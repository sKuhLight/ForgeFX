// Exact goldens of the generic block-params response (`blockParams(eid, { generic: true })`, GET
// …/params?generic=1) for a set of FM3 blocks, on two profiles: the catalog read back as a byte-exact profile (the
// fw 12.0 profile) and the synthetic newer firmware of test/helpers/newerFirmware.ts. The unit is mocked (status 0x13 +
// bulk 0x1F) and answers deterministic synthetic bodies (catalogProfile.syntheticRaw: floats (pid * 997) % 65535,
// enum ordinals lo + pid % count), so every byte of the response is pinned: names, kinds, widgets, write modes,
// fingerprints, values, options, hidden rows, the layout. Committed catalog data and synthetic data only.
//
// Stored under test/fixtures/generic-params/{catalog,newer}-<eid>.json. The files hold the response with keys sorted
// and each option list stored once (`optionLists`, referenced as "#<n>" from the entries), one param per line;
// the test checks that this form restores the response exactly. Regenerate with UPDATE_GOLDEN=1 npm test.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILES, runtimeProfileFrom, type DeviceProfile } from '../../src/devices.js';
import type { BlockParamsV2DTO } from '../../src/drivers/types.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { eidOfSlug } from '../helpers/blockRead.js';
import { catalogBuilt, mockGen3Device } from '../helpers/catalogProfile.js';
import { newerFirmwareBuilt } from '../helpers/newerFirmware.js';

const ROTARY = eidOfSlug('rotary');
/** GLOBAL, Amp, Cab, Delay, Chorus, Rotary, Drive, Mixer (first instances). */
const EIDS = [1, 58, 62, 70, 78, ROTARY, 118, 126];
const PROFILE_LABELS = ['catalog', 'newer'] as const;

export const NEWER_FIRMWARE_GOLDEN_CASE_COUNT = EIDS.length * PROFILE_LABELS.length + 1;

const FIXTURES = fileURLToPath(new URL('../fixtures/generic-params/', import.meta.url));
/** A golden file may not grow past this: the format keeps a block's response well below it. */
const MAX_GOLDEN_BYTES = 128 * 1024;

// ── the stored form ───────────────────────────────────────────────────────────────────────────────────────────
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const sortKeys = (v: Json): Json =>
  Array.isArray(v) ? v.map(sortKeys)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k]!)]))
      : v;

/** The response with sorted keys and every distinct option list stored once, in order of first use. */
function storedForm(r: BlockParamsV2DTO): { [k: string]: Json } {
  const lists: string[] = [];
  const ref = (options: Json): string => {
    const key = JSON.stringify(options);
    let i = lists.indexOf(key);
    if (i < 0) i = lists.push(key) - 1;
    return `#${i}`;
  };
  const doc = sortKeys(JSON.parse(JSON.stringify(r)) as Json) as { [k: string]: Json };
  for (const list of ['named', 'enums']) {
    for (const e of doc[list] as { [k: string]: Json }[]) if (e.options !== undefined) e.options = ref(e.options);
  }
  doc.optionLists = lists.map((s) => JSON.parse(s) as Json);
  return doc;
}

/** The response a stored form stands for. */
function restored(doc: { [k: string]: Json }): Json {
  const lists = doc.optionLists as Json[];
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'optionLists') continue;
    out[k] = k === 'named' || k === 'enums'
      ? (v as { [k: string]: Json }[]).map((e) => (typeof e.options === 'string' ? { ...e, options: lists[Number(e.options.slice(1))]! } : e))
      : v;
  }
  return out;
}

const WIDTH = 160;
/** Arrays whose items are written one per line, each on a single line, however long. */
const ONE_PER_LINE = new Set(['named', 'enums', 'optionLists']);

/** JSON text: a value that fits in WIDTH columns stays on one line, anything longer is broken up. */
function print(v: Json, indent: number, onePerLine = false): string {
  const compact = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || (!onePerLine && compact.length + indent <= WIDTH)) return compact;
  const pad = ' '.repeat(indent + 2);
  const end = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => pad + (onePerLine ? JSON.stringify(x) : print(x, indent + 2))).join(',\n')}\n${end}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${print(v[k]!, indent + 2, ONE_PER_LINE.has(k))}`).join(',\n')}\n${end}}`;
}

const goldenText = (r: BlockParamsV2DTO): string => `${print(storedForm(r), 0)}\n`;

/** Where two texts first differ, for a readable failure. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) return `line ${i + 1}:\n  expected ${e[i]?.slice(0, 400) ?? '(end of file)'}\n  actual   ${a[i]?.slice(0, 400) ?? '(end of file)'}`;
  }
  return 'no difference';
}

// ── the responses ──────────────────────────────────────────────────────────────────────────────────────────────
function profileOf(label: (typeof PROFILE_LABELS)[number]): DeviceProfile {
  return runtimeProfileFrom(label === 'catalog' ? catalogBuilt(0x11) : newerFirmwareBuilt(), PROFILES[0x11]!);
}

async function responses(p: DeviceProfile): Promise<Map<number, BlockParamsV2DTO>> {
  const { driver } = mockGen3Device(p, EIDS);
  const out = new Map<number, BlockParamsV2DTO>();
  for (const eid of EIDS) out.set(eid, await driver.blockParams(eid, { generic: true }));
  return out;
}

export async function runNewerFirmwareGoldenTests(): Promise<void> {
  const savedHook = process.env.FORGEFX_DEFS_FORCE_GENERIC;
  delete process.env.FORGEFX_DEFS_FORCE_GENERIC; // the diagnostic hook would rename params
  try {
    await runCases();
  } finally {
    if (savedHook !== undefined) process.env.FORGEFX_DEFS_FORCE_GENERIC = savedHook;
  }
}

async function runCases(): Promise<void> {
  assertEqual(ROTARY, 86, 'premise: the first Rotary sits at eid 86');
  const update = process.env.UPDATE_GOLDEN === '1';
  if (update && !existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });
  const texts = new Map<string, string>();
  let bytes = 0;

  for (const label of PROFILE_LABELS) {
    const p = profileOf(label);
    const first = await responses(p);
    const again = await responses(profileOf(label)); // a fresh profile and unit: nothing may depend on state
    for (const eid of EIDS) {
      const r = first.get(eid)!;
      const name = `${label}-${eid}.json`;
      const text = goldenText(r);
      assertEqual(goldenText(again.get(eid)!), text, `${name}: the response is deterministic`);
      // the stored form restores the response exactly
      assertEqual(JSON.stringify(sortKeys(restored(JSON.parse(text) as { [k: string]: Json }))), JSON.stringify(sortKeys(JSON.parse(JSON.stringify(r)) as Json)), `${name}: the stored form is lossless`);
      // the synthetic body resolves every value of a block read by position (GLOBAL is not)
      const unresolved = [...r.named, ...r.enums].filter((e) => e.unresolved !== undefined);
      if (eid === 1) assert(unresolved.length === r.named.length + r.enums.length && unresolved.every((e) => e.unresolved === 'non-positional'), `${name}: GLOBAL values are all non-positional`);
      else assertEqual(unresolved.map((e) => `${e.id}:${e.unresolved}`).join(','), '', `${name}: every value resolved`);
      const path = `${FIXTURES}${name}`;
      if (update) writeFileSync(path, text);
      assert(existsSync(path), `${name}: golden missing (run with UPDATE_GOLDEN=1)`);
      const stored = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      if (stored !== text) throw new Error(`${name}: the response differs from the golden (UPDATE_GOLDEN=1 regenerates) at ${firstDifference(text, stored)}`);
      assert(Buffer.byteLength(stored) <= MAX_GOLDEN_BYTES, `${name}: ${Buffer.byteLength(stored)} bytes, over the ${MAX_GOLDEN_BYTES}-byte limit`);
      bytes += Buffer.byteLength(stored);
      texts.set(name, text);
    }
    console.log(`  drivers/newer-firmware-golden: ${label} — ${EIDS.length} blocks match their goldens${update ? ' (regenerated)' : ''}`);
  }

  // what the newer firmware changes and what it leaves alone
  {
    const same = EIDS.filter((eid) => texts.get(`catalog-${eid}.json`) === texts.get(`newer-${eid}.json`));
    assertEqual(same.join(','), '1,62', 'GLOBAL and the cab are untouched by the newer firmware; every other block changed');
    console.log(`  drivers/newer-firmware-golden: GLOBAL and Cab identical on both profiles; ${EIDS.length * 2} goldens, ${Math.round(bytes / 1024)} KiB`);
  }
}
