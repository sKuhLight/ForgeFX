// Cloud device-definition profiles (META-22) — mocked cloud + transport, NO hardware, NO supabase.
// Exercises services/cloudProfiles.ts directly over a __createRegistryForTest registry (the routes are
// one-liners over these functions) plus the AXIS_CLOUD-off route shape via app.inject. Covers: check
// hit/miss, pull (persist as source 'cloud' + runtime swap + check-result reuse), pull gates (501 on
// AM4, 404 no row), publish source mapping (live→live-walk, editor-cache→bytes), publish refusals
// (cloud-sourced 409, nothing persisted 404, signed-out 401 passthrough), disabled route shape.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import * as store from '../../src/store.js';
import { cloudCacheCheck, cloudCachePull, cloudCachePublish, type DeviceProfileCloud } from '../../src/services/cloudProfiles.js';
import { CACHE_SCHEMA } from 'forgefx-midi/cache';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const CLOUD_PROFILES_CASE_COUNT = 6;

const FM3 = 0x11;
const KEY = '11_12p0';

/** fn 0x08 firmware-version reply: frame[6]=major, frame[7]=minor. */
function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

async function makeRegistry(model: number, fw?: [number, number]) {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (req[5] === 0x08 && fw) return [firmwareReply(model, ...fw)];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  return registry;
}

/** A minimal plausible profile row as the store would serve it (shape validation is the edge fn's job;
 *  pull only requires an object with meta). */
function profileRow(source: 'live' | 'bytes' = 'live') {
  return {
    profile: { ranges: { DISTORT: {} }, rangeSections: {}, rosters: {}, enumOverrides: {}, cabIrs: {}, meta: { schema: CACHE_SCHEMA, recordCount: 42, source } },
    contentHash: 'abc123', source: source === 'live' ? 'live-walk' : 'editor-cache', recordCount: 42, createdAt: '2026-07-13T00:00:00Z'
  };
}

function fakeCloud(row: ReturnType<typeof profileRow> | null): DeviceProfileCloud & { gets: number; published: unknown[] } {
  const f = {
    gets: 0,
    published: [] as unknown[],
    async deviceProfileGet() { f.gets++; return row; },
    async deviceProfilePublish(body: unknown) { f.published.push(body); return { code: 201, body: { ok: true } }; }
  };
  return f;
}

// ── 1. check: hit + miss ──
async function checkHitMiss(): Promise<void> {
  const registry = await makeRegistry(FM3, [12, 0]);
  const hit = await cloudCacheCheck(fakeCloud(profileRow()), store.defaultStore, registry);
  assertEqual(hit.enabled, true, 'check enabled');
  assertEqual(hit.available, true, 'check available on a row');
  assertEqual(hit.meta?.recordCount, 42, 'check meta recordCount');
  const miss = await cloudCacheCheck(fakeCloud(null), store.defaultStore, registry);
  assertEqual(miss.available, false, 'check unavailable on no row');
  const off = await cloudCacheCheck(null, store.defaultStore, registry);
  assertEqual(off.enabled, false, 'check enabled:false without a cloud service');
}

// ── 2. pull: persists as source cloud + reuses the check fetch ──
async function pullPersists(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const registry = await makeRegistry(FM3, [12, 0]);
  const cloud = fakeCloud(profileRow());
  try {
    await cloudCacheCheck(cloud, store.defaultStore, registry); // primes the per-registry row cache
    const r = await cloudCachePull(cloud, store.defaultStore, registry);
    assertEqual(r.code, 200, 'pull 200');
    const body = r.body as { pulled: boolean; key: string; source: string; contentHash: string };
    assertEqual(body.pulled, true, 'pulled flag');
    assertEqual(body.key, KEY, 'persisted under the device key');
    assertEqual(body.source, 'cloud', 'source cloud');
    assertEqual(cloud.gets, 1, 'pull reused the check fetch (no second GET)');

    const doc = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(doc != null && !doc.deleted, 'doc persisted');
    const meta = (doc!.data as { meta: { source: string; origin?: string; pulledAt?: string; contentHash?: string } }).meta;
    assertEqual(meta.source, 'cloud', 'doc meta.source cloud');
    assertEqual(meta.origin, 'live', 'original kind kept as origin');
    assert(typeof meta.pulledAt === 'string', 'pulledAt stamped');
    assertEqual(meta.contentHash, 'abc123', 'contentHash kept');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
  }
}

// ── 3. pull gates: 404 no row, 501 AM4 ──
async function pullGates(): Promise<void> {
  const fm3 = await makeRegistry(FM3, [12, 0]);
  const none = await cloudCachePull(fakeCloud(null), store.defaultStore, fm3);
  assertEqual(none.code, 404, 'no cloud row → 404');
  const gen2 = await makeRegistry(0x07);
  const gated = await cloudCachePull(fakeCloud(profileRow()), store.defaultStore, gen2);
  assertEqual(gated.code, 501, 'gen-2 pull → 501');
  assertEqual((gated.body as { capability: string }).capability, 'cacheImport', '501 names cacheImport');

  // AM4 (cacheImport, but no firmware read and nothing persisted) → 503 no identity
  const am4 = await makeRegistry(0x15);
  const noid = await cloudCachePull(fakeCloud(profileRow()), store.defaultStore, am4);
  assertEqual(noid.code, 503, 'AM4 without persisted doc → 503 (no firmware identity)');

  // ...but once a doc is persisted under the FILE firmware, publish derives the identity from it
  store.defaultStore.putDoc('deviceCaches', '15_66p1', { ranges: {}, meta: { schema: CACHE_SCHEMA, recordCount: 1, source: 'editor-cache' } });
  const cloudPub = fakeCloud(null);
  const pub = await cloudCachePublish(cloudPub, store.defaultStore, am4);
  assertEqual(pub.code, 201, 'AM4 publish derives identity from the persisted key');
  const sent = cloudPub.published[0] as { model: number; firmware: string };
  assertEqual(sent.model, 0x15, 'published model 0x15');
  assertEqual(sent.firmware, '66.1', 'published firmware from the file key');
  store.defaultStore.delDoc('deviceCaches', '15_66p1');
}

// ── 4. publish: source mapping live/editor-cache ──
async function publishMapping(): Promise<void> {
  const registry = await makeRegistry(FM3, [12, 0]);
  try {
    // live-walk doc → API source live-walk, uploaded meta.source live
    store.defaultStore.putDoc('deviceCaches', KEY, { ranges: {}, meta: { schema: CACHE_SCHEMA, recordCount: 1, source: 'live' } });
    const cloud1 = fakeCloud(null);
    const r1 = await cloudCachePublish(cloud1, store.defaultStore, registry);
    assertEqual(r1.code, 201, 'live publish passes the fn result through');
    const b1 = cloud1.published[0] as { source: string; profile: { meta: { source: string } } };
    assertEqual(b1.source, 'live-walk', 'live → API source live-walk');
    assertEqual(b1.profile.meta.source, 'live', 'uploaded meta.source stays live');

    // editor-cache doc → API source editor-cache, uploaded meta.source normalized to bytes
    store.defaultStore.putDoc('deviceCaches', KEY, { ranges: {}, meta: { schema: CACHE_SCHEMA, recordCount: 1, source: 'editor-cache', importedAt: 'x' } });
    const cloud2 = fakeCloud(null);
    await cloudCachePublish(cloud2, store.defaultStore, registry);
    const b2 = cloud2.published[0] as { source: string; profile: { meta: { source: string } } };
    assertEqual(b2.source, 'editor-cache', 'editor-cache → API source editor-cache');
    assertEqual(b2.profile.meta.source, 'bytes', 'uploaded meta.source normalized to bytes');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
  }
}

// ── 5. publish refusals ──
async function publishRefusals(): Promise<void> {
  const registry = await makeRegistry(FM3, [12, 0]);
  try {
    store.defaultStore.delDoc('deviceCaches', KEY);
    const missing = await cloudCachePublish(fakeCloud(null), store.defaultStore, registry);
    assertEqual(missing.code, 404, 'nothing persisted → 404');

    store.defaultStore.putDoc('deviceCaches', KEY, { meta: { schema: CACHE_SCHEMA, source: 'cloud', origin: 'live' } });
    const circular = await cloudCachePublish(fakeCloud(null), store.defaultStore, registry);
    assertEqual(circular.code, 409, 'cloud-sourced profile → 409 (nothing new to share)');

    // signed-out: the cloud service itself answers 401 — passed through verbatim
    store.defaultStore.putDoc('deviceCaches', KEY, { meta: { schema: CACHE_SCHEMA, source: 'live' } });
    const signedOut: DeviceProfileCloud = {
      async deviceProfileGet() { return null; },
      async deviceProfilePublish() { return { code: 401, body: { error: 'not signed in' } }; }
    };
    const r = await cloudCachePublish(signedOut, store.defaultStore, registry);
    assertEqual(r.code, 401, '401 passthrough');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
  }
}

// ── 6. AXIS_CLOUD off: the route still answers with the non-erroring disabled shape ──
async function disabledRouteShape(): Promise<void> {
  const registry = await makeRegistry(FM3, [12, 0]);
  const app = await buildApp(registry); // tests run without AXIS_CLOUD=1 → else-branch route
  try {
    const res = await app.inject({ method: 'GET', url: '/device/cache/cloud' });
    assertEqual(res.statusCode, 200, 'disabled check 200');
    const body = res.json() as { enabled: boolean; available: boolean };
    assertEqual(body.enabled, false, 'enabled false');
    assertEqual(body.available, false, 'available false');
  } finally {
    await app.close();
  }
}

export async function runCloudProfilesTests(): Promise<void> {
  await checkHitMiss();
  await pullPersists();
  await pullGates();
  await publishMapping();
  await publishRefusals();
  await disabledRouteShape();
}
