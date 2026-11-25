// GET /device/definitions/diff (M3 WP-F3): the bundled catalog against the applied profile, through the pure builder
// (drivers/definitionsDiff.ts) and through both route twins over a real gen-3 driver on a MockTransport. Covers:
//   - the catalog read back as a byte-exact profile, and no profile at all on the catalog firmware → `state: 'none'`,
//     an empty diff;
//   - the synthetic newer firmware as a profile v2 document (test/helpers/newerFirmware.ts `newerFirmwareDoc`: every
//     M2 change plus an appended and an inserted model, a new section with a probed block, a system table) → the exact
//     golden test/fixtures/definitions-diff/newer.json (UPDATE_GOLDEN=1 regenerates it);
//   - the summary counts are `compareRows`' counts for the same profile, independently known suspects and
//     byte-exactness, and the lists add up to them; synthetic family keys never appear as families;
//   - a deletion that shifts names: the freed slot is removed as `P<pid>`, the vanished name is removed under its name,
//     the shifted rows carry `movedFrom`;
//   - a legacy (format-1) document reports `profile.format: 1`;
//   - a live-only profile reports `removed: null`; suspect families (runtime cross-check, provenance) and disagreement
//     families (conflicting sources) get their status;
//   - `family=` / `include=` filters, an unknown family → 404 `unknown-family`;
//   - the route: no detection and no device traffic, `state` equal to `capabilities.definitions.drift` before and after a
//     grid read, the body equal to the builder's, 501 for a driver without generic params, 503 `firmware-unknown`,
//     503 `no-device`, every answer identical through the runtime-router twin.
// Committed catalog data and synthetic data only.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authorGen3PresetFromIRFull, defaultScaffoldSyx } from 'forgefx-midi/devices/gen3';
import type { BuiltCache, ProfileDoc } from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { PROFILES, paramLabel, runtimeProfileFrom } from '../../src/devices.js';
import { definitionsDiff, definitionsDrift, parseDefinitionsDiffQuery, type DefinitionsDiffInput, type DefinitionsDiffQuery } from '../../src/drivers/definitionsDiff.js';
import { compareRows } from '../../src/drivers/profileCompare.js';
import type { DefinitionsCaps, DefinitionsDiffDTO } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, dumpAnswering, assert, assertEqual } from '../helpers/mock.js';
import { buildTestApp, firmwareVersionReply } from '../helpers/api.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { isInformativeRow } from 'forgefx-midi/cache';
import { seedRecords } from '../helpers/cacheBytes.js';
import { NEWER_FIRMWARE, NEWER_FIRMWARE_DIFF, newerFirmwareBuilt, newerFirmwareDoc } from '../helpers/newerFirmware.js';
import { SEED_BLOCKS, clone, editorCacheSource, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';

const FM3 = 0x11;
const FM3_PROFILE = PROFILES[FM3]!;
const FIXTURES = fileURLToPath(new URL('../fixtures/definitions-diff/', import.meta.url));
const GOLDEN = `${FIXTURES}newer.json`;

/** The newer-firmware key, firmware and the blocks of its edit-buffer grid: an audio block, the probed block, and a
 *  block nothing describes. */
const NEWER_KEY = '11_99p0';
const NEWER_FW = '99.0';
const PLACED = [58, NEWER_FIRMWARE_DIFF.probedEid, NEWER_FIRMWARE.unknownEid];

const CASES: Array<[string, () => void | Promise<void>]> = [
  ['catalog profile and no profile: state none, empty diff', catalogNone],
  ['newer firmware: exact golden', newerGolden],
  ['summary counts are compareRows counts', countsAgree],
  ['a deletion that shifts names: freed slot, vanished name, movedFrom', deletionShift],
  ['legacy format-1 document', legacyFormat1],
  ['live-only profile: removed null', liveOnly],
  ['suspect and disagreement families', suspectsAndDisagreements],
  ['family / include filters, unknown family', filters],
  ['route: state = caps drift, no device traffic, router parity', routeNewer],
  ['route: 501 / 503 gates, router parity', routeGates]
];
export const DEFINITIONS_DIFF_CASE_COUNT = CASES.length;

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The runtime profile and builder input of `doc` applied on FM3 under `key`. */
function appliedInput(doc: BuiltCache, key: string, firmware: string, extra: Partial<DefinitionsDiffInput> = {}): DefinitionsDiffInput {
  const profile = runtimeProfileFrom(doc, FM3_PROFILE);
  const coverage = (doc as Partial<ProfileDoc>).coverage;
  const unmapped = (extra.unmappedEids ?? []).length > 0;
  return {
    model: FM3, firmware, staticProfile: FM3_PROFILE, applied: { key, doc, profile },
    state: definitionsDrift({ running: firmware, catalogFirmware: FM3_PROFILE.catalogFirmware, applied: { firmware: (doc as { firmware?: string }).firmware ?? null, blocking: coverage ? !coverage.complete : false }, unmapped, storedStale: false }),
    ...extra
  };
}

function diffOf(input: DefinitionsDiffInput, query?: DefinitionsDiffQuery): DefinitionsDiffDTO {
  const r = definitionsDiff(input, query);
  if (!r.ok) throw new Error(`unexpected ${r.error} ${r.family}`);
  return r.diff;
}

/** The newer-firmware diff the golden pins: the grid read placed `PLACED`, of which only the unknown block is unmapped. */
const newerInput = (doc: ProfileDoc = newerFirmwareDoc()) =>
  appliedInput(doc, NEWER_KEY, NEWER_FW, { placedEids: PLACED, unmappedEids: [NEWER_FIRMWARE.unknownEid] });

/** Quiet the runtime profile's one-line suspect warning while `fn` runs. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

const WIDTH = 200;
/** JSON text with the DTO's own key order: a value that fits in WIDTH columns stays on one line. */
function print(v: unknown, indent = 0): string {
  const compact = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || compact.length + indent <= WIDTH) return compact;
  const pad = ' '.repeat(indent + 2);
  const end = ' '.repeat(indent);
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => pad + print(x, indent + 2)).join(',\n')}\n${end}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length === 0 ? '{}' : `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${print(o[k], indent + 2)}`).join(',\n')}\n${end}}`;
}
const goldenText = (d: DefinitionsDiffDTO) => `${print(d)}\n`;

function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) return `line ${i + 1}:\n  expected ${e[i]?.slice(0, 400) ?? '(end of file)'}\n  actual   ${a[i]?.slice(0, 400) ?? '(end of file)'}`;
  }
  return 'no difference';
}

/** The summary counts against `compareRows` — called with the suspects the test knows (`suspects`, never the diff's
 *  own list) and the runtime profile's byte-exactness — and against the lists. */
function assertCountsAgree(label: string, input: DefinitionsDiffInput, suspects: readonly string[]): void {
  const d = diffOf(input);
  const facts = input.applied!.profile.profileFacts!;
  const doc = input.applied!.doc;
  const cmp = compareRows(doc, FM3_PROFILE, suspects, facts.isByteExactFamily);
  assertEqual(d.summary.suspects.join(','), [...suspects].sort().join(','), `${label}: the diff reports the expected suspects`);
  assertEqual(d.summary.newParams, cmp.newRows, `${label}: newParams = compareRows newRows`);
  assertEqual(d.summary.changed.compatible, cmp.compatible, `${label}: compatible = compareRows`);
  assertEqual(d.summary.changed.incompatible, cmp.incompatible, `${label}: incompatible = compareRows`);
  assertEqual(d.summary.removed, cmp.removed, `${label}: removed = compareRows`);
  const fams = d.families;
  const sum = (f: (x: DefinitionsDiffDTO['families'][number]) => number) => fams.reduce((n, x) => n + f(x), 0);
  assertEqual(sum((x) => x.params!.added.length), cmp.newRows, `${label}: the added lists hold every new row`);
  assertEqual(sum((x) => x.params!.changed.filter((p) => p.change === 'compatible').length), cmp.compatible, `${label}: changed lists, compatible`);
  assertEqual(sum((x) => x.params!.changed.filter((p) => p.change === 'incompatible').length), cmp.incompatible, `${label}: changed lists, incompatible`);
  // removed: one entry per catalog row the profile no longer has (compareRows' count), plus vanished names at pids that
  // still hold a row
  const rowGone = (fam: string, pid: number) => { const e = doc.ranges[fam]?.[pid]; return !e || !isInformativeRow(e); };
  if (cmp.removed !== null) assertEqual(sum((x) => (x.params!.removed ?? []).filter((p) => rowGone(x.family, p.id)).length), cmp.removed, `${label}: the removed lists hold every removed row`);
  for (const x of fams) {
    for (const p of x.params!.removed ?? []) if (!rowGone(x.family, p.id)) assert(!p.generic, `${label}: ${x.family} ${p.id}: a vanished name is listed under its name`);
    for (const p of [...x.params!.added, ...x.params!.changed]) {
      if (p.movedFrom !== undefined) assert(x.params!.moved.some((m) => m.from === p.movedFrom && m.to === p.id && m.name === p.name), `${label}: ${x.family} ${p.id}: movedFrom ${p.movedFrom} is a moved name`);
    }
  }
  for (const x of fams.filter((f) => f.status === 'suspect')) assertEqual(x.params!.removed, null, `${label}: ${x.family}: a suspect family compares nothing`);
  const canon = (o: Record<string, number[]>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, [...o[k]!].sort((a, b) => a - b)]));
  const newByFamily = Object.fromEntries(fams.filter((x) => x.params!.added.length > 0).map((x) => [x.family, x.params!.added.map((p) => p.id)]));
  assertEqual(canon(newByFamily), canon(cmp.newByFamily), `${label}: new pids per family = compareRows newByFamily`);
  assert(!fams.some((x) => /^(section|block):/.test(x.family)), `${label}: no synthetic family key is a family`);
  assertEqual(sum((x) => x.params!.moved.length), d.summary.movedNames, `${label}: movedNames = the moved lists`);
  assertEqual(sum((x) => x.enums!.length), d.summary.enumChanges, `${label}: enumChanges = the enum lists`);
  assertEqual(fams.filter((x) => x.roster).length, d.summary.rosterChanges, `${label}: rosterChanges = the families with a roster`);
  assertEqual(fams.filter((x) => x.stride).length, d.summary.strideChanges, `${label}: strideChanges = the families with a stride`);
}

/** A preset dump of FM3 whose routing grid holds `eids` (one per cell, rows first), authored by the codec from its clean
 *  scaffold — synthetic, no device bytes. */
function gridDump(eids: readonly number[]): number[][] {
  const rows = FM3_PROFILE.rows;
  const cells = eids.map((effectId, i) => ({ row: i % rows, col: Math.floor(i / rows), effectId }));
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of authorGen3PresetFromIRFull(defaultScaffoldSyx(FM3), { routing: { gridCells: cells } }, FM3).syx) {
    if (b === 0xf0) cur = [b];
    else if (cur) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = null; } }
  }
  return frames;
}

/** A detected FM3 (real gen-3 driver) whose firmware reply is `fw` (none: silent), whose load hook hands out `docs`
 *  by key and whose edit buffer holds `placed`; the Fastify app and the runtime-router twin over it. */
async function rig(opts: { fw?: readonly [number, number]; docs?: Record<string, BuiltCache>; placed?: readonly number[]; detect?: boolean; connected?: boolean } = {}) {
  const mock = new MockTransport('serial', 'mock-definitions-diff');
  const dump = gridDump(opts.placed ?? []);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (opts.fw && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(FM3, opts.fw[0], opts.fw[1])];
    if (req[5] === 0x03) return dumpAnswering(req, dump);
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => (opts.connected === false ? null : { transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (key) => opts.docs?.[key] ?? null
  });
  if (opts.detect !== false) await registry.detect();
  const app = await buildApp(registry);
  const router = createRouter({ registry: registry as DeviceRegistry, store: createStore(createMemStoreBackend(), nodeCodec) });
  const resume = registry.pauseTelemetry(); // no telemetry frame may blur the traffic counts
  const viaApp = async (url: string) => { const r = await app.inject({ method: 'GET', url }); return { status: r.statusCode, text: r.payload }; };
  const viaRouter = async (url: string) => { const r = await router.handle('GET', url); return { status: r.status, text: r.body as string }; };
  const drift = async () => ((await app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: DefinitionsCaps } }).capabilities.definitions.drift;
  return { registry, app, mock, viaApp, viaRouter, drift, close: async () => { resume(); await app.close(); } };
}

/** GET `url` through both twins: same status and byte-identical body; returns the status and the parsed body. */
async function both(r: Awaited<ReturnType<typeof rig>>, url: string, label: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const a = await r.viaApp(url);
  const b = await r.viaRouter(url);
  assertEqual(b.status, a.status, `${label}: router status = app status (${url})`);
  assertEqual(b.text, a.text, `${label}: router body = app body (${url})`);
  return { status: a.status, body: JSON.parse(a.text) as Record<string, unknown> };
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────────────────────

function catalogNone(): void {
  // the catalog read back as a byte-exact profile of its own firmware
  const input = appliedInput(catalogBuilt(FM3), '11_12p0', '12.0');
  assertEqual(input.state, 'none', 'catalog profile: the drift rule says none');
  const d = diffOf(input);
  assertEqual(d.state, 'none', 'catalog profile: state none');
  assertEqual(d.catalogFirmware, '12.0', 'catalog firmware');
  assertEqual(d.profile?.key, '11_12p0', 'the applied profile is described');
  assertEqual(d.profile?.byteExact, true, 'byte-exact');
  assertEqual(JSON.stringify(d.summary), JSON.stringify({
    newParams: 0, changed: { compatible: 0, incompatible: 0 }, removed: 0, movedNames: 0, rosterChanges: 0, enumChanges: 0, strideChanges: 0,
    newSections: 0, unknownBlocks: 0, suspects: [], disagreements: []
  }), 'catalog profile: an empty summary');
  assertEqual(JSON.stringify([d.families, d.sections, d.blocks, d.instances]), '[[],[],[],[]]', 'catalog profile: no family, section, block or instance');

  // nothing applied on the catalog firmware
  const none = diffOf({ model: FM3, firmware: '12.0', state: 'none', staticProfile: FM3_PROFILE, applied: null });
  assertEqual(none.profile, null, 'no profile: profile null');
  assertEqual(none.summary.removed, 0, 'no profile on the catalog firmware: nothing removed');
  assertEqual(JSON.stringify([none.families, none.sections, none.blocks, none.instances]), '[[],[],[],[]]', 'no profile: an empty diff');
  // nothing applied on another firmware: nothing is known about removals
  const unprofiled = diffOf({ model: FM3, firmware: NEWER_FW, state: 'unprofiled', staticProfile: FM3_PROFILE, applied: null, placedEids: [NEWER_FIRMWARE.unknownEid], unmappedEids: [NEWER_FIRMWARE.unknownEid] });
  assertEqual(unprofiled.summary.removed, null, 'unprofiled: removed unknown');
  assertEqual(JSON.stringify(unprofiled.blocks), JSON.stringify([{ eid: NEWER_FIRMWARE.unknownEid, placed: true, state: 'none', key: null, sectionTag: null, params: 0 }]), 'unprofiled: a placed block nothing describes is listed');
}

async function newerGolden(): Promise<void> {
  const d = await quiet(() => diffOf(newerInput()));
  const again = await quiet(() => diffOf(newerInput()));
  const text = goldenText(d);
  assertEqual(goldenText(again), text, 'newer: the diff is deterministic');
  assertEqual(JSON.stringify(JSON.parse(text)), JSON.stringify(d), 'newer: the golden form is lossless (key order included)');
  if (process.env.UPDATE_GOLDEN === '1') {
    if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(GOLDEN, text);
  }
  assert(existsSync(GOLDEN), 'newer.json: golden missing (run with UPDATE_GOLDEN=1)');
  const stored = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
  if (stored !== text) throw new Error(`newer.json: the diff differs from the golden (UPDATE_GOLDEN=1 regenerates) at ${firstDifference(text, stored)}`);

  // the premises the golden stands on, spelled out
  assertEqual(d.state, 'partial', 'newer: a placed block nothing describes makes it partial');
  assertEqual(d.summary.suspects.join(','), NEWER_FIRMWARE.swapped.join(','), 'newer: the swapped families are suspects');
  const fam = (f: string) => d.families.find((x) => x.family === f);
  const app = NEWER_FIRMWARE_DIFF.rosterAppended;
  assertEqual(JSON.stringify(fam(app.family)?.roster?.appended), JSON.stringify([app.label]), 'newer: the appended model');
  assertEqual(fam(app.family)?.roster?.ordinalShift, false, 'newer: an appended model shifts nothing');
  const ins = NEWER_FIRMWARE_DIFF.rosterInserted;
  assertEqual(JSON.stringify(fam(ins.family)?.roster?.inserted), JSON.stringify([{ ordinal: ins.at, label: ins.label }]), 'newer: the inserted model');
  assertEqual(fam(ins.family)?.roster?.ordinalShift, true, 'newer: an inserted model shifts the later ordinals');
  assertEqual(JSON.stringify(fam(NEWER_FIRMWARE.inserted.family)?.params?.moved.map((m) => m.from + 1 === m.to)), JSON.stringify(NEWER_FIRMWARE.inserted.movedNames.map(() => true)), 'newer: the names of the clean insert window moved up one pid');
  assertEqual(fam(NEWER_FIRMWARE.dropped.family)?.params?.removed?.length, 1, 'newer: the dropped param is removed');
  assertEqual(d.summary.newSections, 1, 'newer: one new section');
  assertEqual(JSON.stringify(d.sections), JSON.stringify([{ tag: NEWER_FIRMWARE_DIFF.newSection.tag, key: `section:${NEWER_FIRMWARE_DIFF.newSection.tag}`, role: 'new', stride: 5, informative: 5, mappedEids: [NEWER_FIRMWARE_DIFF.probedEid] }]), 'newer: the new section (not the system table) with its probed block');
  assertEqual(JSON.stringify(d.blocks!.map((b) => [b.eid, b.placed, b.state, b.params])), JSON.stringify([[NEWER_FIRMWARE_DIFF.probedEid, true, 'confirmed', 4], [NEWER_FIRMWARE.unknownEid, true, 'none', 0]]), 'newer: the probed block (four params, the bypass is hidden) and the unknown one');
  console.log(`  drivers/definitions-diff: newer firmware matches its golden${process.env.UPDATE_GOLDEN === '1' ? ' (regenerated)' : ''} (${d.families.length} families, ${Buffer.byteLength(stored)} bytes)`);
}

async function countsAgree(): Promise<void> {
  await quiet(async () => {
    // the swapped sections are the newer firmware's only suspects (the fixture's premise, not the diff's answer)
    const swapped = [...NEWER_FIRMWARE.swapped];
    assertCountsAgree('newer', newerInput(), swapped);
    // a family the winning source flagged (provenance) is a suspect too, and compareRows skips it the same way
    const flagged = clone(newerFirmwareDoc());
    const byteId = flagged.meta.sources[0]!.id;
    flagged.provenance.suspects[byteId] = [...flagged.provenance.suspects[byteId]!, NEWER_FIRMWARE.newKnob.family];
    const input = newerInput(flagged);
    assertCountsAgree('newer, provenance suspect', input, [...swapped, NEWER_FIRMWARE.newKnob.family]);
    assertEqual(diffOf(input).summary.newParams, diffOf(newerInput()).summary.newParams - 1, 'the flagged family\'s new param is not counted');
    assertCountsAgree('newer, legacy format 1', appliedInput(newerFirmwareBuilt(), NEWER_KEY, NEWER_FW), swapped);
    assertCountsAgree('live-only', appliedInput(profileDoc([liveSource(liveSeedRecords())]), '11_12p0', '12.0'), []);
    assertCountsAgree('catalog', appliedInput(catalogBuilt(FM3), '11_12p0', '12.0'), []);
    assertCountsAgree('catalog, live provenance', appliedInput(catalogBuilt(FM3, 'live'), '11_12p0', '12.0'), []);
    assertCountsAgree('merged with a disagreement', appliedInput(await disagreementDoc(), '11_12p0', '12.0'), []);
    assertCountsAgree('a deletion that shifts names', appliedInput(deletionShiftDoc(), '11_12p0', '12.0'), []);
  });
}

/** The catalog read back as a byte-exact profile, with ENHANCER's row at pid 4 deleted: the rows 5..7 move down one pid
 *  (with their labels) and pid 7 is left without a row. */
function deletionShiftDoc(): BuiltCache {
  const b = catalogBuilt(FM3);
  const rows = b.ranges.ENHANCER as Record<number, unknown>;
  const labels = (b.enumOverrides.ENHANCER ??= {}) as Record<string, string[]>;
  for (let pid = 4; pid < 7; pid++) {
    rows[pid] = rows[pid + 1];
    if (labels[String(pid + 1)]) labels[String(pid)] = labels[String(pid + 1)]!;
    else delete labels[String(pid)];
  }
  delete rows[7];
  delete labels['7'];
  return b;
}

function deletionShift(): void {
  const cat = (pid: number) => FM3_PROFILE.params.ENHANCER!.find((d) => d.paramId === pid)!;
  const label = (pid: number) => paramLabel(cat(pid));
  const d = diffOf(appliedInput(deletionShiftDoc(), '11_12p0', '12.0'));
  assertEqual(d.families.map((f) => f.family).join(','), 'ENHANCER', 'only ENHANCER changed');
  const p = d.families[0]!.params!;
  // the names of 5..7 followed their rows down one pid
  assertEqual(JSON.stringify(p.moved.map((m) => [m.name, m.from, m.to])), JSON.stringify([5, 6, 7].map((pid) => [label(pid), pid, pid - 1])), 'the names of 5..7 moved down one pid');
  assertEqual(JSON.stringify(p.changed.map((c) => [c.id, c.name, c.movedFrom])), JSON.stringify([4, 5, 6].map((pid) => [pid, label(pid + 1), pid + 1])), 'the shifted rows carry their moved names and movedFrom');
  // removed: the vanished param under its name (its pid now holds another one), and the freed slot as P7 — never a name
  // the index still serves
  assertEqual(JSON.stringify(p.removed!.map((r) => [r.id, r.name, r.generic])), JSON.stringify([[4, label(4), false], [7, 'P7', true]]), 'removed: the vanished name and the freed slot');
  assert(!p.removed!.some((r) => p.moved.some((m) => m.name === r.name)), 'no removed entry carries a name that moved');
  assertEqual(d.summary.removed, 1, 'one catalog row is gone (compareRows counts rows)');
  assertEqual(d.summary.movedNames, 3, 'three moved names');
}

function legacyFormat1(): void {
  // the newer firmware as a format-1 document (derived tables only): no sources, no sections, no block map
  const doc = newerFirmwareBuilt();
  const d = diffOf(appliedInput(doc, NEWER_KEY, NEWER_FW, { placedEids: PLACED, unmappedEids: [NEWER_FIRMWARE_DIFF.probedEid, NEWER_FIRMWARE.unknownEid] }));
  assertEqual(JSON.stringify(d.profile), JSON.stringify({ key: NEWER_KEY, source: 'editor-cache', byteExact: true, format: 1, sources: [] }), 'format 1: no raw sources');
  assertEqual(JSON.stringify(d.sections), '[]', 'format 1: no sections');
  assertEqual(JSON.stringify(d.blocks!.map((b) => [b.eid, b.state])), JSON.stringify([[NEWER_FIRMWARE_DIFF.probedEid, 'none'], [NEWER_FIRMWARE.unknownEid, 'none']]), 'format 1: no block map, the placed unknown blocks only');
  assertEqual(d.summary.suspects.join(','), NEWER_FIRMWARE.swapped.join(','), 'format 1: the runtime suspects');
  // the same families and params as the format-2 document of the same tables, without what only that one adds
  const v2 = (() => { const w = console.warn; console.warn = () => {}; try { return diffOf(newerInput()); } finally { console.warn = w; } })();
  const addedByV2 = new Set([NEWER_FIRMWARE_DIFF.rosterAppended.family, NEWER_FIRMWARE_DIFF.rosterInserted.family]);
  const strip = (x: DefinitionsDiffDTO) => JSON.stringify(x.families.filter((f) => !addedByV2.has(f.family)));
  assertEqual(strip(d), strip(v2), 'format 1: the same family diffs as format 2 apart from the model lists');
  assertEqual(d.summary.rosterChanges, 0, 'format 1: the model lists are the catalog\'s');
}

function liveOnly(): void {
  const input = appliedInput(profileDoc([liveSource(liveSeedRecords())]), '11_12p0', '12.0');
  const d = diffOf(input);
  assertEqual(d.profile?.byteExact, false, 'live-only: not byte-exact');
  assertEqual(d.summary.removed, null, 'live-only: summary removed null');
  const listed = d.families.filter((f) => f.status !== 'catalog-only');
  assert(listed.length > 0, 'live-only: the walked families are listed');
  assert(listed.every((f) => f.params!.removed === null), 'live-only: every family reports removed null');
  const catalogOnly = d.families.filter((f) => f.status === 'catalog-only');
  assert(catalogOnly.some((f) => f.family === 'CHORUS'), 'live-only: a family the walk did not provide is catalog-only');
  assert(catalogOnly.every((f) => f.params!.removed === null && f.params!.added.length === 0), 'live-only: a catalog-only family has nothing to compare');
  assert(Object.keys(SEED_BLOCKS).every((f) => listed.some((x) => x.family === f)), 'live-only: every seed family is compared');
}

/** An editor cache and a walk of the same seed families whose DISTORT rows all differ: the editor cache wins, the
 *  family is flagged `disagreement`. */
async function disagreementDoc(): Promise<ProfileDoc> {
  const live = liveSeedRecords().map((r) => (r.section === SEED_BLOCKS.DISTORT && r.kind === 'float' ? { ...r, max: r.max + 1 } : r));
  return profileDoc([await editorCacheSource(seedRecords()), liveSource(live)]);
}

async function suspectsAndDisagreements(): Promise<void> {
  const d = await quiet(() => diffOf(newerInput()));
  for (const f of NEWER_FIRMWARE.swapped) {
    const x = d.families.find((y) => y.family === f);
    assertEqual(x?.status, 'suspect', `${f}: suspect`);
    assertEqual(JSON.stringify(x?.params), JSON.stringify({ added: [], changed: [], removed: null, moved: [] }), `${f}: nothing compared, nothing said about removals`);
    assert(x?.roster === undefined && x?.stride === undefined && x?.enums?.length === 0, `${f}: no roster, stride or label change`);
  }
  const doc = await disagreementDoc();
  const input = appliedInput(doc, '11_12p0', '12.0');
  assertEqual(input.state, 'partial', 'a disagreement is a blocking gap: partial');
  const g = diffOf(input);
  assertEqual(g.summary.disagreements.join(','), 'DISTORT', 'disagreements from the coverage');
  assertEqual(g.summary.suspects.join(','), '', 'no suspect');
  const distort = g.families.find((f) => f.family === 'DISTORT');
  assertEqual(distort?.status, 'disagreement', 'DISTORT: disagreement');
  assert((distort?.params?.removed?.length ?? 0) > 0, 'DISTORT: still compared (byte data wins)');
  assertEqual(g.families.filter((f) => f.status === 'disagreement').length, 1, 'only DISTORT');
}

function filters(): void {
  const full = (() => { const w = console.warn; console.warn = () => {}; try { return newerInput(); } finally { console.warn = w; } })();
  const all = diffOf(full);
  const run = (family: unknown, include: unknown) => definitionsDiff(full, parseDefinitionsDiffQuery(family, include));
  const ok = (family: unknown, include: unknown) => { const r = run(family, include); if (!r.ok) throw new Error(`unexpected ${r.family}`); return r.diff; };

  // family=
  let d = ok('FUZZ', undefined);
  assertEqual(d.families.map((f) => f.family).join(','), 'FUZZ', 'family=FUZZ');
  assertEqual(JSON.stringify(d.summary), JSON.stringify(all.summary), 'the summary covers the whole profile');
  assertEqual(JSON.stringify(d.families[0]), JSON.stringify(all.families.find((f) => f.family === 'FUZZ')), 'the family entry is the unfiltered one');
  assertEqual(JSON.stringify([d.sections, d.blocks, d.instances]), JSON.stringify([all.sections, all.blocks, all.instances]), 'family= leaves sections, blocks and instances');
  assertEqual(ok(['FUZZ', 'REVERB'], undefined).families.map((f) => f.family).join(','), 'FUZZ,REVERB', 'repeated family=');
  assertEqual(ok('REVERB,FUZZ', undefined).families.map((f) => f.family).join(','), 'FUZZ,REVERB', 'comma-separated family=, listing order kept');
  assertEqual(ok('GLOBAL', undefined).families.length, 0, 'an unchanged family is known but not listed');
  assertEqual(ok('CROSSOVER', undefined).families.length, 0, 'a catalog family without rows is known');
  for (const bad of ['NOPE', 'section:60', 'block:203', 'fuzz']) {
    const r = run(['FUZZ', bad], undefined);
    assert(!r.ok && r.error === 'unknown-family' && r.family === bad, `family=${bad}: unknown-family`);
  }

  // include=
  d = ok(undefined, 'rosters');
  assertEqual(d.families.map((f) => `${f.family}:${f.status}`).join(','), 'FUZZ:changed,MIXER:suspect,OUTPUT:suspect,REVERB:changed', 'include=rosters: the roster families and the suspects');
  assert(d.families.every((f) => f.params === undefined && f.enums === undefined && f.stride === undefined), 'include=rosters: no params, enums or strides');
  assert(d.sections === undefined && d.blocks === undefined && d.instances === undefined, 'include=rosters: no sections, blocks or instances');
  assertEqual(JSON.stringify(d.summary), JSON.stringify(all.summary), 'include= leaves the summary');
  d = ok(undefined, ['sections', 'blocks']);
  assertEqual(JSON.stringify([d.sections, d.blocks]), JSON.stringify([all.sections, all.blocks]), 'include=sections&include=blocks');
  assert(d.instances === undefined, 'instances left out');
  assertEqual(d.families.map((f) => f.status).join(','), 'suspect,suspect', 'only the always-listed families');
  d = ok(undefined, 'strides,enums,nonsense');
  assert(d.families.every((f) => f.params === undefined && f.roster === undefined && f.enums !== undefined), 'include=strides,enums: enums kept, params and rosters left out');
  assert(d.families.filter((f) => f.status === 'changed').every((f) => f.stride !== undefined || f.enums!.length > 0), 'every changed family listed has a stride or a label change');
  assertEqual(JSON.stringify(ok(undefined, '')), JSON.stringify(all), 'an empty include= means every part');
  assertEqual(JSON.stringify(ok([], [])), JSON.stringify(all), 'no values at all: the full diff');

  // the query parse
  assertEqual(JSON.stringify(parseDefinitionsDiffQuery(undefined, undefined)), '{}', 'nothing: no filter');
  const q = parseDefinitionsDiffQuery([' FUZZ ', 'FUZZ,REVERB', ''], 'params, blocks ,bogus');
  assertEqual(JSON.stringify(q.families), '["FUZZ","REVERB"]', 'families trimmed, split and de-duplicated');
  assertEqual(JSON.stringify([...q.include!]), '["params","blocks"]', 'unknown parts ignored');
}

async function routeNewer(): Promise<void> {
  const doc = newerFirmwareDoc();
  const r = await quiet(() => rig({ fw: [99, 0], docs: { [NEWER_KEY]: doc }, placed: PLACED }));
  try {
    const url = '/device/definitions/diff';
    // before any grid read: nothing placed, nothing unmapped
    let sent = r.mock.sent.length;
    let res = await both(r, url, 'before a grid read');
    assertEqual(r.mock.sent.length, sent, 'the diff sends nothing to the device');
    assertEqual(res.status, 200, '200');
    const d0 = res.body as unknown as DefinitionsDiffDTO;
    assertEqual(d0.state, await r.drift(), 'state = capabilities.definitions.drift (before a grid read)');
    assertEqual(d0.state, 'none', 'nothing unmapped yet: none');
    assertEqual(JSON.stringify(d0.blocks!.map((b) => [b.eid, b.placed, b.state])), JSON.stringify([[NEWER_FIRMWARE_DIFF.probedEid, false, 'confirmed']]), 'no grid read: the probed block is not known to be placed');

    // the grid read places the blocks; the diff then is exactly the golden's
    assertEqual((await r.app.inject({ method: 'GET', url: '/preset/grid' })).statusCode, 200, 'GET /preset/grid');
    sent = r.mock.sent.length;
    res = await both(r, url, 'after a grid read');
    assertEqual(r.mock.sent.length, sent, 'still no device traffic');
    const d1 = res.body as unknown as DefinitionsDiffDTO;
    assertEqual(d1.state, await r.drift(), 'state = capabilities.definitions.drift (after a grid read)');
    assertEqual(d1.state, 'partial', 'a placed block nothing describes: partial');
    const golden = await quiet(() => diffOf(newerInput()));
    assertEqual(JSON.stringify(d1), JSON.stringify(golden), 'the route answers what the builder answers for the same state (the golden)');

    // filters and errors, both twins
    sent = r.mock.sent.length;
    for (const q of ['?family=FUZZ', '?family=FUZZ&family=REVERB', '?family=FUZZ,REVERB', '?include=rosters', '?include=params&include=blocks', '?include=', '?family=FUZZ&include=strides']) {
      const x = await both(r, url + q, q);
      assertEqual(x.status, 200, `${q}: 200`);
    }
    assertEqual(JSON.stringify((await both(r, `${url}?family=FUZZ`, 'family')).body.families), JSON.stringify(golden.families.filter((f) => f.family === 'FUZZ')), 'family=FUZZ through the route');
    const nf = await both(r, `${url}?family=FUZZ&family=NOPE`, 'unknown family');
    assertEqual(nf.status, 404, 'unknown family: 404');
    assertEqual(JSON.stringify(nf.body), JSON.stringify({ error: 'unknown-family', family: 'NOPE' }), 'unknown family: body');
    assertEqual(r.mock.sent.length, sent, 'no request of the diff sent anything');
  } finally { await r.close(); }
}

async function routeGates(): Promise<void> {
  const url = '/device/definitions/diff';
  // firmware not read
  let r = await rig({ docs: {} });
  try {
    const sent = r.mock.sent.length;
    const x = await both(r, url, 'firmware unknown');
    assertEqual(x.status, 503, 'firmware unknown: 503');
    assertEqual(JSON.stringify(x.body), JSON.stringify({ error: 'firmware-unknown' }), 'firmware unknown: body');
    assertEqual(r.mock.sent.length, sent, 'firmware unknown: nothing sent');
  } finally { await r.close(); }

  // no unit identified: the diff never starts a detection
  r = await rig({ detect: false });
  try {
    const x = await both(r, url, 'no device');
    assertEqual(x.status, 503, 'no device: 503');
    assertEqual(JSON.stringify(x.body), JSON.stringify({ error: 'no-device' }), 'no device: body');
    assertEqual(r.mock.sent.length, 0, 'no device: no detection, no frame');
  } finally { await r.close(); }

  // a driver without the generic params (AM4)
  const am4 = await buildTestApp(0x15);
  try {
    const router = createRouter({ registry: am4.registry, store: createStore(createMemStoreBackend(), nodeCodec) });
    const sent = am4.mock.sent.length;
    const a = await am4.app.inject({ method: 'GET', url });
    const b = await router.handle('GET', url);
    assertEqual(a.statusCode, 501, 'AM4: 501');
    assertEqual(a.payload, JSON.stringify({ error: 'unsupported', capability: 'genericParams' }), 'AM4: body');
    assertEqual(b.status, a.statusCode, 'AM4: router status');
    assertEqual(b.body, a.payload, 'AM4: router body');
    assertEqual(am4.mock.sent.length, sent, 'AM4: nothing sent');
  } finally { await am4.app.close(); }

  // the catalog firmware with nothing stored: none, an empty diff
  r = await rig({ fw: [12, 0], docs: {} });
  try {
    const x = await both(r, url, 'catalog firmware, nothing stored');
    assertEqual(x.status, 200, 'catalog firmware: 200');
    const d = x.body as unknown as DefinitionsDiffDTO;
    assertEqual(d.state, await r.drift(), 'state = caps drift');
    assertEqual(JSON.stringify([d.state, d.profile, d.firmware, d.families]), JSON.stringify(['none', null, '12.0', []]), 'catalog firmware: none, no profile, nothing listed');
  } finally { await r.close(); }

  // a newer firmware with nothing stored: unprofiled
  r = await rig({ fw: [99, 0], docs: {} });
  try {
    const d = (await both(r, url, 'unprofiled')).body as unknown as DefinitionsDiffDTO;
    assertEqual(d.state, 'unprofiled', 'nothing stored for a newer firmware: unprofiled');
    assertEqual(d.state, await r.drift(), 'state = caps drift (unprofiled)');
    assertEqual(d.summary.removed, null, 'unprofiled: removed unknown');
  } finally { await r.close(); }
}

export async function runDefinitionsDiffTests(): Promise<void> {
  for (const [name, fn] of CASES) {
    try { await fn(); }
    catch (e) { throw new Error(`[drivers/definitions-diff] ${name}: ${(e as Error).message}`); }
  }
}
