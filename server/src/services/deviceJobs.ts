// Exclusive long-running device jobs — at most ONE of the device-cache build, the diagnostic capture, the block
// probe and the spot check of shared definitions (`cloud-verify`, services/spotCheck.ts) runs per registry at a time
// (each streams definition queries over the one shared link). Each service claims the device before it starts and
// releases it when its job settles; the others answer 409.
//
// Browser-safe: the registry is a type-only import.
import type { DeviceRegistry } from '../drivers/registryCore.js';

export type DeviceJob = 'capture' | 'cache-build' | 'block-probe' | 'cloud-verify';

const BUSY = new WeakMap<DeviceRegistry, DeviceJob>();

/** The exclusive job currently holding the device, or null. */
export function deviceBusy(registry: DeviceRegistry): DeviceJob | null {
  return BUSY.get(registry) ?? null;
}

/** Claim the device for `job`. False when another job (or the same kind) already holds it. */
export function claimDevice(registry: DeviceRegistry, job: DeviceJob): boolean {
  if (BUSY.has(registry)) return false;
  BUSY.set(registry, job);
  return true;
}

/** Release the device — only when `job` is the one holding it. */
export function releaseDevice(registry: DeviceRegistry, job: DeviceJob): void {
  if (BUSY.get(registry) === job) BUSY.delete(registry);
}
