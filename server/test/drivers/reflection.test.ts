// Polling / reflection supervisor regressions. Mocked transport, NO hardware.
//   1. a slow (5-pin DIN) link must still run the cheap scene/channel reflection watches
//      (throttled) instead of disabling ALL device→UI reflection; meters stay skipped.
//   2. a FAILED fn-0x13 status read must surface as an error, not be reported as an EMPTY scene
//      state ([] blinds the client's bypass/channel view).
//   3. a UI channel write must not be followed by a redundant blockState from the channel watch
//      (the registry's channel baseline used to be reset only on `scene` events).
//   4. AM4 setScene must emit a `scene` event like gen-3's setScene (other windows/remotes learn).
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { createAm4Driver } from '../../src/drivers/am4.js';
import { PROFILES } from '../../src/devices.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import type { Conn } from '../../src/transport/types.js';
import type { DeviceDriver, DeviceEvent, DriverCtx, DriverCapabilities } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const REFLECTION_CASE_COUNT = 7;

function makeReg(conn: Conn | null, mock: MockTransport): DeviceRegistry {
  return __createRegistryForTest({
    resolveConn: async () => conn,
    openConn: () => mock,
    listConnections: async () => [] // keep diagnostics() offline + fast
  });
}
const serial = (mock: MockTransport): Conn => ({ transport: 'serial', id: mock.label });

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

function gen3Caps(extra: Partial<DriverCapabilities> = {}): DriverCapabilities {
  return {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, blockParamDecode: true,
    telemetry: { tuner: false, outputMeters: true, cpu: false },
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: false, supportsSave: true,
    deviceEditPush: false, deviceEditWatch: false,
    ...extra
  } as DriverCapabilities;
}
const fakeGrid = async () => ({ model: 'fm3', name: 'x', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const });

/** A slow link still reflects scene + channel changes (throttled); meters stay skipped. */
async function slowLinkReflection(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  (mock as { slow: boolean }).slow = true; // generic 5-pin DIN adapter — the exact case detect() supports
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);

  let sceneCalls = 0;
  let chanCalls = 0;
  const sceneSeq = [0, 1]; // prime scene 0, then a front-panel switch to scene 1
  const fake = {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: gen3Caps(),
    grid: fakeGrid,
    getScene: async () => ({ index: sceneSeq[Math.min(sceneCalls++, sceneSeq.length - 1)]! }),
    // The same front-panel scene switch also moves the block's active channel (A → B) on the second tick.
    getActiveChannels: async () => { chanCalls++; return new Map<number, number>([[1, chanCalls >= 2 ? 1 : 0]]); }
  } as unknown as DeviceDriver;

  const reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect();
  const events: DeviceEvent[] = [];
  const unsub = reg.subscribe((e) => events.push(e));
  await sleep(2600); // slow tick = 2000 ms; need prime + one change tick
  unsub();

  assert(sceneCalls >= 2, `the scene watch ran on a slow link (getScene calls=${sceneCalls})`);
  assert(events.some((e) => e.type === 'scene' && e.index === 1), 'a slow-link scene change still yields a scene event');
  assert(chanCalls >= 2, `the channel watch ran on a slow link (getActiveChannels calls=${chanCalls})`);
  // Both watches run on the same slow tick; the scene watch goes first and its `scene` event re-primes the
  // channel baseline, so the scene switch's own channel move is not announced as a separate blockState.
  assert(!events.some((e) => e.type === 'blockState'), 'a scene change on a slow link does not emit a blockState ahead of the scene');
  assert(!mock.sent.some((f) => f[5] === 0x01), 'meter/CPU reads (fn 0x01) stay skipped on a slow link');
}

/** A failed status read must throw, not masquerade as an empty scene state. */
async function emptySceneStateIsAnError(): Promise<void> {
  // silent fn-0x13 → the status read failed
  const silent = new MockTransport('serial', '/dev/ttyACM0');
  silent.isOpen = true;
  silent.reply = () => [];
  const drvFail = createGen3Driver(PROFILES[0x11]!, { transport: async () => silent, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
  let threw = false;
  try { await drvFail.sceneState!(); } catch { threw = true; }
  assert(threw, 'a failed fn-0x13 read must surface as an error, not an empty sceneState []');
  assertEqual(silent.sent.filter((f) => f[5] === 0x13).length, 2, 'a failed status read is retried exactly once before throwing');

  // positive control: a real (non-empty) status dump still parses through
  const ok = new MockTransport('serial', '/dev/ttyACM0');
  ok.isOpen = true;
  const dump = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x13, 0x02, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0xf7];
  ok.reply = () => [dump];
  const drvOk = createGen3Driver(PROFILES[0x11]!, { transport: async () => ok, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
  const st = await drvOk.sceneState!();
  assertEqual(st.length, 2, 'a valid status dump yields per-block scene state');
  assertEqual(ok.sent.filter((f) => f[5] === 0x13).length, 1, 'a successful status read is not repeated');
}

/** The device is still rebuilding right after a scene switch: an empty first status read is retried once
 *  and the retry's dump is used, instead of failing (503 → the client falls back to a full preset dump). */
async function sceneStateRetriesAnEmptyFirstRead(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.isOpen = true;
  const dump = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x13, 0x02, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0xf7];
  let statusReads = 0;
  mock.reply = (req) => (req[5] === 0x13 ? (++statusReads === 1 ? [] : [dump]) : []);
  const drv = createGen3Driver(PROFILES[0x11]!, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
  const st = await drv.sceneState!();
  assertEqual(st.length, 2, 'the retry after an empty first read yields the scene state');
  assertEqual(statusReads, 2, 'exactly one retry was issued');
}

/** A UI channel write must not trigger a redundant blockState from the channel watch. */
async function noDuplicateBlockState(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.isOpen = true;
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  let channel = 0;
  let chanCalls = 0;
  let reg!: DeviceRegistry;
  const fake = {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: gen3Caps(),
    grid: fakeGrid,
    getActiveChannels: async () => { chanCalls++; return new Map<number, number>([[1, channel]]); },
    getScene: async () => ({ index: 0 }),
    // stand in for gen3.setChannel: flips the device channel AND emits blockState on the SSE bus
    setChannel: async (eid: number, ch: string) => { channel = 'ABCD'.indexOf(ch.toUpperCase()); reg.emitEvent({ type: 'blockState', effectId: eid }); return { ok: true }; }
  } as unknown as DeviceDriver;

  reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect();
  const events: DeviceEvent[] = [];
  const unsub = reg.subscribe((e) => events.push(e));
  reg.setTelemetryMode('performance'); // 60 ms tick → fast
  await waitFor(() => chanCalls >= 1, 3000, 'channel-watch primer');
  const before = events.filter((e) => e.type === 'blockState').length;
  await fake.setChannel!(1, 'B');
  const afterWrite = events.filter((e) => e.type === 'blockState').length;
  assertEqual(afterWrite - before, 1, 'the UI channel write emits exactly one blockState');
  await waitFor(() => chanCalls >= 2, 3000, 'the next channel-watch tick');
  await sleep(150); // let any extra tick land
  const total = events.filter((e) => e.type === 'blockState').length;
  assertEqual(total - before, 1, 'no redundant blockState after the UI channel write (stale baseline reset)');
  unsub();
}

/** AM4 setScene emits a scene event like gen-3's setScene. */
async function am4SetSceneEmitsScene(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.isOpen = true;
  const events: DeviceEvent[] = [];
  const ctx: DriverCtx = { transport: async () => mock, emit: (e) => events.push(e), getCadence: () => cadenceFor(0x15, 'balanced') };
  const drv = createAm4Driver(ctx);
  await drv.setScene(2);
  assert(events.some((e) => e.type === 'scene' && e.index === 2), 'AM4 setScene emits a scene event (like gen-3)');
}

/** On a slow link, UI traffic makes the reflection watches back off at the SLOW cadence. Backing off at the
 *  fast tick would force the status + scene reads through after ~MAX_SKIPS fast ticks (~300 ms here). */
async function slowLinkYieldBackoff(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  (mock as { slow: boolean }).slow = true;
  let release: (v: number[][]) => void = () => {};
  const pending = new Promise<number[][]>((r) => { release = r; });
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(0x11)];
    if (req[0] === 0x11 && req.length === 3) return pending; // held route-driven (interactive) request
    return [];
  };
  let reads = 0;
  const fake = {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: gen3Caps(),
    grid: fakeGrid,
    getScene: async () => { reads++; return { index: 0 }; },
    getActiveChannels: async () => { reads++; return new Map<number, number>([[1, 0]]); }
  } as unknown as DeviceDriver;
  const reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect();
  reg.setTelemetryMode('performance'); // 60 ms primer tick, so a fast-tick back-off would force a read by ~240 ms
  const t = await reg.transport();
  const held = t.request([0x11, 0x22, 0x33]);
  const unsub = reg.subscribe(() => {});
  await sleep(700);
  unsub();
  release([]);
  await held;
  assertEqual(reads, 0, 'no scene/channel read is forced through within 700 ms of UI traffic on a slow link');

  // The FM3 edit-watch read is a multi-KB bulk read: on a slow link it must be rare in every mode.
  for (const mode of ['performance', 'balanced', 'reduced'] as const) {
    const cad = cadenceFor(0x11, mode);
    assert(cad.editWatchSlowMs >= 10000, `${mode}: slow-link edit-watch interval is at least 10 s (got ${cad.editWatchSlowMs} ms)`);
  }
}

/** The FM3 device-edit watch poll also still runs on a slow link (throttled). */
async function slowLinkEditWatch(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  (mock as { slow: boolean }).slow = true;
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  let editReads = 0;
  const fake = {
    modelId: 0x11, key: 'fm3', name: 'FM3',
    capabilities: gen3Caps({ deviceEditWatch: true, telemetry: { tuner: false, outputMeters: false, cpu: false } }),
    grid: fakeGrid,
    readDeviceEditState: async () => { editReads++; return { changed: false }; }
  } as unknown as DeviceDriver;

  const reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect();
  const unsub = reg.subscribe(() => {});
  await sleep(2600); // primer at editWatchMs (2000 ms), then the slow reschedule (4000 ms)
  unsub();
  assert(editReads >= 1, `the FM3 edit-watch poll still runs on a slow link (reads=${editReads})`);
}

export async function runReflectionTests(): Promise<void> {
  setConnOverride(null);
  setProfileOverride(null);
  const cases: [string, () => Promise<void>][] = [
    ['slow-link reflection', slowLinkReflection],
    ['empty sceneState is an error', emptySceneStateIsAnError],
    ['sceneState retries an empty first read', sceneStateRetriesAnEmptyFirstRead],
    ['slow-link yield back-off', slowLinkYieldBackoff],
    ['slow-link edit-watch', slowLinkEditWatch],
    ['no duplicate blockState', noDuplicateBlockState],
    ['AM4 setScene emits scene', am4SetSceneEmitsScene]
  ];
  const failures: string[] = [];
  for (const [name, fn] of cases) {
    try { await fn(); } catch (e) { failures.push(`${name}: ${(e as Error).message}`); }
  }
  if (failures.length) throw new Error(failures.join(' | '));
}
