// The private `cloud` store collection (the Supabase auth sessions) is never reachable through the generic
// `/store/:c[/:id]` routes — not from a foreign origin, not from the app's own origin, not through the browser
// runtime router, not over the Remote relay — and a removed session leaves no token behind on disk.
// Mocked FM3, NO hardware, NO network (the sign-out runs against a faked auth endpoint).
// Covers: the collection/path matrix (case and percent-encoding spellings, the fs backend's file-name
// sanitising); GET list / GET doc / PUT / DELETE → 403 forbidden-collection with and without Origin, nothing
// read or changed, other collections unaffected; the router twin; remoteAllowed and a relayed request;
// removeItem blanks the token; a sign-out over the real Cloud client leaves no token in the store file; a
// tombstone an older build left with its token is scrubbed on first use.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../src/store.js';
import { createRouter } from '../../src/runtime/router.js';
import { remoteAllowed, RemoteHost } from '../../src/remote.js';
import { FORBIDDEN_COLLECTION, isPrivateCollection, isPrivateStorePath, isWriteProtectedCollection } from '../../src/runtime/storeAccess.js';
import { createStoreSessionStorage } from '../../src/runtime/sessionStorage.js';
import { createStore } from '../../src/runtime/store.js';
import { createFsStoreBackend, nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { createCloud } from '../../src/runtime/cloud.js';
import { buildTestApp } from '../helpers/api.js';
import { fakeChannelSession } from './remote.test.js';
import { assert, assertEqual } from '../helpers/mock.js';

const TOKEN = 'zz-test-refresh-token-0123456789';
const KEY = 'sb-test-auth-token';
const SPELLINGS = ['cloud', 'CLOUD', 'Cloud', '%63loud', 'cl%6Fud'];

const COLLECTIONS: Array<[string, boolean]> = [
  ['cloud', true], ['CLOUD', true], ['Cloud', true], ['cloud ', false], ['config', false], ['deviceCaches', false],
  ['cloudy', false], ['xcloud', false], ['local', false], ['cacheContributions', false], ['', false]
];
const PATHS: Array<[string, boolean]> = [
  ['/store/cloud', true], ['/store/cloud/', true], ['/store/cloud/x', true], ['/store/CLOUD/x', true], ['/store/%63loud', true],
  ['/store/cl%6Fud/sb-x-auth-token?y=1', true], ['/store/%E0%A4%A', true], ['/store/config', false], ['/store/config/cloud', false],
  ['/cloudstore/cloud', false], ['/store', false]
];

// [path, allowed for a GET over the relay]: spellings that resolve to a refused area once normalised
const REMOTE_GET: Array<[string, boolean]> = [
  ['/x/../cloud/status', false], ['/preset/%2e%2e/cloud/status', false], ['/store/x/..%2fcloud', false], ['/%63loud/status', false],
  ['/Cloud/status', false], ['/REMOTE/status', false], ['//evil.example/preset/grid', false], ['http://evil.example/preset/grid', false],
  ['preset/grid', false], ['/store/config/../cloud/x', false], ['/debug/./raw', false], ['/preset\\..\\cloud', false],
  ['/preset/grid', true], ['/device/cache/contribute?refresh=1', true], ['/store/config/layouts', true], ['/preset/blocks/58/params?generic=1', true]
];

export const STORE_PRIVATE_CASE_COUNT = COLLECTIONS.length + PATHS.length + REMOTE_GET.length + 7;

function matrix(): void {
  for (const [c, want] of COLLECTIONS) assertEqual(isPrivateCollection(c), want, `[store-private] collection ${JSON.stringify(c)}`);
  for (const [p, want] of PATHS) assertEqual(isPrivateStorePath(p), want, `[store-private] path ${p}`);
  for (const s of SPELLINGS) {
    assert(!remoteAllowed('GET', `/store/${s}`), `[store-private] Remote refuses GET /store/${s}`);
    assert(!remoteAllowed('GET', `/store/${s}/${KEY}`), `[store-private] Remote refuses GET /store/${s}/<key>`);
    assert(!remoteAllowed('PUT', `/store/${s}/${KEY}`), `[store-private] Remote refuses PUT /store/${s}/<key>`);
    assert(!remoteAllowed('DELETE', `/store/${s}/${KEY}`), `[store-private] Remote refuses DELETE /store/${s}/<key>`);
  }
  assert(remoteAllowed('GET', '/store/config'), '[store-private] Remote still reads config');
  for (const [p, want] of REMOTE_GET) assertEqual(remoteAllowed('GET', p), want, `[store-private] Remote GET ${p}`);
  assertEqual(isWriteProtectedCollection('cacheContributions'), true, '[store-private] contribution handles are write-protected');
  assertEqual(isWriteProtectedCollection('CacheContributions'), true, '[store-private] write protection folds case');
  assertEqual(isWriteProtectedCollection('cloud'), true, '[store-private] private implies write-protected');
  assertEqual(isWriteProtectedCollection('config'), false, '[store-private] config stays writable');
  assertEqual(isPrivateCollection('cacheContributions'), false, '[store-private] contribution handles stay readable');
}

function seed(): { rev: number } {
  store.defaultStore.putDoc('cloud', KEY, JSON.stringify({ access_token: 'acc', refresh_token: TOKEN, user: { id: 'u' } }));
  return { rev: store.defaultStore.getDoc('cloud', KEY)!.rev };
}

// ── the app routes and the router twin ──
async function routes(): Promise<void> {
  const { rev } = seed();
  const t = await buildTestApp(0x11);
  try {
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    for (const s of SPELLINGS) {
      for (const origin of [undefined, 'https://evil.example', 'http://localhost:5173']) {
        const headers: Record<string, string> = origin ? { origin } : {};
        const reqs = [
          t.app.inject({ method: 'GET', url: `/store/${s}`, headers }),
          t.app.inject({ method: 'GET', url: `/store/${s}/${KEY}`, headers }),
          t.app.inject({ method: 'PUT', url: `/store/${s}/${KEY}`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ data: '{"refresh_token":"planted"}' }) }),
          t.app.inject({ method: 'DELETE', url: `/store/${s}/${KEY}`, headers })
        ];
        for (const res of await Promise.all(reqs)) {
          assertEqual(res.statusCode, 403, `[store-private] /store/${s} from ${String(origin)} → 403`);
          assertEqual(res.payload, JSON.stringify({ error: FORBIDDEN_COLLECTION }), `[store-private] /store/${s}: body`);
        }
      }
      for (const [m, path, body] of [['GET', `/store/${s}`, undefined], ['GET', `/store/${s}/${KEY}`, undefined], ['PUT', `/store/${s}/${KEY}`, JSON.stringify({ data: 'planted' })], ['DELETE', `/store/${s}/${KEY}`, undefined]] as const) {
        const r = await router.handle(m, path, body);
        assertEqual(r.status, 403, `[store-private] router ${m} ${path} → 403`);
        assertEqual(r.body, JSON.stringify({ error: FORBIDDEN_COLLECTION }), `[store-private] router ${m} ${path}: body`);
      }
    }
    const after = store.defaultStore.getDoc('cloud', KEY)!;
    assertEqual(after.rev, rev, '[store-private] nothing was written or deleted');
    assert(String(after.data).includes(TOKEN) && !String(after.data).includes('planted'), '[store-private] the session is untouched');
    // other collections are unaffected
    const cfg = await t.app.inject({ method: 'PUT', url: '/store/config/store-private-probe', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ data: { a: 1 } }) });
    assertEqual(cfg.statusCode, 200, '[store-private] config writes still work');
    assertEqual((await t.app.inject({ method: 'GET', url: '/store/config/store-private-probe' })).statusCode, 200, '[store-private] config reads still work');
    assertEqual((await router.handle('GET', '/store/config')).status, 200, '[store-private] router config reads still work');
    store.defaultStore.delDoc('config', 'store-private-probe');
  } finally {
    store.defaultStore.delDoc('cloud', KEY);
    await t.app.close();
  }
}

// ── contribution handles: readable, never written or deleted through the generic routes ──
async function writeProtected(): Promise<void> {
  store.defaultStore.putDoc('cacheContributions', '11_13p0', { state: 'uploaded', uploads: [{ uploadId: 'u-1', uploadedAt: 'x' }] });
  const rev = store.defaultStore.getDoc('cacheContributions', '11_13p0')!.rev;
  const t = await buildTestApp(0x11);
  try {
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    for (const c of ['cacheContributions', 'CACHECONTRIBUTIONS']) {
      const put = await t.app.inject({ method: 'PUT', url: `/store/${c}/11_13p0`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ data: { uploads: [] } }) });
      assertEqual(put.statusCode, 403, `[store-private] PUT /store/${c} → 403`);
      const del = await t.app.inject({ method: 'DELETE', url: `/store/${c}/11_13p0` });
      assertEqual(del.statusCode, 403, `[store-private] DELETE /store/${c} → 403`);
      assertEqual((await router.handle('PUT', `/store/${c}/11_13p0`, JSON.stringify({ data: {} }))).status, 403, `[store-private] router PUT /store/${c} → 403`);
      assertEqual((await router.handle('DELETE', `/store/${c}/11_13p0`)).status, 403, `[store-private] router DELETE /store/${c} → 403`);
    }
    assertEqual((await t.app.inject({ method: 'GET', url: '/store/cacheContributions/11_13p0' })).statusCode, 200, '[store-private] contribution handles stay readable');
    assertEqual(store.defaultStore.getDoc('cacheContributions', '11_13p0')!.rev, rev, '[store-private] the handles are untouched');
  } finally {
    store.defaultStore.delDoc('cacheContributions', '11_13p0');
    await t.app.close();
  }
}

// ── over the Remote relay ──
async function relay(): Promise<void> {
  seed();
  const t = await buildTestApp(0x11);
  const log = console.log;
  console.log = () => {};
  try {
    const { session, relay: send } = fakeChannelSession();
    const host = new RemoteHost(t.app, async () => session, (fn) => t.registry.subscribe(fn));
    await host.enable(true);
    try {
      for (const [i, s] of SPELLINGS.entries()) {
        for (const [j, path] of [`/store/${s}`, `/store/${s}/${KEY}`].entries()) {
          const res = await send(`sp${i}-${j}`, 'GET', path);
          assertEqual(res.status, 403, `[store-private] relayed GET ${path} → 403`);
          assert(!res.body.includes(TOKEN), `[store-private] relayed GET ${path}: no token`);
        }
      }
    } finally { await host.enable(false); }
  } finally {
    console.log = log;
    store.defaultStore.delDoc('cloud', KEY);
    await t.app.close();
  }
}

/** Every file under `dir`, concatenated (to look for a token anywhere on disk). */
function diskText(dir: string): string {
  let out = '';
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out += readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
}

// ── removal leaves no token ──
async function removal(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'forgefx-store-private-'));
  try {
    const st = createStore(createFsStoreBackend(dir), nodeCodec);
    // the adapter: removeItem blanks the data of the tombstone
    const ss = createStoreSessionStorage(st);
    ss.setItem(KEY, JSON.stringify({ refresh_token: TOKEN }));
    assert(diskText(dir).includes(TOKEN), '[store-private] the session is on disk while signed in');
    ss.removeItem(KEY);
    assertEqual(ss.getItem(KEY), null, '[store-private] removed reads as absent');
    const tomb = st.docsChangedSince('cloud', 0).find((d) => d.id === KEY)!;
    assertEqual(`${tomb.deleted} ${tomb.data}`, 'true null', '[store-private] the tombstone carries no data');
    assert(!diskText(dir).includes(TOKEN), '[store-private] no token left on disk');

    // a tombstone an older build left WITH its data is scrubbed on first use (and never read)
    st.putDoc('cloud', 'old-key', JSON.stringify({ refresh_token: TOKEN }));
    st.delDoc('cloud', 'old-key'); // the store's own delete keeps the data
    assert(diskText(dir).includes(TOKEN), '[store-private] (precondition) an old-style tombstone keeps the token');
    const cloud = createCloud({ url: 'http://127.0.0.1:54321', anonKey: 'anon' }, st);
    assertEqual(cloud.hasAccountSession(), false, '[store-private] a tombstoned session is not a session');
    assert(!diskText(dir).includes(TOKEN), '[store-private] the old tombstone is scrubbed');

    // a sign-out through the real Cloud client (faked auth endpoint) leaves no token behind
    const accountKey = 'sb-127-auth-token';
    const exp = Math.floor(Date.now() / 1000) + 3600;
    st.putDoc('cloud', accountKey, JSON.stringify({
      access_token: 'aaa.bbb.ccc', token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: TOKEN,
      user: { id: 'acct', aud: 'authenticated', role: 'authenticated', is_anonymous: false, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
    }));
    const c2 = createCloud({ url: 'http://127.0.0.1:54321', anonKey: 'anon' }, st);
    assertEqual(c2.hasAccountSession(), true, '[store-private] signed in');
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
      if (!url.startsWith('http://127.0.0.1:54321/')) throw new Error(`unexpected host ${url}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await c2.logout();
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(seen.includes('POST /auth/v1/logout'), `[store-private] the sign-out reached the (fake) auth endpoint (${seen.join(', ')})`);
    assertEqual(c2.hasAccountSession(), false, '[store-private] signed out');
    assert(!diskText(dir).includes(TOKEN), '[store-private] the signed-out session left no token on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runStorePrivateTests(): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    matrix();
    await routes();
    await writeProtected();
    await relay();
    await removal();
  } finally {
    console.log = log;
  }
}
