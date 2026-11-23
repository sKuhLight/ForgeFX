// Read-only block visuals on the gen-3 block-params response (+ the capability flag and the stamped
// layout graph slots). Mocked transport, NO hardware — same idiom as float-row-selectors.test.ts.
//
// The suite pins:
//   • caps: `blockVisuals` is true on FM3 / FM9 / Axe-Fx III and false on AM4 / gen-1 / gen-2 / VP4, and it
//     is the LAST key of the extended matrix (additive-only DTO ordering);
//   • blockParams() on the shipped profiles serves `visuals` whose every role is the device's OWN paramId
//     and (monitor roles aside) one of the ids this very response serves, strictly narrowed to the block's
//     current layout variant (plus the Default variant's controls for an add-on variant that shares no page
//     name with it): FM3 COMP full curve / THRESH2-only and SUSTAIN-only gain reduction / Compander → none,
//     FM3 GATE ratio vs range-only, REVERB 'Pitch Shift'-only types keep decay, FM3 FILTER comb / envelope
//     / auto-wah get nothing they do not use, FM3 TREMOLO panner, FM9 DELAY without a layout, CONTROLLERS
//     lfo1/lfo2/adsr1/adsr2 with LFO 1's shape (its type is no longer taken for the block type);
//   • roster-less MULTITAP / PLEX pick their layout variant by the live <FAM>_BASETYPE selector;
//   • the served layouts carry `graphKey` on graph slots (gen-3 only; AM4 layouts stay unstamped);
//   • the HTTP route passes `visuals` through (GET /preset/blocks/:eid/params on the FM3 app).
import { createGen3Driver, blockVisualsFor } from '../../src/drivers/gen3.js';
import { createVp4Driver } from '../../src/drivers/vp4.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { SLUG_FAMILY, profileForModel, am4LayoutFor, type DeviceLayout, type DeviceProfile } from '../../src/devices.js';
import type { BlockVisualDTO, DriverCtx } from '../../src/drivers/types.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildTestApp } from '../helpers/api.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

export const BLOCK_VISUALS_CASE_COUNT = 13;

const AXE3 = 0x10;
const FM3 = 0x11;
const FM9 = 0x12;

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

const pidOf = (profile: DeviceProfile, family: string, name: string): number => {
  const p = profile.params[family]?.find((x) => x.name === name);
  if (!p) throw new Error(`${profile.key}: no ${name}`);
  return p.paramId;
};

/** Mocked bulk-read reply for one block: `raw` = paramId → raw wire value (channel A), everything else 0. */
function bulkReply(profile: DeviceProfile, eid: number, family: string, raw: Record<number, number>, channels: number) {
  const stride = profile.rangeSections[family]!.stride;
  const values = new Array<number>(stride * channels).fill(0);
  for (const [pid, v] of Object.entries(raw)) values[Number(pid)] = v;
  const codec = createModernFractalCodec(profile.model);
  const frames = blockBulkFrames(profile.model, eid, values);
  const poll = compactHex(codec.buildBlockBulkReadPoll(eid));
  return (req: readonly number[]) => (compactHex(req) === poll ? frames : []);
}

type ParamsResult = Awaited<ReturnType<ReturnType<typeof createGen3Driver>['blockParams']>>;

/** blockParams() of one block on a mocked unit. */
async function readBlock(model: number, eid: number, family: string, raw: Record<number, number>, channels = 4): Promise<ParamsResult> {
  const profile = profileForModel(model);
  const mock = new MockTransport('serial', `mock-block-visuals-${model}`);
  mock.isOpen = true;
  mock.reply = bulkReply(profile, eid, family, raw, channels);
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return driver.blockParams(eid);
}

const visual = (r: { visuals?: BlockVisualDTO[] }, key: string) => r.visuals?.find((v) => v.key === key);

/** Invariant: every non-monitor role is a param this response serves; every role id is the device's own. */
function checkServed(r: ParamsResult, profile: DeviceProfile, family: string, label: string): void {
  const served = new Set([...r.named.map((n) => n.id), ...r.enums.map((e) => e.id)]);
  const monitors = new Set(Object.values(profile.monitorParams ?? {}).filter((m) => m.family === family).map((m) => m.pid));
  const ownIds = new Set((profile.params[family] ?? []).map((p) => p.paramId));
  for (const v of r.visuals ?? []) {
    for (const [role, id] of Object.entries(v.roles)) {
      assert(ownIds.has(id!), `${label} ${v.key}.${role}: id ${id} is not in the device's ${family} catalog`);
      assert(served.has(id!) || monitors.has(id!), `${label} ${v.key}.${role}: id ${id} is neither served nor a monitor`);
    }
  }
}

/** Graph keys stamped on a layout's graph slots, as `page:key` (in page order). */
function stampedKeys(layout: DeviceLayout | undefined): string[] {
  const out: string[] = [];
  for (const p of layout?.pages ?? []) for (const r of p.rows) for (const c of r.controls) if (c.graphKey) out.push(`${p.name}:${c.graphKey}`);
  return out;
}

export async function runBlockVisualsTests(): Promise<void> {
  // ---- Case 1: caps flag per model, appended last in the extended matrix ----------------------
  for (const [model, want] of [[FM3, true], [FM9, true], [AXE3, true], [0x15, false], [0x01, false], [0x07, false]] as const) {
    const { app } = await buildTestApp(model);
    try {
      const res = await app.inject({ method: 'GET', url: '/device' });
      const caps = (res.json() as { capabilities: Record<string, unknown> }).capabilities;
      assertEqual(caps.blockVisuals, want, `0x${model.toString(16)} capabilities.blockVisuals`);
      const keys = Object.keys(caps);
      assertEqual(keys[keys.indexOf('virtualEffects') + 1], 'blockVisuals', `0x${model.toString(16)} blockVisuals directly after virtualEffects (end of the extended matrix)`);
    } finally {
      await app.close();
    }
  }
  const vp4Ctx: DriverCtx = { transport: async () => new MockTransport('serial', 'mock-vp4'), emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') };
  assertEqual(createVp4Driver(vp4Ctx).capabilities.blockVisuals, false, 'VP4 driver blockVisuals');
  console.log('  drivers/block-visuals: caps flag (FM3/FM9/III true; AM4/gen-1/gen-2/VP4 false; last extended key)');

  // ---- Case 2: FM3 COMP type 0 → full compressor curve, slot stamped --------------------------
  const fm3 = profileForModel(FM3);
  const compEid = eidOf('comp');
  const compTypePid = pidOf(fm3, 'COMP', 'COMP_TYPE');
  {
    const r = await readBlock(FM3, compEid, 'COMP', { [compTypePid]: 0 });
    const v = visual(r, 'dynamics');
    assert(v, 'FM3 COMP type 0: dynamics visual served');
    assertEqual(v.title, 'Compressor curve', 'FM3 COMP type 0 title');
    assertEqual(v.mode, 'compressor', 'FM3 COMP type 0 mode');
    assertEqual(v.roles.threshold, pidOf(fm3, 'COMP', 'COMP_THRESH'), 'FM3 threshold id');
    assertEqual(v.roles.ratio, pidOf(fm3, 'COMP', 'COMP_RATIO'), 'FM3 ratio id');
    assertEqual(v.roles.knee, pidOf(fm3, 'COMP', 'COMP_KNEE'), 'FM3 knee id (served selector)');
    assertEqual(v.roles.gainReduction, pidOf(fm3, 'COMP', 'COMP_GAINMONITOR'), 'FM3 gain-reduction monitor id');
    assertEqual(v.roles.threshold2, undefined, 'type 0 variant shows no THRESH2 → role dropped');
    assertEqual(v.roles.sustain, undefined, 'type 0 variant shows no SUSTAIN → role dropped');
    checkServed(r, fm3, 'COMP', 'FM3 COMP type 0');
    assertEqual(stampedKeys(r.layout).join(','), 'Basic:dynamics', 'FM3 COMP type 0: the Basic graph slot is stamped (sidechain EQ slot is not)');
  }
  console.log('  drivers/block-visuals: FM3 COMP full curve, device ids, variant-narrowed roles, stamped slot');

  // ---- Case 3: FM3 COMP THRESH2-only / SUSTAIN-only types → gain-reduction display; Compander → none.
  //      The types are chosen so every variant that names them (the pre-fw10 'LT' one the server picks
  //      today, and the current one once variant selection honours firmware — FORGEFX-57) agrees: type 3
  //      is THRESH2-only, type 15 SUSTAIN-only and type 12 the Compander in both.
  {
    const dyn = await readBlock(FM3, compEid, 'COMP', { [compTypePid]: 3 });
    const v = visual(dyn, 'dynamics');
    assert(v, 'FM3 COMP type 3: dynamics visual still served (gain reduction)');
    assertEqual(v.title, 'Gain reduction', 'FM3 COMP type 3 title');
    assertEqual(v.roles.threshold, undefined, 'type 3: no threshold role');
    assertEqual(v.roles.ratio, undefined, 'type 3: no ratio role');
    assertEqual(v.roles.threshold2, pidOf(fm3, 'COMP', 'COMP_THRESH2'), 'type 3: threshold2 role');
    checkServed(dyn, fm3, 'COMP', 'FM3 COMP type 3');
    const sus = await readBlock(FM3, compEid, 'COMP', { [compTypePid]: 15 });
    const s = visual(sus, 'dynamics');
    assert(s, 'FM3 COMP type 15: dynamics visual served (gain reduction)');
    assertEqual(s.title, 'Gain reduction', 'FM3 COMP type 15 (SUSTAIN-only) title');
    assertEqual(s.roles.sustain, pidOf(fm3, 'COMP', 'COMP_SUSTAIN'), 'type 15: sustain role');
    assert(s.roles.threshold == null && s.roles.ratio == null, 'type 15: the layout shows SUSTAIN, not THRESH/RATIO → narrowed to GR-only');
    checkServed(sus, fm3, 'COMP', 'FM3 COMP type 15');
    const compander = await readBlock(FM3, compEid, 'COMP', { [compTypePid]: 12 });
    assertEqual(compander.visuals?.length, 0, 'FM3 COMP Compander: no threshold/ratio/sustain → no visual');
  }
  console.log('  drivers/block-visuals: FM3 COMP THRESH2-only / SUSTAIN-only → gain reduction; Compander → none');

  // ---- Case 3b: FM3 GATE — ratio type vs range-only type (layout narrowing) -----------------------
  {
    const gateEid = eidOf('gate');
    const gateTypePid = pidOf(fm3, 'GATE', 'GATE_TYPE');
    const ratioType = visual(await readBlock(FM3, gateEid, 'GATE', { [gateTypePid]: 3 }), 'dynamics');
    assert(ratioType, 'FM3 GATE type 3: dynamics served');
    assertEqual(ratioType.mode, 'gate', 'FM3 GATE mode');
    assertEqual(ratioType.title, 'Gate curve', 'FM3 GATE title');
    assert(ratioType.roles.threshold != null && ratioType.roles.ratio != null && ratioType.roles.knee != null, 'FM3 GATE type 3: threshold + ratio + knee');
    const rangeRead = await readBlock(FM3, gateEid, 'GATE', { [gateTypePid]: 1 });
    const rangeType = visual(rangeRead, 'dynamics');
    assert(rangeType, 'FM3 GATE type 1: dynamics served (threshold + range)');
    assertEqual(rangeType.roles.range, pidOf(fm3, 'GATE', 'GATE_RANGE'), 'FM3 GATE type 1 range role');
    assertEqual(rangeType.roles.ratio, undefined, 'FM3 GATE type 1: its layout shows no ratio → narrowed away');
    assertEqual(rangeType.roles.gainReduction, pidOf(fm3, 'GATE', 'GATE_GAINMONITOR'), 'FM3 GATE gain-reduction monitor');
    checkServed(rangeRead, fm3, 'GATE', 'FM3 GATE type 1');
  }
  console.log('  drivers/block-visuals: FM3 GATE ratio vs range-only types');

  // ---- Case 3c: REVERB types whose only layout page is 'Pitch Shift' (an add-on variant: no page name in
  //      common with the Default variant) keep the decay visual through the Default variant's controls ----
  for (const model of [FM3, FM9, AXE3]) {
    const prof = profileForModel(model);
    const typePid = pidOf(prof, 'REVERB', 'REVERB_TYPE');
    const r = await readBlock(model, eidOf('reverb'), 'REVERB', { [typePid]: 1 });
    assertEqual((r.layout?.pages ?? []).map((p) => p.name).join(','), 'Pitch Shift', `${prof.key} REVERB type 1 layout (the case under test)`);
    const v = visual(r, 'decay');
    assert(v, `${prof.key} REVERB type 1: decay served although its own pages show no decay param`);
    assertEqual(v.roles.time, pidOf(prof, 'REVERB', 'REVERB_TIME'), `${prof.key} REVERB type 1: time`);
    assertEqual(v.roles.predelay, pidOf(prof, 'REVERB', 'REVERB_PREDELAY'), `${prof.key} REVERB type 1: predelay`);
    checkServed(r, prof, 'REVERB', `${prof.key} REVERB type 1`);
    const basic = visual(await readBlock(model, eidOf('reverb'), 'REVERB', { [typePid]: 0 }), 'decay');
    assertEqual(basic?.roles.time, pidOf(prof, 'REVERB', 'REVERB_TIME'), `${prof.key} REVERB type 0: decay with time`);
  }
  console.log('  drivers/block-visuals: REVERB pitch-only types keep decay (Default variant controls)');

  // ---- Case 3d: FILTER is strict (no Default variant): types get no visual they do not use --------
  {
    const filterEid = eidOf('filter');
    const typePid = pidOf(fm3, 'FILTER', 'FILTER_TYPE');
    const keysFor = async (t: number) => ((await readBlock(FM3, filterEid, 'FILTER', { [typePid]: t })).visuals ?? []).map((v) => v.key).join(',');
    assertEqual(await keysFor(0), 'response,lfo', 'FM3 FILTER type 0 (low-pass): response + its modulation LFO');
    assertEqual(await keysFor(13), '', 'FM3 FILTER type 13 (comb): no response, no LFO');
    assertEqual(await keysFor(15), '', 'FM3 FILTER type 15 (envelope): no response, no LFO');
    assertEqual(await keysFor(16), 'lfo', 'FM3 FILTER type 16 (auto-wah): its LFO, no static response');
  }
  console.log('  drivers/block-visuals: FM3 FILTER types strict (comb / envelope / auto-wah)');

  // ---- Case 4: FM3 TREMOLO panner type ---------------------------------------------------------
  {
    const r = await readBlock(FM3, eidOf('tremolo'), 'TREMOLO', { [pidOf(fm3, 'TREMOLO', 'TREMOLO_TYPE')]: 1 });
    const v = visual(r, 'lfo');
    assert(v, 'FM3 TREMOLO panner: lfo served');
    assertEqual(v.mode, 'panner', 'FM3 TREMOLO type 1 mode');
    assertEqual(v.title, 'Panner LFO', 'FM3 TREMOLO type 1 title');
    assert(v.roles.width != null && v.roles.center != null && v.roles.depth == null, 'panner: width + center, no depth');
    checkServed(r, fm3, 'TREMOLO', 'FM3 TREMOLO');
    assertEqual(stampedKeys(r.layout).join(','), 'Panner:lfo', 'FM3 TREMOLO panner slot stamped');
  }
  console.log('  drivers/block-visuals: FM3 TREMOLO panner mode');

  // ---- Case 5: FM9 DELAY — no layout on the device, visual from the catalog alone --------------
  const fm9 = profileForModel(FM9);
  {
    const r = await readBlock(FM9, eidOf('delay'), 'DELAY', {});
    assertEqual(r.layout, undefined, 'FM9 DELAY ships no layout (the case under test)');
    const v = visual(r, 'echo');
    assert(v, 'FM9 DELAY: echo served without a layout');
    assertEqual(v.roles.time, pidOf(fm9, 'DELAY', 'DELAY_TIME'), 'FM9 DELAY_TIME id (its own)');
    assert(v.roles.time !== pidOf(fm3, 'DELAY', 'DELAY_TIME'), 'FM9 DELAY_TIME differs from the FM3 id (no leak)');
    assertEqual(v.roles.routing, pidOf(fm9, 'DELAY', 'DELAY_TYPE'), 'FM9 DELAY routing = DELAY_TYPE (served selector; the model selector is DELAY_MODEL)');
    assertEqual(v.roles.feedback, pidOf(fm9, 'DELAY', 'DELAY_FEED'), 'FM9 DELAY feedback id');
    checkServed(r, fm9, 'DELAY', 'FM9 DELAY');
  }
  console.log('  drivers/block-visuals: FM9 DELAY echo without a layout, FM9 ids');

  // ---- Case 6: Axe-Fx III CONTROLLERS (virtual effect) → lfo1/lfo2/adsr1/adsr2 ----------------
  const iii = profileForModel(AXE3);
  {
    const r = await readBlock(AXE3, 2, 'CONTROLLERS', {}, 1);
    assertEqual((r.visuals ?? []).map((v) => v.key).join(','), 'lfo1,lfo2,adsr1,adsr2', 'III CONTROLLERS visuals');
    assertEqual(visual(r, 'lfo1')?.roles.rate, pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_LFO1FREQ'), 'III lfo1 rate');
    // LFO 1's type is an ordinary selector now (no longer mistaken for the block type — the family has no
    // type roster), so the LFO 1 scope gets its shape like LFO 2
    const lfo1Type = pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_LFO1TYPE');
    assertEqual(r.type, null, 'III CONTROLLERS: no block type (no roster)');
    assert(r.enums.some((e) => e.id === lfo1Type), 'III CONTROLLERS_LFO1TYPE served as an enum');
    assertEqual(visual(r, 'lfo1')?.roles.shape, lfo1Type, 'III lfo1 shape');
    assertEqual(visual(r, 'lfo2')?.roles.shape, pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_LFO2TYPE'), 'III lfo2 shape');
    assertEqual(visual(r, 'lfo2')?.roles.rate, pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_LFO2FREQ'), 'III lfo2 rate');
    assertEqual(visual(r, 'lfo2')?.roles.skew, pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_LFO2BETA'), 'III lfo2 skew (III-specific id)');
    assertEqual(visual(r, 'adsr2')?.roles.curve, pidOf(iii, 'CONTROLLERS', 'CONTROLLERS_ADSR2_TYPE'), 'III adsr2 curve (III-specific id)');
    checkServed(r, iii, 'CONTROLLERS', 'III CONTROLLERS');
    const keys = new Set(stampedKeys(r.layout).map((k) => k.split(':')[1]));
    assertEqual([...keys].sort().join(','), 'adsr1,adsr2,lfo1,lfo2', 'III CONTROLLERS layout slots stamped per instance');
  }
  console.log('  drivers/block-visuals: Axe-Fx III CONTROLLERS lfo1/lfo2/adsr1/adsr2 + stamped slots');

  // ---- Case 6b: the skipped '…TYPE' fallback: LFO 1 shape on FM3/FM9; roster-less MULTITAP / PLEX pick
  //      their layout variant by the live <FAM>_BASETYPE selector (the key their variants are valued by) ----
  for (const model of [FM3, FM9]) {
    const prof = profileForModel(model);
    const r = await readBlock(model, 2, 'CONTROLLERS', {}, 1);
    assertEqual(visual(r, 'lfo1')?.roles.shape, pidOf(prof, 'CONTROLLERS', 'CONTROLLERS_LFO1TYPE'), `${prof.key} lfo1 shape`);
  }
  for (const model of [FM3, FM9, AXE3]) {
    const prof = profileForModel(model);
    const mtBase = pidOf(prof, 'MULTITAP', 'MULTITAP_BASETYPE');
    const mt = await readBlock(model, eidOf('multitap'), 'MULTITAP', { [mtBase]: 2 });
    assertEqual(mt.type, null, `${prof.key} MULTITAP: no block type (no roster)`);
    assert(mt.enums.some((e) => e.id === mtBase && e.value === 2), `${prof.key} MULTITAP_BASETYPE served as an enum (algorithm 2)`);
    assertEqual(mt.layout?.variantName, '2', `${prof.key} MULTITAP algorithm 2 → variant '2'`);
    assertEqual(mt.layout?.variantValue, '2', `${prof.key} MULTITAP variant value`);
    const plexBase = pidOf(prof, 'PLEX', 'PLEX_BASETYPE');
    const plex = await readBlock(model, eidOf('plex'), 'PLEX', { [plexBase]: 4 });
    assertEqual(plex.type, null, `${prof.key} PLEX: no block type (no roster)`);
    assertEqual(plex.layout?.variantName, 'Shimmer Verb', `${prof.key} PLEX base type 4 → 'Shimmer Verb' variant`);
    const plex0 = await readBlock(model, eidOf('plex'), 'PLEX', { [plexBase]: 0 });
    assertEqual(plex0.layout?.variantName, 'Plex Delay', `${prof.key} PLEX base type 0 → 'Plex Delay' variant`);
  }
  console.log('  drivers/block-visuals: FM3/FM9 lfo1 shape; MULTITAP / PLEX variants follow <FAM>_BASETYPE');

  // ---- Case 7: served layouts — gen-3 stamped, AM4 untouched -----------------------------------
  {
    const filter = fm3.layoutFor('FILTER', 0);
    const keys = stampedKeys(filter);
    assert(keys.includes('Filter:response'), 'FM3 FILTER Filter page slot → response');
    assert(keys.some((k) => k === 'Modulation:lfo' || k === 'LFO:lfo'), 'FM3 FILTER modulation page slot → lfo');
    assertEqual(stampedKeys(fm9.layoutFor('PEQ')).length > 0, true, 'FM9 PEQ slot stamped (eq)');
    assertEqual(stampedKeys(am4LayoutFor('compressor', 6)).length, 0, 'AM4 layouts stay unstamped');
    // stamping never touches non-graph controls
    for (const p of iii.layoutFor('CONTROLLERS')?.pages ?? []) for (const r of p.rows) for (const c of r.controls) {
      if (c.graphKey) assertEqual(c.widget, 'graph', 'only graph slots carry a graphKey');
    }
  }
  console.log('  drivers/block-visuals: gen-3 layouts stamped, AM4 untouched');

  // ---- Case 8: blockVisualsFor — non-gen-3 model, layout narrowing ------------------------------
  {
    const vp4Like = { ...fm3, model: 0x14, key: 'vp4' } as DeviceProfile;
    assertEqual(blockVisualsFor(vp4Like, 'COMP', undefined, [0, 1]).length, 0, 'non-gen-3 grid model → none');
    const all = (fm3.params['REVERB'] ?? []).map((p) => p.paramId);
    assertEqual(blockVisualsFor(fm3, 'REVERB', undefined, all)[0]?.key, 'decay', 'REVERB without layout narrowing → decay');
    const layoutOf = (ids: number[], variantValue: string | null, pageName = 'P'): DeviceLayout => ({
      editorName: 'Reverb', family: 'REVERB', variantName: 'x', variantValue,
      pages: [{ name: pageName, rows: [{ section: 'parameters', controls: ids.map((id) => ({ label: '', paramName: null, paramId: id, widget: 'knob' as const, rawWidget: 'knob' })) }] }],
    });
    const time = pidOf(fm3, 'REVERB', 'REVERB_TIME');
    const predelay = pidOf(fm3, 'REVERB', 'REVERB_PREDELAY');
    const shift = pidOf(fm3, 'REVERB', 'REVERB_SHIFT1');
    // strict: a Default (value-less) variant, or a variant sharing a page name with the Default, is final
    assertEqual(blockVisualsFor(fm3, 'REVERB', layoutOf([shift], null), all).length, 0, 'Default variant showing no decay param → none (strict)');
    assertEqual(blockVisualsFor(fm3, 'REVERB', layoutOf([shift], '1', 'Basic'), all).length, 0, 'variant sharing a Default page name → strict');
    assertEqual(blockVisualsFor(fm3, 'REVERB', layoutOf([predelay, shift], '1', 'Basic'), all).length, 0, 'strict: a decay param but not TIME → dropped');
    // add-on variant (no page name in common with the Default): the Default's controls count as well
    assertEqual(blockVisualsFor(fm3, 'REVERB', layoutOf([shift], '1'), all)[0]?.roles.time, time, 'add-on variant → decay through the Default variant');
    // …but a visual the strict pass already keeps is not widened (roles stay what the variant shows)
    assertEqual(Object.keys(blockVisualsFor(fm3, 'REVERB', layoutOf([time, shift], '1'), all)[0]?.roles ?? {}).join(','), 'time', 'strict visual kept as is');
    assertEqual(SLUG_FAMILY['reverb'], 'REVERB', 'slug map sanity');
  }
  console.log('  drivers/block-visuals: blockVisualsFor gating + layout narrowing');

  // ---- Case 9: HTTP route passes `visuals` through ------------------------------------------------
  {
    const { app, mock } = await buildTestApp(FM3);
    try {
      const prior = mock.reply;
      const block = bulkReply(fm3, compEid, 'COMP', { [compTypePid]: 0 }, 4);
      mock.reply = (req) => {
        const r = block(req);
        return r.length ? r : prior(req);
      };
      const res = await app.inject({ method: 'GET', url: `/preset/blocks/${compEid}/params` });
      assertEqual(res.statusCode, 200, 'GET /preset/blocks/:eid/params');
      const body = res.json() as { visuals?: BlockVisualDTO[]; layout?: DeviceLayout };
      assertEqual(body.visuals?.[0]?.key, 'dynamics', 'route serves visuals');
      assertEqual(stampedKeys(body.layout).join(','), 'Basic:dynamics', 'route serves the stamped layout');
    } finally {
      await app.close();
    }
  }
  console.log('  drivers/block-visuals: GET /preset/blocks/:eid/params carries visuals + stamped layout');
}
