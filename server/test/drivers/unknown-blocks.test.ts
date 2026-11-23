// Blocks the catalog cannot place on its own (M3 WP-F5): the block map in the generic block params, the write guard,
// the block probe route and FORGEFX-45 (the Axe-Fx III effect-id table's roster entries), over a MockTransport that
// answers the status dump (0x13), the block bulk read (0x1F), the preset dump (grid) and the definition queries of the
// probe — NO hardware. Synthetic data only: the FM3 catalog's seed rows, a synthetic table of a block the catalog lacks
// ("section 60" / effect id 203), catalog-derived rows for the leave-one-out cases. Covers:
//   - `likely` (runtime bulk shape against the applied document's editor-cache sections): generic params from the
//     section, every one `write: null` + `readOnlyReason: 'unconfirmed-block'`, channels from the shape; PUT → 409,
//     nothing sent; an enum value out of bounds → `none`; two fitting sections → `candidates`, nothing listed, no guard;
//   - `confirmed` by device records after a probe: the section's rows, writes allowed (M2 guards); live-only →
//     read-only `live-only-block`, PUT 409 with nothing sent; no editor-cache section → `none` without any read;
//   - the probe route: preconditions in order (503 no-device / 501 / 503 firmware-unknown / 501 firmware / 400 / 409
//     known-block / 404 / 409 merge refusal / 409 busy | building) with zero transport traffic, the walk's scope (one
//     block, read-only, ceiling from the bulk shape, no known size, values read, no hints) checked at the wire, 504
//     probe-timeout (the device stays claimed until the walk settles), a `live-probe` raw source appended (an older
//     probe of the block replaced), re-derived, persisted, re-applied, SSE `definitions`/`block-probe` once; router
//     twin parity; the Remote relay refuses it (api/remote.test.ts);
//   - FORGEFX-45: the six Axe-Fx III roster ids are reachable and read-only (named, `likely` with roster evidence,
//     PUT 409), never walk-hinted or bounded;
//   - the development hook FORGEFX_DEFS_HIDE_FAMILY: the family leaves the effect table, the static roster, the
//     derivation catalog incl. `familyFirstEid` and the section inventory; one warning; ignored in production and when
//     malformed; leave-one-out RESONATOR (162: likely → probe → confirmed `section:39`) and FORMANT (98: confirmed from a
//     read-only walk, no probe); a stored derivation follows the hook both ways (`meta.derivedHidden`);
//   - the walk-scope gates fail closed (empty table, override parsed, ignored in production);
//   - one confidence → state mapping shared by the generic params and the definitions diff;
//   - an instance block is served under its group's key and a bridged block leaves no `block:<eid>` family.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import {
  BYPASS_TYPECODE, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE, buildDefQuery, decodeWalkQuery, rawFromLiveWalk,
  type CacheRecord, type LiveTransport, type LiveWalkOptions, type ProfileDoc
} from 'forgefx-midi/cache';
import { authorGen3PresetFromIRFull, defaultScaffoldSyx } from 'forgefx-midi/devices/gen3';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { PROFILES, hiddenFamily, runtimeProfileFrom, type DeviceProfile } from '../../src/devices.js';
import { blockMapAccess, blockMapState, BLOCK_MAP_WRITES_ENABLED } from '../../src/drivers/blockMapState.js';
import { blockMapState as diffBlockMapState, definitionsDiff } from '../../src/drivers/definitionsDiff.js';
import { buildParamIndex } from '../../src/drivers/paramIndex.js';
import type { BlockParamsV2DTO, DeviceEvent, EnumParamV2, NamedParamV2 } from '../../src/drivers/types.js';
import { catalogForModel, profileCatalogFor, staticFamilyForEffectId, staticRoster } from '../../src/profileCatalog.js';
import { loadUsableProfile, upgradeStoredProfile } from '../../src/profileSchema.js';
import { createRouter } from '../../src/runtime/router.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import * as store from '../../src/store.js';
import { __setProbeOptionsForTest, type ProbeOptions } from '../../src/services/blockProbe.js';
import { cloudCachePublish, publishableProfile, type DeviceProfileCloud } from '../../src/services/cloudProfiles.js';
import { contribute, parseContributionFlags, type ContributionCloud } from '../../src/services/cacheContribution.js';
import { exportDefinitions } from '../../src/services/definitionsFile.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { claimDevice, releaseDevice } from '../../src/services/deviceJobs.js';
import { parseWalkScopeOverride, walkScopeGates, walkScopeOverrideFromEnv, WALK_SCOPE_VERIFIED_FW } from '../../src/services/walkScope.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, dumpAnswering, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { blockBulkFrames, compactHex, enc14, mockBlockDevice, sysex, type MockBlock } from '../helpers/blockRead.js';
import { mockGen3Device } from '../helpers/catalogProfile.js';
import { seedRecords as cacheSeedRecords } from '../helpers/cacheBytes.js';
import { newerFirmwareDoc } from '../helpers/newerFirmware.js';
import { STAMP, editorCacheSource, familyRecords, liveSeedRecords, liveSource, profileDoc, walkResult, widenTable } from '../helpers/profileDocs.js';

const FM3 = 0x11;
const AXE3 = 0x10;
const FM3P = PROFILES[FM3]!;
/** FM3 fw 12.0 (the catalog firmware): the document key of every stored fixture here. */
const KEY = '11_12p0';
/** A section the FM3 inventory does not list (a block the catalog firmware lacks) and the placed block it belongs to. */
const NEW_TAG = 60;
const TWIN_TAG = 61;
const NEW_EID = 203;
/** The new block's table: 10 slots, two selectors (one with a non-zero default), a bypass. */
const STRIDE = 10;

export const UNKNOWN_BLOCKS_CASE_COUNT = 18;

// ── synthetic records ───────────────────────────────────────────────────────────────────────────────────────────────
const F = (section: number, id: number, tc: number, min: number, max: number, def: number, step: number): CacheRecord =>
  ({ kind: 'float', section, offset: 0, id, tc, min, max, def, step, t1: 0, t2: 0 });
const E = (section: number, id: number, tc: number, values: string[], def = 0): CacheRecord =>
  ({ kind: 'enum', section, offset: 0, id, tc, min: 0, max: values.length - 1, def, step: 0, count: values.length, values, x: 0 });

/** The new block's table at `section` (a cache tag, or a block address for a live read). `live`: as a walk without
 *  label hints reads it — the selector with a non-zero default comes back as a float (same typecode and numbers). */
function newBlock(section: number, live = false): CacheRecord[] {
  return [
    F(section, 0, 0x52, 0, 10, 5, 0.01),
    F(section, 1, 0x81, -24, 24, 0, 0.1),
    E(section, 2, 0x10, ['MODE A', 'MODE B', 'MODE C']),
    F(section, 3, 0x71, 0, 1, 0.5, 0.01),
    F(section, 4, 0x41, 20, 20000, 1000, 1),
    F(section, 5, 0x31, 0, 100, 50, 1),
    live ? F(section, 6, 0x10, 0, 3, 2, 0) : E(section, 6, 0x10, ['ONE', 'TWO', 'THREE', 'FOUR'], 2),
    F(section, 7, 0x61, -12, 12, 0, 0.1),
    F(section, 8, 0x32, 0, 10, 2, 0.01),
    F(section, 9, BYPASS_TYPECODE, 0, 1, 0, 1)
  ];
}

/** The new block's bulk body: one slice of `STRIDE` values (selectors in range), four slices for a block with
 *  channels. `badSelector` puts an ordinal no selector has into pid 2. */
function newBody(o: { channels?: boolean; badSelector?: boolean } = {}): number[] {
  const slice = Array.from({ length: STRIDE }, (_, pid) => (pid === 2 ? (o.badSelector ? 9 : 1) : pid === 6 ? 2 : (pid * 997) % 65535));
  return o.channels === false ? slice : [...slice, ...slice, ...slice, ...slice];
}

/** A format-2 FM3 document of an editor-cache source with the seed families plus `extra` sections. */
async function byteDoc(extra: CacheRecord[] = newBlock(NEW_TAG)): Promise<ProfileDoc> {
  return profileDoc([await editorCacheSource([...cacheSeedRecords(), ...extra])]);
}

/** A live-only FM3 document: a read-only walk of the seed blocks plus the new block's rows at its address. */
function liveOnlyDoc(): ProfileDoc {
  return profileDoc([liveSource([...liveSeedRecords(), ...newBlock(NEW_EID, true)])]);
}

const entriesOf = (r: BlockParamsV2DTO): Array<NamedParamV2 | EnumParamV2> => [...r.named, ...r.enums];
const silent = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
};
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try { return await fn(); } finally { console.warn = warn; console.log = log; }
}

/** Run `fn` with environment variables set (undefined = unset), restoring them after. */
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

/** A walk query (definition, label or value view) — fn 0x01 like a param SET, told apart by its view byte. The other
 *  reads of this suite are 0x03 / 0x08 / 0x13 / 0x1F frames; every other fn-0x01 frame is a write. */
const WALK_VIEWS: ReadonlySet<number> = new Set([VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE]);
const isDefinitionQuery = (f: readonly number[]) => { const q = decodeWalkQuery(Uint8Array.from(f)); return q !== null && WALK_VIEWS.has(q.view); };
const writesIn = (frames: readonly (readonly number[])[]) => frames.filter((f) => f[5] === 0x01 && !isDefinitionQuery(f));

// ── a mocked unit behind the registry ───────────────────────────────────────────────────────────────────────────────

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

/** A preset dump whose routing grid holds `eids`, authored by the codec from its clean scaffold (synthetic). */
function gridDump(model: number, eids: readonly number[]): number[][] {
  const rows = PROFILES[model]!.rows;
  const cells = eids.map((effectId, i) => ({ row: i % rows, col: Math.floor(i / rows), effectId }));
  return framesOf(authorGen3PresetFromIRFull(defaultScaffoldSyx(model), { routing: { gridCells: cells } }, model).syx);
}

interface Rig {
  registry: DeviceRegistry;
  app: Awaited<ReturnType<typeof buildApp>>;
  router: ReturnType<typeof createRouter>;
  mock: MockTransport;
  events: DeviceEvent[];
  blocks: Record<number, MockBlock>;
  /** Captured walk options of every probe walk. */
  walks: LiveWalkOptions[];
  close(): Promise<void>;
}

/** A detected FM3 (fw `fw`, null = silent firmware read) whose edit-buffer grid holds `placed` and that answers the
 *  status dump and the bulk reads of `blocks`; the probe and above-160 gates opened by the registry's override hook
 *  unless `probe` is false ('probe-only': the above-160 gate stays closed);
 *  Fastify app + router twin over the default store. Telemetry held (exact traffic counts). */
async function makeRig(o: { placed?: number[]; blocks?: Record<number, MockBlock>; fw?: readonly [number, number] | null; probe?: boolean | 'probe-only'; detect?: boolean; model?: number } = {}): Promise<Rig> {
  const model = o.model ?? FM3;
  const fw = o.fw === undefined ? ([12, 0] as const) : o.fw;
  const blocks: Record<number, MockBlock> = { ...(o.blocks ?? {}) };
  const gen3 = PROFILES[model] !== undefined;
  const dump = gen3 ? gridDump(model, o.placed ?? [NEW_EID]) : [];
  const codec = createModernFractalCodec(gen3 ? model : FM3);
  const statusHex = compactHex(codec.buildStatusDump());
  const mock = new MockTransport('serial', `mock-unknown-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (fw && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model, fw[0], fw[1])];
    if (!gen3) return [];
    if (req[5] === 0x03) return dumpAnswering(req, dump);
    const h = compactHex(req);
    if (h === statusHex) {
      const status: number[] = [];
      for (const [k, b] of Object.entries(blocks)) if (b.channel !== null) status.push(...enc14(Number(k)), ((b.channel ?? 0) & 0x07) << 1);
      return status.length > 0 ? [sysex(model, 0x13, status)] : [];
    }
    for (const [k, b] of Object.entries(blocks)) {
      if (h === compactHex(codec.buildBlockBulkReadPoll(Number(k)))) return b.silent ? [] : blockBulkFrames(model, Number(k), b.values, b.advertised);
    }
    return []; // definition queries (and anything else): no reply
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    // the probe gate (and, unless 'probe-only', the above-160 gate) opened by the registry's override hook
    walkScopeOverride: () => (o.probe === false ? new Set() : o.probe === 'probe-only' ? new Set(['probe' as const]) : new Set(['probe' as const, 'above160' as const]))
  });
  if (o.detect !== false) await quietly(() => registry.detect());
  const app = await buildApp(registry);
  const router = createRouter({ registry: registry as DeviceRegistry, store: store.defaultStore });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const resume = registry.pauseTelemetry();
  const walks: LiveWalkOptions[] = [];
  return {
    registry: registry as DeviceRegistry, app, router, mock, events, blocks, walks,
    close: async () => { __setProbeOptionsForTest(registry as DeviceRegistry, null); resume(); unsub(); await app.close(); }
  };
}

interface Answer { status: number; json: Record<string, unknown>; text: string }
async function viaApp(r: Rig, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Answer> {
  const res = await r.app.inject({ method, url, ...(body !== undefined ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { status: res.statusCode, text: res.payload, json: (res.payload.startsWith('{') ? JSON.parse(res.payload) : {}) as Record<string, unknown> };
}
async function viaRouter(r: Rig, method: string, url: string, body?: unknown): Promise<Answer> {
  const res = await r.router.handle(method, url, body === undefined ? undefined : JSON.stringify(body));
  const text = res.body as string;
  return { status: res.status, text, json: (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown> };
}

const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const putDoc = (doc: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, doc);
const storedDoc = (): ProfileDoc | null => { const d = store.defaultStore.getDoc('deviceCaches', KEY); return d && !d.deleted ? (d.data as ProfileDoc) : null; };
const PROBE = (eid: number | string) => `/device/definitions/blocks/${eid}/probe`;
const probeEvents = (r: Rig) => r.events.filter((e) => e.type === 'definitions' && e.reason === 'block-probe');

/** A probe walk that queries ids 0..`queryTo` (default: its ceiling) of its one block through the guarded transport
 *  (no reply: the mock stays silent) and answers `records` at that block. */
function fakeWalk(r: Rig, records: (block: number) => CacheRecord[], o: { queryTo?: number; never?: Promise<void> } = {}): ProbeOptions['walkImpl'] {
  return async (t: LiveTransport, opts: LiveWalkOptions) => {
    r.walks.push(opts);
    const block = opts.blocks![0]!;
    const to = o.queryTo ?? opts.maxParamId!;
    for (let pid = 0; pid <= to; pid++) await t.request(buildDefQuery(opts.model, block, pid));
    if (o.never) await o.never;
    const recs = records(block);
    return walkResult(recs, { queries: to + 1 });
  };
}

// ── 1. likely: generic, read-only, channels from the shape; PUT 409, nothing sent ───────────────────────────────────
async function likelyIsReadOnly(): Promise<void> {
  const doc = await byteDoc();
  const section = doc.sections.find((s) => s.tag === NEW_TAG);
  assertEqual(`${section?.key}/${section?.role}/${section?.stride}`, `section:${NEW_TAG}/new/${STRIDE}`, 'fixture: the new section is unassigned, role new');
  const profile = runtimeProfileFrom(doc, FM3P);
  for (const channels of [true, false]) {
    const { driver, mock } = mockBlockDevice(profile, { [NEW_EID]: { values: newBody({ channels }), channel: 1 } });
    const r = await driver.blockParams(NEW_EID, { generic: true });
    const at = `likely (${channels ? 'four slices' : 'one slice'})`;
    assertEqual(`${r.block}|${r.slug}|${r.page}|${r.unknownBlock}|${r.type}`, `Block ${NEW_EID}||-1|true|null`, `${at}: an unknown block`);
    const bm = r.definitions.blockMap!;
    assertEqual(`${bm.state}/${bm.key}/${bm.sectionTag}/${bm.evidence.join('+')}`, `likely/section:${NEW_TAG}/${NEW_TAG}/bulk-shape`, `${at}: likely, bound to the new section by its shape`);
    assertEqual(JSON.stringify(bm.probe), JSON.stringify({ available: false, reason: 'not-verified' }), `${at}: no probe gate on a bare driver`);
    assertEqual(r.definitions.family, `section:${NEW_TAG}`, `${at}: definitions.family = the key`);
    const index = buildParamIndex(profile, `section:${NEW_TAG}`);
    assertEqual(entriesOf(r).length, index.entries.length, `${at}: the section's params`);
    assertEqual(entriesOf(r).length, STRIDE - 1, `${at}: 10 rows minus the bypass, minus nothing else (generic, no type selector)`);
    assert(entriesOf(r).every((e) => e.generic && e.name === `P${e.id}` && e.isNew === true), `${at}: generic, new in firmware`);
    assert(entriesOf(r).every((e) => e.write === null && e.readOnlyReason === 'unconfirmed-block'), `${at}: every param read-only, unconfirmed-block`);
    assertEqual(r.definitions.hidden.map((h) => `${h.id}:${h.reason}`).join(','), '9:bypass', `${at}: the bypass is hidden`);
    assertEqual(r.definitions.channel, channels ? 1 : null, `${at}: the status channel of a four-slice body, none for one slice`);
    const sel = r.enums.find((e) => e.id === 2)!;
    assertEqual(`${sel.value}/${sel.options.map((x) => x.label).join(',')}`, '1/MODE A,MODE B,MODE C', `${at}: the selector reads its ordinal with the section's labels`);
    const sent = mock.sent.length;
    let refused: { statusCode?: number; message: string } | undefined;
    try { await driver.setParam(NEW_EID, 0, 0.5, true); } catch (e) { refused = { statusCode: (e as { statusCode?: number }).statusCode, message: (e as Error).message }; }
    assertEqual(refused?.statusCode, 409, `${at}: PUT refused`);
    assertEqual(refused?.message, `block ${NEW_EID} has no confirmed definitions on this device; write refused`, `${at}: the contract message`);
    assertEqual(mock.sent.length, sent, `${at}: nothing sent`);
  }
}

// ── 2. candidates / none: nothing listed, no guard; no section to match → no read at all ────────────────────────────
async function candidatesAndNone(): Promise<void> {
  // two identical sections: both fit
  const twin = runtimeProfileFrom(await byteDoc([...newBlock(NEW_TAG), ...newBlock(TWIN_TAG)]), FM3P);
  {
    const { driver, mock } = mockBlockDevice(twin, { [NEW_EID]: { values: newBody(), channel: 0 } });
    const r = await driver.blockParams(NEW_EID, { generic: true });
    const bm = r.definitions.blockMap!;
    assertEqual(`${bm.state}/${bm.key}/${(bm.candidates ?? []).join(',')}/${bm.evidence.join('+')}`, `candidates/null/${NEW_TAG},${TWIN_TAG}/bulk-shape`, 'two fitting sections: candidates');
    assertEqual(`${r.named.length}/${r.enums.length}/${r.definitions.family}/${r.unknownBlock}`, '0/0/null/true', 'candidates: nothing listed');
    const sent = mock.sent.length;
    assertEqual((await driver.setParam(NEW_EID, 0, 0.5, true)).ok, true, 'candidates: a write is not refused (no information, no guard)');
    assertEqual(writesIn(mock.sent.slice(sent)).length, 1, 'candidates: the write went out');
  }
  // a selector value no candidate section allows: nothing fits
  {
    const { driver, mock } = mockBlockDevice(runtimeProfileFrom(await byteDoc(), FM3P), { [NEW_EID]: { values: newBody({ badSelector: true }), channel: 0 } });
    const r = await driver.blockParams(NEW_EID, { generic: true });
    assertEqual(`${r.definitions.blockMap!.state}/${r.named.length + r.enums.length}`, 'none/0', 'an enum value out of bounds: none, nothing listed');
    const sent = mock.sent.length;
    await driver.setParam(NEW_EID, 0, 0.5, true);
    assertEqual(writesIn(mock.sent.slice(sent)).length, 1, 'none: not refused');
  }
  // no editor-cache section to match against (a live-only profile with no binding for the block, the bundled catalog)
  for (const [label, profile] of [['live-only profile', runtimeProfileFrom(profileDoc([liveSource(liveSeedRecords())]), FM3P)], ['bundled catalog', FM3P]] as const) {
    const { driver, mock } = mockBlockDevice(profile, { [NEW_EID]: { values: newBody(), channel: 0 } });
    const r = await driver.blockParams(NEW_EID, { generic: true });
    assertEqual(`${r.definitions.blockMap!.state}/${r.named.length + r.enums.length}`, 'none/0', `${label}: none`);
    assertEqual(mock.sent.length, 0, `${label}: nothing to match → nothing read`);
  }
}

// ── 3. live-only: generic from the live rows, read-only, PUT 409, nothing sent ──────────────────────────────────────
async function liveOnlyIsReadOnly(): Promise<void> {
  const doc = liveOnlyDoc();
  const entry = doc.blockMap.find((e) => e.eid === NEW_EID);
  assertEqual(`${entry?.confidence}/${entry?.key}/${entry?.evidence.join('+')}`, `confirmed/block:${NEW_EID}/live-only`, 'fixture: a live-only binding');
  const profile = runtimeProfileFrom(doc, FM3P);
  assertEqual(profile.familyForEffectId(NEW_EID), `block:${NEW_EID}`, 'the overlay resolves the block to its live family');
  const { driver, mock } = mockBlockDevice(profile, { [NEW_EID]: { values: newBody(), channel: 2 } });
  const r = await driver.blockParams(NEW_EID, { generic: true });
  const bm = r.definitions.blockMap!;
  assertEqual(`${bm.state}/${bm.key}/${bm.evidence.join('+')}/${r.unknownBlock}/${r.definitions.profile}`, `confirmed/block:${NEW_EID}/live-only/true/live`, 'confirmed by a live read only');
  assert(entriesOf(r).length > 0, 'its live rows are served');
  assert(entriesOf(r).every((e) => e.write === null && e.readOnlyReason === 'live-only-block'), 'every param read-only, live-only-block');
  assertEqual(r.definitions.channel, 2, 'four slices: the status channel is served');
  const sent = mock.sent.length;
  let status: number | undefined;
  try { await driver.setParam(NEW_EID, 3, 0.5, true); } catch (e) { status = (e as { statusCode?: number }).statusCode; }
  assertEqual(status, 409, 'PUT refused');
  assertEqual(mock.sent.length, sent, 'nothing sent');
  // the classic response stays the unknown block it was (nothing listed, nothing read)
  const before = mock.sent.length;
  const c = await driver.blockParams(NEW_EID);
  assertEqual(`${c.named.length}/${c.enums.length}/${mock.sent.length - before}`, '0/0/0', 'classic: unchanged, no read');
}

// ── 4. the probe: walk → live-probe source → confirmed → writable; SSE once; a re-probe replaces the probe ─────────
async function probeConfirmsAndEnablesWrites(): Promise<void> {
  clearDoc();
  const r = await makeRig({ blocks: { [NEW_EID]: { values: newBody(), channel: 1 } } });
  try {
    putDoc(await byteDoc());
    await r.registry.applyRuntimeCache();
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true)), now: () => '2026-11-22T11:00:00.000Z' });
    assertEqual((await viaApp(r, 'GET', '/preset/grid')).status, 200, 'grid read');
    let g = (await viaApp(r, 'GET', `/preset/blocks/${NEW_EID}/params?generic=1`)).json as unknown as BlockParamsV2DTO;
    assertEqual(`${g.definitions.blockMap!.state}/${JSON.stringify(g.definitions.blockMap!.probe)}`, 'likely/{"available":true}', 'before: likely, the probe is available (gate open, placed)');
    const put = await viaApp(r, 'PUT', `/preset/blocks/${NEW_EID}/params/0`, { value: 0.5, continuous: true });
    assertEqual(`${put.status}/${put.json.error}/${put.json.message}`, `409/Conflict/block ${NEW_EID} has no confirmed definitions on this device; write refused`, 'before: PUT 409 with the contract body');

    const sent = r.mock.sent.length;
    const res = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(res.status, 200, `probe: 200 (${res.text})`);
    const body = res.json as { ok: boolean; eid: number; records: number; blockMap: Record<string, unknown>; walk: { queries: number; pseudoReplies: unknown; lostReplies: number } };
    assertEqual(`${body.ok}/${body.eid}/${body.records}`, `true/${NEW_EID}/${STRIDE}`, 'probe: ok, the block, its records');
    const bm = body.blockMap as { confidence: string; key: string; sectionTag: number; evidence: string[]; compared: { rows: number; equal: number; probedTo: number } };
    assertEqual(`${bm.confidence}/${bm.key}/${bm.sectionTag}/${bm.evidence.join('+')}`, `confirmed/section:${NEW_TAG}/${NEW_TAG}/device-records`, 'probe: confirmed by device records against the new section');
    assertEqual(`${bm.compared.equal}/${bm.compared.rows}/${bm.compared.probedTo}`, `${STRIDE}/${STRIDE}/${STRIDE - 1 + 32}`, 'probe: every row equal, probed past the table end');
    assertEqual(`${body.walk.queries}/${body.walk.lostReplies}/${JSON.stringify(body.walk.pseudoReplies)}`, `${STRIDE + 32}/0/{"endMarker":0,"duplicateId":0,"implausible":0}`, 'probe: walk statistics');
    // the walk: one block, read-only, the shape's ceiling, no known size, values read, no hints, no write hook
    const w = r.walks[0]!;
    assertEqual(`${JSON.stringify(w.blocks)}/${w.maxParamId}/${w.readValues}/${w.mode}/${w.write}/${w.paramKnownSizeByBlock}/${w.paramBoundByBlock}/${w.enumHintByBlock}/${w.interQueryMs}/${w.blockPauseMs}`,
      `[${NEW_EID}]/${STRIDE - 1 + 32}/true/undefined/undefined/undefined/undefined/undefined/3/150`, 'probe walk options');
    const probeFrames = r.mock.sent.slice(sent);
    assertEqual(probeFrames.filter(isDefinitionQuery).length, STRIDE + 32, 'every definition query reached the wire');
    assertEqual(writesIn(probeFrames).length, 0, 'the probe wrote nothing');
    // persisted: the editor cache + the probe; re-applied
    const doc = storedDoc()!;
    assertEqual(doc.raw.sources.map((s) => `${s.kind}/${s.origin}`).join(','), 'editor-cache/local,live-probe/local', 'stored: the probe joined the editor cache');
    const probeSrc = doc.raw.sources[1]! as { scope: { blocks: number[]; maxParamId: number; above160: boolean; hinted: boolean }; capturedAt: string };
    assertEqual(`${probeSrc.scope.blocks.join(',')}/${probeSrc.scope.maxParamId}/${probeSrc.scope.above160}/${probeSrc.scope.hinted}/${probeSrc.capturedAt}`,
      `${NEW_EID}/${STRIDE - 1 + 32}/true/false/2026-11-22T11:00:00.000Z`, 'the probe source scope');
    assertEqual(doc.blockMap.find((e) => e.eid === NEW_EID)?.confidence, 'confirmed', 'stored block map');
    assertEqual(probeEvents(r).length, 1, 'SSE definitions/block-probe once');
    assertEqual(JSON.stringify(probeEvents(r)[0]), JSON.stringify({ type: 'definitions', reason: 'block-probe', key: KEY, eid: NEW_EID }), 'the event');
    // after: confirmed, the section's params, writable
    g = (await viaApp(r, 'GET', `/preset/blocks/${NEW_EID}/params?generic=1`)).json as unknown as BlockParamsV2DTO;
    const after = g.definitions.blockMap!;
    assertEqual(`${after.state}/${after.key}/${after.evidence.join('+')}/${g.unknownBlock}/${g.definitions.profile}`, `confirmed/section:${NEW_TAG}/device-records/true/byte-exact`, 'after: confirmed, the section key, byte-exact rows');
    assertEqual(entriesOf(g).length, STRIDE - 1, 'after: the section rows (10 minus the bypass, the type-less family)');
    assert(g.named.every((e) => e.write === 'norm' && e.readOnlyReason === undefined), 'after: dials write a normalised value');
    assert(g.enums.every((e) => e.write === 'ordinal'), 'after: selectors write an ordinal');
    const before = r.mock.sent.length;
    const ok = await viaApp(r, 'PUT', `/preset/blocks/${NEW_EID}/params/0`, { value: 0.5, continuous: true });
    assertEqual(ok.status, 200, 'after: PUT allowed');
    assertEqual(writesIn(r.mock.sent.slice(before)).length, 1, 'after: one SET went out');
    // the M2 guards still apply to the bound block: a pid no wire parameter → 400
    assertEqual((await viaApp(r, 'PUT', `/preset/blocks/${NEW_EID}/params/70000`, { value: 1, continuous: false })).status, 400, 'after: no wire pid → 400');
    // a second probe of the block replaces the first
    const again = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(again.status, 200, 're-probe: 200');
    assertEqual(storedDoc()!.raw.sources.filter((s) => s.kind === 'live-probe').length, 1, 're-probe: one probe source of the block');
    assertEqual(probeEvents(r).length, 2, 're-probe: one more event');
  } finally { await r.close(); clearDoc(); }
}

// ── 5. probe preconditions: every refusal before any device traffic, in the contract order ──────────────────────────
async function probePreconditions(): Promise<void> {
  clearDoc();
  // 503 no-device: no unit identified — and detection is not triggered
  {
    const r = await makeRig({ detect: false });
    try {
      const res = await viaApp(r, 'POST', PROBE(NEW_EID));
      assertEqual(`${res.status}/${res.json.error}`, '503/no-device', 'no unit identified: 503 no-device');
      assertEqual(r.mock.sent.length, 0, 'no-device: detection not triggered, nothing sent');
    } finally { await r.close(); }
  }
  // 501: not a gen-3 grid unit (an AM4)
  {
    const r = await makeRig({ model: 0x15, fw: null });
    try {
      const sent = r.mock.sent.length;
      const res = await viaApp(r, 'POST', PROBE(NEW_EID));
      assertEqual(JSON.stringify([res.status, res.json]), JSON.stringify([501, { error: 'unsupported', capability: 'blockProbe' }]), 'AM4: 501 unsupported blockProbe');
      assertEqual(r.mock.sent.length, sent, 'AM4: nothing sent');
    } finally { await r.close(); }
  }
  // 503 firmware-unknown, then 501 reason firmware (gate closed), on an FM3
  {
    const r = await makeRig({ fw: null });
    try {
      const sent = r.mock.sent.length;
      const res = await viaApp(r, 'POST', PROBE(NEW_EID));
      assertEqual(`${res.status}/${res.json.error}`, '503/firmware-unknown', 'unknown firmware: 503 firmware-unknown');
      assertEqual(r.mock.sent.length, sent, 'firmware-unknown: nothing sent');
    } finally { await r.close(); }
  }
  {
    const r = await makeRig({ probe: false });
    try {
      await viaApp(r, 'GET', '/preset/grid');
      const sent = r.mock.sent.length;
      const res = await viaApp(r, 'POST', PROBE(NEW_EID));
      assertEqual(`${res.status}/${res.json.error}/${res.json.capability}/${res.json.reason}/${res.json.firmware}`, '501/unsupported/blockProbe/firmware/12.0', 'gate closed (empty table, no override): 501 reason firmware');
      assertEqual(r.mock.sent.length, sent, 'gate closed: nothing sent');
    } finally { await r.close(); }
  }
  // with the gate open: 400 / 409 known-block / 404 / 409 refusal / 409 busy / 409 building — nothing sent for any
  const r = await makeRig({ blocks: { [NEW_EID]: { values: newBody(), channel: 0 } } });
  try {
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true)) });
    const refusal = async (label: string, eid: number | string, status: number, error: string): Promise<Answer> => {
      const sent = r.mock.sent.length;
      const res = await viaApp(r, 'POST', PROBE(eid));
      assertEqual(`${res.status}/${res.json.error}`, `${status}/${error}`, label);
      assertEqual(r.mock.sent.length, sent, `${label}: nothing sent`);
      const twin = await viaRouter(r, 'POST', PROBE(eid));
      assertEqual(`${twin.status}|${twin.text}`, `${res.status}|${res.text}`, `${label}: router twin parity`);
      return res;
    };
    for (const bad of ['abc', '16384', '-1', '1.5', '1e2', '0x10']) await refusal(`eid ${bad}: 400`, bad, 400, 'invalid-eid');
    const known = await refusal('a catalog block (DISTORT 58): 409 known-block', 58, 409, 'known-block');
    assertEqual(known.json.family, 'DISTORT', 'known-block names the family');
    await refusal('a virtual block (GLOBAL 1): 409 known-block', 1, 409, 'known-block');
    await refusal('a second Resonator instance (163, static roster): 409 known-block', 163, 409, 'known-block');
    await refusal('no grid read yet: 404 block-not-placed', NEW_EID, 404, 'block-not-placed');
    await viaApp(r, 'GET', '/preset/grid');
    await refusal('a block not in the grid: 404 block-not-placed', 204, 404, 'block-not-placed');
    // a stored doc a newer build wrote is never rewritten: 409 before the walk
    const newer = await byteDoc();
    (newer.raw as { format: number }).format = 99;
    putDoc(newer);
    await refusal('a newer build\'s doc: 409 newer-profile', NEW_EID, 409, 'newer-profile');
    clearDoc();
    // another exclusive device job
    assert(claimDevice(r.registry, 'capture'), 'fixture: claim for a capture');
    let res = await refusal('a capture runs: 409 busy', NEW_EID, 409, 'busy');
    assertEqual(res.json.what, 'capture', 'busy names the job');
    releaseDevice(r.registry, 'capture');
    assert(claimDevice(r.registry, 'cache-build'), 'fixture: claim for a build');
    res = await refusal('a build runs: 409 building', NEW_EID, 409, 'building');
    releaseDevice(r.registry, 'cache-build');
    // and a running probe keeps a build out
    assert(claimDevice(r.registry, 'block-probe'), 'fixture: claim for a probe');
    const build = await deviceCache.startCacheBuild(store.defaultStore, r.registry, {});
    assertEqual(JSON.stringify(build), JSON.stringify({ code: 409, body: { error: 'busy', what: 'block-probe' } }), 'a probe runs: a build answers 409 busy block-probe');
    releaseDevice(r.registry, 'block-probe');
    assertEqual(r.walks.length, 0, 'no refusal walked');
  } finally { await r.close(); clearDoc(); }
}

// ── 6. probe timeout (504), the watchdog at the wire, a failed walk: nothing stored, the claim held until settled ───
async function probeTimeoutAndWatchdog(): Promise<void> {
  clearDoc();
  const r = await makeRig({ blocks: { [NEW_EID]: { values: newBody(), channel: 0 } } });
  try {
    putDoc(await byteDoc());
    await r.registry.applyRuntimeCache();
    await viaApp(r, 'GET', '/preset/grid');
    const stored = JSON.stringify(storedDoc());
    // a walk that does not finish in time
    let release!: () => void;
    const never = new Promise<void>((resolve) => { release = resolve; });
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true), { never }), timeoutMs: 30 });
    const res = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${res.status}/${res.json.error}`, '504/probe-timeout', 'a walk past its time: 504 probe-timeout');
    assertEqual(JSON.stringify(storedDoc()), stored, 'timeout: nothing stored');
    assertEqual(probeEvents(r).length, 0, 'timeout: no event');
    const signal = r.walks[0]!.signal!;
    assertEqual(signal.aborted, true, 'timeout: the walk was told to stop');
    const busy = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${busy.status}/${busy.json.error}/${busy.json.what}`, '409/busy/block-probe', 'the device stays claimed until the walk settles');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // a faulty walk that queries above its ceiling: refused at the wire, nothing of it sent or stored
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true), { queryTo: STRIDE - 1 + 32 + 1 }) });
    const sent = r.mock.sent.length;
    const wd = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${wd.status}/${wd.json.error}`, '500/walk-bound', 'a query above the ceiling: 500 walk-bound');
    const frames = r.mock.sent.slice(sent).filter(isDefinitionQuery);
    assertEqual(frames.length, STRIDE + 32, 'the queries up to the ceiling went out, the one above it did not');
    assertEqual(JSON.stringify(storedDoc()), stored, 'watchdog: nothing stored');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // a walk that fails (the device stopped answering): 503 probe-failed, nothing stored
    __setProbeOptionsForTest(r.registry, { walkImpl: async () => { throw new Error('liveWalk: device stopped answering'); } });
    const failed = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${failed.status}/${failed.json.error}`, '503/probe-failed', 'a failed walk: 503 probe-failed');
    assertEqual(JSON.stringify(storedDoc()), stored, 'failed: nothing stored');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // the device is free again
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true)) });
    assertEqual((await viaApp(r, 'POST', PROBE(NEW_EID))).status, 200, 'afterwards a probe runs');
  } finally { await r.close(); clearDoc(); }
}

// ── 7. a probe without an editor-cache source: ceiling 127, live-only binding (read-only); router twin parity ─────
async function probeWithoutByteSource(): Promise<void> {
  clearDoc();
  const r = await makeRig({ blocks: { [NEW_EID]: { values: newBody(), channel: 0 } } });
  try {
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true)), now: () => STAMP });
    await viaApp(r, 'GET', '/preset/grid');
    const before = r.mock.sent.length;
    const res = await viaRouter(r, 'POST', PROBE(NEW_EID));
    assertEqual(res.status, 200, `router twin probe: 200 (${res.text})`);
    assertEqual(r.walks[0]!.maxParamId, 127, 'no editor-cache source: the probe cap');
    assertEqual(r.mock.sent.slice(before).filter(isDefinitionQuery).length, 128, 'ids 0..127 queried');
    const bm = res.json.blockMap as { confidence: string; key: string; evidence: string[] };
    assertEqual(`${bm.confidence}/${bm.key}/${bm.evidence.join('+')}`, `confirmed/block:${NEW_EID}/live-only`, 'a live-only binding');
    const g = (await viaApp(r, 'GET', `/preset/blocks/${NEW_EID}/params?generic=1`)).json as unknown as BlockParamsV2DTO;
    assert(entriesOf(g).length > 0 && entriesOf(g).every((e) => e.write === null && e.readOnlyReason === 'live-only-block'), 'served read-only, live-only-block');
    const sent = r.mock.sent.length;
    const put = await viaRouter(r, 'PUT', `/preset/blocks/${NEW_EID}/params/0`, { value: 0.5, continuous: true });
    const putApp = await viaApp(r, 'PUT', `/preset/blocks/${NEW_EID}/params/0`, { value: 0.5, continuous: true });
    assertEqual(`${put.status}|${put.text}`, `${putApp.status}|${putApp.text}`, 'PUT 409: router twin parity');
    assertEqual(JSON.stringify(putApp.json), JSON.stringify({ statusCode: 409, error: 'Conflict', message: `block ${NEW_EID} has no confirmed definitions on this device; write refused` }), 'the contract 409 body');
    assertEqual(r.mock.sent.length, sent, 'nothing sent');
    // the same probe through the app answers like the router twin did (walk and stamp alike)
    const viaAppRes = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(viaAppRes.text, res.text, 'probe: app and router twin answer alike');
  } finally { await r.close(); clearDoc(); }
}

// ── 8. FORGEFX-45: the six Axe-Fx III roster ids are reachable read-only; never walk-hinted or bounded ─────────────
async function iiiRosterReadOnly(): Promise<void> {
  const AX = PROFILES[AXE3]!;
  const ROSTER: Record<number, string> = { 36: 'IRCAPTURE', 134: 'VOCODER', 142: 'CROSSOVER', 170: 'TONEMATCH', 174: 'RTA', 195: 'IRPLAYER' };
  const eids = Object.keys(ROSTER).map(Number);
  const { driver, mock } = mockGen3Device(AX, eids);
  for (const eid of eids) {
    const fam = ROSTER[eid]!;
    assertEqual(AX.familyForEffectId(eid), fam, `III ${eid}: the effect-id table names ${fam}`);
    const r = await driver.blockParams(eid, { generic: true });
    const bm = r.definitions.blockMap!;
    assertEqual(`${r.definitions.family}/${r.unknownBlock}/${bm.state}/${bm.key}/${bm.evidence.join('+')}/${bm.probe.available}/${bm.probe.reason}`,
      `${fam}/undefined/likely/${fam}/roster/false/undefined`, `III ${eid}: a roster binding, served, no probe`);
    assertEqual(entriesOf(r).length, buildParamIndex(AX, fam).entries.length, `III ${eid}: the named catalog params`);
    assert(entriesOf(r).every((e) => !e.generic && e.write === null && e.readOnlyReason === 'unconfirmed-block'), `III ${eid}: named, every one read-only`);
    const sent = mock.sent.length;
    let status: number | undefined;
    try { await driver.setParam(eid, 0, 0.5, true); } catch (e) { status = (e as { statusCode?: number }).statusCode; }
    assertEqual(status, 409, `III ${eid}: PUT refused`);
    assertEqual(mock.sent.length, sent, `III ${eid}: nothing sent`);
    // static roster: described, flagged roster; no hints, no known size, no bound
    const ref = staticRoster(AXE3).get(eid);
    assertEqual(`${ref?.family}/${ref?.roster}`, `${fam}/true`, `III ${eid}: in the static roster, roster-only`);
    assertEqual(staticFamilyForEffectId(AXE3, eid), fam, `III ${eid}: described for the unmapped-block gap`);
  }
  const hints = deviceCache.walkEnumHints(AXE3);
  const full = deviceCache.walkBlockLimits(AXE3, 'full');
  const ro = deviceCache.walkBlockLimits(AXE3, 'read-only');
  for (const eid of [...eids, 135, 143]) {
    assertEqual(hints[eid], undefined, `III ${eid}: never walk-hinted`);
    assertEqual(`${full.knownSize[eid]}/${ro.knownSize[eid]}/${ro.bound[eid]}`, 'undefined/undefined/undefined', `III ${eid}: no known size, no read-only bound`);
    assertEqual(full.bound[eid], 127, `III ${eid}: full mode keeps the unknown-block envelope`);
  }
  // a verified III family keeps its hints and limits (the III table now drives the roster)
  assert(hints[70] !== undefined && full.knownSize[70] !== undefined, 'III DELAY 70: hinted and sized as before');
  // the FM3 / FM9 tables have no roster-only entry
  for (const model of [FM3, 0x12]) assert([...staticRoster(model).values()].every((ref) => !ref.roster), `0x${model.toString(16)}: no roster-only entry`);
  // every reserved instance slot of a roster family is served like its first id: named, read-only, 409, no probe
  const INSTANCES: Record<number, string> = { 135: 'VOCODER', 137: 'VOCODER', 143: 'CROSSOVER', 171: 'TONEMATCH', 177: 'RTA', 196: 'IRPLAYER', 198: 'IRPLAYER' };
  for (const [k, fam] of Object.entries(INSTANCES)) {
    const eid = Number(k);
    const stride = AX.rangeSections[fam]?.stride ?? 1;
    const { driver: d, mock: m } = mockBlockDevice(AX, { [eid]: { values: Array.from({ length: stride }, (_, i) => (i * 997) % 65535), channel: 0 } });
    const r = await d.blockParams(eid, { generic: true });
    const bm = r.definitions.blockMap!;
    assertEqual(`${r.definitions.family}/${r.unknownBlock}/${bm.state}/${bm.key}/${JSON.stringify(bm.probe)}`, `${fam}/undefined/likely/${fam}/{"available":false}`, `III instance ${eid}: served like its first id, no probe`);
    assert(entriesOf(r).length > 0 && entriesOf(r).every((e) => !e.generic && e.write === null && e.readOnlyReason === 'unconfirmed-block'), `III instance ${eid}: named, read-only`);
    const sent = m.sent.length;
    let status: number | undefined;
    try { await d.setParam(eid, 0, 0.5, true); } catch (e) { status = (e as { statusCode?: number }).statusCode; }
    assertEqual(`${status}/${m.sent.length - sent}`, '409/0', `III instance ${eid}: PUT 409, nothing sent`);
  }
  // IR Capture lists nothing: its response reads nothing from the unit
  const ir = mockBlockDevice(AX, { 36: { values: [1], channel: 0 } });
  const irRes = await ir.driver.blockParams(36, { generic: true });
  assertEqual(`${irRes.definitions.family}/${entriesOf(irRes).length}/${ir.mock.sent.length}`, 'IRCAPTURE/0/0', 'III 36: an empty family is not read');
}

// ── 9. the development hook: what it hides, one warning, ignored in production / when malformed ────────────────────
async function hideHookScope(): Promise<void> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try {
    await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'RESONATOR', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, () => {
      assertEqual(hiddenFamily(), 'RESONATOR', 'the hook names the family');
      const cat = profileCatalogFor(FM3);
      assertEqual(Object.prototype.hasOwnProperty.call(cat.familyFirstEid ?? {}, 'RESONATOR'), false, 'familyFirstEid: dropped');
      assertEqual(cat.familyFirstEid?.FORMANT, 98, 'familyFirstEid: the others stay');
      assertEqual((cat.sections ?? []).some((s) => s.family === 'RESONATOR' || s.tag === 39), false, 'section inventory: its tag is gone');
      assertEqual(`${cat.ranges?.RESONATOR}/${cat.rosters?.RESONATOR}/${cat.instanceLimits?.RESONATOR}`, 'undefined/undefined/undefined', 'reference rows, roster, instance count: dropped');
      assertEqual(catalogForModel(FM3).params.some((p) => p.family === 'RESONATOR'), false, 'voter params: dropped');
      assertEqual(`${staticRoster(FM3).get(162)}/${staticRoster(FM3).get(163)}/${staticFamilyForEffectId(FM3, 162)}`, 'undefined/undefined/undefined', 'static roster / owners: dropped');
      assertEqual(FM3P.familyForEffectId(162), undefined, 'static effect table: dropped');
      assertEqual(deviceCache.walkBlockLimits(FM3, 'full').knownSize[162], undefined, 'walk limits: no known size');
      assertEqual(PROFILES[AXE3]!.familyForEffectId(162), undefined, 'every model hides it');
      hiddenFamily();
    });
    assertEqual(warnings.filter((w) => w.includes('FORGEFX_DEFS_HIDE_FAMILY')).length, 1, 'one warning line for the value');
    // back to normal
    assertEqual(hiddenFamily(), null, 'unset: nothing hidden');
    assertEqual(profileCatalogFor(FM3).familyFirstEid?.RESONATOR, 162, 'unset: familyFirstEid has it again');
    assertEqual(staticRoster(FM3).get(162)?.family, 'RESONATOR', 'unset: the static roster has it again');
    warnings.length = 0;
    await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'RESONATOR', FORGEFX_DEV_HOOKS: '1', NODE_ENV: 'production' }, () => {
      assertEqual(hiddenFamily(), null, 'production: ignored');
      assertEqual(profileCatalogFor(FM3).familyFirstEid?.RESONATOR, 162, 'production: nothing hidden');
    });
    assertEqual(warnings.length === 1 && warnings[0]!.includes('ignored in production'), true, 'production: one warning that it is ignored');
    warnings.length = 0;
    await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'resonator', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, () => {
      assertEqual(hiddenFamily(), null, 'malformed (lower case): ignored');
      hiddenFamily();
    });
    assertEqual(warnings.length, 1, 'malformed: one warning');
  } finally { console.warn = warn; }
}

// ── 10. leave-one-out RESONATOR (162, above 160): likely → probe → confirmed section:39 ────────────────────────────
async function leaveOneOutResonator(): Promise<void> {
  clearDoc();
  await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'RESONATOR', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, async () => {
    await quietly(async () => {
      const stride = FM3P.rangeSections.RESONATOR!.stride; // 40
      const rows = (section: number) => widenTable(familyRecords('RESONATOR', section), section, stride);
      const informative = familyRecords('RESONATOR', 39).length;
      const body = (() => {
        const slice = Array.from({ length: stride }, (_, pid) => (pid * 997) % 65535);
        return [...slice, ...slice, ...slice, ...slice];
      })();
      const r = await makeRig({ placed: [162], blocks: { 162: { values: body, channel: 0 } } });
      try {
        const doc = await byteDoc(rows(39));
        const s39 = doc.sections.find((s) => s.tag === 39);
        assertEqual(`${s39?.key}/${s39?.role}`, 'section:39/new', 'hidden: the Resonator section stays section:39, role new');
        assertEqual(doc.meta.derivedHidden as unknown, 'RESONATOR', 'the derivation is marked');
        putDoc(doc);
        await r.registry.applyRuntimeCache();
        await viaApp(r, 'GET', '/preset/grid');
        let g = (await viaApp(r, 'GET', '/preset/blocks/162/params?generic=1')).json as unknown as BlockParamsV2DTO;
        assertEqual(`${g.unknownBlock}/${g.definitions.blockMap!.state}/${g.definitions.blockMap!.sectionTag}/${g.definitions.channel}`, 'true/likely/39/0', '162: an unknown block, likely section 39 (four slices)');
        assert(entriesOf(g).every((e) => e.write === null), '162 likely: every write null');
        const sent = r.mock.sent.length;
        assertEqual((await viaApp(r, 'PUT', '/preset/blocks/162/params/1', { value: 0.5, continuous: true })).status, 409, '162 likely: PUT 409');
        assertEqual(r.mock.sent.length, sent, '162 likely: nothing sent');
        __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, rows) });
        const res = await viaApp(r, 'POST', PROBE(162));
        assertEqual(res.status, 200, `162 probe: 200 (${res.text})`);
        const bm = res.json.blockMap as { confidence: string; sectionTag: number; key: string; compared: { rows: number; equal: number } };
        assertEqual(`${bm.confidence}/${bm.sectionTag}/${bm.key}/${bm.compared.equal === bm.compared.rows}`, 'confirmed/39/section:39/true', '162 probe: confirmed against section 39, every row equal');
        assertEqual(r.walks[0]!.maxParamId, Math.min(stride - 1 + 32, 127), '162 probe: ceiling from the Resonator stride');
        g = (await viaApp(r, 'GET', '/preset/blocks/162/params?generic=1')).json as unknown as BlockParamsV2DTO;
        assertEqual(`${g.definitions.blockMap!.state}/${entriesOf(g).length}`, `confirmed/${informative}`, '162 after: confirmed, the generic count = the section\'s informative rows');
        assert(entriesOf(g).every((e) => e.generic && e.write === 'norm'), '162 after: generic and writable');
      } finally { await r.close(); clearDoc(); }
    });
  });
}

// ── 11. leave-one-out FORMANT (98, ≤ 160): confirmed from a read-only walk, no probe; the stored derivation follows
//        the hook both ways (meta.derivedHidden) ─────────────────────────────────────────────────────────────────────
async function leaveOneOutFormant(): Promise<void> {
  const s = createStore(createMemStoreBackend(), nodeCodec);
  const formant = (section: number) => familyRecords('FORMANT', section);
  const eCache = await editorCacheSource([...cacheSeedRecords(), ...formant(21)]);
  const walk = liveSource([...liveSeedRecords(), ...formant(98)]);
  const doc = profileDoc([eCache, walk]); // derived without the hook
  assertEqual(doc.blockMap.some((e) => e.eid === 98), false, 'unhidden: 98 is a FORMANT block, not in the block map');
  s.putDoc('deviceCaches', KEY, doc);
  await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'FORMANT', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, async () => {
    silent(() => hiddenFamily());
    const loaded = upgradeStoredProfile(s, KEY);
    assertEqual(`${loaded.state}/${loaded.state === 'usable' ? loaded.rederived : ''}`, 'usable/revision', 'hidden: the stored doc re-derives');
    const used = loaded.state === 'usable' ? (loaded.profile as unknown as ProfileDoc) : null;
    const e = used?.blockMap.find((x) => x.eid === 98);
    assertEqual(`${e?.confidence}/${e?.key}/${e?.sectionTag}/${e?.evidence.join('+')}`, 'confirmed/section:21/21/device-records', 'hidden: 98 confirmed from the read-only walk alone');
    const profile = runtimeProfileFrom(used!, FM3P);
    assertEqual(profile.familyForEffectId(98), 'section:21', 'hidden: the overlay serves 98 under the section');
    assertEqual((s.getDoc('deviceCaches', KEY)!.data as ProfileDoc).meta.derivedHidden as unknown, 'FORMANT', 'written back, marked');
  });
  const back = loadUsableProfile(s, KEY) as unknown as ProfileDoc;
  assertEqual(`${back.meta.derivedHidden}/${back.blockMap.some((e) => e.eid === 98)}`, 'undefined/false', 'unhidden again: the marked doc re-derives without the hook');
}

// ── 12. walk-scope gates: fail closed, the override (tokens, production), the registry hook ───────────────────────
async function walkScopeGatesFailClosed(): Promise<void> {
  assertEqual(Object.keys(WALK_SCOPE_VERIFIED_FW).length, 0, 'the verified table is empty in this build');
  const none = '{"extendedIds":false,"above160":false,"blockProbe":false,"farIds":false}';
  assertEqual(JSON.stringify(walkScopeGates(FM3, { major: 13, minor: 0 })), none, 'FM3 13.0 without override: all closed');
  assertEqual(JSON.stringify(walkScopeGates(FM3, null, new Set(['probe', 'extended', 'above160']))), none, 'unknown firmware: closed whatever the override');
  assertEqual(JSON.stringify(walkScopeGates(FM3, { major: 13, minor: 0 }, new Set(['probe']))), '{"extendedIds":false,"above160":false,"blockProbe":true,"farIds":false}', 'override probe: blockProbe only');
  const p = parseWalkScopeOverride(' extended , probe, farIds,,above160 ');
  assertEqual(`${[...p.flags].join(',')}|${p.malformed.join(',')}`, 'extended,probe,above160|farIds', 'override tokens (farIds is never one)');
  const prod = silent(() => walkScopeOverrideFromEnv({ FORGEFX_WALK_SCOPE_OVERRIDE: 'probe', FORGEFX_DEV_HOOKS: '1', NODE_ENV: 'production' }));
  assertEqual(prod.size, 0, 'production: the override is ignored');
  const dev = silent(() => walkScopeOverrideFromEnv({ FORGEFX_WALK_SCOPE_OVERRIDE: 'probe', FORGEFX_DEV_HOOKS: '1' }));
  assertEqual([...dev].join(','), 'probe', 'development: the override opens the probe');
  // a registry without the hook (Browser Direct) keeps every gate closed; the Node hook reads the environment
  const r = await makeRig({ probe: false });
  try {
    assertEqual(r.registry.walkScopeGates().blockProbe, false, 'no override: closed');
    const viaEnv = await withEnv({ FORGEFX_WALK_SCOPE_OVERRIDE: 'probe', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, async () => {
      const m = new MockTransport('serial', 'mock-env');
      m.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(FM3)] : req[5] === 0x08 ? [firmwareVersionReply(FM3, 13, 0)] : []);
      const reg = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: m.label }), openConn: () => m });
      await quietly(() => reg.detect());
      return silent(() => reg.walkScopeGates());
    });
    assertEqual(viaEnv.blockProbe, true, 'the Node registry reads FORGEFX_WALK_SCOPE_OVERRIDE');
  } finally { await r.close(); }
}

// ── 13. one confidence → state mapping, shared by the generic params and the definitions diff ─────────────────────
async function sharedStateMapping(): Promise<void> {
  assert(diffBlockMapState === blockMapState, 'the diff uses the shared mapping itself');
  const cases: Array<[unknown, string]> = [['confirmed', 'confirmed'], ['catalog', 'confirmed'], ['likely', 'likely'], ['roster', 'likely'], ['candidate', 'candidates'], ['pack', 'none'], [undefined, 'none']];
  assertEqual(cases.map(([c]) => blockMapState(c)).join(','), cases.map(([, s]) => s).join(','), 'confidence → state');
  assertEqual(BLOCK_MAP_WRITES_ENABLED, true, 'the kill switch is on (writes to byte-bridged blocks allowed)');
  const acc = (e: Parameters<typeof blockMapAccess>[0]) => { const a = blockMapAccess(e); return `${a.state}/${a.serves}/${a.writable}/${a.readOnlyReason ?? '-'}`; };
  assertEqual([
    acc({ confidence: 'confirmed', evidence: ['device-records'] }), acc({ confidence: 'confirmed', evidence: ['live-only'] }), acc({ confidence: 'confirmed', evidence: ['pack'] }),
    acc({ confidence: 'likely', evidence: ['bulk-shape'] }), acc({ confidence: 'roster', evidence: ['roster'] }), acc({ confidence: 'candidate', evidence: [] }), acc(undefined)
  ].join(' '), 'confirmed/true/true/- confirmed/true/false/live-only-block confirmed/true/true/- likely/true/false/unconfirmed-block likely/true/false/unconfirmed-block candidates/false/true/- none/false/true/-', 'served / writable per state');
  // the diff reports a persisted candidate as candidates (it used to fold every non-confirmed entry there; an unknown
  // confidence is none now)
  const doc = newerFirmwareDoc();
  doc.blockMap = [...doc.blockMap,
    { eid: 204, key: null, sectionTag: null, confidence: 'candidate', evidence: ['device-records'], candidates: [60, 61], channels: null },
    { eid: 206, key: null, sectionTag: null, confidence: 'future' as never, evidence: [], channels: null }];
  const profile = runtimeProfileFrom(doc, FM3P);
  const r = definitionsDiff({ model: FM3, firmware: '12.0', state: 'none', staticProfile: FM3P, applied: { key: KEY, doc, profile } }, { include: new Set(['blocks']) });
  assert(r.ok, 'diff built');
  const states = (r.ok ? r.diff.blocks ?? [] : []).map((b) => `${b.eid}:${b.state}`).join(',');
  assertEqual(states, '203:confirmed,204:candidates,206:none', 'diff states through the shared mapping');
}

// ── 14. the classic response and an unknown block on the bundled catalog: unchanged ────────────────────────────────
async function classicUnchanged(): Promise<void> {
  // a byte-bridged confirmed block: the classic response stays the unknown-block shape (nothing listed, nothing read)
  const doc = await byteDoc();
  const probe = rawFromLiveWalk(walkResult(newBlock(NEW_EID, true)),
    { blocks: [NEW_EID], maxParamId: STRIDE - 1 + 32, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-probe', capturedAt: STAMP, firmware: '12.0', origin: 'local' });
  const merged = profileDoc([...doc.raw.sources, probe]);
  assertEqual(merged.blockMap.find((e) => e.eid === NEW_EID)?.confidence, 'confirmed', 'fixture: confirmed');
  const profile: DeviceProfile = runtimeProfileFrom(merged, FM3P);
  const { driver, mock } = mockBlockDevice(profile, { [NEW_EID]: { values: newBody(), channel: 0 } });
  const c = await driver.blockParams(NEW_EID);
  assertEqual(JSON.stringify(c), JSON.stringify({ block: '', slug: '', page: -1, named: [], enums: [], type: null }), 'classic: the unknown-block shape');
  assertEqual(mock.sent.length, 0, 'classic: nothing read');
  // a catalog block keeps its exact generic response (no blockMap key)
  const g = await driver.blockParams(70, { generic: true });
  assertEqual(`${g.definitions.family}/${g.definitions.blockMap}/${g.unknownBlock}`, 'DELAY/undefined/undefined', 'a catalog block carries no blockMap');
}

// ── 15. an instance block shares its group's key; a bridged block leaves no `block:<eid>` family behind ───────────────
async function instanceAndBridgedKeys(): Promise<void> {
  const blocks = [...Array.from({ length: 161 }, (_, i) => i), NEW_EID, NEW_EID + 1];
  const walk = rawFromLiveWalk(walkResult([...liveSeedRecords(), ...newBlock(NEW_EID, true), ...newBlock(NEW_EID + 1, true)]),
    { blocks, maxParamId: 127, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-readonly', capturedAt: STAMP, firmware: '12.0', origin: 'local' });
  const syntheticKeys = (doc: ProfileDoc) => [...new Set([...Object.keys(doc.ranges), ...Object.keys(doc.rangeSections), ...doc.sections.map((s) => s.key)])]
    .filter((k) => k.includes(':')).sort().join(',');
  // bridged: both blocks are bound to the section; no block family remains anywhere
  const bridged = profileDoc([...(await byteDoc()).raw.sources, walk]);
  assertEqual(syntheticKeys(bridged), `section:${NEW_TAG}`, 'bridged: only the section key');
  const pb = runtimeProfileFrom(bridged, FM3P);
  assertEqual(`${pb.familyForEffectId(NEW_EID)}/${pb.familyForEffectId(NEW_EID + 1)}`, `section:${NEW_TAG}/section:${NEW_TAG}`, 'bridged: both blocks served under the section');
  // live only: the second, identical block is an instance of the first — one family, the group's key
  const live = profileDoc([walk]);
  assertEqual(syntheticKeys(live), `block:${NEW_EID}`, 'live only: the group key only (no block family of the instance)');
  const pl = runtimeProfileFrom(live, FM3P);
  assertEqual(`${pl.familyForEffectId(NEW_EID)}/${pl.familyForEffectId(NEW_EID + 1)}`, `block:${NEW_EID}/block:${NEW_EID}`, 'live only: the instance is served under the group key');
  assertEqual(`${pl.blockMapFor!(NEW_EID + 1)?.evidence.join('+')}`, 'live-only', 'live only: the instance is read-only too');
}

// ── 16. a block served `likely` stays read-only whatever persisted entry it has; a failed re-read keeps the refusal;
//        a pid without a row of a section family is refused ─────────────────────────────────────────────────────────
async function likelyGuardHolds(): Promise<void> {
  const refusedPut = async (driver: ReturnType<typeof mockBlockDevice>['driver'], mock: MockTransport, pid: number, at: string, message?: string) => {
    const sent = mock.sent.length;
    let refused: { statusCode?: number; message: string } | undefined;
    try { await driver.setParam(NEW_EID, pid, 0.5, true); } catch (e) { refused = { statusCode: (e as { statusCode?: number }).statusCode, message: (e as Error).message }; }
    assertEqual(refused?.statusCode, 409, `${at}: PUT refused`);
    if (message !== undefined) assertEqual(refused?.message, message, `${at}: message`);
    assertEqual(mock.sent.length, sent, `${at}: nothing sent`);
  };
  const base = await byteDoc();
  const variants: Array<[string, ProfileDoc['blockMap'][number]]> = [
    ['a persisted candidate without candidates (a probe that bound nothing)', { eid: NEW_EID, key: null, sectionTag: null, confidence: 'candidate', evidence: ['device-records'], candidates: [], channels: null }],
    ['a persisted candidate with candidates', { eid: NEW_EID, key: null, sectionTag: null, confidence: 'candidate', evidence: ['device-records'], candidates: [NEW_TAG, TWIN_TAG], channels: null }],
    ['a confirmed byte-bridged entry whose key the profile does not serve', { eid: NEW_EID, key: 'section:99', sectionTag: 99, confidence: 'confirmed', evidence: ['device-records'], compared: { rows: 9, equal: 9, probedTo: 41 }, channels: null }]
  ];
  for (const [label, entry] of variants) {
    const doc = { ...base, blockMap: [...base.blockMap.filter((e) => e.eid !== NEW_EID), entry] } as ProfileDoc;
    const profile = runtimeProfileFrom(doc, FM3P);
    assertEqual(profile.blockMapFor!(NEW_EID)?.confidence, entry.confidence, `${label}: fixture`);
    const block: MockBlock = { values: newBody(), channel: 0 };
    const { driver, mock } = mockBlockDevice(profile, { [NEW_EID]: block });
    const r = await driver.blockParams(NEW_EID, { generic: true });
    assertEqual(`${r.definitions.blockMap!.state}/${r.definitions.blockMap!.sectionTag}`, `likely/${NEW_TAG}`, `${label}: served likely by its shape`);
    assert(entriesOf(r).every((e) => e.write === null), `${label}: every write null`);
    await refusedPut(driver, mock, 0, label, `block ${NEW_EID} has no confirmed definitions on this device; write refused`);
    // a re-read that fails says nothing new: the refusal stands
    block.silent = true;
    const failed = await driver.blockParams(NEW_EID, { generic: true });
    assert(failed.readError !== undefined, `${label}: the re-read failed`);
    await refusedPut(driver, mock, 0, `${label}, after a failed re-read`);
    // a successful re-read that fits nothing lifts it (no information again)
    block.silent = false;
    block.values = newBody({ badSelector: true });
    await driver.blockParams(NEW_EID, { generic: true });
    const sent = mock.sent.length;
    await driver.setParam(NEW_EID, 0, 0.5, true);
    assertEqual(writesIn(mock.sent.slice(sent)).length, 1, `${label}: a read that fits nothing lifts the refusal`);
  }
  // a confirmed byte-bridged block: a pid its section has no informative row for is refused
  const probe = rawFromLiveWalk(walkResult(newBlock(NEW_EID, true)),
    { blocks: [NEW_EID], maxParamId: STRIDE - 1 + 32, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-probe', capturedAt: STAMP, firmware: '12.0', origin: 'local' });
  const confirmed = runtimeProfileFrom(profileDoc([...base.raw.sources, probe]), FM3P);
  const { driver, mock } = mockBlockDevice(confirmed, { [NEW_EID]: { values: newBody(), channel: 0 } });
  await refusedPut(driver, mock, STRIDE + 5, 'a section pid without a row', `param ${STRIDE + 5} of block ${NEW_EID} has no definition on this device; write refused`);
  const sent = mock.sent.length;
  await driver.setParam(NEW_EID, 1, 0.5, true);
  assertEqual(writesIn(mock.sent.slice(sent)).length, 1, 'a section pid with a row is written');
}

// ── 17. the probe above effect id 160 also needs the above-160 gate (route and availability) ─────────────────────
async function above160Gate(): Promise<void> {
  clearDoc();
  const LOW = 41; // an FM3 effect id no static table places, below 161
  const r = await makeRig({ probe: 'probe-only', placed: [NEW_EID, LOW], blocks: { [NEW_EID]: { values: newBody(), channel: 0 }, [LOW]: { values: newBody(), channel: 0 } } });
  try {
    __setProbeOptionsForTest(r.registry, { walkImpl: fakeWalk(r, (b) => newBlock(b, true)) });
    putDoc(await byteDoc());
    await r.registry.applyRuntimeCache();
    await viaApp(r, 'GET', '/preset/grid');
    const gHigh = (await viaApp(r, 'GET', `/preset/blocks/${NEW_EID}/params?generic=1`)).json as unknown as BlockParamsV2DTO;
    const gLow = (await viaApp(r, 'GET', `/preset/blocks/${LOW}/params?generic=1`)).json as unknown as BlockParamsV2DTO;
    assertEqual(`${JSON.stringify(gHigh.definitions.blockMap!.probe)}|${JSON.stringify(gLow.definitions.blockMap!.probe)}`, '{"available":false,"reason":"not-verified"}|{"available":true}', 'availability: 203 needs the above-160 gate, 41 does not');
    const sent = r.mock.sent.length;
    const high = await viaApp(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${high.status}/${high.json.error}/${high.json.capability}/${high.json.reason}/${high.json.scope}`, '501/unsupported/blockProbe/firmware/above160', '203 without the above-160 gate: 501 scope above160');
    assertEqual(r.mock.sent.length, sent, '203: nothing sent');
    const twin = await viaRouter(r, 'POST', PROBE(NEW_EID));
    assertEqual(`${twin.status}|${twin.text}`, `${high.status}|${high.text}`, '203: router twin parity');
    const low = await viaApp(r, 'POST', PROBE(LOW));
    assertEqual(low.status, 200, `41 with the probe gate alone: 200 (${low.text})`);
    assertEqual(`${r.walks.length}/${JSON.stringify(r.walks[0]!.blocks)}`, `1/[${LOW}]`, 'only the low block was walked');
  } finally { await r.close(); clearDoc(); }
  // a III roster instance slot is a known block for the route as for the availability
  const iii = await makeRig({ model: AXE3, fw: [32, 6], placed: [135] });
  try {
    await viaApp(iii, 'GET', '/preset/grid');
    const sent = iii.mock.sent.length;
    const res = await viaApp(iii, 'POST', PROBE(135));
    assertEqual(`${res.status}/${res.json.error}/${res.json.family}/${iii.mock.sent.length - sent}`, '409/known-block/VOCODER/0', 'III 135: 409 known-block, nothing sent');
  } finally { await iii.close(); }
}

// ── 18. the development hook never reaches the cloud: publish and contribution refused, the marker stripped, the
//        .axisdefs export carries raw sources only ───────────────────────────────────────────────────────────────────
async function devHookNeverShared(): Promise<void> {
  clearDoc();
  const r = await makeRig({ probe: false });
  try {
    const published: unknown[] = [];
    const cloud: DeviceProfileCloud = {
      deviceProfileGet: async () => null,
      deviceProfilePublish: async (body) => { published.push(body); return { code: 201, body: { ok: true } }; }
    };
    const uploads: unknown[] = [];
    const contributionCloud = { hasAccountSession: () => false, editorCacheWanted: async () => true, editorCacheUpload: async (b: Uint8Array) => { uploads.push(b); return { code: 200, body: {} }; }, editorCacheDelete: async () => ({ code: 200, body: {} }), editorCacheUploader: () => null } as unknown as ContributionCloud;
    const flags = parseContributionFlags({ consent: true, consentVersion: 2 });
    assert(flags.ok, 'fixture: contribution flags');
    putDoc(await byteDoc());
    await withEnv({ FORGEFX_DEFS_HIDE_FAMILY: 'FORMANT', FORGEFX_DEV_HOOKS: '1', NODE_ENV: undefined }, async () => {
      silent(() => hiddenFamily());
      const pub = await cloudCachePublish(cloud, store.defaultStore, r.registry);
      assertEqual(`${pub.code}/${(pub.body as { error?: string }).error}`, '409/dev-hook-active', 'hook active: publish refused');
      const con = await contribute(store.defaultStore, r.registry, contributionCloud, { bytes: new Uint8Array(8), name: 'effectDefinitions_11_12p0.cache' }, flags.ok ? flags.flags : (undefined as never));
      assertEqual(`${con.code}/${(con.body as { error?: string }).error}`, '409/dev-hook-active', 'hook active: contribution refused');
      // the stored doc re-derives under the hook (marked); the export carries the raw sources only
      await r.registry.applyRuntimeCache();
      assertEqual(storedDoc()!.meta.derivedHidden as unknown, 'FORMANT', 'fixture: the stored doc is marked');
      const exp = await exportDefinitions(store.defaultStore, r.registry, { now: () => STAMP });
      assertEqual(exp.code, 200, 'export: 200');
      const text = JSON.stringify(exp.body);
      assert(!text.includes('derivedHidden') && !text.includes('"ranges"') && !text.includes('"blockMap"'), 'export: no derived field, no marker');
      assertEqual(JSON.stringify((exp.body as { profile: { raw: { sources: Array<{ records: unknown[] }> } } }).profile.raw.sources.map((s) => s.records.length)),
        JSON.stringify(storedDoc()!.raw.sources.map((s) => s.records.length)), 'export: the stored raw sources');
    });
    // hook off, a doc still marked: refused too (it re-derives clean on its next load)
    assertEqual(storedDoc()!.meta.derivedHidden as unknown, 'FORMANT', 'the marked doc is still stored');
    const marked = await cloudCachePublish(cloud, store.defaultStore, r.registry);
    assertEqual(`${marked.code}/${(marked.body as { error?: string }).error}`, '409/dev-hook-active', 'a doc derived under the hook: publish refused');
    assertEqual(`${published.length}/${uploads.length}`, '0/0', 'nothing published, nothing uploaded');
    // the marker never travels: the publish copy strips it
    const copy = publishableProfile({ ...(storedDoc() as unknown as Record<string, unknown>) });
    assertEqual((copy.meta as Record<string, unknown>).derivedHidden, undefined, 'publishableProfile strips meta.derivedHidden');
    // after a load without the hook the doc is clean again and publishes
    await r.registry.applyRuntimeCache();
    assertEqual(storedDoc()!.meta.derivedHidden, undefined, 're-derived clean');
    assertEqual((await cloudCachePublish(cloud, store.defaultStore, r.registry)).code, 201, 'then publish goes through');
  } finally { await r.close(); clearDoc(); }
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['likely: generic from the section, read-only, channels from the shape; PUT 409, nothing sent', likelyIsReadOnly],
  ['candidates / none: nothing listed, no guard; nothing to match → nothing read', candidatesAndNone],
  ['live-only: read-only live rows (live-only-block), PUT 409, nothing sent; classic unchanged', liveOnlyIsReadOnly],
  ['probe: likely → walk → live-probe source → confirmed → writable; SSE once; a re-probe replaces the probe', probeConfirmsAndEnablesWrites],
  ['probe preconditions in order, zero traffic on refusals, router twin parity', probePreconditions],
  ['probe: 504 timeout (claim held until the walk settles), watchdog at the wire, failed walk; nothing stored', probeTimeoutAndWatchdog],
  ['probe without an editor-cache source: cap 127, live-only binding; router twin parity incl. the 409 body', probeWithoutByteSource],
  ['FORGEFX-45: the six III roster ids reachable read-only, never hinted or bounded', iiiRosterReadOnly],
  ['hide hook: effect table, static roster, derivation catalog incl. familyFirstEid and inventory; one warning; production / malformed ignored', hideHookScope],
  ['leave-one-out RESONATOR 162: likely → probe → confirmed section:39, generic count = informative rows', leaveOneOutResonator],
  ['leave-one-out FORMANT 98: confirmed from a read-only walk; the stored derivation follows the hook both ways', leaveOneOutFormant],
  ['walk-scope gates fail closed; the override (tokens, production, the Node registry hook)', walkScopeGatesFailClosed],
  ['one confidence → state mapping for the generic params and the definitions diff', sharedStateMapping],
  ['classic response of a bound block and generic catalog blocks unchanged', classicUnchanged],
  ['instance blocks share their group key, bridged blocks leave no block:<eid> family', instanceAndBridgedKeys],
  ['a likely block stays read-only whatever persisted entry it has; a failed re-read keeps the refusal; section pids without a row refused', likelyGuardHolds],
  ['the probe above effect id 160 needs the above-160 gate (route + availability); a III roster instance is a known block', above160Gate],
  ['the development hook never reaches the cloud: publish / contribution refused, marker stripped, export raw only', devHookNeverShared]
];

export async function runUnknownBlocksTests(): Promise<void> {
  assertEqual(CASES.length, UNKNOWN_BLOCKS_CASE_COUNT, 'case count');
  const savedHook = process.env.FORGEFX_DEFS_HIDE_FAMILY;
  const savedForce = process.env.FORGEFX_DEFS_FORCE_GENERIC;
  const savedScope = process.env.FORGEFX_WALK_SCOPE_OVERRIDE;
  delete process.env.FORGEFX_DEFS_HIDE_FAMILY;
  delete process.env.FORGEFX_DEFS_FORCE_GENERIC;
  delete process.env.FORGEFX_WALK_SCOPE_OVERRIDE;
  try {
    for (const [name, run] of CASES) {
      await run();
      console.log(`  drivers/unknown-blocks: ${name}`);
    }
  } finally {
    if (savedHook !== undefined) process.env.FORGEFX_DEFS_HIDE_FAMILY = savedHook;
    if (savedForce !== undefined) process.env.FORGEFX_DEFS_FORCE_GENERIC = savedForce;
    if (savedScope !== undefined) process.env.FORGEFX_WALK_SCOPE_OVERRIDE = savedScope;
  }
}
