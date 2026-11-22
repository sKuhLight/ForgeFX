// MUST be imported FIRST by test/run-all.ts (before any suite pulls in transport/connection.ts):
// connection.ts reads its override file (~/.forgefx-conn by default) at module-load time and the
// tests call setConnOverride/setProfileOverride, which PERSIST. Point the override file at a
// throwaway path so the tests never read or clobber the user's real connection override.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT_FILE = join(tmpdir(), `forgefx-test-conn-${process.pid}.json`);
// The API suites build the full Fastify app (buildApp), which loads store.ts — point its data dir
// at a throwaway path so tests never read or write the user's real ~/.axis store.
const DATA_DIR = join(tmpdir(), `forgefx-test-data-${process.pid}`);

// Both paths are keyed by PID, and Windows reuses PIDs: a crashed or older run's leftovers under the
// same PID would leak versions, device caches or a connection override into this run. Start empty
// (before store.ts / connection.ts read them), and clean up best-effort on exit. Only THIS PID's
// paths are touched; other runs' leftovers are left alone.
const clean = (): void => {
  for (const p of [DATA_DIR, PORT_FILE]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};
clean();
process.on('exit', clean);

process.env.FORGEFX_PORT_FILE = PORT_FILE;
process.env.FORGEFX_DATA_DIR = DATA_DIR;
// Make sure an ambient device-profile override can't leak into the detection tests.
delete process.env.FORGEFX_DEVICE;
// Keep the app quiet + hermetic in tests: no cloud routes, no static SPA handler, terse logs.
delete process.env.AXIS_CLOUD;
delete process.env.FORGEFX_STATIC;
process.env.LOG_LEVEL ??= 'silent';
