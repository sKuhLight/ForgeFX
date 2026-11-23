// Host wiring of the spot check (cloud v2, M4): before a pull lets definitions from another installation decide which
// parameters exist (a shared cloud source, or a v1 cloud profile), a few of their rows are read back from the attached
// unit with READ-ONLY definition queries and compared. The selection and the runner are the codec's
// (forgefx-midi cache/spotCheck.ts: `spotCheckRows`, `spotCheckTargets`, `runSpotCheck`); this module supplies what
// only the host knows and runs the check as an exclusive device job:
//   - which families a cloud source decides: from the candidate document the HOST derived itself, with the ids of the
//     sources it merged in from the cloud (never a downloaded document's own provenance or origin fields); a v1
//     profile without raw sources is passed as its derived tables only (every family counts as cloud-decided);
//   - each row's class against the bundled catalog (`classifyProfileRows`, the definitions diff's own pass) and whether
//     the firmware is the catalog's baseline;
//   - each family's static first effect id (the model's static roster, first instance, never a roster-only entry);
//   - each block's HARD query bound: the read-only walk's own limits (`walkBlockLimits`), from the static catalog or the
//     LOCAL editor-cache data of the stored profile of this firmware only (`localByteSource` inside it) — never from
//     cloud data; blocks above 160 and ids above 127 only where the walk-scope gates of the running firmware open them,
//     with the extension walk's bounds (`extensionWalkLimits`; gates fail closed, no firmware is listed today);
//   - the device: claimed for `cloud-verify` (services/deviceJobs.ts: a build, capture or probe answers 409, and vice
//     versa), telemetry paused for the duration, the registry's link adapted exactly as the walk adapts it
//     (`adaptRequest`), SSE `cacheBuild { phase: 'verifying', done, total }` per definition read back.
// The runner itself puts only the targets' definition queries on the wire (an exact allow-list around the walk's bound
// watchdog); no label query, no value read, no write. A query it refuses (`WalkBoundError`) is a bug: the caller stores
// nothing.
//
// Browser-safe: registry/store type-only, the codec's cache subpath, the catalog modules; no node:/fastify imports.
import {
  LIVE_WALK_LIMITS, WalkBoundError, runSpotCheck, spotCheckRng, spotCheckRows, spotCheckTargets,
  type BuiltCache, type LiveTransport, type SpotCheckDoc, type SpotCheckGates, type SpotCheckPlan, type SpotCheckResult,
  type SpotCheckRowClass, type SpotCheckRunOptions
} from 'forgefx-midi/cache';
import type { DeviceRegistry } from '../drivers/registryCore.js';
import { classifyProfileRows } from '../drivers/profileCompare.js';
import { PROFILES } from '../devices.js';
import { staticRoster } from '../profileCatalog.js';
import { loadStoredProfile } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';
import { adaptRequest, extensionWalkLimits, walkBlockLimits } from './deviceCache.js';
import { claimDevice, deviceBusy, releaseDevice } from './deviceJobs.js';

/** Can the attached unit be spot-checked (the future `capabilities.definitions.spotCheck`, without the firmware
 *  condition, which the caller answers with 503 `firmware-unknown`)? A gen-3 grid driver with the self-describe walk
 *  and a bundled catalog of its model. */
export function spotCheckSupported(registry: DeviceRegistry): boolean {
  const caps = registry.activeCapabilities();
  const model = registry.detectedModelId;
  return !!caps && caps.slotModel === 'grid' && caps.selfDescribe === true && model >= 0 && PROFILES[model] !== undefined;
}

/** What the plan of one check reads. */
export interface SpotCheckPlanInput {
  model: number;
  /** The firmware of the candidate document (the running firmware). */
  firmware: string;
  /** The candidate document: derived by this host from raw sources it validated (a profile v2 document), or a v1
   *  profile's derived tables. */
  doc: BuiltCache;
  /** The ids of the sources of `doc` this host merged in from the cloud (profile v2). Absent: `doc` is a v1 profile
   *  adopted as a whole — only its derived tables are read and every family counts as cloud-decided. */
  cloudSourceIds?: readonly string[];
  /** The store and device-cache key whose USABLE stored profile may refine the bounds with its local editor-cache
   *  data (the stored document, not the candidate: the walk's own rule). */
  store: Pick<Store, 'getDoc'>;
  key: string;
  /** The walk-scope gates of the running firmware (`registry.walkScopeGates()`). */
  gates: SpotCheckGates;
  /** Uniform random numbers in [0, 1); default `crypto.getRandomValues` (`spotCheckRng`). */
  rng?: () => number;
}

/** The codec's plan, plus the families a cloud source decides (`winners`). */
export interface HostSpotCheckPlan extends SpotCheckPlan {
  winners: string[];
}

/** The static first effect id of every family of `model` (first instance, never a roster-only entry), memoised. */
const FIRST_EIDS = new Map<number, ReadonlyMap<string, number>>();
function firstEffectIds(model: number): ReadonlyMap<string, number> {
  const hit = FIRST_EIDS.get(model);
  if (hit) return hit;
  const out = new Map<string, number>();
  for (const [block, ref] of staticRoster(model)) {
    if (ref.roster || ref.instance !== 1) continue;
    const seen = out.get(ref.family);
    if (seen === undefined || block < seen) out.set(ref.family, block);
  }
  FIRST_EIDS.set(model, out);
  return out;
}

/** The hard query bound of every block a check may read (see the module comment), -1 for none. */
function blockBounds(model: number, stored: BuiltCache | null, gates: SpotCheckGates): (eid: number) => number {
  const standard = walkBlockLimits(model, 'read-only', stored).bound;
  const opened = gates.extendedIds === true || gates.above160 === true;
  const extended = opened
    ? extensionWalkLimits(model, stored, { extendedIds: gates.extendedIds === true, above160: gates.above160 === true, farIds: false }, 'read-only').bound
    : {};
  return (eid: number): number => {
    const b = eid > LIVE_WALK_LIMITS.standardMaxBlock ? extended[eid] : (extended[eid] ?? standard[eid]);
    return typeof b === 'number' && Number.isInteger(b) && b >= 0 ? b : -1;
  };
}

/** Plan one check (pure apart from the store read; no device traffic): the codec's target selection over the host's
 *  rows, classes, effect ids and bounds. `status`: `not-needed` (no cloud-decided family), `insufficient` (fewer than
 *  12 eligible rows: nothing may be adopted) or `ready`. */
export function planSpotCheck(input: SpotCheckPlanInput): HostSpotCheckPlan {
  const { model, firmware, doc, cloudSourceIds } = input;
  const staticProfile = PROFILES[model];
  const source: SpotCheckDoc = cloudSourceIds !== undefined ? (doc as unknown as SpotCheckDoc) : { ranges: (doc.ranges ?? {}) as SpotCheckDoc['ranges'] };
  const { rows, winners } = spotCheckRows(source, cloudSourceIds !== undefined ? { cloudSourceIds } : {});
  const classes = new Map<string, SpotCheckRowClass>();
  if (staticProfile) {
    for (const fam of classifyProfileRows(doc, staticProfile, [], false).families) {
      for (const r of fam.rows) if (r.cls !== 'removed') classes.set(`${fam.family}\u0000${r.pid}`, r.cls);
    }
  }
  const usable = loadStoredProfile(input.store, input.key);
  const stored = usable.state === 'usable' ? usable.profile : null;
  const eids = firstEffectIds(model);
  const plan = spotCheckTargets({
    rows, winners,
    catalogCompare: (family, pid) => classes.get(`${family}\u0000${pid}`),
    catalogBaseline: !!staticProfile && staticProfile.catalogFirmware === firmware,
    eidOf: (family) => eids.get(family),
    boundOf: blockBounds(model, stored, input.gates),
    gates: input.gates,
    rng: input.rng ?? spotCheckRng()
  });
  return { ...plan, winners };
}

/** Test seams of a registry's checks (set by test suites only, see `__setSpotCheckForTest`). */
export interface SpotCheckTestOptions {
  /** A fixed seed for the target selection (`spotCheckRng(seed)`). */
  seed?: number;
  /** Runner options: the scheduler / clock seams and the pauses. */
  run?: Pick<SpotCheckRunOptions, 'sleep' | 'now' | 'drainMs' | 'pacingMs' | 'budgetMs' | 'timeoutMs'>;
  /** Treat every check as not needed: for suites whose subject is the merge of a pull, not the check (their mocked
   *  units answer no definition query). Never set outside a test. */
  skip?: boolean;
}

/** TEST-ONLY: the seams of `registry`'s checks (null clears them). */
const TEST_OPTIONS = new WeakMap<DeviceRegistry, SpotCheckTestOptions>();
export function __setSpotCheckForTest(registry: DeviceRegistry, opts: SpotCheckTestOptions | null): void {
  if (opts) TEST_OPTIONS.set(registry, opts);
  else TEST_OPTIONS.delete(registry);
}
/** The seams of `registry` (empty in production). */
export function spotCheckTestOptions(registry: DeviceRegistry): SpotCheckTestOptions {
  return TEST_OPTIONS.get(registry) ?? {};
}

/** The RNG of `registry`'s checks: the test seed, else `crypto.getRandomValues`. */
export function spotCheckRngFor(registry: DeviceRegistry): () => number {
  const seed = TEST_OPTIONS.get(registry)?.seed;
  return seed !== undefined ? spotCheckRng(seed) : spotCheckRng();
}

/** Outcome of `runDeviceSpotCheck`: the runner's result, or an HTTP refusal / failure (nothing was adopted). */
export type DeviceSpotCheck = { ok: true; result: SpotCheckResult } | { ok: false; code: number; body: Record<string, unknown> };

/** Identity of the definitions being checked, for the SSE progress events. */
export interface SpotCheckEventIds { key: string; model: number; firmware: string }

/** Run a `ready` plan against the attached unit as the exclusive `cloud-verify` job (see the module comment): 409
 *  `building` / `busy` when another device job holds the unit; telemetry paused while it runs; SSE `cacheBuild
 *  { phase: 'verifying' }` before the first query and after every target. A refused query (`WalkBoundError`) answers
 *  500 `walk-bound`, a refused runner argument (`RangeError` / `TypeError`, a host bug) 500 `spot-check-error`, a
 *  failing link 503 `no-device`. The claim is released and telemetry resumed whatever happens. */
export async function runDeviceSpotCheck(
  registry: DeviceRegistry, plan: Pick<HostSpotCheckPlan, 'targets'>, ids: SpotCheckEventIds, gates: SpotCheckGates
): Promise<DeviceSpotCheck> {
  if (!claimDevice(registry, 'cloud-verify')) {
    const busy = deviceBusy(registry);
    return busy === 'cache-build' ? { ok: false, code: 409, body: { error: 'building' } } : { ok: false, code: 409, body: { error: 'busy', what: busy ?? 'cloud-verify' } };
  }
  const total = plan.targets.length;
  const verifying = (done: number) => registry.emitEvent({ type: 'cacheBuild', phase: 'verifying', done, total, key: ids.key, model: ids.model, firmware: ids.firmware });
  let resume: (() => void) | null = null;
  try {
    resume = registry.pauseTelemetry();
    verifying(0);
    const transport = await registry.transport();
    const link: LiveTransport = { request: (q) => adaptRequest(transport, q) };
    const seams = TEST_OPTIONS.get(registry)?.run ?? {};
    const result = await runSpotCheck(link, {
      ...seams,
      model: ids.model,
      targets: plan.targets,
      gates,
      onProgress: (p) => verifying(p.done)
    });
    return { ok: true, result };
  } catch (e) {
    if (e instanceof WalkBoundError) {
      console.warn(`[forgefx] spot check: ${e.message} — not sent, nothing adopted`);
      return { ok: false, code: 500, body: { error: 'walk-bound', message: e.message } };
    }
    // the runner's own argument checks (a host bug, thrown before any query) vs. the link failing underneath it
    if (e instanceof RangeError || e instanceof TypeError) return { ok: false, code: 500, body: { error: 'spot-check-error', message: e.message } };
    return { ok: false, code: 503, body: { error: 'no-device', message: e instanceof Error ? e.message : String(e) } };
  } finally {
    releaseDevice(registry, 'cloud-verify'); // first: a throwing resume must never leave the device claimed
    try { resume?.(); } catch (e) { console.warn(`[forgefx] spot check: resuming telemetry failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
