// Cloud pull v2 (M4 WP-F2) — a structural fake cloud, a mocked FM3 that answers definition queries from synthetic records
// (FM3 catalog rows only, test/helpers/cacheBytes.ts `catalogSeedRecords`), NO hardware, NO network. Covers:
//   (a) a cloud editor cache over a local read-only walk: the byte rows win, the local units stay; passed verdict + report;
//       SSE `verifying` progress and the terminal `done`;
//   (b) a truncated cloud read next to a cloud editor cache (both best rows pulled): the byte rows win, the read adds
//       units on tuple-equal rows only;
//   (c) a local editor cache + a cloud read: no check needed (`not-needed`, no device traffic), units only on tuple-equal
//       rows;
//   (d) a manipulated catalog-known row: 409 `spot-check-failed`, the store deep-equal before/after, the verdict stored and
//       reported, the row no longer offered (409 `spot-check-rejected-before`), `recheck` checks it again;
//   (e) inconclusive / aborted / insufficient / busy / building / 501 / invalid-source (prototype key, non-finite number,
//       fact hash) / firmware-differs / a body that cannot be fetched (502, listing dropped) / unknown and malformed ids —
//       nothing stored, no device traffic where none is due;
//   (f) the dry-run preview: zero frames, zero store writes, and it predicts what the real pull then stores;
//   (g) the TX audit: only definition queries for the planned addresses, none above the block's bound (a row above it is
//       never read);
//   (h) A8: a pull, then `.axisdefs` export → delete → import with the cloud disabled = the same caps, diff and
//       `?generic=1` params;
//   (i) app ↔ router twin parity (Browser Direct), the origin guard, the Remote relay refusing the pull;
//   plus: v1 rows are checked too (format 1 and with raw sources, no verdict), a unit without a spot check keeps the M3
//   path (marked `unavailable`), the body parser; review round: a refusal after a passed check ends the SSE progress, a
//   swapped unit gets no query, one row per kind, blame scope, a family an earlier cloud pull decides is checked,
//   `replace: true`.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import {
  RAW_FORMAT, VIEW_DEFINITION, decodeWalkQuery, rawSourceId, shareableSource, sourceFactHash,
  type CacheRecord, type ProfileDoc, type RawSource, type ShareableSource
} from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import type { DeviceProfile } from '../../src/devices.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import {
  CLOUD_VERDICTS_COLLECTION, PULL_MAX_SOURCE_IDS, cloudCacheCheck, cloudCachePull, forgetDefinitionSources, parsePullBody, publishableProfile,
  readCloudVerdicts, type CloudProfilesCloud, type CloudPullOptions
} from '../../src/services/cloudProfiles.js';
import { __setSpotCheckForTest, planSpotCheck } from '../../src/services/spotCheck.js';
import { claimDevice, releaseDevice } from '../../src/services/deviceJobs.js';
import { walkBlockLimits } from '../../src/services/deviceCache.js';
import { remoteAllowed } from '../../src/remote.js';
import type { DefinitionSourceBody, DefinitionSourceList, DefinitionSourceReport, DefinitionSourceSummary } from '../../src/runtime/cloud.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { compactHex, blockBulkFrames, enc14, sysex } from '../helpers/blockRead.js';
import { syntheticBody } from '../helpers/catalogProfile.js';
import { catalogSeedRecords, SEED_TAGS } from '../helpers/cacheBytes.js';
import { SEED_BLOCKS, clone, editorCacheSource, familyRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';
import { staticRoster } from '../../src/profileCatalog.js';

const FM3 = 0x11;
const FW = '13.0';
const KEY = '11_13p0';
const ID_EC = '0b7c6a2e-1111-4222-8333-944455556666';
const ID_LR = '1c8d7b3f-2222-4333-8444-a55566667777';
const ID_LF = '2d9e8c40-3333-4444-8555-b66677778888';
/** The seed families' first blocks (FM3 effect ids). */
const BLOCKS = Object.values(SEED_BLOCKS);
/** Eligible rows of the catalog seed set (every one becomes a target: fewer than N = 24). */
const TARGETS = 22;

type Json = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v);

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Records with their section tag replaced by the seed family's block address (the device's / a live read's space). */
function toBlocks(records: readonly CacheRecord[], unit?: string): CacheRecord[] {
  const blockOf = new Map(Object.entries(SEED_TAGS).map(([fam, tag]) => [tag, SEED_BLOCKS[fam]!] as const));
  return records.map((r) => ({ ...r, section: blockOf.get(r.section)!, ...(unit ? { unit } : {}) }));
}
/** The first `n` rows of every block (`n` < 0: all but the last -n) — the FUZZ block whole: its few seed rows are what
 *  lets a live read's section vote place the family at all. */
function firstRowsPerBlock(records: readonly CacheRecord[], n: number): CacheRecord[] {
  const by = new Map<number, CacheRecord[]>();
  for (const r of records) { let g = by.get(r.section); if (!g) by.set(r.section, (g = [])); g.push(r); }
  return [...by.entries()].flatMap(([block, g]) => (block === SEED_BLOCKS.FUZZ ? g : g.slice(0, n < 0 ? g.length + n : n)));
}
/** The honest device: the catalog seed rows at their block addresses. */
const deviceRecords = () => toBlocks(catalogSeedRecords());

/** A local read-only walk of the honest device that read units. */
const localLive = (unit = 'dB') => liveSource(toBlocks(catalogSeedRecords(), unit), { firmware: FW, capturedAt: '2026-11-22T10:30:00.000Z' });
/** The shared (sanitized) copy of an editor cache over `records`. */
async function ecShared(records: CacheRecord[] = catalogSeedRecords()): Promise<ShareableSource> {
  const s = shareableSource(await editorCacheSource(records, { firmware: FW }));
  assert(!('refused' in s), 'fixture: the editor cache is shareable');
  return s as ShareableSource;
}
/** The shared copy of a live read over block-space `records`. */
function liveShared(records: CacheRecord[], o: { kind?: 'live-readonly' | 'live-full'; stats?: Parameters<typeof liveSource>[1]['stats'] } = {}): ShareableSource {
  const s = shareableSource(liveSource(records, { firmware: FW, capturedAt: '2026-11-21T08:15:00.000Z', kind: o.kind ?? 'live-readonly', ...(o.stats ? { stats: o.stats } : {}) }));
  assert(!('refused' in s), 'fixture: the live read is shareable');
  return s as ShareableSource;
}
/** A shared source as a pull stores it (fresh id, origin cloud). */
const asCloud = (s: ShareableSource): RawSource => ({ ...clone(s), id: rawSourceId(s.kind, s.capturedAt, 0), origin: 'cloud' }) as unknown as RawSource;
const factHashOf = (s: ShareableSource) => sourceFactHash(s as unknown as RawSource, { model: FM3, firmware: FW });

/** A listed row and the body the function serves for it. `raw`: the body is handed out as is (no JSON copy), so a test can
 *  plant what JSON cannot carry (a non-finite number, an own `__proto__` key). */
interface CloudRow { summary: DefinitionSourceSummary; body: DefinitionSourceBody | null; raw?: boolean }
async function cloudRow(id: string, src: ShareableSource, o: { tier?: DefinitionSourceSummary['tier']; quality?: number } = {}): Promise<CloudRow> {
  const factHash = await factHashOf(src);
  const kind = src.kind as DefinitionSourceSummary['kind'];
  const live = kind !== 'editor-cache';
  const summary = live
    ? { records: src.records.length, blocks: new Set(src.records.map((r) => r.section)).size }
    : { records: src.records.length, sections: (src as { sections: unknown[] }).sections.length };
  const tier = o.tier ?? 'candidate';
  const quality = o.quality ?? 3;
  return {
    summary: {
      id, kind, rawFormat: RAW_FORMAT, factHash, tier, quality, contributors: 1, networks: 1, spotChecks: { passed: 0, failed: 0 },
      firstSeen: '2026-11-20', lastConfirmedAt: null, bytes: 4000, summary
    },
    body: { id, model: FM3, firmware: FW, kind, rawFormat: RAW_FORMAT, factHash, tier, quality, summary, source: clone(src) as unknown as Record<string, unknown> }
  };
}

interface FakeV1Row { profile: unknown; contentHash: string; source: string; recordCount: number | null; createdAt: string }
interface FakeState { rows: CloudRow[]; v1: FakeV1Row | null; v2: boolean }
/** A structural fake cloud: the v2 listing / bodies / reports (unless `v2: false`) and the v1 store. Counts every call. */
function fakeCloud(rows: CloudRow[], o: { v1?: FakeV1Row | null; v2?: boolean } = {}) {
  const state: FakeState = { rows, v1: o.v1 ?? null, v2: o.v2 ?? true };
  const calls = { list: 0, get: [] as string[], v1: 0, reports: [] as DefinitionSourceReport[] };
  const listing = (): DefinitionSourceList => {
    const alternatives = { 'editor-cache': 0, 'live-full': 0, 'live-readonly': 0 };
    for (const r of state.rows) alternatives[r.summary.kind] = 1;
    return { model: FM3, firmware: FW, sources: state.rows.map((r) => clone(r.summary)), alternatives };
  };
  const v1 = {
    async deviceProfileGet() { calls.v1++; return state.v1 ? clone(state.v1) : null; },
    async deviceProfilePublish() { return { code: 201, body: {} }; }
  };
  const cloud: CloudProfilesCloud = !state.v2 ? v1 : {
    ...v1,
    async definitionSourcesList() { calls.list++; return listing(); },
    async definitionSourceGet(id: string) {
      calls.get.push(id);
      const r = state.rows.find((x) => x.summary.id === id);
      if (!r?.body) return null;
      return r.raw ? r.body : clone(r.body);
    },
    async definitionSourceReport(body: DefinitionSourceReport) { calls.reports.push(clone(body)); return { code: 200, body: { ok: true, quarantined: false } }; },
    async definitionSourceContribute() { throw new Error('no share in this suite'); },
    async definitionSourceWithdraw() { throw new Error('no withdraw in this suite'); },
    async definitionSourcesMine() { throw new Error('no mine in this suite'); }
  };
  return { cloud, state, calls };
}
type Fake = ReturnType<typeof fakeCloud>;

/** A v1 profile row (format 1, derived tables only) of the catalog seed set, optionally mutated. */
async function v1Row(mutate?: (doc: Json) => void): Promise<FakeV1Row> {
  const doc = publishableProfile(profileDoc([await editorCacheSource(catalogSeedRecords(), { firmware: FW })], { firmware: FW }) as unknown as Json);
  const profile = clone({ ...doc, meta: { ...(doc.meta as Json), source: 'bytes' } });
  mutate?.(profile);
  return { profile, contentHash: 'v1hash', source: 'editor-cache', recordCount: 25, createdAt: '2026-07-13T00:00:00Z' };
}

// ── the mocked unit ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Continuous MSB-first septet stream of `raw` (the inverse of the codec's septet decoding). */
function septets(raw: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    n += 8;
    while (n >= 7) { n -= 7; out.push((acc >> n) & 0x7f); }
    acc &= (1 << n) - 1;
  }
  if (n > 0) out.push((acc << (7 - n)) & 0x7f);
  return out;
}

/** A synthetic definition reply of the FM3 for (block, param): the record's definition (symbol id param + 1), or the
 *  empty-slot definition (all zero) where the unit has no row. */
function defReply(block: number, param: number, r: CacheRecord | null): number[] {
  const raw = new Uint8Array(36);
  if (r) {
    const v = new DataView(raw.buffer);
    v.setUint32(0, param + 1, true); v.setUint32(4, r.tc, true);
    v.setFloat32(8, r.min, true); v.setFloat32(12, r.max, true); v.setFloat32(16, r.kind === 'enum' ? 0 : 1, true);
    v.setFloat32(20, r.def, true); v.setFloat32(24, r.step, true);
  }
  const inner = new Array<number>(15).fill(0);
  inner[0] = VIEW_DEFINITION; inner[2] = 0x01; inner[3] = (block >> 7) & 0x7f; inner[4] = param & 0x7f; inner[5] = (param >> 7) & 0x7f;
  inner[6] = 0x3a; inner[13] = raw.length;
  const body = [0xf0, 0x00, 0x01, 0x74, FM3, 0x01, ...inner, ...septets(raw)];
  return [...body, body.reduce((x, y) => x ^ y, 0) & 0x7f, 0xf7];
}

interface Device { records: CacheRecord[]; silent: Set<string>; dead: boolean }

interface Rig {
  registry: DeviceRegistry;
  mock: MockTransport;
  device: Device;
  events: DeviceEvent[];
  app: Awaited<ReturnType<typeof buildApp>>;
  router: ReturnType<typeof createRouter>;
  bodyProfile: { current: DeviceProfile | null };
  close: () => Promise<void>;
}

/** A detected FM3 on firmware 13.0 answering definition queries from `device.records` (the honest unit by default), the
 *  status dump and the bulk reads of the seed blocks; the Fastify app (cloud seam `cloud`) and the router twin over one
 *  registry and the default store. Telemetry is held for the rig's life (no frame may blur the TX audit). The spot check
 *  runs with a fixed seed, no pauses and a frozen clock (deterministic targets, `durationMs` 0). */
async function makeRig(cloud: CloudProfilesCloud | null): Promise<Rig> {
  const mock = new MockTransport('serial', 'mock-0x11');
  const device: Device = { records: deviceRecords(), silent: new Set(), dead: false };
  const bodyProfile: Rig['bodyProfile'] = { current: null };
  const codec = createModernFractalCodec(FM3);
  const statusHex = compactHex(codec.buildStatusDump());
  const polls = new Map(BLOCKS.map((eid) => [compactHex(codec.buildBlockBulkReadPoll(eid)), eid] as const));
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(FM3, 13, 0)];
    const q = req.length === 23 ? decodeWalkQuery(Uint8Array.from(req)) : null;
    if (q && q.view === VIEW_DEFINITION && q.sub === 0) {
      if (device.dead || device.silent.has(`${q.block}:${q.param}`)) return [];
      const rec = device.records.find((x) => x.section === q.block && x.id === q.param) ?? null;
      return [defReply(q.block, q.param, rec)];
    }
    const h = compactHex(req);
    if (h === statusHex) return [sysex(FM3, 0x13, BLOCKS.flatMap((eid) => [...enc14(eid), 0]))];
    const eid = polls.get(h);
    if (eid !== undefined && bodyProfile.current) return blockBulkFrames(FM3, eid, syntheticBody(bodyProfile.current, eid));
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  }) as DeviceRegistry;
  await registry.detect();
  __setSpotCheckForTest(registry, { seed: 7, run: { sleep: async () => {}, drainMs: 0, now: () => 0 } });
  const app = await buildApp(registry, { cloudProfiles: { cloud } });
  const router = createRouter({ registry, store: store.defaultStore, ...(cloud ? { cloud: cloud as never } : {}) });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const resume = registry.pauseTelemetry();
  return {
    registry, mock, device, events, app, router, bodyProfile,
    close: async () => { resume(); unsub(); __setSpotCheckForTest(registry, null); await app.close(); }
  };
}

const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);
const storedRaw = () => store.defaultStore.getDoc('deviceCaches', KEY);
const storedDoc = (): ProfileDoc | null => { const d = storedRaw(); return d && !d.deleted ? (d.data as ProfileDoc) : null; };
const verdictDoc = () => { const d = store.defaultStore.getDoc(CLOUD_VERDICTS_COLLECTION, KEY); return d && !d.deleted ? d.data : null; };
const clearDocs = () => { store.defaultStore.delDoc('deviceCaches', KEY); store.defaultStore.delDoc(CLOUD_VERDICTS_COLLECTION, KEY); };
const originsOf = (doc: ProfileDoc | null) => (doc?.raw?.sources ?? []).map((s) => `${s.kind}/${s.origin}`).join(',');
const cloudIdOf = (doc: ProfileDoc, kind: string) => doc.raw.sources.find((s) => s.origin === 'cloud' && s.kind === kind)!.id;
/** Derived rows without their device units (what decides existence, kinds and ranges). */
const withoutUnits = (ranges: ProfileDoc['ranges']) =>
  json(Object.fromEntries(Object.entries(ranges).map(([f, rows]) => [f, Object.fromEntries(Object.entries(rows).map(([p, r]) => {
    const { unit: _u, ...rest } = r as { unit?: string };
    return [p, rest];
  }))])));
const errorOf = (body: unknown) => (body as { error?: string }).error;
const cacheBuilds = (events: DeviceEvent[]) => events.filter((e): e is Extract<DeviceEvent, { type: 'cacheBuild' }> => e.type === 'cacheBuild');

/** Every frame must be a definition query (sub 0, the FM3, the definition view) for a seed block, at or below the
 *  block's read-only bound (static catalog) and 127. Returns the number of queries. */
function auditTx(frames: readonly number[][], label: string): number {
  const bound = walkBlockLimits(FM3, 'read-only', null).bound;
  const blocks = new Set(BLOCKS);
  for (const f of frames) {
    const q = decodeWalkQuery(Uint8Array.from(f));
    assert(q !== null, `${label}: every frame is a self-describe query (got ${compactHex(f)})`);
    assertEqual(`${q.model} ${q.view} ${q.sub}`, `${FM3} ${VIEW_DEFINITION} 0`, `${label}: a definition query (no label query, no value read)`);
    assert(blocks.has(q.block), `${label}: block ${q.block} is a planned seed block`);
    assert(q.param <= bound[q.block]! && q.param <= 127, `${label}: block ${q.block} param ${q.param} at or below its bound ${bound[q.block]}`);
  }
  return frames.length;
}

// ── (a) cloud editor cache over a local read-only walk ──────────────────────────────────────────────────────────────
async function editorCacheOverLocalRead(): Promise<void> {
  clearDocs();
  const local = localLive('dB');
  putDoc(profileDoc([local], { firmware: FW }));
  const ec = await ecShared();
  const f = fakeCloud([await cloudRow(ID_EC, ec)]);
  const r = await makeRig(f.cloud);
  try {
    const sent0 = r.mock.sent.length;
    const ev0 = r.events.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 200, `[a] 200 (${json(res.body).slice(0, 300)})`);
    const b = res.body as Json;
    assertEqual(Object.keys(b).join(','), 'ok,pulled,key,model,firmware,source,format,merged,adopted,spotCheck,coverage', '[a] answer keys (contract §5.4.3)');
    assertEqual(`${b.ok} ${b.pulled} ${b.key} ${b.model} ${b.firmware} ${b.source} ${b.format} ${b.merged}`, `true true ${KEY} ${FM3} ${FW} cloud 2 true`, '[a] answer head');
    assertEqual(json(b.adopted), json([{ id: ID_EC, kind: 'editor-cache', tier: 'candidate' }]), '[a] adopted');
    assertEqual(json(b.spotCheck), json({ verdict: 'passed', checked: TARGETS, answered: TARGETS, mismatches: 0, durationMs: 0, unverifiable: 0 }), '[a] spot check passed');
    const doc = storedDoc()!;
    assertEqual(json(b.coverage), json({ complete: doc.coverage.complete, gaps: doc.coverage.gaps }), '[a] coverage of the stored doc');
    // the byte rows win: every seed family's existence comes from the cloud editor cache; the rows are the derivation of
    // the local read and the cloud editor cache; the local read's units stay on its tuple-equal rows
    assertEqual(originsOf(doc), 'live-readonly/local,editor-cache/cloud', '[a] the local read kept, the cloud editor cache added');
    const ecId = cloudIdOf(doc, 'editor-cache');
    for (const fam of Object.keys(SEED_TAGS)) assertEqual(doc.provenance.existence[fam], ecId, `[a] ${fam}: existence from the cloud editor cache`);
    const expected = profileDoc([local, asCloud(ec)], { firmware: FW });
    assertEqual(json(doc.ranges), json(expected.ranges), '[a] the stored rows = the derivation of the local read + the cloud editor cache');
    const ecOnly = profileDoc([asCloud(ec)], { firmware: FW });
    assertEqual(withoutUnits(doc.ranges), withoutUnits(ecOnly.ranges), '[a] byte rows: identical to the editor cache alone, units apart');
    assert((doc.provenance.units[local.id] ?? 0) > 0, '[a] units kept from the local read');
    assertEqual((doc.ranges.DISTORT![91] as { unit?: string }).unit, 'dB', '[a] a byte row carries the local unit');
    // this install's verdict and the report
    const v = readCloudVerdicts(store.defaultStore, KEY).get(ID_EC);
    assertEqual(`${v?.verdict} ${v?.factHash === f.state.rows[0]!.summary.factHash} ${v?.kind} ${v?.checked}/${v?.answered}/${v?.mismatches}`,
      `passed true editor-cache ${TARGETS}/${TARGETS}/0`, '[a] passed verdict stored under the listed fact hash');
    assertEqual(json(f.calls.reports.map((x) => `${x.sourceId}:${x.verdict}:${x.checked}:${x.answered}:${x.mismatches}`)), json([`${ID_EC}:passed:${TARGETS}:${TARGETS}:0`]), '[a] reported');
    // SSE: verifying 0..N, then done, then definitions merged
    const cb = cacheBuilds(r.events.slice(ev0));
    const ver = cb.filter((e) => e.phase === 'verifying');
    assertEqual(`${ver.length} ${ver[0]?.done}/${ver[0]?.total} ${ver.at(-1)?.done}/${ver.at(-1)?.total} ${ver[0]?.key}`, `${TARGETS + 1} 0/${TARGETS} ${TARGETS}/${TARGETS} ${KEY}`, '[a] SSE verifying per target');
    assertEqual(cb.at(-1)?.phase, 'done', '[a] SSE terminal done');
    assertEqual(r.events.slice(ev0).filter((e) => e.type === 'definitions' && e.reason === 'merged').length, 1, '[a] SSE definitions merged');
    // (g) every frame a definition query of a planned address
    assertEqual(auditTx(r.mock.sent.slice(sent0), '[a] TX'), TARGETS, '[a] one definition query per target');
    // afterwards the check says: identical, passed, nothing to gain
    const chk = await cloudCacheCheck(f.cloud, store.defaultStore, r.registry);
    assertEqual(json(chk.sources?.map((s) => `${s.id}:${s.verdict}:${s.identical}`)), json([`${ID_EC}:passed:true`]), '[a] the check: passed + identical');
    assertEqual(chk.improves, 'no', '[a] the check: nothing to gain any more');
  } finally { clearDocs(); await r.close(); }
}

// ── (b) a truncated cloud read next to a cloud editor cache ─────────────────────────────────────────────────────────
async function truncatedReadNextToEditorCache(): Promise<void> {
  clearDocs();
  const ec = await ecShared();
  // a lossy read that lost the last row of every block and also misread one row (DISTORT 91's max)
  const misread = firstRowsPerBlock(toBlocks(catalogSeedRecords(), 'ms'), -1).map((x) => (x.section === SEED_BLOCKS.DISTORT && x.id === 91 ? { ...x, max: x.max * 2 } : x));
  const lr = liveShared(misread, { stats: { unresolvedReplies: 3, lostReplies: 3 } });
  const f = fakeCloud([await cloudRow(ID_EC, ec), await cloudRow(ID_LR, lr, { quality: 1 })]);
  const r = await makeRig(f.cloud);
  try {
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 200, `[b] 200 (${json(res.body).slice(0, 300)})`);
    const b = res.body as Json;
    assertEqual(json(b.adopted), json([{ id: ID_EC, kind: 'editor-cache', tier: 'candidate' }, { id: ID_LR, kind: 'live-readonly', tier: 'candidate' }]), '[b] both best rows adopted');
    assertEqual(f.calls.get.join(','), `${ID_EC},${ID_LR}`, '[b] both bodies fetched');
    const doc = storedDoc()!;
    assertEqual(originsOf(doc), 'editor-cache/cloud,live-readonly/cloud', '[b] both stored, origin cloud');
    const ecId = cloudIdOf(doc, 'editor-cache');
    for (const fam of Object.keys(SEED_TAGS)) assertEqual(doc.provenance.existence[fam], ecId, `[b] ${fam}: existence from the editor cache, never the truncated read`);
    const ecOnly = profileDoc([asCloud(ec)], { firmware: FW });
    assertEqual(withoutUnits(doc.ranges), withoutUnits(ecOnly.ranges), '[b] byte rows win: the editor cache\'s rows, units apart');
    assertEqual((doc.ranges.DISTORT![91] as { displayMax: number }).displayMax, (ecOnly.ranges.DISTORT![91] as { displayMax: number }).displayMax, '[b] the misread max lost');
    assertEqual((doc.ranges.DISTORT![91] as { unit?: string }).unit, undefined, '[b] no unit on a row whose tuple differs');
    assert((doc.provenance.units[cloudIdOf(doc, 'live-readonly')] ?? 0) > 0, '[b] the read adds units on its tuple-equal rows');
    // the verdict: the editor cache decided every checked family; the read decided none (no verdict, no report)
    const verdicts = readCloudVerdicts(store.defaultStore, KEY);
    assertEqual(`${verdicts.get(ID_EC)?.verdict} ${verdicts.has(ID_LR)}`, 'passed false', '[b] a verdict only on the row that decided the checked families');
    assertEqual(f.calls.reports.map((x) => x.sourceId).join(','), ID_EC, '[b] reported only that row');
  } finally { clearDocs(); await r.close(); }
}

// ── (c) a local editor cache + a cloud read: no check needed ────────────────────────────────────────────────────────
async function localEditorCacheCloudRead(): Promise<void> {
  clearDocs();
  const localEc = await editorCacheSource(catalogSeedRecords(), { firmware: FW });
  putDoc(profileDoc([localEc], { firmware: FW }));
  const read = toBlocks(catalogSeedRecords(), 'Hz').map((x) => (x.section === SEED_BLOCKS.DISTORT && x.id === 91 ? { ...x, max: x.max * 2 } : x));
  const f = fakeCloud([await cloudRow(ID_LF, liveShared(read, { kind: 'live-full' }))]);
  const r = await makeRig(f.cloud);
  try {
    const sent0 = r.mock.sent.length;
    const ev0 = r.events.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 200, `[c] 200 (${json(res.body).slice(0, 300)})`);
    assertEqual(json((res.body as Json).spotCheck), json({ verdict: 'not-needed', checked: 0, answered: 0, mismatches: 0, durationMs: 0, unverifiable: 0 }), '[c] not-needed');
    assertEqual(r.mock.sent.length, sent0, '[c] no device traffic');
    assertEqual(cacheBuilds(r.events.slice(ev0)).filter((e) => e.phase === 'verifying').length, 0, '[c] no verifying events');
    const doc = storedDoc()!;
    assertEqual(originsOf(doc), 'editor-cache/local,live-full/cloud', '[c] the local editor cache kept, the cloud read added');
    for (const fam of Object.keys(SEED_TAGS)) assertEqual(doc.provenance.existence[fam], localEc.id, `[c] ${fam}: existence stays local`);
    const localOnly = profileDoc([localEc], { firmware: FW });
    assertEqual(withoutUnits(doc.ranges), withoutUnits(localOnly.ranges), '[c] the rows are the local editor cache\'s, units apart');
    const lfId = cloudIdOf(doc, 'live-full');
    const unitRows = Object.values(doc.ranges).flatMap((rows) => Object.values(rows)).filter((x) => (x as { unit?: string }).unit === 'Hz').length;
    assertEqual(unitRows, doc.provenance.units[lfId], '[c] the cloud read contributes exactly the units the provenance counts');
    assert(unitRows > 0, '[c] units added on tuple-equal rows');
    assertEqual((doc.ranges.DISTORT![91] as { unit?: string }).unit, undefined, '[c] no unit on the row whose tuple differs');
    assertEqual(`${verdictDoc()} ${f.calls.reports.length}`, 'null 0', '[c] no verdict, no report');
  } finally { clearDocs(); await r.close(); }
}

// ── (d) a manipulated catalog-known row ─────────────────────────────────────────────────────────────────────────────
async function manipulatedRowFails(): Promise<void> {
  clearDocs();
  putDoc(profileDoc([localLive()], { firmware: FW }));
  // DISTORT 91: the catalog row with another unit class (typecode) — incompatible with the catalog, so a priority-1 target
  const manipulated = await ecShared(catalogSeedRecords().map((x, i) => (i === 0 ? { ...x, tc: x.tc ^ 0x70 } : x)));
  const f = fakeCloud([await cloudRow(ID_EC, manipulated)]);
  const r = await makeRig(f.cloud);
  try {
    const before = json(storedRaw());
    const sent0 = r.mock.sent.length;
    const ev0 = r.events.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${res.code} ${errorOf(res.body)}`, '409 spot-check-failed', '[d] 409 spot-check-failed');
    const sc = (res.body as { spotCheck: Json }).spotCheck;
    assertEqual(json(sc), json({ verdict: 'failed', checked: TARGETS, answered: TARGETS, mismatches: 1, failures: [{ family: 'DISTORT', pid: 91 }], durationMs: 0 }), '[d] the mismatch named by address only');
    assertEqual(json(storedRaw()), before, '[d] the store deep-equal before and after');
    assertEqual(auditTx(r.mock.sent.slice(sent0), '[d] TX'), TARGETS, '[d] read-only traffic');
    const v = readCloudVerdicts(store.defaultStore, KEY).get(ID_EC);
    assertEqual(`${v?.verdict} ${v?.factHash === f.state.rows[0]!.summary.factHash} ${v?.mismatches}`, 'failed true 1', '[d] failed verdict stored');
    assertEqual(json(f.calls.reports.map((x) => `${x.sourceId}:${x.verdict}:${x.mismatches}`)), json([`${ID_EC}:failed:1`]), '[d] reported');
    const cb = cacheBuilds(r.events.slice(ev0));
    assertEqual(`${cb.at(-1)?.phase} ${cb.at(-1)?.reason}`, 'error spot-check-failed', '[d] SSE terminal error, reason spot-check-failed');
    // no longer offered
    const chk = await cloudCacheCheck(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${chk.version} ${chk.available} ${chk.sources?.length} ${json(chk.rejected?.map((s) => `${s.id}:${s.verdict}`))}`, `2 false 0 ${json([`${ID_EC}:failed`])}`, '[d] the check lists it under rejected');
    // a pull without recheck: nothing offered, no v1 row → rejected-before, no traffic; by id the same
    const sent1 = r.mock.sent.length;
    for (const opts of [{}, { sourceIds: [ID_EC] }] as CloudPullOptions[]) {
      const again = await cloudCachePull(f.cloud, store.defaultStore, r.registry, opts);
      assertEqual(`${again.code} ${errorOf(again.body)} ${(again.body as { sourceId?: string }).sourceId}`, `409 spot-check-rejected-before ${ID_EC}`, `[d] ${json(opts)}: rejected before`);
    }
    assertEqual(r.mock.sent.length, sent1, '[d] no traffic for a rejected row');
    assertEqual(json(storedRaw()), before, '[d] still untouched');
    // recheck runs the check again (and fails again: the unit is honest, the row is not)
    const rerun = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { recheck: true });
    assertEqual(`${rerun.code} ${errorOf(rerun.body)}`, '409 spot-check-failed', '[d] recheck re-runs');
    assertEqual(auditTx(r.mock.sent.slice(sent1), '[d] recheck TX'), TARGETS, '[d] recheck: the queries again');
    const byId = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { sourceIds: [ID_EC.toUpperCase()], recheck: true });
    assertEqual(`${byId.code} ${errorOf(byId.body)}`, '409 spot-check-failed', '[d] recheck by id');
    assertEqual(json(storedRaw()), before, '[d] still untouched after the rechecks');
    // the honest row under a new id (new facts) passes and is adopted
    f.state.rows = [await cloudRow(ID_LF.replace('2d9e', '3e0f'), await ecShared())];
    forgetDefinitionSources(r.registry);
    const honest = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${honest.code} ${(honest.body as { spotCheck?: { verdict: string } }).spotCheck?.verdict}`, '200 passed', '[d] the honest row passes');
  } finally { clearDocs(); await r.close(); }
}

// ── (e) the other refusals ──────────────────────────────────────────────────────────────────────────────────────────
async function refusals(): Promise<void> {
  clearDocs();
  const ec = await ecShared();
  const f = fakeCloud([await cloudRow(ID_EC, ec)]);
  const r = await makeRig(f.cloud);
  /** Run a pull expected to fail; nothing may be stored, no verdict written; returns the answer and the frames sent. */
  const refused = async (label: string, expect: string, opts: CloudPullOptions = {}, o: { traffic?: boolean } = {}) => {
    forgetDefinitionSources(r.registry);
    const before = json(storedRaw());
    const verdicts = json(verdictDoc());
    const sent0 = r.mock.sent.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry, opts);
    assertEqual(`${res.code} ${errorOf(res.body)}`, expect, `[e] ${label}`);
    assertEqual(json(storedRaw()), before, `[e] ${label}: nothing stored`);
    assertEqual(json(verdictDoc()), verdicts, `[e] ${label}: no verdict`);
    const frames = r.mock.sent.slice(sent0);
    if (o.traffic) auditTx(frames, `[e] ${label} TX`);
    else assertEqual(frames.length, 0, `[e] ${label}: no device traffic`);
    return { res, body: res.body as Json, frames };
  };
  try {
    // inconclusive: three rows stay silent (19 of 22 answered < 90 %)
    for (const k of ['58:114', '58:109', '58:103']) r.device.silent.add(k);
    const ev0 = r.events.length;
    const inc = await refused('three silent targets → inconclusive', '409 spot-check-inconclusive', {}, { traffic: true });
    const sc = inc.body.spotCheck as Json;
    assertEqual(`${sc.verdict} ${sc.answered} ${sc.mismatches}`, `inconclusive ${TARGETS - 3} 0`, '[e] inconclusive: counts');
    assertEqual(inc.frames.length, TARGETS + 3 + 1, '[e] inconclusive: one retry per silent target, one liveness re-read after two in a row');
    const cb = cacheBuilds(r.events.slice(ev0));
    assertEqual(`${cb.at(-1)?.phase} ${cb.at(-1)?.reason}`, 'error spot-check-inconclusive', '[e] inconclusive: SSE');
    assertEqual(f.calls.reports.length, 0, '[e] inconclusive: no report');
    // a unit that stops answering: aborted (reported as inconclusive), after 2 targets with one retry each
    r.device.silent.clear();
    r.device.dead = true;
    const ab = await refused('a dead unit → aborted', '409 spot-check-inconclusive', {}, { traffic: true });
    assertEqual(`${(ab.body.spotCheck as Json).verdict} ${(ab.body.spotCheck as Json).stopped} ${ab.frames.length}`, 'aborted device-stopped-answering 4', '[e] aborted');
    r.device.dead = false;

    // insufficient: a cloud read with two rows per block (10 rows decided by the cloud: fewer than 12 to check)
    f.state.rows = [await cloudRow(ID_LF, liveShared(firstRowsPerBlock(toBlocks(catalogSeedRecords()), 2), { kind: 'live-full' }))];
    const ins = await refused('too few eligible rows → insufficient', '409 spot-check-insufficient');
    assert((ins.body.eligible as number) < 12 && ins.body.needed === 12, `[e] insufficient: eligible ${ins.body.eligible} < needed 12`);
    // dry run says so ahead of time
    const preview = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { dryRun: true });
    assertEqual(json((preview.body as Json).spotCheck), json({ needed: true, status: 'insufficient', eligible: ins.body.eligible, planned: 0, unverifiable: 0 }), '[e] insufficient: the preview says so');
    clearDocs();
    f.state.rows = [await cloudRow(ID_EC, ec)];

    // the unit is busy / building
    assert(claimDevice(r.registry, 'capture'), 'fixture: claim');
    const busy = await refused('a capture holds the unit → busy', '409 busy');
    assertEqual(busy.body.what, 'capture', '[e] busy: what');
    releaseDevice(r.registry, 'capture');
    assert(claimDevice(r.registry, 'cache-build'), 'fixture: claim');
    await refused('a build holds the unit → building', '409 building');
    releaseDevice(r.registry, 'cache-build');

    // a unit without a spot check (self-describe, but not a grid driver)
    const caps = r.registry.activeCapabilities.bind(r.registry);
    (r.registry as unknown as { activeCapabilities: () => unknown }).activeCapabilities = () => ({ ...caps()!, slotModel: 'linear' });
    try {
      const ns = await refused('no spot check on this unit → 501', '501 unsupported');
      assertEqual(ns.body.capability, 'spotCheck', '[e] 501: capability spotCheck');
    } finally { delete (r.registry as unknown as { activeCapabilities?: unknown }).activeCapabilities; }

    // invalid sources: a prototype key, a non-finite number, facts that are not the listed ones
    const row = f.state.rows[0]!;
    const good = clone(row.body!);
    row.raw = true;
    row.body = { ...good, source: JSON.parse(JSON.stringify(good.source).replace('"codecVersion":', '"__proto__":{"x":1},"codecVersion":')) as Json };
    const proto = await refused('a prototype key → invalid-source', '422 invalid-source');
    assertEqual(`${proto.body.kind} ${String(proto.body.path).startsWith('source')}`, 'editor-cache true', '[e] invalid-source: kind + path');
    const inf = clone(good);
    (inf.source.records as Array<{ max: number }>)[0]!.max = Infinity;
    row.body = inf;
    const nf = await refused('a non-finite number → invalid-source', '422 invalid-source');
    assertEqual(`${nf.body.path} ${nf.body.message}`, 'source.records[0].max not a finite number', '[e] invalid-source: path + message');
    row.raw = false;
    const otherFacts = clone(good);
    (otherFacts.source.records as Array<{ max: number }>)[1]!.max += 1;
    row.body = otherFacts;
    const fh = await refused('facts that differ from the listed fact hash → invalid-source', '422 invalid-source');
    assertEqual(`${fh.body.path} ${fh.body.message}`, 'source its facts do not match the listed fact hash', '[e] fact hash bound');
    // another firmware: in the source, in the envelope
    const fw12 = clone(good);
    fw12.source.firmware = '12.0';
    row.body = fw12;
    const fd = await refused('a source of another firmware → firmware-differs', '409 firmware-differs');
    assertEqual(`${fd.body.expected} ${fd.body.got} ${fd.body.kind}`, `${FW} 12.0 editor-cache`, '[e] firmware-differs: expected / got');
    row.body = { ...clone(good), firmware: '12.0' };
    await refused('an envelope of another firmware → firmware-differs', '409 firmware-differs');
    // a body that does not match its listing, or cannot be fetched: 502, the cached listing dropped
    row.body = { ...clone(good), kind: 'live-full' };
    await refused('a body of another kind → 502 cloud', '502 cloud');
    row.body = { ...clone(good), rawFormat: RAW_FORMAT + 1 };
    await refused('a body of a newer raw format → 502 cloud', '502 cloud');
    row.body = null;
    await cloudCacheCheck(f.cloud, store.defaultStore, r.registry); // cache the listing
    const lists = f.calls.list;
    const gone = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${gone.code} ${errorOf(gone.body)} ${(gone.body as { status?: unknown }).status}`, '502 cloud null', '[e] a listed row whose body is gone → 502 cloud');
    await cloudCacheCheck(f.cloud, store.defaultStore, r.registry);
    assertEqual(f.calls.list, lists + 1, '[e] … and the cached listing was dropped (the next check lists afresh)');
    assertEqual(storedDoc(), null, '[e] nothing stored');
    row.body = good;
    // the stored definitions change while the check runs (another writer): the candidate is not stored over them
    const replyOf = r.mock.reply;
    let wrote = false;
    r.mock.reply = (req) => {
      if (!wrote && req.length === 23 && decodeWalkQuery(Uint8Array.from(req))?.view === VIEW_DEFINITION) { wrote = true; putDoc(profileDoc([localLive()], { firmware: FW })); }
      return replyOf(req);
    };
    try {
      forgetDefinitionSources(r.registry);
      const raced = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
      assertEqual(`${raced.code} ${errorOf(raced.body)} ${(raced.body as { what?: string }).what}`, '409 busy definitions', '[e] the store changed during the check → 409 busy');
      assertEqual(originsOf(storedDoc()), 'live-readonly/local', '[e] the other writer\'s doc stays');
    } finally { r.mock.reply = replyOf; clearDocs(); }
    // ids
    await refused('an id that is not listed → 404', '404 not-found', { sourceIds: [ID_LR] });
    const bad = parsePullBody({ sourceIds: ['nope'] });
    assertEqual(`${bad.ok} ${bad.ok ? '' : bad.result.code}`, 'false 400', '[e] a malformed id → 400');
    assertEqual(f.calls.reports.length, 0, '[e] no report on any refusal');
  } finally { clearDocs(); await r.close(); }
}

// ── (f) the dry-run preview ─────────────────────────────────────────────────────────────────────────────────────────
async function dryRunPreview(): Promise<void> {
  clearDocs();
  // a local read without units: the cloud read's units then decide (a local unit would outrank a cloud one)
  putDoc(profileDoc([localLive('')], { firmware: FW }));
  const ec = await ecShared();
  const lr = liveShared(toBlocks(catalogSeedRecords(), 'Hz'));
  const f = fakeCloud([await cloudRow(ID_EC, ec), await cloudRow(ID_LR, lr)]);
  const r = await makeRig(f.cloud);
  try {
    const rev = json(storedRaw());
    const sent0 = r.mock.sent.length;
    const ev0 = r.events.length;
    const chk = await cloudCacheCheck(f.cloud, store.defaultStore, r.registry);
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { dryRun: true });
    assertEqual(res.code, 200, `[f] 200 (${json(res.body).slice(0, 200)})`);
    const p = res.body as Json;
    assertEqual(Object.keys(p).join(','), 'ok,dryRun,sources,coverage,diff,wins,spotCheck', '[f] preview keys (contract §5.4.3 step 4)');
    assertEqual(json(p.sources), json(chk.sources), '[f] the offered rows as the check summarises them');
    assertEqual(json(p.spotCheck), json({ needed: true, status: 'ready', eligible: TARGETS, planned: TARGETS, unverifiable: 0 }), '[f] a check is needed, 22 targets');
    const wins = p.wins as { families: number; rows: number; units: number; tapers: number };
    assertEqual(`${wins.families} ${wins.tapers}`, '5 0', '[f] wins: the five seed families, no tapers');
    assert(wins.rows > 0 && wins.units > 0, '[f] wins: rows and units');
    // zero frames, zero writes, nothing reported, nothing emitted
    assertEqual(r.mock.sent.length, sent0, '[f] zero TX frames');
    assertEqual(json(storedRaw()), rev, '[f] the stored doc untouched');
    assertEqual(`${verdictDoc()} ${f.calls.reports.length} ${r.events.length - ev0}`, 'null 0 0', '[f] no verdict, no report, no SSE');
    // the preview predicts what the real pull stores
    const pulled = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(pulled.code, 200, '[f] the real pull');
    const doc = storedDoc()!;
    assertEqual(json(p.coverage), json(doc.coverage), '[f] preview coverage = stored coverage');
    const diff = await r.app.inject({ method: 'GET', url: '/device/definitions/diff' });
    assertEqual(json(p.diff), json((JSON.parse(diff.payload) as { summary: unknown }).summary), '[f] preview diff = the diff summary after the pull');
    const ecId = cloudIdOf(doc, 'editor-cache');
    const lrId = cloudIdOf(doc, 'live-readonly');
    assertEqual(wins.units, (doc.provenance.units[ecId] ?? 0) + (doc.provenance.units[lrId] ?? 0), '[f] wins.units = the units the pulled sources contribute');
    // a pull that needs no check previews so
    clearDocs();
    putDoc(profileDoc([await editorCacheSource(catalogSeedRecords(), { firmware: FW })], { firmware: FW }));
    f.state.rows = [await cloudRow(ID_LR, lr)];
    forgetDefinitionSources(r.registry);
    const nn = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { dryRun: true });
    assertEqual(json((nn.body as Json).spotCheck), json({ needed: false, status: 'not-needed', eligible: 0, planned: 0, unverifiable: 0 }), '[f] not-needed preview');
    assertEqual((nn.body as { wins: { families: number } }).wins.families, 0, '[f] a cloud read under a local editor cache decides no family');
  } finally { clearDocs(); await r.close(); }
}

// ── (g) TX audit: a row above its block's bound is never read ──────────────────────────────────────────────────────
async function txAudit(): Promise<void> {
  clearDocs();
  const bound = walkBlockLimits(FM3, 'read-only', null).bound;
  const reverbBound = bound[SEED_BLOCKS.REVERB]!;
  assert(reverbBound < 127, `fixture: REVERB's bound ${reverbBound} is below the id cap`);
  // the cloud editor cache claims a REVERB row above the block's bound (the unit has none: it would answer an empty slot)
  const above = { ...catalogSeedRecords().find((x) => x.section === SEED_TAGS.REVERB)!, id: reverbBound + 5 } as CacheRecord;
  const ec = await ecShared([...catalogSeedRecords(), above]);
  const f = fakeCloud([await cloudRow(ID_EC, ec)]);
  const r = await makeRig(f.cloud);
  try {
    const plan = planSpotCheck({
      model: FM3, firmware: FW, doc: profileDoc([asCloud(ec)], { firmware: FW }) as never, cloudSourceIds: [asCloud(ec).id],
      store: store.defaultStore, key: KEY, gates: {}
    });
    assertEqual(`${plan.status} ${plan.pools.unverifiable} ${plan.targets.length}`, `ready 1 ${TARGETS}`, '[g] the row above the bound is unverifiable, not a target');
    for (const t of plan.targets) assert(t.pid <= bound[t.block]! && t.bound === bound[t.block], `[g] ${t.family}:${t.pid}: bound from the static catalog`);
    const sent0 = r.mock.sent.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${res.code} ${(res.body as { spotCheck?: { verdict: string } }).spotCheck?.verdict}`, '200 passed', '[g] passed');
    const frames = r.mock.sent.slice(sent0);
    assertEqual(auditTx(frames, '[g] TX'), TARGETS, '[g] only the planned definition queries');
    assert(!frames.some((q) => { const d = decodeWalkQuery(Uint8Array.from(q))!; return d.block === SEED_BLOCKS.REVERB && d.param === above.id; }), '[g] the row above the bound was never queried');
    assert(!frames.some((q) => decodeWalkQuery(Uint8Array.from(q))!.block > 160), '[g] no block above 160 (gates closed)');
  } finally { clearDocs(); await r.close(); }
}

// ── (h) A8: a pull, then export → delete → import with the cloud disabled ──────────────────────────────────────────
interface Snapshot { caps: Json; diff: Json; params: Record<number, string> }
async function snapshot(app: Rig['app']): Promise<Snapshot> {
  const dev = JSON.parse((await app.inject({ method: 'GET', url: '/device' })).payload) as { capabilities: { definitions: Json } };
  const diff = JSON.parse((await app.inject({ method: 'GET', url: '/device/definitions/diff' })).payload) as Json;
  const params: Record<number, string> = {};
  for (const eid of BLOCKS) {
    const p = await app.inject({ method: 'GET', url: `/preset/blocks/${eid}/params?generic=1` });
    assertEqual(p.statusCode, 200, `[h] generic params of block ${eid}: 200`);
    params[eid] = p.payload;
  }
  return { caps: dev.capabilities.definitions, diff, params };
}
async function a8Roundtrip(): Promise<void> {
  clearDocs();
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared()), await cloudRow(ID_LR, liveShared(toBlocks(catalogSeedRecords(), 'dB')))]);
  const r = await makeRig(f.cloud);
  let offline: Rig['app'] | null = null;
  try {
    const pulled = await r.app.inject({ method: 'POST', url: '/device/cache/cloud/pull', headers: { 'content-type': 'application/json' }, payload: '{}' });
    assertEqual(pulled.statusCode, 200, `[h] pull through the route (${pulled.payload.slice(0, 200)})`);
    r.bodyProfile.current = r.registry.profile;
    const before = await snapshot(r.app);
    assertEqual((before.caps as { drift: string }).drift, 'none', '[h] the pulled profile applies: no drift');
    const exported = await r.app.inject({ method: 'GET', url: '/device/definitions/export' });
    assertEqual(exported.statusCode, 200, '[h] export');
    assertEqual(JSON.parse((await r.app.inject({ method: 'DELETE', url: '/device/cache' })).payload).deleted, true, '[h] delete');
    // the cloud disabled: a fresh app over the same unit without any cloud
    offline = await buildApp(r.registry);
    assertEqual((await offline.inject({ method: 'GET', url: '/device/cache/cloud' })).payload, json({ enabled: false, available: false }), '[h] cloud disabled');
    assertEqual((await offline.inject({ method: 'POST', url: '/device/cache/cloud/pull', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode, 404, '[h] no pull route without a cloud');
    const sent0 = r.mock.sent.length;
    const imp = await offline.inject({ method: 'POST', url: '/device/definitions/import', headers: { 'content-type': 'application/json' }, payload: exported.payload });
    assertEqual(imp.statusCode, 200, `[h] import (${imp.payload.slice(0, 200)})`);
    assertEqual(originsOf(storedDoc()), 'editor-cache/file,live-readonly/file', '[h] the sources come back from the file');
    const after = await snapshot(offline);
    const normCaps = (c: Json) => { const p = c.profile as Json | null; return json({ ...c, profile: p ? { ...p, source: '<source>' } : p }); };
    assertEqual(normCaps(after.caps), normCaps(before.caps), '[h] the same caps (the provenance the file re-tags apart)');
    const normDiff = (d: Json) => {
      const p = d.profile as { source: string; sources: Array<{ origin: string }> } | null;
      return json({ ...d, profile: p ? { ...p, source: '<source>', sources: p.sources.map((s) => ({ ...s, origin: '<origin>' })) } : p });
    };
    assertEqual(normDiff(after.diff), normDiff(before.diff), '[h] the same diff');
    for (const eid of BLOCKS) assertEqual(after.params[eid], before.params[eid], `[h] the same ?generic=1 params of block ${eid}`);
    assertEqual(r.mock.sent.slice(sent0).filter((q) => q.length === 23 && decodeWalkQuery(Uint8Array.from(q))?.view === VIEW_DEFINITION).length, 0, '[h] no definition query after the pull');
  } finally { clearDocs(); if (offline) await offline.close(); await r.close(); }
}

// ── (i) app ↔ router twins, the origin guard, the Remote relay ─────────────────────────────────────────────────────
async function twins(): Promise<void> {
  clearDocs();
  const local = localLive();
  const honest = await cloudRow(ID_EC, await ecShared());
  const manipulated = await cloudRow(ID_LF.replace('2d9e', '4f10'), await ecShared(catalogSeedRecords().map((x, i) => (i === 0 ? { ...x, tc: x.tc ^ 0x70 } : x))));
  const f = fakeCloud([honest]);
  const r = await makeRig(f.cloud);
  const viaApp = async (body: string, headers: Record<string, string> = {}) => {
    const res = await r.app.inject({ method: 'POST', url: '/device/cache/cloud/pull', headers: { 'content-type': 'application/json', ...headers }, payload: body });
    return { status: res.statusCode, text: res.payload };
  };
  const viaRouter = async (body: string) => {
    const res = await r.router.handle('POST', '/device/cache/cloud/pull', body);
    return { status: res.status, text: res.body as string };
  };
  /** Fresh identical state: the local read stored, no verdicts, the listing asked again. */
  const reset = (row: CloudRow) => { clearDocs(); putDoc(profileDoc([local], { firmware: FW })); f.state.rows = [row]; forgetDefinitionSources(r.registry); };
  try {
    for (const [label, row, body, expect] of [
      ['passed pull', honest, '{}', 200], ['failed pull', manipulated, '{}', 409], ['dry run', honest, '{"dryRun":true}', 200],
      ['by id', honest, json({ sourceIds: [ID_EC] }), 200], ['a malformed body', honest, '[1]', 400], ['a malformed id', honest, '{"sourceIds":["x"]}', 400]
    ] as const) {
      reset(row);
      const sent0 = r.mock.sent.length;
      const a = await viaApp(body);
      const appFrames = r.mock.sent.slice(sent0).map(compactHex);
      const appRaw = json(storedDoc()?.raw ?? null);
      const appVerdicts = json([...readCloudVerdicts(store.defaultStore, KEY).entries()].map(([k, v]) => [k, v.verdict, v.factHash, v.checked]));
      reset(row);
      const sent1 = r.mock.sent.length;
      const b = await viaRouter(body);
      assertEqual(`${a.status}`, `${expect}`, `[i] ${label}: app status`);
      assertEqual(b.status, a.status, `[i] ${label}: router status = app status`);
      assertEqual(b.text, a.text, `[i] ${label}: router body = app body`);
      assertEqual(json(r.mock.sent.slice(sent1).map(compactHex)), json(appFrames), `[i] ${label}: the same frames on the wire`);
      assertEqual(json(storedDoc()?.raw ?? null), appRaw, `[i] ${label}: the same stored sources`);
      assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).entries()].map(([k, v]) => [k, v.verdict, v.factHash, v.checked])), appVerdicts, `[i] ${label}: the same verdicts`);
    }
    // the origin guard (FORGEFX-51): a foreign page is refused before anything happens
    reset(honest);
    const before = json(storedRaw());
    const sent0 = r.mock.sent.length;
    const foreign = await viaApp('{}', { origin: 'https://evil.example' });
    assertEqual(`${foreign.status} ${(JSON.parse(foreign.text) as { error?: string }).error}`, '403 forbidden-origin', '[i] a foreign origin → 403');
    assertEqual(`${r.mock.sent.length - sent0} ${json(storedRaw()) === before}`, '0 true', '[i] nothing sent, nothing stored');
    // the Remote relay never carries the pull (a device check + a store write)
    for (const p of ['/device/cache/cloud/pull', '/device/cache/cloud/pull?dryRun=1']) assert(!remoteAllowed('POST', p), `[i] Remote refuses POST ${p}`);
    assert(remoteAllowed('GET', '/device/cache/cloud'), '[i] Remote still reads the check');
  } finally { clearDocs(); await r.close(); }
}

// ── v1 rows are checked too ─────────────────────────────────────────────────────────────────────────────────────────
async function v1RowsChecked(): Promise<void> {
  clearDocs();
  const f = fakeCloud([], { v2: false, v1: await v1Row() });
  const r = await makeRig(f.cloud);
  try {
    const sent0 = r.mock.sent.length;
    const preview = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { dryRun: true });
    assertEqual(json((preview.body as Json).spotCheck), json({ needed: true, status: 'ready', eligible: TARGETS, planned: TARGETS, unverifiable: 0 }), '[v1] the preview plans a check of the derived rows');
    assertEqual(`${(preview.body as Json).version} ${r.mock.sent.length - sent0} ${storedDoc()}`, '1 0 null', '[v1] preview: no traffic, nothing stored');
    const ok = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(ok.code, 200, `[v1] an honest v1 row passes (${json(ok.body).slice(0, 200)})`);
    assertEqual(json((ok.body as Json).spotCheck), json({ verdict: 'passed', checked: TARGETS, answered: TARGETS, mismatches: 0, durationMs: 0, unverifiable: 0 }), '[v1] checked against the derived rows');
    assertEqual(auditTx(r.mock.sent.slice(sent0), '[v1] TX'), TARGETS, '[v1] read-only');
    assertEqual((storedDoc()!.meta as { source: string }).source, 'cloud', '[v1] adopted');
    assertEqual(verdictDoc(), null, '[v1] no verdict (a v1 row has no row id)');
    // a manipulated v1 row: refused, nothing stored, no verdict
    clearDocs();
    f.state.v1 = await v1Row((p) => { ((p.ranges as Json).DISTORT as Record<string, { typecode: number }>)['91']!.typecode ^= 0x70; });
    const bad = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${bad.code} ${errorOf(bad.body)} ${json((bad.body as { spotCheck: { failures: unknown } }).spotCheck.failures)}`, `409 spot-check-failed ${json([{ family: 'DISTORT', pid: 91 }])}`, '[v1] a manipulated v1 row fails');
    assertEqual(`${storedDoc()} ${verdictDoc()}`, 'null null', '[v1] nothing stored, no verdict');
    // a unit without a spot check keeps the M3 path (no check, no traffic)
    const caps = r.registry.activeCapabilities.bind(r.registry);
    (r.registry as unknown as { activeCapabilities: () => unknown }).activeCapabilities = () => ({ ...caps()!, slotModel: 'linear' });
    try {
      const sent1 = r.mock.sent.length;
      const m3 = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
      assertEqual(`${m3.code} ${json((m3.body as Json).spotCheck)} ${r.mock.sent.length - sent1}`, `200 ${json({ verdict: 'unavailable' })} 0`, '[v1] a unit without a spot check: the M3 path, marked unavailable');
    } finally { delete (r.registry as unknown as { activeCapabilities?: unknown }).activeCapabilities; }
  } finally { clearDocs(); await r.close(); }
}

// ── the body parser ─────────────────────────────────────────────────────────────────────────────────────────────────
async function bodyParser(): Promise<void> {
  const opts = (b: unknown) => { const p = parsePullBody(b); return p.ok ? json(p.opts) : `${p.result.code} ${(p.result.body as { error: string }).error}`; };
  const none = json({ replace: false, dryRun: false, recheck: false });
  assertEqual(`${opts(undefined)} ${opts(null)} ${opts({})}`, `${none} ${none} ${none}`, '[body] defaults');
  assertEqual(opts({ replace: 'yes', dryRun: 1, recheck: true, extra: 1 }), json({ replace: false, dryRun: false, recheck: true }), '[body] only true counts, unknown keys ignored');
  assertEqual(`${opts([])} ${opts('x')} ${opts(3)}`, '400 invalid-request 400 invalid-request 400 invalid-request', '[body] not an object → 400');
  assertEqual(opts({ sourceIds: [ID_EC.toUpperCase(), ID_EC] }), json({ replace: false, dryRun: false, recheck: false, sourceIds: [ID_EC] }), '[body] ids lower-cased, duplicates dropped');
  assertEqual(opts({ sourceIds: ID_EC }), '400 invalid-request', '[body] sourceIds not an array → 400');
  assertEqual(opts({ sourceIds: [ID_EC, ID_LR, ID_LF, ID_EC.replace('0b7c', '9999')] }), '400 invalid-request', `[body] more than ${PULL_MAX_SOURCE_IDS} ids → 400`);
  assertEqual(opts({ sourceIds: ['../mine'] }), '400 invalid-request', '[body] a non-row id → 400');
}

// ── review round: refusals after a check, one row per kind, blame scope, earlier cloud sources, v1 raw, replace, swaps ──

/** The FM3 CHORUS block (first instance) and six of its catalog float rows there: a family the seed editor cache lacks. */
const CHORUS_EID = [...staticRoster(FM3)].find(([, ref]) => ref.family === 'CHORUS' && ref.instance === 1 && !ref.roster)![0];
const chorusRows = () => familyRecords('CHORUS', CHORUS_EID).slice(0, 6);
const isDefQuery = (q: readonly number[]) => q.length === 23 && decodeWalkQuery(Uint8Array.from(q))?.view === VIEW_DEFINITION;
/** Make the registry report another model from now on (a unit swapped); returns the undo. */
function swapModel(registry: DeviceRegistry, model: number): () => void {
  Object.defineProperty(registry, 'detectedModelId', { get: () => model, configurable: true });
  return () => { delete (registry as unknown as { detectedModelId?: unknown }).detectedModelId; };
}

async function refusalAfterCheck(): Promise<void> {
  clearDocs();
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared())]);
  const r = await makeRig(f.cloud);
  const replyOf = r.mock.reply;
  try {
    // the stored definitions change during a check that then passes: 409 busy, and a terminal SSE error (never stuck)
    let n = 0;
    r.mock.reply = (req) => { if (isDefQuery(req) && ++n === TARGETS) putDoc(profileDoc([localLive()], { firmware: FW })); return replyOf(req); };
    let ev0 = r.events.length;
    const raced = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${raced.code} ${errorOf(raced.body)}`, '409 busy', '[1] store changed after a passed check → 409 busy');
    let cb = cacheBuilds(r.events.slice(ev0));
    assertEqual(`${cb.some((e) => e.phase === 'verifying')} ${cb.at(-1)?.phase} ${cb.at(-1)?.reason}`, 'true error definitions-changed', '[1] terminal SSE error after verifying');
    assertEqual(`${verdictDoc()} ${f.calls.reports.length}`, 'null 0', '[1] no verdict, no report for an unstored pull');
    clearDocs();
    // the unit is swapped during a check that then passes: 503, terminal SSE error, nothing stored under the old key
    n = 0;
    let undo: (() => void) | null = null;
    r.mock.reply = (req) => { if (isDefQuery(req) && ++n === TARGETS) undo = swapModel(r.registry, 0x12); return replyOf(req); };
    ev0 = r.events.length;
    try {
      const swapped = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
      assertEqual(`${swapped.code} ${errorOf(swapped.body)}`, '503 no-device', '[1] unit swapped after the check → 503 no-device');
    } finally { (undo as (() => void) | null)?.(); }
    cb = cacheBuilds(r.events.slice(ev0));
    assertEqual(`${cb.at(-1)?.phase} ${cb.at(-1)?.reason}`, 'error unit-changed', '[1] terminal SSE error unit-changed');
    assertEqual(storedDoc(), null, '[1] nothing stored');
    // a runner argument the codec refuses (a host bug, before any query): 500 spot-check-error, SSE error
    r.mock.reply = replyOf;
    __setSpotCheckForTest(r.registry, { seed: 7, run: { sleep: async () => {}, drainMs: -1, now: () => 0 } });
    const sent0 = r.mock.sent.length;
    ev0 = r.events.length;
    const bug = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${bug.code} ${errorOf(bug.body)} ${r.mock.sent.length - sent0}`, '500 spot-check-error 0', '[nice] a refused runner argument → 500, nothing sent');
    cb = cacheBuilds(r.events.slice(ev0));
    assertEqual(`${cb.at(-1)?.phase} ${cb.at(-1)?.reason}`, 'error spot-check-error', '[nice] terminal SSE error');
  } finally { r.mock.reply = replyOf; clearDocs(); await r.close(); }
}

async function unitSwappedBeforeTraffic(): Promise<void> {
  clearDocs();
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared())]);
  const r = await makeRig(f.cloud);
  const get = f.cloud.definitionSourceGet!.bind(f.cloud);
  let undo: (() => void) | null = null;
  f.cloud.definitionSourceGet = async (id: string) => { undo = swapModel(r.registry, 0x12); return get(id); };
  try {
    const sent0 = r.mock.sent.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${res.code} ${errorOf(res.body)}`, '503 no-device', '[4] a unit swapped while the rows were fetched → 503 before any query');
    assertEqual(`${r.mock.sent.slice(sent0).filter(isDefQuery).length} ${storedDoc()} ${verdictDoc()}`, '0 null null', '[4] no query, nothing stored, no verdict');
  } finally { (undo as (() => void) | null)?.(); clearDocs(); await r.close(); }
}

async function oneRowPerKind(): Promise<void> {
  clearDocs();
  const honest = await cloudRow(ID_EC, await ecShared());
  const ID_X = '5a5a5a5a-0000-4000-8000-000000000001';
  const bad = await cloudRow(ID_X, await ecShared(catalogSeedRecords().map((x, i) => (i === 0 ? { ...x, tc: x.tc ^ 0x70 } : x))));
  const f = fakeCloud([honest, bad]);
  const r = await makeRig(f.cloud);
  try {
    const chk = await cloudCacheCheck(f.cloud, store.defaultStore, r.registry);
    assertEqual(json(chk.sources?.map((s) => s.id)), json([ID_EC]), '[2] the check offers the first row of a kind only');
    const ok = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${ok.code} ${f.calls.get.join(',')}`, `200 ${ID_EC}`, '[2] the pull fetches the first row only');
    const named = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { sourceIds: [ID_X] });
    assertEqual(`${named.code} ${errorOf(named.body)}`, '404 not-found', '[2] the second row of a kind is never offered');
    // the manipulated row first: it alone is blamed and reported
    clearDocs();
    f.state.rows = [bad, honest];
    f.calls.reports.length = 0;
    forgetDefinitionSources(r.registry);
    const failed = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${failed.code} ${errorOf(failed.body)}`, '409 spot-check-failed', '[2] the first (manipulated) row fails');
    assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).entries()].map(([k, v]) => `${k}:${v.verdict}`)), json([`${ID_X}:failed`]), '[2] only that row gets the verdict');
    assertEqual(f.calls.reports.map((x) => x.sourceId).join(','), ID_X, '[2] only that row is reported');
  } finally { clearDocs(); await r.close(); }
}

async function blameScope(): Promise<void> {
  clearDocs();
  // the cloud editor cache lacks CHORUS; the cloud read has it, with one row altered (the unit answers the honest one)
  const rows = chorusRows();
  const altered = rows.map((x, i) => (i === 2 ? { ...x, max: x.max + 7 } : x));
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared()), await cloudRow(ID_LR, liveShared([...toBlocks(catalogSeedRecords()), ...altered]))]);
  const r = await makeRig(f.cloud);
  r.device.records.push(...rows);
  try {
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${res.code} ${errorOf(res.body)}`, '409 spot-check-failed', `[3b] the altered row fails (${json(res.body).slice(0, 200)})`);
    assertEqual(json((res.body as { spotCheck: { failures: unknown } }).spotCheck.failures), json([{ family: 'CHORUS', pid: rows[2]!.id }]), '[3b] the CHORUS row named');
    assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).entries()].map(([k, v]) => `${k}:${v.verdict}`)), json([`${ID_LR}:failed`]), '[3b] only the read that decides CHORUS is blamed');
    assertEqual(f.calls.reports.map((x) => `${x.sourceId}:${x.verdict}`).join(','), `${ID_LR}:failed`, '[3b] only it is reported');
    assertEqual(storedDoc(), null, '[3b] nothing stored');
  } finally { clearDocs(); await r.close(); }
}

async function earlierCloudSourceChecked(): Promise<void> {
  clearDocs();
  // an EARLIER pull stored a cloud read that decides CHORUS; the new pull brings an editor cache without CHORUS
  const stored = liveSource([...toBlocks(catalogSeedRecords()), ...chorusRows()], { firmware: FW, capturedAt: '2026-11-20T00:00:00.000Z', origin: 'cloud' });
  putDoc(profileDoc([stored], { firmware: FW }));
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared())]);
  const r = await makeRig(f.cloud);
  r.device.records.push(...chorusRows());
  try {
    const sent0 = r.mock.sent.length;
    const res = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${res.code} ${(res.body as { spotCheck?: { verdict: string } }).spotCheck?.verdict}`, '200 passed', `[3a] passed (${json(res.body).slice(0, 200)})`);
    const doc = storedDoc()!;
    assertEqual(doc.provenance.existence.CHORUS, stored.id, '[3a] CHORUS still decided by the earlier cloud read');
    const chorusQueries = r.mock.sent.slice(sent0).filter((q) => isDefQuery(q) && decodeWalkQuery(Uint8Array.from(q))!.block === CHORUS_EID).length;
    assert(chorusQueries > 0, '[3a] CHORUS rows (decided by a stored cloud source) are among the checked targets');
    assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).keys()]), json([ID_EC]), '[3a] the verdict goes to the pulled row only');
  } finally { clearDocs(); await r.close(); }
}

async function v1RawRealCheck(): Promise<void> {
  clearDocs();
  const row = async (records: CacheRecord[]): Promise<FakeV1Row> => ({
    profile: clone(profileDoc([await editorCacheSource(records, { firmware: FW })], { firmware: FW })), contentHash: 'v1raw', source: 'editor-cache', recordCount: 25, createdAt: '2026-07-13T00:00:00Z'
  });
  const f = fakeCloud([], { v2: false, v1: await row(catalogSeedRecords()) });
  const r = await makeRig(f.cloud);
  try {
    const sent0 = r.mock.sent.length;
    const ok = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${ok.code} ${(ok.body as Json).format} ${(ok.body as { spotCheck?: { verdict: string } }).spotCheck?.verdict}`, '200 2 passed', '[3c] a v1 row with raw sources is checked for real');
    assertEqual(auditTx(r.mock.sent.slice(sent0), '[3c] TX'), TARGETS, '[3c] the checked queries');
    assertEqual(originsOf(storedDoc()), 'editor-cache/cloud', '[3c] stored, origin cloud');
    clearDocs();
    f.state.v1 = await row(catalogSeedRecords().map((x, i) => (i === 0 ? { ...x, tc: x.tc ^ 0x70 } : x)));
    const bad = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${bad.code} ${errorOf(bad.body)} ${storedDoc()} ${verdictDoc()}`, '409 spot-check-failed null null', '[3c] a manipulated raw v1 row: refused, nothing stored, no verdict');
  } finally { clearDocs(); await r.close(); }
}

async function replaceTrue(): Promise<void> {
  const localEc = await editorCacheSource(catalogSeedRecords(), { firmware: FW });
  const f = fakeCloud([await cloudRow(ID_EC, await ecShared())]);
  const r = await makeRig(f.cloud);
  try {
    clearDocs();
    putDoc(profileDoc([localEc], { firmware: FW }));
    const merged = await cloudCachePull(f.cloud, store.defaultStore, r.registry);
    assertEqual(`${merged.code} ${(merged.body as { spotCheck: { verdict: string } }).spotCheck.verdict} ${originsOf(storedDoc())}`, '200 not-needed editor-cache/local,editor-cache/cloud', '[3d] without replace: the local editor cache decides, no check');
    clearDocs();
    putDoc(profileDoc([localEc], { firmware: FW }));
    forgetDefinitionSources(r.registry);
    const sent0 = r.mock.sent.length;
    const replaced = await cloudCachePull(f.cloud, store.defaultStore, r.registry, { replace: true });
    const b = replaced.body as { spotCheck: { verdict: string; checked: number }; merged: boolean };
    assertEqual(`${replaced.code} ${b.spotCheck.verdict} ${b.merged} ${originsOf(storedDoc())}`, '200 passed false editor-cache/cloud', '[3d] replace: the local source dropped, so the cloud decides and is checked');
    // (the stored local editor cache still refines the bounds of this check — local byte data, the walk's own rule —
    // so fewer rows are eligible than with catalog bounds)
    assert(b.spotCheck.checked >= 12, '[3d] at least 12 targets');
    assertEqual(auditTx(r.mock.sent.slice(sent0), '[3d] TX'), b.spotCheck.checked, '[3d] one query per checked target');
  } finally { clearDocs(); await r.close(); }
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['(a) cloud editor cache over a local read: byte rows win, units kept, passed verdict + report, SSE verifying', editorCacheOverLocalRead],
  ['(b) a truncated cloud read next to a cloud editor cache: byte rows win', truncatedReadNextToEditorCache],
  ['(c) a local editor cache + a cloud read: not-needed, units only on tuple-equal rows', localEditorCacheCloudRead],
  ['(d) a manipulated catalog-known row: failed, store untouched, verdict, not re-offered, recheck', manipulatedRowFails],
  ['(e) inconclusive / aborted / insufficient / busy / 501 / invalid-source / firmware-differs / 502 / ids', refusals],
  ['(f) dry-run preview: zero frames, zero writes, predicts the pull', dryRunPreview],
  ['(g) TX audit: definition queries only, none above the bound', txAudit],
  ['(h) A8: pull, export, delete, import offline = same caps / diff / generic params', a8Roundtrip],
  ['(i) app ↔ router twins, origin guard, Remote', twins],
  ['v1 rows are checked too; a unit without a spot check keeps the M3 path', v1RowsChecked],
  ['the pull body parser', bodyParser],
  ['a refusal after a passed check ends the SSE progress (store changed, unit swapped, runner bug → 500)', refusalAfterCheck],
  ['a unit swapped while the rows were fetched gets no query', unitSwappedBeforeTraffic],
  ['one row per kind: a second row of a kind is never offered, blamed or reported', oneRowPerKind],
  ['blame scope: only the row that decides the mismatching family is failed and reported', blameScope],
  ['a family an earlier-stored cloud source decides is checked too', earlierCloudSourceChecked],
  ['a v1 row with raw sources is checked for real', v1RawRealCheck],
  ['replace: true drops the local source, so the cloud decides and is checked', replaceTrue]
];
export const CLOUD_V2_PULL_CASE_COUNT = CASES.length;

export async function runCloudV2PullTests(): Promise<void> {
  for (const [name, run] of CASES) {
    try {
      await run();
    } catch (e) {
      throw new Error(`[api/cloud-v2-pull] ${name}: ${(e as Error).message}`);
    }
  }
}
