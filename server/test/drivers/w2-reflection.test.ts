// Workstream W2 — polling / reflection supervisor regressions. Mocked transport, NO hardware.
//   W2.1 a slow (5-pin DIN) link must still run the cheap scene/channel reflection watches
//        (throttled) instead of disabling ALL device→UI reflection; meters stay skipped.
//   W2.2 a FAILED fn-0x13 status read must surface as an error, not be reported as an EMPTY scene
//        state ([] blinds Axis's bypass/channel view).
//   W2.4 a UI channel write must not be followed by a redundant blockState from the channel watch
//        (the registry's channel baseline is only reset on `scene` events today).
//   W2.5 AM4 setScene must emit a `scene` event like gen-3's setScene (other windows/remotes learn).
// W2.3 is documented / design-flagged (see the W2 report) — not encoded here.
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

export const W2_REFLECTION_CASE_COUNT = 5;

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

/** W2.1 — a slow link still reflects scene + channel changes (throttled); meters stay skipped. */
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
    getActiveChannels: async () => { chanCalls++; return new Map<number, number>([[1, 0]]); }
  } as unknown as DeviceDriver;

  const reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect();
  const events: DeviceEvent[] = [];
  const unsub = reg.subscribe((e) => events.push(e));
  await sleep(2600); // slow tick = 2000 ms; need prime + one change tick
  unsub();

  assert(sceneCalls >= 2, `W2.1: the scene watch ran on a slow link (getScene calls=${sceneCalls})`);
  assert(events.some((e) => e.type === 'scene' && e.index === 1), 'W2.1: a slow-link scene change still yields a scene event');
  assert(chanCalls >= 1, `W2.1: the channel watch ran on a slow link (getActiveChannels calls=${chanCalls})`);
  assert(!mock.sent.some((f) => f[5] === 0x01), 'W2.1: meter/CPU reads (fn 0x01) stay skipped on a slow link');
}

/** W2.2 — a failed status read must throw, not masquerade as an empty scene state. */
async function emptySceneStateIsAnError(): Promise<void> {
  // silent fn-0x13 → the status read failed
  const silent = new MockTransport('serial', '/dev/ttyACM0');
  silent.isOpen = true;
  silent.reply = () => [];
  const drvFail = createGen3Driver(PROFILES[0x11]!, { transport: async () => silent, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
  let threw = false;
  try { await drvFail.sceneState!(); } catch { threw = true; }
  assert(threw, 'W2.2: a failed fn-0x13 read must surface as an error, not an empty sceneState []');

  // positive control: a real (non-empty) status dump still parses through
  const ok = new MockTransport('serial', '/dev/ttyACM0');
  ok.isOpen = true;
  const dump = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x13, 0x02, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0xf7];
  ok.reply = () => [dump];
  const drvOk = createGen3Driver(PROFILES[0x11]!, { transport: async () => ok, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
  const st = await drvOk.sceneState!();
  assertEqual(st.length, 2, 'W2.2: a valid status dump yields per-block scene state');
}

/** W2.4 — a UI channel write must not trigger a redundant blockState from the channel watch. */
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
  assertEqual(afterWrite - before, 1, 'W2.4: the UI channel write emits exactly one blockState');
  await waitFor(() => chanCalls >= 2, 3000, 'the next channel-watch tick');
  await sleep(150); // let any extra tick land
  const total = events.filter((e) => e.type === 'blockState').length;
  assertEqual(total - before, 1, 'W2.4: no redundant blockState after the UI channel write (stale baseline reset)');
  unsub();
}

/** W2.5 — AM4 setScene emits a scene event like gen-3's setScene. */
async function am4SetSceneEmitsScene(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.isOpen = true;
  const events: DeviceEvent[] = [];
  const ctx: DriverCtx = { transport: async () => mock, emit: (e) => events.push(e), getCadence: () => cadenceFor(0x15, 'balanced') };
  const drv = createAm4Driver(ctx);
  await drv.setScene(2);
  assert(events.some((e) => e.type === 'scene' && e.index === 2), 'W2.5: AM4 setScene emits a scene event (like gen-3)');
}

/** W2.1 (second half) — the FM3 device-edit watch poll also still runs on a slow link (throttled). */
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
  assert(editReads >= 1, `W2.1: the FM3 edit-watch poll still runs on a slow link (reads=${editReads})`);
}

export async function runW2ReflectionTests(): Promise<void> {
  setConnOverride(null);
  setProfileOverride(null);
  const cases: [string, () => Promise<void>][] = [
    ['W2.1 slow-link reflection', slowLinkReflection],
    ['W2.2 empty sceneState is an error', emptySceneStateIsAnError],
    ['W2.1 slow-link edit-watch', slowLinkEditWatch],
    ['W2.4 no duplicate blockState', noDuplicateBlockState],
    ['W2.5 AM4 setScene emits scene', am4SetSceneEmitsScene]
  ];
  const failures: string[] = [];
  for (const [name, fn] of cases) {
    try { await fn(); } catch (e) { failures.push(`${name}: ${(e as Error).message}`); }
  }
  if (failures.length) throw new Error(failures.join(' | '));
}
