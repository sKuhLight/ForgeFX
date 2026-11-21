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
import { deviceBusy } from '../../src/services/deviceJobs.js';
import * as store from '../../src/store.js';
import { buildDefQuery, buildValueQuery, decodeReply, CACHE_SCHEMA, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE, type CacheRecord, type LiveTransport, type LiveWalkOptions } from 'forgefx-midi/cache';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import type { RequestOpts } from '../../src/transport/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual, sleep } from '../helpers/mock.js';
import { fakeCacheDoc, seedRecords } from './device-cache.test.js';
import { runDiagnosticUpload, type DiagnosticUploadTransport } from '../../src/runtime/cloud.js';

export const DIAGNOSTIC_CAPTURE_CASE_COUNT = 23;

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

/** A one-chunk synthetic raw patch (2048 bytes): a name and a short body (4 bytes, or `len`) behind a tiny
 *  Huffman stream. `variant` 1 changes the body's values, `len` its length (what a firmware conversion does). */
function rawPatch(name: string, variant = 0, len = 4): Uint8Array {
  const raw = new Uint8Array(2048);
  for (let i = 0; i < name.length; i++) raw[0x08 + i] = name.charCodeAt(i);
  // tree: internal(0) → leaf(1)'A', leaf(1)'B'; then one bit per body byte
  const sym = Array.from({ length: len }, (_, i) => (variant === 0 ? i % 2 : i < 2 ? 1 : 0));
  const bits = [0, 1, ...[0, 1, 0, 0, 0, 0, 0, 1], 1, ...[0, 1, 0, 0, 0, 0, 1, 0], ...sym];
  while (bits.length % 8) bits.push(0);
  raw[0x48] = len; raw[0x4a] = bits.length / 8; // decompressed, compressed size
  for (let i = 0; i < bits.length / 8; i++) raw[0x4c + i] = bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0);
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
  /** Successive current-preset answers (then `current`). */
  presetRefs?: number[];
  /** A stored slot whose dump stops short (no terminator). */
  incompleteSlot?: number;
  /** A hinted address that answers the empty-slot definition (typecode 0, all zero). */
  fillerAt?: { block: number; param: number };
  /** A hinted address whose definition carries a zero default (the walk's numeric rule label-walks it anyway). */
  zeroDefaultAt?: { block: number; param: number };
  /** Print per-frame RX/TX trace lines and a multi-line warning with a path, like a chatty transport. */
  trace?: boolean;
  /** How a store (fn 0x01 sub 0x26) is answered: acknowledged + written (default), refused, or acknowledged
   *  without the slot changing. */
  storeMode?: 'ack' | 'reject' | 'ack-no-write';
  stores?: number[];
}

class FakeFm3 extends MockTransport {
  constructor(readonly state: FakeState) {
    super('serial', 'COM7');
    this.reply = (req) => this.#answer(req);
  }
  override async request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]> {
    const r = await super.request(bytes, opts);
    if (this.state.trace) {
      const spaced = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[forgefx][midi] TX ${bytes.length}B: ${spaced(bytes)}`);
      for (const f of r) console.log(`[forgefx][midi] RX ${f.length}B: ${spaced(f)}`);
      console.warn('[forgefx][serial] late reply swallowed, log at C:\\Users\\John Smith\\AppData\\x.log\nsecond line with more detail');
    }
    for (const f of r) this.emitFrame(f); // a real transport hands every inbound frame to onFrame too
    return r;
  }
  #answer(req: readonly number[]): number[][] {
    const s = this.state;
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (s.silent) return [];
    const fn = req[5];
    if (fn === 0x08) return s.fw ? [msg(0x08, [s.fw[0], s.fw[1], 0, 0])] : [];
    if (fn === 0x0d) {
      const n = s.presetRefs?.length ? s.presetRefs.shift()! : s.current;
      return [msg(0x0d, [n & 0x7f, (n >> 7) & 0x7f, ...Array.from(NAME.padEnd(32, ' '), (c) => c.charCodeAt(0))])];
    }
    if (fn === 0x03) {
      const requested = ((req[6]! & 0x7f) << 7) | (req[7]! & 0x7f);
      const raw = requested === 0x3fff ? (s.editBuffer ?? s.slots.get(s.current) ?? new Uint8Array(2048)) : (s.slots.get(requested) ?? new Uint8Array(2048));
      const header = s.headerFor?.(requested) ?? (requested === 0x3fff ? 0x3f80 : requested);
      const frames = dumpFrames(header, raw);
      return requested === s.incompleteSlot ? frames.slice(0, 2) : frames;
    }
    if (fn === 0x01 && req[6] === 0x26) { // store the edit buffer to a slot
      const n = (req[12]! & 0x7f) | ((req[13]! & 0x7f) << 7);
      (s.stores ??= []).push(n);
      if (s.storeMode === 'reject') return [msg(0x64, [0x01, 0x05])];
      if (s.storeMode !== 'ack-no-write') {
        s.slots.set(n, s.editBuffer ?? s.slots.get(s.current) ?? new Uint8Array(2048));
        if (n === s.current) s.editBuffer = null;
      }
      return [msg(0x01, [0x26, 0x00])];
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
        if (s.fillerAt && s.fillerAt.block === block && s.fillerAt.param === param) return [sdReply(view, block, param, defRaw({ tc: 0, min: 0, max: 0, id: 0 }))];
        // a list with a non-zero default ordinal (what only a hinted walk label-walks); a one-entry list keeps 0
        const zero = s.zeroDefaultAt?.block === block && s.zeroDefaultAt.param === param;
        if (hint && s.fitBlocks.has(block)) return [sdReply(view, block, param, defRaw({ tc: hint.typecode, min: 0, max: hint.count - 1, scale: hint.count >= 2 && !zero ? 1 : 0 }))];
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
const BOUND = deviceCache.walkBlockLimits(FM3, 'read-only').bound;
/** Hinted params of a block inside the read-only walk bound. */
const hinted = (block: number) => Object.keys(HINTS[block] ?? {}).map(Number).filter((p) => p <= (BOUND[block] ?? 127)).sort((a, b) => a - b);
/** Hinted params the label probe should target: lists of two or more labels (a non-zero default). */
const targetsOf = (block: number) => hinted(block).filter((p) => HINTS[block]![p]!.count >= 2);

/** A walk that queries `addrs` through the capture's adapter (definition, then the formatted value) like the
 *  real walk, and returns a record for every real definition, plus the seed records a build needs. */
function addressWalk(addrs: Array<[number, number]>, placeholders: ReadonlySet<string> = new Set()): diag.CaptureWalkImpl {
  return async (t) => {
    const recs: CacheRecord[] = [...seedRecords()];
    for (const [block, param] of addrs) {
      const reply = await t.request(buildDefQuery(FM3, block, param));
      const d = reply ? decodeReply(reply) : null;
      if (d?.view !== 'definition') continue;
      if (placeholders.has(`${block}:${param}`)) { // the walk kept this slot as a placeholder row, not a real param
        recs.push({ kind: 'float', section: block, offset: 0, id: param, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true } as CacheRecord);
        continue;
      }
      await t.request(buildValueQuery(FM3, block, param));
      // the record only marks the address as a real param (the probe reads the definition the walk received);
      // neutral numbers keep these synthetic rows out of the section→family vote of the build
      recs.push({ kind: 'float', section: block, offset: 0, id: param, tc: d.tc, min: 0, max: 0.123, def: 0, step: 0, t1: 0, t2: 0 } as CacheRecord);
    }
    return recs;
  };
}
/** The hinted addresses of `blocks` (at most `max` per block: a handful of synthetic rows per section keeps the
 *  build's section→family vote on the seed sections). */
const addrsOf = (blocks: number[], max = 4): Array<[number, number]> => blocks.flatMap((b) => hinted(b).slice(0, max).map((p) => [b, p] as [number, number]));

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
/** A walk stuck on a dead link: it never settles, not even on abort. */
const stuckWalk = (): Promise<CacheRecord[]> => new Promise(() => {});

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

// ── 2. label probe: only what this run's walk found; effect blocks, Controllers, Modifier, Global last ──
async function labelProbeHappy(): Promise<void> {
  const far = Object.keys(HINTS).map(Number).find((b) => b > 160 && hinted(b).length > 0)!;
  const placeholderAt = targetsOf(66)[0]!;
  const fillerAt = targetsOf(66)[1]!;
  const zeroAt = targetsOf(66)[2]!;
  const { registry, mock } = await makeRig(fakeState({ fitBlocks: new Set([66, 1, 2, 3, far]), fillerAt: { block: 66, param: fillerAt }, zeroDefaultAt: { block: 66, param: zeroAt } }));
  const start = mock.sent.length;
  const b = await run(registry, { steps: ['readonlyWalk', 'labelProbe'] }, { walkImpl: addressWalk(addrsOf([1, 2, 3, 66, far]), new Set([`66:${placeholderAt}`])) });
  const step = stepOf(b, 'labelProbe');
  assertEqual(stepOf(b, 'readonlyWalk').status, 'ok', `walk ok (${stepOf(b, 'readonlyWalk').error})`);
  assertEqual(step.status, 'ok', 'label probe ok');
  const r = step.result as { counts: Record<string, number>; entries: { block: number; param: number; fit: string; labelReply: string; label?: string; family: string; expected: { count: number; typecode: number }; got: { typecode: number; max: number; default: number } }[]; liveness: { block: number; param: number } };
  const walkedAt = new Set(addrsOf([1, 2, 3, 66, far]).map(([blk, p]) => `${blk}:${p}`));
  const want = [66, 2, 3, 1].flatMap((blk) => targetsOf(blk).filter((p) => walkedAt.has(`${blk}:${p}`) && !(blk === 66 && (p === placeholderAt || p === fillerAt || p === zeroAt))).map((p) => `${blk}:${p}`));
  const labelled = r.entries.filter((e) => e.labelReply === 'label');
  assertEqual(labelled.map((e) => `${e.block}:${e.param}`).join(','), want.join(','), 'targets: the walk\'s fitting non-zero-default lists, effect blocks → Controllers → Modifier → Global');
  assertEqual(r.counts.labels, want.length, 'one label per target');
  assertEqual(r.counts.defaultZero, 1, 'a zero-default list is left to the numeric rule (counted, not probed)');
  assert(labelled.every((e) => e.label === 'LBL' && e.fit === 'exact' && e.got.default === 1), 'labels with fit and default recorded');
  assert(labelled.every((e) => e.got.typecode === e.expected.typecode && e.got.max === e.expected.count - 1), 'expected vs got recorded');
  const sent = mock.sent.slice(start);
  const labelQueries = sent.map((f, i) => ({ f, i })).filter(({ f }) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL);
  assertEqual(labelQueries.length, want.length, 'label queries on the wire = targets');
  assert(!labelQueries.some(({ f }) => (f[8]! | (f[9]! << 7)) === far), 'nothing probed beyond the walk range (block > 160)');
  assert(!labelQueries.some(({ f }) => f[8] === 66 && (f[10] === placeholderAt || f[10] === fillerAt)), 'placeholder slot and empty-slot definition never probed');
  for (const { f, i } of labelQueries) {
    assertEqual((f[12]! | (f[13]! << 7)), 0, 'label query at sub = min');
    assert(isQueryOf(sent[i + 1]!, VIEW_DEFINITION, r.liveness.block, r.liveness.param), 'each label query is followed by a liveness query');
  }
  // the probe sends no definition queries of its own: only label + liveness after the walk
  const probeStart = labelQueries[0]!.i;
  assert(sent.slice(probeStart).every((f) => f[6] === VIEW_ENUM_LABEL || isQueryOf(f, VIEW_DEFINITION, r.liveness.block, r.liveness.param)), 'probe traffic = label + liveness only');
}

// ── 3. label probe stops at the first missing reply; the run carries on while the device answers ──
async function labelProbeStops(): Promise<void> {
  const stopAt = targetsOf(66)[1]!;
  const { registry, mock } = await makeRig(fakeState({ fitBlocks: new Set([66, 1]), silentLabel: { block: 66, param: stopAt } }));
  const start = mock.sent.length;
  const b = await run(registry, { steps: ['readonlyWalk', 'labelProbe', 'dumpHeaderProbe'] }, { walkImpl: addressWalk(addrsOf([66, 1])) });
  const step = stepOf(b, 'labelProbe');
  assertEqual(step.status, 'failed', 'label probe failed at the silent label');
  const r = step.result as { stoppedAt: { block: number; param: number; query: string }; counts: { labels: number } };
  assertEqual(JSON.stringify(r.stoppedAt), JSON.stringify({ block: 66, param: stopAt, query: 'label' }), 'stopped at the silent label query');
  assertEqual(r.counts.labels, 1, 'only the labels before the silence');
  const sent = mock.sent.slice(start);
  assert(!sent.some((f) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL && f[8] === 1), 'the Global block was never label-probed after the stop');
  assert(/no reply to the label query/.test(step.error ?? ''), 'error names the missing reply');
  assertEqual(stepOf(b, 'dumpHeaderProbe').status, 'ok', 'device still answers → the next step ran');
  assertEqual(b.state, 'done', 'run done (one step failed)');
}

// ── 3b. no completed read-only walk in the run → no label probe at all ──
async function labelProbeNeedsWalk(): Promise<void> {
  const { registry, mock } = await makeRig(fakeState({ fitBlocks: new Set([66, 1]) }));
  let start = mock.sent.length;
  let b = await run(registry, { steps: ['labelProbe'] });
  assertEqual(stepOf(b, 'labelProbe').status, 'skipped', 'no walk in the run → skipped');
  assertEqual(stepOf(b, 'labelProbe').note, 'needs a completed read-only walk in this run', 'skip note');
  assert(!mock.sent.slice(start).some((f) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL), 'no label query without a walk');
  start = mock.sent.length;
  b = await run(registry, { steps: ['readonlyWalk', 'labelProbe'] }, { walkImpl: async () => { throw new Error('walk broke'); } });
  assertEqual(stepOf(b, 'readonlyWalk').status, 'failed', 'the walk failed');
  assertEqual(stepOf(b, 'labelProbe').status, 'skipped', 'failed walk → label probe skipped (no roster fallback)');
  assert(!mock.sent.slice(start).some((f) => f[5] === 0x01 && f[6] === VIEW_ENUM_LABEL), 'no label query after a failed walk');
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
  assertEqual(r.emptySlots.join(','), '511,510,509', 'three unused slots in all: the last slot (already known) + two searched');
  assertEqual(r.requests.filter((x) => x.purpose === 'empty-search').length, 2, 'the search stops once three are known');
  // no dump payload kept: chunk + footer frames cut to 8 bytes with their length, headers whole
  const chunks = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '78');
  const footers = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '79');
  const headers = b.frames.filter((f) => f.dir === 'RX' && f.hex.slice(10, 12) === '77');
  assert(chunks.length === r.requests.length && chunks.every((f) => f.hex.length === 16 && f.len === 3082), 'chunk frames: 8-byte prefix + length');
  assert(footers.every((f) => f.hex.length === 16 && f.len === 11), 'footer frames: prefix + length');
  assert(headers.every((f) => f.hex.length === 26 && f.len === undefined), 'dump headers kept whole');
  assertEqual(b.redaction.dumpPayloadFrames, chunks.length + footers.length, 'redaction counts the cut dump frames');
  assert(!JSON.stringify(b).includes(hexOf(ascii('P128'))), 'no preset content in the bundle');
  // a unit without free slots near the top: at most six search dumps
  const full = fakeState();
  for (let n = 500; n <= 511; n++) full.slots.set(n, rawPatch(`S${n}`));
  const r2 = (stepOf(await run((await makeRig(full)).registry, { steps: ['dumpHeaderProbe'] }), 'dumpHeaderProbe').result as { requests: { purpose: string }[] });
  assertEqual(r2.requests.filter((x) => x.purpose === 'empty-search').length, 6, 'at most six search dumps');
  // an incomplete dump stops the step
  const { registry: rg, mock } = await makeRig(fakeState({ incompleteSlot: 127 }));
  const start = mock.sent.length;
  const b3 = await run(rg, { steps: ['dumpHeaderProbe'] });
  const s3 = stepOf(b3, 'dumpHeaderProbe');
  assertEqual(s3.status, 'failed', 'incomplete dump → failed');
  assertEqual((s3.result as { stoppedAt: number }).stoppedAt, 127, 'stopped at slot 127');
  assertEqual(mock.sent.slice(start).filter((f) => f[5] === 0x03).length, 2, 'no dump requested after the incomplete one');
}

// ── 5. reload probe: clean → switch + verify; unsaved edits → skipped, nothing switched ──
async function reloadProbe(): Promise<void> {
  {
    const { registry, state } = await makeRig();
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    const b = await run(registry, { steps: ['reloadProbe'] });
    unsub();
    const changed = events.filter((e) => e.type === 'changed');
    assertEqual(changed.length, 1, 'the job\'s own switch is silent; ONE changed event when the run ends');
    assertEqual(JSON.stringify(changed[0]), JSON.stringify({ type: 'changed', scope: 'preset' }), 'a preset refresh');
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
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    const b = await run(registry, { steps: ['reloadProbe'] });
    unsub();
    assert(!events.some((e) => e.type === 'changed'), 'a run that switched nothing sends no changed event');
    const step = stepOf(b, 'reloadProbe');
    assertEqual(step.status, 'skipped', 'unsaved edits → skipped');
    assertEqual(step.note, 'unsaved edits', 'skip note');
    assertEqual((step.result as { editBuffer: string }).editBuffer, 'dirty', 'edit buffer differs from its slot');
    assertEqual(state.switches.length, 0, 'no preset switch was sent');
  }
  {
    // the edit-buffer request answered by a dump headed with the slot number: not provably the edit buffer
    const { registry, state } = await makeRig(fakeState({ headerFor: (n) => (n === 0x3fff ? 12 : n) }));
    const b = await run(registry, { steps: ['reloadProbe'] });
    const step = stepOf(b, 'reloadProbe');
    assertEqual(step.status, 'skipped', 'edit buffer dump under a slot header → skipped');
    assertEqual((step.result as { editBuffer: string }).editBuffer, 'unknown', 'reported unknown, not clean');
    assertEqual(state.switches.length, 0, 'no switch');
  }
  {
    // the slot dump named another slot
    const { registry, state } = await makeRig(fakeState({ headerFor: (n) => (n === 12 ? 13 : n === 0x3fff ? 0x3f80 : n) }));
    assertEqual(stepOf(await run(registry, { steps: ['reloadProbe'] }), 'reloadProbe').status, 'skipped', 'slot dump under another number → skipped');
    assertEqual(state.switches.length, 0, 'no switch');
  }
  {
    // the current preset changes between the check and the switch
    const { registry, state } = await makeRig(fakeState({ presetRefs: [12, 13] }));
    const step = stepOf(await run(registry, { steps: ['reloadProbe'] }), 'reloadProbe');
    assertEqual(step.status, 'skipped', 'preset changed before the switch → skipped');
    assertEqual((step.result as { reason: string }).reason, 'the current preset changed after the check', 'reason recorded');
    assertEqual(state.switches.length, 0, 'no switch');
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

// ── 5b. unsaved edits: preflight, and the user's decision (save / discard) instead of a skip ──
async function unsavedEditsDecision(): Promise<void> {
  const preflight = async (registry: DeviceRegistry) => {
    const r = await diag.capturePreflight(registry);
    assertEqual(r.code, 200, 'preflight 200');
    return r.body as diag.CapturePreflight;
  };
  {
    const { registry } = await makeRig();
    const p = await preflight(registry);
    assertEqual(JSON.stringify(p), JSON.stringify({ preset: 12, presetName: NAME, editBuffer: 'clean', canSave: true }), 'clean preflight');
  }
  {
    const { registry } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1) }));
    const p = await preflight(registry);
    assertEqual(p.editBuffer, 'dirty', 'edited preset → dirty');
    assertEqual(p.likelyCause, 'unsaved-edits', 'same body length → unsaved edits');
  }
  {
    const { registry } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1, 6) }));
    assertEqual((await preflight(registry)).likelyCause, 'older-firmware', 'a body of another length → converted from an older firmware');
  }
  {
    const { registry } = await makeRig(fakeState({ headerFor: (n) => (n === 0x3fff ? 12 : n) }));
    const p = await preflight(registry);
    assert(p.editBuffer === 'unknown' && p.likelyCause === 'unknown' && typeof p.reason === 'string', 'unprovable edit buffer → unknown, with a reason');
  }
  // save: stored to the current slot with the device's ack, re-checked clean, then switched
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1, 6) }));
    await preflight(registry);
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    const b = await run(registry, { steps: ['reloadProbe'], unsavedEdits: 'save' });
    unsub();
    const step = stepOf(b, 'reloadProbe');
    assertEqual(step.status, 'ok', 'save → reload probe runs');
    const r = step.result as { unsavedEdits: { decision: string; outcome: string; save: { slot: number; ok: boolean; acked: boolean; ms: number }; afterSave: { editBuffer: string } }; likelyCause: string; verified: boolean };
    assertEqual(r.unsavedEdits.decision, 'save', 'decision recorded');
    assertEqual(r.unsavedEdits.outcome, 'saved', 'outcome recorded');
    assert(r.unsavedEdits.save.slot === 12 && r.unsavedEdits.save.ok && r.unsavedEdits.save.acked && typeof r.unsavedEdits.save.ms === 'number', 'save: slot, ack, ms recorded');
    assertEqual(r.unsavedEdits.afterSave.editBuffer, 'clean', 'the edit buffer checks clean after the save');
    assertEqual(r.likelyCause, 'older-firmware', 'the likely cause is recorded');
    assertEqual(r.verified, true, 'switch verified');
    assertEqual((state.stores ?? []).join(','), '12', 'stored to the current slot');
    assertEqual(state.switches.join(','), '12', 'then switched');
    assert(b.logs.some((l) => /unsaved edits: 'save' for preset 12/.test(l.msg)) && b.logs.some((l) => /preset 12: save done/.test(l.msg)), 'decision and save in the job log');
    assertEqual(events.filter((e) => e.type === 'changed').length, 1, 'one changed event at the end');
    assert(!JSON.stringify(b).includes('Secret'), 'the preset name stays out of the bundle');
  }
  // a refused save: the step fails, nothing is switched, and the full walk does not run either
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1), storeMode: 'reject' }));
    await preflight(registry);
    let walks = 0;
    const b = await run(registry, { steps: ['reloadProbe'], includeFullWalk: true, unsavedEdits: 'save' }, { walkImpl: async () => { walks++; return seedRecords(); } });
    const rp = stepOf(b, 'reloadProbe');
    assertEqual(rp.status, 'failed', 'refused save → failed');
    assert(/saving preset 12 failed/.test(rp.error ?? ''), `error names the failed save (${rp.error})`);
    assertEqual((rp.result as { save: { ok: boolean; reason: string } }).save.reason, 'rejected', 'the refusal is recorded');
    assertEqual(stepOf(b, 'fullWalk').status, 'failed', 'the full walk fails too (never switch after a failed save)');
    assertEqual(walks, 0, 'no full walk');
    assertEqual(state.switches.length, 0, 'no switch');
    assertEqual((state.stores ?? []).length, 1, 'one save attempt only');
  }
  // an acknowledged save that leaves the edit buffer different: failed, no switch
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1), storeMode: 'ack-no-write' }));
    await preflight(registry);
    const step = stepOf(await run(registry, { steps: ['reloadProbe'], unsavedEdits: 'save' }), 'reloadProbe');
    assertEqual(step.status, 'failed', 'still not clean after the save → failed');
    assertEqual((step.result as { unsavedEdits: { afterSave: { editBuffer: string } } }).unsavedEdits.afterSave.editBuffer, 'dirty', 'the re-check is recorded');
    assertEqual(state.switches.length, 0, 'no switch');
  }
  // discard: the switching steps run although the edit buffer is dirty
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1) }));
    await preflight(registry);
    let walks = 0;
    const b = await run(registry, { steps: ['reloadProbe'], includeFullWalk: true, unsavedEdits: 'discard' }, { walkImpl: async () => { walks++; return seedRecords(); } });
    const r = stepOf(b, 'reloadProbe');
    assertEqual(r.status, 'ok', 'discard → reload probe runs');
    assertEqual((r.result as { discardedUnsavedEdits: boolean }).discardedUnsavedEdits, true, 'discardedUnsavedEdits recorded');
    assertEqual((r.result as { unsavedEdits: { outcome: string } }).unsavedEdits.outcome, 'discarded', 'outcome recorded');
    assertEqual(stepOf(b, 'fullWalk').status, 'ok', 'the full walk runs too');
    assertEqual(walks, 1, 'one full walk');
    assertEqual(state.switches.join(','), '12', 'the reload switched (the edits are gone)');
    assertEqual((state.stores ?? []).length, 0, 'nothing saved');
    assert(b.logs.some((l) => /preset 12: discarded/.test(l.msg)), 'discard in the job log');
  }
  // the decision holds only for the preset it was made for
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1) }));
    await preflight(registry);
    state.slots.set(13, rawPatch('Other'));
    state.current = 13; // the user turned the knob after the dialog
    const step = stepOf(await run(registry, { steps: ['reloadProbe'], unsavedEdits: 'save' }), 'reloadProbe');
    assertEqual(step.status, 'skipped', 'another preset → not honoured');
    assertEqual(step.note, 'the current preset changed', 'skip note');
    assertEqual((step.result as { unsavedEdits: { outcome: string } }).unsavedEdits.outcome, 'preset-changed', 'outcome recorded');
    assertEqual((state.stores ?? []).length + state.switches.length, 0, 'nothing saved, nothing switched');
  }
  // without a preflight the start body names the preset; with neither the decision is not honoured
  {
    const { registry, state } = await makeRig(fakeState({ editBuffer: rawPatch('Current', 1) }));
    assertEqual(stepOf(await run(registry, { steps: ['reloadProbe'], unsavedEdits: 'discard', preset: 12 }), 'reloadProbe').status, 'ok', 'body preset honoured');
    state.editBuffer = rawPatch('Current', 1);
    assertEqual(stepOf(await run(registry, { steps: ['reloadProbe'], unsavedEdits: 'discard' }), 'reloadProbe').note, 'the current preset changed', 'no preflight, no preset → not honoured');
    assertEqual(state.switches.length, 1, 'only the honoured run switched');
  }
  // gates
  {
    const { registry } = await makeRig();
    assertEqual((await diag.startCapture(store.defaultStore, registry, { acknowledged: true, unsavedEdits: 'keep' }, QUICK)).code, 400, 'unknown decision → 400');
    assertEqual((await diag.startCapture(store.defaultStore, registry, { acknowledged: true, steps: ['readonlyWalk'] }, { ...QUICK, walkImpl: blockingWalk })).code, 202, 'started');
    const busy = await diag.capturePreflight(registry);
    assertEqual(busy.code, 409, 'preflight while a capture runs → 409');
    assertEqual(JSON.stringify(busy.body), JSON.stringify({ error: 'busy', what: 'capture' }), '409 body');
    diag.cancelCapture(registry);
    await diag.capturePromise(registry);
    store.defaultStore.delDoc('deviceCaches', '11_13p0');
    await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: (t, o) => blockingWalk(t, o) });
    assertEqual(JSON.stringify((await diag.capturePreflight(registry)).body), JSON.stringify({ error: 'busy', what: 'cache-build' }), 'preflight during a cache build → 409');
    deviceCache.cancelCacheBuild(registry);
    await deviceCache.cacheBuildPromise(registry);
    const none = __createRegistryForTest({ resolveConn: async () => null, openConn: () => new MockTransport() });
    assertEqual((await diag.capturePreflight(none)).code, 503, 'no device → 503');
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
    // the current preset moves between the edit-buffer check and the start of the walk
    const { registry } = await makeRig(fakeState({ fw: [13, 0], presetRefs: [12, 14] }));
    let walks = 0;
    const b = await run(registry, { steps: [], includeFullWalk: true }, { walkImpl: async () => { walks++; return seedRecords(); } });
    assertEqual(stepOf(b, 'fullWalk').status, 'skipped', 'preset changed → full walk skipped');
    assertEqual(walks, 0, 'no full walk ran');
  }
  {
    const { registry } = await makeRig(fakeState({ fw: [13, 0] }));
    let mode: string | undefined;
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    const b = await run(registry, { steps: [], includeFullWalk: true }, { walkImpl: async (_t, o) => { mode = o.mode; await o.write!.reloadPreset(); return seedRecords(); } });
    unsub();
    assertEqual(stepOf(b, 'fullWalk').status, 'ok', 'full walk runs on FM3 13.0 with a clean edit buffer');
    assertEqual(mode, 'full', 'the walk ran in full mode');
    assertEqual(events.filter((e) => e.type === 'changed').length, 1, 'the full walk\'s reloads are silent; ONE changed event at the end');
  }
}

// ── 7. bundle on cancel ──
async function bundleOnCancel(): Promise<void> {
  const { registry } = await makeRig();
  const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true }, { ...QUICK, walkImpl: stuckWalk, releaseGraceMs: 300 });
  assertEqual(r.code, 202, 'started');
  await sleep(30);
  const st = diag.captureStatus(registry);
  assertEqual(st.state, 'running', 'status running');
  assertEqual(st.steps!.find((s) => s.name === 'readonlyWalk')!.status, 'running', 'walk step running');
  assertEqual(diag.cancelCapture(registry).ok, true, 'cancel ok');
  assertEqual(diag.cancelCapture(registry).ok, true, 'cancel idempotent');
  const released = diag.capturePromise(registry)!;
  await sleep(20);
  assertEqual(diag.captureResult(registry).code, 200, 'a cancel publishes the bundle at once, even while a step is stuck on the link');
  assertEqual(diag.captureStatus(registry).state, 'cancelled', 'status reports the ended run');
  assertEqual(deviceBusy(registry), 'capture', 'the device stays claimed while the stuck step may still use the link');
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(String(a[0])); };
  try {
    await released;
  } finally {
    console.warn = warn;
  }
  assertEqual(deviceBusy(registry), null, 'released after the grace period');
  assert(warned.some((w) => /still held the link after 300 ms; releasing the device/.test(w)), 'the forced release is logged');
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

// ── 7b. cancel mid full walk: the walk's own closing reload runs after the abort — the device stays the job's
//     (no build, capture or telemetry in between) until it is done, then ONE changed event ──
async function cancelDuringFullWalk(): Promise<void> {
  const { registry, mock, state } = await makeRig(fakeState({ fw: [13, 0] }));
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e)); // would run meters + edit watch once released
  let reloaded = false;
  const walk: diag.CaptureWalkImpl = async (_t, o) => {
    await new Promise<void>((r) => o.signal!.addEventListener('abort', () => r(), { once: true }));
    await sleep(150); // the codec restores the preset after an abort, too — late
    await o.write!.reloadPreset();
    reloaded = true;
    throw new Error('live walk aborted');
  };
  try {
    const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true, steps: [], includeFullWalk: true }, { ...QUICK, walkImpl: walk });
    assertEqual(r.code, 202, 'started');
    await sleep(40);
    diag.cancelCapture(registry);
    await sleep(20);
    assertEqual(diag.captureResult(registry).code, 200, 'bundle published at once');
    assertEqual((diag.captureResult(registry).body as diag.CaptureBundle).state, 'cancelled', 'cancelled bundle');
    assertEqual(reloaded, false, 'the walk is still restoring the preset');
    const build = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: seedWalk });
    assertEqual(JSON.stringify(build.body), JSON.stringify({ error: 'busy', what: 'capture' }), 'no cache build before the preset is restored');
    assertEqual((await diag.startCapture(store.defaultStore, registry, { acknowledged: true }, QUICK)).code, 409, 'no new capture before the preset is restored');
    assert(!events.some((e) => e.type === 'changed'), 'no changed event yet');
    const before = mock.sent.length;
    await diag.capturePromise(registry);
    assertEqual(reloaded, true, 'the closing reload ran before the release');
    const between = mock.sent.slice(before);
    assert(between.every((f) => f[5] === 0x0d || (f[5] === 0x01 && f[6] === 0x27)), 'only the walk\'s own reload used the link until the release (no telemetry)');
    assertEqual(state.switches.join(','), '12', 'the preset was restored by its own reload');
    assertEqual(events.filter((e) => e.type === 'changed').length, 1, 'ONE changed event once the preset is final');
    assertEqual(deviceBusy(registry), null, 'device released');
    await sleep(250);
    assert(mock.sent.length > before + between.length, 'telemetry resumes after the release');
  } finally {
    unsub();
  }
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
  const b = await run(registry, { steps: ['readonlyWalk', 'labelProbe'] }, { walkImpl: stuckWalk, silenceMs: 60, watchdogTickMs: 10, releaseGraceMs: 50 });
  assertEqual(b.abortReason, 'device-silent', 'watchdog aborts on silence, also when the step never returns');
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
  // a cleanup that throws (the telemetry resume) still leaves a bundle behind
  const pause = registry.pauseTelemetry.bind(registry);
  registry.pauseTelemetry = () => { const resume = pause(); return () => { resume(); throw new Error('resume broke'); }; };
  try {
    const b2 = await run(registry, { steps: ['info'] });
    assertEqual(b2.state, 'done', 'bundle built although the resume threw');
  } finally {
    registry.pauseTelemetry = pause;
  }
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
  const id = { home: 'C:\\Users\\John Smith', user: 'jsmith', host: 'HOSTX' };
  const scrubbed = diag.scrub('fail at D:\\Some Dir\\John Smith\\x.log, home C:\\Users\\John Smith\\AppData\\y, /home/jsmith/a b by jsmith on HOSTX\nsecond line', null, id);
  assert(!/John|Smith|jsmith|HOSTX|second line|Some Dir/.test(scrubbed), `identity, paths with spaces and later lines scrubbed (${scrubbed})`);
}

// ── 12b. the job log: no frame dumps, no names, first lines only, scrubbed ──
async function logPrivacy(): Promise<void> {
  const { registry } = await makeRig(fakeState({ trace: true }));
  const b = await run(registry, { steps: ['info', 'dumpHeaderProbe'] }, { identity: { user: 'jsmith', host: 'HOSTX' } });
  const text = JSON.stringify(b.logs);
  assert(!b.logs.some((l) => /\b(RX|TX)\b/.test(l.msg)), 'no per-frame RX/TX line in the job log');
  assert(!text.includes(NAME_HEX) && !text.includes('53 65 63 72 65 74') && !text.includes('Secret'), 'no preset name in the job log');
  assert(!text.includes('second line') && !text.includes('John Smith'), 'first lines only, paths with spaces scrubbed');
  assert(b.logs.some((l) => l.level === 'warn' && l.msg.includes('late reply swallowed') && l.msg.includes('<path>')), 'the transport warning itself is kept, scrubbed');
  assert(b.logs.some((l) => /step dumpHeaderProbe: ok/.test(l.msg)), 'step ends are always logged');
}

// ── 13. the wire log is trimmed, never the run failed, when the bundle would be too large ──
async function trimming(): Promise<void> {
  const frames: diag.CaptureFrame[] = Array.from({ length: 1000 }, (_, i) => ({ t: i, dir: 'TX' as const, hex: 'aa'.repeat(10) }));
  const t = diag.trimFrames(frames, [500], 300 * 68);
  assert(t.truncated !== undefined && t.truncated.kept + t.truncated.dropped === 1000, 'counts kept + dropped');
  assert(t.frames.some((f) => f.t === 500) && t.frames.some((f) => f.t === 0) && t.frames.some((f) => f.t === 999), 'around the mark, first and last frames kept');
  assertEqual(diag.trimFrames(frames, [], 1e9).truncated, undefined, 'no trim under the budget');
  const { registry } = await makeRig();
  const chatty: diag.CaptureWalkImpl = async (t) => { for (let i = 0; i < 4000; i++) await t.request(buildDefQuery(FM3, 58, i % 100)); return seedRecords(); };
  const b = await run(registry, { steps: ['readonlyWalk'] }, { walkImpl: chatty, maxBundleJsonBytes: 400 * 1024 });
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
  assertEqual(meta.state, 'done', 'meta: run state');
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
  answer = { code: 403, body: { error: 'account-required' } };
  assertEqual(JSON.stringify((await diag.uploadCapture(registry, cloud, { consent: true })).body), JSON.stringify({ error: 'not-signed-in', reason: 'account-required' }), 'anonymous session → 401 account-required');
  answer = { code: 429, body: { error: 'quota-exceeded', retryAfterSeconds: 3600 }, retryAfter: '3600' };
  assertEqual(JSON.stringify((await diag.uploadCapture(registry, cloud, { consent: true })).body), JSON.stringify({ error: 'quota-exceeded', retryAfterSeconds: 3600 }), 'quota 429 kept apart');
  answer = { code: 413, body: { error: 'too-large', stage: 'compressed', limit: 26214400 } };
  const c413 = await diag.uploadCapture(registry, cloud, { consent: true });
  assertEqual(c413.code, 413, 'cloud 413 → 413');
  assertEqual((c413.body as { stage?: string }).stage, 'compressed', 'cloud 413 stage passed on');
  answer = { code: 200, body: { captureId: 'row-1', status: 'complete', deduped: true } };
  assertEqual(((await diag.uploadCapture(registry, cloud, { consent: true })).body as { deduped?: boolean }).deduped, true, 'deduped passed on');
}

// ── 15b. the cloud upload flow (reserve → storage upload → finalize) over a fake wire ──
async function uploadFlow(): Promise<void> {
  const gz = Uint8Array.from([0x1f, 0x8b, 1, 2, 3]);
  const meta = { captureId: 'dc-20261121T000000Z-abcd', model: FM3, firmware: '13.0', app: { forgefx: '1', codec: '2' }, state: 'done', bytes: gz.length };
  type Script = { reserve: { code: number; body: Record<string, unknown> }; uploads: Array<'ok' | 'net' | 'exists' | { status: number; message: string }>; finals: Array<{ code: number; body: Record<string, unknown> }> };
  const rig = (sc: Script) => {
    const log: string[] = [];
    const posts: { path: string; body: unknown }[] = [];
    const t: DiagnosticUploadTransport = {
      post: async (path, body) => {
        posts.push({ path, body });
        log.push(path === 'diagnostic-captures' ? 'reserve' : 'finalize');
        const a = path === 'diagnostic-captures' ? sc.reserve : (sc.finals.shift() ?? { code: 200, body: { status: 'complete' } });
        return { ...a, retryAfter: a.code === 429 ? '60' : null };
      },
      upload: async (bucket, path, token, body) => {
        log.push(`upload ${bucket}/${path}/${token}/${body.length}`);
        const u = sc.uploads.shift() ?? 'ok';
        if (u === 'net') throw new Error('fetch failed');
        if (u === 'exists') return { status: 409, message: 'The resource already exists' };
        return u === 'ok' ? null : u;
      }
    };
    return { t, log, posts };
  };
  const slot = { captureId: 'uuid-1', status: 'pending', uploadUrl: 'https://x/upload', token: 'tok', path: 'u/dc.json.gz', bucket: 'diagnostic-captures', expiresIn: 7200 };
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: ['ok'], finals: [{ code: 200, body: { captureId: 'uuid-1', status: 'complete' } }] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(out.code, 200, 'flow: 200');
    assertEqual(JSON.stringify(out.body), JSON.stringify({ captureId: 'uuid-1', status: 'complete' }), 'flow: the cloud row id');
    assertEqual(r.log.join(' | '), 'reserve | upload diagnostic-captures/u/dc.json.gz/tok/5 | finalize', 'flow: reserve → upload → finalize');
    assertEqual(JSON.stringify(r.posts[0]!.body), JSON.stringify(meta), 'flow: reserve carries the metadata');
    assertEqual(JSON.stringify(r.posts[1]!.body), JSON.stringify({ captureId: 'uuid-1' }), 'flow: finalize by row id');
  }
  {
    const r = rig({ reserve: { code: 200, body: { captureId: 'uuid-2', status: 'complete', deduped: true } }, uploads: [], finals: [] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(r.log.join(' | '), 'reserve', 'deduped complete: nothing else');
    assertEqual((out.body as { deduped?: boolean }).deduped, true, 'deduped flagged');
  }
  {
    const r = rig({ reserve: { code: 200, body: { captureId: 'uuid-3', status: 'pending', deduped: true } }, uploads: [], finals: [] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(r.log.join(' | '), 'reserve | finalize', 'deduped pending without a slot: finalize only');
    assertEqual(out.code, 200, 'finalized');
  }
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: ['net', 'ok'], finals: [] });
    assertEqual((await runDiagnosticUpload(r.t, gz, meta)).code, 200, 'a network failure of the upload is retried once');
    assertEqual(r.log.filter((x) => x.startsWith('upload')).length, 2, 'two upload attempts');
  }
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: ['net', 'net'], finals: [] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(out.code, 0, 'two network failures: give up (network)');
    assert(!r.log.includes('finalize'), 'no finalize without an upload');
  }
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: ['ok', 'ok'], finals: [{ code: 409, body: { error: 'not-uploaded' } }, { code: 200, body: { status: 'complete' } }] });
    assertEqual((await runDiagnosticUpload(r.t, gz, meta)).code, 200, 'finalize 409 not-uploaded: upload + finalize once more');
    assertEqual(r.log.join(' | ').split(' | ').length, 5, 'reserve, upload, finalize, upload, finalize');
  }
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: ['exists'], finals: [] });
    assertEqual((await runDiagnosticUpload(r.t, gz, meta)).code, 200, 'create-only conflict = already stored → finalize');
  }
  {
    const r = rig({ reserve: { code: 429, body: { error: 'rate-limited', retryAfterSeconds: 60 } }, uploads: [], finals: [] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(out.code, 429, 'reserve 429 passed through');
    assertEqual(out.retryAfter, '60', 'Retry-After passed through');
    assertEqual(r.log.join(' | '), 'reserve', 'nothing uploaded when the reservation is refused');
  }
  {
    const r = rig({ reserve: { code: 200, body: slot }, uploads: [{ status: 400, message: 'invalid' }], finals: [] });
    const out = await runDiagnosticUpload(r.t, gz, meta);
    assertEqual(out.code, 400, 'a storage HTTP error ends the flow');
    assert(!r.log.includes('finalize'), 'no finalize after a refused upload');
  }
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
    // the Browser-Direct router takes the host's versions
    diag.__setCaptureOptionsForTest(registry, { ...QUICK, versions: undefined, walkImpl: seedWalk });
    const router = createRouter({ registry, store: store.defaultStore, versions: { forgefx: '1.2.3', codec: '4.5.6', axis: '7.8.9-beta' } });
    assertEqual((await router.handle('POST', '/diagnostics/capture', JSON.stringify({ acknowledged: true, steps: ['info'] }))).status, 202, 'router start 202');
    await diag.capturePromise(registry);
    const viaRouter = JSON.parse((await router.handle('GET', '/diagnostics/capture/result')).body as string) as diag.CaptureBundle;
    assertEqual(JSON.stringify(viaRouter.app), JSON.stringify({ forgefx: '1.2.3', codec: '4.5.6', axis: '7.8.9-beta' }), 'bundle app versions from RuntimeDeps');
  } finally {
    diag.__setCaptureOptionsForTest(registry, null);
    await app.close();
  }
}

export async function runDiagnosticCaptureTests(): Promise<void> {
  await infoAndReadonlyWalk();
  await labelProbeHappy();
  await labelProbeStops();
  await labelProbeNeedsWalk();
  await dumpHeaderProbe();
  await reloadProbe();
  await unsavedEditsDecision();
  await fullWalkGate();
  await bundleOnCancel();
  await cancelDuringFullWalk();
  await bundleOnSilence();
  await silenceWatchdog();
  await bundleOnError();
  await queryBound();
  await redaction();
  await logPrivacy();
  await trimming();
  await gates();
  await upload();
  await uploadFlow();
  await telemetryHold();
  await capsFlag();
  await httpRoutes();
}
