// Profile store v2 lifecycle (M3 WP-F1) — mocked FM3 (fw 12.0) + synthetic profile documents only, NO hardware,
// no real cache bytes. Covers: an editor-cache import writes a format-2 document without user name tables; a
// format-2 doc whose derived tables are older (a lower `meta.schema`, a missing or lower `meta.derivedRevision`)
// is re-derived from its raw sources on `GET /device/cache` and on apply WITHOUT any device traffic and written
// back exactly once; a doc a newer build wrote is re-derived in memory only; a failing re-derivation is `stale`
// `derivation-failed` (nothing deleted; a build merges into it); a legacy format-1 doc stays usable with the `no-raw`
// gap; publish uploads the derived tables only — derived from this install's LOCAL sources alone, without synthetic
// families (nothing local → not publishable); a format-2 cloud row of another schema is re-derivable (available); the
// summary memo is per model; a definitions-file profile counts as another install's in the contribution status; the
// runtime-router twin and Browser Direct's lookup behave the same.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import * as runtimeBarrel from '../../src/runtime/index.js';
import * as store from '../../src/store.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { cloudCacheCheck, cloudCachePublish, cloudCachePull, type DeviceProfileCloud } from '../../src/services/cloudProfiles.js';
import {
  classifyProfile, lastProfileVerdict, loadStoredProfile, loadUsableProfile, profileSummaryOf, upgradeStoredProfile
} from '../../src/profileSchema.js';
import {
  CACHE_SCHEMA, DERIVATION_REVISION, assertNoUserTables, isUserNameTable,
  type BuiltCache, type CacheRecord, type LiveWalkOptions, type ProfileDoc
} from 'forgefx-midi/cache';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { contributionCache, seedRecords as cacheSeedRecords, SYNTHETIC_PRESET_NAMES, SYNTHETIC_USER_CAB_NAMES } from '../helpers/cacheBytes.js';
import { FM3, STAMP, clone, editorCacheSource, familyRecords, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';
import { fakeCacheDoc } from './device-cache.test.js';

export const PROFILE_V2_CASE_COUNT = 12;

const KEY = '11_12p0'; // FM3 fw 12.0

async function makeApp() {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(FM3, 12, 0)];
    return [];
  };
  // no loadDeviceCache override: the real Node hook (loadUsableProfile over the default store)
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  await registry.detect();
  const app = await buildApp(registry);
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  // no telemetry frame may blur the "no device traffic" counts below
  const resume = registry.pauseTelemetry();
  return {
    app, registry, mock, events,
    close: async () => { resume(); unsub(); await app.close(); }
  };
}

const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);
const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const stored = () => store.defaultStore.getDoc('deviceCaches', KEY);
const storedData = () => { const d = stored(); return d && !d.deleted ? (d.data as ProfileDoc) : null; };
const status = async (app: Awaited<ReturnType<typeof makeApp>>['app']) =>
  (await app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
const rederivedEvents = (events: DeviceEvent[]) => events.filter((e) => e.type === 'definitions' && e.reason === 'rederived').length;

/** The reference document: one local editor-cache source (seed tables), with an import stamp. */
async function referenceDoc(): Promise<ProfileDoc> {
  return profileDoc([await editorCacheSource()], { extras: { importedAt: STAMP } });
}

/** A copy of `doc` whose derived tables are older than this build's: its meta changed by `stamp`, and its derived
 *  tables visibly damaged (the DISTORT table gone, a wrong record count), so a re-derivation is observable. */
function olderDerivation(doc: ProfileDoc, stamp: (meta: Record<string, unknown>) => void): ProfileDoc {
  const d = clone(doc) as unknown as { meta: Record<string, unknown>; ranges: Record<string, unknown> };
  stamp(d.meta);
  delete d.ranges.DISTORT;
  d.meta.recordCount = 1;
  return d as unknown as ProfileDoc;
}

/** The flavours of "derived by an older build" that re-derive and are written back. */
const OLDER: Array<{ label: string; stamp: (meta: Record<string, unknown>) => void; reason: 'outdated' | 'revision' }> = [
  { label: 'a lower meta.schema', stamp: (m) => { m.schema = CACHE_SCHEMA - 1; }, reason: 'outdated' },
  { label: 'no meta.schema', stamp: (m) => { delete m.schema; }, reason: 'outdated' },
  { label: 'no meta.derivedRevision', stamp: (m) => { delete m.derivedRevision; }, reason: 'revision' },
  { label: 'a lower meta.derivedRevision', stamp: (m) => { m.derivedRevision = DERIVATION_REVISION - 1; }, reason: 'revision' }
];

/** The written-back doc equals the reference in every derived table, keeps raw and the bookkeeping. */
function assertRederived(after: ProfileDoc | null, ref: ProfileDoc, label: string): void {
  assert(after !== null, `${label}: a doc is stored`);
  assertEqual(after!.meta.schema, CACHE_SCHEMA, `${label}: the current schema`);
  assertEqual(after!.meta.derivedRevision, DERIVATION_REVISION, `${label}: the current derivation revision`);
  assertEqual(JSON.stringify(after!.ranges), JSON.stringify(ref.ranges), `${label}: the derived tables are re-derived (DISTORT back)`);
  assertEqual(after!.meta.recordCount, ref.meta.recordCount, `${label}: the record count is re-derived`);
  assertEqual(JSON.stringify(after!.raw), JSON.stringify(ref.raw), `${label}: raw kept as it was`);
  assertEqual((after!.meta as { importedAt?: string }).importedAt, STAMP, `${label}: ForgeFX bookkeeping kept`);
  assertEqual(after!.meta.source, 'editor-cache', `${label}: the persisted source vocabulary`);
}

// ── 1. an editor-cache import writes a format-2 doc without user name tables ──
async function importWritesFormat2(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    const cache = contributionCache({ major: 12, minor: 0 });
    const res = await r.app.inject({
      method: 'POST', url: '/device/cache/import?name=effectDefinitions_11_12p0.cache',
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(cache.bytes)
    });
    assertEqual(res.statusCode, 200, 'import 200');
    const body = res.json() as { format?: number; sources?: Array<{ kind: string; origin: string; records: number }>; coverage?: { gaps: unknown[] }; merged?: boolean };
    assertEqual(body.format, 2, 'the import answers format 2');
    assertEqual(body.sources?.length, 1, 'one source');
    assertEqual(body.merged, false, 'nothing to merge with');
    assert(Array.isArray(body.coverage?.gaps), 'the coverage rides along');
    const doc = storedData()!;
    assertEqual(doc.meta.format, 2, 'stored format 2');
    assertEqual(doc.meta.derivedRevision, DERIVATION_REVISION, 'stored with the derivation revision');
    assertEqual(doc.meta.source, 'editor-cache', 'persisted source vocabulary unchanged');
    assertEqual(doc.raw.format, 1, 'raw envelope format 1');
    const src = doc.raw.sources[0]!;
    assertEqual(`${src.kind}/${src.origin}`, 'editor-cache/local', 'a local editor-cache source');
    assert(src.kind === 'editor-cache' && src.omitted.tables === 2 && src.omitted.records === 2, `the two user name tables are omitted (${JSON.stringify(src.kind === 'editor-cache' ? src.omitted : null)})`);
    assertEqual(src.records.length, cache.records - 2, 'every other record is kept');
    assert(doc.raw.sources.every((s) => s.records.every((rec) => !isUserNameTable(rec.id))), 'no raw record is a user name table');
    assertNoUserTables(doc); // throws on a violation
    assert(Object.keys(doc.cabIrs ?? {}).every((b) => ['FACTORY 1', 'FACTORY 2', 'LEGACY'].includes(b)), 'only firmware cab banks');
    const json = JSON.stringify(doc);
    for (const n of [...SYNTHETIC_PRESET_NAMES, ...SYNTHETIC_USER_CAB_NAMES].filter((x) => x !== '')) assert(!json.includes(n), `no user name in the stored doc (${n})`);
    assertEqual(JSON.stringify(doc.meta.sources), JSON.stringify(doc.raw.sources.map((s) => ({ id: s.id, kind: s.kind, origin: s.origin, capturedAt: s.capturedAt, firmware: s.firmware, records: s.records.length }))), 'meta.sources summarises raw');
  } finally { clearDoc(); await r.close(); }
}

// ── 2. GET /device/cache re-derives an older doc without device traffic and writes it back once ──
async function rederiveOnStatus(): Promise<void> {
  const ref = await referenceDoc();
  const r = await makeApp();
  try {
    for (const c of OLDER) {
      putDoc(olderDerivation(ref, c.stamp));
      const rev0 = stored()!.rev;
      const sent0 = r.mock.sent.length;
      const ev0 = rederivedEvents(r.events);
      const st = await status(r.app);
      assertEqual(r.mock.sent.length, sent0, `${c.label}: no device traffic`);
      assertEqual(st.stale, false, `${c.label}: usable`);
      assertEqual(st.rederived, true, `${c.label}: rederived`);
      assertEqual(st.format, 2, `${c.label}: format 2`);
      assertEqual(st.sources?.length, 1, `${c.label}: sources`);
      assert(st.coverage !== undefined, `${c.label}: coverage`);
      assertEqual(st.meta?.schema, CACHE_SCHEMA, `${c.label}: the status reports the re-derived schema`);
      assertEqual(st.meta?.recordCount, ref.meta.recordCount, `${c.label}: and the re-derived record count`);
      assertEqual(stored()!.rev, rev0 + 1, `${c.label}: written back`);
      assertRederived(storedData(), ref, c.label);
      assertEqual(rederivedEvents(r.events), ev0 + 1, `${c.label}: one definitions/rederived event`);
      // a second read finds a current doc: nothing re-derived, nothing written
      const again = await status(r.app);
      assertEqual(again.rederived, undefined, `${c.label}: the second read does not re-derive`);
      assertEqual(stored()!.rev, rev0 + 1, `${c.label}: written back exactly once`);
      assertEqual(r.mock.sent.length, sent0, `${c.label}: still no device traffic`);
    }
  } finally { clearDoc(); await r.close(); }
}

// ── 3. apply (detect and re-apply) re-derives the same way ──
async function rederiveOnApply(): Promise<void> {
  const ref = await referenceDoc();
  for (const c of OLDER) {
    // on connect: the registry's load hook re-derives, writes back and applies the re-derived profile
    putDoc(olderDerivation(ref, c.stamp));
    const rev0 = stored()!.rev;
    const r = await makeApp();
    try {
      assertEqual(stored()!.rev, rev0 + 1, `${c.label}: detect wrote the re-derived doc back`);
      assertRederived(storedData(), ref, `${c.label} (detect)`);
      const defs = ((await r.app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: { profile: { key: string; format: number } | null } } }).capabilities.definitions;
      assertEqual(defs.profile?.key, KEY, `${c.label}: the re-derived profile is applied`);
      assertEqual(defs.profile?.format, 2, `${c.label}: format 2 applied`);

      // re-apply over a doc that turned older again: no device traffic, written back once, event emitted
      putDoc(olderDerivation(ref, c.stamp));
      const rev1 = stored()!.rev;
      const sent0 = r.mock.sent.length;
      const ev0 = rederivedEvents(r.events);
      await r.registry.applyRuntimeCache();
      assertEqual(r.mock.sent.length, sent0, `${c.label}: apply sent nothing`);
      assertEqual(stored()!.rev, rev1 + 1, `${c.label}: apply wrote the re-derived doc back`);
      assertRederived(storedData(), ref, `${c.label} (apply)`);
      assertEqual(rederivedEvents(r.events), ev0 + 1, `${c.label}: apply emitted definitions/rederived`);
      assertEqual(lastProfileVerdict(KEY)?.rederived, c.reason, `${c.label}: the verdict names the reason`);
      await r.registry.applyRuntimeCache();
      assertEqual(stored()!.rev, rev1 + 1, `${c.label}: a second apply writes nothing`);
      assertEqual(rederivedEvents(r.events), ev0 + 1, `${c.label}: and emits nothing`);
    } finally { await r.close(); }
  }
  clearDoc();
}

// ── 4. a doc a NEWER build wrote is re-derived in memory, never overwritten ──
async function newerBuildInMemory(): Promise<void> {
  const ref = await referenceDoc();
  putDoc(olderDerivation(ref, (m) => { m.schema = CACHE_SCHEMA + 1; }));
  const rev0 = stored()!.rev;
  const r = await makeApp();
  try {
    assertEqual(stored()!.rev, rev0, 'detect did not overwrite the newer build\'s doc');
    const st = await status(r.app);
    assertEqual(st.stale, false, 'usable (re-derived in memory)');
    assertEqual(st.rederived, true, 'rederived');
    assertEqual(st.meta?.recordCount, ref.meta.recordCount, 'the status serves the in-memory derivation');
    assertEqual(stored()!.rev, rev0, 'the status did not overwrite it either');
    assertEqual(rederivedEvents(r.events), 0, 'no rederived event (nothing written)');
    const defs = ((await r.app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: { profile: { key: string } | null } } }).capabilities.definitions;
    assertEqual(defs.profile?.key, KEY, 'and it is applied');
    // a higher derivation revision under the same schema is used as it is (a newer codec's additive derivation)
    const newerRev = clone(ref) as unknown as { meta: Record<string, unknown> };
    newerRev.meta.derivedRevision = DERIVATION_REVISION + 1;
    putDoc(newerRev);
    const rev1 = stored()!.rev;
    const st2 = await status(r.app);
    assertEqual(st2.rederived, undefined, 'a higher revision is not re-derived');
    assertEqual(stored()!.rev, rev1, 'nor rewritten');
  } finally { clearDoc(); await r.close(); }
}

// ── 5. a re-derivation that fails is `stale` `derivation-failed`; nothing is deleted; a build merges into it ──
async function derivationFailed(): Promise<void> {
  const ref = await referenceDoc();
  const broken = olderDerivation(ref, (m) => { m.derivedRevision = 0; }) as unknown as { raw: { sources: unknown[] } };
  broken.raw.sources.push(clone(broken.raw.sources[0])); // two sources with one id: the codec refuses to derive
  putDoc(broken);
  const rev0 = stored()!.rev;
  const r = await makeApp();
  try {
    const st = await status(r.app);
    assertEqual(st.exists, true, 'exists');
    assertEqual(st.stale, true, 'stale');
    assertEqual(st.staleReason, 'derivation-failed', 'staleReason derivation-failed');
    assertEqual(st.format, 2, 'format 2');
    assertEqual(st.sources?.length, 1, 'the stored source list is still reported');
    assertEqual(st.coverage, undefined, 'no coverage for an unusable doc');
    assertEqual(stored()!.rev, rev0, 'nothing written');
    const defs = ((await r.app.inject({ method: 'GET', url: '/device' })).json() as { capabilities: { definitions: { profile: unknown } } }).capabilities.definitions;
    assertEqual(defs.profile, null, 'not applied');
    // a build is not "already" and MERGES into the unusable doc: raw sources are never dropped implicitly. The stored
    // sources are kept (the colliding id gets a fresh `#n`, which also makes them derivable again) next to the walk.
    let walks = 0;
    const walk = async (_t: unknown, _o: LiveWalkOptions): Promise<CacheRecord[]> => { walks++; return liveSeedRecords(); };
    const b = await deviceCache.startCacheBuild(store.defaultStore, r.registry, { walkImpl: walk });
    assertEqual((b.body as { started?: boolean }).started, true, 'the build walks');
    await deviceCache.cacheBuildPromise(r.registry);
    assertEqual(walks, 1, 'walked once');
    const after = storedData()!;
    assertEqual(after.raw.sources.map((s) => s.kind).join(','), 'editor-cache,editor-cache,live-readonly', 'the stored sources were kept, the walk added');
    assertEqual(new Set(after.raw.sources.map((s) => s.id)).size, 3, 'source ids unique again');
    assertEqual(after.raw.sources[0]!.id, ref.raw.sources[0]!.id, 'the first stored source keeps its id');
    assertEqual((await status(r.app)).stale, false, 'usable after the build');
  } finally { clearDoc(); await r.close(); }
}

// ── 6. a legacy format-1 doc stays usable with the non-blocking `no-raw` gap ──
async function legacyNoRaw(): Promise<void> {
  putDoc(fakeCacheDoc());
  const rev0 = stored()!.rev;
  const r = await makeApp();
  try {
    const st = await status(r.app);
    assertEqual(st.stale, false, 'usable');
    assertEqual(st.format, 1, 'format 1');
    assertEqual(JSON.stringify(st.sources), '[]', 'no raw sources');
    assertEqual(st.rederived, undefined, 'nothing re-derived');
    const noRaw = st.coverage?.gaps.find((g) => g.kind === 'no-raw');
    assert(noRaw !== undefined && noRaw.blocking === false, 'the no-raw gap, non-blocking');
    assertEqual(JSON.stringify(noRaw!.fix), JSON.stringify(['import-editor-cache', 'read-from-device']), 'its fixes');
    assertEqual(stored()!.rev, rev0, 'a legacy doc is never rewritten by a read');
    const types = (await r.app.inject({ method: 'GET', url: '/blocks/amp/types' })).json() as { name: string }[];
    assert(types.some((t) => t.name === 'FAKE CACHE AMP'), 'a legacy doc is applied');
  } finally { clearDoc(); await r.close(); }
}

// ── 7. publish uploads the derived tables only (no raw before M4) ──
async function publishStripsRaw(): Promise<void> {
  const doc = profileDoc([await editorCacheSource(), liveSource(liveSeedRecords({ unit: 'dB' }))], { extras: { importedAt: STAMP } });
  putDoc(doc);
  const r = await makeApp();
  try {
    const published: Array<{ source: string; profile: Record<string, unknown> }> = [];
    const cloud: DeviceProfileCloud = {
      deviceProfileGet: async () => null,
      deviceProfilePublish: async (body) => { published.push(body as never); return { code: 201, body: { ok: true } }; }
    };
    const res = await cloudCachePublish(cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 201, 'published');
    const sent = published[0]!;
    assertEqual(sent.source, 'editor-cache', 'API source of an editor-cache doc');
    for (const k of ['raw', 'sections', 'blockMap', 'provenance', 'coverage']) assert(!(k in sent.profile), `no ${k} in the payload`);
    const meta = sent.profile.meta as Record<string, unknown>;
    for (const k of ['format', 'sources', 'derivedWith', 'derivedRevision', 'derivedAt']) assert(!(k in meta), `no meta.${k} in the payload`);
    assertEqual(meta.source, 'bytes', 'normalised to the codec vocabulary');
    assertEqual(meta.schema, CACHE_SCHEMA, 'the schema rides along');
    assertEqual(JSON.stringify(sent.profile.ranges), JSON.stringify(doc.ranges), 'the derived tables are published as they are');
    assert(!JSON.stringify(sent).includes('"records"'), 'no raw record anywhere in the payload');
  } finally { clearDoc(); await r.close(); }
}

// ── 7b. publish: tables derived from the LOCAL sources only, no synthetic family; nothing local → not publishable ──
async function publishLocalOnly(): Promise<void> {
  const r = await makeApp();
  const published: Array<{ source: string; profile: Record<string, unknown> }> = [];
  const cloud: DeviceProfileCloud = {
    deviceProfileGet: async () => null,
    deviceProfilePublish: async (body) => { published.push(body as never); return { code: 201, body: { ok: true } }; }
  };
  // rows of a table no catalog family matches: under a live walk at block 203 they stay `block:203`
  const odd: CacheRecord[] = Array.from({ length: 10 }, (_, id) => ({ kind: 'float', section: 60, offset: 0, id, tc: 0x31, min: 0, max: 7.77 + id, def: 1, step: 0, t1: 0, t2: 0 } as CacheRecord));
  const hasSynthetic = (o: unknown) => Object.keys((o ?? {}) as object).some((k) => k.startsWith('section:') || k.startsWith('block:'));
  try {
    // two local sources, one with a synthetic family: published without it
    const local = profileDoc([await editorCacheSource(), liveSource([...liveSeedRecords(), ...odd.map((x) => ({ ...x, section: 203 }))])]);
    assert(hasSynthetic(local.ranges), 'fixture: the stored doc carries a synthetic family');
    putDoc(local);
    let res = await cloudCachePublish(cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 201, 'published');
    let sent = published.at(-1)!;
    assertEqual(sent.source, 'editor-cache', 'a local editor cache among the sources: editor-cache');
    for (const k of ['ranges', 'enumOverrides', 'rangeSections', 'rosters', 'cabIrs']) assert(!hasSynthetic(sent.profile[k]), `no synthetic family in ${k}`);
    assertEqual(Object.keys(sent.profile.ranges as object).length, Object.keys(local.ranges).length - 1, 'every catalog family is still there');

    // a cloud editor cache (with a catalog family the local walk lacks: CHORUS at its inventory tag) next to a local
    // walk: only the walk's tables travel
    const cloudSrc = await editorCacheSource([...cacheSeedRecords(), ...familyRecords('CHORUS', 16)], { origin: 'cloud' });
    const mixed = profileDoc([cloudSrc, liveSource(liveSeedRecords())]);
    const walkOnly = profileDoc([liveSource(liveSeedRecords())]);
    const cloudOnlyFamily = Object.keys(mixed.ranges).find((f) => !(f in walkOnly.ranges) && !f.includes(':'));
    assert(cloudOnlyFamily !== undefined, 'fixture: a family only the cloud source provides');
    assertEqual(mixed.meta.source, 'cloud', 'fixture: the best source is the cloud editor cache');
    putDoc(mixed);
    res = await cloudCachePublish(cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 201, 'a doc with a local source next to a cloud one: published');
    sent = published.at(-1)!;
    assertEqual(sent.source, 'live-walk', 'the local source is a walk: live-walk');
    assertEqual((sent.profile.meta as { source?: string }).source, 'live', 'normalised to the codec vocabulary');
    assert(!(cloudOnlyFamily! in (sent.profile.ranges as object)), `the cloud-only family ${cloudOnlyFamily} does not travel back`);
    assertEqual(JSON.stringify(sent.profile.ranges), JSON.stringify(walkOnly.ranges), 'the tables are the local walk\'s alone');

    // only cloud sources: nothing of this install's to publish
    putDoc(profileDoc([cloudSrc]));
    const n = published.length;
    res = await cloudCachePublish(cloud, store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'only cloud sources: 409');
    assert(String((res.body as { error?: string }).error).includes('not publishable'), 'not publishable');
    assertEqual(published.length, n, 'nothing uploaded');
  } finally { clearDoc(); await r.close(); }
}

// ── 7c. cloud check: a format-2 row derived under another schema is re-derivable, i.e. available ──
async function cloudCheckRederivable(): Promise<void> {
  const r = await makeApp();
  try {
    clearDoc();
    const ref = await referenceDoc();
    for (const schema of [CACHE_SCHEMA - 1, CACHE_SCHEMA + 1]) {
      const row = clone(ref) as unknown as { meta: Record<string, unknown> };
      row.meta.schema = schema;
      const cloud: DeviceProfileCloud = {
        deviceProfileGet: async () => ({ profile: row, contentHash: 'h', source: 'editor-cache', recordCount: 1, createdAt: STAMP }),
        deviceProfilePublish: async () => ({ code: 201, body: {} })
      };
      const chk = await cloudCacheCheck(cloud, store.defaultStore, r.registry);
      assertEqual(chk.available, true, `schema ${schema}: a re-derivable row is available`);
      assertEqual(chk.rederivable, true, `schema ${schema}: rederivable`);
      assertEqual(chk.stale, undefined, `schema ${schema}: not stale`);
      // and the pull re-derives it under this build's schema
      const pulled = await cloudCachePull(cloud, store.defaultStore, r.registry);
      assertEqual(pulled.code, 200, `schema ${schema}: pulled`);
      assertEqual(storedData()!.meta.schema, CACHE_SCHEMA, `schema ${schema}: stored under this build's schema`);
      clearDoc();
    }
    // a derived-only row of another schema stays unavailable (nothing to re-derive from)
    const legacy = { ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, schema: CACHE_SCHEMA + 1 } };
    const chk = await cloudCacheCheck({ deviceProfileGet: async () => ({ profile: legacy, contentHash: 'h', source: 'live-walk', recordCount: 1, createdAt: STAMP }), deviceProfilePublish: async () => ({ code: 201, body: {} }) }, store.defaultStore, r.registry);
    assertEqual(chk.available, false, 'a derived-only row of another schema: unavailable');
    assertEqual(chk.stale, true, 'and stale');
  } finally { clearDoc(); await r.close(); }
}

// ── 7d. small contracts: the summary memo is per model; a definitions-file profile counts as another install's ──
async function summaryAndContribution(): Promise<void> {
  const legacy = fakeCacheDoc();
  const bare = profileSummaryOf(legacy, null);
  const fm3 = profileSummaryOf(legacy, FM3);
  assert(bare !== fm3, 'a summary computed without a catalog is not handed out for a model');
  assert(JSON.stringify(bare.coverage) !== JSON.stringify(fm3.coverage), 'the catalog changes the coverage (rosters, ...)');
  assert(profileSummaryOf(legacy, FM3) === fm3, 'memoised per model');
  assert(profileSummaryOf(legacy, null) === bare, 'and without one');
  // contribution status: an imported definitions file is grouped with cloud profiles (like isByteExactProfile does)
  const r = await makeApp();
  try {
    putDoc({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'axisdefs', origin: 'bytes' } });
    const s = (await r.app.inject({ method: 'GET', url: '/device/cache/contribute' })).json() as { localProfile?: string };
    assertEqual(s.localProfile, 'cloud', 'an axisdefs profile: cloud (another install\'s data), not live');
    putDoc({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'cloud', origin: 'live' } });
    assertEqual(((await r.app.inject({ method: 'GET', url: '/device/cache/contribute' })).json() as { localProfile?: string }).localProfile, 'cloud', 'a cloud profile: cloud');
    putDoc(fakeCacheDoc());
    assertEqual(((await r.app.inject({ method: 'GET', url: '/device/cache/contribute' })).json() as { localProfile?: string }).localProfile, 'live', 'a local walk: live');
  } finally { clearDoc(); await r.close(); }
}

// ── 8. runtime-router twin: same status, same re-derivation ──
async function routerParity(): Promise<void> {
  const ref = await referenceDoc();
  const r = await makeApp();
  const router = createRouter({ registry: r.registry as DeviceRegistry, store: store.defaultStore });
  const viaApp = async () => { const res = await r.app.inject({ method: 'GET', url: '/device/cache' }); return { status: res.statusCode, body: res.json() as Record<string, unknown> }; };
  const viaRouter = async () => { const res = await router.handle('GET', '/device/cache'); return { status: res.status, body: JSON.parse(res.body as string) as Record<string, unknown> }; };
  // the status carries no clock of the re-derivation (`derivedAt` stays in the doc), so the bodies compare whole
  const strip = (b: Record<string, unknown>) => JSON.stringify(b);
  try {
    const cases: Array<[string, () => unknown]> = [
      ['a current format-2 doc', () => clone(ref)],
      ['an older derivation (re-derived and written back by each twin)', () => olderDerivation(ref, (m) => { m.derivedRevision = 0; })],
      ['a failing re-derivation', () => { const b = olderDerivation(ref, (m) => { m.derivedRevision = 0; }) as unknown as { raw: { sources: unknown[] } }; b.raw.sources.push(clone(b.raw.sources[0])); return b; }],
      ['a legacy doc', () => fakeCacheDoc()]
    ];
    for (const [label, make] of cases) {
      putDoc(make());
      const a = await viaApp();
      const revA = stored()!.rev;
      putDoc(make());
      const b = await viaRouter();
      assertEqual(b.status, a.status, `${label}: status parity`);
      assertEqual(strip(b.body), strip(a.body), `${label}: body parity`);
      assertEqual(stored()!.rev - revA, label.startsWith('an older') ? 2 : 1, `${label}: the router twin writes back exactly like the app`);
    }
    // the build short-circuit agrees too (a complete local read-only walk)
    putDoc(profileDoc([liveSource(liveSeedRecords())]));
    const built = await r.app.inject({ method: 'POST', url: '/device/cache/build', payload: {} });
    const routed = await router.handle('POST', '/device/cache/build', '{}');
    assertEqual(routed.status, built.statusCode, 'build: status parity');
    assertEqual(routed.body, built.payload, 'build: body parity');
    assertEqual((built.json() as { already?: boolean }).already, true, 'build: already on both twins');
  } finally { clearDoc(); await r.close(); }
}

// ── 9. Browser Direct: the runtime barrel hands its loader the very same lookup ──
async function directLoaderParity(): Promise<void> {
  assert(runtimeBarrel.loadUsableProfile === loadUsableProfile, 'barrel: loadUsableProfile');
  assert(runtimeBarrel.upgradeStoredProfile === upgradeStoredProfile, 'barrel: upgradeStoredProfile');
  assert(runtimeBarrel.classifyProfile === classifyProfile, 'barrel: classifyProfile');
  assert(runtimeBarrel.loadStoredProfile === loadStoredProfile, 'barrel: loadStoredProfile');
  const ref = await referenceDoc();
  // a store the loader may write (IndexedDB through the store interface): re-derived and written back once
  const s = createStore(createMemStoreBackend(), nodeCodec);
  s.putDoc('deviceCaches', KEY, olderDerivation(ref, (m) => { m.derivedRevision = 0; }));
  const rev0 = s.getDoc('deviceCaches', KEY)!.rev;
  const p = loadUsableProfile(s, KEY) as BuiltCache | null;
  assert(p !== null, 'usable');
  assertEqual(JSON.stringify(p!.ranges), JSON.stringify(ref.ranges), 'the re-derived tables');
  assertEqual(s.getDoc('deviceCaches', KEY)!.rev, rev0 + 1, 'written back');
  assertEqual(lastProfileVerdict(KEY)?.upgraded, true, 'the verdict says it was written back');
  loadUsableProfile(s, KEY);
  assertEqual(s.getDoc('deviceCaches', KEY)!.rev, rev0 + 1, 'once');
  // a read-only store (no putDoc): re-derived in memory only
  const ro = createStore(createMemStoreBackend(), nodeCodec);
  ro.putDoc('deviceCaches', KEY, olderDerivation(ref, (m) => { m.derivedRevision = 0; }));
  const readOnly = { getDoc: ro.getDoc.bind(ro) };
  const q = loadUsableProfile(readOnly, KEY) as BuiltCache | null;
  assertEqual(JSON.stringify(q?.ranges), JSON.stringify(ref.ranges), 'a read-only store still gets the re-derived tables');
  assertEqual(ro.getDoc('deviceCaches', KEY)!.rev, rev0, 'and nothing is written');
  assertEqual(lastProfileVerdict(KEY)?.rederived, 'revision', 'verdict: rederived (revision)');
  // the classification is memoised per stored object: the same doc derives once
  const data = ro.getDoc('deviceCaches', KEY)!.data;
  assert(classifyProfile(data, KEY) === classifyProfile(data, KEY), 'memoised per doc object');
}

export async function runProfileV2Tests(): Promise<void> {
  await importWritesFormat2();
  await rederiveOnStatus();
  await rederiveOnApply();
  await newerBuildInMemory();
  await derivationFailed();
  await legacyNoRaw();
  await publishStripsRaw();
  await publishLocalOnly();
  await cloudCheckRederivable();
  await summaryAndContribution();
  await routerParity();
  await directLoaderParity();
}
