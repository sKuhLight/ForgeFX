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
    blocksCatalog: () => [{ slug: 'amp', family: 'AMP', instance: 1, name: 'Amp 1', page: 0, paramCount: 2, typeCount: 1 }],
    blockTypes: () => [{ value: 1, name: 'USA Lead', manufacturer: null, basedOn: null }],
    blockParams: async (eid: number) => ({
      block: 'Amp 1', slug: 'amp', page: 0,
      named: [{ id: 1, name: 'Gain', value: 5, norm: 0.5, min: 0, max: 10 }],
      enums: [], type: { value: 1, name: 'USA Lead' }
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

interface Row { name: string; method: string; url: string; body?: unknown; octet?: boolean }

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
  { name: 'blocks placed', method: 'GET', url: '/preset/blocks' },
  { name: 'blocks catalog', method: 'GET', url: '/blocks' },
  { name: 'block types', method: 'GET', url: '/blocks/amp/types' },
  { name: 'block params', method: 'GET', url: '/preset/blocks/58/params' },
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

// dynamic follow-ups (need the version id from the backup row) + local rows + subscribe + the two
// firmware-gate twins (full capture on fw 13.0 / unknown firmware) = extra cases
export const ROUTER_PARITY_CASE_COUNT = ROWS.length + 10;

function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// FULL-mode cache build is refused on firmware 13+ and on unknown firmware: the Fastify route and its
// Browser-Direct twin answer the SAME 501 (they share startCacheBuild). A self-describe + fullCapture
// fake (the main matrix fake has both off) over a registry whose fn 0x08 reply is scripted — or silent.
async function fullCaptureFirmwareGateParity(): Promise<void> {
  const cases: Array<{ fw?: [number, number]; expectedFirmware: string | null; label: string }> = [
    { fw: [13, 0], expectedFirmware: '13.0', label: 'fw 13.0' },
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
      await parity(row, row.name === 'store put' ? stripEnvelope : undefined);
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

    // 9..10 — firmware gate on full-mode cache builds (fw 13.0 + unknown firmware) holds on both twins
    await fullCaptureFirmwareGateParity();
  } finally {
    await app.close();
    rmSync(localRoot, { recursive: true, force: true });
  }
}
