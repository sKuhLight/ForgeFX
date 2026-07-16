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
import { buildCache, HW_SEEDS, liveWalk, type BuiltCache, type CacheRecord, type DeviceParam, type LiveTransport, type LiveWalkOptions } from 'forgefx-midi/cache';
import { FM3_PARAMS } from 'forgefx-midi/gen3/fm3';
import { FM9_PARAMS } from 'forgefx-midi/gen3/fm9';
import { PARAMS as AXE3_PARAMS } from 'forgefx-midi/gen3/axe-fx-iii';
import { isFractalHeaderFrame } from 'forgefx-midi/shared';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from 'forgefx-midi/am4';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import type { Store } from '../runtime/store.js';
import type { Transport } from '../transport/types.js';

/** Injectable walk (defaults to the codec's `liveWalk`) — tests fake it so they never septet-encode
 *  wire frames. Must resolve to the decoded `CacheRecord[]` `buildCache` consumes. */
export type WalkImpl = (transport: LiveTransport, opts: LiveWalkOptions) => Promise<CacheRecord[]>;

interface CacheJob {
  key: string;
  model: number;
  firmware: string;
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
/** The runtime walk stays inside the hardware-validated envelope: params 0..127 only. The 14-bit
 *  param space (body[5] set) was never live-swept on a real unit — enabling it is a separate,
 *  HW-gated task, not a default. */
const WALK_MAX_PARAM_ID = 127;

/** Adapt the registry's shared Transport to the codec's minimal LiveTransport: one query → the first
 *  matching Fractal reply frame, or null on timeout. Matching requires the fn AND the echoed view +
 *  param-low bytes (reply inner[0]/inner[4] at frame[6]/frame[10] mirror the query's) so a stale
 *  fn-0x01 frame from an earlier query can never be paired with the wrong one — under a sustained
 *  query stream that desync turns a transient slowdown into a wedge (FORGEFX-32). */
function adaptRequest(transport: Transport, query: Uint8Array): Promise<Uint8Array | null> {
  const bytes = Array.from(query);
  const fn = bytes[5];
  // Match the fn AND every echoed address byte: view f[6], block-lo f[8] + block-hi
  // f[9] (effectId>=128), param-lo f[10] + param-hi f[11] (id>127). Matching only
  // view+param-lo (the old code) can pair a high-block/high-param query with a stale
  // reply for a different block/param — a desync that turns a slowdown into a wedge.
  const isEcho = (f: readonly number[]): boolean =>
    isFractalHeaderFrame(f) && f[5] === fn && f[6] === bytes[6]
    && f[8] === bytes[8] && f[9] === bytes[9] && f[10] === bytes[10] && f[11] === bytes[11];
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
  const { key, model, firmware, controller } = job;
  const resume = registry.pauseTelemetry(); // synchronous — telemetry is off before the first await
  registry.emitEvent({ type: 'cacheBuild', phase: 'walking', done: 0, total: 0, key, model, firmware });
  try {
    const transport = await registry.transport();
    const adapter: LiveTransport = { request: (q) => adaptRequest(transport, q) };
    const walkOpts: LiveWalkOptions = {
      model,
      interQueryMs: WALK_PACE_MS,
      blockPauseMs: WALK_BLOCK_PAUSE_MS,
      maxParamId: WALK_MAX_PARAM_ID,
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
 *  immediately; the build runs detached. `walkImpl` is a test seam (defaults to the codec's liveWalk). */
export async function startCacheBuild(store: Store, registry: DeviceRegistry, opts?: { force?: boolean; walkImpl?: WalkImpl }): Promise<StartResult> {
  await registry.driver(); // ensure detection ran
  const caps = registry.activeCapabilities();
  if (!caps?.selfDescribe) return { code: 501, body: { error: 'unsupported', capability: 'selfDescribe' } };
  const model = registry.detectedModelId;
  const fw = registry.firmwareInfo();
  if (model < 0 || !fw) return { code: 503, body: { error: 'no device detected or firmware unknown' } };
  if (JOBS.has(registry)) return { code: 409, body: { error: 'building' } };
  const key = deviceCacheKey(model, fw.major, fw.minor);
  const existing = store.getDoc('deviceCaches', key);
  if (existing && !existing.deleted && !opts?.force) {
    registry.emitEvent({ type: 'cacheBuild', phase: 'already-built', done: 0, total: 0, key, model, firmware: fw.version });
    return { code: 200, body: { ok: true, already: true } };
  }
  const job: CacheJob = {
    key, model, firmware: fw.version,
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
