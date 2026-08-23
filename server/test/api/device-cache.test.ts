// Device-cache runtime build (FORGEFX-15 / A3) — mocked transport, NO hardware. Covers the firmware
// populate (fn 0x08), the background build orchestration (progress events + persisted doc + telemetry
// pause/resume), cancel, the cache-hit short-circuit + runtime-profile swap, and the gated 409/501.
// The build never septet-encodes wire frames: a fake `walkImpl` drives onProgress and returns canned
// records straight into buildCache (which the codec's own cache:check gate exercises for real).
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, __setDriverForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import * as store from '../../src/store.js';
import type { BuiltCache, CacheRecord, LiveWalkOptions } from 'forgefx-midi/cache';
import { buildDefQuery, VIEW_DEFINITION } from 'forgefx-midi/cache';
import { FM3_PARAMS_BY_FAMILY, FM3_ROSTERS } from 'forgefx-midi/gen3/fm3';
import type { DeviceEvent, DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const DEVICE_CACHE_CASE_COUNT = 10;

const FM3 = 0x11;
const KEY = '11_12p0'; // FM3 fw 12.0

/** A fn 0x08 firmware-version reply frame: frame[6]=major, frame[7]=minor (+ optional build date). */
function firmwareReply(model: number, major: number, minor: number, build?: string): number[] {
  const f = [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00];
  if (build) for (const ch of build) f.push(ch.charCodeAt(0) & 0x7f);
  f.push(0xf7);
  return f;
}

function makeMock(model: number, fw?: [number, number, string?]): MockTransport {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (req[5] === 0x08 && fw) return [firmwareReply(model, ...fw)];
    return [];
  };
  return mock;
}

async function makeApp(model: number, opts?: { fw?: [number, number, string?]; loadCache?: (key: string) => BuiltCache | null }) {
  const mock = makeMock(model, opts?.fw);
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    ...(opts?.loadCache ? { loadDeviceCache: opts.loadCache } : {})
  });
  await registry.detect();
  const app = await buildApp(registry);
  return { app, registry, mock };
}

// The 5 HW-seed families and their section tags. buildCache asserts EVERY seed anchors to its section
// (a real device always reports all five), so the canned walk must reproduce that: per family we emit
// a handful of that family's range-bearing FLOAT params at its seed section, each with the param's
// device-true display range so the section→family voter scores its own section decisively. Preferring
// the LEAST-shared param ids (gen-3 families share a big common vocabulary — MIX/LEVEL/…) keeps
// cross-family scoring low so each seed wins its own section.
const SEED_TAGS: Record<string, number> = { DISTORT: 10, CABINET: 11, REVERB: 12, DELAY: 13, FUZZ: 25 };

function seedRecords(): CacheRecord[] {
  const byFam = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; unit?: string; displayMin?: number; displayMax?: number }[]>;
  const fams = Object.keys(SEED_TAGS);
  // how many seed families use each paramId (lower = more distinctive)
  const shareCount = new Map<number, number>();
  for (const f of fams) { const seen = new Set<number>(); for (const p of byFam[f] ?? []) if (!seen.has(p.paramId)) { seen.add(p.paramId); shareCount.set(p.paramId, (shareCount.get(p.paramId) ?? 0) + 1); } }
  const recs: CacheRecord[] = [];
  for (const fam of fams) {
    const cands = (byFam[fam] ?? [])
      .filter((p) => p.paramId < 0xff00 && p.unit !== 'enum' && p.displayMin != null && p.displayMax != null && p.displayMin !== p.displayMax)
      .sort((a, b) => (shareCount.get(a.paramId)! - shareCount.get(b.paramId)!) || a.paramId - b.paramId)
      .slice(0, 6);
    assert(cands.length > 0, `seed family ${fam} has a range-bearing float param for the fixture`);
    for (const p of cands) recs.push({ kind: 'float', section: SEED_TAGS[fam]!, offset: 0, id: p.paramId, tc: 0, min: p.displayMin!, max: p.displayMax!, def: 1, step: 0, t1: 0, t2: 0 });
  }
  return recs;
}

/** A build doc with a distinctive DISTORT (amp) roster — proves the runtime profile serves it.
 *  Renames only entry 0 and keeps the REST of the static roster's names/count intact: a cache
 *  roster shorter than the static one is (correctly, post-fix) distrusted and falls back to
 *  static wholesale, so a fixture meant to prove "cache wins" must not itself look truncated. */
function fakeCacheDoc(): BuiltCache {
  const staticAmp = FM3_ROSTERS.amp;
  const names = staticAmp.map((t, i) => (i === 0 ? 'FAKE CACHE AMP' : t.name));
  return {
    enumOverrides: { DISTORT: { '0': names } },
    ranges: {},
    rangeSections: {},
    rosters: { DISTORT: names.map((name, value) => ({ value, name, manufacturer: value === 0 ? 'ACME' : null, basedOn: value === 0 ? 'Fake Stack' : null })) },
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    model: FM3,
    firmware: '12.0',
    meta: { recordCount: names.length, builtAt: '2026-07-12T00:00:00.000Z', source: 'live' }
  };
}

// ── 1. firmware populate ──
async function firmwarePresent(): Promise<void> {
  const { app, registry } = await makeApp(FM3, { fw: [12, 0, '2026-01-01'] });
  try {
    const fw = registry.firmwareInfo();
    assert(fw != null, 'firmware populated');
    assertEqual(fw!.version, '12.0', 'firmware version');
    const dev = (await app.inject({ method: 'GET', url: '/device' })).json() as { firmware: { version: string; build: string } | null; modelId: number };
    assertEqual(dev.modelId, FM3, 'detected FM3');
    assert(dev.firmware != null && dev.firmware.version === '12.0', 'GET /device carries firmware');
    assertEqual(dev.firmware!.build, '2026-01-01', 'firmware build date');
  } finally {
    await app.close();
  }
}

async function firmwareSilent(): Promise<void> {
  const { app, registry } = await makeApp(FM3); // no fw scripted → silent fn 0x08
  try {
    assertEqual(registry.firmwareInfo(), null, 'silent fn 0x08 → firmware null');
    const dev = (await app.inject({ method: 'GET', url: '/device' })).json() as { firmware: unknown; modelId: number };
    assertEqual(dev.modelId, FM3, 'detection still succeeds without firmware');
    assertEqual(dev.firmware, null, 'GET /device firmware null when silent');
  } finally {
    await app.close();
  }
}

// ── 2. build happy path (progress events + doc + telemetry pause/resume) ──
async function buildHappyPath(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY); // isolate from prior runs
  const expectedRecords = seedRecords().length;
  const { app, registry, mock } = await makeApp(FM3, { fw: [12, 0] });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e)); // also spins up the meter supervisor (FM3)
  try {
    const fakeWalk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => {
      // FORGEFX-32 regression: the walk MUST be paced — 0 ms query flooding freezes FM3 hardware —
      // and MUST stay inside the hardware-validated envelope: block breathers + 7-bit params only
      // (the 14-bit body[5] space was never live-swept on a real unit).
      assertEqual(opts.interQueryMs, 3, 'walk opts carry the hardware-proven 3 ms inter-query pacing');
      assertEqual(opts.blockPauseMs, 150, 'walk opts carry the 150 ms inter-block breather');
      assertEqual(opts.maxParamId, 127, 'walk opts stay inside the 7-bit param envelope');
      // default build is READ-ONLY: no mode, no write hooks (byte-identical to the shipped HW walk)
      assertEqual(opts.mode, undefined, 'default build passes no mode (read-only)');
      assertEqual(opts.write, undefined, 'read-only build passes no write hooks');
      opts.onProgress?.({ phase: 'block-start', block: 0, blockIndex: 0, blockCount: 2, records: 0, enumLabels: 0, queries: 0 });
      opts.onProgress?.({ phase: 'block-done', block: 0, blockIndex: 1, blockCount: 2, records: expectedRecords, enumLabels: 0, queries: 4 });
      opts.onProgress?.({ phase: 'done', blockIndex: 2, blockCount: 2, records: expectedRecords, enumLabels: 0, queries: 4 });
      return seedRecords();
    };
    await registry.setTuner(true); // schedule a tuner poll so we can observe pause/resume
    const beforeLen = mock.sent.length;

    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: fakeWalk });
    assertEqual((r.body as { started?: boolean }).started, true, 'build started');
    await deviceCache.cacheBuildPromise(registry);

    // telemetry was paused across the build → no tuner/meter frame landed while it ran
    assertEqual(mock.sent.length, beforeLen, 'no telemetry frames fired during the build');

    // progress events: walking → building → done
    const cb = events.filter((e) => e.type === 'cacheBuild') as Extract<DeviceEvent, { type: 'cacheBuild' }>[];
    assert(cb.some((e) => e.phase === 'walking'), 'emitted a walking event');
    assert(cb.some((e) => e.phase === 'building'), 'emitted a building event');
    assert(cb.some((e) => e.phase === 'done' && e.key === KEY), 'emitted a done event with the key');

    // doc landed
    const doc = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(doc != null && !doc.deleted, 'cache doc persisted under 11_12p0');
    assertEqual((doc!.data as BuiltCache).meta.recordCount, expectedRecords, 'doc records match the fixture');

    // status endpoint reflects it
    const st = (await app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    assertEqual(st.key, KEY, 'status key');
    assertEqual(st.exists, true, 'status exists');
    assertEqual(st.building, false, 'status not building after completion');
    assert(st.meta != null && st.meta.recordCount === expectedRecords, 'status meta recordCount');

    // resume restarted telemetry → polls fire again
    await sleep(160);
    assert(mock.sent.length > beforeLen, 'telemetry resumed after the build');
  } finally {
    unsub();
    await registry.setTuner(false);
    await app.close();
  }
}

// ── 3. cancel ──
async function cancelBuild(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const { app, registry } = await makeApp(FM3, { fw: [12, 0] });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  try {
    // a walk that never resolves until aborted
    const blockingWalk = (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> =>
      new Promise((_res, rej) => { opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: blockingWalk });
    const cancel = deviceCache.cancelCacheBuild(registry);
    assertEqual(cancel.ok, true, 'cancel ok');
    await deviceCache.cacheBuildPromise(registry);

    const cb = events.filter((e) => e.type === 'cacheBuild') as Extract<DeviceEvent, { type: 'cacheBuild' }>[];
    assert(cb.some((e) => e.phase === 'cancelled'), 'emitted a cancelled event');
    assert(store.defaultStore.getDoc('deviceCaches', KEY) == null || store.defaultStore.getDoc('deviceCaches', KEY)!.deleted, 'no doc after cancel');
    const st = await deviceCache.cacheStatus(store.defaultStore, registry);
    assertEqual(st.building, false, 'not building after cancel');
  } finally {
    unsub();
    await app.close();
  }
}

// ── 4. cache-hit short-circuit + runtime profile ──
async function cacheHitAndRuntimeProfile(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  store.defaultStore.putDoc('deviceCaches', KEY, fakeCacheDoc()); // pre-existing build
  const { app, registry } = await makeApp(FM3, { fw: [12, 0], loadCache: (k) => (k === KEY ? fakeCacheDoc() : null) });
  try {
    // build with a spy walk → must NOT be invoked (doc already present, no force)
    let walked = false;
    const spyWalk = async (): Promise<CacheRecord[]> => { walked = true; return []; };
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: spyWalk });
    assertEqual((r.body as { already?: boolean }).already, true, 'already-built short-circuit');
    assertEqual(walked, false, 'walk not invoked on a cache hit');

    // the runtime profile serves the device-true roster (swapped in during detect via loadDeviceCache)
    const types = (await app.inject({ method: 'GET', url: '/blocks/amp/types' })).json() as { name: string }[];
    assert(types.some((t) => t.name === 'FAKE CACHE AMP'), `runtime roster served (got ${types.map((t) => t.name).slice(0, 3).join(',')})`);
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// ── 5a. concurrent build → 409 ──
async function concurrentBuild(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const { app, registry } = await makeApp(FM3, { fw: [12, 0] });
  try {
    let release: () => void = () => {};
    const gatedWalk = (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> =>
      new Promise((res, rej) => {
        release = () => res(seedRecords());
        opts.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const first = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: gatedWalk });
    assertEqual((first.body as { started?: boolean }).started, true, 'first build started');
    const second = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: gatedWalk });
    assertEqual(second.code, 409, 'concurrent build → 409');
    release();
    await deviceCache.cacheBuildPromise(registry);
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// ── 5b. no selfDescribe (AM4) → 501 ──
async function noSelfDescribe(): Promise<void> {
  const { app, registry } = await makeApp(0x15); // AM4 → selfDescribe false
  try {
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry);
    assertEqual(r.code, 501, 'AM4 build → 501 unsupported');
    assertEqual((r.body as { capability?: string }).capability, 'selfDescribe', '501 names the capability');
  } finally {
    await app.close();
  }
}

// ── 6. FULL-mode build (WP3b) — a seeded gen-3-style fake so we can vary fullCapture and spy the
//    reloadPreset re-select without scripting the real preset-name / preset-switch wire protocol. ──
function gen3FakeCaps(over: Partial<DriverCapabilities>): DriverCapabilities {
  return {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, presetConvert: true, blockParamDecode: true,
    telemetry: { tuner: false, outputMeters: false, cpu: false }, // inert: no supervisor polls
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: true,
    supportsSave: true, selfDescribe: true, cacheImport: true, fullCapture: true,
    deviceEditPush: false, deviceEditWatch: false, // inert: no RX listeners / edit-watch timers
    ...over
  };
}

/** A minimal gen-3-shaped fake driver. `selectCalls` records reloadPreset's re-select target so the
 *  full-mode test can assert the current preset was reloaded, without real preset-switch bytes. */
function makeGen3Fake(caps: DriverCapabilities, selectCalls: number[]): DeviceDriver {
  const fake = {
    modelId: FM3, key: 'fm3', name: 'FM3', capabilities: caps,
    grid: async () => ({ model: 'fm3', name: 'F', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const }),
    presetRef: async () => ({ number: 7, name: 'Cur' }),
    selectPreset: async (n: number) => { selectCalls.push(n); return { ok: true }; },
    reloadPreset: async () => { const { number } = await fake.presetRef(); if (number >= 0) await fake.selectPreset(number); }
  } as unknown as DeviceDriver;
  return fake;
}

async function makeAppWithFake(model: number, fake: DeviceDriver, fw?: [number, number, string?]) {
  const mock = makeMock(model, fw);
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock
  });
  __setDriverForTest(registry, model, fake);
  await registry.detect();
  const app = await buildApp(registry);
  return { app, registry, mock };
}

async function fullBuildWithHooks(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const selectCalls: number[] = [];
  const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: true }), selectCalls);
  const { app, registry, mock } = await makeAppWithFake(FM3, fake, [12, 0]);
  try {
    const SET_FRAME = Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x02, 0x63, 0xf7]); // stand-in continuous-SET
    let sawFull = false;
    const fullWalk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => {
      sawFull = true;
      assertEqual(opts.mode, 'full', 'full build passes mode:full to the walk');
      assertEqual(opts.maxParamId, 16383, 'full build lifts the param cap to the 14-bit space');
      assert(opts.write != null, 'full build passes write hooks');
      await opts.write!.send(SET_FRAME);   // codec would build the SET; the host just puts bytes on the wire
      await opts.write!.reloadPreset();    // per-block non-destructive reload
      return seedRecords();
    };
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { mode: 'full', walkImpl: fullWalk });
    assertEqual((r.body as { started?: boolean }).started, true, 'full build started');
    await deviceCache.cacheBuildPromise(registry);

    assert(sawFull, 'full walk invoked');
    // the send hook put the SET frame on the transport (transport.sendQueued → mock.sent)
    const key = (f: readonly number[]) => f.join(',');
    assert(mock.sent.some((f) => key(f) === key([...SET_FRAME])), 'a SET frame reached the transport via the send hook');
    // reloadPreset re-selected the CURRENT preset (presetRef → selectPreset(7))
    assert(selectCalls.includes(7), 'reloadPreset re-selected the current preset (7)');
    const doc = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(doc != null && !doc.deleted, 'full build persisted the cache doc');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// full mode on a selfDescribe device that lacks fullCapture → 501 (mirrors the selfDescribe 501 shape).
// Driven over HTTP so the POST-body `mode` plumbing is exercised end-to-end.
async function fullWithoutCapability(): Promise<void> {
  const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: false }), []); // selfDescribe true, fullCapture false
  const { app } = await makeAppWithFake(FM3, fake, [12, 0]);
  try {
    const res = await app.inject({ method: 'POST', url: '/device/cache/build', payload: { mode: 'full' } });
    assertEqual(res.statusCode, 501, 'full without fullCapture → 501');
    assertEqual((res.json() as { capability?: string }).capability, 'fullCapture', '501 names the fullCapture capability');
  } finally {
    await app.close();
  }
}

// ── 7. reply matcher (WP3b) — the rig-proven adaptRequest matches view + block-high + param-low +
//    param-high; a stale reply with a wrong block-high or wrong param byte must NOT latch. ──
async function replyMatcher(): Promise<void> {
  const block = 130, param = 200; // high block (block-high 1) + high param (param-high 1)
  const query = buildDefQuery(FM3, block, param);
  const sdReply = (blk: number, prm: number): number[] => {
    const inner = new Array<number>(15).fill(0);
    inner[0] = VIEW_DEFINITION; inner[2] = 0x01; // inner[2] is a device constant, NOT block-low
    inner[3] = (blk >> 7) & 0x7f;  // block-high echo
    inner[4] = prm & 0x7f;         // param-low echo
    inner[5] = (prm >> 7) & 0x7f;  // param-high echo
    inner[6] = 0x3a;               // tag: payload
    const core = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, ...inner];
    let cs = 0; for (const b of core) cs ^= b;
    return [...core, cs & 0x7f, 0xf7];
  };
  const correct = sdReply(block, param);
  const wrongBlockHi = sdReply(2, param);       // block-high 0 ≠ 1
  const wrongParam = sdReply(block, param - 1); // param-low 199 ≠ 200
  const eq = (a: Uint8Array | null, b: number[]) => a != null && Array.from(a).join(',') === b.join(',');
  const mockWith = (frames: number[][]): MockTransport => { const m = new MockTransport('serial', 'sd'); m.reply = () => frames; return m; };

  // NB: under the OLD (block-low) matcher the correct reply is REJECTED (its inner[2]=0x01 ≠ block-low 2).
  assert(eq(await deviceCache.adaptRequest(mockWith([correct]), query), correct), 'matcher accepts the correct high-block/high-param reply');
  assertEqual(await deviceCache.adaptRequest(mockWith([wrongBlockHi]), query), null, 'matcher rejects a stale reply with the wrong block-high');
  assertEqual(await deviceCache.adaptRequest(mockWith([wrongParam]), query), null, 'matcher rejects a stale reply with the wrong param byte');
  assert(eq(await deviceCache.adaptRequest(mockWith([wrongBlockHi, correct]), query), correct), 'matcher picks the correct reply out of a stale-mixed buffer');
}

export async function runDeviceCacheTests(): Promise<void> {
  await firmwarePresent();
  await firmwareSilent();
  await buildHappyPath();
  await cancelBuild();
  await cacheHitAndRuntimeProfile();
  await concurrentBuild();
  await noSelfDescribe();
  await fullBuildWithHooks();
  await fullWithoutCapability();
  await replyMatcher();
}
