// The param index (drivers/paramIndex.ts): the five reconciliation cases between the bundled catalog and a
// device profile (+ the catalog-only-unnamed case), name moves and their guards, provenance rules (live
// never hides, byte-exact hides what the firmware dropped), the section-assignment suspect, the widget /
// write-mode table, and the invariants over the committed FM3 / FM9 / Axe-Fx III catalogs.
// Tiny synthetic profiles for the rules; committed catalog data for the invariants. NO device.
import { runtimeProfileFrom, isEnumOnAnyDevice, layoutWidgetIndex, PROFILES, type DeviceProfile, type ParamDef, type RangeDef } from '../../src/devices.js';
import {
  buildParamIndex, NOT_LISTED_BY_DESIGN, NAME_SHIFT_ENABLED, MAX_WIRE_PID, MAX_STEPPER_DETENTS, CONTINUOUS_CATALOG_UNITS,
  type BlockIndex, type ParamEntry,
} from '../../src/drivers/paramIndex.js';
import { CACHE_SCHEMA, isInformativeRow, type BuiltCache } from 'forgefx-midi/cache';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';

export const PARAM_INDEX_CASE_COUNT = 24;

// ── row and profile builders ──────────────────────────────────────────────────────────────────────
const F = (min: number, max: number, tc = 0x31, o: Partial<RangeDef> = {}): RangeDef => ({ kind: 'float', displayMin: min, displayMax: max, scale: 1, step: 0.01, typecode: tc, ...o });
const E = (n: number, o: Partial<RangeDef> = {}): RangeDef => ({ kind: 'enum', displayMin: 0, displayMax: n - 1, scale: 1, step: 0, typecode: 0x10, enumCount: n, ...o });
const PH: RangeDef = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
const D = (pid: number, name: string, unit?: string, displayLabel?: string): ParamDef => ({ paramId: pid, name, ...(unit ? { unit } : {}), ...(displayLabel ? { displayLabel } : {}) });

interface Fam { fam: string; defs?: ParamDef[]; rows: Record<number, RangeDef>; labels?: Record<number, string[]>; stride?: number }

function mkStatic(fams: Fam[], layouts?: unknown): DeviceProfile {
  const labels = (f: string, pid: number) => fams.find((x) => x.fam === f)?.labels?.[pid];
  return {
    model: 0x11, key: 'fm3', name: 'param-index-test', rows: 4, cols: 12, defaultInstances: 1, instanceLimits: {},
    params: Object.fromEntries(fams.map((f) => [f.fam, f.defs ?? []])),
    ranges: Object.fromEntries(fams.map((f) => [f.fam, f.rows])),
    rangeSections: Object.fromEntries(fams.filter((f) => f.stride !== undefined).map((f) => [f.fam, { stride: f.stride!, recordCount: f.stride! }])),
    rosterFor: () => [], enumLabelsFor: labels, cabIrs: () => ({}), familyForEffectId: () => undefined, layoutFor: () => undefined,
    ...(layouts ? { editorLayouts: layouts } : {}), catalogFirmware: '1.0',
  } as unknown as DeviceProfile;
}

function mkBuilt(fams: Fam[], source: string): BuiltCache {
  return {
    ranges: Object.fromEntries(fams.map((f) => [f.fam, f.rows])),
    enumOverrides: Object.fromEntries(fams.map((f) => [f.fam, Object.fromEntries(Object.entries(f.labels ?? {}).map(([k, v]) => [k, v]))])),
    rangeSections: Object.fromEntries(fams.filter((f) => f.stride !== undefined).map((f) => [f.fam, { sectionTag: 1, stride: f.stride!, recordCount: f.stride! }])),
    rosters: {}, cabIrs: {}, unmappedSections: [], unmappedFamilies: [], model: 0x11, firmware: '2.0',
    meta: { schema: CACHE_SCHEMA, source, recordCount: 1 },
  } as unknown as BuiltCache;
}

const entry = (idx: BlockIndex, pid: number): ParamEntry => {
  const e = idx.byPid.get(pid);
  assert(e !== undefined, `pid ${pid} is listed`);
  return e;
};
const hiddenOf = (idx: BlockIndex) => idx.hidden.map((h) => `${h.id}:${h.reason}`).join(',');
const names = (idx: BlockIndex) => idx.entries.map((e) => `${e.pid}:${e.name}`).join(',');

// ── 1. no profile: the catalog as it is ──
function catalogOnly(): void {
  const S = mkStatic([{
    fam: 'AA', stride: 20,
    defs: [D(0, 'AA_DRIVE', 'numeric'), D(1, 'AA_MODEL', 'enum'), D(2, 'AA_BYPASS', 'enum'), D(3, 'AA_LEVEL', 'db'), D(4, 'AA_OFF', 'enum', 'Bypass'), D(5, 'AA_HIDDEN', 'numeric'), D(6, 'AA_DEGENERATE', 'numeric'), D(8, 'AA_LATE', 'numeric')],
    rows: {
      0: F(0, 10), 1: E(3), 2: F(0, 1, 0xe0), 3: F(-80, 20, 0x181), 4: F(0, 1, 0x10), 5: PH, 6: F(2, 2),
      7: F(0, 100, 0x61), // informative, no name
      8: F(0, 5, 0x41),
      0x4000: F(0, 1), // not a wire pid
    },
    labels: { 1: ['A', 'B', 'C'] },
  }]);
  const idx = buildParamIndex(S, 'AA');
  assertEqual(names(idx), '0:DRIVE,3:LEVEL,8:LATE,7:P7', 'catalog order first, then generic by pid; placeholders, degenerate rows and non-wire pids are not rows');
  assertEqual(hiddenOf(idx), '1:type,2:bypass,4:bypass', 'type selector, typecode-0xE0 bypass and a label-only bypass are hidden with their reason');
  for (const e of idx.entries) {
    assertEqual(e.source, 'catalog', `pid ${e.pid}: source`);
    if (!e.generic) {
      assertEqual(e.nameSource, 'catalog', `pid ${e.pid}: nameSource`);
      assertEqual(e.nameConfidence, 'high', `pid ${e.pid}: nothing contradicts the catalog`);
    }
  }
  const g = entry(idx, 7);
  assertEqual(g.generic, true, 'an unnamed catalog row is generic (case 3b)');
  assertEqual(g.nameSource, 'generic', 'generic nameSource');
  assertEqual(g.nameConfidence, undefined, 'a generic param has no name confidence');
  assertEqual(g.isNew, undefined, 'the catalog has a row for it: not new');
  assertEqual(g.pageHint, 'more', 'an unnamed catalog row belongs on the "more" page');
  assertEqual(g.def, undefined, 'no definition');
  assertEqual(entry(idx, 0).def?.name, 'AA_DRIVE', 'a named entry carries its definition');
  assertEqual(entry(idx, 0).fp.startsWith('1:'), true, 'fingerprint is the versioned form');
  assertEqual(idx.profile, 'none', 'no profile applied');
  assertEqual(idx.suspect, false, 'not suspect');
  assertEqual(idx.stride, 20, 'stride comes from the range sections');
  assertEqual(idx.maxPid, 8, 'maxPid is the highest informative row (the non-wire 0x4000 row does not count)');
  assertEqual(idx.positional, true, 'every informative row is below the stride');
  assertEqual(`${idx.typePid}/${idx.variantPid}`, '1/1', 'the type selector is also the layout variant selector');
  assert(buildParamIndex(S, 'AA') === idx, 'memoised per profile and family');
  assert(buildParamIndex(mkStatic([]), 'AA') !== idx, 'another profile has its own index');
  assertEqual(buildParamIndex(S, 'NOPE').entries.length, 0, 'a family the profile does not have: empty index');
  assertEqual(MAX_WIRE_PID, 0x3fff, 'wire pid ceiling');
}

// ── 2. every case against a byte-exact profile ──
function byteExactCases(): void {
  const S = mkStatic([
    {
      fam: 'AA', stride: 16,
      defs: [D(0, 'AA_DRIVE'), D(1, 'AA_TONE'), D(2, 'AA_SHAPE'), D(3, 'AA_MODE'), D(4, 'AA_KILL'), D(5, 'AA_EXTRA'), D(7, 'AA_PHANTOM'), D(10, 'AA_BYPASS'), D(11, 'AA_MODEL')],
      rows: { 0: F(0, 10, 0x31), 1: F(0, 10, 0x31, { step: 0.02 }), 2: F(0, 10, 0x131), 3: E(2), 4: F(0, 5, 0x41), 5: F(0, 5, 0x51), 6: F(0, 100, 0x61), 7: PH, 10: F(0, 1, 0xe0), 11: E(3) },
      labels: { 3: ['A', 'B'], 11: ['x', 'y', 'z'] },
    },
    { fam: 'BB', stride: 4, defs: [D(0, 'BB_ONE'), D(1, 'BB_TWO')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41) } },
  ]);
  const built = mkBuilt([{
    fam: 'AA', stride: 17,
    rows: {
      0: F(0, 10, 0x31), // 1. equal
      1: F(0, 12, 0x31, { step: 0.02 }), // 2. differs, still compatible (same unit class, overlapping span)
      2: E(3), // 2. differs, not compatible (kind changed)
      3: E(3), // 2. a label appended
      4: PH, // the slot is unused now
      // 5: gone
      6: F(0, 100, 0x61), // static unnamed row, the profile agrees
      7: F(0, 3, 0x71), // profile-only, the catalog has a name but no row to verify against
      8: F(0, 64, 0x81), // profile-only, nothing in the catalog
      9: PH, // profile-only placeholder
      10: F(0, 1, 0xe0), 11: E(3),
    },
    labels: { 2: ['p', 'q', 'r'], 3: ['A', 'B', 'C'], 11: ['x', 'y', 'z'] },
  }], 'editor-cache');
  const P = runtimeProfileFrom(built, S);
  const idx = buildParamIndex(P, 'AA');

  assertEqual(idx.profile, 'byte-exact', 'byte-exact profile');
  assertEqual(names(idx), '0:DRIVE,1:TONE,2:SHAPE,3:MODE,7:PHANTOM,6:P6,8:P8', 'catalog order, then generic by pid; the unused slot (9) is not listed');
  const drive = entry(idx, 0);
  assertEqual(`${drive.source}/${drive.nameSource}/${drive.nameConfidence}`, 'profile/catalog/high', 'case 1: in both, same fingerprint');
  const tone = entry(idx, 1);
  assertEqual(`${tone.source}/${tone.nameSource}/${tone.nameConfidence}`, 'profile/catalog/medium', 'case 2: differs but compatible -> medium');
  assertEqual(tone.row.displayMax, 12, 'case 2: the device row wins');
  const shape = entry(idx, 2);
  assertEqual(`${shape.source}/${shape.nameSource}/${shape.nameConfidence}/${shape.name}`, 'profile/catalog/low/SHAPE', 'case 2: incompatible with no shift -> the name stays, low');
  assertEqual(shape.kind, 'enum', 'case 2: the device kind is served');
  const mode = entry(idx, 3);
  assertEqual(mode.nameConfidence, 'medium', 'case 2: an appended label is a compatible change');
  assertEqual(mode.options && `${mode.options.lo}..${mode.options.hi}`, '0..2', 'the options follow the device row');
  const phantom = entry(idx, 7);
  assertEqual(`${phantom.generic}/${phantom.nameConfidence}/${phantom.isNew}`, 'false/low/true', 'case 3: profile-only pid the catalog names: named at low confidence, new');
  const p6 = entry(idx, 6);
  assertEqual(`${p6.generic}/${p6.source}/${p6.isNew}/${p6.pageHint}`, 'true/profile/undefined/more', 'case 3b: unnamed catalog row the profile agrees with');
  const p8 = entry(idx, 8);
  assertEqual(`${p8.name}/${p8.generic}/${p8.source}/${p8.isNew}/${p8.pageHint}/${p8.nameSource}`, 'P8/true/profile/true/new-in-firmware/generic', 'case 3: profile-only pid is generic, new in firmware');
  assertEqual(p8.nameConfidence, undefined, 'case 3: no name confidence on a generic param');
  assertEqual(hiddenOf(idx), '4:removed,5:removed,10:bypass,11:type', 'case 4: rows a byte-exact profile no longer has are hidden "removed"; bypass and type as always');
  assertEqual(idx.positional, true, 'every id fits the profile stride (17)');
  assertEqual(idx.stride, 17, 'the profile stride');

  // a family the profile does not carry: shown as the catalog says, nothing is hidden as removed
  const bb = buildParamIndex(P, 'BB');
  assertEqual(`${names(bb)}|${hiddenOf(bb)}|${bb.profile}`, '0:ONE,1:TWO||none', 'case 4: a family the profile lacks is served from the catalog, profile none');
  assertEqual(entry(bb, 0).source, 'catalog', 'and its rows are catalog rows');
}

// ── 3. a live profile: never hides, keeps the catalog kind ──
function liveRules(): void {
  const S = mkStatic([{
    fam: 'AA', stride: 16,
    defs: [D(0, 'AA_DRIVE'), D(1, 'AA_TONE'), D(2, 'AA_SHAPE'), D(4, 'AA_KILL'), D(5, 'AA_EXTRA')],
    rows: { 0: F(0, 10, 0x31), 1: F(0, 10, 0x31), 2: F(0, 10, 0x131), 4: F(0, 5, 0x41), 5: F(0, 5, 0x51) },
  }]);
  const built = mkBuilt([{
    fam: 'AA', stride: 8,
    rows: { 0: F(0, 10, 0x31), 1: F(0, 12, 0x31), 2: E(3, { unit: 'Hz' }), 4: PH, 8: F(0, 64, 0x81), 9: PH },
  }], 'live');
  const P = runtimeProfileFrom(built, S);
  const idx = buildParamIndex(P, 'AA');
  assertEqual(idx.profile, 'live', 'live profile');
  assertEqual(names(idx), '0:DRIVE,1:TONE,2:SHAPE,4:KILL,5:EXTRA,8:P8', 'a live profile hides nothing: skipped placeholder (4) and rows it never walked (5) are listed');
  assertEqual(hiddenOf(idx), '', 'nothing hidden');
  const shape = entry(idx, 2);
  assertEqual(`${shape.source}/${shape.kind}/${shape.widget}`, 'catalog/float/knob', 'a live kind conflict keeps the catalog row: source catalog, catalog kind');
  assertEqual(shape.row.unit, 'Hz', 'the skipped row still donates its unit');
  assertEqual(entry(idx, 1).source, 'profile', 'a same-kind live row refines the catalog row: source profile');
  assertEqual(entry(idx, 4).source, 'catalog', 'a skipped placeholder leaves the catalog row: source catalog');
  const p8 = entry(idx, 8);
  assertEqual(`${p8.generic}/${p8.isNew}/${p8.pageHint}`, 'true/true/new-in-firmware', 'a live row for a pid the catalog lacks is generic and new');
  assertEqual(idx.byPid.has(9), false, 'a live placeholder for a pid the catalog lacks is not added');
  assertEqual(idx.stride, 16, 'the live stride never shrinks the catalog stride');
}

// ── 4. the unique-shift rule ──
function nameShift(): void {
  assertEqual(NAME_SHIFT_ENABLED, true, 'the shift rule is on');
  // a row inserted at pid 2 pushes 2..5 up by one
  const S = mkStatic([{
    fam: 'SS', stride: 10,
    defs: [D(0, 'SS_A'), D(1, 'SS_B'), D(2, 'SS_C'), D(3, 'SS_D'), D(4, 'SS_E'), D(5, 'SS_F')],
    rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(-5, 5, 0x51), 3: E(3), 4: E(4), 5: F(0, 100, 0x61) },
    labels: { 3: ['a', 'b', 'c'], 4: ['w', 'x', 'y', 'z'] },
  }]);
  const shifted = mkBuilt([{
    fam: 'SS', stride: 11,
    rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(0, 1, 0x71), 3: F(-5, 5, 0x51), 4: E(3), 5: E(4), 6: F(0, 100, 0x61) },
    labels: { 4: ['a', 'b', 'c'], 5: ['w', 'x', 'y', 'z'] },
  }], 'editor-cache');
  const idx = buildParamIndex(runtimeProfileFrom(shifted, S), 'SS');
  assertEqual(names(idx), '0:A,1:B,3:C,4:D,5:E,6:F,2:P2', 'the names follow their rows; the inserted row is generic');
  for (const [pid, from] of [[3, 2], [4, 3], [5, 4], [6, 5]] as const) {
    const e = entry(idx, pid);
    assertEqual(`${e.nameSource}/${e.movedFrom}/${e.nameConfidence}`, `catalog-moved/${from}/medium`, `pid ${pid}: the name of pid ${from} moved here`);
  }
  assertEqual(entry(idx, 0).nameSource, 'catalog', 'rows that did not move keep their names');
  assertEqual(entry(idx, 6).isNew, true, 'a moved name can land on a pid the catalog has no row for');
  const gap = entry(idx, 2);
  assertEqual(`${gap.generic}/${gap.isNew}/${gap.pageHint}/${gap.source}`, 'true/undefined/more/profile', 'the pid whose name moved away is generic: the catalog does have a row there');
  assertEqual(entry(idx, 5).kind, 'enum', 'a moved name keeps the device row kind');
  assertEqual(entry(idx, 5).options && entry(idx, 5).options!.hi, 3, 'and the device options');

  // relocation: the row of a dropped slot reappears at a new pid
  const R = mkStatic([{ fam: 'AR', stride: 6, defs: [D(0, 'AR_A'), D(1, 'AR_B'), D(2, 'AR_C')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(0, 50, 0x51) } }]);
  const reloc = mkBuilt([{ fam: 'AR', stride: 4, rows: { 0: F(0, 10, 0x31), 1: PH, 2: F(0, 50, 0x51), 3: F(0, 20, 0x41) } }], 'editor-cache');
  const ri = buildParamIndex(runtimeProfileFrom(reloc, R), 'AR');
  assertEqual(`${entry(ri, 3).name}/${entry(ri, 3).nameSource}/${entry(ri, 3).movedFrom}`, 'B/catalog-moved/1', 'a relocated row takes its name along');
  assertEqual(hiddenOf(ri), '1:removed', 'and the slot it left is hidden as removed');

  // ambiguous in the profile: two rows carry the fingerprint -> no move
  const A = mkStatic([{ fam: 'AM', stride: 6, defs: [D(0, 'AM_A'), D(1, 'AM_B')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41) } }]);
  const amb = mkBuilt([{ fam: 'AM', stride: 5, rows: { 0: F(0, 10, 0x31), 1: F(0, 1, 0x71), 3: F(0, 20, 0x41), 4: F(0, 20, 0x41) } }], 'editor-cache');
  const ai = buildParamIndex(runtimeProfileFrom(amb, A), 'AM');
  assertEqual(`${entry(ai, 1).name}/${entry(ai, 1).nameConfidence}`, 'B/low', 'two carriers: the name stays at its own pid, low');
  assertEqual(`${entry(ai, 3).generic}/${entry(ai, 4).generic}`, 'true/true', 'and both carriers are generic');

  // ambiguous in the catalog: two catalog rows share the fingerprint -> no move
  const dup = mkStatic([{ fam: 'AD', stride: 6, defs: [D(0, 'AD_A'), D(1, 'AD_B'), D(2, 'AD_C')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(0, 20, 0x41) } }]);
  const dupBuilt = mkBuilt([{ fam: 'AD', stride: 5, rows: { 0: F(0, 10, 0x31), 1: F(0, 1, 0x71), 2: F(0, 20, 0x41), 3: F(0, 20, 0x41) } }], 'editor-cache');
  const di = buildParamIndex(runtimeProfileFrom(dupBuilt, dup), 'AD');
  assertEqual(entry(di, 1).nameSource, 'catalog', 'a catalog fingerprint that is not unique moves nothing');
  assertEqual(entry(di, 1).nameConfidence, 'low', 'the unmatched name stays at low');
  assertEqual(entry(di, 3).generic, true, 'the extra carrier is generic');

  // the carrier still has a claim of its own -> no move
  const own = mkStatic([{ fam: 'AO', stride: 6, defs: [D(0, 'AO_A'), D(1, 'AO_B'), D(2, 'AO_C')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(0, 30, 0x41) } }]);
  const ownBuilt = mkBuilt([{ fam: 'AO', stride: 4, rows: { 0: F(0, 10, 0x31), 1: F(0, 1, 0x71), 2: F(0, 20, 0x41) } }], 'editor-cache');
  const oi = buildParamIndex(runtimeProfileFrom(ownBuilt, own), 'AO');
  assertEqual(`${entry(oi, 1).nameSource}/${entry(oi, 1).nameConfidence}`, 'catalog/low', 'a carrier that is compatible with its own catalog row is not taken over');
  assertEqual(`${entry(oi, 2).nameSource}/${entry(oi, 2).nameConfidence}`, 'catalog/medium', 'it keeps its own name, medium');
}

// ── 5. a family the cross-check flagged is served from the catalog ──
function suspectFamily(): void {
  const aa: Fam = { fam: 'AA', stride: 8, defs: [D(0, 'AA_A'), D(1, 'AA_B'), D(2, 'AA_C'), D(3, 'AA_D'), D(4, 'AA_E')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(0, 30, 0x51), 3: E(2), 4: E(3) }, labels: { 3: ['p', 'q'], 4: ['r', 's', 't'] } };
  const bb: Fam = { fam: 'BB', stride: 8, defs: [D(0, 'BB_A'), D(1, 'BB_B'), D(2, 'BB_C'), D(3, 'BB_D'), D(4, 'BB_E')], rows: { 0: F(0, 110, 0x61), 1: F(0, 120, 0x71), 2: F(0, 130, 0x81), 3: E(4), 4: E(5) }, labels: { 3: ['a', 'b', 'c', 'd'], 4: ['e', 'f', 'g', 'h', 'i'] } };
  const S = mkStatic([aa, bb]);
  const clean = runtimeProfileFrom(mkBuilt([aa, bb], 'editor-cache'), S);
  assertEqual(buildParamIndex(clean, 'AA').suspect, false, 'the catalog read back as a profile has no suspect');
  assertEqual(buildParamIndex(clean, 'AA').profile, 'byte-exact', 'and is byte-exact');

  const swapped = runtimeProfileFrom(mkBuilt([{ ...aa, rows: bb.rows, labels: bb.labels }, { ...bb, rows: aa.rows, labels: aa.labels }], 'editor-cache'), S);
  for (const fam of ['AA', 'BB']) {
    const idx = buildParamIndex(swapped, fam);
    assertEqual(idx.suspect, true, `${fam}: suspect`);
    assertEqual(idx.profile, 'none', `${fam}: a suspect family has no usable profile`);
    assertEqual(idx.entries.length, 5, `${fam}: all five catalog rows are listed`);
    assert(idx.entries.every((e) => e.source === 'catalog' && e.nameConfidence === 'high'), `${fam}: served as the catalog says`);
    assertEqual(hiddenOf(idx), '', `${fam}: nothing is hidden as removed`);
    assertEqual(idx.entries[0]!.row, S.ranges[fam]![0], `${fam}: the effective rows are the catalog's`);
  }
}

// ── 6. the widget / write-mode table ──
function oneParam(row: RangeDef, o: { labels?: string[]; def?: ParamDef | null; fam?: string; layoutWidget?: string } = {}): ParamEntry {
  const fam = o.fam ?? 'WW';
  const def = o.def === null ? undefined : (o.def ?? D(5, `${fam}_PARAM`, 'numeric'));
  const layouts = o.layoutWidget
    ? { [fam]: { editorName: fam, family: fam, variants: [{ name: 'v', value: null, pages: [{ name: 'p', rows: [{ section: 'parameters', controls: [{ label: '', paramName: 'X', paramId: 5, widget: o.layoutWidget, rawWidget: o.layoutWidget }] }] }] }] } }
    : undefined;
  const S = mkStatic([{ fam, defs: def ? [def] : [], rows: { 5: row }, ...(o.labels ? { labels: { 5: o.labels } } : {}), stride: 8 }], layouts);
  return entry(buildParamIndex(S, fam), 5);
}

function widgetTable(): void {
  const widgetOf = (e: ParamEntry) => `${e.widget}/${e.widgetSource}/${e.list}/${e.write}`;
  // enum rows: always a selector, never a knob
  assertEqual(widgetOf(oneParam(E(2))), 'toggle/device/enums/ordinal', 'two ordinals: toggle');
  assertEqual(widgetOf(oneParam(E(3))), 'dropdown/device/enums/ordinal', 'three ordinals: dropdown');
  const ph = oneParam({ kind: 'enum', displayMin: 0, displayMax: 10, scale: 2, step: 0, typecode: 0x10, enumCount: 6 });
  assertEqual(`${ph.options!.lo}..${ph.options!.hi}/${ph.widget}`, '0..5/dropdown', 'a scaled enum covers its label count, not the display span (PHASER_ORDER shape)');
  const shifted = oneParam(E(3, { displayMin: 1, displayMax: 3 }));
  assertEqual(`${shifted.options!.lo}..${shifted.options!.hi}`, '1..3', 'an enum that starts at 1 keeps its ordinals (DELAY_SVFTYPE shape)');
  assertEqual(oneParam(E(3), { labels: ['a', 'b', 'c'] }).labels?.length, 3, 'the effective labels ride on the entry');

  // float rows that carry a label list are selectors too
  assertEqual(widgetOf(oneParam(F(0, 1, 0xd0), { labels: ['OFF', 'ON'] })), 'toggle/device/enums/ordinal', 'float 0..1 with two labels: toggle, ordinal write');
  const three = oneParam(F(0, 2, 0xd0), { labels: ['a', 'b', 'c'] });
  assertEqual(widgetOf(three), 'dropdown/device/enums/null', 'float with a longer label list: dropdown with no verified write path');
  assertEqual(three.readOnlyReason, 'unverified-write-path', 'and says why');
  assertEqual(`${three.options!.lo}..${three.options!.hi}`, '0..2', 'its options span the rounded display bounds');
  assertEqual(oneParam(F(0, 2, 0xd0), { labels: ['a'] }).write, null, 'a single label is no proven toggle either');

  // floats without labels: knob unless something says discrete
  assertEqual(widgetOf(oneParam(F(0, 10, 0x31))), 'knob/device/named/norm', 'a plain float is a knob');
  assertEqual(widgetOf(oneParam(F(1, 8, 0x31, { step: 1 }))), 'stepper/device/named/norm', 'integral bounds with a whole step: stepper');
  assertEqual(widgetOf(oneParam(F(0, 100, 0x31, { scale: 100, step: 0.01 }))), 'stepper/device/named/norm', 'step * scale is the display step (1 here)');
  assertEqual(widgetOf(oneParam(F(0, 100, 0x31, { scale: 100, step: 0.001 }))), 'knob/device/named/norm', 'a fine display step stays a knob');
  assertEqual(widgetOf(oneParam(F(0, 8.5, 0x31, { step: 1 }))), 'knob/device/named/norm', 'non-integral bounds stay a knob');
  assertEqual(widgetOf(oneParam(F(1, 8, 0x52, { step: 1 }))), 'knob/device/named/norm', 'a typecode-0x52 knob row has no usable step');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { def: D(5, 'WW_SEL', 'enum') })), 'stepper/catalog/named/norm', 'a catalog selector unit makes a float row a stepper');
  assert(isEnumOnAnyDevice('TENTAP', 'TENTAP_DECAYSTYLE'), 'premise: TENTAP_DECAYSTYLE is a selector on some device');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { fam: 'TENTAP', def: D(5, 'TENTAP_DECAYSTYLE', 'unverified') })), 'stepper/catalog/named/norm', 'a param that is a selector on another device is a stepper here too');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { layoutWidget: 'dropdown' })), 'stepper/layout/named/norm', 'the editor draws a dropdown: stepper, from the layout');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { layoutWidget: 'toggle' })), 'stepper/layout/named/norm', 'the editor draws a toggle: stepper, from the layout');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { layoutWidget: 'knob' })), 'knob/device/named/norm', 'a layout knob changes nothing');
  assertEqual(widgetOf(oneParam(F(0, 4, 0x31, { step: 0.1 }), { layoutWidget: 'dropdown', def: null })), 'stepper/layout/named/norm', 'layout evidence reaches a generic param');
  // log taper wins over every selector hint
  assertEqual(widgetOf(oneParam(F(20, 20000, 0x241, { step: 1 }), { def: D(5, 'WW_FREQ', 'enum') })), 'knob/device/named/norm', 'a log-tapered row is a knob (typecode nibble 4)');
  assertEqual(widgetOf(oneParam(F(20, 20000, 0x31, { step: 1, taper: 'log' }))), 'knob/device/named/norm', 'a log-tapered row is a knob (explicit taper)');
  assertEqual(widgetOf(oneParam(F(1, 8, 0x241, { step: 1, taper: 'linear' }))), 'stepper/device/named/norm', 'an explicit linear taper beats the typecode nibble');

  // step
  assertEqual(oneParam(F(0, 10, 0x31, { step: 0.001, scale: 10 })).step, 0.01, 'step is in display units, float noise tidied');
  assertEqual(oneParam(F(0, 10, 0x31, { step: 0 })).step, undefined, 'no step when the row has none');
  assertEqual(oneParam(F(0, 10, 0x52, { step: 0.5 })).step, undefined, 'no step on a typecode-0x52 row');
  assertEqual(oneParam(E(3, { step: 1 })).step, undefined, 'enum entries carry no step');

  // generic typecode-0xF0 rows are monitors / derived values: no write path
  const f0 = oneParam(F(0, 100, 0xf0), { def: null });
  assertEqual(`${f0.generic}/${f0.write}/${f0.readOnlyReason}`, 'true/null/generic-typecode-f0', 'a generic tc-0xF0 row is read-only');
  assertEqual(oneParam(F(0, 100, 0xf0)).write, 'norm', 'a named tc-0xF0 row stays writable as before');
  assertEqual(oneParam(E(3, { typecode: 0xf0 }), { def: null }).readOnlyReason, 'generic-typecode-f0', 'also for a generic enum');

  // kinds never cross: an enum entry is never in named, a labelless float never in enums
  for (const row of [E(2), E(5), F(0, 1, 0xd0), F(0, 9, 0x31)]) {
    const e = oneParam(row, row.kind === 'float' && row.typecode === 0xd0 ? { labels: ['a', 'b'] } : {});
    assertEqual(e.list === 'named', e.kind === 'float' && e.write === 'norm', `${row.kind} ${row.typecode}: list follows the row`);
  }
}

// ── 6b. layout knob over a wide integral range ──
function layoutKnobWins(): void {
  const widgetOf = (e: ParamEntry) => `${e.widget}/${e.widgetSource}/${e.write}`;
  const wide = F(0, 100, 0x31, { step: 1 }); // 100 whole steps
  assertEqual(widgetOf(oneParam(wide, { layoutWidget: 'knob' })), 'knob/layout/norm', 'the editor draws a knob over more than 64 steps: knob');
  assertEqual(oneParam(wide, { layoutWidget: 'knob' }).step, 1, 'and the step stays in the entry');
  assertEqual(widgetOf(oneParam(wide)), 'stepper/device/norm', 'no layout evidence: the integral rule stands');
  assertEqual(widgetOf(oneParam(wide, { def: null })), 'stepper/device/norm', 'a generic row without layout evidence keeps the stepper');
  assertEqual(widgetOf(oneParam(wide, { layoutWidget: 'dropdown' })), 'stepper/device/norm', 'a layout dropdown does not make it a knob');
  assertEqual(widgetOf(oneParam(F(0, 64, 0x31, { step: 1 }), { layoutWidget: 'knob' })), 'stepper/device/norm', 'exactly 64 steps are still detents');
  assertEqual(widgetOf(oneParam(F(0, 65, 0x31, { step: 1 }), { layoutWidget: 'knob' })), 'knob/layout/norm', '65 steps are not');
  assertEqual(widgetOf(oneParam(wide, { layoutWidget: 'knob', def: D(5, 'WW_SEL', 'enum') })), 'stepper/device/norm', 'a catalog selector unit is not outvoted by a layout knob');
  assertEqual(widgetOf(oneParam(F(0, 100, 0x52, { step: 1 }), { layoutWidget: 'knob' })), 'knob/device/norm', 'a typecode-0x52 row has no step to begin with');

  // the committed catalogs: a modifier attack (0..10000) is a knob, a semitone shift (-24..24) a stepper
  for (const [name, p] of [['FM3', PROFILES[0x11]!], ['FM9', PROFILES[0x12]!], ['Axe-Fx III', PROFILES[0x10]!]] as const) {
    const named = (fam: string, defName: string) => {
      const pid = p.params[fam]!.find((d) => d.name === defName)!.paramId;
      return entry(buildParamIndex(p, fam), pid);
    };
    assertEqual(widgetOf(named('MOD', 'MOD_ATTACK')), 'knob/layout/norm', `${name}: modifier attack`);
    assertEqual(widgetOf(named('GLOBAL', 'GLOBAL_FC_RING_BRIGHT_LEVEL')), 'knob/layout/norm', `${name}: ring brightness (75 steps)`);
    const fsb = p.params.GLOBAL!.find((d) => d.name === 'GLOBAL_FS_BRIGHTNESS'); // no row on the FM9 / III catalogs
    if (fsb && p.ranges.GLOBAL![fsb.paramId]) assertEqual(widgetOf(named('GLOBAL', 'GLOBAL_FS_BRIGHTNESS')), 'knob/layout/norm', `${name}: footswitch brightness (100 steps)`);
    assertEqual(widgetOf(named('PITCH', 'PITCH_SHIFT1')), 'stepper/device/norm', `${name}: semitone shift`);
    assertEqual(widgetOf(named('DISTORT', 'DISTORT_LINEFREQ')), 'stepper/device/norm', `${name}: AC line frequency (14 steps of 5)`);
  }
}

// ── 6c. a named row on a continuous catalog unit over a fine whole-step range: knob (catalog evidence) ──
function catalogUnitKnobRule(): void {
  const widgetOf = (e: ParamEntry) => `${e.widget}/${e.widgetSource}/${e.write}`;
  const wide = F(1, 16000, 0x31, { step: 1 }); // 15999 whole steps, no layout evidence
  const unitOf = (unit: string | undefined, row: RangeDef = wide, o: { layoutWidget?: string; fam?: string; name?: string } = {}) =>
    oneParam(row, { def: D(5, o.name ?? `${o.fam ?? 'WW'}_PARAM`, unit), ...o });

  // the premise: the set is what it says, and 64 is the detent limit
  assertEqual([...CONTINUOUS_CATALOG_UNITS].sort().join(','), 'bipolar_percent,db,degrees,hz,knob_0_10,ms,percent,ratio,seconds', 'the continuous units');
  assertEqual(MAX_STEPPER_DETENTS, 64, 'detent limit');

  // every continuous unit: knob, source catalog, the step stays in the entry
  for (const unit of CONTINUOUS_CATALOG_UNITS) {
    const e = unitOf(unit);
    assertEqual(widgetOf(e), 'knob/catalog/norm', `${unit}: a named row over ${wide.displayMax - wide.displayMin} whole steps is a knob`);
    assertEqual(`${e.list}/${e.kind}/${e.step}`, 'named/float/1', `${unit}: still a named float row, step kept`);
  }

  // the detent boundary: 64 steps are detents, 65 are not
  assertEqual(widgetOf(unitOf('ms', F(0, 64, 0x31, { step: 1 }))), 'stepper/device/norm', 'ms over exactly 64 steps: stepper');
  assertEqual(widgetOf(unitOf('ms', F(0, 65, 0x31, { step: 1 }))), 'knob/catalog/norm', 'ms over 65 steps: knob');
  assertEqual(widgetOf(unitOf('ms', F(0, 250, 0x31, { step: 1 }))), 'knob/catalog/norm', 'REVERBDELAY shape: 250 steps');
  assertEqual(widgetOf(unitOf('hz', F(-24, 24, 0x31, { step: 1 }))), 'stepper/device/norm', '48 steps of a continuous unit stay detents');
  assertEqual(widgetOf(unitOf('ms', F(0, 650, 0x31, { step: 10 }))), 'knob/catalog/norm', 'the step counts, not the span: 65 steps of 10');
  assertEqual(widgetOf(unitOf('ms', F(0, 640, 0x31, { step: 10 }))), 'stepper/device/norm', 'and 64 steps of 10 are detents');

  // units that prove nothing about continuity keep the stepper, whatever the span
  for (const unit of ['numeric', 'count', 'unverified', 'pf', 'semitones', 'enum', undefined]) {
    assertEqual(widgetOf(unitOf(unit)), 'stepper/device/norm', `${unit ?? 'no unit'}: no pure detent-count fallback`);
  }
  assertEqual(widgetOf(unitOf('numeric', F(0, 1023, 0x20, { step: 1 }), { fam: 'CABINET', name: 'CABINET_TYPE1' })), 'stepper/device/norm', 'a 0..1023 slot number stays a stepper');
  assertEqual(widgetOf(unitOf('semitones', F(-100, 100, 0x31, { step: 1 }))), 'stepper/device/norm', 'semitones are intervals: stepper even over 200 steps');

  // generic rows keep the stepper rule (no catalog unit to go by)
  assertEqual(widgetOf(oneParam(wide, { def: null })), 'stepper/device/norm', 'a generic row without layout evidence is a stepper');

  // layout evidence comes first (D5): a knob stays a layout knob, anything else keeps the stepper
  assertEqual(widgetOf(unitOf('ms', wide, { layoutWidget: 'knob' })), 'knob/layout/norm', 'the editor draws a knob: knob from the layout');
  assertEqual(widgetOf(unitOf('numeric', wide, { layoutWidget: 'knob' })), 'knob/layout/norm', 'the layout knob does not need a unit');
  for (const w of ['dropdown', 'toggle', 'readout']) {
    assertEqual(widgetOf(unitOf('ms', wide, { layoutWidget: w })), 'stepper/device/norm', `the editor draws a ${w}: the catalog unit does not outvote it`);
  }
  assertEqual(widgetOf(unitOf('ms', F(0, 64, 0x31, { step: 1 }), { layoutWidget: 'knob' })), 'stepper/device/norm', 'a layout knob over 64 steps or fewer is not a knob either');

  // a selector on another device, or a log taper, are decided before the rule (and as before)
  assert(isEnumOnAnyDevice('TENTAP', 'TENTAP_DECAYSTYLE'), 'premise: TENTAP_DECAYSTYLE is a selector on some device');
  assertEqual(widgetOf(unitOf('ms', wide, { fam: 'TENTAP', name: 'TENTAP_DECAYSTYLE' })), 'stepper/device/norm', 'a catalog selector is never a catalog knob');
  assertEqual(widgetOf(unitOf('ms', F(20, 20000, 0x241, { step: 1 }))), 'knob/device/norm', 'a log-tapered row is a device knob, not a catalog one');
  // non-integral and fine-step rows are knobs as before, with their own source
  assertEqual(widgetOf(unitOf('ms', F(0, 100, 0x31, { step: 0.1 }))), 'knob/device/norm', 'a fine display step: knob from the device row');
  assertEqual(widgetOf(unitOf('ms', F(0, 100, 0x31, { step: 1 }), { layoutWidget: 'dropdown' })), 'stepper/device/norm', 'a whole-step row under a layout dropdown stays a stepper');
}

// ── 6d. the rule on the committed catalogs: exactly the time rows the contract names change ──
function catalogUnitKnobCatalogs(): void {
  const widgetOf = (e: ParamEntry) => `${e.widget}/${e.widgetSource}/${e.list}/${e.write}/${e.step}`;
  for (const [name, mid] of DEVICES) {
    const staticP = PROFILES[mid]!;
    for (const [mode, p] of [['catalog', staticP], ['byte-exact catalog profile', runtimeProfileFrom(catalogBuilt(mid), staticP)]] as const) {
      const named = (fam: string, defName: string): ParamEntry | undefined => {
        const pid = p.params[fam]?.find((d) => d.name === defName)?.paramId;
        return pid === undefined ? undefined : buildParamIndex(p, fam).byPid.get(pid);
      };
      const label = `${name} ${mode}`;
      // DELAY_TIME is a knob from layout evidence since the editor layouts give the Delay its own family (its editor
      // page used to be filed under MULTITAP, so the DELAY family had no layout evidence and the catalog rule decided)
      assertEqual(widgetOf(named('DELAY', 'DELAY_TIME')!), 'knob/layout/named/norm/1', `${label}: DELAY_TIME (ms, 1..16000) is a knob (the Delay layout draws one)`);
      assertEqual(widgetOf(named('REVERB', 'REVERB_REVERBDELAY')!), 'knob/catalog/named/norm/1', `${label}: REVERB_REVERBDELAY (ms, 0..250) is a knob`);
      // unit numeric: a long time field is a number, not proof of a dial; these two are knobs only because the Delay
      // editor layout draws knobs for them (layout evidence first, D5)
      for (const n of ['DELAY_TIMER', 'DELAY_SPLICETIME']) {
        assertEqual(widgetOf(named('DELAY', n)!).split('/').slice(0, 2).join('/'), 'knob/layout', `${label}: ${n} is a knob from the Delay layout`);
      }
      // the slot numbers stay steppers (a 0..1023 range is no knob)
      for (const n of ['CABINET_TYPE1', 'CABINET_TYPE2', 'CABINET_TYPE3', 'CABINET_TYPE4']) {
        const e = named('CABINET', n);
        if (e) assertEqual(`${e.widget}/${e.widgetSource}`, 'stepper/device', `${label}: ${n} stays a stepper`);
      }
      // nothing else changed: the catalog knobs are exactly the reverb delay (DELAY_TIME has layout evidence), named, on a continuous unit,
      // all over more than 64 whole steps and none with layout evidence
      const catalogKnobs: string[] = [];
      for (const fam of Object.keys(p.ranges)) {
        const lw = layoutWidgetIndex(p, fam);
        for (const e of buildParamIndex(p, fam).entries) {
          if (e.widget !== 'knob' || e.widgetSource !== 'catalog') continue;
          catalogKnobs.push(e.def!.name);
          assertEqual(e.generic, false, `${label} ${fam} ${e.pid}: a catalog knob is a named row`);
          assert(CONTINUOUS_CATALOG_UNITS.has(e.def!.unit ?? ''), `${label} ${fam} ${e.pid}: on a continuous unit`);
          assert((e.row.displayMax - e.row.displayMin) / e.step! > MAX_STEPPER_DETENTS, `${label} ${fam} ${e.pid}: over more than 64 steps`);
          assertEqual(lw.get(e.pid), undefined, `${label} ${fam} ${e.pid}: no layout evidence`);
        }
      }
      assertEqual(catalogKnobs.sort().join(','), 'REVERB_REVERBDELAY', `${label}: the catalog knobs`);
    }
  }
}

// ── 7. exclusions by design ──
function exclusions(): void {
  assert(NOT_LISTED_BY_DESIGN.has('MOD_EFFECTID'), 'MOD_EFFECTID is not listed by design');
  const S = mkStatic([{
    fam: 'MOD', stride: 30,
    defs: [D(0, 'MOD_SOURCE'), D(1, 'MOD_MIN'), D(2, 'MOD_MAX'), D(8, 'MOD_EFFECTID', 'unverified'), D(9, 'MOD_PARAM')],
    rows: { 0: E(4), 1: F(0, 1, 0x31), 2: F(0, 1, 0x31), 8: E(100), 9: F(0, 1, 0x31) },
  }]);
  const idx = buildParamIndex(S, 'MOD');
  assertEqual(hiddenOf(idx), '8:by-design', 'the modifier target id is never listed');
  assertEqual(names(idx), '0:SOURCE,1:MIN,2:MAX,9:PARAM', 'the other modifier params are');
}

// ── 8. positional ──
function positional(): void {
  const mk = (stride: number | undefined, extraPid?: number) => {
    const rows: Record<number, RangeDef> = { 0: F(0, 1), 1: F(0, 1), 2: F(0, 1) };
    if (extraPid !== undefined) rows[extraPid] = F(0, 1);
    return buildParamIndex(mkStatic([{ fam: 'PP', rows, defs: [D(0, 'PP_A')], ...(stride !== undefined ? { stride } : {}) }]), 'PP');
  };
  assertEqual(mk(3).positional, true, 'every row below the stride');
  assertEqual(mk(2).positional, false, 'a row at or above the stride');
  assertEqual(mk(3, 9000).positional, false, 'a sparse high row (GLOBAL shape) makes the family non-positional');
  assertEqual(mk(undefined).positional, null, 'no known stride: unknown, decided at read time from the actual body');
  assertEqual(mk(3, 9000).maxPid, 9000, 'maxPid reports the highest informative row');
  assertEqual(mk(3).maxPid, 2, 'and is not raised by anything else');

  // only informative rows count: a catalog definition without a row, a placeholder, a removed row do not
  const S = mkStatic([{ fam: 'PQ', rows: { 0: F(0, 1), 1: F(0, 1), 5: PH }, defs: [D(0, 'PQ_A'), D(1, 'PQ_B'), D(500, 'PQ_FAR'), D(5, 'PQ_UNUSED')], stride: 2 }]);
  assertEqual(buildParamIndex(S, 'PQ').positional, true, 'a definition without a row (or with an unused slot) beyond the stride does not matter');
  const R = mkStatic([{ fam: 'PR', rows: { 0: F(0, 1), 1: F(0, 1), 2: F(0, 1) }, defs: [D(0, 'PR_A'), D(1, 'PR_B'), D(2, 'PR_C')], stride: 3 }]);
  const gone = mkBuilt([{ fam: 'PR', stride: 2, rows: { 0: F(0, 1), 1: F(0, 1) } }], 'editor-cache');
  const ri = buildParamIndex(runtimeProfileFrom(gone, R), 'PR');
  assertEqual(hiddenOf(ri), '2:removed', 'premise: pid 2 is removed');
  assertEqual(`${ri.positional}/${ri.maxPid}`, 'true/1', 'a removed row does not count (the profile stride is 2)');
  // hidden type / bypass rows do count: their values sit in the body too
  const H = mkStatic([{ fam: 'PH', rows: { 0: F(0, 1), 1: F(0, 1, 0xe0) }, defs: [D(0, 'PH_A'), D(1, 'PH_BYPASS')], stride: 1 }]);
  assertEqual(buildParamIndex(H, 'PH').positional, false, 'a bypass row above the stride counts');
}

// ── 9. the dev hook ──
function forceGeneric(): void {
  const S = mkStatic([{ fam: 'FG', stride: 8, defs: [D(0, 'FG_RATE'), D(1, 'FG_LFO', 'enum')], rows: { 0: F(0, 10), 1: E(10) }, labels: { 1: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] } }]);
  const plain = buildParamIndex(S, 'FG');
  const forced = buildParamIndex(S, 'FG', { forceGeneric: new Set([1]) });
  assert(forced !== plain, 'a forced index is its own object');
  assert(buildParamIndex(S, 'FG') === plain, 'and does not disturb the memoised one');
  assertEqual(entry(plain, 1).name, 'LFO', 'normally named');
  const e = entry(forced, 1);
  assertEqual(`${e.name}/${e.generic}/${e.nameSource}/${e.widget}/${e.options!.hi}`, 'P1/true/generic/dropdown/9', 'forced: served as P1, a dropdown with the ten device labels');
  assertEqual(e.nameConfidence, undefined, 'forced generic has no confidence');
  assertEqual(entry(forced, 0).name, 'RATE', 'other params keep their names');
  assertEqual(buildParamIndex(S, 'FG', { forceGeneric: new Set() }) === plain, true, 'an empty set is no hook');
}

// ── 10. invariants over the committed catalogs ──
const DEVICES: Array<[string, number]> = [['FM3', 0x11], ['FM9', 0x12], ['Axe-Fx III', 0x10]];

const informativeCount = (p: DeviceProfile, fam: string) =>
  Object.entries(p.ranges[fam] ?? {}).filter(([pid, r]) => Number(pid) <= MAX_WIRE_PID && isInformativeRow(r)).length;

function catalogInvariants(): void {
  for (const [name, mid] of DEVICES) {
    const staticP = PROFILES[mid]!;
    const exact = runtimeProfileFrom(catalogBuilt(mid), staticP);
    for (const [mode, p] of [['catalog only', staticP], ['byte-exact catalog profile', exact]] as const) {
      for (const fam of Object.keys(p.ranges)) {
        const idx = buildParamIndex(p, fam);
        const label = `${name} ${mode} ${fam}`;
        const layoutWidgets = layoutWidgetIndex(p, fam);
        for (const e of idx.entries) {
          // a float with selector evidence (a catalog selector unit, a selector on another device, an editor dropdown or
          // toggle) is served as a stepper, never as a knob; log-tapered rows are the only thing that could outrank it
          const selectorEvidence = !!e.def && (e.def.unit === 'enum' || isEnumOnAnyDevice(fam, e.def.name));
          const layoutSelector = ['dropdown', 'toggle'].includes(layoutWidgets.get(e.pid) ?? '');
          if (e.list === 'named' && (selectorEvidence || layoutSelector)) assert(e.widget !== 'knob', `${label} ${e.pid}: a float with selector evidence is not a knob`);
          assert(!(e.list === 'named' && e.kind === 'enum'), `${label} ${e.pid}: no enum-kind entry in named`);
          assert(e.list === 'named' ? e.widget === 'knob' || e.widget === 'stepper' : e.widget === 'toggle' || e.widget === 'dropdown', `${label} ${e.pid}: widget matches the list`);
          assert(e.list === 'enums' ? e.options !== undefined : e.options === undefined, `${label} ${e.pid}: options exactly on selectors`);
          assert(e.fp.startsWith('1:'), `${label} ${e.pid}: fingerprint`);
          assertEqual(e.generic, e.nameSource === 'generic', `${label} ${e.pid}: generic <=> generic nameSource`);
          assertEqual(e.nameConfidence === undefined, e.generic, `${label} ${e.pid}: confidence <=> named`);
          if (e.generic) assertEqual(e.name, `P${e.pid}`, `${label} ${e.pid}: generic names are P<pid>`);
        }
        const removed = idx.hidden.filter((h) => h.reason === 'removed');
        // listed + hidden (other than 'removed', which are rows the profile does not have) = the informative
        // rows of what backs the family: the profile's own rows when there is one, else the catalog's
        const backing = mode === 'byte-exact catalog profile' ? exact.profileFacts!.ranges[fam] : undefined;
        const expected = backing
          ? Object.entries(backing).filter(([pid, r]) => Number(pid) <= MAX_WIRE_PID && isInformativeRow(r)).length
          : informativeCount(p, fam);
        assertEqual(idx.entries.length + idx.hidden.length - removed.length, expected, `${label}: listed + hidden covers every informative row`);
        if (mode === 'byte-exact catalog profile') {
          if (name === 'Axe-Fx III') {
            // the III's static table adds rows made from inline bounds; a profile that has no such row drops them
            for (const h of removed) assert(staticP.ranges[fam]![h.id]?.synthetic === true, `${label} ${h.id}: only synthetic rows can be removed`);
          } else {
            assertEqual(removed.length, 0, `${label}: the catalog read back loses nothing`);
          }
        }
        // bypass hides exactly the typecode-0xE0 rows: no label-only bypass exists in the catalogs
        const e0 = Object.entries(p.ranges[fam] ?? {}).filter(([pid, r]) => Number(pid) <= MAX_WIRE_PID && isInformativeRow(r) && r.typecode === 0xe0).map(([pid]) => Number(pid));
        const hiddenBypass = idx.hidden.filter((h) => h.reason === 'bypass').map((h) => h.id);
        assertEqual(hiddenBypass.join(','), e0.join(','), `${label}: bypass hides exactly the typecode-0xE0 rows`);
        // an assigned family with a profile agrees with its catalog row by row
        if (mode === 'byte-exact catalog profile') {
          assert(idx.entries.every((e) => e.generic || e.nameConfidence === 'high'), `${label}: every name is confirmed by an equal fingerprint`);
        }
      }
    }
    // the catalog-only and the profile views of the same data list the same params
    if (name !== 'Axe-Fx III') {
      for (const fam of Object.keys(staticP.ranges)) {
        assertEqual(names(buildParamIndex(exact, fam)), names(buildParamIndex(staticP, fam)), `${name} ${fam}: the catalog read back as a profile lists what the catalog lists`);
      }
    }
  }
}

// ── 11. FM3 goldens (the catalog is the fw 12.0 profile) ──
function fm3Goldens(): void {
  for (const source of ['catalog', 'profile'] as const) {
    const p = source === 'catalog' ? PROFILES[0x11]! : runtimeProfileFrom(catalogBuilt(0x11), PROFILES[0x11]!);
    let total = 0;
    let generic = 0;
    const per: Record<string, number> = {};
    const genericFams = new Set<string>();
    for (const fam of Object.keys(p.ranges)) {
      if (fam === 'PRESET') continue; // no effect id: no block can reach it
      const idx = buildParamIndex(p, fam);
      per[fam] = idx.entries.length;
      total += idx.entries.length;
      for (const e of idx.entries) if (e.generic) { generic++; genericFams.add(fam); }
      if (fam !== 'GLOBAL') assertEqual(idx.positional, true, `${source} ${fam}: positional`);
    }
    assertEqual(total, 1611, `${source}: params over the reachable FM3 families`);
    assertEqual(generic, 27, `${source}: generic params`);
    assertEqual([...genericFams].join(','), 'GLOBAL', `${source}: every generic param is on GLOBAL`);
    for (const [fam, n] of Object.entries({ CABINET: 62, CHORUS: 26, CONTROLLERS: 126, DELAY: 81, DISTORT: 139, FUZZ: 41, GLOBAL: 186, MIXER: 16, PITCH: 109 })) {
      assertEqual(per[fam], n, `${source}: ${fam}`);
    }
    const global = buildParamIndex(p, 'GLOBAL');
    assertEqual(global.positional, false, `${source}: GLOBAL is not positional`);
    assertEqual(global.entries.filter((e) => e.generic).every((e) => e.pageHint === 'more' && !e.isNew), true, `${source}: the 27 are old unnamed rows`);
    assertEqual(global.profile, source === 'catalog' ? 'none' : 'byte-exact', `${source}: GLOBAL backing`);
    // the effective selectors per family (they follow the names)
    const sel = (fam: string) => { const i = buildParamIndex(p, fam); return `${i.typePid ?? '-'}/${i.variantPid ?? '-'}`; };
    assertEqual([sel('CABINET'), sel('PLEX'), sel('MULTITAP'), sel('DELAY'), sel('GLOBAL'), sel('CONTROLLERS')].join(' '), '-/31 -/0 -/0 6/6 -/- -/-', `${source}: type/variant pids`);
    // the selectors the old heuristic hid are listed now
    const cab = buildParamIndex(p, 'CABINET');
    assertEqual(cab.hidden.some((h) => h.reason === 'type'), false, `${source}: CABINET has no type selector to hide`);
    assertEqual(cab.byPid.has(43), true, `${source}: the cab preamp type is listed`);
    assertEqual(buildParamIndex(p, 'PLEX').byPid.has(82), true, `${source}: PLEX_FILTERTYPE is listed`);
    assertEqual(buildParamIndex(p, 'CONTROLLERS').byPid.has(0), true, `${source}: CONTROLLERS_LFO1TYPE is listed`);
    assertEqual(buildParamIndex(p, 'GLOBAL').byPid.has(104), true, `${source}: GLOBAL_CC_BYPASS_TYPE is listed`);
    // the two PRESET rows without a name are unreachable but still indexed
    const preset = buildParamIndex(p, 'PRESET');
    assertEqual(preset.entries.filter((e) => e.generic).map((e) => e.pid).join(','), '0,216', `${source}: the two unnamed PRESET rows`);
  }
}

// ── 12. synthetic Axe-Fx III rows are never fingerprint-compared ──
function synthetic(): void {
  const p = PROFILES[0x10]!;
  let rows = 0;
  for (const fam of Object.keys(p.ranges)) {
    for (const [pid, r] of Object.entries(p.ranges[fam]!)) {
      if (!r.synthetic || !isInformativeRow(r)) continue;
      rows++;
      assertEqual(r.typecode, 0, `${fam} ${pid}: a synthetic row has no typecode`);
    }
  }
  assert(rows > 0, 'the III catalog has synthetic rows');
  // a synthetic row against a profile row: matching kind is compatible, a kind change is not
  const S = mkStatic([{ fam: 'SY', stride: 4, defs: [D(0, 'SY_A'), D(1, 'SY_B')], rows: { 0: F(0, 10, 0, { synthetic: true, step: 0 }), 1: E(3, { synthetic: true, typecode: 0 }) } }]);
  const built = mkBuilt([{ fam: 'SY', stride: 4, rows: { 0: F(0, 12, 0x31), 1: F(0, 1, 0x31) } }], 'editor-cache');
  const idx = buildParamIndex(runtimeProfileFrom(built, S), 'SY');
  assertEqual(entry(idx, 0).nameConfidence, 'medium', 'synthetic row, same kind: medium (no fingerprint to compare)');
  assertEqual(entry(idx, 1).nameConfidence, 'low', 'synthetic row, kind changed: low');
  assertEqual(entry(idx, 0).isNew, undefined, 'a synthetic catalog row still counts as a catalog row');
}

// ── 13. entry facts the response builders need ──
function entryFacts(): void {
  const S = mkStatic([{
    fam: 'EF', stride: 12,
    defs: [D(0, 'EF_DRIVE', 'numeric', 'Drive'), D(1, 'EF_SPEED', 'ms'), D(2, 'EF_KIND', 'enum')],
    rows: { 0: F(0, 10), 1: F(1, 3000, 0x241), 2: E(3) },
    labels: { 2: ['a', 'b', 'c'] },
  }]);
  const idx = buildParamIndex(S, 'EF');
  assertEqual(entry(idx, 0).name, 'Drive', 'the display label wins');
  assertEqual(entry(idx, 1).name, 'SPEED', 'else the tidied name');
  assertEqual(entry(idx, 0).def?.unit, 'numeric', 'the catalog unit code is reachable for the response builders');
  assertEqual(entry(idx, 2).labels!.join(''), 'abc', 'labels');
  assertEqual(entry(idx, 0).labels, undefined, 'no labels on a plain float');
  assertEqual(idx.entries.map((e) => e.list).join(','), 'named,named,enums', 'list per entry');
  assertEqual(idx.byPid.size, 3, 'byPid covers the listed entries');
}

// ── 14. no profile facts at all (a hand-built profile) ──
function noFacts(): void {
  const S = mkStatic([{ fam: 'NF', stride: 4, defs: [D(0, 'NF_A')], rows: { 0: F(0, 1), 1: F(0, 1, 0x41) } }]);
  assertEqual(S.profileFacts, undefined, 'premise: no facts');
  const idx = buildParamIndex(S, 'NF');
  assertEqual(`${idx.profile}/${idx.suspect}/${idx.entries.length}`, 'none/false/2', 'a profile without facts is the catalog');
}

// ── 15. shifting rows of a real family (committed FM3 catalog) ──
/** The catalog of `fam` as a device profile with one row inserted at `at` (pids `at..` move up by one) or
 *  deleted at `at` (pids above move down by one); labels and the section stride follow. */
function shiftedBuilt(fam: string, at: number, mode: 'insert' | 'delete', source: 'editor-cache' | 'live' = 'editor-cache'): BuiltCache {
  const b = catalogBuilt(0x11, source);
  const rows = b.ranges[fam] as Record<number, RangeDef>;
  const labels = (b.enumOverrides[fam] ?? {}) as Record<string, string[]>;
  const nr: Record<number, RangeDef> = {};
  const nl: Record<string, string[]> = {};
  for (const pid of Object.keys(rows).map(Number)) {
    let to = pid;
    if (mode === 'insert' && pid >= at) to = pid + 1;
    if (mode === 'delete') { if (pid === at) continue; if (pid > at) to = pid - 1; }
    nr[to] = rows[pid]!;
    if (labels[String(pid)]) nl[String(to)] = labels[String(pid)]!;
  }
  if (mode === 'insert') nr[at] = F(0, 1, 0x7f1);
  b.ranges[fam] = nr;
  b.enumOverrides[fam] = nl;
  const sec = b.rangeSections[fam]!;
  b.rangeSections[fam] = { ...sec, stride: sec.stride + (mode === 'insert' ? 1 : -1) };
  return b;
}

function typeFollowsName(): void {
  const FM3 = PROFILES[0x11]!;
  const clean = buildParamIndex(FM3, 'ENHANCER');
  assertEqual(`${clean.typePid}/${clean.variantPid}`, '6/6', 'premise: ENHANCER_TYPE sits at pid 6');
  // a row inserted at pid 3 moves TYPE to pid 7
  const ins = buildParamIndex(runtimeProfileFrom(shiftedBuilt('ENHANCER', 3, 'insert'), FM3), 'ENHANCER');
  assertEqual(`${ins.typePid}/${ins.variantPid}`, '7/7', 'insert: the effective type selector moved with its name');
  assertEqual(hiddenOf(ins), '6:bypass,7:type', 'insert: pid 7 is hidden as the type, pid 6 as the (moved) bypass');
  assertEqual(ins.byPid.has(7), false, 'insert: the type is not listed as an ordinary enum');
  assertEqual(`${entry(ins, 4).name}/${entry(ins, 4).movedFrom}`, 'High Cut/3', 'insert: the names above the new row follow their rows');
  assertEqual(`${entry(ins, 8).name}/${entry(ins, 8).movedFrom}`, 'Phase Invert/7', 'insert: the name right behind the type moved too');
  assertEqual(`${entry(ins, 3).generic}/${entry(ins, 3).isNew}`, 'true/undefined', 'insert: the new row is generic (the catalog has a row at 3)');
  // pids 8 and 9 carry the same fingerprint (a left/right pair): nothing may move for them
  assertEqual(`${entry(ins, 9).name}/${entry(ins, 9).nameSource}/${entry(ins, 9).nameConfidence}`, 'Pan Right/catalog/high', 'insert: the identical pair does not move (the row at 9 still looks like pid 9)');
  assertEqual(entry(ins, 10).generic, true, 'insert: and the name that has no unique row is dropped rather than guessed');
  // a row deleted at pid 3 moves TYPE down to pid 5
  const del = buildParamIndex(runtimeProfileFrom(shiftedBuilt('ENHANCER', 3, 'delete'), FM3), 'ENHANCER');
  assertEqual(`${del.typePid}/${del.variantPid}`, '5/5', 'delete: the effective type selector moved down');
  assertEqual(hiddenOf(del), '4:bypass,5:type,11:removed', 'delete: pid 5 is the type, pid 4 the bypass, the last slot is gone');
  assertEqual(del.byPid.has(6), true, 'delete: pid 6 is an ordinary param now');
  assertEqual(del.byPid.has(5), false, 'delete: the type is not listed');
  // a family without a type selector has none, whatever moves
  const cab = buildParamIndex(runtimeProfileFrom(shiftedBuilt('CABINET', 3, 'insert'), FM3), 'CABINET');
  assertEqual(cab.typePid, undefined, 'CABINET has no type selector');
  assertEqual(cab.variantPid, 32, 'its variant selector (CABINET_MODE 31) moved to 32');
  // a type selector whose name lost its row has no pid
  const lone = mkStatic([{ fam: 'TL', stride: 4, defs: [D(0, 'TL_TYPE'), D(1, 'TL_A')], rows: { 0: E(3), 1: F(0, 1, 0x41) }, labels: { 0: ['a', 'b', 'c'] } }]);
  const loneBuilt = mkBuilt([{ fam: 'TL', stride: 4, rows: { 0: PH, 1: F(0, 1, 0x41) } }], 'editor-cache');
  const li = buildParamIndex(runtimeProfileFrom(loneBuilt, lone), 'TL');
  assertEqual(`${li.typePid}/${li.variantPid}/${hiddenOf(li)}`, 'undefined/undefined/0:removed', 'a removed type selector leaves no type pid');
}

function deletionShift(): void {
  const FM3 = PROFILES[0x11]!;
  const del = buildParamIndex(runtimeProfileFrom(shiftedBuilt('ENHANCER', 3, 'delete'), FM3), 'ENHANCER');
  const last = entry(del, 10);
  assertEqual(`${last.name}/${last.nameSource}/${last.movedFrom}/${last.nameConfidence}`, 'Scene Ignore/catalog-moved/11/medium', 'delete: the last name follows its row down from the slot the firmware dropped');
  assertEqual(`${entry(del, 3).name}/${entry(del, 3).movedFrom}`, 'Level/4', 'delete: the rows behind the deleted one move down');
  assertEqual(`${entry(del, 9).name}/${entry(del, 9).movedFrom}`, 'Balance/10', 'delete: also the name that sat just before the dropped slot');
  assertEqual(entry(del, 7).generic, true, 'delete: and the pid whose name moved away without a successor is generic');

  // synthetic: the profile is one row shorter and the last row sits one pid lower
  const S = mkStatic([{ fam: 'DS', stride: 5, defs: [D(0, 'DS_A'), D(1, 'DS_B'), D(2, 'DS_C'), D(3, 'DS_D')], rows: { 0: F(0, 10, 0x31), 1: F(0, 20, 0x41), 2: F(-5, 5, 0x51), 3: F(0, 100, 0x61) } }]);
  const gone = mkBuilt([{ fam: 'DS', stride: 4, rows: { 0: F(0, 10, 0x31), 1: F(-5, 5, 0x51), 2: F(0, 100, 0x61) } }], 'editor-cache');
  const di = buildParamIndex(runtimeProfileFrom(gone, S), 'DS');
  assertEqual(names(di), '0:A,1:C,2:D', 'the names of the rows behind the deleted one moved down; the deleted row\'s name is gone');
  assertEqual(hiddenOf(di), '3:removed', 'the dropped slot is removed');
  // a live profile sees no deletion: a row missing from a live walk says nothing, so its pid is neither
  // hidden nor a shift source (the rows the walk did apply are judged as before)
  const liveGone = buildParamIndex(runtimeProfileFrom(mkBuilt([{ fam: 'DS', stride: 4, rows: { 0: F(0, 10, 0x31), 1: F(-5, 5, 0x51), 2: F(0, 100, 0x61) } }], 'live'), S), 'DS');
  assertEqual(hiddenOf(liveGone), '', 'live: nothing is hidden');
  assertEqual(`${entry(liveGone, 3).name}/${entry(liveGone, 3).nameSource}/${entry(liveGone, 3).source}`, 'D/catalog/catalog', 'live: the pid the walk did not return keeps its catalog row and name');
}

// ── 16. labels of a profile row ──
function profileLabels(): void {
  const FM3 = PROFILES[0x11]!;
  // a catalog enum that the profile ships as a float without labels stays a float
  const b = catalogBuilt(0x11);
  const svf = FM3.params.DELAY!.find((d) => d.name === 'DELAY_SVFTYPE')!.paramId;
  (b.ranges.DELAY as Record<number, RangeDef>)[svf] = F(0, 3, 0x31);
  delete (b.enumOverrides.DELAY as Record<string, string[]>)[String(svf)];
  const e = entry(buildParamIndex(runtimeProfileFrom(b, FM3), 'DELAY'), svf);
  assertEqual(`${e.name}/${e.kind}/${e.list}/${e.labels === undefined}/${e.nameConfidence}`, 'Filter Type/float/named/true/low', 'an enum the profile turned into a float is served as a continuous param, without the catalog labels');
  assert(e.widget === 'knob' || e.widget === 'stepper', 'knob or stepper, never a dropdown');
  // labels the profile does ship are the ones served
  (b.enumOverrides.DELAY as Record<string, string[]>)[String(svf)] = ['x', 'y', 'z', 'w'];
  assertEqual(entry(buildParamIndex(runtimeProfileFrom(b, FM3), 'DELAY'), svf).labels?.join(''), 'xyzw', 'the profile\'s own labels win');

  // a list the catalog has but the device cache does not hold (an overlay list): it stands for a row that is the catalog row
  const III = PROFILES[0x10]!;
  const exact = runtimeProfileFrom(catalogBuilt(0x10), III);
  for (const [fam, defName, count] of [['CONTROLLERS', 'CONTROLLERS_TEMPO', 79], ['MOD', 'MOD_SLOPE', 4]] as const) {
    const pid = III.params[fam]!.find((d) => d.name === defName)!.paramId;
    assertEqual(((exact.profileFacts!.enumLabels[fam] ?? {}) as Record<string, readonly string[]>)[String(pid)], undefined, `premise: the III cache holds no list for ${defName}`);
    for (const [mode, p] of [['catalog only', III], ['byte-exact profile', exact]] as const) {
      const en = entry(buildParamIndex(p, fam), pid);
      assertEqual(`${en.widget}/${en.list}/${en.labels?.length}/${en.nameConfidence}`, `dropdown/enums/${count}/high`, `${defName} (${mode}): still a dropdown with its list, confirmed`);
    }
  }
  // but a changed row does not inherit it
  const changed = catalogBuilt(0x10);
  const tempo = III.params.CONTROLLERS!.find((d) => d.name === 'CONTROLLERS_TEMPO')!.paramId;
  (changed.ranges.CONTROLLERS as Record<number, RangeDef>)[tempo] = F(30, 300, 0xb20);
  const ce = entry(buildParamIndex(runtimeProfileFrom(changed, III), 'CONTROLLERS'), tempo);
  assertEqual(`${ce.labels === undefined}/${ce.list}/${ce.widget}`, 'true/named/knob', 'a profile row that differs from the catalog row takes no catalog labels');
}

// ── 17. live kind conflict ──
function liveKindConflicts(): void {
  const FM3 = PROFILES[0x11]!;
  const live = runtimeProfileFrom(shiftedBuilt('TREMOLO', 15, 'insert', 'live'), FM3);
  const idx = buildParamIndex(live, 'TREMOLO');
  assertEqual(idx.profile, 'live', 'live profile');
  assertEqual(idx.entries.filter((e) => e.nameSource === 'catalog-moved').length, 0, 'a live profile moves no names');
  const order = entry(idx, 16); // TREMOLO_ORDER is an enum in the catalog; the walk sees the inserted row's neighbour, a float
  assertEqual(`${order.name}/${order.source}/${order.kind}/${order.nameConfidence}`, 'Crossover Slope/catalog/enum/medium', 'a live kind conflict keeps the catalog row and name at medium confidence');
  assertEqual(`${entry(idx, 2).source}/${entry(idx, 2).nameConfidence}`, 'profile/high', 'rows in front of the insertion are unchanged: high');
  assertEqual(entry(idx, 15).nameConfidence, 'low', 'an applied live row that differs and is incompatible: low');
  // the same shift in a byte-exact profile does move the names
  const exact = buildParamIndex(runtimeProfileFrom(shiftedBuilt('TREMOLO', 15, 'insert'), FM3), 'TREMOLO');
  assertEqual(exact.entries.some((e) => e.nameSource === 'catalog-moved'), true, 'byte-exact: the names follow their rows');
}

// ── 18. immutability ──
function immutability(): void {
  const idx = buildParamIndex(PROFILES[0x11]!, 'DELAY');
  assert(Object.isFrozen(idx) && Object.isFrozen(idx.entries) && Object.isFrozen(idx.hidden), 'the index and its arrays are frozen');
  assert(idx.hidden.length > 0 && Object.isFrozen(idx.hidden[0]), 'hidden items are frozen');
  const withLabels = idx.entries.find((e) => e.labels && e.options)!;
  assert(Object.isFrozen(withLabels) && Object.isFrozen(withLabels.labels) && Object.isFrozen(withLabels.options), 'entries, their labels and options are frozen');
  const mutations: Array<[string, () => void]> = [
    ['rename an entry', () => { (withLabels as { name: string }).name = 'x'; }],
    ['push an entry', () => { (idx.entries as ParamEntry[]).push(withLabels); }],
    ['rewrite a label', () => { (withLabels.labels as string[])[0] = 'x'; }],
    ['change the options', () => { (withLabels.options as { lo: number }).lo = 99; }],
    ['edit a hidden item', () => { (idx.hidden[0] as { id: number }).id = 99; }],
  ];
  for (const [what, fn] of mutations) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, `${what}: refused`);
  }
  // the entry's labels are a copy: the catalog's own list is neither shared nor frozen by the index
  const catalogList = PROFILES[0x11]!.enumLabelsFor('DELAY', withLabels.pid);
  assert(catalogList !== undefined && withLabels.labels !== catalogList, 'the labels are a copy of the catalog list');
  assert(!Object.isFrozen(catalogList), 'the catalog\'s list is left alone');
  assert(buildParamIndex(PROFILES[0x11]!, 'DELAY') === idx, 'and the frozen index is the memoised one');
  // a forced index is frozen as well
  assert(Object.isFrozen(buildParamIndex(PROFILES[0x11]!, 'DELAY', { forceGeneric: new Set([0]) })), 'a forced index is frozen too');
}

// ── 19. device totals (FM9 and III), with and without a profile ──
function deviceTotals(): void {
  // counts over every family, and without PRESET (it has no block, like the FM3 golden); 2 PRESET rows are unnamed
  const expected: Array<[string, number, 'catalog' | 'profile', number, number, number, number]> = [
    // device, model, backing, shown w/o PRESET, generic w/o PRESET, shown with PRESET, generic with PRESET
    ['FM9', 0x12, 'catalog', 1685, 49, 1735, 51],
    ['FM9', 0x12, 'profile', 1685, 49, 1735, 51],
    ['Axe-Fx III', 0x10, 'catalog', 1959, 30, 2009, 32],
    ['Axe-Fx III', 0x10, 'profile', 1948, 30, 1998, 32],
  ];
  for (const [name, mid, backing, shown, gen, shownAll, genAll] of expected) {
    const p = backing === 'catalog' ? PROFILES[mid]! : runtimeProfileFrom(catalogBuilt(mid), PROFILES[mid]!);
    let s = 0, g = 0, sa = 0, ga = 0;
    const nonPositional: string[] = [];
    for (const fam of Object.keys(p.ranges)) {
      const i = buildParamIndex(p, fam);
      sa += i.entries.length;
      ga += i.entries.filter((e) => e.generic).length;
      if (fam !== 'PRESET') { s += i.entries.length; g += i.entries.filter((e) => e.generic).length; }
      if (i.positional === false) nonPositional.push(fam);
    }
    assertEqual(`${s}/${g}/${sa}/${ga}`, `${shown}/${gen}/${shownAll}/${genAll}`, `${name} (${backing}): shown/generic without PRESET, then with`);
    assertEqual(nonPositional.join(','), 'GLOBAL,PRESET', `${name} (${backing}): only the sparse system families are non-positional`);
  }
  // the III's inline-bound rows: a byte-exact III profile hides them as removed, 11 today
  const III = PROFILES[0x10]!;
  const exact = runtimeProfileFrom(catalogBuilt(0x10), III);
  let removed = 0;
  for (const fam of Object.keys(exact.ranges)) removed += buildParamIndex(exact, fam).hidden.filter((h) => h.reason === 'removed').length;
  assertEqual(removed, 11, 'a byte-exact III profile hides 11 synthetic-only rows as removed');
  const irPlayer = buildParamIndex(III, 'IRPLAYER');
  assertEqual(`${irPlayer.positional}/${irPlayer.maxPid}/${irPlayer.stride}`, 'true/19/20', 'III IRPLAYER: rows 0..19 against stride 20 (its catalog definitions up to 26 have no row)');
}

export function runParamIndexTests(): void {
  catalogOnly();
  byteExactCases();
  liveRules();
  nameShift();
  suspectFamily();
  widgetTable();
  layoutKnobWins();
  catalogUnitKnobRule();
  catalogUnitKnobCatalogs();
  exclusions();
  positional();
  forceGeneric();
  catalogInvariants();
  fm3Goldens();
  synthetic();
  entryFacts();
  noFacts();
  typeFollowsName();
  deletionShift();
  profileLabels();
  liveKindConflicts();
  immutability();
  deviceTotals();
}
