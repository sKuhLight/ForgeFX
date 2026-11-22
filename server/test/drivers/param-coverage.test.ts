// Parameter coverage of the generic block-params response (`blockParams(eid, { generic: true })`, GET
// …/params?generic=1) over every block a gen-3 unit can serve, read through a mocked unit (status 0x13 + bulk
// 0x1F). For the FM3, the FM9 and the Axe-Fx III, with the catalog read back as a byte-exact device profile (and
// with no profile at all), every family that has an effect id lists exactly its informative rows minus the
// bypass, the type selector and the by-design exclusions, and reports those in `definitions.hidden`, so that
// listed + hidden covers every informative row. Totals per device are pinned, with the scope they are counted
// over. Then a synthetic newer firmware (test/helpers/newerFirmware.ts) with one invented change of every
// kind, served once as a byte-exact profile and once as a live walk: what each change does to the response.
// Invariants on every response: no enum-kind entry among the dials, no float with selector evidence drawn as a
// knob.
// Committed catalog data and synthetic data only; NO device.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { PROFILES, isEnumOnAnyDevice, layoutWidgetIndex, runtimeProfileFrom, typeSelectorPid, type DeviceProfile, type ParamDef, type RangeDef } from '../../src/devices.js';
import { buildParamIndex, NOT_LISTED_BY_DESIGN, MAX_WIRE_PID } from '../../src/drivers/paramIndex.js';
import type { BlockParamsV2DTO, EnumParamV2, NamedParamV2 } from '../../src/drivers/types.js';
import { BYPASS_TYPECODE, isInformativeRow } from 'forgefx-midi/cache';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { FM3_FAMILY_BY_EFFECT_ID } from 'forgefx-midi/gen3/fm3';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt, mockGen3Device } from '../helpers/catalogProfile.js';
import { NEWER_FIRMWARE, catalogPid, newerFirmwareBuilt, shiftWindowProblems } from '../helpers/newerFirmware.js';

export const PARAM_COVERAGE_CASE_COUNT = 14;

const FM3 = PROFILES[0x11]!;
const DEVICES: Array<[string, number]> = [['FM3', 0x11], ['FM9', 0x12], ['Axe-Fx III', 0x10]];

// ── the blocks a unit can be asked for ──────────────────────────────────────────────────────────────────────
/** The virtual effects of the gen-3 units: GLOBAL, CONTROLLERS, the modifier, the scene MIDI block, FC. */
const VIRTUAL_EIDS = [1, 2, 3, 190, 199];
const ROSTER_EIDS = effectRoster().map((e) => e.page);
/** Every first-instance effect id: the codec's block roster, the FM3/FM9 effect-id table, the virtual effects. */
const SWEEP_EIDS: readonly number[] = [...new Set([...VIRTUAL_EIDS, ...ROSTER_EIDS, ...Object.keys(FM3_FAMILY_BY_EFFECT_ID).map(Number)])].sort((a, b) => a - b);

type V2Entry = NamedParamV2 | EnumParamV2;
const entriesOf = (r: BlockParamsV2DTO): V2Entry[] => [...r.named, ...r.enums];

interface Sweep {
  profile: DeviceProfile;
  /** family → the response of its first effect id (families the profile has rows for). */
  byFamily: Map<string, { eid: number; r: BlockParamsV2DTO }>;
  /** Effect ids that answered an unknown block. */
  unknownEids: number[];
}

async function sweep(profile: DeviceProfile, eids: readonly number[] = SWEEP_EIDS): Promise<Sweep> {
  const { driver } = mockGen3Device(profile, eids);
  const byFamily = new Map<string, { eid: number; r: BlockParamsV2DTO }>();
  const unknownEids: number[] = [];
  for (const eid of eids) {
    const r = await driver.blockParams(eid, { generic: true });
    const fam = r.definitions.family;
    if (fam === null) {
      assertEqual(`${r.unknownBlock}/${r.block}/${r.slug}/${r.page}`, `true/Block ${eid}//-1`, `eid ${eid}: an unknown block is named by its effect id`);
      unknownEids.push(eid);
      continue;
    }
    if (!profile.ranges[fam] || byFamily.has(fam)) continue;
    byFamily.set(fam, { eid, r });
  }
  return { profile, byFamily, unknownEids };
}

const total = (s: Sweep) => [...s.byFamily.values()].reduce((n, { r }) => n + r.named.length + r.enums.length, 0);
const genericTotal = (s: Sweep) => [...s.byFamily.values()].reduce((n, { r }) => n + entriesOf(r).filter((e) => e.generic).length, 0);
const countOf = (s: Sweep, fam: string) => { const x = s.byFamily.get(fam); return x ? x.r.named.length + x.r.enums.length : undefined; };
const responseOf = (s: Sweep, fam: string): BlockParamsV2DTO => {
  const x = s.byFamily.get(fam);
  assert(x !== undefined, `${fam} is served`);
  return x.r;
};
const entryAt = (r: BlockParamsV2DTO, pid: number): V2Entry => {
  const e = entriesOf(r).find((x) => x.id === pid);
  assert(e !== undefined, `${r.definitions.family} pid ${pid} is listed`);
  return e;
};
const hiddenOf = (r: BlockParamsV2DTO) => r.definitions.hidden.map((h) => `${h.id}:${h.reason}`).join(',');
/** The served layout's param controls as `NAME:pid`, `<catalog pid` when the name moved, `!` when unbound. */
const layoutOf = (r: BlockParamsV2DTO) => (r.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls))
  .filter((c) => c.paramName && c.paramId !== null && c.paramId <= MAX_WIRE_PID)
  .map((c) => `${c.paramName}:${c.paramId}${c.movedFrom !== undefined ? `<${c.movedFrom}` : ''}${c.unbound ? '!' : ''}`).join(' ');
const informative = (rows: Readonly<Record<number, RangeDef>> | undefined) =>
  Object.entries(rows ?? {}).filter(([pid, r]) => Number(pid) <= MAX_WIRE_PID && isInformativeRow(r)).map(([pid]) => Number(pid));

/** The params a family lists: its informative rows (pid ≤ 0x3FFF) except the bypass (typecode 0xE0), the type
 *  selector and the params that are never listed by design. */
const byDesignPids = (defs: readonly ParamDef[] = []) => new Set(defs.filter((d) => NOT_LISTED_BY_DESIGN.has(d.name)).map((d) => d.paramId));
function expectedShown(rows: Readonly<Record<number, RangeDef>> | undefined, typePid: number | undefined, defs: readonly ParamDef[] = []): number {
  const byDesign = byDesignPids(defs);
  return informative(rows).filter((pid) => rows![pid]!.typecode !== BYPASS_TYPECODE && pid !== typePid && !byDesign.has(pid)).length;
}

/** A device's catalog as a byte-exact device profile. */
const exactProfile = (mid: number) => runtimeProfileFrom(catalogBuilt(mid), PROFILES[mid]!);
const newerFirmwareProfile = (source: 'editor-cache' | 'live' = 'editor-cache') => runtimeProfileFrom(newerFirmwareBuilt(source), FM3);

/** The response invariants every served block keeps. */
function invariants(s: Sweep, label: string): void {
  for (const [fam, { r }] of s.byFamily) {
    const layout = layoutWidgetIndex(s.profile, fam);
    const defs = s.profile.params[fam] ?? [];
    for (const e of r.named) {
      const at = `${label} ${fam} ${e.id}`;
      assertEqual(e.kind, 'float', `${at}: no enum-kind entry among the dials`);
      assert(e.widget === 'knob' || e.widget === 'stepper', `${at}: a dial is a knob or a stepper`);
      assertEqual(e.write, e.readOnlyReason ? null : 'norm', `${at}: a dial writes a normalised value`);
      // the catalog param that names it (a moved name: the one it came from), and the editor's widget there
      const namedBy = e.generic ? undefined : e.nameSource === 'catalog-moved' ? e.movedFrom : e.id;
      const def = namedBy === undefined ? undefined : defs.find((d) => d.paramId === namedBy);
      const selectorEvidence = !!def && (def.unit === 'enum' || isEnumOnAnyDevice(fam, def.name));
      const layoutKey = def ? def.paramId : defs.some((d) => d.paramId === e.id) ? undefined : e.id;
      const layoutSelector = layoutKey !== undefined && ['dropdown', 'toggle'].includes(layout.get(layoutKey) ?? '');
      if (selectorEvidence || layoutSelector) assert(e.widget !== 'knob', `${at}: a float with selector evidence is not a knob`);
    }
    for (const e of r.enums) {
      const at = `${label} ${fam} ${e.id}`;
      assert(e.widget === 'toggle' || e.widget === 'dropdown', `${at}: a selector is a toggle or a dropdown`);
      assert(Array.isArray(e.options) && e.options.length > 0, `${at}: a selector has options`);
    }
    for (const e of entriesOf(r)) {
      const at = `${label} ${fam} ${e.id}`;
      assertEqual(e.generic, e.nameSource === 'generic', `${at}: generic <=> generic name source`);
      if (e.generic) assertEqual(`${e.name}/${e.nameConfidence}`, `P${e.id}/undefined`, `${at}: a generic param is P<pid>, without confidence`);
      else assert(e.nameConfidence !== undefined, `${at}: a named param has a confidence`);
      assert(/^1:[0-9a-f]{8}$/.test(e.fp), `${at}: fingerprint`);
    }
    const ids = entriesOf(r).map((e) => e.id);
    assertEqual(new Set(ids).size, ids.length, `${label} ${fam}: no pid listed twice`);
    for (const h of r.definitions.hidden) assert(!ids.includes(h.id), `${label} ${fam} ${h.id}: a hidden pid is not listed`);
  }
}

/** Listed + hidden against the rows that back each family: the catalog read back as a byte-exact profile (or the
 *  bundled catalog alone). */
function coverage(s: Sweep, label: string, backing: 'profile' | 'catalog'): void {
  const p = s.profile;
  const staticP = p.staticBase ?? p;
  for (const [fam, { r }] of s.byFamily) {
    // a family the profile has no section for is served from the catalog
    const fromProfile = backing === 'profile' && p.profileFacts!.ranges[fam] !== undefined;
    const rows = fromProfile ? p.profileFacts!.ranges[fam] : staticP.ranges[fam];
    const typePid = typeSelectorPid(staticP, fam);
    const at = `${label} ${fam}`;
    const shown = r.named.length + r.enums.length;
    const removed = r.definitions.hidden.filter((h) => h.reason === 'removed');
    assertEqual(shown, expectedShown(rows, typePid, staticP.params[fam]), `${at}: listed = informative rows - bypass - type - by design`);
    assertEqual(shown + r.definitions.hidden.length - removed.length, informative(rows).length, `${at}: listed + hidden (other than removed) = informative rows`);
    // the reasons say exactly what was left out
    const bypass = informative(rows).filter((pid) => rows![pid]!.typecode === BYPASS_TYPECODE);
    assertEqual(r.definitions.hidden.filter((h) => h.reason === 'bypass').map((h) => h.id).join(','), bypass.join(','), `${at}: bypass = the typecode-0xE0 rows`);
    const typeHidden = r.definitions.hidden.filter((h) => h.reason === 'type').map((h) => h.id);
    assertEqual(typeHidden.join(','), typePid !== undefined && informative(rows).includes(typePid) ? String(typePid) : '', `${at}: type = the type selector`);
    const byDesign = byDesignPids(staticP.params[fam]);
    assertEqual(r.definitions.hidden.filter((h) => h.reason === 'by-design').map((h) => h.id).join(','), informative(rows).filter((pid) => byDesign.has(pid)).join(','), `${at}: by design = the modifier target id`);
    assertEqual(r.definitions.profile, fromProfile ? 'byte-exact' : 'none', `${at}: what backs the family`);
    if (!fromProfile || p.model !== 0x10) assertEqual(removed.length, 0, `${at}: the catalog read back loses nothing`);
    else for (const h of removed) assert(staticP.ranges[fam]![h.id]?.synthetic === true, `${at} ${h.id}: only rows the III table made up from inline bounds are removed`);
    for (const e of entriesOf(r)) if (!e.generic) assertEqual(e.nameConfidence, 'high', `${at} ${e.id}: every name is confirmed`);
    // the layout: no name moved, and no control is unbound. The only rows a catalog read back removes (on the III)
    // are rows the bundled table made up from inline bounds, which prove nothing about the device (the
    // gain-reduction meters), so their controls stay bound.
    const controls = (r.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls));
    assert(controls.every((c) => c.movedFrom === undefined), `${at}: no layout control moved`);
    for (const c of controls) assert(!c.unbound, `${at} ${c.paramName}: no control is unbound`);
  }
}

export async function runParamCoverageTests(): Promise<void> {
  const savedHook = process.env.FORGEFX_DEFS_FORCE_GENERIC;
  delete process.env.FORGEFX_DEFS_FORCE_GENERIC; // the diagnostic hook would rename params
  try {
    await runCases();
  } finally {
    if (savedHook !== undefined) process.env.FORGEFX_DEFS_FORCE_GENERIC = savedHook;
  }
}

async function runCases(): Promise<void> {
  const sweeps = new Map<string, Sweep>();
  for (const [name, mid] of DEVICES) {
    sweeps.set(`${name} catalog`, await sweep(PROFILES[mid]!));
    sweeps.set(`${name} profile`, await sweep(exactProfile(mid)));
  }
  const S = (key: string) => sweeps.get(key)!;

  // ---- 1. scope: the families an effect id reaches -------------------------------------------------------------
  {
    const unreachable: Record<string, string> = {
      FM3: 'PRESET',
      FM9: 'PRESET',
      // the III resolves audio blocks through the codec block roster and the shared virtual effects only
      'Axe-Fx III': 'CROSSOVER,DYNDIST,IRCAPTURE,IRPLAYER,PRESET,RTA,TONEMATCH,VOCODER',
    };
    const unknown: Record<string, string> = { FM3: '', FM9: '', 'Axe-Fx III': '36,134,142,170,174,195' };
    for (const [name, mid] of DEVICES) {
      for (const mode of ['catalog', 'profile']) {
        const s = S(`${name} ${mode}`);
        const missing = Object.keys(PROFILES[mid]!.ranges).filter((f) => !s.byFamily.has(f)).sort();
        assertEqual(missing.join(','), unreachable[name], `${name} ${mode}: families no effect id reaches`);
        assertEqual(s.unknownEids.join(','), unknown[name], `${name} ${mode}: effect ids answered as an unknown block`);
      }
    }
    const fm3 = S('FM3 profile');
    assertEqual(`${fm3.byFamily.get('GLOBAL')?.eid}/${fm3.byFamily.get('CONTROLLERS')?.eid}/${fm3.byFamily.get('MOD')?.eid}/${fm3.byFamily.get('FC')?.eid}`, '1/2/3/undefined', 'FM3: the virtual effects (FC has no rows in the FM3 catalog)');
    console.log(`  drivers/param-coverage: scope — ${SWEEP_EIDS.length} first-instance eids; unreachable FM3/FM9 PRESET, III ${unreachable['Axe-Fx III']}`);
  }

  // ---- 2. byte-exact catalog profile: listed + hidden = informative, per family --------------------------------
  {
    for (const [name] of DEVICES) coverage(S(`${name} profile`), `${name} profile`, 'profile');
    // the families a device serves that its own catalog tables have no section for (the bundled profile adds them)
    const outside = (name: string) => [...S(`${name} profile`).byFamily.keys()].filter((f) => S(`${name} profile`).profile.profileFacts!.ranges[f] === undefined).sort().join(',');
    assertEqual(DEVICES.map(([name]) => `${name}:${outside(name)}`).join(' '), 'FM3: FM9: Axe-Fx III:FC,MIDIBLOCK', 'families served from the bundled profile alone (no informative row on the III either)');
    for (const [name] of DEVICES) assert(responseOf(S(`${name} profile`), 'MOD').definitions.hidden.some((h) => h.reason === 'by-design'), `${name}: the modifier hides its target id by design`);
    let removedIII = 0;
    for (const { r } of S('Axe-Fx III profile').byFamily.values()) removedIII += r.definitions.hidden.filter((h) => h.reason === 'removed').length;
    assertEqual(removedIII, 10, 'Axe-Fx III: the reachable families hide 10 inline-bound-only rows as removed');
    console.log('  drivers/param-coverage: byte-exact catalog profile — FM3/FM9/III listed = expected, listed + hidden = informative per family (III: 10 synthetic rows removed)');
  }

  // ---- 3. no profile: the bundled catalog alone ----------------------------------------------------------------
  {
    for (const [name] of DEVICES) coverage(S(`${name} catalog`), `${name} catalog`, 'catalog');
    for (const [name] of DEVICES) {
      const c = S(`${name} catalog`);
      const p = S(`${name} profile`);
      for (const fam of c.byFamily.keys()) {
        const cr = responseOf(c, fam);
        const pr = responseOf(p, fam);
        const removed = pr.definitions.hidden.filter((h) => h.reason === 'removed').length;
        assertEqual(countOf(c, fam), countOf(p, fam)! + removed, `${name} ${fam}: the catalog view lists what the profile view lists, plus the synthetic rows it removes`);
        if (removed === 0) assertEqual(entriesOf(cr).map((e) => `${e.id}:${e.name}`).join(','), entriesOf(pr).map((e) => `${e.id}:${e.name}`).join(','), `${name} ${fam}: same params, same names`);
      }
    }
    console.log('  drivers/param-coverage: no profile — listed + hidden = informative catalog rows; same params as the byte-exact view');
  }

  // ---- 4. FM3 goldens (the catalog is the fw 12.0 profile) -----------------------------------------------------
  {
    const GLOBAL_GENERIC = '80,81,84,85,88,89,90,91,92,94,95,115,116,117,118,3611,3612,3613,3614,3615,3616,3617,3618,7113,7114,7427,8292';
    for (const mode of ['catalog', 'profile']) {
      const s = S(`FM3 ${mode}`);
      assertEqual(`${total(s)}/${genericTotal(s)}`, '1611/27', `FM3 ${mode}: params / generic over the reachable families`);
      const per = { CABINET: 62, CHORUS: 26, CONTROLLERS: 126, DELAY: 81, DISTORT: 139, FUZZ: 41, GLOBAL: 186, MIXER: 16, PITCH: 109 };
      for (const [fam, n] of Object.entries(per)) assertEqual(countOf(s, fam), n, `FM3 ${mode}: ${fam}`);
      const g = responseOf(s, 'GLOBAL');
      const generic = entriesOf(g).filter((e) => e.generic);
      assertEqual(generic.map((e) => e.id).sort((a, b) => a - b).join(','), GLOBAL_GENERIC, `FM3 ${mode}: the 27 generic params are the unnamed GLOBAL rows`);
      for (const e of entriesOf(g)) assertEqual(`${e.value}/${e.unresolved}`, 'null/non-positional', `FM3 ${mode} GLOBAL ${e.id}: no value, non-positional`);
      assertEqual(`${g.definitions.positional}/${g.definitions.channel}/${g.definitions.persistentWrites}/${g.type}`, 'false/null/true/null', `FM3 ${mode}: GLOBAL is not positional, has no channel, writes persist`);
      for (const [fam, { r }] of s.byFamily) if (fam !== 'GLOBAL') assert(entriesOf(r).every((e) => !e.generic), `FM3 ${mode} ${fam}: no generic param outside GLOBAL`);
    }
    // PRESET has no effect id: its rows (two of them unnamed) are served by no block
    const preset = buildParamIndex(FM3, 'PRESET');
    assertEqual(`${informative(FM3.ranges.PRESET).length}/${preset.entries.filter((e) => e.generic).map((e) => e.pid).join(',')}`, '50/0,216', 'FM3 PRESET: 50 informative rows, 2 unnamed');
    console.log('  drivers/param-coverage: FM3 — 1611 params, 27 generic (all GLOBAL, all non-positional), per-family goldens, PRESET unreachable');
  }

  // ---- 5. FM9 and Axe-Fx III totals, and the scope they are counted over ---------------------------------------
  {
    const pinned: Record<string, [number, number]> = {
      'FM9 catalog': [1685, 49], 'FM9 profile': [1685, 49],
      'Axe-Fx III catalog': [1824, 30], 'Axe-Fx III profile': [1814, 30],
    };
    for (const [key, [n, g]] of Object.entries(pinned)) assertEqual(`${total(S(key))}/${genericTotal(S(key))}`, `${n}/${g}`, `${key}: params / generic over the reachable families`);
    // the index over EVERY family (PRESET aside) counts more: exactly the families without an effect id
    for (const [name] of DEVICES) {
      for (const mode of ['catalog', 'profile']) {
        const s = S(`${name} ${mode}`);
        const all = Object.keys(s.profile.ranges).filter((f) => f !== 'PRESET');
        const indexTotal = all.reduce((n, f) => n + buildParamIndex(s.profile, f).entries.length, 0);
        const unreached = all.filter((f) => !s.byFamily.has(f)).reduce((n, f) => n + buildParamIndex(s.profile, f).entries.length, 0);
        assertEqual(indexTotal, total(s) + unreached, `${name} ${mode}: index total = reachable + the families without an effect id`);
        const expectIndex = { FM3: [1611, 1611], FM9: [1685, 1685], 'Axe-Fx III': [1959, 1948] }[name]!;
        assertEqual(indexTotal, expectIndex[mode === 'catalog' ? 0 : 1]!, `${name} ${mode}: index total over every family but PRESET`);
      }
    }
    const iii = (f: string, mode: string) => buildParamIndex(S(`Axe-Fx III ${mode}`).profile, f).entries.length;
    assertEqual(['VOCODER', 'CROSSOVER', 'TONEMATCH', 'RTA', 'IRPLAYER', 'DYNDIST', 'IRCAPTURE'].map((f) => `${f}:${iii(f, 'catalog')}/${iii(f, 'profile')}`).join(' '),
      'VOCODER:66/66 CROSSOVER:14/14 TONEMATCH:18/18 RTA:6/5 IRPLAYER:19/19 DYNDIST:12/12 IRCAPTURE:0/0', 'Axe-Fx III: the families without an effect id (135 / 134 params)');
    // a sweep over the codec block roster and the virtual effects alone (the blocks GET /preset/blocks lists) misses
    // the FM9's CROSSOVER: its effect id (142) is in the effect-id table only
    const rosterOnly = await sweep(S('FM9 profile').profile, [...new Set([...VIRTUAL_EIDS, ...ROSTER_EIDS])].sort((a, b) => a - b));
    assertEqual(`${total(rosterOnly)}/${countOf(S('FM9 profile'), 'CROSSOVER')}/${S('FM9 profile').byFamily.get('CROSSOVER')?.eid}`, '1671/14/142', 'FM9: roster + virtual effects only = 1671 (CROSSOVER, 14 params at eid 142, is missed)');
    // where the generic params are
    const genericByFamily = (s: Sweep) => [...s.byFamily].filter(([, { r }]) => entriesOf(r).some((e) => e.generic)).map(([f, { r }]) => `${f}:${entriesOf(r).filter((e) => e.generic).length}`).sort().join(' ');
    assertEqual(genericByFamily(S('FM9 profile')), 'CHORUS:3 DELAY:3 DISTORT:3 FUZZ:1 GLOBAL:31 MIXER:6 REVERB:2', 'FM9: generic params per family (catalog rows the FM9 tables have no name for)');
    assertEqual(genericByFamily(S('Axe-Fx III profile')), 'GLOBAL:30', 'Axe-Fx III: generic params per family');
    console.log('  drivers/param-coverage: FM9 1685/49, III 1824 (catalog) / 1814 (profile), 30 generic — index totals minus the families without an effect id; roster-only FM9 sweep 1671');
  }

  // ---- 6. invariants on every response ---------------------------------------------------------------------------
  const nextExact = await sweep(newerFirmwareProfile('editor-cache'));
  const nextLive = await sweep(newerFirmwareProfile('live'));
  {
    for (const [key, s] of sweeps) invariants(s, key);
    invariants(nextExact, 'next firmware (byte-exact)');
    invariants(nextLive, 'next firmware (live)');
    console.log('  drivers/param-coverage: invariants — no enum among the dials, no selector-evidence float as a knob, generic = P<pid>, nothing listed twice or listed and hidden');
  }

  const catalogFm3 = S('FM3 profile');
  const delta = (s: Sweep) => [...s.byFamily.keys()].filter((f) => countOf(s, f) !== countOf(catalogFm3, f)).sort().map((f) => `${f}:${countOf(s, f)! - countOf(catalogFm3, f)!}`).join(' ');

  // ---- 7. next firmware (byte-exact): totals and coverage ---------------------------------------------------------
  {
    assertEqual(`${total(nextExact)}/${genericTotal(nextExact)}`, '1616/34', 'next firmware: params / generic');
    assertEqual(delta(nextExact), 'CHORUS:1 COMP:-1 DELAY:1 ENHANCER:1 FUZZ:1 REVERB:1 ROTARY:1', 'next firmware: per-family change against fw 12');
    const all = [...nextExact.byFamily.values()].flatMap(({ r }) => entriesOf(r));
    const histogram = (k: 'nameConfidence' | 'nameSource') => {
      const h: Record<string, number> = {};
      for (const e of all) h[String(e[k])] = (h[String(e[k])] ?? 0) + 1;
      return Object.entries(h).sort().map(([x, n]) => `${x}:${n}`).join(' ');
    };
    assertEqual(histogram('nameSource'), 'catalog:1572 catalog-moved:10 generic:34', 'next firmware: name sources');
    assertEqual(histogram('nameConfidence'), 'high:1569 low:2 medium:11 undefined:34', 'next firmware: name confidence');
    assertEqual(all.filter((e) => e.isNew).length, 6, 'next firmware: six params are new in firmware (four generic, two moved names)');
    // listed + hidden covers the rows of what backs each family: the profile, or the catalog for the swapped pair
    const [swapA, swapB] = NEWER_FIRMWARE.swapped;
    for (const [fam, { r }] of nextExact.byFamily) {
      const suspect = fam === swapA || fam === swapB;
      const rows = suspect ? FM3.ranges[fam] : nextExact.profile.profileFacts!.ranges[fam];
      // the type selector follows its name where rows were inserted in front of it
      const ins = [NEWER_FIRMWARE.inserted, NEWER_FIRMWARE.insertedAmbiguous].find((x) => x.family === fam);
      const catType = typeSelectorPid(FM3, fam);
      const typePid = catType !== undefined && ins && catType >= ins.at ? catType + 1 : catType;
      const shown = r.named.length + r.enums.length;
      const removed = r.definitions.hidden.filter((h) => h.reason === 'removed').length;
      assertEqual(shown, expectedShown(rows, typePid, FM3.params[fam]), `next firmware ${fam}: listed = expected`);
      assertEqual(shown + r.definitions.hidden.length - removed, informative(rows).length, `next firmware ${fam}: listed + hidden (other than removed) = informative rows`);
      assertEqual(r.definitions.profile, suspect ? 'none' : 'byte-exact', `next firmware ${fam}: backing`);
    }
    console.log('  drivers/param-coverage: next firmware (byte-exact) — 1616 params, 34 generic, 10 moved names, 6 new; listed + hidden = informative per family');
  }

  // ---- 8. next firmware: a new param of each class -----------------------------------------------------------------
  {
    const { newKnob, newToggle, newDropdown, longList } = NEWER_FIRMWARE;
    const knob = entryAt(responseOf(nextExact, newKnob.family), newKnob.pid) as NamedParamV2;
    assertEqual(`${knob.name}/${knob.kind}/${knob.widget}/${knob.write}/${knob.generic}/${knob.isNew}/${knob.pageHint}/${knob.source}`, `P${newKnob.pid}/float/knob/norm/true/true/new-in-firmware/profile`, 'new float at the stride: a generic knob, new in firmware');
    assert(responseOf(nextExact, newKnob.family).named.includes(knob), 'and it is a dial');
    assertEqual(`${knob.min}/${knob.max}/${knob.value !== null}`, '0/10/true', 'its range comes from the profile row, its value from the widened body');
    const toggle = entryAt(responseOf(nextExact, newToggle.family), newToggle.pid) as EnumParamV2;
    assertEqual(`${toggle.name}/${toggle.kind}/${toggle.widget}/${toggle.write}/${toggle.generic}/${toggle.isNew}`, `P${newToggle.pid}/enum/toggle/ordinal/true/true`, 'new two-label selector: a generic toggle, ordinal write');
    assertEqual(toggle.options.map((o) => `${o.value}:${o.label}`).join(','), '0:LO,1:HI', 'with the profile labels');
    const dd = entryAt(responseOf(nextExact, newDropdown.family), newDropdown.pid) as EnumParamV2;
    assertEqual(`${dd.widget}/${dd.write}/${dd.generic}`, 'dropdown/ordinal/true', 'new five-label selector: a generic dropdown');
    assertEqual(dd.options.map((o) => `${o.value}:${o.label}`).join(','), '1:A,2:B,3:C,4:D,5:E', 'the label of ordinal v is labels[v - first ordinal]');
    const ll = entryAt(responseOf(nextExact, longList.family), longList.pid) as EnumParamV2;
    assertEqual(`${ll.widget}/${ll.options.length}/${ll.optionsTruncated}/${ll.options[139]!.label}`, 'dropdown/140/undefined/SPACE 140', 'a 140-entry list is served whole');
    console.log('  drivers/param-coverage: next firmware — new knob (isNew, new-in-firmware), new toggle (ordinal), new dropdown (labels from the first ordinal), 140-option list');
  }

  // ---- 9. next firmware: an unused slot and a dropped param --------------------------------------------------------
  {
    const { unusedSlot, dropped } = NEWER_FIRMWARE;
    const delay = responseOf(nextExact, unusedSlot.family);
    assert(!entriesOf(delay).some((e) => e.id === unusedSlot.pid) && !delay.definitions.hidden.some((h) => h.id === unusedSlot.pid), 'the unused slot is neither listed nor hidden (it is no informative row)');
    const eid = nextExact.byFamily.get(unusedSlot.family)!.eid;
    const { driver, mock } = mockGen3Device(nextExact.profile, []);
    let refused: { statusCode?: number; message: string } | undefined;
    try { await driver.setParam(eid, unusedSlot.pid, 0.5, true); } catch (e) { refused = { statusCode: (e as { statusCode?: number }).statusCode, message: (e as Error).message }; }
    assertEqual(refused?.statusCode, 409, 'a write to the unused slot is refused');
    assertEqual(refused?.message, `param ${unusedSlot.pid} of ${unusedSlot.family} is an unused slot on this firmware; write refused`, 'with the reason');
    assertEqual(mock.sent.length, 0, 'and nothing went out');
    const droppedPid = catalogPid(dropped.family, dropped.name);
    const comp = responseOf(nextExact, dropped.family);
    assert(comp.definitions.hidden.some((h) => h.id === droppedPid && h.reason === 'removed'), 'the dropped param is hidden as removed');
    assert(!entriesOf(comp).some((e) => e.id === droppedPid), 'and not listed');
    console.log('  drivers/param-coverage: next firmware — unused slot not listed, write 409 with nothing sent; dropped param hidden as removed');
  }

  // ---- 10. next firmware: a row inserted where every name can follow its row ---------------------------------------
  {
    const { inserted } = NEWER_FIRMWARE;
    assertEqual(shiftWindowProblems(inserted.family, inserted.at).join('; '), '', 'premise: every catalog row in the window is unique, no shifted row is compatible with its new pid, no type or bypass row');
    const r = responseOf(nextExact, inserted.family);
    const moved = entriesOf(r).filter((e) => e.nameSource === 'catalog-moved');
    const expected = inserted.movedNames.map((n) => `${catalogPid(inserted.family, n) + 1}<-${catalogPid(inserted.family, n)}`);
    assertEqual(moved.map((e) => `${e.id}<-${e.movedFrom}`).join(','), expected.join(','), 'exactly the five names of the window move up one pid');
    assert(moved.every((e) => e.nameConfidence === 'medium' && e.source === 'profile'), 'moved names are medium confidence, profile rows');
    const gap = entryAt(r, inserted.at);
    assertEqual(`${gap.name}/${gap.generic}/${gap.pageHint}/${gap.isNew}`, `P${inserted.at}/true/more/undefined`, 'the inserted row is generic, on the more page (the catalog has a row there)');
    const last = entryAt(r, catalogPid(inserted.family, inserted.movedNames[4]) + 1);
    assertEqual(`${last.generic}/${last.isNew}/${last.nameSource}`, 'false/true/catalog-moved', 'the last name lands on a pid the catalog has no row for: named and new');
    assertEqual(hiddenOf(r), '11:bypass', 'nothing else changes');
    // the editor layout follows: every moved name's control points at the pid that carries it now
    const movedControls = layoutOf(r).split(' ').filter((c) => c.includes('<') || c.endsWith('!'));
    assertEqual(movedControls.sort().join(' '), 'ROTARY_DRIVE:18<17 ROTARY_INPUTSELECT:20<19 ROTARY_MICDIST:19<18 ROTARY_SCENEIGNORE:21<20 ROTARY_SPREAD:17<16', 'the layout controls of the moved names follow them; none is unbound');
    console.log('  drivers/param-coverage: next firmware — insert into ROTARY: exactly the 5 window names move (medium), the inserted row is generic (more), the last one is new');
  }

  // ---- 11. next firmware: an insert whose window cannot be followed safely -----------------------------------------
  {
    const { insertedAmbiguous: ins } = NEWER_FIRMWARE;
    assertEqual(shiftWindowProblems(ins.family, ins.at).join('; '), 'pid 5 is the bypass; pid 6 is the type selector; pid 8 shares its row with 9; pid 8 is compatible with the catalog row at 9; pid 9 shares its row with 8', 'premise: the window holds the bypass, the type selector and an identical pair');
    const r = responseOf(nextExact, ins.family);
    assertEqual(hiddenOf(r), '6:bypass,7:type', 'the bypass row and the type selector are hidden where they now sit (the type follows its name)');
    assertEqual(r.type?.name, 'Classic', 'the type is read where it sits now');
    const at = (pid: number) => { const e = entryAt(r, pid); return `${e.name}/${e.nameSource}/${e.movedFrom ?? '-'}/${e.nameConfidence ?? '-'}`; };
    assertEqual([0, 1].map(at).join(' '), 'Width/catalog/-/high Depth/catalog/-/high', 'the identical pair in front of the insert keeps its names');
    assertEqual(at(8), 'Phase Invert/catalog-moved/7/medium', 'the name behind the type follows its row');
    assertEqual(at(9), 'Pan Right/catalog/-/high', 'the shifted pair: the row at 9 still looks like the catalog row at 9, nothing moves');
    assertEqual(at(10), 'P10/generic/-/-', 'and the name without a unique row is dropped, not guessed');
    assertEqual([4, 5, 11, 12].map(at).join(' '), 'High Cut/catalog-moved/3/medium Level/catalog-moved/4/medium Balance/catalog-moved/10/medium Scene Ignore/catalog-moved/11/medium', 'the other unique rows follow');
    assertEqual(at(3), 'P3/generic/-/-', 'the inserted row is generic');
    // the layout: moved names are followed (the hidden bypass too); the name that could not follow is unbound, so
    // its control does not write the param that moved onto its old pid
    assertEqual(layoutOf(r), 'ENHANCER_WIDTH:0 ENHANCER_PHASE:8<7 ENHANCER_PANL:8! ENHANCER_PANR:9 ENHANCER_PAN:11<10 ENHANCER_LEVEL:5<4 ENHANCER_BYPASS:6<5 ENHANCER_SCENEIGNORE:12<11', 'the served layout follows the names');
    console.log('  drivers/param-coverage: next firmware — insert into ENHANCER: identical pairs never move, the type exclusion follows the moved type name');
  }

  // ---- 12. next firmware: revised rows -----------------------------------------------------------------------------
  {
    const { appended, neutralised, enumToFloat } = NEWER_FIRMWARE;
    const tube = entryAt(responseOf(nextExact, appended.family), catalogPid(appended.family, appended.name)) as EnumParamV2;
    assertEqual(`${tube.name}/${tube.nameSource}/${tube.nameConfidence}/${tube.options.length}/${tube.options.at(-1)!.label}`, `Power Tube Type/catalog/medium/27/${appended.labels[1]}`, 'appended labels: same name, medium, the longer list');
    const rate = entryAt(responseOf(nextExact, neutralised.family), catalogPid(neutralised.family, neutralised.name)) as NamedParamV2;
    assertEqual(`${rate.name}/${rate.nameSource}/${rate.nameConfidence}/${rate.min}/${rate.max}`, 'Rate/catalog/low/0/1', 'a neutralised row: same name, low, the device range');
    const e2f = entryAt(responseOf(nextExact, enumToFloat.family), catalogPid(enumToFloat.family, enumToFloat.name));
    assert(responseOf(nextExact, enumToFloat.family).named.includes(e2f as NamedParamV2), 'a selector that became a float is a dial now');
    assertEqual(`${e2f.kind}/${e2f.widget}/${e2f.widgetSource}/${e2f.nameConfidence}/${e2f.source}`, 'float/stepper/catalog/low/profile', 'a stepper (its catalog unit says selector), low');
    console.log('  drivers/param-coverage: next firmware — appended labels medium, neutralised row low, enum turned float = stepper, low');
  }

  // ---- 13. next firmware: swapped sections, an unknown block --------------------------------------------------------
  {
    for (const [label, s] of [['byte-exact', nextExact], ['live', nextLive]] as const) {
      assertEqual(s.profile.profileFacts!.suspectFamilies.join(','), NEWER_FIRMWARE.swapped.join(','), `${label}: both swapped families are suspects`);
      for (const fam of NEWER_FIRMWARE.swapped) {
        const r = responseOf(s, fam);
        assertEqual(`${r.definitions.profile}/${r.definitions.suspect}`, 'none/true', `${label} ${fam}: no usable profile, suspect`);
        assert(entriesOf(r).every((e) => e.source === 'catalog' && !e.generic), `${label} ${fam}: served from the catalog`);
        assertEqual(countOf(s, fam), countOf(catalogFm3, fam), `${label} ${fam}: the catalog's params`);
        for (const [pid, row] of Object.entries(FM3.ranges[fam]!)) assertEqual(s.profile.ranges[fam]![Number(pid)], row, `${label} ${fam} ${pid}: the catalog row, not merged`);
      }
      // every name confirmed: no device row was used, and a live walk's rows of a suspect section say nothing either
      for (const fam of NEWER_FIRMWARE.swapped) {
        for (const e of entriesOf(responseOf(s, fam))) assertEqual(e.nameConfidence, 'high', `${label} ${fam} ${e.id}: name confirmed`);
      }
      const { driver } = mockGen3Device(s.profile, []);
      const u = await driver.blockParams(NEWER_FIRMWARE.unknownEid, { generic: true });
      assertEqual(JSON.stringify(u), JSON.stringify({
        block: `Block ${NEWER_FIRMWARE.unknownEid}`, slug: '', page: -1, named: [], enums: [], type: null, unknownBlock: true,
        definitions: { family: null, profile: 'none', positional: false, channel: null, persistentWrites: false, hidden: [] },
      }), `${label}: a placed block without a family is named by its effect id`);
    }
    console.log('  drivers/param-coverage: next firmware — MIXER/OUTPUT swap: both suspect, catalog rows, profile none; eid 205 answers "Block 205"');
  }

  // ---- 14. next firmware as a live walk: the live provenance rules ----------------------------------------------------
  {
    const s = nextLive;
    assertEqual(`${total(s)}/${genericTotal(s)}`, '1618/35', 'live: params / generic');
    assertEqual(delta(s), 'CHORUS:1 DELAY:1 ENHANCER:2 FUZZ:1 REVERB:1 ROTARY:1', 'live: per-family change against fw 12');
    for (const [fam, { r }] of s.byFamily) {
      if (!(NEWER_FIRMWARE.swapped as readonly string[]).includes(fam)) assertEqual(r.definitions.profile, 'live', `live ${fam}: backing`);
      assert(!r.definitions.hidden.some((h) => h.reason === 'removed'), `live ${fam}: a live profile never hides a row as removed`);
      assertEqual(r.named.length + r.enums.length + r.definitions.hidden.length, informative(s.profile.ranges[fam]).length, `live ${fam}: listed + hidden = informative effective rows`);
    }
    // new params: as with the byte-exact profile
    for (const { family, pid } of [NEWER_FIRMWARE.newKnob, NEWER_FIRMWARE.newToggle, NEWER_FIRMWARE.newDropdown, NEWER_FIRMWARE.longList]) {
      const e = entryAt(responseOf(s, family), pid);
      assertEqual(`${e.generic}/${e.isNew}/${e.pageHint}/${e.source}`, 'true/true/new-in-firmware/profile', `live ${family} ${pid}: a new row the walk returned is generic and new`);
    }
    // the unused slot: the walk's placeholder row says nothing, the pid has no row at all, a write goes out
    assert(!entriesOf(responseOf(s, NEWER_FIRMWARE.unusedSlot.family)).some((e) => e.id === NEWER_FIRMWARE.unusedSlot.pid), 'live: the unused slot is not listed');
    const { driver, mock } = mockGen3Device(s.profile, []);
    assertEqual((await driver.setParam(s.byFamily.get(NEWER_FIRMWARE.unusedSlot.family)!.eid, NEWER_FIRMWARE.unusedSlot.pid, 0.5, true)).ok, true, 'live: a write to a pid without a row is not refused');
    assertEqual(mock.sent.filter((f) => f[5] === 0x01).length, 1, 'live: one param frame went out');
    // the dropped param: a walk's missing row is no information, the catalog row stands
    const droppedPid = catalogPid(NEWER_FIRMWARE.dropped.family, NEWER_FIRMWARE.dropped.name);
    const dropped = entryAt(responseOf(s, NEWER_FIRMWARE.dropped.family), droppedPid);
    assertEqual(`${dropped.source}/${dropped.nameConfidence}`, 'catalog/high', 'live: the param the firmware dropped is still served from the catalog');
    // the insert into ROTARY: names follow the rows the walk applied; a kind conflict keeps the catalog row
    const rot = responseOf(s, NEWER_FIRMWARE.inserted.family);
    const at = (r: BlockParamsV2DTO, pid: number) => { const e = entryAt(r, pid); return `${e.name}/${e.source}/${e.nameSource}/${e.movedFrom ?? '-'}/${e.nameConfidence ?? '-'}`; };
    assertEqual([16, 17, 18, 19, 20, 21].map((pid) => at(rot, pid)).join(' | '),
      'P16/profile/generic/-/- | Stereo Spread/profile/catalog-moved/16/medium | Drive/profile/catalog-moved/17/medium | Input Select/catalog/catalog/-/medium | P20/profile/generic/-/- | Scene Ignore/profile/catalog-moved/20/medium',
      'live ROTARY: three names follow their rows, the selector row the walk saw as a float stays the catalog row (medium), the mic distance name has no row left');
    // the insert into ENHANCER: the type row the walk saw as a float keeps the catalog row, so the type stays at 6
    const enh = responseOf(s, NEWER_FIRMWARE.insertedAmbiguous.family);
    assertEqual(hiddenOf(enh), '6:type', 'live ENHANCER: the type stays where the catalog has it; the bypass row landed on a kind conflict and is gone');
    assertEqual(enh.type?.name, 'Modern', 'live ENHANCER: the type is read at the catalog pid');
    assertEqual([3, 4, 5, 7, 8, 9, 10, 11, 12].map((pid) => at(enh, pid)).join(' | '),
      'P3/profile/generic/-/- | High Cut/profile/catalog-moved/3/medium | Level/profile/catalog-moved/4/medium | Phase Invert/profile/catalog/-/low | Pan Left/catalog/catalog/-/medium | Pan Right/profile/catalog/-/high | Balance/profile/catalog/-/low | Scene Ignore/catalog/catalog/-/medium | P12/profile/generic/-/-',
      'live ENHANCER: what a walk of the shifted family looks like');
    assertEqual(layoutOf(rot).split(' ').filter((c) => c.includes('<') || c.endsWith('!')).sort().join(' '), 'ROTARY_DRIVE:18<17 ROTARY_MICDIST:18! ROTARY_SCENEIGNORE:21<20 ROTARY_SPREAD:17<16', 'live ROTARY layout: followed names, the lost mic distance unbound');
    assertEqual(layoutOf(enh), 'ENHANCER_WIDTH:0 ENHANCER_DEPTH:1 ENHANCER_LOWCUT:2 ENHANCER_HICUT:4<3 ENHANCER_LEVEL:5<4 ENHANCER_BYPASS:5! ENHANCER_SCENEIGNORE:11', 'live ENHANCER layout: the bypass row was not applied, its control is unbound');
    // revised rows
    const tube = entryAt(responseOf(s, NEWER_FIRMWARE.appended.family), catalogPid(NEWER_FIRMWARE.appended.family, NEWER_FIRMWARE.appended.name)) as EnumParamV2;
    assertEqual(`${tube.nameConfidence}/${tube.options.length}`, 'medium/27', 'live: appended labels, medium');
    const rate = entryAt(responseOf(s, NEWER_FIRMWARE.neutralised.family), catalogPid(NEWER_FIRMWARE.neutralised.family, NEWER_FIRMWARE.neutralised.name));
    assertEqual(`${rate.source}/${rate.nameConfidence}`, 'profile/low', 'live: a same-kind neutralised row is applied, low');
    const e2fPid = catalogPid(NEWER_FIRMWARE.enumToFloat.family, NEWER_FIRMWARE.enumToFloat.name);
    const e2f = entryAt(responseOf(s, NEWER_FIRMWARE.enumToFloat.family), e2fPid) as EnumParamV2;
    assertEqual(`${e2f.kind}/${e2f.source}/${e2f.nameConfidence}/${e2f.widget}/${e2f.options.length}`, 'enum/catalog/medium/dropdown/10', 'live: a walk never re-classifies a catalog selector; the catalog kind stands (medium)');
    console.log('  drivers/param-coverage: next firmware as a live walk — 1618 params, 35 generic; never hides, kind conflicts keep the catalog row, placeholders are no information');
  }
}
