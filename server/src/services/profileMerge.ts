// Merge of new raw definition sources into the stored profile document of a device-cache key (M3 profile v2).
// A build (live walk), an editor-cache import and a cloud pull no longer REPLACE the stored doc: they add their
// raw source to it, and the document is re-derived from all of its sources by the codec's precedence (an
// editor cache outranks a live walk, a local source outranks a cloud/file source of the same kind; see the
// codec's merge.ts). Rules applied here, before the derivation:
//   - one source per (kind, origin): a new source replaces the stored source(s) of the same kind and origin
//     (a live-probe only the probe of the same blocks) — newest wins, no history;
//   - a stored source taken on another firmware than the document's is never merged (dropped, contract §4.1);
//   - raw sources are never dropped implicitly: a stored doc whose raw sources this build can read keeps them,
//     usable or not. A stale doc (`derivation-failed`) keeps its sources next to the new ones and is re-derived;
//     if that derivation still fails, the result is stored stale with every source (`derivationFailed`), so
//     nothing is lost and the new source is kept too;
//   - refusals (`mergeRefusal`, 409 unless `replace`): a doc a NEWER build wrote (a raw envelope of a newer
//     format, or a usable doc re-derived in memory from a newer schema) is never rewritten by this build
//     (`newer-profile`); a stored doc WITHOUT readable raw sources (format 1) whose provenance outranks every
//     incoming source is never replaced by them (`local-profile-better`: a format-1 doc has no raw to merge
//     with, so replacing it would lose better data, e.g. a live walk over a local editor-cache import);
//   - `replace: true` drops every stored source (the old replace behaviour) and skips the refusals;
//   - source ids stay unique within the doc (the codec's `uniqueSourceIds`: a stored source keeps its id, a
//     new source that collides gets the lowest free `#n`).
// Every NON-LOCAL ingress rewrites the origins of the sources it brings in (`foreignSources`): an origin read
// from the wire is never trusted (a forged 'local' would widen walk bounds and hints). Today that is the cloud
// pull ('cloud') and the definitions-file import ('file', services/definitionsFile.ts).
// A build's `force` only skips the `already` check (deviceCache.ts): the walk then replaces the stored source of
// its own kind like any other build — one source per (kind, origin), no history (contract O1).
// The caller persists the result (`persistProfile`, privacy guard included) and swaps the runtime profile.
//
// Browser-safe: store type only, codec cache subpath, profileSchema. No node:/fastify imports.
import {
  ProfileDerivationError, ProfileUserDataError, RAW_FORMAT, sourceRank, sourceSummary, uniqueSourceIds,
  type ProfileDoc, type RawSource, type RawSourceKind, type SourceOrigin
} from 'forgefx-midi/cache';
import {
  classifyProfile, deriveProfileDoc, hasNewerRaw, legacyRankOf, metaExtrasOf, profileFormatOf, readableRaw, type ProfileFormat
} from '../profileSchema.js';
import type { Store } from '../runtime/store.js';

export interface MergeSourcesInput {
  key: string;
  model: number;
  /** Firmware of the document (the device's running firmware, or a forced import's file firmware). */
  firmware: string | null;
  /** The new sources (fresh ids are assigned on collision). */
  incoming: RawSource[];
  /** Drop every stored source (the whole doc is replaced) and skip the refusals. */
  replace?: boolean;
  /** ForgeFX bookkeeping fields for this write (`importedAt`, `builtAt`, `pulledAt`, `contentHash`, …). */
  extras?: Record<string, unknown>;
  /** ISO stamp for `meta.derivedAt`. */
  now: string;
}

export interface MergedProfile {
  /** The document to persist: freshly derived, or (`derivationFailed`) the stored stale doc with every source. */
  doc: ProfileDoc;
  /** Stored sources kept alongside the new ones (0 = the doc holds only the new sources). */
  kept: number;
  /** Stored sources the new ones replaced or that could not be merged (another firmware). */
  dropped: number;
  /** The stored doc held no raw sources this build can read (format 1, or a malformed envelope): the new doc
   *  holds only the new sources. */
  replacedLegacy: boolean;
  /** Set when the stored doc was stale with readable raw sources and the merged sources still do not derive:
   *  `doc` is that stale doc with every source (stored and new) and its old derived tables, so it stays stale
   *  (`derivation-failed`) on load. The error message of the failed derivation. */
  derivationFailed?: string;
}

/** Why a merge into the stored doc is refused (409 unless `replace: true`). */
export interface MergeRefusal {
  error: 'newer-profile' | 'local-profile-better';
  message: string;
  /** What is stored: its persisted `meta.source` and format. */
  local: { source: string; format: ProfileFormat };
}

/** Thrown by `mergeSourcesIntoStored` for a refused merge (see `mergeRefusal`); nothing is derived or stored. */
export class ProfileMergeRefused extends Error {
  readonly refusal: MergeRefusal;
  constructor(refusal: MergeRefusal) {
    super(refusal.message);
    this.name = 'ProfileMergeRefused';
    this.refusal = refusal;
  }
}

/** The 409 body of a refused merge. */
export function refusalBody(r: MergeRefusal): Record<string, unknown> {
  return { error: r.error, local: r.local, message: r.message };
}

/** The sources of a non-local ingress with their origin rewritten to `origin` (an origin from the wire is never
 *  trusted). Copies; the records are shared. */
export function foreignSources(sources: readonly RawSource[], origin: Exclude<SourceOrigin, 'local'>): RawSource[] {
  return sources.map((s) => ({ ...s, origin }) as RawSource);
}

/** Same (kind, origin) slot: the stored source is superseded by the new one. Probes only per block set. */
function sameSlot(a: RawSource, b: RawSource): boolean {
  if (a.kind !== b.kind || a.origin !== b.origin) return false;
  if (a.kind !== 'live-probe' || b.kind !== 'live-probe') return true;
  const ba = [...a.scope.blocks].sort((x, y) => x - y).join(',');
  const bb = [...b.scope.blocks].sort((x, y) => x - y).join(',');
  return ba === bb;
}

const storedSourceOf = (data: unknown): string => {
  const s = (data as { meta?: { source?: unknown } } | null)?.meta?.source;
  return typeof s === 'string' ? s : 'unknown';
};

/**
 * Why adding sources of `incoming` (kind + origin) to the doc stored under `key` must be refused, or null:
 *   - `newer-profile`: the stored doc was written by a NEWER build — its raw envelope has a newer format
 *     (`hasNewerRaw`), or it is a usable doc this build only re-derives in memory from a newer schema
 *     (`rederived: 'newer'`). Rewriting it would lose what that build knows (the same rule the contribution's
 *     coupled import follows). A format-1 doc with a newer schema is stale and is replaced as before.
 *   - `local-profile-better`: the stored doc is usable but holds no raw sources this build can read (format 1),
 *     and its provenance (`legacyRankOf`: a local editor-cache import, a local walk, a cloud/file profile of its
 *     build kind) outranks every incoming source (the codec's `sourceRank`). A format-1 doc has nothing to merge
 *     with, so the incoming sources would replace it.
 * `replace: true`, an absent doc and a tombstone are never refused.
 */
export function mergeRefusal(
  store: Pick<Store, 'getDoc'>,
  key: string,
  incoming: ReadonlyArray<{ kind: RawSourceKind; origin: SourceOrigin }>,
  opts: { replace?: boolean } = {}
): MergeRefusal | null {
  if (opts.replace) return null;
  const stored = store.getDoc('deviceCaches', key);
  if (!stored || stored.deleted) return null;
  const data = stored.data;
  const local = { source: storedSourceOf(data), format: profileFormatOf(data) };
  const s = classifyProfile(data, key);
  if (hasNewerRaw(data) || (s.state === 'usable' && s.rederived === 'newer')) {
    return {
      error: 'newer-profile', local,
      message: 'the stored profile for this firmware was written by a newer build; it is not rewritten — update, or use replace: true to replace it'
    };
  }
  if (s.state === 'usable' && !readableRaw(data) && incoming.length > 0) {
    const storedRank = legacyRankOf((data as { meta?: { source?: unknown; origin?: unknown } }).meta);
    const best = Math.min(...incoming.map((i) => sourceRank(i.kind, i.origin)));
    if (storedRank !== null && storedRank < best) {
      return {
        error: 'local-profile-better', local,
        message: 'a better profile (without raw sources to merge with) is stored for this firmware; these sources would replace it — re-import the editor cache, or use replace: true'
      };
    }
  }
  return null;
}

/** A derivation failure that comes from the input (a source of another firmware, duplicate ids, user data), not
 *  from the stored sources: such a merge is refused as a whole, never stored stale. */
const inputFailure = (e: unknown): boolean =>
  e instanceof ProfileUserDataError || (e instanceof ProfileDerivationError && (e.code === 'firmware-mismatch' || e.code === 'duplicate-source-id'));

/**
 * The document `deviceCaches/<key>` becomes when `incoming` joins the stored sources (see the module comment).
 * Reads the store, writes nothing. Throws `ProfileMergeRefused` (see `mergeRefusal`), and the codec's derivation
 * errors (`ProfileDerivationError` incl. `firmware-mismatch` for a new source of another firmware,
 * `ProfileUserDataError`, a voter seed failure) — except for a stale stored doc with readable raw, whose failed
 * re-derivation comes back as `derivationFailed` (the caller stores it, nothing is lost).
 */
export function mergeSourcesIntoStored(store: Pick<Store, 'getDoc'>, input: MergeSourcesInput): MergedProfile {
  const refusal = mergeRefusal(store, input.key, input.incoming, { replace: input.replace });
  if (refusal) throw new ProfileMergeRefused(refusal);
  const stored = store.getDoc('deviceCaches', input.key);
  const data = stored && !stored.deleted ? stored.data : null;
  const keep: RawSource[] = [];
  let dropped = 0;
  let replacedLegacy = false;
  let staleWithRaw = false;
  let extrasBase: Record<string, unknown> = {};
  if (data !== null && !input.replace) {
    const raw = readableRaw(data);
    if (raw) {
      // usable or stale: readable raw sources are kept (never dropped implicitly)
      staleWithRaw = classifyProfile(data, input.key).state !== 'usable';
      for (const s of raw.sources) {
        const otherFw = input.firmware !== null && s.firmware !== null && s.firmware !== input.firmware;
        if (otherFw || input.incoming.some((n) => sameSlot(n, s))) dropped++;
        else keep.push(s);
      }
      extrasBase = metaExtrasOf((data as { meta?: unknown }).meta);
    } else {
      // format 1 (or a malformed envelope no build can read): no raw source to keep
      replacedLegacy = true;
    }
  } else if (data !== null) {
    const raw = readableRaw(data);
    dropped = raw ? raw.sources.length : 0;
  }
  // stored sources first: they keep their ids, a colliding new source is renamed
  const sources = uniqueSourceIds([...keep, ...input.incoming]);
  const extras = { ...extrasBase, ...(input.extras ?? {}) };
  try {
    const doc = deriveProfileDoc({ format: RAW_FORMAT as 1, sources }, input.model, input.firmware, input.now, extras);
    return { doc, kept: keep.length, dropped, replacedLegacy };
  } catch (e) {
    if (!staleWithRaw || inputFailure(e)) throw e;
    // still not derivable: keep the stale doc (its old derived tables and derivation stamps, so it stays stale on
    // load) with every source, stored and new
    const prev = data as ProfileDoc;
    const meta = { ...(prev.meta as unknown as Record<string, unknown>), ...extras, sources: sources.map((s) => sourceSummary(s)) };
    const doc = { ...prev, raw: { format: RAW_FORMAT as 1, sources }, meta } as unknown as ProfileDoc;
    return { doc, kept: keep.length, dropped, replacedLegacy, derivationFailed: (e as Error).message };
  }
}
