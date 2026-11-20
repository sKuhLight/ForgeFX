// Gen-3 preset store waits for the device's OWN acknowledgement (Axe-Fx III / FM3 / FM9). Mocked,
// NO hardware. A device acks a store ~0.8-1.4 s after the request (measured on our own FM3: 808-897 ms
// on fw 12.0, 1256-1353 ms on fw 13.0), so the old ~120 ms window reported success by ABSENCE of a
// refusal. What a MISSING ack means depends on the per-model evidence table (`storeAck`):
//   'verified' (ack seen on our own hardware — the FM3 today): no ack → ok:false + a clear error, never
//              silent success
//   'unknown'  (FM9 and Axe-Fx III today; injected for the FM3 where the lenient path is under test):
//              no ack → ok:true, acked:false + a warning
//   both: ack → ok:true acked:true (even late / after unrelated frames / next to a stray 0x64);
//         a real 0x64 refusal without ack → ok:false + the device's result code;
//         a frame byte-identical to the request (loopback) is NOT an ack.
//
// The mock transport applies the REAL transport semantics (a quiet gap after the last frame, a hard cap,
// an early return on `match`) in VIRTUAL time, so a 1.4 s ack is tested without waiting 1.4 s — and so a
// driver that passes a too-short quiet gap or cap fails here instead of on a unit.
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { createGen3Driver, type StoreAckEvidence } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { PROFILES } from '../../src/devices.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { isTransportTimeout, type RequestOpts, type Transport } from '../../src/transport/types.js';
import type { DeviceDriver } from '../../src/drivers/types.js';
import { restoreVersion } from '../../src/services/backups.js';
import { buildTestApp } from '../helpers/api.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const GEN3_STORE_CASE_COUNT = 70;

const GEN3_MODELS = [0x10, 0x11, 0x12] as const;
const SLOT = 408; // a slot above 127: the septet-split preset number is the interesting case

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** The device's store echo: the request's envelope (fn 0x01, sub 0x26) followed by a synthetic tail. */
const ackFrame = (model: number) => sysex(model, 0x01, [0x26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
/** A 0x64 MULTIPURPOSE_RESPONSE echoing fn `echoed` with result code `code`. */
const rejectFrame = (model: number, echoed: number, code: number) => sysex(model, 0x64, [echoed, code]);
/** Some unrelated unsolicited frame (a status broadcast). */
const noiseFrame = (model: number) => sysex(model, 0x13, [0x3a, 0x00, 0x02]);

interface Timed { at: number; frame: number[] }

/** MockTransport whose request() replays a scripted, timestamped reply stream under the real
 *  transports' completion rules (hard cap, quiet gap measured from the last frame, early match). */
class TimedTransport extends MockTransport {
  lastOpts: RequestOpts | undefined;
  script: (bytes: readonly number[]) => Timed[] = () => [];
  failWith: Error | null = null;
  override async request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    this.sent.push([...bytes]);
    this.lastOpts = opts;
    if (this.failWith) throw this.failWith;
    const { timeoutMs = 1500, quietMs = 90, match } = opts;
    const frames: number[][] = [];
    let quietAt = Number.POSITIVE_INFINITY;
    for (const ev of [...this.script(bytes)].sort((a, b) => a.at - b.at)) {
      if (ev.at > timeoutMs || ev.at >= quietAt) break; // the cap or a quiet gap ended the exchange first
      frames.push(ev.frame);
      if (match?.(frames)) return frames;
      quietAt = ev.at + quietMs;
    }
    return frames;
  }
}

function driverOver(model: number, mock: MockTransport, storeAck?: StoreAckEvidence) {
  mock.isOpen = true;
  return createGen3Driver(
    PROFILES[model]!,
    { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') },
    storeAck ? { storeAck } : undefined
  );
}

const typedTimeout = () => Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });

/** What the shipped evidence table says per model: the FM3's ack is verified on our own unit (fw 12.0 and
 *  13.0); the FM9 and the Axe-Fx III have not been seen on our own hardware yet. */
const SHIPPED_EVIDENCE: Readonly<Record<number, StoreAckEvidence>> = { 0x10: 'unknown', 0x11: 'verified', 0x12: 'unknown' };

/** The DEFAULT driver (no injected evidence) per model: the table is what the user gets. */
async function defaultEvidence(): Promise<void> {
  for (const model of GEN3_MODELS) {
    const tag = `0x${model.toString(16)}`;
    const mock = new TimedTransport('serial', `mock-store-default-${tag}`);
    const driver = driverOver(model, mock);
    assertEqual(driver.storeAck, SHIPPED_EVIDENCE[model], `${tag}: default store-ack evidence (FM3 'verified', FM9 / Axe-Fx III 'unknown')`);

    // an ack inside the cap is a plain success on every model
    mock.script = () => [{ at: 1402, frame: ackFrame(model) }];
    const acked = await driver.store(SLOT);
    assertEqual(acked.ok && acked.acked, true, `${tag}/default: ack at 1.4 s → ok + acked`);
    assertEqual(acked.warning, undefined, `${tag}/default: no warning when acked`);
    assertEqual(acked.error, undefined, `${tag}/default: no error when acked`);

    // silence: the evidence decides — a verified model fails, an unknown one only warns
    mock.script = () => [];
    const quiet = await driver.store(SLOT);
    if (SHIPPED_EVIDENCE[model] === 'verified') {
      assertEqual(quiet.ok, false, `${tag}/default (verified): silence → ok:false`);
      assertEqual(quiet.acked, false, `${tag}/default (verified): silence → acked:false`);
      assert(/did not acknowledge/.test(quiet.error ?? '') && (quiet.error ?? '').includes(String(SLOT)), `${tag}/default (verified): silence → clear error naming the slot (${quiet.error})`);
      assertEqual(quiet.warning, undefined, `${tag}/default (verified): silence is an error, not a warning`);
    } else {
      assertEqual(quiet.ok, true, `${tag}/default (unknown): silence → ok:true`);
      assertEqual(quiet.acked, false, `${tag}/default (unknown): silence → acked:false`);
      assert(/unconfirmed/.test(quiet.warning ?? '') && (quiet.warning ?? '').includes(String(SLOT)), `${tag}/default (unknown): silence → a warning naming the slot (${quiet.warning})`);
      assertEqual(quiet.error, undefined, `${tag}/default (unknown): silence is not an error`);
    }
  }
}

/** The FM3 acks measured on our own unit (fw 12.0: 808-897 ms; fw 13.0: 1256-1353 ms) through the DEFAULT
 *  FM3 driver: every one is a success, and the wait leaves ~3x room over the slowest. */
async function fm3MeasuredAcks(): Promise<void> {
  const model = 0x11;
  const mock = new TimedTransport('serial', 'mock-store-fm3-measured');
  const driver = driverOver(model, mock);
  assertEqual(driver.storeAck, 'verified', 'fm3: default evidence is verified');
  for (const [fw, at] of [['12.0', 808], ['12.0', 897], ['13.0', 1256], ['13.0', 1353]] as const) {
    mock.script = () => [{ at, frame: ackFrame(model) }];
    const r = await driver.store(SLOT);
    assertEqual(r.ok && r.acked, true, `fm3 fw ${fw}: ack at ${at} ms → ok + acked`);
    assertEqual(r.error, undefined, `fm3 fw ${fw}: ack at ${at} ms → no error`);
    assertEqual(r.warning, undefined, `fm3 fw ${fw}: ack at ${at} ms → no warning`);
  }
  const o = mock.lastOpts!;
  assert((o.timeoutMs ?? 0) >= 2.9 * 1353, `fm3: cap (${o.timeoutMs} ms) leaves ~3x room over the slowest measured ack (1353 ms)`);
  assert((o.quietMs ?? 0) >= (o.timeoutMs ?? Infinity), 'fm3: a quiet gap can never end the wait before the cap');
  assert(mock.sent.some((f) => f[5] === 0x01 && f[6] === 0x26), 'fm3: the store request (fn 0x01 sub 0x26) went out');

  // default FM3: a real refusal and our own request coming back are failures, never an ack
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await driver.store(SLOT);
  assertEqual(rej.ok, false, 'fm3 default: a real 0x64 refusal → ok:false');
  assert(/rejected by the device/.test(rej.error ?? '') && /0x05/.test(rej.error ?? ''), `fm3 default: refusal error carries the result code (${rej.error})`);
  mock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoed = await driver.store(SLOT);
  assertEqual(echoed.ok, false, 'fm3 default: a literal echo of the request is not an ack → ok:false');
  assertEqual(echoed.acked, false, 'fm3 default: a literal echo of the request → acked:false');
}

async function perModel(model: number): Promise<void> {
  const tag = `0x${model.toString(16)}`;

  // the lenient path is exercised on EVERY model by injecting 'unknown' (the shipped table only leaves
  // the FM9 / Axe-Fx III there; the default per model is covered by defaultEvidence())
  const mockU = new TimedTransport('serial', `mock-store-unknown-${tag}`);
  const unknown = driverOver(model, mockU, 'unknown');
  assertEqual(unknown.storeAck, 'unknown', `${tag}: an injected 'unknown' evidence is honoured`);

  // 'unknown' + ack at 1402 ms → ok + acked
  mockU.script = () => [{ at: 1402, frame: ackFrame(model) }];
  const ok = await unknown.store(SLOT);
  assertEqual(ok.ok && ok.acked, true, `${tag}/unknown: ack at 1.4 s → ok + acked`);
  assertEqual(ok.location, SLOT, `${tag}: location echoed`);
  assertEqual(ok.warning, undefined, `${tag}/unknown: no warning when acked`);
  assert(mockU.sent.some((f) => f[5] === 0x01 && f[6] === 0x26), `${tag}: the store request (fn 0x01 sub 0x26) went out`);
  const uo = mockU.lastOpts!;
  assert((uo.timeoutMs ?? 0) >= 2500, `${tag}/unknown: cap (${uo.timeoutMs} ms) leaves room for a ~1.4 s ack`);
  assert((uo.quietMs ?? 0) >= (uo.timeoutMs ?? Infinity), `${tag}/unknown: a quiet gap can never end the wait before the cap`);

  // 'unknown' + silence → ok:true, acked:false, a WARNING (the store was sent, but is unconfirmed)
  mockU.script = () => [];
  const quiet = await unknown.store(SLOT);
  assertEqual(quiet.ok, true, `${tag}/unknown: silence → ok:true (a model without a proven ack must not fail every save)`);
  assertEqual(quiet.acked, false, `${tag}/unknown: silence → acked:false`);
  assert(/unconfirmed/.test(quiet.warning ?? '') && (quiet.warning ?? '').includes(String(SLOT)), `${tag}/unknown: silence → a warning naming the slot (${quiet.warning})`);
  assertEqual(quiet.error, undefined, `${tag}/unknown: silence is not an error`);

  // 'unknown' + a real 0x64 refusal → STILL ok:false
  mockU.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await unknown.store(SLOT);
  assertEqual(rej.ok, false, `${tag}/unknown: a real 0x64 refusal stays ok:false`);

  // 'verified' — strict
  const mockV = new TimedTransport('serial', `mock-store-verified-${tag}`);
  const verified = driverOver(model, mockV, 'verified');
  mockV.script = () => [{ at: 1402, frame: ackFrame(model) }];
  const vok = await verified.store(SLOT);
  assertEqual(vok.ok && vok.acked, true, `${tag}/verified: ack at 1.4 s → ok + acked`);
  assertEqual(vok.error, undefined, `${tag}/verified: no error on success`);
  const vo = mockV.lastOpts!;
  assert((vo.timeoutMs ?? 0) >= 4000, `${tag}/verified: cap (${vo.timeoutMs} ms) leaves ~2.9x room for a 1.4 s ack`);
  assert((vo.quietMs ?? 0) >= (vo.timeoutMs ?? Infinity), `${tag}/verified: a quiet gap can never end the wait before the cap`);

  // an unrelated frame at 100 ms, then silence, then the ack at 1402 ms — still ok (a short quiet gap would lose it)
  mockV.script = () => [{ at: 100, frame: noiseFrame(model) }, { at: 1402, frame: ackFrame(model) }];
  const late = await verified.store(SLOT);
  assertEqual(late.ok && late.acked, true, `${tag}/verified: ack after an unrelated early frame → ok + acked`);

  // no ack at all → ok:false with a clear error (never silent success)
  mockV.script = () => [];
  const none = await verified.store(SLOT);
  assertEqual(none.ok, false, `${tag}/verified: no ack → ok:false`);
  assertEqual(none.acked, false, `${tag}/verified: no ack → acked:false`);
  assert(/did not acknowledge/.test(none.error ?? '') && (none.error ?? '').includes(String(SLOT)), `${tag}/verified: no-ack error names the problem + slot (${none.error})`);
}

async function contractEdges(): Promise<void> {
  const model = 0x11;
  const mock = new TimedTransport('serial', 'mock-store-edges');
  const driver = driverOver(model, mock, 'verified');

  // ack AFTER the cap → timeout, not success
  mock.script = () => [{ at: 9000, frame: ackFrame(model) }];
  assertEqual((await driver.store(SLOT)).ok, false, 'ack past the cap → ok:false');

  // real refusal (0x64 echoing fn 0x01), no ack → ok:false carrying the result code
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await driver.store(SLOT);
  assertEqual(rej.ok, false, '0x64 refusal → ok:false');
  assertEqual(rej.acked, false, '0x64 refusal → acked:false');
  assert(/rejected by the device/.test(rej.error ?? '') && /0x05/.test(rej.error ?? ''), `0x64 refusal error carries the result code (${rej.error})`);

  // a stray 0x64 (a refused read from another exchange) followed by the genuine ack → the ack wins
  mock.script = () => [{ at: 50, frame: rejectFrame(model, 0x01, 0x07) }, { at: 1400, frame: ackFrame(model) }];
  const stray = await driver.store(SLOT);
  assertEqual(stray.ok && stray.acked, true, 'stray 0x64 + ack → ok (the ack is the device\'s own answer)');

  // a 0x64 refusing some OTHER function is not a refusal of the store → unconfirmed, not "rejected"
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x13, 0x05) }];
  const other = await driver.store(SLOT);
  assertEqual(other.ok, false, '0x64 for another fn, no ack → ok:false');
  assert(!/rejected by the device/.test(other.error ?? ''), `0x64 for another fn is not reported as a store refusal (${other.error})`);

  // an ack-shaped frame with a DIFFERENT model byte is not our ack
  mock.script = () => [{ at: 30, frame: ackFrame(0x12) }];
  assertEqual((await driver.store(SLOT)).ok, false, 'ack from another model byte → not an ack');

  // our OWN request coming back byte-for-byte (MIDI thru / loopback) is NOT an ack — strict AND lenient
  mock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoed = await driver.store(SLOT);
  assertEqual(echoed.ok, false, 'verified: a literal echo of the request is not an ack → ok:false');
  assertEqual(echoed.acked, false, 'verified: a literal echo of the request → acked:false');
  const lenientMock = new TimedTransport('serial', 'mock-store-echo-unknown');
  const lenient = driverOver(model, lenientMock, 'unknown');
  lenientMock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoedU = await lenient.store(SLOT);
  assertEqual(echoedU.acked, false, 'unknown: a literal echo of the request → acked:false (never a fake ack)');
  assert(/unconfirmed/.test(echoedU.warning ?? ''), 'unknown: a literal echo of the request → unconfirmed warning');

  // a TYPED timeout (browser-direct transports reject a no-frame timeout; Node ones resolve []) = silence
  mock.script = () => [];
  mock.failWith = typedTimeout();
  const bd = await driver.store(SLOT);
  assertEqual(bd.ok, false, 'verified: typed request() timeout → ok:false');
  assert(/did not acknowledge/.test(bd.error ?? ''), `verified: typed request() timeout → clear error (${bd.error})`);
  lenientMock.script = () => [];
  lenientMock.failWith = typedTimeout();
  const bdU = await lenient.store(SLOT);
  assertEqual(bdU.ok, true, 'unknown: typed request() timeout → ok:true');
  assert(/unconfirmed/.test(bdU.warning ?? ''), 'unknown: typed request() timeout → unconfirmed warning');
  lenientMock.failWith = null;
  // the driver does NOT parse message text: an untyped error that merely SAYS "timed out" propagates
  mock.failWith = new Error('MIDI request timed out after 4000ms');
  let untypedThrew = false;
  try { await driver.store(SLOT); } catch { untypedThrew = true; }
  assert(untypedThrew, 'an untyped "timed out" error is not interpreted by the driver (the transport layer tags it)');
  // any other transport failure propagates too (it is not a store outcome)
  mock.failWith = new Error('serial port closed');
  let threw = false;
  try { await driver.store(SLOT); } catch (e) { threw = /port closed/.test((e as Error).message); }
  assert(threw, 'a non-timeout transport error propagates');
  mock.failWith = null;

  // slow (5-pin DIN) link → a longer cap
  const slowMock = new TimedTransport('serial', 'mock-store-slow');
  Object.defineProperty(slowMock, 'slow', { value: true });
  const slowDriver = driverOver(model, slowMock, 'verified');
  slowMock.script = () => [{ at: 6500, frame: ackFrame(model) }];
  const slowOk = await slowDriver.store(SLOT);
  assertEqual(slowOk.ok && slowOk.acked, true, 'slow link: an ack at 6.5 s is still within the cap');
  mock.script = () => [{ at: 1402, frame: ackFrame(model) }];
  await driver.store(SLOT);
  assert((slowMock.lastOpts?.timeoutMs ?? 0) > (mock.lastOpts?.timeoutMs ?? 0), 'slow link gets a longer cap than a fast one');
}

/** The transport layer tags the browser-direct transports' text-only timeout rejections with the typed
 *  `code` (the registry's instrumentation is the one choke point); drivers only ever test the code. */
async function timeoutNormalisation(): Promise<void> {
  const reg = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: 'x' }), openConn: () => new MockTransport() });
  const cases: [string, string][] = [
    ['MIDI request timed out after 4000ms', 'webmidi / nativeMidi'],
    ['Serial request timed out after 4000ms', 'webserial']
  ];
  for (const [message, which] of cases) {
    const t = new MockTransport('serial', `mock-timeout-${which}`);
    t.reply = () => { throw new Error(message); };
    reg.__instrumentTransportForTest(t);
    let caught: unknown;
    try { await t.request([0xf0, 0xf7]); } catch (e) { caught = e; }
    assert(caught instanceof Error && isTransportTimeout(caught), `${which}: the text-only timeout rejection is tagged ETIMEDOUT`);
    assertEqual((caught as Error).message, message, `${which}: the message is untouched`);
  }
  // already typed → untouched; unrelated errors (even ones mentioning a timeout) → NOT tagged
  const t2 = new MockTransport('serial', 'mock-timeout-other');
  let n = 0;
  const errs = [typedTimeout(), new Error('serial port closed'), new Error('Other request timed out after 5ms'), new Error('MIDI send failed')];
  t2.reply = () => { throw errs[n++]!; };
  reg.__instrumentTransportForTest(t2);
  const out: unknown[] = [];
  for (let i = 0; i < errs.length; i++) { try { await t2.request([0xf0, 0xf7]); } catch (e) { out.push(e); } }
  assertEqual(isTransportTimeout(out[0]), true, 'an already typed timeout stays typed');
  assertEqual(out[0], errs[0], 'an already typed timeout is the same error object');
  assertEqual(isTransportTimeout(out[1]), false, 'a plain transport error is not tagged');
  assertEqual(isTransportTimeout(out[2]), false, 'a look-alike message from another source is not tagged');
  assertEqual(isTransportTimeout(out[3]), false, 'a send failure is not tagged');
}

/** POST /preset/store through BOTH surfaces (Fastify + the browser-facing runtime router) over the
 *  REAL gen-3 driver: the shared handler must pass the driver's verdict through unchanged — including
 *  a browser-direct style rejected timeout, which only the registry's tagging turns into a store verdict. */
async function bothSurfaces(): Promise<void> {
  const model = 0x11;
  const codec = createModernFractalCodec(model);
  const storeReq = JSON.stringify(codec.buildStorePreset(5));
  const post = async (t: Awaited<ReturnType<typeof buildTestApp>>, router: ReturnType<typeof createRouter>) => {
    const a = await t.app.inject({ method: 'POST', url: '/preset/store', payload: { number: 5 } });
    const r = await router.handle('POST', '/preset/store', JSON.stringify({ number: 5 }));
    assertEqual(a.statusCode, 200, 'store: verdicts ride an HTTP 200');
    assertEqual(String(r.body), a.payload, 'router twin: store body identical to the app');
    return JSON.parse(a.payload) as { ok: boolean; acked: boolean; location: number; error?: string; warning?: string };
  };

  /** The real gen-3 driver with INJECTED evidence behind the app (the registry's cache is seeded before detect). */
  const appWithEvidence = async (storeAck: StoreAckEvidence) => {
    let mockRef: MockTransport | null = null;
    const driver = createGen3Driver(
      PROFILES[model]!,
      { transport: async () => mockRef as Transport, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') },
      { storeAck }
    ) as unknown as DeviceDriver;
    const t = await buildTestApp(model, driver);
    mockRef = t.mock;
    return t;
  };

  // injected 'unknown' (what the FM9 / Axe-Fx III ship with): ack → ok+acked; silence → ok+warning;
  // text-only timeouts → ok+warning
  {
    const t = await appWithEvidence('unknown');
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [ackFrame(model)] : []);
      const acked = await post(t, router);
      assertEqual(acked.ok && acked.acked, true, 'app+router: acknowledged store → ok:true acked:true');

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, true, "app+router: 'unknown' model, silence → ok:true");
      assert(quiet.acked === false && /unconfirmed/.test(quiet.warning ?? ''), "app+router: 'unknown' model, silence → acked:false + warning");

      for (const message of ['MIDI request timed out after 2500ms', 'Serial request timed out after 2500ms']) {
        t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error(message); };
        const bd = await post(t, router);
        assert(bd.ok === true && bd.acked === false && /unconfirmed/.test(bd.warning ?? ''), `app+router: browser-direct "${message}" → the same unconfirmed verdict, not a 500`);
      }

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [rejectFrame(model, 0x01, 0x05)] : []);
      const refused = await post(t, router);
      assertEqual(refused.ok, false, "app+router: 'unknown' model, real 0x64 → ok:false");
    } finally { await t.app.close(); }
  }

  // injected 'verified': silence / browser-direct timeout → ok:false + error
  {
    const t = await appWithEvidence('verified');
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, false, "app+router: 'verified' model, silence → ok:false");
      assert(/did not acknowledge/.test(quiet.error ?? ''), `app+router: 'verified' model, silence → clear error (${quiet.error})`);
      t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error('Serial request timed out after 4000ms'); };
      const bd = await post(t, router);
      assert(bd.ok === false && /did not acknowledge/.test(bd.error ?? ''), "app+router: 'verified' model, browser-direct timeout → ok:false + error");
    } finally { await t.app.close(); }
  }

  // the DEFAULT FM3 driver (no injection — the shipped table says 'verified'): ack → ok+acked; silence and
  // browser-direct timeouts → ok:false + error; a real 0x64 → ok:false
  {
    const t = await buildTestApp(model);
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [ackFrame(model)] : []);
      const acked = await post(t, router);
      assertEqual(acked.ok && acked.acked, true, 'app+router: default FM3, acknowledged store → ok:true acked:true');
      assertEqual(acked.error, undefined, 'app+router: default FM3, acknowledged store → no error');
      assertEqual(acked.warning, undefined, 'app+router: default FM3, acknowledged store → no warning');

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, false, 'app+router: default FM3, silence → ok:false');
      assertEqual(quiet.acked, false, 'app+router: default FM3, silence → acked:false');
      assert(/did not acknowledge/.test(quiet.error ?? ''), `app+router: default FM3, silence → clear error (${quiet.error})`);

      for (const message of ['MIDI request timed out after 4000ms', 'Serial request timed out after 4000ms']) {
        t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error(message); };
        const bd = await post(t, router);
        assert(bd.ok === false && bd.acked === false && /did not acknowledge/.test(bd.error ?? ''), `app+router: default FM3, browser-direct "${message}" → ok:false + error, not a 500`);
      }

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [rejectFrame(model, 0x01, 0x05)] : []);
      const refused = await post(t, router);
      assertEqual(refused.ok, false, 'app+router: default FM3, real 0x64 → ok:false');
      assert(/rejected by the device/.test(refused.error ?? ''), `app+router: default FM3, real 0x64 → refusal error (${refused.error})`);
    } finally { await t.app.close(); }
  }
}

/** POST /version/:id/restore = load + store: its answer must carry the store's verdict, not a blanket ok. */
async function restoreCarriesVerdict(): Promise<void> {
  const fakeStore = { getPresetVersion: () => ({ location: 5 }), getPresetVersionBytes: () => new Uint8Array([0xf0, 0xf7]) } as never;
  const driverWith = (storeResult: { ok: boolean; error?: string; warning?: string }) =>
    ({ loadPresetBytes: async () => ({ ok: true }), store: async () => storeResult }) as unknown as DeviceDriver;
  const good = await restoreVersion(fakeStore, driverWith({ ok: true }), 'v1');
  assertEqual(good.ok, true, 'restore: acknowledged store → ok:true');
  assertEqual(good.error, undefined, 'restore: no error on success');
  const bad = await restoreVersion(fakeStore, driverWith({ ok: false, error: 'no acknowledgement' }), 'v1');
  assertEqual(bad.ok, false, 'restore: unacknowledged store → ok:false (never a silent success)');
  assertEqual(bad.error, 'no acknowledgement', 'restore: carries the store error');
  assertEqual(bad.location, 5, 'restore: location echoed');
  const warn = await restoreVersion(fakeStore, driverWith({ ok: true, warning: 'unconfirmed' }), 'v1');
  assertEqual(warn.ok, true, 'restore: sent-but-unconfirmed → ok:true');
  assertEqual(warn.warning, 'unconfirmed', 'restore: carries the store warning');
}

export async function runGen3StoreTests(): Promise<void> {
  await defaultEvidence();
  await fm3MeasuredAcks();
  for (const m of GEN3_MODELS) await perModel(m);
  await contractEdges();
  await timeoutNormalisation();
  await bothSurfaces();
  await restoreCarriesVerdict();
}
