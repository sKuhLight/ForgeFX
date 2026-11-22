// Selector options on gen-3 blocks, served by the classic and the generic response alike:
//   • a device label list starts at the row's FIRST ordinal, so the label of ordinal v is `list[v - first]`
//     (DELAY_SVFTYPE runs 1..3: ordinal 1 is the first label, not the second);
//   • the options cover the row's ordinals (an enum row's count, not its scaled display range: PHASER_ORDER has
//     six ordinals, its display range 0..10 would list eleven);
//   • a long list is served whole up to 4096 options (DISTORT_TONETYPE has 138; the old cap of 128 cut it), and
//     the generic response says when the cap cut a list (`optionsTruncated`);
//   • a label the device does not ship falls back to the model overlay, then to the bare ordinal.
// Committed catalog data for the three devices; synthetic rows for the cap and the overlay. Mocked link, no device.
import { PROFILES, type DeviceProfile, type ParamDef, type RangeDef } from '../../src/devices.js';
import type { BlockParamsDTO, BlockParamsV2DTO } from '../../src/drivers/types.js';
import { resolveEnumValues } from 'forgefx-midi/gen3/axe-fx-iii';
import { assert, assertEqual } from '../helpers/mock.js';
import { mockBlockDevice, eidOfSlug } from '../helpers/blockRead.js';
import { MAX_ENUM_OPTIONS } from '../../src/drivers/gen3.js';

export const ENUM_OPTIONS_CASE_COUNT = 6;

const DEVICES: [string, DeviceProfile][] = [['FM3', PROFILES[0x11]!], ['FM9', PROFILES[0x12]!], ['Axe-Fx III', PROFILES[0x10]!]];

type Both = { classic: BlockParamsDTO; generic: BlockParamsV2DTO };

/** The block `slug` of `profile` read twice (classic, generic) with `set` pids written into channel A of a zero body. */
async function readBoth(profile: DeviceProfile, slug: string, family: string, set: Record<number, number> = {}): Promise<Both> {
  const eid = eidOfSlug(slug);
  const values = new Array<number>(profile.rangeSections[family]!.stride * 4).fill(0);
  for (const [pid, v] of Object.entries(set)) values[Number(pid)] = v;
  const { driver } = mockBlockDevice(profile, { [eid]: { values, channel: 0 } });
  return { classic: await driver.blockParams(eid), generic: (await driver.blockParams(eid, { generic: true })) as BlockParamsV2DTO };
}

const pidOf = (p: DeviceProfile, family: string, name: string): number => {
  const d = p.params[family]!.find((x) => x.name === name);
  assert(!!d, `${family}.${name} is in the catalog`);
  return d.paramId;
};

/** A DELAY block of `profile` reduced to the given params, so one row can be shaped freely. */
function withDelay(defs: ParamDef[], rows: Record<number, RangeDef>, labels: Record<number, string[]> = {}): DeviceProfile {
  const base = PROFILES[0x11]!;
  return {
    ...base,
    params: { ...base.params, DELAY: defs },
    ranges: { ...base.ranges, DELAY: rows },
    rangeSections: { ...base.rangeSections, DELAY: { sectionTag: 1, stride: 8, recordCount: 8 } },
    enumLabelsFor: (family: string, pid: number) => (family === 'DELAY' ? labels[pid] : base.enumLabelsFor(family, pid)),
  } as DeviceProfile;
}
const enumRow = (n: number, o: Partial<RangeDef> = {}): RangeDef => ({ kind: 'enum', displayMin: 0, displayMax: n - 1, scale: 1, step: 0, typecode: 0x10, enumCount: n, ...o });

export async function runEnumOptionsTests(): Promise<void> {
  // ---- 1. the label of an ordinal is the list entry at (ordinal - first ordinal) -----------------------
  for (const [name, p] of DEVICES) {
    const pid = pidOf(p, 'DELAY', 'DELAY_SVFTYPE');
    const row = p.ranges['DELAY']![pid]!;
    assertEqual(row.displayMin, 1, `${name}: DELAY_SVFTYPE starts at ordinal 1 (the premise)`);
    const labels = p.enumLabelsFor('DELAY', pid)!;
    assertEqual(labels.length, 3, `${name}: three labels`);
    const { classic, generic } = await readBoth(p, 'delay', 'DELAY', { [pid]: 2 });
    for (const [which, e] of [['classic', classic.enums.find((x) => x.id === pid)!], ['generic', generic.enums.find((x) => x.id === pid)!]] as const) {
      assertEqual(JSON.stringify(e.options), JSON.stringify([{ value: 1, label: labels[0] }, { value: 2, label: labels[1] }, { value: 3, label: labels[2] }]), `${name} ${which}: ordinal v carries labels[v - 1]`);
      assertEqual(e.value, 2, `${name} ${which}: the ordinal read back`);
    }
  }
  console.log('  drivers/enum-options: DELAY_SVFTYPE (1..3) — ordinal v is labelled list[v - 1] on FM3, FM9 and III, classic and generic');

  // ---- 2. a 138-option list is served whole -----------------------------------------------------------
  for (const [name, p] of DEVICES) {
    const pid = pidOf(p, 'DISTORT', 'DISTORT_TONETYPE');
    const labels = p.enumLabelsFor('DISTORT', pid)!;
    assertEqual(labels.length, 138, `${name}: the tonestack list has 138 labels (the premise)`);
    const { classic, generic } = await readBoth(p, 'amp', 'DISTORT', { [pid]: 137 });
    for (const [which, e] of [['classic', classic.enums.find((x) => x.id === pid)!], ['generic', generic.enums.find((x) => x.id === pid)!]] as const) {
      assertEqual(e.options.length, 138, `${name} ${which}: all 138 options (the old cap cut at 128)`);
      assertEqual(e.options[137]!.label, labels[137], `${name} ${which}: the last label`);
      assertEqual(e.value, 137, `${name} ${which}: the last ordinal reads back`);
    }
    assertEqual((generic.enums.find((x) => x.id === pid) as { optionsTruncated?: true }).optionsTruncated, undefined, `${name}: not truncated`);
  }
  console.log('  drivers/enum-options: DISTORT_TONETYPE serves 138 options on FM3, FM9 and III (classic and generic), not truncated');

  // ---- 3. an enum row is bounded by its count, not by its scaled display range -----------------------------
  for (const [name, p] of DEVICES) {
    const pid = pidOf(p, 'PHASER', 'PHASER_ORDER');
    const row = p.ranges['PHASER']![pid]!;
    assertEqual(`${row.scale}:${row.displayMin}-${row.displayMax}:${row.enumCount}`, '2:0-10:6', `${name}: PHASER_ORDER is scale 2, display 0..10, six labels (the premise)`);
    const ordinal = await readBoth(p, 'phaser', 'PHASER', { [pid]: 3 });
    const scaled = await readBoth(p, 'phaser', 'PHASER', { [pid]: 65534 });
    for (const [which, r] of [['classic', ordinal.classic], ['generic', ordinal.generic]] as const) {
      const e = r.enums.find((x) => x.id === pid)!;
      assertEqual(e.options.map((o) => o.value).join(','), '0,1,2,3,4,5', `${name} ${which}: six ordinals`);
      assertEqual(e.value, 3, `${name} ${which}: an ordinal inside the range is the ordinal`);
    }
    for (const [which, r] of [['classic', scaled.classic], ['generic', scaled.generic]] as const) {
      assertEqual(r.enums.find((x) => x.id === pid)!.value, 5, `${name} ${which}: a full-scale value maps to the last ordinal`);
    }
  }
  console.log('  drivers/enum-options: PHASER_ORDER lists six ordinals (not eleven) and decodes a full-scale value to the last one');

  // ---- 4. the cap: 4096 options, and the generic response says when it cut ----------------------------------
  {
    assertEqual(MAX_ENUM_OPTIONS, 4096, 'the cap');
    const sizes: [number, boolean][] = [[MAX_ENUM_OPTIONS, false], [MAX_ENUM_OPTIONS + 1, true], [5000, true]];
    for (const [n, cut] of sizes) {
      const labels = Array.from({ length: n }, (_, i) => `L${i}`);
      const p = withDelay([{ paramId: 0, name: 'DELAY_HUGE', unit: 'enum' }], { 0: enumRow(n) }, { 0: labels });
      const eid = eidOfSlug('delay');
      const { driver } = mockBlockDevice(p, { [eid]: { values: new Array(32).fill(0), channel: 0 } });
      const classic = await driver.blockParams(eid);
      const generic = await driver.blockParams(eid, { generic: true });
      const ce = classic.enums.find((e) => e.id === 0)!;
      const ge = generic.enums.find((e) => e.id === 0)!;
      assertEqual(ce.options.length, Math.min(n, MAX_ENUM_OPTIONS), `${n} labels, classic: cut at the cap`);
      assertEqual(ge.options.length, Math.min(n, MAX_ENUM_OPTIONS), `${n} labels, generic: cut at the cap`);
      assertEqual(ge.optionsTruncated, cut ? true : undefined, `${n} labels, generic: optionsTruncated ${cut ? 'set' : 'absent'}`);
      assertEqual(ge.options[ge.options.length - 1]!.label, `L${ge.options.length - 1}`, `${n} labels: the list is cut at its end, not thinned`);
    }
  }
  console.log('  drivers/enum-options: lists up to 4096 options are whole; longer ones are cut and the generic response flags optionsTruncated');

  // ---- 5. a label the device does not ship: the model overlay, then the bare ordinal ----------------------
  {
    const overlay = resolveEnumValues('DELAY_BYP');
    assert(!!overlay && overlay.values[1] !== undefined, 'the overlay knows a *_BYP selector (the premise)');
    const p = withDelay([{ paramId: 0, name: 'DELAY_BYP', unit: 'enum' }], { 0: enumRow(4) });
    const eid = eidOfSlug('delay');
    const { driver } = mockBlockDevice(p, { [eid]: { values: new Array(32).fill(0), channel: 0 } });
    const c = (await driver.blockParams(eid)).enums.find((e) => e.id === 0)!;
    assertEqual(c.options[1]!.label, overlay.values[1], 'classic: the overlay label by value');
    assertEqual(c.options[3]!.label, overlay.values[3] ?? '3', 'classic: a value the overlay lacks is the bare ordinal');
    const g = ((await driver.blockParams(eid, { generic: true })) as BlockParamsV2DTO).enums.find((e) => e.id === 0)!;
    assertEqual(JSON.stringify(g.options), JSON.stringify(c.options), 'generic: the same options');
    // a generic param has no catalog name to ask the overlay: bare ordinals
    const bare = withDelay([], { 0: enumRow(3) });
    const eid2 = eidOfSlug('delay');
    const gb = ((await mockBlockDevice(bare, { [eid2]: { values: new Array(32).fill(0), channel: 0 } }).driver.blockParams(eid2, { generic: true })) as BlockParamsV2DTO).enums.find((e) => e.id === 0)!;
    assertEqual(gb.options.map((o) => o.label).join(','), '0,1,2', 'a nameless param is labelled by ordinal');
  }
  console.log('  drivers/enum-options: no device label → overlay by value → bare ordinal');

  // ---- 6. the list order follows the ordinals, whatever the first one is -----------------------------------
  {
    const p = withDelay([{ paramId: 0, name: 'DELAY_SHIFTED', unit: 'enum' }], { 0: enumRow(3, { displayMin: 5, displayMax: 7 }) }, { 0: ['A', 'B', 'C'] });
    const eid = eidOfSlug('delay');
    const values = new Array<number>(32).fill(0);
    values[0] = 6;
    const { driver } = mockBlockDevice(p, { [eid]: { values, channel: 0 } });
    for (const r of [await driver.blockParams(eid), await driver.blockParams(eid, { generic: true })]) {
      const e = r.enums.find((x) => x.id === 0)!;
      assertEqual(JSON.stringify(e.options), JSON.stringify([{ value: 5, label: 'A' }, { value: 6, label: 'B' }, { value: 7, label: 'C' }]), 'a row 5..7 labels 5 → A');
      assertEqual(e.value, 6, 'ordinal 6 read back');
    }
  }
  console.log('  drivers/enum-options: a row starting at 5 labels ordinal 5 with the first entry');
}
