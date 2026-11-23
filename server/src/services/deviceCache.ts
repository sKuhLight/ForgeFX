// Device-cache build orchestration — the runtime on-connect self-describe cache (FORGEFX-15 / A3).
// One background build at a time per registry (module-level WeakMap job state), driving the codec's
// live self-describe walk over the registry's shared transport into a live RAW source, merging it into
// the profile document of the `deviceCaches` store collection (profile v2: the doc keeps every raw source
// and is derived from all of them, see services/profileMerge.ts), and swapping the driver's profile to the
// device-true runtime one. Progress is streamed as `cacheBuild` SSE events. Endpoints (both twins) are thin
// wrappers over the exported functions here — all the logic lives in this module.
//
// Browser-safe: the store + registry are type-only imports (a browser runtime supplies its own), and
// the codec's cache subpath is itself browser-safe. NO node:/fastify/transport VALUE imports — this
// module is in the runtime router's import graph (check-browser-safe.ts enforces it).
import {
  LIVE_WALK_LIMITS, LiveWalkAbortError, RAW_FORMAT, WalkBoundError, buildProfileDoc, enumHintsFromRanges, guardWalkTransport,
  isPlaceholderRecord, liveWalkDetailed, liveWalkScope, rawFromLiveWalk,
  type BuiltCache, type CacheRecord, type LiveEnumHint, type LiveRawSource, type LiveSourceScope, type LiveTransport,
  type LiveWalkOptions, type LiveWalkResult, type LiveWalkWriteHooks, type ProfileCoverage, type RawSourceKind, type SourceSummary
} from 'forgefx-midi/cache';
import { isFractalHeaderFrame } from 'forgefx-midi/shared';
import { deviceCacheKey, fullCaptureAllowedOnFirmware, type DeviceRegistry } from '../drivers/registryCore.js';
import { claimDevice, deviceBusy, releaseDevice } from './deviceJobs.js';
import { PROFILES, type DeviceProfile } from '../devices.js';
import {
  CURRENT_CACHE_SCHEMA, isLocalByteProfile, loadStoredProfile, persistProfile, profileFormatOf, profileSummaryOf, readableRaw,
  upgradeStoredProfile, type ProfileFormat, type StaleReason, type StoredProfile
} from '../profileSchema.js';
import { catalogForModel, deriveOptionsFor, paramsForModel, staticRoster, type StaticBlockRef } from '../profileCatalog.js';
import { mergeRefusal, mergeSourcesIntoStored, refusalBody, type MergeRefusal, type MergedProfile } from './profileMerge.js';
import type { WalkScopeGates } from './walkScope.js';
import type { Store } from '../runtime/store.js';
import { isTransportTimeout, type Transport } from '../transport/types.js';

/** Injectable walk (defaults to the codec's `liveWalkDetailed`) — tests fake it so they never septet-encode
 *  wire frames. Resolves to the walk result (records + reply-loss statistics, persisted with the raw source),
 *  or to the bare decoded records (statistics then count as zero). */
export type WalkImpl = (transport: LiveTransport, opts: LiveWalkOptions) => Promise<CacheRecord[] | LiveWalkResult>;

/** Re-exported from profileCatalog.ts (their home since the profile store re-derives documents). */
export { paramsForModel, catalogForModel };

/** Build mode: 'read-only' is the HW-proven default sweep; 'full' adds the CaptureRig-parity write-sweep
 *  that recovers per-float knob tapers (requires the fullCapture capability + write hooks, and a firmware
 *  the model's full capture has been verified on — inside its FULL_CAPTURE_VERIFIED_FW range, see startCacheBuild). */
export type BuildMode = 'read-only' | 'full';

interface CacheJob {
  key: string;
  model: number;
  firmware: string;
  /** The running firmware the job was started on (gates the enum hints, see `enumHintsVerifiedOn`). */
  fw: { major: number; minor: number };
  mode: BuildMode;
  /** Effective walk scope: the request's, else 'extended' for a read-only build when a walk-scope gate is open (see
   *  `BuildScope`). */
  scope: BuildScope;
  /** The walk-scope gates of the running firmware at the start of the job, on a fresh firmware read when the scope
   *  could be extended (all closed when that read failed); see `startClaimedBuild`. */
  gates: WalkScopeGates;
  /** The extension walk (phase B) runs after the standard walk: the scope is 'extended' and the gates open blocks
   *  for it (`extensionWalkLimits`). False with an 'extended' scope = the extension is reported 'skipped'. */
  phaseB: boolean;
  /** Replace the whole stored doc instead of merging the new source into it. */
  replace: boolean;
  controller: AbortController;
  progress: { done: number; total: number; phase: 'walking' | 'building' };
  promise: Promise<void>;
}

/** Walk scope of a build: 'standard' = ids 0..127 of blocks 0..160 (phase A, today's walk); 'extended' = phase A,
 *  then the extension walk (phase B, `extensionWalkLimits`): the ids above 127 of known contiguous tables longer
 *  than 128 slots and of the low region of a non-contiguous table (gate `extendedIds`), and the present roster
 *  blocks above 160 (gate `above160`) — only on a (model, firmware) whose gate is open (`WALK_SCOPE_VERIFIED_FW`,
 *  empty in this build, or the development override). An 'extended' request whose gates open nothing walks the
 *  standard scope and reports `extension: 'skipped'`. Without a requested scope a READ-ONLY build is 'extended' when
 *  a gate is open, else 'standard'; a full build is 'standard' (full mode is unchanged; its extension, read-only and
 *  above 160 only, runs on an explicit 'extended'). */
export type BuildScope = 'standard' | 'extended';

/** Options of a build start (the route body plus the test seam). */
export interface CacheBuildOptions {
  /** Walk even when the stored doc already holds a complete source of the requested kind. */
  force?: boolean;
  mode?: BuildMode;
  /** Requested scope; absent = 'extended' for a read-only build when a walk-scope gate of the running firmware is
   *  open, else 'standard' (any other value = 'standard'). */
  scope?: BuildScope;
  /** Replace the whole stored doc (old behaviour) instead of merging the walk into it. */
  replace?: boolean;
  walkImpl?: WalkImpl;
}

/** At most ONE build per registry. Module-level so status/cancel see the running job without the
 *  registry having to own build state. */
const JOBS = new WeakMap<DeviceRegistry, CacheJob>();

/** The result a build-start returns to the (thin) endpoint: an HTTP status + the JSON body. */
export interface StartResult { code: number; body: unknown }

export interface CacheStatus {
  key: string | null;
  /** A profile doc is stored under `key` — whether or not this build may use it (see `stale`). */
  exists: boolean;
  building: boolean;
  progress?: { done: number; total: number; phase: string };
  meta?: {
    recordCount: number; builtAt: string | null; firmware: string | null; unmappedSections: number; unmappedFamilies: number; source: string;
    /** The stored profile's schema stamp (null = none). */
    schema: number | null;
  };
  /** The stored profile is not usable by this build (schema missing / outdated / newer, or a re-derivation
   *  that failed): it is not applied at runtime, does not count as built, and must be re-read. False when
   *  nothing is stored. */
  stale: boolean;
  /** Why it is stale — only present when `stale`. */
  staleReason?: StaleReason;
  /** The schema this build writes and accepts. */
  currentSchema: number;
  /** Stored doc only: 1 = derived tables only (legacy), 2 = raw sources + derived tables. */
  format?: ProfileFormat;
  /** Stored doc only: one line per raw source (empty for a format-1 doc). */
  sources?: SourceSummary[];
  /** Usable doc only: document-level gaps and counts (a format-1 doc always reports `no-raw`). */
  coverage?: ProfileCoverage;
  /** This status read re-derived the stored doc from its raw sources (and wrote it back unless a newer
   *  build wrote it). */
  rederived?: true;
}

/** Inter-query pacing for the self-describe walk, in ms. NEVER 0: full-speed query flooding freezes
 *  FM3 hardware (observed on the first real-device run, FORGEFX-32). 3 ms is the hardware-proven value
 *  the capture tooling has always used between fn 0x01 queries. */
const WALK_PACE_MS = 3;
/** Breather between blocks, in ms — the hardware-proven sweep always paused between blocks; a
 *  continuous 128-block stream without let-up contributed to the FORGEFX-32 wedge. */
const WALK_BLOCK_PAUSE_MS = 150;
/** READ-ONLY walk param ceiling: params 0..127 only. The 14-bit param space (body[5] set, id > 127) was
 *  never live-swept read-only on a real unit, so the read-only build stays inside the validated envelope.
 *  Keep this at 127. It is also the hard bound of every block whose table size is unknown in FULL mode.
 *  Per-block limits (`walkBlockLimits`) can only narrow a read-only walk inside it, never widen it. */
const WALK_MAX_PARAM_ID = 127;
/** FULL-mode cap on a per-block hard bound: 511, the highest id of the largest table seen on a unit
 *  (FM3 fw 13.0, block 0), also the codec's own FULL default. Far past a table's end the device answers
 *  pseudo definitions, and one read-only definition query at block 0 param 1000 froze an FM3 until a
 *  power cycle, so this must NEVER be the 14-bit space (16383): junk answers past the end keep resetting
 *  the codec's absent-run stop and a walk would run on to its ceiling. The codec does NOT bound the walk
 *  by itself, the host supplies the ceilings. Every block of 0..`WALK_BOUND_MAX_BLOCK` gets an explicit
 *  per-block bound (`walkBlockLimits`), so this only caps the bounds derived from a known table. */
const WALK_MAX_PARAM_ID_FULL = 511;
/** Block (effect id) addresses the per-block limits are computed for: the whole effect-id byte. The
 *  codec's default sweep covers 0..160 today; entries for blocks it does not visit are inert. */
const WALK_BOUND_MAX_BLOCK = 255;

/** Headroom of the hard bound past a known table, and the largest id gap that still counts as one
 *  contiguous region: room for the params a newer firmware appends to a table (FM3 fw 13.0 over the
 *  fw 12.0 catalog: CHORUS 29 -> 32, FUZZ 43 -> 44, MIXER 17 -> 21), yet nowhere near the far ids a unit
 *  may not survive. Equals the codec's default stop run (a run of this many absent ids ends a block). */
const WALK_BOUND_MARGIN = 32;

/** Per-block limits for the live walk, keyed by block address (= gen-3 effect id). */
export interface WalkBlockLimits {
  /** The codec's `paramKnownSizeByBlock`: the wire stride (slots) of the block's family, for the
   *  instances the unit has. Ids below it are walked without the absent-run stop, so a sparse table
   *  keeps its real rows after long id gaps. */
  knownSize: Record<number, number>;
  /** The codec's `paramBoundByBlock`: a HARD ceiling (highest id, inclusive), never queried above. */
  bound: Record<number, number>;
}

/** A usable wire stride: a finite number of at least one slot. */
const usableStride = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1;

/** Last id of the low contiguous region of a sorted id list: the id before the first gap wider than
 *  `WALK_BOUND_MARGIN`. FM3 GLOBAL: ids run to 131, then jump to 902. */
function lastLowContiguousId(sortedIds: readonly number[]): number {
  let last = sortedIds[0]!;
  for (const id of sortedIds) {
    if (id - last > WALK_BOUND_MARGIN) break;
    last = id;
  }
  return last;
}

/** The model's static roster (block address -> catalog family, instance, slug) lives in profileCatalog.ts, shared
 *  with the gen-3 driver's runtime `unmapped-block` gap; re-exported here for the walk's other callers. */
export { staticRoster, type StaticBlockRef };

/** Known table size and hard ceiling per block for the live walk (see `WalkBlockLimits`).
 *
 *  Table size: the family's `stride` in `rangeSections`, the wire slot count (a table of N slots holds
 *  ids 0..N-1). NOT `recordCount`: that also counts special table records (ids >= 0xff00) that no walk
 *  reaches (FM3 CABINET: 110 records, ids 0..105). The sections are the STATIC catalog of the model,
 *  replaced per family by the LOCAL editor-cache data of the stored profile of the attached firmware
 *  (`localByteSource(stored)`: an editor-cache import made by this install, derived on its own — exact device
 *  data that wins outright, as in `runtimeProfileFrom`; an unusable stride in it falls back to the catalog's, the
 *  family is not dropped). A stored LIVE-walk profile is deliberately NOT used, nor the live sources merged into
 *  a format-2 doc: their sizes are a heuristic (a pre-bound walk may have counted junk past the table end), and a
 *  bound must never come from the very junk it exists to stop. Nor is a cloud or definitions-file profile or
 *  source, whatever its origin claims: a bound is a promise about the device, and their provenance is another
 *  install's claim.
 *
 *  Block to family is the model's static roster (`staticRoster`: each family's ids by the model's instance
 *  count, else the profile's virtual effect ids GLOBAL/CONTROLLERS/MOD). Per block:
 *   - Contiguous table (every catalog id below 0xff00 fits below the stride): hard bound
 *     `min(stride - 1 + WALK_BOUND_MARGIN, mode cap)`, plus the known size when the unit HAS that
 *     instance (`instanceLimits[slug] ?? defaultInstances`: FM3 amp instance 1 yes, 2..4 no). The known
 *     size switches the absent-run stop off below it; a missing instance only gets the bound, so the
 *     codec's empty-block probe skips it cheaply.
 *   - Not a contiguous table (the catalog has ids beyond the stride: GLOBAL carries its real params in
 *     a low region and a few far ids): NO known size, the stride says nothing about where the real
 *     rows end. Hard bound `min(lastLowContiguousId + WALK_BOUND_MARGIN, mode cap)` (FM3 GLOBAL 131).
 *   - Unknown block (no family, no section, unusable stride): FULL mode caps it at 127, the HW-proven
 *     envelope, instead of the 511 default (block 0 is a system table that answers junk and froze at
 *     param 1000). Read-only needs no entry: its default is already 127 with the stop run.
 *
 *  The size is a floor, not a promise: the catalog may predate the connected firmware, which can append
 *  params to a table, so the bound leaves `WALK_BOUND_MARGIN` ids of headroom and the codec keeps its
 *  stop run beyond the known size. Mode cap: read-only 127 (HW-proven envelope), full 511. */
export function walkBlockLimits(model: number, mode: BuildMode, stored?: BuiltCache | null): WalkBlockLimits {
  const limits: WalkBlockLimits = { knownSize: {}, bound: {} };
  const tables = limitTables(model, stored);
  if (!tables) return limits; // no gen-3 catalog for this model: codec defaults everywhere
  const cap = mode === 'full' ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID;
  for (let block = 0; block <= WALK_BOUND_MAX_BLOCK; block++) {
    const t = tables.blockTable(block);
    if (!t) {
      if (mode === 'full') limits.bound[block] = WALK_MAX_PARAM_ID; // unknown block: the HW-proven envelope
      continue;
    }
    if (!t.contiguous) {
      limits.bound[block] = Math.min(lastLowContiguousId(t.ids) + WALK_BOUND_MARGIN, cap); // not a contiguous table
      continue;
    }
    limits.bound[block] = Math.min(t.stride - 1 + WALK_BOUND_MARGIN, cap);
    if (t.present) limits.knownSize[block] = t.stride;
  }
  return limits;
}

/** A block of the model's static roster with a known table: what the standard and the extension limits derive from. */
interface BlockTable {
  family: string;
  /** Wire stride of the family (local editor-cache data, else the catalog's). */
  stride: number;
  /** Ordinary param ids of the family's reference table, ascending (local editor-cache rows, else the catalog's). */
  ids: number[];
  /** Every reference id lies below the stride. */
  contiguous: boolean;
  /** The unit has this instance (`instanceLimits[slug] ?? defaultInstances`; a family without a slug always). */
  present: boolean;
  /** The family's editor slug (a placeable block), when it has one. */
  slug?: string;
  /** Ids of the reference table's enum rows (the extension walk's label budget). */
  enumIds: number[];
}

/** The per-block table facts of a model for the walk limits: the STATIC catalog, replaced per family by the LOCAL
 *  editor-cache data of the stored doc (`localByteSource`; see `walkBlockLimits`). Null without a gen-3 catalog.
 *  `blockTable(block)`: undefined for a block with no known table — unrostered, named from the roster only
 *  (`roster`, FORGEFX-45: no bound derived from a family it is not proven to be), or without a usable stride. */
function limitTables(model: number, stored: BuiltCache | null | undefined): { blockTable(block: number): BlockTable | undefined } | null {
  const profile: DeviceProfile | undefined = PROFILES[model];
  if (!profile) return null;
  const exact = localByteSource(stored, model);
  const strides: Record<string, number> = {};
  for (const [family, meta] of Object.entries(profile.rangeSections)) {
    if (usableStride(meta.stride)) strides[family] = Math.floor(meta.stride);
  }
  for (const [family, meta] of Object.entries(exact?.rangeSections ?? {})) {
    if (usableStride(meta.stride)) strides[family] = Math.floor(meta.stride);
  }
  // Ordinary param ids (below the 0xff00 special records) of a family: the byte-exact cache's rows when it
  // carries any for the family (exact for the firmware), else the static catalog's params and ranges.
  const idsOf = (family: string): number[] => {
    const exactIds = Object.keys(exact?.ranges?.[family] ?? {}).map(Number);
    const ids = exactIds.length > 0
      ? exactIds
      : [...(profile.params[family] ?? []).map((d) => d.paramId), ...Object.keys(profile.ranges[family] ?? {}).map(Number)];
    return [...new Set(ids)].filter((i) => Number.isInteger(i) && i >= 0 && i < 0xff00).sort((x, y) => x - y);
  };
  // Enum rows of a family: the byte-exact cache's rows when it carries any (as `walkEnumHints`), else the catalog's.
  const enumIdsOf = (family: string): number[] => {
    const exactRows = exact?.ranges?.[family];
    const rows = exactRows && Object.keys(exactRows).length > 0 ? exactRows : profile.ranges[family] ?? {};
    return Object.entries(rows)
      .filter(([, r]) => r.kind === 'enum')
      .map(([id]) => Number(id))
      .filter((i) => Number.isInteger(i) && i >= 0)
      .sort((x, y) => x - y);
  };
  const roster = staticRoster(model);
  // per family, computed once (the instances of a family share its table)
  const perFamily = new Map<string, { ids: number[]; enumIds: number[] }>();
  const tableOf = (family: string) => {
    let t = perFamily.get(family);
    if (!t) perFamily.set(family, (t = { ids: idsOf(family), enumIds: enumIdsOf(family) }));
    return t;
  };
  return {
    blockTable(block: number): BlockTable | undefined {
      const ref = roster.get(block);
      // a block the effect-id table names from the roster only (`roster`, FORGEFX-45) is no known table: no known
      // size, no bound derived from a family it is not proven to be — treated like an unknown block
      if (!ref || ref.roster) return undefined;
      const stride = strides[ref.family];
      if (stride === undefined) return undefined;
      const { ids, enumIds } = tableOf(ref.family);
      return {
        family: ref.family,
        stride,
        ids,
        contiguous: !(ids.length > 0 && ids[ids.length - 1]! + 1 > stride),
        present: !ref.slug || ref.instance <= (profile.instanceLimits[ref.slug] ?? profile.defaultInstances),
        ...(ref.slug ? { slug: ref.slug } : {}),
        enumIds
      };
    }
  };
}

/** The walk-scope gates an extension walk runs under (`WalkScopeGates` without the block probe). */
export type ExtensionGates = Pick<WalkScopeGates, 'extendedIds' | 'above160' | 'farIds'>;

/** Effect ids the extension walk never queries, whatever a table says: the system table (block 0, which answers
 *  pseudo definitions far past its end) and the non-effect blocks of the shared gen-3 roster above 160 (190, 199,
 *  200). */
const NEVER_EXTENDED_BLOCKS: ReadonlySet<number> = new Set([0, 190, 199, 200]);

/** The only families whose blocks above 160 an extension walks (the placeable effect families there, contract §5.2):
 *  pinned by name, so a roster entry the codec adds above 160 is never walked until it is listed here. */
const ABOVE160_FAMILIES: ReadonlySet<string> = new Set(['RESONATOR', 'LOOPER', 'PLEX', 'FDBKSEND', 'FDBKRET', 'MULTIPLEXER']);

/** Label queries the extension walk's query budget allows per enum row of a walked table. */
const BUDGET_LABELS_PER_ENUM = 64;

/** Per-block limits of the extension walk (phase B, read-only), see `extensionWalkLimits`. */
export interface ExtensionWalkLimits extends WalkBlockLimits {
  /** Blocks the extension walk visits, ascending (an empty list: nothing to extend). */
  blocks: number[];
  /** Explicit far ids per block (`paramIdsByBlock`), only with the `farIds` gate. */
  idLists: Record<number, number[]>;
  /** Blocks walked past id 127: contiguous tables longer than 128 slots, the low region of a non-contiguous table. */
  extendedBlocks: number[];
  /** Blocks above the standard block range (160): present roster blocks. */
  above160Blocks: number[];
  /** Enum rows of each block's reference table at or below its bound (the label share of the query budget). */
  enums: Record<number, number>;
}

/** Known table sizes, hard ceilings and the block list of the EXTENSION walk (phase B) for `model` under `gates`:
 *  the same table facts as `walkBlockLimits` (the static catalog, or the LOCAL editor-cache data of the stored doc —
 *  `localByteSource`; a cloud, definitions-file or live source never widens a bound), never a guess:
 *   - Contiguous table longer than 128 slots (gate `extendedIds`; present instances only): re-walked whole with the
 *     hard bound `min(stride - 1 + 32, 255)` and the known size `stride` (FM3 DISTORT 175, CONTROLLERS 161).
 *   - Non-contiguous table (gate `extendedIds`): its low region, bound `min(lastLowContiguousId + 32, 255)`, no known
 *     size (FM3 GLOBAL 163); its far ids (the reference ids above that bound) as an explicit id list only with the
 *     `farIds` gate (implemented, never enabled).
 *   - Roster block above 160 (gate `above160`): only a family of `ABOVE160_FAMILIES` (Resonator, Looper, Plex, Send,
 *     Return, Multiplexer) with an editor slug, whose instance the unit has, with a contiguous table: bound `min(stride - 1 + 32, 255)` (at most 127 without the `extendedIds`
 *     gate) and known size `stride`.
 *   - Never: block 0, 190, 199, 200, an unrostered or roster-only block, an absent instance, a table of 128 slots or
 *     fewer up to block 160 (the standard walk covers it whole).
 *  A FULL-mode build's standard walk already reaches every known table's extended bound (its cap is 511), so for it
 *  only the blocks above 160 are left (walked read-only). */
export function extensionWalkLimits(
  model: number,
  stored: BuiltCache | null | undefined,
  gates: ExtensionGates,
  mode: BuildMode = 'read-only'
): ExtensionWalkLimits {
  const out: ExtensionWalkLimits = { knownSize: {}, bound: {}, blocks: [], idLists: {}, extendedBlocks: [], above160Blocks: [], enums: {} };
  const tables = limitTables(model, stored);
  if (!tables) return out;
  const extCap = LIVE_WALK_LIMITS.extendedReadOnlyMaxParamId;
  const add = (block: number, t: BlockTable, bound: number, knownSize: number | null, kind: 'extended' | 'above160'): void => {
    out.blocks.push(block);
    out.bound[block] = bound;
    if (knownSize !== null) out.knownSize[block] = knownSize;
    out.enums[block] = t.enumIds.filter((id) => id <= bound).length;
    (kind === 'extended' ? out.extendedBlocks : out.above160Blocks).push(block);
  };
  for (let block = 0; block <= WALK_BOUND_MAX_BLOCK; block++) {
    if (NEVER_EXTENDED_BLOCKS.has(block)) continue;
    const t = tables.blockTable(block);
    if (!t || !t.present) continue;
    if (block <= LIVE_WALK_LIMITS.standardMaxBlock) {
      if (mode === 'full' || !gates.extendedIds) continue;
      if (t.contiguous) {
        if (t.stride <= WALK_MAX_PARAM_ID + 1) continue; // the standard walk covers it whole
        add(block, t, Math.min(t.stride - 1 + WALK_BOUND_MARGIN, extCap), t.stride, 'extended');
        continue;
      }
      const bound = Math.min(lastLowContiguousId(t.ids) + WALK_BOUND_MARGIN, extCap);
      const far = gates.farIds ? t.ids.filter((id) => id > bound) : [];
      if (bound <= WALK_MAX_PARAM_ID && far.length === 0) continue;
      add(block, t, bound, null, 'extended');
      if (far.length > 0) out.idLists[block] = far;
      continue;
    }
    if (!gates.above160 || !ABOVE160_FAMILIES.has(t.family) || !t.slug || !t.contiguous) continue;
    add(block, t, Math.min(t.stride - 1 + WALK_BOUND_MARGIN, gates.extendedIds ? extCap : WALK_MAX_PARAM_ID), t.stride, 'above160');
  }
  return out;
}

/** The query budget of an extension walk: per block (bound + 1) × 2 (a definition and a value read per id) plus 64
 *  label queries per enum row of its reference table, plus two queries per listed far id (the id and its liveness
 *  re-read). Counted in the host adapter (`walkAdapter`): the first query past it aborts the walk. */
export function extensionQueryBudget(limits: Pick<ExtensionWalkLimits, 'blocks' | 'bound' | 'enums' | 'idLists'>): number {
  let budget = 0;
  for (const block of limits.blocks) {
    budget += ((limits.bound[block] ?? WALK_MAX_PARAM_ID) + 1) * 2;
    budget += BUDGET_LABELS_PER_ENUM * (limits.enums[block] ?? 0);
    budget += 2 * (limits.idLists[block]?.length ?? 0);
  }
  return budget;
}

/** `isLocalByteProfile` lives in profileSchema.ts (the summary's `no-raw` fixes need it too); re-exported here. */
export { isLocalByteProfile };

/** Does a stored profile hold LOCAL editor-cache data (cheap: no derivation)? A format-1 doc: `isLocalByteProfile`;
 *  a format-2 doc: an editor-cache raw source of origin 'local' in a raw envelope this build can read
 *  (`readableRaw`) — sources this build cannot read (a newer or malformed envelope) are never trusted. Every
 *  non-local ingress (cloud pull, and the definitions-file import of WP-F4) rewrites source origins on the way in,
 *  so 'local' here is this install's own data. */
export function hasLocalByteSource(doc: BuiltCache | null | undefined): boolean {
  if (!doc) return false;
  if (profileFormatOf(doc) !== 2) return isLocalByteProfile(doc.meta);
  const raw = readableRaw(doc);
  return !!raw && raw.sources.some((s) => s.kind === 'editor-cache' && s.origin === 'local');
}

const LOCAL_BYTE_SOURCE = new WeakMap<object, BuiltCache | null>();

/** The LOCAL editor-cache data of a stored profile, derived on its own — the only data walk hints and bounds may
 *  rely on (`walkEnumHints`, `walkBlockLimits`, the diagnostic label probe):
 *   - a format-2 doc: its local editor-cache raw source(s) derived standalone (a merged doc's `meta.source`
 *     'editor-cache' does not make every table byte-exact; merged live, cloud or file sources never widen a
 *     bound or create a hint); null when it has none, when its raw envelope is one this build cannot read
 *     (`readableRaw`: a newer or malformed envelope is never trusted, whatever origins it claims) or when that
 *     derivation fails;
 *   - a format-1 doc: the doc itself when `isLocalByteProfile`, else null.
 *  The result keeps the persisted vocabulary (`meta.source: 'editor-cache'`). Memoised per doc object (a result
 *  maps to itself), so repeated lookups of the same stored doc derive once. Pure, no device traffic. */
export function localByteSource(doc: BuiltCache | null | undefined, model: number): BuiltCache | null {
  if (!doc) return null;
  const hit = LOCAL_BYTE_SOURCE.get(doc);
  if (hit !== undefined) return hit;
  let out: BuiltCache | null = null;
  if (profileFormatOf(doc) !== 2) {
    out = isLocalByteProfile(doc.meta) ? doc : null;
  } else {
    const sources = (readableRaw(doc)?.sources ?? []).filter((s) => s.kind === 'editor-cache' && s.origin === 'local');
    if (sources.length > 0) {
      try {
        const { params, seeds } = catalogForModel(model);
        const fw = typeof doc.firmware === 'string' ? doc.firmware : null;
        const derived = buildProfileDoc({ format: RAW_FORMAT as 1, sources }, params, seeds, deriveOptionsFor(model, fw));
        out = { ...derived, meta: { ...derived.meta, source: 'editor-cache' as BuiltCache['meta']['source'] } };
        LOCAL_BYTE_SOURCE.set(out, out);
      } catch {
        out = null;
      }
    }
  }
  LOCAL_BYTE_SOURCE.set(doc, out);
  return out;
}

/** The (model, firmware) pairs the walk's enum hints are verified on: a hinted label walk opens label
 *  queries the device never received before (lists with a non-zero default), so hints are passed only where
 *  a staged hardware probe showed every hinted list answering its first label query — FM3 13.0 (all 118
 *  first-label probes answered). EXACT major.minor, not "at or below": another firmware can renumber or
 *  reshape a table. Extend only after the same staged probe on that model and firmware. */
export const ENUM_HINTS_VERIFIED_FW: Readonly<Record<number, ReadonlyArray<{ readonly major: number; readonly minor: number }>>> = {
  0x11: [{ major: 13, minor: 0 }] // FM3
};

/** The walk-scope gates per (model, firmware) — extended ids, roster blocks above 160, the block probe, far ids — with
 *  their verified-firmware table (`WALK_SCOPE_VERIFIED_FW`, empty in this build: every gate fails closed) and the
 *  Node-only development override. They live in the import-free leaf services/walkScope.ts so the registry core and
 *  the gen-3 driver can read them without an import cycle through this module; re-exported here, their home for the
 *  walk's callers. The registry applies them to the running firmware (`DeviceRegistry.walkScopeGates`). */
export {
  WALK_SCOPE_VERIFIED_FW, WALK_SCOPE_OVERRIDE_ENV, parseWalkScopeOverride, walkScopeGates, walkScopeOverrideFromEnv,
  type FwList, type WalkScopeFlag, type WalkScopeGates, type WalkScopeOverride, type WalkScopeOverrideToken
} from './walkScope.js';

/** Whether the live walk may get enum hints for `model` on firmware `fw`: an exact match in
 *  {@link ENUM_HINTS_VERIFIED_FW}. Unknown or malformed firmware and unlisted models: no (fail closed). */
export function enumHintsVerifiedOn(model: number, fw: { major: number; minor: number } | null | undefined): boolean {
  if (fw == null || !Number.isInteger(fw.major) || !Number.isInteger(fw.minor) || fw.major < 1 || fw.minor < 0) return false;
  return (ENUM_HINTS_VERIFIED_FW[model] ?? []).some((v) => v.major === fw.major && v.minor === fw.minor);
}

/** The label lists the live walk may rely on, per block (the codec's `enumHintByBlock`): for every block
 *  the model's STATIC roster maps to a family (`staticRoster` — every instance of the family by the model's
 *  instance count, and the virtual GLOBAL / CONTROLLERS / MOD blocks), the enum rows of that family as `{ count, typecode }`
 *  (`enumHintsFromRanges`). The codec label-walks a definition whose default slot is non-zero ONLY on such
 *  a hint (type lists, tempo divisions, foot-controller assignments: otherwise they come back as floats).
 *
 *  Source per family: the LOCAL editor-cache data of the stored profile of the attached firmware when it
 *  carries rows for the family (`localByteSource(stored)`: an editor-cache import made by this install, derived
 *  on its own; the caller passes only a usable-schema doc) — exact data for this firmware — else the static
 *  catalog's ranges. NEVER a cloud or definitions-file profile or source (not even one of byte origin: its
 *  provenance is a claim of another install) and never a live walk (stored alone or merged into a format-2
 *  doc) or a profile of unknown provenance: a hint is a promise that the param HAS a label list, and a label
 *  query to a param without one is out of contract for the device. Models without a gen-3 catalog get no
 *  hints. Whether a build passes hints at all is gated by firmware (`enumHintsVerifiedOn`). */
export function walkEnumHints(model: number, stored?: BuiltCache | null): Record<number, Record<number, LiveEnumHint>> {
  const hints: Record<number, Record<number, LiveEnumHint>> = {};
  const profile: DeviceProfile | undefined = PROFILES[model];
  if (!profile) return hints;
  const exact = localByteSource(stored, model);
  const byFamily = new Map<string, Record<number, LiveEnumHint>>();
  const hintsOf = (family: string): Record<number, LiveEnumHint> => {
    let h = byFamily.get(family);
    if (!h) {
      const exactRows = exact?.ranges?.[family];
      const rows = exactRows && Object.keys(exactRows).length > 0 ? exactRows : profile.ranges[family];
      h = rows ? enumHintsFromRanges(rows) : {};
      byFamily.set(family, h);
    }
    return h;
  };
  for (const [block, ref] of staticRoster(model)) {
    if (ref.roster) continue; // named from the roster only (FORGEFX-45): never walk-hinted
    const h = hintsOf(ref.family);
    if (Object.keys(h).length > 0) hints[block] = h;
  }
  return hints;
}

/** Adapt the registry's shared Transport to the codec's minimal LiveTransport: one query → the first
 *  matching Fractal reply frame, or null on timeout (no frame, or a transport timeout rejection:
 *  `isTransportTimeout`; any other rejection still rejects). The matcher mirrors the hardware-proven
 *  capture tooling's query matcher: a reply matches only when it echoes the query's
 *  view (inner[0] = f[6]), BLOCK-HIGH (inner[3] = f[9]), PARAM-LOW (inner[4] = f[10]) and PARAM-HIGH
 *  (inner[5] = f[11]). The device does NOT echo block-LOW — its inner[2] is a constant (0x01), so the
 *  old code's `f[8] === query-block-low` check compared a constant against the block byte and could never
 *  match a high-block reply (inner[2]=0x01 ≠ block-low), letting a stale fn-0x01 frame from an earlier
 *  high-block/high-param query latch onto the wrong one — under a sustained query stream that desync
 *  turns a transient slowdown into a wedge (FORGEFX-32). Matching block-high + both param halves is the
 *  rig-proven fix. EXPORTED for the reply-matcher unit test. */
export function adaptRequest(transport: Transport, query: Uint8Array): Promise<Uint8Array | null> {
  const bytes = Array.from(query);
  const fn = bytes[5];
  const isEcho = (f: readonly number[]): boolean =>
    isFractalHeaderFrame(f) && f[5] === fn
    && f[6] === bytes[6]    // inner[0] — view echo
    && f[9] === bytes[9]    // inner[3] — block-HIGH echo (reaches effectId>=128)
    && f[10] === bytes[10]  // inner[4] — param-LOW echo
    && f[11] === bytes[11]; // inner[5] — param-HIGH echo (id>127)
  return transport
    .request(bytes, { timeoutMs: 1000, quietMs: 20, match: (fs) => fs.some((f) => isEcho(f)) })
    .then(
      (frames) => {
        const hit = frames.find((f) => isEcho(f));
        return hit ? Uint8Array.from(hit) : null;
      },
      // a transport that reports silence as a typed timeout (the browser-direct ones) instead of resolving no frames:
      // the same lost reply, which the walk retries and counts — never a rejected walk
      (e: unknown) => (isTransportTimeout(e) ? null : Promise.reject(e))
    );
}

/** Pacing the walk always runs with (see WALK_PACE_MS / WALK_BLOCK_PAUSE_MS) — exported so other read-only
 *  query sequences over the same link (the diagnostic label probe) keep exactly the same pace. */
export const WALK_PACING: Readonly<{ interQueryMs: number; blockPauseMs: number }> = { interQueryMs: WALK_PACE_MS, blockPauseMs: WALK_BLOCK_PAUSE_MS };

/** The walk options of one live walk besides the transport, and the limits they carry. */
export interface WalkSetup {
  opts: LiveWalkOptions;
  limits: WalkBlockLimits;
  /** The walk got label-list hints (`enumHintsVerifiedOn` the firmware). */
  hinted: boolean;
}

/** The USABLE stored profile of `model` on firmware `fw` (null when none, stale or the firmware is unknown): the only
 *  stored doc whose LOCAL editor-cache data may refine walk limits and hints (`localByteSource`). Only read. */
function usableStoredProfile(store: Store, model: number, fw: { major: number; minor: number } | null): BuiltCache | null {
  // A byte-exact stored cache for this firmware (force-rebuild over an editor-cache import) is exact device data and
  // refines the catalog; a stale one (outdated schema) is not trusted for that either.
  const stored = fw ? loadStoredProfile(store, deviceCacheKey(model, fw.major, fw.minor)) : null;
  return stored?.state === 'usable' ? stored.profile : null;
}

/** Build the live walk's options exactly as the cache build runs it — pacing, the 7-bit (read-only) or
 *  511 (full) ceiling, the per-block limits (`walkBlockLimits`) and the label-list hints, gated by firmware
 *  (`enumHintsVerifiedOn`) — for `model` on the running firmware `fw` (null = unknown: no hints, catalog
 *  limits). A USABLE stored profile of that firmware refines the limits / hints exactly as in a build; it
 *  is only read, never written. Shared by the cache build and the diagnostic capture, so both walk alike. */
export function walkSetup(
  store: Store,
  model: number,
  fw: { major: number; minor: number } | null,
  mode: BuildMode,
  extra: { signal?: AbortSignal; onProgress?: LiveWalkOptions['onProgress']; write?: LiveWalkWriteHooks } = {}
): WalkSetup {
  const full = mode === 'full';
  // Per-block known table size + hard ceiling (see walkBlockLimits). Only the LOCAL editor-cache data of the stored
  // doc refines limits and hints (walkBlockLimits / walkEnumHints take it through localByteSource): a merged live,
  // cloud or file source never does.
  const usable = usableStoredProfile(store, model, fw);
  const limits = walkBlockLimits(model, mode, usable);
  const hinted = enumHintsVerifiedOn(model, fw);
  const opts: LiveWalkOptions = {
    model,
    ...(full ? { mode: 'full' as const, write: extra.write } : {}),
    interQueryMs: WALK_PACE_MS,
    blockPauseMs: WALK_BLOCK_PAUSE_MS,
    maxParamId: full ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID,
    paramKnownSizeByBlock: limits.knownSize,
    paramBoundByBlock: limits.bound,
    // Label lists per block (see walkEnumHints), both modes — only on a (model, firmware) the hints are
    // verified on (enumHintsVerifiedOn); elsewhere the walk gets none and keeps its numeric rule.
    ...(hinted ? { enumHintByBlock: walkEnumHints(model, usable) } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.onProgress ? { onProgress: extra.onProgress } : {})
  };
  return { opts, limits, hinted };
}

/** The walk options of an extension walk (phase B), its limits and its query budget. */
export interface ExtensionSetup {
  opts: LiveWalkOptions;
  limits: ExtensionWalkLimits;
  /** Queries the host adapter lets through (`extensionQueryBudget`). */
  budget: number;
  /** The watchdog's absolute param ceiling (`walkAdapter`): the extended read-only cap 255, or the highest listed far
   *  id when far ids are listed (each still has to be in its block's list). */
  cap: number;
  /** The walk got label-list hints (`enumHintsVerifiedOn` the firmware). */
  hinted: boolean;
}

/** Build the EXTENSION walk's options (phase B) for `model` on the running firmware `fw` under the walk-scope `gates`:
 *  the blocks, bounds, known sizes and far-id lists of `extensionWalkLimits` (the usable stored profile's LOCAL
 *  editor-cache data refines them, as in the standard walk), the same pacing, the label hints of those blocks on a
 *  hinted firmware, and the abort rules of an extension: the first implausible definition reply at id 128 or above
 *  (`abortOnImplausibleFrom`) and any definition query left unanswered (`abortOnSilence`, stricter than the
 *  liveness check: every address an extension queries is known to answer). Always READ-ONLY: no mode, no write
 *  hooks, whatever the build's mode. */
export function extensionWalkSetup(
  store: Store,
  model: number,
  fw: { major: number; minor: number } | null,
  gates: ExtensionGates,
  mode: BuildMode,
  extra: { signal?: AbortSignal; onProgress?: LiveWalkOptions['onProgress'] } = {}
): ExtensionSetup {
  const usable = usableStoredProfile(store, model, fw);
  const limits = extensionWalkLimits(model, usable, gates, mode);
  const hinted = enumHintsVerifiedOn(model, fw);
  const hints: Record<number, Record<number, LiveEnumHint>> = {};
  if (hinted) {
    const all = walkEnumHints(model, usable);
    for (const block of limits.blocks) if (all[block]) hints[block] = all[block]!;
  }
  const opts: LiveWalkOptions = {
    model,
    blocks: [...limits.blocks],
    interQueryMs: WALK_PACE_MS,
    blockPauseMs: WALK_BLOCK_PAUSE_MS,
    maxParamId: WALK_MAX_PARAM_ID,
    paramKnownSizeByBlock: { ...limits.knownSize },
    paramBoundByBlock: { ...limits.bound },
    ...(Object.keys(limits.idLists).length > 0 ? { paramIdsByBlock: { ...limits.idLists } } : {}),
    ...(hinted ? { enumHintByBlock: hints } : {}),
    abortOnImplausibleFrom: WALK_MAX_PARAM_ID + 1,
    abortOnSilence: true,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.onProgress ? { onProgress: extra.onProgress } : {})
  };
  const cap = Math.max(LIVE_WALK_LIMITS.extendedReadOnlyMaxParamId, ...Object.values(limits.idLists).flat());
  return { opts, limits, budget: extensionQueryBudget(limits), cap, hinted };
}

/** The highest param id the walk queries in `block` under `opts`: the block's hard bound, else the
 *  walk's `maxParamId` (the mode default when unset). The diagnostic capture's query-bound watchdog. */
export function walkQueryBound(opts: Pick<LiveWalkOptions, 'paramBoundByBlock' | 'maxParamId' | 'mode'>, block: number): number {
  const b = opts.paramBoundByBlock?.[block];
  if (b !== undefined && Number.isInteger(b)) return b;
  return opts.maxParamId ?? (opts.mode === 'full' ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID);
}

/** An extension walk sent as many queries as its budget allows (`extensionQueryBudget`): the next one is refused
 *  before it reaches the device and the walk rejects. */
export class WalkBudgetError extends Error {
  readonly code = 'walk-budget';
  readonly budget: number;
  constructor(budget: number) {
    super(`liveWalk: query budget of ${budget} queries exhausted; walk aborted`);
    this.name = 'WalkBudgetError';
    this.budget = budget;
  }
}

/** The host side of one walk phase: the registry's transport through `adaptRequest`, behind the bound watchdog —
 *  the codec's `guardWalkTransport`: every outgoing query is decoded, and one for a block outside the scope of `opts`,
 *  above the block's ceiling (`walkQueryBound` of the codec: its hard bound, known size or `maxParamId`) or above
 *  `cap` rejects with `WalkBoundError` and is never sent (defense in depth: independent of the walk implementation)
 *  — and, with a `budget`, a counter of the queries that pass: the first one past it rejects with `WalkBudgetError`,
 *  unsent. `sent()` = queries handed to the transport; `silentBlocks()` = the blocks at least one of them got no reply
 *  in (where a walk's reply-loss statistics can come from). */
export function walkAdapter(
  transport: Transport, opts: LiveWalkOptions, cap: number, budget?: number
): LiveTransport & { sent(): number; refused(): WalkBoundError | WalkBudgetError | null; silentBlocks(): ReadonlySet<number> } {
  let sent = 0;
  let overrun: WalkBudgetError | null = null;
  let hit: WalkBoundError | null = null;
  const silent = new Set<number>();
  const counted: LiveTransport = {
    request: (q) => {
      if (budget !== undefined && sent >= budget) {
        overrun ??= new WalkBudgetError(budget);
        return Promise.reject(overrun);
      }
      sent += 1;
      return adaptRequest(transport, q).then((reply) => {
        if (reply === null) silent.add((q[8]! & 0x7f) | ((q[9]! & 0x7f) << 7));
        return reply;
      });
    }
  };
  const guarded = guardWalkTransport(counted, opts, { maxParamId: cap });
  return {
    request: (q) => guarded.request(q).catch((e: unknown) => {
      if (e instanceof WalkBoundError && hit === null) {
        hit = e;
        console.warn(`[forgefx] walk watchdog: ${e.message} — not sent, the walk is stopped`);
      }
      throw e;
    }),
    sent: () => sent,
    // what the adapter refused (the first watchdog hit, which outranks a budget overrun): a walk implementation that
    // swallowed the rejection and resolved anyway is still judged by it (`refusedBy`)
    refused: () => hit ?? overrun,
    silentBlocks: () => silent
  };
}

/** Throws what a walk adapter refused during a walk that nevertheless resolved (see `walkAdapter`). */
function refusedBy(adapter: { refused(): WalkBoundError | WalkBudgetError | null }): void {
  const r = adapter.refused();
  if (r) throw r;
}

/** Highest effect id the codec's default live walk visits (its DEFAULT_MAX_BLOCK): the standard scope's
 *  block range, recorded in the live raw source's scope. */
const LIVE_WALK_MAX_BLOCK = 160;

/** A walk result from a `WalkImpl`: the detailed result as is, bare records with zeroed statistics. Exported for the
 *  diagnostic capture's definition-walk steps (services/diagnosticCapture.ts). */
export function walkResultOf(r: CacheRecord[] | LiveWalkResult): LiveWalkResult {
  if (!Array.isArray(r)) return r;
  return {
    records: r, queries: 0, enumLabels: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0,
    placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 0 }
  };
}

/** The raw-source kind a build of `mode` produces. */
const liveKindOf = (mode: BuildMode): Extract<RawSourceKind, 'live-full' | 'live-readonly'> => (mode === 'full' ? 'live-full' : 'live-readonly');

/** Phase A's live source joined by the extension walk's result (`extension: 'done'`): the extension's records
 *  replace phase A's for every block it walked (it re-walks a block whole, from id 0, to its wider bound) and add the
 *  blocks only it walked; the scope is the union (the walked blocks' ceilings, far-id lists, `extended` /
 *  `above160` set for what the extension covered); bound hits are phase A's for the blocks the extension did not walk
 *  plus the extension's. Same id, kind, origin, capture time and firmware as phase A's source, so it takes that
 *  source's slot in the document. Records ordered by block, each block in walk order.
 *  Reply statistics: queries and pseudo replies are summed; placeholder slots are phase A's kept placeholder records
 *  plus the extension's. Phase A's reply-LOSS counters (lost, recovered, unresolved, missing slots, silent addresses)
 *  are dropped only when `aSilentBlocks` — the blocks phase A got a lost reply in (`walkAdapter.silentBlocks`) — is
 *  non-empty and holds only blocks the extension re-walked (their losses are superseded); otherwise, or without it,
 *  they are summed (a loss that cannot be placed is never dropped). */
export function joinExtension(
  a: LiveRawSource,
  walked: LiveWalkResult,
  opts: LiveWalkOptions,
  flags: { extended: boolean; above160: boolean },
  aSilentBlocks?: ReadonlySet<number>
): LiveRawSource {
  const scopeB = liveWalkScope(opts, { extended: flags.extended, above160: flags.above160, hinted: a.scope.hinted });
  const b = rawFromLiveWalk(walked, scopeB, { kind: a.kind, capturedAt: a.capturedAt, firmware: a.firmware, origin: a.origin });
  const walkedB = new Set(scopeB.blocks);
  const byBlock = new Map<number, LiveRawSource['records']>();
  const push = (r: LiveRawSource['records'][number]) => {
    const list = byBlock.get(r.section);
    if (list) list.push(r);
    else byBlock.set(r.section, [r]);
  };
  const keptA = a.records.filter((r) => !walkedB.has(r.section));
  for (const r of keptA) push(r);
  for (const r of b.records) push(r);
  const records = [...byBlock.keys()].sort((x, y) => x - y).flatMap((block) => byBlock.get(block)!);
  const bounds: Record<number, number> = { ...a.scope.bounds };
  for (const block of scopeB.blocks) bounds[block] = scopeB.bounds[block] ?? scopeB.maxParamId;
  const idLists: Record<number, number[]> = {};
  for (const [block, ids] of Object.entries(a.scope.idLists ?? {})) if (!walkedB.has(Number(block))) idLists[Number(block)] = [...ids];
  for (const [block, ids] of Object.entries(scopeB.idLists ?? {})) idLists[Number(block)] = [...ids];
  const pa = a.walk.pseudoReplies;
  const pb = b.walk.pseudoReplies;
  const pseudoReplies = pa || pb
    ? {
      endMarker: (pa?.endMarker ?? 0) + (pb?.endMarker ?? 0),
      duplicateId: (pa?.duplicateId ?? 0) + (pb?.duplicateId ?? 0),
      implausible: (pa?.implausible ?? 0) + (pb?.implausible ?? 0)
    }
    : undefined;
  const lossSuperseded = aSilentBlocks !== undefined && aSilentBlocks.size > 0 && [...aSilentBlocks].every((block) => walkedB.has(block));
  const lossA = (n: number) => (lossSuperseded ? 0 : n);
  const placeholdersA = Math.min(a.walk.placeholderSlots, keptA.filter((r) => (r as { placeholder?: boolean }).placeholder === true).length);
  return {
    ...a,
    scope: {
      blocks: [...new Set([...a.scope.blocks, ...scopeB.blocks])].sort((x, y) => x - y),
      maxParamId: a.scope.maxParamId,
      bounds,
      ...(Object.keys(idLists).length > 0 ? { idLists } : {}),
      extended: a.scope.extended || flags.extended,
      above160: a.scope.above160 || flags.above160,
      hinted: a.scope.hinted
    },
    walk: {
      queries: a.walk.queries + b.walk.queries,
      lostReplies: lossA(a.walk.lostReplies) + b.walk.lostReplies,
      recoveredReplies: lossA(a.walk.recoveredReplies) + b.walk.recoveredReplies,
      unresolvedReplies: lossA(a.walk.unresolvedReplies) + b.walk.unresolvedReplies,
      placeholderSlots: placeholdersA + b.walk.placeholderSlots,
      missingSlots: lossA(a.walk.missingSlots) + b.walk.missingSlots,
      silentAddresses: lossA(a.walk.silentAddresses) + b.walk.silentAddresses,
      ...(pseudoReplies ? { pseudoReplies } : {}),
      boundHits: [...a.walk.boundHits.filter((h) => !walkedB.has(h.block)), ...b.walk.boundHits],
      extension: 'done'
    },
    records
  };
}

/** The longest `abortReason` stored (the `.axisdefs` validator's limit for it). */
const ABORT_REASON_MAX = 256;

/** An extension stopped for a reason the build itself found (not a walk rejection): the fixed-vocabulary reason. */
class ExtensionAbort extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = 'ExtensionAbort';
    this.reason = reason;
  }
}

/** Why an extension walk stopped, as stored with the source and sent with the terminal event: a FIXED vocabulary —
 *  `implausible-reply (block b, param p)`, `silent-run (block b)`, `query-budget (n queries)`, `cancelled`,
 *  `empty-block (block b)`, `walk-failed`, `derivation-failed` — never an error message (which may carry anything, a
 *  path included); at most 256 characters. The details go to the log (`runExtension`). Exported for the diagnostic
 *  capture's extension steps, which record the same vocabulary. */
export function extensionAbortReason(e: unknown, signal: AbortSignal): string {
  let reason: string;
  if (signal.aborted) reason = 'cancelled';
  else if (e instanceof ExtensionAbort) reason = e.reason;
  else if (e instanceof LiveWalkAbortError) {
    reason = e.code === 'implausible-reply' ? `implausible-reply (block ${e.block}, param ${e.param})` : `silent-run (block ${e.block})`;
  } else if (e instanceof WalkBudgetError) reason = `query-budget (${e.budget} queries)`;
  else reason = 'walk-failed';
  return reason.slice(0, ABORT_REASON_MAX);
}

/** Outcome of an extension walk (phase B). */
type ExtensionOutcome = { extension: 'done' | 'skipped' } | { extension: 'aborted'; abortReason: string };

/** Phase A's source stored again with its extension outcome (`skipped` / `aborted` + reason), merged and persisted
 *  like phase A was. Best effort: phase A's doc as persisted stays when this fails. */
async function markPhaseA(
  store: Store, registry: DeviceRegistry, job: CacheJob, sourceA: LiveRawSource, outcome: Exclude<ExtensionOutcome, { extension: 'done' }>
): Promise<void> {
  try {
    const marked: LiveRawSource = {
      ...sourceA,
      walk: { ...sourceA.walk, extension: outcome.extension, ...('abortReason' in outcome ? { abortReason: outcome.abortReason } : {}) }
    };
    const now = new Date().toISOString();
    const again = mergeSourcesIntoStored(store, { key: job.key, model: job.model, firmware: job.firmware, incoming: [marked], extras: { builtAt: now }, now });
    if (again.derivationFailed === undefined) {
      persistProfile(store, job.key, again.doc);
      await registry.applyRuntimeCache();
    }
  } catch {
    // phase A's doc as persisted stays
  }
}

/** Phase B of a build: the extension walk over the blocks and bounds `extensionWalkSetup` plans, behind the bound
 *  watchdog and the query budget (`walkAdapter`, cap 255 or the highest listed far id), read-only. Its result joins
 *  phase A's source (`joinExtension`), the doc is re-derived (merged with the stored doc as phase A left it) and
 *  persisted again. Nothing to walk (the setup, recomputed after phase A, has no block): `skipped`.
 *  Phase A is already persisted and applied and is never discarded: when the extension stops — the first implausible
 *  reply at id 128 or above, an unanswered definition query, a failed liveness check, the budget, a cancel, a block
 *  where phase A found definitions and the extension none, or a re-derivation of its result that fails — phase A's
 *  source is stored again marked `extension: 'aborted'` with the `abortReason` (its gaps stay). A watchdog hit
 *  (`WalkBoundError`: a query outside the plan) is a code bug: it rejects — also when the walk swallowed the refusal
 *  and failed or finished otherwise — the build ends with an error, and nothing of phase B is persisted. */
async function runExtension(
  store: Store, registry: DeviceRegistry, job: CacheJob, walkImpl: WalkImpl, transport: Transport, sourceA: LiveRawSource,
  aSilentBlocks: ReadonlySet<number>, onProgress: LiveWalkOptions['onProgress']
): Promise<ExtensionOutcome> {
  const { key, model, firmware, fw, mode, controller } = job;
  const setup = extensionWalkSetup(store, model, fw, job.gates, mode, { signal: controller.signal, onProgress });
  if (setup.limits.blocks.length === 0) {
    await markPhaseA(store, registry, job, sourceA, { extension: 'skipped' });
    return { extension: 'skipped' };
  }
  const adapter = walkAdapter(transport, setup.opts, setup.cap, setup.budget);
  let merged: MergedProfile | null = null;
  let abortReason = 'cancelled';
  try {
    job.progress = { done: 0, total: setup.limits.blocks.length, phase: 'walking' };
    registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: 0, total: setup.limits.blocks.length, key, model, firmware });
    const walked = walkResultOf(await walkImpl(adapter, setup.opts));
    refusedBy(adapter);
    if (!controller.signal.aborted) {
      // a block phase A found definitions in that the extension (re-walking it whole) answered none for: not a table
      // that grew but a walk that went wrong — keep phase A
      const realIn = (records: ReadonlyArray<Parameters<typeof isPlaceholderRecord>[0] & { section: number }>, block: number) =>
        records.some((r) => r.section === block && !isPlaceholderRecord(r));
      for (const block of setup.limits.blocks) {
        if (realIn(sourceA.records, block) && !realIn(walked.records, block)) {
          throw new ExtensionAbort(`empty-block (block ${block})`, `the extension walk found no definition in block ${block}`);
        }
      }
      const joined = joinExtension(sourceA, walked, setup.opts, {
        extended: setup.limits.extendedBlocks.length > 0, above160: setup.limits.above160Blocks.length > 0
      }, aSilentBlocks);
      const now = new Date().toISOString();
      try {
        merged = mergeSourcesIntoStored(store, { key, model, firmware, incoming: [joined], extras: { builtAt: now }, now });
      } catch (e) {
        throw new ExtensionAbort('derivation-failed', e instanceof Error ? e.message : String(e));
      }
      if (merged.derivationFailed !== undefined) throw new ExtensionAbort('derivation-failed', merged.derivationFailed);
      if (controller.signal.aborted) merged = null; // a late cancel discards the extension
    }
  } catch (e) {
    // the watchdog first: a refused query is never a quiet abort, whatever the walk made of the refusal
    const refused = adapter.refused();
    if (refused instanceof WalkBoundError) throw refused;
    if (e instanceof WalkBoundError) throw e;
    merged = null;
    abortReason = extensionAbortReason(e, controller.signal);
    if (abortReason === 'walk-failed' || abortReason === 'derivation-failed') {
      console.warn(`[forgefx] cache build ${key}: extension ${abortReason}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (merged) {
    persistProfile(store, key, merged.doc);
    await registry.applyRuntimeCache();
    return { extension: 'done' };
  }
  // phase A stays: its source again, marked aborted
  console.warn(`[forgefx] cache build ${key}: extension walk aborted (${abortReason}); the standard walk is kept`);
  await markPhaseA(store, registry, job, sourceA, { extension: 'aborted', abortReason });
  return { extension: 'aborted', abortReason };
}

/** The detached build task: pause telemetry, walk → raw source → merge into the stored doc → persist → swap
 *  profile, then (an 'extended' scope with blocks to extend) the extension walk (`runExtension`, phase B), emit the
 *  terminal event, resume telemetry. Never rejects (all outcomes are emitted, not thrown). The walk's records are
 *  kept as a live raw source (unresolved replies and bound hits included: the coverage reports them as blocking
 *  gaps), merged with the doc's other sources by the codec's precedence, unless `replace`. Every walk query passes the
 *  bound watchdog (`walkAdapter`; a hit ends the build with an error, nothing of that phase persisted). */
async function runBuild(store: Store, registry: DeviceRegistry, job: CacheJob, walkImpl: WalkImpl): Promise<void> {
  const { key, model, firmware, fw, mode, controller } = job;
  const full = mode === 'full';
  const resume = registry.pauseTelemetry(); // synchronous — telemetry is off before the first await
  registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: 0, total: 0, key, model, firmware });
  try {
    const transport = await registry.transport();
    // FULL mode writes: the codec BUILDS the continuous-SET frame and hands us finished bytes → we just
    // put them on the wire via the transport's serialized raw send (the same sendQueued gen-3 writes use,
    // so a SET never injects mid-read). reloadPreset re-selects the CURRENT preset through the gen-3
    // driver (fullCapture gates full mode to gen-3, so reloadPreset is present). Telemetry is already
    // paused around the whole build, so these writes are the only device traffic besides the walk queries.
    let write: LiveWalkWriteHooks | undefined;
    if (full) {
      const driver = await registry.driver();
      write = {
        send: (frame) => transport.sendQueued(Array.from(frame)),
        reloadPreset: () => driver.reloadPreset?.() ?? Promise.resolve()
      };
    }
    const onProgress: LiveWalkOptions['onProgress'] = (p) => {
      if (controller.signal.aborted) return;
      if (p.phase === 'done') {
        job.progress = { done: p.blockCount, total: p.blockCount, phase: 'building' };
        registry.emitEvent({ type: 'cacheBuild', phase: 'building', done: p.blockCount, total: p.blockCount, key, model, firmware });
      } else {
        job.progress = { done: p.blockIndex, total: p.blockCount, phase: 'walking' };
        registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: p.blockIndex, total: p.blockCount, key, model, firmware });
      }
    };
    const setup = walkSetup(store, model, fw, mode, { signal: controller.signal, write, onProgress });
    const adapter = walkAdapter(transport, setup.opts, full ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID);
    const walked = walkResultOf(await walkImpl(adapter, setup.opts));
    refusedBy(adapter);
    if (controller.signal.aborted) throw new Error('cancelled'); // a late abort discards the result
    const capturedAt = new Date().toISOString();
    const scope: LiveSourceScope = {
      blocks: Array.from({ length: LIVE_WALK_MAX_BLOCK + 1 }, (_, i) => i),
      maxParamId: setup.opts.maxParamId ?? WALK_MAX_PARAM_ID,
      bounds: { ...setup.limits.bound },
      extended: false,
      above160: false,
      hinted: setup.hinted
    };
    // An extended scope whose gates open nothing to extend walks the standard scope only: 'skipped'.
    const skipped = job.scope === 'extended' && !job.phaseB;
    const source = rawFromLiveWalk(walked, scope, {
      kind: liveKindOf(mode), capturedAt, firmware, origin: 'local', ...(skipped ? { extension: 'skipped' as const } : {})
    });
    const merged = mergeSourcesIntoStored(store, {
      key, model, firmware, incoming: [source], replace: job.replace, extras: { builtAt: capturedAt }, now: capturedAt
    });
    if (controller.signal.aborted) throw new Error('cancelled');
    // phase A is persisted and applied before any extension query: an extension never puts it at risk
    persistProfile(store, key, merged.doc);
    await registry.applyRuntimeCache(); // adopt the freshly-built device-true profile immediately
    if (merged.derivationFailed !== undefined) {
      // the stored doc was stale (its sources did not derive) and still does not derive with the walk added: the
      // walk is kept with the other sources (nothing lost), the doc stays stale — a terminal error, not 'done'
      const total = job.progress.total;
      registry.emitEvent({
        type: 'cacheBuild', phase: 'error', done: total, total, key, model, firmware,
        error: `derivation-failed: ${merged.derivationFailed} (the walk was stored next to the profile's other sources)`
      });
      return;
    }
    let outcome: { extension: 'done' | 'skipped' | 'aborted'; abortReason?: string } | undefined = skipped ? { extension: 'skipped' } : undefined;
    if (job.phaseB) outcome = await runExtension(store, registry, job, walkImpl, transport, source, adapter.silentBlocks(), onProgress);
    const total = job.progress.total;
    registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: total, total, key, model, firmware, ...(outcome ?? {}) });
    if (merged.kept > 0) registry.emitEvent({ type: 'definitions', reason: 'merged', key });
  } catch (e) {
    const phase = controller.signal.aborted ? 'cancelled' : 'error';
    registry.emitEvent({ type: 'cacheBuild', phase, done: job.progress.done, total: job.progress.total, key, model, firmware, ...(phase === 'error' ? { error: (e as Error).message } : {}) });
  } finally {
    resume();
  }
}

/** The current cache key (model + firmware known), or null. */
function currentKey(registry: DeviceRegistry): string | null {
  const model = registry.detectedModelId;
  const fw = registry.firmwareInfo();
  return model >= 0 && fw ? deviceCacheKey(model, fw.major, fw.minor) : null;
}

/** Resolve the cache key for the attached device. When the running firmware is unknown (the fn 0x08
 *  read is gen-3-only — the AM4 never has one), fall back to the NEWEST stored doc for the model
 *  (imports persist under the FILE's firmware key), so status/delete/persisted still find the
 *  profile on firmware-less devices. */
export function resolveCacheKey(store: Store, registry: DeviceRegistry): string | null {
  const exact = currentKey(registry);
  if (exact) return exact;
  const model = registry.detectedModelId;
  if (model < 0) return null;
  const prefix = `${model.toString(16).padStart(2, '0')}_`;
  const docs = store.listDocs('deviceCaches').filter((d) => d.id.startsWith(prefix));
  if (docs.length === 0) return null;
  return docs.sort((a, b) => b.updatedAt - a.updatedAt)[0]!.id;
}

/** GET /device/cache — current key + existence + live build progress + stored-doc meta, plus whether
 *  the stored profile is stale (schema this build cannot use, or a failed re-derivation) and the current
 *  schema number. Additive v2 fields: `format`, `sources` (one line per raw source), `coverage` (usable doc:
 *  document-level gaps + counts) and `rederived` (this read re-derived a format-2 doc from its raw sources and
 *  wrote it back unless a newer build wrote it — no device traffic). */
export async function cacheStatus(store: Store, registry: DeviceRegistry): Promise<CacheStatus> {
  await registry.driver(); // ensure detection ran so model/firmware are populated
  const key = resolveCacheKey(store, registry);
  const job = JOBS.get(registry);
  const stored: StoredProfile = key ? upgradeStoredProfile(store, key) : { state: 'absent' };
  const exists = stored.state !== 'absent';
  const out: CacheStatus = { key, exists, building: !!job, stale: stored.state === 'stale', currentSchema: CURRENT_CACHE_SCHEMA };
  if (job) out.progress = { ...job.progress };
  if (stored.state === 'stale') out.staleReason = stored.check.reason;
  if (stored.state !== 'absent') {
    const data = stored.profile;
    out.meta = {
      recordCount: data.meta?.recordCount ?? 0,
      builtAt: data.meta?.builtAt ?? null,
      firmware: data.firmware ?? null,
      unmappedSections: data.unmappedSections?.length ?? 0,
      unmappedFamilies: data.unmappedFamilies?.length ?? 0,
      // Where the persisted profile came from: 'live' (A3 walk), 'editor-cache' (import), 'cloud'
      // (pull), 'axisdefs' (definitions file). Axis surfaces this next to the device info.
      source: (data.meta as { source?: string } | undefined)?.source ?? 'live',
      schema: stored.check.schema
    };
    out.format = stored.format;
    if (stored.state === 'usable') {
      const summary = profileSummaryOf(data, registry.detectedModelId >= 0 ? registry.detectedModelId : null);
      out.sources = summary.sources;
      out.coverage = summary.coverage;
      if (stored.rederived) {
        out.rederived = true;
        if (stored.upgraded && key) registry.emitEvent({ type: 'definitions', reason: 'rederived', key });
      }
    } else {
      const listed = (data.meta as { sources?: unknown } | undefined)?.sources;
      out.sources = stored.format === 2 && Array.isArray(listed) ? (listed as SourceSummary[]).map((s) => ({ ...s })) : [];
    }
  }
  return out;
}

/** Coverage fixes a repeat walk of the same kind and scope can deliver. A blocking gap whose fixes do not include
 *  one of these (`high-ids` / `blocks-above-160` / `rosters` → `read-extended` / `import-editor-cache`,
 *  `disagreement` → `import-editor-cache`) does not make a build walk again: the same walk would leave it open.
 *  (A build with an extension walks again while the stored source does not cover it, see `buildSatisfied`.) */
const REWALK_FIXES: ReadonlySet<string> = new Set(['read-from-device']);

/** What an extension walk of this build would add (`extensionWalkLimits`): ids above 127, blocks above 160. */
interface ExtensionNeed { extended: boolean; above160: boolean }

/** Does the stored profile already satisfy a build of `mode` (`already: true`, contract §4.1)? Only a format-2 doc
 *  that holds a LOCAL live source of the requested kind (a read-only request is also satisfied by a full walk,
 *  its superset) and whose coverage has no blocking gap a repeat walk could fix (`REWALK_FIXES`). A legacy
 *  format-1 live doc holds no raw source: the build walks and writes a format-2 doc in its place (the `no-raw`
 *  gap's `read-from-device` fix); a legacy local editor-cache import is handled before (`startClaimedBuild`).
 *  A build with an extension (`need`) is satisfied only by such a source whose scope already covers it
 *  (`scope.extended` / `scope.above160`, set by a completed extension): one whose extension was skipped or
 *  aborted walks again. The extension's `read-extended` fix is deliberately not a re-walk fix: an extended source
 *  that still leaves high ids open would be walked again by every build. Anything else walks and merges. */
function buildSatisfied(stored: Extract<StoredProfile, { state: 'usable' }>, mode: BuildMode, model: number, need: ExtensionNeed): boolean {
  if (stored.format !== 2) return false;
  const kinds: readonly RawSourceKind[] = mode === 'full' ? ['live-full'] : ['live-readonly', 'live-full'];
  const summary = profileSummaryOf(stored.profile, model);
  const rewalkGap = summary.coverage.gaps.some((g) => g.blocking && g.fix.some((f) => REWALK_FIXES.has(f)));
  if (rewalkGap || !summary.sources.some((s) => kinds.includes(s.kind) && s.origin === 'local')) return false;
  if (!need.extended && !need.above160) return true;
  return (readableRaw(stored.profile)?.sources ?? []).some((s) =>
    s.kind !== 'editor-cache' && kinds.includes(s.kind) && s.origin === 'local'
    && (!need.extended || s.scope.extended) && (!need.above160 || s.scope.above160));
}

/** TEST-ONLY: the walk a build runs when its caller passes no `walkImpl` (a route has no way to pass one), per
 *  registry — lets a suite drive the real build path through either twin's route. `null` restores the codec's. */
const DEFAULT_WALKS = new WeakMap<DeviceRegistry, WalkImpl>();
export function __setDefaultWalkForTest(registry: DeviceRegistry, walk: WalkImpl | null): void {
  if (walk) DEFAULT_WALKS.set(registry, walk);
  else DEFAULT_WALKS.delete(registry);
}

/** POST /device/cache/build — start a background build (or report already-built / gated). Returns
 *  immediately; the build runs detached. `mode` (default 'read-only') selects the HW-proven read-only
 *  sweep or the fullCapture-gated write-sweep (refused on unverified or unknown firmware). The walk merges
 *  into the stored doc (`replace: true` replaces it); `already: true` only when the doc already holds a
 *  complete local source of the requested kind (`buildSatisfied`; `force` walks anyway and replaces that
 *  source), or is a legacy (format-1) local editor-cache import (byte data a walk cannot improve and no raw to
 *  merge with: `force` answers 409 `local-profile-better`, only `replace` walks over it). A doc a newer build
 *  wrote answers 409 `newer-profile` unless `replace` (see profileMerge.ts `mergeRefusal`). `scope` (see
 *  `BuildScope`; default 'extended' for a read-only build when a walk-scope gate of the running firmware, read afresh,
 *  is open): an 'extended' build
 *  runs the extension walk (phase B, `runExtension`) after the standard walk, when its gates open blocks to extend;
 *  the terminal `done` event carries `extension: 'done' | 'skipped' | 'aborted'` (+ `abortReason`). `walkImpl` is a
 *  test seam (defaults to the codec's liveWalkDetailed; it runs once per phase). */
export async function startCacheBuild(store: Store, registry: DeviceRegistry, opts?: CacheBuildOptions): Promise<StartResult> {
  await registry.driver(); // ensure detection ran
  const caps = registry.activeCapabilities();
  if (!caps?.selfDescribe) return { code: 501, body: { error: 'unsupported', capability: 'selfDescribe' } };
  const mode: BuildMode = opts?.mode === 'full' ? 'full' : 'read-only';
  // FULL-mode write-sweep is gated on the CaptureRig-proven fullCapture cap (gen-3 trio only). Mirror the
  // selfDescribe 501 shape so Axis handles both gates identically.
  if (mode === 'full' && !caps.fullCapture) return { code: 501, body: { error: 'unsupported', capability: 'fullCapture' } };
  // A build is already running: refuse BEFORE anything touches the device. The full-mode firmware re-read below
  // sends fn 0x08 and clears the cached firmware, which must never happen in the middle of a running walk.
  if (JOBS.has(registry)) return { code: 409, body: { error: 'building' } };
  // The device is exclusive between this build and the diagnostic capture: claim it before the first await
  // (a running capture answers 409 busy, a concurrent build start the usual 'building').
  if (!claimDevice(registry, 'cache-build')) {
    const busy = deviceBusy(registry);
    return busy !== null && busy !== 'cache-build' ? { code: 409, body: { error: 'busy', what: busy } } : { code: 409, body: { error: 'building' } };
  }
  let started = false;
  try {
    const r = await startClaimedBuild(store, registry, opts);
    started = r.started;
    return r.result;
  } finally {
    if (!started) releaseDevice(registry, 'cache-build');
  }
}

/** The rest of startCacheBuild, with the device claimed. `started` = a job now owns the claim (its task
 *  releases it when it settles); otherwise the caller releases it. */
async function startClaimedBuild(store: Store, registry: DeviceRegistry, opts: CacheBuildOptions | undefined): Promise<{ started: boolean; result: StartResult }> {
  const mode: BuildMode = opts?.mode === 'full' ? 'full' : 'read-only';
  const done = (result: StartResult) => ({ started: false as const, result });
  // FULL mode WRITES to the device, so it additionally needs a firmware it has been verified on: per model, inside the
  // FULL_CAPTURE_VERIFIED_FW range, refused below its minimum as well as above its maximum (a firmware can move the
  // table ends the walk relies on: on FM3 13.0 a walk without the table-end bound did not stop at a block's end and
  // would have written sweep values to non-existent params; an older firmware was never exercised at all). The
  // firmware is RE-READ right before deciding (fn 0x08,
  // the detect path) so a unit that changed firmware or went quiet since detect() is never judged on a stale
  // version; a silent unit is unknown and therefore refused (fail closed). Same 501/capability shape as the
  // gates above, plus additive `reason: 'firmware'` / `firmware` / `message` fields. Read-only mode is
  // intentionally NOT gated by this rule (the released read-only walk is hardware-proven on FM3 firmware 13.0).
  let fwFresh = false; // the firmware below was re-read for this build (not the one cached at detect)
  if (mode === 'full') {
    const fwNow = await registry.refreshFirmware();
    fwFresh = true;
    if (!fullCaptureAllowedOnFirmware(registry.detectedModelId, fwNow)) {
      return done({
        code: 501,
        body: {
          error: 'unsupported',
          capability: 'fullCapture',
          reason: 'firmware',
          firmware: fwNow?.version ?? null,
          message: fwNow
            ? `full capture is only enabled on firmware versions it has been verified on (this device runs ${fwNow.version}); use read-only`
            : 'full capture needs a known firmware version and the firmware could not be read from the device; re-detect the device'
        }
      });
    }
  }
  const model = registry.detectedModelId;
  let fw = registry.firmwareInfo();
  if (model < 0 || !fw) return done({ code: 503, body: { error: 'no device detected or firmware unknown' } });
  // The walk scope: the requested one, else 'extended' for a READ-ONLY build when a walk-scope gate of the running
  // firmware is open (a full build stays standard unless 'extended' is asked for: full mode is unchanged). The gates
  // are judged on a FRESH firmware read, never on the version cached at detect (the unit may have been updated since):
  // whenever the scope could be extended the firmware is re-read first, and the key and the gates come from that read.
  // A version that cannot be read fails closed: the standard scope only (the cached version keys the build).
  let gates: WalkScopeGates = registry.walkScopeGates();
  const extending = (g: WalkScopeGates) => g.extendedIds || g.above160;
  const couldExtend = opts?.scope === 'extended' || (opts?.scope === undefined && mode === 'read-only' && extending(gates));
  if (couldExtend && !fwFresh) {
    const fresh = await registry.refreshFirmware({ keepOnSilence: true });
    if (fresh) {
      fw = fresh;
      gates = registry.walkScopeGates();
    } else {
      gates = { extendedIds: false, above160: false, blockProbe: false, farIds: false };
    }
  }
  const scope: BuildScope = opts?.scope === undefined
    ? (mode === 'read-only' && extending(gates) ? 'extended' : 'standard')
    : opts.scope === 'extended' ? 'extended' : 'standard';
  const firmware = fw;
  const key = deviceCacheKey(model, firmware.major, firmware.minor);
  const replace = opts?.replace === true;
  // Only a USABLE profile can count as "already built" (a stale one is rebuilt without `force` and merged into or
  // replaced by the new build; it is never deleted up front, a cancelled/failed build leaves it), and only when it
  // already holds what this build would add (`buildSatisfied`).
  const stored = loadStoredProfile(store, key);
  // The extension (phase B) runs when the scope is 'extended' and has blocks to extend (`extensionWalkLimits`, from the
  // same usable stored doc the walk limits read); otherwise an 'extended' scope reports `extension: 'skipped'`.
  const planned = scope === 'extended'
    ? extensionWalkLimits(model, stored.state === 'usable' ? stored.profile : null, gates, mode)
    : null;
  const need: ExtensionNeed = { extended: (planned?.extendedBlocks.length ?? 0) > 0, above160: (planned?.above160Blocks.length ?? 0) > 0 };
  const already = (): { started: false; result: StartResult } => {
    registry.emitEvent({ type: 'cacheBuild', phase: 'already-built', done: 0, total: 0, key, model, firmware: firmware.version });
    return done({ code: 200, body: { ok: true, already: true } });
  };
  // A doc a newer build wrote, or a raw-less doc that outranks this walk, is never rewritten (409 unless `replace`).
  const refusal: MergeRefusal | null = mergeRefusal(store, key, [{ kind: liveKindOf(mode), origin: 'local' }], { replace });
  if (refusal?.error === 'newer-profile') return done({ code: 409, body: refusalBody(refusal) });
  if (stored.state === 'usable' && !replace && !opts?.force) {
    // A legacy (format-1) doc decoded from an editor cache (a local import, or a cloud / file profile of byte origin):
    // byte-exact tables with no raw source to merge a walk into — a walk could only replace them with a live
    // reconstruction. Already built; `force` is refused below (409 local-profile-better), `replace: true` replaces
    // it (the old behaviour).
    if (refusal) return already();
    if (buildSatisfied(stored, mode, model, need)) return already();
  }
  if (refusal) return done({ code: 409, body: refusalBody(refusal) });
  const job: CacheJob = {
    key, model, firmware: firmware.version, fw: { major: firmware.major, minor: firmware.minor }, mode,
    scope,
    gates,
    phaseB: (planned?.blocks.length ?? 0) > 0,
    replace,
    controller: new AbortController(),
    progress: { done: 0, total: 0, phase: 'walking' },
    promise: Promise.resolve()
  };
  JOBS.set(registry, job);
  job.promise = runBuild(store, registry, job, opts?.walkImpl ?? DEFAULT_WALKS.get(registry) ?? liveWalkDetailed).finally(() => {
    if (JOBS.get(registry) === job) JOBS.delete(registry);
    releaseDevice(registry, 'cache-build');
  });
  return { started: true, result: { code: 200, body: { ok: true, key, started: true } } };
}

/** POST /device/cache/cancel — abort a running build (idempotent when none runs). */
export function cancelCacheBuild(registry: DeviceRegistry): { ok: true } {
  JOBS.get(registry)?.controller.abort();
  return { ok: true };
}

/** DELETE /device/cache — drop the current key's stored doc, and with it the runtime profile layered from
 *  it: the driver falls back to the bundled profile unless another usable doc still applies. */
export async function deleteCache(store: Store, registry: DeviceRegistry): Promise<{ ok: true; deleted: boolean }> {
  await registry.driver(); // ensure detection ran so the key resolves
  const key = resolveCacheKey(store, registry);
  if (!key) return { ok: true, deleted: false };
  const doc = store.getDoc('deviceCaches', key);
  if (!doc || doc.deleted) return { ok: true, deleted: false };
  store.delDoc('deviceCaches', key);
  await registry.applyRuntimeCache();
  return { ok: true, deleted: true };
}

/** TEST-ONLY: the in-flight build's promise (or null) so suites can await completion. */
export function cacheBuildPromise(registry: DeviceRegistry): Promise<void> | null {
  return JOBS.get(registry)?.promise ?? null;
}
