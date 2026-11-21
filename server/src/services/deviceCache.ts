// Device-cache build orchestration — the runtime on-connect self-describe cache (FORGEFX-15 / A3).
// One background build at a time per registry (module-level WeakMap job state), driving the codec's
// live self-describe walk over the registry's shared transport into a `BuiltCache`, persisting it to
// the `deviceCaches` store collection, and swapping the driver's profile to the device-true runtime
// one. Progress is streamed as `cacheBuild` SSE events. Endpoints (both twins) are thin wrappers over
// the exported functions here — all the logic lives in this module.
//
// Browser-safe: the store + registry are type-only imports (a browser runtime supplies its own), and
// the codec's cache subpath is itself browser-safe. NO node:/fastify/transport VALUE imports — this
// module is in the runtime router's import graph (check-browser-safe.ts enforces it).
import { buildCache, enumHintsFromRanges, HW_SEEDS, liveWalk, type BuiltCache, type CacheRecord, type DeviceParam, type LiveEnumHint, type LiveTransport, type LiveWalkOptions, type LiveWalkWriteHooks } from 'forgefx-midi/cache';
import { FM3_EFFECT_ID_TABLE, FM3_PARAMS } from 'forgefx-midi/gen3/fm3';
import { FM9_EFFECT_ID_TABLE, FM9_PARAMS } from 'forgefx-midi/gen3/fm9';
import { AXE_FX_III_BLOCKS, PARAMS as AXE3_PARAMS } from 'forgefx-midi/gen3/axe-fx-iii';
import { isFractalHeaderFrame } from 'forgefx-midi/shared';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from 'forgefx-midi/am4';
import { deviceCacheKey, fullCaptureAllowedOnFirmware, type DeviceRegistry } from '../drivers/registryCore.js';
import { PROFILES, SLUG_FAMILY, isByteExactProfile, type DeviceProfile } from '../devices.js';
import { CURRENT_CACHE_SCHEMA, loadStoredProfile, type StaleReason } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';
import type { Transport } from '../transport/types.js';

/** Injectable walk (defaults to the codec's `liveWalk`) — tests fake it so they never septet-encode
 *  wire frames. Must resolve to the decoded `CacheRecord[]` `buildCache` consumes. */
export type WalkImpl = (transport: LiveTransport, opts: LiveWalkOptions) => Promise<CacheRecord[]>;

/** Build mode: 'read-only' is the HW-proven default sweep; 'full' adds the CaptureRig-parity write-sweep
 *  that recovers per-float knob tapers (requires the fullCapture capability + write hooks, and a firmware
 *  the model's full capture has been verified on — FULL_CAPTURE_MAX_VERIFIED_FW, see startCacheBuild). */
export type BuildMode = 'read-only' | 'full';

interface CacheJob {
  key: string;
  model: number;
  firmware: string;
  /** The running firmware the job was started on (gates the enum hints, see `enumHintsVerifiedOn`). */
  fw: { major: number; minor: number };
  mode: BuildMode;
  controller: AbortController;
  progress: { done: number; total: number; phase: 'walking' | 'building' };
  promise: Promise<void>;
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
  /** The stored profile is not usable by this build (schema missing / outdated / newer): it is not
   *  applied at runtime, does not count as built, and must be re-read. False when nothing is stored. */
  stale: boolean;
  /** Why it is stale — only present when `stale`. */
  staleReason?: StaleReason;
  /** The schema this build writes and accepts. */
  currentSchema: number;
}

/** Gen-3 param catalog for the walk's section→family voter, by model byte. Only selfDescribe (gen-3
 *  grid) models reach here; FM3 is the defensive default. */
export function paramsForModel(model: number): DeviceParam[] {
  switch (model) {
    case 0x12: return FM9_PARAMS as unknown as DeviceParam[];
    case 0x10: return AXE3_PARAMS as unknown as DeviceParam[];
    case 0x11:
    default: return FM3_PARAMS as unknown as DeviceParam[];
  }
}

/** Per-model catalog + seed anchors for buildCache. Gen-3 grid models share HW_SEEDS (cache-tag
 *  space); the AM4 has its own section tags and param model (cacheImport only, no live walk). The
 *  editor-cache import uses this so every cacheImport-capable model feeds buildCache correctly. */
export function catalogForModel(model: number): { params: DeviceParam[]; seeds: Record<string, number> } {
  if (model === 0x15) return { params: AM4_CACHE_PARAMS as unknown as DeviceParam[], seeds: AM4_SEEDS };
  return { params: paramsForModel(model), seeds: HW_SEEDS };
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

/** A block address of the model's static roster: its catalog family, which instance of the family it is
 *  (1-based) and the family's editor slug (undefined for families without one, e.g. GLOBAL). */
export interface StaticBlockRef { family: string; instance: number; slug?: string }

/** Catalog family -> editor slug (the inverse of `SLUG_FAMILY`). */
const FAMILY_SLUG: Record<string, string> = Object.fromEntries(Object.entries(SLUG_FAMILY).map(([slug, family]) => [family, slug]));

/** Number of reserved effect ids per first id in the shared gen-3 roster (the Axe-Fx III block table). */
const GEN3_RESERVED_IDS: ReadonlyMap<number, number> = new Map(
  AXE_FX_III_BLOCKS.filter((b) => b.firstId !== null).map((b) => [b.firstId as number, b.instances] as const)
);

const STATIC_ROSTERS = new Map<number, ReadonlyMap<number, StaticBlockRef>>();

/** Block address -> family through the model's STATIC roster only, never a section→family vote of a walk
 *  (per-block walk options keyed through a vote would land on the wrong block whenever the vote is wrong).
 *  Shared by `walkBlockLimits` and `walkEnumHints`.
 *   - Placeable blocks: every family the model's family table classifies as a block (FM3 / FM9: their own
 *     tables; Axe-Fx III: the shared gen-3 families) maps its ids first..first+n-1, where n is the model's
 *     instance count for the family: the roster's (FM3/FM9 table, or the III block table on the III),
 *     raised to the unit's device-true count (`instanceLimits`) where the table lists fewer (the FM3/FM9
 *     table lists one Input and one Output; the units have more), never past the ids the gen-3 roster
 *     reserves for the family. So an Axe-Fx III fifth Input (41) is mapped, a fourth FM3/FM9 multiplexer
 *     (194) is not.
 *   - Everything else: the profile's virtual effect ids (GLOBAL 1, CONTROLLERS 2, MOD 3, ...). */
export function staticRoster(model: number): ReadonlyMap<number, StaticBlockRef> {
  const cached = STATIC_ROSTERS.get(model);
  if (cached) return cached;
  const out = new Map<number, StaticBlockRef>();
  const profile: DeviceProfile | undefined = PROFILES[model];
  const table = model === 0x11 ? FM3_EFFECT_ID_TABLE : model === 0x12 ? FM9_EFFECT_ID_TABLE : model === 0x10 ? FM3_EFFECT_ID_TABLE : undefined;
  if (profile && table) {
    for (const e of table) {
      if (e.addressing !== 'block' || e.firstId === null) continue;
      const slug = FAMILY_SLUG[e.family];
      const reserved = GEN3_RESERVED_IDS.get(e.firstId) ?? e.instances;
      const rosterCount = model === 0x10 ? reserved : e.instances;
      const deviceCount = slug ? (profile.instanceLimits[slug] ?? profile.defaultInstances) : 0;
      const n = Math.min(Math.max(rosterCount, deviceCount), reserved);
      for (let i = 0; i < n; i++) out.set(e.firstId + i, { family: e.family, instance: i + 1, ...(slug ? { slug } : {}) });
    }
    for (let block = 0; block <= WALK_BOUND_MAX_BLOCK; block++) {
      if (out.has(block)) continue;
      const family = profile.familyForEffectId(block);
      if (family !== undefined) out.set(block, { family, instance: 1 });
    }
  }
  STATIC_ROSTERS.set(model, out);
  return out;
}

/** Known table size and hard ceiling per block for the live walk (see `WalkBlockLimits`).
 *
 *  Table size: the family's `stride` in `rangeSections`, the wire slot count (a table of N slots holds
 *  ids 0..N-1). NOT `recordCount`: that also counts special table records (ids >= 0xff00) that no walk
 *  reaches (FM3 CABINET: 110 records, ids 0..105). The sections are the STATIC catalog of the model,
 *  replaced per family by the stored cache of the attached firmware when that one is byte-exact
 *  (`byteExact`: editor-cache import / byte-sourced cloud profile, exact device data that wins outright,
 *  as in `runtimeProfileFrom`; an unusable stride in it falls back to the catalog's, the family is not
 *  dropped). A stored LIVE-walk profile is deliberately NOT used: its sizes are a heuristic (a pre-bound
 *  walk may have counted junk past the table end), and a bound must never come from the very junk it
 *  exists to stop.
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
export function walkBlockLimits(model: number, mode: BuildMode, byteExact?: BuiltCache | null): WalkBlockLimits {
  const limits: WalkBlockLimits = { knownSize: {}, bound: {} };
  const profile: DeviceProfile | undefined = PROFILES[model];
  if (!profile) return limits; // no gen-3 catalog for this model: codec defaults everywhere
  const exact = byteExact && isByteExactProfile(byteExact.meta) ? byteExact : null;
  const strides: Record<string, number> = {};
  for (const [family, meta] of Object.entries(profile.rangeSections)) {
    if (usableStride(meta.stride)) strides[family] = Math.floor(meta.stride);
  }
  for (const [family, meta] of Object.entries(exact?.rangeSections ?? {})) {
    if (usableStride(meta.stride)) strides[family] = Math.floor(meta.stride);
  }
  const cap = mode === 'full' ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID;
  // Ordinary param ids (below the 0xff00 special records) of a family: the byte-exact cache's rows when it
  // carries any for the family (exact for the firmware), else the static catalog's params and ranges.
  const idsOf = (family: string): number[] => {
    const exactIds = Object.keys(exact?.ranges?.[family] ?? {}).map(Number);
    const ids = exactIds.length > 0
      ? exactIds
      : [...(profile.params[family] ?? []).map((d) => d.paramId), ...Object.keys(profile.ranges[family] ?? {}).map(Number)];
    return [...new Set(ids)].filter((i) => Number.isInteger(i) && i >= 0 && i < 0xff00).sort((x, y) => x - y);
  };
  const roster = staticRoster(model);
  for (let block = 0; block <= WALK_BOUND_MAX_BLOCK; block++) {
    const ref = roster.get(block);
    const family = ref?.family;
    const stride = family ? strides[family] : undefined;
    if (family === undefined || stride === undefined) {
      if (mode === 'full') limits.bound[block] = WALK_MAX_PARAM_ID; // unknown block: the HW-proven envelope
      continue;
    }
    const ids = idsOf(family);
    if (ids.length > 0 && ids[ids.length - 1]! + 1 > stride) {
      limits.bound[block] = Math.min(lastLowContiguousId(ids) + WALK_BOUND_MARGIN, cap); // not a contiguous table
      continue;
    }
    limits.bound[block] = Math.min(stride - 1 + WALK_BOUND_MARGIN, cap);
    const present = !ref?.slug || ref.instance <= (profile.instanceLimits[ref.slug] ?? profile.defaultInstances);
    if (present) limits.knownSize[block] = stride;
  }
  return limits;
}

/** A stored profile decoded from editor-cache bytes BY THIS INSTALL: `meta.source` 'editor-cache' (an
 *  editor-cache import) or 'bytes' (the codec's byte-source value). Unlike `isByteExactProfile` it refuses
 *  cloud profiles, whatever `meta.origin` claims. */
export function isLocalByteProfile(meta: { source?: unknown } | undefined): boolean {
  return meta?.source === 'editor-cache' || meta?.source === 'bytes';
}

/** The (model, firmware) pairs the walk's enum hints are verified on: a hinted label walk opens label
 *  queries the device never received before (lists with a non-zero default), so hints are passed only where
 *  a staged hardware probe showed every hinted list answering its first label query — FM3 13.0 (all 118
 *  first-label probes answered). EXACT major.minor, not "at or below": another firmware can renumber or
 *  reshape a table. Extend only after the same staged probe on that model and firmware. */
export const ENUM_HINTS_VERIFIED_FW: Readonly<Record<number, ReadonlyArray<{ readonly major: number; readonly minor: number }>>> = {
  0x11: [{ major: 13, minor: 0 }] // FM3
};

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
 *  Source per family: a LOCAL byte-exact stored cache of the attached firmware when it carries rows for the
 *  family (`isLocalByteProfile`: an editor-cache import made by this install; the caller passes only a
 *  usable-schema doc) — exact data for this firmware — else the static catalog's ranges. NEVER a cloud
 *  profile (not even one of byte origin: its provenance is a claim of another install) and never a stored
 *  live-walk profile or one of unknown provenance: a hint is a promise that the param HAS a label list, and
 *  a label query to a param without one is out of contract for the device. Models without a gen-3 catalog
 *  get no hints. Whether a build passes hints at all is gated by firmware (`enumHintsVerifiedOn`). */
export function walkEnumHints(model: number, byteExact?: BuiltCache | null): Record<number, Record<number, LiveEnumHint>> {
  const hints: Record<number, Record<number, LiveEnumHint>> = {};
  const profile: DeviceProfile | undefined = PROFILES[model];
  if (!profile) return hints;
  const exact = byteExact && isLocalByteProfile(byteExact.meta) ? byteExact : null;
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
    const h = hintsOf(ref.family);
    if (Object.keys(h).length > 0) hints[block] = h;
  }
  return hints;
}

/** Adapt the registry's shared Transport to the codec's minimal LiveTransport: one query → the first
 *  matching Fractal reply frame, or null on timeout. The matcher mirrors the CaptureRig's HW-proven
 *  `sd_query` (fas-re tools/live/capture_v2.py): a reply matches only when it echoes the query's
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
    .then((frames) => {
      const hit = frames.find((f) => isEcho(f));
      return hit ? Uint8Array.from(hit) : null;
    });
}

/** The detached build task: pause telemetry, walk → build → persist → swap profile, emit terminal
 *  event, resume telemetry. Never rejects (all outcomes are emitted, not thrown). */
async function runBuild(store: Store, registry: DeviceRegistry, job: CacheJob, walkImpl: WalkImpl): Promise<void> {
  const { key, model, firmware, fw, mode, controller } = job;
  const full = mode === 'full';
  const resume = registry.pauseTelemetry(); // synchronous — telemetry is off before the first await
  registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: 0, total: 0, key, model, firmware });
  try {
    const transport = await registry.transport();
    const adapter: LiveTransport = { request: (q) => adaptRequest(transport, q) };
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
    // Per-block known table size + hard ceiling (see walkBlockLimits). A byte-exact stored cache for this
    // firmware (force-rebuild over an editor-cache import) is exact device data and refines the catalog;
    // a stale one (outdated schema) is not trusted for that either.
    const stored = loadStoredProfile(store, key);
    const usable = stored.state === 'usable' ? stored.profile : null;
    const limits = walkBlockLimits(model, mode, usable);
    const walkOpts: LiveWalkOptions = {
      model,
      ...(full ? { mode: 'full' as const, write } : {}),
      interQueryMs: WALK_PACE_MS,
      blockPauseMs: WALK_BLOCK_PAUSE_MS,
      maxParamId: full ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID,
      paramKnownSizeByBlock: limits.knownSize,
      paramBoundByBlock: limits.bound,
      // Label lists per block (see walkEnumHints), both modes — only on a (model, firmware) the hints are
      // verified on (enumHintsVerifiedOn); elsewhere the walk gets none and keeps its numeric rule.
      ...(enumHintsVerifiedOn(model, fw) ? { enumHintByBlock: walkEnumHints(model, usable) } : {}),
      signal: controller.signal,
      onProgress: (p) => {
        if (controller.signal.aborted) return;
        if (p.phase === 'done') {
          job.progress = { done: p.blockCount, total: p.blockCount, phase: 'building' };
          registry.emitEvent({ type: 'cacheBuild', phase: 'building', done: p.blockCount, total: p.blockCount, key, model, firmware });
        } else {
          job.progress = { done: p.blockIndex, total: p.blockCount, phase: 'walking' };
          registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: p.blockIndex, total: p.blockCount, key, model, firmware });
        }
      }
    };
    const built = await buildCache(
      { kind: 'live', walk: () => walkImpl(adapter, walkOpts) },
      paramsForModel(model),
      HW_SEEDS,
      { model, firmware, builtAt: new Date().toISOString() }
    );
    if (controller.signal.aborted) throw new Error('cancelled'); // a late abort discards the result
    store.putDoc('deviceCaches', key, built);
    await registry.applyRuntimeCache(); // adopt the freshly-built device-true profile immediately
    const total = job.progress.total;
    registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: total, total, key, model, firmware });
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
 *  the stored profile is stale (schema this build cannot use) and the current schema number. */
export async function cacheStatus(store: Store, registry: DeviceRegistry): Promise<CacheStatus> {
  await registry.driver(); // ensure detection ran so model/firmware are populated
  const key = resolveCacheKey(store, registry);
  const job = JOBS.get(registry);
  const stored = key ? loadStoredProfile(store, key) : ({ state: 'absent' } as const);
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
      // (pull). Axis surfaces this next to the device info.
      source: (data.meta as { source?: string } | undefined)?.source ?? 'live',
      schema: stored.check.schema
    };
  }
  return out;
}

/** POST /device/cache/build — start a background build (or report already-built / gated). Returns
 *  immediately; the build runs detached. `mode` (default 'read-only') selects the HW-proven read-only
 *  sweep or the fullCapture-gated write-sweep (refused on unverified or unknown firmware). `walkImpl` is a test seam (defaults to the codec's liveWalk). */
export async function startCacheBuild(store: Store, registry: DeviceRegistry, opts?: { force?: boolean; mode?: BuildMode; walkImpl?: WalkImpl }): Promise<StartResult> {
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
  // FULL mode WRITES to the device, so it additionally needs a firmware it has been verified on: per model, at
  // or below FULL_CAPTURE_MAX_VERIFIED_FW (a firmware can move the table ends the walk relies on: on FM3 13.0 a walk
  // without the table-end bound did not stop at a block's end and would have written sweep values to
  // non-existent params). The firmware is RE-READ right before deciding (fn 0x08,
  // the detect path) so a unit that changed firmware or went quiet since detect() is never judged on a stale
  // version; a silent unit is unknown and therefore refused (fail closed). Same 501/capability shape as the
  // gates above, plus additive `reason: 'firmware'` / `firmware` / `message` fields. Read-only mode is
  // intentionally NOT gated by this rule (the released read-only walk is hardware-proven on FM3 firmware 13.0).
  if (mode === 'full') {
    const fwNow = await registry.refreshFirmware();
    if (!fullCaptureAllowedOnFirmware(registry.detectedModelId, fwNow)) {
      return {
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
      };
    }
  }
  const model = registry.detectedModelId;
  const fw = registry.firmwareInfo();
  if (model < 0 || !fw) return { code: 503, body: { error: 'no device detected or firmware unknown' } };
  const key = deviceCacheKey(model, fw.major, fw.minor);
  // Only a USABLE profile counts as "already built": a stale one (outdated schema) is rebuilt without
  // `force` and overwritten by the new build (it is never deleted up front, a cancelled/failed build leaves it).
  if (loadStoredProfile(store, key).state === 'usable' && !opts?.force) {
    registry.emitEvent({ type: 'cacheBuild', phase: 'already-built', done: 0, total: 0, key, model, firmware: fw.version });
    return { code: 200, body: { ok: true, already: true } };
  }
  const job: CacheJob = {
    key, model, firmware: fw.version, fw: { major: fw.major, minor: fw.minor }, mode,
    controller: new AbortController(),
    progress: { done: 0, total: 0, phase: 'walking' },
    promise: Promise.resolve()
  };
  JOBS.set(registry, job);
  job.promise = runBuild(store, registry, job, opts?.walkImpl ?? liveWalk).finally(() => {
    if (JOBS.get(registry) === job) JOBS.delete(registry);
  });
  return { code: 200, body: { ok: true, key, started: true } };
}

/** POST /device/cache/cancel — abort a running build (idempotent when none runs). */
export function cancelCacheBuild(registry: DeviceRegistry): { ok: true } {
  JOBS.get(registry)?.controller.abort();
  return { ok: true };
}

/** DELETE /device/cache — drop the current key's stored doc. */
export async function deleteCache(store: Store, registry: DeviceRegistry): Promise<{ ok: true; deleted: boolean }> {
  await registry.driver(); // ensure detection ran so the key resolves
  const key = resolveCacheKey(store, registry);
  if (!key) return { ok: true, deleted: false };
  const doc = store.getDoc('deviceCaches', key);
  if (!doc || doc.deleted) return { ok: true, deleted: false };
  store.delDoc('deviceCaches', key);
  return { ok: true, deleted: true };
}

/** TEST-ONLY: the in-flight build's promise (or null) so suites can await completion. */
export function cacheBuildPromise(registry: DeviceRegistry): Promise<void> | null {
  return JOBS.get(registry)?.promise ?? null;
}
