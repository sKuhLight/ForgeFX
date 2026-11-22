// A synthetic profile of a newer FM3 firmware than the bundled catalog: the catalog read back as a device
// profile (catalogBuilt) plus one change of every kind a firmware update can bring to the definitions. A new
// param of each widget class, an unused slot, a dropped param, rows inserted in front of others (the names
// must follow their rows, or stay put where that cannot be told safely), revised rows (appended labels, a
// neutralised range, a selector that became a float), two sections swapped between families, and a placed
// block no catalog family exists for. Every row, label and number here is invented; none is taken from a real
// firmware.
//
// `newerFirmwareDoc` (opt-in, the definitions diff) adds what only a profile v2 document can carry on top of the same
// profile: a model list that gained an entry at its end, one that gained an entry in front of others, a section the
// catalog's inventory does not list (with a placed block a probe bound to it) and an unassigned system table. Nothing
// it adds reaches `newerFirmwareBuilt`, so the goldens built on that stay as they are.
import {
  BYPASS_TYPECODE, CACHE_SCHEMA, DERIVATION_REVISION, computeCoverage, familyAssignmentSuspects, isInformativeRow, paramFingerprint, rangeRowOf,
  rawFromLiveWalk, rowsCompatible, sourceSummary,
  type BlockMapEntry, type BuiltCache, type CacheRecord, type DerivedSection, type EditorCacheRawSource, type ProfileDoc, type RawSource
} from 'forgefx-midi/cache';
import { FM3_CATALOG_SECTIONS, FM3_ENUM_OVERRIDES, FM3_RANGES } from 'forgefx-midi/gen3/fm3';
import { PROFILES, typeSelectorPid, type RangeDef } from '../../src/devices.js';
import { profileCatalogFor } from '../../src/profileCatalog.js';
import { catalogBuilt, type StoredProfileSource } from './catalogProfile.js';
import { walkResult } from './profileDocs.js';

const FM3 = PROFILES[0x11]!;

type Rows = Record<number, RangeDef>;
type Labels = Record<string, string[]>;

const floatRow = (min: number, max: number, o: Partial<RangeDef> = {}): RangeDef =>
  ({ kind: 'float', displayMin: min, displayMax: max, scale: 1, step: 0.01, typecode: 0x31, ...o });
const enumRow = (lo: number, count: number, o: Partial<RangeDef> = {}): RangeDef =>
  ({ kind: 'enum', displayMin: lo, displayMax: lo + count - 1, scale: 1, step: 0, typecode: 0x10, enumCount: count, ...o });

/** An all-zero row: the slot exists on the wire but is unused on this firmware. */
export const UNUSED_SLOT: RangeDef = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
/** The row a family gains in front of others (an invented level control). */
export const INSERTED_ROW: RangeDef = floatRow(0, 1, { typecode: 0x71 });

/** Where each change sits. Pids that the catalog does not have are given as numbers; changed catalog params are
 *  named and resolved against the bundled catalog (`catalogPid`). */
export const NEWER_FIRMWARE = {
  /** A new float at the catalog's section stride (the section grows by one): a generic knob, new in firmware. */
  newKnob: { family: 'CHORUS', pid: 29, row: floatRow(0, 10, { scale: 10, step: 0.001, typecode: 0x32 }) },
  /** A new two-label selector at the stride: a generic toggle with an ordinal write. */
  newToggle: { family: 'FUZZ', pid: 43, row: enumRow(0, 2), labels: ['LO', 'HI'] },
  /** An unused slot past the catalog stride: never listed, writes refused. */
  unusedSlot: { family: 'DELAY', pid: 88 },
  /** A new selector whose ordinals start at 1: the label of ordinal v is labels[v - 1]. */
  newDropdown: { family: 'DELAY', pid: 89, row: enumRow(1, 5), labels: ['A', 'B', 'C', 'D', 'E'] },
  /** A new selector with a long list (past the old 128-option cap). */
  longList: { family: 'REVERB', pid: 71, row: enumRow(0, 140), labels: Array.from({ length: 140 }, (_, i) => `SPACE ${i + 1}`) },
  /** A named param the firmware dropped (its slot became unused). */
  dropped: { family: 'COMP', name: 'COMP_SUSTAIN' },
  /** A row inserted at `at`: the rows from `at` on move up one pid. Every name in the window can follow its row. */
  inserted: { family: 'ROTARY', at: 16, movedNames: ['ROTARY_SPREAD', 'ROTARY_DRIVE', 'ROTARY_MICDIST', 'ROTARY_INPUTSELECT', 'ROTARY_SCENEIGNORE'] },
  /** The same in a family whose window holds an identical-row pair, the bypass and the type selector. */
  insertedAmbiguous: { family: 'ENHANCER', at: 3 },
  /** A selector whose list gained two entries at the end. */
  appended: { family: 'DISTORT', name: 'DISTORT_TUBETYPE', labels: ['XT-1', 'XT-2'] },
  /** A continuous param whose row was neutralised to an incompatible 0..1 range without a typecode. */
  neutralised: { family: 'FLANGER', name: 'FLANGER_RATE', row: floatRow(0, 1, { step: 0, typecode: 0 }) },
  /** A catalog selector the firmware describes as a float without labels. */
  enumToFloat: { family: 'PHASER', name: 'PHASER_LFOTYPE', row: floatRow(0, 9, { step: 0 }) },
  /** Two families whose sections were assigned the other way round. */
  swapped: ['MIXER', 'OUTPUT'] as const,
  /** A placed block whose effect id no catalog family (and no codec block) knows. */
  unknownEid: 205,
} as const;

/** The pid of the catalog param `name` of `family` (bundled FM3 catalog). */
export function catalogPid(family: string, name: string): number {
  const d = FM3.params[family]?.find((p) => p.name === name);
  if (!d) throw new Error(`no FM3 catalog param ${family}.${name}`);
  return d.paramId;
}

const labelsOf = (family: string, pid: number): readonly string[] | undefined => FM3.enumLabelsFor(family, pid);
const fpOf = (family: string, pid: number, row: RangeDef = FM3.ranges[family]![pid]!) => paramFingerprint(row, labelsOf(family, pid));

/**
 * Why an insert at `at` into `family` could NOT move every name of the shifted window to its row's new pid, as
 * plain reasons (empty = it can): a catalog fingerprint in the window that another row of the family shares, a
 * shifted row that is still compatible with the catalog row at its new pid (so that pid keeps its own name), the
 * type selector or a bypass row in the window, and an inserted row that resembles the catalog row it displaces
 * or any catalog row of the family.
 */
export function shiftWindowProblems(family: string, at: number, inserted: RangeDef = INSERTED_ROW): string[] {
  const rows = FM3.ranges[family] ?? {};
  const informative = Object.keys(rows).map(Number).filter((pid) => isInformativeRow(rows[pid]!)).sort((a, b) => a - b);
  const window = informative.filter((pid) => pid >= at);
  const problems: string[] = [];
  for (const pid of window) {
    const fp = fpOf(family, pid);
    const twins = informative.filter((q) => q !== pid && fpOf(family, q) === fp);
    if (twins.length) problems.push(`pid ${pid} shares its row with ${twins.join(',')}`);
    const target = rows[pid + 1];
    if (target && isInformativeRow(target) && rowsCompatible(rows[pid]!, labelsOf(family, pid), target, labelsOf(family, pid + 1))) {
      problems.push(`pid ${pid} is compatible with the catalog row at ${pid + 1}`);
    }
    if (pid === typeSelectorPid(FM3, family)) problems.push(`pid ${pid} is the type selector`);
    if (rows[pid]!.typecode === BYPASS_TYPECODE) problems.push(`pid ${pid} is the bypass`);
  }
  const insertedFp = paramFingerprint(inserted);
  if (informative.some((pid) => fpOf(family, pid) === insertedFp)) problems.push('the inserted row equals a catalog row');
  const displaced = rows[at];
  if (displaced && rowsCompatible(inserted, undefined, displaced, labelsOf(family, at))) problems.push(`the inserted row is compatible with the catalog row at ${at}`);
  return problems;
}

/** Insert `row` at `at` into `family` of `b`: rows and label lists from `at` on move up one pid, the section
 *  stride grows by one. */
function insertRow(b: BuiltCache, family: string, at: number, row: RangeDef): void {
  const rows = b.ranges[family] as Rows;
  const labels = (b.enumOverrides[family] ?? {}) as Labels;
  const nr: Rows = {};
  const nl: Labels = {};
  for (const pid of Object.keys(rows).map(Number)) {
    const to = pid >= at ? pid + 1 : pid;
    nr[to] = rows[pid]!;
    if (labels[String(pid)]) nl[String(to)] = labels[String(pid)]!;
  }
  nr[at] = row;
  (b.ranges as Record<string, Rows>)[family] = nr;
  (b.enumOverrides as Record<string, Labels>)[family] = nl;
  growStride(b, family, 1);
}

function growStride(b: BuiltCache, family: string, by: number): void {
  const sections = b.rangeSections as Record<string, { stride: number; recordCount: number }>;
  const s = sections[family]!;
  sections[family] = { ...s, stride: s.stride + by, recordCount: s.recordCount + by };
}

/** Put a new row (and its labels) at `pid`, which must be the family's current stride (the section grows). */
function appendAtStride(b: BuiltCache, family: string, pid: number, row: RangeDef, labels?: readonly string[]): void {
  const stride = (b.rangeSections as Record<string, { stride: number }>)[family]!.stride;
  if (pid !== stride) throw new Error(`${family}: pid ${pid} is not the section stride ${stride}`);
  (b.ranges[family] as Rows)[pid] = row;
  if (labels) ((b.enumOverrides as Record<string, Labels>)[family] ??= {})[String(pid)] = [...labels];
  growStride(b, family, 1);
}

/**
 * The newer-firmware profile: `catalogBuilt(0x11, source)` with every change of `NEWER_FIRMWARE` applied. `source` is
 * the stored provenance ('editor-cache': byte-exact; 'live': a walk, whose rules differ). Throws when a premise
 * about the catalog no longer holds (a pid the catalog gained, a clean shift window that is not clean any more),
 * so the expectations built on it never pass by accident.
 */
export function newerFirmwareBuilt(source: StoredProfileSource = 'editor-cache'): BuiltCache {
  const b = catalogBuilt(0x11, source);
  const rows = (family: string) => b.ranges[family] as Rows;
  const labels = (family: string) => ((b.enumOverrides as Record<string, Labels>)[family] ??= {});
  const fresh = (family: string, pid: number) => {
    if (FM3.ranges[family]?.[pid] || FM3.params[family]?.some((d) => d.paramId === pid)) throw new Error(`${family} ${pid} is no longer new to the catalog`);
  };

  // new params of each class
  const { newKnob, newToggle, unusedSlot, newDropdown, longList } = NEWER_FIRMWARE;
  fresh(newKnob.family, newKnob.pid);
  appendAtStride(b, newKnob.family, newKnob.pid, newKnob.row);
  fresh(newToggle.family, newToggle.pid);
  appendAtStride(b, newToggle.family, newToggle.pid, newToggle.row, newToggle.labels);
  fresh(unusedSlot.family, unusedSlot.pid);
  appendAtStride(b, unusedSlot.family, unusedSlot.pid, UNUSED_SLOT);
  fresh(newDropdown.family, newDropdown.pid);
  appendAtStride(b, newDropdown.family, newDropdown.pid, newDropdown.row, newDropdown.labels);
  fresh(longList.family, longList.pid);
  appendAtStride(b, longList.family, longList.pid, longList.row, longList.labels);

  // a dropped param
  rows(NEWER_FIRMWARE.dropped.family)[catalogPid(NEWER_FIRMWARE.dropped.family, NEWER_FIRMWARE.dropped.name)] = UNUSED_SLOT;

  // inserted rows: one window where every name can follow, one where it cannot
  const { inserted, insertedAmbiguous } = NEWER_FIRMWARE;
  const problems = shiftWindowProblems(inserted.family, inserted.at);
  if (problems.length) throw new Error(`${inserted.family} insert at ${inserted.at}: ${problems.join('; ')}`);
  insertRow(b, inserted.family, inserted.at, INSERTED_ROW);
  insertRow(b, insertedAmbiguous.family, insertedAmbiguous.at, INSERTED_ROW);

  // revised rows
  const app = NEWER_FIRMWARE.appended;
  const appPid = catalogPid(app.family, app.name);
  const appRow = rows(app.family)[appPid]!;
  const appLabels = labels(app.family)[String(appPid)]!;
  rows(app.family)[appPid] = { ...appRow, displayMax: appRow.displayMax + app.labels.length, enumCount: appLabels.length + app.labels.length };
  labels(app.family)[String(appPid)] = [...appLabels, ...app.labels];
  const neu = NEWER_FIRMWARE.neutralised;
  rows(neu.family)[catalogPid(neu.family, neu.name)] = neu.row;
  const e2f = NEWER_FIRMWARE.enumToFloat;
  const e2fPid = catalogPid(e2f.family, e2f.name);
  rows(e2f.family)[e2fPid] = e2f.row;
  delete labels(e2f.family)[String(e2fPid)];

  // two sections assigned to each other's family
  const [x, y] = NEWER_FIRMWARE.swapped;
  const swap = (o: Record<string, unknown>) => { const t = o[x]; o[x] = o[y]; o[y] = t; };
  swap(b.ranges as Record<string, unknown>);
  swap(b.enumOverrides as Record<string, unknown>);
  swap(b.rangeSections as Record<string, unknown>);

  (b as { firmware?: string }).firmware = '99.0';
  return b;
}

// ── the profile v2 document (definitions diff) ─────────────────────────────────────────────────────────────────────

/** A float record of the invented new section (`section` = section tag, or the block address in a live source). */
const floatRec = (section: number, id: number, tc: number, min: number, max: number, step: number): CacheRecord =>
  ({ kind: 'float', section, offset: 0, id, tc, min, max, def: 1, step, t1: 0, t2: 0 });

/** What `newerFirmwareDoc` adds on top of `newerFirmwareBuilt` (all invented). */
export const NEWER_FIRMWARE_DIFF = {
  /** A model list that gained an entry at its end. */
  rosterAppended: { family: 'FUZZ', name: 'FUZZ_TYPE', label: 'NEW FUZZ MODEL' },
  /** A model list that gained an entry in front of others: the later models move up one ordinal. */
  rosterInserted: { family: 'REVERB', name: 'REVERB_TYPE', at: 3, label: 'NEW SPACE MODEL' },
  /** A section the catalog's inventory does not list (a block the catalog firmware lacks): four controls and a bypass. */
  newSection: {
    tag: 60,
    records: (section: number): CacheRecord[] => [
      floatRec(section, 0, 0x32, 0, 10, 0.01),
      floatRec(section, 1, 0x81, -24, 24, 0.1),
      { kind: 'enum', section, offset: 0, id: 2, tc: 0x10, min: 0, max: 2, def: 0, step: 0, count: 3, values: ['MODE A', 'MODE B', 'MODE C'], x: 0 },
      floatRec(section, 3, 0x71, 0, 1, 0.01),
      floatRec(section, 4, BYPASS_TYPECODE, 0, 1, 1)
    ]
  },
  /** The placed block a probe bound to the new section (`confirmed`, device records). */
  probedEid: 203,
  /** A system table of the inventory (no family, no block): two rows. */
  systemSection: { tag: 4, records: (section: number): CacheRecord[] => [floatRec(section, 0, 0x31, 0, 100, 1), floatRec(section, 1, 0x31, 0, 100, 1)] },
  /** Capture stamps of the two sources. */
  capturedAt: '2026-11-22T10:00:00.000Z',
  probedAt: '2026-11-22T11:00:00.000Z'
} as const;

/** The highest pid a read-only probe of a table of `stride` ids looks at (the stride plus the stop run, at most 127). */
const probeCeiling = (stride: number) => Math.min(stride - 1 + 32, 127);

/** Grow the label list (and the enum row) of `family`'s `name` by `label` at `at` (default: the end). */
function growList(b: BuiltCache, family: string, name: string, label: string, at?: number): void {
  const pid = catalogPid(family, name);
  const rows = b.ranges[family] as Rows;
  const labels = ((b.enumOverrides as Record<string, Labels>)[family] ??= {});
  const list = labels[String(pid)];
  const row = rows[pid];
  if (!list || !row || row.kind !== 'enum' || row.enumCount !== list.length) throw new Error(`${family}.${name} is no enum row with one label per option any more`);
  const next = [...list];
  next.splice(at ?? next.length, 0, label);
  labels[String(pid)] = next;
  rows[pid] = { ...row, displayMax: row.displayMax + 1, enumCount: next.length };
}

/** Rows (and labels) of `records` as a family's tables, the way the derivation turns a record into a row. */
function tablesOf(records: readonly CacheRecord[]): { rows: Rows; labels: Labels } {
  const rows: Rows = {};
  const labels: Labels = {};
  for (const r of records) {
    const d = rangeRowOf(r);
    rows[r.id] = d.row as RangeDef;
    if (d.labels) labels[String(r.id)] = d.labels;
  }
  return { rows, labels };
}

/**
 * The newer firmware as a profile v2 document (`meta.format: 2`): `newerFirmwareBuilt('editor-cache')` plus
 * `NEWER_FIRMWARE_DIFF`, every section described (the catalog families' sections by their family, the system table and
 * the new section by their synthetic keys `section:<tag>`), the probed block bound to the new section in `blockMap`,
 * provenance (every family from the editor-cache source; the assignment suspects of its tables) and the codec's own
 * coverage of the result. The raw envelope lists both sources: the probe with its records, the editor cache as a
 * stand-in without records (the tables above are hand-made — nothing re-derives this document; its schema and
 * derivation revision are the codec's current ones, so no load re-derives it either). Throws when a premise about the
 * catalog no longer holds.
 */
export function newerFirmwareDoc(): ProfileDoc {
  const b = newerFirmwareBuilt('editor-cache');
  const firmware = (b as { firmware?: string }).firmware ?? null;
  const add = NEWER_FIRMWARE_DIFF;

  // model lists
  growList(b, add.rosterAppended.family, add.rosterAppended.name, add.rosterAppended.label);
  growList(b, add.rosterInserted.family, add.rosterInserted.name, add.rosterInserted.label, add.rosterInserted.at);

  // the system table and the new section, under their synthetic keys
  const inventory = new Map(FM3_CATALOG_SECTIONS.map((c) => [c.tag, c.family] as const));
  if (inventory.get(add.systemSection.tag) !== null) throw new Error(`tag ${add.systemSection.tag} is no system table of the FM3 inventory any more`);
  if (inventory.has(add.newSection.tag)) throw new Error(`tag ${add.newSection.tag} is in the FM3 inventory now`);
  const synthetic: Array<{ tag: number; records: CacheRecord[]; role: 'system' | 'new' }> = [
    { tag: add.systemSection.tag, records: add.systemSection.records(add.systemSection.tag), role: 'system' },
    { tag: add.newSection.tag, records: add.newSection.records(add.newSection.tag), role: 'new' }
  ];
  for (const s of synthetic) {
    const key = `section:${s.tag}`;
    const t = tablesOf(s.records);
    (b.ranges as Record<string, Rows>)[key] = t.rows;
    (b.enumOverrides as Record<string, Labels>)[key] = t.labels;
    (b.rangeSections as Record<string, { sectionTag: number; stride: number; recordCount: number }>)[key] = { sectionTag: s.tag, stride: s.records.length, recordCount: s.records.length };
    (b.unmappedSections as Array<{ sectionTag: number; recordCount: number; wireStride: number }>).push({ sectionTag: s.tag, recordCount: s.records.length, wireStride: s.records.length });
  }

  // the sources: the editor cache (stand-in) and the probe of the placed block
  const editorCache: EditorCacheRawSource = {
    id: `editor-cache@${add.capturedAt}#0`, kind: 'editor-cache', origin: 'local', capturedAt: add.capturedAt, firmware, codecVersion: 'fixture',
    records: [], space: 'section', sections: [], omitted: { tables: 0, records: 0 }, header: null, fileVersion: null, contentSha256: null
  };
  const probeRecords = add.newSection.records(add.probedEid);
  const probedTo = probeCeiling(probeRecords.length);
  const probe = rawFromLiveWalk(
    walkResult(probeRecords),
    { blocks: [add.probedEid], maxParamId: probedTo, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-probe', capturedAt: add.probedAt, firmware: firmware ?? undefined, origin: 'local' }
  );
  const sources: RawSource[] = [editorCache, probe];

  // every section: the catalog families' (their instance tags as instances), the synthetic ones, the probed block
  const informative = (key: string) => Object.values((b.ranges as Record<string, Rows>)[key] ?? {}).filter((r) => isInformativeRow(r)).length;
  const sections: DerivedSection[] = [];
  for (const [key, meta] of Object.entries(b.rangeSections as Record<string, { sectionTag: number; stride: number; recordCount: number; instanceTags?: number[] }>)) {
    const fam = key.startsWith('section:') ? null : key;
    const tags = meta.instanceTags ?? [meta.sectionTag];
    tags.forEach((tag, i) => sections.push({
      space: 'section', tag, key, family: fam,
      role: fam === null ? synthetic.find((s) => s.tag === tag)!.role : i === 0 ? 'family' : 'instance',
      stride: meta.stride, recordCount: meta.recordCount, informative: informative(key), signature: '', sourceId: editorCache.id
    }));
  }
  const newKey = `section:${add.newSection.tag}`;
  sections.push({
    space: 'block', tag: add.probedEid, key: newKey, family: null, role: 'unclassified',
    stride: probeRecords.length, recordCount: probeRecords.length, informative: informative(newKey), signature: '', sourceId: probe.id
  });
  const blockMap: BlockMapEntry[] = [{
    eid: add.probedEid, key: newKey, sectionTag: add.newSection.tag, confidence: 'confirmed', evidence: ['device-records'],
    compared: { rows: informative(newKey), equal: informative(newKey), probedTo }, channels: null
  }];

  const suspects = familyAssignmentSuspects(
    { ranges: b.ranges, enumOverrides: b.enumOverrides },
    { ranges: FM3_RANGES as unknown as BuiltCache['ranges'], enumOverrides: FM3_ENUM_OVERRIDES as unknown as BuiltCache['enumOverrides'] }
  ).filter((f) => !f.startsWith('section:'));
  const doc = {
    ...b,
    meta: {
      ...b.meta, schema: CACHE_SCHEMA, source: 'editor-cache', format: 2, derivedWith: 'fixture', derivedRevision: DERIVATION_REVISION,
      derivedAt: add.probedAt, sources: sources.map(sourceSummary)
    },
    raw: { format: 1, sources },
    sections,
    blockMap,
    provenance: {
      existence: Object.fromEntries(Object.keys(b.ranges).map((k) => [k, editorCache.id])),
      units: {}, tapers: {}, conflicts: [],
      suspects: { [editorCache.id]: suspects, [probe.id]: [] }
    }
  } as unknown as ProfileDoc;
  doc.coverage = computeCoverage(doc, profileCatalogFor(0x11));
  return doc;
}
