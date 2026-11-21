// Float-row selectors on gen-3 blocks: the Axe-Fx III's `*_GLOBALMIX` toggles.
//
// The codec reports a param that carries a device label list under unit 'enum'. Thirteen III global-mix
// toggles (OFF / ON over a 0..1 FLOAT range row) therefore stopped being knobs (the knob rule needs a
// continuous unit) while the enum list only looked at enum-KIND rows: they listed nowhere and the block
// editor lost the control. enumParams() now also admits them, as a deliberately narrow class (see
// FLOAT_ROW_SELECTOR_NAME in gen3.ts) so that no other param changes category.
//
// The suite pins:
//   • the admission rule on a synthetic family (unit, class name, float row, integral span == label count,
//     one entry per wire paramId, type and bypass exclusions, enum-kind rows untouched);
//   • per device (FM3 / FM9 / Axe-Fx III), against the pre-change enum rule restated independently here:
//     the enum list differs from it by exactly the III's 13 global-mix toggles (none on FM3 / FM9), no
//     enum is a knob, the numeric global-mix rows (no label list) are still knobs, and the labelled
//     float rows that were never shown (KILLDRY, IR processing, CABINET_ZOOM ...) are still hidden;
//   • end to end through blockParams() on the shipped III profile: the toggle is served as an enum with the
//     device's OFF / ON labels (not as a knob), reads 0 / 1 and a 16-bit-scaled 65534 as ON, and its write
//     is the discrete SET (sub 09 00, float32(ordinal)) the codec builds for a labelled param.
// Mocked transport, no hardware.
import { createGen3Driver, enumParams, knobParams } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { SLUG_FAMILY, profileForModel } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

export const FLOAT_ROW_SELECTORS_CASE_COUNT = 6;

const AXE3 = 0x10;
const FM3 = 0x11;
const FM9 = 0x12;

/** The 13 III global-mix toggles that carry the device's OFF / ON list (family -> one param name per wire id). */
const III_TOGGLES: Record<string, string> = {
  PEQ: 'PEQ_GLOBALMIX', REVERB: 'REVERB_GLOBALMIX', DELAY: 'DELAY_GLOBALMIX', MULTITAP: 'MULTITAP_GLOBALMIX',
  CHORUS: 'CHORUS_GLOBALMIX', FLANGER: 'FLANGER_GLOBALMIX', ROTARY: 'ROTARY_GLOBALMIX', PHASER: 'PHASER_GLOBALMIX',
  FORMANT: 'FORMANT_GLOBALMIX', PITCH: 'PITCH_GLOBALMIX', SYNTH: 'SYNTH_GLOBALMIX', VOCODER: 'VOCODER_GLOBALMIX',
  MEGATAP: 'MEGATAP_GLOBALMIX',
};
/** Global-mix rows the III ships WITHOUT a label list: numeric 0..1 dials. They stay knobs. */
const III_NUMERIC_MIX = ['PLEX_GLOBALMIX', 'FDBKRET_GLOBALMIX', 'RINGMOD_GLOBALMIX', 'TENTAP_GLOBALMIX', 'RESONATOR_GLOBALMIX'];

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

/** A driver on a mocked III whose block bulk read answers `values` (paramId -> raw) for the `slug` block. */
function driverWith(profile: DeviceProfile, slug: string, raw: Record<number, number>) {
  const eid = eidOf(slug);
  const family = SLUG_FAMILY[slug]!;
  const stride = profile.rangeSections[family]!.stride;
  const codec = createModernFractalCodec(profile.model);
  const values = new Array<number>(stride * 4).fill(0);
  for (const [pid, v] of Object.entries(raw)) values[Number(pid)] = v;
  const bulk = blockBulkFrames(profile.model, eid, values);
  const mock = new MockTransport('serial', 'mock-float-row-selectors');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return { driver, mock, eid, codec };
}

type Rng = { kind: 'float' | 'enum'; displayMin: number; displayMax: number; typecode: number; step?: number };
const rng = (kind: 'float' | 'enum', lo = 0, hi = 1): Rng => ({ kind, displayMin: lo, displayMax: hi, typecode: 0 });

/** One family 'TEST' of single-rule params. Labels: pid 0..3, 9 and 10 carry a 2-entry OFF/ON list. */
function synth(): DeviceProfile {
  return {
    model: AXE3, key: 'axe3', name: 'Axe3-float-row-test', rows: 6, cols: 14,
    defaultInstances: 1, instanceLimits: {},
    params: {
      TEST: [
        { paramId: 0, name: 'TEST_GLOBALMIX', unit: 'enum' }, // the class: 'enum' unit, float 0..1, 2 labels
        { paramId: 1, name: 'TEST_KILLDRY', unit: 'enum' }, // same shape, not in the class
        { paramId: 2, name: 'TEST_PERCENT_GLOBALMIX', unit: 'percent' }, // class name but a continuous unit
        { paramId: 3, name: 'TEST_BADCOUNT_GLOBALMIX', unit: 'enum' }, // 0..2 with 2 labels: not an exact cover
        { paramId: 4, name: 'TEST_NOLABELS_GLOBALMIX', unit: 'enum' }, // no label list at all
        { paramId: 5, name: 'TEST_FRACTION_GLOBALMIX', unit: 'enum' }, // non-integral bounds
        { paramId: 6, name: 'TEST_STUB_GLOBALMIX', unit: 'enum' }, // 0..0 placeholder row
        { paramId: 7, name: 'TEST_ENUMROW', unit: 'enum' }, // a plain enum-kind row
        { paramId: 8, name: 'TEST_ENUMSTUB', unit: 'enum' }, // enum-kind row with no span
        { paramId: 9, name: 'TEST_DUP_GLOBALMIX', unit: 'enum' }, // first of a duplicate wire id
        { paramId: 9, name: 'TEST_OLD_DUP_GLOBALMIX', unit: 'enum' }, // same wire id again: one entry only
        { paramId: 10, name: 'TEST_TYPE_GLOBALMIX', unit: 'enum' }, // the family type selector id: excluded
        { paramId: 11, name: 'TEST_BYPASS_GLOBALMIX', unit: 'enum', displayLabel: 'Bypass' }, // the bypass flag: excluded
        { paramId: 12, name: 'TEST_NOROW_GLOBALMIX', unit: 'enum' }, // no range row at all
      ],
    },
    ranges: {
      TEST: {
        0: rng('float', 0, 1), 1: rng('float', 0, 1), 2: rng('float', 0, 1), 3: rng('float', 0, 2), 4: rng('float', 0, 1),
        5: rng('float', 0, 1.5), 6: rng('float', 0, 0), 7: rng('enum', 0, 3), 8: rng('enum', 0, 0), 9: rng('float', 0, 1),
        10: rng('float', 0, 1), 11: rng('float', 0, 1),
      },
    },
    rangeSections: {},
    rosterFor: () => [],
    enumLabelsFor: (family: string, paramId: number) =>
      family === 'TEST' && [0, 1, 2, 3, 5, 6, 9, 10, 11, 12].includes(paramId) ? ['OFF', 'ON'] : undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

/** The enum rule BEFORE float-row selectors existed, restated independently of the implementation: an
 *  enum-KIND range row with a usable span, minus the family type selector and the bypass flag. */
function legacyEnumNames(profile: DeviceProfile, family: string, typeId?: number): string[] {
  return (profile.params[family] ?? [])
    .filter((p) => {
      const range = profile.ranges[family]?.[p.paramId];
      if (range?.kind !== 'enum' || p.paramId === typeId) return false;
      if (range.displayMax <= range.displayMin) return false;
      return !/^bypass$/i.test(p.displayLabel ?? p.name);
    })
    .map((p) => p.name);
}

export async function runFloatRowSelectorsTests(): Promise<void> {
  // ---- Case 1: the admission rule on a synthetic family ----------------------------------------
  const prof = synth();
  assertEqual(
    enumParams(prof, 'TEST', 10).map((p) => p.name).join(','),
    'TEST_GLOBALMIX,TEST_ENUMROW,TEST_DUP_GLOBALMIX',
    'enum selection on the synthetic family (type id 10 excluded)',
  );
  assertEqual(
    enumParams(prof, 'TEST').map((p) => p.name).join(','),
    'TEST_GLOBALMIX,TEST_ENUMROW,TEST_DUP_GLOBALMIX,TEST_TYPE_GLOBALMIX',
    'without a type id the type-id row is a plain float-row selector',
  );
  assertEqual(knobParams(prof, 'TEST').some((p) => p.unit === 'enum'), false, 'an enum-unit float-row selector is never a knob');
  assertEqual(
    knobParams(prof, 'TEST').map((p) => p.name).join(','),
    'TEST_PERCENT_GLOBALMIX',
    'the class name on a continuous unit stays a knob, not an enum',
  );
  console.log('  drivers/float-row-selectors: admission rule (enum unit, class name, float row, label list == integral span, one per wire id, type/bypass out, enum rows as before)');

  // ---- Cases 2-5: per device, against the shipped catalogs -------------------------------------
  const iii = profileForModel(AXE3);
  const fm3 = profileForModel(FM3);
  const fm9 = profileForModel(FM9);

  // ---- Case 2: the III lists exactly the 13 global-mix toggles on top of the pre-change rule ----
  const extraByDevice: Record<string, string[]> = {};
  for (const dev of [iii, fm3, fm9]) {
    const extra: string[] = [];
    for (const family of Object.keys(dev.params)) {
      const now = enumParams(dev, family).map((p) => p.name);
      const before = legacyEnumNames(dev, family);
      // The pre-change list stays whole and in order; only float-row selectors may be appended in between.
      let at = 0;
      for (const name of before) {
        const i = now.indexOf(name, at);
        assert(i >= 0, `${dev.key} ${family}.${name}: an enum listed before is still listed, in order`);
        at = i + 1;
      }
      for (const name of now) if (!before.includes(name)) extra.push(`${family}.${name}`);
      // No enum is a knob, and the two lists never share a wire id (a knob wins nothing here).
      const knobIds = new Set(knobParams(dev, family).map((p) => p.paramId));
      for (const p of enumParams(dev, family)) {
        assert(!knobIds.has(p.paramId), `${dev.key} ${family}.${p.name}: a param is a knob or an enum, never both`);
      }
    }
    extraByDevice[dev.key] = extra;
  }
  assertEqual(
    [...extraByDevice['axe3']!].sort().join(','),
    Object.entries(III_TOGGLES).map(([f, n]) => `${f}.${n}`).sort().join(','),
    'the III gains exactly the 13 global-mix toggles',
  );
  assertEqual(extraByDevice['fm3']!.length, 0, 'FM3: the enum list is exactly the pre-change one');
  assertEqual(extraByDevice['fm9']!.length, 0, 'FM9: the enum list is exactly the pre-change one');
  console.log(`  drivers/float-row-selectors: enum list vs the pre-change rule: axe3 +${extraByDevice['axe3']!.length} (global-mix toggles), fm3 +0, fm9 +0`);

  // ---- Case 3: the numeric global-mix dials stay dials; the old duplicate does not double the toggle
  for (const name of III_NUMERIC_MIX) {
    const family = name.split('_')[0]!;
    assert(knobParams(iii, family).some((p) => p.name === name), `III ${name} (no label list, numeric 0..1) is still a knob`);
    assert(!enumParams(iii, family).some((p) => p.name === name), `III ${name} is not an enum`);
  }
  const flanger = enumParams(iii, 'FLANGER').filter((p) => /GLOBALMIX$/.test(p.name));
  assertEqual(flanger.length, 1, 'FLANGER_GLOBALMIX and FLANGER_OLD_GLOBALMIX share wire id 15: one control');
  assertEqual(flanger[0]!.name, 'FLANGER_GLOBALMIX', 'the first catalog row of a shared wire id wins');
  console.log('  drivers/float-row-selectors: numeric global-mix rows stay knobs; the shared FLANGER wire id lists once');

  // ---- Case 4: the class is narrow: labelled float rows that were never shown stay hidden -------
  const hidden: [DeviceProfile, string, string][] = [
    [iii, 'REVERB', 'REVERB_KILLDRY'], [iii, 'DELAY', 'DELAY_KILLDRY'], [iii, 'GLOBAL', 'GLOBAL_IRCAPTURE_PROCESS'],
    [iii, 'GLOBAL', 'GLOBAL_DISPLAY_OFFSET'], [fm9, 'CABINET', 'CABINET_ZOOM'],
  ];
  for (const [dev, family, name] of hidden) {
    const p = dev.params[family]?.find((q) => q.name === name);
    assert(!!p, `${dev.key} still has ${name} in its catalog (the check is not vacuous)`);
    assert(!enumParams(dev, family).some((q) => q.name === name), `${dev.key} ${name} stays out of the enum list (a wider class is a separate decision)`);
    assert(!knobParams(dev, family).some((q) => q.name === name), `${dev.key} ${name} stays out of the knobs`);
  }
  console.log('  drivers/float-row-selectors: KILLDRY, IR processing, DISPLAY_OFFSET and CABINET_ZOOM stay hidden');

  // ---- Case 5: end to end on the III, REVERB_GLOBALMIX: enum with OFF / ON, not a knob ----------
  const reverbToggle = iii.params['REVERB']!.find((p) => p.name === 'REVERB_GLOBALMIX')!;
  const pid = reverbToggle.paramId;
  for (const [raw, want] of [[0, 0], [1, 1], [65534, 1], [20000, 0], [40000, 1]] as const) {
    const { driver } = driverWith(iii, 'reverb', { [pid]: raw });
    const served = await driver.blockParams(eidOf('reverb'));
    const e = served.enums.find((x) => x.id === pid);
    assert(!!e, 'REVERB_GLOBALMIX is served in enums[]');
    assertEqual(e!.value, want, `REVERB_GLOBALMIX raw ${raw} reads as ordinal ${want}`);
    assertEqual(JSON.stringify(e!.options), JSON.stringify([{ value: 0, label: 'OFF' }, { value: 1, label: 'ON' }]), 'options carry the device OFF / ON labels');
    assert(!served.named.some((n) => n.id === pid), 'REVERB_GLOBALMIX is not served as a knob');
  }
  {
    const { driver } = driverWith(iii, 'flanger', {});
    const served = await driver.blockParams(eidOf('flanger'));
    assertEqual(served.enums.filter((x) => x.id === 15 && /GLOBALMIX/i.test(x.name)).length, 1, 'the FLANGER toggle is served once');
  }
  console.log('  drivers/float-row-selectors: blockParams() serves REVERB_GLOBALMIX as an OFF/ON enum (0 / 1 / 16-bit-scaled values), not a knob');

  // ---- Case 6: the write is the discrete SET the codec builds for a labelled param ---------------
  {
    const { driver, mock, eid, codec } = driverWith(iii, 'reverb', {});
    mock.sent.length = 0;
    await driver.setParam(eid, pid, 1, false);
    assertEqual(mock.sent.length, 1, 'one frame written');
    const frame = mock.sent[0]!;
    assertEqual(compactHex(frame), compactHex(codec.buildSetParameter(eid, pid, 1)), 'the write is buildSetParameter(eid, pid, ordinal)');
    assertEqual(`${frame[6]!.toString(16).padStart(2, '0')}${frame[7]!.toString(16).padStart(2, '0')}`, '0900', 'discrete sub-action 09 00 (not the continuous 52 00)');
  }
  console.log('  drivers/float-row-selectors: the toggle writes as the discrete SET (sub 09 00, float32(ordinal))');
}
