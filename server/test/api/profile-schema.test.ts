// Profile schema gate (gap L14) — a persisted device-definition profile whose `meta.schema` this build
// cannot use (missing, older, newer) is STALE: never applied at runtime, never "already built", not
// "persisted", not pulled from / pushed to the cloud, and reported as `stale` by the status. Mocked
// transport + synthetic profile docs only, NO hardware. Covers the pure verdict, the store lookup,
// every consuming path (runtime apply incl. the registry's own guard, status, build, import/sources,
// cloud check/pull/publish, the walk-limit derivation), the "current schema behaves as before" side of
// each, and the Fastify-vs-router parity of the changed endpoints. Stale docs are never auto-deleted.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { createRouter } from '../../src/runtime/router.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import * as store from '../../src/store.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { isPersisted } from '../../src/services/editorCacheImport.js';
import { cloudCacheCheck, cloudCachePull, cloudCachePublish, type DeviceProfileCloud } from '../../src/services/cloudProfiles.js';
import {
  CURRENT_CACHE_SCHEMA, checkProfileSchema, loadStoredProfile, loadUsableProfile
} from '../../src/profileSchema.js';
import * as runtimeBarrel from '../../src/runtime/index.js';
import { CACHE_SCHEMA, type BuiltCache, type CacheRecord, type LiveWalkOptions } from 'forgefx-midi/cache';
import { createCloud } from '../../src/runtime/cloud.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { seedRecords, fakeCacheDoc, sectionsDoc } from './device-cache.test.js';
import { liveSource, profileDoc } from '../helpers/profileDocs.js';
import { CACHE_BYTES } from './editor-cache-import.test.js';

export const PROFILE_SCHEMA_CASE_COUNT = 11;

const FM3 = 0x11;
const KEY = '11_12p0'; // FM3 fw 12.0

/** A schema stamp in each flavour a stored profile can carry. `undefined` = no stamp at all. */
const STALE_STAMPS: Array<{ label: string; schema: unknown; reason: 'missing' | 'outdated' | 'newer' }> = [
  { label: 'no stamp', schema: undefined, reason: 'missing' },
  { label: 'non-numeric stamp', schema: '1', reason: 'missing' },
  { label: 'fractional stamp', schema: CACHE_SCHEMA + 0.5, reason: 'missing' },
  { label: 'older stamp', schema: CACHE_SCHEMA - 1, reason: 'outdated' },
  { label: 'newer stamp', schema: CACHE_SCHEMA + 1, reason: 'newer' }
];

/** The distinctive-roster fixture with its schema stamp replaced (undefined removes it). */
function docWithSchema(schema: unknown): BuiltCache {
  const base = fakeCacheDoc();
  const meta: Record<string, unknown> = { ...base.meta };
  if (schema === undefined) delete meta.schema; else meta.schema = schema;
  return { ...base, meta } as BuiltCache;
}

const staleDoc = (): BuiltCache => docWithSchema(undefined);

/** A current profile-v2 doc of FM3 fw 12.0 holding one complete local read-only walk (a build is "already"). */
const currentV2Doc = (): BuiltCache => profileDoc([liveSource(seedRecords())]) as unknown as BuiltCache;

function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

/** A registry over the REAL FM3 gen-3 driver (mocked transport, fw 12.0). `loadCache` overrides the
 *  registry's hook; omitted = the real Node hook (loadUsableProfile over the default store). */
async function makeApp(opts: { loadCache?: (key: string) => BuiltCache | null } = {}) {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[5] === 0x08) return [firmwareReply(FM3, 12, 0)];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    ...(opts.loadCache ? { loadDeviceCache: opts.loadCache } : {})
  });
  await registry.detect();
  const app = await buildApp(registry);
  return { app, registry };
}

const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);
const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const storedData = () => { const d = store.defaultStore.getDoc('deviceCaches', KEY); return d && !d.deleted ? (d.data as BuiltCache) : null; };

/** Does the registry currently serve the fixture's distinctive amp roster (i.e. was that profile applied)? */
async function servesFakeRoster(app: Awaited<ReturnType<typeof makeApp>>['app']): Promise<boolean> {
  const types = (await app.inject({ method: 'GET', url: '/blocks/amp/types' })).json() as { name: string }[];
  return types.some((t) => t.name === 'FAKE CACHE AMP');
}

// ── 1. the pure verdict ──
async function verdictCases(): Promise<void> {
  assertEqual(CURRENT_CACHE_SCHEMA, CACHE_SCHEMA, 'the gate follows the codec constant');
  const ok = checkProfileSchema({ meta: { schema: CACHE_SCHEMA } });
  assertEqual(ok.usable, true, 'current schema is usable');
  assertEqual(ok.schema, CACHE_SCHEMA, 'verdict carries the stored schema');
  for (const c of STALE_STAMPS) {
    const v = checkProfileSchema({ meta: { schema: c.schema, recordCount: 1 } });
    assertEqual(v.usable, false, `${c.label} is not usable`);
    if (v.usable) continue;
    assertEqual(v.reason, c.reason, `${c.label}: reason`);
    assertEqual(v.current, CACHE_SCHEMA, `${c.label}: reports the current schema`);
    assertEqual(v.schema, c.reason === 'missing' ? null : c.schema, `${c.label}: reports the stored schema (null when none)`);
  }
  for (const junk of [null, undefined, 7, 'x', [], {}, { meta: null }, { meta: 3 }]) {
    const v = checkProfileSchema(junk);
    assert(!v.usable && v.reason === 'missing', `non-profile ${JSON.stringify(junk)} is stale (missing)`);
  }
  // the runtime barrel hands Axis the very same helpers
  assert(runtimeBarrel.loadUsableProfile === loadUsableProfile && runtimeBarrel.checkProfileSchema === checkProfileSchema, 'runtime barrel re-exports the shared helpers');
  assertEqual(runtimeBarrel.CURRENT_CACHE_SCHEMA, CACHE_SCHEMA, 'runtime barrel re-exports the current schema');
}

// ── 2. the store lookup (absent / tombstone / usable / stale) ──
async function storeLookup(): Promise<void> {
  const s = createStore(createMemStoreBackend(), nodeCodec);
  assertEqual(loadStoredProfile(s, KEY).state, 'absent', 'nothing stored → absent');
  assertEqual(loadUsableProfile(s, KEY), null, 'nothing stored → no usable profile');

  s.putDoc('deviceCaches', KEY, docWithSchema(CACHE_SCHEMA));
  const usable = loadStoredProfile(s, KEY);
  assertEqual(usable.state, 'usable', 'current schema → usable');
  assert(loadUsableProfile(s, KEY) !== null, 'usable profile is returned');

  for (const c of STALE_STAMPS) {
    s.putDoc('deviceCaches', KEY, docWithSchema(c.schema));
    const st = loadStoredProfile(s, KEY);
    assertEqual(st.state, 'stale', `${c.label} → stale`);
    assertEqual(loadUsableProfile(s, KEY), null, `${c.label} → no usable profile`);
    if (st.state === 'stale') assertEqual(st.profile.meta.recordCount, 2, `${c.label}: the stale profile is still readable for reporting`);
  }

  s.delDoc('deviceCaches', KEY);
  assertEqual(loadStoredProfile(s, KEY).state, 'absent', 'a tombstone is absent');
  assertEqual(loadUsableProfile(s, KEY), null, 'a tombstone is no usable profile');
}

// ── 3. runtime apply: stale → the bundled profile stays; current → applied; the registry guards itself ──
async function runtimeApply(): Promise<void> {
  try {
    // real Node hook (loadUsableProfile): a stale profile on disk is not applied at detect time
    for (const c of STALE_STAMPS) {
      putDoc(docWithSchema(c.schema));
      const { app } = await makeApp();
      try {
        assertEqual(await servesFakeRoster(app), false, `${c.label}: stale profile not applied on connect (bundled roster stays)`);
      } finally { await app.close(); }
    }
    assert(storedData() !== null, 'the stale profile was not deleted by being skipped');

    // a current-schema profile is applied exactly as before
    putDoc(docWithSchema(CACHE_SCHEMA));
    const cur = await makeApp();
    try {
      assertEqual(await servesFakeRoster(cur.app), true, 'current profile applied on connect');
    } finally { await cur.app.close(); }

    // defense in depth: a hook that returns the stale doc anyway (a loader that skipped the gate) is not obeyed
    const sloppy = await makeApp({ loadCache: () => staleDoc() });
    try {
      assertEqual(await servesFakeRoster(sloppy.app), false, 'registry refuses a stale profile even from a sloppy hook');
      await sloppy.registry.applyRuntimeCache();
      assertEqual(await servesFakeRoster(sloppy.app), false, 'an explicit re-apply refuses it too');
    } finally { await sloppy.app.close(); }

    // a stale profile becoming current (rebuilt in place) is picked up by the next apply
    putDoc(staleDoc());
    const flip = await makeApp();
    try {
      assertEqual(await servesFakeRoster(flip.app), false, 'stale first');
      putDoc(docWithSchema(CACHE_SCHEMA));
      await flip.registry.applyRuntimeCache();
      assertEqual(await servesFakeRoster(flip.app), true, 'applied once the stored profile is current');
    } finally { await flip.app.close(); }
  } finally { clearDoc(); }
}

// ── 4. status: additive stale fields, exists stays true ──
async function statusReportsStale(): Promise<void> {
  const { app } = await makeApp();
  const status = async () => (await app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
  try {
    clearDoc();
    let st = await status();
    assertEqual(st.exists, false, 'nothing stored: exists false');
    assertEqual(st.stale, false, 'nothing stored: not stale');
    assertEqual(st.currentSchema, CACHE_SCHEMA, 'status always reports the current schema');
    assertEqual(st.meta, undefined, 'nothing stored: no meta');

    putDoc(docWithSchema(CACHE_SCHEMA));
    st = await status();
    assertEqual(st.exists, true, 'current: exists');
    assertEqual(st.stale, false, 'current: not stale');
    assertEqual(st.staleReason, undefined, 'current: no staleReason');
    assertEqual(st.meta?.schema, CACHE_SCHEMA, 'current: meta.schema is the stored stamp');
    assertEqual(st.meta?.recordCount, 2, 'current: meta unchanged (recordCount)');
    assertEqual(st.meta?.source, 'live', 'current: meta unchanged (source)');

    for (const c of STALE_STAMPS) {
      putDoc(docWithSchema(c.schema));
      st = await status();
      assertEqual(st.key, KEY, `${c.label}: key`);
      assertEqual(st.exists, true, `${c.label}: a stored (stale) profile still exists`);
      assertEqual(st.stale, true, `${c.label}: stale`);
      assertEqual(st.staleReason, c.reason, `${c.label}: staleReason`);
      assertEqual(st.currentSchema, CACHE_SCHEMA, `${c.label}: currentSchema`);
      assertEqual(st.meta?.schema, c.reason === 'missing' ? null : c.schema, `${c.label}: meta.schema is the stored stamp`);
      assertEqual(st.meta?.recordCount, 2, `${c.label}: meta of the stale profile is still reported`);
    }
  } finally { clearDoc(); await app.close(); }
}

// ── 5. build: a stale profile does not count as built; a current one still does ──
async function buildOverStale(): Promise<void> {
  const walks: LiveWalkOptions[] = [];
  const walk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => { walks.push(opts); return seedRecords(); };
  try {
    for (const c of STALE_STAMPS) {
      putDoc(docWithSchema(c.schema));
      const { app, registry } = await makeApp();
      try {
        const r = await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: walk });
        const body = r.body as { started?: boolean; already?: boolean };
        assertEqual(body.already, undefined, `${c.label}: not "already built"`);
        assertEqual(body.started, true, `${c.label}: rebuild started without force`);
        await deviceCache.cacheBuildPromise(registry);
        const after = storedData();
        assert(after !== null, `${c.label}: a profile is stored after the rebuild`);
        assertEqual(after!.meta.schema, CACHE_SCHEMA, `${c.label}: the stale profile was overwritten with a current one`);
        assertEqual(after!.meta.recordCount, seedRecords().length, `${c.label}: it is the new build, not the old doc`);
        const st = (await app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
        assertEqual(st.stale, false, `${c.label}: status no longer stale after the rebuild`);
      } finally { await app.close(); }
    }
    assertEqual(walks.length, STALE_STAMPS.length, 'each stale rebuild walked exactly once');

    // current schema, profile v2: a doc holding a complete local read-only walk short-circuits (no walk)
    putDoc(currentV2Doc());
    const hit = await makeApp();
    try {
      const r = await deviceCache.startCacheBuild(store.defaultStore, hit.registry, { walkImpl: walk });
      assertEqual((r.body as { already?: boolean }).already, true, 'current profile: already built');
      assertEqual(walks.length, STALE_STAMPS.length, 'current profile: no walk');
    } finally { await hit.app.close(); }

    // a current LEGACY (format-1) doc is usable but holds no raw source: the build walks and writes a format-2 doc
    putDoc(docWithSchema(CACHE_SCHEMA));
    const legacy = await makeApp();
    try {
      const r = await deviceCache.startCacheBuild(store.defaultStore, legacy.registry, { walkImpl: walk });
      assertEqual((r.body as { started?: boolean }).started, true, 'current legacy profile: the build walks');
      await deviceCache.cacheBuildPromise(legacy.registry);
      assertEqual(walks.length, STALE_STAMPS.length + 1, 'current legacy profile: walked once');
      assertEqual((storedData()!.meta as { format?: number }).format, 2, 'current legacy profile: replaced by a format-2 doc');
    } finally { await legacy.app.close(); }

    // a cancelled rebuild leaves the stale profile exactly where it was (nothing deletes it up front)
    putDoc(staleDoc());
    const cancelled = await makeApp();
    try {
      const blocking = (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> =>
        new Promise((_res, rej) => { opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
      const r = await deviceCache.startCacheBuild(store.defaultStore, cancelled.registry, { walkImpl: blocking });
      assertEqual((r.body as { started?: boolean }).started, true, 'rebuild over stale started');
      deviceCache.cancelCacheBuild(cancelled.registry);
      await deviceCache.cacheBuildPromise(cancelled.registry);
      const st = await deviceCache.cacheStatus(store.defaultStore, cancelled.registry);
      assertEqual(st.exists, true, 'cancelled rebuild: the stale profile is still stored');
      assertEqual(st.stale, true, 'cancelled rebuild: and still stale');
    } finally { await cancelled.app.close(); }
  } finally { clearDoc(); }
}

// ── 6. import / sources: stale is not "persisted"; an import replaces it ──
async function importAndSources(): Promise<void> {
  const { app, registry } = await makeApp();
  const sources = async () => (await app.inject({ method: 'GET', url: '/device/cache/sources' })).json() as { persisted: boolean };
  try {
    clearDoc();
    assertEqual((await sources()).persisted, false, 'nothing stored: not persisted');
    putDoc(docWithSchema(CACHE_SCHEMA));
    assertEqual((await sources()).persisted, true, 'current profile: persisted (as before)');
    assertEqual(await isPersisted(store.defaultStore, registry), true, 'isPersisted true for a current profile');

    for (const c of STALE_STAMPS) {
      putDoc(docWithSchema(c.schema));
      assertEqual(await isPersisted(store.defaultStore, registry), false, `${c.label}: isPersisted false`);
      assertEqual((await sources()).persisted, false, `${c.label}: sources.persisted false`);
    }

    // import over a stale profile works (no 409, nothing consulted) and leaves a usable one behind
    putDoc(staleDoc());
    const res = await app.inject({
      method: 'POST', url: '/device/cache/import?name=effectDefinitions_11_12p0.cache',
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(CACHE_BYTES)
    });
    assertEqual(res.statusCode, 200, 'import over a stale profile → 200');
    const after = storedData();
    assert(after !== null, 'import stored a profile');
    assertEqual(after!.meta.schema, CACHE_SCHEMA, 'the imported profile carries the current schema');
    assertEqual((after!.meta as { source?: string }).source, 'editor-cache', 'it is the import, not the old doc');
    assertEqual((await sources()).persisted, true, 'persisted after the import');
    const st = (await app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    assertEqual(st.stale, false, 'status not stale after the import');
  } finally { clearDoc(); await app.close(); }
}

// ── cloud fixtures ──
function profileRow(schema: unknown) {
  const meta: Record<string, unknown> = { recordCount: 42, source: 'live' };
  if (schema !== undefined) meta.schema = schema;
  return {
    profile: { ranges: { DISTORT: {} }, rangeSections: {}, rosters: {}, enumOverrides: {}, cabIrs: {}, meta },
    contentHash: 'abc123', source: 'live-walk', recordCount: 42, createdAt: '2026-07-13T00:00:00Z'
  };
}

function fakeCloud(row: ReturnType<typeof profileRow> | null): DeviceProfileCloud & { gets: number; published: unknown[]; asked: Array<[number, string, number | undefined]> } {
  const f = {
    gets: 0,
    published: [] as unknown[],
    asked: [] as Array<[number, string, number | undefined]>,
    async deviceProfileGet(model: number, firmware: string, schema?: number) { f.gets++; f.asked.push([model, firmware, schema]); return row; },
    async deviceProfilePublish(body: unknown) { f.published.push(body); return { code: 201, body: { ok: true } }; }
  };
  return f;
}

// ── 7. cloud check + pull: an unusable row is not offered and not stored ──
async function cloudCheckAndPull(): Promise<void> {
  const { app, registry } = await makeApp();
  try {
    // a current row: available, pull stores it as a usable profile (as before)
    clearDoc();
    const good = fakeCloud(profileRow(CACHE_SCHEMA));
    const hit = await cloudCacheCheck(good, store.defaultStore, registry);
    assertEqual(hit.available, true, 'current row is available');
    assertEqual(hit.stale, undefined, 'current row: no stale fields');
    const pulled = await cloudCachePull(good, store.defaultStore, registry);
    assertEqual(pulled.code, 200, 'current row: pull 200');
    assertEqual(storedData()?.meta.schema, CACHE_SCHEMA, 'pulled profile keeps its (current) schema');
    assertEqual(loadStoredProfile(store.defaultStore, KEY).state, 'usable', 'pulled profile is usable');

    for (const c of STALE_STAMPS) {
      // a usable local profile must survive a refused pull untouched
      const local = putDoc(docWithSchema(CACHE_SCHEMA));
      const cloud = fakeCloud(profileRow(c.schema));
      const chk = await cloudCacheCheck(cloud, store.defaultStore, registry);
      assertEqual(chk.enabled, true, `${c.label}: check enabled`);
      assertEqual(chk.available, false, `${c.label}: an unusable row is not available`);
      assertEqual(chk.stale, true, `${c.label}: check reports stale`);
      assertEqual(chk.staleReason, c.reason, `${c.label}: check staleReason`);
      assertEqual(chk.currentSchema, CACHE_SCHEMA, `${c.label}: check currentSchema`);
      assertEqual(chk.meta, undefined, `${c.label}: nothing to pull, no meta`);

      const getsBefore = cloud.gets;
      const r = await cloudCachePull(cloud, store.defaultStore, registry);
      assertEqual(r.code, 409, `${c.label}: pull refused with 409`);
      const body = r.body as { error?: string; stale?: boolean; staleReason?: string; schema?: unknown; currentSchema?: number };
      assertEqual(body.error, 'cloud-profile-stale', `${c.label}: pull error name`);
      assertEqual(body.stale, true, `${c.label}: pull body carries stale`);
      assertEqual(body.staleReason, c.reason, `${c.label}: pull body staleReason`);
      assertEqual(body.schema, c.reason === 'missing' ? null : c.schema, `${c.label}: pull body schema`);
      assertEqual(body.currentSchema, CACHE_SCHEMA, `${c.label}: pull body currentSchema`);
      assertEqual(cloud.gets, getsBefore + 1, `${c.label}: pull refetched (a refused row is never reused from the check cache)`);
      const kept = store.defaultStore.getDoc('deviceCaches', KEY);
      assertEqual(kept?.rev, local.rev, `${c.label}: the local profile was not touched`);
    }

    // with nothing stored a refused pull stores nothing at all
    clearDoc();
    const r = await cloudCachePull(fakeCloud(profileRow(undefined)), store.defaultStore, registry);
    assertEqual(r.code, 409, 'refused pull over an empty store');
    assertEqual(storedData(), null, 'nothing was stored by the refused pull');
    // a malformed row keeps its own error (422) — the schema gate runs after the shape check
    const bad = await cloudCachePull(fakeCloud({ profile: { nope: 1 } } as never), store.defaultStore, registry);
    assertEqual(bad.code, 422, 'malformed row still 422');
  } finally { clearDoc(); await app.close(); }
}

// ── 7b. the cloud GET asks for the schema this build can use (so builds on different schemas coexist) ──
async function cloudAsksForCurrentSchema(): Promise<void> {
  const { app, registry } = await makeApp();
  try {
    clearDoc();
    const c1 = fakeCloud(profileRow(CACHE_SCHEMA));
    await cloudCacheCheck(c1, store.defaultStore, registry);
    assertEqual(JSON.stringify(c1.asked), JSON.stringify([[FM3, '12.0', CACHE_SCHEMA]]), 'check asks for (model, firmware, current schema)');
  } finally { clearDoc(); await app.close(); }
  // a pull that has no cached check row (fresh registry) fetches itself, with the same schema
  const second = await makeApp();
  try {
    const c2 = fakeCloud(profileRow(CACHE_SCHEMA));
    await cloudCachePull(c2, store.defaultStore, second.registry);
    assertEqual(JSON.stringify(c2.asked), JSON.stringify([[FM3, '12.0', CACHE_SCHEMA]]), 'pull asks for the current schema too');
  } finally { clearDoc(); await second.app.close(); }

  // the real client puts it on the wire as a query parameter; omitted, the URL is the legacy one
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  try {
    const cloud = createCloud({ url: 'https://cloud.invalid', anonKey: 'anon-test-key' }, store.defaultStore);
    assertEqual(await cloud.deviceProfileGet(17, '12.0', CACHE_SCHEMA), null, 'a 404 is no profile');
    assertEqual(await cloud.deviceProfileGet(17, '12.0'), null, 'a 404 is no profile (legacy call)');
    assertEqual(urls[0], `https://cloud.invalid/functions/v1/device-profiles?model=17&firmware=12.0&schema=${CACHE_SCHEMA}`, 'schema rides on the GET');
    assertEqual(urls[1], 'https://cloud.invalid/functions/v1/device-profiles?model=17&firmware=12.0', 'no schema param when none is given');
  } finally { globalThis.fetch = realFetch; }
}

// ── 8. cloud publish: a stale local profile is never uploaded ──
async function cloudPublishGate(): Promise<void> {
  const { app, registry } = await makeApp();
  try {
    for (const source of ['live', 'editor-cache'] as const) {
      for (const c of STALE_STAMPS) {
        const base = docWithSchema(c.schema);
        putDoc({ ...base, meta: { ...base.meta, source } });
        const cloud = fakeCloud(null);
        const r = await cloudCachePublish(cloud, store.defaultStore, registry);
        assertEqual(r.code, 409, `${source}/${c.label}: publish refused with 409`);
        const body = r.body as { error?: string; stale?: boolean; staleReason?: string; currentSchema?: number };
        assertEqual(body.error, 'profile-stale', `${source}/${c.label}: error name`);
        assertEqual(body.stale, true, `${source}/${c.label}: body carries stale`);
        assertEqual(body.staleReason, c.reason, `${source}/${c.label}: staleReason`);
        assertEqual(cloud.published.length, 0, `${source}/${c.label}: nothing was uploaded`);
        assert(storedData() !== null, `${source}/${c.label}: the stale profile was not deleted`);
      }
    }
    // a current profile publishes as before, schema included
    const base = docWithSchema(CACHE_SCHEMA);
    putDoc({ ...base, meta: { ...base.meta, source: 'live' } });
    const cloud = fakeCloud(null);
    const ok = await cloudCachePublish(cloud, store.defaultStore, registry);
    assertEqual(ok.code, 201, 'current profile publishes');
    const sent = cloud.published[0] as { profile: { meta: { schema?: number; source: string } } };
    assertEqual(sent.profile.meta.schema, CACHE_SCHEMA, 'the uploaded profile carries its schema');
    assertEqual(sent.profile.meta.source, 'live', 'upload normalisation unchanged');
    // the older refusals keep their precedence (a cloud-sourced profile is 409 "not publishable", absent is 404)
    putDoc({ ...base, meta: { ...base.meta, source: 'cloud', origin: 'live' } });
    const circular = await cloudCachePublish(fakeCloud(null), store.defaultStore, registry);
    assertEqual((circular.body as { error?: string }).error?.includes('not publishable'), true, 'cloud-sourced still refused as not publishable');
    clearDoc();
    assertEqual((await cloudCachePublish(fakeCloud(null), store.defaultStore, registry)).code, 404, 'nothing stored: still 404');
  } finally { clearDoc(); await app.close(); }
}

// ── 9. walk limits: a stale stored profile is not trusted for table sizes ──
async function walkLimitsIgnoreStale(): Promise<void> {
  const exact = (schema: unknown): BuiltCache => {
    const d = sectionsDoc({ CHORUS: 40 }, { source: 'editor-cache' }, { CHORUS: 40 });
    const meta: Record<string, unknown> = { ...d.meta };
    if (schema === undefined) delete meta.schema; else meta.schema = schema;
    return { ...d, meta } as BuiltCache;
  };
  const sizes: Array<number | undefined> = [];
  const walk = async (_t: unknown, opts: LiveWalkOptions): Promise<CacheRecord[]> => { sizes.push(opts.paramKnownSizeByBlock?.[78]); return seedRecords(); };
  const { app, registry } = await makeApp();
  try {
    putDoc(exact(CACHE_SCHEMA));
    // a legacy editor-cache import: only `replace` walks over it (no raw to merge a walk into)
    await deviceCache.startCacheBuild(store.defaultStore, registry, { replace: true, walkImpl: walk });
    await deviceCache.cacheBuildPromise(registry);
    assertEqual(sizes[0], 40, 'a current byte-exact profile still refines the walk (chorus 40)');

    putDoc(exact(undefined));
    await deviceCache.startCacheBuild(store.defaultStore, registry, { walkImpl: walk }); // no force: stale is rebuilt anyway
    await deviceCache.cacheBuildPromise(registry);
    assertEqual(sizes[1], 29, 'a stale byte-exact profile is ignored: the catalog stride (29) applies');
  } finally { clearDoc(); await app.close(); }
}

// ── 10. Fastify vs runtime-router parity for the changed endpoints ──
async function routerParity(): Promise<void> {
  const { app, registry } = await makeApp();
  const router = createRouter({ registry: registry as DeviceRegistry, store: store.defaultStore });
  // `pick` narrows the compared body: /device/cache/sources legitimately differs per twin in `candidates`
  // (the Fastify route scans the host disk, the browser twin cannot) — only the shared `persisted` flag is compared.
  const both = async (method: 'GET' | 'POST', url: string, body?: unknown, pick?: string[]) => {
    const res = await app.inject({ method, url, ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
    const routed = await router.handle(method, url, body !== undefined ? JSON.stringify(body) : undefined);
    assertEqual(routed.status, res.statusCode, `${method} ${url}: status parity`);
    const narrow = (j: Record<string, unknown>) => (pick ? Object.fromEntries(pick.map((k) => [k, j[k]])) : j);
    const a = narrow(JSON.parse(res.payload) as Record<string, unknown>);
    const r = narrow(JSON.parse(routed.body as string) as Record<string, unknown>);
    assertEqual(JSON.stringify(a), JSON.stringify(r), `${method} ${url}: body parity`);
    return a;
  };
  try {
    clearDoc();
    const empty = await both('GET', '/device/cache');
    assertEqual(empty.stale, false, 'parity: empty status not stale');
    assertEqual((await both('GET', '/device/cache/sources', undefined, ['persisted'])).persisted, false, 'parity: sources not persisted when empty');

    for (const c of STALE_STAMPS) {
      putDoc(docWithSchema(c.schema));
      const st = await both('GET', '/device/cache');
      assertEqual(st.stale, true, `parity ${c.label}: status stale`);
      assertEqual(st.staleReason, c.reason, `parity ${c.label}: staleReason`);
      assertEqual((await both('GET', '/device/cache/sources', undefined, ['persisted'])).persisted, false, `parity ${c.label}: sources not persisted`);
    }

    putDoc(docWithSchema(CACHE_SCHEMA));
    const cur = await both('GET', '/device/cache');
    assertEqual(cur.stale, false, 'parity: current status not stale');
    assertEqual((await both('GET', '/device/cache/sources', undefined, ['persisted'])).persisted, true, 'parity: current sources persisted');
    putDoc(currentV2Doc()); // profile v2: a complete local read-only walk is what makes a build "already"
    const built = await both('POST', '/device/cache/build', {});
    assertEqual(built.already, true, 'parity: a current profile is already built on both twins');
  } finally { clearDoc(); await app.close(); }
}

export async function runProfileSchemaTests(): Promise<void> {
  await verdictCases();
  await storeLookup();
  await runtimeApply();
  await statusReportsStale();
  await buildOverStale();
  await importAndSources();
  await cloudCheckAndPull();
  await cloudAsksForCurrentSchema();
  await cloudPublishGate();
  await walkLimitsIgnoreStale();
  await routerParity();
}
