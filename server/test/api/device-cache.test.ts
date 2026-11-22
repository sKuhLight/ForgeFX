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
import { buildDefQuery, enumHintsFromRanges, VIEW_DEFINITION, CACHE_SCHEMA } from 'forgefx-midi/cache';
import { PROFILES } from '../../src/devices.js';
import { FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import type { DeviceEvent, DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const DEVICE_CACHE_CASE_COUNT = 17;

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

export function seedRecords(): CacheRecord[] {
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

/** A build doc with a distinctive DISTORT (amp) roster — proves the runtime profile serves it. Stamped
 *  with the current schema, so it is a usable profile. */
export function fakeCacheDoc(): BuiltCache {
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
    meta: { schema: CACHE_SCHEMA, recordCount: 2, builtAt: '2026-07-12T00:00:00.000Z', source: 'live' }
  };
}

/** The hard ceiling the walk received for `block` (undefined = no entry, so the codec default applies). */
const boundOf = (opts: LiveWalkOptions, block: number): number | undefined => opts.paramBoundByBlock?.[block];
/** The known table size the walk received for `block` (undefined = no entry). */
const sizeOf = (opts: LiveWalkOptions, block: number): number | undefined => opts.paramKnownSizeByBlock?.[block];

/** A stored profile with the given per-family section strides and provenance, for the limit derivation.
 *  `rowsOf` lists a family's rows as ids 0..n-1 (what a byte-exact cache carries for its own id space). */
export function sectionsDoc(sections: Record<string, number>, meta: Record<string, unknown>, rowsOf: Record<string, number> = {}): BuiltCache {
  const base = fakeCacheDoc();
  const rangeSections = Object.fromEntries(Object.entries(sections).map(([fam, n]) => [fam, { sectionTag: 1, stride: n, recordCount: n }]));
  const ranges = Object.fromEntries(Object.entries(rowsOf).map(([fam, n]) => [
    fam,
    Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { kind: 'float', displayMin: 0, displayMax: 1, typecode: 0 }]))
  ]));
  return { ...base, rangeSections, ranges, meta: { ...base.meta, ...meta } as BuiltCache['meta'] } as BuiltCache;
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
      // default build is READ-ONLY: no mode, no write hooks
      assertEqual(opts.mode, undefined, 'default build passes no mode (read-only)');
      assertEqual(opts.write, undefined, 'read-only build passes no write hooks');
      // per-block limits come from the catalog's table strides: a known size for the instances the unit
      // has (early stop off below it) and a hard ceiling of stride - 1 + 32, capped at 127 in read-only
      const bounds = Object.values(opts.paramBoundByBlock ?? {});
      assert(bounds.length > 0, 'read-only build passes per-block ceilings from the catalog');
      assert(bounds.every((b) => b <= 127), 'no read-only ceiling above the 127 envelope');
      assertEqual(sizeOf(opts, 78), 29, 'FM3 chorus known size is its 29-slot stride');
      assertEqual(boundOf(opts, 78), 60, 'FM3 chorus ceiling is 29 - 1 + 32');
      assertEqual(sizeOf(opts, 80), undefined, 'a chorus instance the FM3 does not have gets no known size');
      assertEqual(boundOf(opts, 80), 60, 'a missing instance still gets the hard ceiling');
      assertEqual(sizeOf(opts, 58), 144, 'FM3 amp known size is its 144-slot stride');
      assertEqual(boundOf(opts, 58), 127, 'FM3 amp ceiling is capped at 127 in read-only');
      assertEqual(sizeOf(opts, 1), undefined, 'FM3 global is not a contiguous table: no known size');
      assertEqual(boundOf(opts, 1), 127, 'FM3 global ceiling (131 + 32) is capped at 127 in read-only');
      assertEqual(sizeOf(opts, 0), undefined, 'block 0 has no known size');
      assertEqual(boundOf(opts, 0), undefined, 'read-only needs no entry for an unknown block (the default is already 127)');
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
      assertEqual(opts.maxParamId, 511, 'full build keeps 511 as the cap, never the 14-bit space');
      const all = Object.values(opts.paramBoundByBlock ?? {});
      assertEqual(all.length, 256, 'full mode bounds every block of the effect-id byte, known or not');
      assert(all.every((b) => b <= 511), 'every full-mode ceiling is below 512');
      assert(!all.includes(16383), 'no ceiling reaches the 14-bit space');
      // FM3 catalog strides: DISTORT 144, CABINET 106 (recordCount 110 also counts special records), DELAY 88
      assertEqual(sizeOf(opts, 58), 144, 'FM3 amp (instance 1) known size 144');
      assertEqual(boundOf(opts, 58), 175, 'FM3 amp ceiling 144 - 1 + 32');
      for (const eid of [59, 60, 61]) {
        assertEqual(sizeOf(opts, eid), undefined, `FM3 amp eid ${eid} is an instance the unit lacks: no known size`);
        assertEqual(boundOf(opts, eid), 175, `FM3 amp eid ${eid} still gets the hard ceiling`);
      }
      assertEqual(sizeOf(opts, 62), 106, 'FM3 cab known size is its stride 106, not the record count 110');
      assertEqual(boundOf(opts, 62), 137, 'FM3 cab ceiling 106 - 1 + 32');
      assertEqual(sizeOf(opts, 71), 88, 'FM3 delay instance 2 exists');
      assertEqual(sizeOf(opts, 72), undefined, 'FM3 delay instance 3 does not');
      assertEqual(boundOf(opts, 70), 119, 'FM3 delay ceiling 88 - 1 + 32');
      assertEqual(sizeOf(opts, 1), undefined, 'FM3 global (virtual eid 1) is not a contiguous table: no known size');
      assertEqual(boundOf(opts, 1), 163, 'FM3 global ceiling is its low region end 131 + 32');
      assertEqual(sizeOf(opts, 2), 130, 'FM3 controllers (virtual eid 2) known size 130');
      assertEqual(boundOf(opts, 2), 161, 'FM3 controllers ceiling 130 - 1 + 32');
      // blocks with no known size (incl. block 0) are capped at the HW-proven 127, not left at 511
      for (const eid of [0, 36, 134, 142, 190, 199]) {
        assertEqual(sizeOf(opts, eid), undefined, `eid ${eid} has no known table size`);
        assertEqual(boundOf(opts, eid), 127, `eid ${eid} is capped at 127 in full mode`);
      }
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

// ── 8. walkBlockLimits: derivation from the static catalog (pure, no device) ──
async function walkBoundDerivation(): Promise<void> {
  const full = deviceCache.walkBlockLimits(FM3, 'full');
  const ro = deviceCache.walkBlockLimits(FM3, 'read-only');
  assertEqual(full.knownSize[58], 144, 'FM3 full: DISTORT known size 144');
  assertEqual(full.bound[58], 175, 'FM3 full: DISTORT ceiling 144 - 1 + 32');
  assertEqual(full.knownSize[78], 29, 'FM3 full: CHORUS known size 29');
  assertEqual(full.bound[78], 60, 'FM3 full: CHORUS ceiling 60');
  assertEqual(ro.knownSize[78], 29, 'FM3 read-only: CHORUS known size 29');
  assertEqual(ro.bound[78], 60, 'FM3 read-only: CHORUS ceiling 60');
  assertEqual(ro.knownSize[58], 144, 'FM3 read-only: the known size is passed whole');
  assertEqual(ro.bound[58], 127, 'FM3 read-only: DISTORT ceiling capped at 127');
  assert(Object.values(ro.bound).every((b) => b <= 127), 'read-only ceilings never exceed 127');
  assert(Object.values(full.bound).every((b) => b <= 511), 'full ceilings never exceed 511');
  for (const eid of Object.keys(full.bound).map(Number)) assert(eid >= 0 && eid <= 255, `limit key ${eid} is an effect-id byte`);
  // a known size always has a ceiling that covers its table (nothing the catalog knows is cut), except by the mode cap
  for (const eid of Object.keys(full.knownSize).map(Number)) assert(full.bound[eid]! >= full.knownSize[eid]! - 1, `full ceiling of ${eid} covers its known table`);
  for (const eid of Object.keys(ro.knownSize).map(Number)) assert(ro.bound[eid] !== undefined, `read-only known size of ${eid} comes with a ceiling`);

  // (1) the known size is the wire STRIDE, not the record count: FM3 CABINET has 110 records but ids 0..105
  assertEqual(full.knownSize[62], 106, 'FM3 CABINET known size is the stride 106, not recordCount 110');
  assertEqual(full.bound[62], 137, 'FM3 CABINET ceiling 106 - 1 + 32');
  // (1) a section that is not a contiguous table gets NO known size and a bound from its low region
  assertEqual(full.knownSize[1], undefined, 'FM3 GLOBAL: no known size');
  assertEqual(full.bound[1], 163, 'FM3 GLOBAL full: last low contiguous id 131 + 32');
  assertEqual(ro.knownSize[1], undefined, 'FM3 GLOBAL read-only: no known size');
  assertEqual(ro.bound[1], 127, 'FM3 GLOBAL read-only: capped at 127');
  const fm9 = deviceCache.walkBlockLimits(0x12, 'full');
  assertEqual(fm9.knownSize[1], undefined, 'FM9 GLOBAL: no known size');
  assertEqual(fm9.bound[1], 178, 'FM9 GLOBAL full: 146 + 32');
  const axe3 = deviceCache.walkBlockLimits(0x10, 'full');
  assertEqual(axe3.knownSize[1], undefined, 'Axe-Fx III GLOBAL: no known size');
  assertEqual(axe3.bound[1], 165, 'Axe-Fx III GLOBAL full: 133 + 32');
  assertEqual(deviceCache.walkBlockLimits(0x12, 'read-only').bound[1], 127, 'FM9 GLOBAL read-only: capped at 127');
  assertEqual(deviceCache.walkBlockLimits(0x10, 'read-only').bound[1], 127, 'Axe-Fx III GLOBAL read-only: capped at 127');
  // every other mapped family is a contiguous table (the catalog's ordinary ids all fit below its stride)
  for (const [name, lim, eids] of [['FM3', full, [2, 3, 37, 46, 58, 62, 66, 70, 78, 114, 118, 126]], ['FM9', fm9, [2, 3, 58, 62, 70, 78, 114, 118, 126]], ['III', axe3, [2, 3, 58, 62, 70, 78, 114, 118, 126]]] as const) {
    for (const eid of eids) assert(lim.knownSize[eid] !== undefined, `${name} eid ${eid} is a contiguous table with a known size`);
  }

  // (3) the known size only goes to instances the unit has (instanceLimits[slug] ?? defaultInstances)
  for (const [eid, known] of [[58, true], [59, false], [60, false], [61, false], [70, true], [71, true], [72, false], [73, false]] as const) {
    assertEqual(full.knownSize[eid] !== undefined, known, `FM3 eid ${eid} known size iff the instance exists`);
    assert(full.bound[eid] !== undefined && full.bound[eid]! > 0, `FM3 eid ${eid} always has a hard ceiling`);
  }
  assertEqual(full.bound[59], full.bound[58], 'a missing instance shares the family ceiling');
  assertEqual(fm9.knownSize[59], 147, 'FM9 has two amps: instance 2 is known');
  assertEqual(fm9.knownSize[60], undefined, 'FM9 amp instance 3 is not');
  assertEqual(axe3.knownSize[73], 89, 'the Axe-Fx III has four delays: instance 4 is known');
  assertEqual(axe3.knownSize[60], undefined, 'the Axe-Fx III has two amps: instance 3 is not');
  assertEqual(axe3.bound[60], 173, 'a missing III amp instance still gets the ceiling 142 - 1 + 32');

  // (4) unknown blocks: FULL caps them at the HW-proven 127 (block 0 included), read-only needs no entry
  for (const eid of [0, 36, 134, 142, 190, 199, 200, 255]) {
    assertEqual(full.knownSize[eid], undefined, `eid ${eid}: no known size`);
    assertEqual(full.bound[eid], 127, `eid ${eid}: full mode caps an unknown block at 127`);
    assertEqual(ro.knownSize[eid], undefined, `eid ${eid}: read-only no known size`);
    assertEqual(ro.bound[eid], undefined, `eid ${eid}: read-only no entry (default 127)`);
  }
  assertEqual(Object.keys(full.bound).length, 256, 'full mode: every block has a ceiling');

  // other models resolve through their own catalog; instances of a family share the ceiling
  for (const eid of [70, 71, 72, 73]) assertEqual(fm9.bound[eid], 122, `FM9 delay eid ${eid} ceiling 91 - 1 + 32`);
  assertEqual(fm9.knownSize[70], 91, 'FM9 delay known size 91');
  assertEqual(fm9.bound[58], 178, 'FM9 full: DISTORT 147 slots, ceiling 178');
  assertEqual(axe3.bound[58], 173, 'Axe-Fx III full: DISTORT 142 slots, ceiling 173 (audio eids resolve without a profile effect-id table)');
  assertEqual(axe3.knownSize[62], 106, 'Axe-Fx III full: CABINET known size is the stride 106');
  // no gen-3 catalog: no entries, codec defaults everywhere
  for (const [model, mode] of [[0x15, 'full'], [0x14, 'read-only']] as const) {
    const none = deviceCache.walkBlockLimits(model, mode);
    assertEqual(Object.keys(none.knownSize).length + Object.keys(none.bound).length, 0, `model 0x${model.toString(16)} has no gen-3 catalog, so no limits`);
  }

  // a BYTE-EXACT stored profile refines the catalog per family (wins outright, larger or smaller)...
  const exact = sectionsDoc({ DISTORT: 150, CHORUS: 20 }, { source: 'editor-cache' }, { DISTORT: 150, CHORUS: 20 });
  const withExact = deviceCache.walkBlockLimits(FM3, 'full', exact);
  assertEqual(withExact.knownSize[58], 150, 'editor-cache DISTORT 150 slots is the known size (larger than the catalog)');
  assertEqual(withExact.bound[58], 181, 'editor-cache DISTORT ceiling 150 - 1 + 32');
  assertEqual(withExact.knownSize[78], 20, 'editor-cache CHORUS 20 slots is the known size (exact data also shrinks)');
  assertEqual(withExact.bound[78], 51, 'editor-cache CHORUS ceiling 20 - 1 + 32');
  assertEqual(withExact.bound[70], 119, 'a family the stored profile does not carry keeps the catalog size');
  assertEqual(deviceCache.walkBlockLimits(FM3, 'read-only', exact).bound[78], 51, 'read-only uses the same sizes below the 127 cap');
  // an exact cache whose rows run past its stride is not a contiguous table: no known size, bound from the rows
  const wide = sectionsDoc({ CHORUS: 20 }, { source: 'editor-cache' }, { CHORUS: 29 });
  const withWide = deviceCache.walkBlockLimits(FM3, 'full', wide);
  assertEqual(withWide.knownSize[78], undefined, 'rows beyond the stride: no known size');
  assertEqual(withWide.bound[78], 60, 'rows beyond the stride: bound from the low region end 28 + 32');
  // an exact cache without rows for the family is judged by the catalog's ids (CHORUS ids reach 28)
  const noRows = sectionsDoc({ CHORUS: 20 }, { source: 'editor-cache' });
  assertEqual(deviceCache.walkBlockLimits(FM3, 'full', noRows).knownSize[78], undefined, 'catalog ids beyond an exact stride: no known size');
  const cloudBytes = sectionsDoc({ DISTORT: 150 }, { source: 'cloud', origin: 'bytes' }, { DISTORT: 150 });
  assertEqual(deviceCache.walkBlockLimits(FM3, 'full', cloudBytes).knownSize[58], 150, 'a cloud profile of byte origin is exact');
  // (5) an UNUSABLE exact stride falls back to the catalog's stride; the family is not dropped
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const doc = sectionsDoc({ DISTORT: bad, CHORUS: 20 }, { source: 'editor-cache' }, { CHORUS: 20 });
    const l = deviceCache.walkBlockLimits(FM3, 'full', doc);
    assertEqual(l.knownSize[58], 144, `exact DISTORT stride ${bad} falls back to the catalog stride 144`);
    assertEqual(l.bound[58], 175, `exact DISTORT stride ${bad} falls back to the catalog ceiling`);
    assertEqual(l.knownSize[78], 20, `the usable CHORUS stride of the same doc still applies (${bad})`);
  }
  // ...but a LIVE-walk profile (or unknown provenance) never moves a limit: its sizes are a heuristic
  for (const meta of [{ source: 'live' }, { source: 'cloud', origin: 'live' }, { source: undefined }]) {
    const doc = sectionsDoc({ DISTORT: 442, CHORUS: 5 }, meta, { DISTORT: 442, CHORUS: 5 });
    const l = deviceCache.walkBlockLimits(FM3, 'full', doc);
    assertEqual(l.knownSize[58], 144, `${JSON.stringify(meta)} profile does not raise the DISTORT size`);
    assertEqual(l.bound[58], 175, `${JSON.stringify(meta)} profile does not raise the DISTORT ceiling`);
    assertEqual(l.knownSize[78], 29, `${JSON.stringify(meta)} profile does not shrink the CHORUS size`);
    assertEqual(l.bound[78], 60, `${JSON.stringify(meta)} profile does not shrink the CHORUS ceiling`);
  }
}

// ── 9. a force-rebuild over a byte-exact stored cache walks with ITS sizes (store to walk options) ──
async function walkBoundFromStoredCache(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  store.defaultStore.putDoc('deviceCaches', KEY, sectionsDoc({ CHORUS: 40 }, { source: 'editor-cache' }, { CHORUS: 40 }));
  const { app, registry } = await makeApp(FM3, { fw: [12, 0] });
  try {
    let seen: LiveWalkOptions | null = null;
    const spyWalk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => { seen = opts; return seedRecords(); };
    const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { force: true, walkImpl: spyWalk });
    assertEqual((r.body as { started?: boolean }).started, true, 'forced rebuild started');
    await deviceCache.cacheBuildPromise(registry);
    assert(seen != null, 'walk invoked');
    assertEqual(sizeOf(seen!, 78), 40, 'stored byte-exact CHORUS (40 slots) is the known size, not the catalog 29');
    assertEqual(boundOf(seen!, 78), 71, 'stored byte-exact CHORUS ceiling is 40 - 1 + 32, not the catalog 60');
    assertEqual(sizeOf(seen!, 62), 106, 'a family the stored cache does not carry keeps the catalog stride');
    assertEqual(boundOf(seen!, 62), 127, 'catalog CABINET ceiling 137 is capped at 127 in read-only');
    assertEqual(seen!.maxParamId, 127, 'read-only ceiling unchanged');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// ── 6b. FULL-mode firmware gate: full capture is allowed only on a firmware inside the range the model's full
//    capture is verified on (FM3 12.0 to 13.0 here), and refused below and above it and on unknown firmware (a
//    firmware can move the table ends the walk relies on; an older one was never exercised); read-only mode is
//    never gated. Service-level, via the walkImpl seam. ──
type GateOutcome = { code: number; body: Record<string, unknown>; walkCalls: number; walkModes: Array<string | undefined>; setFrames: number; docStored: boolean };

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
    const docStored = key ? store.defaultStore.getDoc('deviceCaches', key) != null : false;
    return { code: r.code, body: r.body as Record<string, unknown>, walkCalls: walkModes.length, walkModes, setFrames: mock.sent.filter((f) => k(f) === k([...SET_FRAME])).length, docStored };
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

  // fw 13.0 (the FM3's verified version) → allowed
  const ok13 = await runGateScenario([13, 0], 'full');
  assertEqual(ok13.code, 200, 'full on fw 13.0 → 200');
  assertEqual(ok13.walkModes.join(','), 'full', 'fw 13.0 walk runs in full mode');

  // fw 11.99 (just below the FM3's verified range, which starts at 12.0) → refused: a range with a floor, not just a ceiling
  const justBelow = await runGateScenario([11, 99], 'full');
  assertEqual(justBelow.code, 501, 'full on fw 11.99 → 501');
  assertEqual(justBelow.body.error, 'unsupported', 'fw 11.99 501 keeps the unsupported error code');
  assertEqual(justBelow.body.capability, 'fullCapture', 'fw 11.99 501 names the fullCapture capability');
  assertEqual(justBelow.body.reason, 'firmware', 'fw 11.99 refusal reason: firmware');
  assertEqual(justBelow.body.firmware, '11.99', 'fw 11.99 501 reports the detected firmware');
  assertEqual(justBelow.walkCalls, 0, 'fw 11.99 never walks');
  assertEqual(justBelow.setFrames, 0, 'fw 11.99 writes nothing');

  // fw 5.3 (a real tester firmware far below anything a full capture ran on) → refused the same way
  const old = await runGateScenario([5, 3], 'full');
  assertEqual(old.code, 501, 'full on fw 5.3 → 501');
  assertEqual(old.body.error, 'unsupported', 'fw 5.3 501 keeps the unsupported error code');
  assertEqual(old.body.capability, 'fullCapture', 'fw 5.3 501 names the fullCapture capability');
  assertEqual(old.body.reason, 'firmware', 'fw 5.3 refusal reason: firmware');
  assertEqual(old.body.firmware, '5.3', 'fw 5.3 501 reports the detected firmware');
  const oldMsg = String(old.body.message);
  assert(/verified/.test(oldMsg) && oldMsg.includes('5.3') && /use read-only/.test(oldMsg), 'fw 5.3 501 message names the firmware, says verified-only, and points at read-only');
  assertEqual(old.walkCalls, 0, 'fw 5.3 never walks');
  assertEqual(old.setFrames, 0, 'fw 5.3 writes nothing');
  assertEqual(old.docStored, false, 'fw 5.3 refusal stored no device cache');
  assertEqual(justBelow.docStored, false, 'fw 11.99 refusal stored no device cache');

  // fw 13.1 (just above the FM3's verified 13.0) → refused: allowlist, not "major < 14"
  const justAbove = await runGateScenario([13, 1], 'full');
  assertEqual(justAbove.code, 501, 'full on fw 13.1 → 501');
  assertEqual(justAbove.body.reason, 'firmware', 'fw 13.1 refusal reason: firmware');
  assertEqual(justAbove.walkCalls, 0, 'fw 13.1 never walks');
  assertEqual(justAbove.setFrames, 0, 'fw 13.1 writes nothing');

  // fw 14.0 → refused: 501 fullCapture/firmware, the walk is never invoked and nothing is written
  const blocked = await runGateScenario([14, 0], 'full');
  assertEqual(blocked.code, 501, 'full on fw 14.0 → 501');
  assertEqual(blocked.body.error, 'unsupported', '501 keeps the unsupported error code');
  assertEqual(blocked.body.capability, 'fullCapture', '501 names the fullCapture capability');
  assertEqual(blocked.body.reason, 'firmware', '501 carries reason: firmware');
  assertEqual(blocked.body.firmware, '14.0', '501 reports the detected firmware');
  const blockedMsg = String(blocked.body.message);
  assert(/verified/.test(blockedMsg) && blockedMsg.includes('14.0') && /use read-only/.test(blockedMsg), '501 message names the detected firmware, says verified-only, and points at read-only');
  assert(!/FM3|firmware 14 and later/.test(blockedMsg), '501 message makes no model-specific claim');
  assertEqual(blocked.walkCalls, 0, 'refused full build never starts the walk');
  assertEqual(blocked.setFrames, 0, 'refused full build writes nothing to the device');

  // a later firmware is refused too
  const later = await runGateScenario([15, 3], 'full');
  assertEqual(later.code, 501, 'full on fw 15.3 → 501');
  assertEqual(later.walkCalls, 0, 'fw 15.3 never walks');

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

  // read-only on an unverified fw 14.0 stays allowed: plain read-only walk (no mode, no write hooks), no SET frame
  const ro = await runGateScenario([14, 0], 'read-only');
  assertEqual(ro.code, 200, 'read-only on fw 14.0 → 200');
  assertEqual(ro.body.started, true, 'read-only on fw 14.0 starts the build');
  assertEqual(ro.walkModes.length, 1, 'read-only walk ran once');
  assertEqual(ro.walkModes[0], undefined, 'read-only walk passes no mode');
  assertEqual(ro.setFrames, 0, 'read-only walk writes nothing');

  // read-only on a below-range fw 5.3 stays allowed too: the range only governs the writing full mode
  const roOld = await runGateScenario([5, 3], 'read-only');
  assertEqual(roOld.code, 200, 'read-only on fw 5.3 → 200');
  assertEqual(roOld.body.started, true, 'read-only on fw 5.3 starts the build');
  assertEqual(roOld.walkModes.length, 1, 'fw 5.3 read-only walk ran once');
  assertEqual(roOld.walkModes[0], undefined, 'fw 5.3 read-only walk passes no mode');
  assertEqual(roOld.setFrames, 0, 'fw 5.3 read-only walk writes nothing');
  assertEqual(roOld.docStored, true, 'fw 5.3 read-only build stored its device cache');
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

    // (a) unit now reports 14.0; re-detect replaces the cached version, caps follow, full is refused
    state.fw = [14, 0];
    await registry.detect();
    assertEqual(registry.firmwareInfo()?.version, '14.0', 're-detect picks up 14.0');
    assertEqual(await fullCaps(), false, 'caps withdraw fullCapture after re-detect on 14.0');
    let r = await full();
    assertEqual(r.code, 501, 'full after re-detect on 14.0 → 501');
    assertEqual(body(r).firmware, '14.0', 'refusal reports 14.0');

    // (b) unit goes silent; re-detect CLEARS the version (no stale 14.0 / 12.0 left behind) → refused, firmware null
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
    state.fw = [14, 0]; // no re-detect
    r = await full();
    assertEqual(r.code, 501, 'stale 12.0 + unit now 14.0, no re-detect → pre-gate re-read refuses');
    assertEqual(body(r).firmware, '14.0', 'pre-gate re-read reports the fresh 14.0');
    assertEqual(registry.firmwareInfo()?.version, '14.0', 'pre-gate re-read refreshed the registry');
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
  const { app, registry } = await makeAppWithFake(FM3, fake, [14, 0]);
  try {
    const res = await app.inject({ method: 'POST', url: '/device/cache/build', payload: { mode: 'full' } });
    assertEqual(res.statusCode, 501, 'HTTP full on fw 14.0 → 501');
    const b = res.json() as { error?: string; capability?: string; reason?: string; firmware?: string | null; message?: string };
    assertEqual(b.error, 'unsupported', 'HTTP 501 error');
    assertEqual(b.capability, 'fullCapture', 'HTTP 501 capability');
    assertEqual(b.reason, 'firmware', 'HTTP 501 reason');
    assertEqual(b.firmware, '14.0', 'HTTP 501 firmware');
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

// ── 10. walkEnumHints: label-list hints per block from the static catalog or a LOCAL byte import ──
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A stored profile carrying ENUM rows for one family, under the given provenance. */
function enumRowsDoc(meta: Record<string, unknown>, family: string, rows: Record<number, { enumCount: number; typecode: number }>): BuiltCache {
  const doc = sectionsDoc({}, meta);
  const ranges = { [family]: Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { kind: 'enum', displayMin: 0, displayMax: r.enumCount - 1, typecode: r.typecode, enumCount: r.enumCount }])) };
  return { ...doc, ranges } as unknown as BuiltCache;
}

async function enumHintDerivation(): Promise<void> {
  const catalogOf = (model: number, family: string) => enumHintsFromRanges(PROFILES[model]!.ranges[family] ?? {});
  const fm3 = deviceCache.walkEnumHints(FM3);
  // mapped effect blocks carry their family's catalog lists — every instance the model's roster has
  const distort = catalogOf(FM3, 'DISTORT');
  assert(Object.keys(distort).length > 0, 'the FM3 catalog has DISTORT enum rows');
  for (const eid of [58, 59, 60, 61]) assert(sameJson(fm3[eid], distort), `FM3 eid ${eid} carries the DISTORT catalog hints`);
  for (const eid of [70, 71, 72, 73]) assert(sameJson(fm3[eid], catalogOf(FM3, 'DELAY')), `FM3 delay instance eid ${eid} keyed through the roster`);
  assert(sameJson(fm3[66], catalogOf(FM3, 'REVERB')), 'FM3 eid 66 carries the REVERB hints');
  assert(sameJson(fm3[1], catalogOf(FM3, 'GLOBAL')), 'FM3 virtual eid 1 carries the GLOBAL hints');
  // every hint has a positive integer count and an integer typecode (the codec ignores anything else)
  for (const block of Object.values(fm3)) {
    for (const h of Object.values(block)) assert(Number.isInteger(h.count) && h.count >= 1 && Number.isInteger(h.typecode), `usable hint ${JSON.stringify(h)}`);
  }
  // blocks the static roster maps to no family get no hints (system selector, modifier copies, tuner, FC blocks)
  for (const eid of [0, 4, 34, 35, 199, 200, 255]) assertEqual(fm3[eid], undefined, `FM3 eid ${eid}: no hints`);
  // other models resolve through their own catalog, keyed the same way
  for (const [model, eids] of [[0x12, [58, 59, 60, 61]], [0x10, [70, 71, 72, 73]]] as const) {
    const h = deviceCache.walkEnumHints(model);
    const fam = eids[0] === 58 ? 'DISTORT' : 'DELAY';
    for (const eid of eids) assert(sameJson(h[eid], catalogOf(model, fam)), `model 0x${model.toString(16)} eid ${eid} carries its catalog's ${fam} hints`);
  }
  for (const model of [0x15, 0x14]) assertEqual(Object.keys(deviceCache.walkEnumHints(model)).length, 0, `model 0x${model.toString(16)}: no gen-3 catalog, no hints`);

  // a LOCAL byte-exact import supplies the rows of the families it carries (exact for the firmware) ...
  for (const meta of [{ source: 'editor-cache' }, { source: 'bytes' }]) {
    const doc = enumRowsDoc(meta, 'DISTORT', { 70: { enumCount: 26, typecode: 16 }, 21: { enumCount: 3, typecode: 16 } });
    const h = deviceCache.walkEnumHints(FM3, doc);
    for (const eid of [58, 59, 60, 61]) {
      assert(sameJson(h[eid], { 21: { count: 3, typecode: 16 }, 70: { count: 26, typecode: 16 } }), `${JSON.stringify(meta)}: eid ${eid} takes the import's DISTORT rows`);
    }
    assert(sameJson(h[66], catalogOf(FM3, 'REVERB')), `${JSON.stringify(meta)}: a family the import does not carry keeps the catalog hints`);
  }
  // ... an empty row set for a family falls back to the catalog ...
  const empty = { ...sectionsDoc({}, { source: 'editor-cache' }), ranges: { DISTORT: {} } } as unknown as BuiltCache;
  assert(sameJson(deviceCache.walkEnumHints(FM3, empty)[58], distort), 'empty byte-exact rows fall back to the catalog');
  // ... but a CLOUD profile never supplies hints, not even one claiming a byte origin (a crafted one with
  // rows that would label-walk a float), and neither does a live-walk profile or unknown provenance
  for (const meta of [{ source: 'cloud', origin: 'bytes' }, { source: 'cloud', origin: 'editor-cache' }, { source: 'cloud', origin: 'live' }, { source: 'live' }, { source: undefined }]) {
    const doc = enumRowsDoc(meta, 'DISTORT', { 70: { enumCount: 26, typecode: 16 }, 15: { enumCount: 2, typecode: 0 } });
    assert(sameJson(deviceCache.walkEnumHints(FM3, doc), fm3), `${JSON.stringify(meta)} profile: hints stay the catalog's`);
  }
  assertEqual(deviceCache.isLocalByteProfile({ source: 'cloud', origin: 'bytes' } as never), false, 'a byte-origin cloud profile is not a local byte import');
  assertEqual(deviceCache.isLocalByteProfile({ source: 'editor-cache' }), true, 'an editor-cache import is a local byte import');

  // the static roster's instance count per family and model (shared with walkBlockLimits)
  const iii = deviceCache.walkEnumHints(0x10);
  const iiiLimits = deviceCache.walkBlockLimits(0x10, 'full');
  assert(Object.keys(catalogOf(0x10, 'INPUT')).length > 0, 'the Axe-Fx III catalog has INPUT enum rows');
  assert(sameJson(iii[41], catalogOf(0x10, 'INPUT')), 'Axe-Fx III fifth Input (41) carries the INPUT hints');
  assertEqual(iiiLimits.knownSize[41], iiiLimits.knownSize[37], 'Axe-Fx III fifth Input (41) has the INPUT known size');
  for (const [model, name] of [[FM3, 'FM3'], [0x12, 'FM9']] as const) {
    const h = deviceCache.walkEnumHints(model);
    const l = deviceCache.walkBlockLimits(model, 'full');
    assertEqual(h[194], undefined, `${name}: a fourth multiplexer (194) is not in the roster, no hints`);
    assertEqual(l.knownSize[194], undefined, `${name}: 194 has no known size`);
    assertEqual(l.bound[194], 127, `${name}: 194 is an unknown block (127 in full mode)`);
    assert(h[193] !== undefined || Object.keys(catalogOf(model, 'MULTIPLEXER')).length === 0, `${name}: the third multiplexer (193) is mapped`);
    assert(l.bound[193] !== undefined && l.bound[193] !== 127, `${name}: 193 keeps the MULTIPLEXER ceiling`);
  }
  assertEqual(deviceCache.staticRoster(FM3).get(38)?.family, 'INPUT', 'FM3: the second Input (38, a device-true instance) is mapped');
  assertEqual(deviceCache.staticRoster(FM3).get(39), undefined, 'FM3: no third Input');
  assertEqual(deviceCache.staticRoster(0x12).get(40)?.instance, 4, 'FM9: four Inputs (37..40)');
  assertEqual(deviceCache.staticRoster(0x10).get(41)?.instance, 5, 'Axe-Fx III: five Inputs (37..41)');
}

// ── 11. the hints reach the walk options (store → walk): verified firmware only, both modes ──
async function enumHintsInWalkOptions(): Promise<void> {
  // the verified table: exact major.minor, fail closed
  assertEqual(deviceCache.enumHintsVerifiedOn(FM3, { major: 13, minor: 0 }), true, 'FM3 13.0 is verified');
  for (const [model, fw] of [[FM3, { major: 13, minor: 1 }], [FM3, { major: 12, minor: 0 }], [FM3, { major: 14, minor: 0 }], [FM3, null], [FM3, undefined], [FM3, { major: 0, minor: 0 }], [FM3, { major: 13.5, minor: 0 }], [0x12, { major: 13, minor: 0 }], [0x12, { major: 12, minor: 0 }], [0x10, { major: 32, minor: 6 }], [0x15, { major: 13, minor: 0 }]] as const) {
    assertEqual(deviceCache.enumHintsVerifiedOn(model, fw), false, `model 0x${model.toString(16)} fw ${JSON.stringify(fw)}: hints off`);
  }
  const catalog = deviceCache.walkEnumHints(FM3);
  const KEY13 = '11_13p0';
  const spyBuild = async (fw: [number, number], opts: { force?: boolean } = {}): Promise<LiveWalkOptions> => {
    const { app, registry } = await makeApp(FM3, { fw });
    try {
      let seen: LiveWalkOptions | null = null;
      const spy = async (_t: unknown, o: LiveWalkOptions): Promise<CacheRecord[]> => { seen = o; return seedRecords(); };
      await deviceCache.startCacheBuild(store.defaultStore, registry, { ...opts, walkImpl: spy });
      await deviceCache.cacheBuildPromise(registry);
      assert(seen != null, `walk invoked (fw ${fw.join('.')})`);
      return seen!;
    } finally {
      await app.close();
    }
  };
  // FM3 13.0, read-only, nothing stored: the catalog hints
  store.defaultStore.delDoc('deviceCaches', KEY13);
  try {
    const ro = await spyBuild([13, 0]);
    assertEqual(ro.mode, undefined, 'read-only walk');
    assert(sameJson(ro.enumHintByBlock, catalog), 'FM3 13.0 read-only walk gets the catalog hints');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY13);
  }
  // an unverified firmware gets no hints at all (the key is absent, the codec keeps its numeric rule)
  for (const fw of [[12, 0], [13, 1]] as Array<[number, number]>) {
    const key = `11_${fw[0]}p${fw[1]}`;
    store.defaultStore.delDoc('deviceCaches', key);
    try {
      const o = await spyBuild(fw);
      assert(!('enumHintByBlock' in o), `FM3 ${fw.join('.')}: no enumHintByBlock in the walk options`);
    } finally {
      store.defaultStore.delDoc('deviceCaches', key);
    }
  }
  // force-rebuild over a stored local import: its rows; over a byte-origin CLOUD profile or a LIVE profile: the catalog
  for (const [meta, want] of [
    [{ source: 'editor-cache' }, { 70: { count: 26, typecode: 16 } }],
    [{ source: 'cloud', origin: 'bytes' }, catalog[58]],
    [{ source: 'live' }, catalog[58]],
  ] as const) {
    store.defaultStore.putDoc('deviceCaches', KEY13, enumRowsDoc(meta, 'DISTORT', { 70: { enumCount: 26, typecode: 16 } }));
    try {
      const o = await spyBuild([13, 0], { force: true });
      assert(sameJson(o.enumHintByBlock?.[58], want), `stored ${JSON.stringify(meta)} profile: eid 58 hints ${JSON.stringify(o.enumHintByBlock?.[58])}`);
      assert(sameJson(o.enumHintByBlock?.[66], catalog[66]), `stored ${JSON.stringify(meta)} profile: other families keep the catalog hints`);
    } finally {
      store.defaultStore.delDoc('deviceCaches', KEY13);
    }
  }
  // full mode on FM3 13.0 carries the same hints
  {
    const fake = makeGen3Fake(gen3FakeCaps({ fullCapture: true }), []);
    const { app, registry } = await makeAppWithFake(FM3, fake, [13, 0]);
    try {
      let seen: LiveWalkOptions | null = null;
      const spy = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => { seen = opts; return seedRecords(); };
      const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { mode: 'full', walkImpl: spy });
      assertEqual((r.body as { started?: boolean }).started, true, 'full build started');
      await deviceCache.cacheBuildPromise(registry);
      assertEqual(seen!.mode, 'full', 'full walk');
      assert(sameJson(seen!.enumHintByBlock, catalog), 'full walk on FM3 13.0 gets the catalog hints');
    } finally {
      store.defaultStore.delDoc('deviceCaches', KEY13);
      await app.close();
    }
  }
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
  await walkBoundDerivation();
  await walkBoundFromStoredCache();
  await enumHintDerivation();
  await enumHintsInWalkOptions();
  await fullFirmwareGate();
  await fullFirmwareFreshness();
  await fullFirmwareGateHttp();
  await replyMatcher();
}
