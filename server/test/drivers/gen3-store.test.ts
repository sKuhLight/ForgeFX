// Gen-3 preset store waits for the device's OWN acknowledgement (Axe-Fx III / FM3 / FM9). Mocked,
// NO hardware. A device acks a store ~0.8-1.4 s after the request (measured on our own FM3: 808-897 ms
// on fw 12.0, 1256-1353 ms on fw 13.0), so the old ~120 ms window reported success by ABSENCE of a
// refusal. What a MISSING ack means depends on the per-model evidence table, narrowed to the link and
// firmware it was measured on (`storeAckFor`):
//   'verified' (ack seen on our own hardware — the FM3 on a fast USB link with fw >= 12.0): no ack →
//              ok:false + reason 'no-ack' + a clear error, never silent success
//   'unknown'  (FM9 and Axe-Fx III; the FM3 on a slow link, on fw < 12.0 or on unread firmware; or
//              injected): no ack → ok:true, acked:false + reason 'no-ack' + a warning
//   both: ack → ok:true acked:true (even late / after unrelated frames / next to a stray 0x64);
//         a real 0x64 refusal without ack → ok:false + reason 'rejected' + the device's result code;
//         a frame byte-identical to the request (loopback) is NOT an ack.
// An injected `storeAck` overrides the table (scope included).
//
// The mock transport applies the REAL transport semantics (a quiet gap after the last frame, a hard cap,
// an early return on `match`) in VIRTUAL time, so a 1.4 s ack is tested without waiting 1.4 s — and so a
// driver that passes a too-short quiet gap or cap fails here instead of on a unit.
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { createGen3Driver, resolveStoreAck, type StoreAckEvidence, type StoreAckScope } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { PROFILES } from '../../src/devices.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { isTransportTimeout, type RequestOpts, type Transport } from '../../src/transport/types.js';
import type { DeviceDriver, StoreReason } from '../../src/drivers/types.js';
import { restoreVersion } from '../../src/services/backups.js';
import { buildTestApp } from '../helpers/api.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

// One case = one executed assert()/assertEqual() in this suite (counted by running it; keep in step when adding).
export const GEN3_STORE_CASE_COUNT = 430;

const GEN3_MODELS = [0x10, 0x11, 0x12] as const;
const SLOT = 408; // a slot above 127: the septet-split preset number is the interesting case

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** The device's store acknowledgement: the request's envelope (fn 0x01, sub 0x26) followed by a synthetic tail. */
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

/** The firmware the registry would have read at detect time (null = not read / not known). */
type Fw = { major: number; minor: number } | null;
const FW_12_0: Fw = { major: 12, minor: 0 };
const FW_13_0: Fw = { major: 13, minor: 0 };

/** A mock link that reports itself slow (a generic 5-pin DIN interface) — the scope's fast-link rule. */
function slowLink(mock: MockTransport): MockTransport {
  Object.defineProperty(mock, 'slow', { value: true });
  return mock;
}

function driverOver(model: number, mock: MockTransport, storeAck?: StoreAckEvidence, firmware: Fw = null) {
  mock.isOpen = true;
  return createGen3Driver(
    PROFILES[model]!,
    { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced'), getFirmware: () => firmware },
    storeAck ? { storeAck } : undefined
  );
}

const typedTimeout = () => Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });

/** What the shipped evidence table gives per model on a fast link and fw 13.0 — the conditions the FM3's
 *  ack was measured under on our own unit (fw 12.0 and 13.0, USB). The FM9 and the Axe-Fx III have not
 *  been seen on our own hardware yet. */
const SHIPPED_EVIDENCE: Readonly<Record<number, StoreAckEvidence>> = { 0x10: 'unknown', 0x11: 'verified', 0x12: 'unknown' };

/** The caps `store()` applies per evidence level and link. */
const CAPS = { verified: { fast: 6000, slow: 8000 }, unknown: { fast: 2500, slow: 6000 } } as const;

/** The DEFAULT driver (no injected evidence) per model, on a fast link with known firmware: the table is
 *  what the user gets. */
async function defaultEvidence(): Promise<void> {
  for (const model of GEN3_MODELS) {
    const tag = `0x${model.toString(16)}`;
    const mock = new TimedTransport('serial', `mock-store-default-${tag}`);
    const driver = driverOver(model, mock, undefined, FW_13_0);
    assertEqual(driver.storeAckFor(false), SHIPPED_EVIDENCE[model], `${tag}: default store-ack evidence (FM3 'verified', FM9 / Axe-Fx III 'unknown')`);

    // an ack inside the cap is a plain success on every model — and carries no reason
    mock.script = () => [{ at: 1402, frame: ackFrame(model) }];
    const acked = await driver.store(SLOT);
    assertEqual(acked.ok && acked.acked, true, `${tag}/default: ack at 1.4 s → ok + acked`);
    assertEqual(acked.warning, undefined, `${tag}/default: no warning when acked`);
    assertEqual(acked.error, undefined, `${tag}/default: no error when acked`);
    assertEqual(acked.reason, undefined, `${tag}/default: no reason when acked`);

    // silence: the evidence decides — a verified model fails, an unknown one only warns; both say 'no-ack'
    mock.script = () => [];
    const quiet = await driver.store(SLOT);
    assertEqual(quiet.reason, 'no-ack', `${tag}/default: silence → reason 'no-ack'`);
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

/** The FM3's 'verified' holds only where it was measured: a fast (USB) link and firmware >= 12.0. Anywhere
 *  else the FM3 is as lenient as an unmeasured model. The scope is data in the table; the effective level is
 *  resolved at store() time from the link and the firmware the registry read. */
async function evidenceScope(): Promise<void> {
  // the pure resolver, against the FM3's scope
  const fm3Scope: StoreAckScope = { level: 'verified', minFirmware: [12, 0], fastLinkOnly: true };
  const fast = (firmware: Fw) => ({ slow: false, firmware });
  assertEqual(resolveStoreAck(fm3Scope, fast(FW_12_0)), 'verified', 'scope: fast link + fw 12.0 → verified');
  assertEqual(resolveStoreAck(fm3Scope, fast(FW_13_0)), 'verified', 'scope: fast link + fw 13.0 → verified');
  assertEqual(resolveStoreAck(fm3Scope, fast({ major: 12, minor: 1 })), 'verified', 'scope: fast link + fw 12.1 → verified');
  assertEqual(resolveStoreAck(fm3Scope, fast({ major: 14, minor: 0 })), 'verified', 'scope: fast link + a newer major → verified');
  assertEqual(resolveStoreAck(fm3Scope, fast({ major: 11, minor: 2 })), 'unknown', 'scope: fw 11.2 → unknown');
  assertEqual(resolveStoreAck(fm3Scope, fast({ major: 11, minor: 99 })), 'unknown', 'scope: fw 11.99 is still below 12.0 → unknown');
  assertEqual(resolveStoreAck(fm3Scope, fast(null)), 'unknown', 'scope: firmware not known → unknown');
  assertEqual(resolveStoreAck(fm3Scope, { slow: true, firmware: FW_13_0 }), 'unknown', 'scope: slow link → unknown');
  assertEqual(resolveStoreAck(fm3Scope, { slow: true, firmware: null }), 'unknown', 'scope: slow link + unknown firmware → unknown');
  // a scope with a non-zero minor: the minor is compared only when the major is equal
  const minor3: StoreAckScope = { level: 'verified', minFirmware: [12, 3] };
  assertEqual(resolveStoreAck(minor3, fast({ major: 12, minor: 1 })), 'unknown', 'scope [12,3]: fw 12.1 → unknown');
  assertEqual(resolveStoreAck(minor3, fast({ major: 12, minor: 2 })), 'unknown', 'scope [12,3]: fw 12.2 → unknown');
  assertEqual(resolveStoreAck(minor3, fast({ major: 12, minor: 3 })), 'verified', 'scope [12,3]: fw 12.3 → verified');
  assertEqual(resolveStoreAck(minor3, fast({ major: 12, minor: 9 })), 'verified', 'scope [12,3]: fw 12.9 → verified');
  assertEqual(resolveStoreAck(minor3, fast({ major: 13, minor: 0 })), 'verified', 'scope [12,3]: fw 13.0 (smaller minor, larger major) → verified');
  assertEqual(resolveStoreAck(minor3, fast({ major: 11, minor: 9 })), 'unknown', 'scope [12,3]: fw 11.9 (larger minor, smaller major) → unknown');
  assertEqual(resolveStoreAck(undefined, fast(FW_13_0)), 'unknown', 'scope: no table entry → unknown');
  assertEqual(resolveStoreAck({ level: 'unknown' }, fast(FW_13_0)), 'unknown', "scope: an 'unknown' entry never escalates");
  assertEqual(resolveStoreAck({ level: 'verified' }, { slow: true, firmware: null }), 'verified', 'scope: an entry without conditions applies everywhere');

  // through the driver: effective level + the behaviour + the cap actually used, per model / link / firmware
  const cases: Array<[string, number, boolean, Fw, StoreAckEvidence]> = [
    ['FM3, fast link, fw 12.0', 0x11, false, FW_12_0, 'verified'],
    ['FM3, fast link, fw 13.0', 0x11, false, FW_13_0, 'verified'],
    ['FM3, slow link, fw 13.0', 0x11, true, FW_13_0, 'unknown'],
    ['FM3, slow link, fw 12.0', 0x11, true, FW_12_0, 'unknown'],
    ['FM3, fast link, fw 11.2', 0x11, false, { major: 11, minor: 2 }, 'unknown'],
    ['FM3, fast link, firmware not known', 0x11, false, null, 'unknown'],
    ['FM3, slow link, firmware not known', 0x11, true, null, 'unknown'],
    ['FM9, fast link, fw 13.0', 0x12, false, FW_13_0, 'unknown'],
    ['Axe-Fx III, fast link, fw 13.0', 0x10, false, FW_13_0, 'unknown']
  ];
  for (const [label, model, slow, fw, expected] of cases) {
    const mock = new TimedTransport('serial', `mock-store-scope-${label}`);
    if (slow) slowLink(mock);
    const driver = driverOver(model, mock, undefined, fw);
    assertEqual(driver.storeAckFor(slow), expected, `${label}: effective evidence`);

    // an ack in time is a success under every scope (the wait is the same, only the miss differs)
    mock.script = () => [{ at: 1402, frame: ackFrame(model) }];
    const acked = await driver.store(SLOT);
    assertEqual(acked.ok && acked.acked, true, `${label}: ack at 1.4 s → ok + acked`);
    assertEqual(acked.reason, undefined, `${label}: acked → no reason`);

    // silence: strict inside the scope, lenient outside it — with the matching cap
    mock.script = () => [];
    const quiet = await driver.store(SLOT);
    assertEqual(quiet.reason, 'no-ack', `${label}: silence → reason 'no-ack'`);
    assertEqual(quiet.acked, false, `${label}: silence → acked:false`);
    if (expected === 'verified') {
      assertEqual(quiet.ok, false, `${label}: silence → ok:false (verified)`);
      assert(/did not acknowledge/.test(quiet.error ?? ''), `${label}: silence → error (${quiet.error})`);
    } else {
      assertEqual(quiet.ok, true, `${label}: silence → ok:true (lenient)`);
      assert(/unconfirmed/.test(quiet.warning ?? ''), `${label}: silence → warning (${quiet.warning})`);
    }
    assertEqual(mock.lastOpts?.timeoutMs, CAPS[expected][slow ? 'slow' : 'fast'], `${label}: the ${expected} ${slow ? 'slow' : 'fast'} cap is used`);

    // a real refusal is a refusal at every level
    mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
    const rej = await driver.store(SLOT);
    assertEqual(rej.ok, false, `${label}: real 0x64 → ok:false`);
    assertEqual(rej.reason, 'rejected', `${label}: real 0x64 → reason 'rejected'`);
  }

  // the driver is built BEFORE detection reads the firmware: it is resolved at store() time, per call
  let firmware: Fw = null;
  const lateMock = new TimedTransport('serial', 'mock-store-scope-late-firmware');
  lateMock.isOpen = true;
  const late = createGen3Driver(PROFILES[0x11]!, { transport: async () => lateMock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced'), getFirmware: () => firmware });
  lateMock.script = () => [];
  const before = await late.store(SLOT);
  assertEqual(before.ok, true, 'late firmware: not read yet → lenient (ok:true)');
  firmware = FW_13_0; // detection's fn 0x08 read lands
  const after = await late.store(SLOT);
  assertEqual(after.ok, false, 'late firmware: once read (fw 13.0) the same driver is strict (ok:false)');
  firmware = { major: 11, minor: 2 }; // e.g. a different unit attached on the same driver
  assertEqual((await late.store(SLOT)).ok, true, 'late firmware: a re-read older firmware drops back to lenient');

  // a ctx that cannot report firmware at all (getFirmware is optional) → the FM3 stays lenient
  const noFwMock = new TimedTransport('serial', 'mock-store-scope-no-getfirmware');
  noFwMock.isOpen = true;
  const noFw = createGen3Driver(PROFILES[0x11]!, { transport: async () => noFwMock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  noFwMock.script = () => [];
  assertEqual((await noFw.store(SLOT)).ok, true, 'a ctx without getFirmware → the FM3 is lenient (ok:true)');

  // an INJECTED level overrides the table, scope included
  const strictMock = new TimedTransport('serial', 'mock-store-scope-inject-verified');
  slowLink(strictMock);
  const strict = driverOver(0x11, strictMock, 'verified', null); // slow link + unknown firmware: the table says unknown
  assertEqual(strict.storeAckFor(true), 'verified', "an injected 'verified' wins over the scope (slow link, no firmware)");
  strictMock.script = () => [];
  assertEqual((await strict.store(SLOT)).ok, false, "an injected 'verified' is strict outside the scope");
  const lenientMock = new TimedTransport('serial', 'mock-store-scope-inject-unknown');
  const lenient = driverOver(0x11, lenientMock, 'unknown', FW_13_0); // inside the scope: the table says verified
  assertEqual(lenient.storeAckFor(false), 'unknown', "an injected 'unknown' wins over the scope (fast link, fw 13.0)");
  lenientMock.script = () => [];
  assertEqual((await lenient.store(SLOT)).ok, true, "an injected 'unknown' is lenient inside the scope");
}

/** The FM3 acks measured on our own unit (fw 12.0: 808-897 ms; fw 13.0: 1256-1353 ms, fast link) through the
 *  DEFAULT FM3 driver: every one is a success, and the wait leaves >4x room over the slowest. */
async function fm3MeasuredAcks(): Promise<void> {
  const model = 0x11;
  const mock = new TimedTransport('serial', 'mock-store-fm3-measured');
  const runs: Array<[string, Fw, number[]]> = [['12.0', FW_12_0, [808, 897]], ['13.0', FW_13_0, [1256, 1353]]];
  for (const [fw, firmware, times] of runs) {
    const driver = driverOver(model, mock, undefined, firmware);
    assertEqual(driver.storeAckFor(false), 'verified', `fm3 fw ${fw}: default evidence is verified`);
    for (const at of times) {
      mock.script = () => [{ at, frame: ackFrame(model) }];
      const r = await driver.store(SLOT);
      assertEqual(r.ok && r.acked, true, `fm3 fw ${fw}: ack at ${at} ms → ok + acked`);
      assertEqual(r.error, undefined, `fm3 fw ${fw}: ack at ${at} ms → no error`);
      assertEqual(r.warning, undefined, `fm3 fw ${fw}: ack at ${at} ms → no warning`);
    }
  }
  const o = mock.lastOpts!;
  assert((o.timeoutMs ?? 0) >= 4 * 1353, `fm3: cap (${o.timeoutMs} ms) leaves >4x room over the slowest measured ack (1353 ms)`);
  assert((o.quietMs ?? 0) >= (o.timeoutMs ?? Infinity), 'fm3: a quiet gap can never end the wait before the cap');
  assert(mock.sent.some((f) => f[5] === 0x01 && f[6] === 0x26), 'fm3: the store request (fn 0x01 sub 0x26) went out');

  // default FM3: a real refusal and our own request coming back are failures, never an ack
  const driver = driverOver(model, mock, undefined, FW_13_0);
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await driver.store(SLOT);
  assertEqual(rej.ok, false, 'fm3 default: a real 0x64 refusal → ok:false');
  assertEqual(rej.reason, 'rejected', "fm3 default: a real 0x64 refusal → reason 'rejected'");
  assert(/rejected by the device/.test(rej.error ?? '') && /0x05/.test(rej.error ?? ''), `fm3 default: refusal error carries the result code (${rej.error})`);
  mock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoed = await driver.store(SLOT);
  assertEqual(echoed.ok, false, 'fm3 default: a literal echo of the request is not an ack → ok:false');
  assertEqual(echoed.acked, false, 'fm3 default: a literal echo of the request → acked:false');
  assertEqual(echoed.reason, 'no-ack', "fm3 default: a literal echo of the request → reason 'no-ack'");
}

async function perModel(model: number): Promise<void> {
  const tag = `0x${model.toString(16)}`;

  // the lenient path is exercised on EVERY model by injecting 'unknown' (the shipped table only leaves
  // the FM9 / Axe-Fx III there; the default per model is covered by defaultEvidence())
  const mockU = new TimedTransport('serial', `mock-store-unknown-${tag}`);
  const unknown = driverOver(model, mockU, 'unknown');
  assertEqual(unknown.storeAckFor(false), 'unknown', `${tag}: an injected 'unknown' evidence is honoured`);

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
  assertEqual(quiet.reason, 'no-ack', `${tag}/unknown: silence → reason 'no-ack'`);
  assertEqual(ok.reason, undefined, `${tag}/unknown: an acknowledged store carries no reason`);

  // 'unknown' + a real 0x64 refusal → STILL ok:false
  mockU.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await unknown.store(SLOT);
  assertEqual(rej.ok, false, `${tag}/unknown: a real 0x64 refusal stays ok:false`);
  assertEqual(rej.reason, 'rejected', `${tag}/unknown: a real 0x64 refusal → reason 'rejected'`);

  // 'verified' — strict
  const mockV = new TimedTransport('serial', `mock-store-verified-${tag}`);
  const verified = driverOver(model, mockV, 'verified');
  mockV.script = () => [{ at: 1402, frame: ackFrame(model) }];
  const vok = await verified.store(SLOT);
  assertEqual(vok.ok && vok.acked, true, `${tag}/verified: ack at 1.4 s → ok + acked`);
  assertEqual(vok.error, undefined, `${tag}/verified: no error on success`);
  assertEqual(vok.reason, undefined, `${tag}/verified: an acknowledged store carries no reason`);
  const vo = mockV.lastOpts!;
  assert((vo.timeoutMs ?? 0) >= 4 * 1402, `${tag}/verified: cap (${vo.timeoutMs} ms) leaves >4x room for a 1.4 s ack`);
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
  assertEqual(none.reason, 'no-ack', `${tag}/verified: no ack → reason 'no-ack' (outcome unknown, not a refusal)`);

  // a real 0x64 refusal → ok:false, reason 'rejected' (the device said no — distinguishable without parsing text)
  mockV.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const vrej = await verified.store(SLOT);
  assertEqual(vrej.ok, false, `${tag}/verified: a real 0x64 refusal → ok:false`);
  assertEqual(vrej.reason, 'rejected', `${tag}/verified: a real 0x64 refusal → reason 'rejected'`);
}

async function contractEdges(): Promise<void> {
  const model = 0x11;
  const mock = new TimedTransport('serial', 'mock-store-edges');
  const driver = driverOver(model, mock, 'verified');

  // ack AFTER the cap → timeout, not success
  mock.script = () => [{ at: 9000, frame: ackFrame(model) }];
  const pastCap = await driver.store(SLOT);
  assertEqual(pastCap.ok, false, 'ack past the cap → ok:false');
  assertEqual(pastCap.reason, 'no-ack', "ack past the cap → reason 'no-ack'");

  // real refusal (0x64 echoing fn 0x01), no ack → ok:false carrying the result code
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x01, 0x05) }];
  const rej = await driver.store(SLOT);
  assertEqual(rej.ok, false, '0x64 refusal → ok:false');
  assertEqual(rej.acked, false, '0x64 refusal → acked:false');
  assertEqual(rej.reason, 'rejected', "0x64 refusal → reason 'rejected'");
  assert(/rejected by the device/.test(rej.error ?? '') && /0x05/.test(rej.error ?? ''), `0x64 refusal error carries the result code (${rej.error})`);

  // a stray 0x64 (a refused read from another exchange) followed by the genuine ack → the ack wins
  mock.script = () => [{ at: 50, frame: rejectFrame(model, 0x01, 0x07) }, { at: 1400, frame: ackFrame(model) }];
  const stray = await driver.store(SLOT);
  assertEqual(stray.ok && stray.acked, true, 'stray 0x64 + ack → ok (the ack is the device\'s own answer)');
  assertEqual(stray.reason, undefined, 'stray 0x64 + ack → no reason (the ack wins)');

  // a 0x64 refusing some OTHER function is not a refusal of the store → unconfirmed, not "rejected"
  mock.script = () => [{ at: 30, frame: rejectFrame(model, 0x13, 0x05) }];
  const other = await driver.store(SLOT);
  assertEqual(other.ok, false, '0x64 for another fn, no ack → ok:false');
  assert(!/rejected by the device/.test(other.error ?? ''), `0x64 for another fn is not reported as a store refusal (${other.error})`);
  assertEqual(other.reason, 'no-ack', "0x64 for another fn → reason 'no-ack', not 'rejected'");

  // an ack-shaped frame with a DIFFERENT model byte is not our ack
  mock.script = () => [{ at: 30, frame: ackFrame(0x12) }];
  assertEqual((await driver.store(SLOT)).ok, false, 'ack from another model byte → not an ack');

  // our OWN request coming back byte-for-byte (MIDI thru / loopback) is NOT an ack — strict AND lenient
  mock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoed = await driver.store(SLOT);
  assertEqual(echoed.ok, false, 'verified: a literal echo of the request is not an ack → ok:false');
  assertEqual(echoed.acked, false, 'verified: a literal echo of the request → acked:false');
  assertEqual(echoed.reason, 'no-ack', "verified: a literal echo of the request → reason 'no-ack'");
  const lenientMock = new TimedTransport('serial', 'mock-store-echo-unknown');
  const lenient = driverOver(model, lenientMock, 'unknown');
  lenientMock.script = (req) => [{ at: 5, frame: [...req] }];
  const echoedU = await lenient.store(SLOT);
  assertEqual(echoedU.acked, false, 'unknown: a literal echo of the request → acked:false (never a fake ack)');
  assert(/unconfirmed/.test(echoedU.warning ?? ''), 'unknown: a literal echo of the request → unconfirmed warning');
  assertEqual(echoedU.reason, 'no-ack', "unknown: a literal echo of the request → reason 'no-ack'");

  // a TYPED timeout (browser-direct transports reject a no-frame timeout; Node ones resolve []) = silence
  mock.script = () => [];
  mock.failWith = typedTimeout();
  const bd = await driver.store(SLOT);
  assertEqual(bd.ok, false, 'verified: typed request() timeout → ok:false');
  assert(/did not acknowledge/.test(bd.error ?? ''), `verified: typed request() timeout → clear error (${bd.error})`);
  assertEqual(bd.reason, 'no-ack', "verified: typed request() timeout → reason 'no-ack'");
  lenientMock.script = () => [];
  lenientMock.failWith = typedTimeout();
  const bdU = await lenient.store(SLOT);
  assertEqual(bdU.ok, true, 'unknown: typed request() timeout → ok:true');
  assert(/unconfirmed/.test(bdU.warning ?? ''), 'unknown: typed request() timeout → unconfirmed warning');
  assertEqual(bdU.reason, 'no-ack', "unknown: typed request() timeout → reason 'no-ack'");
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
  const slowMock = slowLink(new TimedTransport('serial', 'mock-store-slow')) as TimedTransport;
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
  type StoreBody = { ok: boolean; acked: boolean; reason?: StoreReason; location: number; error?: string; warning?: string };
  const post = async (t: Awaited<ReturnType<typeof buildTestApp>>, router: ReturnType<typeof createRouter>) => {
    const a = await t.app.inject({ method: 'POST', url: '/preset/store', payload: { number: 5 } });
    const r = await router.handle('POST', '/preset/store', JSON.stringify({ number: 5 }));
    assertEqual(a.statusCode, 200, 'store: verdicts ride an HTTP 200');
    assertEqual(String(r.body), a.payload, 'router twin: store body identical to the app');
    return JSON.parse(a.payload) as StoreBody;
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

  // DEFAULT FM3 driver, firmware NOT read at detect (the mock stays silent on fn 0x08): the evidence is
  // outside its measured scope, so the FM3 is lenient — ack → ok+acked; silence → ok+warning; text-only
  // timeouts → ok+warning; reasons: acked none, no-ack on the warnings, 'rejected' on a refusal
  {
    const t = await buildTestApp(model);
    assertEqual(t.registry.firmwareInfo(), null, 'app+router: firmware not read (silent fn 0x08)');
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [ackFrame(model)] : []);
      const acked = await post(t, router);
      assertEqual(acked.ok && acked.acked, true, 'app+router: acknowledged store → ok:true acked:true');
      assertEqual(acked.reason, undefined, 'app+router: acknowledged store → no reason');

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, true, "app+router: FM3 with unread firmware, silence → ok:true");
      assert(quiet.acked === false && /unconfirmed/.test(quiet.warning ?? ''), "app+router: FM3 with unread firmware, silence → acked:false + warning");
      assertEqual(quiet.reason, 'no-ack', "app+router: FM3 with unread firmware, silence → reason 'no-ack'");

      for (const message of ['MIDI request timed out after 2500ms', 'Serial request timed out after 2500ms']) {
        t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error(message); };
        const bd = await post(t, router);
        assert(bd.ok === true && bd.acked === false && /unconfirmed/.test(bd.warning ?? ''), `app+router: browser-direct "${message}" → the same unconfirmed verdict, not a 500`);
        assertEqual(bd.reason, 'no-ack', `app+router: browser-direct "${message}" → reason 'no-ack'`);
      }

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [rejectFrame(model, 0x01, 0x05)] : []);
      const refused = await post(t, router);
      assertEqual(refused.ok, false, "app+router: FM3 with unread firmware, real 0x64 → ok:false");
      assertEqual(refused.reason, 'rejected', "app+router: FM3 with unread firmware, real 0x64 → reason 'rejected'");
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
      assertEqual(quiet.reason, 'no-ack', "app+router: 'verified' model, silence → reason 'no-ack'");
      t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error('Serial request timed out after 6000ms'); };
      const bd = await post(t, router);
      assert(bd.ok === false && /did not acknowledge/.test(bd.error ?? ''), "app+router: 'verified' model, browser-direct timeout → ok:false + error");
      assertEqual(bd.reason, 'no-ack', "app+router: 'verified' model, browser-direct timeout → reason 'no-ack'");
    } finally { await t.app.close(); }
  }

  // the DEFAULT FM3 driver with the firmware the REGISTRY read at detect (fn 0x08 → 12.0 / 13.0), on a fast
  // link — the shipped table's 'verified' scope, reaching the driver through DriverCtx.getFirmware on both
  // surfaces: ack → ok+acked; silence and browser-direct timeouts → ok:false + error; a real 0x64 → ok:false
  for (const fw of [[12, 0], [13, 0]] as const) {
    const t = await buildTestApp(model, undefined, { firmware: fw });
    const label = `default FM3, fw ${fw[0]}.${fw[1]}`;
    assertEqual(t.registry.firmwareInfo()?.major, fw[0], `app+router: ${label}: the registry read the firmware (major)`);
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [ackFrame(model)] : []);
      const acked = await post(t, router);
      assertEqual(acked.ok && acked.acked, true, `app+router: ${label}, acknowledged store → ok:true acked:true`);
      assertEqual(acked.error, undefined, `app+router: ${label}, acknowledged store → no error`);
      assertEqual(acked.warning, undefined, `app+router: ${label}, acknowledged store → no warning`);
      assertEqual(acked.reason, undefined, `app+router: ${label}, acknowledged store → no reason`);

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, false, `app+router: ${label}, silence → ok:false`);
      assertEqual(quiet.acked, false, `app+router: ${label}, silence → acked:false`);
      assert(/did not acknowledge/.test(quiet.error ?? ''), `app+router: ${label}, silence → clear error (${quiet.error})`);
      assertEqual(quiet.reason, 'no-ack', `app+router: ${label}, silence → reason 'no-ack'`);

      for (const message of ['MIDI request timed out after 6000ms', 'Serial request timed out after 6000ms']) {
        t.mock.reply = (req) => { if (isIdentifyBroadcast(req)) return [handshakeReply(model)]; throw new Error(message); };
        const bd = await post(t, router);
        assert(bd.ok === false && bd.acked === false && /did not acknowledge/.test(bd.error ?? ''), `app+router: ${label}, browser-direct "${message}" → ok:false + error, not a 500`);
        assertEqual(bd.reason, 'no-ack', `app+router: ${label}, browser-direct "${message}" → reason 'no-ack'`);
      }

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : JSON.stringify(req) === storeReq ? [rejectFrame(model, 0x01, 0x05)] : []);
      const refused = await post(t, router);
      assertEqual(refused.ok, false, `app+router: ${label}, real 0x64 → ok:false`);
      assertEqual(refused.reason, 'rejected', `app+router: ${label}, real 0x64 → reason 'rejected'`);
      assert(/rejected by the device/.test(refused.error ?? ''), `app+router: ${label}, real 0x64 → refusal error (${refused.error})`);
    } finally { await t.app.close(); }
  }

  // the same default FM3 and firmware, but the registry's link reports itself slow (5-pin DIN) → outside the
  // measured scope: lenient again, with the unverified slow cap
  {
    const t = await buildTestApp(model, undefined, { firmware: [13, 0] });
    slowLink(t.mock);
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const quiet = await post(t, router);
      assertEqual(quiet.ok, true, 'app+router: default FM3, fw 13.0, slow link, silence → ok:true (lenient)');
      assert(quiet.acked === false && /unconfirmed/.test(quiet.warning ?? ''), 'app+router: default FM3, fw 13.0, slow link, silence → acked:false + warning');
      assertEqual(quiet.reason, 'no-ack', "app+router: default FM3, fw 13.0, slow link, silence → reason 'no-ack'");
    } finally { await t.app.close(); }
  }

  // a RE-DETECT whose fn 0x08 read fails must not keep the earlier firmware: the registry clears it first, so
  // the FM3 drops back to lenient (device info and the cache-key readers see "unknown" too); a later
  // successful read makes it strict again
  const fwReply = (major: number, minor: number) => [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
  for (const how of ['silent', 'throws'] as const) {
    const t = await buildTestApp(model, undefined, { firmware: [13, 0] });
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    const label = `app+router: re-detect, fn 0x08 ${how}`;
    try {
      assertEqual(t.registry.firmwareInfo()?.major, 13, `${label}: firmware read at the first detect`);
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      assertEqual((await post(t, router)).ok, false, `${label}: before — silence → ok:false (verified scope)`);

      t.mock.reply = (req) => {
        if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
        if (req[5] === 0x08 && how === 'throws') throw new Error('serial port closed');
        return [];
      };
      await t.registry.detect();
      assertEqual(t.registry.firmwareInfo(), null, `${label}: the earlier firmware is not kept`);
      assertEqual((await t.registry.deviceInfo()).firmware, null, `${label}: deviceInfo().firmware → null`);
      await t.registry.applyRuntimeCache(); // no firmware → no cache key is built, nothing is swapped, no crash
      const lenient = await post(t, router);
      assertEqual(lenient.ok, true, `${label}: silence → ok:true (lenient)`);
      assert(lenient.acked === false && /unconfirmed/.test(lenient.warning ?? ''), `${label}: silence → acked:false + warning`);
      assertEqual(lenient.reason, 'no-ack', `${label}: silence → reason 'no-ack'`);

      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : req[5] === 0x08 ? [fwReply(13, 0)] : []);
      await t.registry.detect();
      assertEqual(t.registry.firmwareInfo()?.major, 13, `${label}: a later successful read restores the firmware`);
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      assertEqual((await post(t, router)).ok, false, `${label}: after the read works again → strict (ok:false)`);
    } finally { await t.app.close(); }
  }

  // a re-detect that lands on a non-gen-3 unit (the AM4 is never asked fn 0x08) must not keep the FM3's firmware
  {
    const t = await buildTestApp(model, undefined, { firmware: [13, 0] });
    try {
      assertEqual(t.registry.firmwareInfo()?.major, 13, 'app+router: re-detect on a non-gen-3 unit: firmware read at the first detect');
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x15)] : []);
      await t.registry.detect();
      assertEqual(t.registry.detectedModelId, 0x15, 'app+router: re-detect on a non-gen-3 unit: the AM4 was detected');
      assertEqual(t.registry.firmwareInfo(), null, "app+router: re-detect on a non-gen-3 unit: the earlier unit's firmware is not kept");
    } finally { await t.app.close(); }
  }

  // REOPEN: dropping the live connection and opening a new transport clears the firmware (it is not carried
  // over to a possibly different or rebooted unit); with the re-read failing, the FM3 is lenient
  {
    const t = await buildTestApp(model, undefined, { firmware: [13, 0] });
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    try {
      assertEqual(t.registry.firmwareInfo()?.major, 13, 'app+router: reopen: firmware read at the first detect');
      await t.registry.selectConnection(null); // drops the live connection
      await t.registry.transport(); // a NEW transport opens
      assertEqual(t.registry.firmwareInfo(), null, 'app+router: reopen: the firmware is cleared, not carried to the new transport');
      t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
      const lenient = await post(t, router); // the first request re-detects; fn 0x08 is silent
      assertEqual(lenient.ok, true, 'app+router: reopen + failed re-read: silence → ok:true (lenient)');
      assertEqual(lenient.reason, 'no-ack', "app+router: reopen + failed re-read: silence → reason 'no-ack'");
    } finally { await t.app.close(); }
  }
}

/** POST /version/:id/restore = load + store: its answer must carry the store's verdict, not a blanket ok. */
async function restoreCarriesVerdict(): Promise<void> {
  const fakeStore = { getPresetVersion: () => ({ location: 5 }), getPresetVersionBytes: () => new Uint8Array([0xf0, 0xf7]) } as never;
  type StoreResult = { ok: boolean; acked?: boolean; reason?: StoreReason; error?: string; warning?: string };
  const driverWith = (storeResult: StoreResult) =>
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

  // additive: the store's own `acked` and `reason` pass through unchanged
  const acked = await restoreVersion(fakeStore, driverWith({ ok: true, acked: true }), 'v1');
  assertEqual(acked.acked, true, 'restore: carries acked:true');
  assertEqual(acked.reason, undefined, 'restore: an acknowledged store carries no reason');
  const noAck = await restoreVersion(fakeStore, driverWith({ ok: false, acked: false, reason: 'no-ack', error: 'no acknowledgement' }), 'v1');
  assertEqual(noAck.acked, false, 'restore: carries acked:false');
  assertEqual(noAck.reason, 'no-ack', "restore: carries reason 'no-ack' (outcome unknown)");
  const refused = await restoreVersion(fakeStore, driverWith({ ok: false, acked: false, reason: 'rejected', error: 'rejected by the device' }), 'v1');
  assertEqual(refused.reason, 'rejected', "restore: carries reason 'rejected' (the device said no)");
  const lenient = await restoreVersion(fakeStore, driverWith({ ok: true, acked: false, reason: 'no-ack', warning: 'unconfirmed' }), 'v1');
  assertEqual(lenient.ok && lenient.acked === false, true, 'restore: sent-but-unconfirmed → ok:true, acked:false');
  assertEqual(lenient.reason, 'no-ack', "restore: sent-but-unconfirmed carries reason 'no-ack'");
  // a driver that reports neither (AM4 / VP4 / gen-2) → the restore answer carries neither
  assertEqual('acked' in good, false, 'restore: a driver without acked → no acked key');
  assertEqual('reason' in good, false, 'restore: a driver without reason → no reason key');
}

export async function runGen3StoreTests(): Promise<void> {
  await defaultEvidence();
  await evidenceScope();
  await fm3MeasuredAcks();
  for (const m of GEN3_MODELS) await perModel(m);
  await contractEdges();
  await timeoutNormalisation();
  await bothSurfaces();
  await restoreCarriesVerdict();
}
