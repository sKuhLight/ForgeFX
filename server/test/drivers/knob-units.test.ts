// Knob selection on gen-3 blocks: which catalog params become dials.
//
// A float-kind range alone does not make a param a knob. Some selectors ship a float-typed range
// record under catalog unit 'enum' (CABINET_ZOOM, the CONTROLLERS_*_MODE rows, GLOBAL_SEND_MIDI_CLOCK
// …); rendering those as dials writes fractional values into a selector. So knob selection also
// requires a CONTINUOUS catalog unit (KNOB_UNITS).
//
// 'unverified', 'count' and 'pf' (float ranges that are mostly real continuous controls, but whose
// catalog unit proves nothing) are admitted CONSERVATIVELY: they must be label-less and must not look
// like a stepper (integer step, or integral bounds over a small span). On top of that, a param that is
// a selector ('enum' unit) on ANOTHER gen-3 device is never a knob, and a short denylist covers the
// cases no range heuristic can see (MOD_EFFECTID retargets a modifier, GLOBAL_CS_CHAN_BEGIN reads back
// its minimum). The lasting fix (correct units in the codec catalog) is a forgefx-midi follow-up.
//
// The suite pins:
//   • every selection rule on a synthetic family;
//   • per device (FM3 / FM9 / Axe-Fx III): no enum-kind or 'enum'-unit param is a knob, no param that
//     is an 'enum'-unit selector on ANY gen-3 device is a knob anywhere (the TENTAP_DECAYSTYLE class),
//     the semantic selectors that used to leak in (TENTAP_DECAYSTYLE, MOD_EFFECTID, REVERB_BASETYPE,
//     GLOBAL_CS_CHAN_BEGIN) are not knobs, every recovered knob honours the provisional-unit contract,
//     and the count of recovered knobs per device is printed;
//   • an end-to-end blockParams() read on the shipped FM3 profile.
// Mocked transport, no hardware.
import { createGen3Driver, knobParams } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { SLUG_FAMILY, profileForModel, runtimeProfileFrom } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import { mockBlockDevice } from '../helpers/blockRead.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { typecodeTaper, typecodeUnit } from 'forgefx-midi/cache';

export const KNOB_UNITS_CASE_COUNT = 11;

const PROVISIONAL_UNITS = new Set(['unverified', 'count', 'pf']);
/** Semantic selectors / non-dials that used to leak in as knobs when the provisional units were admitted. */
const MUST_NOT_BE_KNOBS = ['TENTAP_DECAYSTYLE', 'MOD_EFFECTID', 'REVERB_BASETYPE', 'GLOBAL_CS_CHAN_BEGIN'];
const GEN3_MODELS = [0x11, 0x12, 0x10]; // FM3, FM9, Axe-Fx III

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function blockBulkFrames(model: number, effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, []),
  ];
}

const eidOf = (slug: string): number => {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page;
};

async function blockParamsOf(profile: DeviceProfile, slug: string) {
  const eid = eidOf(slug);
  const family = SLUG_FAMILY[slug]!;
  const stride = profile.rangeSections[family]!.stride;
  const codec = createModernFractalCodec(profile.model);
  const bulk = blockBulkFrames(profile.model, eid, new Array(stride * 4).fill(0));
  const mock = new MockTransport('serial', 'mock-knob-units');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return driver.blockParams(eid);
}

type Rng = { kind: 'float' | 'enum'; displayMin: number; displayMax: number; typecode: number; step?: number };
const rng = (kind: 'float' | 'enum', lo = 0, hi = 10, step?: number): Rng => ({ kind, displayMin: lo, displayMax: hi, typecode: 0, ...(step != null ? { step } : {}) });

/** A family 'TEST' of single-rule params, plus a real TENTAP_DECAYSTYLE (an 'enum' unit on the Axe-Fx III) as 'unverified'. */
function synth(): DeviceProfile {
  return {
    model: 0x11, key: 'fm3', name: 'FM3-knob-units-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: {
      TEST: [
        { paramId: 0, name: 'TEST_NUMERIC', unit: 'numeric' },
        { paramId: 1, name: 'TEST_UNVERIFIED', unit: 'unverified' }, // 0..10 with a fractional step: a dial
        { paramId: 2, name: 'TEST_COUNT_Q', unit: 'count' }, // 0.1..10: a real continuous count-unit value
        { paramId: 3, name: 'TEST_CAP', unit: 'pf' },
        { paramId: 4, name: 'TEST_ZOOM', unit: 'enum' }, // float-typed range under the enum unit
        { paramId: 5, name: 'TEST_MODE', unit: 'enum' }, // a real enum
        { paramId: 6, name: 'TEST_UNVERIFIED_ENUM', unit: 'unverified' }, // enum range kind, non-enum unit
        { paramId: 7, name: 'TEST_BYPASS', unit: 'numeric' },
        { paramId: 8, name: 'TEST_DEAD', unit: 'numeric' }, // 0..0 range
        { paramId: 9, name: 'TEST_NOUNIT' }, // no unit at all
        { paramId: 0, name: 'TEST_NUMERIC_DUP', unit: 'numeric' }, // same wire paramId again
        { paramId: 10, name: 'TEST_STEP_INT', unit: 'unverified' }, // integer step: a stepper
        { paramId: 11, name: 'TEST_SMALL_INT', unit: 'count' }, // integral bounds, no step, small span: a stepper
        { paramId: 12, name: 'TEST_BIG_INT', unit: 'unverified' }, // integral bounds but a wide span: stays a dial
        { paramId: 13, name: 'TEST_FINE_STEP', unit: 'unverified' }, // 0..1 with a fractional step: a dial
        { paramId: 14, name: 'TEST_LABELLED', unit: 'unverified' }, // the profile has labels for it: a selector
        { paramId: 15, name: 'TEST_STEP_INT_NUMERIC', unit: 'numeric' }, // an ESTABLISHED unit is not vetted for steppers
      ],
      TENTAP: [{ paramId: 6, name: 'TENTAP_DECAYSTYLE', unit: 'unverified' }], // 'enum' on the Axe-Fx III
      MOD: [{ paramId: 8, name: 'MOD_EFFECTID', unit: 'numeric' }], // denylisted whatever its unit says
    },
    ranges: {
      TEST: {
        0: rng('float'), 1: rng('float', 0, 10, 0.001), 2: rng('float', 0.1, 10), 3: rng('float', 10, 10000),
        4: rng('float'), 5: rng('enum', 0, 3), 6: rng('enum', 0, 3), 7: rng('float'), 8: rng('float', 0, 0), 9: rng('float'),
        10: rng('float', 0, 100, 1), 11: rng('float', 2, 8), 12: rng('float', 30, 250), 13: rng('float', 0, 1, 0.001),
        14: rng('float', 0.5, 7.5), 15: rng('float', 0, 100, 1),
      },
      TENTAP: { 6: rng('float', 0, 1, 0.001) }, // a fractional step: only the cross-device rule can exclude it
      MOD: { 8: rng('float', 0.5, 201.5) },
    },
    rangeSections: {},
    rosterFor: () => [],
    enumLabelsFor: (family: string, paramId: number) => (family === 'TEST' && paramId === 14 ? ['A', 'B'] : undefined),
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

export async function runKnobUnitsTests(): Promise<void> {
  // ---- Case 1: every selection rule, on a synthetic family ------------------------------------
  const prof = synth();
  assertEqual(
    knobParams(prof, 'TEST').map((p) => p.name).join(','),
    'TEST_NUMERIC,TEST_UNVERIFIED,TEST_COUNT_Q,TEST_CAP,TEST_BIG_INT,TEST_FINE_STEP,TEST_STEP_INT_NUMERIC',
    'knob selection on the synthetic family',
  );
  console.log('  drivers/knob-units: selection rules (continuous units in; enum unit/kind, bypass, 0..0, no unit, duplicate pid, labelled and stepper-like provisional params out)');

  // ---- Case 2: a selector on another device is never a knob; the denylist holds ----------------
  assertEqual(knobParams(prof, 'TENTAP').length, 0, "a param that is an 'enum' unit on another gen-3 device is not a knob even when this catalog says 'unverified'");
  assertEqual(knobParams(prof, 'MOD').length, 0, 'MOD_EFFECTID (a modifier target) is never a knob, whatever its unit and range');
  console.log('  drivers/knob-units: cross-device enum counterpart and denylist exclude their params');

  // ---- Cases 3-6: per device, the shipped catalogs ---------------------------------------------
  const profs = GEN3_MODELS.map((m) => profileForModel(m));
  // 'FAMILY.NAME' of every param that is an 'enum'-unit selector on ANY device (from the raw catalogs).
  const enumAnywhere = new Set<string>();
  for (const p of profs) for (const [fam, list] of Object.entries(p.params)) for (const q of list) if (q.unit === 'enum') enumAnywhere.add(`${fam}.${q.name}`);
  const summary: string[] = [];
  for (const dev of profs) {
    let knobs = 0;
    let recovered = 0;
    let enumUnitFloat = 0;
    for (const family of Object.keys(dev.params)) {
      const picked = knobParams(dev, family);
      const pickedIds = new Set(picked.map((p) => p.paramId));
      knobs += picked.length;
      for (const p of picked) {
        const range = dev.ranges[family]![p.paramId]!;
        const where = `${dev.key} ${family}.${p.name}`;
        assertEqual(range.kind, 'float', `${where}: a knob must have a float range`);
        assert(p.unit !== 'enum', `${where}: an 'enum'-unit param must never become a knob`);
        assert(!enumAnywhere.has(`${family}.${p.name}`), `${where}: a param that is an 'enum' selector on any gen-3 device must never become a knob`);
        assert(!MUST_NOT_BE_KNOBS.includes(p.name), `${where}: a semantic selector / non-dial must never become a knob`);
        if (PROVISIONAL_UNITS.has(p.unit ?? '')) {
          recovered += 1;
          // The provisional-unit contract, restated independently of the implementation.
          const integral = Number.isInteger(range.displayMin) && Number.isInteger(range.displayMax);
          const step = range.step ?? 0;
          assert(!(dev.enumLabelsFor(family, p.paramId)?.length), `${where}: a labelled param is a selector, not a knob`);
          assert(!(integral && step >= 1 && Number.isInteger(step)), `${where}: an integer-stepped range must not be a recovered knob`);
          assert(!(integral && step === 0 && range.displayMax - range.displayMin <= 64), `${where}: a small integral no-step range must not be a recovered knob`);
        }
      }
      for (const p of dev.params[family] ?? []) {
        const range = dev.ranges[family]?.[p.paramId];
        // The params that removing the unit filter would turn into dials stay out.
        if (p.unit === 'enum' && range?.kind === 'float' && range.displayMin !== range.displayMax && !/bypass/i.test(p.displayLabel ?? p.name)) {
          assert(!pickedIds.has(p.paramId), `${dev.key} ${family}.${p.name}: enum-unit float-range param stays out of the knobs`);
          enumUnitFloat += 1;
        }
      }
    }
    assert(recovered > 0, `${dev.key}: the provisional units still recover at least one knob`);
    assert(enumUnitFloat > 0, `${dev.key}: the catalog has enum-unit float-range params (the unit filter has something to do)`);
    summary.push(`${dev.key}: ${knobs} knobs, +${recovered} recovered by unverified/count/pf, ${enumUnitFloat} enum-unit float-range params kept out`);
  }
  console.log(`  drivers/knob-units: ${summary.join('; ')}`);

  // Cases 3-6 in one line each, as invariants over the catalogs above:
  //  3 no enum-kind/enum-unit knob · 4 no cross-device selector knob (TENTAP_DECAYSTYLE class)
  //  5 the four leaked selectors are out · 6 provisional-unit contract.
  // Case 7: the leaked selectors are real catalog entries (so 5 is not vacuous).
  const known = new Set<string>();
  for (const p of profs) for (const list of Object.values(p.params)) for (const q of list) known.add(q.name);
  for (const name of MUST_NOT_BE_KNOBS) assert(known.has(name), `${name} is still a catalog param (the exclusion check is not vacuous)`);
  assert(enumAnywhere.has('TENTAP.TENTAP_DECAYSTYLE'), 'TENTAP_DECAYSTYLE is an enum selector on the Axe-Fx III (the cross-device rule has a real subject)');
  console.log('  drivers/knob-units: the cross-device and denylist checks have real catalog subjects');

  // ---- Case 8: end to end through blockParams() on the shipped FM3 profile ----------------------
  const fm3 = profileForModel(0x11);
  const amp = await blockParamsOf(fm3, 'amp');
  const brightcap = fm3.params['DISTORT']!.find((p) => p.name === 'DISTORT_BRIGHTCAP');
  assert(!!brightcap && brightcap.unit === 'pf', 'FM3 catalog still has DISTORT_BRIGHTCAP as a pf param');
  assert(amp.named.some((p) => p.id === brightcap!.paramId), "a 'pf' param shows up as a knob in blockParams()");
  const cab = await blockParamsOf(fm3, 'cab');
  const zoom = fm3.params['CABINET']!.find((p) => p.name === 'CABINET_ZOOM');
  assert(!!zoom && zoom.unit === 'enum' && fm3.ranges['CABINET']![zoom.paramId]?.kind === 'float', 'FM3 catalog still has CABINET_ZOOM as an enum-unit float-range param');
  assert(!cab.named.some((p) => p.id === zoom!.paramId), 'CABINET_ZOOM is not served as a knob (no fractional writes into a selector)');
  for (const [slug, name] of [['tentap', 'TENTAP_DECAYSTYLE'], ['reverb', 'REVERB_BASETYPE']] as const) {
    const pd = fm3.params[SLUG_FAMILY[slug]!]!.find((p) => p.name === name);
    assert(!!pd, `FM3 catalog still has ${name}`);
    const served = await blockParamsOf(fm3, slug);
    assert(!served.named.some((p) => p.id === pd!.paramId), `${name} is not served as a knob by blockParams()`);
  }
  console.log('  drivers/knob-units: blockParams() serves the pf knob and keeps CABINET_ZOOM, TENTAP_DECAYSTYLE and REVERB_BASETYPE out of the dials');

  // ---- Case 9: the generic response lists every classic dial, classified by the row and not by the unit ----
  // The classic rule (KNOB_UNITS + the provisional-unit vetting) decides which params are dials. The generic
  // response classifies by the device row first (a float row without labels is a dial: knob, or stepper when
  // its integral steps are detents), so it must list every classic dial under `named`, and never list an enum
  // row there.
  for (const dev of profs) {
    for (const slug of ['amp', 'cab', 'reverb', 'delay'] as const) {
      const family = SLUG_FAMILY[slug]!;
      const eid = eidOf(slug);
      const values = new Array<number>(dev.rangeSections[family]!.stride * 4).fill(0);
      const { driver } = mockBlockDevice(dev, { [eid]: { values, channel: 0 } });
      const classic = await driver.blockParams(eid);
      const generic = await driver.blockParams(eid, { generic: true });
      const genericNamed = new Set(generic.named.map((n) => n.id));
      for (const n of classic.named) assert(genericNamed.has(n.id), `${dev.key} ${slug} ${n.name} (pid ${n.id}): a classic dial is a generic dial too`);
      for (const n of generic.named) assertEqual(n.kind, 'float', `${dev.key} ${slug} ${n.name}: no enum row among the dials`);
      assert(generic.named.length >= classic.named.length, `${dev.key} ${slug}: the generic response lists at least the classic dials`);
    }
  }
  console.log('  drivers/knob-units: every classic dial of amp / cab / reverb / delay is a generic dial on FM3, FM9 and III; no enum row is');
  // ---- Case 10: units and tapers from the typecode rules (M3 §6.1): the classic dials are unchanged, the generic ----
  // response says where each unit and taper came from and fills a unit only where neither the device row nor the
  // catalog has one. A catalog unit is never replaced (the typecode units agree with every catalog unit that exists).
  const LABEL: Record<string, string> = { hz: 'Hz', db: 'dB', percent: '%' };
  const typecodeFills: Record<string, number> = {};
  for (const dev of profs) {
    let fills = 0;
    for (const slug of ['amp', 'cab', 'reverb', 'delay', 'drive', 'chorus', 'filter', 'peq'] as const) {
      const family = SLUG_FAMILY[slug]!;
      const eid = eidOf(slug);
      const values = new Array<number>(dev.rangeSections[family]!.stride * 4).fill(0);
      const { driver } = mockBlockDevice(dev, { [eid]: { values, channel: 0 } });
      const classic = await driver.blockParams(eid);
      const generic = await driver.blockParams(eid, { generic: true });
      const byId = new Map(generic.named.map((n) => [n.id, n] as const));
      for (const c of classic.named) {
        const where = `${dev.key} ${slug} ${c.name} (pid ${c.id})`;
        assert(!('unitSource' in c) && !('taperSource' in c), `${where}: the classic response carries no source fields`);
        const g = byId.get(c.id)!;
        const row = dev.ranges[family]![c.id]!;
        const catalogUnit = dev.params[family]!.find((d) => d.paramId === c.id)?.unit;
        // the classic unit and taper are what they always were: the row's unit, else the catalog code's label;
        // log only for an explicit log taper or (without one) a middle-nibble-4 typecode, on a positive range
        const wantLog = (row.taper ? row.taper === 'log' : ((row.typecode >> 4) & 0xf) === 4) && row.displayMin > 0;
        assertEqual(c.log === true, wantLog, `${where}: classic taper unchanged`);
        assertEqual(g.log === true, wantLog, `${where}: the generic response tapers the same`);
        if (c.unit !== undefined) {
          assertEqual(g.unit, c.unit, `${where}: a unit the catalog (or the row) has is served unchanged`);
          assertEqual(g.unitSource, 'catalog', `${where}: from the catalog`);
        } else {
          const tc = typecodeUnit(row.typecode);
          assertEqual(g.unit, tc ? LABEL[tc.unit] : undefined, `${where}: no catalog unit → the typecode's, if any`);
          assertEqual(g.unitSource, tc ? 'typecode' : undefined, `${where}: unitSource`);
          if (tc) fills++;
        }
        const tt = typecodeTaper(row.typecode);
        assertEqual(g.taperSource, row.taper ? 'catalog' : tt ? 'typecode' : undefined, `${where}: taperSource`);
        if (catalogUnit && LABEL[catalogUnit] && typecodeUnit(row.typecode)) {
          assertEqual(LABEL[typecodeUnit(row.typecode)!.unit], LABEL[catalogUnit], `${where}: the typecode unit agrees with the catalog unit`);
        }
      }
    }
    typecodeFills[dev.key] = fills;
    assert(fills > 0, `${dev.key}: the typecode rules fill at least one unit on these blocks (the case is not vacuous)`);
  }
  console.log(`  drivers/knob-units: typecode rules — classic units/tapers unchanged, generic unitSource/taperSource, units filled only where none exists (${Object.entries(typecodeFills).map(([k, n]) => `${k} ${n}`).join(', ')} on amp/cab/reverb/delay/drive/chorus/filter/peq)`);

  // ---- Case 11: a device row's own unit and taper win and are marked 'device' (synthetic live profile row) ----
  {
    const fm3 = profileForModel(0x11);
    const family = 'CHORUS';
    const eid = eidOf('chorus');
    const knob = knobParams(fm3, family).find((p) => {
      const r = fm3.ranges[family]![p.paramId]!;
      return !r.taper && !r.unit && r.displayMin > 0;
    });
    assert(knob !== undefined, 'premise: an FM3 chorus knob with a positive range and no explicit taper or row unit');
    const row = fm3.ranges[family]![knob.paramId]!;
    const built = catalogBuilt(0x11, 'live');
    (built.ranges[family] as Record<number, typeof row>)[knob.paramId] = { ...row, unit: 'ms', taper: 'log' };
    const live = runtimeProfileFrom(built, fm3);
    const values = new Array<number>(live.rangeSections[family]!.stride * 4).fill(0);
    const { driver } = mockBlockDevice(live, { [eid]: { values, channel: 0 } });
    const g = (await driver.blockParams(eid, { generic: true })).named.find((n) => n.id === knob.paramId)!;
    assertEqual(`${g.unit}/${g.unitSource}/${g.log === true}/${g.taperSource}`, 'ms/device/true/device', 'the device row\'s unit and log taper are served as device facts');
    const c = (await driver.blockParams(eid)).named.find((n) => n.id === knob.paramId)!;
    assertEqual(`${c.unit}/${c.log === true}`, 'ms/true', 'the classic response uses the device row too (as before)');
    // a row of the bundled catalog with an explicit taper (FM9 / III capture tapers) is a catalog fact
    const fm9 = profileForModel(0x12);
    const tapered = Object.entries(fm9.ranges.DISTORT ?? {}).find(([pid, r]) => r.kind === 'float' && r.taper === 'log' && r.displayMin > 0 && knobParams(fm9, 'DISTORT').some((p) => p.paramId === Number(pid)));
    assert(tapered !== undefined, 'premise: an FM9 amp knob with an explicit log taper in the catalog');
    const v9 = new Array<number>(fm9.rangeSections.DISTORT!.stride * 4).fill(0);
    const g9 = (await mockBlockDevice(fm9, { [eidOf('amp')]: { values: v9, channel: 0 } }).driver.blockParams(eidOf('amp'), { generic: true })).named.find((n) => n.id === Number(tapered[0]))!;
    assertEqual(`${g9.log === true}/${g9.taperSource}`, 'true/catalog', 'an explicit catalog taper is a catalog fact');
  }
  console.log("  drivers/knob-units: a device row's unit and taper are served as 'device', an explicit catalog taper as 'catalog'");
}

