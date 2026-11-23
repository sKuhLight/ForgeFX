// The block probe (`POST /device/definitions/blocks/:eid/probe`, both twins; not on the Remote allowlist): one read-only
// definition walk of ONE placed block the catalog does not know, so the block map can bind it to its editor-cache
// section (forgefx-midi cache/blockMap.ts) and the block gets definitions without an app update (contract M3 §3.5).
//
// Preconditions, checked in this order, every refusal before any device traffic:
//   503 `no-device`         no unit identified (detection is never triggered here)
//   501 unsupported         not a gen-3 grid driver (capability `blockProbe`)
//   503 `firmware-unknown`  the running firmware was not read (the gate needs it)
//   501 unsupported         the block probe is not verified on the running firmware (`reason: 'firmware'`; the
//                           registry's walk-scope gates, services/walkScope.ts — empty table, dev override only)
//   400 `invalid-eid`       the effect id is not an integer 0..16383
//   501 unsupported         an effect id above 160 while definition reads above 160 are not verified on the running
//                           firmware (`reason: 'firmware'`, `scope: 'above160'`)
//   409 `known-block`       the static tables place the effect id (a catalog family, a roster-only family, a virtual
//                           block; the development hook's hidden family counts as unknown)
//   404 `block-not-placed`  the block is not in the edit-buffer grid as last read (no grid read yet: not placed)
//   409 merge refusals      `newer-profile` / `local-profile-better` (the probe could not be stored, profileMerge.ts)
//   409 `building` / `busy` another exclusive device job runs (deviceJobs.ts)
// The walk, with the device claimed and telemetry paused: blocks [eid], read-only (no write hook), no known size (the
// stop run stays active), `readValues`, no label hints, the build's pacing, the ceiling
// min(T.stride − 1 + 32, 127) for the best editor-cache candidate T of the block's bulk shape (the widest fitting section;
// no fitting section or no editor-cache source → 127), every query checked against that scope at the wire (the codec's
// `guardWalkTransport`, capped at the probe cap 127). 60 s at most → 504 `probe-timeout`. The walk becomes a
// `live-probe` raw source of the stored document (replacing an older probe of the same block), the document is
// re-derived and persisted, the runtime profile re-applied, and SSE `definitions` (`reason: 'block-probe'`) emitted once.
// 200 `{ ok, eid, blockMap, records, walk: { queries, pseudoReplies, lostReplies } }` — `blockMap` = the derived
// document's entry for the block (a `candidate` entry without candidates when the walk found nothing to bind).
//
// Browser-safe: store + registry type-only, codec cache subpath; no node:/fastify imports.
import {
  LIVE_WALK_LIMITS, WalkBoundError, guardWalkTransport, liveWalkDetailed, liveWalkScope, rawFromLiveWalk,
  type BlockMapEntry, type CacheRecord, type LiveTransport, type LiveWalkOptions, type LiveWalkResult
} from 'forgefx-midi/cache';
import type { DeviceRegistry } from '../drivers/registryCore.js';
import { catalogFamilyOfBlock, deviceCacheKey } from '../profileCatalog.js';
import { persistProfile } from '../profileSchema.js';
import { WALK_PACING, adaptRequest, type StartResult, type WalkImpl } from './deviceCache.js';
import { claimDevice, deviceBusy, releaseDevice } from './deviceJobs.js';
import { ProfileMergeRefused, mergeRefusal, mergeSourcesIntoStored, refusalBody } from './profileMerge.js';
import type { Store } from '../runtime/store.js';

/** Longest a probe may take before it answers 504 `probe-timeout`. */
export const PROBE_TIMEOUT_MS = 60_000;

/** Highest effect id the probe accepts (the 14-bit block address). */
const MAX_EID = 0x3fff;

export interface ProbeOptions {
  /** Test seam: the walk (default the codec's `liveWalkDetailed`). It receives the bound-guarded transport. */
  walkImpl?: WalkImpl;
  /** Test seam: the timeout (default `PROBE_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Test seam: the capture stamp of the probe source (default now). */
  now?: () => string;
}

/** TEST-ONLY: probe options a route-driven probe of `registry` uses (a route has no way to pass them). */
const TEST_OPTIONS = new WeakMap<DeviceRegistry, ProbeOptions>();
export function __setProbeOptionsForTest(registry: DeviceRegistry, opts: ProbeOptions | null): void {
  if (opts) TEST_OPTIONS.set(registry, opts);
  else TEST_OPTIONS.delete(registry);
}

/** The effect id of the route, or null when it is not an integer 0..16383 (decimal digits only). */
function parseEid(raw: unknown): number | null {
  const s = typeof raw === 'number' ? String(raw) : raw;
  if (typeof s !== 'string' || !/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_EID ? n : null;
}

/** A walk result from a `WalkImpl` (bare records: statistics zero). */
function walkResultOf(r: CacheRecord[] | LiveWalkResult): LiveWalkResult {
  if (!Array.isArray(r)) return r;
  return {
    records: r, queries: 0, enumLabels: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0,
    placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 0 }
  };
}

class ProbeTimeout extends Error {
  constructor() { super('probe-timeout'); this.name = 'ProbeTimeout'; }
}

/** POST /device/definitions/blocks/:eid/probe (see the module comment). */
export async function probeBlock(store: Store, registry: DeviceRegistry, eidRaw: unknown, options: ProbeOptions = {}): Promise<StartResult> {
  const opts: ProbeOptions = { ...TEST_OPTIONS.get(registry), ...options };
  const model = registry.detectedModelId;
  if (model < 0) return { code: 503, body: { error: 'no-device' } };
  const driver = await registry.driver(); // detection already ran: no device traffic
  const caps = registry.activeCapabilities();
  if (!caps || caps.slotModel !== 'grid' || !caps.selfDescribe || !driver.placedEffectIds || !driver.probeShape) {
    return { code: 501, body: { error: 'unsupported', capability: 'blockProbe' } };
  }
  const fw = registry.firmwareInfo();
  if (!fw) return { code: 503, body: { error: 'firmware-unknown' } };
  if (registry.walkScopeGates().blockProbe !== true) {
    return {
      code: 501,
      body: {
        error: 'unsupported', capability: 'blockProbe', reason: 'firmware', firmware: fw.version,
        message: `the block probe is only enabled on firmware versions it has been verified on (this device runs ${fw.version})`
      }
    };
  }
  const eid = parseEid(eidRaw);
  if (eid === null) return { code: 400, body: { error: 'invalid-eid', message: 'the effect id must be an integer 0..16383' } };
  // a block above the standard range also needs definition reads above effect id 160 verified (hardware check HV1)
  if (eid > LIVE_WALK_LIMITS.standardMaxBlock && registry.walkScopeGates().above160 !== true) {
    return {
      code: 501,
      body: {
        error: 'unsupported', capability: 'blockProbe', reason: 'firmware', scope: 'above160', firmware: fw.version,
        message: `definition reads above effect id ${LIVE_WALK_LIMITS.standardMaxBlock} are not verified on this firmware (${fw.version}); block ${eid} is not probed`
      }
    };
  }
  const known = catalogFamilyOfBlock(model, eid);
  if (known !== undefined) {
    return { code: 409, body: { error: 'known-block', family: known, message: `block ${eid} is a ${known} block of the bundled catalog; it is not probed` } };
  }
  // the edit-buffer grid as last read (known follow-up: a front-panel change since that read can make it stale; the probe
  // then reads an empty block, which binds nothing)
  if (!(driver.placedEffectIds() ?? []).includes(eid)) {
    return { code: 404, body: { error: 'block-not-placed', message: `block ${eid} is not in the edit-buffer grid (read the grid first)` } };
  }
  const key = deviceCacheKey(model, fw.major, fw.minor);
  const refusal = mergeRefusal(store, key, [{ kind: 'live-probe', origin: 'local' }]);
  if (refusal) return { code: 409, body: refusalBody(refusal) };
  if (!claimDevice(registry, 'block-probe')) {
    const busy = deviceBusy(registry);
    return busy === 'cache-build' ? { code: 409, body: { error: 'building' } } : { code: 409, body: { error: 'busy', what: busy ?? 'block-probe' } };
  }

  // ── claimed: everything below talks to the device ──
  const resume = registry.pauseTelemetry();
  const job: ProbeJob = {
    store, registry, model, eid, key, firmware: fw.version, opts,
    probeShape: (e) => driver.probeShape!(e), settled: Promise.resolve()
  };
  try {
    return await runProbe(job);
  } catch (e) {
    return { code: 503, body: { error: 'probe-failed', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    // the device stays claimed (and telemetry held) until the walk itself has settled, also after a timeout answer
    void job.settled.finally(() => {
      releaseDevice(registry, 'block-probe'); // first: a throwing resume must never leave the device claimed
      try { resume(); } catch (e) { console.warn(`[forgefx] block probe: resuming telemetry failed: ${e instanceof Error ? e.message : String(e)}`); }
    });
  }
}

/** A probe that passed its preconditions and holds the device. `settled`: the walk, settled either way (the claim is
 *  released when it is). */
interface ProbeJob {
  store: Store;
  registry: DeviceRegistry;
  model: number;
  eid: number;
  key: string;
  firmware: string;
  opts: ProbeOptions;
  probeShape(eid: number): Promise<Array<{ tag: number; stride: number }> | null>;
  settled: Promise<unknown>;
}

/** The walk, the merge and the answer of a claimed probe (see the module comment). */
async function runProbe(job: ProbeJob): Promise<StartResult> {
  const { store, registry, model, eid, key, firmware, opts } = job;
  // the ceiling: the widest editor-cache section the block's bulk shape fits, plus the stop run, at most the probe cap
  const fits = await job.probeShape(eid);
  const widest = (fits ?? []).reduce((m, f) => Math.max(m, f.stride), 0);
  const cap = LIVE_WALK_LIMITS.probeMaxParamId;
  const ceiling = widest > 0 ? Math.min(widest - 1 + LIVE_WALK_LIMITS.stopRun, cap) : cap;
  const controller = new AbortController();
  const walkOpts: LiveWalkOptions = {
    model,
    blocks: [eid],
    maxParamId: ceiling,
    readValues: true,
    interQueryMs: WALK_PACING.interQueryMs,
    blockPauseMs: WALK_PACING.blockPauseMs,
    signal: controller.signal
  };
  const transport = await registry.transport();
  const adapter: LiveTransport = { request: (q) => adaptRequest(transport, q) };
  const guarded = guardWalkTransport(adapter, walkOpts, { maxParamId: cap });
  const walk = (opts.walkImpl ?? liveWalkDetailed)(guarded, walkOpts);
  job.settled = walk.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(new ProbeTimeout()); reject(new ProbeTimeout()); }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  });
  let walked: LiveWalkResult;
  try {
    walked = walkResultOf(await Promise.race([walk, timeout]));
  } catch (e) {
    if (e instanceof ProbeTimeout || controller.signal.aborted) {
      return { code: 504, body: { error: 'probe-timeout', message: `the probe of block ${eid} did not finish in time; nothing was stored` } };
    }
    if (e instanceof WalkBoundError) return { code: 500, body: { error: 'walk-bound', message: e.message } };
    return { code: 503, body: { error: 'probe-failed', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // the walk → a live-probe raw source of the stored document → re-derived, persisted, applied
  const capturedAt = opts.now?.() ?? new Date().toISOString();
  const source = rawFromLiveWalk(walked, liveWalkScope(walkOpts, { above160: eid > LIVE_WALK_LIMITS.standardMaxBlock, hinted: false }), {
    kind: 'live-probe', capturedAt, firmware, origin: 'local'
  });
  let merged: ReturnType<typeof mergeSourcesIntoStored>;
  try {
    merged = mergeSourcesIntoStored(store, { key, model, firmware, incoming: [source], now: capturedAt });
  } catch (e) {
    if (e instanceof ProfileMergeRefused) return { code: 409, body: refusalBody(e.refusal) };
    return { code: 422, body: { error: 'derivation-failed', message: e instanceof Error ? e.message : String(e), stored: false } };
  }
  persistProfile(store, key, merged.doc);
  await registry.applyRuntimeCache();
  registry.emitEvent({ type: 'definitions', reason: 'block-probe', key, eid });
  if (merged.derivationFailed !== undefined) {
    return { code: 422, body: { error: 'derivation-failed', message: merged.derivationFailed, stored: true } };
  }
  const entry: BlockMapEntry = merged.doc.blockMap.find((e) => e.eid === eid)
    ?? { eid, key: null, sectionTag: null, confidence: 'candidate', evidence: [], candidates: [], channels: null };
  return {
    code: 200,
    body: {
      ok: true, eid, blockMap: entry, records: source.records.length,
      walk: { queries: walked.queries, pseudoReplies: walked.pseudoReplies ?? { endMarker: 0, duplicateId: 0, implausible: 0 }, lostReplies: walked.lostReplies }
    }
  };
}
