// Shared plumbing for the Phase-6 API suites (alias parity / capabilities): builds the REAL Fastify
// app (buildApp) over an ISOLATED mocked registry — NO hardware, no listening socket (app.inject).
// The registry detects the requested model via a scripted fn 0x00 handshake reply on a MockTransport
// (same pattern as test/drivers/detection.test.ts); a hand-built fake driver can be pre-seeded for a
// model byte so route-level behavior is exercised without scripting the AM4 reader wire protocol.
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, __setDriverForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DeviceDriver } from '../../src/drivers/types.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast } from './mock.js';

export interface TestApp {
  app: FastifyInstance;
  registry: DeviceRegistry;
  mock: MockTransport;
}

/** Build app + isolated registry with the given model detected (via mocked handshake). An optional
 *  fake driver is seeded into the registry's driver cache BEFORE detection activates it. `opts.firmware`
 *  answers detect's fn 0x08 firmware query (frame[6]=major, frame[7]=minor); omitted → that query is silent. */
export async function buildTestApp(modelId: number, fakeDriver?: DeviceDriver, opts: { firmware?: readonly [number, number] } = {}): Promise<TestApp> {
  const mock = new MockTransport('serial', `mock-0x${modelId.toString(16)}`);
  const fw = opts.firmware;
  mock.reply = (req) => isIdentifyBroadcast(req)
    ? [handshakeReply(modelId)]
    : fw && req[0] === 0xf0 && req[5] === 0x08 ? [[0xf0, 0x00, 0x01, 0x74, modelId, 0x08, fw[0], fw[1], 0x00, 0x00, 0xf7]] : [];
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock
  });
  if (fakeDriver) __setDriverForTest(registry, modelId, fakeDriver);
  await registry.detect(); // activate the driver for modelId (fake if seeded)
  const app = await buildApp(registry);
  return { app, registry, mock };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
