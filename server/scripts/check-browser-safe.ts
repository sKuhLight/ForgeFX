/**
 * Browser-safety probe for the runtime package subpath (mirrors forgefx-midi's script).
 *
 * Bundles each browser-relevant entry point from SOURCE with esbuild at
 * `platform: 'browser'`. If any module in the graph imports a Node core
 * module (`node:fs`, `path`, …) or a Node-only package (fastify, serialport,
 * @julusian/midi), resolution fails and this script exits non-zero.
 *
 * Deliberately NOT probed (Node-only by design):
 *   - src/index.ts / src/app.ts   — Fastify server + SSE + static UI
 *   - src/drivers/registry.ts     — the singleton over the real transports
 *   - src/store.ts / localStore.ts / cloud.ts / telemetry.ts — the fs/env-bound faces
 *
 * Run via `npm test` (chained) or `npm run check:browser`.
 */
import { build } from 'esbuild';

const ENTRIES = [
  'src/runtime/index.ts',
  'src/drivers/paramIndex.ts', // the pure param index: no runtime import path reaches it yet
];

let failed = 0;
for (const entry of ENTRIES) {
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
    });
    console.log(`PASS  browser-safe: ${entry}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message.split('\n').slice(0, 6).join('\n') : String(e);
    console.error(`FAIL  browser-safe: ${entry}\n${msg}`);
  }
}

if (failed) {
  console.error(`check-browser-safe: ${failed}/${ENTRIES.length} entry point(s) pull Node-only code.`);
  process.exit(1);
}
console.log(`check-browser-safe: all ${ENTRIES.length} entry points bundle clean for the browser.`);
