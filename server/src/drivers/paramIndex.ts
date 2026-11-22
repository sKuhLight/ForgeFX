// The param index: which parameters a block of one family has on the connected device, what they are
// called, and how each one is served (kind, widget, write mode). Pure: no I/O, no device access, no Node
// APIs, so it runs in the browser build too.
//
// The inputs are the bundled catalog (the static profile: names, units, rows, labels) and, when one is
// applied, the device's own profile (`DeviceProfile.profileFacts`, set by `runtimeProfileFrom`). The index
// reconciles the two row by row, by fingerprint (see forgefx-midi `paramFingerprint`):
//
//   1. in the profile and in the catalog, same fingerprint     → named, nameConfidence 'high'
//   2. in both, fingerprint differs                              → the device's row wins; the name stays
//                                                                 ('medium' when the rows are still
//                                                                 compatible, 'low' when not), or moves to
//                                                                 the one row that now carries its
//                                                                 fingerprint (see NAME_SHIFT_ENABLED)
//   3. in the profile only                                       → a generic param `P<pid>` ('new in
//                                                                 firmware'), or the catalog name at 'low'
//                                                                 confidence when the catalog knows one
//   3b. in the catalog only, with no name                        → a generic param, page 'more'
//   4. in the catalog only                                       → listed as the catalog says; hidden as
//                                                                 'removed' when a byte-exact profile of
//                                                                 the family does not have it any more
//   5. unknown family                                            → not an index matter (no family)
//
// A param that is not listed is reported in `hidden` with its reason, so that listed + hidden (other than
// 'removed') covers every informative row of a byte-exact profile. A live profile never hides anything: its
// coverage is bounded, so a missing row says nothing. A byte-exact Axe-Fx III profile hides the rows its
// static table only made up from inline bounds (11 today) as 'removed', the way the legacy merge drops them.
//
// The index is immutable: entries, hidden items and their nested arrays are frozen, so a cached index can
// never be corrupted by a response builder (label de-duplication renames response items, not entries).
import { BYPASS_TYPECODE, enumOrdinalBounds, isInformativeRow, paramFingerprint, rowsCompatible } from 'forgefx-midi/cache';
import {
  isEnumOnAnyDevice, layoutWidgetIndex, paramLabel, typeSelectorPid, variantSelectorPid,
  type DeviceProfile, type ParamDef, type RangeDef,
} from '../devices.js';

// ── types ─────────────────────────────────────────────────────────────────────────────────────────

/** How a param is drawn: a continuous knob, a knob with integer detents, a dropdown, a two-state toggle. */
export type ParamWidget = 'knob' | 'stepper' | 'dropdown' | 'toggle';
/** Device-true kind of the effective row. */
export type ParamKind = 'float' | 'enum';
/** Where the existence/range facts of a param came from: the applied profile or the bundled catalog. */
export type ParamSource = 'profile' | 'catalog';
export type NameSource = 'catalog' | 'catalog-moved' | 'generic';
export type NameConfidence = 'high' | 'medium' | 'low';
/** What settled the widget: the row itself, the catalog (its unit says selector), or the editor layout. */
export type WidgetSource = 'device' | 'catalog' | 'layout';
/** How a value is written: `norm` = continuous 0..1 over the display range, `ordinal` = the enum ordinal
 *  (a discrete write), `null` = no verified write path (advisory: the server does not refuse it). */
export type WriteMode = 'norm' | 'ordinal' | null;
export type ReadOnlyReason = 'unverified-write-path' | 'generic-typecode-f0';
export type HiddenReason = 'bypass' | 'type' | 'by-design' | 'removed';
export interface HiddenParam { readonly id: number; readonly reason: HiddenReason }
/** What backs the family's rows: a byte-exact profile, a live-walk profile, or the catalog alone
 *  (no profile applied, family not in the profile, or the family was flagged as mis-assigned). */
export type BlockProfileKind = 'byte-exact' | 'live' | 'none';

/** One listed param, with everything the legacy and the v2 responses need except the live value.
 *  Immutable (frozen); `row` and `def` are the profile's own objects and must not be modified either. */
export interface ParamEntry {
  readonly pid: number;
  /** Name before label de-duplication: the catalog label, or `P<pid>` for a generic param. */
  readonly name: string;
  /** The catalog definition that supplies the name (for a moved name: the definition it came from).
   *  Undefined for a generic param. Carries the catalog unit code. */
  readonly def?: Readonly<ParamDef>;
  /** Which response array the param belongs in: continuous params (`named`) or selectors (`enums`). */
  readonly list: 'named' | 'enums';
  readonly kind: ParamKind;
  readonly source: ParamSource;
  readonly generic: boolean;
  /** The bundled catalog has no informative row for this family/pid. */
  readonly isNew?: true;
  /** Generic params only: `isNew` → 'new-in-firmware', else 'more'. */
  readonly pageHint?: 'new-in-firmware' | 'more';
  readonly nameSource: NameSource;
  /** Absent on a generic param. */
  readonly nameConfidence?: NameConfidence;
  /** `nameSource` 'catalog-moved': the catalog pid the name came from. */
  readonly movedFrom?: number;
  /** Fingerprint of the effective row with its effective labels ("1:xxxxxxxx"). */
  readonly fp: string;
  readonly widget: ParamWidget;
  readonly widgetSource: WidgetSource;
  readonly write: WriteMode;
  readonly readOnlyReason?: ReadOnlyReason;
  /** Display-unit step of a continuous param, when known. */
  readonly step?: number;
  /** The effective row (the profile's where the merge took it, else the catalog's). */
  readonly row: Readonly<RangeDef>;
  /** Effective label list (a frozen copy), when there is one. */
  readonly labels?: readonly string[];
  /** `enums` entries: the ordinal range the options cover (an enum row: `enumOrdinalBounds`; a float row
   *  with labels: its rounded display bounds). */
  readonly options?: Readonly<{ lo: number; hi: number }>;
}

/** The index of one family on one profile. Immutable (frozen). */
export interface BlockIndex {
  readonly family: string;
  /** Listed params: catalog-named ones in catalog order, then generic ones by ascending pid. */
  readonly entries: readonly ParamEntry[];
  readonly byPid: ReadonlyMap<number, ParamEntry>;
  /** Informative rows that are not listed, with the reason, by ascending pid. */
  readonly hidden: readonly HiddenParam[];
  /** Every informative row of the family sits below the section stride, so a value can be read by position.
   *  `null` when the family has no known stride: decide at read time from the actual body's stride. */
  readonly positional: boolean | null;
  /** The family was flagged by the section-assignment cross-check: its profile data was not used. */
  readonly suspect: boolean;
  readonly profile: BlockProfileKind;
  /** The family's section stride from the profile's range sections, when it has one. */
  readonly stride: number | undefined;
  /** Highest pid among the informative effective rows (listed, or hidden as type / bypass / by design);
   *  -1 when there is none. Catalog definitions without a row and removed rows do not count. */
  readonly maxPid: number;
  /** The effective type selector: the pid that carries the name of the catalog's type selector (it follows
   *  the name when the row moved), undefined when there is none or the name has no row. Hidden as 'type'. */
  readonly typePid: number | undefined;
  /** The effective layout-variant selector: the type selector, else the pid carrying `<F>_BASETYPE` /
   *  `<F>_MODE`. Listed like any other param unless it is the type selector. */
  readonly variantPid: number | undefined;
  /** Catalog pid → the pid that carries that catalog name on the connected device, listed or hidden (a name
   *  that moved with its row is found where the row went; a pid the diagnostic hook serves as generic keeps its
   *  own name's place). A catalog name the index serves nowhere (removed, or lost in a shift with no unique row
   *  to follow, or a definition without an informative row) has no entry. */
  readonly namedAt: ReadonlyMap<number, number>;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────────

/** Params that are never listed although they are informative rows: writing them has effects a param
 *  editor must not trigger. `MOD_EFFECTID` is the modifier's target block id (a write would retarget it;
 *  binding goes through the modifier endpoints). Keyed by the catalog param name. */
export const NOT_LISTED_BY_DESIGN: ReadonlySet<string> = new Set(['MOD_EFFECTID']);

/** Kill switch for the unique-shift rule (a name follows its row when the row moved to another pid). */
export const NAME_SHIFT_ENABLED = true;

/** Highest param id that is a wire parameter; above it sit the editor's pseudo ids (button, picker,
 *  label slots) and the special table records. */
export const MAX_WIRE_PID = 0x3fff;
/** Typecode of the knob rows whose step is not a real front-panel increment. */
const KNOB_TYPECODE = 0x52;

/** A whole-step range with more detents than this is too fine to read as a stepper (the limit
 *  `looksDiscrete` in the legacy knob test uses). It is only ever the second half of a knob rule: layout
 *  or catalog evidence has to say the param is continuous as well. */
export const MAX_STEPPER_DETENTS = 64;

/** Catalog unit codes that establish a CONTINUOUS control: a quantity the user sweeps (time, frequency,
 *  level, amount, angle) rather than counts or picks. A named row on one of these units with whole-step
 *  bounds and more than `MAX_STEPPER_DETENTS` detents is a knob when the editor layout does not say
 *  otherwise (`DELAY_TIME` 1..16000 ms, `REVERB_REVERBDELAY` 0..250 ms). The set is the units the bundled
 *  catalogs actually use, less the ones whose unit proves nothing about continuity:
 *    - `numeric`, `count`, `unverified`, `pf`: plain or unconfirmed units, they carry counters, slot and
 *      type numbers (`CABINET_TYPE1..4` 0..1023, `DELAY_TIMER`, `DELAY_SPLICETIME`) next to real dials;
 *    - `enum`: a selector by the catalog's own account;
 *    - `semitones`: musical intervals, discrete by nature (every catalog row spans 48 steps today).
 *  There is deliberately NO pure detent-count fallback: a number of detents alone says nothing. */
export const CONTINUOUS_CATALOG_UNITS: ReadonlySet<string> = new Set([
  'ms', 'seconds', 'hz', 'db', 'percent', 'bipolar_percent', 'ratio', 'degrees', 'knob_0_10',
]);

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

const tidy = (x: number): number => Number(x.toPrecision(6));

/** Log-tapered row: a device-true explicit taper wins, else the typecode's middle nibble (4 = log);
 *  a log sweep needs a positive range. Same rule as the value display. */
function isLogRow(r: RangeDef): boolean {
  if (!(r.displayMin > 0)) return false;
  return r.taper ? r.taper === 'log' : ((r.typecode >> 4) & 0xf) === 4;
}

/** Front-panel step in display units; 0 when the row has none or its step is not a real one. */
function displayStep(r: RangeDef): number {
  if (r.typecode === KNOB_TYPECODE) return 0;
  const s = (r.step ?? 0) * (r.scale || 1);
  return s > 0 && Number.isFinite(s) ? s : 0;
}

type Relation = 'equal' | 'compatible' | 'incompatible';

// ── the index ─────────────────────────────────────────────────────────────────────────────────────

const memo = new WeakMap<DeviceProfile, Map<string, BlockIndex>>();

/**
 * The index of one family on one profile. Memoised per profile object (a profile is immutable once
 * built; applying another one makes a new index). `forceGeneric` is a test/diagnostic hook: those pids
 * are served as generic params whatever the catalog knows; such an index is never memoised.
 */
export function buildParamIndex(profile: DeviceProfile, family: string, opts?: { forceGeneric?: ReadonlySet<number> }): BlockIndex {
  const force = opts?.forceGeneric;
  if (force && force.size > 0) return computeIndex(profile, family, force);
  let perProfile = memo.get(profile);
  if (!perProfile) memo.set(profile, (perProfile = new Map()));
  let idx = perProfile.get(family);
  if (!idx) perProfile.set(family, (idx = computeIndex(profile, family, undefined)));
  return idx;
}

function computeIndex(profile: DeviceProfile, family: string, force: ReadonlySet<number> | undefined): BlockIndex {
  const base = profile.staticBase ?? profile;
  const facts = profile.profileFacts;
  const eff: Readonly<Record<number, RangeDef>> = profile.ranges[family] ?? {};
  const cat: Readonly<Record<number, RangeDef>> = base.ranges[family] ?? {};
  const defs = base.params[family] ?? [];

  // the catalog's name per pid (first definition wins) and its position in the catalog order
  const defByPid = new Map<number, ParamDef>();
  const defOrder = new Map<number, number>();
  defs.forEach((d, i) => {
    if (!defByPid.has(d.paramId)) { defByPid.set(d.paramId, d); defOrder.set(d.paramId, i); }
  });

  const suspect = facts?.suspectFamilies.includes(family) ?? false;
  const familyInProfile = !!facts && facts.ranges[family] !== undefined && !suspect;
  const knowsFamily = familyInProfile && !!facts?.byteExact;
  const applied = facts?.appliedRows[family];
  const inProfile = (pid: number): boolean => applied?.has(pid) ?? false;

  /** The catalog's row at `pid` when it is informative. */
  const catRow = (pid: number): RangeDef | undefined => {
    const r = cat[pid];
    return r && isInformativeRow(r) ? r : undefined;
  };
  // Labels of the EFFECTIVE row. A row the catalog still supplies has the catalog's list. A row a byte-exact
  // profile supplied carries the profile's own list; where the profile ships none, the catalog's list stands
  // only if the profile row IS the catalog row apart from labels (an overlay list the device cache does not
  // hold, e.g. a tempo selector). Otherwise the catalog's list belongs to an older row and would turn a float
  // row into a selector. A live profile falls back to the catalog wherever the walk found no labels.
  const effLabels = (pid: number): readonly string[] | undefined => {
    if (!facts || !inProfile(pid)) return base.enumLabelsFor(family, pid);
    if (!facts.byteExact) return profile.enumLabelsFor(family, pid);
    const own = facts.enumLabels[family]?.[String(pid)];
    if (own && own.length > 0) return own;
    const c = cat[pid];
    const e = eff[pid];
    return c && e && !c.synthetic && paramFingerprint(c) === paramFingerprint(e) ? base.enumLabelsFor(family, pid) : undefined;
  };
  const catLabels = (pid: number) => base.enumLabelsFor(family, pid);
  /** A live walk saw a row of the other kind than the catalog's: the merge kept the catalog row. A suspect
   *  family's profile section belongs to another family, so its rows say nothing about this one. */
  const liveKindConflict = (pid: number): boolean => {
    if (!facts || facts.byteExact || suspect) return false;
    const walked = facts.ranges[family]?.[pid];
    const c = cat[pid];
    return !!walked && !!c && walked.displayMin !== walked.displayMax && walked.kind !== c.kind;
  };

  // ── candidate pids: informative effective rows. A byte-exact profile that knows the family speaks for
  // every pid: a catalog row it does not carry is gone from the firmware ('removed'), not a candidate.
  const candidates: number[] = [];
  const hidden = new Map<number, HiddenReason>();
  for (const k of Object.keys(eff)) {
    const pid = Number(k);
    if (pid > MAX_WIRE_PID || !isInformativeRow(eff[pid]!)) continue;
    if (knowsFamily && !inProfile(pid)) continue; // handled below as 'removed'
    candidates.push(pid);
  }
  candidates.sort((a, b) => a - b);
  if (knowsFamily) {
    for (const k of Object.keys(cat)) {
      const pid = Number(k);
      if (pid > MAX_WIRE_PID || !catRow(pid)) continue;
      if (!inProfile(pid) || !isInformativeRow(eff[pid]!)) hidden.set(pid, 'removed');
    }
  }

  // ── how does the device's row at `pid` relate to the catalog's? (profile rows that differ from the catalog)
  const fpCache = new Map<string, string>();
  const rowFp = (side: 'eff' | 'cat', pid: number): string => {
    const key = `${side}:${pid}`;
    let fp = fpCache.get(key);
    if (fp === undefined) {
      fp = side === 'eff' ? paramFingerprint(eff[pid]!, effLabels(pid)) : paramFingerprint(cat[pid]!, catLabels(pid));
      fpCache.set(key, fp);
    }
    return fp;
  };
  const relationCache = new Map<number, Relation>();
  /** Needs an informative catalog row at `pid` and a profile-applied effective row. A synthetic catalog row
   *  (inline bounds, no typecode) is never fingerprint-compared: a matching kind counts as compatible. */
  const relation = (pid: number): Relation => {
    let rel = relationCache.get(pid);
    if (rel !== undefined) return rel;
    const c = cat[pid]!;
    const e = eff[pid];
    if (!e || !isInformativeRow(e)) rel = 'incompatible';
    else if (c.synthetic) rel = c.kind === e.kind ? 'compatible' : 'incompatible';
    else if (rowFp('cat', pid) === rowFp('eff', pid)) rel = 'equal';
    else rel = rowsCompatible(c, catLabels(pid), e, effLabels(pid)) ? 'compatible' : 'incompatible';
    relationCache.set(pid, rel);
    return rel;
  };

  // ── unique shift: a name follows its row when the row moved. For a catalog pid `a` whose device row no
  // longer matches (or is gone), the fingerprint of the catalog row must be unique in the catalog and carried
  // by exactly one other device row `q`, which has no claim of its own (no catalog row it still matches).
  // A live kind conflict is never a source: the live walk's kind split is a heuristic, and its row is not applied.
  const moveTarget = new Map<number, number>(); // q → a
  const movedOut = new Set<number>(); // a
  if (NAME_SHIFT_ENABLED && facts) {
    let catFpCount: Map<string, number> | undefined;
    let candidatesByFp: Map<string, number[]> | undefined;
    const proposals = new Map<number, number[]>(); // q → [a]
    for (const k of Object.keys(cat)) {
      const a = Number(k);
      if (a > MAX_WIRE_PID || !defByPid.has(a) || !catRow(a) || cat[a]!.synthetic) continue;
      // a source: the profile's row at `a` no longer matches, or a byte-exact profile of the family has no row there
      const gone = knowsFamily && !inProfile(a);
      if (!gone && !(inProfile(a) && relation(a) === 'incompatible')) continue;
      if (!catFpCount) {
        catFpCount = new Map();
        for (const k2 of Object.keys(cat)) {
          const p2 = Number(k2);
          if (p2 > MAX_WIRE_PID || !catRow(p2) || cat[p2]!.synthetic) continue;
          const f = rowFp('cat', p2);
          catFpCount.set(f, (catFpCount.get(f) ?? 0) + 1);
        }
        candidatesByFp = new Map();
        for (const p2 of candidates) {
          const f = rowFp('eff', p2);
          const l = candidatesByFp.get(f);
          if (l) l.push(p2); else candidatesByFp.set(f, [p2]);
        }
      }
      const fp = rowFp('cat', a);
      if (catFpCount.get(fp) !== 1) continue; // 1. unique in the catalog
      const carriers = (candidatesByFp!.get(fp) ?? []).filter((q) => q !== a);
      if (carriers.length !== 1) continue; // 2. carried by exactly one other device row
      const q = carriers[0]!;
      const own = catRow(q) !== undefined && (!inProfile(q) || relation(q) !== 'incompatible');
      if (own) continue; // 3. q still has a claim of its own
      const l = proposals.get(q);
      if (l) l.push(a); else proposals.set(q, [a]);
    }
    for (const [q, as] of proposals) {
      if (as.length !== 1) continue; // 4. no other pid may resolve to the same row
      moveTarget.set(q, as[0]!);
      movedOut.add(as[0]!);
    }
  }

  // ── entries
  const layoutWidgets = layoutWidgetIndex(profile, family);
  const catTypePid = typeSelectorPid(profile, family);
  const catVariantPid = variantSelectorPid(profile, family);
  let typePid: number | undefined;
  let variantPid: number | undefined;
  const namedAt = new Map<number, number>();
  const entries: ParamEntry[] = [];
  const orderKey = new Map<ParamEntry, number>();

  for (const pid of candidates) {
    const row = eff[pid]!;
    const labels = effLabels(pid);
    const hasLabels = !!labels && labels.length > 0;
    const natural = defByPid.get(pid);

    // who names it
    let nameDef: ParamDef | undefined;
    let nameSource: NameSource = 'generic';
    let confidence: NameConfidence | undefined;
    let movedFrom: number | undefined;
    const movedHere = moveTarget.get(pid);
    if (force?.has(pid)) {
      /* forced generic */
    } else if (movedHere !== undefined) {
      nameDef = defByPid.get(movedHere);
      nameSource = 'catalog-moved';
      confidence = 'medium';
      movedFrom = movedHere;
    } else if (natural && !movedOut.has(pid)) {
      nameDef = natural;
      nameSource = 'catalog';
      if (!inProfile(pid)) confidence = liveKindConflict(pid) ? 'medium' : 'high';
      else if (!catRow(pid)) confidence = 'low'; // profile-only pid the catalog happens to name: nothing to verify against
      else {
        const rel = relation(pid);
        confidence = rel === 'equal' ? 'high' : rel === 'compatible' ? 'medium' : 'low';
      }
    }
    const generic = nameDef === undefined;
    if (nameDef) namedAt.set(nameDef.paramId, pid);
    else if (force?.has(pid) && natural && !movedOut.has(pid) && movedHere === undefined) namedAt.set(natural.paramId, pid);

    // the selectors follow their names: the pid that carries the catalog selector's name is the selector
    const isType = nameDef !== undefined && nameDef.paramId === catTypePid;
    if (isType) typePid = pid;
    if (nameDef !== undefined && nameDef.paramId === catVariantPid) variantPid = pid;

    // exclusions: not listed, reported in `hidden`
    if (row.typecode === BYPASS_TYPECODE || (nameDef && /^bypass$/i.test(paramLabel(nameDef)))) { hidden.set(pid, 'bypass'); continue; }
    if (isType) { hidden.set(pid, 'type'); continue; }
    if (nameDef && NOT_LISTED_BY_DESIGN.has(nameDef.name)) { hidden.set(pid, 'by-design'); continue; }

    const isNew = !catRow(pid);
    const kind: ParamKind = row.kind === 'enum' ? 'enum' : 'float';

    // widget and write mode: the device row first, evidence second
    let list: 'named' | 'enums';
    let widget: ParamWidget;
    let widgetSource: WidgetSource = 'device';
    let write: WriteMode;
    let readOnlyReason: ReadOnlyReason | undefined;
    let options: { lo: number; hi: number } | undefined;
    let step: number | undefined;
    if (kind === 'enum') {
      options = enumOrdinalBounds(row);
      list = 'enums';
      widget = options.hi - options.lo === 1 ? 'toggle' : 'dropdown';
      write = 'ordinal';
    } else if (hasLabels) {
      // a float row that ships a label list is a selector
      options = { lo: Math.round(row.displayMin), hi: Math.round(row.displayMax) };
      list = 'enums';
      if (row.displayMax - row.displayMin === 1 && labels!.length === 2) {
        widget = 'toggle';
        write = 'ordinal'; // float32(ordinal), proven for 0..1
      } else {
        widget = 'dropdown';
        write = null;
        readOnlyReason = 'unverified-write-path';
      }
    } else {
      list = 'named';
      write = 'norm';
      widget = 'knob';
      if (!isLogRow(row)) {
        const ds = displayStep(row);
        const integral = Number.isInteger(row.displayMin) && Number.isInteger(row.displayMax) && ds >= 1 - 1e-9;
        const catalogSelector = !!nameDef && (nameDef.unit === 'enum' || isEnumOnAnyDevice(family, nameDef.name));
        // the editor layout is keyed by catalog pids: a moved name looks up where it came from, a generic
        // param only where the catalog has no name of its own
        const layoutKey = nameDef ? (movedFrom ?? pid) : defByPid.has(pid) ? undefined : pid;
        const layoutKind = layoutKey === undefined ? undefined : layoutWidgets.get(layoutKey);
        if (integral) {
          // integral bounds with a whole step read as a stepper, unless the range is too fine to be detents
          // (more than MAX_STEPPER_DETENTS steps) AND something says it is continuous. Layout evidence comes
          // first: the editor draws a knob → knob ('layout'); the editor draws anything else → stepper. With
          // no layout evidence a NAMED row on an established continuous catalog unit is a knob ('catalog').
          const steps = (row.displayMax - row.displayMin) / ds;
          const fine = steps > MAX_STEPPER_DETENTS && !catalogSelector;
          if (fine && layoutKind === 'knob') { widget = 'knob'; widgetSource = 'layout'; }
          else if (fine && layoutKind === undefined && nameDef !== undefined && CONTINUOUS_CATALOG_UNITS.has(nameDef.unit ?? '')) { widget = 'knob'; widgetSource = 'catalog'; }
          else widget = 'stepper';
        } else if (catalogSelector) { widget = 'stepper'; widgetSource = 'catalog'; }
        else if (layoutKind === 'dropdown' || layoutKind === 'toggle') { widget = 'stepper'; widgetSource = 'layout'; }
      }
      const ds = displayStep(row);
      if (ds > 0) step = tidy(ds);
    }
    if (generic && (row.typecode & 0xff) === 0xf0) {
      write = null;
      readOnlyReason = 'generic-typecode-f0';
    }

    const entry: ParamEntry = Object.freeze({
      pid,
      name: nameDef ? paramLabel(nameDef) : `P${pid}`,
      ...(nameDef ? { def: nameDef } : {}),
      list,
      kind,
      source: inProfile(pid) ? 'profile' : 'catalog',
      generic,
      ...(isNew ? { isNew: true as const } : {}),
      ...(generic ? { pageHint: isNew ? ('new-in-firmware' as const) : ('more' as const) } : {}),
      nameSource,
      ...(confidence ? { nameConfidence: confidence } : {}),
      ...(movedFrom !== undefined ? { movedFrom } : {}),
      fp: rowFp('eff', pid),
      widget,
      widgetSource,
      write,
      ...(readOnlyReason ? { readOnlyReason } : {}),
      ...(step !== undefined ? { step } : {}),
      row,
      ...(hasLabels ? { labels: Object.freeze([...labels!]) } : {}),
      ...(options ? { options: Object.freeze(options) } : {}),
    });
    entries.push(entry);
    // catalog order for named params (a moved name keeps the position of the definition it came from)
    orderKey.set(entry, nameDef ? (defOrder.get(nameDef.paramId) ?? Number.MAX_SAFE_INTEGER - 1) : Number.MAX_SAFE_INTEGER);
  }
  // ── positional: every informative row of the family sits below the section stride. Only the rows
  // themselves count (listed, or hidden as type / bypass / by design): not catalog definitions without a row,
  // not removed rows. Without a known stride it cannot be told here.
  let maxPid = -1;
  for (const pid of candidates) maxPid = Math.max(maxPid, pid);
  const stride = profile.rangeSections[family]?.stride;

  entries.sort((x, y) => {
    const ox = orderKey.get(x)!;
    const oy = orderKey.get(y)!;
    return ox !== oy ? ox - oy : x.pid - y.pid;
  });
  const index: BlockIndex = {
    family,
    entries: Object.freeze(entries),
    byPid: new Map(entries.map((e) => [e.pid, e])),
    hidden: Object.freeze([...hidden.entries()].sort((x, y) => x[0] - y[0]).map(([id, reason]) => Object.freeze({ id, reason }))),
    positional: stride === undefined ? null : maxPid < stride,
    suspect,
    profile: !familyInProfile ? 'none' : facts!.byteExact ? 'byte-exact' : 'live',
    stride,
    maxPid,
    typePid,
    variantPid,
    namedAt,
  };
  return Object.freeze(index);
}
