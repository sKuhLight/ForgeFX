// Diagnostic capture — the in-app device diagnostic (Axis: Settings → Debugging → "Device diagnostics").
// One background job per registry runs a fixed sequence of read-mostly steps against the attached gen-3
// unit with exactly the shipped walk/probe code, records the whole wire log of the run, and ALWAYS leaves
// a result bundle behind (done, failed, cancelled or aborted) that the user can save or upload for analysis.
//
//   info            model, firmware (fresh fn 0x08 read), transport kind, current preset number, versions
//   readonlyWalk    the device-cache read-only walk (same options, limits and hints as a build) — into
//                   the bundle only; the stored device profile is never written or swapped
//   labelProbe      only the label lists THIS run's read-only walk found as real definitions that fit a hint
//                   and that only a hinted walk would label-walk (a non-zero default ordinal): ONE label query at
//                   the first ordinal (sub = min), then a liveness query; effect blocks first, Controllers,
//                   Modifier, Global last; stops at the first missing reply. No walk in the run → skipped.
//   dumpHeaderProbe stored-slot dumps (0, 127, 128, last, up to three unused slots) + the edit buffer: which
//                   preset number each 0x77 header names (dump payloads are never kept)
//   reloadProbe     re-select the current preset by SysEx and verify the preset number — only when the edit
//                   buffer provably equals its stored slot (never over unsaved edits)
//   fullWalk        opt-in; the full walk under every existing gate (fullCapture + verified firmware), and
//                   only with the same provably clean edit buffer (it reloads the preset after each block)
//
// Mutually exclusive with the device-cache build (services/deviceJobs.ts). A watchdog aborts the run when a
// walk query would exceed the walk's hard bound or when nothing is received for 60 s while a step runs; an
// abort (or a cancel) ends the run at once, even while a step still waits on the link.
// Redaction happens as frames are recorded: preset/scene names are blanked, dump chunks cut to a prefix.
// Log lines are scrubbed (port, paths, home directory, user and host names, e-mail addresses) and frame
// dumps are never copied into the job log.
//
// Browser-safe: registry/store/driver are type-only or structural imports, gzip uses CompressionStream and
// the upload goes through an injected cloud client. NO node:/fastify/transport VALUE imports beyond the
// browser-safe transport types (check-browser-safe.ts enforces it).
import {
  buildCache, buildDefQuery, buildEnumQuery, decodeReply, parseDisplayValue, HW_SEEDS, liveWalkDetailed, VIEW_DEFINITION, VIEW_VALUE,
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

/** Who runs this process — only to scrub it out of log lines (never stored). */
export interface HostIdentity { home?: string; user?: string; host?: string }

/** Host bindings and test seams. Everything is optional; the defaults are the production behaviour. */
export interface CaptureOptions {
  /** The walk both walk steps run (test seam). */
  walkImpl?: CaptureWalkImpl;
  /** Version stamps the host knows (the server reads its package version; a browser runtime passes its own). */
  versions?: { forgefx?: string; codec?: string; axis?: string };
  /** No frame received for this long while a step runs → the run aborts as 'device-silent'. */
  silenceMs?: number;
  /** Watchdog check interval. */
  watchdogTickMs?: number;
  /** Pacing of the label probe (defaults to the walk's own: WALK_PACING). */
  pacing?: { interQueryMs: number; blockPauseMs: number };
  /** Stored slots the header probe may dump while looking for unused slots (at most 6). */
  emptySearchBudget?: number;
  /** Largest bundle JSON (bytes) before the wire log is trimmed. */
  maxBundleJsonBytes?: number;
  /** Scrubbed from log lines (defaults to this process's home directory, user and host name). */
  identity?: HostIdentity;
  /** Clock (ms). */
  now?: () => number;
}

// ── limits / constants ──

/** The upload endpoint's limit on the gzip body (25 MiB). */
export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
/** Largest bundle JSON kept (64 MiB): the wire log is trimmed below it. */
export const MAX_BUNDLE_JSON_BYTES = 64 * 1024 * 1024;
const BUNDLE_JSON_MARGIN = 256 * 1024;
const DEFAULT_SILENCE_MS = 60_000;
const DEFAULT_WATCHDOG_TICK_MS = 1000;
/** Stored slots the header probe may dump looking for unused ones, and how many unused slots it wants. */
const MAX_EMPTY_SEARCH = 6;
const EMPTY_SLOTS_WANTED = 3;
/** The walk's block range: the codec's default sweep (0..160) — the label probe never leaves it. */
const WALK_MAX_BLOCK = 160;
/** Frames kept on each side of a failure / abort when the wire log is trimmed. */
const TRIM_WINDOW = 200;
/** Log lines mirrored from the console (the job's own lines are not capped). */
const MAX_TAPPED_LOGS = 2000;
/** Label count cap of a list (the codec's default `enumCountCap`). */
const ENUM_COUNT_CAP = 1024;
/** How many labels a list may have grown past its hint (the codec's HINT_GROWTH_LIMIT). */
const HINT_GROWTH_LIMIT = 4;
const EDIT_BUFFER = 0x3fff;
/** Header numbers that name the edit buffer in a dump (the 0x3FFF request itself, and `7F 00`). */
const EDIT_BUFFER_HEADERS: readonly number[] = [EDIT_BUFFER, 0x3f80];
/** The order of the label probe after the effect blocks: Controllers, Modifier, Global last. */
const LATE_FAMILIES: readonly string[] = ['CONTROLLERS', 'MOD', 'GLOBAL'];

// ── job state (module-level, per registry — like the cache build) ──

interface StepRecord extends CaptureStep { progress?: { done: number; total: number } }

/** What this run's read-only walk saw: its decoded definitions + formatted values per `block:param`, and the
 *  addresses that became real records (no placeholder, no end marker / pseudo definition). */
interface WalkFindings {
  defs: Map<string, LiveDefinition>;
  displays: Map<string, string>;
  real: Set<string>;
}

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
  /** Rejects when the run is aborted (cancel, watchdog): every step and liveness check races it. */
  aborted: Promise<never>;
  abortReason: string | null;
  steps: StepRecord[];
  frames: CaptureFrame[];
  logs: CaptureLog[];
  tappedLogs: number;
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
  identity: HostIdentity;
  /** The completed read-only walk of this run (the label probe's only source), or null. */
  walk: WalkFindings | null;
  /** The bundle is built: late writes of a step that was still running are ignored. */
  finished: boolean;
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
  if (job && !job.finished) {
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
  const controller = new AbortController();
  const job: Job = {
    id: newCaptureId(t0),
    store, registry, opts: merged, now, t0,
    startedAt: new Date(t0).toISOString(),
    includeFullWalk,
    controller,
    aborted: new Promise<never>((_res, rej) => {
      controller.signal.addEventListener('abort', () => rej(new AbortedError(`run aborted: ${job.abortReason ?? 'aborted'}`)), { once: true });
    }),
    abortReason: null,
    steps: steps.steps.map((name) => ({ name, status: 'pending' as StepStatus })),
    frames: [], logs: [], tappedLogs: 0, redaction: { presetNames: 0, dumpPayloadFrames: 0 }, marks: [],
    lastRx: t0, stepStartedAt: null,
    model,
    modelName: DEVICE_MODELS[model]?.name ?? `0x${model.toString(16)}`,
    firmware: fw?.version ?? null,
    fw: fw ? { major: fw.major, minor: fw.minor } : null,
    transportKind: 'unknown',
    label: null,
    identity: merged.identity ?? hostIdentity(),
    walk: null,
    finished: false,
    promise: Promise.resolve()
  };
  job.aborted.catch(() => {}); // raced, never awaited alone
  RUNNING.set(registry, job);
  job.promise = runCapture(job)
    .catch(() => { /* runCapture publishes its own bundle; nothing may escape */ })
    .finally(() => {
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

const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

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
  const axis = typeof b.axisVersion === 'string' && VERSION_RE.test(b.axisVersion) ? b.axisVersion : undefined;
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
  if (job.abortReason || job.finished) return;
  job.abortReason = scrub(reason, job.label, job.identity);
  job.marks.push(job.frames.length);
  log(job, reason === 'cancelled' ? 'info' : 'warn', `run aborted: ${job.abortReason}`);
  job.controller.abort();
}

/** `p`, or the run's abort — whichever comes first. A step that still waits on the link after an abort
 *  settles on its own later; its result is ignored (the bundle is built from a copy). */
function raceAbort<T>(job: Job, p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return Promise.race([p, job.aborted]);
}

async function runCapture(job: Job): Promise<void> {
  const { registry } = job;
  let resume: () => void = () => {};
  let unobserve: () => void = () => {};
  let untap: () => void = () => {};
  let watchdog: ReturnType<typeof setInterval> | null = null;
  try {
    resume = registry.pauseTelemetry(); // synchronous — telemetry is off before the first await
    unobserve = registry.addFrameObserver((dir, bytes) => recordFrame(job, dir, bytes));
    untap = tapConsole(job);
    // Not unref'd: while a step hangs on a dead link this timer is what ends the run (cleared in finally).
    watchdog = setInterval(() => checkSilence(job), job.opts.watchdogTickMs ?? DEFAULT_WATCHDOG_TICK_MS);
    log(job, 'info', `capture ${job.id} started: model 0x${job.model.toString(16)}, steps ${job.steps.map((s) => s.name).join(', ')}`);
    try {
      const t = await raceAbort(job, registry.transport());
      job.transportKind = t.kind;
      job.label = t.label || null;
    } catch (e) {
      if (!job.abortReason) log(job, 'warn', `transport unavailable: ${(e as Error).message}`);
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
    if (watchdog) clearInterval(watchdog);
    for (const stop of [untap, unobserve, resume]) {
      try { stop(); } catch { /* one failing cleanup must not keep the bundle from being built */ }
    }
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
    const out = await raceAbort(job, STEPS[step.name](job, step));
    step.status = out.status ?? 'ok';
    if (out.note) step.note = scrub(out.note, job.label, job.identity);
    if (out.error) step.error = scrub(out.error, job.label, job.identity);
  } catch (e) {
    step.status = job.abortReason ? 'aborted' : 'failed';
    step.error = scrub((e as Error).message, job.label, job.identity);
  } finally {
    step.endedAt = new Date(job.now()).toISOString();
    job.stepStartedAt = null;
  }
  log(job, step.status === 'failed' ? 'warn' : 'info', `step ${step.name}: ${step.status}${step.note ? ` (${step.note})` : ''}${step.error ? ` — ${step.error}` : ''}`);
  if (step.status === 'failed' && !job.abortReason) {
    job.marks.push(job.frames.length);
    // carry on only while the device still answers
    let alive = false;
    try { alive = await raceAbort(job, deviceAlive(job)); } catch { /* aborted meanwhile */ }
    if (!alive) abortJob(job, 'device-silent');
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

/** Block and param a fn-0x01 self-describe query addresses. */
const queryAddress = (q: Uint8Array) => ({ block: (q[8]! & 0x7f) | ((q[9]! & 0x7f) << 7), param: (q[10]! & 0x7f) | ((q[11]! & 0x7f) << 7) });

/** The query-bound watchdog: a fn-0x01 query whose param lies above the walk's hard bound for its block is
 *  never sent — the run aborts as 'query-bound'. */
function guardQuery(job: Job, bounds: Pick<LiveWalkOptions, 'paramBoundByBlock' | 'maxParamId' | 'mode'>, query: Uint8Array): void {
  if (query.length < 13 || query[5] !== 0x01) return;
  const { block, param } = queryAddress(query);
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

const addrKey = (block: number, param: number) => `${block}:${param}`;

/** Run the device-cache walk (same options, limits and hints as a build) into the bundle: the derived
 *  profile is summarised in the step result and NEVER stored or applied. The read-only walk also keeps
 *  what it saw for the label probe (`job.walk`), only when it completes. */
async function stepWalk(job: Job, step: StepRecord, mode: BuildMode): Promise<StepOutcome> {
  const { registry, model } = job;
  const transport = await registry.transport();
  let write: LiveWalkOptions['write'];
  if (mode === 'full') {
    const driver = await registry.driver();
    write = {
      send: (frame) => transport.sendQueued(Array.from(frame)),
      // the job's own reloads stay silent: clients must not reload their views in the middle of the run
      reloadPreset: () => driver.reloadPreset?.({ silent: true }) ?? Promise.resolve()
    };
  }
  const { opts, limits, hinted } = walkSetup(job.store, model, job.fw, mode, {
    signal: job.controller.signal,
    write,
    onProgress: (p) => {
      step.progress = p.phase === 'done' ? { done: p.blockCount, total: p.blockCount } : { done: p.blockIndex, total: p.blockCount };
    }
  });
  const seen: WalkFindings = { defs: new Map(), displays: new Map(), real: new Set() };
  const adapter: LiveTransport = {
    request: async (q) => {
      guardQuery(job, opts, q);
      const reply = await sdQuery(transport, q);
      if (reply && mode === 'read-only' && q[5] === 0x01 && (q[6] === VIEW_DEFINITION || q[6] === VIEW_VALUE)) {
        const { block, param } = queryAddress(q);
        const r = decodeReply(reply);
        if (r?.view === 'definition') seen.defs.set(addrKey(block, param), r);
        else if (r?.view === 'value') seen.displays.set(addrKey(block, param), r.value);
      }
      return reply;
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
  let records: CacheRecord[] = [];
  const built = await buildCache({
    kind: 'live',
    walk: async () => {
      const r = await walkImpl(adapter, opts);
      records = Array.isArray(r) ? r : r.records;
      return r;
    }
  }, paramsForModel(model), HW_SEEDS, {
    model,
    ...(job.firmware ? { firmware: job.firmware } : {}),
    builtAt: new Date(job.now()).toISOString()
  });
  throwIfAborted(job);
  result.profile = profileSummary(built);
  if (mode === 'read-only') {
    // real records only: a placeholder slot or a pseudo definition (end marker, copy, junk) never became one
    for (const r of records) if (!(r as { placeholder?: boolean }).placeholder && r.id < 0xff00) seen.real.add(addrKey(r.section, r.id));
    job.walk = seen;
  }
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
    step.result = { editBuffer: eb.state, ...(eb.reason ? { reason: eb.reason } : {}) };
    return { status: 'skipped', note: 'unsaved edits' };
  }
  throwIfAborted(job);
  // the current preset once more, right before the walk starts reloading it
  const again = await driver.presetRef!();
  if (again.number !== eb.preset) {
    step.result = { editBuffer: 'unknown', reason: 'the current preset changed after the check' };
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

/** The empty-slot body (typecode 0, all-zero numbers): an unused slot or a table's end marker, never a list. */
const isFillerDefinition = (d: LiveDefinition) => d.tc === 0 && d.min === 0 && d.max === 0 && d.def === 0 && d.step === 0;

interface LabelProbeEntry {
  block: number;
  param: number;
  family: string;
  expected: { count: number; typecode: number };
  got: { typecode: number; min: number; max: number; default: number; step: number };
  fit: 'exact' | 'grown' | 'mismatch';
  labelReply: 'label' | 'empty' | 'none' | 'not-sent';
  label?: string;
}

async function stepLabelProbe(job: Job, step: StepRecord): Promise<StepOutcome> {
  const walk = job.walk;
  if (!walk) return { status: 'skipped', note: 'needs a completed read-only walk in this run' };
  const { registry, model, store } = job;
  const transport = await registry.transport();
  const key = job.fw ? deviceCacheKey(model, job.fw.major, job.fw.minor) : null;
  const stored = key ? loadStoredProfile(store, key) : null;
  const usable = stored?.state === 'usable' ? stored.profile : null;
  // The walk's own hint source and roster keying (walkEnumHints), WITHOUT the per-firmware gate — this step
  // is the verification. Targets are only what THIS run's walk found (see WalkFindings).
  const hints = walkEnumHints(model, usable);
  const limits = walkBlockLimits(model, 'read-only', usable);
  const bounds = { paramBoundByBlock: limits.bound, maxParamId: 127 };
  const roster = staticRoster(model);
  const byteExactFamilies = usable && isLocalByteProfile(usable.meta)
    ? Object.keys(usable.ranges ?? {}).filter((f) => Object.keys(usable.ranges[f] ?? {}).length > 0).sort()
    : [];
  const counts = { walkDefinitions: walk.real.size, hinted: 0, defaultZero: 0, mismatch: 0, grownNotLabel: 0, targets: 0, labels: 0, emptyLabels: 0 };
  const entries: LabelProbeEntry[] = [];
  const candidates: { entry: LabelProbeEntry; min: number }[] = [];
  for (const k of walk.real) {
    const [block, param] = k.split(':').map(Number) as [number, number];
    if (block > WALK_MAX_BLOCK || param > walkQueryBound(bounds, block)) continue;
    const hint = hints[block]?.[param];
    const d = walk.defs.get(k);
    if (!hint || !d || isFillerDefinition(d)) continue;
    counts.hinted++;
    // a list with a zero default is label-walked by the walk's numeric rule anyway: nothing to verify here
    if (d.scale === 0) { counts.defaultZero++; continue; }
    const entry: LabelProbeEntry = {
      block, param, family: roster.get(block)?.family ?? '?',
      expected: { count: hint.count, typecode: hint.typecode },
      got: { typecode: d.tc, min: d.min, max: d.max, default: d.scale, step: d.step },
      fit: 'mismatch', labelReply: 'not-sent'
    };
    const fit = hintFit(d, hint);
    if (!fit) { counts.mismatch++; entries.push(entry); continue; }
    entry.fit = fit;
    // like the walk: a grown list is label-queried only when its formatted value is a label
    const display = walk.displays.get(k) ?? '';
    if (fit === 'grown' && !(display.trim() !== '' && parseDisplayValue(display) === null)) { counts.grownNotLabel++; entries.push(entry); continue; }
    candidates.push({ entry, min: Math.round(d.min) });
  }
  // effect blocks first, then Controllers, Modifier, Global last
  const rank = (e: LabelProbeEntry) => { const i = LATE_FAMILIES.indexOf(e.family); return i < 0 ? 0 : i + 1; };
  candidates.sort((a, b) => rank(a.entry) - rank(b.entry) || a.entry.block - b.entry.block || a.entry.param - b.entry.param);
  counts.targets = candidates.length;
  const live = livenessAddress(model);
  const result: Record<string, unknown> = {
    firmware: job.firmware,
    hintsVerifiedOnFirmware: enumHintsVerifiedOn(model, job.fw),
    byteExactFamilies,
    liveness: live,
    counts,
    entries
  };
  step.result = result;
  step.progress = { done: 0, total: candidates.length };
  const pacing = job.opts.pacing ?? WALK_PACING;
  const query = async (q: Uint8Array): Promise<Uint8Array | null> => {
    throwIfAborted(job);
    guardQuery(job, bounds, q);
    const r = await sdQuery(transport, q);
    await pause(pacing.interQueryMs);
    return r;
  };
  let stop: { block: number; param: number; query: 'label' | 'liveness' } | null = null;
  let prevBlock = -1;
  for (const [i, c] of candidates.entries()) {
    throwIfAborted(job);
    const e = c.entry;
    if (prevBlock !== -1 && e.block !== prevBlock) await pause(pacing.blockPauseMs);
    prevBlock = e.block;
    entries.push(e);
    step.progress = { done: i + 1, total: candidates.length };
    const lab = await query(buildEnumQuery(model, e.block, e.param, c.min));
    if (!lab) { e.labelReply = 'none'; stop = { block: e.block, param: e.param, query: 'label' }; break; }
    const lr = decodeReply(lab);
    if (lr?.view === 'enum_label') { e.labelReply = 'label'; e.label = lr.label; counts.labels++; }
    else { e.labelReply = 'empty'; counts.emptyLabels++; }
    const alive = await query(buildDefQuery(model, live.block, live.param));
    if (!alive) { stop = { block: e.block, param: e.param, query: 'liveness' }; break; }
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
  step.progress = { done: 0, total: fixed.length + 1 };
  let stopped: number | 'edit-buffer' | null = null;
  /** One dump; null (and the step stops) when the dump did not arrive whole. */
  const probe = async (target: number | 'edit-buffer', purpose: DumpProbeEntry['purpose']): Promise<DiagnosticDump | null> => {
    throwIfAborted(job);
    const d = await driver.diagnosticDump!(target);
    requests.push({
      target, purpose, header: d.header, names: headerNames(d.header, d.requested), complete: d.complete,
      frames: d.frames, chunks: d.chunks, bytes: d.bytes, empty: d.empty, ms: d.ms
    });
    step.progress = { done: requests.length, total: Math.max(step.progress?.total ?? 0, requests.length) };
    if (!d.complete) { stopped = target; return null; }
    if (d.empty === true && typeof target === 'number') emptySlots.push(target);
    return d;
  };
  for (const n of fixed) {
    if (!(await probe(n, 'fixed'))) break;
  }
  if (stopped === null) {
    // unused slots: the fixed dumps' own flags count first; then a few slots from the top down (where a
    // unit's free slots usually are), at most MAX_EMPTY_SEARCH dumps
    const budget = Math.min(MAX_EMPTY_SEARCH, Math.max(0, job.opts.emptySearchBudget ?? MAX_EMPTY_SEARCH));
    let spent = 0;
    for (let n = last - 1; n >= 0 && emptySlots.length < EMPTY_SLOTS_WANTED && spent < budget; n--) {
      if (fixed.includes(n)) continue;
      spent++;
      if (!(await probe(n, 'empty-search'))) break;
    }
    result.emptySearch = { searched: spent, found: emptySlots.filter((n) => !fixed.includes(n)).length };
  }
  if (stopped === null) await probe('edit-buffer', 'edit-buffer');
  if (stopped !== null) {
    const what: number | 'edit-buffer' = stopped;
    result.stoppedAt = what;
    return { status: 'failed', note: 'stopped after an incomplete dump', error: `the dump for ${what === 'edit-buffer' ? 'the edit buffer' : `slot ${what}`} did not arrive whole` };
  }
  return {};
}

// ── step: reloadProbe ──

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Does the edit buffer hold exactly its stored slot (no unsaved edits)? Read-only. 'clean' ONLY when the
 *  edit-buffer dump arrived whole under an edit-buffer header, the dump of the current slot arrived whole under
 *  exactly that slot's number, and the two decode to the same patch ('raw' = identical raw patch, 'content' =
 *  identical body + name). A difference is 'dirty'; anything else (an unknown current preset, a dump named
 *  otherwise, an incomplete or undecodable dump) is 'unknown'. Callers re-check the current preset right
 *  before they switch. */
async function editBufferState(job: Job, driver: DeviceDriver): Promise<{ state: 'clean' | 'dirty' | 'unknown'; preset: number | null; match?: 'raw' | 'content' | 'none'; reason?: string }> {
  if (!driver.presetRef || !driver.diagnosticDump) return { state: 'unknown', preset: null, reason: 'no current-preset read or dump on this device' };
  const ref = await driver.presetRef();
  if (ref.number < 0) return { state: 'unknown', preset: null, reason: 'current preset unknown' };
  throwIfAborted(job);
  const eb = await driver.diagnosticDump('edit-buffer');
  if (!eb.complete || eb.header === null || !EDIT_BUFFER_HEADERS.includes(eb.header)) {
    return { state: 'unknown', preset: ref.number, reason: 'the edit-buffer dump did not arrive whole under an edit-buffer header' };
  }
  throwIfAborted(job);
  const slot = await driver.diagnosticDump(ref.number);
  if (!slot.complete || slot.header !== ref.number) {
    return { state: 'unknown', preset: ref.number, reason: 'the dump of the current slot did not arrive whole under its own number' };
  }
  if (!eb.patch || !slot.patch) return { state: 'unknown', preset: ref.number, reason: 'a dump could not be decoded' };
  if (bytesEqual(eb.patch.raw, slot.patch.raw)) return { state: 'clean', preset: ref.number, match: 'raw' };
  const name = (p: { raw: Uint8Array }) => p.raw.subarray(0x08, 0x28);
  if (bytesEqual(eb.patch.body, slot.patch.body) && bytesEqual(name(eb.patch), name(slot.patch))) return { state: 'clean', preset: ref.number, match: 'content' };
  return { state: 'dirty', preset: ref.number, match: 'none' };
}

async function stepReloadProbe(job: Job, step: StepRecord): Promise<StepOutcome> {
  const driver = await job.registry.driver();
  if (!driver.selectPreset || !driver.presetRef || !driver.diagnosticDump) return { status: 'skipped', note: 'this device cannot switch presets by SysEx' };
  const eb = await editBufferState(job, driver);
  const result: Record<string, unknown> = { preset: eb.preset, editBuffer: eb.state, ...(eb.match ? { match: eb.match } : {}), ...(eb.reason ? { reason: eb.reason } : {}) };
  step.result = result;
  if (eb.state !== 'clean' || eb.preset === null) return { status: 'skipped', note: 'unsaved edits' };
  throwIfAborted(job);
  // the current preset once more, right before the switch: a front-panel change since the check voids it
  const again = await driver.presetRef();
  if (again.number !== eb.preset) {
    result.editBuffer = 'unknown';
    result.reason = 'the current preset changed after the check';
    return { status: 'skipped', note: 'unsaved edits' };
  }
  throwIfAborted(job);
  const t0 = job.now();
  const sw = await driver.selectPreset(eb.preset, { silent: true }); // job-internal: no 'changed' to the clients
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
  if (job.finished) return;
  const t = job.now();
  if (dir === 'RX') job.lastRx = t;
  for (const f of splitFrames(bytes)) {
    const r = redactFrame(f);
    if (r.kind === 'name') job.redaction.presetNames++;
    else if (r.kind === 'dump') job.redaction.dumpPayloadFrames++;
    job.frames.push({ t: t - job.t0, dir, hex: toHex(r.bytes), ...(r.len !== undefined ? { len: r.len } : {}) });
  }
}

// ── log scrubbing ──

/** This process's home directory, user and host name, where the runtime exposes them (Node: env; a browser
 *  has none). Only ever used to remove them from log lines. */
function hostIdentity(): HostIdentity {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const home = env.USERPROFILE || env.HOME || undefined;
  const user = env.USERNAME || env.USER || env.LOGNAME || (home ? home.split(/[\\/]/).filter(Boolean).pop() : undefined);
  const host = env.COMPUTERNAME || env.HOSTNAME || undefined;
  return { ...(home ? { home } : {}), ...(user ? { user } : {}), ...(host ? { host } : {}) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip what must never reach a bundle from a log line: everything after its first line, the port label,
 *  the home directory, file-system paths (Windows paths with spaces included), e-mail addresses, serial port
 *  names, and the user and host name. */
export function scrub(msg: string, label: string | null, identity: HostIdentity = {}): string {
  let s = String(msg).split(/\r?\n/, 1)[0] ?? '';
  const swap = (needle: string | undefined, by: string, minLen: number, word = false) => {
    if (!needle || needle.length < minLen) return;
    const body = escapeRe(needle);
    s = s.replace(new RegExp(word ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'gi'), by);
  };
  swap(label ?? undefined, '<port>', 2);
  swap(identity.home, '<home>', 3);
  s = s
    .replace(/\\\\[^\s"'`,;)]+/g, '<path>') // UNC
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n"'<>|?*:]+\\)*[^\\\s"'<>|?*:,;)]*/g, '<path>') // Windows, segments may hold spaces
    .replace(/\b[A-Za-z]:\/[^\s"'<>|?*,;)]*/g, '<path>')
    .replace(/\/(?:Users|home)\/[^/\r\n"'<>|]+(?:\/[^/\s"'<>|,;)]*)*/g, '<path>') // a home dir (with spaces), then the rest
    .replace(/(?:~|\/(?:dev|tmp|var|private|Volumes|mnt|media|opt|root|etc|Applications|Library))\/[^\s"'`,;)]*/g, '<path>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bCOM\d+\b/gi, '<port>');
  swap(identity.user, '<user>', 3, true);
  swap(identity.host, '<host>', 3, true);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/** A per-frame wire trace line (a transport debugging aid): never copied into the job log — the frames
 *  already are, redacted. Catches a RX/TX trace, any Fractal SysEx header in hex, and long hex runs. */
const FRAME_DUMP_RE = /\b(?:RX|TX)\b[^\n]*\b[0-9a-f]{2}(?:[ ,:][0-9a-f]{2}){3}|f0[ ,:]?00[ ,:]?01[ ,:]?74|(?:\b[0-9a-f]{2}[ ,:]){12}|[0-9a-f]{24}/i;

function log(job: Job, level: CaptureLog['level'], msg: string): void {
  if (job.finished) return;
  job.logs.push({ t: job.now() - job.t0, level, msg: scrub(msg, job.label, job.identity) });
}

/** Mirror the ForgeFX log lines written while the run is active (transport and driver warnings) into the
 *  job log — first line only, scrubbed, never a frame dump, at most MAX_TAPPED_LOGS. Pass-through: the
 *  console still prints them. */
function tapConsole(job: Job): () => void {
  const c = console as unknown as Record<'log' | 'warn' | 'error', (...args: unknown[]) => void>;
  const orig = { log: c.log, warn: c.warn, error: c.error };
  const levels = { log: 'debug', warn: 'warn', error: 'error' } as const;
  const wrapped = {} as Record<'log' | 'warn' | 'error', (...args: unknown[]) => void>;
  for (const k of ['log', 'warn', 'error'] as const) {
    wrapped[k] = (...args: unknown[]) => {
      try {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[forgefx]') && job.tappedLogs < MAX_TAPPED_LOGS) {
          const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : String(a))).join(' ').split(/\r?\n/, 1)[0] ?? '';
          if (!FRAME_DUMP_RE.test(line)) {
            job.tappedLogs++;
            log(job, levels[k], line);
          }
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

function appVersions(job: Job): { forgefx: string; codec: string; axis?: string } {
  const v = job.opts.versions ?? {};
  const pick = (x: string | undefined) => (x && VERSION_RE.test(x) ? x : undefined);
  const axis = pick(v.axis);
  return { forgefx: pick(v.forgefx) ?? 'unknown', codec: pick(v.codec) ?? (CODEC_VERSION || 'unknown'), ...(axis ? { axis } : {}) };
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

/** A JSON-safe deep copy (a step that still runs after an abort must not change the bundle afterwards). */
function snapshot(v: unknown): unknown {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)) as unknown; } catch { return undefined; }
}

/** End of a run (from the runner's finally): settle step states, build the redacted bundle, publish it as
 *  the last result. Never throws — a fallback bundle is published if building the real one fails. */
function finish(job: Job): void {
  if (job.finished) return;
  const endedAt = new Date(job.now()).toISOString();
  let bundle: CaptureBundle | null = null;
  try {
    for (const s of job.steps) {
      if (s.status === 'running') s.status = 'aborted';
      else if (s.status === 'pending') { s.status = 'skipped'; s.note = `not run: ${job.abortReason ?? 'run ended'}`; }
    }
    const state: CaptureBundle['state'] = job.abortReason === 'cancelled' ? 'cancelled' : job.abortReason ? 'failed' : 'done';
    log(job, 'info', `capture ${job.id} ended: ${state}${job.abortReason ? ` (${job.abortReason})` : ''}`);
    job.finished = true;
    const base: CaptureBundle = {
      schema: 1,
      id: job.id,
      createdAt: job.startedAt,
      endedAt,
      state,
      ...(job.abortReason ? { abortReason: job.abortReason } : {}),
      app: appVersions(job),
      device: { model: job.model, modelName: job.modelName, firmware: job.firmware, transport: job.transportKind },
      steps: job.steps.map((s) => {
        const result = snapshot(s.result);
        return {
          name: s.name, status: s.status,
          ...(s.startedAt ? { startedAt: s.startedAt } : {}),
          ...(s.endedAt ? { endedAt: s.endedAt } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(s.error ? { error: s.error } : {}),
          ...(s.note ? { note: s.note } : {})
        };
      }),
      frames: [],
      logs: job.logs.slice(),
      redaction: { ...job.redaction }
    };
    const rest = JSON.stringify(base).length;
    const max = job.opts.maxBundleJsonBytes ?? MAX_BUNDLE_JSON_BYTES;
    const trimmed = trimFrames(job.frames, job.marks, Math.max(0, max - BUNDLE_JSON_MARGIN - rest));
    bundle = { ...base, frames: trimmed.frames, ...(trimmed.truncated ? { framesTruncated: trimmed.truncated } : {}) };
  } catch (e) {
    job.finished = true;
    bundle = {
      schema: 1, id: job.id, createdAt: job.startedAt, endedAt, state: 'failed',
      abortReason: job.abortReason ?? scrub(`error: ${(e as Error).message}`, job.label, job.identity),
      app: { forgefx: 'unknown', codec: CODEC_VERSION || 'unknown' },
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
