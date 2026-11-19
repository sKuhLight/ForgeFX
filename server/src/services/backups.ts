// Backups / version control — device-INDEPENDENT policy that composes a driver's dump/load/store
// primitives with the content-addressed version store. Moved out of the old Device class; the routes
// hand in the active driver (after capability-gating on presetDump/loadPresetBytes/store) AND the
// store instance (the server passes store.defaultStore, the browser runtime its own) — type-only
// store imports keep this module browser-safe for the runtime router.
import type { Store } from '../runtime/store.js';
import type { PresetVersion, Backup } from '../runtime/storeBackend.js';
import type { DeviceDriver } from '../drivers/types.js';

/** Snapshot one preset into the version store (dedup'd by CRC). Returns the version, or null if empty. */
export async function backupPreset(store: Store, d: DeviceDriver, n: number, source: 'manual' | 'auto' | 'backup' = 'manual', backupId?: string): Promise<PresetVersion | null> {
  const { bytes, summary } = await d.dumpRaw!(n);
  if (!summary.crcValid || !summary.name.trim()) return null;
  return store.addPresetVersion({ location: n, crc: summary.crc, name: summary.name, model: summary.model, source, backupId }, bytes);
}

/** Full-device backup: snapshot every populated slot under one backup id. */
export async function backupDevice(store: Store, d: DeviceDriver, label: string, from = 0, to = 511): Promise<Backup> {
  const b = store.createBackup(label || 'Device backup', d.name);
  let count = 0;
  for (let n = from; n <= to; n++) {
    try { if (await backupPreset(store, d, n, 'backup', b.id)) count++; } catch { /* empty/unreadable slot */ }
  }
  store.setBackupCount(b.id, count);
  return { ...b, count };
}

/** Load a stored version snapshot into the edit buffer. */
export async function loadVersion(store: Store, d: DeviceDriver, id: string): Promise<{ ok: boolean }> {
  const bytes = store.getPresetVersionBytes(id);
  if (!bytes) throw new Error('version not found');
  return d.loadPresetBytes!(bytes);
}

/** Restore a version to its origin slot: load it into the edit buffer, then commit it to that slot
 *  (DESTRUCTIVE for that slot). This is the "Restore this version to device" action — unlike
 *  loadVersion, it persists to the preset's location, not just the edit buffer. */
export async function restoreVersion(store: Store, d: DeviceDriver, id: string): Promise<{ ok: boolean; location: number; error?: string; warning?: string }> {
  const v = store.getPresetVersion(id);
  if (!v) throw new Error('version not found');
  if (v.location < 0) throw new Error('version has no slot to restore to');
  await loadVersion(store, d, id);
  // The commit's own verdict decides the answer: a store the device refused or never acknowledged must
  // not be reported as a successful restore.
  const r = await d.store!(v.location);
  return { ok: r.ok, location: v.location, ...(r.error ? { error: r.error } : {}), ...(r.warning ? { warning: r.warning } : {}) };
}
