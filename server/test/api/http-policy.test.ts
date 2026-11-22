// FORGEFX-51 — the app-wide HTTP policy: origin check, Host allowlist (DNS rebinding), the CORS reflection
// rule, the listen address, the static SPA handler's path containment, and the invalid-JSON answer.
//
// The route sweep enumerates EVERY registered route (buildApp's `onRoute` seam, HEAD twins and the CORS
// `OPTIONS *` route included; plus unmatched requests, which the static SPA handler serves) in two builds:
// FORGEFX_STATIC set, and AXIS_CLOUD=1 with the cloud client configured off (the cloud, remote and shared-
// profile routes). A probe hook added after buildApp answers 299 with the matched route, so it is only reached
// when the policy let the request through, and no handler ever runs (no device I/O, no store writes, no SSE).
// Asserted per route and method: a foreign origin, or `Sec-Fetch-Site: cross-site` without one, gets 403
// forbidden-origin unless the route is public (GET/HEAD /healthz, unmatched GET/HEAD), every allowed caller
// passes, a rebinding Host gets 403 forbidden-host on everything. Then real requests (no probe) for the CORS
// headers, the env switches, a loopback-bound server's Host rule, the loopback-peer rule of the strict
// routes, the static files (HEAD, Windows device names) and invalid / prototype-poisoning JSON.
// Mocked FM3, NO hardware, NO network (one loopback socket for a raw request).
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { selectBindHost } from '../../src/services/bindHost.js';
import { staticTarget } from '../../src/services/staticFiles.js';
import {
  FORBIDDEN_HOST, FORBIDDEN_ORIGIN, createRequestPolicy, hostnameAliases, isCrossSiteFetch, isLoopbackAddress, isLoopbackBind,
  isPublicRequest, isStrictAllowed, normalizeOrigin, splitList
} from '../../src/services/originGuard.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

type Headers = Record<string, string>;

// ── pure: the Host allowlist ──
const POLICY_HOSTS = { machineHostnames: ['Studio-PC'], allowedHosts: ['forgefx.example.com', 'proxy.lan:8443', 'bad host'] };
const HOSTS_OK: (string | undefined)[] = [
  undefined, // no Host header (HTTP/1.0)
  'localhost:5056', 'LOCALHOST', 'localhost', 'axis.localhost:5173',
  '127.0.0.1:5056', '127.0.0.1', '127.1.2.3:5056', '2130706433:5056', // numeric IPv4 → 127.0.0.1
  '[::1]:5056', '[::1]', '[::ffff:127.0.0.1]:5056',
  '192.168.1.20:5056', '10.0.0.5', '[fe80::1]:5056', // LAN browsers by address
  'studio-pc:5056', 'STUDIO-PC', 'studio-pc.local:5056', // this machine's names
  'forgefx.example.com', 'FORGEFX.EXAMPLE.COM:443', 'proxy.lan' // FORGEFX_ALLOWED_HOSTS (port ignored)
];
const HOSTS_REFUSED: (string | string[])[] = [
  'evil.example:5056', 'evil.example', // a DNS-rebinding page's own hostname
  '127.0.0.1.nip.io:5056', 'localhost.evil.example', 'studio-pc.evil.example', 'studio-pc.local.evil.example',
  'other-pc.local:5056', 'sub.forgefx.example.com', 'example.com', 'localhost.', // exact names only
  '', 'localhost:5056/x', 'user@localhost:5056', 'localhost#x', 'localhost?x', // not a host[:port]
  ['localhost:5056', 'evil.example'] // repeated header
];

// ── pure: the app-wide origin rule ──
const POLICY_ORIGINS = { allowedOrigins: ['http://192.168.1.10:5173', 'capacitor://localhost', 'HTTPS://UI.Example.com:443', 'null', 'not a url', 'http://ui.example.com/app', '*'] };
const ORIGINS_OK: [string | undefined, string | undefined][] = [
  [undefined, 'localhost:5056'], // curl, Electron main, the Remote relay, same-origin GETs
  ['http://localhost:51234', 'localhost:51234'], // the packaged Axis renderer (same origin, OS-assigned port)
  ['http://localhost:5173', 'localhost:5056'], // Axis dev: the Vite proxy forwards Origin, rewrites Host
  ['https://localhost:8443', 'localhost:8443'],
  ['http://127.0.0.1:5056', '127.0.0.1:5056'],
  ['http://[::1]:5056', '[::1]:5056'],
  ['http://192.168.1.20:5056', '192.168.1.20:5056'], // LAN browser on a headless ForgeFX serving the SPA
  ['http://pi.local:5056', 'PI.LOCAL:5056'], // the same by name (the Host check is separate)
  ['http://192.168.1.10:5173', 'localhost:5056'], // FORGEFX_ALLOWED_ORIGINS
  ['capacitor://localhost', '192.168.1.20:5056'], // an app-shell origin, listed
  ['CAPACITOR://LOCALHOST', '192.168.1.20:5056'],
  ['https://ui.example.com', 'forgefx:5056'] // listed with an explicit default port
];
const ORIGINS_REFUSED: [string | string[] | undefined, string | undefined][] = [
  ['https://evil.example', 'localhost:5056'],
  ['null', 'localhost:5056'],
  ['', 'localhost:5056'],
  ['http://evil.example:5056', '192.168.1.20:5056'], // a foreign page against a LAN server
  ['http://localhost.evil.example:5056', 'localhost:5056'],
  ['http://192.168.1.20:5057', '192.168.1.20:5056'], // other port: not same-origin
  ['http://192.168.1.10:5174', 'localhost:5056'], // listed origin, other port
  ['https://192.168.1.10:5173', 'localhost:5056'], // listed origin, other scheme
  ['http://ui.example.com', 'forgefx:5056'],
  ['https://ui.example.com:8443', 'forgefx:5056'],
  ['capacitor://evil', 'localhost:5056'],
  ['ionic://localhost', 'localhost:5056'],
  ['http://localhost:5173, https://evil.example', 'localhost:5056'], // comma-joined repeated header
  [['http://localhost:5173', 'https://evil.example'], 'localhost:5056']
];
const CORS: [string | undefined, boolean][] = [
  ['http://localhost:5173', true], ['http://127.0.0.1:5056', true], ['http://192.168.1.10:5173', true], ['capacitor://localhost', true],
  ['http://192.168.1.20:5056', false], // same-origin needs no CORS header
  [undefined, false], ['https://evil.example', false], ['null', false]
];
const PUBLIC: [{ method: string; is404?: boolean; routeOptions?: { url?: string } }, boolean][] = [
  [{ method: 'GET', routeOptions: { url: '/healthz' } }, true],
  [{ method: 'HEAD', routeOptions: { url: '/healthz' } }, true],
  [{ method: 'POST', routeOptions: { url: '/healthz' } }, false],
  [{ method: 'GET', routeOptions: { url: '/device' } }, false],
  [{ method: 'GET', is404: true }, true],
  [{ method: 'HEAD', is404: true }, true],
  [{ method: 'POST', is404: true }, false],
  [{ method: 'OPTIONS', routeOptions: { url: '*' } }, false]
];
const ENTRY_CASES = 4;

// ── pure: loopback bind → loopback names and addresses only (+ the env list) ──
const POLICY_LOOPBACK = { ...POLICY_HOSTS, bindHost: '127.0.0.1' };
const LOOPBACK_BIND_OK: (string | undefined)[] = [
  undefined, 'localhost:5056', 'axis.localhost:5173', '127.0.0.1:5056', '127.5.5.5', '2130706433:5056', '[::1]:5056',
  '[::ffff:127.0.0.1]:5056', 'forgefx.example.com' // the env list still applies
];
const LOOPBACK_BIND_REFUSED: string[] = [
  'studio-pc:5056', 'studio-pc.local:5056', // this machine's names: only on a non-loopback bind
  '192.168.1.20:5056', '10.0.0.5', '[fe80::1]:5056', '[::ffff:192.168.1.20]', // LAN addresses
  '0.0.0.0:5056', // routed to loopback by some systems
  'evil.example:5056'
];
const BIND_KIND: [string | undefined, boolean][] = [
  ['127.0.0.1', true], ['127.0.0.2', true], ['::1', true], ['localhost', true], [' LOCALHOST ', true],
  ['0.0.0.0', false], ['::', false], ['192.168.1.20', false], [undefined, false]
];

// ── pure: loopback peers (the STRICT routes) ──
const PEERS: [string | undefined, boolean][] = [
  ['127.0.0.1', true], ['127.9.8.7', true], ['::1', true], ['::ffff:127.0.0.1', true], ['[::1]', true], ['[::ffff:7f00:1]', true],
  ['192.168.1.30', false], ['::ffff:192.168.1.30', false], ['10.0.0.5', false], ['fe80::1', false], ['0.0.0.0', false],
  ['::', false], ['128.0.0.1', false], ['127.0.0.1.evil', false], ['', false], [undefined, false]
];
const STRICT: [string | undefined, string | undefined, boolean][] = [
  [undefined, '127.0.0.1', true], ['http://localhost:5173', '127.0.0.1', true], ['http://localhost:5056', '::ffff:127.0.0.1', true],
  [undefined, '192.168.1.30', false], // a LAN client without an Origin (curl from another box)
  ['http://localhost:5173', '192.168.1.30', false],
  ['http://192.168.1.20:5056', '127.0.0.1', false] // a non-loopback Origin
];

// ── pure: fetch metadata ──
const CROSS_SITE: [string | string[] | undefined, boolean][] = [
  ['cross-site', true], ['Cross-Site', true], ['same-origin, cross-site', true], [['same-origin', 'cross-site'], true],
  ['same-origin', false], ['same-site', false], ['none', false], [undefined, false], ['', false]
];

// ── pure: static paths on Windows (reserved devices, `:`) vs elsewhere ──
const RESERVED_WIN: string[] = ['/con', '/CON', '/nul.txt', '/sub/aux.js', '/com1', '/LPT9.log', '/conin$', '/con%20', '/con%20.txt', '/app.js%3a%3a$DATA', '/C:/x'];
const NOT_RESERVED_WIN: string[] = ['/console.js', '/connect/app.js', '/com10', '/nullish.css', '/app.js'];

// ── pure: the listen address ──
const BIND: [Record<string, string | undefined>, Record<string, string | undefined>, string][] = [
  [{}, { node: '20.18.0' }, '0.0.0.0'], // Docker / headless / dev keep LAN access
  [{}, { node: '20.18.0', electron: '33.2.0' }, '127.0.0.1'], // the desktop app: loopback only
  [{ FORGEFX_HOST: '0.0.0.0' }, { electron: '33.2.0' }, '0.0.0.0'], // the env wins
  [{ FORGEFX_HOST: '192.168.1.20' }, { node: '20.18.0' }, '192.168.1.20'],
  [{ FORGEFX_HOST: ' ::1 ' }, { node: '20.18.0' }, '::1'],
  [{ FORGEFX_HOST: '  ' }, { electron: '33.2.0' }, '127.0.0.1'] // blank = unset
];

// ── the route sweep ──
const SWEEP_HTTP: AppOptions['http'] = {
  allowedOrigins: ['http://192.168.1.10:5173', 'capacitor://localhost'],
  allowedHosts: ['forgefx.example.com'],
  machineHostnames: ['Studio-PC']
};
const FOREIGN: Headers[] = [
  { origin: 'https://evil.example' },
  { origin: 'null' },
  { origin: 'http://evil.example:5056', host: '192.168.1.20:5056' }, // a foreign page against a LAN server
  { origin: 'http://localhost.evil.example:5056' },
  { 'sec-fetch-site': 'cross-site' }, // <img>/<script>/link from another site: no Origin at all
  { 'sec-fetch-site': 'cross-site', host: 'localhost:5056' }
];
const ALLOWED: Headers[] = [
  {}, // Electron main, curl, the Remote relay's inject, same-origin GETs
  { 'sec-fetch-site': 'same-origin' }, // the Axis renderer's / the Vite page's same-origin GET (no Origin)
  { origin: 'http://localhost:51234', host: 'localhost:51234', 'sec-fetch-site': 'same-origin' }, // ...and its writes
  { origin: 'http://localhost:3000', host: 'localhost:5056', 'sec-fetch-site': 'same-site' }, // another loopback port
  { 'sec-fetch-site': 'none' }, // typed URL, bookmark
  { origin: 'http://192.168.1.10:5173', host: '192.168.1.20:5056', 'sec-fetch-site': 'cross-site' }, // listed origin
  { origin: 'http://localhost:51234', host: 'localhost:51234' }, // the packaged Axis renderer
  { origin: 'http://localhost:5173', host: 'localhost:5056' }, // Axis dev (Vite proxy, changeOrigin)
  { origin: 'http://localhost:5174', host: 'localhost:5174' }, // a dev server without changeOrigin
  { origin: 'http://127.0.0.1:5056', host: '127.0.0.1:5056' },
  { origin: 'http://[::1]:5056', host: '[::1]:5056' },
  { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' }, // LAN browser, headless ForgeFX serving the SPA
  { origin: 'http://studio-pc.local:5056', host: 'studio-pc.local:5056' }, // the same by this machine's mDNS name
  { origin: 'https://forgefx.example.com', host: 'forgefx.example.com' }, // behind a reverse proxy (listed host)
  { origin: 'http://192.168.1.10:5173', host: '192.168.1.20:5056' }, // FORGEFX_ALLOWED_ORIGINS
  { origin: 'capacitor://localhost', host: '192.168.1.20:5056' }
];
const REBINDING: Headers[] = [
  { origin: 'http://evil.example:5056', host: 'evil.example:5056' }, // same-origin, but on a rebound name
  { host: 'evil.example:5056' }, // its GETs carry no Origin
  { host: '127.0.0.1.nip.io:5056' }
];
const SWEEP_BUILDS = 2;

const E2E_CASES = 20;
const LOOPBACK_BIND_E2E_CASES = 4;
const STRICT_PEER_CASES = 7;
const STATIC_CASES = 24;
const JSON_CASES = 9;

export const HTTP_POLICY_CASE_COUNT =
  HOSTS_OK.length + HOSTS_REFUSED.length + ORIGINS_OK.length + ORIGINS_REFUSED.length + CORS.length + PUBLIC.length + ENTRY_CASES +
  LOOPBACK_BIND_OK.length + LOOPBACK_BIND_REFUSED.length + BIND_KIND.length + PEERS.length + STRICT.length + CROSS_SITE.length +
  RESERVED_WIN.length + NOT_RESERVED_WIN.length +
  BIND.length + SWEEP_BUILDS * (FOREIGN.length + ALLOWED.length + REBINDING.length) + E2E_CASES + LOOPBACK_BIND_E2E_CASES +
  STRICT_PEER_CASES + STATIC_CASES + JSON_CASES;

function pureCases(): void {
  const hp = createRequestPolicy(POLICY_HOSTS);
  for (const h of HOSTS_OK) assert(hp.isAllowedHost(h), `[http-policy] Host ${String(h)} is allowed`);
  for (const h of HOSTS_REFUSED) assert(!hp.isAllowedHost(h), `[http-policy] Host ${JSON.stringify(h)} is refused`);

  const op = createRequestPolicy(POLICY_ORIGINS);
  for (const [o, h] of ORIGINS_OK) assert(op.isAllowedRequestOrigin(o, h), `[http-policy] Origin ${String(o)} with Host ${String(h)} is allowed`);
  for (const [o, h] of ORIGINS_REFUSED) assert(!op.isAllowedRequestOrigin(o, h), `[http-policy] Origin ${JSON.stringify(o)} with Host ${String(h)} is refused`);
  for (const [o, want] of CORS) assertEqual(op.isCorsOrigin(o), want, `[http-policy] CORS reflects ${String(o)}`);
  for (const [r, want] of PUBLIC) assertEqual(isPublicRequest(r), want, `[http-policy] public: ${r.method} ${r.routeOptions?.url ?? '(unmatched)'}`);

  // entries: unparseable ones are reported, never matched; lists split on commas
  assertEqual(JSON.stringify(op.ignored), JSON.stringify(['origin null', 'origin not a url', 'origin http://ui.example.com/app', 'origin *']), '[http-policy] ignored origin entries');
  assertEqual(JSON.stringify(hp.ignored), JSON.stringify(['host bad host']), '[http-policy] ignored host entries');
  assertEqual(JSON.stringify(splitList(' http://a.example , ,https://b.example ')), JSON.stringify(['http://a.example', 'https://b.example']), '[http-policy] splitList');
  assertEqual(normalizeOrigin('HTTP://LOCALHOST:80'), 'http://localhost', '[http-policy] an origin compares canonically');
  assertEqual(JSON.stringify(hostnameAliases('Studio-PC.fritz.box')), JSON.stringify(['studio-pc.fritz.box', 'studio-pc', 'studio-pc.local']), '[http-policy] hostname aliases');

  for (const [env, versions, want] of BIND) assertEqual(selectBindHost(env, versions), want, `[http-policy] bind host for ${JSON.stringify(env)} / ${versions.electron ? 'electron' : 'node'}`);
  assertEqual(selectBindHost(), '0.0.0.0', '[http-policy] this (non-Electron) test process defaults to all interfaces');

  const lp = createRequestPolicy(POLICY_LOOPBACK);
  for (const h of LOOPBACK_BIND_OK) assert(lp.isAllowedHost(h), `[http-policy] loopback bind: Host ${String(h)} is allowed`);
  for (const h of LOOPBACK_BIND_REFUSED) assert(!lp.isAllowedHost(h), `[http-policy] loopback bind: Host ${h} is refused`);
  for (const [b, want] of BIND_KIND) assertEqual(isLoopbackBind(b), want, `[http-policy] ${String(b)} is ${want ? '' : 'not '}a loopback bind`);
  for (const b of ['::1', 'localhost']) assert(!createRequestPolicy({ ...POLICY_HOSTS, bindHost: b }).isAllowedHost('studio-pc.local'), `[http-policy] bind ${b}: no machine names`);
  for (const b of ['0.0.0.0', '::', '192.168.1.20']) assert(createRequestPolicy({ ...POLICY_HOSTS, bindHost: b }).isAllowedHost('studio-pc.local'), `[http-policy] bind ${b}: machine names`);

  for (const [a, want] of PEERS) assertEqual(isLoopbackAddress(a), want, `[http-policy] peer ${String(a)} is ${want ? '' : 'not '}loopback`);
  for (const [o, peer, want] of STRICT) assertEqual(isStrictAllowed(o, peer), want, `[http-policy] strict: Origin ${String(o)} from ${String(peer)}`);
  for (const [s, want] of CROSS_SITE) assertEqual(isCrossSiteFetch(s), want, `[http-policy] Sec-Fetch-Site ${JSON.stringify(s)}`);

  const root = join(tmpdir(), 'forgefx-static-root');
  for (const url of RESERVED_WIN) {
    assertEqual(staticTarget(root, url, 'win32').kind, 'reserved', `[http-policy] static win32: ${url} is refused before any fs call`);
    assert(staticTarget(root, url, 'linux').kind !== 'reserved', `[http-policy] static linux: ${url} is an ordinary name`);
  }
  for (const url of NOT_RESERVED_WIN) assertEqual(staticTarget(root, url, 'win32').kind, 'file', `[http-policy] static win32: ${url} is an ordinary name`);
}

async function makeApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  await registry.detect();
  return buildApp(registry, opts);
}

interface Route { method: string; url: string }

/** A concrete URL for a route pattern (`:c` → a store collection, other params → 1, `*` → a path). */
const concrete = (url: string): string => (url === '*' ? '/device' : url.replace(/:([A-Za-z]+)/g, (_m, p: string) => (p === 'c' ? 'config' : '1')));

const PROBE = 'x-policy-probe';

async function sweep(label: string, app: FastifyInstance, routes: Route[], mustHave: string[]): Promise<void> {
  // the probe runs after the policy hook (added first in buildApp) and before route hooks + handlers
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers[PROBE] === '1') return reply.code(299).send({ route: req.routeOptions?.url ?? null });
    return undefined;
  });
  const have = new Set(routes.map((r) => `${r.method} ${r.url}`));
  for (const k of mustHave) assert(have.has(k), `[http-policy] ${label}: the sweep covers ${k}`);
  assert(routes.length >= 120, `[http-policy] ${label}: enumerated ${routes.length} routes (expected the whole surface)`);

  // unmatched requests: GET/HEAD reach the static SPA handler (public), anything else is not public
  const targets: (Route & { matched: boolean })[] = [
    ...routes.map((r) => ({ ...r, matched: true })),
    { method: 'GET', url: '/deep/spa/route', matched: false },
    { method: 'HEAD', url: '/app.js', matched: false },
    { method: 'POST', url: '/no/such/route', matched: false },
    { method: 'DELETE', url: '/no/such/route', matched: false }
  ];
  const send = (t: (typeof targets)[number], h: Headers) =>
    app.inject({
      method: t.method as 'GET',
      url: t.matched ? concrete(t.url) : t.url,
      headers: { ...h, [PROBE]: '1', ...(t.method === 'OPTIONS' ? { 'access-control-request-method': 'POST' } : {}) }
    });
  const isPublic = (t: (typeof targets)[number]) => (t.method === 'GET' || t.method === 'HEAD') && (t.matched ? t.url === '/healthz' : true);
  const reached = (t: (typeof targets)[number], payload: string, what: string) => {
    if (t.method === 'HEAD') return; // no body on HEAD
    assertEqual(payload, JSON.stringify({ route: t.matched ? t.url : null }), `[http-policy] ${label}: ${what} reaches ${t.method} ${t.url}`);
  };

  for (const h of FOREIGN) {
    for (const t of targets) {
      const res = await send(t, h);
      if (isPublic(t)) {
        assertEqual(res.statusCode, 299, `[http-policy] ${label}: public ${t.method} ${t.url} from ${h.origin} passes`);
        reached(t, res.payload, `public ${h.origin}`);
      } else {
        assertEqual(res.statusCode, 403, `[http-policy] ${label}: ${t.method} ${t.url} from ${h.origin} (Host ${h.host ?? 'default'}) → 403`);
        if (t.method !== 'HEAD') assertEqual(res.payload, JSON.stringify({ error: FORBIDDEN_ORIGIN }), `[http-policy] ${label}: ${t.method} ${t.url}: body`);
        assertEqual(res.headers['access-control-allow-origin'], undefined, `[http-policy] ${label}: ${t.method} ${t.url}: no CORS header for ${h.origin}`);
      }
    }
  }
  for (const h of ALLOWED) {
    for (const t of targets) {
      const res = await send(t, h);
      // a preflight from an origin CORS reflects is answered by the CORS hook (204), after the policy let it pass
      if (t.method === 'OPTIONS' && res.statusCode === 204) {
        assertEqual(res.headers['access-control-allow-origin'], h.origin, `[http-policy] ${label}: preflight from ${h.origin} reflected`);
        continue;
      }
      assertEqual(res.statusCode, 299, `[http-policy] ${label}: ${t.method} ${t.url} from ${h.origin ?? 'no Origin'} (Host ${h.host ?? 'default'}) is not refused`);
      reached(t, res.payload, String(h.origin ?? 'no Origin'));
    }
  }
  for (const h of REBINDING) {
    for (const t of targets) {
      const res = await send(t, h);
      assertEqual(res.statusCode, 403, `[http-policy] ${label}: ${t.method} ${t.url} with Host ${h.host} → 403`);
      if (t.method !== 'HEAD') assertEqual(res.payload, JSON.stringify({ error: FORBIDDEN_HOST }), `[http-policy] ${label}: ${t.method} ${t.url}: forbidden-host`);
    }
  }
}

const COMMON_ROUTES = [
  'GET /healthz', 'HEAD /healthz', 'GET /device', 'GET /diag', 'GET /ports', 'POST /ports/select', 'POST /debug/raw',
  'GET /store/:c', 'GET /store/:c/:id', 'PUT /store/:c/:id', 'DELETE /store/:c/:id',
  'GET /local/config', 'PUT /local/config', 'GET /local/presets/file', 'POST /local/presets', 'POST /local/sync', 'POST /local/restore',
  'GET /backups', 'GET /versions', 'GET /version/:id/syx', 'POST /version/:id/restore', 'POST /backup/device',
  'GET /device/cache/sources', 'POST /device/cache/import', 'GET /device/cache/contribute', 'POST /device/cache/build', 'GET /device/cache/cloud',
  'POST /preset/select', 'POST /preset/store', 'PUT /preset/blocks/:eid/params/:paramId', 'PUT /preset/grid/cell', 'POST /scene', 'POST /tuner',
  'POST /preset/load', 'POST /firmware/validate', 'POST /diagnostics/capture', 'POST /telemetry/report', 'GET /events',
  'GET /cloud/status', 'GET /remote/status', 'POST /am4/preset/store', 'OPTIONS *'
];

async function routeSweep(staticRoot: string): Promise<void> {
  // build 1: static SPA on, cloud off
  const routes1: Route[] = [];
  process.env.FORGEFX_STATIC = staticRoot;
  let app: FastifyInstance;
  try {
    app = await makeApp({ http: SWEEP_HTTP, onRoute: (r) => { for (const m of [r.method].flat()) routes1.push({ method: m, url: r.url }); } });
  } finally { delete process.env.FORGEFX_STATIC; }
  try { await sweep('static', app, routes1, COMMON_ROUTES); } finally { await app.close(); }

  // build 2: AXIS_CLOUD=1, the client configured off (no request can leave the process), no static handler
  const saved = { AXIS_CLOUD: process.env.AXIS_CLOUD, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  process.env.AXIS_CLOUD = '1';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('no network in this suite'); }) as typeof fetch;
  const routes2: Route[] = [];
  let app2: FastifyInstance | null = null;
  try {
    app2 = await makeApp({ http: SWEEP_HTTP, onRoute: (r) => { for (const m of [r.method].flat()) routes2.push({ method: m, url: r.url }); } });
    await sweep('cloud', app2, routes2, [
      ...COMMON_ROUTES, 'POST /cloud/login', 'POST /cloud/register', 'POST /cloud/delete-account', 'POST /cloud/sync', 'GET /cloud/index',
      'POST /remote/enable', 'POST /device/cache/cloud/pull', 'POST /device/cache/cloud/publish'
    ]);
  } finally {
    globalThis.fetch = realFetch;
    if (app2) await app2.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── real requests: CORS headers, preflight, env switches ──
async function endToEnd(): Promise<void> {
  const app = await makeApp({ http: SWEEP_HTTP });
  try {
    const get = (url: string, h: Headers) => app.inject({ method: 'GET', url, headers: h });
    let res = await get('/device', { origin: 'https://evil.example' });
    assertEqual(res.statusCode, 403, '[http-policy] e2e: foreign GET /device → 403');
    assertEqual(res.headers['access-control-allow-origin'], undefined, '[http-policy] e2e: no CORS header on a refusal');

    res = await get('/device', { origin: 'http://localhost:5173' });
    assertEqual(res.statusCode, 200, '[http-policy] e2e: loopback cross-origin GET /device → 200');
    assertEqual(res.headers['access-control-allow-origin'], 'http://localhost:5173', '[http-policy] e2e: loopback origin reflected');
    assert(String(res.headers.vary ?? '').toLowerCase().includes('origin'), '[http-policy] e2e: Vary: Origin');

    res = await get('/device', { origin: 'http://192.168.1.10:5173', host: '192.168.1.20:5056' });
    assertEqual(res.headers['access-control-allow-origin'], 'http://192.168.1.10:5173', '[http-policy] e2e: listed origin reflected');

    res = await get('/device', { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' });
    assertEqual(res.statusCode, 200, '[http-policy] e2e: LAN same-origin GET /device → 200');
    assertEqual(res.headers['access-control-allow-origin'], undefined, '[http-policy] e2e: same-origin gets no CORS header');

    res = await get('/healthz', { origin: 'https://evil.example' });
    assertEqual(res.statusCode, 200, '[http-policy] e2e: /healthz is public');
    assertEqual(res.headers['access-control-allow-origin'], undefined, '[http-policy] e2e: ...but a foreign page cannot read it');

    res = await app.inject({ method: 'OPTIONS', url: '/device', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    assertEqual(res.statusCode, 403, '[http-policy] e2e: foreign preflight → 403');
    res = await app.inject({ method: 'OPTIONS', url: '/store/config/x', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT' } });
    assertEqual(res.statusCode, 204, '[http-policy] e2e: loopback preflight → 204');
    assertEqual(res.headers['access-control-allow-origin'], 'http://localhost:5173', '[http-policy] e2e: preflight reflects the loopback origin');

    res = await get('/device', { host: 'evil.example:5056' });
    assertEqual(res.statusCode, 403, '[http-policy] e2e: rebinding Host → 403');
    assertEqual(res.payload, JSON.stringify({ error: FORBIDDEN_HOST }), '[http-policy] e2e: forbidden-host body');
  } finally { await app.close(); }

  // the env switches (no `http` option: production reads FORGEFX_ALLOWED_ORIGINS / _HOSTS and os.hostname())
  process.env.FORGEFX_ALLOWED_ORIGINS = 'https://ui.example.com, not a url';
  process.env.FORGEFX_ALLOWED_HOSTS = 'forgefx.example.com';
  let envApp: FastifyInstance;
  try { envApp = await makeApp(); } finally { delete process.env.FORGEFX_ALLOWED_ORIGINS; delete process.env.FORGEFX_ALLOWED_HOSTS; }
  try {
    let res = await envApp.inject({ method: 'GET', url: '/device', headers: { origin: 'https://ui.example.com', host: 'forgefx.example.com' } });
    assertEqual(res.statusCode, 200, '[http-policy] env: listed origin + listed host → 200');
    assertEqual(res.headers['access-control-allow-origin'], 'https://ui.example.com', '[http-policy] env: listed origin reflected');
    res = await envApp.inject({ method: 'GET', url: '/device', headers: { origin: 'https://other.example.com', host: 'forgefx.example.com' } });
    assertEqual(res.statusCode, 403, '[http-policy] env: an unlisted origin → 403');
    res = await envApp.inject({ method: 'GET', url: '/device', headers: { host: 'other.example.com' } });
    assertEqual(res.statusCode, 403, '[http-policy] env: an unlisted host → 403');
    for (const name of hostnameAliases(hostname())) {
      res = await envApp.inject({ method: 'GET', url: '/device', headers: { host: `${name}:5056` } });
      assertEqual(res.statusCode, 200, `[http-policy] env: this machine's name ${name} is accepted`);
    }
  } finally { await envApp.close(); }
}

// ── a loopback-bound server (the desktop app): loopback names and addresses only ──
async function loopbackBind(): Promise<void> {
  const app = await makeApp({ http: { ...SWEEP_HTTP, bindHost: '127.0.0.1' } });
  try {
    const get = (host: string) => app.inject({ method: 'GET', url: '/device', headers: { host } });
    assertEqual((await get('localhost:5056')).statusCode, 200, '[http-policy] loopback bind: localhost → 200');
    assertEqual((await get('forgefx.example.com')).statusCode, 200, '[http-policy] loopback bind: a listed host → 200');
    for (const host of ['studio-pc.local:5056', '192.168.1.20:5056']) {
      const res = await get(host);
      assertEqual(`${res.statusCode} ${res.payload}`, `403 ${JSON.stringify({ error: FORBIDDEN_HOST })}`, `[http-policy] loopback bind: ${host} → 403 forbidden-host`);
    }
  } finally { await app.close(); }
}

// ── the STRICT routes need a loopback peer (a LAN client without an Origin is refused before any fs access) ──
async function strictPeer(): Promise<void> {
  const fsCalls: string[] = [];
  const reads: string[] = [];
  const app = await makeApp({
    http: SWEEP_HTTP,
    editorCaches: {
      discover: {
        platform: 'linux', home: join(tmpdir(), 'forgefx-http-policy-no-home'), env: {},
        fs: { existsSync: (p) => { fsCalls.push(p); return false; }, readdirSync: (p) => { fsCalls.push(p); return []; }, statSync: (p) => { fsCalls.push(p); return { size: 0, mtimeMs: 0 }; } }
      },
      readFile: (p) => { reads.push(p); throw new Error('not in this suite'); }
    },
    contribute: { cloud: null, dryRun: true }
  });
  const STRICT_ROUTES: { method: 'GET' | 'POST'; url: string; body?: unknown }[] = [
    { method: 'GET', url: '/device/cache/sources' },
    { method: 'POST', url: '/device/cache/import', body: { path: '/somewhere/effectDefinitions_11_12p0.cache' } },
    { method: 'GET', url: '/device/cache/contribute' },
    { method: 'POST', url: '/device/cache/contribute', body: { source: { path: '/x.cache' }, consent: true, consentVersion: 2 } },
    { method: 'POST', url: '/device/cache/contribute/decision', body: { decision: 'declined' } },
    { method: 'POST', url: '/device/cache/contribute/withdraw', body: {} }
  ];
  const send = (r: (typeof STRICT_ROUTES)[number], remoteAddress: string | undefined, headers: Headers = {}) =>
    app.inject({
      method: r.method, url: r.url, ...(remoteAddress ? { remoteAddress } : {}),
      headers: { ...headers, ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {})
    });
  try {
    // 1-2. LAN peers (IPv4 and IPv4-mapped), no Origin and a LAN same-origin page → 403, nothing touched
    for (const peer of ['192.168.1.30', '::ffff:192.168.1.30']) {
      for (const h of [{}, { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' }] as Headers[]) {
        for (const r of STRICT_ROUTES) {
          const res = await send(r, peer, h);
          assertEqual(`${res.statusCode} ${res.payload}`, `403 ${JSON.stringify({ error: FORBIDDEN_ORIGIN })}`, `[http-policy] strict: ${r.method} ${r.url} from ${peer} → 403`);
        }
      }
    }
    assertEqual(fsCalls.length + reads.length, 0, '[http-policy] strict: a refused peer never reaches discovery or a read');
    // 3. ...while the app-wide routes still serve that LAN client (the peer only matters on the strict routes)
    const lan = await app.inject({ method: 'GET', url: '/device', remoteAddress: '192.168.1.30', headers: { host: '192.168.1.20:5056' } });
    assertEqual(lan.statusCode, 200, '[http-policy] strict: GET /device from a LAN peer → 200');
    const bytes = await app.inject({ method: 'POST', url: '/device/cache/import?name=x.cache', remoteAddress: '192.168.1.30', headers: { 'content-type': 'application/octet-stream', origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' }, payload: Buffer.from([1, 2, 3]) });
    assert(bytes.statusCode !== 403, `[http-policy] strict: the bytes import is not a strict route (got ${bytes.statusCode})`);
    // 4-6. loopback peers (inject's default 127.0.0.1, ::1, IPv4-mapped) pass the guard
    for (const peer of [undefined, '::1', '::ffff:127.0.0.1']) {
      for (const r of STRICT_ROUTES) {
        const res = await send(r, peer);
        assert(res.statusCode !== 403, `[http-policy] strict: ${r.method} ${r.url} from ${peer ?? 'inject default'} is not refused (got ${res.statusCode})`);
      }
    }
    // 7. a loopback peer with a foreign Origin is still refused
    const foreign = await send(STRICT_ROUTES[0]!, '127.0.0.1', { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' });
    assertEqual(foreign.statusCode, 403, '[http-policy] strict: a same-origin LAN page through a loopback peer → 403');
  } finally { await app.close(); }
}

// ── the static SPA handler ──
function makeStaticTree(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'forgefx-http-policy-'));
  const root = join(base, 'spa');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'index.html'), 'INDEX');
  writeFileSync(join(root, 'app.js'), 'APP');
  mkdirSync(join(base, 'spa-private'), { recursive: true }); // a sibling whose name starts with the root's
  writeFileSync(join(base, 'spa-private', 'secret.txt'), 'SECRET');
  writeFileSync(join(base, 'secret.txt'), 'SECRET');
  return { base, root };
}

/** One raw HTTP/1.1 request over a loopback socket (for a request target inject would normalise). */
function rawRequest(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`));
    let d = '';
    s.setEncoding('utf8');
    s.on('data', (c: string) => { d += c; });
    s.on('error', reject);
    s.on('end', () => resolve({ status: Number(d.split(' ')[1]), body: d.split('\r\n\r\n')[1] ?? '' }));
  });
}

async function staticFiles(base: string, root: string): Promise<void> {
  // pure containment
  assertEqual(staticTarget(root, '/%E0%A4%A').kind, 'invalid-url', '[http-policy] static: malformed escape → invalid-url');
  assertEqual(staticTarget(root, '/a%00b').kind, 'invalid-url', '[http-policy] static: NUL → invalid-url');
  assertEqual(staticTarget(root, '/../spa-private/secret.txt').kind, 'outside', '[http-policy] static: sibling with the same prefix → outside');
  assertEqual(JSON.stringify(staticTarget(root, '/sub/../app.js?v=1')), JSON.stringify({ kind: 'file', path: join(root, 'app.js') }), '[http-policy] static: dot segments inside the root');
  assertEqual(staticTarget(root, '/').kind, 'index', '[http-policy] static: / → index');
  assertEqual(staticTarget(root, '/..foo').kind, 'file', '[http-policy] static: a name starting with two dots stays inside');

  process.env.FORGEFX_STATIC = root;
  let app: FastifyInstance;
  try { app = await makeApp(); } finally { delete process.env.FORGEFX_STATIC; }
  try {
    let res = await app.inject({ method: 'GET', url: '/app.js', headers: { origin: 'https://evil.example' } });
    assertEqual(res.statusCode, 200, '[http-policy] static: an asset is public');
    assertEqual(res.payload, 'APP', '[http-policy] static: asset body');
    assert(String(res.headers['content-type']).startsWith('text/javascript'), '[http-policy] static: asset type');
    assertEqual(res.headers['x-frame-options'], 'SAMEORIGIN', '[http-policy] static: no framing by other sites');
    assertEqual(res.headers['content-security-policy'], "frame-ancestors 'self'", '[http-policy] static: frame-ancestors');

    for (const url of ['/', '/deep/spa/route']) {
      res = await app.inject({ method: 'GET', url });
      assertEqual(res.payload, 'INDEX', `[http-policy] static: ${url} → index.html`);
    }
    // encoded traversal (inject would resolve plain `..` before sending, as a browser does)
    for (const url of ['/..%2fspa-private%2fsecret.txt', '/%2e%2e%2fspa-private/secret.txt', '/..%2fsecret.txt', '/sub%2f..%2f..%2fsecret.txt']) {
      res = await app.inject({ method: 'GET', url });
      assertEqual(res.statusCode, 404, `[http-policy] static: ${url} → 404`);
      assert(!res.payload.includes('SECRET'), `[http-policy] static: ${url} never serves a file outside the root`);
    }
    // a backslash is a separator on Windows only: outside there (404), a missing file name elsewhere (index)
    res = await app.inject({ method: 'GET', url: '/..%5cspa-private%5csecret.txt' });
    assert(!res.payload.includes('SECRET'), '[http-policy] static: backslash traversal never serves the file');
    assertEqual(res.statusCode, sep === '\\' ? 404 : 200, '[http-policy] static: backslash traversal status');

    res = await app.inject({ method: 'POST', url: '/app.js', headers: { origin: 'http://localhost:5173' } });
    assertEqual(res.statusCode, 404, '[http-policy] static: only GET/HEAD are served');

    // HEAD: the GET headers without the body
    res = await app.inject({ method: 'HEAD', url: '/app.js' });
    assertEqual(`${res.statusCode} ${res.headers['content-length']} ${res.payload.length}`, '200 3 0', '[http-policy] static: HEAD /app.js → 200, length 3, no body');
    assert(String(res.headers['content-type']).startsWith('text/javascript'), '[http-policy] static: HEAD keeps the type');
    res = await app.inject({ method: 'HEAD', url: '/deep/spa/route' });
    assertEqual(`${res.statusCode} ${res.headers['content-length']}`, '200 5', '[http-policy] static: HEAD of an SPA route → index.html length');

    // a Windows device name: refused before any fs call there (it would read the device); a missing file elsewhere
    res = await app.inject({ method: 'GET', url: '/con' });
    assertEqual(res.statusCode, process.platform === 'win32' ? 404 : 200, '[http-policy] static: /con status on this platform');

    // a request target the router accepts but decodeURIComponent does not: 400, not a 500
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const bad = await rawRequest(port, '/ok#%E0');
    assertEqual(bad.status, 400, '[http-policy] static: malformed escape → 400');
    assertEqual(bad.body, JSON.stringify({ error: 'invalid-url' }), '[http-policy] static: invalid-url body');
  } finally {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  }
}

// ── invalid JSON bodies ──
async function invalidJson(): Promise<void> {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(0x11)] : []);
  const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
  await registry.detect();
  const app = await buildApp(registry);
  const json = (method: 'POST' | 'PUT', url: string, payload: string) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, payload });
  const BODY = JSON.stringify({ error: 'invalid-json' });
  try {
    for (const [m, url, payload] of [
      ['POST', '/preset/select', '{bad'],
      ['PUT', '/store/config/http-policy-probe', '{"data":'],
      ['POST', '/preset/decode', '[1,2'],
      ['POST', '/device/cache/contribute', '{bad'] // a route with its own errorHandler (413 shape) re-sends it
    ] as const) {
      const res = await json(m, url, payload);
      assertEqual(res.statusCode, 400, `[http-policy] json: ${m} ${url} with a broken body → 400`);
      assertEqual(res.payload, BODY, `[http-policy] json: ${m} ${url}: invalid-json`);
    }
    const empty = await json('PUT', '/local/config', '');
    assertEqual(empty.statusCode, 200, '[http-policy] json: an empty JSON body is still {}');
    // prototype poisoning: refused like malformed JSON, nothing stored, Object.prototype untouched
    for (const payload of ['{"data":{"__proto__":{"polluted":true}}}', '{"data":{"constructor":{"prototype":{"polluted":true}}}}']) {
      const res = await json('PUT', '/store/config/http-policy-poison', payload);
      assertEqual(`${res.statusCode} ${res.payload}`, `400 ${BODY}`, `[http-policy] json: ${payload} → 400 invalid-json`);
    }
    assert(({} as { polluted?: unknown }).polluted === undefined && store.defaultStore.getDoc('config', 'http-policy-poison') == null, '[http-policy] json: nothing polluted or stored');
    const benign = await json('PUT', '/store/config/http-policy-poison', '{"data":{"constructor":"a plain key"}}');
    assertEqual(benign.statusCode, 200, '[http-policy] json: a plain "constructor" key is fine');
    store.defaultStore.delDoc('config', 'http-policy-poison');
    const twin = await createRouter({ registry, store: store.defaultStore }).handle('POST', '/preset/select', '{bad');
    assertEqual(`${twin.status} ${twin.body}`, `400 ${BODY}`, '[http-policy] json: router twin answers the same');
  } finally { await app.close(); }
}

export async function runHttpPolicyTests(): Promise<void> {
  pureCases();
  const { base, root } = makeStaticTree();
  try {
    await routeSweep(root);
    await endToEnd();
    await loopbackBind();
    await strictPeer();
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
  await staticFiles(base, root);
  await invalidJson();
}
