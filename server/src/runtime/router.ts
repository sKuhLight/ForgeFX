// Runtime request router — the browser-facing twin of the Fastify app (app.ts). Axis Browser Direct
// installs `handle()` as its transport: same paths, same JSON shapes, same status codes, same
// capability-gating (501 unsupported), because the NON-TRIVIAL handler bodies are the shared
// runtime/handlers.ts + runtime/localService.ts + services/backups.ts code both surfaces call — only
// thin request-shape glue lives here (mirrored 1:1 from app.ts; the parity suite
// test/api/router.test.ts proves status+body equality over a shared fake registry + store).
//
// Differences by design:
//   • no /events SSE — `subscribe()` replaces it (a browser runtime consumes DeviceEvents directly);
//     PUT /store/config/:id still fans the config event out via the shared putStoreDoc().
//   • no deprecated /am4/* aliases (v2 clients don't call them) → they 404 naturally.
//   • services absent from deps answer their server "disabled" shapes: no `local` → the
//     unconfigured-root responses; no `cloud` → the AXIS_CLOUD=off /cloud/status + /remote/status
//     stubs (the other /cloud/* routes don't exist then — 404, exactly like app.ts); no `telemetry`
//     → the unconfigured telemetryStatus shape and the 503 upload error.
// NO fastify/node:/transport imports here or in anything this pulls in — must bundle for the browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import type { DeviceEvent } from '../drivers/types.js';
import * as backups from '../services/backups.js';
import * as deviceCache from '../services/deviceCache.js';
import * as editorCacheImport from '../services/editorCacheImport.js';
import * as cloudProfiles from '../services/cloudProfiles.js';
import * as diagnostics from '../services/diagnosticCapture.js';
import { blockHelpBySlug, helpIndex } from '../help.js';
import { createUnifiedHandlers, genericFlag } from './handlers.js';
import { sendErrorStatus } from '../drivers/sendPolicy.js';
import { putStoreDoc } from './services.js';
import { createLocalService } from './localService.js';
import type { FolderAdapter } from './folderAdapter.js';
import type { ScanCachePersistence } from './localFolder.js';
import type { Store } from './store.js';
import type { CloudService } from './cloud.js';

export interface RouterResponse {
  status: number;
  contentType: string;
  body: string | Uint8Array;
}

/** The /local/* bindings a runtime supplies (see runtime/localService.ts for each hook's contract).
 *  Node would pass createFsFolderAdapter + node:path checks; a browser passes its directory-handle
 *  adapter (root strings are opaque labels there) and a JS sha256. */
export interface RouterLocalDeps {
  adapterFor(root: string): FolderAdapter;
  isAbsolute(root: string): boolean;
  resolveRoot(root: string): string;
  scanCache: ScanCachePersistence;
  sha256Hex(bytes: Uint8Array): string;
}

/** Diagnostics upload surface (src/telemetry.ts shape). Absent → the "not configured" responses. */
export interface TelemetryService {
  status(): { enabled: boolean; faroUrl: string; key: string; uploadEnabled: boolean };
  report(body: Record<string, unknown>): Promise<{ path: string; bytes: number; stored: number }>;
}

export interface RuntimeDeps {
  registry: DeviceRegistry;
  store: Store;
  local?: RouterLocalDeps;
  cloud?: CloudService;
  telemetry?: TelemetryService;
  /** Version stamps for diagnostic-capture bundles (`app` in the bundle): the ForgeFX build this runtime
   *  bundles, the codec and the hosting Axis, where the host knows them (each `[0-9A-Za-z.+-]{1,32}`). */
  versions?: { forgefx?: string; codec?: string; axis?: string };
}

// ── request plumbing ──
/** Per-request status recorder — the StatusSink the shared handlers code() into. */
class Reply {
  statusCode = 200;
  code(n: number): this { this.statusCode = n; return this; }
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body ({} for empty, like app.ts's tolerant parser). */
  body: unknown;
  /** Raw bytes for the octet-stream routes (body arrived as Uint8Array). */
  raw: Uint8Array | null;
  reply: Reply;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; segs: string[]; octet: boolean; handler: Handler }

const JSON_TYPE = 'application/json; charset=utf-8';
const OCTET_TYPE = 'application/octet-stream';
/** Reason phrases for the error envelope (Fastify uses node:http's table, which the browser runtime cannot import). */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

export function createRouter(deps: RuntimeDeps): {
  handle(method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse>;
  subscribe(fn: (e: DeviceEvent) => void): () => void;
} {
  const { registry, store } = deps;
  const h = createUnifiedHandlers(registry);
  const { driver, unsupported } = h;

  // /local/* — the shared route service over the runtime's folder bindings. Without `local` deps the
  // config/gate methods still answer, backed by a stub adapter whose root never exists — exactly the
  // server's unconfigured-root behavior (configured:false, 409 gates), and PUT with a path fails its
  // absolute-root check.
  const local = createLocalService({
    adapterFor: deps.local?.adapterFor ?? (() => UNAVAILABLE_ADAPTER),
    isAbsolute: deps.local?.isAbsolute ?? (() => false),
    resolveRoot: deps.local?.resolveRoot ?? ((r) => r),
    scanCache: deps.local?.scanCache ?? { load: () => ({}), save: () => {} },
    sha256Hex: deps.local?.sha256Hex ?? (() => ''),
    store,
    decode: h.decodeBytes
  });

  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler, opts?: { octet?: boolean }) =>
    routes.push({ method, segs: path.split('/').filter(Boolean), octet: !!opts?.octet, handler });

  // ── system ──
  // /healthz carries the unified-API version handshake (mirrored as apiVersion on /device).
  on('GET', '/healthz', async () => {
    const hz = await registry.health();
    return { ok: hz.ok, api: { version: 2 }, device: hz.device };
  });
  // full connection diagnostic; the router has no deprecated aliases, so the hit counters stay empty
  on('GET', '/diag', async () => ({ ...(await registry.diagnostics()), deprecatedAliasHits: {} }));
  on('GET', '/device', () => registry.deviceInfo());
  on('GET', '/ports', () => registry.connections()); // serial + MIDI connections (Fractal flagged) + chosen + override
  on('POST', '/ports/select', (c) => {
    const b = (c.body ?? {}) as { transport?: 'serial' | 'midi'; id?: string | null; inId?: string | null; outId?: string | null; model?: string | null };
    const model = b.model; // undefined = leave the profile override as-is; 'auto'/'' = clear it; else force it
    // MIDI (Axe-Fx III / FM9, or an FM3 via a MIDI→USB adapter): separate input + output endpoints
    if (b?.transport === 'midi' && b.inId && b.outId) return registry.selectConnection({ transport: 'midi', id: b.id || b.inId, inId: b.inId, outId: b.outId }, model);
    if (b?.id) return registry.selectConnection({ transport: b.transport === 'midi' ? 'midi' : 'serial', id: b.id }, model);
    return registry.selectConnection(null, model); // clear the port back to auto (a forced profile can remain via `model`)
  });
  // auto-detect the connected Fractal unit (FM3/FM9/Axe-Fx/…) via the fn 0x00 handshake
  on('GET', '/device/detect', () => registry.detect());

  // ── device cache (on-connect self-describe build; capability selfDescribe) ──
  on('GET', '/device/cache', () => deviceCache.cacheStatus(store, registry));
  on('POST', '/device/cache/build', async (c) => {
    const body = c.body as { force?: boolean; mode?: 'read-only' | 'full' } | undefined;
    const r = await deviceCache.startCacheBuild(store, registry, { force: !!body?.force, mode: body?.mode });
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/device/cache/cancel', () => deviceCache.cancelCacheBuild(registry));
  on('DELETE', '/device/cache', () => deviceCache.deleteCache(store, registry));
  // ── editor-cache import (SECOND cache source; capability cacheImport). Disk discovery is Node-only,
  //    so the browser twin returns an empty candidate list (discovery:'unavailable') + octet-only import. ──
  on('GET', '/device/cache/sources', async () => {
    const persisted = await editorCacheImport.isPersisted(store, registry);
    return { persisted, candidates: [], discovery: 'unavailable' };
  });
  on('POST', '/device/cache/import', async (c) => {
    if (!c.raw || !c.raw.length) { c.reply.code(400); return { error: 'POST the .cache bytes as application/octet-stream with ?name=<filename>' }; }
    const name = c.query.get('name');
    if (!name) { c.reply.code(400); return { error: 'missing ?name=<filename>' }; }
    const force = c.query.get('force') === '1' || c.query.get('force') === 'true';
    const r = await editorCacheImport.importEditorCache(registry, store, c.raw, { name, force });
    c.reply.code(r.code);
    return r.body;
  }, { octet: true });
  // ── shared device-definition profiles (THIRD cache source; services/cloudProfiles.ts). deps.cloud is
  //    optional — absent (no cloud in this runtime) degrades to the same non-erroring disabled shape. ──
  on('GET', '/device/cache/cloud', () => cloudProfiles.cloudCacheCheck(deps.cloud ?? null, store, registry));
  on('POST', '/device/cache/cloud/pull', async (c) => {
    const r = await cloudProfiles.cloudCachePull(deps.cloud ?? null, store, registry);
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/device/cache/cloud/publish', async (c) => {
    const r = await cloudProfiles.cloudCachePublish(deps.cloud ?? null, store, registry);
    c.reply.code(r.code);
    return r.body;
  });
  // ── diagnostic capture (capability diagnosticCapture; shared service, see services/diagnosticCapture.ts).
  //    No cloud dep → the upload answers the server's 503 cloud-disabled. ──
  const captureOpts: diagnostics.CaptureOptions = deps.versions ? { versions: deps.versions } : {};
  on('GET', '/diagnostics/capture', () => diagnostics.captureStatus(registry));
  on('POST', '/diagnostics/capture', async (c) => {
    const r = await diagnostics.startCapture(store, registry, c.body, captureOpts);
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/diagnostics/capture/cancel', () => diagnostics.cancelCapture(registry));
  on('GET', '/diagnostics/capture/preflight', async (c) => {
    const r = await diagnostics.capturePreflight(registry);
    c.reply.code(r.code);
    return r.body;
  });
  on('GET', '/diagnostics/capture/result', (c) => {
    const r = diagnostics.captureResult(registry);
    c.reply.code(r.code);
    return r.body;
  });
  on('POST', '/diagnostics/capture/upload', async (c) => {
    const r = await diagnostics.uploadCapture(registry, deps.cloud ?? null, c.body);
    c.reply.code(r.code);
    return r.body;
  });
  // cab IR names per bank (Factory 1/2, Legacy, Scratchpad) — refresh lets a driver merge live per-device banks.
  on('GET', '/cab/irs', async (c) => {
    if (c.query.get('refresh') === '1') {
      const d = await driver();
      if (d.cabIrs) return d.cabIrs(true);
    }
    return registry.profile.cabIrs();
  });

  // ── block & parameter help (curated tooltips; see help.ts) ──
  on('GET', '/help', () => helpIndex(registry.profile));
  on('GET', '/help/blocks/:slug', (c) => {
    const dto = blockHelpBySlug(registry.profile, c.params.slug!);
    if (!dto) { c.reply.code(404); return { error: `no help for block "${c.params.slug}"` }; }
    return dto;
  });

  // ── preset ──
  on('GET', '/preset', async (c) => {
    const d = await driver();
    if (!d.presetRef) return unsupported(c.reply, 'presetRef');
    return d.presetRef();
  });
  // Stored preset name (driver-backed since Phase 6; gen-3 keeps the {number, name:''} stub).
  on('GET', '/presets/:n', (c) => h.presetNameH(Number(c.params.n)));
  // Decode any preset by number (non-disruptive) → library summary: name, scenes, unique blocks.
  on('GET', '/presets/:n/summary', (c) => h.presetSummaryH(c.reply, c.params.n ?? '', c.query.get('full') === '1'));
  // Full per-block decoded params for one preset (every family/param) — deep-search + browser detail.
  on('GET', '/presets/:n/params', (c) => h.presetParamsH(c.reply, c.params.n ?? ''));
  // Grid of the STORED slot `:n` (never the edit buffer — that is /preset/grid); see presetGridH.
  on('GET', '/presets/:n/grid', (c) => h.presetGridH(c.reply, c.params.n ?? ''));
  on('GET', '/preset/grid', (c) => h.gridH(c.reply));
  on('GET', '/preset/blocks', (c) => h.blocksH(c.reply));
  on('GET', '/preset/scene-state', (c) => h.sceneStateH(c.reply));
  on('POST', '/preset/select', (c) => h.presetSelectH(c.reply, (c.body as { number: number }).number));
  on('POST', '/preset/store', (c) => h.presetStoreH(c.reply, (c.body as { number?: number } | undefined)?.number));
  // AM4 preset library scan → every stored location. Capability presets.canScanNames.
  on('GET', '/preset/locations', (c) => h.locationsH(c.reply));
  // Verbatim .syx dump of one preset (location omitted → active buffer). Capability backupDump.
  on('POST', '/preset/backup', (c) => h.backupH(c.reply, (c.body as { location?: number } | undefined)?.location));
  // Verbatim re-emit of a preset dump to its stored location. Capability restoreDump.
  on('POST', '/preset/restore', (c) => h.restoreH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes));
  // Rename the working-buffer preset. Visible immediately; persist is a separate store.
  on('POST', '/preset/name', async (c) => {
    const d = await driver();
    if (!d.setPresetName) return unsupported(c.reply, 'setPresetName');
    return d.setPresetName((c.body as { name: string }).name);
  });

  // Decode an uploaded preset .syx → library summary. Offline (decode touches no transport).
  // Bodies: raw bytes (Uint8Array — the octet-stream shape) OR JSON {bytes:number[]}.
  // Model-byte-dispatched — an AM4 dump decodes via the AM4 offline decoder (see handlers.decodeH).
  on('POST', '/preset/decode', async (c) => {
    if (c.raw) {
      if (!c.raw.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
      return h.decodeH(c.reply, c.raw);
    }
    const b = c.body as { bytes?: number[] } | undefined;
    const bytes = b && Array.isArray(b.bytes) ? b.bytes : null;
    if (!bytes || !bytes.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream, or JSON {bytes:number[]}' }; }
    return h.decodeH(c.reply, Uint8Array.from(bytes));
  }, { octet: true });
  // load a .syx preset dump (e.g. a cloud/file preset) into the edit buffer — the driver validates it
  // as ONE preset dump for the connected model (400 otherwise, see drivers/sendPolicy.ts)
  on('POST', '/preset/load', async (c) => {
    if (!c.raw || !c.raw.length) { c.reply.code(400); return { error: 'POST raw .syx bytes as application/octet-stream' }; }
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(c.reply, 'loadPresetBytes');
      return await d.loadPresetBytes(c.raw);
    } catch (e) { c.reply.code(sendErrorStatus(e, 503)); return { error: (e as Error).message }; }
  }, { octet: true });

  // ── catalog ──
  on('GET', '/blocks', async (c) => {
    const d = await driver();
    if (!d.blocksCatalog) return unsupported(c.reply, 'blocksCatalog');
    return d.blocksCatalog();
  });
  on('GET', '/blocks/:slug/types', async (c) => {
    const d = await driver();
    if (!d.blockTypes) return unsupported(c.reply, 'blockTypes');
    return d.blockTypes(c.params.slug!);
  });

  // ── live block params (addressed by the placed block's canonical address `addr`) ──
  on('GET', '/preset/blocks/:eid/params', (c) => h.blockParamsH(c.reply, Number(c.params.eid), { generic: genericFlag(c.query.getAll('generic')) }));
  on('PUT', '/preset/blocks/:eid/params/:paramId', (c) => {
    const b = c.body as { value: number; continuous?: boolean };
    return h.setParamH(c.reply, Number(c.params.eid), Number(c.params.paramId), b.value, b.continuous ?? true);
  });
  on('POST', '/preset/blocks/:eid/bypass', (c) => h.bypassH(c.reply, Number(c.params.eid), (c.body as { bypassed: boolean }).bypassed));
  on('POST', '/preset/blocks/:eid/channel', async (c) => {
    const d = await driver();
    if (!d.setChannel) return unsupported(c.reply, 'channels');
    return d.setChannel(Number(c.params.eid), (c.body as { channel: string }).channel);
  });
  on('POST', '/preset/blocks/:eid/type', async (c) => {
    const d = await driver();
    if (!d.setType) return unsupported(c.reply, 'setType');
    return d.setType(Number(c.params.eid), (c.body as { value: number }).value);
  });
  // raw param values for an effect (for FC eid 199 / Modifier eid 3, whose params have no display range)
  on('GET', '/preset/blocks/:eid/raw', async (c) => {
    try {
      const d = await driver();
      if (!d.rawBlock) return unsupported(c.reply, 'rawBlock');
      return await d.rawBlock(Number(c.params.eid));
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // read specific paramIds via per-pid fn 0x01 GET (FC current state — the 0x1F bulk path doesn't cover FC)
  on('POST', '/preset/blocks/:eid/read', async (c) => {
    try {
      const d = await driver();
      if (!d.readParams) return unsupported(c.reply, 'readParams');
      return await d.readParams(Number(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids ?? []);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // FC read path: sub 0x1a range-read returning the normalized (0..1) value per pid
  on('POST', '/preset/blocks/:eid/readrange', async (c) => {
    try {
      const d = await driver();
      if (!d.readRange) return unsupported(c.reply, 'readRange');
      return await d.readRange(Number(c.params.eid), (c.body as { pids?: number[] } | undefined)?.pids ?? []);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // current state of a cab block (mode / per-slot bank + IR + dyna type) for the picker
  on('GET', '/preset/blocks/:eid/cab', async (c) => {
    const d = await driver();
    if (!d.cabState) return unsupported(c.reply, 'cabState');
    return d.cabState(Number(c.params.eid));
  });

  // per-block meter + swipe-control values for the always-on grid level fill
  on('POST', '/preset/meters', async (c) => {
    try {
      const d = await driver();
      if (!d.meters) return unsupported(c.reply, 'meters');
      return await d.meters((c.body as { wants?: Record<string, number[]> } | undefined)?.wants ?? {});
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── grid editing (1-indexed row/col, matching FM-Edit) ──
  on('PUT', '/preset/grid/cell', async (c) => {
    const d = await driver();
    if (!d.placeCell) return unsupported(c.reply, 'gridEdit');
    const b = c.body as { row: number; col: number; blockId: number };
    return d.placeCell(b.row, b.col, b.blockId);
  });
  on('POST', '/preset/grid/cable', async (c) => {
    const d = await driver();
    if (!d.cable) return unsupported(c.reply, 'gridEdit');
    const b = c.body as { srcRow: number; srcCol: number; destRow: number; connect?: boolean };
    return d.cable(b.srcRow, b.srcCol, b.destRow, b.connect ?? true);
  });
  on('POST', '/preset/grid/select', async (c) => {
    const d = await driver();
    if (!d.selectCell) return unsupported(c.reply, 'gridEdit');
    const b = c.body as { row: number; col: number };
    return d.selectCell(b.row, b.col);
  });

  // ── telemetry cadence-mode control (GET/PUT /telemetry/config) ──
  on('GET', '/telemetry/config', () => h.telemetryConfigH());
  on('PUT', '/telemetry/config', (c) => h.telemetrySetH(c.reply, (c.body as { mode?: string } | undefined)?.mode));

  // ── telemetry: tuner · tempo · scene ──
  on('POST', '/tuner', (c) => registry.setTuner(!!(c.body as { on?: boolean } | undefined)?.on));
  on('GET', '/tempo', async (c) => {
    const d = await driver();
    if (!d.getTempo) return unsupported(c.reply, 'getTempo');
    return d.getTempo();
  });
  on('POST', '/tempo', async (c) => {
    const d = await driver();
    if (!d.setTempo) return unsupported(c.reply, 'setTempo');
    return d.setTempo((c.body as { bpm: number }).bpm);
  });
  on('POST', '/tempo/tap', async (c) => {
    const d = await driver();
    if (!d.tapTempo) return unsupported(c.reply, 'tapTempo');
    return d.tapTempo();
  });
  on('GET', '/scene', async (c) => {
    const d = await driver();
    if (!d.getScene) return unsupported(c.reply, 'scenes');
    return d.getScene();
  });
  on('POST', '/scene', (c) => h.sceneSetH(c.reply, (c.body as { index: number }).index));
  // Rename a scene (0-based index) in the working buffer. Visible immediately; persist is a separate store.
  on('POST', '/scene/name', async (c) => {
    const d = await driver();
    if (!d.setSceneName) return unsupported(c.reply, 'scenes');
    const b = c.body as { index: number; name: string };
    return d.setSceneName(b.index, b.name);
  });

  // ── FC / Modifier / monitors ──
  on('GET', '/fc/model', () => registry.profile.fcModel ?? null);
  // Modifier address model — unified superset DTO (always carries `bindingSupported`).
  on('GET', '/mod/model', () => h.modModelH());
  // Per-block monitor (meter) param table — read-only pids Axis renders meters from. {} if none.
  on('GET', '/preset/monitors', () => registry.profile.monitorParams ?? {});
  // Live per-block audio meters: reads each placed monitored block's level (normalized 0..1) + dB.
  on('GET', '/preset/monitors/live', async (c) => {
    const q = c.query.get('eid') ?? undefined;
    const eid = q != null && q !== '' ? Number(q) : undefined;
    try {
      const d = await driver();
      if (!d.liveMonitors) return unsupported(c.reply, 'liveMonitors');
      return await d.liveMonitors(Number.isFinite(eid as number) ? eid : undefined);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  on('GET', '/preset/looper', async (c) => {
    const q = c.query.get('eid') ?? undefined;
    const eid = q != null && q !== '' ? Number(q) : NaN;
    try {
      const d = await driver();
      if (!d.looperTelemetry) return unsupported(c.reply, 'looperTelemetry');
      if (!Number.isFinite(eid)) { c.reply.code(400); return { error: 'eid required' }; }
      return await d.looperTelemetry(eid);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  on('POST', '/preset/looper/control', async (c) => {
    const { eid, action, on: onv } = (c.body ?? {}) as { eid?: number; action?: string; on?: boolean };
    try {
      const d = await driver();
      if (!d.looperControl) return unsupported(c.reply, 'looperControl');
      if (!Number.isFinite(eid as number) || !action) { c.reply.code(400); return { error: 'eid + action required' }; }
      return await d.looperControl(eid as number, action, onv !== false);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // FC current switch state via the sub-0x01 structured config-selector read (see app.ts).
  on('GET', '/fc/state', async (c) => {
    const layout = Number(c.query.get('layout') ?? 0);
    const view = Number(c.query.get('view') ?? 0);
    const sw = Number(c.query.get('switch') ?? 0);
    try {
      const d = await driver();
      if (!d.fcReadState) return unsupported(c.reply, 'fcLiveRead');
      return await d.fcReadState(layout, view, sw);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // bind a modifier slot to a target parameter (writes targetEffectId + targetParam + source on the slot eid)
  on('POST', '/mod/bind', async (c) => {
    const b = c.body as { slot?: number; targetEffectId?: number; targetParam?: number; source?: number } | undefined;
    if (b?.slot == null || b.targetEffectId == null || b.targetParam == null || b.source == null) {
      c.reply.code(400);
      return { ok: false, error: 'slot, targetEffectId, targetParam, source required' };
    }
    try {
      const d = await driver();
      if (!d.bindModifier) return unsupported(c.reply, 'modifiers.bind');
      return await d.bindModifier(b.slot, b.targetEffectId, b.targetParam, b.source);
    } catch (e) { c.reply.code(503); return { ok: false, error: (e as Error).message }; }
  });

  // Validate a firmware .syx (integrity check only, NOT a flasher). Capability firmwareValidate.
  on('POST', '/firmware/validate', (c) => h.fwValidateH(c.reply, (c.body as { bytes?: number[] } | undefined)?.bytes));
  // Device/global param write by catalog key (e.g. the AM4's 'amp.gain'). Capability deviceParams.
  on('PUT', '/device/param', (c) => {
    const b = c.body as { key?: string; value?: number } | undefined;
    return h.deviceParamH(c.reply, b?.key, b?.value);
  });

  // ── persistent store: documents (Axis config · library metadata · layouts) ──
  on('GET', '/store/:c', (c) => ({ docs: store.listDocs(c.params.c!) }));
  on('GET', '/store/:c/:id', (c) => {
    const d = store.getDoc(c.params.c!, c.params.id!);
    if (!d) { c.reply.code(404); return { error: 'not found' }; }
    return d;
  });
  // Config writes fan out to every live UI (router subscribers, like the host's SSE) — shared putStoreDoc.
  on('PUT', '/store/:c/:id', (c) => {
    const b = c.body as { data?: unknown; origin?: string } | undefined;
    return putStoreDoc(store, registry, c.params.c!, c.params.id!, b?.data, b?.origin);
  });
  on('DELETE', '/store/:c/:id', (c) => { store.delDoc(c.params.c!, c.params.id!); return { ok: true }; });

  // ── local storage folder (Presets/ library + Sync/ mirror; shared service — see localService.ts) ──
  on('GET', '/local/config', async (c) => send(c, await local.config()));
  on('PUT', '/local/config', async (c) => send(c, await local.setConfig((c.body as { root?: string | null } | undefined)?.root)));
  on('GET', '/local/presets', async (c) => send(c, await local.presets(c.query.get('refresh') === '1')));
  on('GET', '/local/presets/file', async (c) => send(c, await local.presetFile(c.query.get('path') ?? undefined)));
  on('POST', '/local/presets', async (c) => send(c, await local.writePreset(c.body as Parameters<typeof local.writePreset>[0])));
  on('POST', '/local/sync', async (c) => send(c, await local.sync()));
  on('POST', '/local/restore', async (c) => send(c, await local.restore()));

  // ── backups + version control ──
  // snapshot one preset (version control)
  on('POST', '/backup/preset/:n', async (c) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(c.reply, 'presetDump');
      const v = await backups.backupPreset(store, d, Number(c.params.n));
      if (!v) { c.reply.code(422); return { error: 'empty/invalid preset' }; }
      return { version: v };
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  // full-device backup (long-running): body { label, from?, to? }
  on('POST', '/backup/device', async (c) => {
    try {
      const d = await driver();
      if (!d.dumpRaw) return unsupported(c.reply, 'presetDump');
      const b = c.body as { label?: string; from?: number; to?: number } | undefined;
      return await backups.backupDevice(store, d, b?.label ?? 'Device backup', b?.from ?? 0, b?.to ?? 511);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });
  on('GET', '/backups', () => ({ backups: store.listBackups() }));
  // load a stored version into the EDIT BUFFER (play it without occupying a slot)
  on('POST', '/version/:id/load', async (c) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes) return unsupported(c.reply, 'loadPresetBytes');
      return await backups.loadVersion(store, d, c.params.id!);
    } catch (e) { c.reply.code(sendErrorStatus(e, 503)); return { error: (e as Error).message }; }
  });
  // restore a snapshot to its origin slot (load + commit to that slot — destructive for the slot)
  on('POST', '/version/:id/restore', async (c) => {
    try {
      const d = await driver();
      if (!d.loadPresetBytes || !d.store) return unsupported(c.reply, 'loadPresetBytes');
      return await backups.restoreVersion(store, d, c.params.id!);
    } catch (e) { c.reply.code(sendErrorStatus(e, 503)); return { error: (e as Error).message }; }
  });
  // version history (all, or for one slot via ?location=)
  on('GET', '/versions', (c) => {
    const loc = c.query.get('location');
    return { versions: store.listPresetVersions(loc != null ? Number(loc) : undefined) };
  });
  // download a stored snapshot's raw .syx
  on('GET', '/version/:id/syx', (c) => {
    const bytes = store.getPresetVersionBytes(c.params.id!);
    if (!bytes) { c.reply.code(404); return { error: 'not found' }; }
    return bytes; // Uint8Array → application/octet-stream
  });

  // ── cloud sync + remote + telemetry ── absent services answer the server's "disabled" stubs; the
  // gated /cloud/* routes only exist when a cloud service is supplied (parity with AXIS_CLOUD=1).
  if (deps.cloud) {
    const cloud = deps.cloud;
    type Creds = { email: string; password: string };
    on('GET', '/cloud/status', () => cloud.status());
    on('POST', '/cloud/register', async (c) => { const b = c.body as Creds; try { return await cloud.register(b.email, b.password); } catch (e) { c.reply.code(400); return { error: (e as Error).message }; } });
    on('POST', '/cloud/login', async (c) => { const b = c.body as Creds; try { return await cloud.login(b.email, b.password); } catch (e) { c.reply.code(401); return { error: (e as Error).message }; } });
    on('POST', '/cloud/logout', () => cloud.logout());
    on('POST', '/cloud/delete-account', async (c) => { try { return await cloud.deleteAccount(); } catch (e) { c.reply.code(500); return { error: (e as Error).message }; } });
    on('POST', '/cloud/sync', async (c) => { try { return await cloud.sync((c.body as { scopes?: { config?: boolean; presets?: boolean } } | undefined)?.scopes); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    on('GET', '/cloud/index', async (c) => { try { return await cloud.cloudIndex(); } catch (e) { c.reply.code(503); return { error: (e as Error).message }; } });
    // The Realtime remote HOST agent is a Node/Fastify concern (remote.ts) — a browser runtime IS the
    // UI, so it never hosts. Status mirrors the host's "off" answer; enabling is not available.
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
    on('POST', '/remote/enable', (c) => { c.reply.code(503); return { error: 'remote host not available in this runtime' }; });
  } else {
    on('GET', '/cloud/status', () => ({ enabled: false, user: null })); // so Axis can gate its UI without erroring
    on('GET', '/remote/status', () => ({ enabled: false, connected: false, userId: null }));
  }

  // status is always served (so Axis gates its UI without erroring); the report upload works whenever
  // a telemetry service is supplied — absent, it fails with the server's "not configured" 503.
  on('GET', '/telemetry/status', () => deps.telemetry?.status() ?? { enabled: false, faroUrl: '', key: '', uploadEnabled: false });
  on('POST', '/telemetry/report', async (c) => {
    try {
      if (!deps.telemetry) throw new Error('cloud storage not configured (SUPABASE_URL / SUPABASE_ANON_KEY unset)');
      return await deps.telemetry.report((c.body ?? {}) as Record<string, unknown>);
    } catch (e) { c.reply.code(503); return { error: (e as Error).message }; }
  });

  // ── dispatch ──
  const match = (route: Route, segs: string[]): Record<string, string> | null => {
    if (route.segs.length !== segs.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < segs.length; i++) {
      const pat = route.segs[i]!;
      if (pat.startsWith(':')) params[pat.slice(1)] = decodeURIComponent(segs[i]!);
      else if (pat !== segs[i]) return null;
    }
    return params;
  };

  const respond = (status: number, body: unknown): RouterResponse =>
    body instanceof Uint8Array
      ? { status, contentType: OCTET_TYPE, body }
      : { status, contentType: JSON_TYPE, body: JSON.stringify(body) };

  const handle = async (method: string, path: string, body?: string | Uint8Array): Promise<RouterResponse> => {
    const m = method.toUpperCase();
    const qi = path.indexOf('?');
    const pathname = qi >= 0 ? path.slice(0, qi) : path;
    const query = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    const segs = pathname.split('/').filter(Boolean);

    for (const route of routes) {
      if (route.method !== m) continue;
      const params = match(route, segs);
      if (!params) continue;

      // Body decode mirrors app.ts's parsers: Uint8Array = application/octet-stream on the raw-bytes
      // routes; everything else is JSON (empty/absent → {}, like the tolerant empty-JSON parser).
      let raw: Uint8Array | null = null;
      let json: unknown = {};
      if (body instanceof Uint8Array && route.octet) raw = body;
      else if (body != null) {
        const s = typeof body === 'string' ? body : new TextDecoder().decode(body);
        if (s.length) {
          try { json = JSON.parse(s); }
          catch { return respond(400, { statusCode: 400, error: 'Bad Request', message: 'Body is not valid JSON' }); }
        }
      }

      const ctx: Ctx = { params, query, body: json, raw, reply: new Reply() };
      try {
        const out = await route.handler(ctx);
        return respond(ctx.reply.statusCode, out);
      } catch (e) {
        // uncaught handler error → Fastify's default error envelope: a thrown error carrying a 4xx/5xx
        // `statusCode` (a driver's 400 "no such instance" / 409 "already placed") keeps it, anything else is a 500
        const code = (e as { statusCode?: unknown }).statusCode;
        const status = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
        return respond(status, { statusCode: status, error: STATUS_TEXT[status] ?? (status >= 500 ? 'Internal Server Error' : 'Bad Request'), message: (e as Error).message });
      }
    }
    // Fastify's default not-found body, verbatim
    return respond(404, { message: `Route ${m}:${pathname} not found`, error: 'Not Found', statusCode: 404 });
  };

  return { handle, subscribe: (fn) => registry.subscribe(fn) };
}

/** Local-folder responses map onto the reply exactly like localStore.ts's `send` (bytes stay bytes). */
function send(c: Ctx, r: { status: number; body: unknown }): unknown {
  c.reply.code(r.status);
  return r.body;
}

/** Stub adapter behind the no-`local`-deps case: nothing exists, nothing is writable — every gated
 *  route answers exactly like the server with no root configured. */
const UNAVAILABLE_ADAPTER: FolderAdapter = {
  key: (rel) => rel,
  list: async () => { throw new Error('local folder unavailable'); },
  exists: async () => false,
  readFile: async () => { throw new Error('local folder unavailable'); },
  writeFile: async () => { throw new Error('local folder unavailable'); },
  mkdir: async () => { throw new Error('local folder unavailable'); },
  remove: async () => { throw new Error('local folder unavailable'); }
};
