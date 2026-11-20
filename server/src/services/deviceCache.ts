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
import { buildCache, HW_SEEDS, liveWalk, type BuiltCache, type CacheRecord, type DeviceParam, type LiveTransport, type LiveWalkOptions, type LiveWalkWriteHooks } from 'forgefx-midi/cache';
import { FM3_PARAMS } from 'forgefx-midi/gen3/fm3';
import { FM9_PARAMS } from 'forgefx-midi/gen3/fm9';
import { PARAMS as AXE3_PARAMS } from 'forgefx-midi/gen3/axe-fx-iii';
import { isFractalHeaderFrame } from 'forgefx-midi/shared';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from 'forgefx-midi/am4';
import { deviceCacheKey, fullCaptureAllowedOnFirmware, type DeviceRegistry } from '../drivers/registryCore.js';
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
  exists: boolean;
  building: boolean;
  progress?: { done: number; total: number; phase: string };
  meta?: { recordCount: number; builtAt: string | null; firmware: string | null; unmappedSections: number; unmappedFamilies: number; source: string };
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
/** READ-ONLY walk param ceiling: params 0..127 only. This default sweep is HARDWARE-PROVEN byte-for-byte
 *  — the 14-bit param space (body[5] set, id > 127) was never live-swept read-only on a real unit, so the
 *  read-only build stays inside the validated envelope. Keep this at 127; the read-only cache must remain
 *  byte-identical to the shipped HW-verified walk. */
const WALK_MAX_PARAM_ID = 127;
/** FULL-mode walk param ceiling: the codec's full 14-bit param space (2^14 − 1). Full capture is the
 *  CaptureRig-parity write-sweep, and the rig sweeps the whole 14-bit id range to reach sparse high-id
 *  (id > 127) records; the codec bounds this walk itself (filler / absent-run / block-probe guards end
 *  each block long before 16383), so lifting the host cap here just removes an artificial floor and lets
 *  those guards do the real bounding. Full mode is model-gated (fullCapture) so it never runs unverified. */
const WALK_MAX_PARAM_ID_FULL = 16383;

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
  const { key, model, firmware, mode, controller } = job;
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
    const walkOpts: LiveWalkOptions = {
      model,
      ...(full ? { mode: 'full' as const, write } : {}),
      interQueryMs: WALK_PACE_MS,
      blockPauseMs: WALK_BLOCK_PAUSE_MS,
      maxParamId: full ? WALK_MAX_PARAM_ID_FULL : WALK_MAX_PARAM_ID,
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

/** GET /device/cache — current key + existence + live build progress + stored-doc meta. */
export async function cacheStatus(store: Store, registry: DeviceRegistry): Promise<CacheStatus> {
  await registry.driver(); // ensure detection ran so model/firmware are populated
  const key = resolveCacheKey(store, registry);
  const job = JOBS.get(registry);
  const doc = key ? store.getDoc('deviceCaches', key) : null;
  const exists = !!(doc && !doc.deleted);
  const out: CacheStatus = { key, exists, building: !!job };
  if (job) out.progress = { ...job.progress };
  if (exists) {
    const data = doc!.data as BuiltCache;
    out.meta = {
      recordCount: data.meta?.recordCount ?? 0,
      builtAt: data.meta?.builtAt ?? null,
      firmware: data.firmware ?? null,
      unmappedSections: data.unmappedSections?.length ?? 0,
      unmappedFamilies: data.unmappedFamilies?.length ?? 0,
      // Where the persisted profile came from: 'live' (A3 walk), 'editor-cache' (import), 'cloud'
      // (pull). Axis surfaces this next to the device info.
      source: (data.meta as { source?: string } | undefined)?.source ?? 'live'
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
  // or below FULL_CAPTURE_MAX_VERIFIED_FW (e.g. FM3 firmware 13.0's walk does not stop at a block's end and
  // would write sweep values to non-existent params). The firmware is RE-READ right before deciding (fn 0x08,
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
  const existing = store.getDoc('deviceCaches', key);
  if (existing && !existing.deleted && !opts?.force) {
    registry.emitEvent({ type: 'cacheBuild', phase: 'already-built', done: 0, total: 0, key, model, firmware: fw.version });
    return { code: 200, body: { ok: true, already: true } };
  }
  const job: CacheJob = {
    key, model, firmware: fw.version, mode,
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
