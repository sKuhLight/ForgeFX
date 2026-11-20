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
import { FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import type { DeviceEvent, DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const DEVICE_CACHE_CASE_COUNT = 13;

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

/** A build doc with a distinctive DISTORT (amp) roster — proves the runtime profile serves it. */
function fakeCacheDoc(): BuiltCache {
  return {
    enumOverrides: { DISTORT: { '0': ['FAKE CACHE AMP', 'Other Amp'] } },
    ranges: {},
    rangeSections: {},
    rosters: { DISTORT: [{ value: 0, name: 'FAKE CACHE AMP', manufacturer: 'ACME', basedOn: 'Fake Stack' }, { value: 1, name: 'Other Amp', manufacturer: null, basedOn: null }] },
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    model: FM3,
    firmware: '12.0',
    meta: { recordCount: 2, builtAt: '2026-07-12T00:00:00.000Z', source: 'live' }
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
  const { app, registry, mock } = await makeApp(FM3, { fw: [12, 0] });
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
    // a FULL request while a build runs is refused with 409 BEFORE the firmware re-read: nothing reaches the
    // device (no fn 0x08 mid-walk) and the cached firmware is not cleared, even on firmware that would be allowed
    const sentBefore = mock.sent.length;
    const fullDuring = await deviceCache.startCacheBuild(store.defaultStore, registry, { mode: 'full', walkImpl: gatedWalk });
    assertEqual(fullDuring.code, 409, 'full request during a running build → 409');
    assertEqual((fullDuring.body as { error?: string }).error, 'building', '409 body names the building state');
    assertEqual(mock.sent.length, sentBefore, 'full request during a running build sends no frame');
    assertEqual(registry.firmwareInfo()?.version, '12.0', 'full request during a running build leaves the cached firmware intact');
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

// ── 6b. FULL-mode firmware gate: full capture is allowed only on a firmware the model's full capture is
//    verified on (FM3 <= 12.0 here), and refused above it and on unknown firmware (FM3 13.0's walk would not
//    stop at a block's end and would write sweep values to non-existent params); read-only mode is never
//    gated. Service-level, via the walkImpl seam. ──
type GateOutcome = { code: number; body: Record<string, unknown>; walkCalls: number; walkModes: Array<string | undefined>; setFrames: number };

async function runGateScenario(fw: [number, number] | undefined, mode: 'full' | 'read-only'): Promise<GateOutcome> {
  const key = fw ? `11_${fw[0]}p${fw[1]}` : null;
  if (key) store.defaultStore.delDoc('deviceCaches', key);
  const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: true }), []);
  const { app, registry, mock } = await makeAppWithFake(FM3, fake, fw);
  try {
    const SET_FRAME = Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x02, 0x63, 0xf7]);
    const walkModes: Array<string | undefined> = [];
    const walk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => {
      walkModes.push(opts.mode);
      if (opts.write) await opts.write.send(SET_FRAME); // a full walk would write a sweep value
      return seedRecords();
    };
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { mode, walkImpl: walk });
    await deviceCache.cacheBuildPromise(registry);
    const k = (f: readonly number[]) => f.join(',');
    return { code: r.code, body: r.body as Record<string, unknown>, walkCalls: walkModes.length, walkModes, setFrames: mock.sent.filter((f) => k(f) === k([...SET_FRAME])).length };
  } finally {
    if (key) store.defaultStore.delDoc('deviceCaches', key);
    await app.close();
  }
}

async function fullFirmwareGate(): Promise<void> {
  // fw 12.0 → full allowed (existing behaviour): started, walk runs in full mode, the SET reaches the wire
  const ok = await runGateScenario([12, 0], 'full');
  assertEqual(ok.code, 200, 'full on fw 12.0 → 200');
  assertEqual(ok.body.started, true, 'full on fw 12.0 starts the build');
  assertEqual(ok.walkModes.join(','), 'full', 'fw 12.0 walk runs in full mode');
  assertEqual(ok.setFrames, 1, 'fw 12.0 full walk may write (SET reached the transport)');

  // fw 12.1 (just above the FM3's verified 12.0) → refused too: allowlist, not "major < 13"
  const justAbove = await runGateScenario([12, 1], 'full');
  assertEqual(justAbove.code, 501, 'full on fw 12.1 → 501');
  assertEqual(justAbove.body.reason, 'firmware', 'fw 12.1 refusal reason: firmware');
  assertEqual(justAbove.walkCalls, 0, 'fw 12.1 never walks');
  assertEqual(justAbove.setFrames, 0, 'fw 12.1 writes nothing');

  // fw 13.0 → refused: 501 fullCapture/firmware, the walk is never invoked and nothing is written
  const blocked = await runGateScenario([13, 0], 'full');
  assertEqual(blocked.code, 501, 'full on fw 13.0 → 501');
  assertEqual(blocked.body.error, 'unsupported', '501 keeps the unsupported error code');
  assertEqual(blocked.body.capability, 'fullCapture', '501 names the fullCapture capability');
  assertEqual(blocked.body.reason, 'firmware', '501 carries reason: firmware');
  assertEqual(blocked.body.firmware, '13.0', '501 reports the detected firmware');
  const blockedMsg = String(blocked.body.message);
  assert(/verified/.test(blockedMsg) && blockedMsg.includes('13.0') && /use read-only/.test(blockedMsg), '501 message names the detected firmware, says verified-only, and points at read-only');
  assert(!/FM3|firmware 13 and later/.test(blockedMsg), '501 message makes no model-specific claim');
  assertEqual(blocked.walkCalls, 0, 'refused full build never starts the walk');
  assertEqual(blocked.setFrames, 0, 'refused full build writes nothing to the device');

  // a later firmware is refused too (threshold is "13 and later")
  const later = await runGateScenario([14, 3], 'full');
  assertEqual(later.code, 501, 'full on fw 14.3 → 501');
  assertEqual(later.walkCalls, 0, 'fw 14.3 never walks');

  // unknown firmware (silent fn 0x08) → refused, firmware reported as null
  const unknown = await runGateScenario(undefined, 'full');
  assertEqual(unknown.code, 501, 'full on unknown firmware → 501');
  assertEqual(unknown.body.capability, 'fullCapture', 'unknown-firmware 501 names fullCapture');
  assertEqual(unknown.body.reason, 'firmware', 'unknown-firmware 501 carries reason: firmware');
  assertEqual(unknown.body.firmware, null, 'unknown-firmware 501 reports firmware null');
  const unknownMsg = String(unknown.body.message);
  assert(/re-detect/.test(unknownMsg) && !/read-only/.test(unknownMsg), 'unknown-firmware message says re-detect and does NOT offer read-only');
  assertEqual(unknown.walkCalls, 0, 'unknown firmware never walks');
  assertEqual(unknown.setFrames, 0, 'unknown firmware writes nothing');

  // read-only on fw 13.0 stays allowed: plain read-only walk (no mode, no write hooks), no SET frame
  const ro = await runGateScenario([13, 0], 'read-only');
  assertEqual(ro.code, 200, 'read-only on fw 13.0 → 200');
  assertEqual(ro.body.started, true, 'read-only on fw 13.0 starts the build');
  assertEqual(ro.walkModes.length, 1, 'read-only walk ran once');
  assertEqual(ro.walkModes[0], undefined, 'read-only walk passes no mode');
  assertEqual(ro.setFrames, 0, 'read-only walk writes nothing');
}

// Stale / unusable firmware: the full-capture gate never judges a version it did not just read.
//  - re-detect after the unit's firmware changed (or went silent) replaces / clears the cached version;
//  - a build request WITHOUT a re-detect re-reads the firmware right before gating;
//  - a reply for another model, or with major 0, is no version at all.
async function fullFirmwareFreshness(): Promise<void> {
  const state: { fw?: [number, number]; replyModel: number } = { fw: [12, 0], replyModel: FM3 };
  const mock = new MockTransport('serial', 'mock-0x11-mutable');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[5] === 0x08 && state.fw) return [firmwareReply(state.replyModel, ...state.fw)];
    return [];
  };
  const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: true }), []);
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  __setDriverForTest(registry, FM3, fake);
  await registry.detect();
  const app = await buildApp(registry);
  const SET_FRAME = Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x02, 0x63, 0xf7]);
  let walkCalls = 0;
  const walk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => {
    walkCalls++;
    if (opts.write) await opts.write.send(SET_FRAME);
    return seedRecords();
  };
  const full = () => deviceCache.startCacheBuild(store.defaultStore, registry, { mode: 'full', walkImpl: walk });
  const body = (r: { body: unknown }) => r.body as Record<string, unknown>;
  const fullCaps = async () => ((await app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { fullCapture: boolean } }).capabilities.fullCapture;
  const setFrames = () => mock.sent.filter((f) => f.join(',') === [...SET_FRAME].join(',')).length;
  store.defaultStore.delDoc('deviceCaches', KEY);
  try {
    assertEqual(registry.firmwareInfo()?.version, '12.0', 'initial detect reads 12.0');
    assertEqual(await fullCaps(), true, 'caps offer fullCapture on 12.0');

    // (a) unit now reports 13.0; re-detect replaces the cached version, caps follow, full is refused
    state.fw = [13, 0];
    await registry.detect();
    assertEqual(registry.firmwareInfo()?.version, '13.0', 're-detect picks up 13.0');
    assertEqual(await fullCaps(), false, 'caps withdraw fullCapture after re-detect on 13.0');
    let r = await full();
    assertEqual(r.code, 501, 'full after re-detect on 13.0 → 501');
    assertEqual(body(r).firmware, '13.0', 'refusal reports 13.0');

    // (b) unit goes silent; re-detect CLEARS the version (no stale 13.0 / 12.0 left behind) → refused, firmware null
    state.fw = undefined;
    await registry.detect();
    assertEqual(registry.firmwareInfo(), null, 're-detect on a silent unit clears the stale firmware');
    r = await full();
    assertEqual(r.code, 501, 'full on silent unit → 501');
    assertEqual(body(r).reason, 'firmware', 'silent unit refusal reason: firmware');
    assertEqual(body(r).firmware, null, 'silent unit refusal reports firmware null');

    // (c) detect on 12.0 again, then the unit changes WITHOUT a re-detect: the pre-gate re-read catches it
    state.fw = [12, 0];
    await registry.detect();
    assertEqual(registry.firmwareInfo()?.version, '12.0', 're-detect back on 12.0');
    state.fw = [13, 0]; // no re-detect
    r = await full();
    assertEqual(r.code, 501, 'stale 12.0 + unit now 13.0, no re-detect → pre-gate re-read refuses');
    assertEqual(body(r).firmware, '13.0', 'pre-gate re-read reports the fresh 13.0');
    assertEqual(registry.firmwareInfo()?.version, '13.0', 'pre-gate re-read refreshed the registry');
    state.fw = [12, 0];
    await registry.detect();
    state.fw = undefined; // goes silent, no re-detect
    r = await full();
    assertEqual(r.code, 501, 'stale 12.0 + unit now silent, no re-detect → refused');
    assertEqual(body(r).firmware, null, 'pre-gate re-read of a silent unit reports firmware null');
    assertEqual(registry.firmwareInfo(), null, 'pre-gate re-read cleared the stale version');
    assertEqual(walkCalls, 0, 'no refused request ever started a walk');
    assertEqual(setFrames(), 0, 'no refused request wrote to the device');

    // (d) a reply carrying another model byte, or major 0, is treated as unknown
    state.fw = [12, 0]; state.replyModel = 0x12;
    await registry.detect();
    assertEqual(registry.firmwareInfo(), null, 'firmware reply for another model is ignored');
    r = await full();
    assertEqual(r.code, 501, 'full with a wrong-model firmware reply → 501');
    state.replyModel = FM3; state.fw = [0, 5];
    await registry.detect();
    assertEqual(registry.firmwareInfo(), null, 'firmware major 0 is ignored');
    r = await full();
    assertEqual(r.code, 501, 'full with major 0 → 501');
    assertEqual(walkCalls, 0, 'wrong-model / major-0 refusals never walked');

    // (e) the re-read also lets a verified unit through again without a re-detect
    state.fw = [12, 0];
    r = await full();
    assertEqual(r.code, 200, 'verified firmware seen only by the pre-gate re-read → allowed');
    assertEqual(body(r).started, true, 'full build started');
    await deviceCache.cacheBuildPromise(registry);
    assertEqual(walkCalls, 1, 'the allowed request walked exactly once');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// Same gate over HTTP: POST body `mode` plumbing + the 501 response shape.
async function fullFirmwareGateHttp(): Promise<void> {
  const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: true }), []);
  const { app, registry } = await makeAppWithFake(FM3, fake, [13, 0]);
  try {
    const res = await app.inject({ method: 'POST', url: '/device/cache/build', payload: { mode: 'full' } });
    assertEqual(res.statusCode, 501, 'HTTP full on fw 13.0 → 501');
    const b = res.json() as { error?: string; capability?: string; reason?: string; firmware?: string | null; message?: string };
    assertEqual(b.error, 'unsupported', 'HTTP 501 error');
    assertEqual(b.capability, 'fullCapture', 'HTTP 501 capability');
    assertEqual(b.reason, 'firmware', 'HTTP 501 reason');
    assertEqual(b.firmware, '13.0', 'HTTP 501 firmware');
    assert(typeof b.message === 'string' && b.message.length > 0, 'HTTP 501 carries a message');
    assertEqual(deviceCache.cacheBuildPromise(registry), null, 'refused full build leaves no job running');
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
  await fullFirmwareGate();
  await fullFirmwareFreshness();
  await fullFirmwareGateHttp();
  await replyMatcher();
}
