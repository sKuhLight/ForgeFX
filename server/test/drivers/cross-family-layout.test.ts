// Layout controls that address another block (FORGEFX-48, M3 WP-F7): the generic response (`?generic=1`) binds a
// cross-block reference (`control.crossBlock`) through the REFERENCED family — its catalog name follows the
// referenced family's own param index (`namedAt`: moved → new pid + `movedFrom`, dropped → `unbound`) — and stamps
// the effect id of the block that owns it (`crossBlock.effectId`) from the device's own effect-id table, bounded by
// the device's instance count; modifier slots, preset-level data and unknown families get null. The classic response
// serves the editor layout as it is.
//
// Committed catalog data and synthetic data only (the newer-firmware profile of test/helpers/newerFirmware.ts, a
// synthetic reference into ROTARY), mocked FM3 / FM9 / Axe-Fx III.
import '../helpers/env.js';
import { PROFILES, runtimeProfileFrom, type DeviceLayout, type DeviceLayoutControl, type DeviceProfile, type ProfileFacts } from '../../src/devices.js';
import type { BlockParamsV2DTO } from '../../src/drivers/types.js';
import { profileCatalogFor } from '../../src/profileCatalog.js';
import type { RangeDef as CodecRangeDef } from 'forgefx-midi/cache';
import { mockBlockDevice, eidOfSlug } from '../helpers/blockRead.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { NEWER_FIRMWARE, UNUSED_SLOT, catalogPid, newerFirmwareBuilt } from '../helpers/newerFirmware.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const CROSS_FAMILY_LAYOUT_CASE_COUNT = 8;

const FM3 = PROFILES[0x11]!;
const FM9 = PROFILES[0x12]!;
const AXE3 = PROFILES[0x10]!;

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const controlsOf = (l: DeviceLayout | undefined): DeviceLayoutControl[] =>
  (l?.pages ?? []).flatMap((p) => p.rows.flatMap((r) => r.controls));

/** The generic and the classic response of `eid` (family `family`) on `profile`, its body all zeros. */
async function served(profile: DeviceProfile, eid: number, family: string): Promise<{ generic: BlockParamsV2DTO; classic: Awaited<ReturnType<ReturnType<typeof mockBlockDevice>['driver']['blockParams']>> ; sent: () => number }> {
  const stride = profile.rangeSections[family]?.stride ?? 64;
  const channels = eid >= 37 && eid < 190 ? 4 : 1;
  const { driver, mock } = mockBlockDevice(profile, { [eid]: { values: new Array<number>(stride * channels).fill(0), channel: 0 } });
  const generic = (await driver.blockParams(eid, { generic: true })) as BlockParamsV2DTO;
  const classic = await driver.blockParams(eid);
  return { generic, classic, sent: () => mock.sent.length };
}

/** A profile whose layout of `family` is `layout` (everything else as `base`). */
const withLayout = (base: DeviceProfile, family: string, layout: DeviceLayout): DeviceProfile => ({
  ...base,
  layoutFor: (fam, typeValue, selectors, firmware) => (fam === family ? layout : base.layoutFor(fam, typeValue, selectors, firmware)),
});

const ctl = (label: string, paramName: string | null, paramId: number | null, crossBlock?: DeviceLayoutControl['crossBlock'], widget: DeviceLayoutControl['widget'] = 'knob'): DeviceLayoutControl =>
  ({ label, paramName, paramId, widget, rawWidget: widget, ...(crossBlock ? { crossBlock } : {}) });

const show = (c: DeviceLayoutControl): string =>
  `${c.label}:${c.paramId}${c.movedFrom !== undefined ? `<${c.movedFrom}` : ''}${c.unbound ? ':unbound' : ''}`
  + (c.crossBlock ? `@${c.crossBlock.family}:${c.crossBlock.paramId}#${c.crossBlock.effectId === undefined ? 'none' : c.crossBlock.effectId}` : '');

export async function runCrossFamilyLayoutTests(): Promise<void> {
  const ROTARY_EID = eidOfSlug('rotary');
  const COMP_EID = eidOfSlug('comp');
  const CHORUS_EID = eidOfSlug('chorus');
  const OUTPUT_EID = eidOfSlug('output');
  const AMP_EID = eidOfSlug('amp');

  // ---- 1. real layouts: Controllers and Foot Controller references, FM3 and Axe-Fx III --------------------------
  for (const p of [FM3, AXE3]) {
    const { generic, classic } = await served(p, 2, 'CONTROLLERS');
    const refs = controlsOf(generic.layout).filter((c) => c.crossBlock);
    const global = refs.filter((c) => c.crossBlock!.family === 'GLOBAL');
    assert(global.length > 0, `${p.key}: premise: the Controllers layout references GLOBAL params (metronome)`);
    for (const c of global) {
      const pid = p.params.GLOBAL!.find((d) => d.name === c.crossBlock!.paramName)!.paramId;
      assertEqual(`${c.crossBlock!.effectId}/${c.paramId}/${c.crossBlock!.paramId}`, `1/${pid}/${pid}`, `${p.key}: ${c.crossBlock!.paramName} addresses GLOBAL (effect id 1) at its GLOBAL pid`);
    }
    const preset = refs.filter((c) => c.crossBlock!.family === 'PRESET');
    const mod = refs.filter((c) => c.crossBlock!.family === 'MOD');
    assert(preset.length > 0 && mod.length > 0, `${p.key}: premise: preset-level and modifier references exist`);
    assert([...preset, ...mod].every((c) => c.crossBlock!.effectId === null), `${p.key}: PRESET and MOD references have no effect id (null)`);
    assert(refs.every((c) => c.crossBlock!.effectId !== undefined), `${p.key}: every reference carries effectId`);
    // the classic response serves the editor layout as it is: no effect id, no rebinding
    const text = JSON.stringify(classic.layout);
    assert(!text.includes('effectId') && !text.includes('movedFrom') && !text.includes('unbound'), `${p.key}: the classic Controllers layout is untouched`);

    const fc = await served(p, 199, 'FC');
    const fcRefs = controlsOf(fc.generic.layout).filter((c) => c.crossBlock);
    assert(fcRefs.some((c) => c.crossBlock!.family === 'FC'), `${p.key}: premise: the FC layout references the FC block`);
    for (const c of fcRefs) {
      assertEqual(c.crossBlock!.effectId, c.crossBlock!.family === 'FC' ? 199 : c.crossBlock!.family === 'GLOBAL' ? 1 : null, `${p.key}: FC page ${c.crossBlock!.effect} → its owning block`);
    }
  }
  console.log('  drivers/cross-family-layout: Controllers / FC pages — GLOBAL refs → effect id 1 at the GLOBAL pid, FC → 199, PRESET and MOD → null; classic layout untouched (FM3, III)');

  // ---- 2. the Output leveling panel: own family at another instance, and the amp level (FM3 / FM9 / III) ---------
  for (const [p, amps] of [[FM3, ['ID_DISTORT1:58']], [FM9, ['ID_DISTORT1:58', 'ID_DISTORT2:59']], [AXE3, ['ID_DISTORT1:58', 'ID_DISTORT2:59']]] as const) {
    const panel = p.layoutFor('OUTPUT', 1)!;
    assertEqual(panel.variantName, 'LevelingPanel', `${p.key}: premise: the Output leveling panel variant`);
    const { generic } = await served(withLayout(p, 'OUTPUT', panel), OUTPUT_EID + 1, 'OUTPUT'); // the SECOND output is open
    const refs = controlsOf(generic.layout).filter((c) => c.crossBlock);
    const byToken = new Map<string, Set<number | null | undefined>>();
    for (const c of refs) (byToken.get(c.crossBlock!.effect) ?? byToken.set(c.crossBlock!.effect, new Set()).get(c.crossBlock!.effect)!).add(c.crossBlock!.effectId);
    assertEqual(JSON.stringify([...byToken.get('ID_OUTPUT1')!]), JSON.stringify([OUTPUT_EID]), `${p.key}: ID_OUTPUT1 → the first output, also while the second one is open`);
    assertEqual(JSON.stringify([...byToken.get('ID_OUTPUT2')!]), JSON.stringify([OUTPUT_EID + 1]), `${p.key}: ID_OUTPUT2 → the second output`);
    for (const a of amps) {
      const [token, eid] = a.split(':');
      const c = refs.find((x) => x.crossBlock!.effect === token)!;
      const levelPid = p.params.DISTORT!.find((d) => d.name === 'DISTORT_LEVEL')!.paramId;
      assertEqual(`${c.crossBlock!.effectId}/${c.crossBlock!.paramName}/${c.paramId}`, `${eid}/DISTORT_LEVEL/${levelPid}`, `${p.key}: ${token} ("Amp Level") → amp ${eid}, DISTORT_LEVEL`);
    }
  }
  assertEqual(AMP_EID, 58, 'premise: the first amp is effect id 58');
  console.log('  drivers/cross-family-layout: Output leveling panel — ID_OUTPUT1/2 → 42/43 whichever output is open, Amp Level → amp 58 (and 59 where a second amp exists: FM9, III)');

  // ---- 3. instances are bounded by the device, each device resolves over its own table --------------------------
  const tokens: Array<[string, string]> = [
    ['ID_OUTPUT2', 'OUTPUT'], ['ID_OUTPUT3', 'OUTPUT'], ['ID_OUTPUT4', 'OUTPUT'], ['ID_OUTPUT5', 'OUTPUT'],
    ['ID_DISTORT2', 'DISTORT'], ['ID_ROTARY2', 'ROTARY'], ['ID_ROTARY3', 'ROTARY'], ['ID_GLOBAL', 'GLOBAL'], ['ID_FOOTCONTROLLER', 'FC'],
    ['ID_MODIFIER3', 'MOD'], ['ID_PRESET_FC', 'PRESET'], ['ID_NOTHING', ''], ['bogus', 'OUTPUT'],
  ];
  const probe: DeviceLayout = {
    editorName: 'Chorus', family: 'CHORUS', variantName: 'probe', variantValue: null,
    pages: [{ name: 'p', rows: [{ section: 'parameters', controls: tokens.map(([effect, family]) => ctl(effect, null, null, { effect, family: family || null, paramName: null, paramId: null }, 'label')) }] }],
  };
  const want: Record<string, string> = {
    // FM3: 2 outputs, 1 amp, 2 rotaries; FM9: 3 outputs, 2 amps; III: 4 outputs (its roster span), 2 amps
    fm3: `43,null,null,null,null,${ROTARY_EID + 1},null,1,199,null,null,null,null`,
    fm9: `43,44,null,null,59,${ROTARY_EID + 1},null,1,199,null,null,null,null`,
    axe3: `43,44,45,null,59,${ROTARY_EID + 1},null,1,199,null,null,null,null`,
  };
  assertEqual(OUTPUT_EID, 42, 'premise: the first output is effect id 42');
  for (const p of [FM3, FM9, AXE3]) {
    const { generic } = await served(withLayout(p, 'CHORUS', probe), CHORUS_EID, 'CHORUS');
    assertEqual(controlsOf(generic.layout).map((c) => String(c.crossBlock!.effectId)).join(','), want[p.key], `${p.key}: owning effect ids over the device's own table and instance counts`);
  }
  console.log('  drivers/cross-family-layout: instance > 1 bounded per device (FM3 2 outputs / 1 amp, FM9 3 / 2, III 4 = roster span), MOD / PRESET / unknown family / malformed token → null');

  // ---- 4. a family the static table gives no effect id, bound `confirmed` by the profile's block map ------------
  {
    assertEqual(profileCatalogFor(0x10).familyFirstEid!.DYNDIST, null, 'premise: the III table gives DYNDIST no effect id');
    const exact = runtimeProfileFrom(catalogBuilt(0x10), AXE3);
    const facts = exact.profileFacts!;
    const bound: DeviceProfile = {
      ...exact,
      familyForEffectId: (eid) => (eid === 230 || eid === 231 ? 'DYNDIST' : exact.familyForEffectId(eid)),
      profileFacts: { ...facts, confirmedBlocks: new Set([...facts.confirmedBlocks, 230, 231]) } as ProfileFacts,
    };
    const dyn: DeviceLayout = {
      ...probe, pages: [{ name: 'p', rows: [{ section: 'parameters', controls: ['ID_DYNDIST1', 'ID_DYNDIST2', 'ID_DYNDIST3'].map((effect) => ctl(effect, null, null, { effect, family: 'DYNDIST', paramName: null, paramId: null }, 'label')) }] }],
    };
    const eids = async (p: DeviceProfile) => controlsOf((await served(withLayout(p, 'CHORUS', dyn), CHORUS_EID, 'CHORUS')).generic.layout).map((c) => String(c.crossBlock!.effectId)).join(',');
    assertEqual(await eids(bound), '230,231,null', 'a confirmed block-map family: first id = its lowest bound id, instances = the run of bound ids');
    assertEqual(await eids(exact), 'null,null,null', 'without the binding the family has no effect id');
  }
  console.log('  drivers/cross-family-layout: a family only the block map binds (confirmed) resolves to its bound ids; unbound → null');

  // ---- 5. FORGEFX-48: a reference into another family follows THAT family's names (newer-firmware ROTARY shift) ---
  {
    const { inserted, dropped } = NEWER_FIRMWARE;
    assertEqual(inserted.family, 'ROTARY', 'premise: the newer firmware inserts a row into ROTARY');
    const moved = inserted.movedNames[1]!; // ROTARY_DRIVE
    const other = inserted.movedNames[0]!; // ROTARY_SPREAD
    const movedPid = catalogPid('ROTARY', moved);
    const otherPid = catalogPid('ROTARY', other);
    const still = FM3.params.ROTARY!.find((d) => d.paramId < inserted.at && FM3.ranges.ROTARY![d.paramId] && FM3.ranges.ROTARY![d.paramId]!.displayMin !== FM3.ranges.ROTARY![d.paramId]!.displayMax)!;
    const sustain = catalogPid(dropped.family, dropped.name);
    const ref = (effect: string, family: string, name: string, pid: number) => ctl(name, name, pid, { effect, family, paramName: name, paramId: pid });
    const layout: DeviceLayout = {
      editorName: 'Chorus', family: 'CHORUS', variantName: 'probe', variantValue: null,
      pages: [{ name: 'p', rows: [{ section: 'parameters', controls: [
        ref('ID_ROTARY1', 'ROTARY', moved, movedPid),
        ref('ID_ROTARY2', 'ROTARY', other, otherPid),
        ref('ID_ROTARY1', 'ROTARY', still.name, still.paramId),
        ref('ID_COMP1', 'COMP', dropped.name, sustain),
        { ...ref('ID_COMP1', 'COMP', dropped.name, sustain), label: 'meter', widget: 'meter', rawWidget: 'meter' },
        ref('ID_ROTARY1', 'ROTARY', moved, movedPid + 40), // names the param at a pid that is not its catalog pid
      ] }] }],
    };
    const before = JSON.stringify(layout);
    const newer = runtimeProfileFrom(newerFirmwareBuilt(), FM3);
    const { generic, classic } = await served(withLayout(newer, 'CHORUS', layout), CHORUS_EID, 'CHORUS');
    assertEqual(controlsOf(generic.layout).map(show).join(' '), [
      `${moved}:${movedPid + 1}<${movedPid}@ROTARY:${movedPid + 1}#${ROTARY_EID}`,
      `${other}:${otherPid + 1}<${otherPid}@ROTARY:${otherPid + 1}#${ROTARY_EID + 1}`,
      `${still.name}:${still.paramId}@ROTARY:${still.paramId}#${ROTARY_EID}`,
      `${dropped.name}:${sustain}:unbound@COMP:${sustain}#${COMP_EID}`,
      `meter:${sustain}@COMP:${sustain}#${COMP_EID}`,
      `${moved}:${movedPid + 40}@ROTARY:${movedPid + 40}#${ROTARY_EID}`,
    ].join(' '), 'moved names follow the referenced family\'s rows (movedFrom), a dropped one is unbound (not the meter), a pid mismatch keeps its binding');
    assertEqual(JSON.stringify(classic.layout), before, 'the classic response serves the layout byte for byte');
    assertEqual(JSON.stringify(layout), before, 'the served layout object is never modified (the generic one is a copy)');
    // on the bundled catalog nothing moved: only the effect ids are added
    const plain = await served(withLayout(FM3, 'CHORUS', layout), CHORUS_EID, 'CHORUS');
    assert(controlsOf(plain.generic.layout).every((c) => c.movedFrom === undefined && !c.unbound && typeof c.crossBlock!.effectId === 'number'), 'catalog: nothing moved or unbound, every reference addressed');
  }
  console.log('  drivers/cross-family-layout: FORGEFX-48 — a reference into ROTARY follows the newer firmware\'s shift (pid + movedFrom + crossBlock.paramId), a dropped COMP name is unbound (meters stay bound); classic layout byte-identical, nothing mutated');

  // ---- 6. GLOBAL references: addressed as effect id 1, under the existing write guard of that address -----------
  {
    const name = 'GLOBAL_METLEVEL1';
    const pid = FM3.params.GLOBAL!.find((d) => d.name === name)!.paramId;
    const b = catalogBuilt(0x11);
    (b.ranges.GLOBAL as Record<number, CodecRangeDef>)[pid] = { ...UNUSED_SLOT };
    // an id the catalog defines no GLOBAL param at, an unused slot on this firmware
    const catalogIds = new Set(FM3.params.GLOBAL!.map((d) => d.paramId));
    let slot = 0;
    while (catalogIds.has(slot)) slot++;
    (b.ranges.GLOBAL as Record<number, CodecRangeDef>)[slot] = { ...UNUSED_SLOT };
    const exact = runtimeProfileFrom(b, FM3);
    const { generic } = await served(exact, 2, 'CONTROLLERS');
    const c = controlsOf(generic.layout).find((x) => x.crossBlock?.paramName === name);
    assert(c !== undefined, `premise: the Controllers layout serves ${name}`);
    assertEqual(`${c.crossBlock!.effectId}/${c.paramId}/${c.unbound === true}`, `1/${pid}/true`, `${name}: still addressed as GLOBAL, unbound once the device dropped its row`);
    assertEqual(generic.definitions.persistentWrites, false, 'premise: the Controllers block itself has no persistent writes');
    const { driver, mock } = mockBlockDevice(exact, {});
    const refused = async (eid: number, paramId: number): Promise<number | undefined> => {
      try { await driver.setParam(eid, paramId, 0.5, true); return undefined; } catch (e) { return (e as { statusCode?: number }).statusCode; }
    };
    assertEqual(await refused(1, 0xff06), 400, 'a pseudo id at effect id 1 is no wire parameter');
    assertEqual(await refused(1, slot), 409, 'an unused GLOBAL slot is refused at effect id 1');
    assertEqual(mock.sent.length, 0, 'nothing reaches the wire for a refused write');
    const g = await served(exact, 1, 'GLOBAL');
    assertEqual(g.generic.definitions.persistentWrites, true, 'the GLOBAL block the reference addresses declares its writes persistent');
  }
  console.log('  drivers/cross-family-layout: GLOBAL refs → effect id 1, unbound when the device dropped the row; writes at eid 1 keep its guards (400 pseudo id, 409 unused slot, nothing sent) and its persistentWrites');

  // ---- 7. the classic layout of every real block with references is the layout the profile resolves ------------
  for (const p of [FM3, FM9, AXE3]) {
    for (const [eid, family] of [[2, 'CONTROLLERS'], [199, 'FC']] as const) {
      const { classic } = await served(p, eid, family);
      assertEqual(JSON.stringify(classic.layout), JSON.stringify(p.layoutFor(family, undefined, () => undefined)), `${p.key} ${family}: the classic layout is the resolved editor layout`);
    }
  }
  console.log('  drivers/cross-family-layout: classic Controllers / FC layouts equal the resolved editor layout (FM3, FM9, III)');

  // ---- 8. the development hook that hides a catalog family: a reference into it addresses nothing ------------
  {
    const first = profileCatalogFor(0x11).familyFirstEid!;
    assertEqual(`${first.GLOBAL}/${first.FC}/${first.OUTPUT}/${first.ROTARY}`, `1/199/42/${ROTARY_EID}`, 'premise: the FM3 table');
    const layout: DeviceLayout = { ...probe, pages: [{ name: 'p', rows: [{ section: 'parameters', controls: [ctl('x', null, null, { effect: 'ID_ROTARY1', family: 'ROTARY', paramName: null, paramId: null }, 'label')] }] }] };
    const eid = async () => controlsOf((await served(withLayout(FM3, 'CHORUS', layout), CHORUS_EID, 'CHORUS')).generic.layout)[0]!.crossBlock!.effectId;
    assertEqual(await eid(), ROTARY_EID, 'a reference without a param still names its owning block');
    const warn = console.warn;
    console.warn = () => {};
    try {
      assertEqual(await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'ROTARY', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, eid), null, 'the hidden family has no effect id');
    } finally {
      console.warn = warn;
    }
    assertEqual(await eid(), ROTARY_EID, 'and has it again once the hook is off');
  }
  console.log('  drivers/cross-family-layout: the FM3 table is GLOBAL 1 / FC 199 / OUTPUT 42 / ROTARY 86; a family the development hook hides addresses nothing');
}
