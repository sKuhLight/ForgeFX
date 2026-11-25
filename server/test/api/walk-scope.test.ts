// Walk scope gates, the two-phase build, the bound watchdog and the development-hook opt-in (M3 WP-F6) — mocked
// transport, NO hardware. Covers:
//   - the extension limits per device (FM3 DISTORT 175 / CONTROLLERS 161 / GLOBAL 163, the present roster blocks above
//     160; Axe-Fx III CONTROLLERS 209; nothing above 255; block 0, 190, 199, 200, roster-only, absent instances never;
//     a cloud doc never widens, a local editor-cache doc does), the query budget and the phase-B walk options;
//   - the gates fail closed (empty verified table, unknown and unlisted firmware), the override needs the opt-in, is
//     ignored in production and on a registry without the hook (the router twin / Browser Direct);
//   - the build: phase A persisted before phase B, phase B joins phase A's raw source (one source, extended scope,
//     `extension: 'done'`), the already rule, the default scope, `skipped`, standard; aborts (implausible reply at 140,
//     a silent run, a failed liveness check, the budget, cancel) keep phase A marked `aborted` with the reason;
//   - the bound watchdog at the host adapter (an out-of-bound or out-of-scope query from a faulty walk is refused and
//     never sent; build error, nothing persisted for that phase), a transport timeout = a lost reply;
//   - `capabilities.definitions.walk` per gate, the bound-hit gap of a walk, instance evidence through phase B;
//   - the opt-in of all three development hooks (walk-scope override, hide family, force generic).
// Synthetic records from the committed FM3 catalog only.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import {
  LiveWalkAbortError, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE, WalkBoundError, buildDefQuery, liveWalkDetailed,
  type CacheRecord, type LiveRawSource, type LiveWalkOptions, type LiveWalkResult, type ProfileDoc
} from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, __setDriverForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { PROFILES, hiddenFamily } from '../../src/devices.js';
import { DEV_HOOKS_ENV, devHookValue, devHooksEnabled } from '../../src/devHooks.js';
import { profileSummaryOf } from '../../src/profileSchema.js';
import { createRouter } from '../../src/runtime/router.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { WALK_SCOPE_VERIFIED_FW, walkScopeGates, walkScopeOverrideFromEnv, type WalkScopeOverrideToken } from '../../src/services/walkScope.js';
import * as store from '../../src/store.js';
import type { BlockParamsV2DTO, DeviceDriver, DeviceEvent, DriverCapabilities } from '../../src/drivers/types.js';
import type { Transport } from '../../src/transport/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { seedRecords as cacheSeedRecords } from '../helpers/cacheBytes.js';
import { mockBlockDevice, eidOfSlug } from '../helpers/blockRead.js';
import { editorCacheSource, familyRecords, liveSeedRecords, liveSource, profileDoc, walkResult, widenTable } from '../helpers/profileDocs.js';

export const WALK_SCOPE_CASE_COUNT = 21;

const FM3 = 0x11;
const FM9 = 0x12;
const AXE3 = 0x10;
const VP4 = 0x14;
const KEY = '11_12p0'; // FM3 fw 12.0 (the catalog firmware)
const KEY13 = '11_13p0';
const ALL_GATES = { extendedIds: true, above160: true, farIds: false } as const;
const FM3_PHASE_B = [1, 2, 58, 162, 163, 166, 178, 182, 183, 186, 187, 191, 192];

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Runs `fn` with console.warn captured; returns its result and the warning lines. */
async function capturingWarnings<T>(fn: () => Promise<T> | T): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try { return { value: await fn(), warnings }; } finally { console.warn = warn; }
}

interface Rig {
  registry: DeviceRegistry;
  app: Awaited<ReturnType<typeof buildApp>>;
  router: ReturnType<typeof createRouter>;
  mock: MockTransport;
  events: DeviceEvent[];
  close(): Promise<void>;
}

/** A detected unit over a mocked link. `override`: the registry's walk-scope hook — a token set (injected), 'env' (the
 *  Node registry's own hook: reads the environment) or 'none' (no hook at all, as a Browser Direct registry). */
async function makeRig(o: {
  model?: number; fw?: readonly [number, number] | null; override?: Iterable<WalkScopeOverrideToken> | 'env' | 'none';
  /** A firmware the test changes after detect (wins over `fw`). */ fwState?: { fw: readonly [number, number] | null };
  /** A driver seeded for the model before detect. */ driver?: DeviceDriver;
  /** Answers walk queries (fn 0x01) instead of silence. */ walkReply?: (req: readonly number[]) => number[][];
} = {}): Promise<Rig> {
  const model = o.model ?? FM3;
  const state = o.fwState ?? { fw: o.fw === undefined ? ([12, 0] as const) : o.fw };
  const mock = new MockTransport('serial', `mock-walk-scope-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    const fw = state.fw;
    if (req[0] === 0xf0 && req[5] === 0x08) return fw ? [firmwareVersionReply(model, fw[0], fw[1])] : [];
    if (o.walkReply && req[5] === 0x01) return o.walkReply(req);
    return []; // definition queries (and anything else): no reply
  };
  const override = o.override ?? [];
  const hook = override === 'env'
    ? {}
    : override === 'none'
      ? { walkScopeOverride: undefined }
      : { walkScopeOverride: () => new Set(override) };
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock, ...hook });
  if (o.driver) __setDriverForTest(registry, model, o.driver);
  await registry.detect();
  const app = await buildApp(registry);
  const router = createRouter({ registry, store: store.defaultStore });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const resume = registry.pauseTelemetry();
  return {
    registry, app, router, mock, events,
    close: async () => { deviceCache.__setDefaultWalkForTest(registry, null); resume(); unsub(); await app.close(); }
  };
}

const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const storedDoc = (): ProfileDoc | null => {
  const d = store.defaultStore.getDoc('deviceCaches', KEY);
  return d && !d.deleted ? (d.data as ProfileDoc) : null;
};
const liveSourceOf = (doc: ProfileDoc | null): LiveRawSource | undefined =>
  doc?.raw?.sources.find((s): s is LiveRawSource => s.kind === 'live-readonly' || s.kind === 'live-full');
const terminal = (r: Rig) => r.events.filter((e): e is Extract<DeviceEvent, { type: 'cacheBuild' }> =>
  e.type === 'cacheBuild' && (e.phase === 'done' || e.phase === 'error' || e.phase === 'cancelled' || e.phase === 'already-built'));
const definitionsCaps = async (r: Rig) =>
  ((await r.app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: { walk: Record<string, boolean> } } }).capabilities.definitions;

/** A build walk per phase: phase A (the standard walk: no explicit block list) and phase B (the extension walk). */
type PhaseWalk = (t: { request(q: Uint8Array): Promise<Uint8Array | null> }, o: LiveWalkOptions) => Promise<CacheRecord[] | LiveWalkResult>;
function twoPhase(a: PhaseWalk, b: PhaseWalk): deviceCache.WalkImpl & { calls: LiveWalkOptions[] } {
  const calls: LiveWalkOptions[] = [];
  const impl = (async (t, o) => { calls.push(o); return o.blocks ? b(t, o) : a(t, o); }) as deviceCache.WalkImpl & { calls: LiveWalkOptions[] };
  impl.calls = calls;
  return impl;
}

/** Synthetic DISTORT rows at ids 128..143 of block 58 (what an extension walk finds past 127: the FM3 table has 144
 *  slots). */
const distortHigh = (): CacheRecord[] => Array.from({ length: 16 }, (_, i) =>
  ({ kind: 'float', section: 58, offset: 0, id: 128 + i, tc: 0, min: 0, max: 10, def: 1, step: 0, t1: 0, t2: 0 }) as CacheRecord);
/** What a successful extension walk answers: the DISTORT block re-walked (its seed rows + the rows above 127) and
 *  the first Resonator instance; every other extended block is silent (no records). */
const phaseBRecords = (): CacheRecord[] => [...liveSeedRecords().filter((r) => r.section === 58), ...distortHigh(), ...familyRecords('RESONATOR', 162)];

async function build(r: Rig, opts: deviceCache.CacheBuildOptions): Promise<deviceCache.StartResult> {
  const res = await deviceCache.startCacheBuild(store.defaultStore, r.registry, opts);
  await deviceCache.cacheBuildPromise(r.registry);
  return res;
}

// ── 1. extension limits per device ────────────────────────────────────────────────────────────────────────────────
function extendedBoundsPerDevice(): void {
  const fm3 = deviceCache.extensionWalkLimits(FM3, null, ALL_GATES);
  assertEqual(fm3.blocks.join(','), FM3_PHASE_B.join(','), 'FM3: GLOBAL, CONTROLLERS, amp 1 and the present roster blocks above 160');
  assertEqual(`${fm3.bound[58]}/${fm3.knownSize[58]}`, '175/144', 'FM3 DISTORT: 144 - 1 + 32, known size 144');
  assertEqual(`${fm3.bound[2]}/${fm3.knownSize[2]}`, '161/130', 'FM3 CONTROLLERS: 130 - 1 + 32, known size 130');
  assertEqual(`${fm3.bound[1]}/${fm3.knownSize[1]}`, '163/undefined', 'FM3 GLOBAL: low region 131 + 32, no known size');
  assertEqual(JSON.stringify(fm3.idLists), '{}', 'FM3: no far ids without the farIds gate');
  assertEqual(`${fm3.bound[162]}/${fm3.knownSize[162]}`, `${PROFILES[FM3]!.rangeSections.RESONATOR!.stride - 1 + 32}/${PROFILES[FM3]!.rangeSections.RESONATOR!.stride}`, 'FM3 Resonator 1: stride - 1 + 32, known size');
  assertEqual(fm3.extendedBlocks.join(','), '1,2,58', 'FM3: the blocks walked past 127');
  assertEqual(fm3.above160Blocks.join(','), '162,163,166,178,182,183,186,187,191,192', 'FM3: the present roster blocks above 160');
  for (const b of [0, 59, 60, 61, 161, 164, 165, 167, 170, 174, 179, 184, 188, 190, 193, 195, 199, 200]) {
    assert(!fm3.blocks.includes(b), `FM3: block ${b} never extended (block 0, absent instance, no table, 190/199/200)`);
  }
  // every other block keeps the standard walk's ≤ 127
  const std = deviceCache.walkBlockLimits(FM3, 'read-only');
  assert(Object.values(std.bound).every((b) => b <= 127), 'FM3 standard walk: every ceiling ≤ 127 (unchanged)');
  assertEqual(std.bound[58], 127, 'FM3 standard walk: DISTORT still 127');

  const axe3 = deviceCache.extensionWalkLimits(AXE3, null, ALL_GATES);
  assertEqual(`${axe3.bound[2]}/${axe3.knownSize[2]}`, '209/178', 'Axe-Fx III CONTROLLERS: 178 - 1 + 32');
  assertEqual(`${axe3.bound[58]}/${axe3.bound[59]}`, '173/173', 'Axe-Fx III DISTORT: both amp instances, 142 - 1 + 32');
  for (const b of [36, 134, 142, 170, 171, 174, 177, 194, 195, 198]) assert(!axe3.blocks.includes(b), `Axe-Fx III: roster-only or absent block ${b} never extended`);
  const fm9 = deviceCache.extensionWalkLimits(FM9, null, ALL_GATES);
  assertEqual(`${fm9.bound[58]}/${fm9.bound[59]}`, '178/178', 'FM9 DISTORT: both amp instances, 147 - 1 + 32');
  // the blocks above 160, pinned per model (Resonator, Looper, Plex, Send, Return, Multiplexer; present instances only)
  assertEqual(fm9.above160Blocks.join(','), '162,163,166,178,182,183,186,187,191,192', 'FM9: the roster blocks above 160, exactly');
  assertEqual(axe3.above160Blocks.join(','), '162,163,166,178,179,182,183,186,187,191,192', 'Axe-Fx III: the roster blocks above 160 (two Plex), exactly');
  assertEqual(`${fm9.extendedBlocks.join(',')}|${axe3.extendedBlocks.join(',')}`, '1,2,58,59|1,2,58,59', 'FM9 / III: the blocks walked past 127');

  for (const model of [FM3, FM9, AXE3]) {
    const l = deviceCache.extensionWalkLimits(model, null, { extendedIds: true, above160: true, farIds: true });
    assert(Object.values(l.bound).every((b) => b <= 255), `model 0x${model.toString(16)}: no bound above 255`);
    assert(!l.blocks.includes(0) && !l.blocks.includes(190) && !l.blocks.includes(199) && !l.blocks.includes(200), `model 0x${model.toString(16)}: never block 0/190/199/200`);
    assert(Object.keys(l.idLists).every((b) => Number(b) === 1), `model 0x${model.toString(16)}: far ids only for the non-contiguous GLOBAL table`);
    assert((l.idLists[1] ?? []).every((id) => id > l.bound[1]!), `model 0x${model.toString(16)}: far ids lie above the low region's bound`);
  }
  const far = deviceCache.extensionWalkLimits(FM3, null, { extendedIds: true, above160: false, farIds: true });
  assert((far.idLists[1]?.length ?? 0) > 0 && far.idLists[1]![0]! > 163, 'farIds (never enabled): the catalog far GLOBAL ids as an explicit list');

  // the gates select: nothing, only above 160 (capped at 127 without extendedIds), full mode = only above 160
  assertEqual(deviceCache.extensionWalkLimits(FM3, null, { extendedIds: false, above160: false, farIds: false }).blocks.length, 0, 'no gate: nothing to extend');
  const only160 = deviceCache.extensionWalkLimits(FM3, null, { extendedIds: false, above160: true, farIds: false });
  assertEqual(only160.blocks.join(','), '162,163,166,178,182,183,186,187,191,192', 'above160 only: the roster blocks');
  assert(Object.values(only160.bound).every((b) => b <= 127), 'above160 without extendedIds: bounds ≤ 127');
  assertEqual(deviceCache.extensionWalkLimits(FM3, null, ALL_GATES, 'full').blocks.join(','), '162,163,166,178,182,183,186,187,191,192', 'full mode: its standard walk covers the known tables, only above 160 is left');
  assertEqual(deviceCache.extensionWalkLimits(VP4, null, ALL_GATES).blocks.length + deviceCache.extensionWalkLimits(0x15, null, ALL_GATES).blocks.length, 0, 'no gen-3 grid catalog: nothing');
  console.log('  api/walk-scope: extension bounds — FM3 175/161/163 + 10 roster blocks, III 209, FM9 178, ≤ 255, never 0/190/199/200/roster-only/absent');
}

// ── 2. bound sources: a local editor-cache doc widens, a cloud doc never does ─────────────────────────────────────
async function boundSources(): Promise<void> {
  const wide = widenTable(cacheSeedRecords(), 10, 150, 'DISTORT'); // DISTORT section (tag 10) with 150 slots
  const local = profileDoc([await editorCacheSource(wide)]);
  const cloud = profileDoc([await editorCacheSource(wide, { origin: 'cloud', capturedAt: '2026-11-21T10:00:00.000Z' })]);
  const file = profileDoc([await editorCacheSource(wide, { origin: 'file', capturedAt: '2026-11-21T11:00:00.000Z' })]);
  assertEqual(deviceCache.extensionWalkLimits(FM3, local, ALL_GATES).bound[58], 181, 'local editor-cache source: DISTORT 150 - 1 + 32');
  assertEqual(deviceCache.extensionWalkLimits(FM3, local, ALL_GATES).knownSize[58], 150, 'local editor-cache source: known size 150');
  assertEqual(deviceCache.extensionWalkLimits(FM3, cloud, ALL_GATES).bound[58], 175, 'cloud source: the catalog bound stays');
  assertEqual(deviceCache.extensionWalkLimits(FM3, file, ALL_GATES).bound[58], 175, 'definitions-file source: the catalog bound stays');
  // a live doc whose DISTORT table is longer never widens either
  const liveWide = profileDoc([liveSource(widenTable(liveSeedRecords(), 58, 200, 'DISTORT'))]);
  assertEqual(deviceCache.extensionWalkLimits(FM3, liveWide, ALL_GATES).bound[58], 175, 'live source: the catalog bound stays');
  console.log('  api/walk-scope: extension bounds from the catalog or the LOCAL editor cache only (cloud, file, live never widen)');
}

// ── 3. query budget and the phase-B walk options ──────────────────────────────────────────────────────────────────
function budgetAndOptions(): void {
  assertEqual(deviceCache.extensionQueryBudget({ blocks: [1, 2], bound: { 1: 10, 2: 20 }, enums: { 1: 2 }, idLists: { 2: [300, 301] } }), 22 + 128 + 42 + 4, 'budget = Σ (bound + 1) × 2 + 64 per enum + 2 per listed id');
  const fw = { major: 13, minor: 0 };
  const s = deviceCache.extensionWalkSetup(store.defaultStore, FM3, fw, ALL_GATES, 'read-only');
  assertEqual(s.opts.blocks?.join(','), FM3_PHASE_B.join(','), 'options: the explicit phase-B blocks');
  assertEqual(`${s.opts.abortOnImplausibleFrom}/${s.opts.abortOnSilence}/${s.opts.maxParamId}`, '128/true/127', 'options: abort at the first implausible reply ≥ 128, at any silence; 127 default');
  assertEqual(`${s.opts.mode}/${s.opts.write}`, 'undefined/undefined', 'options: read-only (no mode, no write hooks)');
  assertEqual(`${s.opts.paramBoundByBlock?.[58]}/${s.opts.paramKnownSizeByBlock?.[58]}`, '175/144', 'options: DISTORT bound and size');
  assertEqual(s.opts.interQueryMs, 3, 'options: the hardware-proven pacing');
  assert(s.hinted && Object.keys(s.opts.enumHintByBlock ?? {}).length > 0, 'fw 13.0: hinted');
  assert(Object.keys(s.opts.enumHintByBlock ?? {}).every((b) => FM3_PHASE_B.includes(Number(b))), 'hints only for the phase-B blocks');
  assertEqual(s.budget, deviceCache.extensionQueryBudget(s.limits), 'the setup carries the budget of its limits');
  assert(s.budget > 0, 'a positive budget');
  const fullB = deviceCache.extensionWalkSetup(store.defaultStore, FM3, fw, ALL_GATES, 'full');
  assertEqual(`${fullB.opts.mode}/${fullB.opts.write}/${fullB.opts.blocks?.[0]}`, 'undefined/undefined/162', 'a full build\'s extension: read-only, above 160 only');
  console.log('  api/walk-scope: budget formula, phase-B options (explicit blocks, abort rules, read-only, hints of its blocks)');
}

// ── 4. gates fail closed ──────────────────────────────────────────────────────────────────────────────────────────
async function gatesFailClosed(): Promise<void> {
  assertEqual(Object.keys(WALK_SCOPE_VERIFIED_FW).length, 0, 'the verified table is empty in this build');
  const closed = '{"extendedIds":false,"above160":false,"blockProbe":false,"farIds":false}';
  for (const [label, fw] of [['FM3 13.0', { major: 13, minor: 0 }], ['FM3 99.9 (unlisted)', { major: 99, minor: 9 }], ['unknown', null], ['malformed', { major: 0, minor: -1 }]] as const) {
    assertEqual(JSON.stringify(walkScopeGates(FM3, fw)), closed, `${label}: closed without override`);
  }
  assertEqual(JSON.stringify(walkScopeGates(FM3, null, new Set(['extended', 'above160', 'probe']))), closed, 'unknown firmware: closed whatever the override');
  const r = await makeRig({ override: [] });
  try {
    assertEqual(JSON.stringify((await definitionsCaps(r)).walk), closed, 'caps: walk all false without an override');
    clearDoc();
    const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { walkImpl: walk });
    assertEqual(walk.calls.length, 1, 'closed gates: one walk (standard)');
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(done?.extension, undefined, 'closed gates, no scope requested: standard, no extension field');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: gates fail closed (empty table, unlisted/unknown firmware), a default build stays standard');
}

// ── 5. the override: opt-in, production, the router twin ──────────────────────────────────────────────────────────
async function overrideOptIn(): Promise<void> {
  const OV = 'FORGEFX_WALK_SCOPE_OVERRIDE';
  let w = await capturingWarnings(() => walkScopeOverrideFromEnv({ [OV]: 'extended,above160' }));
  assertEqual(w.value.size, 0, 'without the opt-in: ignored');
  assert(w.warnings.length === 1 && w.warnings[0]!.includes(DEV_HOOKS_ENV), 'without the opt-in: one warning naming FORGEFX_DEV_HOOKS');
  w = await capturingWarnings(() => walkScopeOverrideFromEnv({ [OV]: 'extended,above160', [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' }));
  assert(w.value.size === 0 && w.warnings.length === 1 && w.warnings[0]!.includes('ignored in production'), 'production: ignored even with the opt-in, one warning');
  w = await capturingWarnings(() => walkScopeOverrideFromEnv({ [OV]: 'extended', [DEV_HOOKS_ENV]: 'true' }));
  assertEqual(w.value.size, 0, 'an opt-in other than 1: ignored');
  w = await capturingWarnings(() => walkScopeOverrideFromEnv({ [OV]: 'extended,above160', [DEV_HOOKS_ENV]: '1' }));
  assertEqual([...w.value].join(','), 'extended,above160', 'with the opt-in: the override opens its flags');

  // the Node registry reads the environment at call time
  const r = await makeRig({ override: 'env' });
  try {
    const capsWith = (vars: Record<string, string | undefined>) => withEnv(vars, async () => (await capturingWarnings(() => definitionsCaps(r))).value.walk);
    assertEqual((await capsWith({ [OV]: 'extended', [DEV_HOOKS_ENV]: undefined, NODE_ENV: undefined })).extendedIds, false, 'registry: no opt-in → closed');
    assertEqual((await capsWith({ [OV]: 'extended', [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' })).extendedIds, false, 'registry: production → closed');
    assertEqual((await capsWith({ [OV]: 'extended', [DEV_HOOKS_ENV]: '1', NODE_ENV: undefined })).extendedIds, true, 'registry: opt-in → open');
  } finally { await r.close(); }

  // a registry without the hook (Browser Direct, the router twin's runtime): the environment is never read
  const bd = await makeRig({ override: 'none' });
  try {
    clearDoc();
    await withEnv({ [OV]: 'extended,above160', [DEV_HOOKS_ENV]: '1', NODE_ENV: undefined }, async () => {
      await capturingWarnings(async () => {
        assertEqual(bd.registry.walkScopeGates().extendedIds, false, 'no hook: closed despite the environment');
        const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
        deviceCache.__setDefaultWalkForTest(bd.registry, walk);
        const res = await bd.router.handle('POST', '/device/cache/build', JSON.stringify({ scope: 'extended' }));
        assertEqual(res.status, 200, 'router twin: build started');
        await deviceCache.cacheBuildPromise(bd.registry);
        assertEqual(walk.calls.length, 1, 'router twin: one walk, no extension');
        assertEqual(terminal(bd).find((e) => e.phase === 'done')?.extension, 'skipped', 'router twin: extended request → skipped');
        const caps = JSON.parse((await bd.router.handle('GET', '/device')).body as string) as { capabilities: { definitions: { walk: Record<string, boolean> } } };
        assertEqual(Object.values(caps.capabilities.definitions.walk).some(Boolean), false, 'router twin caps: walk all false');
      });
    });
  } finally { clearDoc(); await bd.close(); }
  console.log('  api/walk-scope: the override needs FORGEFX_DEV_HOOKS=1, is ignored in production and on a registry without the hook (router twin)');
}

// ── 6. phase A then phase B: persisted first, joined, re-derived, persisted again ─────────────────────────────────
async function twoPhaseBuild(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    let atPhaseB: ProfileDoc | null = null;
    const walk = twoPhase(
      async () => walkResult(liveSeedRecords(), { boundHits: [{ block: 58, lastReal: 127, bound: 127 }] }),
      async () => { atPhaseB = storedDoc(); return walkResult(phaseBRecords()); }
    );
    const res = await build(r, { walkImpl: walk }); // no scope: extended, the gates are open
    assertEqual((res.body as { started?: boolean }).started, true, 'started');
    assertEqual(walk.calls.length, 2, 'two walks: phase A, then phase B');
    const [a, b] = walk.calls;
    assertEqual(`${a!.blocks}/${a!.abortOnSilence}/${a!.maxParamId}`, 'undefined/undefined/127', 'phase A: today\'s standard walk');
    assert(Object.values(a!.paramBoundByBlock ?? {}).every((x) => x <= 127), 'phase A: every ceiling ≤ 127');
    assertEqual(b!.blocks?.join(','), FM3_PHASE_B.join(','), 'phase B: the extension blocks');
    // phase A was persisted (and applied) before phase B queried anything
    const a0 = liveSourceOf(atPhaseB);
    assert(a0 !== undefined, 'phase A persisted before phase B');
    assertEqual(`${a0!.scope.extended}/${a0!.scope.above160}/${a0!.walk.extension}`, 'false/false/undefined', 'phase A source: standard scope, no marker yet');
    assert(!a0!.records.some((x) => x.section === 162), 'phase A source: nothing above 160');

    const doc = storedDoc()!;
    const lives = doc.raw!.sources.filter((s) => s.kind === 'live-readonly');
    assertEqual(lives.length, 1, 'phase B joined phase A\'s source (one live source)');
    const s = lives[0] as LiveRawSource;
    assertEqual(s.id, a0!.id, 'the joined source keeps phase A\'s id');
    assertEqual(`${s.scope.extended}/${s.scope.above160}/${s.walk.extension}/${s.walk.abortReason}`, 'true/true/done/undefined', 'joined: extended scope, extension done');
    assertEqual(`${s.scope.bounds[58]}/${s.scope.bounds[2]}/${s.scope.bounds[1]}/${s.scope.bounds[162]}/${s.scope.bounds[70]}`, `175/161/163/${PROFILES[FM3]!.rangeSections.RESONATOR!.stride - 1 + 32}/${a0!.scope.bounds[70]}`, 'joined: the extension\'s ceilings, phase A\'s elsewhere');
    assert(s.scope.blocks.includes(162) && s.scope.blocks.includes(160) && !s.scope.blocks.includes(164), 'joined: the walked blocks (0..160 + the extension)');
    assertEqual(s.records.filter((x) => x.section === 58).length, phaseBRecords().filter((x) => x.section === 58).length, 'block 58: phase B\'s records replace phase A\'s');
    assertEqual(s.records.filter((x) => x.section === 66).length, liveSeedRecords().filter((x) => x.section === 66).length, 'block 66: phase A\'s records stay');
    assertEqual(JSON.stringify(s.walk.boundHits), '[]', 'bound hits: phase A\'s on a re-walked block dropped');
    // the join on its own: phase A's hits on blocks the extension did not walk stay, the extension's are added
    const joined = deviceCache.joinExtension(
      liveSource(liveSeedRecords(), { stats: { boundHits: [{ block: 58, lastReal: 127, bound: 127 }, { block: 70, lastReal: 118, bound: 119 }] } }),
      walkResult(phaseBRecords(), { boundHits: [{ block: 162, lastReal: 68, bound: 71 }], unresolvedReplies: 2 }),
      b!, { extended: true, above160: true }
    );
    assertEqual(joined.walk.boundHits.map((h) => h.block).join(','), '70,162', 'join: hits of blocks not re-walked + the extension\'s');
    assertEqual(`${joined.walk.unresolvedReplies}/${joined.walk.extension}/${joined.scope.extended}`, '2/done/true', 'join: statistics summed, extension done');
    assert(Object.keys(doc.ranges.DISTORT ?? {}).some((k) => Number(k) > 127), 're-derived: DISTORT rows above 127');
    assert(doc.ranges.RESONATOR !== undefined, 're-derived: the Resonator (block 162) table');
    // instance evidence (report only): every reserved Resonator id was walked, one answered
    const inst = profileSummaryOf(doc, FM3).coverage.instances.find((i) => i.family === 'RESONATOR');
    assertEqual(JSON.stringify(inst), JSON.stringify({ family: 'RESONATOR', static: 2, seen: 1 }), 'coverage.instances: RESONATOR static 2, seen 1');
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${done?.extension}/${done?.abortReason}`, 'done/undefined', 'SSE: done with extension done');
    assert(r.events.filter((e) => e.type === 'cacheBuild' && e.phase === 'walking').length >= 2, 'SSE: walking events for both phases');

    // the already rule: the joined source covers the extension
    r.events.length = 0;
    const again = await build(r, { walkImpl: walk });
    assertEqual((again.body as { already?: boolean }).already, true, 'a second build: already (extended source)');
    // scope 'standard' on open gates: one walk, no extension field
    r.events.length = 0;
    const std = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { walkImpl: std, scope: 'standard', force: true });
    assertEqual(`${std.calls.length}/${terminal(r).find((e) => e.phase === 'done')?.extension}`, '1/undefined', 'scope standard: one walk, no extension');
  } finally { clearDoc(); await r.close(); }

  // a standard build has no instance evidence above 160 (never walked)
  const plain = profileDoc([liveSource(liveSeedRecords())]);
  assertEqual(profileSummaryOf(plain, FM3).coverage.instances.some((i) => i.family === 'RESONATOR'), false, 'standard walk: no Resonator instance evidence');
  console.log('  api/walk-scope: phase A persisted first, phase B joins its source (extended, done), re-derived, already, instance evidence');
}

// ── 7. phase B aborts keep phase A ────────────────────────────────────────────────────────────────────────────────
async function phaseBAborts(): Promise<void> {
  const cases: Array<[string, PhaseWalk, (reason: string) => boolean]> = [
    ['implausible reply at 140', async () => { throw new LiveWalkAbortError('implausible-reply', 58, 140); }, (x) => x === 'implausible-reply (block 58, param 140)'],
    ['a silent run', async () => { throw new LiveWalkAbortError('silent-run', 1, 150); }, (x) => x === 'silent-run (block 1)'],
    ['a failed liveness check', async () => { throw new Error('liveWalk: device stopped answering (8 consecutive queries unanswered, liveness check unanswered); walk aborted'); }, (x) => x === 'walk-failed']
  ];
  for (const [label, phaseB, reasonOk] of cases) {
    clearDoc();
    const r = await makeRig({ override: ['extended', 'above160'] });
    try {
      const walk = twoPhase(async () => liveSeedRecords(), phaseB);
      await build(r, { walkImpl: walk, scope: 'extended' });
      const done = terminal(r).find((e) => e.phase === 'done');
      assertEqual(done?.extension, 'aborted', `${label}: done, extension aborted`);
      assert(reasonOk(done?.abortReason ?? ''), `${label}: abortReason (${done?.abortReason})`);
      const s = liveSourceOf(storedDoc());
      assert(s !== undefined, `${label}: phase A kept`);
      assertEqual(`${s!.walk.extension}/${s!.walk.abortReason === done?.abortReason}`, 'aborted/true', `${label}: the source is marked aborted with the reason`);
      assertEqual(`${s!.scope.extended}/${s!.scope.above160}`, 'false/false', `${label}: the standard scope stays`);
      assertEqual(s!.records.length, liveSeedRecords().length, `${label}: phase A's records only`);
      assert(!Object.keys(storedDoc()!.ranges.DISTORT ?? {}).some((k) => Number(k) > 127), `${label}: the high-id gap stays`);
      // an aborted extension does not satisfy the next build
      const next = await build(r, { walkImpl: twoPhase(async () => liveSeedRecords(), async () => liveSeedRecords().filter((x) => x.section === 58)) });
      assertEqual((next.body as { started?: boolean }).started, true, `${label}: the next build walks again`);
    } finally { clearDoc(); await r.close(); }
  }

  // cancel during phase B
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    const walk = twoPhase(async () => liveSeedRecords(), async (_t, o) => {
      deviceCache.cancelCacheBuild(r.registry);
      assert(o.signal?.aborted === true, 'the cancel reaches the phase-B walk');
      throw new Error('aborted');
    });
    await build(r, { walkImpl: walk });
    const done = terminal(r).find((e) => e.phase === 'done' || e.phase === 'cancelled');
    assertEqual(`${done?.phase}/${done?.extension}/${done?.abortReason}`, 'done/aborted/cancelled', 'cancel in phase B: done, extension aborted (cancelled)');
    assertEqual(liveSourceOf(storedDoc())?.walk.extension, 'aborted', 'cancel in phase B: phase A kept, marked');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: phase B aborts (implausible at 140, silent run, liveness, cancel) keep phase A, marked aborted + reason');
}

// ── 8. the query budget ───────────────────────────────────────────────────────────────────────────────────────────
async function budgetOverrun(): Promise<void> {
  // the adapter alone: three queries pass, the fourth is refused unsent
  const mock = new MockTransport();
  const opts: LiveWalkOptions = { model: FM3, blocks: [58], maxParamId: 127 };
  const adapter = deviceCache.walkAdapter(mock, opts, 255, 3);
  for (let i = 0; i < 3; i++) assertEqual(await adapter.request(buildDefQuery(FM3, 58, i)), null, `query ${i}: sent (no reply)`);
  let err: unknown;
  try { await adapter.request(buildDefQuery(FM3, 58, 3)); } catch (e) { err = e; }
  assert(err instanceof deviceCache.WalkBudgetError, 'the fourth query: WalkBudgetError');
  assertEqual(`${mock.sent.length}/${adapter.sent()}`, '3/3', 'nothing past the budget reached the transport');

  // through a build: a phase-B walk that would not stop is aborted at its budget, phase A kept
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    const budget = deviceCache.extensionQueryBudget(deviceCache.extensionWalkLimits(FM3, null, ALL_GATES));
    let answered = 0;
    const walk = twoPhase(async () => liveSeedRecords(), async (t) => {
      for (;;) { await t.request(buildDefQuery(FM3, 58, answered % 128)); answered++; }
    });
    const walkQueries = () => r.mock.sent.filter((f) => f[5] === 0x01).length;
    const before = walkQueries();
    await build(r, { walkImpl: walk });
    assertEqual(answered, budget, `the walk got exactly its budget (${budget}) of queries`);
    assertEqual(walkQueries() - before, budget, 'the transport saw no query past the budget');
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${done?.extension}/${done?.abortReason}`, `aborted/query-budget (${budget} queries)`, 'aborted on the budget');
    assertEqual(liveSourceOf(storedDoc())?.walk.extension, 'aborted', 'phase A kept, marked');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: the query budget is counted in the adapter; an overrun aborts phase B, phase A kept');
}

// ── 9. the bound watchdog ─────────────────────────────────────────────────────────────────────────────────────────
async function boundWatchdog(): Promise<void> {
  // the adapter alone: scope and bound per block, a non-walk frame
  const mock = new MockTransport();
  const opts: LiveWalkOptions = { model: FM3, blocks: [58, 162], maxParamId: 127, paramBoundByBlock: { 58: 175, 162: 71 } };
  const adapter = deviceCache.walkAdapter(mock, opts, 255);
  await adapter.request(buildDefQuery(FM3, 58, 175));
  await adapter.request(buildDefQuery(FM3, 162, 71));
  for (const [label, q] of [
    ['above the bound (58 / 176)', buildDefQuery(FM3, 58, 176)],
    ['above the bound (162 / 72)', buildDefQuery(FM3, 162, 72)],
    ['a block outside the scope (59)', buildDefQuery(FM3, 59, 0)],
    ['block 0', buildDefQuery(FM3, 0, 0)],
    ['another model', buildDefQuery(FM9, 58, 0)],
    ['not a walk query', Uint8Array.from([0xf0, 0x00, 0x01, 0x74, FM3, 0x0d, 0x00, 0xf7])]
  ] as const) {
    let err: unknown;
    try { await adapter.request(q); } catch (e) { err = e; }
    assert(err instanceof WalkBoundError, `watchdog: ${label} → WalkBoundError`);
  }
  assertEqual(mock.sent.length, 2, 'watchdog: only the two in-scope queries were sent');
  assert(adapter.refused() instanceof WalkBoundError, 'the adapter remembers the refusal');
  // far ids (the farIds gate, never enabled): a listed id passes the watchdog, an unlisted one beyond the bound does not
  const farSetup = deviceCache.extensionWalkSetup(store.defaultStore, FM3, { major: 12, minor: 0 }, { extendedIds: true, above160: false, farIds: true }, 'read-only');
  const firstFar = farSetup.limits.idLists[1]![0]!;
  assertEqual(`${farSetup.cap >= firstFar}/${farSetup.opts.paramIdsByBlock?.[1]?.[0]}`, `true/${firstFar}`, 'far ids: listed in the options, within the watchdog cap');
  const farMock = new MockTransport();
  const farAdapter = deviceCache.walkAdapter(farMock, farSetup.opts, farSetup.cap);
  await farAdapter.request(buildDefQuery(FM3, 1, firstFar));
  let farErr: unknown;
  try { await farAdapter.request(buildDefQuery(FM3, 1, firstFar + 1)); } catch (e) { farErr = e; }
  assert(farMock.sent.length === 1 && farErr instanceof WalkBoundError, 'far ids: the listed id sent, an unlisted neighbour refused');
  assertEqual(deviceCache.extensionWalkSetup(store.defaultStore, FM3, { major: 12, minor: 0 }, ALL_GATES, 'read-only').cap, 255, 'without far ids: the watchdog cap is 255');

  // phase A: a faulty walk queries 58 / 128 (bound 127) — error, nothing persisted, nothing sent
  for (const swallow of [false, true]) {
    clearDoc();
    const r = await makeRig({ override: ['extended', 'above160'] });
    try {
      const bad = buildDefQuery(FM3, 58, 128);
      const walk = twoPhase(async (t) => {
        try { await t.request(bad); } catch (e) { if (!swallow) throw e; }
        return liveSeedRecords();
      }, async () => phaseBRecords());
      await build(r, { walkImpl: walk });
      const end = terminal(r).find((e) => e.phase === 'error' || e.phase === 'done');
      assert(end?.phase === 'error' && (end.error ?? '').includes('refused'), `phase A watchdog${swallow ? ' (error swallowed by the walk)' : ''}: build error (${end?.error})`);
      assertEqual(storedDoc(), null, 'phase A watchdog: nothing persisted');
      assertEqual(walk.calls.length, 1, 'phase A watchdog: no phase B');
      assert(!r.mock.sent.some((f) => f.length === bad.length && f.every((x, i) => x === bad[i])), 'phase A watchdog: the query never reached the transport');
    } finally { clearDoc(); await r.close(); }
  }

  // phase B: a faulty walk queries 58 / 176 (bound 175) or block 59 (not in scope) — error, phase A stays unmarked; also
  // when the walk swallows the refusal and then fails with another error (never a quiet abort)
  for (const [q, swallowThenFail] of [[buildDefQuery(FM3, 58, 176), false], [buildDefQuery(FM3, 59, 3), false], [buildDefQuery(FM3, 58, 176), true]] as const) {
    clearDoc();
    const r = await makeRig({ override: ['extended', 'above160'] });
    try {
      const walk = twoPhase(async () => liveSeedRecords(), async (t) => {
        if (!swallowThenFail) { await t.request(q); return phaseBRecords(); }
        try { await t.request(q); } catch { /* swallowed */ }
        throw new Error('something else went wrong');
      });
      await build(r, { walkImpl: walk });
      const end = terminal(r).find((e) => e.phase === 'error' || e.phase === 'done');
      assertEqual(`${end?.phase}/${(end?.error ?? '').includes('refused')}`, 'error/true', `phase B watchdog${swallowThenFail ? ' (swallowed, then another error)' : ''}: build error naming the refusal`);
      const s = liveSourceOf(storedDoc());
      assertEqual(`${s?.walk.extension}/${s?.scope.extended}/${s?.records.length}`, `undefined/false/${liveSeedRecords().length}`, 'phase B watchdog: phase A as persisted, nothing of phase B');
      assert(!r.mock.sent.some((f) => f.length === q.length && f.every((x, i) => x === q[i])), 'phase B watchdog: the query never reached the transport');
    } finally { clearDoc(); await r.close(); }
  }
  console.log('  api/walk-scope: the bound watchdog refuses out-of-bound / out-of-scope queries unsent; build error, nothing of that phase persisted');
}

// ── 10. a transport timeout is a lost reply ───────────────────────────────────────────────────────────────────────
async function timeoutIsLostReply(): Promise<void> {
  const timeoutErr = () => Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
  const timingOut = { request: () => Promise.reject(timeoutErr()) } as unknown as Transport;
  assertEqual(await deviceCache.adaptRequest(timingOut, buildDefQuery(FM3, 58, 0)), null, 'a timeout rejection → null (lost reply)');
  const broken = { request: () => Promise.reject(new Error('port closed')) } as unknown as Transport;
  let err: unknown;
  try { await deviceCache.adaptRequest(broken, buildDefQuery(FM3, 58, 0)); } catch (e) { err = e; }
  assert(err instanceof Error && err.message === 'port closed', 'any other rejection still rejects');
  // the codec walk over the host adapter: timeouts are counted as lost replies, the walk resolves
  const opts: LiveWalkOptions = { model: FM3, blocks: [58], maxParamId: 127, paramBoundByBlock: { 58: 127 }, lostReplyRetries: 0, lostReplyDrainMs: 0 };
  const res = await liveWalkDetailed(deviceCache.walkAdapter(timingOut, opts, 127), opts);
  assert(res.records.length === 0 && res.lostReplies > 0 && res.queries > 0, `the walk resolves with lost replies (queries ${res.queries}, lost ${res.lostReplies})`);
  console.log('  api/walk-scope: a transport timeout rejection is a lost reply (null), the walk carries on');
}

// ── 11. SSE extension values: skipped, default scope ──────────────────────────────────────────────────────────────
async function extensionSkipped(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['probe'] }); // a gate is open, but none that extends a walk
  try {
    const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { walkImpl: walk, scope: 'extended' });
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${walk.calls.length}/${done?.extension}`, '1/skipped', 'extended request, nothing to extend: one walk, skipped');
    assertEqual(liveSourceOf(storedDoc())?.walk.extension, 'skipped', 'the source is marked skipped');
    r.events.length = 0;
    await build(r, { walkImpl: walk, force: true }); // no scope: the probe gate does not make a build extended
    assertEqual(terminal(r).find((e) => e.phase === 'done')?.extension, undefined, 'default scope with only the probe gate: standard');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: SSE extension skipped (nothing to extend), default scope standard without an extending gate');
}

// ── 12. capabilities.definitions.walk per gate ────────────────────────────────────────────────────────────────────
async function capsPerGate(): Promise<void> {
  const cases: Array<[WalkScopeOverrideToken[], string]> = [
    [[], 'false/false/false/false'],
    [['extended'], 'true/false/false/false'],
    [['above160'], 'false/true/false/false'],
    [['probe'], 'false/false/true/false'],
    [['extended', 'above160', 'probe'], 'true/true/true/false']
  ];
  for (const [tokens, want] of cases) {
    const r = await makeRig({ override: tokens });
    try {
      const defs = await definitionsCaps(r) as unknown as { walk: { extendedIds: boolean; above160: boolean; blockProbe: boolean; farIds: boolean } };
      const w = defs.walk;
      assertEqual(`${w.extendedIds}/${w.above160}/${w.blockProbe}/${w.farIds}`, want, `caps walk with [${tokens.join(',')}]`);
      assertEqual(Object.keys(w).join(','), 'extendedIds,above160,blockProbe,farIds', 'caps walk key order');
    } finally { await r.close(); }
  }
  for (const [label, o] of [
    ['unknown firmware', { fw: null }],
    ['VP4 (no definition walk)', { model: VP4, fw: [3, 0] as const }]
  ] as const) {
    const r = await makeRig({ ...o, override: ['extended', 'above160', 'probe'] });
    try {
      const w = (await definitionsCaps(r)).walk;
      assertEqual(Object.values(w).some(Boolean), false, `${label}: walk all false whatever the override`);
    } finally { await r.close(); }
  }
  console.log('  api/walk-scope: capabilities.definitions.walk per gate (farIds never), all false on unknown firmware / without a walk');
}

// ── 13. a bound hit is a blocking coverage gap ────────────────────────────────────────────────────────────────────
async function boundHitGap(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: [] });
  try {
    const ceiling = deviceCache.walkBlockLimits(FM3, 'read-only').bound[70]!;
    await build(r, { walkImpl: async () => walkResult(liveSeedRecords(), { boundHits: [{ block: 70, lastReal: ceiling - 1, bound: ceiling }] }) });
    const st = (await r.app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    const gap = st.coverage?.gaps.find((g) => g.kind === 'bound-hit');
    assertEqual(`${gap?.blocking}/${gap?.eids?.join(',')}/${st.coverage?.complete}`, 'true/70/false', 'the bound hit at the DELAY block: a blocking gap');
    assertEqual(st.coverage?.walk?.boundHits, 1, 'coverage.walk.boundHits');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: a walk\'s bound hit → blocking bound-hit gap');
}

// ── 14. the development hooks need the explicit opt-in ────────────────────────────────────────────────────────────
async function devHooksOptIn(): Promise<void> {
  // the helper
  let w = await capturingWarnings(() => [devHookValue({ X_HOOK: 'v' }, 'X_HOOK'), devHookValue({ X_HOOK: 'v' }, 'X_HOOK')]);
  assertEqual(`${w.value.join(',')}|${w.warnings.length}`, ',|1', 'no opt-in: ignored, one warning per value');
  w = await capturingWarnings(() => [devHookValue({ X_HOOK: 'v', [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' }, 'X_HOOK')]);
  assertEqual(`${w.value[0]}|${w.warnings.length}|${w.warnings[0]?.includes('ignored in production')}`, 'undefined|1|true', 'production: ignored with the opt-in');
  w = await capturingWarnings(() => [devHookValue({ X_HOOK: 'v', [DEV_HOOKS_ENV]: ' 1 ' }, 'X_HOOK')]);
  assertEqual(`${w.value[0]}|${w.warnings.length}`, 'v|0', 'opt-in: the value, no warning from the helper');
  assertEqual(`${devHookValue({ [DEV_HOOKS_ENV]: '1' }, 'X_HOOK')}/${devHookValue(undefined, 'X_HOOK')}`, 'undefined/undefined', 'unset / no environment (browser)');
  assertEqual(`${devHooksEnabled({ [DEV_HOOKS_ENV]: '1' })}/${devHooksEnabled({ [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' })}/${devHooksEnabled({})}`, 'true/false/false', 'devHooksEnabled');

  // FORGEFX_DEFS_HIDE_FAMILY
  const hide = (vars: Record<string, string | undefined>) => withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'RESONATOR', ...vars }, () => capturingWarnings(() => hiddenFamily()));
  let h = await hide({ [DEV_HOOKS_ENV]: undefined, NODE_ENV: undefined });
  assert(h.value === null && h.warnings.some((x) => x.includes(DEV_HOOKS_ENV)), 'hide family: no opt-in → nothing hidden, warned');
  h = await hide({ [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' });
  assertEqual(h.value, null, 'hide family: production → nothing hidden');
  h = await hide({ [DEV_HOOKS_ENV]: '1', NODE_ENV: undefined });
  assertEqual(h.value, 'RESONATOR', 'hide family: opt-in → hidden');
  assertEqual(hiddenFamily(), null, 'hide family: unset again → nothing hidden');

  // FORGEFX_DEFS_FORCE_GENERIC
  const FM3P = PROFILES[FM3]!;
  const delay = eidOfSlug('delay');
  const stride = FM3P.rangeSections.DELAY!.stride;
  const values = Array.from({ length: stride * 4 }, (_, i) => (i * 311 + 17) % 60000);
  const pid3 = (vars: Record<string, string | undefined>) => withEnv({ FORGEFX_DEFS_FORCE_GENERIC: 'DELAY:3', ...vars }, () => capturingWarnings(async () => {
    const res = await mockBlockDevice(FM3P, { [delay]: { values, channel: 0 } }).driver.blockParams(delay, { generic: true }) as BlockParamsV2DTO;
    const e = res.enums.find((x) => x.id === 3);
    return `${e?.name}/${e?.generic}`;
  }));
  const catalogName = (await pid3({ FORGEFX_DEFS_FORCE_GENERIC: undefined })).value;
  assert(!catalogName.startsWith('P3/'), `fixture: DELAY pid 3 has a catalog name (${catalogName})`);
  assertEqual((await pid3({ [DEV_HOOKS_ENV]: undefined, NODE_ENV: undefined })).value, catalogName, 'force generic: no opt-in → ignored');
  assertEqual((await pid3({ [DEV_HOOKS_ENV]: '1', NODE_ENV: 'production' })).value, catalogName, 'force generic: production → ignored');
  assertEqual((await pid3({ [DEV_HOOKS_ENV]: '1', NODE_ENV: undefined })).value, 'P3/true', 'force generic: opt-in → served generic');
  console.log('  api/walk-scope: all three development hooks need FORGEFX_DEV_HOOKS=1 and are ignored in production');
}

// ── 15. the gates are judged on a fresh firmware read ─────────────────────────────────────────────────────────────
async function firmwareFreshness(): Promise<void> {
  const table = WALK_SCOPE_VERIFIED_FW as Record<number, unknown>;
  const fw12 = [{ major: 12, minor: 0 }];
  table[FM3] = { extendedIds: fw12, above160: fw12, blockProbe: [], farIds: [] }; // as if FM3 12.0 had passed acceptance
  const state: { fw: readonly [number, number] | null } = { fw: [12, 0] };
  clearDoc();
  store.defaultStore.delDoc('deviceCaches', KEY13);
  const r = await makeRig({ override: [], fwState: state });
  try {
    assertEqual((await definitionsCaps(r)).walk.extendedIds, true, 'premise: the table entry opens the gates on the detected 12.0');
    // the unit was updated to 13.0 since detect: a default build re-reads the firmware; its gates are closed there
    state.fw = [13, 0];
    const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { walkImpl: walk });
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${walk.calls.length}/${done?.key}/${done?.extension}`, `1/${KEY13}/undefined`, 'firmware changed since detect: one walk, keyed by the fresh 13.0, standard');
    assertEqual(r.registry.firmwareInfo()?.version, '13.0', 'the registry holds the fresh version');
    // back on 12.0: an explicit extended build reads it again and extends
    r.events.length = 0;
    state.fw = [12, 0];
    const again = twoPhase(async () => liveSeedRecords(), async () => phaseBRecords());
    await build(r, { walkImpl: again, scope: 'extended' });
    assertEqual(`${again.calls.length}/${terminal(r).find((e) => e.phase === 'done')?.extension}`, '2/done', 'on 12.0 again: phase B runs');
    // a unit that does not answer the version read: fail closed (standard only; the cached version keys the build)
    r.events.length = 0;
    state.fw = null;
    const silent = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { walkImpl: silent, scope: 'extended', force: true });
    const d = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${silent.calls.length}/${d?.key}/${d?.extension}`, `1/${KEY}/skipped`, 'unreadable firmware: standard only, skipped');
    assertEqual(r.registry.firmwareInfo()?.version, '12.0', 'unreadable firmware: the version read before is kept');
  } finally {
    delete table[FM3];
    clearDoc();
    store.defaultStore.delDoc('deviceCaches', KEY13);
    await r.close();
  }
  console.log('  api/walk-scope: the gates are judged on a fresh firmware read (changed → its gates, unreadable → standard only)');
}

/** A gen-3-shaped fake driver with the full-capture capability (full builds need it); no telemetry, no listeners. */
function fakeFullDriver(): DeviceDriver {
  const caps = {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, presetConvert: true, blockParamDecode: true,
    telemetry: { tuner: false, outputMeters: false, cpu: false },
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: true,
    supportsSave: true, selfDescribe: true, cacheImport: true, fullCapture: true,
    deviceEditPush: false, deviceEditWatch: false
  } as unknown as DriverCapabilities;
  return {
    modelId: FM3, key: 'fm3', name: 'FM3', capabilities: caps,
    grid: async () => ({ model: 'fm3', name: 'F', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const }),
    presetRef: async () => ({ number: 7, name: 'Cur' }),
    selectPreset: async () => ({ ok: true }),
    reloadPreset: async () => {}
  } as unknown as DeviceDriver;
}

// ── 16. full mode is unchanged: standard by default, the extension only on request ───────────────────────────────
async function fullModeScope(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'], driver: fakeFullDriver() });
  try {
    const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error('phase B must not run'); });
    await build(r, { mode: 'full', walkImpl: walk });
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${walk.calls.length}/${walk.calls[0]?.mode}/${done?.extension}`, '1/full/undefined', 'full, no scope, gates open: one full walk, no extension');
    r.events.length = 0;
    const again = await build(r, { mode: 'full', walkImpl: walk });
    assertEqual(`${(again.body as { already?: boolean }).already}/${walk.calls.length}`, 'true/1', 'full again: already (open gates never re-run the sweep)');
    r.events.length = 0;
    const ext = twoPhase(async () => liveSeedRecords(), async () => familyRecords('RESONATOR', 162));
    await build(r, { mode: 'full', scope: 'extended', force: true, walkImpl: ext });
    const b = ext.calls[1];
    assertEqual(`${ext.calls.length}/${b?.mode}/${b?.write}/${b?.blocks?.join(',')}`, '2/undefined/undefined/162,163,166,178,182,183,186,187,191,192', 'full + explicit extended: phase B read-only, above 160 only');
    assertEqual(terminal(r).find((e) => e.phase === 'done')?.extension, 'done', 'full + explicit extended: done');
    const s = liveSourceOf(storedDoc());
    assertEqual(`${s?.kind}/${s?.scope.above160}/${s?.scope.extended}`, 'live-full/true/false', 'the full source joined by the blocks above 160');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: full builds stay standard by default (already stays already); extended only on request, read-only');
}

// ── 17. the stored abort reason is a fixed vocabulary ─────────────────────────────────────────────────────────────
async function abortReasonVocabulary(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    const secret = 'C:\\Users\\Jane Q Private\\AppData\\walk.log';
    const walk = twoPhase(async () => liveSeedRecords(), async () => { throw new Error(`${secret} ${'x'.repeat(5000)}`); });
    const w = await capturingWarnings(() => build(r, { walkImpl: walk }));
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${done?.extension}/${done?.abortReason}`, 'aborted/walk-failed', 'a free-text failure: the fixed reason walk-failed');
    assertEqual(liveSourceOf(storedDoc())?.walk.abortReason, 'walk-failed', 'stored: walk-failed');
    const raw = JSON.stringify(storedDoc());
    assert(!raw.includes('Jane Q Private') && !raw.includes('xxxxxxxxxx'), 'the stored doc carries none of the message');
    assert(w.warnings.some((x) => x.includes('Jane Q Private')), 'the details go to the log only');
    const exp = await r.app.inject({ method: 'GET', url: '/device/definitions/export' });
    assertEqual(exp.statusCode, 200, '.axisdefs export: 200');
    assert(!exp.payload.includes('Jane Q Private') && exp.payload.includes('"abortReason":"walk-failed"'), 'the export carries the fixed reason only');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: abortReason is a fixed vocabulary (no message, no path stored or exported), details logged');
}

// ── 18. join safety and the joined reply statistics ───────────────────────────────────────────────────────────────
async function joinSafetyAndStats(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    const walk = twoPhase(async () => liveSeedRecords(), async () => familyRecords('RESONATOR', 162)); // the amp block lost
    await build(r, { walkImpl: walk });
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${done?.extension}/${done?.abortReason}`, 'aborted/empty-block (block 58)', 'phase B found nothing where phase A had rows: aborted');
    const s = liveSourceOf(storedDoc());
    assertEqual(`${s?.records.filter((x) => x.section === 58).length}/${s?.records.some((x) => x.section === 162)}`, `${liveSeedRecords().filter((x) => x.section === 58).length}/false`, 'phase A kept whole');
  } finally { clearDoc(); await r.close(); }

  const opts = deviceCache.extensionWalkSetup(store.defaultStore, FM3, { major: 12, minor: 0 }, ALL_GATES, 'read-only').opts;
  const a = liveSource(liveSeedRecords(), { stats: { lostReplies: 3, recoveredReplies: 1, unresolvedReplies: 2, missingSlots: 1, silentAddresses: 4 } });
  const b = walkResult(phaseBRecords(), { lostReplies: 1 });
  const JOINED = { extended: true, above160: true };
  const stats = (x: LiveRawSource) => `${x.walk.lostReplies}/${x.walk.recoveredReplies}/${x.walk.unresolvedReplies}/${x.walk.missingSlots}/${x.walk.silentAddresses}`;
  assertEqual(stats(deviceCache.joinExtension(a, b, opts, JOINED, new Set([58, 2]))), '1/0/0/0/0', 'phase A lost replies only in re-walked blocks: its loss counters are dropped');
  assertEqual(stats(deviceCache.joinExtension(a, b, opts, JOINED, new Set([58, 70]))), '4/1/2/1/4', 'a lost reply in a block not re-walked (70): summed');
  assertEqual(stats(deviceCache.joinExtension(a, b, opts, JOINED)), '4/1/2/1/4', 'without the loss map: summed');
  assertEqual(stats(deviceCache.joinExtension(a, b, opts, JOINED, new Set())), '4/1/2/1/4', 'an empty loss map with counted losses: summed');
  assertEqual(deviceCache.joinExtension(a, b, opts, JOINED, new Set([58])).walk.queries, a.walk.queries + b.queries, 'queries: always summed');
  console.log('  api/walk-scope: a block phase B found empty aborts (phase A kept); phase A losses dropped only where superseded');
}

/** Continuous MSB-first septet stream of `raw` (the inverse of the codec's septet decoding). */
function septets(raw: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    n += 8;
    while (n >= 7) { n -= 7; out.push((acc >> n) & 0x7f); }
    acc &= (1 << n) - 1;
  }
  if (n > 0) out.push((acc << (7 - n)) & 0x7f);
  return out;
}

/** A synthetic self-describe reply of the FM3 echoing view / block-high / param; `raw` null = a no-payload reply. */
function sdReply(view: number, block: number, param: number, raw: Uint8Array | null): number[] {
  const inner = new Array<number>(15).fill(0);
  inner[0] = view; inner[2] = 0x01; inner[3] = (block >> 7) & 0x7f; inner[4] = param & 0x7f; inner[5] = (param >> 7) & 0x7f;
  inner[6] = raw ? 0x3a : 0x40;
  inner[13] = raw ? raw.length : 0;
  const body = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, ...inner, ...(raw ? septets(raw) : [])];
  return [...body, body.reduce((x, y) => x ^ y, 0) & 0x7f, 0xf7];
}

/** A 36-byte synthetic definition body. */
function defRaw(d: { tc: number; min: number; max: number; scale?: number; def?: number; step?: number; id: number }): Uint8Array {
  const b = new Uint8Array(36);
  const v = new DataView(b.buffer);
  v.setUint32(0, d.id, true); v.setUint32(4, d.tc, true);
  v.setFloat32(8, d.min, true); v.setFloat32(12, d.max, true); v.setFloat32(16, d.scale ?? 0, true);
  v.setFloat32(20, d.def ?? 0, true); v.setFloat32(24, d.step ?? 0, true);
  return b;
}

/** A synthetic FM3 answering the walk's queries in the phase-B blocks: a real definition (its own symbol id) for every
 *  id of a block's table — generic float rows; GLOBAL's low region 0..131; the amp block: its seed rows, generic rows
 *  at 0..3 and 128..143, unused slots in between — the empty-slot definition past a table's end and in unused slots,
 *  a numeric formatted value, a no-payload label reply. `implausibleAt`: that one definition answers with its bounds
 *  the wrong way round. */
function dryRunDevice(implausibleAt?: { block: number; param: number }): (req: readonly number[]) => number[][] {
  const P = PROFILES[FM3]!;
  const sizes = new Map<number, number>([[1, 132], [2, P.rangeSections.CONTROLLERS!.stride], [58, P.rangeSections.DISTORT!.stride]]);
  for (const [b, fam] of [[162, 'RESONATOR'], [163, 'RESONATOR'], [166, 'LOOPER'], [178, 'PLEX'], [182, 'FDBKSEND'], [183, 'FDBKSEND'], [186, 'FDBKRET'], [187, 'FDBKRET'], [191, 'MULTIPLEXER'], [192, 'MULTIPLEXER']] as const) {
    sizes.set(b, P.rangeSections[fam]!.stride);
  }
  const seeds = new Map(liveSeedRecords().filter((x) => x.section === 58).map((x) => [x.id, x]));
  const ascii = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
  return (req) => {
    const view = req[6]!;
    const block = (req[8]! & 0x7f) | ((req[9]! & 0x7f) << 7);
    const param = (req[10]! & 0x7f) | ((req[11]! & 0x7f) << 7);
    if (view === VIEW_DEFINITION) {
      if (implausibleAt && implausibleAt.block === block && implausibleAt.param === param) {
        return [sdReply(view, block, param, defRaw({ tc: 1, min: 10, max: 0, scale: 1, def: 1, id: 5000 + param }))];
      }
      // the amp table: its seed rows (the section vote anchors on them), generic rows at 0..3 (a block whose first ids
      // are all unused is skipped) and 128..143, unused slots in between
      const s = block === 58 ? seeds.get(param) : undefined;
      if (s) return [sdReply(view, block, param, defRaw({ tc: s.tc, min: s.min, max: s.max, scale: 1, def: s.def, step: s.step, id: 1000 + param }))];
      if (param < (sizes.get(block) ?? 0) && (block !== 58 || param < 4 || param >= 128)) {
        return [sdReply(view, block, param, defRaw({ tc: block === 58 ? 0 : 1, min: 0, max: 10, scale: 1, def: 1, id: 1000 + param }))];
      }
      return [sdReply(view, block, param, defRaw({ tc: 0, min: 0, max: 0, id: 0 }))];
    }
    if (view === VIEW_VALUE) return [sdReply(view, block, param, ascii('5.00'))];
    return [sdReply(view, block, param, null)];
  };
}

// ── 19. an H3 dry run: the codec's own walk as phase B over a synthetic unit ─────────────────────────────────────
async function dryRunRealWalk(): Promise<void> {
  const bounds = deviceCache.extensionWalkLimits(FM3, null, ALL_GATES).bound;
  const queryOf = (f: readonly number[]) => ({ block: (f[8]! & 0x7f) | ((f[9]! & 0x7f) << 7), param: (f[10]! & 0x7f) | ((f[11]! & 0x7f) << 7) });
  for (const implausible of [false, true]) {
    clearDoc();
    const r = await makeRig({ override: ['extended', 'above160'], walkReply: dryRunDevice(implausible ? { block: 58, param: 140 } : undefined) });
    try {
      // the real walk, unpaced for the test (the pacing is no part of the scope the watchdog checks)
      const walk = twoPhase(async () => liveSeedRecords(), (t, o) => liveWalkDetailed(t, { ...o, interQueryMs: 0, blockPauseMs: 0, lostReplyDrainMs: 0 }));
      const before = r.mock.sent.length;
      await build(r, { walkImpl: walk });
      const sent = r.mock.sent.slice(before);
      assert(sent.every((f) => (f[5] === 0x01 ? [VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE].includes(f[6]!) : f[5] === 0x08)), 'dry run: walk queries (and the firmware read) only, no write frame');
      const maxBy = new Map<number, number>();
      for (const f of sent.filter((x) => x[5] === 0x01)) {
        const q = queryOf(f);
        maxBy.set(q.block, Math.max(maxBy.get(q.block) ?? -1, q.param));
      }
      assert([...maxBy.keys()].every((b) => FM3_PHASE_B.includes(b)), `dry run: only phase-B blocks queried (${[...maxBy.keys()].join(',')})`);
      const done = terminal(r).find((e) => e.phase === 'done');
      if (!implausible) {
        for (const b of FM3_PHASE_B) assertEqual(maxBy.get(b), bounds[b], `dry run: block ${b} queried up to exactly its bound`);
        assertEqual(`${done?.extension}/${done?.abortReason}`, 'done/undefined', 'dry run: done');
        const s = liveSourceOf(storedDoc())!;
        assertEqual(Math.max(...s.records.filter((x) => x.section === 58).map((x) => x.id)), 143, 'dry run: the amp table read to id 143');
        assertEqual(`${s.walk.pseudoReplies?.implausible ?? 0}/${s.scope.bounds[58]}/${s.scope.extended}`, '0/175/true', 'dry run: no implausible reply, the extended scope stored');
      } else {
        assertEqual(maxBy.get(58), 140, 'implausible at 140: nothing queried past it');
        assert(!maxBy.has(162), 'implausible at 140: the walk stopped there (no later block)');
        assertEqual(`${done?.extension}/${done?.abortReason}`, 'aborted/implausible-reply (block 58, param 140)', 'implausible at 140: aborted');
        assertEqual(liveSourceOf(storedDoc())?.records.length, liveSeedRecords().length, 'implausible at 140: phase A kept');
      }
    } finally { clearDoc(); await r.close(); }
  }
  console.log('  api/walk-scope: H3 dry run — the real walk queries each phase-B block to exactly its bound; a device-side implausible reply at 140 aborts');
}

// ── 20. a phase-B result that does not derive keeps phase A ──────────────────────────────────────────────────────
async function derivationFailureKeepsA(): Promise<void> {
  clearDoc();
  const r = await makeRig({ override: ['extended', 'above160'] });
  try {
    // a record no profile may carry (a user name table id): the derivation refuses the joined source
    const userTable = { kind: 'enum', section: 162, offset: 0, id: 0xffff, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['a', 'b'], x: 0 } as CacheRecord;
    const walk = twoPhase(async () => liveSeedRecords(), async () => [...phaseBRecords(), userTable]);
    const w = await capturingWarnings(() => build(r, { walkImpl: walk }));
    const done = terminal(r).find((e) => e.phase === 'done');
    assertEqual(`${done?.extension}/${done?.abortReason}`, 'aborted/derivation-failed', 'phase B does not derive: aborted, derivation-failed');
    const s = liveSourceOf(storedDoc());
    assertEqual(`${s?.scope.extended}/${s?.records.length}/${s?.walk.abortReason}`, `false/${liveSeedRecords().length}/derivation-failed`, 'phase A kept, marked');
    assert(w.warnings.some((x) => x.includes('derivation-failed')), 'the details are logged');
  } finally { clearDoc(); await r.close(); }
  console.log('  api/walk-scope: a phase-B result that does not derive aborts the extension, phase A kept');
}

// ── 21. a late cancel (after the walk, after the merge) discards phase B ──────────────────────────────────────────
async function lateCancelAfterMerge(): Promise<void> {
  const target = store.defaultStore as { getDoc: typeof store.defaultStore.getDoc };
  const original = target.getDoc;
  for (const when of ['after the walk', 'during the merge'] as const) {
    clearDoc();
    const r = await makeRig({ override: ['extended', 'above160'] });
    let armed = false;
    target.getDoc = (collection, id) => {
      if (armed && collection === 'deviceCaches') { armed = false; deviceCache.cancelCacheBuild(r.registry); }
      return original(collection, id);
    };
    try {
      const walk = twoPhase(async () => liveSeedRecords(), async () => {
        if (when === 'after the walk') deviceCache.cancelCacheBuild(r.registry);
        else armed = true; // the next store read is the merge of the joined source
        return phaseBRecords();
      });
      await build(r, { walkImpl: walk });
      const done = terminal(r).find((e) => e.phase === 'done' || e.phase === 'cancelled');
      assertEqual(`${done?.phase}/${done?.extension}/${done?.abortReason}`, 'done/aborted/cancelled', `cancel ${when}: the extension is discarded`);
      const s = liveSourceOf(storedDoc());
      assertEqual(`${s?.walk.extension}/${s?.records.some((x) => x.section === 162)}/${s?.scope.extended}`, 'aborted/false/false', `cancel ${when}: phase A kept, nothing of phase B`);
    } finally { target.getDoc = original; clearDoc(); await r.close(); }
  }
  console.log('  api/walk-scope: a late cancel (after the walk / during the merge) discards phase B, phase A kept');
}

export async function runWalkScopeTests(): Promise<void> {
  const saved = { scope: process.env.FORGEFX_WALK_SCOPE_OVERRIDE, hide: process.env.FORGEFX_DEFS_HIDE_FAMILY, force: process.env.FORGEFX_DEFS_FORCE_GENERIC, optIn: process.env[DEV_HOOKS_ENV] };
  delete process.env.FORGEFX_WALK_SCOPE_OVERRIDE;
  delete process.env.FORGEFX_DEFS_HIDE_FAMILY;
  delete process.env.FORGEFX_DEFS_FORCE_GENERIC;
  delete process.env[DEV_HOOKS_ENV];
  try {
    extendedBoundsPerDevice();
    await boundSources();
    budgetAndOptions();
    await gatesFailClosed();
    await overrideOptIn();
    await twoPhaseBuild();
    await phaseBAborts();
    await budgetOverrun();
    await boundWatchdog();
    await timeoutIsLostReply();
    await extensionSkipped();
    await capsPerGate();
    await boundHitGap();
    await devHooksOptIn();
    await firmwareFreshness();
    await fullModeScope();
    await abortReasonVocabulary();
    await joinSafetyAndStats();
    await dryRunRealWalk();
    await derivationFailureKeepsA();
    await lateCancelAfterMerge();
  } finally {
    clearDoc();
    store.defaultStore.delDoc('deviceCaches', KEY13);
    for (const [k, v] of [['FORGEFX_WALK_SCOPE_OVERRIDE', saved.scope], ['FORGEFX_DEFS_HIDE_FAMILY', saved.hide], ['FORGEFX_DEFS_FORCE_GENERIC', saved.force], [DEV_HOOKS_ENV, saved.optIn]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
