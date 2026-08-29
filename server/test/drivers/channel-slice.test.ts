// Channel-slice geometry for gen-3 fn=0x1F block reads — the amp-model-wrong-on-channels-B-D bug.
//
// The FM3 amp block's fn=0x1F body carries ALL FOUR channels back to back: channel k's paramId p
// lives at k*stride + p. #channelSlice picks that stride from the profile's rangeSections. A
// walk-built runtime profile reports a SHORT stride there (the live walk's section meta counts the
// records it collected — 126 of FM3 DISTORT's 144 — not the section's true width), and a short
// stride is silent: base = channel*126 lands in the middle of an EARLIER channel's slice, so the
// type read at base+6 is a real, valid-looking value from the wrong param.
//
// Reproduced field-exact (FM3, firmware 11.0, walk-built cache):
//   • preset 068 "USA MKIIC++ lead", amp on channel B — 126*1+6 = chA paramId 132 (VPLATEMON, 0)
//     → decoded 0 → "59 Bassguy Bright" instead of "USA MK IIC++" (roster 248).
//   • preset 043 "Friedman BE metal" scene 4, amp on channel C — 126*2+6 = chB paramId 114
//     (TRIODE1RATIO, raw 23330) → the >max rescale turns it into 117 → "CA3+ Clean" instead of
//     "Friedman BE V1 Fat" (roster 259).
// Mocked transport, no hardware — same idiom as definition-completeness.test.ts.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { runtimeProfileFrom, profileForModel } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const FAMILY = 'DISTORT'; // the amp block's catalog family (SLUG_FAMILY['amp'])
const TYPE_PID = 6; // DISTORT_TYPE
const TRUE_STRIDE = 144; // FM3_RANGE_SECTIONS.DISTORT.stride — hardware-validated
const WALK_STRIDE = 126; // what the live walk reported for the same section
const ROSTER_LEN = 330;

// Field-exact roster ordinals (FM3 firmware 11.0 amp list).
const MKIIC = 248;
const BE_V1_FAT = 259;
const CA3_CLEAN = 117;
// The params the short stride lands on, with the values the two field presets carried.
const VPLATEMON_PID = 132; // 126*1 + 6
const TRIODE1RATIO_PID = 114; // 126*2 + 6 - 144
const TRIODE1RATIO_RAW = 23330;

export const CHANNEL_SLICE_CASE_COUNT = 7;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
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

function synthProfile(stride: number): DeviceProfile {
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
    rangeSections: { [FAMILY]: { sectionTag: 10, stride, recordCount: stride } },
    rosterFor: () => roster,
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

/** The field body: 4 channel blocks of 144, with the two decoy values the short stride lands on. */
function fieldBody(): number[] {
  const values = new Array(TRUE_STRIDE * 4).fill(0);
  values[0 * TRUE_STRIDE + TYPE_PID] = 33; // channel A: some other amp
  values[1 * TRUE_STRIDE + TYPE_PID] = MKIIC;
  values[2 * TRUE_STRIDE + TYPE_PID] = BE_V1_FAT;
  values[3 * TRUE_STRIDE + TYPE_PID] = 12;
  values[0 * TRUE_STRIDE + VPLATEMON_PID] = 0; // what the short stride reads for channel B
  values[1 * TRUE_STRIDE + TRIODE1RATIO_PID] = TRIODE1RATIO_RAW; // …and for channel C
  return values;
}

async function readAmpType(stride: number, channel: number): Promise<{ value: number; name: string } | null> {
  const eid = ampEid();
  const codec = createModernFractalCodec(MODEL);
  const bulk = blockBulkFrames(eid, fieldBody());
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
  const driver = createGen3Driver(synthProfile(stride), { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  return (await driver.blockParams(eid)).type;
}

export async function runChannelSliceTests(): Promise<void> {
  // ---- Case 1-2: the catalog stride resolves every channel's own model ----------------------
  assertEqual((await readAmpType(TRUE_STRIDE, 1))?.name, 'USA MK IIC++', 'catalog stride, channel B → the channel B model');
  assertEqual((await readAmpType(TRUE_STRIDE, 2))?.name, 'Friedman BE V1 Fat', 'catalog stride, channel C → the channel C model');
  console.log('  drivers/channel-slice: catalog stride slices channels B/C to their own amp model');

  // ---- Case 3-4: a walk-shortened stride must NOT drag the read off its channel --------------
  // Before the fix these decoded to "59 Bassguy Bright" and "CA3+ Clean" — the two field reports.
  const b = await readAmpType(WALK_STRIDE, 1);
  const c = await readAmpType(WALK_STRIDE, 2);
  assert(b?.name !== '59 Bassguy Bright', 'walk-short stride must not decode channel B as roster 0');
  assert(c?.name !== 'CA3+ Clean', `walk-short stride must not rescale a decoy into roster ${CA3_CLEAN}`);
  assertEqual(b?.name, 'USA MK IIC++', 'walk-short stride, channel B → still the channel B model (wire itemCount wins)');
  assertEqual(c?.name, 'Friedman BE V1 Fat', 'walk-short stride, channel C → still the channel C model (wire itemCount wins)');
  console.log('  drivers/channel-slice: a walk-shortened stride is repaired from the body itemCount');

  // ---- Case 5-7: the cache overlay never shrinks the catalog's validated stride --------------
  const fm3 = profileForModel(MODEL);
  const overlaid = runtimeProfileFrom(
    {
      enumOverrides: {}, ranges: {}, rosters: {}, cabIrs: {},
      rangeSections: {
        [FAMILY]: { sectionTag: 58, stride: WALK_STRIDE, recordCount: WALK_STRIDE },
        WALKONLY: { sectionTag: 99, stride: 7, recordCount: 7 },
      },
    } as never,
    fm3,
  );
  assertEqual(overlaid.rangeSections[FAMILY]?.stride, TRUE_STRIDE, 'cache overlay keeps the catalog DISTORT stride');
  assertEqual(overlaid.rangeSections[FAMILY]?.sectionTag, 58, 'cache overlay still adopts the device-observed section tag');
  assertEqual(overlaid.rangeSections['WALKONLY']?.stride, 7, 'cache overlay still contributes sections the catalog lacks');
  console.log('  drivers/channel-slice: runtimeProfileFrom keeps the catalog stride, adopts cache-only sections');
}
