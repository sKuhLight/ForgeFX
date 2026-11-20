// The gen-3 reject-only write path (#write: scene/preset names, grid edits, non-continuous param sets, preset
// switch). The device answers an accepted write with silence and a refused one with a 0x64
// MULTIPURPOSE_RESPONSE `[echoedFn, resultCode]` — so a 0x64 is attributed to the write only when it echoes the
// write's own function byte, and silence must cost no more than the write's own 120 ms window.
//
// Mocked, NO hardware: a scripted MockTransport for the outcome, and the REAL request queue over a virtual-time
// link for the timing (the queue is what the serial and MIDI transports run on).
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import type { RequestOpts, Transport } from '../../src/transport/types.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import { VirtualClock, FakeLink, QueueTransport, track } from '../helpers/virtualLink.js';

const MODEL = 0x11; // FM3
const FN_SET_GET = 0x01; // the function every #write-based op (scene/preset name, grid, type) is built on

// One case = one executed check() (the suite verifies the count itself at the end).
export const WRITE_REJECTION_CASE_COUNT = 16;
let executed = 0;
function check(cond: unknown, msg: string): void {
  executed++;
  assert(cond, msg);
}

function sysex(fn: number, payload: readonly number[], model = MODEL): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const rejection = (echoedFn: number, model = MODEL) => sysex(0x64, [echoedFn, 0x0b], model);

function driverOver(t: Transport) {
  return createGen3Driver(PROFILES[MODEL]!, { transport: async () => t, emit: () => {}, getCadence: () => cadenceFor(MODEL, 'balanced') });
}

/** One scene-name write with the mock answering it with `reply` (or throwing `fail`). */
async function writeWith(reply: number[][], fail?: Error): Promise<{ ok: boolean; opts: RequestOpts | undefined }> {
  const mock = new MockTransport('serial', 'mock-write');
  mock.isOpen = true;
  let opts: RequestOpts | undefined;
  mock.request = async (bytes, o) => {
    mock.sent.push([...bytes]);
    opts = o;
    if (fail) throw fail;
    return reply;
  };
  const r = await driverOver(mock).setSceneName!(0, 'Test Scene');
  return { ok: r.ok, opts };
}

async function attribution(): Promise<void> {
  check((await writeWith([rejection(0x1f)])).ok, 'a 0x64 echoing ANOTHER function (0x1f, a refused read) is not this write\'s refusal — ok');
  check(!(await writeWith([rejection(FN_SET_GET)])).ok, 'a 0x64 echoing this write\'s function (0x01) is its refusal — ok:false');
  check((await writeWith([])).ok, 'silence is acceptance — ok');
  check((await writeWith([rejection(FN_SET_GET, 0x10)])).ok, 'a fn-0x01 refusal from ANOTHER model byte is not this device\'s answer — ok');
  check(!(await writeWith([[0xf0, 0x00, 0x01, 0x74, MODEL, 0x64, 0xf7]])).ok, 'a 0x64 too short to echo a function counts as this write\'s refusal (conservative)');
  check(!(await writeWith([rejection(0x1f), rejection(FN_SET_GET)])).ok, 'a foreign 0x64 does not hide the write\'s own refusal behind it');

  const { opts } = await writeWith([]);
  check(opts?.rejectOnly === true, 'the write is sent as rejectOnly (silence = success: no warning, no drain)');
  check(opts?.timeoutMs === 120, 'the refusal window stays 120 ms');

  const typed = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
  check((await writeWith([], typed)).ok, 'browser-direct: a typed no-frame timeout on a reject-only write is acceptance — ok');
  let threw = false;
  try { await writeWith([], new Error('port not open')); } catch { threw = true; }
  check(threw, 'any other transport error still propagates');
}

/** Through the real queue: the write is not delayed, a foreign 0x64 does not end it, its own refusal does. */
async function timingOverQueue(): Promise<void> {
  const silent = new VirtualClock();
  const sLink = new FakeLink(silent);
  const sDriver = driverOver(new QueueTransport(sLink));
  const w = track(silent, sDriver.setSceneName!(0, 'Test Scene'));
  const next = track(silent, sDriver.setPresetName!('Next'));
  await silent.advanceTo(120);
  check(w.done && w.at === 120 && (w.value as { ok: boolean }).ok, `queue: a silent write is accepted at its 120 ms window end (at ${w.at})`);
  check(sLink.sentAt(1) === 120, `queue: the next write goes out at once — no drain after a reject-only write (at ${sLink.sentAt(1)})`);
  await silent.advanceTo(240);
  check(next.done && next.at === 240, 'queue: back-to-back writes cost one window each');

  const foreign = new VirtualClock();
  const fLink = new FakeLink(foreign);
  const fw = track(foreign, driverOver(new QueueTransport(fLink)).setSceneName!(0, 'Test Scene'));
  foreign.at(10, () => fLink.emit(rejection(0x1f)));
  await foreign.advanceTo(119);
  check(!fw.done, 'queue: a foreign 0x64 neither matches nor quiet-completes the write window');
  await foreign.advanceTo(120);
  check(fw.done && (fw.value as { ok: boolean }).ok, 'queue: and the write is still accepted');

  const refused = new VirtualClock();
  const rLink = new FakeLink(refused);
  const rw = track(refused, driverOver(new QueueTransport(rLink)).setSceneName!(0, 'Test Scene'));
  refused.at(30, () => rLink.emit(rejection(FN_SET_GET)));
  await refused.advanceTo(30);
  check(rw.done && rw.at === 30 && !(rw.value as { ok: boolean }).ok, 'queue: its own refusal ends the write at once — ok:false');
}

export async function runWriteRejectionTests(): Promise<void> {
  executed = 0;
  await attribution();
  await timingOverQueue();
  assertEqual(executed, WRITE_REJECTION_CASE_COUNT, 'write-rejection: WRITE_REJECTION_CASE_COUNT is in step with the executed checks');
}
