// Channel-slice geometry for gen-3 fn=0x1F block reads — the amp-model-wrong-on-channels-B-D bug.
//
// The FM3 amp block's fn=0x1F body carries ALL FOUR channels back to back: channel k's paramId p
// lives at k*stride + p. #channelSlice picks that stride from the profile's rangeSections. A
// walk-built runtime profile reports a SHORT stride there (the live walk's section meta counts the
// records it collected — 126 of FM3 DISTORT's 144 — not the section's true width), and a short
// stride is silent: base = channel*126 lands in the middle of an EARLIER channel's slice, so the
// type read at base+6 is a real, valid-looking value from the wrong param.
//
// Reproduced field-exact (FM3, firmware 13, walk-built cache):
//   • preset 068 "USA MKIIC++ lead", amp on channel B — 126*1+6 = chA paramId 132 (VPLATEMON, 0)
//     → decoded 0 → "59 Bassguy Bright" instead of "USA MK IIC++" (roster 248).
//   • preset 043 "Friedman BE metal" scene 4, amp on channel C — 126*2+6 = chB paramId 114
//     (TRIODE1RATIO, raw 23330) → the >max rescale turns it into 117 → "CA3+ Clean" instead of
//     "Friedman BE V1 Fat" (roster 259).
//
// The table stride is only a hint, whatever its origin: a static catalog stride is measured on one
// firmware (and may simply be wrong for the connected one), a live-walk stride is a lower bound.
// The reply is the tiebreaker — a stride counts only when it divides the advertised itemCount into
// 1-4 channel slices — so the cases below run against a plain static profile too, no cache involved.
// The cache overlay (runtimeProfileFrom) is provenance-aware (the real persisted `meta`: 'live',
// 'editor-cache', 'cloud' + origin): a byte-exact profile wins, everything else (a live walk, a cloud
// profile that came from one, unknown provenance) never shrinks a catalog stride.
// Channel-less families (the virtual effects GLOBAL / CONTROLLERS / MODIFIER / FC) are not channel-blocked:
// their body is one slice, so a drifted table stride must never turn into itemCount / 4 there (it would
// make decodeEditBurst drop every device edit from that paramId on) — see the decodeEditBurst cases.
// Mocked transport, no hardware — same idiom as definition-completeness.test.ts.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { runtimeProfileFrom } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const FAMILY = 'DISTORT'; // the amp block's catalog family (SLUG_FAMILY['amp'])
const TYPE_PID = 6; // DISTORT_TYPE
const TRUE_STRIDE = 144; // the DISTORT body width in the field report
const WALK_STRIDE = 126; // what the live walk reported for the same section
const ROSTER_LEN = 330;

// Roster ordinals from the field report (the roster itself is synthetic).
const MKIIC = 248;
const BE_V1_FAT = 259;
const CA3_CLEAN = 117;
const CH_D_TYPE = 12;
const CH_A_TYPE = 33;
// The params the short stride lands on, with the values the two field presets carried.
const VPLATEMON_PID = 132; // 126*1 + 6
const TRIODE1RATIO_PID = 114; // 126*2 + 6 - 144
const TRIODE1RATIO_RAW = 23330;

export const CHANNEL_SLICE_CASE_COUNT = 13;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 reply; `advertised` is the itemCount in the head frame (0 = a silent wire). */
function blockBulkFrames(effectId: number, values: readonly number[], advertised = values.length): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(advertised), 0x07]),
    sysex(0x75, body),
    sysex(0x76, []),
  ];
}

/** fn=0x13 status dump: id-id-dd triples, dd = (channel << 1) | bypassed. */
function statusFrame(effectId: number, channel: number): number[] {
  return sysex(0x13, [...enc14(effectId), (channel & 0x07) << 1]);
}

function ampEid(): number {
  const e = effectRoster().find((x) => x.slug === 'amp');
  if (!e) throw new Error("no roster entry for slug 'amp'");
  return e.page; // instance-1 effect id
}

const roster = Array.from({ length: ROSTER_LEN }, (_, value) => ({
  value,
  name: value === 0 ? '59 Bassguy Bright'
    : value === CA3_CLEAN ? 'CA3+ Clean'
    : value === MKIIC ? 'USA MK IIC++'
    : value === BE_V1_FAT ? 'Friedman BE V1 Fat'
    : `Amp ${value}`,
  manufacturer: null,
  basedOn: null,
}));

/** A static-style profile whose DISTORT section claims `stride` (whatever its origin). */
function synthProfile(stride: number, extraSections: DeviceProfile['rangeSections'] = {}): DeviceProfile {
  return {
    model: MODEL, key: 'fm3', name: 'FM3-channel-slice-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: {
      [FAMILY]: [
        { paramId: TYPE_PID, name: `${FAMILY}_TYPE`, unit: 'enum' },
        { paramId: VPLATEMON_PID, name: `${FAMILY}_VPLATEMON`, unit: 'numeric' },
        { paramId: TRIODE1RATIO_PID, name: `${FAMILY}_TRIODE1RATIO`, unit: 'numeric' },
      ],
    },
    ranges: {
      [FAMILY]: {
        [TYPE_PID]: { kind: 'enum', displayMin: 0, displayMax: ROSTER_LEN - 1, typecode: 0x10 },
        [VPLATEMON_PID]: { kind: 'float', displayMin: 0, displayMax: 1, typecode: 0x00 },
        [TRIODE1RATIO_PID]: { kind: 'float', displayMin: -200, displayMax: 200, typecode: 0x531 },
      },
    },
    rangeSections: { [FAMILY]: { sectionTag: 10, stride, recordCount: stride }, ...extraSections },
    rosterFor: () => roster,
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

/** `channels` slices of `stride`, each carrying its own amp type at TYPE_PID (A..D = 33, MKIIC, BE_V1_FAT, 12). */
function channelBody(stride: number, channels = 4): number[] {
  const values = new Array(stride * channels).fill(0);
  const types = [CH_A_TYPE, MKIIC, BE_V1_FAT, CH_D_TYPE];
  for (let ch = 0; ch < channels; ch++) values[ch * stride + TYPE_PID] = types[ch]!;
  return values;
}

/** The field body: 4 channel blocks of 144, with the two decoy values the short stride lands on. */
function fieldBody(): number[] {
  const values = channelBody(TRUE_STRIDE);
  values[0 * TRUE_STRIDE + VPLATEMON_PID] = 0; // what the short stride reads for channel B
  values[1 * TRUE_STRIDE + TRIODE1RATIO_PID] = TRIODE1RATIO_RAW; // …and for channel C
  return values;
}

async function readAmpType(
  profile: DeviceProfile,
  channel: number,
  values: readonly number[] = fieldBody(),
  advertised: number = values.length,
): Promise<{ value: number; name: string } | null> {
  const eid = ampEid();
  const codec = createModernFractalCodec(MODEL);
  const bulk = blockBulkFrames(eid, values, advertised);
  const statusHex = compactHex(codec.buildStatusDump());
  const pollHex = compactHex(codec.buildBlockBulkReadPoll(eid));
  const mock = new MockTransport('serial', 'mock-channel-slice');
  mock.isOpen = true;
  mock.reply = (req) => {
    const h = compactHex(req);
    if (h === statusHex) return [statusFrame(eid, channel)];
    if (h === pollHex) return bulk;
    return [];
  };
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return (await driver.blockParams(eid)).type;
}

export async function runChannelSliceTests(): Promise<void> {
  // ---- Case 1: the catalog stride resolves every channel's own model ------------------------
  assertEqual((await readAmpType(synthProfile(TRUE_STRIDE), 1))?.name, 'USA MK IIC++', 'catalog stride, channel B → the channel B model');
  assertEqual((await readAmpType(synthProfile(TRUE_STRIDE), 2))?.name, 'Friedman BE V1 Fat', 'catalog stride, channel C → the channel C model');
  console.log('  drivers/channel-slice: catalog stride slices channels B/C to their own amp model');

  // ---- Case 2: a walk-shortened stride must NOT drag the read off its channel ----------------
  // Before the fix these decoded to "59 Bassguy Bright" and "CA3+ Clean" — the two field reports.
  const b = await readAmpType(synthProfile(WALK_STRIDE), 1);
  const c = await readAmpType(synthProfile(WALK_STRIDE), 2);
  assert(b?.name !== '59 Bassguy Bright', 'walk-short stride must not decode channel B as roster 0');
  assert(c?.name !== 'CA3+ Clean', `walk-short stride must not rescale a decoy into roster ${CA3_CLEAN}`);
  assertEqual(b?.name, 'USA MK IIC++', 'walk-short stride, channel B → still the channel B model (wire itemCount wins)');
  assertEqual(c?.name, 'Friedman BE V1 Fat', 'walk-short stride, channel C → still the channel C model (wire itemCount wins)');
  console.log('  drivers/channel-slice: a walk-shortened stride is repaired from the body itemCount');

  // ---- Case 3: NO cache — a static stride that is wrong for the connected firmware -----------
  // The static table says 44, the reply carries 4 x 43 (itemCount 172): a catalog stride that does not
  // match the connected device. Before the reply check every channel but A read a neighbour's slice.
  const body43 = channelBody(43);
  const staticWide = synthProfile(44);
  assertEqual((await readAmpType(staticWide, 1, body43))?.name, 'USA MK IIC++', 'static stride 44 vs 4x43 body, channel B');
  assertEqual((await readAmpType(staticWide, 2, body43))?.name, 'Friedman BE V1 Fat', 'static stride 44 vs 4x43 body, channel C');
  assertEqual((await readAmpType(staticWide, 3, body43))?.name, `Amp ${CH_D_TYPE}`, 'static stride 44 vs 4x43 body, channel D');
  console.log('  drivers/channel-slice: a static catalog stride that disagrees with the reply is overruled (no cache)');

  // ---- Case 4: a short stride that happens to divide the body is still rejected --------------
  // 72 divides 4 x 144 evenly, but it would imply EIGHT channels. Accepting any divisor would read
  // channel B at index 72+6, i.e. channel A's param 78.
  const half = synthProfile(TRUE_STRIDE / 2);
  assertEqual((await readAmpType(half, 1))?.name, 'USA MK IIC++', 'stride that implies 8 channels, channel B');
  assertEqual((await readAmpType(half, 2))?.name, 'Friedman BE V1 Fat', 'stride that implies 8 channels, channel C');
  console.log('  drivers/channel-slice: a stride implying more than four channels is rejected');

  // ---- Case 5: a silent wire (itemCount 0) falls back to trusting the table -------------------
  assertEqual((await readAmpType(synthProfile(TRUE_STRIDE), 1, fieldBody(), 0))?.name, 'USA MK IIC++', 'no advertised count → the table stride is used');
  console.log('  drivers/channel-slice: with no advertised count the table stride is trusted');

  // ---- Case 6: a body that is not channel-blocked is one slice (channel A only) -------------
  const flat = new Array(150).fill(0); // 150 % 4 != 0 and the table (144) does not divide it
  flat[TYPE_PID] = CH_A_TYPE;
  assertEqual((await readAmpType(synthProfile(TRUE_STRIDE), 1, flat))?.name, `Amp ${CH_A_TYPE}`, 'not channel-blocked → every channel reads the single slice');
  console.log('  drivers/channel-slice: a non-channel-blocked body degrades to a single slice');

  // ---- Cases 7-11: runtimeProfileFrom is provenance-aware -----------------------------------------
  const staticProfile = synthProfile(TRUE_STRIDE, { FUZZ: { sectionTag: 25, stride: 44, recordCount: 44 } });
  const sections = {
    [FAMILY]: { sectionTag: 58, stride: WALK_STRIDE, recordCount: WALK_STRIDE },
    FUZZ: { sectionTag: 25, stride: 43, recordCount: 43 },
    CACHEONLY: { sectionTag: 99, stride: 7, recordCount: 7 },
  };
  const built = (meta: Record<string, unknown> | undefined) => ({
    enumOverrides: {}, ranges: {}, rosters: {}, cabIrs: {}, rangeSections: sections, ...(meta ? { meta } : {}),
  }) as never;
  const LIVE = { source: 'live', recordCount: 0 };
  const EDITOR_CACHE = { source: 'editor-cache', recordCount: 0 };
  const strideOf = (meta: Record<string, unknown> | undefined, fam: string) => runtimeProfileFrom(built(meta), staticProfile).rangeSections[fam]?.stride;

  // 7-8: a live walk's stride is a lower bound — it never shrinks the catalog's, it still adopts the rest.
  const live = runtimeProfileFrom(built(LIVE), staticProfile);
  assertEqual(live.rangeSections[FAMILY]?.stride, TRUE_STRIDE, 'live walk keeps the longer catalog stride');
  assertEqual(live.rangeSections[FAMILY]?.sectionTag, 58, 'live walk still adopts the device-observed section tag');
  assertEqual(live.rangeSections['CACHEONLY']?.stride, 7, 'live walk still contributes sections the catalog lacks');
  console.log('  drivers/channel-slice: a live walk never shrinks a catalog stride, adopts cache-only sections');

  // 9: a byte-exact profile (an editor-cache import, or a cloud profile published from one) is the
  // device's own data, so it wins even when it is SHORTER than the static catalog (catalog 44 vs 43).
  const bytes = runtimeProfileFrom(built(EDITOR_CACHE), staticProfile);
  assertEqual(bytes.rangeSections['FUZZ']?.stride, 43, 'editor-cache import overrides a catalog stride that does not match its firmware');
  assertEqual(bytes.rangeSections[FAMILY]?.stride, WALK_STRIDE, 'editor-cache import is taken as-is, not subject to the live-walk lower-bound rule');
  assertEqual(strideOf({ source: 'cloud', origin: 'bytes', recordCount: 0 }, 'FUZZ'), 43, 'a cloud profile published from an editor cache is byte-exact too');
  console.log('  drivers/channel-slice: a byte-exact stride overrides the catalog, even a shorter one');

  // 9b: a pulled cloud profile keeps source 'cloud' and its build kind in `origin`; one that came from a
  // live walk (or has no/unknown origin or no source at all) is NOT byte-exact and must not shrink strides.
  assertEqual(strideOf({ source: 'cloud', origin: 'live', recordCount: 0 }, FAMILY), TRUE_STRIDE, 'a cloud profile published from a live walk never shrinks a catalog stride');
  assertEqual(strideOf({ source: 'cloud', recordCount: 0 }, FAMILY), TRUE_STRIDE, 'a cloud profile without an origin never shrinks a catalog stride');
  assertEqual(strideOf({ recordCount: 0 }, FAMILY), TRUE_STRIDE, 'a profile without a source never shrinks a catalog stride');
  assertEqual(strideOf(undefined, FAMILY), TRUE_STRIDE, 'a profile without meta never shrinks a catalog stride');
  console.log('  drivers/channel-slice: cloud-from-live and unknown provenance get the live-walk treatment');

  // 10: the overlaid live profile still reads every channel correctly end to end.
  assertEqual((await readAmpType(live, 2))?.name, 'Friedman BE V1 Fat', 'overlaid live profile, channel C → the channel C model');
  console.log('  drivers/channel-slice: an overlaid live profile reads channel C correctly');

  await runChannelSliceEditBurstTests();
}

// ---- Cases 12-13: decodeEditBurst through the same geometry -------------------------------------
const VIRTUAL_EID = 2; // the CONTROLLERS virtual effect (no codec slug, resolves through the profile)
const EDIT_LOW_PID = 5;
const EDIT_LATE_PID = 50; // beyond itemCount / 4 of a 132-value body (33)

/** A profile with a channel-less CONTROLLERS family and the audio DISTORT family, both with drifted table strides. */
function editProfile(controllersStride: number, distortStride: number): DeviceProfile {
  const flt = (hi = 1) => ({ kind: 'float', displayMin: 0, displayMax: hi, typecode: 0 });
  return {
    model: MODEL, key: 'fm3', name: 'FM3-edit-burst-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: {
      CONTROLLERS: [
        { paramId: EDIT_LOW_PID, name: 'CONTROLLERS_LOW', unit: 'numeric' },
        { paramId: EDIT_LATE_PID, name: 'CONTROLLERS_LATE', unit: 'numeric' },
      ],
      [FAMILY]: [
        { paramId: EDIT_LOW_PID, name: `${FAMILY}_LOW`, unit: 'numeric' },
        { paramId: 149, name: `${FAMILY}_LATE`, unit: 'numeric' }, // beyond the drifted table stride (144)
      ],
    },
    ranges: {
      CONTROLLERS: { [EDIT_LOW_PID]: flt(), [EDIT_LATE_PID]: flt() },
      [FAMILY]: { [EDIT_LOW_PID]: flt(), 149: flt() },
    },
    rangeSections: {
      CONTROLLERS: { sectionTag: 2, stride: controllersStride, recordCount: controllersStride },
      [FAMILY]: { sectionTag: 10, stride: distortStride, recordCount: distortStride },
    },
    rosterFor: () => [],
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: (eid: number) => (eid === VIRTUAL_EID ? 'CONTROLLERS' : undefined),
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

/** Prime the edit snapshot with `before`, then diff `after`: the paramIds decodeEditBurst reports as moved. */
function editedPids(profile: DeviceProfile, eid: number, before: readonly number[], after: readonly number[]): number[] {
  const mock = new MockTransport('serial', 'mock-edit-burst');
  mock.isOpen = true;
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const first = driver.decodeEditBurst(blockBulkFrames(eid, before));
  assertEqual(first.reload, true, 'first sight of a block asks for a reload (snapshot primed)');
  return driver.decodeEditBurst(blockBulkFrames(eid, after)).events.map((e) => e.paramId).sort((a, b) => a - b);
}

async function runChannelSliceEditBurstTests(): Promise<void> {
  // Case 12: a channel-less family whose table stride drifted (130 vs a 132-value body). itemCount / 4
  // would be 33, hiding every edit from paramId 33 on; the whole body is the slice instead.
  const flatBefore = new Array(132).fill(0);
  const flatAfter = [...flatBefore];
  flatAfter[EDIT_LOW_PID] = 20000;
  flatAfter[EDIT_LATE_PID] = 30000;
  assertEqual(
    editedPids(editProfile(130, 144), VIRTUAL_EID, flatBefore, flatAfter).join(','),
    `${EDIT_LOW_PID},${EDIT_LATE_PID}`,
    'channel-less family with a drifted table stride keeps reporting device edits past itemCount/4',
  );
  console.log('  drivers/channel-slice: a channel-less family reports edits past itemCount/4 even with a drifted table stride');

  // Case 13: a channel-bearing block still uses itemCount / 4 when its table stride is wrong, so an
  // edit near the end of the real channel slice (pid 149 of 150) is reported, not clipped at the table (144).
  const ampBefore = new Array(150 * 4).fill(0);
  const ampAfter = [...ampBefore];
  ampAfter[EDIT_LOW_PID] = 20000;
  ampAfter[149] = 30000;
  assertEqual(
    editedPids(editProfile(130, 144), ampEid(), ampBefore, ampAfter).join(','),
    `${EDIT_LOW_PID},149`,
    'channel-bearing block with a drifted table stride is sliced by itemCount/4 (edits at the end of the slice survive)',
  );
  console.log('  drivers/channel-slice: a channel-bearing block still slices by itemCount/4 for edit diffs');
}
