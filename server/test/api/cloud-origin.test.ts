// The /cloud/* and /remote/* routes refuse foreign origins (RELAXED guard: no Origin, a loopback origin, or the
// server's own origin pass). Without it, CORS (which reflects every origin) let any web page sign this install
// into an account of its choosing, sign it out, delete the account, switch Remote on, or read who is signed in.
// Builds the app with AXIS_CLOUD=1 but NO Supabase URL/key, so the cloud client is configured off: nothing can
// reach a network, and the allowed calls answer from the disabled client. Also the AXIS_CLOUD-off stubs.
// Mocked FM3, NO hardware, NO network.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { buildApp } from '../../src/app.js';
import * as store from '../../src/store.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

const ROUTES: Array<{ method: 'GET' | 'POST'; url: string; body?: unknown }> = [
  { method: 'GET', url: '/cloud/status' },
  { method: 'POST', url: '/cloud/register', body: { email: 'a@example.invalid', password: 'x' } },
  { method: 'POST', url: '/cloud/login', body: { email: 'a@example.invalid', password: 'x' } },
  { method: 'POST', url: '/cloud/logout' },
  { method: 'POST', url: '/cloud/delete-account' },
  { method: 'POST', url: '/cloud/sync', body: {} },
  { method: 'GET', url: '/cloud/index' },
  { method: 'GET', url: '/remote/status' },
  { method: 'POST', url: '/remote/enable', body: { on: false } }
];
const FOREIGN: Array<Record<string, string>> = [
  { origin: 'https://evil.example' },
  { origin: 'null' },
  { origin: 'http://evil.example:5056', host: '192.168.1.20:5056' } // a foreign page against a LAN server
];
const ALLOWED: Array<Record<string, string>> = [
  {}, // Electron main, curl, the Remote relay
  { origin: 'http://localhost:5056' }, // the packaged Axis app
  { origin: 'http://localhost:5173' }, // Axis dev (Vite proxy)
  { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' } // a LAN / Docker UI served by this server
];

export const CLOUD_ORIGIN_CASE_COUNT = ROUTES.length * (FOREIGN.length + ALLOWED.length) + 2;

const inject = (app: Awaited<ReturnType<typeof buildApp>>, r: (typeof ROUTES)[number], headers: Record<string, string>) =>
  app.inject({
    method: r.method, url: r.url,
    headers: { ...headers, ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {})
  });

async function cloudOn(): Promise<void> {
  const saved = { AXIS_CLOUD: process.env.AXIS_CLOUD, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  process.env.AXIS_CLOUD = '1';
  delete process.env.SUPABASE_URL; // the cloud client stays configured off: no request can leave the process
  delete process.env.SUPABASE_ANON_KEY;
  const t = await buildTestApp(0x11);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('no network in this suite'); }) as typeof fetch;
  const before = JSON.stringify(store.defaultStore.listDocs('cloud'));
  try {
    for (const r of ROUTES) {
      for (const h of FOREIGN) {
        const res = await inject(t.app, r, h);
        assertEqual(res.statusCode, 403, `[cloud-origin] ${r.method} ${r.url} from ${h.origin} → 403`);
        assertEqual(res.payload, JSON.stringify({ error: 'forbidden-origin' }), `[cloud-origin] ${r.url}: body`);
      }
      for (const h of ALLOWED) {
        const res = await inject(t.app, r, h);
        assert(res.statusCode !== 403, `[cloud-origin] ${r.method} ${r.url} from ${h.origin ?? 'no Origin'} is not refused (got ${res.statusCode})`);
      }
    }
    const st = await t.app.inject({ method: 'GET', url: '/cloud/status', headers: { origin: 'http://localhost:5173' } });
    assertEqual(JSON.stringify(st.json()), JSON.stringify({ enabled: false, user: null }), '[cloud-origin] status answers from the disabled client');
    assertEqual(JSON.stringify(store.defaultStore.listDocs('cloud')), before, '[cloud-origin] no session was written');
  } finally {
    globalThis.fetch = realFetch;
    await t.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// AXIS_CLOUD off: the non-erroring status stubs are guarded the same way
async function cloudOff(): Promise<void> {
  const t = await buildTestApp(0x11);
  try {
    for (const url of ['/cloud/status', '/remote/status']) {
      assertEqual((await t.app.inject({ method: 'GET', url, headers: { origin: 'https://evil.example' } })).statusCode, 403, `[cloud-origin] off: ${url} foreign → 403`);
      assertEqual((await t.app.inject({ method: 'GET', url, headers: { origin: 'http://localhost:5056' } })).statusCode, 200, `[cloud-origin] off: ${url} loopback → 200`);
    }
  } finally { await t.app.close(); }
}

export async function runCloudOriginTests(): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    await cloudOn();
    await cloudOff();
  } finally { console.log = log; }
}
