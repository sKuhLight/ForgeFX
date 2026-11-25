// Editor-cache import (FORGEFX-31 / META-22) — the SECOND device-cache source alongside A3's
// on-connect live self-describe walk (services/deviceCache.ts). Official Fractal editors write an
// `effectDefinitions_<modelHex>_<fwMajor>p<fwMinor>.cache` file into their config dir. This module parses the
// filename, verifies the file matches the CONNECTED device (model always; firmware unless forced), turns the
// bytes into an editor-cache RAW source (the codec's `rawFromCacheBytes`: records without byte positions,
// user name tables omitted), MERGES it into the stored profile document of the device's key (profile v2: the
// doc keeps every raw source and is derived from all of them, an editor cache outranking a live walk; see
// services/profileMerge.ts), persists it into the SAME `deviceCaches` collection under the SAME key discipline
// as A3, and swaps the runtime profile identically.
//
// Browser-safe: the store + registry are type-only imports (a browser runtime supplies its own) and
// the codec's cache subpath is itself browser-safe. NO node:/fs VALUE imports — this module is in the
// runtime router's import graph (the DISK-scanning half lives in the Node-only editorCacheDiscovery.ts,
// which the router never imports). check-browser-safe.ts enforces it.
import { ProfileDerivationError, ProfileUserDataError, rawFromCacheBytes, type BuiltCache, type EditorCacheRawSource, type ProfileDoc } from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import { resolveCacheKey } from './deviceCache.js';
import { deriveProfileDoc, loadStoredProfile, persistProfile, profileFormatOf } from '../profileSchema.js';
import { ProfileMergeRefused, mergeSourcesIntoStored, refusalBody } from './profileMerge.js';
import type { Store } from '../runtime/store.js';

/** Parsed identity of an `effectDefinitions_<modelHex>_<fwMajor>p<fwMinor>.cache` filename. */
export interface EditorCacheFileInfo { model: number; fwMajor: number; fwMinor: number }

/** The result an import returns to the (thin) endpoint: an HTTP status + the JSON body — mirrors
 *  deviceCache.StartResult so the routes stay one-liners over both twins. */
export interface ImportResult { code: number; body: unknown }

/** 400 error code for a `{ path }` import body naming a file that is not a discovered editor cache
 *  (FORGEFX-47). The browser twin has no discovery, so every path gets it there. */
export const NOT_A_DISCOVERED_CACHE = 'not-a-discovered-cache';

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
 * matches the device's (409 firmware-mismatch, overridable). Turns the bytes into an editor-cache raw source
 * (422 cache-parse-failed on a malformed/foreign cache), merges it into the stored doc of the connected
 * device's key (`opts.replace`: replaces the doc), persists it with `{ source:'editor-cache', importedAt }`
 * meta, and swaps the runtime profile (registry.applyRuntimeCache) exactly like A3.
 * 501 when the active driver isn't cache-import capable (matches A3's selfDescribe gating).
 */
export async function importEditorCache(
  registry: DeviceRegistry,
  store: Store,
  bytes: Uint8Array,
  opts: { name: string; force?: boolean; replace?: boolean },
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

  let built: ProfileDoc;
  try {
    built = await buildEditorCache(model, bytes, fileFw, opts.name);
  } catch (e) {
    // A malformed/foreign cache throws a WalkError (or a seed-anchor failure) — surface it as a 422.
    return { code: 422, body: { error: 'cache-parse-failed', message: (e as Error).message } };
  }

  return importBuiltCache(registry, store, built, info, { replace: opts.replace });
}

/** The editor-cache raw source of a cache file's bytes (strict walk, user name tables omitted, the sha256 of
 *  the redacted bytes), stamped with the firmware it is matched to and the time of the read. Throws a
 *  `WalkError` on a malformed cache. */
export async function editorCacheSource(bytes: Uint8Array, fileFw: string, opts: { fileName?: string; capturedAt?: string } = {}): Promise<EditorCacheRawSource> {
  return rawFromCacheBytes(bytes, {
    ...(opts.fileName ? { fileName: opts.fileName } : {}),
    firmware: fileFw,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    origin: 'local'
  });
}

/** Build an editor cache's bytes for `model` into a standalone profile document (format 2, the one
 *  editor-cache raw source), stamped with the file's firmware. Its derived tables equal the codec's byte
 *  build (`buildCache { kind:'bytes' }`) of the same bytes, plus the synthetic family keys of unassigned
 *  sections. Throws a `WalkError` or a seed-anchor failure on a malformed/foreign cache. Shared by the import
 *  and the contribution validation, so both build the same document. */
export async function buildEditorCache(model: number, bytes: Uint8Array, fileFw: string, fileName?: string): Promise<ProfileDoc> {
  const now = new Date().toISOString();
  const source = await editorCacheSource(bytes, fileFw, { capturedAt: now, ...(fileName ? { fileName } : {}) });
  return deriveProfileDoc({ format: 1, sources: [source] }, model, fileFw, now, { builtAt: now });
}

/** Map a derivation/persist failure of a merge to the import's HTTP answer. */
function mergeFailure(e: unknown): ImportResult {
  if (e instanceof ProfileMergeRefused) return { code: 409, body: refusalBody(e.refusal) };
  if (e instanceof ProfileUserDataError) return { code: 500, body: { error: 'contains-user-data', message: e.message } };
  if (e instanceof ProfileDerivationError && e.code === 'firmware-mismatch') return { code: 409, body: { error: 'firmware-differs', message: e.message } };
  return { code: 422, body: { error: 'derivation-failed', message: (e as Error).message } };
}

/**
 * Persist an already BUILT editor cache (`buildEditorCache`) as the device cache and swap the runtime
 * profile — the second half of `importEditorCache`, split out so the contribution path imports the cache it
 * validated without building it twice. The caller has already checked capability, model and firmware.
 * `file` is the file name's identity (model + firmware), the key fallback when the device firmware is unknown.
 * A format-2 `built` merges its raw source into the stored doc (`opts.replace`: replaces it); the legacy
 * derived-only shape replaces the doc. A doc a newer build wrote is never rewritten (409 `newer-profile` unless
 * `replace`, profileMerge.ts `mergeRefusal`). Over a stale doc whose sources do not derive, the import is stored
 * next to them; if they still do not derive the answer is 422 `derivation-failed` with `stored: true`.
 */
export async function importBuiltCache(
  registry: DeviceRegistry,
  store: Store,
  built: BuiltCache | ProfileDoc,
  file: EditorCacheFileInfo,
  opts: { replace?: boolean } = {},
): Promise<ImportResult> {
  const model = file.model;
  const fw = registry.firmwareInfo();
  const fileFw = `${file.fwMajor}.${file.fwMinor}`;
  // Persist under the CONNECTED device's key so applyRuntimeCache (which reads by the device's own
  // firmware) picks it up immediately; fall back to the file's firmware only when the device's is
  // unknown (force path). Provenance rides in `meta.source` + `firmware`.
  const keyMajor = fw?.major ?? file.fwMajor;
  const keyMinor = fw?.minor ?? file.fwMinor;
  const key = deviceCacheKey(model, keyMajor, keyMinor);
  const importedAt = new Date().toISOString();
  let doc: BuiltCache;
  let kept = 0;
  let derivationFailed: string | undefined;
  try {
    if (profileFormatOf(built) === 2) {
      // The doc's firmware is the FILE's: a forced import of another firmware's cache cannot merge with the
      // sources of the device's firmware (they are dropped) and keeps reporting the file's firmware.
      const merged = mergeSourcesIntoStored(store, {
        key, model, firmware: fileFw, incoming: (built as ProfileDoc).raw.sources, replace: opts.replace,
        extras: { importedAt, builtAt: importedAt }, now: importedAt
      });
      doc = merged.doc;
      kept = merged.kept;
      derivationFailed = merged.derivationFailed;
    } else {
      // `built.meta.schema` is the codec's current stamp, so an import over a stale profile replaces it
      // with a usable one (the import never consults the stored profile, stale or not).
      doc = { ...built, meta: { ...built.meta, source: 'editor-cache' as const, importedAt } } as unknown as BuiltCache;
    }
  } catch (e) {
    return mergeFailure(e);
  }
  try {
    persistProfile(store, key, doc);
  } catch (e) {
    if (e instanceof ProfileUserDataError) return mergeFailure(e);
    throw e; // a store failure is not a derivation problem: it propagates as before
  }
  await registry.applyRuntimeCache(); // adopt the imported device-true profile immediately
  if (derivationFailed !== undefined) {
    // the stored doc was stale (its sources did not derive) and still does not derive with the import added: the
    // import is kept next to the other sources (nothing lost), the doc stays stale
    return { code: 422, body: { error: 'derivation-failed', message: derivationFailed, stored: true, key } };
  }
  // Tell live UIs the cache changed (same terminal signal A3 emits after a build).
  registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: 0, total: 0, key, model, firmware: fileFw });
  if (kept > 0) registry.emitEvent({ type: 'definitions', reason: 'merged', key });
  const v2 = profileFormatOf(doc) === 2 ? (doc as unknown as ProfileDoc) : null;

  return {
    code: 200,
    body: {
      ok: true, imported: true, key, model, firmware: fileFw, source: 'editor-cache', recordCount: built.meta.recordCount,
      ...(v2 ? { format: 2, sources: v2.meta.sources, coverage: v2.coverage, merged: kept > 0 } : {})
    },
  };
}
