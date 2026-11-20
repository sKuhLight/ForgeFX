// GET /presets/:n/grid — the grid of the STORED slot `n`, never the edit buffer. Mocked, NO hardware.
//
//   A  route level over a fake driver (Fastify app AND the browser-facing runtime router, one registry):
//      different slots → different grids, never the live grid; malformed / out-of-range n → 400 with no
//      device access (the SAME validator guards /presets/:n/summary and /params); a driver that cannot dump
//      a slot answers the live grid only for the loaded slot (needs presetRef) and 501 for any other — and
//      for every slot when it cannot even name its loaded slot; a decode failure → 503.
//   B  the REAL gen-3 driver over a MockTransport serving a bundled FM3 dump: presetGrid(n) requests the
//      dump of slot n (not the edit buffer), is never cached after it settles, shares ONE dump between
//      concurrent requests for the same slot, leaves the edit-buffer grid alone, and reports its own
//      profile key as the grid `model`.
//   C  the same real driver end to end through app.inject + router; an Axe-Fx III slot >= 512 (14-bit
//      request) works while 1024 is out of range.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { createRouter } from '../../src/runtime/router.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import * as store from '../../src/store.js';
import type { DeviceDriver, DriverCapabilities, PresetGridDTO } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const PRESET_GRID_SLOT_CASE_COUNT = 62;

const FM3_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)));
const EDIT_BUFFER = 0x3fff;
const compact = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');

const CAPS: DriverCapabilities = {
  slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
  presetDump: true, presetConvert: false, blockParamDecode: false, telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: false, supportsSave: true,
  selfDescribe: false, cacheImport: false, fullCapture: false
};

const gridOf = (name: string, effectId: number): PresetGridDTO => ({
  model: 'fm3', name, crcValid: true, rows: 4, cols: 12, scenes: [],
  cells: [{ row: 0, col: 0, effectId, name: `Block ${effectId}`, isShunt: false, routeFlag: 0, fromRows: [] }],
  source: 'dump'
});

interface Calls { grid: number; presetGrid: number[]; presetRef: number; summary: number[]; params: number[] }

/** Gen-3-style fake: can dump a stored slot (`presetGrid`) and knows its slot count; its `grid()` is
 *  the LIVE edit-buffer grid ("LIVE") — a slot route must never return that. */
function makeDumpDriver(calls: Calls, opts: { failSlot?: number } = {}): DeviceDriver {
  return {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: CAPS, presetCount: 512,
    grid: async () => { calls.grid++; return gridOf('LIVE', 58); },
    presetGrid: async (n: number) => {
      calls.presetGrid.push(n);
      if (n === opts.failSlot) throw new Error('dump incomplete');
      return gridOf(`SLOT-${n}`, 100 + n);
    },
    presetSummary: async (n: number) => { calls.summary.push(n); return { number: n, name: `SUM-${n}` }; },
    presetParams: async (n: number) => { calls.params.push(n); return [{ n }]; },
    presetRef: async () => { calls.presetRef++; return { number: 3, name: 'Current' }; }
  } as unknown as DeviceDriver;
}

/** AM4 shape: no stored-slot read, only the live grid + the loaded slot's number (`presetRef`). */
function makeLiveOnlyDriver(calls: Calls, loaded: number): DeviceDriver {
  return {
    modelId: 0x15, key: 'am4', name: 'AM4', capabilities: { ...CAPS, slotModel: 'linear', presetDump: false },
    grid: async () => { calls.grid++; return gridOf('LIVE', 58); },
    presetRef: async () => { calls.presetRef++; return { number: loaded, name: 'Loaded' }; }
  } as unknown as DeviceDriver;
}

/** gen-1 / gen-2 / VP4 shape: neither a stored-slot read NOR a way to name the loaded slot. */
function makeBlindDriver(calls: Calls): DeviceDriver {
  return {
    modelId: 0x07, key: 'axefx2', name: 'Axe-Fx II', capabilities: { ...CAPS, slotModel: 'grid', presetDump: false },
    grid: async () => { calls.grid++; return gridOf('LIVE', 58); }
  } as unknown as DeviceDriver;
}

const freshCalls = (): Calls => ({ grid: 0, presetGrid: [], presetRef: 0, summary: [], params: [] });

async function bothSurfaces(
  t: Awaited<ReturnType<typeof buildTestApp>>,
  router: ReturnType<typeof createRouter>,
  url: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await t.app.inject({ method: 'GET', url });
  const routed = await router.handle('GET', url);
  assertEqual(routed.status, res.statusCode, `${url}: router status parity`);
  const appBody = JSON.parse(res.payload) as Record<string, unknown>;
  assertEqual(String(routed.body), res.payload, `${url}: router body parity`);
  return { status: res.statusCode, body: appBody };
}

// ── A — route level over fake drivers ──
async function routeLevel(): Promise<void> {
  // A1 — a dump-capable driver
  {
    const calls = freshCalls();
    const t = await buildTestApp(0x11, makeDumpDriver(calls, { failSlot: 77 }));
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      const a = await bothSurfaces(t, router, '/presets/7/grid');
      const b = await bothSurfaces(t, router, '/presets/9/grid');
      assertEqual(a.status, 200, 'slot 7 → 200');
      assertEqual(a.body.name, 'SLOT-7', 'slot 7 grid is the stored slot 7 (not LIVE)');
      assertEqual(b.body.name, 'SLOT-9', 'slot 9 grid is the stored slot 9');
      assert((a.body.cells as { effectId: number }[])[0]!.effectId !== (b.body.cells as { effectId: number }[])[0]!.effectId, 'different slots → different grids');
      assertEqual(calls.grid, 0, 'slot routes never read the edit-buffer grid');
      assertEqual(calls.presetGrid.join(','), '7,7,9,9', 'driver was asked for exactly the addressed slots (app + router)');

      const first = await bothSurfaces(t, router, '/presets/0/grid');
      assertEqual(first.body.name, 'SLOT-0', 'slot 0 is valid');
      const last = await bothSurfaces(t, router, '/presets/511/grid');
      assertEqual(last.body.name, 'SLOT-511', 'last slot (511) is valid');

      // the edit-buffer route is untouched
      const live = await bothSurfaces(t, router, '/preset/grid');
      assertEqual(live.body.name, 'LIVE', '/preset/grid still serves the edit buffer');

      // malformed numbers → 400 BEFORE any driver call
      const before = calls.presetGrid.length;
      for (const bad of ['abc', '-1', '1.5', '1e2', '0x10', '%2007', '000000']) {
        const r = await bothSurfaces(t, router, `/presets/${bad}/grid`);
        assertEqual(r.status, 400, `invalid n "${bad}" → 400`);
        assertEqual(r.body.error, 'invalid preset number', `invalid n "${bad}" error text`);
      }
      // out of range (≥ presetCount) → 400 with the max
      const over = await bothSurfaces(t, router, '/presets/512/grid');
      assertEqual(over.status, 400, 'n = presetCount → 400');
      assertEqual(over.body.max, 511, 'out-of-range answer names the max slot');
      assertEqual((await bothSurfaces(t, router, '/presets/99999/grid')).status, 400, 'huge n → 400');
      assertEqual(calls.presetGrid.length, before, 'rejected numbers never reached the driver');

      // the SAME validator guards /presets/:n/summary and /presets/:n/params (app + router)
      const ok1 = await bothSurfaces(t, router, '/presets/7/summary');
      assertEqual(ok1.body.name, 'SUM-7', 'summary: a valid slot still reaches the driver');
      const ok2 = await bothSurfaces(t, router, '/presets/7/params');
      assertEqual((ok2.body.blocks as { n: number }[])[0]!.n, 7, 'params: a valid slot still reaches the driver');
      for (const route of ['summary', 'params']) {
        for (const bad of ['abc', '-1', '1.5', '1e2']) {
          assertEqual((await bothSurfaces(t, router, `/presets/${bad}/${route}`)).status, 400, `${route}: malformed "${bad}" → 400`);
        }
        const oor = await bothSurfaces(t, router, `/presets/512/${route}`);
        assertEqual(oor.status, 400, `${route}: n = presetCount → 400`);
        assertEqual(oor.body.max, 511, `${route}: out-of-range names the max slot`);
      }
      assertEqual(calls.summary.join(','), '7,7', 'summary: only the valid slot reached the driver (app + router)');
      assertEqual(calls.params.join(','), '7,7', 'params: only the valid slot reached the driver (app + router)');

      // a failing dump → 503 on both surfaces, never a substituted grid
      const realError = console.error;
      console.error = () => {}; // decodeFail logs the stack by design; keep the suite output clean
      let failed: Awaited<ReturnType<typeof bothSurfaces>>;
      try { failed = await bothSurfaces(t, router, '/presets/77/grid'); } finally { console.error = realError; }
      assertEqual(failed.status, 503, 'dump failure → 503');
      assertEqual(failed.body.error, 'dump incomplete', 'dump failure carries the message');
    } finally { await t.app.close(); }
  }

  // A2 — a driver that cannot dump a stored slot (AM4/gen-1/gen-2/VP4 shape)
  {
    const calls = freshCalls();
    const t = await buildTestApp(0x15, makeLiveOnlyDriver(calls, 3));
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      const loaded = await bothSurfaces(t, router, '/presets/3/grid');
      assertEqual(loaded.status, 200, 'live-only driver: the LOADED slot → 200');
      assertEqual(loaded.body.name, 'LIVE', 'live-only driver: loaded slot answers the live grid');
      const other = await bothSurfaces(t, router, '/presets/4/grid');
      assertEqual(other.status, 501, 'live-only driver: any other slot → 501, never the live grid');
      assertEqual(other.body.error, 'unsupported', 'live-only driver: 501 envelope');
      assertEqual(other.body.capability, 'presetDump', 'live-only driver: 501 names the capability');
      const bad = await bothSurfaces(t, router, '/presets/x/grid');
      assertEqual(bad.status, 400, 'live-only driver: malformed n still 400');
      assertEqual(calls.grid, 2, 'live grid read only for the loaded slot (app + router), not for slot 4');
    } finally { await t.app.close(); }
  }

  // A3 — a driver that can neither dump a slot nor name its loaded slot (gen-1 / gen-2 / VP4): 501 for EVERY slot
  {
    const calls = freshCalls();
    const t = await buildTestApp(0x07, makeBlindDriver(calls));
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      for (const n of [0, 3, 4]) {
        const r = await bothSurfaces(t, router, `/presets/${n}/grid`);
        assertEqual(r.status, 501, `blind driver: slot ${n} → 501`);
        assertEqual(r.body.capability, 'presetDump', `blind driver: slot ${n} 501 names the capability`);
      }
      assertEqual(calls.grid, 0, 'blind driver: the live grid is never substituted for a slot');
      assertEqual((await bothSurfaces(t, router, '/preset/grid')).body.name, 'LIVE', 'blind driver: /preset/grid still serves the live grid');
    } finally { await t.app.close(); }
  }
}

// ── B — the real gen-3 driver ──
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = null; } }
  }
  return frames;
}

async function realDriver(): Promise<void> {
  const prof = PROFILES[0x11]!;
  const codec = createModernFractalCodec(0x11);
  const dump = framesOf(new Uint8Array(FM3_FIXTURE));
  const mock = new MockTransport('serial', 'mock-fm3-grid-slot');
  mock.isOpen = true;
  mock.reply = (req) => (req[5] === 0x03 ? dump : []); // any preset-dump request is answered with the fixture
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });

  assertEqual(driver.presetCount, 512, 'FM3 has 512 stored slots');
  assertEqual(createGen3Driver(PROFILES[0x12]!, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') }).presetCount, 512, 'FM9 has 512 stored slots');
  assertEqual(createGen3Driver(PROFILES[0x10]!, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') }).presetCount, 1024, 'Axe-Fx III has 1024 stored slots');

  const slotReq = (n: number) => compact(codec.buildRequestPresetDump(n));
  const g7 = await driver.presetGrid!(7);
  assert(g7.cells.length > 0 && g7.rows === prof.rows && g7.cols === prof.cols, 'stored-slot grid decodes through the dump pipeline');
  assert(mock.sent.some((f) => compact(f) === slotReq(7)), 'presetGrid(7) requests the dump of slot 7');
  assert(!mock.sent.some((f) => compact(f) === slotReq(EDIT_BUFFER)), 'presetGrid(7) never requests the edit buffer');

  // not cached: a second call dumps again (a slot must never be served from the edit-buffer cache)
  const sentBefore = mock.sent.length;
  await driver.presetGrid!(7);
  assert(mock.sent.length > sentBefore, 'presetGrid is never served from a cache');

  // the edit-buffer grid() still requests the edit buffer, and presetGrid did not seed its cache
  await driver.grid();
  assert(mock.sent.some((f) => compact(f) === slotReq(EDIT_BUFFER)), 'grid() still requests the edit buffer — presetGrid did not seed its cache');
  const sentAfterGrid = mock.sent.length;
  const g9 = await driver.presetGrid!(9);
  assert(mock.sent.length > sentAfterGrid && mock.sent.some((f) => compact(f) === slotReq(9)), 'presetGrid(9) after grid() asks the device for slot 9');
  assertEqual(JSON.stringify(g9), JSON.stringify(g7), 'same dump bytes → same grid (decode is deterministic)');
  assertEqual(g7.name, (await driver.presetSummary(5)).name, 'slot grid name matches the slot summary name');
  assertEqual(g7.model, 'fm3', 'FM3 slot grid reports its own profile key');

  // concurrent requests for the SAME slot share one dump; another slot gets its own; nothing is kept afterwards
  const count = (n: number) => mock.sent.filter((f) => compact(f) === slotReq(n)).length;
  const before21 = count(21), before22 = count(22);
  const [c1, c2, c3] = await Promise.all([driver.presetGrid!(21), driver.presetGrid!(21), driver.presetGrid!(22)]);
  assertEqual(count(21) - before21, 1, 'two concurrent presetGrid(21) share ONE dump request');
  assertEqual(count(22) - before22, 1, 'a concurrent presetGrid(22) gets its own dump request');
  assertEqual(JSON.stringify(c1), JSON.stringify(c2), 'coalesced callers get the same grid');
  assert(c3.cells.length > 0, 'the other slot decodes');
  await driver.presetGrid!(21);
  assertEqual(count(21) - before21, 2, 'after the dump settled, the next call reads the device again (no cache)');

  // a failed dump is not stuck in the in-flight map: the next call retries
  const failing = new MockTransport('serial', 'mock-fm3-grid-slot-fail');
  failing.isOpen = true;
  failing.reply = () => [];
  const flaky = createGen3Driver(prof, { transport: async () => failing, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const realLog = console.log;
  console.log = () => {}; // the dump retry path logs; keep the suite output clean
  try {
    let threw = 0;
    try { await flaky.presetGrid!(3); } catch { threw++; }
    const sent = failing.sent.length;
    try { await flaky.presetGrid!(3); } catch { threw++; }
    assertEqual(threw, 2, 'an incomplete dump rejects (both attempts)');
    assert(failing.sent.length > sent, 'a failed in-flight dump does not poison later calls');
  } finally { console.log = realLog; }
}

// ── C — real driver through both surfaces ──
async function realDriverEndToEnd(): Promise<void> {
  const dump = framesOf(new Uint8Array(FM3_FIXTURE));
  const t = await buildTestApp(0x11);
  t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : req[5] === 0x03 ? dump : []);
  const router = createRouter({ registry: t.registry, store: store.defaultStore });
  try {
    const r = await bothSurfaces(t, router, '/presets/5/grid');
    assertEqual(r.status, 200, 'real gen-3 driver: stored slot → 200');
    assert(Array.isArray(r.body.cells) && (r.body.cells as unknown[]).length > 0, 'real gen-3 driver: cells decoded from the slot dump');
    const sentSlot5 = t.mock.sent.some((f) => f[5] === 0x03 && compact(f) === compact(createModernFractalCodec(0x11).buildRequestPresetDump(5)));
    assert(sentSlot5, 'real gen-3 driver: the slot-5 dump was requested');
    assertEqual((await bothSurfaces(t, router, '/presets/512/grid')).status, 400, 'real FM3: slot 512 is out of range → 400');
    assertEqual((await bothSurfaces(t, router, '/presets/nope/grid')).status, 400, 'real FM3: malformed n → 400');
  } finally { await t.app.close(); }
}

/** Axe-Fx III: 1024 slots — a slot >= 512 needs the 14-bit dump request and must not be rejected. */
async function axeFx3HighSlot(): Promise<void> {
  const III_FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/axe3-devs-gift-of-tone.syx', import.meta.url)));
  const dump = framesOf(new Uint8Array(III_FIXTURE));
  const codec = createModernFractalCodec(0x10);
  const prof = PROFILES[0x10]!;
  const mock = new MockTransport('serial', 'mock-axe3-grid-slot');
  mock.isOpen = true;
  mock.reply = (req) => (req[5] === 0x03 ? dump : []);
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const g = await driver.presetGrid!(700);
  const want = compact(codec.buildRequestPresetDump(700));
  assert(mock.sent.some((f) => compact(f) === want), 'III presetGrid(700) sends the 14-bit dump request for slot 700');
  assert(want !== compact(codec.buildRequestPresetDump(700 & 0x7f)), 'the request really carries the high septet (700 != 700 mod 128)');
  assertEqual(g.model, 'axe3', 'III slot grid reports the axe3 profile key');
  assert(g.rows === 6 && g.cols === 14 && g.cells.length > 0, 'III slot grid decodes (6x14, cells present)');

  const t = await buildTestApp(0x10);
  t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x10)] : req[5] === 0x03 ? dump : []);
  const router = createRouter({ registry: t.registry, store: store.defaultStore });
  try {
    assertEqual((await bothSurfaces(t, router, '/presets/700/grid')).status, 200, 'III: slot 700 → 200 on both surfaces');
    assertEqual((await bothSurfaces(t, router, '/presets/1023/grid')).status, 200, 'III: last slot 1023 → 200');
    const oor = await bothSurfaces(t, router, '/presets/1024/grid');
    assertEqual(oor.status, 400, 'III: slot 1024 → 400');
    assertEqual(oor.body.max, 1023, 'III: out-of-range names max 1023');
  } finally { await t.app.close(); }
}

export async function runPresetGridSlotTests(): Promise<void> {
  await routeLevel();
  await realDriver();
  await realDriverEndToEnd();
  await axeFx3HighSlot();
}
