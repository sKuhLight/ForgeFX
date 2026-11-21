// Diagnostic capture — the in-app device diagnostic (Axis: Settings → Debugging → "Device diagnostics").
// One background job per registry runs a fixed sequence of read-mostly steps against the attached gen-3
// unit with exactly the shipped walk/probe code, records the whole wire log of the run, and ALWAYS leaves
// a result bundle behind (done, failed, cancelled or aborted) that the user can save or upload for analysis.
//
//   info            model, firmware (fresh fn 0x08 read), transport kind, current preset number, versions
//   readonlyWalk    the device-cache read-only walk (same options, limits and hints as a build) — into
//                   the bundle only; the stored device profile is never written or swapped
//   labelProbe      per hinted label list of the mapped blocks: definition, ONE label query at its first
//                   ordinal (sub = min) where the definition fits the hint, then a liveness query; Global last;
//                   stops at the first missing reply. This is the evidence the per-firmware hint gate needs.
//   dumpHeaderProbe stored-slot dumps (0, 127, 128, last, a few unused slots) + the edit buffer: which preset
//                   number each 0x77 header names (dump payloads are never kept)
//   reloadProbe     re-select the current preset by SysEx and verify the preset number (only when the edit
//                   buffer provably equals its stored slot — never over unsaved edits)
//   fullWalk        opt-in; the full walk under every existing gate (fullCapture + verified firmware)
//
// Mutually exclusive with the device-cache build (services/deviceJobs.ts). A watchdog aborts the run when a
// walk query would exceed the walk's hard bound or when nothing is received for 60 s while a step runs.
// Redaction happens as frames are recorded: preset/scene names are blanked, dump chunks cut to a prefix.
//
// Browser-safe: registry/store/driver are type-only or structural imports, gzip uses CompressionStream and
// the upload goes through an injected cloud client. NO node:/fastify/transport VALUE imports beyond the
// browser-safe transport types (check-browser-safe.ts enforces it).
import {
  buildCache, buildDefQuery, buildEnumQuery, buildValueQuery, decodeReply, parseDisplayValue, HW_SEEDS, liveWalkDetailed,
  type BuiltCache, type CacheRecord, type LiveDefinition, type LiveEnumHint, type LiveTransport, type LiveWalkOptions, type LiveWalkResult
} from 'forgefx-midi/cache';
import { DEVICE_MODELS } from 'forgefx-midi/shared';
import { VERSION as CODEC_VERSION } from 'forgefx-midi';
import { deviceCacheKey, diagnosticCaptureSupported, fullCaptureAllowedOnFirmware, type DeviceRegistry } from '../drivers/registryCore.js';
import type { DeviceDriver, DiagnosticDump } from '../drivers/types.js';
import { PROFILES } from '../devices.js';
import { loadStoredProfile } from '../profileSchema.js';
import type { DiagnosticUploadMeta } from '../runtime/cloud.js';
import type { Store } from '../runtime/store.js';
import { isTransportTimeout, type Transport } from '../transport/types.js';
import {
  adaptRequest, enumHintsVerifiedOn, isLocalByteProfile, paramsForModel, staticRoster, walkBlockLimits, walkEnumHints, walkQueryBound, walkSetup,
  WALK_PACING, type BuildMode
} from './deviceCache.js';
import { claimDevice, deviceBusy, releaseDevice } from './deviceJobs.js';

// ── public shapes (the HTTP contract both surfaces serve) ──

export type StepName = 'info' | 'readonlyWalk' | 'labelProbe' | 'dumpHeaderProbe' | 'reloadProbe' | 'fullWalk';
export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'aborted' | 'skipped';

/** Every step, in the order a run executes them. */
export const STEP_ORDER: readonly StepName[] = ['info', 'readonlyWalk', 'labelProbe', 'dumpHeaderProbe', 'reloadProbe', 'fullWalk'];
/** The steps of a run that names none. `fullWalk` is opt-in (`includeFullWalk: true`). */
export const DEFAULT_STEPS: readonly StepName[] = ['info', 'readonlyWalk', 'labelProbe', 'dumpHeaderProbe', 'reloadProbe'];

export interface CaptureStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  id?: string;
  startedAt?: string;
  endedAt?: string;
  steps?: { name: StepName; status: StepStatus; progress?: { done: number; total: number }; note?: string }[];
  abortReason?: string;
  resultAvailable: boolean;
}

export interface CaptureFrame {
  /** ms since the run started. */
  t: number;
  dir: 'TX' | 'RX';
  hex: string;
  /** Total frame length, only on a frame whose payload was cut (preset dump chunks). */
  len?: number;
}
export interface CaptureLog { t: number; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
export interface CaptureStep { name: StepName; status: StepStatus; startedAt?: string; endedAt?: string; result?: unknown; error?: string; note?: string }

export interface CaptureBundle {
  schema: 1;
  id: string;
  createdAt: string;
  endedAt: string;
  state: 'done' | 'failed' | 'cancelled';
  abortReason?: string;
  app: { forgefx: string; codec: string; axis?: string };
  device: { model: number; modelName: string; firmware: string | null; transport: string };
  steps: CaptureStep[];
  frames: CaptureFrame[];
  logs: CaptureLog[];
  redaction: { presetNames: number; dumpPayloadFrames: number };
  /** ADDITIVE: present only when the wire log was too large for the bundle and frames were dropped (the
   *  first and last frames and the frames around each failure / abort are kept). */
  framesTruncated?: { kept: number; dropped: number };
}

/** An HTTP status + JSON body for the (thin) route wrappers. */
export interface CaptureResult { code: number; body: unknown }

/** Injectable walk (defaults to the codec's `liveWalkDetailed`, so the bundle carries its reply stats). */
export type CaptureWalkImpl = (transport: LiveTransport, opts: LiveWalkOptions) => Promise<CacheRecord[] | LiveWalkResult>;

/** Host bindings and test seams. Everything is optional; the defaults are the production behaviour. */
export interface CaptureOptions {
  /** The walk both walk steps run (test seam). */
  walkImpl?: CaptureWalkImpl;
  /** Version stamps the host knows (the server reads its package version; a browser runtime may pass one). */
  versions?: { forgefx?: string };
  /** No frame received for this long while a step runs → the run aborts as 'device-silent'. */
  silenceMs?: number;
  /** Watchdog check interval. */
  watchdogTickMs?: number;
  /** Pacing of the label probe (defaults to the walk's own: WALK_PACING). */
  pacing?: { interQueryMs: number; blockPauseMs: number };
  /** Extra stored-slot dumps the header probe may spend looking for unused slots. */
  emptySearchBudget?: number;
  /** Largest bundle JSON (bytes) before the wire log is trimmed (the upload endpoint refuses more). */
  maxBundleJsonBytes?: number;
  /** Clock (ms). */
  now?: () => number;
}

// ── limits / constants ──

/** The upload endpoint's limit on the gzip body (25 MiB). */
export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
/** The upload endpoint's limit on the decompressed bundle JSON (64 MiB) — a bundle is trimmed below it. */
export const MAX_BUNDLE_JSON_BYTES = 64 * 1024 * 1024;
const BUNDLE_JSON_MARGIN = 256 * 1024;
const DEFAULT_SILENCE_MS = 60_000;
const DEFAULT_WATCHDOG_TICK_MS = 1000;
const DEFAULT_EMPTY_SEARCH_BUDGET = 12;
/** Unused slots the dump-header probe looks for besides the fixed ones. */
const EMPTY_SLOTS_WANTED = 3;
/** Frames kept on each side of a failure / abort when the wire log is trimmed. */
const TRIM_WINDOW = 200;
/** Job log entries kept (the console tap can be chatty). */
const MAX_LOGS = 5000;
/** Label count cap of a list (the codec's default `enumCountCap`). */
const ENUM_COUNT_CAP = 1024;
/** How many labels a list may have grown past its hint (the codec's HINT_GROWTH_LIMIT). */
const HINT_GROWTH_LIMIT = 4;
const EDIT_BUFFER = 0x3fff;
const EDIT_BUFFER_HEADERS: readonly number[] = [EDIT_BUFFER, 0x3f80];

// ── job state (module-level, per registry — like the cache build) ──

interface StepRecord extends CaptureStep { progress?: { done: number; total: number } }

interface Job {
  id: string;
  store: Store;
  registry: DeviceRegistry;
  opts: CaptureOptions;
  now: () => number;
  t0: number;
  startedAt: string;
  includeFullWalk: boolean;
  controller: AbortController;
  abortReason: string | null;
  steps: StepRecord[];
  frames: CaptureFrame[];
  logs: CaptureLog[];
  redaction: { presetNames: number; dumpPayloadFrames: number };
  /** Frame indices of failures / aborts (kept when the log is trimmed). */
  marks: number[];
  lastRx: number;
  stepStartedAt: number | null;
  model: number;
  modelName: string;
  firmware: string | null;
  fw: { major: number; minor: number } | null;
  transportKind: string;
  /** The transport's label (a port path or name) — only to scrub it from log lines; never stored. */
  label: string | null;
  promise: Promise<void>;
}

const RUNNING = new WeakMap<DeviceRegistry, Job>();
const LAST = new WeakMap<DeviceRegistry, { bundle: CaptureBundle; status: CaptureStatus }>();
const TEST_OPTIONS = new WeakMap<DeviceRegistry, CaptureOptions>();

/** TEST-ONLY: options every capture started on `registry` gets (the routes build their own). */
export function __setCaptureOptionsForTest(registry: DeviceRegistry, opts: CaptureOptions | null): void {
  if (opts) TEST_OPTIONS.set(registry, opts);
  else TEST_OPTIONS.delete(registry);
}
/** TEST-ONLY: the running capture's promise (or null) so suites can await the end of a run. */
export function capturePromise(registry: DeviceRegistry): Promise<void> | null {
  return RUNNING.get(registry)?.promise ?? null;
}

// ── endpoints ──

/** GET /diagnostics/capture */
export function captureStatus(registry: DeviceRegistry): CaptureStatus {
  const job = RUNNING.get(registry);
  const last = LAST.get(registry);
  if (job) {
    return {
      state: 'running',
      id: job.id,
      startedAt: job.startedAt,
      steps: job.steps.map(stepView),
      ...(job.abortReason ? { abortReason: job.abortReason } : {}),
      resultAvailable: !!last
    };
  }
  return last ? last.status : { state: 'idle', resultAvailable: false };
}

/** POST /diagnostics/capture — body `{ acknowledged: true, steps?, includeFullWalk? }`. 202 started; 400 not
 *  acknowledged / bad steps; 409 busy (a capture or a cache build runs); 503 no device; 501 not a gen-3 unit. */
export async function startCapture(store: Store, registry: DeviceRegistry, body: unknown, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const b = (body && typeof body === 'object' ? body : {}) as { acknowledged?: unknown; steps?: unknown; includeFullWalk?: unknown };
  if (b.acknowledged !== true) return { code: 400, body: { error: 'not-acknowledged' } };
  const includeFullWalk = b.includeFullWalk === true;
  const steps = resolveSteps(b.steps, includeFullWalk);
  if (!steps.ok) return { code: 400, body: { error: 'bad-steps', message: steps.message } };
  const busy = RUNNING.has(registry) ? 'capture' : deviceBusy(registry);
  if (busy) return { code: 409, body: { error: 'busy', what: busy } };
  await registry.driver(); // ensure detection ran
  const model = registry.detectedModelId;
  if (model < 0) return { code: 503, body: { error: 'no-device' } };
  if (!diagnosticCaptureSupported(model, registry.activeCapabilities())) return { code: 501, body: { error: 'unsupported', capability: 'diagnosticCapture' } };
  if (!claimDevice(registry, 'capture')) return { code: 409, body: { error: 'busy', what: deviceBusy(registry) ?? 'capture' } };

  const merged: CaptureOptions = { ...TEST_OPTIONS.get(registry), ...opts };
  const now = merged.now ?? Date.now;
  const t0 = now();
  const fw = registry.firmwareInfo();
  const job: Job = {
    id: newCaptureId(t0),
    store, registry, opts: merged, now, t0,
    startedAt: new Date(t0).toISOString(),
    includeFullWalk,
    controller: new AbortController(),
    abortReason: null,
    steps: steps.steps.map((name) => ({ name, status: 'pending' as StepStatus })),
    frames: [], logs: [], redaction: { presetNames: 0, dumpPayloadFrames: 0 }, marks: [],
    lastRx: t0, stepStartedAt: null,
    model,
    modelName: DEVICE_MODELS[model]?.name ?? `0x${model.toString(16)}`,
    firmware: fw?.version ?? null,
    fw: fw ? { major: fw.major, minor: fw.minor } : null,
    transportKind: 'unknown',
    label: null,
    promise: Promise.resolve()
  };
  RUNNING.set(registry, job);
  job.promise = runCapture(job).finally(() => {
    if (RUNNING.get(registry) === job) RUNNING.delete(registry);
    releaseDevice(registry, 'capture');
  });
  return { code: 202, body: { started: true, id: job.id } };
}

/** POST /diagnostics/capture/cancel — idempotent. */
export function cancelCapture(registry: DeviceRegistry): { ok: true } {
  const job = RUNNING.get(registry);
  if (job) abortJob(job, 'cancelled');
  return { ok: true };
}

/** GET /diagnostics/capture/result — the last finished run's bundle. */
export function captureResult(registry: DeviceRegistry): CaptureResult {
  const last = LAST.get(registry);
  return last ? { code: 200, body: last.bundle } : { code: 404, body: { error: 'no-result' } };
}

export type { DiagnosticUploadMeta } from '../runtime/cloud.js';

/** The slice of the cloud client the upload needs (structural, so tests fake it): ONE call that moves the
 *  gzip body to the cloud however the cloud wants it (runtime/cloud.ts `runDiagnosticUpload`). `code` is the
 *  final HTTP status, 0 for a network failure, `body.captureId` (the cloud's row id) on success;
 *  `disabled` = no cloud configured in this runtime. */
export interface DiagnosticCaptureCloud {
  diagnosticCaptureUpload(gz: Uint8Array, meta: DiagnosticUploadMeta): Promise<{ code: number; body: unknown; retryAfter?: string | null; disabled?: boolean }>;
}

/** POST /diagnostics/capture/upload — body `{ consent: true, axisVersion? }`: gzip the last bundle and hand it to
 *  the cloud client (axis-cloud `diagnostic-captures`) under the signed-in user. 200 `{ ok, captureId (the cloud's
 *  row id), bytes, deduped? }`; 400 no consent; 404 no result; 413 too large (here or in the cloud); 401
 *  not signed in (`reason: 'account-required'` for an anonymous session); 429 rate limited / quota exceeded
 *  (`retryAfterSeconds`); 503 no cloud; 502 any other cloud error. */
export async function uploadCapture(
  registry: DeviceRegistry,
  cloud: DiagnosticCaptureCloud | null,
  body: unknown,
  opts: { gzip?: (data: Uint8Array) => Promise<Uint8Array>; limitBytes?: number } = {}
): Promise<CaptureResult> {
  const b = (body && typeof body === 'object' ? body : {}) as { consent?: unknown; axisVersion?: unknown };
  if (b.consent !== true) return { code: 400, body: { error: 'not-consented' } };
  const last = LAST.get(registry);
  if (!last) return { code: 404, body: { error: 'no-result' } };
  if (!cloud) return { code: 503, body: { error: 'cloud-disabled' } };
  // the client's own version, stamped into the uploaded copy only (the stored result stays as it was)
  const axis = typeof b.axisVersion === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(b.axisVersion) ? b.axisVersion : undefined;
  const bundle: CaptureBundle = axis ? { ...last.bundle, app: { ...last.bundle.app, axis } } : last.bundle;
  const gz = await (opts.gzip ?? gzipBytes)(new TextEncoder().encode(JSON.stringify(bundle)));
  const limit = opts.limitBytes ?? UPLOAD_LIMIT_BYTES;
  if (gz.length > limit) return { code: 413, body: { error: 'too-large', bytes: gz.length, limit } };
  const app = { forgefx: bundle.app.forgefx, codec: bundle.app.codec, ...(bundle.app.axis ? { axis: bundle.app.axis } : {}) };
  const r = await cloud.diagnosticCaptureUpload(gz, { captureId: bundle.id, model: bundle.device.model, firmware: bundle.device.firmware, app, state: bundle.state, bytes: gz.length });
  const rb = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
  if (r.disabled) return { code: 503, body: { error: 'cloud-disabled' } };
  if (r.code === 401) return { code: 401, body: { error: 'not-signed-in' } };
  if (r.code === 403 && rb.error === 'account-required') return { code: 401, body: { error: 'not-signed-in', reason: 'account-required' } };
  if (r.code === 429) {
    const fromBody = typeof rb.retryAfterSeconds === 'number' ? rb.retryAfterSeconds : NaN;
    const fromHeader = Number(r.retryAfter ?? NaN);
    const retryAfterSeconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : null;
    return { code: 429, body: { error: rb.error === 'quota-exceeded' ? 'quota-exceeded' : 'rate-limited', retryAfterSeconds } };
  }
  if (r.code === 413) return { code: 413, body: { error: 'too-large', bytes: gz.length, limit: typeof rb.limit === 'number' ? rb.limit : limit, ...(typeof rb.stage === 'string' ? { stage: rb.stage } : {}) } };
  if (r.code >= 200 && r.code < 300 && typeof rb.captureId === 'string') {
    return { code: 200, body: { ok: true, captureId: rb.captureId, bytes: gz.length, ...(rb.deduped === true ? { deduped: true } : {}) } };
  }
  const message = typeof rb.message === 'string' ? rb.message : typeof rb.error === 'string' ? rb.error : r.code === 0 ? 'cloud unreachable' : `cloud answered ${r.code}`;
  return { code: 502, body: { error: 'cloud', status: r.code, message } };
}

/** gzip via the web-standard CompressionStream (Node 18+ and browsers alike). */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(data.slice()).catch(() => {}); // a copy on a plain ArrayBuffer (what the stream's typing wants)
  void writer.close().catch(() => {});
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ── steps selection ──

function resolveSteps(raw: unknown, includeFullWalk: boolean): { ok: true; steps: StepName[] } | { ok: false; message: string } {
  let wanted: readonly StepName[] = DEFAULT_STEPS;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || !(STEP_ORDER as readonly string[]).includes(s))) {
      return { ok: false, message: `steps must be a list of: ${STEP_ORDER.join(', ')}` };
    }
    wanted = raw as StepName[];
  }
  const set = new Set<StepName>(wanted);
  if (includeFullWalk) set.add('fullWalk');
  const steps = STEP_ORDER.filter((s) => set.has(s));
  if (steps.length === 0) return { ok: false, message: 'no steps selected' };
  return { ok: true, steps };
}

// ── the run ──

class AbortedError extends Error {}

function throwIfAborted(job: Job): void {
  if (job.controller.signal.aborted) throw new AbortedError(`run aborted: ${job.abortReason ?? 'aborted'}`);
}

function abortJob(job: Job, reason: string): void {
  if (job.abortReason) return;
  job.abortReason = reason;
  job.marks.push(job.frames.length);
  log(job, reason === 'cancelled' ? 'info' : 'warn', `run aborted: ${reason}`);
  job.controller.abort();
}

async function runCapture(job: Job): Promise<void> {
  const { registry } = job;
  const resume = registry.pauseTelemetry(); // synchronous — telemetry is off before the first await
  const unobserve = registry.addFrameObserver((dir, bytes) => recordFrame(job, dir, bytes));
  const untap = tapConsole(job);
  const tick = job.opts.watchdogTickMs ?? DEFAULT_WATCHDOG_TICK_MS;
  // Not unref'd: while a step hangs on a dead link this timer is what ends the run (cleared in finally).
  const watchdog = setInterval(() => checkSilence(job), tick);
  log(job, 'info', `capture ${job.id} started: model 0x${job.model.toString(16)}, steps ${job.steps.map((s) => s.name).join(', ')}`);
  try {
    try {
      const t = await registry.transport();
      job.transportKind = t.kind;
      job.label = t.label || null;
    } catch (e) {
      log(job, 'warn', `transport unavailable: ${(e as Error).message}`);
    }
    for (const step of job.steps) {
      if (job.abortReason) {
        step.status = 'skipped';
        step.note = `not run: ${job.abortReason}`;
        continue;
      }
      await runStep(job, step);
    }
  } catch (e) {
    // a fault of the runner itself — still end with a bundle
    if (!job.abortReason) abortJob(job, `error: ${(e as Error).message}`);
  } finally {
    clearInterval(watchdog);
    untap();
    unobserve();
    resume();
    finish(job);
  }
}

type StepOutcome = { status?: 'ok' | 'skipped' | 'failed'; note?: string; error?: string };
type StepImpl = (job: Job, step: StepRecord) => Promise<StepOutcome>;

const STEPS: Record<StepName, StepImpl> = {
  info: stepInfo,
  readonlyWalk: (job, step) => stepWalk(job, step, 'read-only'),
  labelProbe: stepLabelProbe,
  dumpHeaderProbe: stepDumpHeaderProbe,
  reloadProbe: stepReloadProbe,
  fullWalk: stepFullWalk
};

async function runStep(job: Job, step: StepRecord): Promise<void> {
  step.status = 'running';
  step.startedAt = new Date(job.now()).toISOString();
  job.stepStartedAt = job.now();
  log(job, 'info', `step ${step.name}: start`);
  try {
    const out = await STEPS[step.name](job, step);
    step.status = out.status ?? 'ok';
    if (out.note) step.note = scrub(out.note, job.label);
    if (out.error) step.error = scrub(out.error, job.label);
  } catch (e) {
    step.status = job.abortReason ? 'aborted' : 'failed';
    step.error = scrub((e as Error).message, job.label);
  } finally {
    step.endedAt = new Date(job.now()).toISOString();
    job.stepStartedAt = null;
  }
  log(job, step.status === 'failed' ? 'warn' : 'info', `step ${step.name}: ${step.status}${step.note ? ` (${step.note})` : ''}${step.error ? ` — ${step.error}` : ''}`);
  if (step.status === 'failed' && !job.abortReason) {
    job.marks.push(job.frames.length);
    // carry on only while the device still answers
    if (!(await deviceAlive(job))) abortJob(job, 'device-silent');
  }
}

function checkSilence(job: Job): void {
  if (job.stepStartedAt === null || job.abortReason) return;
  const silence = job.opts.silenceMs ?? DEFAULT_SILENCE_MS;
  if (job.now() - Math.max(job.lastRx, job.stepStartedAt) > silence) abortJob(job, 'device-silent');
}

// ── wire helpers ──

/** One self-describe query over the walk's own matcher (`adaptRequest`): the reply frame, or null when the
 *  device did not answer (a transport that reports silence as a typed timeout included). */
async function sdQuery(transport: Transport, query: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await adaptRequest(transport, query);
  } catch (e) {
    if (isTransportTimeout(e)) return null;
    throw e;
  }
}

/** The query-bound watchdog: a fn-0x01 query whose param lies above the walk's hard bound for its block is
 *  never sent — the run aborts as 'query-bound'. */
function guardQuery(job: Job, bounds: Pick<LiveWalkOptions, 'paramBoundByBlock' | 'maxParamId' | 'mode'>, query: Uint8Array): void {
  if (query.length < 13 || query[5] !== 0x01) return;
  const block = (query[8]! & 0x7f) | ((query[9]! & 0x7f) << 7);
  const param = (query[10]! & 0x7f) | ((query[11]! & 0x7f) << 7);
  const bound = walkQueryBound(bounds, block);
  if (param > bound) {
    abortJob(job, 'query-bound');
    throw new Error(`query above the walk's bound not sent (block ${block}, param ${param}, bound ${bound})`);
  }
}

const pause = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** A known parameter of the model for liveness checks: the first amp block's lowest catalog param (FM3 /
 *  FM9 / Axe-Fx III: block 58, param 0). */
export function livenessAddress(model: number): { block: number; param: number } {
  const profile = PROFILES[model];
  for (const [block, ref] of staticRoster(model)) {
    if (ref.family !== 'DISTORT' || ref.instance !== 1) continue;
    const ids = [...(profile?.params.DISTORT ?? []).map((d) => d.paramId), ...Object.keys(profile?.ranges.DISTORT ?? {}).map(Number)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < 0xff00);
    return { block, param: ids.length ? Math.min(...ids) : 0 };
  }
  return { block: 58, param: 0 };
}

async function deviceAlive(job: Job): Promise<boolean> {
  try {
    const t = await job.registry.transport();
    const { block, param } = livenessAddress(job.model);
    return (await sdQuery(t, buildDefQuery(job.model, block, param))) !== null;
  } catch {
    return false;
  }
}

// ── step: info ──

async function stepInfo(job: Job, step: StepRecord): Promise<StepOutcome> {
  const { registry } = job;
  const driver = await registry.driver();
  const transport = await registry.transport();
  job.transportKind = transport.kind;
  job.label = transport.label || null;
  const fw = await registry.refreshFirmware();
  job.firmware = fw?.version ?? null;
  job.fw = fw ? { major: fw.major, minor: fw.minor } : null;
  throwIfAborted(job);
  let presetNumber: number | null = null;
  if (driver.presetRef) {
    const ref = await driver.presetRef(); // the name in the reply is never kept
    presetNumber = ref.number >= 0 ? ref.number : null;
  }
  step.result = {
    model: job.model,
    modelName: job.modelName,
    profile: driver.key,
    firmware: fw?.version ?? null,
    firmwareBuild: fw?.build || null,
    transport: transport.kind,
    slowLink: transport.slow,
    presetNumber,
    versions: appVersions(job)
  };
  return fw ? {} : { note: 'firmware could not be read' };
}

// ── steps: readonlyWalk / fullWalk ──

/** Run the device-cache walk (same options, limits and hints as a build) into the bundle: the derived
 *  profile is summarised in the step result and NEVER stored or applied. */
async function stepWalk(job: Job, step: StepRecord, mode: BuildMode): Promise<StepOutcome> {
  const { registry, model } = job;
  const transport = await registry.transport();
  let write: LiveWalkOptions['write'];
  if (mode === 'full') {
    const driver = await registry.driver();
    write = {
      send: (frame) => transport.sendQueued(Array.from(frame)),
      reloadPreset: () => driver.reloadPreset?.() ?? Promise.resolve()
    };
  }
  const { opts, limits, hinted } = walkSetup(job.store, model, job.fw, mode, {
    signal: job.controller.signal,
    write,
    onProgress: (p) => {
      step.progress = p.phase === 'done' ? { done: p.blockCount, total: p.blockCount } : { done: p.blockIndex, total: p.blockCount };
    }
  });
  const adapter: LiveTransport = {
    request: async (q) => {
      guardQuery(job, opts, q);
      return sdQuery(transport, q);
    }
  };
  const result: Record<string, unknown> = {
    mode,
    firmware: job.firmware,
    hinted,
    options: {
      interQueryMs: opts.interQueryMs,
      blockPauseMs: opts.blockPauseMs,
      maxParamId: opts.maxParamId,
      boundBlocks: Object.keys(limits.bound).length,
      knownSizeBlocks: Object.keys(limits.knownSize).length,
      hintBlocks: Object.keys(opts.enumHintByBlock ?? {}).length
    }
  };
  step.result = result;
  const walkImpl = job.opts.walkImpl ?? liveWalkDetailed;
  const built = await buildCache({ kind: 'live', walk: () => walkImpl(adapter, opts) }, paramsForModel(model), HW_SEEDS, {
    model,
    ...(job.firmware ? { firmware: job.firmware } : {}),
    builtAt: new Date(job.now()).toISOString()
  });
  throwIfAborted(job);
  result.profile = profileSummary(built);
  return {};
}

function profileSummary(built: BuiltCache): Record<string, unknown> {
  const enumParams: Record<string, number> = {};
  for (const [family, rows] of Object.entries(built.ranges ?? {})) enumParams[family] = Object.values(rows).filter((r) => r.kind === 'enum').length;
  return {
    schema: built.meta.schema ?? null,
    recordCount: built.meta.recordCount,
    walk: built.meta.walk ?? null,
    families: Object.keys(built.rangeSections ?? {}).length,
    sections: Object.fromEntries(Object.entries(built.rangeSections ?? {}).map(([f, m]) => [f, { tag: m.sectionTag, stride: m.stride, records: m.recordCount }])),
    enumParams,
    rosters: Object.fromEntries(Object.entries(built.rosters ?? {}).map(([f, r]) => [f, r.length])),
    unmappedSections: built.unmappedSections ?? [],
    unmappedFamilies: built.unmappedFamilies ?? []
  };
}

async function stepFullWalk(job: Job, step: StepRecord): Promise<StepOutcome> {
  if (!job.includeFullWalk) return { status: 'skipped', note: 'includeFullWalk not set' };
  const { registry } = job;
  const caps = registry.activeCapabilities();
  const driver = await registry.driver();
  if (!caps?.fullCapture || !driver.reloadPreset) return { status: 'skipped', note: 'full capture is not supported on this device' };
  // the same gate the cache build applies: a firmware re-read right before deciding, verified versions only
  const fw = await registry.refreshFirmware();
  job.firmware = fw?.version ?? job.firmware;
  job.fw = fw ? { major: fw.major, minor: fw.minor } : null;
  if (!fullCaptureAllowedOnFirmware(job.model, fw)) {
    return { status: 'skipped', note: fw ? `full capture is not verified on firmware ${fw.version}` : 'full capture needs a known firmware version' };
  }
  // the full walk reloads the current preset after every swept block: never over unsaved edits
  const eb = await editBufferState(job, driver);
  if (eb.state !== 'clean') {
    step.result = { editBuffer: eb.state };
    return { status: 'skipped', note: 'unsaved edits' };
  }
  throwIfAborted(job);
  return stepWalk(job, step, 'full');
}

// ── step: labelProbe ──

/** Does a definition fit the label list a hint names — the codec's own rule for a hinted label walk
 *  (integral bounds, first ordinal 0..127, the hint's typecode, the default inside min..max; 'exact' count,
 *  or 'grown' by up to 4 labels). */
function hintFit(d: LiveDefinition, hint: LiveEnumHint): 'exact' | 'grown' | false {
  const integral = (x: number) => Number.isFinite(x) && x === Math.round(x);
  if (!integral(d.min) || !integral(d.max)) return false;
  const lo = Math.round(d.min);
  const span = Math.round(d.max - d.min + 1);
  if (lo < 0 || lo > 127 || span < 1 || span > ENUM_COUNT_CAP) return false;
  if (hint.typecode !== d.tc) return false;
  if (!integral(d.scale) || d.scale < d.min || d.scale > d.max) return false;
  if (span === hint.count) return 'exact';
  return span > hint.count && span <= hint.count + HINT_GROWTH_LIMIT ? 'grown' : false;
}

interface LabelProbeEntry {
  block: number;
  param: number;
  family: string;
  expected: { count: number; typecode: number };
  got?: { typecode: number; min: number; max: number; default: number; step: number };
  fit?: 'exact' | 'grown' | 'mismatch' | 'no-definition';
  labelReply?: 'label' | 'empty' | 'none' | 'not-sent';
  label?: string;
}

async function stepLabelProbe(job: Job, step: StepRecord): Promise<StepOutcome> {
  const { registry, model, store } = job;
  const transport = await registry.transport();
  const key = job.fw ? deviceCacheKey(model, job.fw.major, job.fw.minor) : null;
  const stored = key ? loadStoredProfile(store, key) : null;
  const usable = stored?.state === 'usable' ? stored.profile : null;
  // The walk's own hint source and roster keying (walkEnumHints), WITHOUT the per-firmware gate — this
  // step is the verification. The walk's read-only bounds still hold: a hint above them is never probed.
  const hints = walkEnumHints(model, usable);
  const limits = walkBlockLimits(model, 'read-only', usable);
  const bounds = { paramBoundByBlock: limits.bound, maxParamId: 127 };
  const roster = staticRoster(model);
  const byteExactFamilies = usable && isLocalByteProfile(usable.meta)
    ? Object.keys(usable.ranges ?? {}).filter((f) => Object.keys(usable.ranges[f] ?? {}).length > 0).sort()
    : [];
  const isGlobal = (b: number) => roster.get(b)?.family === 'GLOBAL';
  const blocks = Object.keys(hints).map(Number).sort((a, b) => a - b);
  const ordered = [...blocks.filter((b) => !isGlobal(b)), ...blocks.filter(isGlobal)];
  const work: { block: number; param: number; family: string; hint: LiveEnumHint }[] = [];
  let beyondBound = 0;
  for (const block of ordered) {
    const family = roster.get(block)?.family ?? '?';
    for (const p of Object.keys(hints[block]!).map(Number).sort((a, b) => a - b)) {
      if (p > walkQueryBound(bounds, block)) { beyondBound++; continue; }
      work.push({ block, param: p, family, hint: hints[block]![p]! });
    }
  }
  const live = livenessAddress(model);
  const counts = { hints: work.length + beyondBound, beyondBound, probed: 0, noDefinition: 0, mismatch: 0, grownNotLabel: 0, labelQueries: 0, labels: 0, emptyLabels: 0 };
  const entries: LabelProbeEntry[] = [];
  const result: Record<string, unknown> = {
    firmware: job.firmware,
    hintsVerifiedOnFirmware: enumHintsVerifiedOn(model, job.fw),
    byteExactFamilies,
    liveness: live,
    counts,
    entries
  };
  step.result = result;
  step.progress = { done: 0, total: work.length };
  const pacing = job.opts.pacing ?? WALK_PACING;
  const query = async (q: Uint8Array): Promise<Uint8Array | null> => {
    throwIfAborted(job);
    guardQuery(job, bounds, q);
    const r = await sdQuery(transport, q);
    await pause(pacing.interQueryMs);
    return r;
  };
  let stop: { block: number; param: number; query: 'definition' | 'value' | 'label' | 'liveness' } | null = null;
  let prevBlock = -1;
  for (const w of work) {
    throwIfAborted(job);
    if (prevBlock !== -1 && w.block !== prevBlock) await pause(pacing.blockPauseMs);
    prevBlock = w.block;
    const entry: LabelProbeEntry = { block: w.block, param: w.param, family: w.family, expected: { count: w.hint.count, typecode: w.hint.typecode } };
    entries.push(entry);
    counts.probed++;
    step.progress = { done: counts.probed, total: work.length };
    const defFrame = await query(buildDefQuery(model, w.block, w.param));
    if (!defFrame) { stop = { block: w.block, param: w.param, query: 'definition' }; break; }
    const d = decodeReply(defFrame);
    if (!d || d.view !== 'definition') { entry.fit = 'no-definition'; counts.noDefinition++; continue; }
    entry.got = { typecode: d.tc, min: d.min, max: d.max, default: d.scale, step: d.step };
    const fit = hintFit(d, w.hint);
    if (!fit) { entry.fit = 'mismatch'; counts.mismatch++; continue; }
    entry.fit = fit;
    if (fit === 'grown') {
      // like the walk: a grown list is label-queried only when its formatted value is a label
      const v = await query(buildValueQuery(model, w.block, w.param));
      if (!v) { stop = { block: w.block, param: w.param, query: 'value' }; break; }
      const vr = decodeReply(v);
      const display = vr?.view === 'value' ? vr.value : '';
      if (!(display.trim() !== '' && parseDisplayValue(display) === null)) {
        entry.labelReply = 'not-sent';
        counts.grownNotLabel++;
        continue;
      }
    }
    counts.labelQueries++;
    const lab = await query(buildEnumQuery(model, w.block, w.param, Math.round(d.min)));
    if (!lab) { entry.labelReply = 'none'; stop = { block: w.block, param: w.param, query: 'label' }; break; }
    const lr = decodeReply(lab);
    if (lr?.view === 'enum_label') { entry.labelReply = 'label'; entry.label = lr.label; counts.labels++; }
    else { entry.labelReply = 'empty'; counts.emptyLabels++; }
    const alive = await query(buildDefQuery(model, live.block, live.param));
    if (!alive) { stop = { block: w.block, param: w.param, query: 'liveness' }; break; }
  }
  if (stop) {
    result.stoppedAt = stop;
    return { status: 'failed', note: 'stopped at the first missing reply', error: `no reply to the ${stop.query} query (block ${stop.block}, param ${stop.param})` };
  }
  return {};
}

// ── step: dumpHeaderProbe ──

interface DumpProbeEntry {
  target: number | 'edit-buffer';
  purpose: 'fixed' | 'empty-search' | 'edit-buffer';
  header: number | null;
  /** What the header names: the requested number, an edit-buffer value, another number, or no header. */
  names: 'request' | 'edit-buffer' | 'other' | 'none';
  complete: boolean;
  frames: number;
  chunks: number;
  bytes: number;
  empty: boolean | null;
  ms: number;
}

function headerNames(header: number | null, requested: number): DumpProbeEntry['names'] {
  if (header === null) return 'none';
  if (header === requested) return 'request';
  if (EDIT_BUFFER_HEADERS.includes(header)) return 'edit-buffer';
  return 'other';
}

async function stepDumpHeaderProbe(job: Job, step: StepRecord): Promise<StepOutcome> {
  const driver = await job.registry.driver();
  if (!driver.diagnosticDump) return { status: 'skipped', note: 'this device cannot request a preset dump' };
  const count = driver.presetCount ?? 512;
  const last = count - 1;
  const fixed = [...new Set([0, 127, 128, last])].filter((n) => n >= 0 && n < count);
  const requests: DumpProbeEntry[] = [];
  const emptySlots: number[] = [];
  const result: Record<string, unknown> = { presetCount: count, requests, emptySlots };
  step.result = result;
  const budget = Math.max(0, job.opts.emptySearchBudget ?? DEFAULT_EMPTY_SEARCH_BUDGET);
  step.progress = { done: 0, total: fixed.length + 1 };
  let missing: number | 'edit-buffer' | null = null;
  const probe = async (target: number | 'edit-buffer', purpose: DumpProbeEntry['purpose']): Promise<DiagnosticDump | null> => {
    throwIfAborted(job);
    const d = await driver.diagnosticDump!(target);
    requests.push({
      target, purpose, header: d.header, names: headerNames(d.header, d.requested), complete: d.complete,
      frames: d.frames, chunks: d.chunks, bytes: d.bytes, empty: d.empty, ms: d.ms
    });
    step.progress = { done: requests.length, total: Math.max(step.progress?.total ?? 0, requests.length) };
    if (d.frames === 0) { missing = target; return null; } // no answer at all: stop here
    if (d.empty === true && typeof target === 'number') emptySlots.push(target);
    return d;
  };
  for (const n of fixed) {
    if (!(await probe(n, 'fixed'))) break;
  }
  if (missing === null) {
    // look for unused slots from the top down (where a unit's free slots usually are)
    let found = 0;
    let spent = 0;
    for (let n = last - 1; n >= 0 && found < EMPTY_SLOTS_WANTED && spent < budget; n--) {
      if (fixed.includes(n)) continue;
      spent++;
      const d = await probe(n, 'empty-search');
      if (!d) break;
      if (d.empty === true) found++;
    }
    if (found === 0 && spent > 0) result.emptySearch = { searched: spent, found: 0 };
  }
  if (missing === null) await probe('edit-buffer', 'edit-buffer');
  if (missing !== null) {
    result.stoppedAt = missing;
    return { status: 'failed', note: 'stopped at the first missing reply', error: `no reply to the dump request for ${missing === 'edit-buffer' ? 'the edit buffer' : `slot ${missing}`}` };
  }
  return {};
}

// ── step: reloadProbe ──

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Does the edit buffer hold exactly its stored slot (no unsaved edits)? Read-only: dumps the edit buffer
 *  and the current slot and compares them in memory ('raw' = identical raw patch, 'content' = identical
 *  body + name). Anything else — a difference, an undecodable dump, an unknown current preset — is not
 *  'clean'. */
async function editBufferState(job: Job, driver: DeviceDriver): Promise<{ state: 'clean' | 'dirty' | 'unknown'; preset: number | null; match?: 'raw' | 'content' | 'none' }> {
  if (!driver.presetRef || !driver.diagnosticDump) return { state: 'unknown', preset: null };
  const ref = await driver.presetRef();
  if (ref.number < 0) return { state: 'unknown', preset: null };
  throwIfAborted(job);
  const eb = await driver.diagnosticDump('edit-buffer');
  throwIfAborted(job);
  const slot = await driver.diagnosticDump(ref.number);
  if (!eb.patch || !slot.patch) return { state: 'unknown', preset: ref.number };
  if (bytesEqual(eb.patch.raw, slot.patch.raw)) return { state: 'clean', preset: ref.number, match: 'raw' };
  const name = (p: { raw: Uint8Array }) => p.raw.subarray(0x08, 0x28);
  if (bytesEqual(eb.patch.body, slot.patch.body) && bytesEqual(name(eb.patch), name(slot.patch))) return { state: 'clean', preset: ref.number, match: 'content' };
  return { state: 'dirty', preset: ref.number, match: 'none' };
}

async function stepReloadProbe(job: Job, step: StepRecord): Promise<StepOutcome> {
  const driver = await job.registry.driver();
  if (!driver.selectPreset || !driver.presetRef || !driver.diagnosticDump) return { status: 'skipped', note: 'this device cannot switch presets by SysEx' };
  const eb = await editBufferState(job, driver);
  const result: Record<string, unknown> = { preset: eb.preset, editBuffer: eb.state, ...(eb.match ? { match: eb.match } : {}) };
  step.result = result;
  if (eb.state !== 'clean' || eb.preset === null) return { status: 'skipped', note: 'unsaved edits' };
  throwIfAborted(job);
  const t0 = job.now();
  const sw = await driver.selectPreset(eb.preset);
  const t1 = job.now();
  const after = await driver.presetRef();
  const t2 = job.now();
  result.switch = { ok: sw.ok, ms: t1 - t0 };
  result.verify = { preset: after.number, ms: t2 - t1 };
  result.verified = sw.ok && after.number === eb.preset;
  result.totalMs = t2 - t0;
  if (!result.verified) {
    return { status: 'failed', error: sw.ok ? `the preset number after the switch is ${after.number}, expected ${eb.preset}` : 'the device refused the preset switch' };
  }
  return {};
}

// ── recording ──

const toHex = (bytes: readonly number[]) => bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

/** Split a TX/RX byte run into its SysEx frames (a paced send carries several); anything that is not a
 *  well-formed F0..F7 run stays one piece. */
function splitFrames(bytes: readonly number[]): number[][] {
  if (bytes[0] !== 0xf0) return [Array.from(bytes)];
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { out.push(cur); cur = null; }
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [Array.from(bytes)];
}

const isFractal = (f: readonly number[]) => f.length >= 8 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74;

function withChecksum(f: number[]): number[] {
  let cs = 0;
  for (let i = 0; i < f.length - 2; i++) cs ^= f[i]!;
  f[f.length - 2] = cs & 0x7f;
  return f;
}

/** Redact one frame before it is recorded:
 *   - preset/scene name replies (fn 0x0d / 0x0e) and the name writes (fn 0x01 sub 0x28 / 0x2b): the name
 *     bytes become 0x20 (header, number and length kept; checksum recomputed) → kind 'name';
 *   - preset dump chunks / terminators (fn 0x78 / 0x79): only the first 8 bytes are kept, plus the total
 *     length → kind 'dump'. Dump headers (0x77) are kept whole.
 *  Everything else is kept verbatim. */
export function redactFrame(frame: readonly number[]): { bytes: number[]; len?: number; kind?: 'name' | 'dump' } {
  if (!isFractal(frame)) return { bytes: Array.from(frame) };
  const fn = frame[5];
  const n = frame.length;
  if (fn === 0x78 || fn === 0x79) return { bytes: frame.slice(0, 8), len: n, kind: 'dump' };
  const blank = (from: number): { bytes: number[]; kind: 'name' } => {
    const f = Array.from(frame);
    for (let i = from; i < n - 2; i++) f[i] = 0x20;
    return { bytes: withChecksum(f), kind: 'name' };
  };
  if (fn === 0x0d && n > 10) return blank(8); // [nn nn preset#] then the name
  if (fn === 0x0e && n > 9) return blank(7); // [nn scene] then the name
  if (fn === 0x01 && (frame[6] === 0x28 || frame[6] === 0x2b) && n > 23) return blank(21); // 15-byte prefix, then the packed name
  return { bytes: Array.from(frame) };
}

function recordFrame(job: Job, dir: 'TX' | 'RX', bytes: readonly number[]): void {
  const t = job.now();
  if (dir === 'RX') job.lastRx = t;
  for (const f of splitFrames(bytes)) {
    const r = redactFrame(f);
    if (r.kind === 'name') job.redaction.presetNames++;
    else if (r.kind === 'dump') job.redaction.dumpPayloadFrames++;
    job.frames.push({ t: t - job.t0, dir, hex: toHex(r.bytes), ...(r.len !== undefined ? { len: r.len } : {}) });
  }
}

/** Strip what must never reach a bundle from a log line: the port label, file-system paths, e-mail
 *  addresses, serial port names. */
export function scrub(msg: string, label: string | null): string {
  let s = msg;
  if (label) s = s.split(label).join('<port>');
  s = s
    .replace(/\\\\[^\s"'`,;)]+/g, '<path>')
    .replace(/\b[A-Za-z]:[\\/][^\s"'`,;)]*/g, '<path>')
    .replace(/(?:~|\/(?:Users|home|dev|tmp|var|private|Volumes|mnt|media|opt|root|etc|Applications|Library))\/[^\s"'`,;)]*/g, '<path>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bCOM\d+\b/gi, '<port>');
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function log(job: Job, level: CaptureLog['level'], msg: string): void {
  if (job.logs.length >= MAX_LOGS) return;
  job.logs.push({ t: job.now() - job.t0, level, msg: scrub(msg, job.label) });
}

/** Mirror the ForgeFX log lines written while the run is active (transport and driver warnings) into the
 *  job log. Pass-through: the console still prints them. */
function tapConsole(job: Job): () => void {
  const c = console as unknown as Record<'log' | 'warn' | 'error', (...args: unknown[]) => void>;
  const orig = { log: c.log, warn: c.warn, error: c.error };
  const levels = { log: 'debug', warn: 'warn', error: 'error' } as const;
  const wrapped = {} as Record<'log' | 'warn' | 'error', (...args: unknown[]) => void>;
  for (const k of ['log', 'warn', 'error'] as const) {
    wrapped[k] = (...args: unknown[]) => {
      try {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[forgefx]')) {
          log(job, levels[k], args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : String(a))).join(' '));
        }
      } catch { /* never break logging */ }
      orig[k].apply(console, args);
    };
    c[k] = wrapped[k];
  }
  return () => {
    for (const k of ['log', 'warn', 'error'] as const) if (c[k] === wrapped[k]) c[k] = orig[k];
  };
}

// ── the bundle ──

function appVersions(job: Job): { forgefx: string; codec: string } {
  return { forgefx: job.opts.versions?.forgefx || 'unknown', codec: CODEC_VERSION || 'unknown' };
}

function stepView(s: StepRecord): NonNullable<CaptureStatus['steps']>[number] {
  return { name: s.name, status: s.status, ...(s.progress ? { progress: { ...s.progress } } : {}), ...(s.note ? { note: s.note } : {}) };
}

/** Keep the frames of the bundle under `budget` bytes of JSON: first the beginning and the end of the run (up
 *  to half the budget), then the frames around each mark (failures / aborts, nearest first), then more from
 *  both ends until the budget is spent. Order is preserved; the caller records what was dropped. */
export function trimFrames(frames: CaptureFrame[], marks: readonly number[], budget: number): { frames: CaptureFrame[]; truncated?: { kept: number; dropped: number } } {
  const size = (f: CaptureFrame) => f.hex.length + 48;
  let total = 0;
  for (const f of frames) total += size(f);
  if (total <= budget) return { frames };
  const keep = new Uint8Array(frames.length);
  let used = 0;
  const take = (i: number, limit: number): boolean => {
    if (i < 0 || i >= frames.length || keep[i]) return true;
    const s = size(frames[i]!);
    if (used + s > limit) return false;
    keep[i] = 1;
    used += s;
    return true;
  };
  let lo = 0;
  let hi = frames.length - 1;
  const fromEnds = (limit: number) => {
    while (lo <= hi) {
      if (!take(lo, limit)) break;
      lo++;
      if (lo > hi) break;
      if (!take(hi, limit)) break;
      hi--;
    }
  };
  fromEnds(budget / 2);
  for (const m of marks) {
    for (let d = 0; d <= TRIM_WINDOW; d++) {
      if (!take(m - d, budget) || !take(m + d, budget)) break;
    }
  }
  fromEnds(budget);
  const kept = frames.filter((_, i) => keep[i]);
  return { frames: kept, truncated: { kept: kept.length, dropped: frames.length - kept.length } };
}

/** End of a run (from the runner's finally): settle step states, build the redacted bundle, publish it as
 *  the last result. Never throws — a fallback bundle is published if building the real one fails. */
function finish(job: Job): void {
  const endedAt = new Date(job.now()).toISOString();
  for (const s of job.steps) {
    if (s.status === 'running') s.status = 'aborted';
    else if (s.status === 'pending') { s.status = 'skipped'; s.note = `not run: ${job.abortReason ?? 'run ended'}`; }
  }
  const state: CaptureBundle['state'] = job.abortReason === 'cancelled' ? 'cancelled' : job.abortReason ? 'failed' : 'done';
  log(job, 'info', `capture ${job.id} ended: ${state}${job.abortReason ? ` (${job.abortReason})` : ''}`);
  let bundle: CaptureBundle;
  try {
    const base: CaptureBundle = {
      schema: 1,
      id: job.id,
      createdAt: job.startedAt,
      endedAt,
      state,
      ...(job.abortReason ? { abortReason: job.abortReason } : {}),
      app: appVersions(job),
      device: { model: job.model, modelName: job.modelName, firmware: job.firmware, transport: job.transportKind },
      steps: job.steps.map((s) => ({
        name: s.name, status: s.status,
        ...(s.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s.endedAt ? { endedAt: s.endedAt } : {}),
        ...(s.result !== undefined ? { result: s.result } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(s.note ? { note: s.note } : {})
      })),
      frames: [],
      logs: job.logs,
      redaction: { ...job.redaction }
    };
    const rest = JSON.stringify(base).length;
    const max = job.opts.maxBundleJsonBytes ?? MAX_BUNDLE_JSON_BYTES;
    const trimmed = trimFrames(job.frames, job.marks, Math.max(0, max - BUNDLE_JSON_MARGIN - rest));
    bundle = { ...base, frames: trimmed.frames, ...(trimmed.truncated ? { framesTruncated: trimmed.truncated } : {}) };
  } catch (e) {
    bundle = {
      schema: 1, id: job.id, createdAt: job.startedAt, endedAt, state: 'failed', abortReason: job.abortReason ?? `error: ${(e as Error).message}`,
      app: { forgefx: job.opts.versions?.forgefx || 'unknown', codec: CODEC_VERSION || 'unknown' },
      device: { model: job.model, modelName: job.modelName, firmware: job.firmware, transport: job.transportKind },
      steps: job.steps.map((s) => ({ name: s.name, status: s.status })),
      frames: [], logs: [], redaction: { ...job.redaction }
    };
  }
  const status: CaptureStatus = {
    state: bundle.state,
    id: job.id,
    startedAt: job.startedAt,
    endedAt,
    steps: job.steps.map(stepView),
    ...(bundle.abortReason ? { abortReason: bundle.abortReason } : {}),
    resultAvailable: true
  };
  LAST.set(job.registry, { bundle, status });
  job.frames = []; // the bundle owns what is kept
}

/** A bundle id safe for a storage path: `dc-<UTC timestamp>-<random>`. */
function newCaptureId(t: number): string {
  const stamp = new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const rnd = new Uint8Array(4);
  if (c?.getRandomValues) c.getRandomValues(rnd);
  else for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  return `dc-${stamp}-${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
