// FORGEFX-47 — the loopback-origin guard and the discovered-path allowlist on the editor-cache routes
// (GET /device/cache/sources, POST /device/cache/import). Mocked FM3 on fw 12.0, NO hardware.
// Discovery is pointed at temp trees built here (never the user's real editor dirs) through
// buildApp's `editorCaches` seam, with a spy over the discovery fs and over the candidate reader, so
// the suite can assert that a refused request touches neither. Covers: the origin matrix (pure); a
// foreign origin and `Origin: null` → 403 on both routes with zero fs calls; no Origin and loopback
// origins (incl. the Axis desktop origin http://localhost:<port> and the Vite dev origin) → allowed;
// an undiscovered path (a valid cache file outside the roots, and a `..` walk out of them) → 400 and
// never stat-ed or read; a discovered path → import works; case folding only on Windows; the router
// twin's `{ path }` answer; the Remote relay still serves /device/cache/sources but not the import.
// LAN / headless (Docker, Raspberry Pi serving the SPA): a same-origin request (Origin host:port ==
// Host) may import BYTES (200), but never the `{ path }` import or the listing (403); a mismatched
// Origin/Host bytes import is 403. The same-origin matrix (pure) covers default ports, case, IPv6.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { buildApp, type AppOptions } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import * as store from '../../src/store.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { createRouter } from '../../src/runtime/router.js';
import { RemoteHost } from '../../src/remote.js';
import { readCandidateFile, type DiscoverOpts, type DiscoveryFs } from '../../src/services/editorCacheDiscovery.js';
import { FORBIDDEN_ORIGIN, isAllowedOrigin, isAllowedOriginOrSameOrigin, isSameOrigin } from '../../src/services/originGuard.js';
import { NOT_A_DISCOVERED_CACHE } from '../../src/services/editorCacheImport.js';
import { CACHE_BYTES } from './editor-cache-import.test.js';
import { fakeChannelSession } from './remote.test.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

const FM3 = 0x11;
const KEY = '11_12p0';
const FILE = 'effectDefinitions_11_12p0.cache';

// ── the origin matrix (pure) ──
const ALLOWED_ORIGINS: (string | undefined)[] = [
  undefined, // curl, same-origin GET, the Electron main process, the Remote relay's inject
  'http://localhost:5056', // the packaged Axis app (renderer loaded from the server itself)
  'http://localhost:51234', // the packaged app on an OS-assigned port
  'http://localhost:5173', // Axis dev (Vite; the proxy forwards Origin unchanged)
  'http://localhost', // no port
  'https://localhost:8443',
  'http://LOCALHOST:5173', // host compare is case-insensitive
  'http://127.0.0.1:5056',
  'http://[::1]:5056'
];
const REFUSED_ORIGINS: (string | string[])[] = [
  'https://evil.example',
  'http://evil.example:5056',
  'http://localhost.evil.example',
  'http://127.0.0.1.nip.io:5056',
  'http://192.168.1.20:5056', // a LAN origin is not loopback
  'null', // sandboxed iframe / data: / file: — the Axis renderer never sends it
  '',
  'file://',
  'app://axis',
  'chrome-extension://abcdefghijklmnop',
  'http://localhost:5173, https://evil.example', // a comma-joined repeated header
  ['http://localhost:5173', 'https://evil.example']
];

// [Origin, Host header] pairs for the relaxed (bytes-import) rule.
const SAME_ORIGIN: [string, string][] = [
  ['http://192.168.1.20:5056', '192.168.1.20:5056'], // LAN browser on a headless ForgeFX
  ['http://pi.local:5056', 'PI.LOCAL:5056'], // host case
  ['http://pi.local', 'pi.local'], // default port, omitted on both sides
  ['http://pi.local', 'pi.local:80'], // default port, explicit in Host
  ['https://forgefx.lan', 'forgefx.lan:443'],
  ['http://[fe80::1]:5056', '[fe80::1]:5056'],
  ['http://evil.example:5056', 'evil.example:5056'] // a DNS-rebinding page is same-origin too (accepted for bytes only)
];
const NOT_SAME_ORIGIN: [string | string[] | undefined, string | string[] | undefined][] = [
  ['http://evil.example:5056', '192.168.1.20:5056'], // foreign page -> LAN server
  ['http://192.168.1.20:5056', 'localhost:5056'],
  ['http://192.168.1.20:5057', '192.168.1.20:5056'], // other port
  ['http://pi.local:8080', 'pi.local'],
  ['null', 'null'],
  ['http://pi.local:5056', undefined], // no Host
  ['http://pi.local:5056', ''],
  ['http://pi.local:5056', ['pi.local:5056', 'evil.example']], // repeated Host
  ['http://pi.local:5056', 'user@pi.local:5056'], // not a Host value
  ['http://pi.local:5056', 'pi.local:5056/x'],
  [undefined, 'pi.local:5056'], // no Origin: not "same-origin" (the strict rule allows it on its own)
  ['file://', 'pi.local']
];

const ROUTE_CASES = 10;
export const ORIGIN_GUARD_CASE_COUNT = ALLOWED_ORIGINS.length + REFUSED_ORIGINS.length + SAME_ORIGIN.length + NOT_SAME_ORIGIN.length + ROUTE_CASES;

function originMatrix(): void {
  for (const o of ALLOWED_ORIGINS) assert(isAllowedOrigin(o), `[origin-guard] origin ${String(o)} is allowed`);
  for (const o of REFUSED_ORIGINS) assert(!isAllowedOrigin(o), `[origin-guard] origin ${JSON.stringify(o)} is refused`);
  for (const [o, h] of SAME_ORIGIN) {
    assert(isSameOrigin(o, h), `[origin-guard] ${o} with Host ${h} is same-origin`);
    assert(isAllowedOriginOrSameOrigin(o, h), `[origin-guard] relaxed: ${o} with Host ${h} is allowed`);
  }
  for (const [o, h] of NOT_SAME_ORIGIN) assert(!isSameOrigin(o, h), `[origin-guard] ${JSON.stringify(o)} with Host ${JSON.stringify(h)} is not same-origin`);
  assert(!isAllowedOriginOrSameOrigin('http://evil.example:5056', '192.168.1.20:5056'), '[origin-guard] relaxed: a foreign Origin is refused');
  assert(isAllowedOriginOrSameOrigin(undefined, 'pi.local:5056'), '[origin-guard] relaxed: no Origin is allowed (strict rule)');
  assert(isAllowedOriginOrSameOrigin('http://localhost:5173', 'localhost:5056'), '[origin-guard] relaxed: a loopback Origin is allowed (strict rule)');
}

// ── fixtures ──
/** A real-fs DiscoveryFs that records every call, so a test can assert what discovery touched. */
function spyFs(): DiscoveryFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    existsSync: (p) => { calls.push(`exists ${p}`); return existsSync(p); },
    readdirSync: (p) => { calls.push(`readdir ${p}`); return readdirSync(p); },
    statSync: (p) => { calls.push(`stat ${p}`); const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; }
  };
}

/** A candidate reader that records the paths it was asked to read (and really reads them). */
function spyReader(): { reads: string[]; readFile: (p: string) => { name: string; bytes: Uint8Array } } {
  const reads: string[] = [];
  return { reads, readFile: (p) => { reads.push(p); return readCandidateFile(p); } };
}

interface Tree { root: string; candidate: string; outside: string; discover: DiscoverOpts; fs: DiscoveryFs & { calls: string[] } }

/** A temp editor tree for a simulated platform: one valid FM3 cache inside the discovery root, and
 *  an identical, equally valid cache OUTSIDE it (so reading it would import fine — only the
 *  allowlist stops it). */
function makeTree(platform: 'darwin' | 'win32'): Tree {
  const root = mkdtempSync(join(tmpdir(), `forgefx-origin-guard-${platform}-`));
  const home = join(root, 'home');
  const appdata = join(root, 'appdata');
  const base = platform === 'win32' ? join(appdata, 'Fractal Audio') : join(home, 'Library', 'Application Support', 'Fractal Audio');
  mkdirSync(join(base, 'FM3-Edit'), { recursive: true });
  const candidate = join(base, 'FM3-Edit', FILE);
  writeFileSync(candidate, CACHE_BYTES);
  mkdirSync(join(root, 'outside'), { recursive: true });
  const outside = join(root, 'outside', FILE);
  writeFileSync(outside, CACHE_BYTES);
  const fs = spyFs();
  return { root, candidate, outside, fs, discover: { platform, home, env: { APPDATA: appdata }, fs } };
}

function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

async function makeApp(opts: AppOptions) {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[5] === 0x08) return [firmwareReply(FM3, 12, 0)];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  const app = await buildApp(registry, opts);
  return { app, registry };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

/** Origin (omitted when undefined) + an optional Host override (inject defaults to localhost:80). */
const hdrs = (origin?: string, host?: string): Record<string, string> => ({ ...(origin === undefined ? {} : { origin }), ...(host === undefined ? {} : { host }) });
const sources = (app: App, origin?: string, host?: string) =>
  app.inject({ method: 'GET', url: '/device/cache/sources', headers: hdrs(origin, host) });
const importPath = (app: App, path: string, origin?: string, host?: string) =>
  app.inject({ method: 'POST', url: '/device/cache/import', headers: { 'content-type': 'application/json', ...hdrs(origin, host) }, payload: JSON.stringify({ path }) });
const importBytes = (app: App, origin?: string, host?: string) =>
  app.inject({ method: 'POST', url: `/device/cache/import?name=${FILE}`, headers: { 'content-type': 'application/octet-stream', ...hdrs(origin, host) }, payload: Buffer.from(CACHE_BYTES) });

const persisted = (): boolean => { const d = store.defaultStore.getDoc('deviceCaches', KEY); return d != null && !d.deleted; };

// ── route cases ──
async function routeCases(): Promise<void> {
  const tree = makeTree('darwin');
  const reader = spyReader();
  store.defaultStore.delDoc('deviceCaches', KEY);
  const { app, registry } = await makeApp({ editorCaches: { discover: tree.discover, readFile: reader.readFile } });
  try {
    // 1. a foreign origin → 403 on the sources listing, before discovery touches the disk
    for (const origin of ['https://evil.example', 'null']) {
      const res = await sources(app, origin);
      assertEqual(res.statusCode, 403, `[origin-guard] sources from ${origin} → 403`);
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: FORBIDDEN_ORIGIN }), `[origin-guard] sources from ${origin}: body`);
    }
    assertEqual(tree.fs.calls.length, 0, '[origin-guard] a refused sources request never reaches discovery');

    // 2. a foreign origin → 403 on the path import (even for a discovered path) and on the bytes import
    for (const origin of ['https://evil.example', 'null']) {
      for (const p of [tree.outside, tree.candidate]) {
        const res = await importPath(app, p, origin);
        assertEqual(res.statusCode, 403, `[origin-guard] path import from ${origin} → 403`);
        assertEqual((res.json() as { error: string }).error, FORBIDDEN_ORIGIN, `[origin-guard] path import from ${origin}: error code`);
      }
      const bytes = await importBytes(app, origin);
      assertEqual(bytes.statusCode, 403, `[origin-guard] bytes import from ${origin} → 403`);
    }
    assertEqual(tree.fs.calls.length, 0, '[origin-guard] a refused import never reaches discovery');
    assertEqual(reader.reads.length, 0, '[origin-guard] a refused import never reads a file');
    assert(!persisted(), '[origin-guard] a refused import persists nothing');

    // 3. no Origin + loopback origins (Axis desktop, Vite dev, IPv4/IPv6 loopback) → the listing works
    for (const origin of [undefined, 'http://localhost:5056', 'http://localhost:5173', 'http://127.0.0.1:5056', 'http://[::1]:5056']) {
      const res = await sources(app, origin);
      assertEqual(res.statusCode, 200, `[origin-guard] sources from ${String(origin)} → 200`);
      const body = res.json() as { candidates: { path: string }[] };
      assertEqual(body.candidates.length, 1, `[origin-guard] sources from ${String(origin)}: the temp candidate`);
      assertEqual(body.candidates[0]!.path, tree.candidate, `[origin-guard] sources from ${String(origin)}: candidate path`);
    }

    // 4. an undiscovered path → 400, never stat-ed or read (the outside file is a valid cache: reading
    //    it would import). Also a `..` walk from a discovery dir out to it.
    tree.fs.calls.length = 0;
    // string-joined so the `..` segments reach the server un-normalised
    const escape = [tree.candidate, '..', '..', '..', '..', '..', '..', 'outside', FILE].join(sep);
    for (const p of [tree.outside, escape, join(tree.root, 'missing', FILE), 'relative/' + FILE]) {
      const res = await importPath(app, p, 'http://localhost:5173');
      assertEqual(res.statusCode, 400, `[origin-guard] undiscovered ${p} → 400`);
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: NOT_A_DISCOVERED_CACHE }), `[origin-guard] undiscovered ${p}: body`);
    }
    assertEqual(reader.reads.length, 0, '[origin-guard] an undiscovered path is never read');
    assert(!tree.fs.calls.some((c) => c.includes(join(tree.root, 'outside')) || c.includes('missing')), '[origin-guard] an undiscovered path is never stat-ed');
    assert(!persisted(), '[origin-guard] an undiscovered path persists nothing');

    // 5. the discovered path → imports (from a loopback origin and with no Origin)
    for (const origin of ['http://localhost:5056', undefined]) {
      store.defaultStore.delDoc('deviceCaches', KEY);
      reader.reads.length = 0;
      const res = await importPath(app, tree.candidate, origin);
      assertEqual(res.statusCode, 200, `[origin-guard] discovered path from ${String(origin)} → 200`);
      const body = res.json() as { imported: boolean; key: string; source: string };
      assertEqual(body.imported, true, '[origin-guard] discovered path: imported');
      assertEqual(body.key, KEY, '[origin-guard] discovered path: key');
      assertEqual(body.source, 'editor-cache', '[origin-guard] discovered path: source');
      assertEqual(JSON.stringify(reader.reads), JSON.stringify([tree.candidate]), '[origin-guard] the read uses the candidate path');
      assert(persisted(), '[origin-guard] discovered path: persisted');
    }

    // 6. a different case is not the same path off Windows
    const res = await importPath(app, tree.candidate.toUpperCase());
    assertEqual(res.statusCode, 400, '[origin-guard] darwin: a differently-cased path is not a candidate');

    // 7. the router twin: no discovery, so a `{ path }` body gets the same 400 as an undiscovered path
    const router = createRouter({ registry, store: store.defaultStore });
    const twin = await router.handle('POST', '/device/cache/import', JSON.stringify({ path: tree.outside }));
    assertEqual(twin.status, 400, '[origin-guard] router: path body → 400');
    assertEqual(twin.body, JSON.stringify({ error: NOT_A_DISCOVERED_CACHE }), '[origin-guard] router: same body as the app');
    const twinBytes = await router.handle('POST', `/device/cache/import?name=${FILE}`, CACHE_BYTES);
    assertEqual(twinBytes.status, 200, '[origin-guard] router: the bytes import is unchanged');

    // 8. LAN / headless: a same-origin browser (Origin host:port == Host) may import BYTES, but not a
    //    path and not the listing; a mismatched Origin/Host bytes import is refused
    const LAN_ORIGIN = 'http://192.168.1.20:5056';
    const LAN_HOST = '192.168.1.20:5056';
    tree.fs.calls.length = 0;
    reader.reads.length = 0;
    store.defaultStore.delDoc('deviceCaches', KEY);
    const lanPath = await importPath(app, tree.candidate, LAN_ORIGIN, LAN_HOST);
    assertEqual(lanPath.statusCode, 403, '[origin-guard] LAN same-origin path import -> 403');
    assertEqual(JSON.stringify(lanPath.json()), JSON.stringify({ error: FORBIDDEN_ORIGIN }), '[origin-guard] LAN same-origin path import: body');
    const lanList = await sources(app, LAN_ORIGIN, LAN_HOST);
    assertEqual(lanList.statusCode, 403, '[origin-guard] LAN same-origin listing with an Origin -> 403');
    assertEqual(tree.fs.calls.length, 0, '[origin-guard] LAN path import + listing never reach discovery');
    assertEqual(reader.reads.length, 0, '[origin-guard] LAN path import never reads a file');
    for (const [o, h] of [['http://evil.example:5056', LAN_HOST], [LAN_ORIGIN, 'localhost:5056'], ['https://evil.example', undefined]] as [string, string | undefined][]) {
      const res = await importBytes(app, o, h);
      assertEqual(res.statusCode, 403, `[origin-guard] bytes import, Origin ${o} / Host ${String(h)} -> 403`);
    }
    assert(!persisted(), '[origin-guard] refused LAN / mismatched imports persist nothing');
    const lanBytes = await importBytes(app, LAN_ORIGIN, LAN_HOST);
    assertEqual(lanBytes.statusCode, 200, '[origin-guard] LAN same-origin bytes import -> 200');
    assertEqual((lanBytes.json() as { key: string }).key, KEY, '[origin-guard] LAN same-origin bytes import: key');
    assert(persisted(), '[origin-guard] LAN same-origin bytes import: persisted');
    store.defaultStore.delDoc('deviceCaches', KEY);

    // 9. the Remote relay (inject, no Origin) still serves the listing; the import stays local-only
    const realLog = console.log;
    console.log = () => {};
    try {
      const { session, relay } = fakeChannelSession();
      const host = new RemoteHost(app, async () => session, (fn) => registry.subscribe(fn));
      await host.enable(true);
      try {
        const listed = await relay('s1', 'GET', '/device/cache/sources');
        assertEqual(listed.status, 200, '[origin-guard] relayed sources → 200');
        const body = JSON.parse(listed.body) as { candidates: { path: string }[] };
        assertEqual(body.candidates[0]?.path, tree.candidate, '[origin-guard] relayed sources: candidate');
        const imp = await relay('s2', 'POST', '/device/cache/import', { path: tree.candidate });
        assertEqual(imp.status, 403, '[origin-guard] relayed import → 403 (not allowed remotely)');
      } finally {
        await host.enable(false);
      }
    } finally {
      console.log = realLog;
    }
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await app.close();
    rmSync(tree.root, { recursive: true, force: true });
  }

  // 10. Windows: the compare is case-insensitive; the read still uses the candidate's own path
  const win = makeTree('win32');
  const winReader = spyReader();
  const w = await makeApp({ editorCaches: { discover: win.discover, readFile: winReader.readFile } });
  try {
    const res = await importPath(w.app, win.candidate.toUpperCase(), 'http://localhost:5173');
    assertEqual(res.statusCode, 200, '[origin-guard] win32: a differently-cased discovered path imports');
    assertEqual(JSON.stringify(winReader.reads), JSON.stringify([win.candidate]), '[origin-guard] win32: the read uses the candidate path');
  } finally {
    store.defaultStore.delDoc('deviceCaches', KEY);
    await w.app.close();
    rmSync(win.root, { recursive: true, force: true });
  }
}

export async function runOriginGuardTests(): Promise<void> {
  originMatrix();
  await routeCases();
}
