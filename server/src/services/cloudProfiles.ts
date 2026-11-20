// Cloud device-definition profiles (META-22) — the THIRD cache source alongside A3's live walk
// (services/deviceCache.ts) and the editor-cache import (services/editorCacheImport.ts). Profiles are
// shared, non-user data in axis-cloud's `device_profiles` store: identical for every device of the
// same model on the same firmware. check → is one available for the ATTACHED device; pull → persist it
// into `deviceCaches` under the standard key + swap the runtime profile (indistinguishable from a
// walked/imported cache at read time); publish → upload the locally persisted profile so the next user
// on this firmware skips the walk entirely.
//
// Schema gate (profileSchema.ts): a profile whose `meta.schema` this build cannot use (missing, outdated,
// newer) is never adopted, in either direction. CHECK reports such a row as unavailable (+ `stale`), PULL
// refuses it with a 409 instead of storing it (storing an unusable profile would only make the next
// status read "stale" with nothing the user can do about it, and could replace a profile that is fine),
// PUBLISH refuses to upload a stale local profile (409) so the shared store only ever receives profiles
// other builds can use. Nothing is deleted, locally or in the cloud.
//
// Browser-safe: registry/store/cloud are type-only or structural imports; the fetch work lives in
// runtime/cloud.ts (itself browser-safe). check-browser-safe.ts enforces it.
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import { resolveCacheKey } from './deviceCache.js';
import { CURRENT_CACHE_SCHEMA, checkProfileSchema, staleFields, type StaleReason } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';
import type { ImportResult } from './editorCacheImport.js';

/** The slice of the Cloud service these functions need — structural so tests fake it in two lines
 *  (and so the browser twin can pass its own Cloud instance through RuntimeDeps.cloud). */
export interface DeviceProfileCloud {
  /** `schema` = the profile schema this build can use (always passed): the endpoint answers with the newest
   *  row of that schema, so builds on different schemas do not hide each other's shared profiles. */
  deviceProfileGet(model: number, firmware: string, schema?: number): Promise<{ profile: unknown; contentHash: string; source: string; recordCount: number | null; createdAt: string } | null>;
  deviceProfilePublish(body: { model: number; firmware: string; source: 'live-walk' | 'editor-cache'; profile: unknown }): Promise<{ code: number; body: unknown }>;
}

/** check's GET result caches here so an immediately following pull doesn't refetch the (possibly
 *  hundreds-of-KB) profile. Keyed per registry, invalidated when the device key changes. */
const LAST_CHECK = new WeakMap<DeviceRegistry, { key: string; row: NonNullable<Awaited<ReturnType<DeviceProfileCloud['deviceProfileGet']>>> }>();

/** The attached device's (model, canonical firmware string, cache key), or null until detection
 *  populates them. Cloud rows are keyed by the SAME major.minor the local store keys on. Devices
 *  without a firmware read (AM4 — fn 0x08 is gen-3 only) derive their identity from the newest
 *  persisted doc's key: imports store under the FILE's firmware, so publish/check work after the
 *  first import even though the registry itself never learns a version. */
async function deviceIdentity(store: Store, registry: DeviceRegistry): Promise<{ model: number; firmware: string; key: string } | null> {
  await registry.driver(); // ensure detection ran
  const model = registry.detectedModelId;
  if (model < 0) return null;
  const fw = registry.firmwareInfo();
  if (fw) return { model, firmware: `${fw.major}.${fw.minor}`, key: deviceCacheKey(model, fw.major, fw.minor) };
  const key = resolveCacheKey(store, registry);
  const m = key?.match(/^[0-9a-f]{1,2}_(\d+)p(\d+)$/);
  if (!key || !m) return null;
  return { model, firmware: `${Number(m[1])}.${Number(m[2])}`, key };
}

/** GET /device/cache/cloud result. A row whose schema this build cannot use is NOT available; it is
 *  reported with the additive `stale` fields (why, stored vs current schema) so a UI can say so. */
export interface CloudCacheCheck {
  enabled: boolean;
  available: boolean;
  meta?: { source: string; recordCount: number | null; createdAt: string; contentHash: string };
  stale?: true;
  staleReason?: StaleReason;
  schema?: number | null;
  currentSchema?: number;
}

/** GET /device/cache/cloud — is a USABLE shared profile available for the attached device+firmware?
 *  Fetches (and caches) the row so a following pull is instant. `enabled:false` when cloud is off entirely. */
export async function cloudCacheCheck(cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry): Promise<CloudCacheCheck> {
  if (!cloud) return { enabled: false, available: false };
  const id = await deviceIdentity(store, registry);
  if (!id) return { enabled: true, available: false };
  const row = await cloud.deviceProfileGet(id.model, id.firmware, CURRENT_CACHE_SCHEMA);
  if (!row) return { enabled: true, available: false };
  // Backstop for a cloud endpoint that ignores the schema filter (older deployment): still judge the row.
  const verdict = checkProfileSchema(row.profile);
  if (!verdict.usable) {
    LAST_CHECK.delete(registry); // never let a pull reuse a row that was just judged unusable
    return { enabled: true, available: false, ...staleFields(verdict) };
  }
  LAST_CHECK.set(registry, { key: id.key, row });
  return { enabled: true, available: true, meta: { source: row.source, recordCount: row.recordCount, createdAt: row.createdAt, contentHash: row.contentHash } };
}

/** POST /device/cache/cloud/pull — adopt the shared profile for the attached device: persist it into
 *  `deviceCaches` (source 'cloud', original kind kept as `origin`) + swap the runtime profile, exactly
 *  like a finished walk/import. Model/firmware match is inherent — the row was fetched BY the attached
 *  identity. Gated on the same capability as import (only cache-capable devices apply profiles). A row
 *  whose schema this build cannot use is refused with 409 `cloud-profile-stale` (+ reason, stored and
 *  current schema) and NOT stored: the local profile, if any, is left exactly as it was. */
export async function cloudCachePull(cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const caps = registry.activeCapabilities();
  if (!caps?.cacheImport) return { code: 501, body: { error: 'unsupported', capability: 'cacheImport' } };
  const id = await deviceIdentity(store, registry);
  if (!id) return { code: 503, body: { error: 'no device detected' } };

  const cached = LAST_CHECK.get(registry);
  const row = cached?.key === id.key ? cached.row : await cloud.deviceProfileGet(id.model, id.firmware, CURRENT_CACHE_SCHEMA);
  if (!row) return { code: 404, body: { error: 'no cloud profile for this device+firmware' } };

  const p = row.profile as { meta?: Record<string, unknown> } | null;
  if (!p || typeof p !== 'object' || !p.meta) return { code: 422, body: { error: 'cloud profile malformed' } };
  const verdict = checkProfileSchema(p);
  if (!verdict.usable) return { code: 409, body: { error: 'cloud-profile-stale', ...staleFields(verdict) } };
  // Source becomes 'cloud' for surfacing; the build kind it originally came from rides in `origin`.
  const doc = { ...p, meta: { ...p.meta, source: 'cloud' as const, origin: p.meta.source, pulledAt: new Date().toISOString(), contentHash: row.contentHash } };
  store.putDoc('deviceCaches', id.key, doc);
  await registry.applyRuntimeCache();
  registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: 0, total: 0, key: id.key, model: id.model, firmware: id.firmware });
  return { code: 200, body: { ok: true, pulled: true, key: id.key, model: id.model, firmware: id.firmware, source: 'cloud', contentHash: row.contentHash } };
}

/** POST /device/cache/cloud/publish — upload the locally persisted profile for the attached device.
 *  Maps the store's source kinds to the API's ('live' → 'live-walk', 'editor-cache' stays; a profile
 *  that itself CAME from the cloud is refused — nothing new to share). A STALE local profile (schema this
 *  build cannot use) is refused with 409 `profile-stale` and never uploaded: re-read the definitions first.
 *  The store validator expects the codec's meta.source vocabulary ('live'|'bytes'), so the uploaded copy
 *  is normalized back to it. */
export async function cloudCachePublish(cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const id = await deviceIdentity(store, registry);
  if (!id) return { code: 503, body: { error: 'no device detected' } };
  const doc = store.getDoc('deviceCaches', id.key);
  const data = doc && !doc.deleted ? (doc.data as { meta?: { source?: string } }) : null;
  if (!data?.meta) return { code: 404, body: { error: 'no locally persisted profile to publish' } };

  const kind = data.meta.source;
  const apiSource = kind === 'live' ? 'live-walk' as const : kind === 'editor-cache' ? 'editor-cache' as const : null;
  if (!apiSource) return { code: 409, body: { error: `profile source '${kind}' is not publishable (already from the cloud?)` } };
  const verdict = checkProfileSchema(data);
  if (!verdict.usable) return { code: 409, body: { error: 'profile-stale', ...staleFields(verdict) } };
  const upload = { ...data, meta: { ...data.meta, source: apiSource === 'live-walk' ? 'live' : 'bytes' } };
  const r = await cloud.deviceProfilePublish({ model: id.model, firmware: id.firmware, source: apiSource, profile: upload });
  return { code: r.code, body: r.body };
}
