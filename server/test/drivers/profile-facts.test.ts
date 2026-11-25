// Runtime-profile facts — what `runtimeProfileFrom` records about the profile it layers over the bundled
// catalog (provenance, the raw rows, which rows the merge took, which families the section-assignment
// cross-check refused), and the registry reverting to the bundled profile when no usable profile applies
// any more (a delete, a firmware without a profile, an unknown firmware). Synthetic and committed catalog
// data only; mocked transport, NO hardware.
import '../helpers/env.js';
import { runtimeProfileFrom, isByteExactProfile, PROFILES, type DeviceProfile } from '../../src/devices.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { CACHE_SCHEMA, type BuiltCache } from 'forgefx-midi/cache';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';

export const PROFILE_FACTS_CASE_COUNT = 9;

const FM3 = 0x11;
const FM3_STATIC = PROFILES[FM3]!;

/** Run `fn` with console.warn collected. */
function collectWarnings<T>(fn: () => T): { result: T; lines: string[] } {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { return { result: fn(), lines }; } finally { console.warn = orig; }
}

// ── a hand-built static profile with a few rows, like walk-reclassification's ──
const DISTORT = 'DISTORT';
const KIND_CONFLICT_PID = 21; // catalog enum, the walk says float
const REFINED_PID = 114; // catalog float, the walk float with a refined range
const NEW_PID = 999; // not in the catalog
const GAP_PID = 500; // only a placeholder row ever mentions it

function synthStatic(): DeviceProfile {
  return {
    model: FM3, key: 'fm3', name: 'FM3-profile-facts-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {}, params: {},
    ranges: {
      [DISTORT]: {
        [KIND_CONFLICT_PID]: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10 },
        [REFINED_PID]: { kind: 'float', displayMin: -200, displayMax: 200, scale: 1, step: 0, typecode: 0x531 },
      },
    },
    rangeSections: {}, rosterFor: () => [], enumLabelsFor: () => undefined, cabIrs: () => ({}),
    familyForEffectId: () => undefined, layoutFor: () => undefined, catalogFirmware: '12.0',
  } as unknown as DeviceProfile;
}

function synthBuilt(meta: Record<string, unknown> | undefined, extra: Partial<BuiltCache> = {}): BuiltCache {
  const ph = (kind: 'float' | 'enum') => ({ kind, displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 });
  return {
    enumOverrides: {}, rosters: {}, cabIrs: {}, rangeSections: {},
    ...(meta ? { meta } : {}),
    ranges: {
      [DISTORT]: {
        [KIND_CONFLICT_PID]: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10 },
        [REFINED_PID]: { kind: 'float', displayMin: -300, displayMax: 300, scale: 1, step: 0, typecode: 0x531 },
        [NEW_PID]: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x20 },
        [GAP_PID]: ph('float'),
      },
    },
    ...extra,
  } as unknown as BuiltCache;
}

// ── 1. provenance per meta ──
function provenance(): void {
  const table: Array<[string, Record<string, unknown> | undefined, string, boolean]> = [
    ['editor-cache', { source: 'editor-cache' }, 'editor-cache', true],
    ["the codec's raw byte source", { source: 'bytes' }, 'editor-cache', true],
    ['live', { source: 'live' }, 'live', false],
    ['cloud published from an editor cache', { source: 'cloud', origin: 'bytes' }, 'cloud', true],
    ['cloud published from a live walk', { source: 'cloud', origin: 'live' }, 'cloud', false],
    ['cloud without an origin', { source: 'cloud' }, 'cloud', false],
    ['no source', { recordCount: 3 }, 'unknown', false],
    ['an unknown source', { source: 'from-the-future' }, 'unknown', false],
    ['no meta at all', undefined, 'unknown', false],
  ];
  for (const [label, meta, source, byteExact] of table) {
    const p = runtimeProfileFrom(synthBuilt(meta), synthStatic());
    assertEqual(p.profileFacts?.source, source, `${label}: source`);
    assertEqual(p.profileFacts?.byteExact, byteExact, `${label}: byteExact`);
    assertEqual(p.profileFacts?.byteExact, isByteExactProfile(meta), `${label}: byteExact is isByteExactProfile`);
  }
}

// ── 2. the facts carry the profile's own data; the static profile carries none ──
function factsAndStatic(): void {
  const built = catalogBuilt(FM3);
  const p = runtimeProfileFrom(built, FM3_STATIC);
  const f = p.profileFacts!;
  assertEqual(f.firmware, '12.0', 'firmware comes from the doc');
  assert(f.ranges === built.ranges, 'ranges are the built rows verbatim (same object)');
  assert(f.enumLabels === built.enumOverrides, 'enumLabels are the built enumOverrides verbatim (same object)');
  assertEqual(f.suspectFamilies.length, 0, 'the catalog read back as a profile has no suspect family');
  assert(p.staticBase === FM3_STATIC, 'staticBase is the static profile it was layered over');
  assertEqual(p.catalogFirmware, '12.0', 'a runtime profile keeps the static profile\'s catalog firmware');
  // layering again over a runtime profile still points at the bundled one
  assert(runtimeProfileFrom(built, p).staticBase === FM3_STATIC, 'staticBase never chains through a runtime profile');

  assertEqual(FM3_STATIC.profileFacts, undefined, 'a static profile has no profileFacts');
  assertEqual(FM3_STATIC.staticBase, undefined, 'a static profile has no staticBase');
  assertEqual(PROFILES[0x11]!.catalogFirmware, '12.0', 'FM3 catalog firmware');
  assertEqual(PROFILES[0x10]!.catalogFirmware, '32.6', 'Axe-Fx III catalog firmware');
  assertEqual(PROFILES[0x12]!.catalogFirmware, null, 'FM9 catalog firmware is not settled');

  const noFw = runtimeProfileFrom(catalogBuilt(0x12), PROFILES[0x12]!);
  assertEqual(noFw.profileFacts?.firmware, null, 'a doc without a firmware gives firmware null');
  const junkFw = runtimeProfileFrom({ ...synthBuilt({ source: 'live' }), firmware: 12 as unknown as string }, synthStatic());
  assertEqual(junkFw.profileFacts?.firmware, null, 'a non-string firmware gives null');
}

// ── 3. appliedRows of a byte-exact profile: every row, placeholders included ──
function appliedByteExact(): void {
  const built = catalogBuilt(FM3);
  const p = runtimeProfileFrom(built, FM3_STATIC);
  const applied = p.profileFacts!.appliedRows;
  let rows = 0;
  let placeholders = 0;
  for (const [fam, famRows] of Object.entries(built.ranges)) {
    const pids = Object.keys(famRows).map(Number);
    rows += pids.length;
    assertEqual(applied[fam]?.size, pids.length, `${fam}: every row of a byte-exact profile is applied`);
    for (const pid of pids) {
      if (famRows[pid]!.displayMin === famRows[pid]!.displayMax) placeholders++;
      assert(p.ranges[fam]![pid] === famRows[pid], `${fam} ${pid}: the effective row is the profile's`);
    }
  }
  assert(rows > 1800 && placeholders > 0, 'the fixture holds the whole FM3 catalog, placeholder slots included');
}

// ── 4. appliedRows of a live profile: not the skipped rows ──
function appliedLive(): void {
  const p = runtimeProfileFrom(synthBuilt({ source: 'live' }), synthStatic());
  const applied = p.profileFacts!.appliedRows[DISTORT]!;
  assertEqual(applied.has(REFINED_PID), true, 'a same-kind live row refines the catalog row: applied');
  assertEqual(applied.has(NEW_PID), true, 'a live row for a pid the catalog lacks: applied');
  assertEqual(applied.has(KIND_CONFLICT_PID), false, 'a live kind conflict keeps the catalog row: not applied');
  assertEqual(applied.has(GAP_PID), false, 'a live placeholder row is skipped: not applied');
  assertEqual(p.ranges[DISTORT]![KIND_CONFLICT_PID]!.kind, 'enum', 'the catalog kind stands for the skipped row');
  // the raw rows are still all there in the facts (verbatim), the index reads the skip from appliedRows
  assertEqual(Object.keys(p.profileFacts!.ranges[DISTORT]!).length, 4, 'facts.ranges keeps every walked row');

  const b = runtimeProfileFrom(synthBuilt({ source: 'editor-cache' }), synthStatic());
  assertEqual(b.profileFacts!.appliedRows[DISTORT]!.size, 4, 'byte-exact: all four rows applied, the placeholder included');
}

// ── 5. a swapped section pair is reported and not merged ──
function suspectSwap(): void {
  const built = catalogBuilt(FM3);
  const swap = <T>(o: Record<string, T>) => { const t = o.MIXER!; o.MIXER = o.OUTPUT!; o.OUTPUT = t; };
  swap(built.ranges as Record<string, unknown>);
  swap(built.enumOverrides as Record<string, unknown>);
  swap(built.rangeSections as Record<string, unknown>);

  const { result: p, lines } = collectWarnings(() => runtimeProfileFrom(built, FM3_STATIC));
  assertEqual(p.profileFacts!.suspectFamilies.join(','), 'MIXER,OUTPUT', 'both swapped families are reported, sorted');
  assertEqual(lines.length, 1, 'one log line');
  assert(/MIXER, OUTPUT/.test(lines[0]!), 'the log line names the families');

  for (const fam of ['MIXER', 'OUTPUT']) {
    assertEqual(p.profileFacts!.appliedRows[fam], undefined, `${fam}: no row was merged`);
    for (const [pidStr, row] of Object.entries(FM3_STATIC.ranges[fam]!)) {
      assert(p.ranges[fam]![Number(pidStr)] === row, `${fam} ${pidStr}: the effective row is the catalog's`);
    }
    assertEqual(Object.keys(p.ranges[fam]!).length, Object.keys(FM3_STATIC.ranges[fam]!).length, `${fam}: no foreign row was added`);
    assertEqual(p.rangeSections[fam]!.stride, FM3_STATIC.rangeSections[fam]!.stride, `${fam}: the catalog stride stands`);
    for (const pidStr of Object.keys(built.enumOverrides[fam] ?? {})) {
      assertEqual(p.enumLabelsFor(fam, Number(pidStr)), FM3_STATIC.enumLabelsFor(fam, Number(pidStr)), `${fam} ${pidStr}: labels fall back to the catalog`);
    }
  }
  // every other family is merged as before
  assertEqual(p.profileFacts!.appliedRows.CABINET!.size, Object.keys(built.ranges.CABINET!).length, 'other families are still merged');
  // live: the same swap is refused the same way
  const liveBuilt = catalogBuilt(FM3, 'live');
  swap(liveBuilt.ranges as Record<string, unknown>);
  swap(liveBuilt.enumOverrides as Record<string, unknown>);
  const live = collectWarnings(() => runtimeProfileFrom(liveBuilt, FM3_STATIC)).result;
  assertEqual(live.profileFacts!.suspectFamilies.join(','), 'MIXER,OUTPUT', 'a live profile is cross-checked as well');

  // the unmodified catalog raises nothing and logs nothing
  const clean = collectWarnings(() => runtimeProfileFrom(catalogBuilt(FM3), FM3_STATIC));
  assertEqual(clean.lines.length, 0, 'no log line without a suspect');
}

// ── 6. the cross-check never fails the swap ──
function malformedDoc(): void {
  const p = runtimeProfileFrom({ meta: { source: 'live' } } as unknown as BuiltCache, FM3_STATIC);
  assertEqual(p.profileFacts!.suspectFamilies.length, 0, 'a doc without tables has no suspects');
  assertEqual(Object.keys(p.profileFacts!.ranges).length, 0, 'and no rows');
  // rows without scale/step (older hand-made docs) over families big enough to be cross-checked
  const bare = { kind: 'float', displayMin: 0, displayMax: 1, typecode: 0 };
  const rows = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, bare]));
  const sparse = { meta: { source: 'live' }, ranges: { MIXER: rows, OUTPUT: rows }, rangeSections: {}, rosters: {}, cabIrs: {} } as unknown as BuiltCache;
  const q = runtimeProfileFrom(sparse, FM3_STATIC);
  assertEqual(q.profileFacts!.suspectFamilies.length, 0, 'rows without scale/step raise no suspect');
  assertEqual(q.profileFacts!.enumLabels !== undefined, true, 'a missing enumOverrides table reads as empty');
}

// ── mocked registry for the revert cases ──
const firmwareReply = (model: number, major: number, minor: number) => [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];

async function makeRegistry(load: (key: string) => BuiltCache | null, fw: { v: [number, number] | null }): Promise<DeviceRegistry> {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[5] === 0x08 && fw.v) return [firmwareReply(FM3, ...fw.v)];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: load,
  });
  await registry.detect();
  return registry;
}

const driverProfile = async (r: DeviceRegistry): Promise<DeviceProfile> => ((await r.driver()) as unknown as { profile: DeviceProfile }).profile;
const KEY_12 = '11_12p0';

async function expectRuntime(r: DeviceRegistry, label: string): Promise<void> {
  assert(r.profile.profileFacts !== undefined, `${label}: the registry's profile is the runtime profile`);
  assert((await driverProfile(r)).profileFacts !== undefined, `${label}: the driver reads through the runtime profile`);
}
async function expectBundled(r: DeviceRegistry, label: string): Promise<void> {
  assert(r.profile === FM3_STATIC, `${label}: the registry's profile is the bundled one again`);
  assert((await driverProfile(r)) === FM3_STATIC, `${label}: the driver reads through the bundled profile again`);
}

// ── 7. revert after the stored profile is deleted ──
async function revertAfterDelete(): Promise<void> {
  const mem = createStore(createMemStoreBackend(), nodeCodec);
  mem.putDoc('deviceCaches', KEY_12, catalogBuilt(FM3));
  const registry = await makeRegistry((k) => loadUsableProfile(mem, k), { v: [12, 0] });
  await expectRuntime(registry, 'before the delete');
  const r = await deviceCache.deleteCache(mem, registry);
  assertEqual(r.deleted, true, 'the doc was deleted');
  await expectBundled(registry, 'after the delete');
  const again = await deviceCache.deleteCache(mem, registry);
  assertEqual(again.deleted, false, 'a second delete finds nothing');
  await expectBundled(registry, 'after a second delete');
}

// ── 8. revert on a firmware without a profile, and on an unknown firmware ──
async function revertOnFirmware(): Promise<void> {
  const docs = new Map<string, BuiltCache>([[KEY_12, catalogBuilt(FM3)]]);
  const fw: { v: [number, number] | null } = { v: [12, 0] };
  const registry = await makeRegistry((k) => docs.get(k) ?? null, fw);
  await expectRuntime(registry, 'fw 12.0 with a profile');

  fw.v = [13, 0]; // a firmware update: no profile stored for 13.0
  await registry.detect();
  assertEqual(registry.firmwareInfo()?.version, '13.0', 'the new firmware was read');
  await expectBundled(registry, 'fw 13.0 without a profile');

  fw.v = [12, 0]; // back to a firmware that has one
  await registry.detect();
  await expectRuntime(registry, 'back on fw 12.0');

  fw.v = null; // the firmware read goes silent
  await registry.detect();
  assertEqual(registry.firmwareInfo(), null, 'firmware unknown');
  await expectBundled(registry, 'unknown firmware');

  // a stored profile this build cannot use counts as none
  fw.v = [12, 0];
  docs.set(KEY_12, { ...catalogBuilt(FM3), meta: { ...catalogBuilt(FM3).meta, schema: CACHE_SCHEMA - 1 } });
  await registry.detect();
  await expectBundled(registry, 'a stale stored profile');
}

// ── 9. nothing layered: a repeated apply changes nothing; a registry without the hook is left alone ──
async function revertIdempotent(): Promise<void> {
  const registry = await makeRegistry(() => null, { v: [12, 0] });
  await expectBundled(registry, 'no profile at all');
  await registry.applyRuntimeCache();
  await expectBundled(registry, 'a repeated apply');

  // without a loadDeviceCache hook the registry cannot know about profiles: nothing is touched, nothing throws
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(FM3)] : req[5] === 0x08 ? [firmwareReply(FM3, 12, 0)] : []);
  const bare = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock, loadDeviceCache: undefined });
  await bare.detect();
  await bare.applyRuntimeCache();
  await expectBundled(bare, 'a registry without the hook');
}

export async function runProfileFactsTests(): Promise<void> {
  provenance();
  factsAndStatic();
  appliedByteExact();
  appliedLive();
  suspectSwap();
  malformedDoc();
  await revertAfterDelete();
  await revertOnFirmware();
  await revertIdempotent();
}
