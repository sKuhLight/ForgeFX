// The generic block-params response (`blockParams(eid, { generic: true })`, GET …/params?generic=1) over a
// mocked unit that answers the status dump (0x13) and the block bulk read (0x1F): every param the block has
// on the connected device, values that are `null` with an `unresolved` reason instead of an invented number,
// classification (kind / widget / write mode), fingerprints, hidden rows, and the classic response next to it
// (same reads, numbers kept, additive `unresolved` markers). Committed catalog data and synthetic bodies only.
import { PROFILES, SLUG_FAMILY, runtimeProfileFrom, type DeviceLayout, type DeviceLayoutControl, type DeviceProfile, type ParamDef, type RangeDef, type SelectorValues } from '../../src/devices.js';
import { buildParamIndex } from '../../src/drivers/paramIndex.js';
import { createGen3Driver, parseForcedGeneric } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import type { BlockParamsDTO, BlockParamsV2DTO, PresetGridDTO } from '../../src/drivers/types.js';
import { CACHE_SCHEMA, isInformativeRow, type BuiltCache } from 'forgefx-midi/cache';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt, mockGen3Device } from '../helpers/catalogProfile.js';
import { mockBlockDevice, eidOfSlug, compactHex, enc14, sysex } from '../helpers/blockRead.js';
import { VirtualClock, FakeLink, QueueTransport, track } from '../helpers/virtualLink.js';

export const BLOCK_PARAMS_V2_CASE_COUNT = 25;

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

/** The FM3 catalog as a byte-exact device profile with one row inserted into `fam` at `at`: the rows (and
 *  labels) from `at` on move up by one pid, the section stride grows by one. */
function insertedBuilt(fam: string, at: number): BuiltCache {
  const b = catalogBuilt(0x11);
  const rows = b.ranges[fam] as Record<number, RangeDef>;
  const labels = (b.enumOverrides[fam] ?? {}) as Record<string, string[]>;
  const nr: Record<number, RangeDef> = {};
  const nl: Record<string, string[]> = {};
  for (const pid of Object.keys(rows).map(Number)) {
    const to = pid >= at ? pid + 1 : pid;
    nr[to] = rows[pid]!;
    if (labels[String(pid)]) nl[String(to)] = labels[String(pid)]!;
  }
  nr[at] = { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0.01, typecode: 0x7f1 };
  b.ranges[fam] = nr;
  b.enumOverrides[fam] = nl;
  const sec = b.rangeSections[fam]!;
  b.rangeSections[fam] = { ...sec, stride: sec.stride + 1 };
  return b;
}

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
    // M3 §3.3: an unknown block's definitions carry its block-map state (no profile, no section to match: none; a bare
    // driver has no probe gate: not-verified)
    assertEqual(JSON.stringify(g.definitions), JSON.stringify({
      family: null, profile: 'none', positional: false, channel: null, persistentWrites: false, hidden: [],
      blockMap: { state: 'none', key: null, sectionTag: null, evidence: [], probe: { available: false, reason: 'not-verified' } }
    }), 'definitions of an unknown block');
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
    const priorOptIn = process.env.FORGEFX_DEV_HOOKS;
    try {
      process.env.FORGEFX_DEV_HOOKS = '1'; // every development hook needs the explicit opt-in (devHooks.ts)
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
      if (priorOptIn === undefined) delete process.env.FORGEFX_DEV_HOOKS;
      else process.env.FORGEFX_DEV_HOOKS = priorOptIn;
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
      assertEqual(b.boundParamId, muteOf(n), `${b.paramName} → CABINET_MUTE${n}`);
      assert(b.paramId !== muteOf(n), 'the control keeps its own pseudo id');
    }
    const classic = await classicOf(FM3, CAB, { [CAB]: { values: body(cabStride), channel: 0 } });
    const classicButtons = (classic.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls)).filter((c) => c.paramName?.includes('_BTN_'));
    assert(classicButtons.every((b) => b.boundParamId === undefined), 'the classic layout is unchanged');
    console.log('  drivers/block-params-v2: layout buttons carry boundParamId (generic response only)');
  }

  // ---- 14. a lost status reply is asked for once more before the channel counts as unknown -----------
  const statusHex = compactHex(createModernFractalCodec(0x11).buildStatusDump());
  /** A unit whose first `lost` status replies go missing; records every status request's timeout. `hold()`
   *  keeps status replies back until `release()`. */
  const statusRig = (opts: { lost?: number; slow?: boolean } = {}) => {
    const dev = mockBlockDevice(FM3, { [DELAY]: { values: body(stride), channel: 2 } });
    const answer = dev.mock.reply;
    const timeouts: number[] = [];
    const gate: { held: Promise<void> | null; release: () => void } = { held: null, release: () => {} };
    if (opts.slow) (dev.mock as unknown as { slow: boolean }).slow = true;
    dev.mock.request = async (bytes, o) => {
      dev.mock.sent.push([...bytes]);
      if (compactHex(bytes) === statusHex) {
        const n = timeouts.push(o?.timeoutMs ?? -1);
        if (gate.held) await gate.held;
        if (n <= (opts.lost ?? 0)) return [];
      }
      return answer(bytes);
    };
    return {
      driver: dev.driver, timeouts,
      hold: () => { gate.held = new Promise<void>((resolve) => { gate.release = resolve; }); },
      release: () => gate.release(),
    };
  };
  {
    const once = statusRig({ lost: 1 });
    const r = await once.driver.blockParams(DELAY, { generic: true });
    assertEqual(once.timeouts.length, 2, 'the status request is re-issued once after a lost reply');
    assertEqual(r.definitions.channel, 2, 'the second reply gives the channel');
    assert(allEntries(r).every((e) => e.value !== null && e.unresolved === undefined), 'every value resolves: no channel-unknown');
    assertEqual(once.timeouts.join(','), '1500,1500', 'a normal link waits 1.5 s per request');
    const twice = statusRig({ lost: 2, slow: true });
    const lost = await twice.driver.blockParams(DELAY, { generic: true });
    assertEqual(twice.timeouts.join(','), '4000,1500', 'a slow link waits 4 s for the first request, 1.5 s for the retry, and asks twice at most');
    assert(allEntries(lost).every((e) => e.unresolved === 'channel-unknown'), 'two lost replies: the channel is unknown');
    // the routine channel-watch poll asks once, with the fixed 1.5 s even on a slow link: its next tick is the retry
    const poll = statusRig({ lost: 1, slow: true });
    assertEqual((await poll.driver.getActiveChannels()).size, 0, 'the poll reports nothing for a lost reply');
    assertEqual(poll.timeouts.join(','), '1500', 'and asks once, 1.5 s');
    console.log('  drivers/block-params-v2: the status read is retried once (slow link 4 s then 1.5 s) before channel-unknown; the channel poll asks once, 1.5 s');
  }

  // ---- 15. the classic type (and the meter tile's type name) is read where the type selector sits now --
  {
    const shifted = runtimeProfileFrom(insertedBuilt('ENHANCER', 3), FM3); // ENHANCER_TYPE moves from pid 6 to 7
    assertEqual(buildParamIndex(shifted, 'ENHANCER').typePid, 7, 'premise: the type selector moved with its name');
    const ENH = eidOfSlug('enhancer');
    const values = new Array<number>(strideOf(shifted, 'ENHANCER') * 4).fill(0);
    values[7] = 2; // the type ordinal where the type sits on this device (pid 6 now holds the moved bypass flag, 0)
    const roster = shifted.rosterFor('enhancer');
    const c = (await mockBlockDevice(shifted, { [ENH]: { values, channel: 0 } }).driver.blockParams(ENH)) as BlockParamsDTO;
    assertEqual(JSON.stringify(c.type), JSON.stringify({ value: 2, name: roster[2]!.name }), 'classic: the type is read at its effective pid');
    const v2 = await v2Of(shifted, ENH, { [ENH]: { values, channel: 0 } });
    assertEqual(JSON.stringify(v2.type), JSON.stringify(c.type), 'classic and generic read the same type');
    assertEqual(c.enums.some((e) => e.id === 6), false, 'classic: the entry set still leaves out the catalog\'s type pid, as before');
    // the meter tile names the type from the same pid (meters() reads the grid; this one holds the enhancer alone)
    const dev = mockBlockDevice(shifted, { [ENH]: { values, channel: 0 } });
    const grid: PresetGridDTO = { model: 'fm3', name: 'T', crcValid: true, rows: 4, cols: 12, scenes: [], source: 'dump', cells: [{ row: 0, col: 0, effectId: ENH, name: 'Enhancer 1', isShunt: false, routeFlag: 0, fromRows: [] }] };
    (dev.driver as unknown as { grid: () => Promise<PresetGridDTO> }).grid = async () => grid;
    const tile = (await dev.driver.meters()).find((m) => m.effectId === ENH);
    assertEqual(tile?.typeName, roster[2]!.name, 'meters: the type name comes from the effective pid');
    console.log('  drivers/block-params-v2: a moved type selector is read at its new pid by the classic response and the meter tile');
  }

  // ---- 16. an effect id the codec knows but no family maps: the generic response names it by its id ---
  {
    // The III maps every audio block through its effect-id table since FORGEFX-45, so dropping the slug mapping no longer
    // leaves eid 70 without a family: the development hook hides the DELAY family instead (codec slug kept, no family)
    const prior = process.env.FORGEFX_DEFS_HIDE_FAMILY;
    const priorOptIn = process.env.FORGEFX_DEV_HOOKS;
    const warn = console.warn;
    console.warn = () => {};
    process.env.FORGEFX_DEV_HOOKS = '1';
    process.env.FORGEFX_DEFS_HIDE_FAMILY = 'DELAY';
    try {
      assertEqual(SLUG_FAMILY['delay'], 'DELAY', 'premise: the codec slug still names the family');
      const g = await v2Of(AXE3, DELAY, {});
      assertEqual(`${g.block}|${g.slug}|${g.page}|${g.unknownBlock}`, `Block ${DELAY}||-1|true`, 'generic: "Block <eid>", no slug, no page, marked unknown');
      assertEqual(g.definitions.family, null, 'generic: no family');
      const c = (await mockBlockDevice(AXE3, {}).driver.blockParams(DELAY)) as BlockParamsDTO;
      assertEqual(`${c.block}|${c.slug}|${c.page}`, `Delay|delay|${DELAY}`, 'classic: unchanged (the codec name, slug and page)');
    } finally {
      if (prior === undefined) delete process.env.FORGEFX_DEFS_HIDE_FAMILY;
      else process.env.FORGEFX_DEFS_HIDE_FAMILY = prior;
      if (priorOptIn === undefined) delete process.env.FORGEFX_DEV_HOOKS;
      else process.env.FORGEFX_DEV_HOOKS = priorOptIn;
      console.warn = warn;
    }
    console.log('  drivers/block-params-v2: an unmapped block with a codec slug — generic "Block <eid>" / slug "" / page -1, classic unchanged');
  }

  // ---- 17. the diagnostic hook is parsed strictly; a malformed value warns once ----------------------
  {
    const p = parseForcedGeneric('DELAY:3,5, CHORUS:8:9, 12, chorus:4, MIXER:99999, FUZZ:43,,');
    const pids = Object.fromEntries([...p.pids].map(([f, s]) => [f, [...s]]));
    assertEqual(JSON.stringify(pids), JSON.stringify({ DELAY: [3, 5], FUZZ: [43] }), 'FAMILY:pid entries, a bare pid joins the family before it');
    assertEqual(JSON.stringify(p.malformed), JSON.stringify(['CHORUS:8:9', '12', 'chorus:4', 'MIXER:99999']), 'malformed: an extra field, a bare pid after a malformed entry, lower case, no wire pid');
    assertEqual(JSON.stringify(parseForcedGeneric('8').malformed), JSON.stringify(['8']), 'a bare pid with no family before it');
    const prior = process.env.FORGEFX_DEFS_FORCE_GENERIC;
    const priorOptIn = process.env.FORGEFX_DEV_HOOKS;
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      process.env.FORGEFX_DEV_HOOKS = '1';
      process.env.FORGEFX_DEFS_FORCE_GENERIC = 'DELAY:3, CHORUS:8:9';
      const r = await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
      await v2Of(FM3, DELAY, { [DELAY]: { values: body(stride), channel: 0 } });
      assertEqual(r.enums.find((e) => e.id === 3)?.name, 'P3', 'the well-formed entry still applies');
      assertEqual(warnings.length, 1, 'one warning for a malformed value, however often it is read');
      assert(warnings[0]!.includes('"CHORUS:8:9"'), 'the warning names the malformed entry');
      const chorus = eidOfSlug('chorus');
      const ch = await v2Of(FM3, chorus, { [chorus]: { values: body(strideOf(FM3, 'CHORUS')), channel: 0 } });
      assert(ch.enums.find((e) => e.id === 8)?.generic !== true, 'the malformed CHORUS entry forces nothing');
    } finally {
      console.warn = realWarn;
      if (prior === undefined) delete process.env.FORGEFX_DEFS_FORCE_GENERIC;
      else process.env.FORGEFX_DEFS_FORCE_GENERIC = prior;
      if (priorOptIn === undefined) delete process.env.FORGEFX_DEV_HOOKS;
      else process.env.FORGEFX_DEV_HOOKS = priorOptIn;
    }
    console.log('  drivers/block-params-v2: FORGEFX_DEFS_FORCE_GENERIC — strict FAMILY:pid[,pid...] entries, malformed ones ignored with one warning');
  }

  // ---- 18. definitions.channel is the channel whose slice is served ----------------------------------
  {
    const values = body(stride, 2); // the body carries channels A and B only
    const r = await v2Of(FM3, DELAY, { [DELAY]: { values, channel: 3 } });
    assertEqual(r.definitions.channel, 1, 'status says D, the body ends at B: B is served and reported');
    assertEqual(r.named.find((n) => n.id === 0)!.norm, values[stride + 0]! / 65534, 'the values are channel B\'s');
    console.log('  drivers/block-params-v2: definitions.channel reports the clamped slice channel');
  }

  // ---- 19. the generic GLOBAL response reads nothing from the device -----------------------------------
  {
    const dev = mockBlockDevice(FM3, { [GLOBAL_EID]: { values: new Array<number>(136).fill(1234), channel: null } });
    const r = (await dev.driver.blockParams(GLOBAL_EID, { generic: true })) as BlockParamsV2DTO;
    assertEqual(dev.mock.sent.length, 0, 'no status read, no body read');
    assertEqual(r.named.length + r.enums.length, 186, 'every GLOBAL param is still listed');
    assert(allEntries(r).every((e) => e.value === null && e.unresolved === 'non-positional'), 'all null / non-positional');
    assertEqual(r.readError, undefined, 'nothing failed');
    assertEqual(r.definitions.positional, false, 'not positional');
    await dev.driver.readDeviceEditState();
    assertEqual(dev.mock.sent.length, 0, 'the device-edit poll leaves the block alone');
    await dev.driver.blockParams(GLOBAL_EID);
    assert(dev.mock.sent.length > 0, 'the classic response still reads the block');
    console.log('  drivers/block-params-v2: generic GLOBAL — served from the definitions alone, no device read');
  }

  // ---- 20. concurrent status reads share one request; each caller keeps its own retry ------------------
  {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const ok = statusRig();
    ok.hold();
    const both = Promise.all([ok.driver.sceneState(), ok.driver.getActiveChannels()]);
    await settle();
    ok.release();
    const [scene, chans] = await both;
    assertEqual(ok.timeouts.length, 1, 'two callers while one request is pending: one request');
    assertEqual(chans.get(DELAY), 2, 'the poll gets the shared answer');
    assert(scene.some((s) => s.effectId === DELAY && s.channel === 'C'), 'and so does the scene read');
    // the shared reply is lost: the scene read retries on its own, the poll does not
    const lostOne = statusRig({ lost: 1 });
    lostOne.hold();
    const again = Promise.all([lostOne.driver.sceneState(), lostOne.driver.getActiveChannels()]);
    await settle();
    lostOne.release();
    const [scene2, chans2] = await again;
    assertEqual(chans2.size, 0, 'the poll takes the lost reply as it is');
    assert(scene2.some((s) => s.effectId === DELAY && s.channel === 'C'), 'the scene read asked again and got the channel');
    assertEqual(lostOne.timeouts.length, 2, 'one shared request plus the scene read\'s own retry');
    // a request issued after the shared one settled is a new one
    await ok.driver.getActiveChannels();
    assertEqual(ok.timeouts.length, 2, 'a later caller asks again');
    console.log('  drivers/block-params-v2: concurrent status reads coalesce into one request; retries stay per caller');
  }

  // ---- 21. a block without channels is read without asking for the status ------------------------------
  {
    const dev = mockBlockDevice(FM3, {
      [GLOBAL_EID]: { values: new Array<number>(136).fill(1234), channel: null },
      2: { values: new Array<number>(130).fill(1000), channel: null },
    });
    await dev.driver.blockParams(GLOBAL_EID);
    await dev.driver.blockParams(2);
    const ctrl = await dev.driver.blockParams(2, { generic: true });
    assertEqual(dev.mock.sent.filter((f) => compactHex(f) === statusHex).length, 0, 'no status request for GLOBAL or CONTROLLERS');
    assertEqual(dev.mock.sent.length, 3, 'one body read per response');
    assert(allEntries(ctrl).length > 0 && allEntries(ctrl).every((e) => e.value !== null), 'CONTROLLERS values still resolve');
    console.log('  drivers/block-params-v2: channel-less blocks (GLOBAL classic, CONTROLLERS) send no status request');
  }

  // ---- 22. the generic layout follows names that moved; a name the device dropped leaves its control unbound ---
  {
    // a synthetic Rotary: a row inserted at pid 3 moves C and MODE (the variant selector) up one pid; the row
    // at 2 became an unused slot; E and F are an identical pair, so E's name cannot follow its row
    const ROT = eidOfSlug('rotary');
    const F = (min: number, max: number, typecode: number): RangeDef => ({ kind: 'float', displayMin: min, displayMax: max, scale: 1, step: 0.01, typecode });
    const unused: RangeDef = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
    const mode: RangeDef = { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 };
    const defs: ParamDef[] = [
      { paramId: 0, name: 'ROTARY_MUTE1' }, { paramId: 1, name: 'ROTARY_A' }, { paramId: 2, name: 'ROTARY_B' }, { paramId: 3, name: 'ROTARY_C' },
      { paramId: 4, name: 'ROTARY_MODE', unit: 'enum' }, { paramId: 5, name: 'ROTARY_E' }, { paramId: 6, name: 'ROTARY_F' },
      { paramId: 0xff06, name: 'ROTARY_BTN_MUTE1', unit: 'enum' },
    ];
    const rows: Record<number, RangeDef> = { 0: F(0, 1, 0x21), 1: F(0, 10, 0x31), 2: F(0, 20, 0x41), 3: F(-5, 5, 0x51), 4: mode, 5: F(0, 100, 0x61), 6: F(0, 100, 0x61) };
    const ctl = (paramName: string | null, paramId: number | null, extra: Partial<DeviceLayoutControl> = {}): DeviceLayoutControl =>
      ({ label: paramName ?? '', paramName, paramId, widget: 'knob', rawWidget: 'knob', ...extra });
    const editor: DeviceLayout = {
      editorName: 'Rotary', family: 'ROTARY', variantName: 'v', variantValue: null,
      pages: [{ name: 'p', rows: [{ section: 'parameters', controls: [
        ctl('ROTARY_BTN_MUTE1', 0xff06, { widget: 'button', rawWidget: 'button' }),
        ctl('ROTARY_A', 1), ctl('ROTARY_B', 2), ctl('ROTARY_C', 3), ctl('ROTARY_MODE', 4, { widget: 'dropdown', rawWidget: 'dropdown' }),
        ctl('ROTARY_E', 5), ctl('ROTARY_F', 6), ctl('ROTARY_B', 2, { widget: 'meter', rawWidget: 'meter' }),
        ctl('DELAY_TIME', 3, { crossBlock: { effect: 'ID_DELAY1', family: 'DELAY', paramName: 'DELAY_TIME', paramId: 3 } }),
        ctl('ROTARY_C', 3, { crossBlock: { effect: 'ID_ROTARY2', family: 'ROTARY', paramName: 'ROTARY_C', paramId: 3 } }),
        ctl(null, null, { widget: 'spacer', rawWidget: 'spacer' }),
      ] }] }],
    };
    const editorJson = JSON.stringify(editor);
    const seen: Array<{ variant: number | undefined; mode: number | undefined }> = [];
    const S = {
      ...FM3,
      params: { ...FM3.params, ROTARY: defs },
      ranges: { ...FM3.ranges, ROTARY: rows },
      rangeSections: { ...FM3.rangeSections, ROTARY: { stride: 7, recordCount: 7 } },
      enumLabelsFor: (fam: string, pid: number) => (fam === 'ROTARY' ? (pid === 4 ? ['X', 'Y', 'Z'] : undefined) : FM3.enumLabelsFor(fam, pid)),
      editorLayouts: undefined,
      layoutFor: (fam: string, variant?: number, selectors?: SelectorValues) => {
        if (fam !== 'ROTARY') return FM3.layoutFor(fam, variant, selectors);
        seen.push({ variant, mode: selectors?.('ROTARY_MODE') });
        return editor;
      },
    } as DeviceProfile;
    const built = {
      ranges: { ROTARY: { 0: rows[0], 1: rows[1], 2: unused, 3: F(0, 1, 0x71), 4: rows[3], 5: mode, 6: rows[5], 7: rows[6] } },
      enumOverrides: { ROTARY: { 5: ['X', 'Y', 'Z'] } },
      rangeSections: { ROTARY: { sectionTag: 1, stride: 8, recordCount: 8 } },
      rosters: {}, cabIrs: {}, unmappedSections: [], unmappedFamilies: [], model: 0x11, firmware: '99.0',
      meta: { schema: CACHE_SCHEMA, source: 'editor-cache', recordCount: 8 },
    } as unknown as BuiltCache;
    const P = runtimeProfileFrom(built, S);
    const idx = buildParamIndex(P, 'ROTARY');
    assertEqual([...idx.namedAt].sort((x, y) => x[0] - y[0]).map(([c, at]) => `${c}>${at}`).join(','), '0>0,1>1,3>4,4>5,6>6', 'premise: C and MODE moved, B was dropped, E lost its name');
    assertEqual(`${idx.variantPid}/${idx.hidden.map((h) => `${h.id}:${h.reason}`).join(',')}`, '5/2:removed', 'premise: the variant selector followed its name; B is removed');

    const dev = mockGen3Device(P, [ROT]);
    const v2 = await dev.driver.blockParams(ROT, { generic: true });
    const controls = v2.layout!.pages[0]!.rows[0]!.controls;
    const show = (c: DeviceLayoutControl) =>
      `${c.paramName}:${c.paramId}${c.movedFrom !== undefined ? `<${c.movedFrom}` : ''}${c.unbound ? ':unbound' : ''}${c.boundParamId !== undefined ? `=>${c.boundParamId}` : ''}${c.crossBlock ? `@${c.crossBlock.family}:${c.crossBlock.paramId}` : ''}`;
    assertEqual(controls.map(show).join(' '),
      'ROTARY_BTN_MUTE1:65286=>0 ROTARY_A:1 ROTARY_B:2:unbound ROTARY_C:4<3 ROTARY_MODE:5<4 ROTARY_E:5:unbound ROTARY_F:6 ROTARY_B:2 DELAY_TIME:3@DELAY:3 ROTARY_C:4<3@ROTARY:4 null:null',
      'moved names are followed (movedFrom), dropped and lost names unbound (not a display-only meter), the button bound, another family untouched, a reference to this family followed');
    assert(controls[1] === editor.pages[0]!.rows[0]!.controls[1], 'an untouched control is served as it is');
    assertEqual(JSON.stringify(editor), editorJson, 'the editor layout itself is not modified');
    // the variant and the page selectors are read where the names sit now: MODE's value is the one at pid 5
    const modeEntry = v2.enums.find((e) => e.id === 5)!;
    assertEqual(`${modeEntry.name}/${modeEntry.value}`, 'MODE/2', 'premise: the selector is served at 5 with value 2');
    assertEqual(JSON.stringify(seen.at(-1)), JSON.stringify({ variant: 2, mode: 2 }), 'the layout variant and selector values come from pid 5');

    // the classic response serves the editor layout exactly as it is
    const classic = await dev.driver.blockParams(ROT);
    assertEqual(JSON.stringify(classic.layout), editorJson, 'the classic layout is unchanged');
    // without a profile nothing moved: only the button is bound
    const plain = await mockGen3Device(S, [ROT]).driver.blockParams(ROT, { generic: true });
    const plainControls = plain.layout!.pages[0]!.rows[0]!.controls;
    assertEqual(plainControls.filter((c) => c.movedFrom !== undefined || c.unbound).length, 0, 'catalog only: no control moved or unbound');
    assertEqual(plainControls[0]!.boundParamId, 0, 'catalog only: the button is bound');
    console.log('  drivers/block-params-v2: generic layout follows moved names (movedFrom), unbinds dropped / lost names; buttons, other families and the classic layout unchanged');
  }

  // ---- 23. a byte-exact Axe-Fx III profile: the gain-reduction meters stay bound --------------------------------
  {
    // the III's static table makes rows up from inline bounds (synthetic) where its device cache has none; a
    // byte-exact profile hides them as removed, but that says nothing about the device: the meters still work
    const controlsOf = (r: BlockParamsV2DTO) => (r.layout?.pages ?? []).flatMap((pg) => pg.rows.flatMap((row) => row.controls));
    const exact = runtimeProfileFrom(catalogBuilt(0x10), AXE3);
    for (const [slug, fam, name] of [['comp', 'COMP', 'COMP_GAINMONITOR'], ['gate', 'GATE', 'GATE_GAINMONITOR']] as const) {
      const eid = eidOfSlug(slug);
      const pid = AXE3.params[fam]!.find((d) => d.name === name)!.paramId;
      assertEqual(AXE3.ranges[fam]![pid]?.synthetic, true, `premise: ${name} has a row made up from inline bounds`);
      const r = await mockGen3Device(exact, [eid]).driver.blockParams(eid, { generic: true });
      assert(r.definitions.hidden.some((h) => h.id === pid && h.reason === 'removed'), `premise: ${name} is hidden as removed`);
      const meters = controlsOf(r).filter((c) => c.paramName === name);
      assert(meters.length > 0 && meters.every((c) => c.widget === 'meter'), `premise: the layout draws ${name} as a meter`);
      assert(meters.every((c) => c.unbound === undefined && c.paramId === pid && c.movedFrom === undefined), `${name}: the meter stays bound to pid ${pid}`);
    }
    // a device-mined row the profile dropped still unbinds its control on the III
    const comp = eidOfSlug('comp');
    const plain = await mockGen3Device(exact, [comp]).driver.blockParams(comp, { generic: true });
    const knob = controlsOf(plain).find((c) => {
      const row = c.paramId !== null && c.paramId <= 0x3fff ? AXE3.ranges.COMP![c.paramId] : undefined;
      return c.widget === 'knob' && !c.crossBlock && !!row && !row.synthetic && isInformativeRow(row);
    });
    assert(knob !== undefined, 'premise: the III Compressor layout has a knob on a device-mined row');
    const b = catalogBuilt(0x10);
    (b.ranges.COMP as Record<number, RangeDef>)[knob.paramId!] = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
    const dropped = await mockGen3Device(runtimeProfileFrom(b, AXE3), [comp]).driver.blockParams(comp, { generic: true });
    const gone = controlsOf(dropped).filter((c) => c.paramName === knob.paramName);
    assert(gone.length > 0 && gone.every((c) => c.unbound === true), `${knob.paramName}: a device-mined row the profile dropped unbinds its control`);
    console.log('  drivers/block-params-v2: byte-exact III — gain-reduction meters (inline-bound rows) stay bound; a dropped device row still unbinds');
  }
  // ---- 24. a pending status request is joined only by a caller that would not wait longer ------------------------
  {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    // slow link: the poll's 1.5 s request is pending when a block read wants its 4 s one; joining would cut the
    // block read's wait to 1.5 s exactly when the unit is busy. It asks on its own (the queue sends it after the poll's).
    const busy = statusRig({ lost: 1, slow: true });
    busy.hold();
    const poll = busy.driver.getActiveChannels();
    await settle();
    const read = busy.driver.blockParams(DELAY, { generic: true });
    await settle();
    busy.release();
    const [chans, r] = await Promise.all([poll, read]);
    assertEqual(busy.timeouts.join(','), '1500,4000', 'slow link: the block read does not join the poll\'s shorter request');
    assertEqual(chans.size, 0, 'the poll takes its lost reply as it is');
    assertEqual(r.definitions.channel, 2, 'the block read gets the channel from its own request, without a retry');
    // a caller that waits no longer than the pending request joins it: the poll joins a block read's 4 s request
    const joined = statusRig({ slow: true });
    joined.hold();
    const first = joined.driver.blockParams(DELAY, { generic: true });
    await settle();
    const second = joined.driver.getActiveChannels();
    await settle();
    joined.release();
    const [r1, c2] = await Promise.all([first, second]);
    assertEqual(joined.timeouts.join(','), '4000', 'the poll joins the pending longer request');
    assertEqual(`${r1.definitions.channel}/${c2.get(DELAY)}`, '2/2', 'both get its answer');
    // after the longer request settled, a new caller asks again
    await joined.driver.getActiveChannels();
    assertEqual(joined.timeouts.join(','), '4000,1500', 'a later caller asks again');
    console.log('  drivers/block-params-v2: a pending status request is joined only by a caller with no longer timeout (slow link: block read 4 s beside the 1.5 s poll)');
  }

  // ---- 25. over the serialised queue: a status read after an awaited write never gets a reply from before it ------
  {
    const clock = new VirtualClock();
    const link = new FakeLink(clock);
    const queue = new QueueTransport(link); // ONE transport: the driver asks for it on every operation
    const driver = createGen3Driver(FM3, { transport: async () => queue, emit: () => {}, getCadence: () => cadenceFor(0x11, 'balanced') });
    // the unit answers each status request 40 ms later: channel A before the write, channel C after it
    let statusRequests = 0;
    let wrote = false;
    link.device = (bytes, at) => {
      if (bytes[5] === 0x01) wrote = true;
      if (compactHex(bytes) !== statusHex) return;
      statusRequests++;
      link.emitAt(at + 40, sysex(0x11, 0x13, [...enc14(DELAY), (wrote ? 2 : 0) << 1]));
    };
    const poll = track(clock, driver.getActiveChannels()); // a status request goes out first and is pending...
    const after = track(clock, (async () => {
      await driver.setParam(DELAY, 0, 0.5, true); // ...when a caller writes and waits for the write,
      return driver.getActiveChannels(); //            then reads the status again
    })());
    await clock.advanceTo(5000);
    assert(poll.done && after.done, 'both callers finished');
    assertEqual(poll.value!.get(DELAY), 0, 'the pending request gets the reply from before the write');
    assertEqual(after.value!.get(DELAY), 2, 'the read after the awaited write gets a reply from after it');
    assertEqual(statusRequests, 2, 'it issued its own request: the earlier one had settled before the write went out');
    const order = link.sent.map((s) => (compactHex(s.bytes) === statusHex ? 'status' : s.bytes[5] === 0x01 ? 'write' : 'other')).join(',');
    assertEqual(order, 'status,write,status', 'the queue serialises status, write, status');
    console.log('  drivers/block-params-v2: over the serialised queue a status read after an awaited write asks again (never a reply from before the write)');
  }
}
