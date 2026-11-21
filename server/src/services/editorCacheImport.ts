// Editor-cache import (FORGEFX-31 / META-22) — the SECOND device-cache source alongside A3's
// on-connect live self-describe walk (services/deviceCache.ts). Official Fractal editors write an
// `effectDefinitions_<modelHex>_<fwMajor>p<fwMinor>.cache` file into their config dir; feeding that
// file's bytes through the codec's BYTE record-source (buildCache { kind:'bytes' }) yields the exact
// same device-true `BuiltCache` the live walk produces. This module parses the filename, verifies the
// file matches the CONNECTED device (model always; firmware unless forced), builds, persists into the
// SAME `deviceCaches` collection under the SAME key discipline as A3, and swaps the runtime profile
// identically — so an imported cache is indistinguishable from a walked one at read time.
//
// Browser-safe: the store + registry are type-only imports (a browser runtime supplies its own) and
// the codec's cache subpath is itself browser-safe. NO node:/fs VALUE imports — this module is in the
// runtime router's import graph (the DISK-scanning half lives in the Node-only editorCacheDiscovery.ts,
// which the router never imports). check-browser-safe.ts enforces it.
import { buildCache, type BuiltCache } from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import { catalogForModel, resolveCacheKey } from './deviceCache.js';
import { loadStoredProfile } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';

/** Parsed identity of an `effectDefinitions_<modelHex>_<fwMajor>p<fwMinor>.cache` filename. */
export interface EditorCacheFileInfo { model: number; fwMajor: number; fwMinor: number }

/** The result an import returns to the (thin) endpoint: an HTTP status + the JSON body — mirrors
 *  deviceCache.StartResult so the routes stay one-liners over both twins. */
export interface ImportResult { code: number; body: unknown }

// e.g. `effectDefinitions_11_12p0.cache` (FM3 fw 12.0), `effectDefinitions_15_2p1.cache` (AM4 fw 2.1).
const FILENAME_RE = /^effectDefinitions_([0-9a-fA-F]{1,2})_(\d+)p(\d+)\.cache$/;

/** Parse an editor cache filename → {model, fwMajor, fwMinor}, or null if it isn't one. Tolerates a
 *  leading directory path (basename is matched). Model is the hex byte (`11` → 0x11). */
export function parseEditorCacheFilename(name: string): EditorCacheFileInfo | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = FILENAME_RE.exec(base);
  if (!m) return null;
  return { model: parseInt(m[1]!, 16), fwMajor: Number(m[2]), fwMinor: Number(m[3]) };
}

/** Does a USABLE persisted cache already exist for the CURRENTLY attached model+firmware? Drives the
 *  `persisted` flag of GET /device/cache/sources (both twins call it; candidates are added per-twin).
 *  A stale profile (schema this build cannot use) is not "persisted": it is not applied, and the
 *  definitions still have to be acquired (GET /device/cache reports it as `stale`). */
export async function isPersisted(store: Store, registry: DeviceRegistry): Promise<boolean> {
  await registry.driver(); // ensure detection ran so model/firmware are populated
  const key = resolveCacheKey(store, registry);
  if (!key) return false;
  return loadStoredProfile(store, key).state === 'usable';
}

/**
 * Import an official-editor `.cache` file's bytes as the device cache. Verifies the file's model
 * matches the connected device (409 model-mismatch) and — unless `opts.force` — that its firmware
 * matches the device's (409 firmware-mismatch, overridable). Builds through the codec BYTE source,
 * persists into `deviceCaches` under the connected device's key with `{ source:'editor-cache',
 * importedAt }` meta, and swaps the runtime profile (registry.applyRuntimeCache) exactly like A3.
 * 501 when the active driver isn't cache-import capable (matches A3's selfDescribe gating).
 */
export async function importEditorCache(
  registry: DeviceRegistry,
  store: Store,
  bytes: Uint8Array,
  opts: { name: string; force?: boolean },
): Promise<ImportResult> {
  await registry.driver(); // ensure detection ran (model/firmware/capabilities populated)
  const caps = registry.activeCapabilities();
  if (!caps?.cacheImport) return { code: 501, body: { error: 'unsupported', capability: 'cacheImport' } };

  const info = parseEditorCacheFilename(opts.name);
  if (!info) return { code: 400, body: { error: 'not an effectDefinitions_<modelHex>_<fwMajor>p<fwMinor>.cache filename', name: opts.name } };
  if (!bytes.length) return { code: 400, body: { error: 'empty cache file' } };

  const model = registry.detectedModelId;
  if (model < 0) return { code: 503, body: { error: 'no device detected' } };
  // Model must match the attached unit — a foreign device's cache is never applied.
  if (info.model !== model) {
    return { code: 409, body: { error: 'model-mismatch', expected: model, got: info.model } };
  }

  const fw = registry.firmwareInfo();
  const fileFw = `${info.fwMajor}.${info.fwMinor}`;
  // Firmware must match unless forced (a fw-drift import can misdescribe params). A device whose
  // running firmware is UNKNOWN (no gen-3 fn 0x08 — e.g. the AM4) has nothing to mismatch against:
  // accept the file and key the doc by the FILE's firmware.
  if (!opts.force && fw && (fw.major !== info.fwMajor || fw.minor !== info.fwMinor)) {
    return { code: 409, body: { error: 'firmware-mismatch', expected: fw.version, got: fileFw, overridable: true } };
  }

  let built: BuiltCache;
  try {
    const catalog = catalogForModel(model);
    built = await buildCache(
      { kind: 'bytes', buf: bytes },
      catalog.params,
      catalog.seeds,
      { model, firmware: fileFw, builtAt: new Date().toISOString() },
    );
  } catch (e) {
    // A malformed/foreign cache throws a WalkError (or a seed-anchor failure) — surface it as a 422.
    return { code: 422, body: { error: 'cache-parse-failed', message: (e as Error).message } };
  }

  // Persist under the CONNECTED device's key so applyRuntimeCache (which reads by the device's own
  // firmware) picks it up immediately; fall back to the file's firmware only when the device's is
  // unknown (force path). Provenance rides in `meta.source` + `firmware`.
  const keyMajor = fw?.major ?? info.fwMajor;
  const keyMinor = fw?.minor ?? info.fwMinor;
  const key = deviceCacheKey(model, keyMajor, keyMinor);
  // `built.meta.schema` is the codec's current stamp, so an import over a stale profile replaces it
  // with a usable one (the import never consults the stored profile, stale or not).
  const doc = { ...built, meta: { ...built.meta, source: 'editor-cache' as const, importedAt: new Date().toISOString() } };
  store.putDoc('deviceCaches', key, doc);
  await registry.applyRuntimeCache(); // adopt the imported device-true profile immediately
  // Tell live UIs the cache changed (same terminal signal A3 emits after a build).
  registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: 0, total: 0, key, model, firmware: fileFw });

  return {
    code: 200,
    body: { ok: true, imported: true, key, model, firmware: fileFw, source: 'editor-cache', recordCount: built.meta.recordCount },
  };
}
