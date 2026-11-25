// Editor-cache import (FORGEFX-31 / META-22) — mocked transport, NO hardware. Covers the filename
// parser, the happy-path import of a synthetic `.cache` byte buffer (built with the codec's own
// inverse encoder so the real DataView walker runs), the model-mismatch 409, the firmware-mismatch
// 409 + force override, the 501 cacheImport gate (AM4), and the disk-discovery scan over a faked fs.
// Mirrors device-cache.test.ts: mocked registry via __createRegistryForTest + app.inject().
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { join, sep } from 'node:path';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import * as store from '../../src/store.js';
import { parseEditorCacheFilename } from '../../src/services/editorCacheImport.js';
import { discoverEditorCaches, type DiscoveryFs } from '../../src/services/editorCacheDiscovery.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { am4SeedRecords, encodeCache, seedRecords } from '../helpers/cacheBytes.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const EDITOR_CACHE_IMPORT_CASE_COUNT = 7;

const FM3 = 0x11;
const KEY = '11_12p0'; // FM3 fw 12.0

/** fn 0x08 firmware-version reply: frame[6]=major, frame[7]=minor. */
function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

function makeMock(model: number, fw?: [number, number]): MockTransport {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (req[5] === 0x08 && fw) return [firmwareReply(model, ...fw)];
    return [];
  };
  return mock;
}

async function makeApp(model: number, fw?: [number, number]) {
  const mock = makeMock(model, fw);
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    // Load a persisted cache back out of the store so applyRuntimeCache can swap the profile after import.
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  const app = await buildApp(registry);
  return { app, registry, mock };
}

// ── synthetic .cache buffer ──────────────────────────────────────────────────────────────────────
// The 5 HW-seed families, each with a handful of its most-distinctive range-bearing FLOAT params, serialised
// with the inverse cache encoder so the real byte walker runs (test/helpers/cacheBytes.ts, shared with the
// contribution suites).
export { encodeCache };
export const CACHE_BYTES = encodeCache(seedRecords());

function importReq(app: Awaited<ReturnType<typeof makeApp>>['app'], name: string, force = false, bytes: Uint8Array = CACHE_BYTES) {
  return app.inject({
    method: 'POST',
    url: `/device/cache/import?name=${encodeURIComponent(name)}${force ? '&force=1' : ''}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(bytes)
  });
}

// ── 1. filename parsing ──
function filenameParsing(): void {
  const ok = parseEditorCacheFilename('effectDefinitions_11_12p0.cache');
  assert(ok != null, 'FM3 12.0 filename parses');
  assertEqual(ok!.model, 0x11, 'model 0x11');
  assertEqual(ok!.fwMajor, 12, 'fwMajor 12');
  assertEqual(ok!.fwMinor, 0, 'fwMinor 0');
  const fm9 = parseEditorCacheFilename('/some/dir/effectDefinitions_12_9p3.cache');
  assert(fm9 != null && fm9.model === 0x12 && fm9.fwMajor === 9 && fm9.fwMinor === 3, 'FM9 filename with a leading path parses');
  assertEqual(parseEditorCacheFilename('effectDefinitions_11_12p0.txt'), null, 'wrong extension → null');
  assertEqual(parseEditorCacheFilename('random.cache'), null, 'non-editor name → null');
  assertEqual(parseEditorCacheFilename('effectDefinitions_11.cache'), null, 'missing fw segment → null');
}

// ── 2. happy path import ──
async function happyPath(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const { app } = await makeApp(FM3, [12, 0]);
  try {
    const res = await importReq(app, 'effectDefinitions_11_12p0.cache');
    assertEqual(res.statusCode, 200, 'import 200');
    const body = res.json() as { imported: boolean; key: string; source: string; recordCount: number; firmware: string };
    assertEqual(body.imported, true, 'imported flag');
    assertEqual(body.key, KEY, 'persisted under 11_12p0');
    assertEqual(body.source, 'editor-cache', 'source marker');
    assertEqual(body.firmware, '12.0', 'firmware echoed');
    assertEqual(body.recordCount, seedRecords().length, 'recordCount matches the fixture');

    const doc = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(doc != null && !doc.deleted, 'cache doc persisted');
    const meta = (doc!.data as { meta: { source: string; importedAt?: string; recordCount: number } }).meta;
    assertEqual(meta.source, 'editor-cache', 'doc meta.source stamped editor-cache');
    assert(typeof meta.importedAt === 'string' && meta.importedAt.length > 0, 'doc meta.importedAt stamped');

    // status endpoint reflects it (runtime profile swap ran without throwing via loadDeviceCache)
    const st = (await app.inject({ method: 'GET', url: '/device/cache' })).json() as { key: string; exists: boolean; meta?: { recordCount: number } };
    assertEqual(st.key, KEY, 'status key');
    assertEqual(st.exists, true, 'status exists');
    assert(st.meta != null && st.meta.recordCount === seedRecords().length, 'status meta recordCount');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// ── 3. firmware mismatch → 409, force overrides ──
async function firmwareMismatch(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', KEY);
  const { app } = await makeApp(FM3, [12, 0]); // device on fw 12.0
  try {
    const bad = await importReq(app, 'effectDefinitions_11_11p0.cache'); // file for fw 11.0
    assertEqual(bad.statusCode, 409, 'firmware mismatch → 409');
    const body = bad.json() as { error: string; expected: string; got: string; overridable: boolean };
    assertEqual(body.error, 'firmware-mismatch', 'names firmware-mismatch');
    assertEqual(body.got, '11.0', 'reports the file firmware');
    assertEqual(body.overridable, true, 'flagged overridable');
    const rejected = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(rejected == null || rejected.deleted, 'nothing persisted on the rejected import');

    const forced = await importReq(app, 'effectDefinitions_11_11p0.cache', true);
    assertEqual(forced.statusCode, 200, 'force overrides the firmware mismatch');
    // persisted under the DEVICE's key (12.0) so the runtime swap picks it up
    const doc = store.defaultStore.getDoc('deviceCaches', KEY);
    assert(doc != null && !doc.deleted, 'forced import persisted under the device fw key');
    assertEqual((doc!.data as { firmware: string }).firmware, '11.0', 'provenance keeps the file firmware');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
  }
}

// ── 4. model mismatch → 409 ──
async function modelMismatch(): Promise<void> {
  const { app } = await makeApp(FM3, [12, 0]);
  try {
    const res = await importReq(app, 'effectDefinitions_12_12p0.cache'); // FM9 model byte
    assertEqual(res.statusCode, 409, 'model mismatch → 409');
    const body = res.json() as { error: string; expected: number; got: number };
    assertEqual(body.error, 'model-mismatch', 'names model-mismatch');
    assertEqual(body.expected, FM3, 'expected = attached model');
    assertEqual(body.got, 0x12, 'got = file model');
  } finally {
    await app.close();
  }
}

// ── 5. no cacheImport (gen-2) → 501; AM4 imports happily without a firmware read ──
async function noCacheImport(): Promise<void> {
  const { app } = await makeApp(0x07); // Axe-Fx II → cacheImport false
  try {
    const res = await importReq(app, 'effectDefinitions_07_11p0.cache');
    assertEqual(res.statusCode, 501, 'gen-2 import → 501 unsupported');
    assertEqual((res.json() as { capability: string }).capability, 'cacheImport', '501 names the capability');
  } finally {
    await app.close();
  }
}

// ── 5b. AM4 import: no fn 0x08 firmware → file firmware keys the doc, no 409 ──
function am4CacheBytes(): Uint8Array {
  // One distinctive range-bearing float per seed family (amp/drive/reverb/delay), straight from
  // AM4_CACHE_PARAMS so the vote anchors every AM4 seed. Same inverse encoder as the gen-3 fixture.
  return encodeCache(am4SeedRecords());
}

async function am4Import(): Promise<void> {
  store.defaultStore.delDoc('deviceCaches', '15_66p1');
  const { app } = await makeApp(0x15); // AM4: no firmware reply — fn 0x08 is gen-3 only
  try {
    const res = await importReq(app, 'effectDefinitions_15_66p1.cache', false, am4CacheBytes());
    assertEqual(res.statusCode, 200, 'AM4 import 200 without force (unknown device firmware is not a mismatch)');
    const body = res.json() as { key: string; firmware: string; source: string };
    assertEqual(body.key, '15_66p1', 'doc keyed by the FILE firmware');
    assertEqual(body.source, 'editor-cache', 'source marker');

    // status resolves the doc via the model-prefix fallback (no firmware on the registry)
    const st = (await app.inject({ method: 'GET', url: '/device/cache' })).json() as { key: string | null; exists: boolean };
    assertEqual(st.key, '15_66p1', 'status falls back to the newest model-prefixed doc');
    assertEqual(st.exists, true, 'status exists after AM4 import');
  } finally {
    store.defaultStore.delDoc('deviceCaches', '15_66p1');
    await app.close();
  }
}

// ── 6. disk discovery over a faked fs + endpoint shape ──
async function discovery(): Promise<void> {
  // Fake a macOS layout: ~/Library/Application Support/Fractal Audio/<Editor>/effectDefinitions_*.cache
  // The discovery code builds its paths with node:path's join, which uses the HOST's separator even
  // for a simulated platform, so the fake tree is keyed with the same join: a hard-coded '/' layout
  // would not match on Windows (backslashes) and the scan would find nothing.
  const home = '/home/tester';
  const base = join(home, 'Library', 'Application Support', 'Fractal Audio');
  const tree: Record<string, string[]> = {
    [base]: ['FM3-Edit', 'Axe-Edit III', 'notes.txt'],
    [join(base, 'FM3-Edit')]: ['effectDefinitions_11_12p0.cache', 'other.bin'],
    [join(base, 'Axe-Edit III')]: ['effectDefinitions_10_25p0.cache']
  };
  const fakeFs: DiscoveryFs = {
    existsSync: (p) => p === base,
    readdirSync: (p) => { const e = tree[p]; if (!e) throw new Error('ENOENT'); return e; },
    statSync: (p) => (p.endsWith('.cache') ? { size: 4096, mtimeMs: 1_700_000_000_000 } : (() => { throw new Error('EISDIR'); })())
  };
  const found = discoverEditorCaches({ platform: 'darwin', home, env: {}, fs: fakeFs });
  assertEqual(found.length, 2, 'two editor caches discovered');
  const fm3 = found.find((c) => c.model === 0x11);
  assert(fm3 != null, 'FM3 candidate found');
  assertEqual(fm3!.fwMajor, 12, 'FM3 candidate fw major');
  assertEqual(fm3!.file, 'effectDefinitions_11_12p0.cache', 'FM3 candidate file');
  assert(fm3!.path.endsWith(`${sep}${join('FM3-Edit', 'effectDefinitions_11_12p0.cache')}`), 'FM3 candidate path under its editor dir');
  assertEqual(fm3!.path, join(base, 'FM3-Edit', 'effectDefinitions_11_12p0.cache'), 'FM3 candidate path is the editor dir joined with the file');
  assertEqual(fm3!.size, 4096, 'FM3 candidate size');
  assert(found.some((c) => c.model === 0x10 && c.fwMajor === 25), 'Axe-Fx III candidate found');

  // endpoint shape (real fs — usually empty on a test box; assert the contract, not contents)
  const { app } = await makeApp(FM3, [12, 0]);
  try {
    const res = await app.inject({ method: 'GET', url: '/device/cache/sources' });
    assertEqual(res.statusCode, 200, 'sources 200');
    const body = res.json() as { persisted: boolean; candidates: unknown[] };
    assertEqual(typeof body.persisted, 'boolean', 'sources.persisted is a boolean');
    assert(Array.isArray(body.candidates), 'sources.candidates is an array');
  } finally {
    await app.close();
  }
}

export async function runEditorCacheImportTests(): Promise<void> {
  filenameParsing();
  await happyPath();
  await firmwareMismatch();
  await modelMismatch();
  await noCacheImport();
  await am4Import();
  await discovery();
}
