// Cloud device-definition profiles (META-22) — the THIRD cache source alongside A3's live walk
// (services/deviceCache.ts) and the editor-cache import (services/editorCacheImport.ts). Profiles are
// shared, non-user data in axis-cloud's `device_profiles` store: identical for every device of the
// same model on the same firmware. check → is one available for the ATTACHED device; pull → persist it
// into `deviceCaches` under the standard key + swap the runtime profile (indistinguishable from a
// walked/imported cache at read time); publish → upload the locally persisted profile so the next user
// on this firmware skips the walk entirely.
//
// Profile v2 (M3): a pull MERGES a format-2 cloud doc's raw sources into the stored doc (a local source always
// outranks a cloud source of the same kind) and adopts a format-1 cloud doc only when no usable local profile
// is stored (409 `local-profile-better` otherwise, unless `replace`). A publish uploads the derived tables only:
// raw sources stay local until M4.
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
import { assertNoUserTables, isSyntheticFamilyKey, ProfileDerivationError, ProfileUserDataError, type ProfileDoc } from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import { resolveCacheKey } from './deviceCache.js';
import {
  CURRENT_CACHE_SCHEMA, checkProfileSchema, deriveProfileDoc, loadStoredProfile, metaExtrasOf, persistProfile, profileFormatOf,
  readableRaw, rederiveReasonOf, staleFields, type StaleReason
} from '../profileSchema.js';
import { ProfileMergeRefused, foreignSources, mergeRefusal, mergeSourcesIntoStored, refusalBody } from './profileMerge.js';
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
 *  reported with the additive `stale` fields (why, stored vs current schema) so a UI can say so — unless it is a
 *  format-2 row whose raw sources this build can read: a pull re-derives it (`rederivable: true`, available). */
export interface CloudCacheCheck {
  enabled: boolean;
  available: boolean;
  meta?: { source: string; recordCount: number | null; createdAt: string; contentHash: string };
  /** The row's derived tables are not this build's (another schema or an older derivation), but it carries raw
   *  sources this build can read: a pull re-derives them. */
  rederivable?: true;
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
  // Backstop for a cloud endpoint that ignores the schema filter (older deployment): still judge the row. A format-2
  // row with readable raw sources is re-derived by the pull, whatever schema its derived tables carry.
  const verdict = checkProfileSchema(row.profile);
  const rederivable = rederiveReasonOf(row.profile) !== null;
  if (!verdict.usable && !rederivable) {
    LAST_CHECK.delete(registry); // never let a pull reuse a row that was just judged unusable
    return { enabled: true, available: false, ...staleFields(verdict) };
  }
  LAST_CHECK.set(registry, { key: id.key, row });
  return {
    enabled: true, available: true, meta: { source: row.source, recordCount: row.recordCount, createdAt: row.createdAt, contentHash: row.contentHash },
    ...(rederivable ? { rederivable: true as const } : {})
  };
}

/** Fields of a format-2 document that never go to the shared cloud store before M4: the raw sources and
 *  everything derived only for this install's coverage view. */
const PUBLISH_STRIPPED_KEYS: readonly string[] = ['raw', 'sections', 'blockMap', 'provenance', 'coverage'];
/** Format-2 `meta` fields stripped with them (the uploaded copy is a plain derived-tables document). */
const PUBLISH_STRIPPED_META: readonly string[] = ['format', 'sources', 'derivedWith', 'derivedRevision', 'derivedAt'];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The derived-tables-only copy of a profile document — what `publish` uploads and what a pull of a row without
 *  readable raw sources stores: no raw sources, sections, block map, provenance or coverage, no format-2 meta, and
 *  no synthetic family (`section:<tag>` / `block:<eid>`, an unassigned section of this install's document) in any
 *  derived table. A format-1 doc without synthetic keys passes unchanged. Exported for the tests. */
export function publishableProfile(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (PUBLISH_STRIPPED_KEYS.includes(k)) continue;
    out[k] = k !== 'meta' && isPlainObject(v) && Object.keys(v).some(isSyntheticFamilyKey)
      ? Object.fromEntries(Object.entries(v).filter(([fk]) => !isSyntheticFamilyKey(fk)))
      : v;
  }
  const meta = data.meta as Record<string, unknown> | undefined;
  if (meta) out.meta = Object.fromEntries(Object.entries(meta).filter(([k]) => !PUBLISH_STRIPPED_META.includes(k)));
  return out;
}

/** POST /device/cache/cloud/pull — adopt the shared profile for the attached device. Model/firmware match is
 *  inherent — the row was fetched BY the attached identity. Gated on the same capability as import (only
 *  cache-capable devices apply profiles). Nothing from the wire is trusted for provenance: every source a row
 *  brings in is re-tagged `origin: 'cloud'` (`foreignSources`), whatever origin it claims, and a row without
 *  readable raw sources is stored as derived tables only (`publishableProfile`).
 *   - A format-2 cloud doc (raw sources this build can read) contributes its raw sources to the stored doc,
 *     merged by the codec's precedence: a local source of the same kind always outranks it, so a pull never
 *     replaces a better local source. A source of another firmware is refused (409 `firmware-differs`). Refused
 *     merges (profileMerge.ts `mergeRefusal`, unless `replace`): a stored doc without raw sources that outranks
 *     every cloud source (e.g. a legacy local editor-cache import) → 409 `local-profile-better`; a doc a newer
 *     build wrote → 409 `newer-profile`. Over a stale doc whose sources do not derive, the cloud sources are
 *     stored next to them; if they still do not derive the answer is 422 `derivation-failed` with `stored: true`.
 *   - A row with derived tables only (format 1, or a raw envelope this build cannot read — its raw is dropped)
 *     is adopted only when the key holds no usable profile and no raw sources (stale or not: raw sources are never
 *     dropped implicitly); otherwise 409 `local-profile-better` (or `newer-profile`), nothing stored.
 *     `replace: true` adopts it anyway (old behaviour). A row whose schema this build cannot use is refused with
 *     409 `cloud-profile-stale` (+ reason, stored and current schema) and NOT stored. It is persisted with source
 *     'cloud' (original kind in `origin`). */
export async function cloudCachePull(cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry, opts: { replace?: boolean } = {}): Promise<ImportResult> {
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
  const pulledAt = new Date().toISOString();
  const raw = readableRaw(p);
  let kept = 0;
  let stored: Record<string, unknown>;
  if (raw) {
    const incoming = foreignSources(raw.sources, 'cloud');
    const foreign = incoming.find((s) => s.firmware !== null && s.firmware !== id.firmware);
    if (foreign) return { code: 409, body: { error: 'firmware-differs', expected: id.firmware, got: foreign.firmware } };
    try {
      const merged = mergeSourcesIntoStored(store, {
        key: id.key, model: id.model, firmware: id.firmware, incoming,
        replace: opts.replace, extras: { pulledAt, contentHash: row.contentHash }, now: pulledAt
      });
      kept = merged.kept;
      stored = merged.doc as unknown as Record<string, unknown>;
      persistProfile(store, id.key, stored);
      if (merged.derivationFailed !== undefined) {
        // the stored doc was stale and still does not derive with the cloud sources added: kept (nothing lost)
        await registry.applyRuntimeCache();
        return { code: 422, body: { error: 'derivation-failed', message: merged.derivationFailed, stored: true, key: id.key } };
      }
    } catch (e) {
      if (e instanceof ProfileMergeRefused) return { code: 409, body: refusalBody(e.refusal) };
      if (e instanceof ProfileUserDataError) return { code: 422, body: { error: 'contains-user-data', message: e.message } };
      if (e instanceof ProfileDerivationError && e.code === 'firmware-mismatch') return { code: 409, body: { error: 'firmware-differs', message: e.message } };
      return { code: 422, body: { error: 'derivation-failed', message: (e as Error).message } };
    }
  } else {
    const verdict = checkProfileSchema(p);
    if (!verdict.usable) return { code: 409, body: { error: 'cloud-profile-stale', ...staleFields(verdict) } };
    if (!opts.replace) {
      // a doc a newer build wrote is never rewritten
      const newer = mergeRefusal(store, id.key, []);
      if (newer) return { code: 409, body: refusalBody(newer) };
      const local = loadStoredProfile(store, id.key);
      if (local.state !== 'absent') {
        const localSource = (local.profile.meta as { source?: string } | undefined)?.source ?? 'live';
        const holdsRaw = readableRaw(store.getDoc('deviceCaches', id.key)?.data) !== null;
        if (local.state === 'usable' || holdsRaw) {
          return {
            code: 409,
            body: {
              error: 'local-profile-better', local: { source: localSource, format: local.format },
              message: local.state === 'usable'
                ? 'a usable local profile is stored for this firmware; pull with replace: true to adopt the cloud profile instead'
                : 'the stored profile for this firmware holds raw definition sources that a profile without raw sources would drop; pull with replace: true to adopt the cloud profile instead'
            }
          };
        }
      }
    }
    // Derived tables only (a raw envelope this build cannot read is dropped, never stored verbatim). Source becomes
    // 'cloud' for surfacing; the build kind it originally came from rides in `origin`.
    const tables = publishableProfile(p as Record<string, unknown>);
    stored = { ...tables, meta: { ...(tables.meta as Record<string, unknown>), source: 'cloud' as const, origin: p.meta.source, pulledAt, contentHash: row.contentHash } };
    try {
      persistProfile(store, id.key, stored);
    } catch (e) {
      return { code: 422, body: { error: 'contains-user-data', message: (e as Error).message } };
    }
  }
  await registry.applyRuntimeCache();
  registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: 0, total: 0, key: id.key, model: id.model, firmware: id.firmware });
  if (kept > 0) registry.emitEvent({ type: 'definitions', reason: 'merged', key: id.key });
  return {
    code: 200,
    body: {
      ok: true, pulled: true, key: id.key, model: id.model, firmware: id.firmware, source: 'cloud', contentHash: row.contentHash,
      ...(raw ? { format: 2, merged: kept > 0 } : {})
    }
  };
}

/** POST /device/cache/cloud/publish — upload the locally persisted profile for the attached device.
 *  Maps the store's source kinds to the API's ('live' → 'live-walk', 'editor-cache' stays; a profile
 *  whose best source came from the cloud or a definitions file is refused — nothing new to share). A STALE
 *  local profile (schema this build cannot use, or a failed re-derivation) is refused with 409 `profile-stale`
 *  and never uploaded: re-read the definitions first. A format-2 doc publishes what THIS install read: the tables
 *  derived standalone from its LOCAL raw sources only (cloud and file sources never travel back; the API source is
 *  'editor-cache' when a local editor-cache source is among them, else 'live-walk'); a format-2 doc without a local
 *  source is refused like a cloud profile (409 not publishable), and one whose raw sources this build cannot read
 *  too. Either way the upload is derived tables only (`publishableProfile`: no raw sources before M4, no synthetic
 *  families), after the privacy guard. The store validator expects the codec's meta.source vocabulary
 *  ('live'|'bytes'), so the uploaded copy is normalized back to it. */
export async function cloudCachePublish(cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const id = await deviceIdentity(store, registry);
  if (!id) return { code: 503, body: { error: 'no device detected' } };
  const doc = store.getDoc('deviceCaches', id.key);
  const storedData = doc && !doc.deleted ? (doc.data as { meta?: { source?: string }; firmware?: unknown }) : null;
  if (!storedData?.meta) return { code: 404, body: { error: 'no locally persisted profile to publish' } };

  const kind = storedData.meta.source;
  const notPublishable = (why: string): ImportResult => ({ code: 409, body: { error: `profile source '${kind}' is not publishable (${why})` } });
  let apiSource: 'live-walk' | 'editor-cache' | null;
  let tables: Record<string, unknown>;
  if (profileFormatOf(storedData) === 2) {
    const raw = readableRaw(storedData);
    if (!raw) return notPublishable('raw sources this build cannot read');
    const local = raw.sources.filter((s) => s.origin === 'local');
    if (local.length === 0) return notPublishable('no source read on this install: already from the cloud or a file?');
    const stored = loadStoredProfile(store, id.key);
    if (stored.state === 'stale') return { code: 409, body: { error: 'profile-stale', ...staleFields(stored.check) } };
    if (stored.state !== 'usable') return { code: 404, body: { error: 'no locally persisted profile to publish' } };
    apiSource = local.some((s) => s.kind === 'editor-cache') ? 'editor-cache' : 'live-walk';
    let own: ProfileDoc;
    try {
      const fw = typeof storedData.firmware === 'string' ? storedData.firmware : id.firmware;
      own = deriveProfileDoc({ format: 1, sources: local }, id.model, fw, new Date().toISOString(), metaExtrasOf(storedData.meta));
    } catch (e) {
      return { code: 422, body: { error: 'derivation-failed', message: (e as Error).message } };
    }
    tables = publishableProfile(own as unknown as Record<string, unknown>);
  } else {
    apiSource = kind === 'live' ? 'live-walk' : kind === 'editor-cache' ? 'editor-cache' : null;
    if (!apiSource) return notPublishable('already from the cloud?');
    const stored = loadStoredProfile(store, id.key);
    if (stored.state === 'stale') return { code: 409, body: { error: 'profile-stale', ...staleFields(stored.check) } };
    if (stored.state !== 'usable') return { code: 404, body: { error: 'no locally persisted profile to publish' } };
    tables = publishableProfile(stored.profile as unknown as Record<string, unknown>);
  }
  const data = tables;
  try {
    assertNoUserTables(data as Parameters<typeof assertNoUserTables>[0]);
  } catch (e) {
    return { code: 500, body: { error: 'contains-user-data', message: (e as Error).message } };
  }
  const upload = { ...data, meta: { ...(data.meta as Record<string, unknown>), source: apiSource === 'live-walk' ? 'live' : 'bytes' } };
  const r = await cloud.deviceProfilePublish({ model: id.model, firmware: id.firmware, source: apiSource, profile: upload });
  return { code: r.code, body: r.body };
}
