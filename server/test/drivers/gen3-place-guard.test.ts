// Gen-3 placeCell refuses a block that is already in the grid. Mocked transport, NO hardware.
//
// Hardware finding (FM3 fw 13): PUT /preset/grid/cell with a blockId that is ALREADY placed elsewhere makes
// the driver send cell-select (sub 0x30) + insert (sub 0x32); the device echoes the insert and silently
// ignores it (no 0x64 refusal), so the write reported ok:true although nothing changed. The driver now reads
// the grid first (its cached/coalesced read path) and answers a 409 — with nothing written — instead.
//
//   A  the REAL gen-3 driver over a MockTransport serving the bundled FM3 dump:
//        - duplicate elsewhere → 409 with the cell in the message; ZERO placement frames, no `changed` event
//        - a hit read from the cache is confirmed by one fresh dump first (a stale read must never refuse a
//          move whose source was just cleared, nor skip a placement as "already there")
//        - valid placement unchanged (select + insert, ok:true, grid cache dropped, `changed` emitted)
//        - same block onto its own cell → ok:true no-op, nothing written; clear (blockId 0) never reads the grid
//        - move flow (Axis: clear the source, then place at the destination) is allowed
//        - an unreadable grid (first read, or the confirming read) keeps today's behaviour: the placement goes out
//        - shunts (routing cells, may repeat) are never guarded AND never start a read (real grid path, zero dump
//          requests); bad coordinates / instances fail before any read
//        - slow link (5-pin DIN): the guard never starts a read (fresh or confirming) — it uses only a cached or
//          in-flight read taken after the last write, and is skipped (today's behaviour) otherwise; a read that
//          predates a move's clear is ignored so the move is not refused; fast link keeps the read
//        - the same guard on the Axe-Fx III and FM9 dumps
//   B  the same real driver end to end through app.inject AND the browser-facing router: 409 / 200 / 400 bodies
//      are identical on both surfaces.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createGen3Driver, type Gen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES } from '../../src/devices.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import type { DeviceEvent, PresetGridDTO } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, dumpAnswering } from '../helpers/mock.js';

// One case = one executed ok()/eq() in this suite (the run asserts it matches; keep in step when adding).
export const GEN3_PLACE_GUARD_CASE_COUNT = 112;

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/preset-convert/${name}`, import.meta.url)));
const FM3_DUMP = framesOf(new Uint8Array(fixture('fm3-preset-5.syx')));
const FM9_DUMP = framesOf(new Uint8Array(fixture('fm9-devs-gift-of-tone.syx')));
const III_DUMP = framesOf(new Uint8Array(fixture('axe3-devs-gift-of-tone.syx')));
const CHUNKS = 8; // an FM3 preset dump carries 8 chunk frames
const SHUNT_ID = 1024; // routing/shunt cells are effect ids >= 1024 on gen-3

let cases = 0;
function ok(cond: unknown, msg: string): asserts cond {
  cases++;
  if (!cond) throw new Error(msg);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  cases++;
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

/** Split a flat .syx byte stream into F0..F7 frames. */
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { frames.push(cur); cur = null; }
    }
  }
  return frames;
}

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** An all-zero (unused-slot style) FM3 dump: decodes to a grid with no cells. */
function emptyDump(): number[][] {
  const frames: number[][] = [sysex(0x11, 0x77, [0x7f, 0x00, 0x00, 0x40, 0x00])];
  for (let i = 0; i < CHUNKS; i++) frames.push(sysex(0x11, 0x78, [0x00, 0x08, ...new Array<number>(3072).fill(0)]));
  frames.push(sysex(0x11, 0x79, [0x00, 0x00, 0x00]));
  return frames;
}

const eidFor = (slug: string): number => {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page; // instance 1 effect id
};

const compact = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
/** Cell-select (sub 0x30) / insert (sub 0x32) frames — what a placement writes (fn 0x01). */
const placementFrames = (m: MockTransport) => m.sent.filter((f) => f[5] === 0x01 && (f[6] === 0x30 || f[6] === 0x32));
/** Preset-dump READ requests (fn 0x03). */
const dumpRequests = (m: MockTransport) => m.sent.filter((f) => f[5] === 0x03);

interface Rig { driver: Gen3Driver; mock: MockTransport; events: DeviceEvent[]; codec: ReturnType<typeof createModernFractalCodec>; rows: number }

function rig(model: number, serve: number[][] | null): Rig {
  const prof = PROFILES[model]!;
  const mock = new MockTransport('serial', `mock-place-guard-0x${model.toString(16)}`);
  mock.isOpen = true;
  if (serve) mock.reply = (req) => (req[5] === 0x03 ? dumpAnswering(req, serve) : []);
  const events: DeviceEvent[] = [];
  const driver = createGen3Driver(prof, { transport: async () => mock, emit: (e) => { events.push(e); }, getCadence: () => cadenceFor(null, 'balanced') });
  return { driver, mock, events, codec: createModernFractalCodec(model), rows: prof.rows };
}

/** The grid cache window is a static on the driver class: widen it so a cached read cannot expire mid-case
 *  (runGen3PlaceGuardTests restores it). */
const ttlOf = (d: Gen3Driver) => d.constructor as unknown as { GRID_TTL_MS: number };
const holdCache = (d: Gen3Driver) => { ttlOf(d).GRID_TTL_MS = 60_000; };

/** A link that reports itself slow (a generic 5-pin DIN interface) — `Transport.slow`, the flag the dump windows use. */
function slowLink(r: Rig): Rig {
  Object.defineProperty(r.mock, 'slow', { value: true });
  return r;
}
/** A gate a scripted reply can wait on, to hold a dump read in flight. */
function defer(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  return { promise, open };
}

/** Fail (instead of hanging the runner) when `p` waits on a read that is never going to be released. */
function within<T>(p: Promise<T>, what: string, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting: ${what}`)), ms))]);
}

interface Rejected { statusCode?: number; message: string }
async function rejection(p: Promise<unknown>): Promise<Rejected | null> {
  try { await p; return null; } catch (e) { return { statusCode: (e as { statusCode?: number }).statusCode, message: (e as Error).message }; }
}

async function driverCases(): Promise<void> {
  // ── A1: the FM3 fixture — duplicate, confirm, valid, same-cell, clear ──
  const r = rig(0x11, FM3_DUMP);
  const g = await r.driver.grid();
  const amp = g.cells.find((c) => c.name === 'Amp 1')!;
  eq(amp.effectId, eidFor('amp'), 'fixture sanity: Amp 1 sits under the roster amp effect id');
  eq(`${amp.row},${amp.col}`, '1,4', 'fixture sanity: Amp 1 at 0-indexed row 1 col 4 (= row 2 col 5 for the 1-indexed API)');
  const flanger = eidFor('flanger');
  ok(!g.cells.some((c) => c.effectId === flanger), 'fixture sanity: no Flanger 1 in the grid');
  holdCache(r.driver);
  const primed = dumpRequests(r.mock).length; // 1: the sanity read above
  eq(primed, 1, 'one dump read so far');

  // duplicate elsewhere: the grid() above is still cached → the hit is confirmed with ONE fresh dump
  const dup = await rejection(r.driver.placeCell(1, 1, amp.effectId));
  eq(dup?.statusCode, 409, 'duplicate placement → statusCode 409');
  eq(dup?.message, 'Amp 1 is already placed at row 2 col 5 — move it instead', 'duplicate message names the block and its 1-indexed cell');
  eq(placementFrames(r.mock).length, 0, 'duplicate: no select/insert frame was sent');
  eq(r.mock.sent.filter((f) => f[5] !== 0x03).length, 0, 'duplicate: nothing but dump READ requests went out');
  eq(dumpRequests(r.mock).length, primed + 1, 'duplicate: a cached hit is confirmed by exactly one fresh dump');
  ok(!r.events.some((e) => e.type === 'changed'), 'duplicate: no `changed` event');

  // the confirming read refreshed the cache: a second duplicate is confirmed again (still reading, never writing)
  const dup2 = await rejection(r.driver.placeCell(2, 2, amp.effectId));
  eq(dup2?.statusCode, 409, 'second duplicate (other target cell) → 409');
  eq(placementFrames(r.mock).length, 0, 'second duplicate: still nothing written');

  // valid placement of a block that is not in the grid: exactly select + insert, as before
  const sentBefore = r.mock.sent.length;
  const dumpsBefore = dumpRequests(r.mock).length;
  const placed = await r.driver.placeCell(1, 1, flanger);
  eq(placed.ok, true, 'valid placement → ok:true');
  const wrote = r.mock.sent.slice(sentBefore);
  eq(wrote.length, 2, 'valid placement writes exactly two frames (a negative on the cached grid needs no read)');
  eq(compact(wrote[0]!), compact(r.codec.buildClearBlock({ row: 1, col: 1, rows: r.rows })), 'valid placement: cell-select frame first');
  eq(compact(wrote[1]!), compact(r.codec.buildSetGridCell({ row: 1, col: 1, blockId: flanger, rows: r.rows })), 'valid placement: insert frame second');
  eq(dumpRequests(r.mock).length, dumpsBefore, 'valid placement on a warm cache adds no dump read');
  ok(r.events.some((e) => e.type === 'changed' && e.scope === 'grid'), 'valid placement emits changed{grid}');
  await r.driver.grid();
  eq(dumpRequests(r.mock).length, dumpsBefore + 1, 'valid placement dropped the grid cache (the next grid() reads the device)');

  // the same block onto the cell it already occupies: a no-op, nothing written, nothing announced
  const eventsBefore = r.events.length;
  const sentBeforeSame = placementFrames(r.mock).length;
  const same = await r.driver.placeCell(2, 5, amp.effectId);
  eq(same.ok, true, 'same-cell placement → ok:true');
  eq(placementFrames(r.mock).length, sentBeforeSame, 'same-cell placement writes nothing');
  eq(r.events.length, eventsBefore, 'same-cell placement emits no event');

  // clearing never consults the grid (blockId 0 is not a block) and still sends select + insert-0
  const dumpsBeforeClear = dumpRequests(r.mock).length;
  const sentBeforeClear = r.mock.sent.length;
  const cleared = await r.driver.placeCell(2, 5, 0);
  eq(cleared.ok, true, 'clear → ok:true');
  eq(dumpRequests(r.mock).length, dumpsBeforeClear, 'clear reads no dump');
  const clr = r.mock.sent.slice(sentBeforeClear);
  eq(clr.length, 2, 'clear writes select + insert-0');
  eq(compact(clr[1]!), compact(r.codec.buildSetGridCell({ row: 2, col: 5, blockId: 0, rows: r.rows })), 'clear: insert-0 frame');

  // ── A2: Axis MOVE flow = clear the source, then place at the destination ──
  // The device now reports the amp gone (its dump is empty). A cached grid still lists the amp; so does an
  // in-flight read that predates the clear — the confirming read must let the placement through.
  const m = rig(0x11, FM3_DUMP);
  await m.driver.grid(); // cache: amp present at row 2 col 5
  holdCache(m.driver);
  m.mock.reply = (req) => (req[5] === 0x03 ? dumpAnswering(req, emptyDump()) : []);
  const stale = await m.driver.placeCell(1, 1, amp.effectId); // cache says "amp at r2c5" — device says empty
  eq(stale.ok, true, 'stale cached hit: a fresh read finds the block gone → the placement proceeds');
  eq(placementFrames(m.mock).length, 2, 'stale cached hit: select + insert were sent');
  ok(dumpRequests(m.mock).length >= 2, 'stale cached hit was confirmed against the device');

  // the real sequence, cold cache: clear source → place destination
  const mv = rig(0x11, FM3_DUMP);
  await mv.driver.grid();
  mv.mock.reply = (req) => (req[5] === 0x03 ? dumpAnswering(req, emptyDump()) : []);
  const c1 = await mv.driver.placeCell(2, 5, 0); // clearCell(source) → drops the cache
  const sentMove = placementFrames(mv.mock).length;
  const c2 = await mv.driver.placeCell(1, 1, amp.effectId); // placeCell(destination)
  eq(c1.ok && c2.ok, true, 'move (clear source, place destination) → both ok');
  eq(placementFrames(mv.mock).length - sentMove, 2, 'move: the destination placement wrote select + insert');
  // same-cell stale no-op must not swallow a placement either: cache says "already at r2c5", device says gone
  const re = rig(0x11, FM3_DUMP);
  await re.driver.grid();
  holdCache(re.driver);
  re.mock.reply = (req) => (req[5] === 0x03 ? dumpAnswering(req, emptyDump()) : []);
  const redo = await re.driver.placeCell(2, 5, amp.effectId); // e.g. undo of a remove, with a pre-clear read cached
  eq(redo.ok, true, 'stale same-cell hit → ok');
  eq(placementFrames(re.mock).length, 2, 'stale same-cell hit: the block is really placed (not skipped as "already there")');

  // ── A3: an unreadable grid never blocks a placement (today's behaviour) ──
  {
    const dead = rig(0x11, null); // silent device: every dump read fails
    const fb = await dead.driver.placeCell(1, 1, amp.effectId);
    eq(fb.ok, true, 'unreadable grid: the placement still goes out');
    eq(placementFrames(dead.mock).length, 2, 'unreadable grid: select + insert were sent');
    eq(compact(placementFrames(dead.mock)[1]!), compact(dead.codec.buildSetGridCell({ row: 1, col: 1, blockId: amp.effectId, rows: dead.rows })), 'unreadable grid: the insert is the unchanged frame');
    ok(dumpRequests(dead.mock).length >= 1, 'unreadable grid: the read was attempted');

    // the FIRST read succeeded (block present elsewhere) but the confirming read fails → also today's behaviour
    const flaky = rig(0x11, FM3_DUMP);
    await flaky.driver.grid();
    holdCache(flaky.driver);
    flaky.mock.reply = () => []; // the device goes silent
    const fb2 = await flaky.driver.placeCell(1, 1, amp.effectId);
    eq(fb2.ok, true, 'failed confirming read: the placement still goes out');
    eq(placementFrames(flaky.mock).length, 2, 'failed confirming read: select + insert were sent');
  }

  // ── A4: shunts repeat freely and never cost a read; bad input fails before any read ──
  // The REAL grid path (no stub): a shunt placement must not start a dump read at all, warm cache or cold.
  const sh = rig(0x11, FM3_DUMP);
  let gridCalls = 0;
  const realGrid = sh.driver.grid.bind(sh.driver);
  (sh.driver as unknown as { grid: () => Promise<PresetGridDTO> }).grid = () => { gridCalls++; return realGrid(); };
  const shunt1 = await sh.driver.placeCell(1, 4, SHUNT_ID);
  const shunt2 = await sh.driver.placeCell(1, 5, SHUNT_ID); // the same shunt id again: shunts repeat
  const shunt3 = await sh.driver.placeCell(2, 4, SHUNT_ID + 1);
  eq(shunt1.ok && shunt2.ok && shunt3.ok, true, 'shunt placements → ok:true');
  eq(placementFrames(sh.mock).length, 6, 'shunt placements: select + insert each');
  eq(dumpRequests(sh.mock).length, 0, 'shunt placements start NO dump read (cold cache)');
  eq(gridCalls, 0, 'shunt placements never consult grid()');
  await realGrid(); // warm the cache; a shunt placement still must not read or consult it
  const dumpsWarm = dumpRequests(sh.mock).length;
  await sh.driver.placeCell(3, 4, SHUNT_ID);
  eq(dumpRequests(sh.mock).length, dumpsWarm, 'shunt placement with a warm cache: no further read');
  eq(gridCalls, 0, 'shunt placement with a warm cache never consults grid()');

  const bad = rig(0x11, FM3_DUMP);
  const badRow = await rejection(bad.driver.placeCell(0, 1, amp.effectId));
  ok(badRow !== null && /row out of range/.test(badRow.message), `bad row throws the codec's range error (${badRow?.message})`);
  eq(bad.mock.sent.length, 0, 'bad row: nothing at all was sent (no read, no write)');
  const inst = await rejection(bad.driver.placeCell(1, 1, amp.effectId + 1)); // Amp 2: the FM3 has one amp
  eq(inst?.statusCode, 400, 'a block instance the unit lacks is still a 400');
  eq(bad.mock.sent.length, 0, 'missing instance: nothing was sent');

  // ── A6: slow link (5-pin DIN): the guard never starts a read — only an existing, post-write one counts ──
  // fast link first: a cold-cache block placement does exactly one dump read, then writes
  const fast = rig(0x11, FM3_DUMP);
  await fast.driver.placeCell(1, 1, flanger);
  eq(dumpRequests(fast.mock).length, 1, 'fast link, cold cache: the guard reads the grid once');
  eq(placementFrames(fast.mock).length, 2, 'fast link, cold cache: select + insert follow');

  // slow, cold cache: no read of any kind — the placement goes out exactly as before the guard existed,
  // even for a block that IS already in the grid (the device ignores it; that is today's behaviour)
  const s1 = slowLink(rig(0x11, FM3_DUMP));
  const s1r = await s1.driver.placeCell(1, 1, amp.effectId);
  eq(s1r.ok, true, 'slow link, no read to use: the placement goes out (guard skipped)');
  eq(dumpRequests(s1.mock).length, 0, 'slow link, no read to use: NO dump request (no fresh read, no confirm read)');
  eq(placementFrames(s1.mock).length, 2, 'slow link, no read to use: select + insert were sent');

  // slow, a fresh cached read exists: it is used as is — refusal, no-op and valid placement — without any further read
  const s2 = slowLink(rig(0x11, FM3_DUMP));
  await s2.driver.grid();
  holdCache(s2.driver);
  const s2dumps = dumpRequests(s2.mock).length;
  const s2dup = await rejection(s2.driver.placeCell(1, 1, amp.effectId));
  eq(s2dup?.statusCode, 409, 'slow link, cached read: duplicate → 409');
  eq(s2dup?.message, 'Amp 1 is already placed at row 2 col 5 — move it instead', 'slow link, cached read: same message');
  eq(placementFrames(s2.mock).length, 0, 'slow link, cached read: duplicate wrote nothing');
  eq(dumpRequests(s2.mock).length, s2dumps, 'slow link, cached read: no confirm read');
  const s2same = await s2.driver.placeCell(2, 5, amp.effectId);
  eq(s2same.ok, true, 'slow link, cached read: same-cell → ok:true no-op');
  eq(placementFrames(s2.mock).length, 0, 'slow link, cached read: same-cell wrote nothing');
  await s2.driver.placeCell(1, 1, flanger);
  eq(placementFrames(s2.mock).length, 2, 'slow link, cached read: a valid placement is written');
  eq(dumpRequests(s2.mock).length, s2dumps, 'slow link, cached read: the valid placement read nothing either');

  // slow, the cached read is gone (the write above dropped it): back to "no read to use" — no fresh read
  const s2after = await s2.driver.placeCell(1, 2, amp.effectId);
  eq(s2after.ok, true, 'slow link, after a write dropped the cache: the placement goes out (guard skipped)');
  eq(dumpRequests(s2.mock).length, s2dumps, 'slow link, after a write dropped the cache: still no dump request');
  eq(placementFrames(s2.mock).length, 4, 'slow link, after a write dropped the cache: select + insert were sent');

  // slow, a read IN FLIGHT that started after the last write is awaited and used (no second read)
  const gate = defer();
  const s3 = slowLink(rig(0x11, null));
  s3.mock.reply = (req) => (req[5] === 0x03 ? gate.promise.then(() => dumpAnswering(req, FM3_DUMP)) : []);
  const inflight = s3.driver.grid(); // GET /preset/grid in progress
  const s3dup = rejection(s3.driver.placeCell(1, 1, amp.effectId));
  gate.open();
  await inflight;
  const s3res = await s3dup;
  eq(s3res?.statusCode, 409, 'slow link, in-flight read: duplicate → 409 from that read');
  eq(dumpRequests(s3.mock).length, 1, 'slow link, in-flight read: the guard started no read of its own');
  eq(placementFrames(s3.mock).length, 0, 'slow link, in-flight read: nothing written');

  // slow, a read in flight that started BEFORE a write is out of date (a move: its clear lands while it runs)
  const gate2 = defer();
  const s4 = slowLink(rig(0x11, null));
  holdCache(s4.driver);
  s4.mock.reply = (req) => (req[5] === 0x03 ? gate2.promise.then(() => dumpAnswering(req, FM3_DUMP)) : []);
  const stale4 = s4.driver.grid(); // reads the pre-clear grid (amp at row 2 col 5)
  await s4.driver.placeCell(2, 5, 0); // the move's clear: invalidates the grid
  const s4r = await within(s4.driver.placeCell(1, 1, amp.effectId), 'the move must not wait on a read that predates its clear'); // the move's place: the pre-clear read must not refuse it
  eq(s4r.ok, true, 'slow link, pre-clear in-flight read: the move is NOT refused');
  eq(placementFrames(s4.mock).length, 4, 'slow link, pre-clear in-flight read: clear and place were both written');
  gate2.open();
  await stale4;
  eq(dumpRequests(s4.mock).length, 1, 'slow link, pre-clear in-flight read: the guard read nothing itself');
  // that stale read has now settled into the cache (still inside its window) — it predates the clear, so it is not used either
  const s4late = await s4.driver.placeCell(1, 2, amp.effectId);
  eq(s4late.ok, true, 'slow link, cache filled by a pre-clear read: the placement is not refused by it');
  eq(placementFrames(s4.mock).length, 6, 'slow link, cache filled by a pre-clear read: select + insert were sent');
  eq(dumpRequests(s4.mock).length, 1, 'slow link, cache filled by a pre-clear read: still no read of its own');

  // slow, a write lands WHILE the guard waits on an in-flight read: that read is out of date by the time it settles
  const gate3 = defer();
  const s5 = slowLink(rig(0x11, null));
  s5.mock.reply = (req) => (req[5] === 0x03 ? gate3.promise.then(() => dumpAnswering(req, FM3_DUMP)) : []);
  const reading = s5.driver.grid();
  const waiting = rejection(s5.driver.placeCell(1, 1, amp.effectId)); // the guard is now awaiting that read
  await s5.driver.cable(2, 5, 2, true); // a grid-changing write completes meanwhile
  gate3.open();
  await reading;
  eq(await waiting, null, 'slow link, a write landed while waiting: the settled (now stale) read does not refuse the placement');
  eq(placementFrames(s5.mock).length, 2, 'slow link, a write landed while waiting: the placement was written');

  // ── A5: the same guard on the Axe-Fx III and the FM9 ──
  for (const [model, dump, label] of [[0x10, III_DUMP, 'Axe-Fx III'], [0x12, FM9_DUMP, 'FM9']] as const) {
    const x = rig(model, dump);
    const grid = await x.driver.grid();
    const blk = grid.cells.find((c) => !c.isShunt && c.effectId && c.effectId <= 0x3fff)!;
    ok(!!blk, `${label}: fixture has a placed block`);
    const target = blk.col + 2 <= 14 ? { row: blk.row + 1, col: blk.col + 2 } : { row: blk.row + 1, col: 1 }; // 1-indexed, another cell
    const refused = await rejection(x.driver.placeCell(target.row, target.col, blk.effectId));
    eq(refused?.statusCode, 409, `${label}: duplicate placement → 409`);
    ok(refused!.message.startsWith(`${blk.name} is already placed at row ${blk.row + 1} col ${blk.col + 1}`), `${label}: message names the block and its cell (${refused?.message})`);
    eq(placementFrames(x.mock).length, 0, `${label}: nothing written`);
    const stay = await x.driver.placeCell(blk.row + 1, blk.col + 1, blk.effectId);
    eq(stay.ok, true, `${label}: same-cell placement → ok:true no-op`);
    eq(placementFrames(x.mock).length, 0, `${label}: same-cell placement writes nothing`);
  }
}

// ── B: end to end through the Fastify app AND the browser-facing router ──
async function surfaceCases(): Promise<void> {
  const t = await buildTestApp(0x11);
  t.mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : req[5] === 0x03 ? dumpAnswering(req, FM3_DUMP) : []);
  const router = createRouter({ registry: t.registry, store: store.defaultStore });
  const amp = eidFor('amp');
  const flanger = eidFor('flanger');
  const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** One PUT /preset/grid/cell on both surfaces: same status, same JSON body. */
  const put = async (name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await t.app.inject({ method: 'PUT', url: '/preset/grid/cell', payload: body });
    const routed = await router.handle('PUT', '/preset/grid/cell', JSON.stringify(body));
    eq(routed.status, res.statusCode, `${name}: router/app status parity (app body ${res.payload})`);
    const appJson = JSON.parse(res.payload) as Record<string, unknown>;
    const routerJson = JSON.parse(String(routed.body)) as Record<string, unknown>;
    ok(deepEq(appJson, routerJson), `${name}: router/app body parity\napp:    ${res.payload}\nrouter: ${String(routed.body)}`);
    return { status: res.statusCode, json: appJson };
  };

  try {
    const before = placementFrames(t.mock).length;
    const dup = await put('duplicate', { row: 1, col: 1, blockId: amp });
    eq(dup.status, 409, 'PUT /preset/grid/cell of a placed block → 409 (app and router)');
    eq(dup.json.error, 'Conflict', '409 envelope names the status');
    eq(dup.json.message, 'Amp 1 is already placed at row 2 col 5 — move it instead', '409 message (app and router)');
    eq(placementFrames(t.mock).length, before, 'duplicate over HTTP: no placement frame went out on either surface');

    const same = await put('same cell', { row: 2, col: 5, blockId: amp });
    eq(same.status, 200, 'same-cell placement → 200');
    ok(deepEq(same.json, { ok: true }), 'same-cell placement body is {ok:true}');
    eq(placementFrames(t.mock).length, before, 'same-cell placement over HTTP wrote nothing');

    const valid = await put('valid', { row: 1, col: 1, blockId: flanger });
    eq(valid.status, 200, 'valid placement → 200');
    ok(deepEq(valid.json, { ok: true }), 'valid placement body is {ok:true}');
    eq(placementFrames(t.mock).length - before, 4, 'valid placement: select + insert on each of the two surfaces');

    const clear = await put('clear', { row: 2, col: 5, blockId: 0 });
    eq(clear.status, 200, 'clear → 200');
    eq(placementFrames(t.mock).length - before, 8, 'clear: select + insert on each of the two surfaces');

    const missing = await put('missing instance', { row: 1, col: 1, blockId: amp + 1 });
    eq(missing.status, 400, 'a block instance the unit lacks → 400 on BOTH surfaces (the router no longer flattens it to 500)');
    eq(placementFrames(t.mock).length - before, 8, 'missing instance wrote nothing');
  } finally { await t.app.close(); }
}

export async function runGen3PlaceGuardTests(): Promise<void> {
  const ttl = ttlOf(rig(0x11, null).driver);
  const saved = ttl.GRID_TTL_MS;
  const realLog = console.log;
  console.log = () => {}; // the dump decode / incomplete-dump retry / detect paths log; keep the suite output clean
  cases = 0;
  try {
    await driverCases();
    ttl.GRID_TTL_MS = saved; // the end-to-end cases use the production cache window
    await surfaceCases();
  } finally {
    ttl.GRID_TTL_MS = saved;
    console.log = realLog;
  }
  if (cases !== GEN3_PLACE_GUARD_CASE_COUNT) throw new Error(`gen3-place-guard ran ${cases} cases, expected ${GEN3_PLACE_GUARD_CASE_COUNT} — update GEN3_PLACE_GUARD_CASE_COUNT`);
}
