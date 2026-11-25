// The runtime `unmapped-block` coverage gap through the REAL gen-3 driver (M3 WP-F2): a synthetic edit-buffer grid
// (codec-authored dump: a clean scaffold with only the routing grid replaced, no device frames) served by a
// MockTransport, NO hardware. Covers:
//   - only a placed block that NO family describes is unmapped: not one the profile resolves, not one the model's
//     static tables place (an Axe-Fx III fifth Input, III roster blocks such as Vocoder / Crossover / Tone Match /
//     RTA / IR Player, further instance slots), not one the applied document's block map binds `confirmed`;
//   - the SSE `definitions` event (reason `unmapped-blocks`, the running firmware's profile key) fires when the set
//     changes — after a grid read or a profile swap — and not otherwise;
//   - the set is forgotten on a (re)detect (`resetSession`) and when the connection's transport changes;
//   - end to end through the registry: GET /preset/grid then GET /device → `unmapped-block` gap + drift `partial`
//     for an applied profile, `none` once a confirmed block map describes the block, `none` without an applied
//     profile on the catalog firmware.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { authorGen3PresetFromIRFull, defaultScaffoldSyx } from 'forgefx-midi/devices/gen3';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { createGen3Driver, type Gen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import type { DefinitionsCaps, DeviceEvent } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, dumpAnswering, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { familyRecords, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';

export const UNMAPPED_BLOCKS_CASE_COUNT = 5;

/** An effect id no gen-3 table places (a block a newer firmware might add). */
const NEW_EID = 203;

/** Split a flat .syx byte stream into F0..F7 frames. */
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { frames.push(cur); cur = null; }
    }
  }
  return frames;
}

/** A preset dump of `model` whose routing grid holds `eids` (one per cell, rows first), authored by the codec from
 *  its clean scaffold — synthetic, no device bytes. */
function gridDump(model: number, eids: readonly number[]): number[][] {
  const rows = PROFILES[model]!.rows;
  const cells = eids.map((effectId, i) => ({ row: i % rows, col: Math.floor(i / rows), effectId }));
  return framesOf(authorGen3PresetFromIRFull(defaultScaffoldSyx(model), { routing: { gridCells: cells } }, model).syx);
}

/** Placed effect ids per model: the new block plus blocks the profile does not resolve on its own but the model's
 *  static tables do (III Input 5 = 41; the III roster blocks 134 / 142 / 170 / 174 / 195 and their instance slots). */
const PLACED: Record<number, number[]> = {
  0x10: [NEW_EID, 58, 41, 134, 135, 142, 170, 174, 195],
  0x11: [NEW_EID, 58, 37, 134, 142],
  0x12: [NEW_EID, 58, 37, 134, 142]
};

interface Rig { driver: Gen3Driver; mock: { v: MockTransport }; events: DeviceEvent[] }
function rig(model: number, dump: number[][]): Rig {
  const mk = () => {
    const m = new MockTransport('serial', `mock-unmapped-0x${model.toString(16)}`);
    m.isOpen = true;
    m.reply = (req) => (req[5] === 0x03 ? dumpAnswering(req, dump) : []);
    return m;
  };
  const mock = { v: mk() };
  const events: DeviceEvent[] = [];
  const driver = createGen3Driver(PROFILES[model]!, {
    transport: async () => mock.v,
    emit: (e) => { events.push(e); },
    getCadence: () => cadenceFor(null, 'balanced'),
    getFirmware: () => ({ major: 13, minor: 0 })
  });
  return { driver, mock, events };
}
const unmappedEvents = (events: DeviceEvent[]) => events.filter((e) => e.type === 'definitions' && e.reason === 'unmapped-blocks');
const keyOf = (model: number) => `${model.toString(16).padStart(2, '0')}_13p0`;

/** The grid cache window is a static on the driver class: a zero window makes every grid() read the dump. */
const ttlOf = (d: Gen3Driver) => d.constructor as unknown as { GRID_TTL_MS: number };

// ── 1. only a block no family describes is unmapped (III / FM3 / FM9) ──
async function onlyUndescribedBlocks(): Promise<void> {
  for (const model of [0x10, 0x11, 0x12]) {
    const r = rig(model, gridDump(model, PLACED[model]!));
    const name = `0x${model.toString(16)}`;
    assertEqual(r.driver.unmappedPlacedEffectIds(), null, `${name}: null before the first grid read`);
    const grid = await r.driver.grid();
    const placed = grid.cells.filter((c) => !c.isShunt && c.effectId > 0).map((c) => c.effectId).sort((a, b) => a - b);
    assertEqual(placed.join(','), [...PLACED[model]!].sort((a, b) => a - b).join(','), `${name}: the synthetic grid places exactly the test blocks`);
    assertEqual(JSON.stringify(r.driver.unmappedPlacedEffectIds()), JSON.stringify([NEW_EID]), `${name}: only the new block is unmapped`);
    const ev = unmappedEvents(r.events);
    assertEqual(ev.length, 1, `${name}: one definitions/unmapped-blocks event`);
    assertEqual((ev[0] as { key?: string }).key, keyOf(model), `${name}: keyed by the running firmware's profile key`);
  }
}

// ── 2. events only on a change; a confirmed block map describes the block ──
async function changesAndConfirmedMap(): Promise<void> {
  const model = 0x11;
  const r = rig(model, gridDump(model, PLACED[model]!));
  const ttl = ttlOf(r.driver).GRID_TTL_MS;
  ttlOf(r.driver).GRID_TTL_MS = 0;
  try {
    await r.driver.grid();
    await r.driver.grid(); // the same set again: no new event
    assertEqual(unmappedEvents(r.events).length, 1, 'a repeated read with the same set emits nothing');
    // a profile document whose block map binds the new block (a live walk found it): confirmed → not unmapped
    const doc = profileDoc([liveSource([...liveSeedRecords(), ...familyRecords('CHORUS', NEW_EID)])]);
    const entry = doc.blockMap.find((e) => e.eid === NEW_EID);
    assert(entry?.confidence === 'confirmed', `fixture: a confirmed block-map entry for ${NEW_EID} (${JSON.stringify(entry)})`);
    r.driver.applyRuntimeProfile(runtimeProfileFrom(doc, PROFILES[model]!));
    assertEqual(JSON.stringify(r.driver.unmappedPlacedEffectIds()), '[]', 'a confirmed block-map entry describes the block');
    assertEqual(unmappedEvents(r.events).length, 2, 'the profile swap changed the set: an event');
    // back to the bundled profile: unmapped again, another event
    r.driver.applyRuntimeProfile(PROFILES[model]!);
    assertEqual(JSON.stringify(r.driver.unmappedPlacedEffectIds()), JSON.stringify([NEW_EID]), 'the bundled profile does not describe it');
    assertEqual(unmappedEvents(r.events).length, 3, 'and that change is announced too');
    r.driver.applyRuntimeProfile(PROFILES[model]!);
    assertEqual(unmappedEvents(r.events).length, 3, 'a swap that changes nothing emits nothing');
    // a profile of another kind that leaves the block undescribed: the set stays, no event
    r.driver.applyRuntimeProfile(runtimeProfileFrom(profileDoc([liveSource(liveSeedRecords())]), PROFILES[model]!));
    assertEqual(unmappedEvents(r.events).length, 3, 'a swap that keeps the set emits nothing');
  } finally { ttlOf(r.driver).GRID_TTL_MS = ttl; }
}

// ── 3. forgotten on a (re)detect and on a new transport ──
async function forgottenOnNewSession(): Promise<void> {
  const model = 0x11;
  const dump = gridDump(model, PLACED[model]!);
  const r = rig(model, dump);
  const ttl = ttlOf(r.driver).GRID_TTL_MS;
  ttlOf(r.driver).GRID_TTL_MS = 0;
  try {
    await r.driver.grid();
    assertEqual(JSON.stringify(r.driver.unmappedPlacedEffectIds()), JSON.stringify([NEW_EID]), 'read');
    r.driver.resetSession();
    assertEqual(r.driver.unmappedPlacedEffectIds(), null, 'a (re)detect forgets the placed blocks');
    await r.driver.grid();
    assertEqual(unmappedEvents(r.events).length, 2, 'the first read of the new session announces the set again');
    // a new transport (a reconnect): the placed blocks of the old one are forgotten at its first use
    const silent = new MockTransport('serial', 'mock-unmapped-silent');
    silent.isOpen = true;
    r.mock.v = silent;
    let failed = false;
    try { await r.driver.grid(); } catch { failed = true; }
    assert(failed, 'fixture: the silent transport answers no dump');
    assertEqual(r.driver.unmappedPlacedEffectIds(), null, 'a new transport forgets the placed blocks of the old one');
  } finally { ttlOf(r.driver).GRID_TTL_MS = ttl; }
}

// ── 4. end to end: grid read → caps (gap + drift) → SSE, real driver through the registry ──
async function throughTheRegistry(): Promise<void> {
  const model = 0x11;
  const dump = gridDump(model, PLACED[model]!);
  const KEY = '11_12p0'; // FM3 fw 12.0 = the catalog firmware
  const make = async (docs: Record<string, unknown>) => {
    const mock = new MockTransport('serial', 'mock-unmapped-registry');
    mock.reply = (req) => {
      if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
      if (req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model, 12, 0)];
      if (req[5] === 0x03) return dumpAnswering(req, dump);
      return [];
    };
    const s = createStore(createMemStoreBackend(), nodeCodec);
    for (const [k, v] of Object.entries(docs)) s.putDoc('deviceCaches', k, v);
    const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock, loadDeviceCache: (key) => loadUsableProfile(s, key) });
    await registry.detect();
    const app = await buildApp(registry);
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    const resume = registry.pauseTelemetry();
    return { registry, app, store: s, events, close: async () => { resume(); unsub(); await app.close(); } };
  };
  const defs = async (app: Awaited<ReturnType<typeof make>>['app']) =>
    ((await app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: DefinitionsCaps } }).capabilities.definitions;

  // an applied profile without a gap of its own: partial once the grid shows a block no family describes
  let r = await make({ [KEY]: profileDoc([liveSource(liveSeedRecords())]) });
  try {
    let d = await defs(r.app);
    assertEqual(d.drift, 'none', 'before a grid read: none');
    assertEqual((await r.app.inject({ method: 'GET', url: '/preset/grid' })).statusCode, 200, 'GET /preset/grid');
    d = await defs(r.app);
    assertEqual(d.drift, 'partial', 'a placed block no family describes: partial');
    assert(d.profile!.coverage.gaps.includes('unmapped-block'), 'the runtime unmapped-block gap');
    assertEqual(d.profile!.coverage.complete, false, 'not complete');
    assertEqual(unmappedEvents(r.events).length, 1, 'SSE definitions/unmapped-blocks');
    assertEqual((unmappedEvents(r.events)[0] as { key?: string }).key, KEY, 'keyed by the running firmware');
    // a stored doc whose block map confirms the block: re-applied → described → none, and announced
    r.store.putDoc('deviceCaches', KEY, profileDoc([liveSource([...liveSeedRecords(), ...familyRecords('CHORUS', NEW_EID)])]));
    await r.registry.applyRuntimeCache();
    d = await defs(r.app);
    assertEqual(d.drift, 'none', 'a confirmed block map describes the block: none');
    assert(!d.profile!.coverage.gaps.includes('unmapped-block'), 'no runtime gap');
    assertEqual(unmappedEvents(r.events).length, 2, 'the swap announced the change');
  } finally { await r.close(); }

  // no applied profile on the catalog firmware: the runtime gap does not apply
  r = await make({});
  try {
    await r.app.inject({ method: 'GET', url: '/preset/grid' });
    const d = await defs(r.app);
    assertEqual(d.profile, null, 'nothing applied');
    assertEqual(d.drift, 'none', 'no applied profile: none');
  } finally { await r.close(); }
}

// ── 5. the III roster blocks and instance slots are not unmapped under any profile the registry applies ──
async function iiiRosterBlocksNotUnmapped(): Promise<void> {
  const model = 0x10;
  const r = rig(model, gridDump(model, PLACED[model]!.filter((e) => e !== NEW_EID)));
  await r.driver.grid();
  assertEqual(JSON.stringify(r.driver.unmappedPlacedEffectIds()), '[]', 'III: Input 5, the roster blocks and instance slots are described');
  assertEqual(unmappedEvents(r.events).length, 0, 'III: nothing to announce');
}

export async function runUnmappedBlocksTests(): Promise<void> {
  await onlyUndescribedBlocks();
  await changesAndConfirmedMap();
  await forgottenOnNewSession();
  await throughTheRegistry();
  await iiiRosterBlocksNotUnmapped();
}
