// Block state on the block-params response: Scene Ignore + Bypass Mode (additive `blockState`, cap `blockState`).
//
// WHICH param each one is comes from the codec (`blockStateParams`: by name in the model's own catalog);
// the value is the block's active-channel enum read, and the write is the ordinary enum write (setParam with
// continuous:false → the codec's discrete SET, sub 09 00, carrying THIS model's byte). The suite pins:
//   • the per-device ids on the amp block: FM3 137, FM9 6 (the shared block header), Axe-Fx III 135 — each
//     read from the mocked bulk read, and equal to the block's own enums[] entry (header and board in sync);
//   • the bypass-mode options carry the device labels and the codec's muting classification;
//   • the write frame for each model: buildSetParameter(eid, pid, ordinal) with the model byte at [4];
//   • the firmware gate: a known firmware below the gate → supported:false + reason; unknown → supported;
//   • families without a param → null; the capability: true on III / FM3 / FM9, false on VP4 / AM4 / gen-1/2.
// Mocked transport, no hardware.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { createVp4Driver } from '../../src/drivers/vp4.js';
import { createAm4Driver } from '../../src/drivers/am4.js';
import { createGen1Driver } from '../../src/drivers/gen1.js';
import { createGen2Driver } from '../../src/drivers/gen2.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { SLUG_FAMILY, profileForModel } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import type { DriverCtx } from '../../src/drivers/types.js';
import { effectRoster, blockStateParams } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

export const BLOCK_STATE_CASE_COUNT = 8;

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

/** fn=0x13 status dump: id-id-dd triples, dd = (channel << 1) | bypassed. */
function statusFrame(model: number, effectId: number, channel: number): number[] {
  return sysex(model, 0x13, [...enc14(effectId), (channel & 0x07) << 1]);
}

/** A driver on a mocked gen-3 unit whose bulk read answers `raw` (paramId -> wire value) for the `slug` block,
 *  on channel A; `opts.channel` makes that channel the active one (status read) and `opts.byChannel` fills
 *  the other channel slices; `opts.silent` answers no bulk read at all (a failed read). */
function driverWith(
  profile: DeviceProfile,
  slug: string,
  raw: Record<number, number>,
  firmware: { major: number; minor: number } | null = null,
  opts: { channel?: number; byChannel?: Record<number, Record<number, number>>; silent?: boolean } = {}
) {
  const eid = eidOf(slug);
  const family = SLUG_FAMILY[slug]!;
  const stride = profile.rangeSections[family]!.stride;
  const codec = createModernFractalCodec(profile.model);
  const values = new Array<number>(stride * 4).fill(0);
  for (const [pid, v] of Object.entries(raw)) values[Number(pid)] = v;
  for (const [ch, rawCh] of Object.entries(opts.byChannel ?? {})) {
    for (const [pid, v] of Object.entries(rawCh)) values[Number(ch) * stride + Number(pid)] = v;
  }
  const bulk = blockBulkFrames(profile.model, eid, values);
  const mock = new MockTransport('serial', 'mock-block-state');
  mock.isOpen = true;
  const pollHex = compactHex(codec.buildBlockBulkReadPoll(eid));
  const statusHex = compactHex(codec.buildStatusDump());
  mock.reply = (req) => {
    const h = compactHex(req);
    if (h === statusHex && opts.channel != null) return [statusFrame(profile.model, eid, opts.channel)];
    if (h === pollHex && !opts.silent) return bulk;
    return [];
  };
  const driver = createGen3Driver(profile, {
    transport: async () => mock,
    emit: () => {},
    getCadence: () => cadenceFor(null, 'balanced'),
    getFirmware: () => firmware
  });
  return { driver, mock, eid, codec };
}

const ctxFor = (mock: MockTransport): DriverCtx => ({ transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });

export async function runBlockStateTests(): Promise<void> {
  const devices: Array<{ label: string; model: number; ampSi: number }> = [
    { label: 'FM3', model: FM3, ampSi: 137 },
    { label: 'FM9', model: FM9, ampSi: 6 },
    { label: 'Axe-Fx III', model: AXE3, ampSi: 135 },
  ];

  // ---- Case 1: amp Scene Ignore id per device, read from the bulk, in sync with the enums[] entry ----
  for (const d of devices) {
    const prof = profileForModel(d.model);
    const facts = blockStateParams(d.model, 'DISTORT');
    assertEqual(facts.sceneIgnore?.paramId, d.ampSi, `${d.label} amp Scene Ignore id from the codec`);
    for (const on of [0, 1]) {
      const { driver, eid } = driverWith(prof, 'amp', { [d.ampSi]: on, [facts.bypassMode!.paramId]: 1 });
      const r = await driver.blockParams(eid);
      const si = r.blockState.sceneIgnore;
      assert(!!si, `${d.label} amp blockState.sceneIgnore present`);
      assertEqual(si!.paramId, d.ampSi, `${d.label} amp sceneIgnore.paramId`);
      assertEqual(si!.value, on, `${d.label} amp sceneIgnore.value (raw ${on})`);
      assertEqual(si!.supported, true, `${d.label} amp sceneIgnore supported (firmware unknown)`);
      assertEqual(si!.reason, undefined, `${d.label} no reason when supported`);
      const board = r.enums.find((e) => e.id === d.ampSi);
      assert(!!board, `${d.label} the amp's Scene Ignore is also a board enum`);
      assertEqual(board!.value, si!.value, `${d.label} header and board read the same value`);
      // a different device's id is NOT what this device tags
      for (const other of devices) {
        if (other.model === d.model || other.ampSi === d.ampSi) continue;
        assert(si!.paramId !== other.ampSi, `${d.label} does not tag ${other.label}'s id ${other.ampSi}`);
      }
    }
  }
  console.log('  drivers/block-state: amp Scene Ignore FM3 137 / FM9 6 / III 135, value from the active-channel read, equal to the board enum');

  // ---- Case 2: bypass-mode options carry the device labels + the muting classification ----
  {
    const prof = profileForModel(FM3);
    const amp = blockStateParams(FM3, 'DISTORT').bypassMode!;
    const { driver, eid } = driverWith(prof, 'amp', { [amp.paramId]: 1 });
    const bm = (await driver.blockParams(eid)).blockState.bypassMode;
    assert(!!bm, 'FM3 amp bypassMode present');
    assertEqual(bm!.paramId, 3, 'FM3 amp bypass mode id');
    assertEqual(bm!.value, 1, 'FM3 amp bypass mode value (MUTE)');
    assertEqual(JSON.stringify(bm!.options), JSON.stringify([{ value: 0, label: 'THRU', muting: false }, { value: 1, label: 'MUTE', muting: true }]), 'FM3 amp options THRU / MUTE');

    const dly = blockStateParams(FM3, 'DELAY').bypassMode!;
    const r = await driverWith(prof, 'delay', { [dly.paramId]: 2 }).driver.blockParams(eidOf('delay'));
    const dbm = r.blockState.bypassMode!;
    assertEqual(dbm.options.map((o) => o.label).join('|'), 'THRU|MUTE FX OUT|MUTE OUT|MUTE FX IN|MUTE IN', 'FM3 delay offers 5 modes');
    assertEqual(dbm.options.filter((o) => o.muting).map((o) => o.value).join(','), '2,4', 'FM3 delay: MUTE OUT + MUTE IN silence');
    assertEqual(dbm.value, 2, 'FM3 delay bypass mode value');
    assertEqual(r.blockState.sceneIgnore?.paramId, 83, 'FM3 delay Scene Ignore id');
  }
  console.log('  drivers/block-state: bypass-mode options = device labels + muting flags (FM3 amp THRU/MUTE, delay 5 modes)');

  // ---- Case 3: the write is the ordinary discrete SET, with each model's byte ----
  for (const d of devices) {
    const { driver, mock, eid, codec } = driverWith(profileForModel(d.model), 'amp', {});
    mock.sent.length = 0;
    await driver.setParam(eid, d.ampSi, 1, false);
    assertEqual(mock.sent.length, 1, `${d.label}: one frame written`);
    const frame = mock.sent[0]!;
    assertEqual(compactHex(frame), compactHex(codec.buildSetParameter(eid, d.ampSi, 1)), `${d.label}: buildSetParameter(eid, pid, 1)`);
    assertEqual(frame[4], d.model, `${d.label}: the frame carries the model byte 0x${d.model.toString(16)}`);
    assertEqual(frame[5], 0x01, `${d.label}: fn 0x01`);
    assertEqual(`${frame[6]!.toString(16).padStart(2, '0')}${frame[7]!.toString(16).padStart(2, '0')}`, '0900', `${d.label}: discrete sub-action 09 00`);
    assertEqual((frame[8]! | (frame[9]! << 7)), eid, `${d.label}: effect id`);
    assertEqual((frame[10]! | (frame[11]! << 7)), d.ampSi, `${d.label}: param id`);
  }
  console.log('  drivers/block-state: Scene Ignore writes = buildSetParameter (fn 0x01, sub 09 00) with the model byte (0x11 / 0x12 / 0x10)');

  // ---- Case 4: firmware gate ----
  {
    const prof = profileForModel(FM3);
    const gate = async (slug: string, fw: { major: number; minor: number } | null) =>
      (await driverWith(prof, slug, {}, fw).driver.blockParams(eidOf(slug))).blockState.sceneIgnore!;
    const below = await gate('amp', { major: 5, minor: 2 });
    assertEqual(below.supported, false, 'FM3 5.02: Scene Ignore not supported');
    assertEqual(below.reason, 'Needs firmware ≥ 5.03', 'FM3 5.02: reason names the gate');
    assertEqual(below.paramId, 137, 'the gated entry still names its param');
    const at = await gate('amp', { major: 5, minor: 3 });
    assertEqual(at.supported, true, 'FM3 5.03: supported');
    assertEqual(at.reason, undefined, 'FM3 5.03: no reason');
    assertEqual((await gate('amp', null)).supported, true, 'unknown firmware: not gated');
    const ring = await gate('ringmod', { major: 11, minor: 0 });
    assertEqual(ring.supported, false, 'FM3 RINGMOD on 11.00: not supported');
    assertEqual(ring.reason, 'Needs firmware ≥ 11.01', 'FM3 RINGMOD gate 11.01');
    assertEqual((await gate('ringmod', { major: 12, minor: 0 })).supported, true, 'FM3 RINGMOD on 12.00: supported');
    const fm9 = await driverWith(profileForModel(FM9), 'amp', {}, { major: 2, minor: 2 }).driver.blockParams(eidOf('amp'));
    assertEqual(fm9.blockState.sceneIgnore?.reason, 'Needs firmware ≥ 2.03', 'FM9 2.02: gate 2.03');
    const iii = await driverWith(profileForModel(AXE3), 'amp', {}, { major: 19, minor: 4 }).driver.blockParams(eidOf('amp'));
    assertEqual(iii.blockState.sceneIgnore?.reason, 'Needs firmware ≥ 19.05', 'III 19.04: gate 19.05');
  }
  console.log('  drivers/block-state: firmware gate (FM3 5.03, RINGMOD 11.01, FM9 2.03, III 19.05; unknown firmware not gated)');

  // ---- Case 5: families without a param → null ----
  {
    const prof = profileForModel(FM3);
    const vol = (await driverWith(prof, 'volume', {}).driver.blockParams(eidOf('volume'))).blockState;
    assertEqual(vol.sceneIgnore, null, 'FM3 VOLUME has no Scene Ignore');
    assert(vol.bypassMode !== null, 'FM3 VOLUME has a bypass mode');
    const enh = (await driverWith(prof, 'enhancer', {}).driver.blockParams(eidOf('enhancer'))).blockState;
    assert(enh.sceneIgnore !== null, 'FM3 ENHANCER has Scene Ignore');
    assertEqual(enh.bypassMode, null, 'FM3 ENHANCER has no bypass mode');
  }
  console.log('  drivers/block-state: a family without the param serves null (VOLUME: no Scene Ignore; ENHANCER: no bypass mode)');

  // ---- Case 7: per channel — channel B active reads channel B's values, not channel A's ----
  {
    const prof = profileForModel(FM3);
    const amp = blockStateParams(FM3, 'DISTORT');
    const si = amp.sceneIgnore!.paramId;
    const bm = amp.bypassMode!.paramId;
    // channel A: Scene Ignore OFF, THRU; channel B: Scene Ignore ON, MUTE
    const { driver, eid } = driverWith(prof, 'amp', { [si]: 0, [bm]: 0 }, null, { channel: 1, byChannel: { 1: { [si]: 1, [bm]: 1 } } });
    const r = await driver.blockParams(eid);
    assertEqual(r.blockState.sceneIgnore?.value, 1, 'channel B active: Scene Ignore reads channel B (ON)');
    assertEqual(r.blockState.bypassMode?.value, 1, 'channel B active: Bypass Mode reads channel B (MUTE)');
    assertEqual(r.enums.find((e) => e.id === si)?.value, 1, 'the board enum is the same channel B value');
    const a = await driverWith(prof, 'amp', { [si]: 0, [bm]: 0 }, null, { channel: 0, byChannel: { 1: { [si]: 1, [bm]: 1 } } }).driver.blockParams(eid);
    assertEqual(a.blockState.sceneIgnore?.value, 0, 'channel A active: Scene Ignore reads channel A (OFF)');
    assertEqual(a.blockState.bypassMode?.value, 0, 'channel A active: Bypass Mode reads channel A (THRU)');
  }
  console.log('  drivers/block-state: the values are the active channel\'s (B: ON / MUTE vs A: OFF / THRU)');

  // ---- Case 8: a failed read is flagged, not served as "the block has none" ----
  {
    const r = await driverWith(profileForModel(FM3), 'amp', {}, null, { silent: true }).driver.blockParams(eidOf('amp'));
    assertEqual(JSON.stringify(r.blockState), JSON.stringify({ sceneIgnore: null, bypassMode: null, readError: true }), 'no bulk reply: readError, no members');
    const ok = await driverWith(profileForModel(FM3), 'amp', {}).driver.blockParams(eidOf('amp'));
    assertEqual(ok.blockState.readError, undefined, 'a decoded read carries no readError');
  }
  console.log('  drivers/block-state: a failed block read serves { readError: true } instead of empty members');

  // ---- Case 6: the capability ----
  for (const d of devices) {
    const { driver } = driverWith(profileForModel(d.model), 'amp', {});
    assertEqual(driver.capabilities.blockState, true, `${d.label} capability blockState`);
  }
  const mock = new MockTransport('serial', 'mock-block-state-caps');
  assertEqual(!!createVp4Driver(ctxFor(mock)).capabilities.blockState, false, 'VP4: no blockState (discrete writes not decoded)');
  assertEqual(!!createAm4Driver(ctxFor(mock)).capabilities.blockState, false, 'AM4: no blockState');
  assertEqual(!!createGen1Driver(ctxFor(mock)).capabilities.blockState, false, 'gen-1: no blockState');
  assertEqual(!!createGen2Driver(ctxFor(mock)).capabilities.blockState, false, 'Axe-Fx II: no blockState');
  assertEqual(JSON.stringify(blockStateParams(0x14, 'DISTORT')), '{}', 'codec: VP4 resolves nothing');
  console.log('  drivers/block-state: capability true on III / FM3 / FM9, false on VP4 / AM4 / gen-1 / Axe-Fx II');
}
