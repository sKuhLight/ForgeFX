// Cloud client v2 + check (M4 WP-F1) — a structural fake cloud and a faked Supabase `fetch`, mocked FM3, NO hardware,
// NO network. Synthetic raw sources from the FM3 catalog only (test/helpers/profileDocs.ts). Covers:
//   - the v2 listing turned into client summaries (exact shape and key order), the 10-minute cache (`refresh`, expiry,
//     forget, another client), the identity the store is asked for (model, firmware read from the unit, RAW_FORMAT);
//   - the v1 fallback: the function missing (null), throwing, or offering nothing → the v1 answer, identical to a client
//     without v2; units the v2 store does not serve (firmware not read, AM4) never ask it; the v1 pull unchanged;
//   - this install's verdicts: a failed check moves a row to `rejected` (only for the facts it was reached on; a row
//     re-created under a new id with the same (kind, factHash) stays rejected), passed shows as `verdict`, malformed
//     verdicts ignored, ids lower-cased, the newest 64 kept, the collection write-protected; the exported offer split;
//     a v2 answer drops the cached v1 row;
//   - `improves` (local editor cache → no; local live only + cloud editor cache → yes; a better-ranked local LIVE read
//     covers a live offer only with as many record-carrying blocks; legacy format-1 doc; a newer build's doc; an
//     undecidable stored source or block count → unknown) and `identical` by the codec fact hash;
//   - app ↔ router twin parity (Browser Direct) incl. `?refresh=1`, the disabled answer, the Remote relay (GET allowed);
//   - the shared validation mode (services/rawValidation.ts): codec share output passes unchanged, every rule refuses
//     (incl. file / codec version patterns, unit tokens, labels, conflicting duplicates, a block listed twice);
//   - the Cloud client's v2 methods over a faked Supabase: URLs (`no-cache` listing, lower-cased ids), answer parsing,
//     sessions (share signs in anonymously in its OWN slot, never the editor-cache one and vice versa; withdraw / mine
//     never sign in, a report never creates a session).
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { gunzipSync } from 'node:zlib';
import {
  CACHE_SCHEMA, RAW_FORMAT, shareableSource, sourceFactHash,
  type CacheRecord, type EditorCacheRawSource, type LiveRawSource, type RawSource, type ShareableSource
} from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import {
  CLOUD_CHECK_CACHE_MS, CLOUD_VERDICTS_COLLECTION, CLOUD_VERDICTS_MAX, cloudCacheCheck, cloudCachePull, definitionSourcesOffer,
  forgetDefinitionSources, normalizeRowId, readCloudVerdicts, recordCloudVerdict, verdictFor,
  type CloudCacheCheck, type CloudProfilesCloud, type DeviceProfileCloud
} from '../../src/services/cloudProfiles.js';
import { checkRawSources, checkSharedSource, checkSharedSources, isDayStamp } from '../../src/services/rawValidation.js';
import { isWriteProtectedCollection } from '../../src/runtime/storeAccess.js';
import { RemoteHost, remoteAllowed } from '../../src/remote.js';
import {
  ANONYMOUS_UPLOADER_STORAGE_KEY, DEFINITION_SHARER_STORAGE_KEY, createCloud, parseDefinitionSourceBody, parseDefinitionSourceList,
  type DefinitionSourceContribution, type DefinitionSourceList, type DefinitionSourceSummary
} from '../../src/runtime/cloud.js';
import { createStore, type Store } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { clone, editorCacheSource, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';
import { fakeChannelSession } from './remote.test.js';

const FM3 = 0x11;
const AM4 = 0x15;
const FW = '13.0';
const KEY = '11_13p0';
const ID_EC = '0b7c6a2e-1111-4222-8333-944455556666';
const ID_LR = '1c8d7b3f-2222-4333-8444-a55566667777';
const ID_LF = '2d9e8c40-3333-4444-8555-b66677778888';
const H_EC = 'e'.repeat(64);
const H_LR = 'b'.repeat(64);
const H_LF = 'f'.repeat(64);
const AT = '2026-11-23T09:00:00.000Z';

const json = (v: unknown) => JSON.stringify(v);
const clearDocs = () => {
  store.defaultStore.delDoc('deviceCaches', KEY);
  store.defaultStore.delDoc(CLOUD_VERDICTS_COLLECTION, KEY);
};
const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);

// ── fixtures ──

/** A detected unit of `model` whose firmware reply is `fw` (null: a silent unit). */
async function makeRegistry(model = FM3, fw: readonly [number, number] | null = [13, 0]): Promise<DeviceRegistry> {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (fw && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model, fw[0], fw[1])];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  return registry as DeviceRegistry;
}

type Kind = DefinitionSourceSummary['kind'];
const ids: Record<Kind, string> = { 'editor-cache': ID_EC, 'live-readonly': ID_LR, 'live-full': ID_LF };
const hashes: Record<Kind, string> = { 'editor-cache': H_EC, 'live-readonly': H_LR, 'live-full': H_LF };

/** A listed row as the cloud serves it (the function's `SourceSummary`). */
function row(kind: Kind, o: Partial<DefinitionSourceSummary> = {}): DefinitionSourceSummary {
  const summary = kind === 'editor-cache'
    ? { records: 2500, sections: 41, omittedRecords: 12, headerVersion: FW, headerSectionCount: 41, fileVersion: FW, headerMatchesFirmware: true, labels: 900 }
    : {
        records: 3000, blocks: 60, scopeBlocks: 161, maxParamId: 127, extended: kind === 'live-full', above160: false, hinted: false, units: 40, tapers: 0,
        walk: { queries: 3100, lostReplies: 2, recoveredReplies: 2, unresolvedReplies: 0, missingSlots: 0, boundHits: 0, extension: null }
      };
  return {
    id: ids[kind], kind, rawFormat: 1, factHash: hashes[kind], tier: 'candidate', quality: 3, contributors: 1, networks: 1,
    spotChecks: { passed: 0, failed: 0 }, firstSeen: '2026-11-20', lastConfirmedAt: null, bytes: 420_000, summary, ...o
  };
}

function listing(...sources: DefinitionSourceSummary[]): DefinitionSourceList {
  const alternatives = { 'editor-cache': 0, 'live-full': 0, 'live-readonly': 0 };
  for (const s of sources) alternatives[s.kind] = 1;
  return { model: FM3, firmware: FW, sources, alternatives };
}

/** A v1 profile row (the M3 store), usable by this build. */
function v1Row() {
  return {
    profile: { ranges: { DISTORT: {} }, rangeSections: {}, rosters: {}, enumOverrides: {}, cabIrs: {}, meta: { schema: CACHE_SCHEMA, recordCount: 42, source: 'live' } },
    contentHash: 'abc123', source: 'live-walk', recordCount: 42, createdAt: '2026-07-13T00:00:00Z'
  };
}

interface FakeOpts { list?: DefinitionSourceList | null | 'throw'; v1?: ReturnType<typeof v1Row> | null; v2?: boolean }
/** A structural fake cloud: the v1 store always, the v2 listing unless `v2: false`. Counts every call. */
function fakeCloud(o: FakeOpts = {}) {
  const calls = { list: [] as Array<[number, string, number]>, v1: 0 };
  const v1: DeviceProfileCloud = {
    async deviceProfileGet() { calls.v1++; return o.v1 ? clone(o.v1) : null; },
    async deviceProfilePublish() { return { code: 201, body: {} }; }
  };
  const cloud: CloudProfilesCloud = o.v2 === false ? v1 : {
    ...v1,
    async definitionSourcesList(model: number, firmware: string, rawFormat: number) {
      calls.list.push([model, firmware, rawFormat]);
      if (o.list === 'throw') throw new Error('network down');
      return o.list ? clone(o.list) : null;
    }
  };
  return { cloud, calls };
}

/** Local raw sources of the device firmware (synthetic, FM3 catalog seed records). */
const localEditor = (origin: 'local' | 'cloud' = 'local') => editorCacheSource(undefined, { firmware: FW, origin });
const localLive = (kind: LiveRawSource['kind'] = 'live-readonly', origin: 'local' | 'cloud' = 'local') =>
  liveSource(liveSeedRecords({ unit: 'dB' }), { kind, firmware: FW, origin, capturedAt: '2026-11-22T10:30:00.000Z' });
const factHash = (s: RawSource | ShareableSource) => sourceFactHash(s as RawSource, { model: FM3, firmware: FW });

const verdict = (factHash: string, v: 'passed' | 'failed', at = AT) => ({ factHash, verdict: v, at, checked: 24, answered: 24, mismatches: v === 'failed' ? 1 : 0 });

// ── 1. the v2 listing → client summaries, the identity asked for, the 10-minute cache ──
async function listToSummaries(): Promise<void> {
  clearDocs();
  const registry = await makeRegistry();
  const ec = row('editor-cache', { tier: 'official', contributors: 3, networks: 2, spotChecks: { passed: 2, failed: 0 } });
  const lr = row('live-readonly', { quality: 2, firstSeen: '2026-11-21', summary: { ...row('live-readonly').summary, extended: true, above160: true } });
  const f = fakeCloud({ list: listing(ec, lr), v1: v1Row() });
  const chk = await cloudCacheCheck(f.cloud, store.defaultStore, registry);
  const expected: CloudCacheCheck = {
    enabled: true, available: true, version: 2,
    sources: [
      {
        id: ID_EC, kind: 'editor-cache', tier: 'official', quality: 3, complete: true, contributors: 3, deviceChecks: { passed: 2, failed: 0 },
        firstSeen: '2026-11-20', records: 2500, sections: 41, verdict: null, identical: false
      },
      {
        id: ID_LR, kind: 'live-readonly', tier: 'candidate', quality: 2, complete: false, contributors: 1, deviceChecks: { passed: 0, failed: 0 },
        firstSeen: '2026-11-21', records: 3000, blocks: 60, extended: true, above160: true, verdict: null, identical: false
      }
    ],
    rejected: [], improves: 'yes'
  };
  assertEqual(json(chk), json(expected), '[v2] the listing as client summaries (exact shape, key order), nothing stored → improves yes');
  assertEqual(json(f.calls.list), json([[FM3, FW, RAW_FORMAT]]), '[v2] asked for (model, firmware read from the unit, RAW_FORMAT)');
  assertEqual(f.calls.v1, 0, '[v2] the v1 store is not asked when v2 offers');
  assert(!json(chk).includes(H_EC) && !json(chk).includes('"networks"') && !json(chk).includes('"bytes"'), '[v2] no fact hash, network count or byte size in the answer');

  // the listing is cached per registry and key for 10 minutes; refresh, expiry, forget and another client ask again
  await cloudCacheCheck(f.cloud, store.defaultStore, registry);
  assertEqual(f.calls.list.length, 1, '[cache] a second check within 10 min reuses the listing');
  await cloudCacheCheck(f.cloud, store.defaultStore, registry, { refresh: true });
  assertEqual(f.calls.list.length, 2, '[cache] refresh asks again');
  await cloudCacheCheck(f.cloud, store.defaultStore, registry, { now: Date.now() + CLOUD_CHECK_CACHE_MS + 1000 });
  assertEqual(f.calls.list.length, 3, '[cache] an expired listing is asked again');
  forgetDefinitionSources(registry);
  await cloudCacheCheck(f.cloud, store.defaultStore, registry);
  assertEqual(f.calls.list.length, 4, '[cache] forgetDefinitionSources drops it');
  const other = fakeCloud({ list: listing(ec) });
  const o = await cloudCacheCheck(other.cloud, store.defaultStore, registry);
  assertEqual(`${other.calls.list.length} ${o.sources?.length}`, '1 1', '[cache] another cloud client never sees this one\'s listing');
  // a fresh registry (another connection) asks again
  await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
  assertEqual(f.calls.list.length, 5, '[cache] per registry');
  // off: nothing asked
  assertEqual(json(await cloudCacheCheck(null, store.defaultStore, registry)), json({ enabled: false, available: false }), '[v2] no cloud → disabled');
  clearDocs();
}

// ── 2. the v1 fallback ──
async function v1Fallback(): Promise<void> {
  clearDocs();
  try {
    // the function is missing (404 → null): the v1 answer, exactly what a client without v2 gets
    const reg = await makeRegistry();
    const missing = fakeCloud({ list: null, v1: v1Row() });
    const v1only = fakeCloud({ v2: false, v1: v1Row() });
    const a = await cloudCacheCheck(missing.cloud, store.defaultStore, reg);
    const b = await cloudCacheCheck(v1only.cloud, store.defaultStore, await makeRegistry());
    assertEqual(json(a), json(b), '[v1] function 404 → the same answer as a client without v2');
    assertEqual(`${a.version} ${a.available} ${a.meta?.recordCount} ${a.improves}`, '1 true 42 unknown', '[v1] version 1, the v1 row, improves unknown');
    assertEqual(`${missing.calls.list.length} ${missing.calls.v1}`, '1 1', '[v1] v2 asked first, then v1');
    assertEqual(a.sources, undefined, '[v1] no v2 fields');
    // a null answer is not cached: the next check asks v2 again
    await cloudCacheCheck(missing.cloud, store.defaultStore, reg);
    assertEqual(missing.calls.list.length, 2, '[v1] an unanswered v2 listing is asked again next time');
    // the v1 pull is unchanged: it reuses the row the check fetched
    const pulled = await cloudCachePull(missing.cloud, store.defaultStore, reg);
    assertEqual(`${pulled.code} ${(pulled.body as { source?: string }).source} ${missing.calls.v1}`, '200 cloud 2', '[v1] the pull adopts the v1 row without a second GET');
    clearDocs();

    // v2 throws → v1
    const thrown = fakeCloud({ list: 'throw', v1: v1Row() });
    const t = await cloudCacheCheck(thrown.cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${t.version} ${t.available}`, '1 true', '[v1] a throwing v2 listing falls back to v1');

    // v2 answers but offers nothing: v1 row → v1 answer; no v1 row → the v2 store's "nothing"
    const empty = fakeCloud({ list: listing(), v1: v1Row() });
    const e = await cloudCacheCheck(empty.cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${e.version} ${e.available} ${e.rejected}`, '1 true undefined', '[v1] nothing shared in v2 → the v1 row');
    const none = fakeCloud({ list: listing(), v1: null });
    assertEqual(json(await cloudCacheCheck(none.cloud, store.defaultStore, await makeRegistry())),
      json({ enabled: true, available: false, version: 2, sources: [], rejected: [], improves: 'no' }), '[v1] nothing anywhere → v2 nothing');
    const bare = fakeCloud({ v2: false, v1: null });
    assertEqual(json(await cloudCacheCheck(bare.cloud, store.defaultStore, await makeRegistry())), json({ enabled: true, available: false }),
      '[v1] a client without v2 and no row: the M3 answer, unchanged');

    // a v1 row this build cannot use: still the stale answer, marked version 1
    const staleRow = v1Row();
    delete (staleRow.profile.meta as { schema?: number }).schema;
    const st = await cloudCacheCheck(fakeCloud({ list: null, v1: staleRow }).cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${st.available} ${st.stale} ${st.staleReason} ${st.version}`, 'false true missing 1', '[v1] a stale v1 row keeps its stale fields');

    // units the v2 store does not serve never ask it: a silent FM3 (identity from a stored key) and an AM4
    putDoc({ ranges: {}, meta: { schema: CACHE_SCHEMA, recordCount: 1, source: 'live' } });
    const silent = fakeCloud({ list: listing(row('editor-cache')), v1: v1Row() });
    const s = await cloudCacheCheck(silent.cloud, store.defaultStore, await makeRegistry(FM3, null));
    assertEqual(`${silent.calls.list.length} ${silent.calls.v1} ${s.version}`, '0 1 1', '[v1] firmware not read from the unit → v1 only');
    clearDocs();
    store.defaultStore.putDoc('deviceCaches', '15_66p1', { ranges: {}, meta: { schema: CACHE_SCHEMA, recordCount: 1, source: 'editor-cache' } });
    const am4 = fakeCloud({ list: listing(row('editor-cache')), v1: v1Row() });
    await cloudCacheCheck(am4.cloud, store.defaultStore, await makeRegistry(AM4, null));
    assertEqual(`${am4.calls.list.length} ${am4.calls.v1}`, '0 1', '[v1] AM4 → v1 only');
    store.defaultStore.delDoc('deviceCaches', '15_66p1');
  } finally { clearDocs(); }
}

// ── 3. this install's verdicts ──
async function verdicts(): Promise<void> {
  clearDocs();
  try {
    const list = listing(row('editor-cache'), row('live-readonly'));
    recordCloudVerdict(store.defaultStore, KEY, ID_EC, verdict(H_EC, 'failed'));
    const f = fakeCloud({ list, v1: v1Row() });
    const c = await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${c.version} ${c.available}`, '2 true', '[verdict] the remaining row is offered');
    assertEqual(json(c.sources?.map((s) => `${s.kind}:${s.verdict}`)), json(['live-readonly:null']), '[verdict] the failed row is not offered');
    assertEqual(json(c.rejected?.map((s) => `${s.id}:${s.kind}:${s.verdict}`)), json([`${ID_EC}:editor-cache:failed`]), '[verdict] failed → rejected');
    assertEqual(c.improves, 'yes', '[verdict] improves judged on the offered rows');

    // a verdict counts only for the facts it was reached on; passed shows on the offered row
    recordCloudVerdict(store.defaultStore, KEY, ID_LR, verdict(H_EC, 'failed'));
    const c2 = await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
    assertEqual(json(c2.sources?.map((s) => `${s.kind}:${s.verdict}`)), json(['live-readonly:null']), '[verdict] a verdict on other facts is ignored');
    recordCloudVerdict(store.defaultStore, KEY, ID_LR, verdict(H_LR, 'passed'));
    const c3 = await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
    assertEqual(json(c3.sources?.map((s) => `${s.kind}:${s.verdict}`)), json(['live-readonly:passed']), '[verdict] passed shows on the offered row');

    // every row failed: the v1 row answers, carrying the rejected rows; without a v1 row the v2 "nothing" with them
    recordCloudVerdict(store.defaultStore, KEY, ID_LR, verdict(H_LR, 'failed'));
    const c4 = await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${c4.version} ${c4.available} ${c4.rejected?.length} ${c4.meta?.recordCount}`, '1 true 2 42', '[verdict] all rejected → v1 row + rejected');
    const c5 = await cloudCacheCheck(fakeCloud({ list, v1: null }).cloud, store.defaultStore, await makeRegistry());
    assertEqual(`${c5.version} ${c5.available} ${c5.sources?.length} ${c5.rejected?.length} ${c5.improves}`, '2 false 0 2 no', '[verdict] all rejected, no v1 row');

    // malformed verdicts are never trusted
    store.defaultStore.putDoc(CLOUD_VERDICTS_COLLECTION, KEY, {
      verdicts: {
        [ID_EC]: verdict(H_EC, 'failed'), 'not-a-row-id': verdict(H_EC, 'failed'), [ID_LR]: { ...verdict(H_LR, 'failed'), verdict: 'maybe' },
        [ID_LF]: { ...verdict('XYZ', 'failed') }
      }
    });
    assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).keys()]), json([ID_EC]), '[verdict] malformed entries ignored');
    store.defaultStore.putDoc(CLOUD_VERDICTS_COLLECTION, KEY, { verdicts: [1, 2] });
    assertEqual(readCloudVerdicts(store.defaultStore, KEY).size, 0, '[verdict] a malformed doc reads as none');
    let threw = false;
    try { recordCloudVerdict(store.defaultStore, KEY, 'nope', verdict(H_EC, 'failed')); } catch { threw = true; }
    assert(threw, '[verdict] recording refuses a non-row id');

    // the newest CLOUD_VERDICTS_MAX are kept
    store.defaultStore.delDoc(CLOUD_VERDICTS_COLLECTION, KEY);
    const idOf = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    for (let n = 0; n < CLOUD_VERDICTS_MAX + 6; n++) {
      recordCloudVerdict(store.defaultStore, KEY, idOf(n), verdict(H_EC, 'passed', new Date(Date.parse(AT) + n * 1000).toISOString()));
    }
    const kept = readCloudVerdicts(store.defaultStore, KEY);
    assertEqual(`${kept.size} ${kept.has(idOf(0))} ${kept.has(idOf(CLOUD_VERDICTS_MAX + 5))}`, `${CLOUD_VERDICTS_MAX} false true`, '[verdict] newest kept');

    // a web page can read but never plant or delete verdicts through the generic store routes
    assert(isWriteProtectedCollection(CLOUD_VERDICTS_COLLECTION), '[verdict] the collection is write-protected');

    // an orphan reset (withdrawn, shared again: a new row id, identical facts) stays rejected by (kind, factHash)
    store.defaultStore.delDoc(CLOUD_VERDICTS_COLLECTION, KEY);
    const OLD_ID = '9f9f9f9f-0000-4000-8000-000000000001';
    recordCloudVerdict(store.defaultStore, KEY, OLD_ID.toUpperCase(), { ...verdict(H_EC, 'failed'), kind: 'editor-cache' });
    assertEqual(json([...readCloudVerdicts(store.defaultStore, KEY).keys()]), json([OLD_ID]), '[verdict] row ids stored lower-cased');
    const reset = await cloudCacheCheck(fakeCloud({ list, v1: null }).cloud, store.defaultStore, await makeRegistry());
    assertEqual(json(reset.rejected?.map((s) => `${s.id}:${s.verdict}`)), json([`${ID_EC}:failed`]), '[verdict] the re-created row (same facts, new id) stays rejected');
    // ... but never for another kind, and a newer passed verdict on the same facts wins
    const otherKind = new Map([[OLD_ID, { ...verdict(H_EC, 'failed'), kind: 'live-full' as const }]]);
    assertEqual(verdictFor({ id: ID_EC, kind: 'editor-cache', factHash: H_EC }, otherKind), null, '[verdict] (kind, factHash): another kind never matches');
    const newer = new Map([[OLD_ID, verdict(H_EC, 'failed', AT)], [ID_EC, verdict(H_EC, 'passed', '2026-11-24T09:00:00.000Z')]]);
    assertEqual(verdictFor({ id: ID_EC, kind: 'editor-cache', factHash: H_EC }, newer)?.verdict, 'passed', '[verdict] the newest verdict on the facts wins');
    // the offer the pull starts from carries the rows (fact hashes included) and the rejecting verdict
    const registry = await makeRegistry();
    const offer = await definitionSourcesOffer(fakeCloud({ list }).cloud, store.defaultStore, registry, { model: FM3, firmware: FW, key: KEY });
    assertEqual(json(offer?.offered.map((o) => `${o.row.id}:${o.row.factHash === H_LR}`)), json([`${ID_LR}:true`]), '[offer] offered rows with their listing rows');
    assertEqual(json(offer?.rejected.map((r) => `${r.row.id}:${r.verdict.verdict}:${r.summary.verdict}`)), json([`${ID_EC}:failed:failed`]), '[offer] rejected rows with the verdict');
    assertEqual(`${normalizeRowId(ID_EC.toUpperCase())} ${normalizeRowId('nope')} ${normalizeRowId(` ${ID_EC}`)}`, `${ID_EC} null null`, '[offer] normalizeRowId');

    // a v2 answer clears the v1 row an earlier check cached: a following (v1) pull fetches again instead of reusing it
    clearDocs();
    const o: FakeOpts = { list: null, v1: v1Row() };
    const swap = fakeCloud(o);
    const reg2 = await makeRegistry();
    await cloudCacheCheck(swap.cloud, store.defaultStore, reg2);
    assertEqual(swap.calls.v1, 1, '[v1 cache] the v1 check fetched the row');
    o.list = listing(row('editor-cache'));
    const v2now = await cloudCacheCheck(swap.cloud, store.defaultStore, reg2, { refresh: true });
    assertEqual(v2now.version, 2, '[v1 cache] v2 answers now');
    await cloudCachePull(swap.cloud, store.defaultStore, reg2);
    assertEqual(swap.calls.v1, 2, '[v1 cache] the pull did not reuse the v1 row cached before the v2 answer');
  } finally { clearDocs(); }
}

// ── 4. improves ──
async function improvesMatrix(): Promise<void> {
  clearDocs();
  try {
    const judge = async (label: string, doc: unknown, rows: DefinitionSourceSummary[], expected: string) => {
      clearDocs();
      if (doc !== null) putDoc(doc);
      const c = await cloudCacheCheck(fakeCloud({ list: listing(...rows) }).cloud, store.defaultStore, await makeRegistry());
      assertEqual(c.improves, expected, `[improves] ${label}`);
      return c;
    };
    const ec = await localEditor();
    const lr = await localLive();
    const docEc = profileDoc([ec], { firmware: FW });
    const docLr = profileDoc([lr], { firmware: FW });
    await judge('nothing stored + cloud editor cache → yes', null, [row('editor-cache')], 'yes');
    await judge('local editor cache + cloud editor cache and live → no', docEc, [row('editor-cache'), row('live-readonly'), row('live-full')], 'no');
    await judge('local live only + cloud editor cache → yes', docLr, [row('editor-cache')], 'yes');
    // a better-ranked local LIVE source covers a live offer only where it has the blocks (the merge takes a family's
    // existence from the best-ranked source that HAS it): the local seed read carries 5 blocks
    const blocks = (n: number | undefined, kind: Kind = 'live-readonly') => ({ ...row(kind).summary, blocks: n });
    await judge('local live-readonly (5 blocks) + cloud live-readonly with ≤ 5 blocks → no', docLr, [row('live-readonly', { summary: blocks(5) })], 'no');
    await judge('truncated local live-readonly + cloud live-readonly q3 with more blocks → yes', docLr, [row('live-readonly', { quality: 3, summary: blocks(60) })], 'yes');
    const truncated = liveSource(liveSeedRecords().filter((r) => r.section === 58), { firmware: FW, stats: { unresolvedReplies: 3 } });
    // (raw only: one block does not derive on its own — a stale doc keeps its sources and a pull merges into it)
    const rawOnly = (sources: RawSource[]) => ({ meta: { format: 2, schema: CACHE_SCHEMA, source: 'live' }, raw: { format: 1, sources } });
    await judge('scoped local read (1 block) + cloud live-readonly with 2 blocks → yes', rawOnly([truncated]), [row('live-readonly', { summary: blocks(2) })], 'yes');
    await judge('scoped local read (1 block) + cloud live-readonly with 1 block → no', rawOnly([truncated]), [row('live-readonly', { summary: blocks(1) })], 'no');
    const docLf = profileDoc([await localLive('live-full')], { firmware: FW });
    await judge('local live-full + cloud live-readonly subset (4 blocks) → no', docLf, [row('live-readonly', { summary: blocks(4) })], 'no');
    await judge('local live-full + cloud live-readonly with more blocks → yes', docLf, [row('live-readonly', { summary: blocks(61) })], 'yes');
    await judge('local live-full + cloud live-full of other facts, same blocks → no', docLf, [row('live-full', { summary: blocks(5, 'live-full') })], 'no');
    await judge('local live-readonly + a live offer without a block count → unknown', docLr, [row('live-readonly', { summary: { records: 3000 } })], 'unknown');
    await judge('local live-readonly + cloud live-full → yes (a better kind)', docLr, [row('live-full')], 'yes');
    await judge('local live-readonly + cloud live-readonly and editor cache → yes', docLr, [row('live-readonly', { summary: blocks(5) }), row('editor-cache')], 'yes');
    // a stored CLOUD editor cache covers every live offer (an editor cache has every family), not a newer editor cache
    const docCloudEc = profileDoc([await localEditor('cloud')], { firmware: FW });
    await judge('stored cloud editor cache + cloud live offers → no', docCloudEc, [row('live-readonly'), row('live-full')], 'no');
    await judge('stored cloud editor cache + another cloud editor cache → yes', docCloudEc, [row('editor-cache')], 'yes');

    // a stored CLOUD source of the same kind: covered only when identical
    const cloudLr = await localLive('live-readonly', 'cloud');
    const docCloudLr = profileDoc([cloudLr], { firmware: FW });
    const same = await judge('stored cloud live-readonly, identical offer → no', docCloudLr, [row('live-readonly', { factHash: await factHash(cloudLr) })], 'no');
    assertEqual(same.sources?.[0]?.identical, true, '[improves] the identical offer is flagged');
    await judge('stored cloud live-readonly, other facts → yes', docCloudLr, [row('live-readonly')], 'yes');

    // a legacy format-1 local editor-cache profile outranks every cloud source (the pull would answer local-profile-better)
    const legacy = { ranges: { DISTORT: {} }, rangeSections: {}, rosters: {}, enumOverrides: {}, cabIrs: {}, meta: { schema: CACHE_SCHEMA, recordCount: 5, source: 'editor-cache' } };
    await judge('legacy format-1 local editor cache → no', legacy, [row('editor-cache'), row('live-full')], 'no');
    // ... a legacy live profile does not outrank a cloud editor cache
    await judge('legacy format-1 live walk + cloud editor cache → yes', { ...legacy, meta: { ...legacy.meta, source: 'live' } }, [row('editor-cache')], 'yes');
    // a document a newer build wrote is never rewritten (newer-profile)
    const newer = clone(docLr) as unknown as { raw: { format: number } };
    newer.raw.format = RAW_FORMAT + 1;
    await judge('a newer build\'s doc → no', newer, [row('editor-cache')], 'no');
    // a stored cloud source whose facts cannot be hashed (conflicting duplicates): undecidable
    const broken = clone(cloudLr);
    const dup = { ...(broken.records[0] as CacheRecord), max: (broken.records[0] as CacheRecord).max + 1 };
    broken.records.push(dup as LiveRawSource['records'][number]);
    await judge('stored cloud source without a computable hash → unknown', { meta: { format: 2, schema: CACHE_SCHEMA, source: 'cloud' }, raw: { format: 1, sources: [broken] } }, [row('live-readonly')], 'unknown');
    // a stored source of another firmware never covers an offer (the merge drops it)
    const lr12 = liveSource(liveSeedRecords(), { firmware: '12.0' });
    await judge('a stored source of another firmware does not cover', { meta: { format: 2, schema: CACHE_SCHEMA, source: 'live' }, raw: { format: 1, sources: [lr12] } }, [row('live-readonly')], 'yes');
  } finally { clearDocs(); }
}

// ── 5. identical by the codec fact hash ──
async function identicalFactHash(): Promise<void> {
  clearDocs();
  try {
    const ec = await localEditor();
    const lr = await localLive();
    const hEc = await factHash(ec);
    const hLr = await factHash(lr);
    // the shared copy hashes the same as the stored source (id, origin, content hash, capture time excluded)
    const sEc = shareableSource(ec);
    const sLr = shareableSource(lr);
    assert(!('refused' in sEc) && !('refused' in sLr), 'fixture: shareable');
    assertEqual(await factHash(sEc as ShareableSource), hEc, '[identical] editor cache: shared copy hash = stored source hash');
    assertEqual(await factHash(sLr as ShareableSource), hLr, '[identical] live: shared copy hash = stored source hash');
    putDoc(profileDoc([ec, lr], { firmware: FW }));
    const f = fakeCloud({ list: listing(row('editor-cache', { factHash: hEc }), row('live-readonly', { factHash: hLr }), row('live-full')) });
    const c = await cloudCacheCheck(f.cloud, store.defaultStore, await makeRegistry());
    assertEqual(json(c.sources?.map((s) => `${s.kind}:${s.identical}`)), json(['editor-cache:true', 'live-readonly:true', 'live-full:false']), '[identical] per row by fact hash');
    assertEqual(c.improves, 'no', '[identical] nothing to gain');
    // identical needs the same kind too
    const g = await cloudCacheCheck(fakeCloud({ list: listing(row('live-full', { factHash: hLr })) }).cloud, store.defaultStore, await makeRegistry());
    assertEqual(g.sources?.[0]?.identical, false, '[identical] same facts of another kind are not identical');
  } finally { clearDocs(); }
}

// ── 6. app ↔ router twin parity (Browser Direct), the disabled answer, the verdict store over HTTP ──
interface Answer { status: number; text: string }
async function routerParity(): Promise<void> {
  clearDocs();
  const viaApp = async (app: Awaited<ReturnType<typeof buildApp>>, method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Answer> => {
    const res = await app.inject({ method, url, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, payload: json(body) } : {}) });
    return { status: res.statusCode, text: res.payload };
  };
  const viaRouter = async (router: ReturnType<typeof createRouter>, method: string, url: string, body?: unknown): Promise<Answer> => {
    const res = await router.handle(method, url, body === undefined ? undefined : json(body));
    return { status: res.status, text: res.body as string };
  };
  const twins = async (label: string, cloudOf: (f: ReturnType<typeof fakeCloud>) => CloudProfilesCloud | null, o: FakeOpts, urls: string[], expect: (a: Answer) => void) => {
    const registry = await makeRegistry();
    const f = fakeCloud(o);
    const c = cloudOf(f);
    const app = await buildApp(registry, { cloudProfiles: { cloud: c } });
    const router = createRouter({ registry, store: store.defaultStore, ...(c ? { cloud: c as never } : {}) });
    try {
      for (const url of urls) {
        const a = await viaApp(app, 'GET', url);
        const b = await viaRouter(router, 'GET', url);
        assertEqual(b.status, a.status, `[twins] ${label} ${url}: status`);
        assertEqual(b.text, a.text, `[twins] ${label} ${url}: body`);
        expect(a);
      }
    } finally { await app.close(); }
    return f;
  };
  try {
    putDoc(profileDoc([await localLive()], { firmware: FW }));
    recordCloudVerdict(store.defaultStore, KEY, ID_LF, verdict(H_LF, 'failed'));
    const v2 = await twins('v2', (f) => f.cloud, { list: listing(row('editor-cache'), row('live-full')), v1: v1Row() },
      ['/device/cache/cloud', '/device/cache/cloud?refresh=1', '/device/cache/cloud?refresh=true'], (a) => {
        const b = JSON.parse(a.text) as CloudCacheCheck;
        assertEqual(`${a.status} ${b.version} ${b.sources?.length} ${b.rejected?.length} ${b.improves}`, '200 2 1 1 yes', '[twins] v2 answer');
      });
    // first GET via app fetched, router reused it; each refresh fetched once per twin
    assertEqual(v2.calls.list.length, 5, '[twins] refresh=1|true bypasses the cache on both twins');
    await twins('v1 fallback', (f) => f.cloud, { list: null, v1: v1Row() }, ['/device/cache/cloud'], (a) => {
      const b = JSON.parse(a.text) as CloudCacheCheck;
      assertEqual(`${a.status} ${b.version} ${b.available}`, '200 1 true', '[twins] v1 answer');
    });
    await twins('disabled', () => null, {}, ['/device/cache/cloud', '/device/cache/cloud?refresh=1'], (a) => {
      assertEqual(`${a.status} ${a.text}`, `200 ${json({ enabled: false, available: false })}`, '[twins] no cloud → the disabled answer');
    });
    // production (AXIS_CLOUD off, no seam): the unchanged stub
    const plain = await buildApp(await makeRegistry());
    try {
      const a = await viaApp(plain, 'GET', '/device/cache/cloud');
      assertEqual(`${a.status} ${a.text}`, `200 ${json({ enabled: false, available: false })}`, '[twins] AXIS_CLOUD off: the M3 stub shape');
      // verdicts are readable but never writable through /store
      const rev = store.defaultStore.getDoc(CLOUD_VERDICTS_COLLECTION, KEY)!.rev;
      const router = createRouter({ registry: await makeRegistry(), store: store.defaultStore });
      for (const [m, url, body] of [['PUT', `/store/${CLOUD_VERDICTS_COLLECTION}/${KEY}`, { verdicts: {} }], ['DELETE', `/store/${CLOUD_VERDICTS_COLLECTION}/${KEY}`, undefined]] as const) {
        const x = await viaApp(plain, m, url, body);
        const y = await viaRouter(router, m, url, body);
        assertEqual(`${x.status} ${y.status}`, '403 403', `[twins] ${m} ${url} refused on both twins`);
      }
      assertEqual(store.defaultStore.getDoc(CLOUD_VERDICTS_COLLECTION, KEY)!.rev, rev, '[twins] the verdicts are untouched');
    } finally { await plain.close(); }
  } finally { clearDocs(); }
}

// ── 7. Remote: the check GET relays; pull, publish and verdict writes do not ──
async function remoteRelay(): Promise<void> {
  for (const p of ['/device/cache/cloud', '/device/cache/cloud?refresh=1']) assert(remoteAllowed('GET', p), `[remote] GET ${p} allowed`);
  for (const p of ['/device/cache/cloud/pull', '/device/cache/cloud/publish']) assert(!remoteAllowed('POST', p), `[remote] POST ${p} refused`);
  assert(!remoteAllowed('PUT', `/store/${CLOUD_VERDICTS_COLLECTION}/${KEY}`), '[remote] verdicts never written remotely');
  clearDocs();
  const registry = await makeRegistry();
  const f = fakeCloud({ list: listing(row('editor-cache')) });
  const app = await buildApp(registry, { cloudProfiles: { cloud: f.cloud } });
  const log = console.log;
  console.log = () => {}; // the host logs every relayed request
  try {
    const { session, relay } = fakeChannelSession();
    const host = new RemoteHost(app, async () => session, (fn) => registry.subscribe(fn));
    await host.enable(true);
    try {
      const got = await relay('c1', 'GET', '/device/cache/cloud');
      const body = got.encoding === 'gzip' ? gunzipSync(Buffer.from(got.body, 'base64')).toString('utf8') : got.body;
      const b = JSON.parse(body) as CloudCacheCheck;
      assertEqual(`${got.status} ${b.version} ${b.sources?.[0]?.kind}`, '200 2 editor-cache', '[remote] the check relays with the v2 answer');
      const pull = await relay('c2', 'POST', '/device/cache/cloud/pull', {});
      assertEqual(pull.status, 403, '[remote] the pull is refused');
    } finally { await host.enable(false); }
  } finally { console.log = log; await app.close(); clearDocs(); }
}

// ── 8. the shared validation mode ──
async function sharedMode(): Promise<void> {
  const ec = await localEditor();
  const lf = liveSource(liveSeedRecords({ unit: 'ms' }), { kind: 'live-full', firmware: FW });
  (lf.walk as { abortReason?: string }).abortReason = 'a reply was lost';
  (lf.walk as { extension?: string }).extension = 'aborted';
  const sEc = shareableSource(ec) as ShareableSource;
  const sLf = shareableSource(lf) as ShareableSource;
  assert(!('refused' in sEc) && !('refused' in sLf), 'fixture: shareable');
  // the codec's share output passes and comes back unchanged
  for (const [label, s] of [['editor cache', sEc], ['live', sLf]] as const) {
    const r = checkSharedSource(clone(s));
    assert(r.ok, `[shared] ${label}: the codec's share output passes (${r.ok ? '' : `${r.path}: ${r.message}`})`);
    assertEqual(json(r.source), json(s), `[shared] ${label}: comes back unchanged`);
  }
  const list = checkSharedSources(clone([sEc, sLf]));
  assert(list.ok && list.sources.length === 2, '[shared] a list of shared sources passes');
  // a shared source is not a stored one (no id / origin), a stored one is not a shared one
  const local = checkRawSources(clone([sEc]));
  assert(!local.ok && local.path === 'sources[0].id', '[shared] local mode refuses a shared source (no id)');
  const asShared = checkSharedSource(clone(ec));
  assert(!asShared.ok && asShared.path === 'source.id' && asShared.message === 'not part of a shared source', '[shared] a stored source is refused (its id)');
  // unknown keys are dropped
  const extra = checkSharedSource({ ...clone(sEc), note: 'x', records: (clone(sEc) as { records: object[] }).records.map((r, i) => (i === 0 ? { ...r, extra: 1 } : r)) });
  assert(extra.ok && !('note' in extra.source) && !('extra' in (extra.source.records[0] as object)), '[shared] unknown keys dropped');

  const refuse = (label: string, mutate: (s: Record<string, unknown>) => void, base: ShareableSource, path: string) => {
    const s = clone(base) as unknown as Record<string, unknown>;
    mutate(s);
    const r = checkSharedSource(s);
    assert(!r.ok, `[shared] ${label}: refused`);
    assertEqual(r.ok ? '' : r.path, path, `[shared] ${label}: path`);
  };
  refuse('id present', (s) => { s.id = 'editor-cache@x#0'; }, sEc, 'source.id');
  refuse('origin present', (s) => { s.origin = 'cloud'; }, sEc, 'source.origin');
  refuse('origin present even when null', (s) => { s.origin = null; }, sEc, 'source.origin');
  refuse('a content hash', (s) => { s.contentSha256 = 'a'.repeat(64); }, sEc, 'source.contentSha256');
  refuse('no content hash key', (s) => { delete s.contentSha256; }, sEc, 'source.contentSha256');
  refuse('issues (a tolerant parse)', (s) => { s.issues = []; }, sEc, 'source.issues');
  refuse('a capture time of day', (s) => { s.capturedAt = '2026-11-22T10:30:00.000Z'; }, sEc, 'source.capturedAt');
  refuse('an impossible day', (s) => { s.capturedAt = '2026-02-30T00:00:00.000Z'; }, sEc, 'source.capturedAt');
  refuse('a date-only stamp', (s) => { s.capturedAt = '2026-11-22'; }, sEc, 'source.capturedAt');
  refuse('a live-probe', (s) => { s.kind = 'live-probe'; }, sLf, 'source.kind');
  refuse('walk.abortReason', (s) => { (s.walk as Record<string, unknown>).abortReason = 'free text'; }, sLf, 'source.walk.abortReason');
  refuse('a user name table record', (s) => {
    const recs = s.records as Array<Record<string, unknown>>;
    const sections = s.sections as Array<{ tag: number }>;
    recs.push({ ...recs[0]!, id: 0xffff, section: sections[0]!.tag });
  }, sEc, `source.records[${(sEc as { records: unknown[] }).records.length}].id`);
  refuse('a non-canonical firmware', (s) => { s.firmware = '13.00'; }, sEc, 'source.firmware');
  // the closed patterns of the codec sanitizer / the cloud validator
  refuse('a non-canonical file version', (s) => { s.fileVersion = '13.00'; }, sEc, 'source.fileVersion');
  refuse('a free-text file version', (s) => { s.fileVersion = 'v13'; }, sEc, 'source.fileVersion');
  refuse('a codec version that is no version stamp', (s) => { s.codecVersion = 'built by hand'; }, sEc, 'source.codecVersion');
  refuse('a unit that is no unit token', (s) => { (s.records as Array<Record<string, unknown>>)[0]!.unit = 'dB\n'; }, sLf, 'source.records[0].unit');
  refuse('a unit with free text', (s) => { (s.records as Array<Record<string, unknown>>)[0]!.unit = 'my preset'; }, sLf, 'source.records[0].unit');
  const ecRecords = (sEc as { records: unknown[] }).records;
  // a labelled enum row (a synthetic list in a declared section; the seed has none)
  const labelled = clone(sEc) as unknown as { sections: Array<{ tag: number; count: number }>; records: object[] };
  labelled.records.push({ kind: 'enum', section: labelled.sections[0]!.tag, id: 4000, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['Clean', 'Lead é'], x: 0 });
  labelled.sections[0]!.count += 1;
  const sLabelled = labelled as unknown as ShareableSource;
  assert(checkSharedSource(clone(sLabelled)).ok, 'fixture: the labelled source passes');
  const enumAt = labelled.records.length - 1;
  refuse('a label with a control character', (s) => { ((s.records as Array<{ values: string[] }>)[enumAt]!.values)[0] = 'Clean\u0007'; }, sLabelled, `source.records[${enumAt}].values[0]`);
  refuse('a label of more than 255 UTF-8 bytes', (s) => { ((s.records as Array<{ values: string[] }>)[enumAt]!.values)[0] = 'é'.repeat(128); }, sLabelled, `source.records[${enumAt}].values[0]`);
  refuse('a label with a lone surrogate', (s) => { ((s.records as Array<{ values: string[] }>)[enumAt]!.values)[0] = 'A\ud800'; }, sLabelled, `source.records[${enumAt}].values[0]`);
  const n = ecRecords.length;
  refuse('a (section, id) repeated with different content', (s) => {
    const recs = s.records as Array<Record<string, unknown>>;
    recs.push({ ...recs[0]!, max: (recs[0]!.max as number) + 1 });
  }, sEc, `source.records[${n}]`);
  refuse('a live (section, id) repeated with another range', (s) => {
    const recs = s.records as Array<Record<string, unknown>>;
    recs.push({ ...recs[0]!, min: (recs[0]!.min as number) - 1 });
  }, sLf, `source.records[${(sLf as LiveRawSource).records.length}]`);
  refuse('a block listed twice', (s) => { const sc = s.scope as { blocks: number[] }; sc.blocks.push(sc.blocks[0]!); }, sLf, 'source.scope.blocks');
  // identical repeats are one position; a live repeat that differs only in its unit is identical to the fact hash
  const rep1 = clone(sEc) as unknown as { records: object[] };
  rep1.records.push(clone(rep1.records[0]!));
  assert(checkSharedSource(rep1).ok, '[shared] an identical repeat passes');
  const rep2 = clone(sLf) as unknown as { records: Array<Record<string, unknown>> };
  rep2.records.push({ ...rep2.records[0]!, unit: 'Hz' });
  assert(checkSharedSource(rep2).ok, '[shared] a live repeat differing only in its unit passes (kind-free projection)');
  // the local mode is unchanged: a stored source with a time of day, a free-text file version, a control-character label
  const loose = clone(ec) as unknown as { capturedAt: string; fileVersion: string; codecVersion: string; sections: Array<{ tag: number }>; records: object[] };
  loose.fileVersion = 'v13';
  loose.codecVersion = 'built by hand';
  loose.records.push({ kind: 'enum', section: loose.sections[0]!.tag, id: 4000, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 1, values: ['Clean\u0007'], x: 0 });
  assert(checkRawSources([loose]).ok, '[shared] local mode keeps its own rules');
  // stage 1 still runs: prototype keys and non-finite numbers
  const proto = JSON.parse(`{"kind":"editor-cache","__proto__":{"x":1}}`) as unknown;
  assert(!checkSharedSource(proto).ok, '[shared] a prototype key is refused');
  const inf = clone(sEc) as unknown as { records: Array<{ max: number }> };
  inf.records[0]!.max = Infinity;
  const r = checkSharedSource(inf);
  assert(!r.ok && r.message === 'not a finite number', '[shared] a non-finite number is refused');
  // null capture time is fine; the day helper
  const nullAt = clone(sEc) as unknown as Record<string, unknown>;
  nullAt.capturedAt = null;
  assert(checkSharedSource(nullAt).ok, '[shared] capturedAt null passes');
  assert(isDayStamp('2026-11-22T00:00:00.000Z') && !isDayStamp('2026-11-22T00:00:00Z') && !isDayStamp('2026-13-01T00:00:00.000Z'), '[shared] isDayStamp');
}

// ── 9. the Cloud client's v2 methods over a faked Supabase ──
const SUPA = 'http://127.0.0.1:54321';
const jwt = (payload: Record<string, unknown>) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload, 'sig'].map((p) => (typeof p === 'string' ? p : Buffer.from(JSON.stringify(p)).toString('base64url'))).join('.');
const sessionJson = (token: string, anonymous: boolean, userId: string) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `r-${userId}`,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', is_anonymous: anonymous, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  };
};

async function cloudClient(): Promise<void> {
  const memStore = (): Store => createStore(createMemStoreBackend(), nodeCodec);
  // the parsers on their own
  const asked = { model: FM3, firmware: FW, rawFormat: 1 };
  const good = row('editor-cache');
  const parsed = parseDefinitionSourceList({ ...listing(good, row('live-readonly')), extra: 1 }, asked);
  assertEqual(json(parsed), json(listing(good, row('live-readonly'))), '[parse] a well-formed listing round-trips');
  assertEqual(parseDefinitionSourceList({ ...listing(good), model: 0x12 }, asked), null, '[parse] another model → null');
  assertEqual(parseDefinitionSourceList({ ...listing(good), firmware: '12.0' }, asked), null, '[parse] another firmware → null');
  assertEqual(parseDefinitionSourceList({ model: FM3, firmware: FW }, asked), null, '[parse] no sources array → null');
  assertEqual(parseDefinitionSourceList(v1Row(), asked), null, '[parse] a v1 answer is not a listing');
  const bad = [
    { ...good, tier: 'rejected' }, { ...good, kind: 'live-probe' }, { ...good, factHash: 'X'.repeat(64) }, { ...good, id: 'abc' },
    { ...good, rawFormat: 2 }, { ...good, quality: 4 }, { ...good, contributors: -1 }, { ...good, spotChecks: null }, { ...good, firstSeen: 'yesterday' }
  ];
  const dropped = parseDefinitionSourceList({ model: FM3, firmware: FW, sources: [...bad, good, { ...good, id: ID_LF }], alternatives: { 'editor-cache': 'x' } }, asked);
  assertEqual(json(dropped?.sources.map((s) => s.id)), json([ID_EC]), '[parse] malformed rows dropped, first row per kind kept');
  assertEqual(dropped?.alternatives['editor-cache'], 0, '[parse] a malformed alternatives count reads 0');
  const hostile = parseDefinitionSourceList({ ...listing({ ...good, summary: { records: 5, label: 'x'.repeat(40), nested: { a: 1 }, walk: { queries: 3, deep: { a: 1 } } } as never }) }, asked);
  assertEqual(json(hostile?.sources[0]?.summary), json({ records: 5, walk: { queries: 3 } }), '[parse] a summary keeps short scalars only');
  const body = { id: ID_EC, model: FM3, firmware: FW, kind: 'editor-cache', rawFormat: 1, factHash: H_EC, tier: 'verified', quality: 3, summary: { records: 1 }, source: { kind: 'editor-cache' } };
  assertEqual(parseDefinitionSourceBody(body, ID_EC)?.tier, 'verified', '[parse] a source body');
  assertEqual(parseDefinitionSourceBody(body, ID_LR), null, '[parse] another id → null');
  assertEqual(parseDefinitionSourceBody({ ...body, firmware: '13.00' }, ID_EC), null, '[parse] a non-canonical firmware → null');
  assertEqual(parseDefinitionSourceBody({ ...body, source: [] }, ID_EC), null, '[parse] no source object → null');

  // off: no request, nothing pretends to work
  const off = createCloud({ url: '', anonKey: '' }, memStore());
  assertEqual(await off.definitionSourcesList(FM3, FW, 1), null, '[client] off: list null');
  assertEqual(await off.definitionSourceGet(ID_EC), null, '[client] off: get null');
  assertEqual((await off.definitionSourceReport({ sourceId: ID_EC, verdict: 'passed', checked: 24, answered: 24, mismatches: 0 })).disabled, true, '[client] off: report disabled');

  const anonToken = jwt({ sub: 'anon-user', role: 'authenticated', is_anonymous: true, exp: Math.floor(Date.now() / 1000) + 3600 });
  const edToken = jwt({ sub: 'ed-user', role: 'authenticated', is_anonymous: true, exp: Math.floor(Date.now() / 1000) + 3600 });
  const reqs: Array<{ method: string; url: string; auth: string | null; body: unknown; cache: string | null }> = [];
  let listAnswer: { status: number; body: unknown } = { status: 200, body: listing(good) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const raw = init.body;
    reqs.push({ method, url, auth: new Headers(init.headers).get('authorization'), body: typeof raw === 'string' ? JSON.parse(raw) : null, cache: (init as { cache?: string }).cache ?? null });
    const reply = (status: number, b: unknown) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!url.startsWith(SUPA)) throw new Error(`unexpected host ${url}`);
    const u = new URL(url);
    if (method === 'POST' && u.pathname === '/auth/v1/signup') return reply(200, sessionJson(anonToken, true, 'anon-user'));
    if (method === 'GET' && u.pathname === '/functions/v1/definition-sources') return reply(listAnswer.status, listAnswer.body);
    if (method === 'GET' && u.pathname === `/functions/v1/definition-sources/source/${ID_EC}`) return reply(200, body);
    if (method === 'POST' && u.pathname === '/functions/v1/definition-sources') return reply(201, { sourceId: ID_EC, factHash: H_EC, created: true, deduped: false, confirmed: false, tier: 'candidate', contributors: 1, networks: 1 });
    if (method === 'POST' && u.pathname === '/functions/v1/definition-sources/withdraw') return reply(200, { withdrawn: 1, deletedSources: 1 });
    if (method === 'GET' && u.pathname === '/functions/v1/definition-sources/mine') return reply(200, { contributions: [] });
    if (method === 'POST' && u.pathname === '/functions/v1/definition-sources/report') return reply(200, { ok: true, quarantined: false });
    if (method === 'POST' && u.pathname === '/functions/v1/editor-caches/delete') return reply(200, { uploadId: ID_LF, deleted: true });
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  try {
    const st = memStore();
    const cl = createCloud({ url: SUPA, anonKey: 'anon-key' }, st);
    // the public reads: anonymous, the documented URLs
    const l = await cl.definitionSourcesList(FM3, FW, 1);
    assertEqual(l?.sources[0]?.id, ID_EC, '[client] list parsed');
    assertEqual(reqs.at(-1)!.url, `${SUPA}/functions/v1/definition-sources?model=17&firmware=13.0&rawFormat=1`, '[client] list URL');
    assertEqual(reqs.at(-1)!.auth, null, '[client] the list carries no session');
    assertEqual(reqs.at(-1)!.cache, 'no-cache', '[client] the list revalidates (a browser never answers a refresh from its HTTP cache)');
    listAnswer = { status: 404, body: { error: 'not found' } };
    assertEqual(await cl.definitionSourcesList(FM3, FW, 1), null, '[client] function missing (404) → null');
    listAnswer = { status: 503, body: { error: 'paused' } };
    assertEqual(await cl.definitionSourcesList(FM3, FW, 1), null, '[client] paused (503) → null');
    listAnswer = { status: 200, body: '<html>gateway</html>' };
    assertEqual(await cl.definitionSourcesList(FM3, FW, 1), null, '[client] not JSON → null');
    const g = await cl.definitionSourceGet(ID_EC);
    assertEqual(`${g?.id} ${reqs.at(-1)!.url} ${reqs.at(-1)!.auth}`, `${ID_EC} ${SUPA}/functions/v1/definition-sources/source/${ID_EC} null`, '[client] get by id, anonymous');
    await cl.definitionSourceGet(ID_EC.toUpperCase());
    assertEqual(reqs.at(-1)!.url, `${SUPA}/functions/v1/definition-sources/source/${ID_EC}`, '[client] an upper-case id is requested lower-cased');
    reqs.length = 0;
    assertEqual(await cl.definitionSourceGet('../mine'), null, '[client] a non-row id is never requested');
    assertEqual(await cl.definitionSourceGet(ID_LR), null, '[client] 404 → null');
    assertEqual(reqs.length, 1, '[client] only the row id was requested');

    // a report never creates a session; withdraw and mine neither - and none of them uses the EDITOR-CACHE anonymous
    // session: shared definitions have an anonymous identity of their own (maintainer D2)
    st.putDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY, JSON.stringify(sessionJson(edToken, true, 'ed-user')));
    const edSlot = JSON.stringify(st.getDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY)!.data);
    assertEqual((DEFINITION_SHARER_STORAGE_KEY as string) !== ANONYMOUS_UPLOADER_STORAGE_KEY, true, '[client] two distinct slots');
    reqs.length = 0;
    const rep = await cl.definitionSourceReport({ sourceId: ID_EC, verdict: 'failed', checked: 24, answered: 24, mismatches: 1 });
    assertEqual(`${rep.code} ${(rep.body as { reason?: string }).reason}`, '401 anonymous-session-missing', '[client] report without a session → 401');
    const wd = await cl.definitionSourceWithdraw({ all: true }, 'anonymous');
    const mine = await cl.definitionSourcesMine();
    assertEqual(`${wd.code} ${mine.code}`, '401 401', '[client] withdraw / mine without a session → 401');
    assertEqual(reqs.length, 0, '[client] nothing was sent (no anonymous sign-in)');

    // a share signs in anonymously while signed out, then posts the envelope verbatim
    const shared = shareableSource(await localEditor()) as ShareableSource;
    const env: DefinitionSourceContribution = {
      model: FM3, firmware: FW, kind: 'editor-cache', rawFormat: 1, source: shared, app: { forgefx: 't', codec: 't' }, consentAt: new Date().toISOString(), consentVersion: 1
    };
    const out = await cl.definitionSourceContribute(env);
    assertEqual(`${out.code} ${out.via} ${out.uploaderId}`, '201 anonymous anon-user', '[client] signed out: shared anonymously');
    assertEqual(reqs.map((r) => `${r.method} ${new URL(r.url).pathname}`).join(' | '), 'POST /auth/v1/signup | POST /functions/v1/definition-sources', '[client] sign-in → share');
    assertEqual(reqs.at(-1)!.auth, `Bearer ${anonToken}`, '[client] the share runs under the anonymous session');
    assertEqual(json(reqs.at(-1)!.body), json(env), '[client] the envelope verbatim');
    assert(st.getDoc('cloud', DEFINITION_SHARER_STORAGE_KEY) !== null, '[client] the share session lives in the sharer slot');
    assertEqual(JSON.stringify(st.getDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY)!.data), edSlot, '[client] the editor-cache slot is untouched');
    assertEqual(`${cl.definitionSharer('anonymous')} ${cl.editorCacheUploader('anonymous')}`, 'anon-user ed-user', '[client] two anonymous identities');
    // now a session exists: report, withdraw and mine use it, no second sign-in
    reqs.length = 0;
    const rep2 = await cl.definitionSourceReport({ sourceId: ID_EC, verdict: 'passed', checked: 24, answered: 23, mismatches: 0 });
    const wd2 = await cl.definitionSourceWithdraw({ sourceId: ID_EC }, 'anonymous');
    const mine2 = await cl.definitionSourcesMine('anonymous');
    assertEqual(`${rep2.code} ${wd2.code} ${mine2.code}`, '200 200 200', '[client] report / withdraw / mine under the existing session');
    assertEqual(reqs.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.auth === `Bearer ${anonToken}`}`).join(' | '),
      'POST /functions/v1/definition-sources/report true | POST /functions/v1/definition-sources/withdraw true | GET /functions/v1/definition-sources/mine true',
      '[client] the three calls, each with the session token');
    assertEqual(json(reqs[1]!.body), json({ sourceId: ID_EC }), '[client] withdraw body');
    assert(!reqs.some((r) => r.url.includes('/auth/v1/signup')), '[client] no second sign-in');
    assert(!reqs.some((r) => r.auth === `Bearer ${edToken}`), '[client] the editor-cache session never ran a definitions call');
    // ... and the editor-cache delete still runs under its own anonymous session, never the sharer's
    reqs.length = 0;
    const del = await cl.editorCacheDelete(ID_LF, 'anonymous');
    assertEqual(`${del.code} ${reqs.at(-1)!.auth === `Bearer ${edToken}`}`, '200 true', '[client] the editor-cache delete runs under the editor-cache session');
    // a sharer session alone never serves an editor-cache call
    const st2 = memStore();
    st2.putDoc('cloud', DEFINITION_SHARER_STORAGE_KEY, JSON.stringify(sessionJson(anonToken, true, 'anon-user')));
    reqs.length = 0;
    const del2 = await createCloud({ url: SUPA, anonKey: 'anon-key' }, st2).editorCacheDelete(ID_LF, 'anonymous');
    assertEqual(`${del2.code} ${(del2.body as { reason?: string }).reason} ${reqs.length}`, '401 anonymous-session-missing 0', '[client] the sharer session never deletes an editor-cache upload');
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['v2 list → summaries, identity, 10-min cache', listToSummaries],
  ['v1 fallback (404 / throw / nothing offered / unsupported units), v1 pull unchanged', v1Fallback],
  ['verdicts: failed → rejected, facts-bound, malformed ignored, newest kept, write-protected', verdicts],
  ['improves matrix', improvesMatrix],
  ['identical by the codec fact hash', identicalFactHash],
  ['app ↔ router twin parity (Browser Direct), disabled answer, verdict store over HTTP', routerParity],
  ['Remote: check GET relays, pull refused', remoteRelay],
  ['shared validation mode', sharedMode],
  ['Cloud client v2 over a faked Supabase', cloudClient]
];
export const CLOUD_V2_CHECK_CASE_COUNT = CASES.length;

export async function runCloudV2CheckTests(): Promise<void> {
  for (const [name, run] of CASES) {
    try {
      await run();
    } catch (e) {
      throw new Error(`[api/cloud-v2-check] ${name}: ${(e as Error).message}`);
    }
  }
}
