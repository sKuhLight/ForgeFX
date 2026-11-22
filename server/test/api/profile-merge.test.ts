// Profile v2 merge on build / import / pull (M3 WP-F2) — mocked FM3 (fw 12.0), synthetic editor-cache bytes and
// canned walk records only, NO hardware. A build, an editor-cache import and a cloud pull add their raw source to
// the stored document of the key instead of replacing it; the codec derives the tables from all sources (an
// editor cache outranks a live walk, a local source a cloud one of the same kind). Covers: import then walk and
// walk then import (two sources, device units on the byte rows, byte rows otherwise intact, the same tables in
// either order); a pull never replaces a local byte source (409 `local-profile-better`, `replace: true` adopts
// it; a format-2 cloud doc merges, ranked below the local source; another firmware 409); `force` / `replace`; the
// `already` rule (only gaps a repeat walk can fix re-walk); unique source ids; the SSE `definitions` `merged` event;
// router-twin plumbing of `replace` through the real build route. Legacy (format-1) fixtures: a build never replaces
// a legacy editor-cache profile (`already`, force 409 `local-profile-better`, `no-raw` fix = re-import); a format-2
// pull never replaces a raw-less doc that outranks it; nothing from the wire is trusted for provenance (origins
// rewritten to cloud, an unreadable raw envelope stored as derived tables only, never widening walk bounds); raw
// sources are never dropped implicitly (a still-failing stale doc keeps every source) and a newer build's doc is never
// rewritten (409 `newer-profile`); byte-exactness per family (live guards for a walk-only family in a merged doc).
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { cloudCachePull, type DeviceProfileCloud } from '../../src/services/cloudProfiles.js';
import { loadStoredProfile } from '../../src/profileSchema.js';
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import { buildParamIndex } from '../../src/drivers/paramIndex.js';
import { createGen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import { CACHE_SCHEMA, RAW_FORMAT, type BuiltCache, type CacheRecord, type LiveWalkOptions, type ProfileDoc } from 'forgefx-midi/cache';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { encodeCache, seedRecords as cacheSeedRecords, SEED_TAGS } from '../helpers/cacheBytes.js';
import { FM3, STAMP, clone, editorCacheSource, familyRecords, liveSeedRecords, liveSource, profileDoc, widenTable } from '../helpers/profileDocs.js';
import { fakeCacheDoc } from './device-cache.test.js';

export const PROFILE_MERGE_CASE_COUNT = 12;

const KEY = '11_12p0'; // FM3 fw 12.0
const CACHE_BYTES = encodeCache(cacheSeedRecords());
const IMPORT_URL = '/device/cache/import?name=effectDefinitions_11_12p0.cache';

async function makeApp(fw: [number, number] = [12, 0]) {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(FM3, fw[0], fw[1])];
    return [];
  };
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  await registry.detect();
  const app = await buildApp(registry);
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  return { app, registry, mock, events, close: async () => { unsub(); await app.close(); } };
}
type Rig = Awaited<ReturnType<typeof makeApp>>;

const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);
const clearDoc = () => store.defaultStore.delDoc('deviceCaches', KEY);
const stored = () => store.defaultStore.getDoc('deviceCaches', KEY);
const storedData = () => { const d = stored(); return d && !d.deleted ? (d.data as ProfileDoc) : null; };
const kindsOf = (doc: ProfileDoc | null) => (doc?.raw?.sources ?? []).map((s) => `${s.kind}/${s.origin}`).join(',');
const mergedEvents = (events: DeviceEvent[]) => events.filter((e) => e.type === 'definitions' && e.reason === 'merged').length;

async function importBytes(r: Rig, query = ''): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = await r.app.inject({ method: 'POST', url: IMPORT_URL + query, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(CACHE_BYTES) });
  return { code: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** Run a build with a canned walk (live seed records with a device unit); returns the start result and walk count. */
async function build(r: Rig, opts: deviceCache.CacheBuildOptions = {}, records: () => CacheRecord[] = () => liveSeedRecords({ unit: 'dB' })) {
  let walks = 0;
  const walk = async (_t: unknown, _o: LiveWalkOptions): Promise<CacheRecord[]> => { walks++; return records(); };
  const res = await deviceCache.startCacheBuild(store.defaultStore, r.registry, { ...opts, walkImpl: walk });
  await deviceCache.cacheBuildPromise(r.registry);
  return { res, walks };
}

/** Every row of `before` is in `after` unchanged, apart from an attached device unit. */
function assertByteRowsIntact(after: ProfileDoc, before: ProfileDoc, label: string): number {
  let units = 0;
  for (const [fam, rows] of Object.entries(before.ranges)) {
    for (const [pid, row] of Object.entries(rows)) {
      const got = after.ranges[fam]?.[Number(pid)] as Record<string, unknown> | undefined;
      assert(got !== undefined, `${label}: ${fam}/${pid} still there`);
      const { unit, ...rest } = got!;
      if (unit !== undefined) units++;
      assertEqual(JSON.stringify(rest), JSON.stringify(row), `${label}: ${fam}/${pid} unchanged apart from the unit`);
    }
  }
  return units;
}

// ── 1. import, then a walk: two sources, units on the byte rows, byte rows intact ──
async function importThenWalk(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    const imp = await importBytes(r);
    assertEqual(imp.code, 200, 'import 200');
    assertEqual(imp.body.merged, false, 'the first import merges nothing');
    assertEqual(mergedEvents(r.events), 0, 'no merged event for a first import');
    const byteOnly = clone(storedData()!);
    assertEqual(kindsOf(byteOnly), 'editor-cache/local', 'one source after the import');

    const { res, walks } = await build(r);
    assertEqual((res.body as { started?: boolean }).started, true, 'an editor-cache doc has no live source: the build walks');
    assertEqual(walks, 1, 'walked once');
    const merged = storedData()!;
    assertEqual(kindsOf(merged), 'editor-cache/local,live-readonly/local', 'two sources');
    assertEqual(merged.meta.source, 'editor-cache', 'the editor cache stays the best source');
    const units = assertByteRowsIntact(merged, byteOnly, 'import then walk');
    assert(units > 0, `device units attached to the byte rows (${units})`);
    assertEqual(merged.coverage.units, units, 'coverage counts the units');
    const byteId = merged.raw.sources[0]!.id;
    assertEqual(merged.provenance.existence.DISTORT, byteId, 'existence facts from the editor cache');
    assert((merged.provenance.units[merged.raw.sources[1]!.id] ?? 0) > 0, 'the walk is credited with the units');
    assertEqual(merged.provenance.conflicts.length, 0, 'no conflicts between equal tables');
    assertEqual(mergedEvents(r.events), 1, 'definitions/merged emitted for the build that merged');
    const done = r.events.filter((e) => e.type === 'cacheBuild' && e.phase === 'done');
    assert(done.length >= 2, 'the import and the build each end with cacheBuild done');
    // status reports both sources and the coverage
    const st = (await r.app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    assertEqual(st.sources?.map((s) => s.kind).join(','), 'editor-cache,live-readonly', 'status: the sources');
    assertEqual(st.coverage?.units, units, 'status: the coverage');
  } finally { clearDoc(); await r.close(); }
}

// ── 2. a walk, then an import: the same tables in either order ──
async function walkThenImport(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    const { walks } = await build(r);
    assertEqual(walks, 1, 'walked');
    assertEqual(kindsOf(storedData()), 'live-readonly/local', 'one live source');
    assertEqual(storedData()!.meta.source, 'live', 'a live doc');
    const imp = await importBytes(r);
    assertEqual(imp.code, 200, 'import 200');
    assertEqual(imp.body.merged, true, 'the import merged into the walk');
    const sources = imp.body.sources as Array<{ kind: string }>;
    assertEqual(sources.map((s) => s.kind).join(','), 'live-readonly,editor-cache', 'the import answers both sources');
    const walkFirst = storedData()!;
    assertEqual(walkFirst.meta.source, 'editor-cache', 'the editor cache now provides the existence facts');
    assertEqual(walkFirst.provenance.existence.DISTORT, walkFirst.raw.sources.find((s) => s.kind === 'editor-cache')!.id, 'existence from the editor cache');
    // the other order gives the same derived tables
    clearDoc();
    await importBytes(r);
    await build(r);
    const importFirst = storedData()!;
    assertEqual(JSON.stringify(walkFirst.ranges), JSON.stringify(importFirst.ranges), 'same ranges in either order');
    assertEqual(JSON.stringify(walkFirst.rangeSections), JSON.stringify(importFirst.rangeSections), 'same sections in either order');
    assertEqual(JSON.stringify(walkFirst.enumOverrides), JSON.stringify(importFirst.enumOverrides), 'same labels in either order');
  } finally { clearDoc(); await r.close(); }
}

// ── 3. a pull never replaces a local byte source ──
function cloudOf(profile: unknown): DeviceProfileCloud & { gets: number } {
  const c = {
    gets: 0,
    async deviceProfileGet() { c.gets++; return { profile, contentHash: 'h1', source: 'editor-cache', recordCount: 30, createdAt: STAMP }; },
    async deviceProfilePublish() { return { code: 201, body: {} }; }
  };
  return c;
}
async function pullNeverReplacesLocal(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    // a format-1 cloud row (what publish uploads until M4) over a local editor-cache import
    const legacyRow = { ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'bytes' } };
    await importBytes(r);
    const rev0 = stored()!.rev;
    let res = await cloudCachePull(cloudOf(legacyRow), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'a derived-only cloud profile over a usable local one: 409');
    assertEqual((res.body as { error?: string }).error, 'local-profile-better', 'local-profile-better');
    assertEqual((res.body as { local?: { source?: string; format?: number } }).local?.format, 2, 'the body names the local doc');
    assertEqual(stored()!.rev, rev0, 'the local doc is untouched');
    // replace: true adopts it (the old behaviour)
    res = await cloudCachePull(cloudOf(legacyRow), store.defaultStore, r.registry, { replace: true });
    assertEqual(res.code, 200, 'replace: true pulls');
    assertEqual(storedData()!.meta.source, 'cloud', 'the cloud profile replaced the doc');
    assertEqual((storedData()!.meta as { origin?: string }).origin, 'bytes', 'its build kind in origin');
    // with nothing usable stored, a derived-only row is adopted without replace
    clearDoc();
    res = await cloudCachePull(cloudOf(legacyRow), store.defaultStore, r.registry);
    assertEqual(res.code, 200, 'nothing stored: adopted');

    // a format-2 cloud doc contributes its raw sources (re-tagged cloud), ranked below the local source
    clearDoc();
    await importBytes(r);
    const local = storedData()!;
    const cloudDoc = profileDoc([await editorCacheSource(cacheSeedRecords(), { capturedAt: local.raw.sources[0]!.capturedAt! })]);
    res = await cloudCachePull(cloudOf(cloudDoc), store.defaultStore, r.registry);
    assertEqual(res.code, 200, 'a format-2 cloud doc merges');
    assertEqual((res.body as { merged?: boolean }).merged, true, 'merged with the local source');
    const merged = storedData()!;
    assertEqual(kindsOf(merged), 'editor-cache/local,editor-cache/cloud', 'both sources, the cloud one re-tagged');
    const ids = merged.raw.sources.map((s) => s.id);
    assertEqual(new Set(ids).size, 2, `source ids stay unique (${ids.join(', ')})`);
    assertEqual(ids[0], local.raw.sources[0]!.id, 'the local source keeps its id');
    assertEqual(merged.provenance.existence.DISTORT, ids[0], 'the local source keeps winning');
    assertEqual(merged.meta.source, 'editor-cache', 'still a local editor-cache doc');
    assertEqual(deviceCache.hasLocalByteSource(merged), true, 'the walk limits still see the local editor cache');
    // a cloud source of another firmware is refused
    const rev1 = stored()!.rev;
    const foreign = profileDoc([await editorCacheSource(cacheSeedRecords(), { firmware: '12.1' })], { firmware: '12.1' });
    res = await cloudCachePull(cloudOf(foreign), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'another firmware: 409');
    assertEqual((res.body as { error?: string }).error, 'firmware-differs', 'firmware-differs');
    assertEqual(stored()!.rev, rev1, 'nothing stored');
  } finally { clearDoc(); await r.close(); }
}

// ── 4. force and replace ──
async function forceAndReplace(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    await importBytes(r);
    await build(r);
    assertEqual(kindsOf(storedData()), 'editor-cache/local,live-readonly/local', 'editor cache + walk');
    const liveId = storedData()!.raw.sources[1]!.id;

    // a complete local read-only walk is there: `already`, no walk
    let b = await build(r);
    assertEqual((b.res.body as { already?: boolean }).already, true, 'already');
    assertEqual(b.walks, 0, 'no walk');
    // force walks anyway and REPLACES the walk of its own kind (one source per kind and origin); the import stays
    await new Promise((res) => setTimeout(res, 5)); // a later capture stamp
    b = await build(r, { force: true });
    assertEqual(b.walks, 1, 'force walks');
    const forced = storedData()!;
    assertEqual(kindsOf(forced), 'editor-cache/local,live-readonly/local', 'still one walk next to the import');
    assert(forced.raw.sources[1]!.id !== liveId, 'the walk is the new one');
    // replace: true drops every stored source (the old replace behaviour)
    b = await build(r, { replace: true });
    assertEqual(b.walks, 1, 'replace walks');
    assertEqual(kindsOf(storedData()), 'live-readonly/local', 'only the new walk');
    // an import merges ...
    let imp = await importBytes(r);
    assertEqual(imp.body.merged, true, 'an import merges');
    assertEqual(kindsOf(storedData()), 'live-readonly/local,editor-cache/local', 'walk + import');
    // ... unless ?replace=1
    imp = await importBytes(r, '&replace=1');
    assertEqual(imp.code, 200, 'import with replace');
    assertEqual(imp.body.merged, false, 'nothing merged');
    assertEqual(kindsOf(storedData()), 'editor-cache/local', 'only the import');
    // a re-import replaces the editor-cache source of the same origin, it does not pile up
    imp = await importBytes(r);
    assertEqual(kindsOf(storedData()), 'editor-cache/local', 'a re-import keeps one editor-cache source');
  } finally { clearDoc(); await r.close(); }
}

// ── 5. the `already` rule ──
async function alreadyRule(): Promise<void> {
  const byteSrc = await editorCacheSource();
  const cases: Array<{ label: string; doc: () => unknown; mode?: 'read-only' | 'full'; already: boolean }> = [
    { label: 'a legacy format-1 doc (no raw source to go by)', doc: () => fakeCacheDoc(), already: false },
    { label: 'an editor-cache source only', doc: () => profileDoc([byteSrc]), already: false },
    { label: 'a complete local read-only walk', doc: () => profileDoc([liveSource(liveSeedRecords())]), already: true },
    { label: 'a complete local read-only walk next to an editor cache', doc: () => profileDoc([byteSrc, liveSource(liveSeedRecords())]), already: true },
    { label: 'a local read-only walk with unresolved replies (blocking gap)', doc: () => profileDoc([liveSource(liveSeedRecords(), { stats: { unresolvedReplies: 2 } })]), already: false },
    { label: 'a local FULL walk (a read-only request)', doc: () => profileDoc([liveSource(liveSeedRecords(), { kind: 'live-full' })]), already: true },
    { label: 'a cloud read-only walk only', doc: () => profileDoc([liveSource(liveSeedRecords(), { origin: 'cloud' })]), already: false },
    { label: 'a stale doc', doc: () => ({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, schema: CACHE_SCHEMA + 1 } }), already: false }
  ];
  const r = await makeApp();
  try {
    for (const c of cases) {
      clearDoc();
      putDoc(c.doc());
      const b = await build(r, c.mode ? { mode: c.mode } : {});
      assertEqual((b.res.body as { already?: boolean }).already === true, c.already, `${c.label}: already ${c.already}`);
      assertEqual(b.walks, c.already ? 0 : 1, `${c.label}: walks`);
    }
  } finally { clearDoc(); await r.close(); }
  // only gaps a repeat walk of the same kind and scope can fix make a build walk again: on a firmware newer than the
  // catalog a live-only doc has blocking `high-ids` / `rosters` / `blocks-above-160` gaps, whose fixes are the
  // extended read or an editor-cache import — the same standard walk would leave them open
  const KEY13 = '11_13p0';
  const r13 = await makeApp([13, 0]);
  try {
    store.defaultStore.delDoc('deviceCaches', KEY13);
    const live13 = profileDoc([liveSource(liveSeedRecords(), { firmware: '13.0' })], { firmware: '13.0' });
    const blocking = live13.coverage.gaps.filter((g) => g.blocking);
    assert(blocking.length > 0 && blocking.every((g) => !g.fix.includes('read-from-device')), `fixture: blocking gaps without read-from-device (${blocking.map((g) => g.kind).join(',')})`);
    store.defaultStore.putDoc('deviceCaches', KEY13, live13);
    let walks = 0;
    const res = await deviceCache.startCacheBuild(store.defaultStore, r13.registry, { walkImpl: async () => { walks++; return liveSeedRecords(); } });
    await deviceCache.cacheBuildPromise(r13.registry);
    assertEqual((res.body as { already?: boolean }).already, true, 'blocking gaps a repeat walk cannot fix: already');
    assertEqual(walks, 0, 'blocking gaps a repeat walk cannot fix: no walk');
    // ... while a blocking gap a repeat walk can fix (unresolved replies) still walks on the same firmware
    store.defaultStore.putDoc('deviceCaches', KEY13, profileDoc([liveSource(liveSeedRecords(), { firmware: '13.0', stats: { unresolvedReplies: 1 } })], { firmware: '13.0' }));
    const res2 = await deviceCache.startCacheBuild(store.defaultStore, r13.registry, { walkImpl: async () => { walks++; return liveSeedRecords(); } });
    await deviceCache.cacheBuildPromise(r13.registry);
    assertEqual((res2.body as { started?: boolean }).started, true, 'unresolved replies: the build walks');
    assertEqual(walks, 1, 'unresolved replies: walked once');
  } finally { store.defaultStore.delDoc('deviceCaches', KEY13); await r13.close(); }
}

// ── 6. a walk with unresolved replies is kept (blocking gap) and the next build merges over it ──
async function unresolvedKept(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  try {
    const lossy = async (_t: unknown, _o: LiveWalkOptions) => ({
      records: liveSeedRecords(), queries: 40, enumLabels: 0, lostReplies: 3, recoveredReplies: 1, unresolvedReplies: 2,
      placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 0 }
    });
    await deviceCache.startCacheBuild(store.defaultStore, r.registry, { walkImpl: lossy });
    await deviceCache.cacheBuildPromise(r.registry);
    const doc = storedData()!;
    assert(doc !== null, 'a walk with unresolved replies is persisted');
    const src = doc.raw.sources[0]!;
    assert(src.kind === 'live-readonly' && src.walk.unresolvedReplies === 2 && src.walk.lostReplies === 3, 'its statistics are kept with the source');
    const gap = doc.coverage.gaps.find((g) => g.kind === 'unresolved-replies');
    assert(gap?.blocking === true && gap.count === 2, 'a blocking unresolved-replies gap');
    assertEqual(doc.coverage.complete, false, 'not complete');
    // not `already`: the next build walks again and its clean walk replaces the lossy one
    const b = await build(r);
    assertEqual(b.walks, 1, 'the next build walks');
    assertEqual(storedData()!.coverage.complete, true, 'complete after a clean walk');
    assertEqual(kindsOf(storedData()), 'live-readonly/local', 'one walk');
  } finally { clearDoc(); await r.close(); }
}

// ── 7. router twin: `replace` reaches the build, the import and the pull ──
async function routerPlumbing(): Promise<void> {
  clearDoc();
  const r = await makeApp();
  const cloud = cloudOf({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'bytes' } });
  const router = createRouter({ registry: r.registry as DeviceRegistry, store: store.defaultStore, cloud: cloud as never });
  // a route cannot pass a walk: the test seam gives both twins' build route a canned walk (a device unit on every row)
  let walks = 0;
  deviceCache.__setDefaultWalkForTest(r.registry, async () => { walks++; return liveSeedRecords({ unit: 'dB' }); });
  const routeBuild = async (via: 'app' | 'router', body: Record<string, unknown>) => {
    const res = via === 'app'
      ? await r.app.inject({ method: 'POST', url: '/device/cache/build', payload: body }).then((x) => ({ status: x.statusCode, body: x.payload }))
      : await router.handle('POST', '/device/cache/build', JSON.stringify(body)).then((x) => ({ status: x.status, body: x.body as string }));
    await deviceCache.cacheBuildPromise(r.registry);
    return { status: res.status, body: JSON.parse(res.body) as { started?: boolean; already?: boolean; error?: string } };
  };
  try {
    await importBytes(r);
    // pull over a usable local doc: 409 on the router twin, 200 with replace
    let res = await router.handle('POST', '/device/cache/cloud/pull', '{}');
    assertEqual(res.status, 409, 'router pull: 409 local-profile-better');
    assertEqual((JSON.parse(res.body as string) as { error?: string }).error, 'local-profile-better', 'router pull: error');
    res = await router.handle('POST', '/device/cache/cloud/pull', JSON.stringify({ replace: true }));
    assertEqual(res.status, 200, 'router pull with replace: 200');
    assertEqual(storedData()!.meta.source, 'cloud', 'router pull with replace adopted the cloud doc');
    // import with ?replace=1 on the router twin
    await build(r);
    res = await router.handle('POST', IMPORT_URL + '&replace=1', CACHE_BYTES);
    assertEqual(res.status, 200, 'router import 200');
    assertEqual(kindsOf(storedData()), 'editor-cache/local', 'router import with replace: only the import');
    res = await router.handle('POST', IMPORT_URL, CACHE_BYTES);
    assertEqual((JSON.parse(res.body as string) as { merged?: boolean }).merged, false, 'router re-import: one editor-cache source, nothing else to merge');

    // the BUILD route on both twins, really walking (the seam's canned walk): a plain build merges next to the import,
    // `replace: true` replaces the whole doc with the walk alone
    for (const via of ['app', 'router'] as const) {
      clearDoc();
      await importBytes(r);
      const w0 = walks;
      let b = await routeBuild(via, {});
      assertEqual(b.status, 200, `${via} build: 200`);
      assertEqual(b.body.started, true, `${via} build: started`);
      assertEqual(walks, w0 + 1, `${via} build: walked through the route`);
      assertEqual(kindsOf(storedData()), 'editor-cache/local,live-readonly/local', `${via} build: merged next to the import`);
      b = await routeBuild(via, {});
      assertEqual(b.body.already, true, `${via} build again: already`);
      assertEqual(walks, w0 + 1, `${via} build again: no walk`);
      b = await routeBuild(via, { replace: true });
      assertEqual(b.body.started, true, `${via} build with replace: started although complete`);
      assertEqual(walks, w0 + 2, `${via} build with replace: walked`);
      assertEqual(kindsOf(storedData()), 'live-readonly/local', `${via} build with replace: the walk alone replaced the doc`);
    }
    // and the short-circuit answers are byte-identical on both twins
    putDoc(profileDoc([liveSource(liveSeedRecords())]));
    const appBuild = await r.app.inject({ method: 'POST', url: '/device/cache/build', payload: {} });
    const routed = await router.handle('POST', '/device/cache/build', '{}');
    assertEqual(routed.status, appBuild.statusCode, 'build: status parity');
    assertEqual(routed.body, appBuild.payload, 'build: body parity');
    assertEqual((appBuild.json() as { already?: boolean }).already, true, 'build: already on both twins');
  } finally { deviceCache.__setDefaultWalkForTest(r.registry, null); clearDoc(); await r.close(); }
}

// ── legacy (format-1) fixtures: what an older build stored ──
/** A legacy editor-cache import (format 1, derived tables only, `meta.source: 'editor-cache'`). */
const legacyLocalBytes = () => ({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'editor-cache', importedAt: STAMP } });
/** A legacy live walk (format 1, `meta.source: 'live'`). */
const legacyLocalLive = () => fakeCacheDoc();
/** A legacy pulled cloud profile of byte origin (format 1, `meta.source: 'cloud'`, `origin: 'bytes'`). */
const legacyCloudBytes = () => ({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'cloud', origin: 'bytes' } });
const errorOf = (body: unknown) => (body as { error?: string }).error;

// ── 8. H1: a build never replaces a legacy editor-cache profile (no raw to merge a walk into) ──
async function legacyBytesVsBuild(): Promise<void> {
  const r = await makeApp();
  const router = createRouter({ registry: r.registry as DeviceRegistry, store: store.defaultStore });
  try {
    for (const [label, make] of [['a legacy local editor-cache import', legacyLocalBytes], ['a legacy cloud profile of byte origin', legacyCloudBytes]] as const) {
      clearDoc();
      putDoc(make());
      const rev0 = stored()!.rev;
      // a plain build: already built (byte data a walk cannot improve), nothing walked or written
      let b = await build(r);
      assertEqual((b.res.body as { already?: boolean }).already, true, `${label}: build → already`);
      assertEqual(b.walks, 0, `${label}: build → no walk`);
      assertEqual(stored()!.rev, rev0, `${label}: build → nothing written`);
      // force: 409 local-profile-better, nothing walked or written
      b = await build(r, { force: true });
      assertEqual(b.res.code, 409, `${label}: force → 409`);
      assertEqual(errorOf(b.res.body), 'local-profile-better', `${label}: force → local-profile-better`);
      assertEqual((b.res.body as { local?: { format?: number } }).local?.format, 1, `${label}: the body names the legacy doc`);
      assertEqual(b.walks, 0, `${label}: force → no walk`);
      assertEqual(stored()!.rev, rev0, `${label}: force → nothing written`);
      // status: the no-raw gap offers only the re-import (a device read cannot improve the doc)
      const st = (await r.app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
      const noRaw = st.coverage?.gaps.find((g) => g.kind === 'no-raw');
      assertEqual(JSON.stringify(noRaw?.fix), JSON.stringify(['import-editor-cache']), `${label}: no-raw fix is the re-import only`);
      // router twin: the same 409
      const appForce = await r.app.inject({ method: 'POST', url: '/device/cache/build', payload: { force: true } });
      const routedForce = await router.handle('POST', '/device/cache/build', JSON.stringify({ force: true }));
      assertEqual(appForce.statusCode, 409, `${label}: app force → 409`);
      assertEqual(routedForce.status, appForce.statusCode, `${label}: router force → same status`);
      assertEqual(routedForce.body, appForce.payload, `${label}: router force → same body`);
      // replace: true walks and replaces it (the old behaviour)
      b = await build(r, { replace: true });
      assertEqual(b.walks, 1, `${label}: replace → walked`);
      assertEqual(kindsOf(storedData()), 'live-readonly/local', `${label}: replace → the walk replaced it`);
    }
    // a legacy LIVE walk ranks like the new walk: the build walks and writes a format-2 doc in its place
    clearDoc();
    putDoc(legacyLocalLive());
    let st = (await r.app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    assertEqual(JSON.stringify(st.coverage?.gaps.find((g) => g.kind === 'no-raw')?.fix), JSON.stringify(['import-editor-cache', 'read-from-device']), 'a legacy live doc: both fixes');
    const b = await build(r);
    assertEqual(b.walks, 1, 'a legacy live doc: the build walks');
    assertEqual(kindsOf(storedData()), 'live-readonly/local', 'a legacy live doc: replaced by the format-2 walk');
    // the re-import is the fix for a legacy editor-cache doc: it replaces it with a format-2 doc
    clearDoc();
    putDoc(legacyLocalBytes());
    const imp = await importBytes(r);
    assertEqual(imp.code, 200, 'import over a legacy editor-cache doc: 200');
    assertEqual(kindsOf(storedData()), 'editor-cache/local', 'import over a legacy editor-cache doc: format 2 now');
    st = (await r.app.inject({ method: 'GET', url: '/device/cache' })).json() as deviceCache.CacheStatus;
    assertEqual(st.coverage?.gaps.some((g) => g.kind === 'no-raw'), false, 'no no-raw gap after the re-import');
  } finally { clearDoc(); await r.close(); }
}

// ── 9. H2: a format-2 cloud pull never replaces a raw-less local doc that outranks it ──
async function legacyVsFormat2Pull(): Promise<void> {
  const r = await makeApp();
  const cloudBytesDoc = profileDoc([await editorCacheSource()]);
  const cloudLiveDoc = profileDoc([liveSource(liveSeedRecords())]);
  try {
    // a legacy local editor-cache import outranks every cloud source: 409, untouched; replace adopts the cloud doc
    clearDoc();
    putDoc(legacyLocalBytes());
    let rev0 = stored()!.rev;
    let res = await cloudCachePull(cloudOf(cloudBytesDoc), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'cloud editor cache over a legacy local editor cache: 409');
    assertEqual(errorOf(res.body), 'local-profile-better', 'local-profile-better');
    assertEqual((res.body as { local?: { source?: string; format?: number } }).local?.format, 1, 'the body names the legacy doc');
    assertEqual(stored()!.rev, rev0, 'the legacy doc is untouched');
    res = await cloudCachePull(cloudOf(cloudLiveDoc), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'a cloud walk over a legacy local editor cache: 409');
    assertEqual(stored()!.rev, rev0, 'still untouched');
    res = await cloudCachePull(cloudOf(cloudBytesDoc), store.defaultStore, r.registry, { replace: true });
    assertEqual(res.code, 200, 'replace: true adopts the cloud doc');
    assertEqual(kindsOf(storedData()), 'editor-cache/cloud', 'the cloud source alone');
    // a legacy local walk: a cloud walk ranks below it (409), a cloud editor cache above it (adopted)
    clearDoc();
    putDoc(legacyLocalLive());
    rev0 = stored()!.rev;
    res = await cloudCachePull(cloudOf(cloudLiveDoc), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'a cloud walk over a legacy local walk: 409');
    assertEqual(stored()!.rev, rev0, 'the legacy walk is untouched');
    res = await cloudCachePull(cloudOf(cloudBytesDoc), store.defaultStore, r.registry);
    assertEqual(res.code, 200, 'a cloud editor cache over a legacy local walk: adopted (byte data outranks a walk)');
    assertEqual(kindsOf(storedData()), 'editor-cache/cloud', 'the cloud editor-cache source');
  } finally { clearDoc(); await r.close(); }
}

// ── 10. H3: nothing from the wire is trusted for provenance (origins, unreadable raw) ──
async function untrustedCloudRows(): Promise<void> {
  const r = await makeApp();
  // a widened DISTORT table (150 slots, catalog 144) in an editor-cache source that claims to be LOCAL
  const wide = widenTable(cacheSeedRecords(), SEED_TAGS.DISTORT!, 150, 'DISTORT');
  const forged = profileDoc([await editorCacheSource(wide)]);
  const catalog = deviceCache.walkBlockLimits(FM3, 'full', null);
  assertEqual(catalog.knownSize[58], 144, 'fixture: the catalog DISTORT size');
  const limitsOfStored = () => {
    const s = loadStoredProfile(store.defaultStore, KEY);
    return deviceCache.walkBlockLimits(FM3, 'full', s.state === 'usable' ? s.profile : null);
  };
  try {
    // (a) a stored format-2 doc whose raw envelope this build cannot read is never trusted for bounds or hints
    for (const [label, format] of [['a newer raw format', RAW_FORMAT + 1], ['a malformed raw format', '1']] as const) {
      const unreadable = clone(forged) as unknown as { raw: { format: unknown } };
      unreadable.raw.format = format;
      assertEqual(deviceCache.hasLocalByteSource(unreadable as unknown as BuiltCache), false, `${label}: hasLocalByteSource false`);
      assertEqual(deviceCache.localByteSource(unreadable as unknown as BuiltCache, FM3), null, `${label}: localByteSource null`);
      assertEqual(deviceCache.walkBlockLimits(FM3, 'full', unreadable as unknown as BuiltCache).knownSize[58], 144, `${label}: the catalog DISTORT size`);
    }
    assertEqual(deviceCache.walkBlockLimits(FM3, 'full', forged).knownSize[58], 150, 'fixture: a readable local source does widen it');

    // (b) a pulled row whose raw envelope this build cannot read: stored as derived tables only, never verbatim
    for (const [label, format] of [['a newer raw format', RAW_FORMAT + 1], ['a malformed raw format', '1']] as const) {
      clearDoc();
      const row = clone(forged) as unknown as { raw: { format: unknown } };
      row.raw.format = format;
      const res = await cloudCachePull(cloudOf(row), store.defaultStore, r.registry);
      assertEqual(res.code, 200, `${label}: pulled (its derived tables are usable)`);
      const doc = storedData() as unknown as Record<string, unknown> & { meta: Record<string, unknown> };
      for (const k of ['raw', 'sections', 'blockMap', 'provenance', 'coverage']) assert(!(k in doc), `${label}: no ${k} stored`);
      for (const k of ['format', 'sources', 'derivedWith', 'derivedRevision', 'derivedAt']) assert(!(k in doc.meta), `${label}: no meta.${k} stored`);
      assertEqual(doc.meta.source, 'cloud', `${label}: a cloud profile`);
      assertEqual(deviceCache.hasLocalByteSource(doc as unknown as BuiltCache), false, `${label}: no local byte source`);
      assertEqual(limitsOfStored().knownSize[58], 144, `${label}: the walk keeps the catalog DISTORT size`);
      assertEqual(limitsOfStored().bound[58], 175, `${label}: and the catalog DISTORT ceiling`);
    }

    // (c) a readable row: every source origin is rewritten to 'cloud', whatever it claims ('local', 'file')
    for (const origin of ['local', 'file'] as const) {
      clearDoc();
      const row = clone(forged);
      for (const s of row.raw.sources) (s as { origin: string }).origin = origin;
      const res = await cloudCachePull(cloudOf(row), store.defaultStore, r.registry);
      assertEqual(res.code, 200, `claimed ${origin}: pulled`);
      assertEqual(kindsOf(storedData()), 'editor-cache/cloud', `claimed ${origin}: stored as a cloud source`);
      assertEqual(deviceCache.hasLocalByteSource(storedData()), false, `claimed ${origin}: no local byte source`);
      assertEqual(limitsOfStored().knownSize[58], 144, `claimed ${origin}: the catalog DISTORT size`);
    }
  } finally { clearDoc(); await r.close(); }
}

// ── 11. M1: raw sources are never dropped implicitly; a newer build's doc is never rewritten ──
async function rawSourcesNeverDropped(): Promise<void> {
  const r = await makeApp();
  // a format-2 doc whose only source (a cloud walk without the seed families) does not derive: stale
  const failing = clone(profileDoc([liveSource(liveSeedRecords(), { origin: 'cloud' })])) as unknown as ProfileDoc & { meta: Record<string, unknown> };
  failing.raw.sources[0]!.records = familyRecords('CHORUS', 78) as never;
  failing.meta.derivedRevision = 0; // must re-derive, and cannot
  const cloudId = failing.raw.sources[0]!.id;
  try {
    clearDoc();
    putDoc(clone(failing));
    assertEqual(loadStoredProfile(store.defaultStore, KEY).state, 'stale', 'fixture: stale');
    // a build keeps the stale doc's source and stores the walk next to it; still not derivable → stays stale, error
    const errs0 = r.events.filter((e) => e.type === 'cacheBuild' && e.phase === 'error').length;
    const b = await build(r);
    assertEqual(b.walks, 1, 'the build walks');
    assertEqual(kindsOf(storedData()), 'live-readonly/cloud,live-readonly/local', 'both sources stored');
    assertEqual(storedData()!.raw.sources[0]!.id, cloudId, 'the stale source keeps its id');
    const s = loadStoredProfile(store.defaultStore, KEY);
    assert(s.state === 'stale' && s.check.reason === 'derivation-failed', 'still stale: derivation-failed');
    const errs = r.events.filter((e) => e.type === 'cacheBuild' && e.phase === 'error');
    assertEqual(errs.length, errs0 + 1, 'the build ends in a terminal error');
    assert(String((errs.at(-1) as { error?: string }).error).startsWith('derivation-failed'), 'naming derivation-failed');
    // an import: kept next to them, 422 derivation-failed with stored: true
    const imp = await importBytes(r);
    assertEqual(imp.code, 422, 'import over a still-failing doc: 422');
    assertEqual(imp.body.error, 'derivation-failed', 'derivation-failed');
    assertEqual(imp.body.stored, true, 'stored: true');
    assertEqual(kindsOf(storedData()), 'live-readonly/cloud,live-readonly/local,editor-cache/local', 'all three sources stored');
    // a pull of a format-2 cloud doc: the same (its source replaces the stored cloud walk of its slot, which derives)
    // — here a cloud editor cache, so the stored cloud WALK stays and the doc still fails
    let res = await cloudCachePull(cloudOf(profileDoc([await editorCacheSource()])), store.defaultStore, r.registry);
    assertEqual(res.code, 422, 'pull over a still-failing doc: 422');
    assertEqual((res.body as { stored?: boolean }).stored, true, 'pull: stored: true');
    assertEqual(kindsOf(storedData()), 'live-readonly/cloud,live-readonly/local,editor-cache/local,editor-cache/cloud', 'all four sources stored');
    // a derived-only cloud row would drop the raw sources: 409, untouched
    const rev = stored()!.rev;
    res = await cloudCachePull(cloudOf({ ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'bytes' } }), store.defaultStore, r.registry);
    assertEqual(res.code, 409, 'a derived-only row over a doc with raw sources: 409');
    assertEqual(errorOf(res.body), 'local-profile-better', 'local-profile-better');
    assertEqual(stored()!.rev, rev, 'the raw sources are untouched');
    // replace drops them on request
    const rep = await importBytes(r, '&replace=1');
    assertEqual(rep.code, 200, 'import with replace: 200');
    assertEqual(kindsOf(storedData()), 'editor-cache/local', 'replace: only the import');

    // a doc a NEWER build wrote: a raw envelope of a newer format, or a newer schema re-derived in memory only
    const newerRaw = clone(profileDoc([await editorCacheSource()])) as unknown as { raw: { format: number } };
    newerRaw.raw.format = RAW_FORMAT + 1;
    const newerSchema = clone(profileDoc([await editorCacheSource()])) as unknown as { meta: Record<string, unknown> };
    newerSchema.meta.schema = CACHE_SCHEMA + 1;
    for (const [label, doc] of [['a newer raw format', newerRaw], ['a newer schema', newerSchema]] as const) {
      clearDoc();
      putDoc(clone(doc));
      const rev0 = stored()!.rev;
      for (const force of [false, true]) {
        const nb = await build(r, force ? { force: true } : {});
        assertEqual(nb.res.code, 409, `${label}: build${force ? ' (force)' : ''} → 409`);
        assertEqual(errorOf(nb.res.body), 'newer-profile', `${label}: build → newer-profile`);
        assertEqual(nb.walks, 0, `${label}: build → no walk`);
      }
      const ni = await importBytes(r);
      assertEqual(ni.code, 409, `${label}: import → 409`);
      assertEqual(ni.body.error, 'newer-profile', `${label}: import → newer-profile`);
      for (const row of [profileDoc([liveSource(liveSeedRecords())]), { ...fakeCacheDoc(), meta: { ...fakeCacheDoc().meta, source: 'bytes' } }]) {
        const np = await cloudCachePull(cloudOf(row), store.defaultStore, r.registry);
        assertEqual(np.code, 409, `${label}: pull → 409`);
        assertEqual(errorOf(np.body), 'newer-profile', `${label}: pull → newer-profile`);
      }
      assertEqual(stored()!.rev, rev0, `${label}: never rewritten`);
      const rb = await build(r, { replace: true });
      assertEqual(rb.walks, 1, `${label}: replace → walked`);
      assertEqual(kindsOf(storedData()), 'live-readonly/local', `${label}: replace → replaced`);
    }
  } finally { clearDoc(); await r.close(); }
}

// ── 12. M2: byte-exactness is decided per family, from the source that provides it ──
async function perFamilyByteExactness(): Promise<void> {
  const fm3 = PROFILES[FM3]!;
  const catChorus = fm3.rangeSections.CHORUS!.stride;
  // the editor cache has no CHORUS table; the walk found a short one (12 slots) with a kind flip and a placeholder
  const catRows = fm3.ranges.CHORUS ?? {};
  const informative = (k: string) => catRows[Number(k)]!.displayMin !== catRows[Number(k)]!.displayMax && Number(k) < 12;
  const floatPid = Number(Object.keys(catRows).find((k) => catRows[Number(k)]!.kind === 'float' && informative(k)));
  const placeholderPid = Number(Object.keys(catRows).find((k) => Number(k) !== floatPid && informative(k)));
  assert(Number.isInteger(floatPid) && Number.isInteger(placeholderPid), 'fixture: two informative catalog CHORUS rows below 12');
  const walked: CacheRecord[] = familyRecords('CHORUS', 78).filter((rec) => rec.id < 12 && rec.id !== floatPid && rec.id !== placeholderPid);
  // a live enum row where the catalog has a float (a live walk's kind is a heuristic); every other free id below 12
  // (the placeholder pid among them) becomes an all-zero placeholder slot
  walked.push({ kind: 'enum', section: 78, offset: 0, id: floatPid, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['One', 'Two'], x: 0 } as CacheRecord);
  const chorus = widenTable(walked, 78, 12);
  const merged = profileDoc([await editorCacheSource(), liveSource([...liveSeedRecords(), ...chorus])]);
  assertEqual(merged.meta.source, 'editor-cache', 'fixture: the doc\'s best source is the editor cache');
  assert(merged.provenance.existence.CHORUS?.startsWith('live-readonly'), 'fixture: CHORUS comes from the walk');
  const rt = runtimeProfileFrom(merged, fm3);
  const facts = rt.profileFacts!;
  assertEqual(facts.byteExact, true, 'the document as a whole: byte-exact (its best source)');
  assertEqual(facts.isByteExactFamily('DISTORT'), true, 'DISTORT (editor cache): byte-exact');
  assertEqual(facts.isByteExactFamily('CHORUS'), false, 'CHORUS (walk only): live');
  assertEqual(rt.rangeSections.CHORUS!.stride, catChorus, 'the live CHORUS stride never shrinks the catalog stride');
  assertEqual(rt.ranges.CHORUS![floatPid]!.kind, 'float', 'a live row never re-classifies a catalog param');
  assertEqual(JSON.stringify(rt.ranges.CHORUS![placeholderPid]), JSON.stringify(catRows[placeholderPid]), 'a live placeholder never replaces a catalog range');
  assertEqual(buildParamIndex(rt, 'CHORUS').profile, 'live', 'param index: CHORUS is live');
  assertEqual(buildParamIndex(rt, 'DISTORT').profile, 'byte-exact', 'param index: DISTORT is byte-exact');
  // the same rows in a live-only doc give the same CHORUS treatment
  const liveOnly = runtimeProfileFrom(profileDoc([liveSource([...liveSeedRecords(), ...chorus])]), fm3);
  assertEqual(JSON.stringify(liveOnly.rangeSections.CHORUS), JSON.stringify(rt.rangeSections.CHORUS), 'CHORUS section equal to a live-only doc\'s');
  assertEqual(JSON.stringify(liveOnly.ranges.CHORUS), JSON.stringify(rt.ranges.CHORUS), 'CHORUS rows equal to a live-only doc\'s');
  // the write guard follows the family: a byte family's own unused slot is refused, a live family's placeholder is no
  // information (nothing refused for it)
  const freePid = (fam: string) => Math.max(...[...(fm3.params[fam] ?? []).map((d) => d.paramId), ...Object.keys(fm3.ranges[fam] ?? {}).map(Number)].filter((n) => n < 0xff00)) + 3;
  const guardDoc = profileDoc([
    await editorCacheSource(widenTable(cacheSeedRecords(), SEED_TAGS.DISTORT!, freePid('DISTORT') + 1, 'DISTORT')),
    liveSource([...liveSeedRecords(), ...widenTable(familyRecords('CHORUS', 78), 78, freePid('CHORUS') + 1)])
  ]);
  assert(guardDoc.provenance.existence.CHORUS?.startsWith('live-readonly'), 'fixture: CHORUS from the walk');
  assert(guardDoc.provenance.existence.DISTORT?.startsWith('editor-cache'), 'fixture: DISTORT from the editor cache');
  const mock = new MockTransport('serial', 'mock-guard');
  mock.isOpen = true;
  const driver = createGen3Driver(runtimeProfileFrom(guardDoc, fm3), { transport: async () => mock, emit: () => {}, getCadence: () => cadenceFor(null, 'balanced') });
  let refused: unknown = null;
  try { await driver.setParam(58, freePid('DISTORT'), 0.5, true); } catch (e) { refused = e; }
  assertEqual((refused as { statusCode?: number } | null)?.statusCode, 409, 'a byte family\'s unused slot: 409');
  const sent0 = mock.sent.length;
  await driver.setParam(78, freePid('CHORUS'), 0.5, true);
  assertEqual(mock.sent.length, sent0 + 1, 'a live family\'s placeholder slot: not refused (the write goes out)');
  // a cloud editor-cache source counts as byte for display — but never for walk bounds / hints
  const cloudBytes = profileDoc([await editorCacheSource(undefined, { origin: 'cloud' })]);
  assertEqual(runtimeProfileFrom(cloudBytes, fm3).profileFacts!.isByteExactFamily('DISTORT'), true, 'a cloud editor cache: byte-exact for display');
  assertEqual(deviceCache.localByteSource(cloudBytes, FM3), null, 'a cloud editor cache: no local byte source for the walk');
  // legacy (format-1) docs keep the document-level rule
  const legacy = runtimeProfileFrom(legacyLocalBytes() as unknown as BuiltCache, fm3).profileFacts!;
  assertEqual(legacy.isByteExactFamily('CHORUS'), true, 'a legacy editor-cache doc: every family byte-exact');
  assertEqual(runtimeProfileFrom(fakeCacheDoc(), fm3).profileFacts!.isByteExactFamily('DISTORT'), false, 'a legacy live doc: no family byte-exact');
}

export async function runProfileMergeTests(): Promise<void> {
  await importThenWalk();
  await walkThenImport();
  await pullNeverReplacesLocal();
  await forceAndReplace();
  await alreadyRule();
  await unresolvedKept();
  await routerPlumbing();
  await legacyBytesVsBuild();
  await legacyVsFormat2Pull();
  await untrustedCloudRows();
  await rawSourcesNeverDropped();
  await perFamilyByteExactness();
}
