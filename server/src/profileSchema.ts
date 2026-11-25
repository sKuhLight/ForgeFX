// Lifecycle of persisted device-definition profiles ("device caches", the docs of the `deviceCaches` store
// collection). Every path that consumes a stored profile (runtime apply, status, build short-circuit,
// import/sources, cloud pull/publish, walk limits, Browser Direct's loader) asks THIS module, so they cannot
// disagree about whether a profile is usable.
//
// Two document formats live in the store:
//   - format 1 (legacy): derived tables only (`BuiltCache`). Usable while `meta.schema` equals the codec's
//     CACHE_SCHEMA; otherwise stale. It reports the non-blocking coverage gap `no-raw`.
//   - format 2 (`meta.format: 2`, the codec's ProfileDoc): the raw definition sources plus the tables
//     derived from them. The derived tables are a cache of `deriveProfile(raw, catalog)`, so a format-2 doc
//     the codec says needs it (`needsRederive`: a schema that differs from this build's, or a
//     `meta.derivedRevision` below the codec's DERIVATION_REVISION) is RE-DERIVED from its raw sources instead
//     of going stale — pure, no device traffic. A doc a newer codec derived (higher revision, same schema) is
//     used as it is.
//
// States (`loadStoredProfile`):
//   absent  — no doc, or a tombstone
//   usable  — the stored tables (`rederived` absent), or the tables re-derived in memory from raw
//             (`rederived`: why). `upgradeStoredProfile` writes a re-derived doc back (raw kept, derived
//             tables + schema/derivedWith/derivedRevision/derivedAt replaced), except one written by a NEWER
//             build (`newer`: re-derived in memory only, so two builds sharing a data dir never ping-pong).
//   stale   — not usable, with a reason:
//       'missing'           — no (integer) schema stamp: a profile written before profiles were versioned
//       'outdated'          — an older schema (format 1: nothing to re-derive from)
//       'newer'             — a schema this build does not understand (format 1, or raw this build cannot read)
//       'derivation-failed' — a format-2 doc whose re-derivation threw; nothing is deleted
//
// A stale profile stays stored (the user can still delete it; nothing auto-deletes) and is replaced or
// merged by the next explicit build / import / pull.
//
// Privacy: `persistProfile` runs the codec's `assertNoUserTables` on every write (a violation is a bug).
//
// Browser-safe: no node:/fastify imports — this module is in the runtime router's import graph and is
// exported from the runtime barrel so Browser Direct's loader (Axis) applies the very same decision.
import {
  CACHE_SCHEMA, RAW_FORMAT, assertNoUserTables, buildProfileDoc, computeCoverage, needsRederive, planSourceUnits, sourceRank, sourceSummary,
  type BuiltCache, type CoverageInput, type ProfileCoverage, type ProfileDoc, type ProfileRaw, type RawSource, type SourceSummary
} from 'forgefx-midi/cache';
import { catalogForModel, deriveOptionsFor, modelOfCacheKey, profileCatalogFor } from './profileCatalog.js';
import { hiddenFamily } from './devices.js';
import type { Store } from './runtime/store.js';

/** The schema this build writes and the only one it accepts. */
export const CURRENT_CACHE_SCHEMA: number = CACHE_SCHEMA;

export type StaleReason = 'missing' | 'outdated' | 'newer' | 'derivation-failed';

/** Verdict on one profile's `meta.schema`. `schema` is the stored stamp (null when absent/invalid). */
export type ProfileSchemaCheck =
  | { usable: true; schema: number; current: number }
  | { usable: false; reason: StaleReason; schema: number | null; current: number };

/** Judge a profile (the doc `data`, or a cloud row's `profile`) by its schema stamp. Total: anything
 *  that is not an object carrying an integer stamp (absent, a string, NaN, 1.5, ...) comes back 'missing'. */
export function checkProfileSchema(profile: unknown): ProfileSchemaCheck {
  const current = CURRENT_CACHE_SCHEMA;
  const raw = (profile as { meta?: { schema?: unknown } } | null | undefined)?.meta?.schema;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { usable: false, reason: 'missing', schema: null, current };
  if (raw === current) return { usable: true, schema: raw, current };
  return { usable: false, reason: raw < current ? 'outdated' : 'newer', schema: raw, current };
}

/** The additive fields a not-usable verdict contributes to API bodies (status / refusals):
 *  `stale: true`, why, and the stored vs current schema numbers. */
export function staleFields(check: Extract<ProfileSchemaCheck, { usable: false }>): { stale: true; staleReason: StaleReason; schema: number | null; currentSchema: number } {
  return { stale: true, staleReason: check.reason, schema: check.schema, currentSchema: check.current };
}

// ── format ──

/** 1 = derived tables only (legacy), 2 = raw sources + derived tables. */
export type ProfileFormat = 1 | 2;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A doc is format 2 when `meta.format` is 2 AND it carries a raw envelope with a source list; anything else
 *  (no stamp, a stripped cloud copy, a malformed envelope) is a legacy format-1 doc. */
export function profileFormatOf(profile: unknown): ProfileFormat {
  if (!isObj(profile) || !isObj(profile.meta) || profile.meta.format !== 2) return 1;
  const raw = profile.raw;
  return isObj(raw) && Array.isArray(raw.sources) ? 2 : 1;
}

/** The raw envelope of a format-2 doc that this build can read (`raw.format` ≤ RAW_FORMAT), else null. */
export function readableRaw(profile: unknown): ProfileRaw | null {
  if (profileFormatOf(profile) !== 2) return null;
  const raw = (profile as { raw: ProfileRaw }).raw;
  return typeof raw.format === 'number' && Number.isInteger(raw.format) && raw.format >= 1 && raw.format <= RAW_FORMAT ? raw : null;
}

/** A format-2 doc whose raw envelope a NEWER build wrote: an integer `raw.format` above this build's RAW_FORMAT.
 *  (A malformed envelope — a non-integer format — is not "newer": it is unreadable for every build.) */
export function hasNewerRaw(profile: unknown): boolean {
  if (profileFormatOf(profile) !== 2) return false;
  const f = (profile as { raw: { format?: unknown } }).raw.format;
  return typeof f === 'number' && Number.isInteger(f) && f > RAW_FORMAT;
}

/** A legacy (format-1) stored profile decoded from editor-cache bytes BY THIS INSTALL: `meta.source`
 *  'editor-cache' (an editor-cache import) or 'bytes' (the codec's byte-source value). Unlike
 *  `isByteExactProfile` it refuses cloud and definitions-file profiles, whatever `meta.origin` claims. Says
 *  nothing about a format-2 doc, whose `meta.source` only names its best source (see deviceCache.ts
 *  `localByteSource` / `hasLocalByteSource`). */
export function isLocalByteProfile(meta: { source?: unknown } | undefined): boolean {
  return meta?.source === 'editor-cache' || meta?.source === 'bytes';
}

/** The source precedence rank (the codec's `sourceRank`, lower wins) a stored doc WITHOUT readable raw sources
 *  stands for, from its persisted `meta.source` / `meta.origin`: a local editor-cache import ranks as a local
 *  editor-cache source, a live walk as a local read-only walk (a legacy doc does not say whether the walk was a
 *  full one), a cloud / definitions-file profile as a cloud / file source of its build kind (`origin`). Null for
 *  an unknown provenance (it outranks nothing). */
export function legacyRankOf(meta: { source?: unknown; origin?: unknown } | undefined): number | null {
  const src = meta?.source;
  if (src === 'editor-cache' || src === 'bytes') return sourceRank('editor-cache', 'local');
  if (src === 'live') return sourceRank('live-readonly', 'local');
  if (src === 'cloud' || src === 'axisdefs') {
    const origin = src === 'cloud' ? 'cloud' : 'file';
    const o = meta?.origin;
    if (o === 'editor-cache' || o === 'bytes') return sourceRank('editor-cache', origin);
    if (o === 'live') return sourceRank('live-readonly', origin);
  }
  return null;
}

/** Why a usable profile was re-derived: an older (or missing) schema, a newer schema, or tables derived under
 *  an older derivation revision of the same schema (`meta.derivedRevision` below DERIVATION_REVISION). */
export type RederiveReason = 'outdated' | 'newer' | 'revision';

/** Whether (and why) a stored doc must be re-derived from its raw sources: the codec's `needsRederive` (a
 *  format-2 doc whose schema differs from this build's, or whose derivation revision is older), for a doc whose
 *  raw envelope this build can read (`raw.format <= RAW_FORMAT`). Null otherwise (a format-1 doc, a doc a newer
 *  codec derived under the same schema, raw this build cannot read). */
export function rederiveReasonOf(profile: unknown): RederiveReason | null {
  if (!readableRaw(profile)) return null;
  if (!needsRederive((profile as { meta?: Parameters<typeof needsRederive>[0] }).meta)) {
    // tables derived while the development hook hid another family than it hides now (devices.ts `hiddenFamily`;
    // `meta.derivedHidden` marks such a derivation) re-derive like an older revision: a session with the hook sees the
    // stored raw sources through its hidden catalog, a session without it never keeps a hidden derivation
    return derivedHiddenOf(profile) !== hiddenFamily() ? 'revision' : null;
  }
  const check = checkProfileSchema(profile);
  if (!check.usable) return check.reason === 'newer' ? 'newer' : 'outdated';
  return 'revision';
}

/** The family the development hook hid when the doc's tables were derived (`meta.derivedHidden`), null for none. */
function derivedHiddenOf(profile: unknown): string | null {
  const v = (profile as { meta?: { derivedHidden?: unknown } } | null)?.meta?.derivedHidden;
  return typeof v === 'string' ? v : null;
}

// ── ForgeFX meta on top of the codec's ──

/** `meta` keys the derivation owns; everything else in a stored doc's meta is ForgeFX bookkeeping
 *  (`builtAt`, `importedAt`, `pulledAt`, `contentHash`, ...) that survives a re-derivation or merge. */
const DERIVED_META_KEYS: ReadonlySet<string> = new Set([
  'schema', 'recordCount', 'source', 'origin', 'walk', 'issues', 'format', 'derivedWith', 'derivedRevision', 'derivedAt', 'sources',
  'derivedHidden'
]);

/** The ForgeFX bookkeeping fields of a stored doc's meta (see DERIVED_META_KEYS). */
export function metaExtrasOf(meta: unknown): Record<string, unknown> {
  if (!isObj(meta)) return {};
  return Object.fromEntries(Object.entries(meta).filter(([k]) => !DERIVED_META_KEYS.has(k)));
}

/** `meta.source` (+ `meta.origin`) as ForgeFX persists it, from the best-ranked raw source: a local source
 *  is 'editor-cache' / 'live'; a cloud or file source is 'cloud' / 'axisdefs' with the codec class of the
 *  data ('bytes' | 'live') in `origin` (what `isByteExactProfile` reads). */
export function persistedSourceMeta(raw: ProfileRaw): { source: string; origin?: 'bytes' | 'live' } {
  const top = planSourceUnits(raw.sources)[0];
  if (!top) return { source: 'live' };
  const byteKind = top.kind === 'editor-cache';
  if (top.origin === 'local') return { source: byteKind ? 'editor-cache' : 'live' };
  return { source: top.origin === 'cloud' ? 'cloud' : 'axisdefs', origin: byteKind ? 'bytes' : 'live' };
}

/** A freshly derived document with ForgeFX's meta: the codec's derived meta, the persisted source vocabulary
 *  (`persistedSourceMeta`) and the given bookkeeping fields. */
export function withForgefxMeta(doc: ProfileDoc, extras: Record<string, unknown> = {}): ProfileDoc {
  const src = persistedSourceMeta(doc.raw);
  const meta = { ...metaExtrasOf(extras), ...doc.meta, source: src.source, ...(src.origin ? { origin: src.origin } : {}) };
  return { ...doc, meta: meta as unknown as ProfileDoc['meta'] };
}

/** Derive a complete format-2 document for `model` from raw sources (the one derivation every write path and
 *  the re-derivation use). `firmware` = the document's firmware; `extras` = ForgeFX bookkeeping. Throws the
 *  codec's derivation errors (`ProfileDerivationError`, `ProfileUserDataError`, a voter seed failure). */
export function deriveProfileDoc(raw: ProfileRaw, model: number, firmware: string | null | undefined, derivedAt: string, extras: Record<string, unknown> = {}): ProfileDoc {
  const { params, seeds } = catalogForModel(model);
  const doc = withForgefxMeta(buildProfileDoc(raw, params, seeds, deriveOptionsFor(model, firmware, derivedAt)), extras);
  // a derivation under the development hook's hidden catalog is marked, so a session without the hook re-derives it
  const hidden = hiddenFamily();
  return hidden === null ? doc : { ...doc, meta: { ...doc.meta, derivedHidden: hidden } as ProfileDoc['meta'] };
}

/** Re-derive a format-2 doc from its raw sources (raw kept, derived tables + schema/derivedWith/derivedAt
 *  replaced, ForgeFX bookkeeping kept). */
export function rederiveProfileDoc(doc: ProfileDoc, model: number, derivedAt: string): ProfileDoc {
  return deriveProfileDoc(doc.raw, model, typeof doc.firmware === 'string' ? doc.firmware : null, derivedAt, doc.meta as unknown as Record<string, unknown>);
}

// ── store lookup ──

/** What a store key holds, as far as using it goes. `profile` is what a consumer applies: the stored doc,
 *  or (usable + `rederived`) the doc re-derived from its raw sources. The stale profile is handed back too
 *  (status reports its meta; nothing else may apply it). */
export type StoredProfile =
  | { state: 'absent' }
  | {
      state: 'usable'; profile: BuiltCache; check: Extract<ProfileSchemaCheck, { usable: true }>; format: ProfileFormat;
      /** Set when `profile` was re-derived from raw (the stored tables were not used as they are). */
      rederived?: RederiveReason;
      /** Set by `upgradeStoredProfile` when it wrote the re-derived doc back. */
      upgraded?: true;
    }
  | { state: 'stale'; profile: BuiltCache; check: Extract<ProfileSchemaCheck, { usable: false }>; format: ProfileFormat };

/** Classification per stored `data` object (and the development hook's hidden family it was made under), so repeated
 *  lookups of the same doc re-derive once. */
const CLASSIFIED = new WeakMap<object, { hidden: string | null; out: StoredProfile }>();

/** Classify a stored profile `data` of the device-cache `key` (the key names the model a re-derivation
 *  derives for; the doc's own `model` is the fallback). */
export function classifyProfile(data: unknown, key: string | null): StoredProfile {
  const hidden = hiddenFamily();
  if (isObj(data)) {
    const hit = CLASSIFIED.get(data);
    if (hit && hit.hidden === hidden) return hit.out;
  }
  const profile = data as BuiltCache;
  const format = profileFormatOf(data);
  const check = checkProfileSchema(data);
  const why = rederiveReasonOf(data);
  let out: StoredProfile;
  if (why === null) {
    out = check.usable ? { state: 'usable', profile, check, format } : { state: 'stale', profile, check, format };
  } else {
    const docModel = (data as { model?: unknown }).model;
    const model = (key !== null ? modelOfCacheKey(key) : null) ?? (typeof docModel === 'number' ? docModel : null);
    try {
      if (model === null) throw new Error('no model to derive for');
      const derived = rederiveProfileDoc(data as ProfileDoc, model, new Date().toISOString());
      out = { state: 'usable', profile: derived, check: { usable: true, schema: CURRENT_CACHE_SCHEMA, current: CURRENT_CACHE_SCHEMA }, format: 2, rederived: why };
    } catch {
      out = { state: 'stale', profile, check: { usable: false, reason: 'derivation-failed', schema: check.schema, current: CURRENT_CACHE_SCHEMA }, format: 2 };
    }
  }
  if (isObj(data)) CLASSIFIED.set(data, { hidden, out });
  return out;
}

/** Read `deviceCaches/<key>` and classify it (`classifyProfile`). A missing doc and a tombstone are both
 *  'absent'. Pure: a re-derived doc is NOT written back (see `upgradeStoredProfile`). */
export function loadStoredProfile(store: Pick<Store, 'getDoc'>, key: string): StoredProfile {
  const doc = store.getDoc('deviceCaches', key);
  if (!doc || doc.deleted) return { state: 'absent' };
  return classifyProfile(doc.data, key);
}

/** Write a document to `deviceCaches/<key>` after the privacy guard (`assertNoUserTables`: no user name table
 *  in any raw source, no non-firmware cab bank). A violation throws `ProfileUserDataError` — a bug on every
 *  write path, since the sources omit those tables. */
export function persistProfile(store: Pick<Store, 'putDoc'>, key: string, doc: unknown): void {
  assertNoUserTables(doc as Parameters<typeof assertNoUserTables>[0]);
  store.putDoc('deviceCaches', key, doc);
}

/** `loadStoredProfile`, and when that re-derived the doc from raw because the stored tables are older
 *  (schema or codec), write the re-derived doc back once (`upgraded: true`). A doc written by a newer build
 *  is used re-derived but never overwritten. A failing write leaves the in-memory result usable. */
export function upgradeStoredProfile(store: Pick<Store, 'getDoc' | 'putDoc'>, key: string): StoredProfile {
  const s = loadStoredProfile(store, key);
  if (s.state !== 'usable' || !s.rederived || s.rederived === 'newer') return s;
  try {
    persistProfile(store, key, s.profile);
  } catch {
    return s;
  }
  return { ...s, upgraded: true };
}

// ── the verdict side channel (runtime apply → capabilities) ──

/** What the last `loadUsableProfile` found under a key: lets the registry tell "nothing stored" from "stored
 *  but stale" although its load hook only hands back a usable profile or null. */
export interface ProfileVerdict {
  state: 'absent' | 'usable' | 'stale'; reason?: StaleReason; format?: ProfileFormat; rederived?: RederiveReason;
  /** The re-derived doc was written back by this lookup. */
  upgraded?: true;
}
const VERDICTS = new Map<string, ProfileVerdict>();

/** The verdict the last `loadUsableProfile(…, key)` recorded (undefined: none since `forgetProfileVerdict`). */
export function lastProfileVerdict(key: string): ProfileVerdict | undefined {
  return VERDICTS.get(key);
}

/** Drop the recorded verdict of `key` (the registry does so right before calling its load hook, so a hook
 *  that does not go through `loadUsableProfile` leaves no stale answer behind). */
export function forgetProfileVerdict(key: string): void {
  VERDICTS.delete(key);
}

/** The profile stored under `key` ONLY when this build may use it — null when absent, tombstoned or stale.
 *  A format-2 doc with older derived tables comes back re-derived from raw, and when `store` can write
 *  (`putDoc`), it is written back once (`upgradeStoredProfile`). The one lookup behind every "apply this
 *  profile" hook (Node registry, Browser Direct). Records the verdict for `lastProfileVerdict`. */
export function loadUsableProfile(store: Pick<Store, 'getDoc'> & Partial<Pick<Store, 'putDoc'>>, key: string): BuiltCache | null {
  const s = typeof store.putDoc === 'function'
    ? upgradeStoredProfile(store as Pick<Store, 'getDoc' | 'putDoc'>, key)
    : loadStoredProfile(store, key);
  VERDICTS.set(key, s.state === 'absent'
    ? { state: 'absent' }
    : s.state === 'stale'
      ? { state: 'stale', reason: s.check.reason, format: s.format }
      : { state: 'usable', format: s.format, ...(s.rederived ? { rederived: s.rederived } : {}), ...(s.upgraded ? { upgraded: true as const } : {}) });
  return s.state === 'usable' ? s.profile : null;
}

// ── summary (sources + coverage) ──

/** Format, raw-source summary and document-level coverage of a usable profile. */
export interface ProfileSummary { format: ProfileFormat; sources: SourceSummary[]; coverage: ProfileCoverage }

/** Memoised summaries per doc object and model (`null` = no catalog): a coverage computed against one model's
 *  catalog (or none) is never handed out for another. */
const SUMMARIES = new WeakMap<object, Map<number | null, ProfileSummary>>();

/** A coverage that says nothing beyond "no raw sources" — for a document too malformed to assess. */
function noRawCoverage(): ProfileCoverage {
  return {
    complete: true, gaps: [{ kind: 'no-raw', blocking: false, fix: ['import-editor-cache', 'read-from-device'] }],
    units: 0, tapers: 0, highIds: { expected: 0, present: 0 }, sections: { total: 0, assigned: 0, system: 0, new: 0, unclassified: 0 }, instances: []
  };
}

/** A legacy doc decoded from an editor cache (a local import — `isLocalByteProfile` — or a cloud / definitions-file
 *  profile of byte origin: `legacyRankOf` outranks every live walk) has byte-exact tables but no raw source to merge
 *  with: a device read can never improve on it (a build over it answers `already`, or 409 `local-profile-better`
 *  when forced, see deviceCache.ts), so its `no-raw` gap offers only a re-import. */
function legacyBytesCoverage(coverage: ProfileCoverage): ProfileCoverage {
  if (!coverage.gaps.some((g) => g.kind === 'no-raw')) return coverage;
  return { ...coverage, gaps: coverage.gaps.map((g) => (g.kind === 'no-raw' ? { ...g, fix: ['import-editor-cache'] } : g)) };
}

/** The summary of a profile of `model` (memoised per doc object and model): a format-2 doc reports its own
 *  `meta.sources` and `coverage`; a format-1 doc has no sources and its coverage is computed against the
 *  model's catalog (always with the non-blocking `no-raw` gap, whose fix is only `import-editor-cache` for a doc
 *  of editor-cache origin, `legacyBytesCoverage`). Never throws. */
export function profileSummaryOf(profile: BuiltCache, model: number | null): ProfileSummary {
  let perModel = SUMMARIES.get(profile);
  const hit = perModel?.get(model);
  if (hit) return hit;
  const catalog = model !== null ? profileCatalogFor(model) : {};
  let out: ProfileSummary;
  const raw = profileFormatOf(profile) === 2 ? (profile as unknown as ProfileDoc).raw : null;
  if (raw) {
    const doc = profile as unknown as ProfileDoc;
    let sources: SourceSummary[];
    try { sources = Array.isArray(doc.meta.sources) ? doc.meta.sources : raw.sources.map((s: RawSource) => sourceSummary(s)); } catch { sources = []; }
    let coverage: ProfileCoverage;
    try { coverage = isObj(doc.coverage) && Array.isArray(doc.coverage.gaps) ? doc.coverage : computeCoverage(doc as unknown as CoverageInput, catalog); } catch { coverage = noRawCoverage(); }
    out = { format: 2, sources, coverage };
  } else {
    let coverage: ProfileCoverage;
    try { coverage = computeCoverage(profile as CoverageInput, catalog); } catch { coverage = noRawCoverage(); }
    const rank = legacyRankOf(profile.meta);
    if (rank !== null && rank < sourceRank('live-full', 'local')) coverage = legacyBytesCoverage(coverage);
    out = { format: 1, sources: [], coverage };
  }
  if (!perModel) SUMMARIES.set(profile, (perModel = new Map()));
  perModel.set(model, out);
  return out;
}
