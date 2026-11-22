// Step-2 router parity — the browser-facing runtime router (runtime/router.ts) must answer every
// covered endpoint with the SAME status + content-type class + body as the Fastify app (app.ts),
// because both dispatch into the shared handler/service code. Builds the REAL buildApp AND a router
// over the SAME isolated registry (mocked fn 0x00 handshake, hand-built fake FM3 driver) and the SAME
// default store (FORGEFX_DATA_DIR is a throwaway — helpers/env.ts); every matrix row injects the app,
// dispatches the router, and deep-compares the pair. Also covers: capability-gated 501, unknown-route
// 404 (Fastify's default envelope), octet-stream byte responses (version .syx, local file), the
// /local/* service over a real temp root, disabled-state cloud/remote/telemetry stubs, and the
// subscribe() config fan-out that replaces SSE.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { createRouter, type RouterResponse } from '../../src/runtime/router.js';
import { createFsFolderAdapter } from '../../src/runtime/fsFolderAdapter.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import type { ScanCache } from '../../src/runtime/localFolder.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import * as store from '../../src/store.js';
import * as diagnostics from '../../src/services/diagnosticCapture.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

// deterministic gen-3-style .syx: frame[4] = 0x11 (FM3) → decode dispatches to the driver's decoder
const presetSyx = (tag: number) => Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x11, 0x77, tag, 0x01, 0xf7]);

const CAPS: DriverCapabilities = {
  slotModel: 'grid',
  grid: { rows: 4, cols: 12 },
  gridEdit: true,
  scenes: 8,
  channels: true,
  presetDump: true,
  blockParamDecode: true,
  telemetry: { tuner: false, outputMeters: false, cpu: false }, // no polls in tests
  fcModel: true,
  fcLiveRead: false,
  modBind: true,
  cabIrs: true,
  supportsSave: true,
  selfDescribe: false, // fake driver: keeps POST /device/cache/build on the 501 gated path
  cacheImport: false,
  fullCapture: false // no self-describe → no full-mode write-sweep
};

/** Deterministic fake FM3 driver — a rich (but not full) optional-method surface so the matrix hits
 *  both implemented routes AND the capability-gated 501 path (no scanPresets / validateFirmware). */
function makeFakeFm3(): DeviceDriver {
  const summary = (n: number) =>
    ({ number: n, name: `P${n}`, model: 'FM3', crcValid: true, crc: 0x1234 + n, scenes: [], blocks: [], models: {}, amps: [] }) as never;
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: CAPS,
    grid: async () => ({
      model: 'fm3', name: 'PARITY', crcValid: true, rows: 4, cols: 12, scenes: ['S1'],
      cells: [{ row: 0, col: 0, effectId: 58, name: 'Amp 1', isShunt: false, routeFlag: 0, fromRows: [] }],
      source: 'dump' as const
    }),
    placedBlocks: async () => [
      { slug: 'amp', name: 'Amp 1', effectId: 58, row: 1, col: 1, fromRows: [], bypassed: false, channel: 'A' }
    ],
    presetRef: async () => ({ number: 3, name: 'Current' }),
    presetCount: 512,
    presetGrid: async (n: number) => ({
      model: 'fm3', name: `SLOT-${n}`, crcValid: true, rows: 4, cols: 12, scenes: [],
      cells: [{ row: 0, col: 0, effectId: 100 + n, name: `Block ${n}`, isShunt: false, routeFlag: 0, fromRows: [] }],
      source: 'dump' as const
    }),
    blocksCatalog: () => [{ slug: 'amp', family: 'AMP', instance: 1, name: 'Amp 1', page: 0, paramCount: 2, typeCount: 1 }],
    blockTypes: () => [{ value: 1, name: 'USA Lead', manufacturer: null, basedOn: null }],
    // `opts.generic` (the `?generic=1` query) answers the generic shape: recognisable by its `definitions` block
    blockParams: async (_eid: number, opts?: { generic?: boolean }) => ({
      block: 'Amp 1', slug: 'amp', page: 0,
      named: [{ id: 1, name: 'Gain', value: 5, norm: 0.5, min: 0, max: 10 }],
      enums: [], type: { value: 1, name: 'USA Lead' },
      ...(opts?.generic ? { definitions: { family: 'DISTORT', profile: 'none', positional: true, channel: 0, persistentWrites: false, hidden: [] } } : {})
    }),
    setParam: async () => ({ ok: true }),
    setBypass: async () => ({ ok: true }),
    setChannel: async () => ({ ok: true }),
    setType: async () => ({ ok: true }),
    selectCell: async () => ({ ok: true }),
    getScene: async () => ({ index: 1 }),
    setScene: async () => ({ ok: true }),
    getTempo: async () => ({ bpm: 120 }),
    setTempo: async () => ({ ok: true }),
    tapTempo: async () => ({ ok: true }),
    selectPreset: async () => ({ ok: true }),
    store: async () => ({ ok: true }),
    setPresetName: async () => ({ ok: true }),
    modifierModel: () => ({ bindingSupported: true, slotCount: 16 }),
    dumpRaw: async (n: number) => ({ bytes: presetSyx(n), summary: summary(n) }),
    loadPresetBytes: async () => ({ ok: true }),
    decodePresetBytes: (bytes: Uint8Array) => {
      if (bytes[0] !== 0xf0 || bytes.length < 8) throw new Error('not a preset');
      return summary(bytes[6]!);
    }
  } as DeviceDriver;
}

interface Row {
  name: string; method: string; url: string; body?: unknown; octet?: boolean;
  /** Block-params rows: whether the driver must have been asked for the generic response. */
  generic?: boolean;
}

// Representative endpoint matrix (2e): device info/detect, grid, blocks + catalog, blockParams,
// setParam, bypass, channel, scene get/set, tempo, preset select/store, decode, versions/backups,
// store docs, help, local, disabled cloud/remote/telemetry, gated 501s and the 404 envelope.
const ROWS: Row[] = [
  { name: 'healthz', method: 'GET', url: '/healthz' },
  { name: 'device info', method: 'GET', url: '/device' },
  { name: 'device detect', method: 'GET', url: '/device/detect' },
  { name: 'ports', method: 'GET', url: '/ports' },
  { name: 'preset ref', method: 'GET', url: '/preset' },
  { name: 'grid', method: 'GET', url: '/preset/grid' },
  { name: 'grid by number', method: 'GET', url: '/presets/7/grid' },
  { name: 'grid by number (other slot)', method: 'GET', url: '/presets/8/grid' },
  { name: 'grid by number (400 malformed)', method: 'GET', url: '/presets/abc/grid' },
  { name: 'grid by number (400 out of range)', method: 'GET', url: '/presets/512/grid' },
  { name: 'blocks placed', method: 'GET', url: '/preset/blocks' },
  { name: 'blocks catalog', method: 'GET', url: '/blocks' },
  { name: 'block types', method: 'GET', url: '/blocks/amp/types' },
  { name: 'block params', method: 'GET', url: '/preset/blocks/58/params', generic: false },
  { name: 'block params generic', method: 'GET', url: '/preset/blocks/58/params?generic=1', generic: true },
  { name: 'block params generic=0 (classic)', method: 'GET', url: '/preset/blocks/58/params?generic=0', generic: false },
  // a repeated key: the FIRST value decides on both surfaces (Fastify parses it to an array, the router reads URLSearchParams)
  { name: 'block params generic=1&generic=0 (first value: generic)', method: 'GET', url: '/preset/blocks/58/params?generic=1&generic=0', generic: true },
  { name: 'block params generic=0&generic=1 (first value: classic)', method: 'GET', url: '/preset/blocks/58/params?generic=0&generic=1', generic: false },
  { name: 'set param', method: 'PUT', url: '/preset/blocks/58/params/7', body: { value: 0.42, continuous: true } },
  { name: 'bypass', method: 'POST', url: '/preset/blocks/58/bypass', body: { bypassed: true } },
  { name: 'channel', method: 'POST', url: '/preset/blocks/58/channel', body: { channel: 'B' } },
  { name: 'grid select', method: 'POST', url: '/preset/grid/select', body: { row: 1, col: 2 } },
  { name: 'scene get', method: 'GET', url: '/scene' },
  { name: 'scene set', method: 'POST', url: '/scene', body: { index: 2 } },
  { name: 'tempo get', method: 'GET', url: '/tempo' },
  { name: 'tempo set', method: 'POST', url: '/tempo', body: { bpm: 121 } },
  { name: 'tempo tap', method: 'POST', url: '/tempo/tap' },
  { name: 'tuner (caps off)', method: 'POST', url: '/tuner', body: { on: true } },
  // telemetry cadence-mode control (registry-level; identical on both surfaces). GET before PUT so the
  // GET row observes the default; PUT switches the shared registry, invalid PUT 400s.
  { name: 'telemetry config get', method: 'GET', url: '/telemetry/config' },
  { name: 'telemetry config set', method: 'PUT', url: '/telemetry/config', body: { mode: 'performance' } },
  { name: 'telemetry config bad mode 400', method: 'PUT', url: '/telemetry/config', body: { mode: 'nope' } },
  { name: 'preset select', method: 'POST', url: '/preset/select', body: { number: 33 } },
  { name: 'preset store', method: 'POST', url: '/preset/store', body: { number: 5 } },
  { name: 'stored name stub', method: 'GET', url: '/presets/9' },
  { name: 'decode (JSON bytes)', method: 'POST', url: '/preset/decode', body: { bytes: [...presetSyx(42)] } },
  { name: 'fc model', method: 'GET', url: '/fc/model' },
  { name: 'mod model', method: 'GET', url: '/mod/model' },
  { name: 'monitors table', method: 'GET', url: '/preset/monitors' },
  { name: 'cab irs', method: 'GET', url: '/cab/irs' },
  { name: 'help block', method: 'GET', url: '/help/blocks/reverb' },
  // capability-gated 501s (the fake implements neither)
  { name: '501 locations scan', method: 'GET', url: '/preset/locations' },
  { name: '501 firmware validate', method: 'POST', url: '/firmware/validate', body: { bytes: [1, 2, 3] } },
  // device cache (four twins) — the fake FM3 has selfDescribe:false + no firmware, so status is empty,
  // build is 501-gated, cancel is idempotent, delete finds nothing. No state mutation → order-safe.
  { name: 'device cache status', method: 'GET', url: '/device/cache' },
  { name: 'device cache build (501)', method: 'POST', url: '/device/cache/build', body: {} },
  { name: 'device cache cancel', method: 'POST', url: '/device/cache/cancel' },
  { name: 'device cache delete', method: 'DELETE', url: '/device/cache' },
  // diagnostic capture (five twins) — the fake FM3 has selfDescribe:false, so a start passes the 400 gates
  // and then answers 501; nothing has run, so the result is 404 and the upload stops at its gates.
  { name: 'diagnostics status (idle)', method: 'GET', url: '/diagnostics/capture' },
  { name: 'diagnostics start without acknowledgement (400)', method: 'POST', url: '/diagnostics/capture', body: { steps: ['info'] } },
  { name: 'diagnostics start with unknown steps (400)', method: 'POST', url: '/diagnostics/capture', body: { acknowledged: true, steps: ['nope'] } },
  { name: 'diagnostics start (501 no diagnosticCapture)', method: 'POST', url: '/diagnostics/capture', body: { acknowledged: true } },
  { name: 'diagnostics cancel (idle)', method: 'POST', url: '/diagnostics/capture/cancel' },
  { name: 'diagnostics preflight (501 no diagnosticCapture)', method: 'GET', url: '/diagnostics/capture/preflight' },
  { name: 'diagnostics start with an unknown unsavedEdits (400)', method: 'POST', url: '/diagnostics/capture', body: { acknowledged: true, unsavedEdits: 'keep' } },
  { name: 'diagnostics start with a decision but no token (400)', method: 'POST', url: '/diagnostics/capture', body: { acknowledged: true, unsavedEdits: 'discard', preset: 3 } },
  { name: 'diagnostics result (404)', method: 'GET', url: '/diagnostics/capture/result' },
  { name: 'diagnostics upload without consent (400)', method: 'POST', url: '/diagnostics/capture/upload', body: {} },
  { name: 'diagnostics upload without a result (404)', method: 'POST', url: '/diagnostics/capture/upload', body: { consent: true } },
  // editor-cache contribution (four twins) — the fake FM3 has no generic params and no firmware: the consent
  // gate and the source checks answer first, then the 501 / 503 gates. No discovery is reached (bytes bodies only).
  { name: 'contribute without consent (400)', method: 'POST', url: '/device/cache/contribute', body: {} },
  { name: 'contribute with consent v1 (400)', method: 'POST', url: '/device/cache/contribute', body: { consent: true, consentVersion: 1 } },
  { name: 'contribute dry run without a source (400)', method: 'POST', url: '/device/cache/contribute', body: { dryRun: true } },
  { name: 'contribution decision invalid (400)', method: 'POST', url: '/device/cache/contribute/decision', body: { decision: 'maybe' } },
  { name: 'contribution decision without firmware (503)', method: 'POST', url: '/device/cache/contribute/decision', body: { decision: 'declined' } },
  { name: 'contribution withdraw without firmware (503)', method: 'POST', url: '/device/cache/contribute/withdraw' },
  // version control (row order matters: backup first, listing after)
  { name: 'backup preset (dedup twin)', method: 'POST', url: '/backup/preset/5' },
  { name: 'versions', method: 'GET', url: '/versions' },
  { name: 'versions by location', method: 'GET', url: '/versions?location=5' },
  { name: 'backups list', method: 'GET', url: '/backups' },
  // store documents (PUT normalized below — the two writes get distinct rev/updatedAt envelopes)
  { name: 'store list', method: 'GET', url: '/store/config' },
  { name: 'store put', method: 'PUT', url: '/store/config/parity-ui', body: { data: { theme: 'dark' } } },
  { name: 'store get', method: 'GET', url: '/store/config/parity-ui' },
  { name: 'store delete', method: 'DELETE', url: '/store/config/parity-ui' },
  { name: 'store get missing', method: 'GET', url: '/store/config/never-written' },
  // disabled-state stubs (no AXIS_CLOUD on the app, no cloud/telemetry deps on the router)
  { name: 'cloud status (off)', method: 'GET', url: '/cloud/status' },
  { name: 'remote status (off)', method: 'GET', url: '/remote/status' },
  { name: 'cloud sync gated (404)', method: 'POST', url: '/cloud/sync' },
  { name: 'telemetry status', method: 'GET', url: '/telemetry/status' },
  // unknown route → Fastify's default 404 envelope
  { name: 'unknown route 404', method: 'GET', url: '/definitely/not/a/route' }
];

// A capture on a self-describe unit through both surfaces (see diagnosticCaptureRunParity).
const DIAGNOSTICS_RUN_CASES = 10;
// A driver without the generic response (AM4) asked for it on both surfaces (see classicDriverGenericParity).
const CLASSIC_DRIVER_CASES = 2;
// dynamic follow-ups (need the version id from the backup row) + local rows + subscribe + the two
// firmware-gate twins (full capture on fw 14.0 / unknown firmware) + the running-capture twins = extra cases
export const ROUTER_PARITY_CASE_COUNT = ROWS.length + 10 + DIAGNOSTICS_RUN_CASES + CLASSIC_DRIVER_CASES;

function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// FULL-mode cache build is refused outside the verified firmware range (FM3: 12.0 to 13.0) and on unknown firmware: the Fastify route and its
// Browser-Direct twin answer the SAME 501 (they share startCacheBuild). A self-describe + fullCapture
// fake (the main matrix fake has both off) over a registry whose fn 0x08 reply is scripted — or silent.
async function fullCaptureFirmwareGateParity(): Promise<void> {
  const cases: Array<{ fw?: [number, number]; expectedFirmware: string | null; label: string }> = [
    { fw: [14, 0], expectedFirmware: '14.0', label: 'fw 14.0' },
    { fw: [5, 3], expectedFirmware: '5.3', label: 'fw 5.3 (below the verified range)' },
    { expectedFirmware: null, label: 'unknown firmware' }
  ];
  for (const c of cases) {
    const fake = { ...makeFakeFm3(), capabilities: { ...CAPS, selfDescribe: true, cacheImport: true, fullCapture: true } } as DeviceDriver;
    const { app, registry } = await buildTestApp(0x11, fake, c.fw ? { firmware: c.fw } : undefined);
    try {
      const router = createRouter({ registry, store: store.defaultStore });
      const res = await app.inject({ method: 'POST', url: '/device/cache/build', payload: { mode: 'full' } });
      const routed = await router.handle('POST', '/device/cache/build', JSON.stringify({ mode: 'full' }));
      assertEqual(res.statusCode, 501, `full capture on ${c.label}: app → 501`);
      assertEqual(routed.status, 501, `full capture on ${c.label}: router twin → 501`);
      const appJson = JSON.parse(res.payload) as Record<string, unknown>;
      const routerJson = JSON.parse(routed.body as string) as Record<string, unknown>;
      assert(deepEq(appJson, routerJson), `full capture on ${c.label}: body parity\napp:    ${JSON.stringify(appJson)}\nrouter: ${JSON.stringify(routerJson)}`);
      assertEqual(appJson.capability, 'fullCapture', `${c.label}: 501 names fullCapture`);
      assertEqual(appJson.reason, 'firmware', `${c.label}: 501 reason is firmware`);
      assertEqual(appJson.firmware, c.expectedFirmware, `${c.label}: 501 reports the detected firmware`);
    } finally {
      await app.close();
    }
  }
}

// A driver that has no generic response (AM4, gen-1/2, VP4) ignores `?generic=1`: both surfaces answer the
// classic body, without `definitions`, exactly as for the plain request. A fake AM4 whose blockParams takes the
// address alone (the real AM4/gen-2 signature) records what it was handed.
async function classicDriverGenericParity(): Promise<void> {
  const calls: unknown[][] = [];
  const classic = {
    block: 'amp', slug: 'amp', page: -1,
    named: [{ id: 1, name: 'Gain', value: 5, norm: 0.5, min: 0, max: 10 }],
    enums: [{ id: 3, name: 'Bypass', value: 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] }],
    type: { value: 2, name: 'USA Lead' }
  };
  const fake = {
    modelId: 0x15, key: 'am4', name: 'AM4',
    capabilities: { ...CAPS, slotModel: 'linear', slotCount: 4, gridEdit: false, scenes: 4, channels: false, presetDump: false, blockParamDecode: false, fcModel: false, modBind: false, cabIrs: false },
    blockParams: async (...args: unknown[]) => { calls.push(args); return classic; }
  } as unknown as DeviceDriver;
  const { app, registry } = await buildTestApp(0x15, fake);
  try {
    const router = createRouter({ registry, store: store.defaultStore });
    const bodies: Record<string, unknown> = {};
    for (const url of ['/preset/blocks/58/params', '/preset/blocks/58/params?generic=1']) {
      const res = await app.inject({ method: 'GET', url });
      const routed = await router.handle('GET', url);
      assertEqual(res.statusCode, 200, `AM4 ${url}: app 200`);
      assertEqual(routed.status, 200, `AM4 ${url}: router 200`);
      const appJson = JSON.parse(res.payload) as Record<string, unknown>;
      const routerJson = JSON.parse(routed.body as string) as Record<string, unknown>;
      assert(deepEq(appJson, routerJson), `AM4 ${url}: body parity\napp:    ${res.payload}\nrouter: ${String(routed.body)}`);
      assertEqual('definitions' in appJson, false, `AM4 ${url}: no definitions`);
      bodies[url] = appJson;
    }
    assert(deepEq(bodies['/preset/blocks/58/params'], bodies['/preset/blocks/58/params?generic=1']), 'AM4: ?generic=1 answers the same body as the classic request');
    assert(deepEq(bodies['/preset/blocks/58/params'], classic), 'AM4: the body is the driver\'s, untouched');
    // the flag still reached the driver on both surfaces; the driver simply has no use for it
    assertEqual(JSON.stringify(calls), JSON.stringify([[58, { generic: false }], [58, { generic: false }], [58, { generic: true }], [58, { generic: true }]]), 'AM4: the flag is handed to the driver on both surfaces');
  } finally {
    await app.close();
  }
}

// A capture on a self-describe unit through both surfaces (they share the job state of one registry):
// 202 on either (ids differ), 409 busy on BOTH while one runs, the same running status, the same cancel,
// the same finished status + result bundle, and the same 503 cloud-disabled upload.
async function diagnosticCaptureRunParity(): Promise<void> {
  const fake = { ...makeFakeFm3(), capabilities: { ...CAPS, selfDescribe: true } } as DeviceDriver;
  const { app, registry } = await buildTestApp(0x11, fake);
  // the walk parks until the run is cancelled, so the capture stays "running" while both surfaces are asked
  const blocking = (_t: unknown, o: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_res, rej) => { o.signal?.addEventListener('abort', () => rej(new Error('live walk aborted'))); });
  diagnostics.__setCaptureOptionsForTest(registry, { walkImpl: blocking as never, versions: { forgefx: 'parity' } });
  const router = createRouter({ registry, store: store.defaultStore, versions: { forgefx: 'parity' } });
  const both = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
    const routed = await router.handle(method, url, body !== undefined ? JSON.stringify(body) : undefined);
    return { app: { status: res.statusCode, json: res.payload ? JSON.parse(res.payload) as unknown : null }, router: { status: routed.status, json: JSON.parse(routed.body as string) as unknown } };
  };
  const same = (label: string, r: Awaited<ReturnType<typeof both>>, status: number) => {
    assertEqual(r.app.status, status, `${label}: app status`);
    assertEqual(r.router.status, status, `${label}: router status`);
    assert(deepEq(r.app.json, r.router.json), `${label}: body parity\napp:    ${JSON.stringify(r.app.json)}\nrouter: ${JSON.stringify(r.router.json)}`);
  };
  const body = { acknowledged: true, steps: ['readonlyWalk'] };
  try {
    for (const starter of ['app', 'router'] as const) {
      const started = starter === 'app'
        ? await app.inject({ method: 'POST', url: '/diagnostics/capture', payload: body }).then((r) => ({ status: r.statusCode, json: r.json() as { started: boolean; id: string } }))
        : await router.handle('POST', '/diagnostics/capture', JSON.stringify(body)).then((r) => ({ status: r.status, json: JSON.parse(r.body as string) as { started: boolean; id: string } }));
      assertEqual(started.status, 202, `start via ${starter}: 202`);
      assert(started.json.started === true && typeof started.json.id === 'string', `start via ${starter}: { started, id }`);
      same(`busy while running (started via ${starter})`, await both('POST', '/diagnostics/capture', body), 409);
      same(`status while running (started via ${starter})`, await both('GET', '/diagnostics/capture'), 200);
      same(`preflight while running (started via ${starter})`, await both('GET', '/diagnostics/capture/preflight'), 409);
      same(`cancel (started via ${starter})`, await both('POST', '/diagnostics/capture/cancel'), 200);
      await diagnostics.capturePromise(registry);
    }
    same('status after the run', await both('GET', '/diagnostics/capture'), 200);
    same('preflight when idle', await both('GET', '/diagnostics/capture/preflight'), 200);
    const result = await both('GET', '/diagnostics/capture/result');
    same('result bundle', result, 200);
    assertEqual((result.app.json as { state: string }).state, 'cancelled', 'the result is the cancelled run');
    same('upload without a cloud (503)', await both('POST', '/diagnostics/capture/upload', { consent: true }), 503);
  } finally {
    diagnostics.__setCaptureOptionsForTest(registry, null);
    await app.close();
  }
}

export async function runRouterParityTests(): Promise<void> {
  // the telemetry/cloud stub rows assume an unconfigured Supabase env — keep the suite hermetic
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'AXIS_TELEMETRY', 'AXIS_FARO_URL', 'AXIS_TELEMETRY_KEY']) delete process.env[k];

  const { app, registry } = await buildTestApp(0x11, makeFakeFm3());
  const localRoot = mkdtempSync(join(tmpdir(), 'axis-router-parity-'));
  const router = createRouter({
    registry,
    store: store.defaultStore,
    // the same Node bindings localStore.ts wires — the parity rows drive both through one temp root
    local: {
      adapterFor: (root) => createFsFolderAdapter(root),
      isAbsolute,
      resolveRoot: (root) => resolve(root),
      scanCache: {
        load: () => store.defaultBackend.getJSON<ScanCache>('localScan', {}),
        save: (c) => store.defaultBackend.putJSON('localScan', c, { atomic: true, pretty: true })
      },
      sha256Hex: nodeCodec.sha256Hex
    }
  });

  /** Run one request against BOTH surfaces and assert status + content-type class + body parity.
   *  `normalize` lets envelope fields that legitimately differ between two writes (rev/updatedAt)
   *  be stripped before comparison. */
  const parity = async (row: Row, normalize?: (b: unknown) => unknown): Promise<{ appJson: unknown; routed: RouterResponse }> => {
    const res = await app.inject({
      method: row.method as 'GET', url: row.url,
      ...(row.body !== undefined ? { payload: row.body as Record<string, unknown> } : {})
    });
    const routed = await router.handle(row.method, row.url, row.body !== undefined ? JSON.stringify(row.body) : undefined);

    assertEqual(routed.status, res.statusCode, `${row.name}: status parity (app ${res.statusCode} body ${res.payload.slice(0, 200)})`);
    const appType = String(res.headers['content-type'] ?? '').split(';')[0];
    assertEqual(routed.contentType.split(';')[0], appType, `${row.name}: content-type class parity`);

    if (row.octet) {
      const a = res.rawPayload;
      const r = routed.body as Uint8Array;
      assert(r instanceof Uint8Array, `${row.name}: router body must be bytes`);
      assertEqual(Buffer.from(r).toString('hex'), Buffer.from(a).toString('hex'), `${row.name}: byte parity`);
      return { appJson: null, routed };
    }
    const appJson = res.payload.length ? JSON.parse(res.payload) : null;
    const routerJson = typeof routed.body === 'string' && routed.body.length ? JSON.parse(routed.body) : null;
    const na = normalize ? normalize(appJson) : appJson;
    const nr = normalize ? normalize(routerJson) : routerJson;
    assert(deepEq(na, nr), `${row.name}: body parity\napp:    ${JSON.stringify(na)}\nrouter: ${JSON.stringify(nr)}`);
    return { appJson, routed };
  };

  try {
    // config fan-out: the router's subscribe() replaces SSE — collect events across the store rows
    const events: DeviceEvent[] = [];
    const unsub = router.subscribe((e) => events.push(e));

    // strip the per-write envelope on the store PUT twin (two writes → two revs/timestamps)
    const stripEnvelope = (b: unknown): unknown => {
      if (!b || typeof b !== 'object') return b;
      const { updatedAt, rev, ...rest } = b as Record<string, unknown>;
      assert(typeof updatedAt === 'number' && typeof rev === 'number', 'store put carries the sync envelope');
      return rest;
    };

    for (const row of ROWS) {
      const r = await parity(row, row.name === 'store put' ? stripEnvelope : undefined);
      // the generic flag reaches the driver through BOTH surfaces (parity alone would pass if both dropped it):
      // only a first `generic` value of '1' answers the generic shape, nothing else does
      if (row.generic !== undefined) {
        const generic = row.generic;
        assertEqual('definitions' in (r.appJson as object), generic, `${row.name}: the app answers the ${generic ? 'generic' : 'classic'} shape`);
        assertEqual('definitions' in (JSON.parse(r.routed.body as string) as object), generic, `${row.name}: the router answers the ${generic ? 'generic' : 'classic'} shape`);
      }
    }

    // 1 — the backup row stored exactly ONE version for slot 5 (the router call dedup'd by content)
    const versions = store.defaultStore.listPresetVersions(5);
    assertEqual(versions.length, 1, 'backup twin dedups to one stored version');
    const vid = versions[0]!.id;

    // 2 — version .syx bytes (octet response) match byte-for-byte
    await parity({ name: 'version syx bytes', method: 'GET', url: `/version/${vid}/syx`, octet: true });
    // 3 — version load through the shared backups service
    await parity({ name: 'version load', method: 'POST', url: `/version/${vid}/load` });

    // 4..7 — /local/* over one real temp root through the SAME shared service
    await parity({ name: 'local config put', method: 'PUT', url: '/local/config', body: { root: localRoot } });
    await parity({ name: 'local preset write', method: 'POST', url: '/local/presets', body: { name: 'Parity', bytes: [...presetSyx(9)], overwrite: true } });
    await parity({ name: 'local presets scan', method: 'GET', url: '/local/presets' });
    await parity({ name: 'local preset file', method: 'GET', url: '/local/presets/file?path=Parity.syx', octet: true });

    // 8 — PUT /store/config/:id fanned the config DeviceEvent out to the router's subscribers
    // (both surfaces' writes emit on the shared registry, so ≥2 arrive — one per PUT)
    unsub();
    const cfgEvents = events.filter((e) => e.type === 'config' && (e as { id?: string }).id === 'parity-ui');
    assert(cfgEvents.length >= 2, `config fan-out reaches router subscribers (got ${cfgEvents.length})`);

    // 9..10 — firmware gate on full-mode cache builds (fw 14.0 + unknown firmware) holds on both twins
    await fullCaptureFirmwareGateParity();
    // + a running diagnostic capture on both twins
    await diagnosticCaptureRunParity();
    // + a driver without the generic response, asked for it on both twins
    await classicDriverGenericParity();
  } finally {
    await app.close();
    rmSync(localRoot, { recursive: true, force: true });
  }
}
