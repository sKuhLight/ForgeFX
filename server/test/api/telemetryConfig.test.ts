// GET/PUT /telemetry/config (FORGEFX-26) — mode read/round-trip, effective-cadence changes per mode,
// 400 on an unknown mode, the telemetryConfig SSE event on a switch, and app↔router surface parity.
// Uses the REAL buildApp over a mocked FM3 detection (gen-3 family cadence), plus a router over the
// SAME registry to prove both surfaces answer identically.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { buildTestApp } from '../helpers/api.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const TELEMETRY_CONFIG_CASE_COUNT = 6;

type Cad = {
  meterTickMs: number; meterSlowMs: number; cpuEveryNTicks: number; channelEveryNTicks: number;
  sceneEveryNTicks: number; editWatchMs: number; editWatchSlowMs: number; tunerMs: number; editRehashMs: number;
};
type Dto = { mode: string; effective: Cad; modes: string[] };

export async function runTelemetryConfigTests(): Promise<void> {
  const { app, registry } = await buildTestApp(0x11); // FM3 → gen-3 cadence family
  try {
    // 1 — GET default is 'balanced'; gen-3 balanced relaxes the meter tick to 100 ms (invisible smoothing)
    //     but holds scene/channel every-Nth at 8.
    const g = await app.inject({ method: 'GET', url: '/telemetry/config' });
    assertEqual(g.statusCode, 200, 'GET /telemetry/config status');
    const gd = g.json() as Dto;
    assertEqual(gd.mode, 'balanced', 'default mode is balanced');
    assertEqual(gd.modes.join(','), 'performance,balanced,reduced', 'modes list');
    assertEqual(gd.effective.meterTickMs, 100, 'balanced gen-3 meterTickMs');
    assertEqual(gd.effective.editWatchMs, 2000, 'balanced gen-3 editWatchMs');
    assertEqual(gd.effective.sceneEveryNTicks, 8, 'balanced sceneEveryNTicks (latency held stable)');
    assertEqual(gd.effective.tunerMs, 55, 'gen-3 tunerMs (family-fixed)');

    // 2 — PUT performance round-trips + tightens the effective cadence (60 / 1500). editRehash is now 0
    //     in EVERY mode (FORGEFX-25 follow-up: the AM4 latched re-dump glitched audio after a channel swap).
    const p = await app.inject({ method: 'PUT', url: '/telemetry/config', payload: { mode: 'performance' } });
    assertEqual(p.statusCode, 200, 'PUT performance status');
    const pd = p.json() as Dto;
    assertEqual(pd.mode, 'performance', 'PUT echoes performance');
    assertEqual(pd.effective.meterTickMs, 60, 'performance meterTickMs');
    assertEqual(pd.effective.editWatchMs, 1500, 'performance editWatchMs');
    assertEqual(pd.effective.editRehashMs, 0, 'performance editRehashMs disabled (latched rehash off in all modes)');
    // GET now reflects the switch (in-memory persistence)
    const g2 = (await app.inject({ method: 'GET', url: '/telemetry/config' })).json() as Dto;
    assertEqual(g2.mode, 'performance', 'GET reflects the switch');

    // 3 — reduced coarsens the meter tick (400) + CPU cadence (16); editRehash stays 0 (as in all modes)
    const r = (await app.inject({ method: 'PUT', url: '/telemetry/config', payload: { mode: 'reduced' } })).json() as Dto;
    assertEqual(r.effective.meterTickMs, 400, 'reduced meterTickMs');
    assertEqual(r.effective.cpuEveryNTicks, 16, 'reduced cpuEveryNTicks');
    assertEqual(r.effective.editRehashMs, 0, 'reduced editRehashMs disabled');

    // 4 — an unknown mode 400s and does NOT change the stored mode
    const bad = await app.inject({ method: 'PUT', url: '/telemetry/config', payload: { mode: 'ludicrous' } });
    assertEqual(bad.statusCode, 400, 'unknown mode → 400');
    const still = (await app.inject({ method: 'GET', url: '/telemetry/config' })).json() as Dto;
    assertEqual(still.mode, 'reduced', 'mode unchanged after a rejected PUT');

    // 5 — a mode switch emits a telemetryConfig event to SSE subscribers
    const events: DeviceEvent[] = [];
    const unsub = registry.subscribe((e) => events.push(e));
    await app.inject({ method: 'PUT', url: '/telemetry/config', payload: { mode: 'balanced' } });
    unsub();
    const tc = events.filter((e) => e.type === 'telemetryConfig');
    assert(tc.length >= 1, `telemetryConfig event emitted (got ${tc.length})`);
    assertEqual((tc.at(-1) as { mode: string }).mode, 'balanced', 'event carries the new mode');

    // 6 — router surface parity: same DTO from the browser-facing router over the SAME registry
    const router = createRouter({ registry, store: store.defaultStore });
    const routed = await router.handle('GET', '/telemetry/config');
    assertEqual(routed.status, 200, 'router GET status');
    const rd = JSON.parse(routed.body as string) as Dto;
    assertEqual(rd.mode, 'balanced', 'router mode matches app');
    assertEqual(rd.effective.meterTickMs, 100, 'router effective matches app');
    const routedBad = await router.handle('PUT', '/telemetry/config', JSON.stringify({ mode: 'nope' }));
    assertEqual(routedBad.status, 400, 'router unknown mode → 400');
  } finally {
    await app.close();
  }
}
