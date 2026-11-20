// Drivers over the REAL request queue (virtual-time fake link, NO hardware): each read only completes on ITS
// reply, so a late reply to an earlier read can never pass for the next one, and writes end as soon as the
// device answers them.
//   - gen-3 preset dump: only a whole dump counts (a stalled first attempt's tail never reaches the retry, and
//     a library scan never shifts slot N's preset into slot N+1); which header is acceptable follows the
//     per-model DUMP_HEADER_POLICY (FM3 stored slots strict; FM9 / Axe-Fx III and every edit-buffer read prefer
//     the requested number but fall back, logged once, instead of failing).
//   - gen-3 block bulk read: only the burst whose 0x74 head names the block counts (another block's late burst
//     is ignored); a burst whose 0x76 is lost ends after the quiet gap, not the timeout.
//   - gen-3 preset store: the store-ack wait keeps its timing and outcome on the real queue.
//   - gen-3 write: the device's value echo for THIS write ends the refusal window early (after a short
//     confirmation gap in which a refusal still counts).
//   - AM4 writes: the 64-byte param-write echo (not only the 18-byte command ack) ends a write — acknowledged,
//     `acked:true`; AM4 backup refuses a dump of another location.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildSetParamNorm, buildSetFloatParam, buildSetSceneName } from 'forgefx-midi/am4';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { createAm4Driver } from '../../src/drivers/am4.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { dumpAnswering, assert, assertEqual } from '../helpers/mock.js';
import { VirtualClock, FakeLink, QueueTransport, track } from '../helpers/virtualLink.js';

// One case = one executed check() (the suite verifies the count itself at the end).
export const REPLY_MATCHING_CASE_COUNT = 51;
let executed = 0;
function check(cond: unknown, msg: string): void {
  executed++;
  assert(cond, msg);
}

const FM3 = 0x11;
function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
/** Recompute a frame's checksum after editing it. */
function withChecksum(f: number[]): number[] {
  let cs = 0;
  for (let i = 0; i < f.length - 2; i++) cs ^= f[i]!;
  f[f.length - 2] = cs & 0x7f;
  return f;
}
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = null; } }
  }
  return frames;
}
const fixture = (name: string) => framesOf(new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/preset-convert/${name}`, import.meta.url)))));
const FIXTURE = fixture('fm3-preset-5.syx');
const FM9 = 0x12;
const FM9_FIXTURE = fixture('fm9-devs-gift-of-tone.syx');
const headerSlot = (bytes: ArrayLike<number>) => ((bytes[6]! & 0x7f) << 7) | (bytes[7]! & 0x7f);
/** `frames` (a whole dump) with its 0x77 header naming preset number `n` (0x3FFF = the edit buffer). */
const dumpNaming = (frames: number[][], n: number) =>
  frames.map((f) => (f[5] === 0x77 ? withChecksum([...f.slice(0, 6), (n >> 7) & 0x7f, n & 0x7f, ...f.slice(8)]) : f));

function rig() {
  const clock = new VirtualClock();
  const link = new FakeLink(clock);
  const transport = new QueueTransport(link);
  return { clock, link, transport };
}
function gen3Over(transport: QueueTransport, firmware: { major: number; minor: number } | null = null, model = FM3) {
  return createGen3Driver(PROFILES[model]!, { transport: async () => transport, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced'), getFirmware: () => firmware });
}
/** Run `fn` with console.log / console.warn captured. */
async function quietly<T>(fn: (logged: string[]) => Promise<T>): Promise<T> {
  const log = console.log, warn = console.warn;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    return await fn(logged);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// ── preset dump ──────────────────────────────────────────────────────────────────────────────────────────
async function stalledDumpNeverShiftsSlots(): Promise<void> {
  for (const tailAfterDrain of [false, true]) {
    const tag = tailAfterDrain ? 'tail after the drain' : 'tail inside the drain';
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport);
    const requests: number[] = [];
    // The device answers one dump at a time (it cannot start the next dump before the current one is out).
    // Slot 5's FIRST dump stalls after its first chunk (> the 180 ms quiet gap); its tail then arrives inside
    // the drain (200..450, cap-ended) — or, second run, at +400: with no late frame the drain ends quiet at
    // +380, so that tail lands in the RETRY, before the retry's own dump. Every later request gets a whole dump
    // naming the requested slot.
    let busyUntil = 0;
    const play = (frames: number[][], from: number) => {
      let t = Math.max(from, busyUntil + 1);
      for (const f of frames) { link.emitAt(t, f); busyUntil = t; t += 2; }
    };
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      const slot = headerSlot(bytes);
      requests.push(slot);
      const dump = dumpAnswering(bytes, FIXTURE);
      if (slot === 5 && requests.filter((s) => s === 5).length === 1) {
        link.emitAt(at + 10, dump[0]!);
        link.emitAt(at + 20, dump[1]!);
        busyUntil = at + 20;
        play(dump.slice(2), tailAfterDrain ? at + 400 : at + 270);
        return;
      }
      play(dump, at + 10);
    };
    const old = console.log;
    console.log = () => {};
    try {
      const d5 = track(clock, driver.dumpRaw(5));
      await clock.advanceTo(3000);
      const d6 = track(clock, driver.dumpRaw(6));
      await clock.advanceTo(6000);
      check(d5.done && !d5.error && headerSlot(d5.value!.bytes) === 5, `dump (${tag}): slot 5 decodes from a dump naming slot 5 (${String(d5.error ?? '')})`);
      check(d5.value?.bytes.length === FIXTURE.flat().length, `dump (${tag}): slot 5's bytes are exactly one whole dump — no stale tail mixed in`);
      check(d6.done && !d6.error && headerSlot(d6.value!.bytes) === 6, `dump (${tag}): slot 6 gets slot 6's dump, never slot 5's (the library-scan shift)`);
      check(requests.join(',') === '5,5,6', `dump (${tag}): slot 5 retried once, slot 6 asked once (${requests.join(',')})`);
    } finally {
      console.log = old;
    }
  }

  // FM3 (header check 'strict'): a stored-slot read never accepts another slot's whole dump
  {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport);
    link.device = (bytes, at) => {
      if (bytes[5] === 0x03) dumpNaming(FIXTURE, 4).forEach((f, i) => link.emitAt(at + 10 + i, f));
    };
    await quietly(async () => {
      const p = track(clock, driver.dumpRaw(7));
      await clock.advanceTo(30_000);
      check(p.done && !!p.error, 'dump (FM3 strict): a slot-7 read answered only with slot 4\'s dump fails instead of decoding the wrong preset');
    });
  }

  // FM9 (header not verified yet → 'prefer'): no dump naming slot 7 arrives → slot 4's whole dump is used after
  // the quiet gap, logged ONCE, without a drain or a retry
  {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport, null, FM9);
    const sent: number[] = [];
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      sent.push(at);
      dumpNaming(FM9_FIXTURE, 4).forEach((f, i) => link.emitAt(at + 10 + i, f));
    };
    await quietly(async (logged) => {
      const p = track(clock, driver.dumpRaw(7));
      const q = track(clock, driver.dumpRaw(8)); // queued right behind it
      await clock.advanceTo(4000);
      const lastFrameAt = 10 + FM9_FIXTURE.length - 1;
      check(p.done && !p.error && headerSlot(p.value!.bytes) === 4 && p.at === lastFrameAt + 180, `dump (FM9 prefer): another slot's whole dump is used one quiet gap after its terminator (at ${p.at}, ${String(p.error ?? '')})`);
      check(q.done && !q.error && sent.length === 2 && sent[1] === p.at, `dump (FM9 prefer): one request per read, and the next read goes out the moment it ends — no retry, no drain (sent ${sent.join(',')})`);
      check(logged.filter((l) => /header names slot 4/.test(l)).length === 1, `dump (FM9 prefer): the fallback is logged once (${logged.filter((l) => /header names/.test(l)).length})`);
    });
  }

  // a late WHOLE dump of slot 5 arrives first, then slot 6's own dump: slot 6 on both policies
  for (const [model, frames, label] of [[FM3, FIXTURE, 'FM3 strict'], [FM9, FM9_FIXTURE, 'FM9 prefer']] as const) {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport, null, model);
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      dumpNaming(frames, 5).forEach((f, i) => link.emitAt(at + 10 + i, f));
      dumpNaming(frames, 6).forEach((f, i) => link.emitAt(at + 100 + i, f));
    };
    await quietly(async () => {
      const p = track(clock, driver.dumpRaw(6));
      await clock.advanceTo(3000);
      check(p.done && !p.error && headerSlot(p.value!.bytes) === 6 && p.at === 100 + frames.length - 1, `dump (${label}): a late slot-5 dump never answers a slot-6 read (at ${p.at})`);
    });
  }

  // edit-buffer reads (grid(), presetBodyHex): a late stored-slot dump never answers them by itself
  {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport);
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      dumpNaming(FIXTURE, 5).forEach((f, i) => link.emitAt(at + 10 + i, f)); // a late scan reply
      dumpNaming(FIXTURE, 0x3fff).forEach((f, i) => link.emitAt(at + 100 + i, f)); // the edit buffer
    };
    await quietly(async () => {
      const p = track(clock, driver.dumpRaw(0x3fff)); // the same reader grid() uses
      await clock.advanceTo(3000);
      check(p.done && !p.error && headerSlot(p.value!.bytes) === 0x3fff, 'edit buffer: the dump naming the edit buffer wins over a late stored-slot dump');
    });
  }
  {
    // ... but when the device's edit-buffer reply names a stored slot, the read still works (after the quiet
    // gap, logged once) instead of failing
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport);
    link.device = (bytes, at) => {
      if (bytes[5] === 0x03) dumpNaming(FIXTURE, 5).forEach((f, i) => link.emitAt(at + 10 + i, f));
    };
    await quietly(async (logged) => {
      const p = track(clock, driver.grid());
      await clock.advanceTo(3000);
      check(p.done && !p.error && (p.value?.cells.length ?? 0) > 0 && p.at === 10 + FIXTURE.length - 1 + 180, `edit buffer: a stored-slot header is used after the quiet gap if nothing names the edit buffer (at ${p.at})`);
      check(logged.some((l) => /edit buffer read answered by a dump whose header names slot 5/.test(l)), 'edit buffer: and logged, as evidence for the header policy');
    });
  }
}

// ── block bulk read ──────────────────────────────────────────────────────────────────────────────────────
const head = (eid: number, n: number) => sysex(FM3, 0x74, [eid & 0x7f, (eid >> 7) & 0x7f, n & 0x7f, (n >> 7) & 0x7f]);
const body = (vals: number[]) => sysex(FM3, 0x75, [0x00, 0x00, ...vals.flatMap((v) => [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03])]);
const end = () => sysex(FM3, 0x76, []);
const burst = (eid: number, vals: number[]) => [head(eid, vals.length), body(vals), end()];

async function bulkReadIsPerBlock(): Promise<void> {
  const codec = createModernFractalCodec(FM3);
  const X = 0x25, Y = 0x26;
  const xBurst = burst(X, [100, 200, 300]);
  const yBurst = burst(Y, [7, 8, 9]);
  const expectY = codec.assembleGen3BlockBulkRead(yBurst).values;
  const { clock, link, transport } = rig();
  const driver = gen3Over(transport);
  const polls: { eid: number; at: number }[] = [];
  link.device = (bytes, at) => {
    if (bytes[5] !== 0x1f) return;
    const eid = bytes[6]! | (bytes[7]! << 7);
    polls.push({ eid, at });
    // X: silent until long after its 2.5 s timeout + drain — its burst lands while Y is being read
    if (eid === X) xBurst.forEach((f, i) => link.emitAt(at + 2650 + i, f));
    if (eid === Y) yBurst.forEach((f, i) => link.emitAt(at + 100 + i, f));
  };
  const old = console.warn;
  console.warn = () => {};
  try {
    const x = track(clock, driver.rawBlock(X));
    await clock.advanceTo(2500);
    check(x.done && !!x.error, 'bulk: X with no reply fails at its timeout (no 0x74 head), as before');
    const y = track(clock, driver.rawBlock(Y));
    await clock.advanceTo(10_000);
    const yAt = polls.find((p) => p.eid === Y)!.at;
    check(y.done && !y.error && y.at === yAt + 102, `bulk: Y completes on ITS burst, not on X's late burst (sent ${yAt}, done ${y.at})`);
    const got = y.value ? Object.entries(y.value.values).map(([k, v]) => `${k}:${v}`).join(',') : '';
    const want = expectY.map((v, i) => (v ? `${i}:${v}` : '')).filter(Boolean).join(',');
    check(got === want, `bulk: Y's values are Y's (${got} vs ${want})`);
  } finally {
    console.warn = old;
  }

  // a burst whose 0x76 is lost: ends one quiet gap after its last body, with what arrived
  const lost = rig();
  const d2 = gen3Over(lost.transport);
  lost.link.device = (bytes, at) => {
    if (bytes[5] !== 0x1f) return;
    lost.link.emitAt(at + 10, yBurst[0]!);
    lost.link.emitAt(at + 12, yBurst[1]!); // no 0x76
  };
  console.warn = () => {};
  try {
    const r = track(lost.clock, d2.rawBlock(Y));
    await lost.clock.advanceTo(5000);
    check(r.done && !r.error && r.at === 132, `bulk: a lost 0x76 ends 120 ms after the last body, not at the 2.5 s timeout (at ${r.at})`);
  } finally {
    console.warn = old;
  }
}

// ── preset store on the real queue ───────────────────────────────────────────────────────────────────────
async function storeOnTheRealQueue(): Promise<void> {
  const FW13 = { major: 13, minor: 0 }; // FM3, fast link, fw 13 → 'verified', cap 6000 ms
  const ack = sysex(FM3, 0x01, [0x26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const refusal = sysex(FM3, 0x64, [0x01, 0x05]);
  const noise = sysex(FM3, 0x13, [0x3a, 0x00, 0x02]);
  const cases: { name: string; script: [number, number[]][]; done: number; acked: boolean; reason?: string; nextAt: number }[] = [
    { name: 'ack at 1.4 s', script: [[1402, ack]], done: 1402, acked: true, nextAt: 1402 },
    { name: 'an unrelated frame, then the ack', script: [[100, noise], [1402, ack]], done: 1402, acked: true, nextAt: 1402 },
    { name: 'a stray 0x64, then the ack', script: [[30, refusal], [1402, ack]], done: 1402, acked: true, nextAt: 1402 },
    { name: 'silence', script: [], done: 6000, acked: false, reason: 'no-ack', nextAt: 6250 },
    { name: 'a refusal and no ack', script: [[30, refusal]], done: 6000, acked: false, reason: 'rejected', nextAt: 6000 }
  ];
  for (const c of cases) {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport, FW13);
    link.device = (bytes, at) => {
      if (bytes[5] === 0x01 && bytes[6] === 0x26) for (const [dt, f] of c.script) link.emitAt(at + dt, f);
    };
    const old = console.warn;
    console.warn = () => {};
    try {
      const s = track(clock, driver.store(408));
      await clock.advanceTo(0); // the store's request is queued first
      const next = track(clock, transport.request(sysex(FM3, 0x0c, []), { timeoutMs: 10, quietMs: 5 })); // any next request
      await clock.advanceTo(20_000);
      check(
        s.done && s.at === c.done && s.value?.acked === c.acked && s.value?.reason === c.reason,
        `store (${c.name}): settles at ${c.done} ms, acked=${c.acked}, reason=${c.reason} (got ${s.at} ms, ${JSON.stringify(s.value)})`
      );
      check(next.done && link.sentAt(1) === c.nextAt, `store (${c.name}): the next request goes out at ${c.nextAt} ms (at ${link.sentAt(1)})`);
    } finally {
      console.warn = old;
    }
  }
}

// ── writes end when the device answers them ──────────────────────────────────────────────────────────────
async function writesEndOnTheirEcho(): Promise<void> {
  // gen-3: a discrete SET's value echo (same fn, sub-action, effect id, param id) — 60 bytes. The echo opens a
  // confirmation gap (half the window, 60 ms): accepted at echo + 60 unless a refusal comes in that gap.
  for (const refuseAt of [null, 50] as const) {
    const { clock, link, transport } = rig();
    const driver = gen3Over(transport);
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x01 || bytes[6] !== 0x09) return;
      link.emitAt(at + 3, [...bytes]); // loopback of our own write: NOT an echo
      const echo = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, ...bytes.slice(6, 12), ...new Array<number>(46).fill(0), 0x00, 0xf7];
      link.emitAt(at + 25, withChecksum(echo));
      if (refuseAt !== null) link.emitAt(at + refuseAt, sysex(FM3, 0x64, [0x01, 0x0b]));
    };
    const w = track(clock, driver.setParam(0x25, 3, 2, false));
    await clock.advanceTo(1000);
    check(
      refuseAt === null ? w.done && w.at === 85 && w.value?.ok === true : w.done && w.at === refuseAt && w.value?.ok === false,
      refuseAt === null
        ? `gen3 write: the value echo ends the write one confirmation gap later (85 ms, was the 120 ms window), not the loopback at 3 ms (at ${w.at})`
        : `gen3 write: a refusal after the echo (inside the confirmation gap) still refuses the write (at ${w.at}, ok ${w.value?.ok})`
    );
  }

  // AM4: SET_NORM / WRITE get the 64-byte param-write echo; scene name gets the 18-byte command ack
  const am = rig();
  const am4 = createAm4Driver({ transport: async () => am.transport, emit: () => {}, getCadence: () => cadenceFor(0x15, 'balanced') });
  const ack64 = (req: number[]) => withChecksum([...req.slice(0, 12), 0x00, 0x00, 0x28, 0x00, ...new Array<number>(46).fill(0), 0x00, 0xf7]);
  const ack18 = (req: number[]) => withChecksum([...req.slice(0, 12), 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]);
  am.link.device = (bytes, at) => {
    am.link.emitAt(at + 2, [...bytes]); // USB-MIDI receipt-echo of our own bytes: never an ack
    const action = bytes[10];
    am.link.emitAt(at + 15, action === 0x01 || action === 0x02 ? ack64(bytes) : ack18(bytes));
  };
  const old = console.log;
  console.log = () => {};
  try {
    const norm = track(am.clock, am4.setParamNorm(0x3a, 0x0b, 0.5));
    await am.clock.advanceTo(1000);
    check(norm.done && norm.at === 15 && norm.value?.ok === true && norm.value?.acked === true, `am4 SET_NORM: the 64-byte echo ends the write at 15 ms with ok:true, acked:true (was 600 ms, ok:false) (at ${norm.at})`);
    const t0 = am.clock.t;
    const val = track(am.clock, am4.setParamValue(0x3a, 0x0c, 3));
    await am.clock.advanceTo(t0 + 1000);
    check(val.done && val.at === t0 + 15 && val.value?.ok === true, 'am4 WRITE: the 64-byte echo ends the write');
    const t1 = am.clock.t;
    const sn = track(am.clock, am4.setSceneName(0, 'Lead'));
    await am.clock.advanceTo(t1 + 1000);
    check(sn.done && sn.at === t1 + 15 && sn.value?.ok === true, 'am4 scene name: the 18-byte command ack ends it');
    check(isFrameSent(am.link.sent, buildSetParamNorm({ pidLow: 0x3a, pidHigh: 0x0b }, 0.5)) && isFrameSent(am.link.sent, buildSetFloatParam({ pidLow: 0x3a, pidHigh: 0x0c }, 3)) && isFrameSent(am.link.sent, buildSetSceneName(0, 'Lead')), 'am4: the frames on the wire are the codec\'s write frames');
    // no acknowledgement at all → ok:false, no `acked`
    am.link.device = null;
    const t2 = am.clock.t;
    const none = track(am.clock, am4.setParamNorm(0x3a, 0x0b, 0.25));
    await am.clock.advanceTo(t2 + 2000);
    check(none.done && none.value?.ok === false && none.value?.acked === undefined, 'am4: no acknowledgement → ok:false');
  } finally {
    console.log = old;
  }
}

// ── AM4 backup: the dump must be OF the requested location ───────────────────────────────────────────────
function am4DumpFrames(bank: number, sub: number): number[][] {
  const chunks = Array.from({ length: 4 }, () => sysex(0x15, 0x78, new Array<number>(3074).fill(0)));
  return [sysex(0x15, 0x77, [bank, sub, 0x00, 0x00, 0x00]), ...chunks, sysex(0x15, 0x79, [0x00, 0x00, 0x00])];
}
async function am4BackupChecksLocation(): Promise<void> {
  for (const [label, want, bank, sub, ok] of [
    ['location 5 answered with location 5', 5, 1, 1, true],
    ['location 5 answered with location 9 (a late scan reply)', 5, 2, 1, false],
    ['the active buffer answered with a stored location', null, 0, 1, false],
    ['the active buffer answered with the active buffer', null, 0x7f, 0, true]
  ] as const) {
    const { clock, link, transport } = rig();
    const am4 = createAm4Driver({ transport: async () => transport, emit: () => {}, getCadence: () => cadenceFor(0x15, 'balanced') });
    link.device = (bytes, at) => { am4DumpFrames(bank, sub).forEach((f, i) => link.emitAt(at + 10 + i, f)); };
    await quietly(async () => {
      const p = track(clock, am4.backupPreset(want ?? undefined));
      await clock.advanceTo(10_000);
      check(
        p.done && (ok ? !p.error && p.value?.location === want : /late reply to an earlier read/.test(String((p.error as Error)?.message))),
        `am4 backup: ${label} → ${ok ? 'backed up' : 'refused'} (${String((p.error as Error)?.message ?? '')})`
      );
    });
  }

  // a stale dump of location 9 arrives first, then this request's own dump of location 5: the stale one is
  // ignored by the matcher and the request completes on its own dump — no "try again"
  const { clock, link, transport } = rig();
  const am4 = createAm4Driver({ transport: async () => transport, emit: () => {}, getCadence: () => cadenceFor(0x15, 'balanced') });
  const own = am4DumpFrames(1, 1);
  link.device = (_bytes, at) => {
    am4DumpFrames(2, 1).forEach((f, i) => link.emitAt(at + 10 + i, f));
    own.forEach((f, i) => link.emitAt(at + 50 + i, f));
  };
  await quietly(async () => {
    const p = track(clock, am4.backupPreset(5));
    await clock.advanceTo(10_000);
    check(p.done && !p.error && p.value?.location === 5 && p.at === 50 + own.length - 1, `am4 backup: a stale dump of another location is skipped and the own dump completes the backup (at ${p.at}, ${String((p.error as Error)?.message ?? '')})`);
  });
}

// ── adaptive header policy + the current slot as an edit-buffer header ───────────────────────────────────
async function headerPolicyAdapts(): Promise<void> {
  // FM9 starts 'prefer' for stored slots. Once the device has named a requested slot in a header, the
  // connection is 'strict': a later read answered only by another slot's dump fails instead of using it.
  const mk = () => {
    const r = rig();
    r.link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      const slot = headerSlot(bytes);
      dumpNaming(FM9_FIXTURE, slot === 7 ? 4 : slot).forEach((f, i) => r.link.emitAt(at + 10 + i, f)); // slot 7 → slot 4's dump
    };
    return r;
  };
  let conn = mk();
  const driver = createGen3Driver(PROFILES[FM9]!, { transport: async () => conn.transport, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced'), getFirmware: () => null });
  const read = async (slot: number) => {
    const p = track(conn.clock, driver.dumpRaw(slot));
    await conn.clock.advanceTo(conn.clock.t + 30_000);
    return p;
  };
  await quietly(async () => {
    const fresh = await read(7);
    check(fresh.done && !fresh.error && headerSlot(fresh.value!.bytes) === 4, 'adaptive: a fresh FM9 connection still falls back (prefer)');
    const proven = await read(3);
    check(proven.done && !proven.error && headerSlot(proven.value!.bytes) === 3, 'adaptive: the device names slot 3 in its header');
    const strict = await read(7);
    check(strict.done && !!strict.error, 'adaptive: after that, another slot\'s dump is never used again on this connection (strict)');
    conn = mk(); // reconnect: a new transport
    const again = await read(7);
    check(again.done && !again.error && headerSlot(again.value!.bytes) === 4, 'adaptive: a reconnect starts from the table again (prefer)');
    await read(3); // proven again on the new connection
    driver.resetSession(); // what the registry does on (re)detect
    const redetected = await read(7);
    check(redetected.done && !redetected.error, 'adaptive: a re-detect starts from the table again too');
  });

  // edit buffer: once the driver knows the current slot, a header naming it is the edit buffer's own (no
  // quiet-gap wait); a stored-slot header naming anything else still is not
  for (const knows of [false, true]) {
    const { clock, link, transport } = rig();
    const driver3 = gen3Over(transport);
    let dumpAt = -1;
    link.device = (bytes, at) => {
      if (bytes[5] !== 0x03) return;
      dumpAt = at;
      dumpNaming(FIXTURE, 9).forEach((f, i) => link.emitAt(at + 10 + i, f)); // a late scan reply
      dumpNaming(FIXTURE, 5).forEach((f, i) => link.emitAt(at + 60 + i, f)); // the edit buffer, naming slot 5
    };
    await quietly(async () => {
      if (knows) {
        const sel = track(clock, driver3.selectPreset(5)); // silent accept → current slot 5
        await clock.advanceTo(clock.t + 500);
        check(sel.done && sel.value?.ok === true, 'edit buffer: selectPreset(5) accepted');
      }
      const p = track(clock, driver3.dumpRaw(0x3fff)); // the reader grid() uses
      await clock.advanceTo(clock.t + 5000);
      const terminatorAt = dumpAt + 60 + FIXTURE.length - 1;
      check(
        p.done && !p.error && headerSlot(p.value!.bytes) === 5 && p.at === (knows ? terminatorAt : terminatorAt + 180),
        knows
          ? `edit buffer: with the current slot known (5), its header is accepted at the terminator — no +180 ms (at ${p.at - dumpAt})`
          : `edit buffer: without it, today's behaviour — the last whole dump after the quiet gap (at ${p.at - dumpAt})`
      );
    });
  }
}
const isFrameSent = (sent: { bytes: number[] }[], f: number[]) => sent.some((s) => s.bytes.length === f.length && s.bytes.every((b, i) => b === f[i]));

export async function runReplyMatchingTests(): Promise<void> {
  executed = 0;
  await stalledDumpNeverShiftsSlots();
  await bulkReadIsPerBlock();
  await storeOnTheRealQueue();
  await writesEndOnTheirEcho();
  await am4BackupChecksLocation();
  await headerPolicyAdapts();
  assertEqual(executed, REPLY_MATCHING_CASE_COUNT, 'reply-matching: REPLY_MATCHING_CASE_COUNT is in step with the executed checks');
}
