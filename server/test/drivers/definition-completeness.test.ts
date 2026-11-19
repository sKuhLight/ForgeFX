// WP3a (FORGEFX-40): serve the imported catalog unit/taper data on gen-3 blockParams.
// The gen-3 driver's #display() maps a raw wire value to {value, norm, unit, min, max, log} via the
// device-true range resolved from this.#prof.ranges[family][paramId]. That range is EITHER a static
// catalog row (Fm9ParamRange/Axe3ParamRange — carries the new unit?/taper? fields) or a walk-built
// RangeDef (carries unit?, not yet taper). This suite drives #display through blockParams() over a
// SYNTHETIC profile whose ranges carry controlled unit/taper values, and asserts:
//   • explicit taper 'log'  → log:true  even when the typecode nibble says linear
//   • explicit taper 'linear'→ log:false even when the typecode nibble says log
//   • absent taper           → the typecode-nibble heuristic: ONLY nibble 4 is log, every other nibble
//                              (nibble 5 included) is linear
//   • catalog range.unit passthrough beats the AM4-name-overlay (UNIT_LABEL) fallback
//   • absent range.unit      → the overlay fallback is preserved
// Mocked transport, no hardware — same idiom as modelbyte.test.ts.
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import type { DeviceProfile } from '../../src/devices.js';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';

const MODEL = 0x11; // FM3
const FAMILY = 'DISTORT'; // the amp block's catalog family (SLUG_FAMILY['amp'])
const STRIDE = 20;
const RAW = 30000; // an integer wire value in 0..65534 (log10 needs an int; positive ranges below)

export const DEFINITION_COMPLETENESS_CASE_COUNT = 13;

const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** fn=0x74/0x75/0x76 block-bulk-read reply frames carrying `values` (same shape as modelbyte.test.ts). */
function blockBulkFrames(effectId: number, values: readonly number[]): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(0x74, [...enc14(effectId), ...enc14(values.length), 0x07]),
    sysex(0x75, body),
    sysex(0x76, []),
  ];
}

function ampEid(): number {
  const e = effectRoster().find((x) => x.slug === 'amp');
  if (!e) throw new Error("no roster entry for slug 'amp'");
  return e.page; // instance-1 effect id
}

type Range = { kind: string; displayMin: number; displayMax: number; typecode: number; unit?: string; taper?: 'linear' | 'log' | 'flat' | 'custom' };

// One knob param per scenario, keyed by paramId. `unit` is the CATALOG unit code (drives the
// UNIT_LABEL overlay fallback); the RANGE carries the device-true unit/taper being tested.
const PARAMS: { paramId: number; name: string; unit: string }[] = [
  { paramId: 10, name: 'TAPER_LOG_NIBBLE_LINEAR', unit: 'hz' },
  { paramId: 11, name: 'TAPER_LINEAR_NIBBLE_LOG', unit: 'hz' },
  { paramId: 12, name: 'NIBBLE_LOG_NO_TAPER', unit: 'hz' },
  { paramId: 13, name: 'NIBBLE_LINEAR_NO_TAPER', unit: 'numeric' },
  { paramId: 14, name: 'CATALOG_UNIT_WINS', unit: 'db' }, // overlay would say 'dB'
  { paramId: 15, name: 'ABSENT_UNIT_OVERLAY', unit: 'db' }, // overlay 'dB' is the expected fallback
  { paramId: 16, name: 'NIBBLE5_NO_TAPER', unit: 'hz' },
];
// typecode 0x40 → middle nibble ((0x40>>4)&0xf)=4 → the heuristic reads log10; 0x00 → linear;
// 0x50 → nibble 5 → linear too (only nibble 4 marks a log taper).
const RANGES: Record<number, Range> = {
  10: { kind: 'float', displayMin: 20, displayMax: 20000, typecode: 0x00, taper: 'log' },
  11: { kind: 'float', displayMin: 20, displayMax: 20000, typecode: 0x40, taper: 'linear' },
  12: { kind: 'float', displayMin: 20, displayMax: 20000, typecode: 0x40 },
  13: { kind: 'float', displayMin: 0, displayMax: 10, typecode: 0x00 },
  14: { kind: 'float', displayMin: 0, displayMax: 10, typecode: 0x00, unit: 'MyHz' }, // device-true unit token
  15: { kind: 'float', displayMin: 0, displayMax: 10, typecode: 0x00 }, // no device-true unit → overlay
  16: { kind: 'float', displayMin: 20, displayMax: 20000, typecode: 0x50 }, // nibble 5, positive range, no taper
};

function synthProfile(): DeviceProfile {
  return {
    model: MODEL, key: 'fm3', name: 'FM3-wp3a-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: { [FAMILY]: PARAMS },
    ranges: { [FAMILY]: RANGES },
    rangeSections: { [FAMILY]: { stride: STRIDE, recordCount: STRIDE } },
    rosterFor: () => [],
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

async function readNamed(): Promise<Map<number, { id: number; log?: boolean; unit?: string }>> {
  const eid = ampEid();
  const codec = createModernFractalCodec(MODEL);
  const values = new Array(STRIDE).fill(0);
  for (const p of PARAMS) values[p.paramId] = RAW;
  const bulk = blockBulkFrames(eid, values);
  const mock = new MockTransport('serial', 'mock-wp3a');
  mock.isOpen = true;
  mock.reply = (req) => (compactHex(req) === compactHex(codec.buildBlockBulkReadPoll(eid)) ? bulk : []);
  const driver = createGen3Driver(synthProfile(), { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  const r = await driver.blockParams(eid);
  const byId = new Map<number, { id: number; log?: boolean; unit?: string }>();
  for (const n of r.named) byId.set(n.id, n);
  return byId;
}

export async function runDefinitionCompletenessTests(): Promise<void> {
  const named = await readNamed();
  const get = (id: number) => {
    const n = named.get(id);
    assert(!!n, `param ${id} present in blockParams.named`);
    return n!;
  };

  // TAPER — explicit device-true taper overrides the typecode-nibble heuristic.
  assertEqual(get(10).log, true, "explicit taper 'log' → log:true even when the nibble says linear");
  assert(!get(11).log, "explicit taper 'linear' → log:false even when the nibble says log");

  // TAPER — no explicit taper → the typecode-nibble heuristic is preserved (both directions).
  assertEqual(get(12).log, true, 'absent taper, nibble 4 → log:true (heuristic preserved)');
  assert(!get(13).log, 'absent taper, nibble 0 → log falsy (heuristic preserved)');
  assert(!get(16).log, 'absent taper, nibble 5 → linear (only nibble 4 marks a log taper)');

  // UNIT — device-true range.unit wins over the AM4-name-overlay (UNIT_LABEL) fallback.
  assertEqual(get(14).unit, 'MyHz', 'catalog range.unit passthrough beats the AM4 overlay');
  assertEqual(get(15).unit, 'dB', "absent range.unit → overlay fallback preserved (UNIT_LABEL['db'])");
}
