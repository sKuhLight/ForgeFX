// ForgeFX HTTP API — production entry point. Mirrors the REST contract Axis consumes; drop-in
// replacement for the retired C# server. All routes live in the buildApp() factory (app.ts) so the
// API tests can inject against an isolated registry; this module keeps the process concerns:
// .env loading, the Electron WebSocket shim, port allocation, and listening.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from './drivers/registry.js';
import { buildApp } from './app.js';
import { selectBindHost } from './services/bindHost.js';

// Load the server's .env (Supabase creds + AXIS_CLOUD/AXIS_TELEMETRY/AXIS_FARO_URL) — keeps secrets out
// of source so the public repo never ships a hosted instance's keys. Resolve it RELATIVE TO THIS MODULE
// (server/.env, one level above dist/ or src/) so it's found regardless of the process cwd — the packaged
// app imports us in-process from Electron, where cwd is not the server dir. Falls back to cwd, then to the
// ambient OS env. The release build writes server/.env from CI secrets; in dev it's the local .env.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')); }
catch { try { process.loadEnvFile(); } catch { /* rely on the ambient environment */ } }

// supabase-js builds a realtime client in createClient() that needs a global WebSocket. Electron's bundled
// Node (20) has none (WebSocket is global only in Node 22+), so createClient throws in PACKAGED builds and
// cloud/telemetry silently appear "disabled" — even though the env is loaded. Provide `ws` globally before
// any client is created. ForgeFX never opens a realtime channel; this only satisfies the constructor. In
// dev / Node 22+ a global WebSocket already exists, so this is a no-op there.
if (typeof globalThis.WebSocket === 'undefined') {
  try { (globalThis as { WebSocket?: unknown }).WebSocket = (await import('ws')).default; }
  catch { /* ws unavailable — cloud will surface a clear error instead of a silent disable */ }
}

const PORT = Number(process.env.PORT ?? 5056);
// Listen address (services/bindHost.ts): loopback inside the Electron desktop app, all interfaces elsewhere
// (Docker / headless / dev keep LAN access); FORGEFX_HOST overrides.
const HOST = selectBindHost();
const app = await buildApp(registry, { http: { bindHost: HOST } }); // the Host allowlist depends on the bind

// Auto port allocation: try PORT; if it's taken, let the OS assign a free one (port 0).
// The actual bound port is logged (and the desktop app picks a free port up front anyway).
async function listen(port: number, fellBack = false): Promise<void> {
  try {
    await app.listen({ port, host: HOST });
    const addr = app.server.address();
    const actual = addr && typeof addr === 'object' ? addr.port : port;
    app.log.info(`ForgeFX (node) on http://localhost:${actual} (listening on ${HOST})`);
    // one-shot startup diagnostic — lands in the desktop debug log even if the /diag fetch never fires
    registry.diagnostics().then((d) => app.log.info({ diag: d }, 'forgefx startup diagnostics')).catch(() => {});
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && !fellBack) {
      app.log.warn(`port ${port} in use — falling back to an OS-assigned free port`);
      return listen(0, true);
    }
    app.log.error(e);
    process.exit(1);
  }
}
listen(PORT);
