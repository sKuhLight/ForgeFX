// The diagnostic capture's definition-walk steps (M3 WP-F8): `extendedWalk`, `above160Walk` and `blockProbe` of
// services/diagnosticCapture.ts — mocked transport, synthetic frames and records only, NO hardware. Covers:
//   - opt-in only: never in DEFAULT_STEPS (a default run walks nothing above id 127 or block 160, even with every gate
//     open); their place in STEP_ORDER (after the walks, before every step that may switch presets);
//   - the gates: an unanswered firmware read skips them with nothing sent; on a firmware the walk-scope table does not
//     list they run read-only as diagnostic evidence (`gate.allowance: 'diagnostic'`) only with the request flag
//     `unverifiedScope: true` (else skipped, nothing sent past the firmware read; a non-boolean flag → 400
//     invalid-request on both twins), with the development override 'dev-override', with a table entry 'verified';
//   - above-160 clearance for the probe: only an above160Walk that PASSED (no implausible / lost / unresolved reply, a
//     real table in every block) clears it — not one that merely ended 'ok', failed or was skipped;
//   - a liveness query unanswered after a probe ends the run as 'device-silent'; a probe timeout stops the walk itself;
//   - labels: every step result says `labels: 'unscreened'`, the bundle `redaction.unscreenedLabels` once one talked;
//   - extendedWalk / above160Walk run the build's extension plan (blocks, bounds, budget) through the codec's own walk on a
//     synthetic unit: every block queried to exactly its bound, records as a `live-readonly` raw source, nothing
//     stored, nothing applied, no write frame; the abort rules: an implausible reply at id 140 fails the step with the
//     build's `abortReason` and the run carries on while the unit answers; the query budget; `empty-block`;
//   - blockProbe: targets from a fresh, silent grid read (blocks the static tables do not place; on an Axe-Fx III also the
//     roster-only ones, never a virtual one), above effect id 160 only once above160Walk passed in the run (or the gate
//     is open), the probe route's walk (ceiling from the bulk shape; a roster-only block's catalog stride), the would-be
//     block map computed but never stored, a liveness query after each probe; a probe timeout stops the step, the run
//     carries on;
//   - an abort mid-step (cancel during an extension walk, during a probe walk) leaves a bundle with the steps done so
//     far, the aborted step's gate and plan, the interrupted block marked 'aborted', and the abort reason;
//   - the bound watchdog: an out-of-plan query (above a bound, outside the block list, above the probe ceiling, one the
//     walk swallowed) is never sent and aborts the run as 'query-bound' with a bundle;
//   - both twins (Fastify + router) alike, the Remote relay refuses the start, dump payload redaction applies to the
//     probe step's grid read.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import {
  BYPASS_TYPECODE, LiveWalkAbortError, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE, buildDefQuery, liveWalkDetailed,
  type CacheRecord, type LiveRawSource, type LiveWalkOptions, type ProfileDoc
} from 'forgefx-midi/cache';
import { authorGen3PresetFromIRFull, defaultScaffoldSyx } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { PROFILES } from '../../src/devices.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { staticRoster } from '../../src/profileCatalog.js';
import { remoteAllowed } from '../../src/remote.js';
import { createRouter } from '../../src/runtime/router.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import * as diag from '../../src/services/diagnosticCapture.js';
import { deviceBusy } from '../../src/services/deviceJobs.js';
import { WALK_SCOPE_VERIFIED_FW, type WalkScopeOverrideToken } from '../../src/services/walkScope.js';
import * as store from '../../src/store.js';
import type { RequestOpts } from '../../src/transport/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, dumpAnswering, assert, assertEqual, sleep } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { blockBulkFrames, compactHex, enc14, sysex, type MockBlock } from '../helpers/blockRead.js';
import { seedRecords as cacheSeedRecords } from '../helpers/cacheBytes.js';
import { editorCacheSource, liveSeedRecords, liveSource, profileDoc, walkResult } from '../helpers/profileDocs.js';

export const DIAGNOSTIC_WALK_STEPS_CASE_COUNT = 13;

const FM3 = 0x11;
const AXE3 = 0x10;
/** FM3 fw 12.0 (the catalog firmware): the document key of the stored fixtures. */
const KEY = '11_12p0';
/** A section the FM3 inventory does not list and the placed block it belongs to (as in the unknown-blocks suite). */
const NEW_TAG = 60;
const NEW_EID = 203;
const STRIDE = 10;
const NEW_STEPS: readonly diag.StepName[] = ['extendedWalk', 'above160Walk', 'blockProbe'];
/** The request flag a run on a firmware the walk-scope table does not list needs. */
const U = { unverifiedScope: true } as const;
/** FM3 extension plan (catalog bounds): ids above 127 of GLOBAL, CONTROLLERS and the amp; the roster blocks above 160. */
const FM3_EXTENDED = [1, 2, 58];
const FM3_ABOVE160 = [162, 163, 166, 178, 182, 183, 186, 187, 191, 192];
const WALK_VIEWS: ReadonlySet<number> = new Set([VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE]);

// ── synthetic records and frames ────────────────────────────────────────────────────────────────────────────────────
const F = (section: number, id: number, tc: number, min: number, max: number, def: number, step: number): CacheRecord =>
  ({ kind: 'float', section, offset: 0, id, tc, min, max, def, step, t1: 0, t2: 0 });
const E = (section: number, id: number, tc: number, values: string[], def = 0): CacheRecord =>
  ({ kind: 'enum', section, offset: 0, id, tc, min: 0, max: values.length - 1, def, step: 0, count: values.length, values, x: 0 });

/** The new block's table at `section`; `live`: as a walk without label hints reads it. */
function newBlock(section: number, live = false): CacheRecord[] {
  return [
    F(section, 0, 0x52, 0, 10, 5, 0.01),
    F(section, 1, 0x81, -24, 24, 0, 0.1),
    E(section, 2, 0x10, ['MODE A', 'MODE B', 'MODE C']),
    F(section, 3, 0x71, 0, 1, 0.5, 0.01),
    F(section, 4, 0x41, 20, 20000, 1000, 1),
    F(section, 5, 0x31, 0, 100, 50, 1),
    live ? F(section, 6, 0x10, 0, 3, 2, 0) : E(section, 6, 0x10, ['ONE', 'TWO', 'THREE', 'FOUR'], 2),
    F(section, 7, 0x61, -12, 12, 0, 0.1),
    F(section, 8, 0x32, 0, 10, 2, 0.01),
    F(section, 9, BYPASS_TYPECODE, 0, 1, 0, 1)
  ];
}
/** The new block's bulk body: four channel slices of `STRIDE` values (selectors in range). */
const newBody = (): number[] => {
  const slice = Array.from({ length: STRIDE }, (_, pid) => (pid === 2 ? 1 : pid === 6 ? 2 : (pid * 997) % 65535));
  return [...slice, ...slice, ...slice, ...slice];
};
/** A format-2 FM3 document of a local editor-cache source with the seed families plus the new section. */
const byteDoc = async (): Promise<ProfileDoc> => profileDoc([await editorCacheSource([...cacheSeedRecords(), ...newBlock(NEW_TAG)])]);

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
function sdReply(model: number, view: number, block: number, param: number, raw: Uint8Array | null): number[] {
  const inner = new Array<number>(15).fill(0);
  inner[0] = view; inner[2] = 0x01; inner[3] = (block >> 7) & 0x7f; inner[4] = param & 0x7f; inner[5] = (param >> 7) & 0x7f;
  inner[6] = raw ? 0x3a : 0x40;
  inner[13] = raw ? raw.length : 0;
  return sysex(model, 0x01, [...inner, ...(raw ? septets(raw) : [])]);
}
function defRaw(d: { tc: number; min: number; max: number; scale?: number; def?: number; step?: number; id: number }): Uint8Array {
  const b = new Uint8Array(36);
  const v = new DataView(b.buffer);
  v.setUint32(0, d.id, true); v.setUint32(4, d.tc, true);
  v.setFloat32(8, d.min, true); v.setFloat32(12, d.max, true); v.setFloat32(16, d.scale ?? 0, true);
  v.setFloat32(20, d.def ?? 0, true); v.setFloat32(24, d.step ?? 0, true);
  return b;
}
const queryOf = (f: readonly number[]) => ({ block: (f[8]! & 0x7f) | ((f[9]! & 0x7f) << 7), param: (f[10]! & 0x7f) | ((f[11]! & 0x7f) << 7) });
const isWalkQuery = (f: readonly number[]) => f[5] === 0x01 && WALK_VIEWS.has(f[6]!);
const writesIn = (frames: readonly (readonly number[])[]) => frames.filter((f) => f[5] === 0x01 && !isWalkQuery(f));

/** A synthetic FM3 answering the extension walk's definition queries (as the walk-scope suite's dry run): a real
 *  definition for every id of a block's table (GLOBAL's low region 0..131; the amp: its seed rows, generic rows at 0..3
 *  and 128..143, unused slots between; the roster blocks above 160: their catalog stride), the empty-slot definition past
 *  a table's end, a numeric value, a no-payload label. `implausibleAt`: that definition answers with inverted bounds. */
function syntheticUnit(implausibleAt?: { block: number; param: number }): (req: readonly number[]) => number[][] {
  const P = PROFILES[FM3]!;
  const sizes = new Map<number, number>([[1, 132], [2, P.rangeSections.CONTROLLERS!.stride], [58, P.rangeSections.DISTORT!.stride]]);
  for (const [b, fam] of [[162, 'RESONATOR'], [163, 'RESONATOR'], [166, 'LOOPER'], [178, 'PLEX'], [182, 'FDBKSEND'], [183, 'FDBKSEND'], [186, 'FDBKRET'], [187, 'FDBKRET'], [191, 'MULTIPLEXER'], [192, 'MULTIPLEXER']] as const) {
    sizes.set(b, P.rangeSections[fam]!.stride);
  }
  const seeds = new Map(liveSeedRecords().filter((x) => x.section === 58).map((x) => [x.id, x]));
  const ascii = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
  return (req) => {
    const view = req[6]!;
    const { block, param } = queryOf(req);
    if (view === VIEW_DEFINITION) {
      if (implausibleAt && implausibleAt.block === block && implausibleAt.param === param) {
        return [sdReply(FM3, view, block, param, defRaw({ tc: 1, min: 10, max: 0, scale: 1, def: 1, id: 5000 + param }))];
      }
      const s = block === 58 ? seeds.get(param) : undefined;
      if (s) return [sdReply(FM3, view, block, param, defRaw({ tc: s.tc, min: s.min, max: s.max, scale: 1, def: s.def, step: s.step, id: 1000 + param }))];
      if (param < (sizes.get(block) ?? 0) && (block !== 58 || param < 4 || param >= 128)) {
        return [sdReply(FM3, view, block, param, defRaw({ tc: block === 58 ? 0 : 1, min: 0, max: 10, scale: 1, def: 1, id: 1000 + param }))];
      }
      return [sdReply(FM3, view, block, param, defRaw({ tc: 0, min: 0, max: 0, id: 0 }))];
    }
    if (view === VIEW_VALUE) return [sdReply(FM3, view, block, param, ascii('5.00'))];
    return [sdReply(FM3, view, block, param, null)];
  };
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
/** A preset dump whose routing grid holds `eids`, authored by the codec from its clean scaffold (synthetic). */
function gridDump(model: number, eids: readonly number[]): number[][] {
  const rows = PROFILES[model]!.rows;
  const cells = eids.map((effectId, i) => ({ row: i % rows, col: Math.floor(i / rows), effectId }));
  return framesOf(authorGen3PresetFromIRFull(defaultScaffoldSyx(model), { routing: { gridCells: cells } }, model).syx);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try { return await fn(); } finally { console.warn = warn; console.log = log; }
}

// ── a mocked unit behind the registry ───────────────────────────────────────────────────────────────────────────────

/** A mock that hands every reply to the onFrame handlers too, like a real transport (the wire log records RX). */
class Unit extends MockTransport {
  override async request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]> {
    const r = await super.request(bytes, opts);
    for (const f of r) this.emitFrame(f);
    return r;
  }
}

interface Rig {
  registry: DeviceRegistry;
  mock: Unit;
  events: DeviceEvent[];
  close(): Promise<void>;
}

/** A detected gen-3 unit (FM3 fw 12.0 unless given; `fw: null` = an unanswered firmware read) whose edit-buffer grid
 *  holds `placed`, answering the status dump and the bulk reads of `blocks`, and every walk query with `walkReply`
 *  (default: a no-payload echo — a liveness query is answered). `override`: the registry's walk-scope override hook. */
async function makeRig(o: {
  model?: number; fw?: readonly [number, number] | null; placed?: number[]; blocks?: Record<number, MockBlock>;
  override?: WalkScopeOverrideToken[]; walkReply?: (req: readonly number[]) => number[][];
} = {}): Promise<Rig> {
  const model = o.model ?? FM3;
  const fw = o.fw === undefined ? ([12, 0] as const) : o.fw;
  const blocks: Record<number, MockBlock> = { ...(o.blocks ?? {}) };
  const dump = gridDump(model, o.placed ?? [58]);
  const codec = createModernFractalCodec(model);
  const statusHex = compactHex(codec.buildStatusDump());
  const mock = new Unit('serial', `mock-diag-walk-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (req[0] === 0xf0 && req[5] === 0x08) return fw ? [firmwareVersionReply(model, fw[0], fw[1])] : [];
    if (req[5] === 0x03) return dumpAnswering(req, dump);
    if (isWalkQuery(req)) {
      if (o.walkReply) return o.walkReply(req);
      const { block, param } = queryOf(req);
      return [sdReply(model, req[6]!, block, param, null)];
    }
    const h = compactHex(req);
    if (h === statusHex) {
      const status: number[] = [];
      for (const [k, b] of Object.entries(blocks)) if (b.channel !== null) status.push(...enc14(Number(k)), ((b.channel ?? 0) & 0x07) << 1);
      return status.length > 0 ? [sysex(model, 0x13, status)] : [];
    }
    for (const [k, b] of Object.entries(blocks)) {
      if (h === compactHex(codec.buildBlockBulkReadPoll(Number(k)))) return b.silent ? [] : blockBulkFrames(model, Number(k), b.values, b.advertised);
    }
    return [];
  };
  const override = new Set(o.override ?? []);
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock, walkScopeOverride: () => override });
  await quietly(() => registry.detect());
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const resume = registry.pauseTelemetry();
  return {
    registry, mock, events,
    close: async () => { diag.__setCaptureOptionsForTest(registry, null); resume(); unsub(); }
  };
}

const QUICK: diag.CaptureOptions = { pacing: { interQueryMs: 0, blockPauseMs: 0 }, versions: { forgefx: '9.9.9-test' } };

async function run(registry: DeviceRegistry, body: Record<string, unknown>, opts: diag.CaptureOptions = {}): Promise<diag.CaptureBundle> {
  const r = await diag.startCapture(store.defaultStore, registry, { acknowledged: true, ...body }, { ...QUICK, ...opts });
  assertEqual(r.code, 202, `capture starts (${JSON.stringify(r.body)})`);
  await quietly(async () => { await diag.capturePromise(registry); });
  const res = diag.captureResult(registry);
  assertEqual(res.code, 200, 'a result is available after the run');
  return res.body as diag.CaptureBundle;
}
const stepOf = (b: diag.CaptureBundle, name: diag.StepName) => b.steps.find((s) => s.name === name)!;
const resultOf = (b: diag.CaptureBundle, name: diag.StepName) => (stepOf(b, name).result ?? {}) as Record<string, any>;

const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const putDoc = (doc: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, doc);
const storedJson = () => JSON.stringify(store.defaultStore.getDoc('deviceCaches', KEY) ?? null);

const ceilingOf = (o: LiveWalkOptions, block: number) => o.paramBoundByBlock?.[block] ?? o.maxParamId ?? 127;
/** A fake walk for the definition-walk steps (told apart by their options): a probe walk (one block, values read)
 *  queries ids 0..its ceiling and answers `probeRecords(block)`; an extension walk queries id 0 and the bound of every
 *  planned block and answers `extensionRecords(block)` (default none); any other walk (the standard read-only walk)
 *  answers `standardRecords` (default the editor-cache seed fixture). Every call's options are recorded. */
function planWalk(o: {
  walks?: LiveWalkOptions[]; probeRecords?: (block: number) => CacheRecord[]; extensionRecords?: (block: number) => CacheRecord[];
  standardRecords?: () => CacheRecord[];
} = {}): diag.CaptureWalkImpl {
  return async (t, opts) => {
    o.walks?.push(opts);
    const blocks = opts.blocks;
    if (!blocks) return walkResult(o.standardRecords?.() ?? cacheSeedRecords());
    if (opts.readValues && blocks.length === 1) {
      const block = blocks[0]!;
      for (let pid = 0; pid <= ceilingOf(opts, block); pid++) await t.request(buildDefQuery(opts.model, block, pid));
      return walkResult(o.probeRecords?.(block) ?? [], { queries: ceilingOf(opts, block) + 1 });
    }
    const recs: CacheRecord[] = [];
    for (const block of blocks) {
      await t.request(buildDefQuery(opts.model, block, 0));
      await t.request(buildDefQuery(opts.model, block, ceilingOf(opts, block)));
      recs.push(...(o.extensionRecords?.(block) ?? []));
    }
    return walkResult(recs, { queries: blocks.length * 2 });
  };
}
/** The codec's own walk, unpaced for the test (pacing is no part of the scope the watchdog checks). */
const realWalk: diag.CaptureWalkImpl = (t, o) => liveWalkDetailed(t, { ...o, interQueryMs: 0, blockPauseMs: 0, lostReplyDrainMs: 0 });
/** A walk that waits for its signal, then rejects (sets `entered.v` when it starts). */
const blockingWalk = (entered: { v: number }): diag.CaptureWalkImpl => (_t, o) => {
  entered.v++;
  return new Promise((_res, rej) => {
    if (o.signal?.aborted) rej(new Error('live walk aborted'));
    o.signal?.addEventListener('abort', () => rej(new Error('live walk aborted')), { once: true });
  });
};
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ── 1. opt-in only: never a default step; their place in the order ───────────────────────────────────────────────────
async function optInOnly(): Promise<void> {
  for (const s of NEW_STEPS) {
    assert(!diag.DEFAULT_STEPS.includes(s), `${s} is not a default step`);
    assert(diag.STEP_ORDER.includes(s), `${s} is a known step`);
  }
  const at = (s: diag.StepName) => diag.STEP_ORDER.indexOf(s);
  assert(at('readonlyWalk') < at('extendedWalk') && at('labelProbe') < at('extendedWalk') && at('extendedWalk') < at('above160Walk')
    && at('above160Walk') < at('blockProbe') && at('blockProbe') < at('dumpHeaderProbe') && at('blockProbe') < at('reloadProbe')
    && at('blockProbe') < at('fullWalk'), 'order: after the standard walk and the label probe, before every step that may switch presets');
  // every gate open (development override): a run that names no steps still runs the defaults only
  const r = await makeRig({ placed: [58, NEW_EID], override: ['extended', 'above160', 'probe'] });
  try {
    const walks: LiveWalkOptions[] = [];
    const b = await run(r.registry, {}, { walkImpl: planWalk({ walks }) });
    assertEqual(b.steps.map((s) => s.name).join(','), diag.DEFAULT_STEPS.join(','), 'a run without steps: the default steps only');
    assertEqual(walks.length, 1, 'one walk: the standard read-only walk');
    assertEqual(walks[0]!.blocks, undefined, 'the standard walk (no extension or probe block list)');
    const queries = r.mock.sent.filter(isWalkQuery).map(queryOf);
    assert(queries.every((q) => q.block <= 160 && q.param <= 127), 'nothing above id 127 or block 160 reached the wire');
    assertEqual(b.redaction.unscreenedLabels, undefined, 'no definition-walk step ran: no unscreened-labels mark');
    // the names are accepted, one by one
    for (const s of NEW_STEPS) {
      const one = await run(r.registry, { steps: [s] }, { walkImpl: planWalk() });
      assertEqual(one.steps.map((x) => x.name).join(','), s, `steps: ['${s}'] runs exactly that step`);
    }
  } finally { await r.close(); }
}

// ── 2. the gates: unknown firmware → skipped; unlisted → diagnostic; override; verified ─────────────────────────────
async function gatesRecorded(): Promise<void> {
  clearDoc();
  {
    const r = await makeRig({ fw: null, placed: [58, NEW_EID], override: ['extended', 'above160', 'probe'] });
    try {
      let walks = 0;
      const sent = r.mock.sent.length;
      const b = await run(r.registry, { steps: [...NEW_STEPS] }, { walkImpl: async () => { walks++; return []; } });
      for (const s of NEW_STEPS) {
        const st = stepOf(b, s);
        assertEqual(st.status, 'skipped', `${s}: skipped on an unanswered firmware read`);
        assert(/known firmware version/.test(st.note ?? ''), `${s}: the note says why (${st.note})`);
        assertEqual(JSON.stringify((st.result as { gate: unknown }).gate), JSON.stringify({ flag: { extendedWalk: 'extendedIds', above160Walk: 'above160', blockProbe: 'blockProbe' }[s], firmware: null, unverifiedScope: false }), `${s}: gate recorded without a firmware`);
        assertEqual((st.result as { labels?: string }).labels, 'unscreened', `${s}: labels marked unscreened`);
      }
      assertEqual(walks, 0, 'no walk ran');
      assertEqual(r.mock.sent.slice(sent).filter(isWalkQuery).length, 0, 'no walk query (no liveness query either)');
      assertEqual(r.mock.sent.slice(sent).filter((f) => f[5] === 0x03).length, 0, 'no grid read');
      assertEqual(`${b.state}/${b.redaction.unscreenedLabels}`, 'done/undefined', 'the run ends done; nothing talked, no unscreened-labels mark');
    } finally { await r.close(); }
  }
  {
    // the verified table is empty: without the request flag every step is skipped, nothing sent past the firmware read
    assertEqual(Object.keys(WALK_SCOPE_VERIFIED_FW).length, 0, 'premise: the verified table is empty in this build');
    const r = await makeRig({ placed: [58, NEW_EID] });
    try {
      let walks = 0;
      const sent = r.mock.sent.length;
      const b = await run(r.registry, { steps: [...NEW_STEPS] }, { walkImpl: async () => { walks++; return []; } });
      for (const s of NEW_STEPS) {
        const st = stepOf(b, s);
        assertEqual(st.status, 'skipped', `${s}: no unverifiedScope → skipped`);
        assert(/is not verified on firmware 12\.0; the request must set unverifiedScope: true/.test(st.note ?? ''), `${s}: the note says how to run it (${st.note})`);
        const gate = (st.result as { gate: Record<string, unknown> }).gate;
        assertEqual(`${gate.allowance}/${gate.unverifiedScope}`, 'diagnostic/false', `${s}: the gate and the missing flag recorded`);
      }
      assertEqual(walks, 0, 'no walk ran');
      const after = r.mock.sent.slice(sent);
      assert(after.length > 0 && after.every((f) => f[5] === 0x08), 'nothing but the firmware reads went out');
      assertEqual(b.redaction.unscreenedLabels, undefined, 'no unscreened-labels mark');
      // with the flag: the step runs read-only as diagnostic evidence, and says so
      const b2 = await run(r.registry, { steps: ['extendedWalk'], ...U }, { walkImpl: planWalk() });
      assertEqual(stepOf(b2, 'extendedWalk').status, 'ok', 'unlisted firmware + unverifiedScope: the step runs');
      assertEqual(JSON.stringify(resultOf(b2, 'extendedWalk').gate), JSON.stringify({ flag: 'extendedIds', firmware: '12.0', verified: false, devOverride: false, unverifiedScope: true, allowance: 'diagnostic' }), 'gate: diagnostic, flag recorded');
      assert(b2.logs.some((l) => l.level === 'warn' && /extendedIds is not verified on firmware 12\.0: read-only diagnostic run/.test(l.msg)), 'the job log says it');
      assertEqual(`${resultOf(b2, 'extendedWalk').labels}/${b2.redaction.unscreenedLabels}`, 'unscreened/true', 'labels unscreened, the bundle says so');
      // the flag must be a boolean (both twins: the routes hand the body to the same start)
      const bad = await diag.startCapture(store.defaultStore, r.registry, { acknowledged: true, steps: ['extendedWalk'], unverifiedScope: 'yes' }, QUICK);
      assertEqual(`${bad.code}/${(bad.body as { error: string }).error}`, '400/invalid-request', 'a non-boolean unverifiedScope → 400 invalid-request');
      assertEqual((await diag.startCapture(store.defaultStore, r.registry, { acknowledged: true, steps: ['extendedWalk'], unverifiedScope: 1 }, QUICK)).code, 400, 'a number → 400');
      assertEqual(diag.captureStatus(r.registry).state, 'done', 'no run was started by a refused request');
    } finally { await r.close(); }
  }
  {
    const r = await makeRig({ override: ['extended'] });
    try {
      const b = await run(r.registry, { steps: ['extendedWalk', 'above160Walk'] }, { walkImpl: planWalk() });
      assertEqual(`${resultOf(b, 'extendedWalk').gate.allowance}/${resultOf(b, 'extendedWalk').gate.devOverride}/${stepOf(b, 'extendedWalk').status}`, 'dev-override/true/ok', 'override: dev-override runs without the flag');
      assertEqual(`${resultOf(b, 'above160Walk').gate.allowance}/${stepOf(b, 'above160Walk').status}`, 'diagnostic/skipped', 'a flag the override does not name: diagnostic, skipped without unverifiedScope');
    } finally { await r.close(); }
  }
  {
    const table = WALK_SCOPE_VERIFIED_FW as Record<number, unknown>;
    table[FM3] = { extendedIds: [{ major: 12, minor: 0 }], above160: [], blockProbe: [], farIds: [] };
    const r = await makeRig();
    try {
      const b = await run(r.registry, { steps: ['extendedWalk'] }, { walkImpl: planWalk() });
      assertEqual(JSON.stringify(resultOf(b, 'extendedWalk').gate), JSON.stringify({ flag: 'extendedIds', firmware: '12.0', verified: true, devOverride: false, unverifiedScope: false, allowance: 'verified' }), 'a table entry: verified (no flag needed)');
      assertEqual(stepOf(b, 'extendedWalk').status, 'ok', 'verified: runs');
    } finally { delete table[FM3]; await r.close(); }
  }
}

// ── 3. extendedWalk + above160Walk: the codec's walk on a synthetic unit, nothing stored ─────────────────────────────
async function extensionWalks(): Promise<void> {
  clearDoc();
  // a stored live profile (never a source of walk bounds): it must stay byte-identical
  putDoc(profileDoc([liveSource(liveSeedRecords())]));
  const r = await makeRig({ walkReply: syntheticUnit() });
  try {
    await r.registry.applyRuntimeCache();
    const before = storedJson();
    const profileBefore = r.registry.profile;
    const sent = r.mock.sent.length;
    const b = await run(r.registry, { steps: ['extendedWalk', 'above160Walk'], ...U }, { walkImpl: realWalk });
    assertEqual(b.state, 'done', 'run done');
    const ext = resultOf(b, 'extendedWalk');
    assertEqual(stepOf(b, 'extendedWalk').status, 'ok', `extendedWalk ok (${stepOf(b, 'extendedWalk').error})`);
    assertEqual(`${ext.outcome}/${ext.passed}/${ext.emptyBlockCheck}`, 'done/true/not-run', 'extension done and passed; no standard walk in the run to compare with');
    assertEqual(ext.plan.blocks.join(','), FM3_EXTENDED.join(','), 'plan: GLOBAL, CONTROLLERS, the amp (blocks 0..160 only)');
    assertEqual(`${ext.plan.bounds[1]}/${ext.plan.bounds[2]}/${ext.plan.bounds[58]}/${ext.plan.knownSize[58]}`, '163/161/175/144', 'plan: the build\'s extended bounds');
    assertEqual(ext.plan.budget, deviceCache.extensionWalkSetup(store.defaultStore, FM3, { major: 12, minor: 0 }, { extendedIds: true, above160: false, farIds: false }, 'read-only').budget, 'plan: the build\'s query budget');
    const amp = (ext.blocks as Array<{ block: number; lastReal: number | null; family: string }>).find((x) => x.block === 58)!;
    assertEqual(`${amp.family}/${amp.lastReal}`, 'DISTORT/143', 'the amp table read to id 143');
    const src = ext.source as LiveRawSource;
    assertEqual(`${src.kind}/${src.origin}/${src.scope.extended}/${src.scope.above160}/${src.scope.blocks.join(',')}/${src.firmware}`, `live-readonly/local/true/false/${FM3_EXTENDED.join(',')}/12.0`, 'records as a live-readonly raw source');
    assert(src.records.some((x) => x.section === 58 && x.id === 143), 'the source carries the rows above 127');
    const a160 = resultOf(b, 'above160Walk');
    assertEqual(stepOf(b, 'above160Walk').status, 'ok', `above160Walk ok (${stepOf(b, 'above160Walk').error})`);
    assertEqual(a160.plan.blocks.join(','), FM3_ABOVE160.join(','), 'plan: the present roster blocks above 160');
    assertEqual(`${a160.passed}/${a160.emptyBlockCheck}/${a160.walk.lostReplies}/${a160.walk.pseudoReplies.implausible}`, 'true/not-applicable/0/0', 'above 160: passed (the hardware-check criteria), no empty-block comparison');
    assert(FM3_ABOVE160.every((bl) => a160.plan.bounds[bl] <= 127), 'above 160: the standard ceiling (no extended ids)');
    assertEqual(`${a160.source.scope.above160}/${a160.source.scope.extended}`, 'true/false', 'above-160 source scope');
    // the wire: every planned block queried to exactly its bound, nothing outside the plans, no write
    const frames = r.mock.sent.slice(sent);
    const maxBy = new Map<number, number>();
    for (const q of frames.filter(isWalkQuery).map(queryOf)) maxBy.set(q.block, Math.max(maxBy.get(q.block) ?? -1, q.param));
    for (const bl of FM3_EXTENDED) assertEqual(maxBy.get(bl), ext.plan.bounds[bl], `block ${bl} queried up to exactly its bound`);
    for (const bl of FM3_ABOVE160) assertEqual(maxBy.get(bl), a160.plan.bounds[bl], `block ${bl} queried up to exactly its bound`);
    const live = diag.livenessAddress(FM3);
    assert([...maxBy.keys()].every((bl) => FM3_EXTENDED.includes(bl) || FM3_ABOVE160.includes(bl) || bl === live.block), `only planned blocks queried (${[...maxBy.keys()].join(',')})`);
    assertEqual(writesIn(frames).length, 0, 'no write frame');
    // nothing stored, nothing applied, no definitions event
    assertEqual(storedJson(), before, 'the stored profile is byte-identical');
    assert(r.registry.profile === profileBefore, 'the runtime profile is not swapped');
    assert(!r.events.some((e) => e.type === 'definitions' || e.type === 'cacheBuild'), 'no definitions / cacheBuild event');
  } finally { await r.close(); clearDoc(); }
  // an implausible reply at id 140: the step fails with the build's abort reason, the run carries on
  const r2 = await makeRig({ walkReply: syntheticUnit({ block: 58, param: 140 }) });
  try {
    const sent = r2.mock.sent.length;
    const b = await run(r2.registry, { steps: ['extendedWalk', 'above160Walk'], ...U }, { walkImpl: realWalk });
    const ext = stepOf(b, 'extendedWalk');
    assertEqual(ext.status, 'failed', 'implausible at 140: the step fails');
    assertEqual(resultOf(b, 'extendedWalk').passed, false, 'not passed');
    assertEqual(ext.error, 'implausible-reply (block 58, param 140)', 'the build\'s abort reason');
    assertEqual(`${resultOf(b, 'extendedWalk').outcome}/${resultOf(b, 'extendedWalk').abortReason}`, 'aborted/implausible-reply (block 58, param 140)', 'recorded in the result');
    const amp = r2.mock.sent.slice(sent).filter(isWalkQuery).map(queryOf).filter((q) => q.block === 58 && q.param > 0);
    assertEqual(Math.max(...amp.map((q) => q.param)), 140, 'nothing queried in the amp past the implausible reply');
    assertEqual(stepOf(b, 'above160Walk').status, 'ok', 'the unit answered the liveness check: the next step ran');
    assertEqual(`${b.state}/${b.abortReason}`, 'done/undefined', 'the run is done, not aborted');
  } finally { await r2.close(); }
}

// ── 4. the extension's other abort rules in the step: the query budget, a block the standard walk lost ─────────────
async function extensionAbortRules(): Promise<void> {
  clearDoc();
  const r = await makeRig();
  try {
    let refusedAt = -1;
    const greedy: diag.CaptureWalkImpl = async (t, o) => {
      if (!o.blocks || o.readValues) return walkResult(cacheSeedRecords());
      if (o.blocks.includes(162)) return walkResult([]); // the above-160 walk: quiet
      for (let i = 0; ; i++) {
        try { await t.request(buildDefQuery(FM3, 58, i % 176)); } catch (e) { refusedAt = i; throw e; }
      }
    };
    const sent = r.mock.sent.length;
    const b = await run(r.registry, { steps: ['extendedWalk', 'above160Walk'], ...U }, { walkImpl: greedy });
    const ext = resultOf(b, 'extendedWalk');
    assertEqual(stepOf(b, 'extendedWalk').status, 'failed', 'past the budget: the step fails');
    assertEqual(`${ext.passed}/${resultOf(b, 'above160Walk').passed}`, 'false/false', 'neither passed (the budget; an above-160 walk without a single real table)');
    assertEqual(stepOf(b, 'extendedWalk').error, `query-budget (${ext.plan.budget} queries)`, 'the build\'s abort reason');
    assertEqual(refusedAt, ext.plan.budget, 'the first query past the budget is refused');
    assertEqual(diag.livenessAddress(FM3).block, 58, 'premise: the liveness query reads the amp block');
    assertEqual(r.mock.sent.slice(sent).filter((f) => isWalkQuery(f) && queryOf(f).block === 58).length, ext.plan.budget + 1,
      'exactly the budget went out, plus the liveness query after the failed step');
    assertEqual(stepOf(b, 'above160Walk').status, 'ok', 'the run carried on');
    // a block this run's standard walk found definitions in that the extension answered none for
    const withAmp = (): CacheRecord[] => [...cacheSeedRecords(), F(58, 0, 0x31, 0, 10, 1, 0)];
    const b2 = await run(r.registry, { steps: ['readonlyWalk', 'extendedWalk'], ...U }, { walkImpl: planWalk({ standardRecords: withAmp }) });
    assertEqual(stepOf(b2, 'readonlyWalk').status, 'ok', `premise: the standard walk ran (${stepOf(b2, 'readonlyWalk').error})`);
    assertEqual(`${stepOf(b2, 'extendedWalk').status}/${stepOf(b2, 'extendedWalk').error}`, 'failed/empty-block (block 58)', 'an emptied block fails the step');
    assertEqual(`${resultOf(b2, 'extendedWalk').outcome}/${resultOf(b2, 'extendedWalk').emptyBlockCheck}/${resultOf(b2, 'extendedWalk').passed}`, 'aborted/failed/false', 'outcome aborted, the comparison failed');
    assert(resultOf(b2, 'extendedWalk').source !== undefined, 'what the extension read is still in the bundle');
    // the extension keeps the amp's table: the comparison passes
    const amp = (bl: number) => (bl === 58 ? [F(58, 0, 0x31, 0, 10, 1, 0), F(58, 130, 0x31, 0, 10, 1, 0)] : [F(bl, 0, 0x31, 0, 10, 1, 0)]);
    const b4 = await run(r.registry, { steps: ['readonlyWalk', 'extendedWalk'], ...U }, { walkImpl: planWalk({ standardRecords: withAmp, extensionRecords: amp }) });
    assertEqual(`${stepOf(b4, 'extendedWalk').status}/${resultOf(b4, 'extendedWalk').emptyBlockCheck}/${resultOf(b4, 'extendedWalk').passed}`, 'ok/passed/true', 'the comparison passed');
    // the same extension without a standard walk in the run: nothing to compare with, done
    const b3 = await run(r.registry, { steps: ['extendedWalk'], ...U }, { walkImpl: planWalk() });
    assertEqual(`${stepOf(b3, 'extendedWalk').status}/${resultOf(b3, 'extendedWalk').outcome}/${resultOf(b3, 'extendedWalk').emptyBlockCheck}`, 'ok/done/not-run', 'no standard walk in the run: done, the comparison not run');
  } finally { await r.close(); }
}

// ── 5. blockProbe: fresh grid read, above 160 only once shown safe, the probe walk, nothing stored ───────────────────
async function blockProbeSteps(): Promise<void> {
  clearDoc();
  const r = await makeRig({ placed: [58, NEW_EID], blocks: { [NEW_EID]: { values: newBody(), channel: 1 } } });
  try {
    putDoc(await byteDoc());
    await r.registry.applyRuntimeCache();
    const before = storedJson();
    const profileBefore = r.registry.profile;
    const driver = await r.registry.driver();
    await driver.grid(); // a cached grid read: the step must read afresh anyway
    r.events.length = 0; // (that read announced the unmapped placed block; the step's own read announces nothing)
    // alone: the only target lies above 160 and nothing showed reads there safe → skipped, never walked
    let walks: LiveWalkOptions[] = [];
    let sent = r.mock.sent.length;
    let b = await run(r.registry, { steps: ['blockProbe'], ...U }, { walkImpl: planWalk({ walks, probeRecords: (bl) => newBlock(bl, true) }) });
    let st = stepOf(b, 'blockProbe');
    assertEqual(st.status, 'skipped', 'alone: skipped');
    assert(/above effect id 160; run above160Walk/.test(st.note ?? ''), `alone: the note says what to do (${st.note})`);
    let res = resultOf(b, 'blockProbe');
    assertEqual(`${res.placedBlocks}/${res.above160}/${res.targets.length}/${res.targets[0].eid}/${res.targets[0].kind}/${res.targets[0].status}`, `2/not-shown/1/${NEW_EID}/unknown/skipped`, 'alone: the target, skipped');
    assertEqual(walks.length, 0, 'alone: no probe walk');
    assert(r.mock.sent.slice(sent).some((f) => f[5] === 0x03 && f[6] === 0x7f && f[7] === 0x7f), 'a fresh edit-buffer grid read went out (the cached read was not used)');
    assert(!r.mock.sent.slice(sent).some((f) => isWalkQuery(f) && queryOf(f).block === NEW_EID), 'alone: block 203 never queried');
    // after above160Walk PASSED in the same run (a real table in every block, no loss): probed
    walks = [];
    sent = r.mock.sent.length;
    b = await run(r.registry, { steps: ['above160Walk', 'blockProbe'], ...U }, { walkImpl: planWalk({ walks, probeRecords: (bl) => newBlock(bl, true), extensionRecords: tableOf }) });
    assertEqual(`${stepOf(b, 'above160Walk').status}/${resultOf(b, 'above160Walk').passed}`, 'ok/true', 'above160Walk ok and passed');
    st = stepOf(b, 'blockProbe');
    assertEqual(st.status, 'ok', `probe step ok (${st.error ?? st.note})`);
    res = resultOf(b, 'blockProbe');
    assertEqual(res.above160, 'this-run', 'above 160 shown safe by this run');
    const t = res.targets[0];
    assertEqual(`${t.eid}/${t.kind}/${t.status}/${t.ceiling}/${t.ceilingFrom}/${JSON.stringify(t.fits)}/${t.aliveAfter}`, `${NEW_EID}/unknown/ok/${STRIDE - 1 + 32}/shape/[{"tag":${NEW_TAG},"stride":${STRIDE}}]/true`, 'the target: probed with the shape ceiling, alive after');
    const w = walks.find((x) => x.readValues)!;
    assertEqual(`${JSON.stringify(w.blocks)}/${w.maxParamId}/${w.readValues}/${w.mode}/${w.write}/${w.paramKnownSizeByBlock}/${w.paramBoundByBlock}/${w.enumHintByBlock}`,
      `[${NEW_EID}]/${STRIDE - 1 + 32}/true/undefined/undefined/undefined/undefined/undefined`, 'the probe route\'s walk options');
    const probeQs = r.mock.sent.slice(sent).filter(isWalkQuery).map(queryOf).filter((q) => q.block === NEW_EID);
    assertEqual(`${probeQs.length}/${Math.max(...probeQs.map((q) => q.param))}`, `${STRIDE + 32}/${STRIDE - 1 + 32}`, 'every probe query within its ceiling');
    const src = t.source as LiveRawSource;
    assertEqual(`${src.kind}/${src.scope.blocks.join(',')}/${src.scope.maxParamId}/${src.scope.above160}/${src.scope.hinted}/${src.records.length}`, `live-probe/${NEW_EID}/${STRIDE - 1 + 32}/true/false/${STRIDE}`, 'records as a live-probe raw source');
    assertEqual(`${t.blockMap.confidence}/${t.blockMap.key}/${t.blockMap.evidence.join('+')}`, `confirmed/section:${NEW_TAG}/device-records`, 'the would-be block map');
    assertEqual(writesIn(r.mock.sent.slice(sent)).length, 0, 'no write frame');
    assertEqual(storedJson(), before, 'the stored profile is byte-identical (no probe source stored)');
    assert(r.registry.profile === profileBefore, 'the runtime profile is not swapped');
    assert(!r.events.some((e) => e.type === 'definitions'), 'no definitions event mid-run (no stored probe, a silent grid read)');
  } finally { await r.close(); clearDoc(); }
}

/** One real row per block: what a passing extension walk reports for every planned block. */
const tableOf = (bl: number): CacheRecord[] => [F(bl, 0, 0x31, 0, 10, 1, 0)];

// ── 5b. the above-160 clearance: only an above160Walk that PASSED clears a probe above 160 ───────────────────────────
async function above160Clearance(): Promise<void> {
  const variants: Array<{ what: string; steps: diag.StepName[]; override?: WalkScopeOverrideToken[]; flag: boolean; walk: diag.CaptureWalkImpl; a160: string }> = [
    {
      what: 'an implausible reply', steps: ['above160Walk', 'blockProbe'], flag: true, a160: 'ok/false',
      walk: planWalkWith({ pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 1 } })
    },
    { what: 'a lost reply', steps: ['above160Walk', 'blockProbe'], flag: true, a160: 'ok/false', walk: planWalkWith({ lostReplies: 1 }) },
    { what: 'an unresolved reply', steps: ['above160Walk', 'blockProbe'], flag: true, a160: 'ok/false', walk: planWalkWith({ unresolvedReplies: 1 }) },
    { what: 'a block without a real table', steps: ['above160Walk', 'blockProbe'], flag: true, a160: 'ok/false', walk: planWalkWith({}, (bl) => (bl === 192 ? [] : tableOf(bl))) },
    {
      what: 'a failed above160Walk', steps: ['above160Walk', 'blockProbe'], flag: true, a160: 'failed/false',
      walk: async (t, o) => { if (o.blocks && !o.readValues) throw new LiveWalkAbortError('silent-run', 162, 3); return planWalk()(t, o); }
    },
    // the probe opened by the override (no flag needed for it), the above-160 walk not: skipped without the flag
    { what: 'a skipped above160Walk', steps: ['above160Walk', 'blockProbe'], override: ['probe'], flag: false, a160: 'skipped/undefined', walk: planWalk() }
  ];
  for (const v of variants) {
    const r = await makeRig({ placed: [58, NEW_EID], override: v.override ?? [] });
    try {
      const sent = r.mock.sent.length;
      const b = await run(r.registry, { steps: v.steps, ...(v.flag ? U : {}) }, { walkImpl: v.walk });
      assertEqual(`${stepOf(b, 'above160Walk').status}/${resultOf(b, 'above160Walk').passed}`, v.a160, `${v.what}: the above-160 walk's outcome`);
      const res = resultOf(b, 'blockProbe');
      assertEqual(`${stepOf(b, 'blockProbe').status}/${res.above160}/${res.targets[0].status}`, 'skipped/not-shown/skipped', `${v.what}: the probe above 160 is not cleared`);
      assert(!r.mock.sent.slice(sent).some((f) => isWalkQuery(f) && queryOf(f).block === NEW_EID), `${v.what}: block ${NEW_EID} never queried`);
    } finally { await r.close(); }
  }
}

/** `planWalk` whose extension walk reports `stats` (and `records`, default one real row per block). */
function planWalkWith(stats: Partial<Parameters<typeof walkResult>[1]>, records: (block: number) => CacheRecord[] = tableOf): diag.CaptureWalkImpl {
  const inner = planWalk({ extensionRecords: records });
  return async (t, o) => {
    const r = await inner(t, o);
    return o.blocks && !o.readValues && !Array.isArray(r) ? { ...r, ...stats } : r;
  };
}

// ── 6. blockProbe on an Axe-Fx III: a roster-only block is a target; up to 160 it needs no above-160 evidence ───────
async function blockProbeRoster(): Promise<void> {
  const ref = staticRoster(AXE3).get(134);
  assert(ref?.roster === true, 'premise: the III names effect id 134 from the block roster only');
  assert(staticRoster(AXE3).get(36)?.roster === true, 'premise: and effect id 36 (a virtual block) too');
  const stride = PROFILES[AXE3]!.rangeSections[ref.family]!.stride;
  const r = await makeRig({ model: AXE3, fw: [33, 0], placed: [36, 134] });
  try {
    const walks: LiveWalkOptions[] = [];
    const b = await run(r.registry, { steps: ['blockProbe'], ...U }, { walkImpl: planWalk({ walks }) });
    const st = stepOf(b, 'blockProbe');
    assertEqual(st.status, 'ok', `III: probed (${st.error ?? st.note})`);
    const res = resultOf(b, 'blockProbe');
    assertEqual(res.targets.map((x: { eid: number }) => x.eid).join(','), '134', 'III: the virtual block is never a target');
    const t = res.targets[0];
    assertEqual(`${res.gate.allowance}/${res.gate.firmware}/${res.above160}`, 'diagnostic/33.0/not-shown', 'III: diagnostic evidence run');
    assertEqual(`${t.eid}/${t.kind}/${t.family}/${t.status}/${t.fits}`, `134/roster/${ref.family}/ok/null`, 'III: the roster-only block, no fitting section');
    assertEqual(`${t.ceiling}/${t.ceilingFrom}`, `${Math.min(stride - 1 + 32, 127)}/catalog`, 'III: sized by its family\'s catalog stride');
    const w = walks.filter((x) => x.readValues);
    assertEqual(`${w.length}/${w[0]!.maxParamId}`, `1/${Math.min(stride - 1 + 32, 127)}`, 'one probe walk, to that ceiling');
    assert(!r.mock.sent.some((f) => isWalkQuery(f) && queryOf(f).block === 36), 'the virtual block never queried');
  } finally { await r.close(); }
}

// ── 7. an abort mid-step leaves a bundle: cancel during an extension walk and during a probe walk ───────────────────
async function abortLeavesBundle(): Promise<void> {
  {
    const r = await makeRig();
    try {
      const entered = { v: 0 };
      const go = await diag.startCapture(store.defaultStore, r.registry, { acknowledged: true, steps: ['info', 'extendedWalk', 'above160Walk'], ...U }, { ...QUICK, walkImpl: blockingWalk(entered) });
      assertEqual(go.code, 202, 'started');
      await until(() => entered.v > 0, 'the extension walk');
      diag.cancelCapture(r.registry);
      await diag.capturePromise(r.registry);
      const b = diag.captureResult(r.registry).body as diag.CaptureBundle;
      assertEqual(`${b.state}/${b.abortReason}`, 'cancelled/cancelled', 'bundle: cancelled');
      assertEqual(stepOf(b, 'info').status, 'ok', 'the step done before is kept');
      assertEqual(stepOf(b, 'extendedWalk').status, 'aborted', 'the running step: aborted');
      const res = resultOf(b, 'extendedWalk');
      assert(res.gate?.allowance === 'diagnostic' && Array.isArray(res.plan?.blocks), 'the aborted step keeps its gate and plan');
      assertEqual(`${stepOf(b, 'above160Walk').status}/${stepOf(b, 'above160Walk').note}`, 'skipped/not run: cancelled', 'the later step: skipped');
      assert(b.frames.length > 0, 'frames up to the cancel kept');
      assertEqual(deviceBusy(r.registry), null, 'device released');
    } finally { await r.close(); }
  }
  {
    const r = await makeRig({ placed: [58, NEW_EID], override: ['above160', 'probe'] });
    try {
      const entered = { v: 0 };
      const go = await diag.startCapture(store.defaultStore, r.registry, { acknowledged: true, steps: ['blockProbe', 'dumpHeaderProbe'] }, { ...QUICK, walkImpl: blockingWalk(entered) });
      assertEqual(go.code, 202, 'started');
      await until(() => entered.v > 0, 'the probe walk');
      diag.cancelCapture(r.registry);
      await diag.capturePromise(r.registry);
      const b = diag.captureResult(r.registry).body as diag.CaptureBundle;
      assertEqual(`${b.state}/${stepOf(b, 'blockProbe').status}/${stepOf(b, 'dumpHeaderProbe').status}`, 'cancelled/aborted/skipped', 'probe cancelled: bundle, step aborted, the rest skipped');
      const res = resultOf(b, 'blockProbe');
      assertEqual(`${res.above160}/${res.targets[0].eid}/${res.targets[0].status}/${res.targets[0].reason}/${res.targets[0].ceiling}`, `dev-override/${NEW_EID}/aborted/not finished: cancelled/127`, 'the target the cancel interrupted: aborted');
      assertEqual(b.redaction.unscreenedLabels, true, 'the aborted step talked: unscreened-labels mark');
      assertEqual(deviceBusy(r.registry), null, 'device released');
    } finally { await r.close(); }
  }
}

// ── 8. the bound watchdog: an out-of-plan query is never sent; the run aborts 'query-bound' with a bundle ───────────
async function boundWatchdog(): Promise<void> {
  const cases: Array<{ what: string; step: diag.StepName; query: () => Uint8Array; swallow?: boolean }> = [
    { what: 'above the amp\'s extended bound (175)', step: 'extendedWalk', query: () => buildDefQuery(FM3, 58, 176) },
    { what: 'a block outside the extension plan', step: 'extendedWalk', query: () => buildDefQuery(FM3, 70, 0) },
    { what: 'above the 127 cap of a block above 160', step: 'above160Walk', query: () => buildDefQuery(FM3, 162, 128) },
    { what: 'a refusal the walk swallowed', step: 'extendedWalk', query: () => buildDefQuery(FM3, 58, 200), swallow: true },
    { what: 'above the probe ceiling', step: 'blockProbe', query: () => buildDefQuery(FM3, NEW_EID, 128) }
  ];
  for (const c of cases) {
    const r = await makeRig({ placed: [58, NEW_EID], override: ['above160', 'probe'] });
    try {
      const bad = c.query();
      const faulty: diag.CaptureWalkImpl = async (t, o) => {
        if (!o.blocks) return walkResult(cacheSeedRecords());
        await t.request(buildDefQuery(FM3, o.blocks[0]!, 0)); // in plan
        if (c.swallow) {
          try { await t.request(bad); } catch { /* a faulty walk that carries on */ }
          return walkResult([]);
        }
        await t.request(bad);
        return walkResult([]);
      };
      const b = await run(r.registry, { steps: ['info', c.step, 'dumpHeaderProbe'], ...U }, { walkImpl: faulty });
      assertEqual(`${b.state}/${b.abortReason}`, 'failed/query-bound', `${c.what}: the run aborts as query-bound`);
      assertEqual(stepOf(b, c.step).status, 'aborted', `${c.what}: the step aborted`);
      assertEqual(`${stepOf(b, 'info').status}/${stepOf(b, 'dumpHeaderProbe').status}`, 'ok/skipped', `${c.what}: earlier result kept, later step skipped`);
      const hex = compactHex([...bad]);
      assert(!r.mock.sent.some((f) => compactHex(f) === hex), `${c.what}: the query never reached the wire`);
      assert(resultOf(b, c.step).gate !== undefined, `${c.what}: the step's gate is in the bundle`);
    } finally { await r.close(); }
  }
}

// ── 9. probe timeout: the walk itself is stopped, the step stops at that block, the run carries on ─────────────────
async function probeTimeout(): Promise<void> {
  const r = await makeRig({ placed: [58, NEW_EID], override: ['above160', 'probe'] });
  try {
    const entered = { v: 0 };
    let sawAbort = false;
    const walk: diag.CaptureWalkImpl = (t, o) => {
      o.signal?.addEventListener('abort', () => { sawAbort = true; }, { once: true });
      return blockingWalk(entered)(t, o);
    };
    // a short release grace: a walk nobody stopped would be left behind (and the device released anyway)
    const b = await run(r.registry, { steps: ['blockProbe', 'dumpHeaderProbe'] }, { walkImpl: walk, probeTimeoutMs: 50, releaseGraceMs: 20 });
    const st = stepOf(b, 'blockProbe');
    assertEqual(`${st.status}/${st.error}`, `failed/the probe of block ${NEW_EID} did not finish (probe-timeout)`, 'a probe past its time: the step fails');
    assertEqual(resultOf(b, 'blockProbe').targets[0].status, 'timeout', 'the target: timeout');
    assertEqual(sawAbort, true, 'the timed-out walk saw its abort signal (it is stopped, not left on the link)');
    assertEqual(stepOf(b, 'dumpHeaderProbe').status, 'ok', 'the unit answered the liveness check: the run carried on');
    assertEqual(b.state, 'done', 'run done');
    assertEqual(deviceBusy(r.registry), null, 'device released');
  } finally { await r.close(); }
}

// ── 9b. a probed block after which the unit stops answering: the run ends as 'device-silent' with a bundle ─────────
async function silentAfterProbe(): Promise<void> {
  const state = { silent: false };
  const r = await makeRig({
    placed: [58, NEW_EID], override: ['above160', 'probe'],
    walkReply: (req) => (state.silent ? [] : [sdReply(FM3, req[6]!, queryOf(req).block, queryOf(req).param, null)])
  });
  try {
    const probe = planWalk();
    const walk: diag.CaptureWalkImpl = async (t, o) => { const res = await probe(t, o); state.silent = true; return res; };
    const b = await run(r.registry, { steps: ['blockProbe', 'dumpHeaderProbe'] }, { walkImpl: walk });
    assertEqual(`${b.state}/${b.abortReason}`, 'failed/device-silent', 'no liveness reply after the probe: the run ends device-silent');
    const t = resultOf(b, 'blockProbe').targets[0];
    assertEqual(`${t.eid}/${t.status}/${t.aliveAfter}`, `${NEW_EID}/ok/false`, 'the probe itself is kept, the failed liveness recorded');
    assertEqual(`${stepOf(b, 'blockProbe').status}/${stepOf(b, 'dumpHeaderProbe').status}`, 'aborted/skipped', 'the step aborted, the rest skipped');
    assertEqual(deviceBusy(r.registry), null, 'device released');
  } finally { await r.close(); }
}

// ── 10. both twins alike; the Remote relay refuses the start ────────────────────────────────────────────────────────
async function twinsAndRemote(): Promise<void> {
  const r = await makeRig({ placed: [58, NEW_EID] });
  const app = await buildApp(r.registry);
  try {
    diag.__setCaptureOptionsForTest(r.registry, { ...QUICK, walkImpl: planWalk({ extensionRecords: tableOf }) });
    // a non-boolean unverifiedScope: 400 invalid-request on both twins, nothing started
    const badBody = { acknowledged: true, steps: ['extendedWalk'], unverifiedScope: 'true' };
    const badApp = await app.inject({ method: 'POST', url: '/diagnostics/capture', payload: badBody });
    assertEqual(`${badApp.statusCode}/${(badApp.json() as { error: string }).error}`, '400/invalid-request', 'app: 400 invalid-request');
    const routerBad = createRouter({ registry: r.registry, store: store.defaultStore });
    const badRouter = await routerBad.handle('POST', '/diagnostics/capture', JSON.stringify(badBody));
    assertEqual(`${badRouter.status}/${(JSON.parse(badRouter.body as string) as { error: string }).error}`, '400/invalid-request', 'router: 400 invalid-request');
    assertEqual(diag.capturePromise(r.registry), null, 'nothing started');
    const body = { acknowledged: true, steps: ['extendedWalk', 'above160Walk', 'blockProbe'], ...U };
    const a = await app.inject({ method: 'POST', url: '/diagnostics/capture', payload: body });
    assertEqual(a.statusCode, 202, 'app: 202');
    await quietly(async () => { await diag.capturePromise(r.registry); });
    const viaApp = (await app.inject({ method: 'GET', url: '/diagnostics/capture/result' })).json() as diag.CaptureBundle;
    const router = createRouter({ registry: r.registry, store: store.defaultStore });
    const rr = await router.handle('POST', '/diagnostics/capture', JSON.stringify(body));
    assertEqual(rr.status, 202, 'router: 202');
    await quietly(async () => { await diag.capturePromise(r.registry); });
    const viaRouter = JSON.parse((await router.handle('GET', '/diagnostics/capture/result')).body as string) as diag.CaptureBundle;
    for (const s of NEW_STEPS) {
      const x = stepOf(viaApp, s);
      const y = stepOf(viaRouter, s);
      assertEqual(`${x.status}/${x.note}/${x.error}`, `${y.status}/${y.note}/${y.error}`, `${s}: same outcome on both twins`);
      const rx = (x.result ?? {}) as Record<string, unknown>;
      const ry = (y.result ?? {}) as Record<string, unknown>;
      assertEqual(JSON.stringify(rx.gate), JSON.stringify(ry.gate), `${s}: same gate`);
      // the raw sources carry their capture time (and an id derived from it): everything else is the same
      const timeless = (v: unknown) => JSON.stringify(v, (k, x: unknown) => (k === 'capturedAt' || (k === 'id' && typeof x === 'string') ? undefined : x));
      assertEqual(timeless(rx.plan ?? rx.targets), timeless(ry.plan ?? ry.targets), `${s}: same plan / targets`);
    }
    assertEqual(`${stepOf(viaApp, 'extendedWalk').status}/${stepOf(viaApp, 'above160Walk').status}/${stepOf(viaApp, 'blockProbe').status}`, 'ok/ok/ok', 'all three ran');
    for (const path of ['/diagnostics/capture', '/diagnostics/capture/cancel', '/diagnostics/capture/upload']) {
      assertEqual(remoteAllowed('POST', path), false, `Remote: POST ${path} refused`);
    }
  } finally { await app.close(); await r.close(); }
}

// ── 11. redaction applies to the new steps' traffic (the probe step's grid read) ───────────────────────────────────
async function redactionApplies(): Promise<void> {
  const r = await makeRig({ placed: [58, NEW_EID], override: ['above160', 'probe'] });
  try {
    const b = await run(r.registry, { steps: ['blockProbe'] }, { walkImpl: planWalk() });
    const chunks = b.frames.filter((f) => f.dir === 'RX' && (f.hex.slice(10, 12) === '78' || f.hex.slice(10, 12) === '79'));
    assert(chunks.length > 0, 'the grid read\'s dump frames are in the wire log');
    assert(chunks.every((f) => f.hex.length === 16 && typeof f.len === 'number' && f.len > 8), 'dump frames cut to 8 bytes + length');
    assertEqual(b.redaction.dumpPayloadFrames, chunks.length, 'counted');
    assert(b.frames.some((f) => f.dir === 'TX' && queryOf(Array.from(Buffer.from(f.hex, 'hex'))).block === NEW_EID), 'the probe queries are in the wire log');
    assert(!JSON.stringify(b).includes(r.mock.label), 'no port name in the bundle');
    // label and value text is kept verbatim (no frame-level label redaction): the bundle and the step say so
    assertEqual(`${resultOf(b, 'blockProbe').labels}/${b.redaction.unscreenedLabels}`, 'unscreened/true', 'labels marked unscreened');
  } finally { await r.close(); }
}

export async function runDiagnosticWalkStepsTests(): Promise<void> {
  await optInOnly();
  await gatesRecorded();
  await extensionWalks();
  await extensionAbortRules();
  await blockProbeSteps();
  await above160Clearance();
  await blockProbeRoster();
  await abortLeavesBundle();
  await boundWatchdog();
  await probeTimeout();
  await silentAfterProbe();
  await twinsAndRemote();
  await redactionApplies();
}
