// The request queue shared by the serial and USB-MIDI transports (src/transport/requestQueue.ts): when a
// request is complete, and what happens to a reply that arrives after its request gave up. NO hardware: a fake
// link and a VIRTUAL clock, so the drain caps and multi-second timeouts run instantly and to the ms.
//
// The failure this guards against: a request times out, its reply arrives late during the NEXT request, that
// request ends on the wrong frame, and its own reply then poisons the one after it.
import {
  RequestQueue, LATE_DRAIN_LIMITS, SAME_TICK_MS, isResultEcho, pacedWrite
} from '../../src/transport/requestQueue.js';
import { isTransportTimeout, type RequestOpts } from '../../src/transport/types.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { VirtualClock, FakeLink, track } from '../helpers/virtualLink.js';

// One case = one executed check() (the suite verifies the count itself at the end).
export const REQUEST_QUEUE_CASE_COUNT = 130;
let executed = 0;
function check(cond: unknown, msg: string): void {
  executed++;
  assert(cond, msg);
}
function checkEqual(actual: unknown, expected: unknown, msg: string): void {
  executed++;
  assertEqual(actual, expected, msg);
}

const MODEL = 0x11;
function sysex(fn: number, payload: readonly number[], model = MODEL): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const fnOf = (f: readonly number[]) => f[5];
const byFn = (fn: number) => (fs: number[][]) => fs.some((f) => f[5] === fn);
const same = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

// synthetic request / reply frames
const REQ_STATUS = sysex(0x0d, [0x01]);
const REQ_GET = sysex(0x01, [0x01, 0x00, 0x05, 0x00, 0x02, 0x00]);
const REQ_RANGE = sysex(0x01, [0x1a, 0x00, 0x05, 0x00, 0x02, 0x00]);
const REQ_POLL = sysex(0x1f, [0x25, 0x00]);
const REQ_DUMP = sysex(0x03, [0x7f, 0x7f]);
const REQ_WRITE = sysex(0x01, [0x09, 0x00, 0x00, 0x41, 0x42]);
const statusReply = (tag: number) => sysex(0x0d, [0x01, tag]);
const getReply = (tag: number) => sysex(0x01, [0x01, 0x00, 0x05, 0x00, 0x02, 0x00, tag]);
const isGetReply = (fs: number[][]) => fs.some((f) => f[5] === 0x01 && f[6] === 0x01 && f.length > 14);
const noise = () => sysex(0x13, [0x3a, 0x00, 0x02]); // unsolicited status broadcast
const result = (echoedFn: number, code: number) => sysex(0x64, [echoedFn, code]);
const ownRefusal = (fs: number[][]) => fs.some((f) => isResultEcho(REQ_WRITE, f));
const WRITE: RequestOpts = { timeoutMs: 120, quietMs: 60, rejectOnly: true, match: ownRefusal };

function rig(extra: { silenceError?: (ms: number) => Error } = {}) {
  const clock = new VirtualClock();
  const link = new FakeLink(clock);
  const warnings: string[] = [];
  const queue = new RequestQueue(link, { tag: 'test', clock, warn: (m) => warnings.push(m), ...extra });
  const request = (bytes: number[], opts: RequestOpts) => track(clock, queue.request(bytes, opts));
  return { clock, link, warnings, queue, request };
}

// ── 1. lost reply ────────────────────────────────────────────────────────────────────────────────────────
async function lostReply(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 300, quietMs: 50, match: byFn(0x01) });
  await clock.advanceTo(299);
  check(!a.done, 'lost reply: still waiting just before the timeout');
  await clock.advanceTo(300);
  check(a.done && a.at === 300, `lost reply: the caller is answered AT the timeout, not after the drain (at ${a.at})`);
  check(Array.isArray(a.value) && a.value.length === 0, 'lost reply: resolves [] (Node convention, as before)');
  checkEqual(warnings.length, 1, 'lost reply: one timeout warning');
  check(/fn=0x0d/.test(warnings[0] ?? '') && /no reply within 300 ms/.test(warnings[0] ?? ''), `lost reply: the warning names the function and the timeout (${warnings[0]})`);
  checkEqual(link.sent.length, 1, 'lost reply: the link is still held at the timeout (next request not sent)');
  await clock.advanceTo(399);
  checkEqual(link.sent.length, 1, 'lost reply: held for the drain quiet window — max(quietMs 50, floor 100) = 100 ms');
  await clock.advanceTo(400);
  checkEqual(link.sentAt(1), 400, 'lost reply: a silent drain releases the link after one quiet window');
  link.emitAt(410, getReply(1));
  await clock.advanceTo(450);
  check(b.done && b.at === 410 && same(b.value?.[0], getReply(1)), 'lost reply: the next request then completes normally on its own reply');
  checkEqual(warnings.length, 1, 'lost reply: a silent drain logs nothing more');
}

// ── 2. a late reply never completes the next request ─────────────────────────────────────────────────────
async function lateReplyDuringNextRequest(): Promise<void> {
  const { clock, link, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  const c = request(REQ_STATUS, { timeoutMs: 1000, quietMs: 50, match: byFn(0x0d) });
  await clock.advanceTo(400); // A timed out at 300, drained silently until 400 → B on the wire
  checkEqual(link.sentAt(1), 400, 'late reply: B is sent once A has drained');
  check(a.done && a.value?.length === 0, 'late reply: A was answered at its timeout');
  link.emitAt(420, statusReply(0xaa)); // A's reply, after the drain — B is in flight now
  await clock.advanceTo(519);
  check(!b.done, 'late reply: A\'s late reply neither completes B nor quiet-completes it (old code ended B at 470)');
  checkEqual(link.sent.length, 2, 'late reply: C is not sent while B still waits for its own reply');
  link.emitAt(550, getReply(0xbb));
  await clock.advanceTo(550);
  check(b.done && b.at === 550, `late reply: B completes on ITS reply (at ${b.at})`);
  check(same(b.value?.find((f) => fnOf(f) === 0x01), getReply(0xbb)), 'late reply: the reply B\'s caller picks is B\'s own');
  checkEqual(link.sentAt(2), 550, 'late reply: a matched request that got its reply releases the link at once (no drain)');
  link.emitAt(570, statusReply(0xcc));
  await clock.advanceTo(570);
  check(c.done && c.at === 570, 'late reply: C completes on its own reply');
  checkEqual(c.value?.length, 1, 'late reply: C saw only its own reply — B\'s reply did not poison it');
  check(same(c.value?.[0], statusReply(0xcc)), 'late reply: C got C\'s payload, not A\'s late one');

  // The limit, stated as a test: a reply later than the drain that the NEXT request's matcher accepts (here a
  // function-only matcher of the same function) does complete it. Only a specific matcher prevents that.
  const lim = rig();
  lim.request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const d = lim.request(REQ_STATUS, { timeoutMs: 1000, quietMs: 50, match: byFn(0x0d) });
  lim.link.emitAt(420, statusReply(0xaa));
  await lim.clock.advanceTo(420);
  check(d.done && same(d.value?.[0], statusReply(0xaa)), 'limit: a late same-function reply after the drain completes a function-only matcher (documented)');
}

async function lateReplyInsideDrain(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  link.emitAt(320, statusReply(0xaa)); // A's reply 20 ms too late — inside the drain
  await clock.advanceTo(419);
  checkEqual(link.sent.length, 1, 'drain: a late frame re-arms the drain quiet window');
  check(a.done && a.value?.length === 0, 'drain: the late reply is not handed to the caller that already gave up');
  await clock.advanceTo(420);
  checkEqual(link.sentAt(1), 420, 'drain: link released one quiet window after the late frame');
  link.emitAt(430, getReply(1));
  await clock.advanceTo(430);
  checkEqual(b.value?.length, 1, 'drain: B never sees A\'s swallowed reply');
  check(warnings.some((w) => /swallowed 1 late frame\(s\) after fn=0x0d/.test(w)), `drain: a summary names the swallowed frame (${warnings.join(' | ')})`);
}

// ── 3. unrelated traffic during a matched request ────────────────────────────────────────────────────────
async function unrelatedFrames(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const r = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  link.emitAt(10, noise());
  link.emitAt(20, result(0x1f, 0x07)); // a refusal of ANOTHER function (a foreign 0x64)
  link.emitAt(100, noise());
  link.emitAt(200, sysex(0x64, [0x01, 0x05], 0x10)); // fn-0x01 refusal, but another model byte
  link.emitAt(400, getReply(7));
  await clock.advanceTo(399);
  check(!r.done, 'unrelated: gaps of silence after unrelated frames do not end a matched request');
  await clock.advanceTo(400);
  check(r.done && r.at === 400, 'unrelated: it completes on its own reply');
  checkEqual(r.value?.length, 5, 'unrelated: unrelated frames are still collected (callers pick with their own predicate)');
  check(same(r.value?.[4], getReply(7)), 'unrelated: the reply is in the result');
  checkEqual(warnings.length, 0, 'unrelated: nothing to warn about');
}

async function refusalEndsMatchedRequest(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  // a bulk-read poll of an unplaced block: the device answers with a 0x64 echoing fn 0x1f instead of a burst
  const r = request(REQ_POLL, { timeoutMs: 2500, quietMs: 120, match: byFn(0x76) });
  request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  link.emitAt(30, result(0x1f, 0x07));
  await clock.advanceTo(149);
  check(!r.done, 'refusal: the owned 0x64 arms the quiet gap (a real reply right behind it would still win)');
  await clock.advanceTo(150);
  check(r.done && r.at === 150, `refusal: a refused request ends one quiet gap after the refusal, not at the 2.5 s timeout (at ${r.at})`);
  check(same(r.value?.[0], result(0x1f, 0x07)), 'refusal: the refusal is handed to the caller');
  checkEqual(link.sentAt(1), 150, 'refusal: no drain after an answered request');
  checkEqual(warnings.length, 0, 'refusal: not a timeout, no warning');
  check(isResultEcho(REQ_POLL, result(0x1f, 0x07)), 'isResultEcho: 0x64 echoing the request fn + model');
  check(!isResultEcho(REQ_POLL, result(0x01, 0x07)), 'isResultEcho: another fn is not this request\'s result');
  check(!isResultEcho(REQ_POLL, sysex(0x64, [0x1f, 0x07], 0x10)), 'isResultEcho: another model byte is not this device\'s result');
  check(!isResultEcho(REQ_POLL, [0xf0, 0x00, 0x01, 0x74, MODEL, 0x64, 0xf7]), 'isResultEcho: a 0x64 too short to echo a function is not attributed here');
}

// ── 4. a reply that stops short: quiet-gap end WITHOUT match drains too ──────────────────────────────────
async function incompleteReplyDrains(): Promise<void> {
  // The stalled dump: header @10, chunk @20, the device stalls 250 ms (> quietMs 180), then the rest.
  const { clock, link, warnings, request } = rig();
  const owns = (f: number[]) => f[5] === 0x77 || f[5] === 0x78;
  const opts: RequestOpts = { timeoutMs: 5000, quietMs: 180, match: byFn(0x79), owns };
  const a1 = request(REQ_DUMP, opts);
  const a2 = request(REQ_DUMP, opts); // the retry a dump reader issues
  link.emitAt(10, sysex(0x77, [0x00, 0x05]));
  link.emitAt(20, sysex(0x78, [0x01]));
  link.emitAt(30, noise()); // not owned: must not extend the window
  link.emitAt(270, sysex(0x78, [0x02]));
  link.emitAt(280, sysex(0x79, []));
  await clock.advanceTo(199);
  check(!a1.done, 'incomplete: still waiting inside the quiet gap after the last owned frame');
  await clock.advanceTo(200);
  check(a1.done && a1.at === 200, `incomplete: the caller is answered one quiet gap after its last owned frame (at ${a1.at})`);
  checkEqual(a1.value?.length, 3, 'incomplete: it gets what arrived');
  checkEqual(link.sent.length, 1, 'incomplete: but the link stays held — the reply stopped short, the rest may still come');
  check(warnings.some((w) => /reply incomplete/.test(w)), 'incomplete: a warning says the reply stopped short');
  await clock.advanceTo(449);
  checkEqual(link.sent.length, 1, 'incomplete: the stalled tail (0x78 @270, 0x79 @280) is swallowed by the drain');
  await clock.advanceTo(450);
  checkEqual(link.sentAt(1), 450, 'incomplete: released at the drain cap (start 200 + 250 ms)');
  check(warnings.some((w) => /swallowed 2 late frame\(s\)/.test(w)), 'incomplete: the summary counts the swallowed tail');
  await clock.advanceTo(1000);
  check(!a2.done, 'incomplete: the retry never receives the first attempt\'s tail (old code completed it at 280 with it)');

  // without `owns` the same dump waits for the hard timeout
  const s = rig();
  const t = s.request(REQ_DUMP, { timeoutMs: 5000, quietMs: 180, match: byFn(0x79) });
  s.link.emitAt(10, sysex(0x77, [0x00]));
  s.link.emitAt(20, sysex(0x78, [0x01]));
  await s.clock.advanceTo(4999);
  check(!t.done, 'owns: without it, chunks are not owned — no quiet completion');
  await s.clock.advanceTo(5000);
  check(t.done && t.at === 5000, 'owns: without it, the request ends at the timeout');
}

// ── 5. requests without a matcher: classic quiet-gap collection, unchanged ───────────────────────────────
async function unmatchedUnchanged(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const r = request(REQ_GET, { timeoutMs: 500, quietMs: 50 });
  link.emitAt(10, noise());
  link.emitAt(40, getReply(1));
  await clock.advanceTo(89);
  check(!r.done, 'unmatched: the quiet gap runs from the LAST frame');
  await clock.advanceTo(90);
  check(r.done && r.at === 90, `unmatched: ends quietMs after the last frame, any frame counts (at ${r.at})`);
  checkEqual(r.value?.length, 2, 'unmatched: every frame collected');
  checkEqual(link.sent.length, 1, 'unmatched: (nothing else queued)');

  const silent = request(REQ_STATUS, { timeoutMs: 500, quietMs: 50 });
  request(REQ_GET, { timeoutMs: 500, quietMs: 50 });
  await clock.advanceTo(590);
  check(silent.done && silent.at === 590 && silent.value?.length === 0, 'unmatched: silence resolves [] at the timeout');
  checkEqual(link.sentAt(2), 590, 'unmatched: no drain — the next request goes out at the timeout');
  checkEqual(warnings.length, 0, 'unmatched: no timeout warning');

  const chatty = rig();
  const c = chatty.request(REQ_GET, { timeoutMs: 300, quietMs: 50 });
  for (let at = 10; at < 1000; at += 20) chatty.link.emitAt(at, noise());
  await chatty.clock.advanceTo(300);
  check(c.done && c.at === 300, 'unmatched: the hard cap still ends a quiet gap that never comes');
}

// ── 6. the drain is bounded ──────────────────────────────────────────────────────────────────────────────
async function drainCap(): Promise<void> {
  checkEqual(LATE_DRAIN_LIMITS.maxMs, 250, 'drain cap: 250 ms by default');
  checkEqual(LATE_DRAIN_LIMITS.maxFrames, 32, 'drain cap: 32 frames by default');
  checkEqual(LATE_DRAIN_LIMITS.quietFloorMs, 100, 'drain floor: 100 ms by default');

  // a chatty device: a frame every 20 ms for a full second after the timeout — each would re-arm the quiet gap
  const time = rig();
  const a = time.request(REQ_STATUS, { timeoutMs: 100, quietMs: 50, match: byFn(0x0d) });
  time.request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  for (let at = 110; at < 1200; at += 20) time.link.emitAt(at, noise());
  await time.clock.advanceTo(349);
  checkEqual(time.link.sent.length, 1, 'drain cap: still draining before the time cap');
  await time.clock.advanceTo(350);
  checkEqual(time.link.sentAt(1), 350, 'drain cap: a chatty device cannot hold the link past timeout + 250 ms');
  check(a.done && a.at === 100, 'drain cap: the timed-out caller was answered at its timeout regardless');
  check(time.warnings.some((w) => /swallowed 13 late frame\(s\)/.test(w) && /drain cap reached/.test(w)), `drain cap: the summary says the cap ended it (${time.warnings.join(' | ')})`);

  // a burst: more late frames than the frame cap, all at once
  const burst = rig();
  burst.request(REQ_STATUS, { timeoutMs: 100, quietMs: 50, match: byFn(0x0d) });
  const b = burst.request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  burst.clock.at(110, () => { for (let i = 0; i < 40; i++) burst.link.emit(noise()); });
  await burst.clock.advanceTo(110);
  checkEqual(burst.link.sentAt(1), 110, 'drain cap: the 32nd late frame releases the link at once');
  check(burst.warnings.some((w) => /swallowed 32 late frame\(s\)/.test(w)), 'drain cap: exactly maxFrames swallowed');
  burst.link.emitAt(120, getReply(2));
  await burst.clock.advanceTo(120);
  check(b.done && same(b.value?.[0], getReply(2)) && b.value?.length === 1, 'drain cap: the request after the burst still gets its own reply');

  // the store-ack shape: a multi-second quietMs must not turn into a multi-second drain
  const store = rig();
  const s = store.request(REQ_GET, { timeoutMs: 6000, quietMs: 6000, match: byFn(0x02) });
  store.request(REQ_STATUS, { timeoutMs: 1000, quietMs: 50, match: byFn(0x0d) });
  await store.clock.advanceTo(6000);
  check(s.done && s.at === 6000, 'drain cap: a long-cap request is answered at its cap (store-ack timing unchanged)');
  await store.clock.advanceTo(6249);
  checkEqual(store.link.sent.length, 1, 'drain cap: drain quiet = min(quietMs, 250 ms)');
  await store.clock.advanceTo(6250);
  checkEqual(store.link.sentAt(1), 6250, 'drain cap: the link is free 250 ms after a long-cap timeout');

  // the floor: a 12 ms meter poll still waits 100 ms for a late reply
  const floor = rig();
  floor.request(REQ_STATUS, { timeoutMs: 200, quietMs: 12, match: byFn(0x0d) });
  floor.request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  floor.link.emitAt(260, statusReply(1)); // 60 ms late: past the old 12 ms window, inside the floor
  await floor.clock.advanceTo(359);
  checkEqual(floor.link.sent.length, 1, 'drain floor: a short-quiet request still drains at least 100 ms');
  await floor.clock.advanceTo(360);
  checkEqual(floor.link.sentAt(1), 360, 'drain floor: the 60 ms-late reply was swallowed and re-armed the window');
}

// ── 7. reject-only writes: no drain, and their late refusals stay theirs ─────────────────────────────────
async function rejectOnlyWrite(): Promise<void> {
  const ok = rig();
  const w = ok.request(REQ_WRITE, WRITE);
  ok.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  await ok.clock.advanceTo(120);
  check(w.done && w.at === 120 && w.value?.length === 0, 'reject-only: silence = accepted, answered at the window end');
  checkEqual(ok.link.sentAt(1), 120, 'reject-only: the next request goes out at the window end — no drain');
  checkEqual(ok.warnings.length, 0, 'reject-only: silence is not a timeout — no warning');

  const foreign = rig();
  const f = foreign.request(REQ_WRITE, WRITE);
  foreign.link.emitAt(10, result(0x1f, 0x07));
  await foreign.clock.advanceTo(119);
  check(!f.done, 'reject-only: a foreign 0x64 neither matches nor quiet-completes the write');
  await foreign.clock.advanceTo(120);
  check(f.done && f.at === 120, 'reject-only: the write window still runs to its end');

  const refused = rig();
  const r = refused.request(REQ_WRITE, WRITE);
  refused.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  refused.link.emitAt(30, result(0x01, 0x05));
  await refused.clock.advanceTo(30);
  check(r.done && r.at === 30 && same(r.value?.[0], result(0x01, 0x05)), 'reject-only: its own refusal ends the write immediately');
  checkEqual(refused.link.sentAt(1), 30, 'reject-only: and frees the link immediately');

  // the same request WITHOUT rejectOnly would hold the link for the drain — the exemption is what saves it
  const plain = rig();
  plain.request(REQ_WRITE, { ...WRITE, rejectOnly: false });
  plain.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  await plain.clock.advanceTo(220);
  checkEqual(plain.link.sentAt(1), 220, 'reject-only: (contrast) a plain matched request drains max(quietMs, floor) = 100 ms');

  // A refusal carries only its function, so it goes to the request IN FLIGHT whenever it could be that
  // request's answer — back-to-back writes (clear-then-place a cell) must never lose their real refusal.
  checkEqual(SAME_TICK_MS, 2, 'refusals: only a refusal within 2 ms of a send is "too soon" to be its answer');
  // W1 accepted silently, W2 actually refused 10 ms after it went out → W2 is refused
  const e = rig();
  const w1 = e.request(REQ_WRITE, WRITE);
  const w2 = e.request(REQ_WRITE, WRITE);
  e.link.emitAt(130, result(0x01, 0x0b));
  await e.clock.advanceTo(400);
  check(w1.done && w1.at === 120 && w1.value?.length === 0, 'refusals: W1 was answered (accepted) at its window end');
  check(w2.done && w2.at === 130 && ownRefusal(w2.value ?? []), 'refusals: a refusal 10 ms into W2 refuses W2 (never hidden from the write in flight)');
  check(e.warnings.some((w) => /possibly the refusal of the write before it/.test(w)), `refusals: logged as POSSIBLY the earlier write's (${e.warnings.join(' | ')})`);
  // the same at 5 ms into W2 (the old misattribution case: maybe W1's late refusal) — still credited to W2
  const c = rig();
  c.request(REQ_WRITE, WRITE);
  const c2 = c.request(REQ_WRITE, WRITE);
  c.link.emitAt(125, result(0x01, 0x0b));
  await c.clock.advanceTo(400);
  check(c2.done && c2.at === 125 && ownRefusal(c2.value ?? []), 'refusals: 5 ms into W2 is still credited to W2 (it could be W2\'s answer)');

  // too soon: on the wire before W2 could have been answered → kept from W2 (it belongs to something earlier)
  for (const [dt, credited] of [[1, false], [2, false], [3, true]] as const) {
    const t = rig();
    t.request(REQ_WRITE, WRITE);
    const t2 = t.request(REQ_WRITE, WRITE);
    t.link.emitAt(120 + dt, result(0x01, 0x0b));
    await t.clock.advanceTo(400);
    check(
      credited ? t2.at === 120 + dt && ownRefusal(t2.value ?? []) : t2.at === 240 && !ownRefusal(t2.value ?? []) && t.warnings.some((w) => /too soon to be its answer/.test(w)),
      `refusals: a refusal ${dt} ms after W2 went out is ${credited ? 'credited to W2' : 'kept from W2 (too soon to be its answer)'}`
    );
  }

  // a READ after an accepted write is refused itself 30 ms in → the read gets it (and ends without a drain)
  const rr = rig();
  rr.request(REQ_WRITE, WRITE);
  const get = rr.request(REQ_GET, { timeoutMs: 800, quietMs: 50, match: isGetReply });
  rr.request(REQ_STATUS, { timeoutMs: 800, quietMs: 50, match: byFn(0x0d) });
  rr.link.emitAt(150, result(0x01, 0x07));
  await rr.clock.advanceTo(2000);
  check(get.done && get.at === 200 && get.value?.length === 1 && rr.link.sentAt(2) === 200, 'refusals: a refused read is answered one quiet gap after its refusal, next request right then (no drain)');

  // a refusal of ANOTHER function is never the in-flight request's
  const o = rig();
  o.request(REQ_WRITE, WRITE);
  const st = o.request(REQ_STATUS, { timeoutMs: 800, quietMs: 50, match: byFn(0x0d) });
  o.link.emitAt(150, result(0x01, 0x0b));
  o.link.emitAt(400, statusReply(3));
  await o.clock.advanceTo(400);
  check(st.done && st.at === 400 && same(st.value?.at(-1), statusReply(3)), 'refusals: a fn-0x01 refusal never ends a fn-0x0d request');

  // no "possibly" when the request before was not an accepted reject-only write
  const n = rig();
  n.request(REQ_STATUS, { timeoutMs: 800, quietMs: 50, match: byFn(0x0d) });
  n.link.emitAt(10, statusReply(1));
  const g2 = n.request(REQ_GET, { timeoutMs: 800, quietMs: 50, match: isGetReply });
  n.link.emitAt(40, result(0x01, 0x07));
  await n.clock.advanceTo(200);
  check(g2.done && !n.warnings.some((w) => /possibly/.test(w)), 'refusals: no "possibly" warning when the request before was not a reported-accepted write');

  // a reject-only write with an owned positive echo: accepted one quiet gap after the echo, no drain...
  const ECHO = sysex(0x01, [0x09, 0x00, 0x00, 0x41, 0x42, 0x00, 0x00, 0x00]);
  const echoed: RequestOpts = { ...WRITE, owns: (fr) => fr[5] === 0x01 && fr.length === ECHO.length };
  const ac = rig();
  const wa = ac.request(REQ_WRITE, echoed);
  ac.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: isGetReply });
  ac.link.emitAt(25, ECHO);
  await ac.clock.advanceTo(200);
  check(wa.done && wa.at === 85 && !ownRefusal(wa.value ?? []) && ac.link.sentAt(1) === 85 && ac.warnings.length === 0, 'reject-only: an owned echo ends the write as accepted one quiet gap later (85 ms), no drain, no warning');
  // ...but a refusal inside that gap is still this write's
  const rf = rig();
  const wr = rf.request(REQ_WRITE, echoed);
  rf.link.emitAt(25, ECHO);
  rf.link.emitAt(50, result(0x01, 0x0b));
  await rf.clock.advanceTo(200);
  check(wr.done && wr.at === 50 && ownRefusal(wr.value ?? []), 'reject-only: a refusal after the echo, inside the quiet gap, still refuses the write');
}

// ── 8. browser-direct convention + failures + defensive guards ───────────────────────────────────────────
async function silenceErrorAndFailures(): Promise<void> {
  const typed = (ms: number) => Object.assign(new Error(`request timed out after ${ms} ms`), { code: 'ETIMEDOUT' });
  const b = rig({ silenceError: typed });
  const m = b.request(REQ_STATUS, { timeoutMs: 100, quietMs: 30, match: byFn(0x0d) });
  const w = b.request(REQ_WRITE, { timeoutMs: 100, quietMs: 30, rejectOnly: true, match: ownRefusal });
  const u = b.request(REQ_GET, { timeoutMs: 100, quietMs: 30 });
  await b.clock.advanceTo(100);
  check(m.done && m.at === 100 && isTransportTimeout(m.error), 'silenceError: a silent matched request rejects with the typed timeout');
  await b.clock.advanceTo(200);
  checkEqual(b.link.sentAt(1), 200, 'silenceError: and still drains before the next request');
  await b.clock.advanceTo(300);
  check(w.done && w.at === 300 && w.error === undefined && w.value?.length === 0, 'silenceError: a reject-only write never rejects on silence');
  await b.clock.advanceTo(400);
  check(u.done && isTransportTimeout(u.error), 'silenceError: a silent unmatched request rejects too (browser convention)');
  const withFrames = b.request(REQ_STATUS, { timeoutMs: 100, quietMs: 30, match: byFn(0x0d) });
  b.link.emitAt(410, noise());
  await b.clock.advanceTo(500);
  check(withFrames.done && withFrames.error === undefined && withFrames.value?.length === 1, 'silenceError: a timeout WITH frames resolves them');

  // a silenceError that itself throws must not deadlock the queue
  const boom = rig({ silenceError: () => { throw new Error('boom'); } });
  const ba = boom.request(REQ_STATUS, { timeoutMs: 100, quietMs: 30, match: (fs) => fs.length > 5 });
  const bb = boom.request(REQ_GET, { timeoutMs: 100, quietMs: 30 });
  await boom.clock.advanceTo(2000);
  check(ba.done && (ba.error as Error)?.message === 'boom', 'guard: a throwing silenceError rejects the caller with its error');
  check(bb.done && boom.link.sentAt(1) === 200, 'guard: and the queue moves on (no deadlock)');

  const f = rig();
  f.link.failNextSend = new Error('port not open');
  const dead = f.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  f.request(REQ_STATUS, { timeoutMs: 500, quietMs: 50, match: byFn(0x0d) });
  await f.clock.advanceTo(0);
  check(dead.done && (dead.error as Error)?.message === 'port not open', 'send failure: the request rejects with the send error');
  checkEqual(f.link.sentAt(0), 0, 'send failure: the link is released at once');
  checkEqual(f.link.handlers.size, 1, 'send failure: its frame handler is unsubscribed (only the next request listens)');

  // a matcher / owns predicate that throws: the caller gets the error, the RX dispatch never sees it
  for (const which of ['match', 'owns'] as const) {
    const g = rig();
    const bad = () => { throw new Error(`bad ${which}`); };
    const opts: RequestOpts = which === 'match' ? { timeoutMs: 500, match: bad } : { timeoutMs: 500, match: () => false, owns: bad };
    const p = g.request(REQ_GET, opts);
    g.request(REQ_STATUS, { timeoutMs: 500, quietMs: 50, match: byFn(0x0d) });
    await g.clock.advanceTo(10);
    let escaped = false;
    try { g.link.emit(noise()); } catch { escaped = true; }
    await g.clock.advanceTo(10);
    check(!escaped && p.done && (p.error as Error)?.message === `bad ${which}`, `guard: a throwing ${which} rejects the request and never escapes into the RX loop`);
    checkEqual(g.link.sentAt(1), 10, `guard: a throwing ${which} frees the link at once`);
  }

  // subscribing fails: the request rejects, the link is free
  const sub = rig();
  sub.link.failSubscribe = new Error('no rx');
  const s1 = sub.request(REQ_GET, { timeoutMs: 500, match: byFn(0x01) });
  await sub.clock.advanceTo(0);
  sub.link.failSubscribe = null;
  sub.request(REQ_STATUS, { timeoutMs: 500, match: byFn(0x0d) });
  await sub.clock.advanceTo(0);
  check(s1.done && (s1.error as Error)?.message === 'no rx' && sub.link.sent.length === 1 && fnOf(sub.link.sent[0]!.bytes) === 0x0d, 'guard: a failing subscribe rejects the request and the next one still goes out');
}

// ── 9. the port closes mid-request ───────────────────────────────────────────────────────────────────────
async function closeMidRequest(): Promise<void> {
  const { clock, link, queue, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 300, quietMs: 50, match: byFn(0x01) });
  const s = track(clock, queue.sendQueued(REQ_WRITE));
  clock.at(100, () => { link.closed = true; });
  await clock.advanceTo(300);
  check(a.done && a.at === 300 && a.value?.length === 0, 'close: the in-flight request still ends at its timeout');
  await clock.advanceTo(400);
  check(b.done && b.at === 400 && (b.error as Error)?.message === 'port not open', 'close: the next request rejects as soon as it gets the link');
  check(s.done && (s.error as Error)?.message === 'port not open', 'close: a queued send rejects too — nothing waits forever');
  link.closed = false;
  const c = request(REQ_GET, { timeoutMs: 300, quietMs: 50, match: byFn(0x01) });
  await clock.advanceTo(400);
  check(!c.done && link.sent.length === 2 && link.sentAt(1) === 400, 'close: once the port is back the queue carries on');
}

// ── 10. fire-and-forget + paced sends share the queue ────────────────────────────────────────────────────
async function queuedSends(): Promise<void> {
  const { clock, link, queue, request } = rig();
  request(REQ_STATUS, { timeoutMs: 100, quietMs: 40, match: byFn(0x0d) });
  const q = track(clock, queue.sendQueued(REQ_WRITE, 20));
  const p = track(clock, queue.serialize(async () => { link.send(REQ_DUMP); return 7; }));
  await clock.advanceTo(199);
  checkEqual(link.sent.length, 1, 'sendQueued: waits behind a request that is still draining');
  await clock.advanceTo(200);
  checkEqual(link.sentAt(1), 200, 'sendQueued: goes out when the drain releases the link');
  await clock.advanceTo(219);
  check(!q.done && link.sent.length === 2, 'sendQueued: holds the link for its settle time');
  await clock.advanceTo(220);
  check(q.done && q.at === 220, 'sendQueued: resolves after the settle');
  check(p.done && p.value === 7 && link.sentAt(2) === 220, 'serialize: runs its task when the link is free and returns its value');
  const failed = track(clock, queue.serialize(async () => { throw new Error('paced write failed'); }));
  request(REQ_GET, { timeoutMs: 100, quietMs: 40 });
  await clock.advanceTo(220);
  check(failed.done && (failed.error as Error)?.message === 'paced write failed', 'serialize: a failing task rejects its caller');
  check(link.sentAt(3) === 220 && fnOf(link.sent[3]!.bytes) === 0x01, 'serialize: and releases the link to the next operation');

  // pacedWrite: chunks on the clock, then a settle
  const pc = new VirtualClock();
  const writes: [number, number, number][] = [];
  let open = true;
  const port = { isOpen: () => open, write: (s: number, e: number) => { writes.push([pc.t, s, e]); } };
  const whole = track(pc, pacedWrite(port, 200, 64, 3, 20, pc));
  await pc.advanceTo(100);
  check(whole.done && whole.at === 32 && writes.length === 4 && writes[3]![1] === 192 && writes[3]![2] === 200, `pacedWrite: 4 chunks 3 ms apart, then the 20 ms settle (done at ${whole.at})`);
  // the port closes mid-pump: reject, never hang
  writes.length = 0;
  const cut = track(pc, pacedWrite(port, 640, 64, 3, 20, pc));
  pc.at(pc.t + 7, () => { open = false; });
  await pc.advanceTo(pc.t + 100);
  check(cut.done && (cut.error as Error)?.message === 'port not open' && writes.length === 3, 'pacedWrite: a port closing mid-pump rejects the send');
  open = true;
  const thrown = track(pc, pacedWrite({ isOpen: () => true, write: () => { throw new Error('EIO'); } }, 640, 64, 3, 20, pc));
  await pc.advanceTo(pc.t + 10);
  check(thrown.done && (thrown.error as Error)?.message === 'EIO', 'pacedWrite: a write that throws rejects the send');
  // ... and the queue it ran on moves on
  const qr = rig();
  open = true;
  const paced = track(qr.clock, qr.queue.serialize(() => pacedWrite({ isOpen: () => open, write: () => { open = false; } }, 640, 64, 3, 20, qr.clock)));
  qr.request(REQ_GET, { timeoutMs: 100, quietMs: 40 });
  await qr.clock.advanceTo(10);
  check(paced.done && !!paced.error && qr.link.sentAt(0) === 3, 'pacedWrite: a failed paced send frees the queue for the next request');
}

// ── 11. warnings: per request kind, routine polls quiet ──────────────────────────────────────────────────
async function warnings(): Promise<void> {
  const { clock, link, warnings: log, request } = rig();
  request(REQ_GET, { timeoutMs: 100, quietMs: 50, match: isGetReply });
  request(REQ_RANGE, { timeoutMs: 100, quietMs: 50, match: byFn(0x02) });
  await clock.advanceTo(1000);
  check(log.some((w) => /fn=0x01\/0x01/.test(w)) && log.some((w) => /fn=0x01\/0x1a/.test(w)), 'warnings: two kinds of fn-0x01 request time out → two lines, not one');
  const before = log.length;
  request(REQ_GET, { timeoutMs: 100, quietMs: 50, match: isGetReply });
  await clock.advanceTo(2000);
  checkEqual(log.length, before, 'warnings: a repeat of the same kind within 10 s is coalesced');
  await clock.advanceTo(10_200);
  request(REQ_GET, { timeoutMs: 100, quietMs: 50, match: isGetReply });
  await clock.advanceTo(12_000);
  check(log.some((w) => /fn=0x01\/0x01/.test(w) && /\+1 more like it/.test(w)), 'warnings: the next report counts the coalesced ones');

  const r = rig();
  r.request(REQ_STATUS, { timeoutMs: 100, quietMs: 50, routine: true, match: byFn(0x0d) });
  await r.clock.advanceTo(300);
  checkEqual(r.warnings.length, 0, 'warnings: a routine poll\'s timeout is not logged');
  r.request(REQ_STATUS, { timeoutMs: 100, quietMs: 50, routine: true, match: byFn(0x0d) });
  r.link.emitAt(420, noise());
  await r.clock.advanceTo(800);
  check(r.warnings.length === 1 && /swallowed 1 late frame/.test(r.warnings[0]!), 'warnings: but frames its drain swallowed still are');
  void link;
}

export async function runRequestQueueTests(): Promise<void> {
  executed = 0;
  await lostReply();
  await lateReplyDuringNextRequest();
  await lateReplyInsideDrain();
  await unrelatedFrames();
  await refusalEndsMatchedRequest();
  await incompleteReplyDrains();
  await unmatchedUnchanged();
  await drainCap();
  await rejectOnlyWrite();
  await silenceErrorAndFailures();
  await closeMidRequest();
  await queuedSends();
  await warnings();
  assertEqual(executed, REQUEST_QUEUE_CASE_COUNT, 'request-queue: REQUEST_QUEUE_CASE_COUNT is in step with the executed checks');
}
