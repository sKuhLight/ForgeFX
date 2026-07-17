// Telemetry overhaul supervisor unit tests (FORGEFX-26/27/28) — mocked Conn/Transport, NO hardware.
// Covers: cadence resolution per mode/family; cumulative traffic counters over scripted MockTransport
// traffic; the fn-0x1F echo guard (idempotent wrap + self-reply suppression still intact); the
// interactive-request detector; and the supervisor yield + starvation guard.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { setProfileOverride, setConnOverride } from '../../src/transport/connection.js';
import type { Conn } from '../../src/transport/types.js';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { cadenceFor, TELEMETRY_MODES } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';

export const TELEMETRY_CASE_COUNT = 6;

function makeReg(conn: Conn | null, mock: MockTransport): DeviceRegistry {
  return __createRegistryForTest({
    resolveConn: async () => conn,
    openConn: () => mock,
    listConnections: async () => [] // keep diagnostics() offline + fast
  });
}
const serial = (mock: MockTransport): Conn => ({ transport: 'serial', id: mock.label });

/** Minimal fake gen-3 driver (model 0x11) with just the capability flags a supervisor test toggles. */
function fakeGen3(opts: { outputMeters?: boolean; editPush?: boolean; onBurst?: () => void }): DeviceDriver {
  const caps = {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, blockParamDecode: true,
    telemetry: { tuner: false, outputMeters: !!opts.outputMeters, cpu: false },
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: false, supportsSave: true,
    deviceEditPush: !!opts.editPush
  } as DriverCapabilities;
  return {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities: caps,
    grid: async () => ({ model: 'fm3', name: 'x', crcValid: true, rows: 4, cols: 12, scenes: [], cells: [], source: 'dump' as const }),
    decodeEditBurst: opts.editPush ? () => { opts.onBurst?.(); return { events: [], reload: false }; } : undefined
  } as DeviceDriver;
}

/** a. cadenceFor: mode + family resolution (gen-3 vs AM4 vs generic/null). */
function cadenceUnit(): void {
  assertEqual(TELEMETRY_MODES.join(','), 'performance,balanced,reduced', 'mode order');
  const g3bal = cadenceFor(0x11, 'balanced');
  assertEqual(g3bal.meterTickMs, 100, 'gen-3 balanced meterTickMs (relaxed from 60)');
  assertEqual(g3bal.editWatchMs, 2000, 'gen-3 balanced editWatchMs');
  assertEqual(g3bal.tunerMs, 55, 'gen-3 tunerMs');
  const g3perf = cadenceFor(0x11, 'performance');
  assertEqual(g3perf.meterTickMs, 60, 'gen-3 performance meterTickMs');
  assertEqual(g3perf.editRehashMs, 0, 'performance editRehashMs disabled (latched rehash off in all modes)');
  const g3red = cadenceFor(0x11, 'reduced');
  assertEqual(g3red.meterTickMs, 400, 'reduced meterTickMs');
  assertEqual(g3red.cpuEveryNTicks, 16, 'reduced cpuEveryNTicks');
  assertEqual(g3red.editRehashMs, 0, 'reduced editRehashMs disabled');
  assertEqual(cadenceFor(0x15, 'balanced').tunerMs, 100, 'AM4 tunerMs (family-fixed 100)');
  assertEqual(cadenceFor(null, 'balanced').tunerMs, 55, 'generic/null tunerMs');
  // every-Nth offsets held at 8 across modes so scene/channel latency stays stable
  for (const m of TELEMETRY_MODES) assertEqual(cadenceFor(0x11, m).sceneEveryNTicks, 8, `${m} sceneEveryNTicks stable`);
}

/** b. Traffic counters: TX on send/sendQueued/request + RX on inbound frames, cumulative in /diag. */
async function trafficCounters(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeReg(serial(mock), mock);
  await reg.detect(); // opens + instruments the transport (also sends 1 identify request)
  const t = await reg.transport();
  const base = (await reg.diagnostics()).traffic as { txMsgs: number; txBytes: number; rxMsgs: number; rxBytes: number; since: number };
  assert(base.since > 0, 'traffic.since is set');

  t.send([0xf0, 0x01, 0x02, 0x03, 0xf7]);          // TX 5 bytes
  await t.sendQueued([0x11, 0x22, 0x33]);           // TX 3 bytes
  await t.request([0xf0, 0, 0, 0, 0, 0x02, 0xf7]);  // TX 7 bytes (fn 0x02, not a bulk read)
  (mock).emitFrame([0xf0, 0xaa, 0xbb, 0xf7]);       // RX 4 bytes
  (mock).emitFrame([0x01, 0x02]);                   // RX 2 bytes

  const d = (await reg.diagnostics()).traffic as typeof base;
  assertEqual(d.txMsgs - base.txMsgs, 3, 'tx msg delta');
  assertEqual(d.txBytes - base.txBytes, 5 + 3 + 7, 'tx byte delta');
  assertEqual(d.rxMsgs - base.rxMsgs, 2, 'rx msg delta');
  assertEqual(d.rxBytes - base.rxBytes, 4 + 2, 'rx byte delta');
}

/** c. Echo-guard: instrumentation is IDEMPOTENT (a second wrap must not double-count TX). */
async function echoGuardIdempotent(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const reg = makeReg(serial(mock), mock);
  await reg.detect();
  const t = await reg.transport();
  reg.__instrumentTransportForTest(t); // re-wrap — must be a no-op
  const before = (await reg.diagnostics()).traffic as { txMsgs: number };
  t.send([0xf0, 0x01, 0xf7]);
  const after = (await reg.diagnostics()).traffic as { txMsgs: number };
  assertEqual(after.txMsgs - before.txMsgs, 1, 'a single send counts once (wrap is idempotent)');
}

/** d. Echo-guard suppression: while an fn-0x1F bulk read is IN FLIGHT, an inbound 0x74 burst is our
 *     own reply → dropped (decodeEditBurst NOT called); with no bulk read in flight it IS a
 *     front-panel edit → decodeEditBurst runs. */
async function echoGuardSuppression(): Promise<void> {
  let bursts = 0;
  const fake = fakeGen3({ editPush: true, onBurst: () => { bursts++; } });
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  let releaseBulk: (v: number[][]) => void = () => {};
  const bulkReply = new Promise<number[][]>((r) => { releaseBulk = r; });
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(0x11)];
    if (req[5] === 0x1f) return bulkReply; // hold the bulk read in flight
    return [];
  };
  const reg = makeReg(serial(mock), mock);
  reg.__seedDriver(0x11, fake);
  await reg.detect(); // activates the fake (deviceEditPush) over the open transport
  const unsub = reg.subscribe(() => {}); // attaches the edit-push RX listener
  const t = await reg.transport();

  const held = t.request([0xf0, 0x00, 0x01, 0x74, 0x11, 0x1f, 0x00, 0xf7]); // fn 0x1F bulk read → #pendingBulkReads=1
  (mock).emitFrame([0xf0, 0x00, 0x01, 0x74, 0x11, 0x74, 0x01, 0xf7]); // 0x74 head arrives → our own reply → suppressed
  (mock).emitFrame([0xf0, 0x00, 0x01, 0x74, 0x11, 0x76, 0xf7]);       // 0x76 end
  assertEqual(bursts, 0, 'burst suppressed while our bulk read is in flight');

  releaseBulk([]);
  await held; // #pendingBulkReads back to 0

  (mock).emitFrame([0xf0, 0x00, 0x01, 0x74, 0x11, 0x74, 0x01, 0xf7]); // now a genuine front-panel burst
  (mock).emitFrame([0xf0, 0x00, 0x01, 0x74, 0x11, 0x76, 0xf7]);
  assertEqual(bursts, 1, 'genuine burst decoded once no bulk read is in flight');
  unsub();
}

/** e. Interactive detector: a route-driven request in flight registers as interactive; a supervisor
 *     poll would not (it wraps in #supervised). */
async function interactiveDetector(): Promise<void> {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  let release: (v: number[][]) => void = () => {};
  const pending = new Promise<number[][]>((r) => { release = r; });
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(0x11)];
    if (req[0] === 0x11 && req.length === 3) return pending; // the held "interactive" request
    return [];
  };
  const reg = makeReg(serial(mock), mock);
  await reg.detect();
  const t = await reg.transport();
  assertEqual(reg.__interactiveInFlightForTest(), 0, 'no interactive requests initially');
  const held = t.request([0x11, 0x22, 0x33]);
  assertEqual(reg.__interactiveInFlightForTest(), 1, 'held route request counts as interactive');
  release([]);
  await held;
  assertEqual(reg.__interactiveInFlightForTest(), 0, 'interactive count clears when the request settles');
}

/** f. Yield + starvation: under a held interactive request the meter loop skips most ticks (yielding)
 *     but the starvation guard still forces polls through → strictly fewer meter frames than a free run,
 *     yet not zero. */
async function yieldStarvation(): Promise<void> {
  const WINDOW = 320; // performance tick = 60 ms → ~5 ticks

  // free run: no interactive load
  {
    const mock = new MockTransport('serial', '/dev/ttyACM0');
    mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
    const reg = makeReg(serial(mock), mock);
    reg.__seedDriver(0x11, fakeGen3({ outputMeters: true }));
    await reg.detect();
    reg.setTelemetryMode('performance');
    await reg.transport();
    const base = mock.sent.length;
    const unsub = reg.subscribe(() => {});
    await sleep(WINDOW);
    unsub();
    var freeDelta = mock.sent.length - base;
  }

  // busy run: a route-driven request held in flight the whole window
  let busyDelta = 0;
  {
    const mock = new MockTransport('serial', '/dev/ttyACM0');
    let release: (v: number[][]) => void = () => {};
    const pending = new Promise<number[][]>((r) => { release = r; });
    mock.reply = (req) => {
      if (isIdentifyBroadcast(req)) return [handshakeReply(0x11)];
      if (req[0] === 0x11 && req.length === 3) return pending; // held interactive
      return [];
    };
    const reg = makeReg(serial(mock), mock);
    reg.__seedDriver(0x11, fakeGen3({ outputMeters: true }));
    await reg.detect();
    reg.setTelemetryMode('performance');
    const t = await reg.transport();
    const held = t.request([0x11, 0x22, 0x33]); // interactive, in flight for the whole window
    const base = mock.sent.length;
    const unsub = reg.subscribe(() => {});
    await sleep(WINDOW);
    unsub();
    release([]);
    await held;
    busyDelta = mock.sent.length - base;
  }

  assert(freeDelta > busyDelta, `yield reduces meter polling (free ${freeDelta} > busy ${busyDelta})`);
  assert(busyDelta >= 1, `starvation guard still forces a poll through (busy ${busyDelta})`);
}

export async function runTelemetryTests(): Promise<void> {
  setConnOverride(null);
  setProfileOverride(null);
  cadenceUnit();
  await trafficCounters();
  await echoGuardIdempotent();
  await echoGuardSuppression();
  await interactiveDetector();
  await yieldStarvation();
}
