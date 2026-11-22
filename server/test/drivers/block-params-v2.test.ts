// The generic block-params response (`blockParams(eid, { generic: true })`, GET …/params?generic=1) over a
// mocked unit that answers the status dump (0x13) and the block bulk read (0x1F): every param the block has
// on the connected device, values that are `null` with an `unresolved` reason instead of an invented number,
// classification (kind / widget / write mode), fingerprints, hidden rows, and the classic response next to it
// (same reads, numbers kept, additive `unresolved` markers). Committed catalog data and synthetic bodies only.
import { PROFILES, SLUG_FAMILY, runtimeProfileFrom, type DeviceProfile } from '../../src/devices.js';
import { buildParamIndex } from '../../src/drivers/paramIndex.js';
import type { BlockParamsDTO, BlockParamsV2DTO } from '../../src/drivers/types.js';
import { isInformativeRow } from 'forgefx-midi/cache';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { mockBlockDevice, eidOfSlug } from '../helpers/blockRead.js';

export const BLOCK_PARAMS_V2_CASE_COUNT = 13;

const FM3 = PROFILES[0x11]!;
const FM9 = PROFILES[0x12]!;
const AXE3 = PROFILES[0x10]!;

const DELAY = eidOfSlug('delay');
const CAB = eidOfSlug('cab');
const GLOBAL_EID = 1;
const strideOf = (p: DeviceProfile, fam: string) => p.rangeSections[fam]!.stride;
const FP = /^1:[0-9a-f]{8}$/;

/** A body whose every channel slice differs: channel k's pid p holds a value in the 16-bit range. */
function body(stride: number, channels = 4): number[] {
  const values: number[] = [];
  for (let ch = 0; ch < channels; ch++) for (let p = 0; p < stride; p++) values.push((p * 311 + ch * 5000 + 17) % 60000);
  return values;
}

const v2Of = (p: DeviceProfile, eid: number, blocks: Parameters<typeof mockBlockDevice>[1]) =>
  mockBlockDevice(p, blocks).driver.blockParams(eid, { generic: true }) as Promise<BlockParamsV2DTO>;
const classicOf = (p: DeviceProfile, eid: number, blocks: Parameters<typeof mockBlockDevice>[1]) =>
  mockBlockDevice(p, blocks).driver.blockParams(eid) as Promise<BlockParamsDTO>;

const allEntries = (r: BlockParamsV2DTO) => [...r.named, ...r.enums];

export async function runBlockParamsV2Tests(): Promise<void> {
  const stride = strideOf(FM3, 'DELAY');

  // ---- 1. a healthy read: shape, slice, values, definitions ------------------------------------
  {
    const values = body(stride);
    values[stride * 1 + 6] = 5; // channel B's DELAY_MODEL (a roster ordinal)
    values[0 * stride + 6] = 2; // …channel A's differs
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: 1 } });
    assertEqual(r.block, 'Delay', 'block name');
    assertEqual(r.slug, 'delay', 'slug');
    assertEqual(r.page, DELAY, 'page');
    assertEqual(r.definitions.family, 'DELAY', 'definitions.family');
    assertEqual(r.definitions.profile, 'none', 'no profile applied: the bundled catalog alone');
    assertEqual(r.definitions.positional, true, 'a block is read by position');
    assertEqual(r.definitions.channel, 1, 'the active channel the values were sliced from');
    assertEqual(r.definitions.persistentWrites, false, 'an audio block writes the edit buffer');
    assertEqual(JSON.stringify(r.definitions.hidden), JSON.stringify([{ id: 5, reason: 'bypass' }, { id: 6, reason: 'type' }]), 'bypass and the type selector are reported, not listed');
    assertEqual(r.unknownBlock, undefined, 'a known block');
    assertEqual(r.readError, undefined, 'the read worked');
    for (const e of allEntries(r)) {
      assert(e.value !== null && e.unresolved === undefined, `${e.name}: a resolved value`);
      assert(FP.test(e.fp), `${e.name}: a fingerprint`);
      assert(e.kind === 'float' || e.kind === 'enum', `${e.name}: a kind`);
    }
    // channel B's slice: the first named param is Mix (pid 0), a linear 0..100 % row
    const mix = r.named.find((n) => n.id === 0)!;
    assertEqual(mix.name, 'Mix', 'pid 0 is Mix');
    assertEqual(mix.norm, values[stride * 1 + 0]! / 65534, 'the value comes from channel B, not channel A');
    assert(mix.norm !== values[0]! / 65534, 'the channels differ in this body');
    // the type selector is read on its own: DELAY_MODEL (pid 6)
    assertEqual(r.type?.value, 5, 'type value from channel B');
    assert((r.type?.name ?? '') !== '', 'type name from the roster');
    console.log('  drivers/block-params-v2: healthy read — channel slice, definitions, hidden rows, values, fingerprints');
  }

  // ---- 2. enum decode: ordinals, scaled values, the label of an ordinal ---------------------------
  {
    const svf = FM3.params['DELAY']!.find((p) => p.name === 'DELAY_SVFTYPE')!.paramId;
    const bypassMode = 3; // DELAY_BYPASS_MODE: THRU / MUTE FX OUT / MUTE OUT
    const values = body(stride);
    values[svf] = 3;
    values[bypassMode] = 2;
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: 0 } });
    const e = r.enums.find((x) => x.id === svf)!;
    assertEqual(e.value, 3, 'DELAY_SVFTYPE ordinal 3');
    assertEqual(e.options.find((o) => o.value === 3)?.label, 'HIGHPASS', 'its label is the third entry of the list');
    assertEqual(r.enums.find((x) => x.id === bypassMode)!.options[2]!.label, 'MUTE OUT', 'a zero-based list');
    // an enum row below its first ordinal is not a reading
    values[svf] = 0;
    const low = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: 0 } });
    const lowE = low.enums.find((x) => x.id === svf)!;
    assertEqual(lowE.value, null, 'ordinal 0 is below DELAY_SVFTYPE\'s first ordinal (1)');
    assertEqual(lowE.unresolved, 'out-of-range', 'out-of-range');
    // …while a float above full scale is no reading either
    values[0] = 65535;
    const high = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: 0 } });
    const mixE = high.named.find((x) => x.id === 0)!;
    assertEqual(mixE.value, null, 'a float above full scale');
    assertEqual(mixE.norm, null, 'has no norm either');
    assertEqual(mixE.unresolved, 'out-of-range', 'out-of-range');
    assertEqual(mixE.max, 100, 'the static range facts are still served');
    console.log('  drivers/block-params-v2: enum ordinals and labels; out-of-range enum and float readings are null');
  }

  // ---- 3. GLOBAL: the body is indexed by record, not by pid ---------------------------------------
  {
    const values = new Array<number>(136).fill(1234);
    const r = await v2Of(FM3, GLOBAL_EID, { [GLOBAL_EID]: { values, channel: null } });
    assertEqual(r.block, 'GLOBAL', 'the virtual effect resolves through the profile');
    assertEqual(r.definitions.family, 'GLOBAL', 'family GLOBAL');
    assertEqual(r.definitions.positional, false, 'not positional');
    assertEqual(r.definitions.channel, null, 'no channels');
    assertEqual(r.definitions.persistentWrites, true, 'GLOBAL writes are persistent settings');
    assertEqual(r.type, null, 'GLOBAL has no type');
    assertEqual(r.named.length + r.enums.length, 186, 'every informative GLOBAL row is listed (FM3 catalog)');
    for (const e of allEntries(r)) {
      assertEqual(e.value, null, `${e.name}: no value`);
      assertEqual(e.unresolved, 'non-positional', `${e.name}: non-positional`);
    }
    for (const n of r.named) assertEqual(n.norm, null, `${n.name}: no norm`);
    const generic = allEntries(r).filter((e) => e.generic);
    assertEqual(generic.length, 27, 'the 27 unnamed GLOBAL rows are generic params');
    for (const e of generic) {
      assertEqual(e.name, `P${e.id}`, 'a generic name');
      assertEqual(e.pageHint, 'more', 'catalog rows without a name go on the more page');
      assertEqual(e.nameSource, 'generic', 'name source');
      assertEqual(e.nameConfidence, undefined, 'a generic name has no confidence');
      assertEqual(e.isNew, undefined, 'not new in firmware: the catalog has the row');
    }
    // an enum with a long list keeps it whole
    const cc = r.enums.find((e) => e.options.length >= 148)!;
    assert(!!cc && cc.optionsTruncated === undefined, 'the CC lists are served whole');
    console.log('  drivers/block-params-v2: GLOBAL — 186 entries, all null / non-positional, 27 generic, persistent writes');

    // the classic response of the same block keeps its numbers and says which ones are not readings
    const c = await classicOf(FM3, GLOBAL_EID, { [GLOBAL_EID]: { values, channel: null } });
    assert(c.named.length > 0 && c.enums.length > 0, 'the classic response lists the block');
    for (const e of [...c.named, ...c.enums]) {
      assert(typeof e.value === 'number', `${e.name}: still a number`);
      assertEqual(e.unresolved, 'non-positional', `${e.name}: marked non-positional`);
    }
    console.log('  drivers/block-params-v2: classic GLOBAL — numbers kept, every entry marked non-positional');
  }

  // ---- 4. a torn body: only the positions that arrived are readings -------------------------------
  {
    const full = body(stride);
    const torn = full.slice(0, 40); // the head advertises 4 channels of `stride`, 40 values arrive
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values: torn, advertised: full.length, channel: 0 } });
    const inBody = allEntries(r).filter((e) => e.id < 40);
    const beyond = allEntries(r).filter((e) => e.id >= 40);
    assert(inBody.length > 0 && beyond.length > 0, 'the torn body splits the params');
    for (const e of inBody) assert(e.value !== null, `${e.name}: inside the body is a reading`);
    for (const e of beyond) {
      assertEqual(e.value, null, `${e.name}: beyond the body`);
      assertEqual(e.unresolved, 'not-in-body', `${e.name}: not in body`);
    }
    // channel B of the same torn read is entirely past what arrived
    const rb = await v2Of(FM3, DELAY, { [DELAY]: { values: torn, advertised: full.length, channel: 1 } });
    for (const e of allEntries(rb)) assertEqual(e.unresolved, 'not-in-body', `${e.name}: channel B is past the torn body`);
    // the classic response keeps its zeros and marks them
    const c = await classicOf(FM3, DELAY, { [DELAY]: { values: torn, advertised: full.length, channel: 0 } });
    const beyondC = [...c.named, ...c.enums].filter((e) => e.id >= 40);
    assert(beyondC.length > 0 && beyondC.every((e) => e.unresolved === 'not-in-body'), 'classic: positions beyond the body are marked');
    assert([...c.named, ...c.enums].filter((e) => e.id < 40).every((e) => e.unresolved === undefined), 'classic: positions inside are not');
    console.log('  drivers/block-params-v2: torn body — positions inside are readings, the rest null / not-in-body; classic marks the same entries');
  }

  // ---- 5. a failed read ------------------------------------------------------------------------
  {
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0, silent: true } });
    assert(typeof r.readError === 'string' && r.readError.length > 0, 'the read error is reported');
    assertEqual(r.named.length + r.enums.length, 81, 'every param is still listed (the definitions do not depend on the read)');
    for (const e of allEntries(r)) {
      assertEqual(e.value, null, `${e.name}: no value`);
      assertEqual(e.unresolved, 'read-failed', `${e.name}: read-failed`);
    }
    assertEqual(r.type, null, 'no type without a read');
    assertEqual(r.definitions.channel, 0, 'the status read had worked');
    const c = await classicOf(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0, silent: true } });
    assert(c.named.length > 0 && c.named.every((n) => n.value === 0 && n.norm === 0 && n.unresolved === 'read-failed'), 'classic: dials at rest, marked read-failed');
    assertEqual(c.enums.length, 0, 'classic: no selectors without a read');
    assertEqual(c.type, null, 'classic: no type');
    console.log('  drivers/block-params-v2: failed read — everything listed, nothing resolved, readError set; classic as before plus the marker');
  }

  // ---- 6. an unknown channel --------------------------------------------------------------------
  {
    const values = body(stride);
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: null } });
    assertEqual(r.definitions.channel, null, 'channel unknown');
    for (const e of allEntries(r)) {
      assertEqual(e.value, null, `${e.name}: no value`);
      assertEqual(e.unresolved, 'channel-unknown', `${e.name}: channel-unknown`);
    }
    assertEqual(r.type, null, 'no type');
    // classic: the slice of channel A as before, every entry marked
    const c = await classicOf(FM3, DELAY, { [DELAY]: { values, channel: null } });
    const mix = c.named.find((n) => n.id === 0)!;
    assertEqual(mix.norm, values[0]! / 65534, 'classic: channel A, as before');
    assertEqual(mix.unresolved, 'channel-unknown', 'classic: marked');
    assert(c.type !== null, 'classic: the type is still read');
    // a block that has no channels is not "channel unknown": CONTROLLERS (eid 2) is one slice with no status entry
    const ctrl = await v2Of(FM3, 2, { 2: { values: new Array<number>(130).fill(1000), channel: null } });
    assertEqual(ctrl.definitions.positional, true, 'CONTROLLERS is read by position');
    assertEqual(ctrl.definitions.channel, null, 'it has no channel');
    assert(allEntries(ctrl).length > 0 && allEntries(ctrl).every((e) => e.value !== null && e.unresolved === undefined), 'and every value of it is a reading');
    console.log('  drivers/block-params-v2: unknown channel — null / channel-unknown; classic keeps channel A and marks every entry');
  }

  // ---- 7. classification: kinds, widgets, write modes -----------------------------------------
  {
    for (const [name, prof, eids] of [['FM3', FM3, ['delay', 'cab', 'filter', 'reverb', 'comp']], ['FM9', FM9, ['delay', 'cab', 'amp']], ['Axe-Fx III', AXE3, ['delay', 'cab', 'reverb']]] as const) {
      for (const slug of eids) {
        const eid = eidOfSlug(slug);
        const r = await v2Of(prof, eid, { [eid]: { values: body(strideOf(prof, SLUG_FAMILY[slug]!)), channel: 0 } });
        for (const n of r.named) {
          assertEqual(n.kind, 'float', `${name} ${slug} ${n.name}: an enum is never a dial`);
          assert(n.widget === 'knob' || n.widget === 'stepper', `${name} ${slug} ${n.name}: a dial is a knob or a stepper`);
          assertEqual(n.write, 'norm', `${name} ${slug} ${n.name}: dials write a normalised value`);
        }
        for (const e of r.enums) {
          assert(e.widget === 'toggle' || e.widget === 'dropdown', `${name} ${slug} ${e.name}: a selector is a toggle or a dropdown`);
          if (e.widget === 'toggle') assertEqual(e.options.length, 2, `${name} ${slug} ${e.name}: a toggle has two options`);
          if (e.kind === 'enum') assertEqual(e.write, 'ordinal', `${name} ${slug} ${e.name}: an enum writes its ordinal`);
        }
      }
    }
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
    assert(r.named.some((n) => n.widget === 'stepper' && Number.isInteger(n.min) && Number.isInteger(n.max)), 'a float row with integral bounds and whole steps is a stepper (DELAY_TIME)');
    assert(r.enums.some((e) => e.widget === 'toggle'), 'a two-option enum is a toggle');
    assert(r.enums.some((e) => e.widget === 'dropdown' && e.options.length > 2), 'a longer enum is a dropdown');
    console.log('  drivers/block-params-v2: no enum in named, dials are knob/stepper, selectors toggle/dropdown, writes follow the kind (FM3, FM9, III)');
  }

  // ---- 8. response names are de-duplicated; the index is not touched --------------------------------
  {
    const cabStride = strideOf(FM3, 'CABINET');
    const r = await v2Of(FM3, CAB, { [CAB]: { values: body(cabStride), channel: 0 } });
    const lowCuts = allEntries(r).filter((e) => /^Low Cut( \d)?$/.test(e.name));
    assertEqual(lowCuts.map((e) => e.name).join(','), 'Low Cut 1,Low Cut 2,Low Cut 3', 'repeated labels get a suffix in the response');
    const idx = buildParamIndex(FM3, 'CABINET');
    const names = idx.entries.filter((e) => e.pid === 38 || e.pid === 62 || e.pid === 63).map((e) => e.name);
    assertEqual(names.join(','), 'Low Cut,Low Cut,Low Cut', 'the index entries keep the catalog label');
    assert(Object.isFrozen(idx) && Object.isFrozen(idx.entries) && idx.entries.every((e) => Object.isFrozen(e)), 'the index is still frozen');
    const again = await v2Of(FM3, CAB, { [CAB]: { values: body(cabStride), channel: 0 } });
    assertEqual(JSON.stringify(again.named.map((n) => n.name)), JSON.stringify(r.named.map((n) => n.name)), 'a second response is named the same');
    console.log('  drivers/block-params-v2: duplicate labels are numbered on the response copies, never in the index');
  }

  // ---- 9. a byte-exact profile: provenance, counts, the invariant ---------------------------------
  {
    const profile = runtimeProfileFrom(catalogBuilt(0x11), FM3);
    const values = body(stride);
    const r = await v2Of(profile, DELAY, { [DELAY]: { values, channel: 0 } });
    assertEqual(r.definitions.profile, 'byte-exact', 'byte-exact profile');
    const informative = Object.entries(profile.ranges['DELAY']!).filter(([pid, row]) => Number(pid) <= 0x3fff && isInformativeRow(row)).length;
    const removed = r.definitions.hidden.filter((h) => h.reason === 'removed').length;
    assertEqual(r.named.length + r.enums.length + r.definitions.hidden.length - removed, informative, 'listed + hidden (other than removed) = the informative rows of the family');
    for (const e of allEntries(r)) {
      assertEqual(e.source, 'profile', `${e.name}: its row came from the profile`);
      assertEqual(e.nameConfidence, 'high', `${e.name}: the catalog profile agrees with the catalog`);
    }
    console.log('  drivers/block-params-v2: byte-exact profile — provenance on every entry, listed + hidden = informative rows');
  }

  // ---- 10. an effect id the device model has no family for -------------------------------------------
  {
    const g = await v2Of(FM3, 205, {});
    assertEqual(g.block, 'Block 205', 'a placeholder name');
    assertEqual(g.slug, '', 'no slug');
    assertEqual(g.page, -1, 'no page');
    assertEqual(g.unknownBlock, true, 'marked unknown');
    assertEqual(g.named.length + g.enums.length, 0, 'nothing listed');
    assertEqual(g.type, null, 'no type');
    assertEqual(JSON.stringify(g.definitions), JSON.stringify({ family: null, profile: 'none', positional: false, channel: null, persistentWrites: false, hidden: [] }), 'definitions of an unknown block');
    const c = (await mockBlockDevice(FM3, {}).driver.blockParams(205)) as BlockParamsDTO;
    assertEqual(c.block, '', 'classic: unchanged');
    assertEqual((c as unknown as Record<string, unknown>).unknownBlock, undefined, 'classic: no marker');
    console.log('  drivers/block-params-v2: unknown block — Block <eid>, nothing listed; classic unchanged');
  }

  // ---- 11. selectors: the type follows its name, the cab follows its mode ----------------------------
  {
    const cabStride = strideOf(FM3, 'CABINET');
    const modePid = FM3.params['CABINET']!.find((p) => p.name === 'CABINET_MODE')!.paramId;
    const preType = FM3.params['CABINET']!.find((p) => p.name === 'CABINET_PRETYPE')!.paramId;
    for (const mode of [0, 1]) {
      const values = body(cabStride);
      values[modePid] = mode;
      const r = await v2Of(FM3, CAB, { [CAB]: { values, channel: 0 } });
      assertEqual(r.type, null, 'the cab has no type');
      assertEqual(r.layout?.variantValue, String(mode), `the cab layout follows CABINET_MODE = ${mode}`);
      assert(r.enums.some((e) => e.id === preType), 'the preamp type is an ordinary selector');
      assert(r.enums.some((e) => e.id === modePid && e.value === mode), 'the mode is listed with its value');
    }
    console.log('  drivers/block-params-v2: cab — no type, layout variant follows CABINET_MODE, preamp type listed');
  }

  // ---- 12. the diagnostic hook serves a chosen pid as a generic param ---------------------------------
  {
    const prior = process.env.FORGEFX_DEFS_FORCE_GENERIC;
    try {
      process.env.FORGEFX_DEFS_FORCE_GENERIC = 'DELAY:3, CHORUS:8';
      const r = await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
      const forced = r.enums.find((e) => e.id === 3)!;
      assertEqual(forced.name, 'P3', 'served under the generic name');
      assertEqual(forced.generic, true, 'generic');
      assertEqual(forced.options.map((o) => o.label).join('|'), FM3.enumLabelsFor('DELAY', 3)!.join('|'), 'with the device labels');
      const c = await classicOf(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
      assertEqual(c.enums.find((e) => e.id === 3)!.name, 'Bypass Mode', 'the classic response ignores the hook');
    } finally {
      if (prior === undefined) delete process.env.FORGEFX_DEFS_FORCE_GENERIC;
      else process.env.FORGEFX_DEFS_FORCE_GENERIC = prior;
    }
    const plain = await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
    assertEqual(plain.enums.find((e) => e.id === 3)!.name, 'Bypass Mode', 'off by default');
    console.log('  drivers/block-params-v2: FORGEFX_DEFS_FORCE_GENERIC serves the chosen pid as a generic param (generic response only)');
  }

  // ---- 13. layout buttons point at the param they press ---------------------------------------------
  {
    const cabStride = strideOf(FM3, 'CABINET');
    const r = await v2Of(FM3, CAB, { [CAB]: { values: body(cabStride), channel: 0 } });
    const buttons = (r.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls)).filter((c) => c.paramName?.includes('_BTN_MUTE'));
    assert(buttons.length > 0, 'the cab layout draws mute buttons');
    const muteOf = (n: number) => FM3.params['CABINET']!.find((p) => p.name === `CABINET_MUTE${n}`)!.paramId;
    for (const b of buttons) {
      const n = Number(/MUTE(\d)/.exec(b.paramName!)![1]);
      assertEqual((b as { boundParamId?: number }).boundParamId, muteOf(n), `${b.paramName} → CABINET_MUTE${n}`);
      assert(b.paramId !== muteOf(n), 'the control keeps its own pseudo id');
    }
    const classic = await classicOf(FM3, CAB, { [CAB]: { values: body(cabStride), channel: 0 } });
    const classicButtons = (classic.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls)).filter((c) => c.paramName?.includes('_BTN_'));
    assert(classicButtons.every((b) => (b as { boundParamId?: number }).boundParamId === undefined), 'the classic layout is unchanged');
    console.log('  drivers/block-params-v2: layout buttons carry boundParamId (generic response only)');
  }
}
