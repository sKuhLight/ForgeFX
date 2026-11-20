// The request queue shared by the serial and USB-MIDI transports (src/transport/requestQueue.ts): when a
// request is complete, and what happens to a reply that arrives after its request gave up. NO hardware: a fake
// link and a VIRTUAL clock, so the 250 ms drain cap and multi-second timeouts run instantly and to the ms.
//
// The failure this guards against: a request times out, its reply arrives late during the NEXT request, that
// request ends on the wrong frame, and its own reply then poisons the one after it.
import { RequestQueue, LATE_DRAIN_LIMITS, isResultEcho } from '../../src/transport/requestQueue.js';
import { isTransportTimeout, type RequestOpts } from '../../src/transport/types.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { VirtualClock, FakeLink, track } from '../helpers/virtualLink.js';

// One case = one executed check() (the suite verifies the count itself at the end).
export const REQUEST_QUEUE_CASE_COUNT = 87;
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
const REQ_POLL = sysex(0x1f, [0x25, 0x00]);
const REQ_DUMP = sysex(0x03, [0x7f, 0x7f]);
const REQ_WRITE = sysex(0x01, [0x09, 0x00, 0x00, 0x41, 0x42]);
const statusReply = (tag: number) => sysex(0x0d, [0x01, tag]);
const getReply = (tag: number) => sysex(0x01, [0x01, 0x00, 0x05, 0x00, 0x02, 0x00, tag]);
const noise = () => sysex(0x13, [0x3a, 0x00, 0x02]); // unsolicited status broadcast
const result = (echoedFn: number, code: number) => sysex(0x64, [echoedFn, code]);

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
  await clock.advanceTo(349);
  checkEqual(link.sent.length, 1, 'lost reply: still held inside the drain quiet window (min(quietMs, cap) = 50 ms)');
  await clock.advanceTo(350);
  checkEqual(link.sentAt(1), 350, 'lost reply: a silent drain releases the link after one quiet window');
  clock.at(360, () => link.emit(getReply(1)));
  await clock.advanceTo(400);
  check(b.done && b.at === 360 && same(b.value?.[0], getReply(1)), 'lost reply: the next request then completes normally on its own reply');
  checkEqual(warnings.length, 1, 'lost reply: a silent drain logs nothing more');
}

// ── 2. a late reply never completes the next request ─────────────────────────────────────────────────────
async function lateReplyDuringNextRequest(): Promise<void> {
  const { clock, link, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  const c = request(REQ_STATUS, { timeoutMs: 1000, quietMs: 50, match: byFn(0x0d) });
  await clock.advanceTo(350); // A timed out at 300, drained silently until 350 → B on the wire
  checkEqual(link.sentAt(1), 350, 'late reply: B is sent once A has drained');
  clock.at(370, () => link.emit(statusReply(0xaa))); // A's reply, late — B is in flight now
  await clock.advanceTo(469);
  check(!b.done, 'late reply: A\'s late reply neither completes B nor quiet-completes it (old code ended B at 420)');
  checkEqual(link.sent.length, 2, 'late reply: C is not sent while B still waits for its own reply');
  clock.at(500, () => link.emit(getReply(0xbb)));
  await clock.advanceTo(500);
  check(b.done && b.at === 500, `late reply: B completes on ITS reply (at ${b.at})`);
  check(same(b.value?.find((f) => fnOf(f) === 0x01), getReply(0xbb)), 'late reply: the reply B\'s caller picks is B\'s own');
  checkEqual(link.sentAt(2), 500, 'late reply: a matched request that got its reply releases the link at once (no drain)');
  clock.at(520, () => link.emit(statusReply(0xcc)));
  await clock.advanceTo(520);
  check(c.done && c.at === 520, 'late reply: C completes on its own reply');
  checkEqual(c.value?.length, 1, 'late reply: C saw only its own reply — B\'s reply did not poison it');
  check(same(c.value?.[0], statusReply(0xcc)), 'late reply: C got C\'s payload, not A\'s late one');
}

async function lateReplyInsideDrain(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const a = request(REQ_STATUS, { timeoutMs: 300, quietMs: 50, match: byFn(0x0d) });
  const b = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  clock.at(320, () => link.emit(statusReply(0xaa))); // A's reply 20 ms too late — inside the drain
  await clock.advanceTo(369);
  checkEqual(link.sent.length, 1, 'drain: a late frame re-arms the drain quiet window');
  check(a.done && a.value?.length === 0, 'drain: the late reply is not handed to the caller that already gave up');
  await clock.advanceTo(370);
  checkEqual(link.sentAt(1), 370, 'drain: link released one quiet window after the late frame');
  clock.at(380, () => link.emit(getReply(1)));
  await clock.advanceTo(380);
  checkEqual(b.value?.length, 1, 'drain: B never sees A\'s swallowed reply');
  check(warnings.some((w) => /swallowed 1 late frame\(s\) after the fn=0x0d timeout/.test(w)), `drain: a summary names the swallowed frame (${warnings.join(' | ')})`);
}

// ── 3. unrelated traffic during a matched request ────────────────────────────────────────────────────────
async function unrelatedFrames(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const r = request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  clock.at(10, () => link.emit(noise()));
  clock.at(20, () => link.emit(result(0x1f, 0x07))); // a refusal of ANOTHER function (a foreign 0x64)
  clock.at(100, () => link.emit(noise()));
  clock.at(200, () => link.emit(sysex(0x64, [0x01, 0x05], 0x10))); // fn-0x01 refusal, but another model byte
  clock.at(400, () => link.emit(getReply(7)));
  await clock.advanceTo(399);
  check(!r.done, 'unrelated: gaps of silence after unrelated frames do not end a matched request');
  await clock.advanceTo(400);
  check(r.done && r.at === 400, 'unrelated: it completes on its own reply');
  checkEqual(r.value?.length, 5, 'unrelated: unrelated frames are still collected (callers pick with their own predicate)');
  check(same(r.value?.[4], getReply(7)), 'unrelated: the reply is in the result');
  checkEqual(link.sentAt(0), 0, 'unrelated: sent at once');
  checkEqual(warnings.length, 0, 'unrelated: nothing to warn about');
}

async function refusalEndsMatchedRequest(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  // a bulk-read poll of an unplaced block: the device answers with a 0x64 echoing fn 0x1f instead of a burst
  const r = request(REQ_POLL, { timeoutMs: 2500, quietMs: 120, match: byFn(0x76) });
  const next = request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  clock.at(30, () => link.emit(result(0x1f, 0x07)));
  await clock.advanceTo(149);
  check(!r.done, 'refusal: the owned 0x64 arms the quiet gap (a real reply right behind it would still win)');
  await clock.advanceTo(150);
  check(r.done && r.at === 150, `refusal: a refused request ends one quiet gap after the refusal, not at the 2.5 s timeout (at ${r.at})`);
  check(same(r.value?.[0], result(0x1f, 0x07)), 'refusal: the refusal is handed to the caller');
  checkEqual(link.sentAt(1), 150, 'refusal: no drain after an answered request');
  checkEqual(warnings.length, 0, 'refusal: not a timeout, no warning');
  void next;
  check(isResultEcho(REQ_POLL, result(0x1f, 0x07)), 'isResultEcho: 0x64 echoing the request fn + model');
  check(!isResultEcho(REQ_POLL, result(0x01, 0x07)), 'isResultEcho: another fn is not this request\'s result');
  check(!isResultEcho(REQ_POLL, sysex(0x64, [0x1f, 0x07], 0x10)), 'isResultEcho: another model byte is not this device\'s result');
  check(!isResultEcho(REQ_POLL, [0xf0, 0x00, 0x01, 0x74, MODEL, 0x64, 0xf7]), 'isResultEcho: a 0x64 too short to echo a function is not attributed here');
}

async function ownedFramesArmQuiet(): Promise<void> {
  const { clock, link, request } = rig();
  const owns = (f: number[]) => f[5] === 0x77 || f[5] === 0x78;
  const r = request(REQ_DUMP, { timeoutMs: 5000, quietMs: 180, match: byFn(0x79), owns });
  clock.at(10, () => link.emit(sysex(0x77, [0x00])));
  clock.at(20, () => link.emit(sysex(0x78, [0x01])));
  clock.at(30, () => link.emit(noise())); // not owned: must not extend the window
  // the 0x79 terminator never arrives
  await clock.advanceTo(199);
  check(!r.done, 'owns: still waiting inside the quiet gap after the last owned frame');
  await clock.advanceTo(200);
  check(r.done && r.at === 200, `owns: a dump whose terminator is lost ends one quiet gap after its last chunk (at ${r.at})`);
  checkEqual(r.value?.length, 3, 'owns: every collected frame is handed over');

  // without `owns` the same dump waits for the hard timeout
  const s = rig();
  const t = s.request(REQ_DUMP, { timeoutMs: 5000, quietMs: 180, match: byFn(0x79) });
  s.clock.at(10, () => s.link.emit(sysex(0x77, [0x00])));
  s.clock.at(20, () => s.link.emit(sysex(0x78, [0x01])));
  await s.clock.advanceTo(4999);
  check(!t.done, 'owns: without it, chunks are not owned — no quiet completion');
  await s.clock.advanceTo(5000);
  check(t.done && t.at === 5000, 'owns: without it, the request ends at the timeout');
}

// ── 4. requests without a matcher: classic quiet-gap collection, unchanged ───────────────────────────────
async function unmatchedUnchanged(): Promise<void> {
  const { clock, link, warnings, request } = rig();
  const r = request(REQ_GET, { timeoutMs: 500, quietMs: 50 });
  clock.at(10, () => link.emit(noise()));
  clock.at(40, () => link.emit(getReply(1)));
  await clock.advanceTo(89);
  check(!r.done, 'unmatched: the quiet gap runs from the LAST frame');
  await clock.advanceTo(90);
  check(r.done && r.at === 90, `unmatched: ends quietMs after the last frame, any frame counts (at ${r.at})`);
  checkEqual(r.value?.length, 2, 'unmatched: every frame collected');

  const silent = request(REQ_STATUS, { timeoutMs: 500, quietMs: 50 });
  const after = request(REQ_GET, { timeoutMs: 500, quietMs: 50 });
  await clock.advanceTo(590);
  check(silent.done && silent.at === 590 && silent.value?.length === 0, 'unmatched: silence resolves [] at the timeout');
  checkEqual(link.sentAt(2), 590, 'unmatched: no drain — the next request goes out at the timeout');
  checkEqual(warnings.length, 0, 'unmatched: no timeout warning');
  void after;

  const chatty = rig();
  const c = chatty.request(REQ_GET, { timeoutMs: 300, quietMs: 50 });
  for (let at = 10; at < 1000; at += 20) chatty.clock.at(at, () => chatty.link.emit(noise()));
  await chatty.clock.advanceTo(300);
  check(c.done && c.at === 300, 'unmatched: the hard cap still ends a quiet gap that never comes');
}

// ── 5. the drain is bounded ──────────────────────────────────────────────────────────────────────────────
async function drainCap(): Promise<void> {
  checkEqual(LATE_DRAIN_LIMITS.maxMs, 250, 'drain cap: 250 ms by default');
  checkEqual(LATE_DRAIN_LIMITS.maxFrames, 32, 'drain cap: 32 frames by default');

  // a chatty device: a frame every 20 ms for a full second after the timeout — each would re-arm the quiet gap
  const time = rig();
  const a = time.request(REQ_STATUS, { timeoutMs: 100, quietMs: 50, match: byFn(0x0d) });
  time.request(REQ_GET, { timeoutMs: 1000, quietMs: 50, match: byFn(0x01) });
  for (let at = 110; at < 1200; at += 20) time.clock.at(at, () => time.link.emit(noise()));
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
  burst.clock.at(120, () => burst.link.emit(getReply(2)));
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
}

// ── 6. reject-only writes do not pay for the drain ───────────────────────────────────────────────────────
async function rejectOnlyWrite(): Promise<void> {
  const ownRefusal = (fs: number[][]) => fs.some((f) => isResultEcho(REQ_WRITE, f));
  const write: RequestOpts = { timeoutMs: 120, quietMs: 60, rejectOnly: true, match: ownRefusal };

  const ok = rig();
  const w = ok.request(REQ_WRITE, write);
  ok.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  await ok.clock.advanceTo(120);
  check(w.done && w.at === 120 && w.value?.length === 0, 'reject-only: silence = accepted, answered at the window end');
  checkEqual(ok.link.sentAt(1), 120, 'reject-only: the next request goes out at the window end — no drain');
  checkEqual(ok.warnings.length, 0, 'reject-only: silence is not a timeout — no warning');

  const foreign = rig();
  const f = foreign.request(REQ_WRITE, write);
  foreign.clock.at(10, () => foreign.link.emit(result(0x1f, 0x07)));
  await foreign.clock.advanceTo(119);
  check(!f.done, 'reject-only: a foreign 0x64 neither matches nor quiet-completes the write');
  await foreign.clock.advanceTo(120);
  check(f.done && f.at === 120, 'reject-only: the write window still runs to its end');

  const refused = rig();
  const r = refused.request(REQ_WRITE, write);
  refused.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  refused.clock.at(30, () => refused.link.emit(result(0x01, 0x05)));
  await refused.clock.advanceTo(30);
  check(r.done && r.at === 30 && same(r.value?.[0], result(0x01, 0x05)), 'reject-only: its own refusal ends the write immediately');
  checkEqual(refused.link.sentAt(1), 30, 'reject-only: and frees the link immediately');

  // the same request WITHOUT rejectOnly would hold the link for the drain — the exemption is what saves it
  const plain = rig();
  plain.request(REQ_WRITE, { ...write, rejectOnly: false });
  plain.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  await plain.clock.advanceTo(180);
  checkEqual(plain.link.sentAt(1), 180, 'reject-only: (contrast) a plain matched request drains min(quietMs, cap) = 60 ms');
}

// ── 7. browser-direct convention + failures ──────────────────────────────────────────────────────────────
async function silenceErrorAndFailures(): Promise<void> {
  const typed = (ms: number) => Object.assign(new Error(`request timed out after ${ms} ms`), { code: 'ETIMEDOUT' });
  const b = rig({ silenceError: typed });
  const m = b.request(REQ_STATUS, { timeoutMs: 100, quietMs: 30, match: byFn(0x0d) });
  const w = b.request(REQ_WRITE, { timeoutMs: 100, quietMs: 30, rejectOnly: true, match: (fs) => fs.some((f) => isResultEcho(REQ_WRITE, f)) });
  const u = b.request(REQ_GET, { timeoutMs: 100, quietMs: 30 });
  await b.clock.advanceTo(100);
  check(m.done && m.at === 100 && isTransportTimeout(m.error), 'silenceError: a silent matched request rejects with the typed timeout');
  await b.clock.advanceTo(130);
  checkEqual(b.link.sentAt(1), 130, 'silenceError: and still drains before the next request');
  await b.clock.advanceTo(230);
  check(w.done && w.at === 230 && w.error === undefined && w.value?.length === 0, 'silenceError: a reject-only write never rejects on silence');
  await b.clock.advanceTo(330);
  check(u.done && isTransportTimeout(u.error), 'silenceError: a silent unmatched request rejects too (browser convention)');
  const withFrames = b.request(REQ_STATUS, { timeoutMs: 100, quietMs: 30, match: byFn(0x0d) });
  b.clock.at(340, () => b.link.emit(noise()));
  await b.clock.advanceTo(430);
  check(withFrames.done && withFrames.error === undefined && withFrames.value?.length === 1, 'silenceError: a timeout WITH frames resolves them');

  const f = rig();
  f.link.failNextSend = new Error('port not open');
  const dead = f.request(REQ_GET, { timeoutMs: 500, quietMs: 50, match: byFn(0x01) });
  const after = f.request(REQ_STATUS, { timeoutMs: 500, quietMs: 50, match: byFn(0x0d) });
  await f.clock.advanceTo(0);
  check(dead.done && (dead.error as Error)?.message === 'port not open', 'send failure: the request rejects with the send error');
  checkEqual(f.link.sentAt(0), 0, 'send failure: the link is released at once');
  checkEqual(f.link.handlers.size, 1, 'send failure: its frame handler is unsubscribed (only the next request listens)');
  void after;
}

// ── 8. fire-and-forget + paced sends share the queue ─────────────────────────────────────────────────────
async function queuedSends(): Promise<void> {
  const { clock, link, queue, request } = rig();
  request(REQ_STATUS, { timeoutMs: 100, quietMs: 40, match: byFn(0x0d) });
  const q = track(clock, queue.sendQueued(REQ_WRITE, 20));
  const p = track(clock, queue.serialize(async () => { link.send(REQ_DUMP); return 7; }));
  await clock.advanceTo(139);
  checkEqual(link.sent.length, 1, 'sendQueued: waits behind a request that is still draining');
  await clock.advanceTo(140);
  checkEqual(link.sentAt(1), 140, 'sendQueued: goes out when the drain releases the link');
  await clock.advanceTo(159);
  check(!q.done && link.sent.length === 2, 'sendQueued: holds the link for its settle time');
  await clock.advanceTo(160);
  check(q.done && q.at === 160, 'sendQueued: resolves after the settle');
  check(p.done && p.value === 7 && link.sentAt(2) === 160, 'serialize: runs its task when the link is free and returns its value');
  const failed = track(clock, queue.serialize(async () => { throw new Error('paced write failed'); }));
  const next = request(REQ_GET, { timeoutMs: 100, quietMs: 40 });
  await clock.advanceTo(160);
  check(failed.done && (failed.error as Error)?.message === 'paced write failed', 'serialize: a failing task rejects its caller');
  checkEqual(link.sentAt(3), 160, 'serialize: and releases the link');
  void next;
  check(fnOf(link.sent[3]!.bytes) === 0x01, 'serialize: the next operation is the one queued after it');
}

export async function runRequestQueueTests(): Promise<void> {
  executed = 0;
  await lostReply();
  await lateReplyDuringNextRequest();
  await lateReplyInsideDrain();
  await unrelatedFrames();
  await refusalEndsMatchedRequest();
  await ownedFramesArmQuiet();
  await unmatchedUnchanged();
  await drainCap();
  await rejectOnlyWrite();
  await silenceErrorAndFailures();
  await queuedSends();
  assertEqual(executed, REQUEST_QUEUE_CASE_COUNT, 'request-queue: REQUEST_QUEUE_CASE_COUNT is in step with the executed checks');
}
