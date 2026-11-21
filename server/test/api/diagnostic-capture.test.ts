// Diagnostic capture (services/diagnosticCapture.ts) — mocked transport, synthetic frames only, NO hardware.
// A fake FM3 answers the handshake, the firmware read, the current-preset name query, self-describe
// definition / label / value queries, preset dumps (synthetic raw patches) and the SysEx preset switch, and
// hands every reply to the onFrame handlers like a real transport does (so the wire log records RX).
// Covers each step's happy path, the label probe's stop-at-first-silence + Global-last order, the dump
// header numbers, the reload probe's unsaved-edits skip, the stored profile staying untouched, a bundle on
// cancel / device silence / a thrown error / the query-bound watchdog, redaction with counts, the 409s
// against the cache build both ways, the 400/501/503 gates, the upload (gzip, size limit, 401, 429, cloud
// errors, axisVersion) and the telemetry hold while a capture runs.
import { gunzipSync } from 'node:zlib';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import * as diag from '../../src/services/diagnosticCapture.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import * as store from '../../src/store.js';
import { buildDefQuery, CACHE_SCHEMA, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE, type CacheRecord, type LiveTransport, type LiveWalkOptions } from 'forgefx-midi/cache';
import type { RequestOpts } from '../../src/transport/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';
import { fakeCacheDoc, seedRecords } from './device-cache.test.js';

export const DIAGNOSTIC_CAPTURE_CASE_COUNT = 18;

const FM3 = 0x11;
const NAME = 'Secret Name';
const NAME_HEX = Buffer.from('Secret').toString('hex');

// ── synthetic frames ──

const cs = (f: readonly number[]) => f.reduce((a, b) => a ^ b, 0) & 0x7f;
const msg = (fn: number, payload: readonly number[]): number[] => {
  const body = [0xf0, 0x00, 0x01, 0x74, FM3, fn, ...payload];
  return [...body, cs(body), 0xf7];
};

/** Continuous MSB-first septet stream of `raw` (the inverse of the codec's decodeSeptetStream). */
function septets(raw: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    n += 8;
    while (n >= 7) { n -= 7; out.push((acc >> n) & 0x7f); }
    acc &= (1 << n) - 1;
  }
  if (n > 0) out.push((acc << (7 - n)) & 0x7f);
  return out;
}

/** A self-describe reply echoing view / block-high / param; `raw` null = a no-payload reply. */
function sdReply(view: number, block: number, param: number, raw: Uint8Array | null): number[] {
  const inner = new Array<number>(15).fill(0);
  inner[0] = view; inner[2] = 0x01; inner[3] = (block >> 7) & 0x7f; inner[4] = param & 0x7f; inner[5] = (param >> 7) & 0x7f;
  inner[6] = raw ? 0x3a : 0x40;
  inner[13] = raw ? raw.length : 0;
  return msg(0x01, [...inner, ...(raw ? septets(raw) : [])]);
}

function defRaw(d: { tc: number; min: number; max: number; scale?: number; def?: number; step?: number; id?: number }): Uint8Array {
  const b = new Uint8Array(36);
  const v = new DataView(b.buffer);
  v.setUint32(0, d.id ?? 7, true); v.setUint32(4, d.tc, true);
  v.setFloat32(8, d.min, true); v.setFloat32(12, d.max, true); v.setFloat32(16, d.scale ?? 0, true);
  v.setFloat32(20, d.def ?? 0, true); v.setFloat32(24, d.step ?? 0, true);
  return b;
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A one-chunk synthetic raw patch (2048 bytes): a name and a 4-byte body behind a tiny Huffman stream. */
function rawPatch(name: string, variant = 0): Uint8Array {
  const raw = new Uint8Array(2048);
  for (let i = 0; i < name.length; i++) raw[0x08 + i] = name.charCodeAt(i);
  raw[0x48] = 4; raw[0x4a] = 3; // decomp 4, comp 3
  // tree: internal(0) → leaf(1)'A', leaf(1)'B'; then 4 symbols
  const sym = variant === 0 ? [0, 1, 0, 1] : [1, 1, 0, 0];
  const bits = [0, 1, ...[0, 1, 0, 0, 0, 0, 0, 1], 1, ...[0, 1, 0, 0, 0, 0, 1, 0], ...sym, 0];
  for (let i = 0; i < 3; i++) raw[0x4c + i] = bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0);
  return raw;
}
function encode16to3(raw: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const v = (raw[i]! | (raw[i + 1]! << 8)) & 0xffff;
    out.push(v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x7f);
  }
  return out;
}
function dumpFrames(header: number, raw: Uint8Array): number[][] {
  return [
    msg(0x77, [(header >> 7) & 0x7f, header & 0x7f, 0, 0, 0]),
    msg(0x78, [0, 0, ...encode16to3(raw)]),
    msg(0x79, [0, 0, 0])
  ];
}

// ── the fake FM3 ──

interface FakeState {
  fw: [number, number] | null;
  current: number;
  slots: Map<number, Uint8Array>;
  editBuffer: Uint8Array | null; // null = the current slot's patch
  /** Blocks whose hinted params answer a definition that fits the hint (others: a no-payload reply). */
  fitBlocks: Set<number>;
  /** A label query that gets no answer. */
  silentLabel?: { block: number; param: number };
  /** Header number override per requested dump number. */
  headerFor?: (requested: number) => number;
  /** Everything goes unanswered. */
  silent: boolean;
  switches: number[];
}

class FakeFm3 extends MockTransport {
  constructor(readonly state: FakeState) {
    super('serial', 'COM7');
    this.reply = (req) => this.#answer(req);
  }
  override async request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]> {
    const r = await super.request(bytes, opts);
    for (const f of r) this.emitFrame(f); // a real transport hands every inbound frame to onFrame too
    return r;
  }
  #answer(req: readonly number[]): number[][] {
    const s = this.state;
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (s.silent) return [];
    const fn = req[5];
    if (fn === 0x08) return s.fw ? [msg(0x08, [s.fw[0], s.fw[1], 0, 0])] : [];
    if (fn === 0x0d) return [msg(0x0d, [s.current & 0x7f, (s.current >> 7) & 0x7f, ...Array.from(NAME.padEnd(32, ' '), (c) => c.charCodeAt(0))])];
    if (fn === 0x03) {
      const requested = ((req[6]! & 0x7f) << 7) | (req[7]! & 0x7f);
      const raw = requested === 0x3fff ? (s.editBuffer ?? s.slots.get(s.current) ?? new Uint8Array(2048)) : (s.slots.get(requested) ?? new Uint8Array(2048));
      const header = s.headerFor?.(requested) ?? (requested === 0x3fff ? 0x3f80 : requested);
      return dumpFrames(header, raw);
    }
    if (fn === 0x01 && req[6] === 0x27) { // SysEx preset switch
      const n = (req[12]! & 0x7f) | ((req[13]! & 0x7f) << 7);
      s.switches.push(n);
      s.current = n;
      s.editBuffer = null;
      return [];
    }
    if (fn === 0x01 && (req[6] === VIEW_DEFINITION || req[6] === VIEW_ENUM_LABEL || req[6] === VIEW_VALUE)) {
      const view = req[6]!;
      const block = (req[8]! & 0x7f) | ((req[9]! & 0x7f) << 7);
      const param = (req[10]! & 0x7f) | ((req[11]! & 0x7f) << 7);
      const live = diag.livenessAddress(FM3);
      if (view === VIEW_DEFINITION) {
        const hint = HINTS[block]?.[param];
        if (hint && s.fitBlocks.has(block)) return [sdReply(view, block, param, defRaw({ tc: hint.typecode, min: 0, max: hint.count - 1 }))];
        if (block === live.block && param === live.param) return [sdReply(view, block, param, defRaw({ tc: 1, min: 0, max: 10, def: 1 }))];
        return [sdReply(view, block, param, null)];
      }
      if (view === VIEW_ENUM_LABEL) {
        if (s.silentLabel && s.silentLabel.block === block && s.silentLabel.param === param) return [];
        return [sdReply(view, block, param, ascii('LBL'))];
      }
      return [sdReply(view, block, param, ascii('5.00'))];
    }
    return [];
  }
}

const HINTS = deviceCache.walkEnumHints(FM3);

function fakeState(over: Partial<FakeState> = {}): FakeState {
  return {
    fw: [13, 0], current: 12,
    slots: new Map([[0, rawPatch('P0')], [12, rawPatch('Current')], [128, rawPatch('P128')], [127, rawPatch('P127')], [508, rawPatch('P508')]]),
    editBuffer: null, fitBlocks: new Set(), silent: false, switches: [],
    ...over
  };
}

async function makeRig(state = fakeState()) {
  const mock = new FakeFm3(state);
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  await registry.detect();
  return { registry, mock, state };
}

const QUICK: diag.CaptureOptions = { pacing: { interQueryMs: 0, blockPauseMs: 0 }, versions: { forgefx: '9.9.9-test' } };
const seedWalk = async (): Promise<CacheRecord[]> => seedRecords();
/** A walk that never returns until the run's signal aborts it. */
const blockingWalk = (_t: LiveTransport, o: LiveWalkOptions): Promise<CacheRecord[]> =>
  new Promise((_res, rej) => { o.signal?.addEventListener('abort', () => rej(new Error('live walk aborted'))); });

async function run(registry: DeviceRegistry, body: Record<string, unknown>, opts: diag.CaptureOptions = {}): Promise<diag.CaptureBundle> {
  const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true, ...body }, { ...QUICK, ...opts });
  assertEqual(r.code, 202, `capture starts (${JSON.stringify(r.body)})`);
  await diag.capturePromise(registry);
  const res = diag.captureResult(registry);
  assertEqual(res.code, 200, 'a result is available after the run');
  return res.body as diag.CaptureBundle;
}
const stepOf = (b: diag.CaptureBundle, name: diag.StepName) => b.steps.find((s) => s.name === name)!;
const hexOf = (f: readonly number[] | Uint8Array) => Array.from(f, (b) => b.toString(16).padStart(2, '0')).join('');
const isQueryOf = (f: readonly number[], view: number, block: number, param: number) =>
  f[5] === 0x01 && f[6] === view && ((f[8]! | (f[9]! << 7)) === block) && ((f[10]! | (f[11]! << 7)) === param);

// ── 1. info + read-only walk, stored profile untouched ──
async function infoAndReadonlyWalk(): Promise<void> {
  const { registry } = await makeRig();
  const KEY = '11_13p0';
  const doc = { ...fakeCacheDoc(), firmware: '13.0', meta: { schema: CACHE_SCHEMA, recordCount: 2, builtAt: '2026-01-01T00:00:00.000Z', source: 'live' } };
  store.defaultStore.putDoc('deviceCaches', KEY, doc);
  const before = JSON.stringify(store.defaultStore.getDoc('deviceCaches', KEY));
  const profileBefore = registry.profile;
  let seen: LiveWalkOptions | null = null;
  try {
    const b = await run(registry, { steps: ['info', 'readonlyWalk'] }, { walkImpl: async (_t, o) => { seen = o; return seedRecords(); } });
    assertEqual(b.schema, 1, 'bundle schema 1');
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.id), `bundle id is path-safe (${b.id})`);
    assertEqual(b.state, 'done', 'run done');
    assertEqual(b.device.model, FM3, 'device model');
    assertEqual(b.device.firmware, '13.0', 'device firmware (fresh read)');
    assertEqual(b.device.transport, 'serial', 'transport kind');
    assertEqual(b.app.forgefx, '9.9.9-test', 'forgefx version from the host');
    assert(typeof b.app.codec === 'string' && b.app.codec.length > 0, 'codec version stamped');
    const info = stepOf(b, 'info');
    assertEqual(info.status, 'ok', 'info ok');
    const ir = info.result as { presetNumber: number; firmware: string; transport: string; modelName: string };
    assertEqual(ir.presetNumber, 12, 'info: current preset number');
    assertEqual(ir.firmware, '13.0', 'info: firmware');
    assertEqual(ir.modelName, 'FM3', 'info: model name');
    const walk = stepOf(b, 'readonlyWalk');
    assertEqual(walk.status, 'ok', 'read-only walk ok');
    assert(seen != null, 'the walk ran');
    const o = seen as LiveWalkOptions;
    assertEqual(o.mode, undefined, 'read-only walk: no mode');
    assertEqual(o.write, undefined, 'read-only walk: no write hooks');
    assertEqual(o.interQueryMs, 3, 'same pacing as a build');
    assertEqual(o.blockPauseMs, 150, 'same block breather as a build');
    assertEqual(o.maxParamId, 127, 'same 7-bit envelope as a build');
    assertEqual(o.paramBoundByBlock?.[58], 127, 'same per-block bounds as a build');
    assert(o.enumHintByBlock !== undefined, 'FM3 13.0: the walk gets the label hints, as a build would');
    const wr = walk.result as { profile: { recordCount: number; schema: number } };
    assertEqual(wr.profile.recordCount, seedRecords().length, 'the derived profile summary is in the result');
    assertEqual(wr.profile.schema, CACHE_SCHEMA, 'profile summary schema');
    // the user's stored profile is untouched, and nothing was applied
    assertEqual(JSON.stringify(store.defaultStore.getDoc('deviceCaches', KEY)), before, 'stored profile byte-identical after the capture');
    assert(registry.profile === profileBefore, 'runtime profile not swapped');
    store.defaultStore.delDoc('deviceCaches', KEY);
    await run(registry, { steps: ['readonlyWalk'] }, { walkImpl: seedWalk });
    const after = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(after == null || after.deleted, 'no profile is created by a capture');
    // frames: TX + RX with ms timestamps
    assert(b.frames.some((f) => f.dir === 'TX') && b.frames.some((f) => f.dir === 'RX'), 'wire log has TX and RX');
    assert(b.frames.every((f, i) => typeof f.t === 'number' && f.t >= 0 && (i === 0 || f.t >= b.frames[i - 1]!.t)), 'frame times are ms since start, monotonic');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
  }
}

// ── 2. label probe: Global last, liveness after each label, bounds respected ──
async function labelProbeHappy(): Promise<void> {
  const { registry, mock } = await makeRig(fakeState({ fitBlocks: new Set([66, 1]) }));
  const start = mock.sent.length;
  const b = await run(registry, { steps: ['labelProbe'] });
  const step = stepOf(b, 'labelProbe');
  assertEqual(step.status, 'ok', 'label probe ok');
  const r = step.result as { counts: Record<string, number>; entries: { block: number; param: number; fit: string; labelReply?: string; label?: string; expected: { count: number; typecode: number }; got?: { typecode: number; max: number } }[]; hintsVerifiedOnFirmware: boolean; liveness: { block: number; param: number } };
  const bound = (blk: number) => deviceCache.walkBlockLimits(FM3, 'read-only').bound[blk] ?? 127;
  const inBound = (blk: number) => Object.keys(HINTS[blk] ?? {}).map(Number).filter((p) => p <= bound(blk)).length;
  const expectedLabels = inBound(66) + inBound(1);
  assertEqual(r.counts.labels, expectedLabels, 'one label query per fitting hint of the answering blocks');
  assert((r.counts.beyondBound ?? 0) > 0, 'GLOBAL far ids are counted as beyond the walk bound, never probed');
  assertEqual(r.hintsVerifiedOnFirmware, true, 'FM3 13.0 is a verified firmware (recorded)');
  const labelled = r.entries.filter((e) => e.labelReply === 'label');
  assert(labelled.every((e) => e.label === 'LBL' && e.fit === 'exact'), 'labels recorded with their fit');
  assert(labelled.every((e) => e.got!.typecode === e.expected.typecode && e.got!.max === e.expected.count - 1), 'expected vs got recorded');
  // Global (block 1) entries come last
  const firstGlobal = r.entries.findIndex((e) => e.block === 1);
  assert(firstGlobal > 0 && r.entries.slice(firstGlobal).every((e) => e.block === 1), 'the Global block is probed last');
  // on the wire: each label query (sub = min = 0) is followed by the liveness definition query
  const sent = mock.sent.slice(start);
  const live = r.liveness;
  let labels = 0;
  for (let i = 0; i < sent.length; i++) {
    const f = sent[i]!;
    if (f[5] !== 0x01 || f[6] !== VIEW_ENUM_LABEL) continue;
    labels++;
    assertEqual((f[12]! | (f[13]! << 7)), 0, 'label query at sub = min');
    assert(isQueryOf(sent[i + 1]!, VIEW_DEFINITION, live.block, live.param), `label query ${labels} is followed by a liveness definition query`);
  }
  assertEqual(labels, expectedLabels, 'label queries on the wire');
  for (const f of sent) {
    if (f[5] !== 0x01) continue;
    const blk = f[8]! | (f[9]! << 7);
    const p = f[10]! | (f[11]! << 7);
    assert(p <= bound(blk), `no probe query above the walk bound (block ${blk} param ${p})`);
  }
  const lastLabel = [...sent].reverse().find((f) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL)!;
  assertEqual(lastLabel[8], 1, 'the last label query goes to the Global block');
}

// ── 3. label probe stops at the first missing reply; the run carries on while the device answers ──
async function labelProbeStops(): Promise<void> {
  const params66 = Object.keys(HINTS[66]!).map(Number).sort((a, b) => a - b);
  const stopAt = params66[1]!;
  const { registry, mock } = await makeRig(fakeState({ fitBlocks: new Set([66, 1]), silentLabel: { block: 66, param: stopAt } }));
  const start = mock.sent.length;
  const b = await run(registry, { steps: ['labelProbe', 'dumpHeaderProbe'] });
  const step = stepOf(b, 'labelProbe');
  assertEqual(step.status, 'failed', 'label probe failed at the silent label');
  const r = step.result as { stoppedAt: { block: number; param: number; query: string }; counts: { labels: number } };
  assertEqual(r.stoppedAt.block, 66, 'stopped at block 66');
  assertEqual(r.stoppedAt.param, stopAt, 'stopped at the silent param');
  assertEqual(r.stoppedAt.query, 'label', 'stopped on the label query');
  assertEqual(r.counts.labels, 1, 'only the labels before the silence');
  const sent = mock.sent.slice(start);
  assert(!sent.some((f) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL && f[8] === 1), 'the Global block was never label-probed after the stop');
  assert(/no reply to the label query/.test(step.error ?? ''), 'error names the missing reply');
  assertEqual(stepOf(b, 'dumpHeaderProbe').status, 'ok', 'device still answers → the next step ran');
  assertEqual(b.state, 'done', 'run done (one step failed)');
}

// ── 4. dump header probe: named numbers per request, unused slots, payloads cut ──
async function dumpHeaderProbe(): Promise<void> {
  const { registry } = await makeRig(fakeState({ headerFor: (n) => (n === 127 ? 126 : n === 0x3fff ? 0x3f80 : n) }));
  const b = await run(registry, { steps: ['dumpHeaderProbe'] });
  const step = stepOf(b, 'dumpHeaderProbe');
  assertEqual(step.status, 'ok', 'dump header probe ok');
  const r = step.result as { requests: { target: number | string; purpose: string; header: number | null; names: string; complete: boolean; empty: boolean | null }[]; emptySlots: number[] };
  const byTarget = (t: number | string) => r.requests.find((x) => x.target === t)!;
  assertEqual(byTarget(0).header, 0, 'slot 0 header named');
  assertEqual(byTarget(0).names, 'request', 'slot 0 names the request');
  assertEqual(byTarget(0).empty, false, 'slot 0 is a populated preset');
  assertEqual(byTarget(127).header, 126, 'slot 127: the header number the device named is recorded');
  assertEqual(byTarget(127).names, 'other', 'slot 127: names another number');
  assertEqual(byTarget(128).names, 'request', 'slot 128 (>= 128) names the request');
  assertEqual(byTarget(511).empty, true, 'the last slot is unused');
  assertEqual(byTarget('edit-buffer').header, 0x3f80, 'edit buffer header recorded');
  assertEqual(byTarget('edit-buffer').names, 'edit-buffer', 'edit buffer header classified');
  assertEqual(r.requests.filter((x) => x.purpose === 'empty-search').filter((x) => x.empty).length, 3, 'up to three extra unused slots');
  assert(r.emptySlots.includes(511) && r.emptySlots.length === 4, `unused slots recorded (${r.emptySlots.join(',')})`);
  assert(!r.requests.some((x) => x.target === 508 && x.purpose === 'empty-search' && x.empty), 'populated slot not counted as unused');
  // no dump payload kept: chunk + footer frames cut to 8 bytes with their length, headers whole
  const chunks = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '78');
  const footers = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '79');
  const headers = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '77');
  assert(chunks.length === r.requests.length && chunks.every((f) => f.hex.length === 16 && f.len === 3082), 'chunk frames: 8-byte prefix + length');
  assert(footers.every((f) => f.hex.length === 16 && f.len === 11), 'footer frames: prefix + length');
  assert(headers.every((f) => f.hex.length === 26 && f.len === undefined), 'dump headers kept whole');
  assertEqual(b.redaction.dumpPayloadFrames, chunks.length + footers.length, 'redaction counts the cut dump frames');
  assert(!JSON.stringify(b).includes(hexOf(ascii('P128'))), 'no preset content in the bundle');
}

// ── 5. reload probe: clean → switch + verify; unsaved edits → skipped, nothing switched ──
async function reloadProbe(): Promise<void> {
  {
    const { registry, state } = await makeRig();
    const b = await run(registry, { steps: ['reloadProbe'] });
    const step = stepOf(b, 'reloadProbe');
    assertEqual(step.status, 'ok', 'reload probe ok on a clean edit buffer');
    const r = step.result as { preset: number; editBuffer: string; match: string; verified: boolean; switch: { ok: boolean; ms: number }; totalMs: number };
    assertEqual(r.editBuffer, 'clean', 'edit buffer equals its slot');
    assertEqual(r.match, 'raw', 'identical raw patch');
    assertEqual(r.verified, true, 'preset number verified after the switch');
    assertEqual(state.switches.join(','), '12', 'switched to the CURRENT preset by SysEx');
    assert(typeof r.switch.ms === 'number' && typeof r.totalMs === 'number', 'timing recorded');
  }
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1) }));
    const b = await run(registry, { steps: ['reloadProbe'] });
    const step = stepOf(b, 'reloadProbe');
    assertEqual(step.status, 'skipped', 'unsaved edits → skipped');
    assertEqual(step.note, 'unsaved edits', 'skip note');
    assertEqual((step.result as { editBuffer: string }).editBuffer, 'dirty', 'edit buffer differs from its slot');
    assertEqual(state.switches.length, 0, 'no preset switch was sent');
  }
  {
    // an undecodable edit buffer (unknown state) is not clean either
    const { registry, state } = await makeRig(fakeState({ fw: [13, 0], current: 300 }));
    state.slots.set(300, new Uint8Array(2048).fill(1)); // not a valid patch → unknown
    state.editBuffer = state.slots.get(300)!;
    const b = await run(registry, { steps: ['reloadProbe'] });
    assertEqual(stepOf(b, 'reloadProbe').status, 'skipped', 'unknown edit buffer → skipped');
    assertEqual(state.switches.length, 0, 'no switch when unknown');
  }
}

// ── 6. full walk: gated (opt-in, capability, verified firmware) ──
async function fullWalkGate(): Promise<void> {
  {
    const { registry } = await makeRig(fakeState({ fw: [14, 0] }));
    let walks = 0;
    const b = await run(registry, { steps: ['info'], includeFullWalk: true }, { walkImpl: async () => { walks++; return seedRecords(); } });
    const fw = stepOf(b, 'fullWalk');
    assertEqual(fw.status, 'skipped', 'full walk skipped on an unverified firmware');
    assert(/not verified on firmware 14\.0/.test(fw.note ?? ''), `skip note names the firmware (${fw.note})`);
    assertEqual(walks, 0, 'no full walk ran');
  }
  {
    const { registry } = await makeRig(fakeState({ fw: [13, 0] }));
    const b = await run(registry, { steps: ['info', 'fullWalk'] });
    assertEqual(stepOf(b, 'fullWalk').note, 'includeFullWalk not set', 'fullWalk without includeFullWalk is skipped');
  }
  {
    const { registry } = await makeRig(fakeState({ fw: [13, 0] }));
    let mode: string | undefined;
    const b = await run(registry, { steps: [], includeFullWalk: true }, { walkImpl: async (_t, o) => { mode = o.mode; return seedRecords(); } });
    assertEqual(stepOf(b, 'fullWalk').status, 'ok', 'full walk runs on FM3 13.0 with a clean edit buffer');
    assertEqual(mode, 'full', 'the walk ran in full mode');
  }
}

// ── 7. bundle on cancel ──
async function bundleOnCancel(): Promise<void> {
  const { registry } = await makeRig();
  const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true }, { ...QUICK, walkImpl: blockingWalk });
  assertEqual(r.code, 202, 'started');
  await sleep(30);
  const st = diag.captureStatus(registry);
  assertEqual(st.state, 'running', 'status running');
  assertEqual(st.steps!.find((s) => s.name === 'readonlyWalk')!.status, 'running', 'walk step running');
  assertEqual(diag.cancelCapture(registry).ok, true, 'cancel ok');
  assertEqual(diag.cancelCapture(registry).ok, true, 'cancel idempotent');
  await diag.capturePromise(registry);
  const b = diag.captureResult(registry).body as diag.CaptureBundle;
  assertEqual(b.state, 'cancelled', 'bundle state cancelled');
  assertEqual(b.abortReason, 'cancelled', 'abort reason cancelled');
  assertEqual(stepOf(b, 'info').status, 'ok', 'finished step kept');
  assertEqual(stepOf(b, 'readonlyWalk').status, 'aborted', 'running step aborted');
  assertEqual(stepOf(b, 'labelProbe').status, 'skipped', 'later steps skipped');
  assert(b.frames.length > 0, 'frames up to the cancel kept');
  const st2 = diag.captureStatus(registry);
  assertEqual(st2.state, 'cancelled', 'status cancelled');
  assertEqual(st2.resultAvailable, true, 'result available');
}

// ── 8. bundle when the device goes silent (liveness check after a failed step) ──
async function bundleOnSilence(): Promise<void> {
  const { registry, state } = await makeRig();
  const b = await run(registry, {}, { walkImpl: async () => { state.silent = true; throw new Error('device stopped answering'); } });
  assertEqual(b.state, 'failed', 'run failed');
  assertEqual(b.abortReason, 'device-silent', 'abort reason device-silent');
  assertEqual(stepOf(b, 'readonlyWalk').status, 'failed', 'the failing step');
  assertEqual(stepOf(b, 'readonlyWalk').error, 'device stopped answering', 'its error');
  assertEqual(stepOf(b, 'labelProbe').status, 'skipped', 'no further step after a silent liveness check');
  assertEqual(stepOf(b, 'info').status, 'ok', 'earlier results kept');
}

// ── 9. silence watchdog: no RX for the window while a step runs ──
async function silenceWatchdog(): Promise<void> {
  const { registry } = await makeRig();
  const b = await run(registry, { steps: ['readonlyWalk', 'labelProbe'] }, { walkImpl: blockingWalk, silenceMs: 60, watchdogTickMs: 10 });
  assertEqual(b.abortReason, 'device-silent', 'watchdog aborts on silence');
  assertEqual(stepOf(b, 'readonlyWalk').status, 'aborted', 'the waiting step aborted');
  assertEqual(b.state, 'failed', 'state failed');
}

// ── 10. a thrown error mid-step: recorded, the run continues ──
async function bundleOnError(): Promise<void> {
  const { registry } = await makeRig();
  const b = await run(registry, { steps: ['info', 'readonlyWalk', 'dumpHeaderProbe'] }, { walkImpl: async () => { throw new Error('boom in the walk'); } });
  assertEqual(stepOf(b, 'readonlyWalk').status, 'failed', 'walk failed');
  assertEqual(stepOf(b, 'readonlyWalk').error, 'boom in the walk', 'error recorded');
  assertEqual(stepOf(b, 'dumpHeaderProbe').status, 'ok', 'device alive → next step ran');
  assertEqual(b.state, 'done', 'run done');
  assert(b.logs.some((l) => l.level === 'warn' && /readonlyWalk: failed/.test(l.msg)), 'job log carries the failure');
}

// ── 11. query-bound watchdog: a query above the walk bound is never sent ──
async function queryBound(): Promise<void> {
  const { registry, mock } = await makeRig();
  const far = buildDefQuery(FM3, 70, 200);
  const b = await run(registry, { steps: ['readonlyWalk', 'labelProbe'] }, {
    walkImpl: async (t) => { await t.request(buildDefQuery(FM3, 70, 3)); await t.request(far); return seedRecords(); }
  });
  assertEqual(b.abortReason, 'query-bound', 'abort reason query-bound');
  assertEqual(stepOf(b, 'readonlyWalk').status, 'aborted', 'walk aborted');
  assertEqual(stepOf(b, 'labelProbe').status, 'skipped', 'rest skipped');
  assert(!mock.sent.some((f) => hexOf(f) === hexOf(far)), 'the far query never reached the wire');
  assert(mock.sent.some((f) => isQueryOf(f, VIEW_DEFINITION, 70, 3)), 'in-bound queries pass');
}

// ── 12. redaction ──
async function redaction(): Promise<void> {
  const nameReply = msg(0x0d, [12, 0, ...Array.from(NAME.padEnd(32, ' '), (c) => c.charCodeAt(0))]);
  const r = diag.redactFrame(nameReply);
  assertEqual(r.kind, 'name', 'preset name reply redacted');
  assertEqual(r.bytes.length, nameReply.length, 'length kept');
  assertEqual(hexOf(r.bytes.slice(0, 8)), hexOf(nameReply.slice(0, 8)), 'header + preset number kept');
  assert(r.bytes.slice(8, -2).every((x) => x === 0x20), 'name bytes blanked');
  assertEqual(r.bytes[r.bytes.length - 2], cs(r.bytes.slice(0, -2)), 'checksum recomputed');
  const scene = diag.redactFrame(msg(0x0e, [2, ...ascii('Chorus Lead'.padEnd(32, ' '))]));
  assert(scene.kind === 'name' && scene.bytes.slice(7, -2).every((x) => x === 0x20), 'scene name reply redacted');
  const rename = diag.redactFrame(msg(0x01, [0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, ...new Array(37).fill(0x41)]));
  assert(rename.kind === 'name' && rename.bytes.slice(21, -2).every((x) => x === 0x20), 'preset rename write redacted');
  assertEqual(diag.redactFrame(msg(0x0d, [0x7f, 0x7f])).kind, undefined, 'the name QUERY is kept');
  const chunk = msg(0x78, new Array(100).fill(5));
  const c = diag.redactFrame(chunk);
  assert(c.kind === 'dump' && c.bytes.length === 8 && c.len === chunk.length, 'dump chunk cut to 8 bytes + length');
  assertEqual(diag.redactFrame(msg(0x77, [0, 5, 0, 0, 0])).kind, undefined, 'dump header kept whole');
  const def = sdReply(VIEW_DEFINITION, 58, 1, defRaw({ tc: 1, min: 0, max: 1 }));
  assertEqual(hexOf(diag.redactFrame(def).bytes), hexOf(def), 'self-describe replies kept verbatim');
  // in a run: the current-preset name reply is in the log, blanked, and counted
  const { registry } = await makeRig();
  const b = await run(registry, { steps: ['info', 'dumpHeaderProbe'] });
  assert(b.redaction.presetNames >= 1, 'name replies counted');
  assert(b.frames.some((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '0d'), 'the name reply frame is logged');
  const json = JSON.stringify(b);
  assert(!json.includes(NAME_HEX) && !json.includes('Secret'), 'no preset name anywhere in the bundle');
  assert(!json.includes('COM7'), 'no port name in the bundle');
  assertEqual(diag.scrub('open failed on COM7 at C:\\Users\\someone\\x and /dev/cu.usbmodem1 for a@b.io', 'COM7'), 'open failed on <port> at <path> and <path> for <email>', 'log scrub');
}

// ── 13. the wire log is trimmed, never the run failed, when the bundle would be too large ──
async function trimming(): Promise<void> {
  const frames: diag.CaptureFrame[] = Array.from({ length: 1000 }, (_, i) => ({ t: i, dir: 'TX' as const, hex: 'aa'.repeat(10) }));
  const t = diag.trimFrames(frames, [500], 300 * 68);
  assert(t.truncated !== undefined && t.truncated.kept + t.truncated.dropped === 1000, 'counts kept + dropped');
  assert(t.frames.some((f) => f.t === 500) && t.frames.some((f) => f.t === 0) && t.frames.some((f) => f.t === 999), 'around the mark, first and last frames kept');
  assertEqual(diag.trimFrames(frames, [], 1e9).truncated, undefined, 'no trim under the budget');
  const { registry } = await makeRig(fakeState({ fitBlocks: new Set([66]) }));
  const b = await run(registry, { steps: ['labelProbe'] }, { maxBundleJsonBytes: 400 * 1024 });
  assert(b.framesTruncated !== undefined && b.framesTruncated.dropped > 0, 'framesTruncated recorded');
  assertEqual(b.frames.length, b.framesTruncated!.kept, 'kept frames match');
  assert(JSON.stringify(b).length <= 400 * 1024, 'bundle under the limit');
}

// ── 14. 409 both ways with the cache build; a second capture; 400 / 501 / 503 ──
async function gates(): Promise<void> {
  const { registry } = await makeRig();
  const start = (body: unknown) => diag.startCapture(store.defaultStore, registry, body, { ...QUICK, walkImpl: blockingWalk });
  assertEqual((await start({})).code, 400, 'no acknowledgement → 400');
  assertEqual(((await start({ acknowledged: 'yes' })).body as { error: string }).error, 'not-acknowledged', '400 body');
  assertEqual((await start({ acknowledged: true, steps: ['nope'] })).code, 400, 'unknown step → 400');
  assertEqual((await start({ acknowledged: true, steps: ['readonlyWalk'] })).code, 202, 'capture started');
  const again = await start({ acknowledged: true });
  assertEqual(again.code, 409, 'second capture → 409');
  assertEqual(JSON.stringify(again.body), JSON.stringify({ error: 'busy', what: 'capture' }), 'busy capture body');
  const build = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: seedWalk });
  assertEqual(build.code, 409, 'cache build during a capture → 409');
  assertEqual(JSON.stringify(build.body), JSON.stringify({ error: 'busy', what: 'capture' }), 'cache build busy body');
  diag.cancelCapture(registry);
  await diag.capturePromise(registry);
  // a cache build running → the capture answers 409 cache-build
  store.defaultStore.delDoc('deviceCaches', '11_13p0');
  const b = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: (_t, o) => blockingWalk(_t, o) });
  assertEqual((b.body as { started?: boolean }).started, true, 'cache build started');
  const blocked = await start({ acknowledged: true });
  assertEqual(blocked.code, 409, 'capture during a cache build → 409');
  assertEqual(JSON.stringify(blocked.body), JSON.stringify({ error: 'busy', what: 'cache-build' }), 'busy cache-build body');
  deviceCache.cancelCacheBuild(registry);
  await deviceCache.cacheBuildPromise(registry);
  assertEqual((await start({ acknowledged: true, steps: ['info'] })).code, 202, 'capture starts once the build ended');
  await diag.capturePromise(registry);
  // 501 on a non-gen-3 unit (AM4), 503 without a device
  const am4 = new MockTransport('serial', 'am4');
  am4.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x15)] : []);
  const r4 = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: 'am4' }), openConn: () => am4 });
  await r4.detect();
  const u = await diag.startCapture(store.defaultStore, r4, { acknowledged: true });
  assertEqual(u.code, 501, 'AM4 → 501');
  assertEqual(JSON.stringify(u.body), JSON.stringify({ error: 'unsupported', capability: 'diagnosticCapture' }), '501 body');
  const none = __createRegistryForTest({ resolveConn: async () => null, openConn: () => am4 });
  const n = await diag.startCapture(store.defaultStore, none, { acknowledged: true });
  assertEqual(n.code, 503, 'no device → 503');
  assertEqual((n.body as { error: string }).error, 'no-device', '503 body');
  assertEqual(diag.captureStatus(none).state, 'idle', 'idle status');
  assertEqual(diag.captureResult(none).code, 404, 'no result → 404');
}

// ── 15. upload ──
async function upload(): Promise<void> {
  const { registry } = await makeRig();
  const calls: Uint8Array[] = [];
  const metas: diag.DiagnosticUploadMeta[] = [];
  let answer: { code: number; body: unknown; retryAfter?: string | null; disabled?: boolean } = { code: 200, body: { captureId: 'row-1', status: 'complete' } };
  const cloud: diag.DiagnosticCaptureCloud = { diagnosticCaptureUpload: async (gz, meta) => { calls.push(gz); metas.push(meta); return answer; } };
  assertEqual((await diag.uploadCapture(registry, cloud, { consent: true })).code, 404, 'no result → 404');
  const b = await run(registry, { steps: ['info'] });
  assertEqual((await diag.uploadCapture(registry, cloud, {})).code, 400, 'no consent → 400');
  assertEqual(JSON.stringify((await diag.uploadCapture(registry, null, { consent: true })).body), JSON.stringify({ error: 'cloud-disabled' }), 'no cloud → 503 cloud-disabled');
  const ok = await diag.uploadCapture(registry, cloud, { consent: true, axisVersion: '0.9.1-beta' });
  assertEqual(ok.code, 200, 'upload ok');
  const okb = ok.body as { ok: boolean; captureId: string; bytes: number };
  assertEqual(okb.captureId, 'row-1', 'captureId from the cloud');
  const gz = calls[0]!;
  assertEqual(okb.bytes, gz.length, 'bytes = compressed size');
  assert(gz[0] === 0x1f && gz[1] === 0x8b, 'gzip magic');
  const sentBundle = JSON.parse(gunzipSync(gz).toString('utf8')) as diag.CaptureBundle;
  assertEqual(sentBundle.id, b.id, 'the uploaded bundle is the last result');
  assertEqual(sentBundle.app.axis, '0.9.1-beta', 'axisVersion stamped into the upload');
  const meta = metas[0]!;
  assertEqual(meta.captureId, b.id, 'meta: capture id');
  assertEqual(meta.model, FM3, 'meta: model');
  assertEqual(meta.firmware, '13.0', 'meta: firmware');
  assertEqual(meta.bytes, gz.length, 'meta: compressed size');
  assertEqual(meta.app.axis, '0.9.1-beta', 'meta: app versions incl. axis');
  assertEqual((diag.captureResult(registry).body as diag.CaptureBundle).app.axis, undefined, 'stored result not mutated');
  await diag.uploadCapture(registry, cloud, { consent: true, axisVersion: 'x'.repeat(40) });
  assertEqual((JSON.parse(gunzipSync(calls[1]!).toString('utf8')) as diag.CaptureBundle).app.axis, undefined, 'an invalid axisVersion is ignored');
  const big = await diag.uploadCapture(registry, cloud, { consent: true }, { limitBytes: 10 });
  assertEqual(big.code, 413, 'over the limit → 413');
  assertEqual(JSON.stringify(big.body), JSON.stringify({ error: 'too-large', bytes: (big.body as { bytes: number }).bytes, limit: 10 }), '413 body');
  assertEqual(diag.UPLOAD_LIMIT_BYTES, 26214400, 'default limit is 25 MiB');
  answer = { code: 401, body: { error: 'unauthorized' } };
  assertEqual(JSON.stringify((await diag.uploadCapture(registry, cloud, { consent: true })).body), JSON.stringify({ error: 'not-signed-in' }), '401 mapped');
  answer = { code: 429, body: { error: 'rate-limited', retryAfterSeconds: 120 }, retryAfter: '120' };
  const rl = await diag.uploadCapture(registry, cloud, { consent: true });
  assertEqual(rl.code, 429, '429 passed through');
  assertEqual(JSON.stringify(rl.body), JSON.stringify({ error: 'rate-limited', retryAfterSeconds: 120 }), '429 body');
  answer = { code: 500, body: { error: 'internal', message: 'upload failed; please try again later' } };
  const ce = await diag.uploadCapture(registry, cloud, { consent: true });
  assertEqual(ce.code, 502, 'cloud error → 502');
  assertEqual(JSON.stringify(ce.body), JSON.stringify({ error: 'cloud', status: 500, message: 'upload failed; please try again later' }), '502 body');
  answer = { code: 0, body: { error: 'fetch failed' } };
  assertEqual((await diag.uploadCapture(registry, cloud, { consent: true })).code, 502, 'network failure → 502');
  answer = { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
  assertEqual((await diag.uploadCapture(registry, cloud, { consent: true })).code, 503, 'disabled cloud client → 503');
}

// ── 16. telemetry held while a capture runs, resumed after ──
async function telemetryHold(): Promise<void> {
  const { registry, mock } = await makeRig();
  const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true, steps: ['readonlyWalk'] }, { ...QUICK, walkImpl: blockingWalk });
  assertEqual(r.code, 202, 'started');
  await sleep(20);
  const unsub = registry.subscribe(() => {}); // would start meters + edit watch on an FM3
  try {
    const before = mock.sent.length;
    await sleep(300);
    assertEqual(mock.sent.length, before, 'no supervisor polls while the capture holds the device');
    diag.cancelCapture(registry);
    await diag.capturePromise(registry);
    const after = mock.sent.length;
    await sleep(300);
    assert(mock.sent.length > after, 'supervisor polls resume after the capture for the listener that joined');
  } finally {
    unsub();
  }
}

// ── 17. the caps flag ──
async function capsFlag(): Promise<void> {
  for (const [model, want] of [[FM3, true], [0x12, true], [0x10, true], [0x15, false], [0x01, false]] as const) {
    const m = new MockTransport('serial', `m${model}`);
    m.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(model)] : []);
    const reg = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: m.label }), openConn: () => m });
    await reg.detect();
    const app = await buildApp(reg);
    try {
      const dev = (await app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { diagnosticCapture?: boolean } };
      assertEqual(dev.capabilities.diagnosticCapture, want, `model 0x${model.toString(16)} diagnosticCapture`);
    } finally {
      await app.close();
    }
  }
}

// ── 18. HTTP surface (Fastify): routes, codes, the 202 body ──
async function httpRoutes(): Promise<void> {
  const { registry } = await makeRig();
  diag.__setCaptureOptionsForTest(registry, { ...QUICK, walkImpl: seedWalk });
  const app = await buildApp(registry);
  try {
    const st = await app.inject({ method: 'GET', url: '/diagnostics/capture' });
    assertEqual(st.statusCode, 200, 'GET status 200');
    assertEqual((await app.inject({ method: 'POST', url: '/diagnostics/capture', payload: {} })).statusCode, 400, 'POST without ack 400');
    const s = await app.inject({ method: 'POST', url: '/diagnostics/capture', payload: { acknowledged: true, steps: ['info', 'readonlyWalk'] } });
    assertEqual(s.statusCode, 202, 'POST 202');
    const body = s.json() as { started: boolean; id: string };
    assertEqual(body.started, true, '202 started');
    await diag.capturePromise(registry);
    const res = await app.inject({ method: 'GET', url: '/diagnostics/capture/result' });
    assertEqual(res.statusCode, 200, 'result 200');
    assertEqual((res.json() as diag.CaptureBundle).id, body.id, 'result is the run');
    assertEqual((res.json() as diag.CaptureBundle).app.forgefx === 'unknown' || /\d/.test((res.json() as diag.CaptureBundle).app.forgefx), true, 'forgefx version from package.json or unknown');
    assertEqual((await app.inject({ method: 'POST', url: '/diagnostics/capture/cancel' })).json<{ ok: boolean }>().ok, true, 'cancel ok when idle');
    const up = await app.inject({ method: 'POST', url: '/diagnostics/capture/upload', payload: { consent: true } });
    assertEqual(up.statusCode, 503, 'upload without AXIS_CLOUD → 503');
    assertEqual((up.json() as { error: string }).error, 'cloud-disabled', 'cloud-disabled body');
  } finally {
    diag.__setCaptureOptionsForTest(registry, null);
    await app.close();
  }
}

export async function runDiagnosticCaptureTests(): Promise<void> {
  await infoAndReadonlyWalk();
  await labelProbeHappy();
  await labelProbeStops();
  await dumpHeaderProbe();
  await reloadProbe();
  await fullWalkGate();
  await bundleOnCancel();
  await bundleOnSilence();
  await silenceWatchdog();
  await bundleOnError();
  await queryBound();
  await redaction();
  await trimming();
  await gates();
  await upload();
  await telemetryHold();
  await capsFlag();
  await httpRoutes();
}
