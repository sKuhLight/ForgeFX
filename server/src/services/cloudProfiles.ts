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
// Cloud v2 (M4, shared definition sources — axis-cloud `definition-sources`): the CHECK reads the v2 store first for
// the gen-3 grid units (Axe-Fx III, FM3, FM9) whose firmware was read: the best shared source per kind, as summaries,
// minus the rows this install's device check failed (listed under `rejected`), with `identical` (the facts equal a
// source already stored, by the codec's fact hash) and `improves` (would a pull change what decides the definitions?).
// When the v2 store does not answer (function not deployed: 404/5xx, cloud client without v2) or offers nothing,
// the v1 path below runs unchanged. The v2 listing is cached per registry and device key for 10 minutes
// (`refresh` bypasses it); verdicts and local fact hashes are read fresh on every check.
//
// Browser-safe: registry/store/cloud are type-only or structural imports; the fetch work lives in
// runtime/cloud.ts (itself browser-safe). check-browser-safe.ts enforces it.
import {
  assertNoUserTables, isSyntheticFamilyKey, ProfileDerivationError, ProfileUserDataError, RAW_FORMAT, sourceFactHash, sourceRank,
  type ProfileDoc, type RawSource, type RawSourceKind, type SourceOrigin
} from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import type { CloudSourceSummary, SharedSourceKind } from '../drivers/types.js';
import { resolveCacheKey } from './deviceCache.js';
import {
  CURRENT_CACHE_SCHEMA, checkProfileSchema, deriveProfileDoc, loadStoredProfile, metaExtrasOf, persistProfile, profileFormatOf,
  readableRaw, rederiveReasonOf, staleFields, type StaleReason
} from '../profileSchema.js';
import { ProfileMergeRefused, foreignSources, mergeRefusal, mergeSourcesIntoStored, refusalBody } from './profileMerge.js';
import { checkRawSources } from './rawValidation.js';
import { HIDE_FAMILY_ENV, hiddenFamily } from '../devices.js';
import type { Store } from '../runtime/store.js';
import type {
  DefinitionSourceBody, DefinitionSourceContribution, DefinitionSourceList, DefinitionSourceOutcome, DefinitionSourceReport,
  DefinitionSourceSummary, DefinitionSourceWithdrawal, UploaderSession
} from '../runtime/cloud.js';
import type { ImportResult } from './editorCacheImport.js';

/** The slice of the Cloud service these functions need — structural so tests fake it in two lines
 *  (and so the browser twin can pass its own Cloud instance through RuntimeDeps.cloud). */
export interface DeviceProfileCloud {
  /** `schema` = the profile schema this build can use (always passed): the endpoint answers with the newest
   *  row of that schema, so builds on different schemas do not hide each other's shared profiles. */
  deviceProfileGet(model: number, firmware: string, schema?: number): Promise<{ profile: unknown; contentHash: string; source: string; recordCount: number | null; createdAt: string } | null>;
  deviceProfilePublish(body: { model: number; firmware: string; source: 'live-walk' | 'editor-cache'; profile: unknown }): Promise<{ code: number; body: unknown }>;
}

/** The slice of the Cloud client the shared definition store (cloud v2, axis-cloud `definition-sources`) needs —
 *  structural, so tests and Browser Direct pass their own (runtime/cloud.ts `Cloud` implements it). The reads are
 *  anonymous and answer null on any failure (the caller then uses the v1 store); the writes run under the account
 *  session, else this install's anonymous one (created by a share only; a report never creates one). */
export interface DefinitionSourceCloud {
  definitionSourcesList(model: number, firmware: string, rawFormat: number): Promise<DefinitionSourceList | null>;
  definitionSourceGet(id: string): Promise<DefinitionSourceBody | null>;
  definitionSourceContribute(body: DefinitionSourceContribution): Promise<DefinitionSourceOutcome>;
  definitionSourceWithdraw(sel: DefinitionSourceWithdrawal, via?: UploaderSession): Promise<DefinitionSourceOutcome>;
  definitionSourcesMine(via?: UploaderSession): Promise<DefinitionSourceOutcome>;
  definitionSourceReport(body: DefinitionSourceReport): Promise<DefinitionSourceOutcome>;
}

/** What the cloud-profile routes take: the v1 store always, the v2 store when the client has it (a client without
 *  the v2 methods keeps the v1 path, unchanged). */
export type CloudProfilesCloud = DeviceProfileCloud & Partial<DefinitionSourceCloud>;

/** Models the v2 store serves (the gen-3 grid units with a definition walk): Axe-Fx III, FM3, FM9. */
export const DEFINITION_SOURCE_MODELS: readonly number[] = [0x10, 0x11, 0x12];
/** How long the v2 listing is reused per registry and device key; `?refresh=1` bypasses it. */
export const CLOUD_CHECK_CACHE_MS = 10 * 60 * 1000;
/** Local store collection of this install's device-check verdicts on shared rows (one doc per device-cache key). */
export const CLOUD_VERDICTS_COLLECTION = 'cloudVerdicts';
/** Verdicts kept per device key (the newest). */
export const CLOUD_VERDICTS_MAX = 64;

/** This install's device check of one shared row (stored by the pull, keyed by the cloud row id). */
export interface CloudVerdict {
  /** The fact hash the verdict was reached on: a verdict only counts for a row with these facts. */
  factHash: string;
  /** The kind of the checked row. Optional for older entries: the fact hash covers the kind anyway (the codec's fact
   *  document names it), so (kind, factHash) never matches another kind's row. */
  kind?: SharedSourceKind;
  verdict: 'passed' | 'failed';
  /** ISO time of the check. */
  at: string;
  checked: number;
  answered: number;
  mismatches: number;
}

const ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FACT_HASH_RE = /^[0-9a-f]{64}$/;
const SHARED_KINDS: readonly SharedSourceKind[] = ['editor-cache', 'live-full', 'live-readonly'];
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A cloud row id from a request body or the store, lower-cased (Postgres prints UUIDs lower-case), or null when it
 *  is not a UUID. Every id a client sends (`sourceIds`, `recheck`, withdraw) goes through this before it is used. */
export function normalizeRowId(v: unknown): string | null {
  if (typeof v !== 'string' || v.length !== 36) return null;
  const id = v.toLowerCase();
  return ROW_ID_RE.test(id) ? id : null;
}

function verdictOf(v: unknown): CloudVerdict | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.factHash !== 'string' || !FACT_HASH_RE.test(o.factHash)) return null;
  if (o.verdict !== 'passed' && o.verdict !== 'failed') return null;
  if (typeof o.at !== 'string' || o.at.length > 40 || !isCount(o.checked) || !isCount(o.answered) || !isCount(o.mismatches)) return null;
  if (o.kind !== undefined && !(SHARED_KINDS as readonly unknown[]).includes(o.kind)) return null;
  return {
    factHash: o.factHash, ...(o.kind !== undefined ? { kind: o.kind as SharedSourceKind } : {}), verdict: o.verdict, at: o.at,
    checked: o.checked, answered: o.answered, mismatches: o.mismatches
  };
}

/** The verdicts stored for a device key, by cloud row id. Malformed entries are ignored (never trusted). */
export function readCloudVerdicts(store: Pick<Store, 'getDoc'>, key: string): Map<string, CloudVerdict> {
  const out = new Map<string, CloudVerdict>();
  const doc = store.getDoc(CLOUD_VERDICTS_COLLECTION, key);
  const verdicts = doc && !doc.deleted ? (doc.data as { verdicts?: unknown } | null)?.verdicts : undefined;
  if (typeof verdicts !== 'object' || verdicts === null || Array.isArray(verdicts)) return out;
  for (const [rawId, v] of Object.entries(verdicts as Record<string, unknown>)) {
    const id = normalizeRowId(rawId);
    const verdict = id ? verdictOf(v) : null;
    if (id && verdict) out.set(id, verdict);
  }
  return out;
}

/**
 * This install's verdict on a listed row: the newest stored verdict reached on the row's facts — under the row's id,
 * or under another id with the same (kind, factHash). A row the cloud re-created under a new id with identical facts
 * (an orphan reset: withdrawn, then shared again) keeps its verdict; a row with other facts never inherits one.
 */
export function verdictFor(row: Pick<DefinitionSourceSummary, 'id' | 'kind' | 'factHash'>, verdicts: ReadonlyMap<string, CloudVerdict>): CloudVerdict | null {
  let best: CloudVerdict | null = null;
  for (const [id, v] of verdicts) {
    if (v.factHash !== row.factHash) continue;
    if (id !== row.id && v.kind !== undefined && v.kind !== row.kind) continue;
    if (!best || v.at > best.at) best = v;
  }
  return best;
}

/** Store this install's verdict on a shared row (replacing an earlier one), keeping the newest `CLOUD_VERDICTS_MAX`. */
export function recordCloudVerdict(store: Pick<Store, 'getDoc' | 'putDoc'>, key: string, rawSourceId: string, verdict: CloudVerdict): void {
  const sourceId = normalizeRowId(rawSourceId);
  const v = verdictOf(verdict);
  if (!sourceId || !v) throw new TypeError('recordCloudVerdict: not a row id or not a verdict');
  const all = readCloudVerdicts(store, key);
  all.delete(sourceId);
  all.set(sourceId, v);
  const kept = [...all.entries()].sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0)).slice(0, CLOUD_VERDICTS_MAX);
  store.putDoc(CLOUD_VERDICTS_COLLECTION, key, { verdicts: Object.fromEntries(kept) });
}

/** The v2 listing cache: per registry, valid for one cloud client and device key. */
const V2_LIST = new WeakMap<DeviceRegistry, { cloud: object; key: string; at: number; list: DefinitionSourceList }>();

/** Forget the cached v2 listing (after this install shared or withdrew, the next check asks again). */
export function forgetDefinitionSources(registry: DeviceRegistry): void {
  V2_LIST.delete(registry);
}

/** The identity the v2 store is asked for, or null when it does not apply: a model it serves, a gen-3 unit with a
 *  definition walk, and a firmware READ from the unit (never one derived from a stored document's key). */
function definitionSourceIdentity(registry: DeviceRegistry, id: { model: number; firmware: string; key: string }): { model: number; firmware: string; key: string } | null {
  if (!DEFINITION_SOURCE_MODELS.includes(id.model)) return null;
  if (registry.activeCapabilities()?.selfDescribe !== true) return null;
  const fw = registry.firmwareInfo();
  if (!fw || `${fw.major}.${fw.minor}` !== id.firmware) return null;
  return id;
}

/** The v2 listing for the attached device (the cached one unless `refresh`), or null: no v2 client, the store does
 *  not apply to this device, or the store did not answer. For the check and the pull. */
export async function definitionSourcesFor(
  cloud: CloudProfilesCloud, registry: DeviceRegistry, id: { model: number; firmware: string; key: string },
  opts: { refresh?: boolean; now?: number } = {}
): Promise<DefinitionSourceList | null> {
  if (typeof cloud.definitionSourcesList !== 'function' || !definitionSourceIdentity(registry, id)) return null;
  const now = opts.now ?? Date.now();
  const hit = V2_LIST.get(registry);
  if (hit && !opts.refresh && hit.cloud === cloud && hit.key === id.key && now - hit.at >= 0 && now - hit.at < CLOUD_CHECK_CACHE_MS) return hit.list;
  let list: DefinitionSourceList | null;
  try { list = await cloud.definitionSourcesList(id.model, id.firmware, RAW_FORMAT); } catch { list = null; }
  if (list) V2_LIST.set(registry, { cloud, key: id.key, at: now, list });
  else V2_LIST.delete(registry);
  return list;
}

/** A source stored for the device key, as the improves / identical judgement needs it. `hash` null = its fact hash
 *  could not be computed (a malformed stored source); `blocks` = the blocks its records sit in (live sources). */
interface StoredFact { kind: RawSourceKind; origin: SourceOrigin; hash: string | null; blocks: ReadonlySet<number> }

/** Fact hashes of stored docs, per store and key, valid while the doc's revision is unchanged. */
const STORED_FACTS = new WeakMap<object, Map<string, { rev: number; updatedAt: number; model: number; facts: StoredFact[] | null }>>();

/** The raw sources stored for `id.key` that a pull would keep next to cloud sources (those of the device firmware),
 *  with their fact hashes; null when no doc with readable raw sources is stored. */
async function storedSourceFacts(store: Pick<Store, 'getDoc'>, id: { model: number; firmware: string; key: string }): Promise<StoredFact[] | null> {
  const doc = store.getDoc('deviceCaches', id.key);
  if (!doc || doc.deleted) return null;
  let memo = STORED_FACTS.get(store);
  if (!memo) STORED_FACTS.set(store, (memo = new Map()));
  const hit = memo.get(id.key);
  if (hit && hit.rev === doc.rev && hit.updatedAt === doc.updatedAt && hit.model === id.model) return hit.facts;
  const raw = readableRaw(doc.data);
  let facts: StoredFact[] | null = null;
  if (raw) {
    facts = [];
    for (const s of raw.sources as RawSource[]) {
      if (s.kind === 'live-probe') continue; // a single-block probe has no fact hash and is never shared
      if (s.firmware !== null && s.firmware !== id.firmware) continue; // the merge drops a source of another firmware
      let hash: string | null;
      try { hash = await sourceFactHash(s, { model: id.model, firmware: id.firmware }); } catch { hash = null; }
      const blocks = new Set<number>(s.kind === 'editor-cache' ? [] : s.records.map((r) => r.section));
      facts.push({ kind: s.kind, origin: s.origin, hash, blocks });
    }
  }
  memo.set(id.key, { rev: doc.rev, updatedAt: doc.updatedAt, model: id.model, facts });
  return facts;
}

/**
 * Would pulling the offered sources change what decides the definitions? The codec's merge takes a family's existence
 * from the best-ranked source THAT HAS the family (`sourceRank`), so a better-ranked source only covers an offer where
 * it covers the same blocks. Per offered row:
 *   - covered by a stored source of the same kind with identical facts (fact hash);
 *   - covered by a stored EDITOR-CACHE source that outranks it (local or cloud origin: an editor cache has every
 *     family, byte-exact);
 *   - against better-ranked stored LIVE sources (a local read of the same kind, a better live kind): their
 *     record-carrying blocks together are compared with the offer's `summary.blocks` — the offer has more → `yes`
 *     (blocks the local reads lack), as many or fewer → covered; an offer without a block count → undecidable.
 * `no` when nothing is offered, when a pull would be refused (a doc a newer build wrote; a stored doc without raw
 * sources that outranks every offered source: `mergeRefusal`), or when every offered row is covered. `yes` when an
 * offered row is not covered. `unknown` when a row could be covered but that cannot be decided (a stored source of
 * its kind without a computable hash, an offer without a block count).
 */
function improvesOf(offered: readonly DefinitionSourceSummary[], facts: StoredFact[] | null, refused: boolean): 'yes' | 'no' | 'unknown' {
  if (offered.length === 0 || refused) return 'no';
  if (facts === null) return 'yes';
  let undetermined = false;
  for (const row of offered) {
    const rank = sourceRank(row.kind, 'cloud');
    let covered = false;
    let maybe = false;
    let betterLive = false;
    const liveBlocks = new Set<number>();
    for (const s of facts) {
      if (s.kind === row.kind && s.hash === row.factHash) { covered = true; break; }
      if (sourceRank(s.kind, s.origin) < rank) {
        if (s.kind === 'editor-cache') { covered = true; break; }
        betterLive = true;
        for (const b of s.blocks) liveBlocks.add(b);
      }
      if (s.kind === row.kind && s.hash === null) maybe = true;
    }
    if (!covered && betterLive) {
      const offerBlocks = row.kind === 'editor-cache' ? undefined : summaryCount(row.summary, 'blocks');
      if (offerBlocks === undefined) maybe = true;
      else if (offerBlocks > liveBlocks.size) return 'yes'; // the offer has blocks the better-ranked local reads lack
      else covered = true;
    }
    if (covered) continue;
    if (!maybe) return 'yes';
    undetermined = true;
  }
  return undetermined ? 'unknown' : 'no';
}

const summaryCount = (s: Record<string, unknown>, k: string): number | undefined => (isCount(s[k]) ? s[k] : undefined);

/** The client summary of a listed row (counts from the cloud's summary; no content). */
function cloudSourceSummary(row: DefinitionSourceSummary, verdict: CloudVerdict | null, identical: boolean): CloudSourceSummary {
  const s = row.summary;
  const live = row.kind !== 'editor-cache';
  const sections = live ? undefined : summaryCount(s, 'sections');
  const blocks = live ? summaryCount(s, 'blocks') : undefined;
  return {
    id: row.id, kind: row.kind, tier: row.tier, quality: row.quality, complete: row.quality === 3,
    contributors: row.contributors, deviceChecks: { passed: row.spotChecks.passed, failed: row.spotChecks.failed },
    firstSeen: row.firstSeen, records: summaryCount(s, 'records') ?? 0,
    ...(sections !== undefined ? { sections } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(live && typeof s.extended === 'boolean' ? { extended: s.extended } : {}),
    ...(live && typeof s.above160 === 'boolean' ? { above160: s.above160 } : {}),
    verdict: verdict?.verdict ?? null,
    identical
  };
}

/** One listed row with its client summary (and, when rejected, the verdict that rejected it). */
export interface OfferedSource { row: DefinitionSourceSummary; summary: CloudSourceSummary }
export interface RejectedSource extends OfferedSource { verdict: CloudVerdict }

/** The v2 offer for the attached device, as the check answers it and the pull starts from it. */
export interface DefinitionSourcesOffer {
  /** The listing the split was made from (cached per registry and key, see `definitionSourcesFor`). */
  list: DefinitionSourceList;
  /** Best row per kind, minus the rows this install's device check failed (`verdictFor`). */
  offered: OfferedSource[];
  /** The rows this install's device check failed (on the same facts): not offered unless re-checked. */
  rejected: RejectedSource[];
  /** Would pulling the offered rows change what decides the definitions (`improvesOf`)? */
  improves: 'yes' | 'no' | 'unknown';
}

/** The v2 offer: the listing split into offered and locally rejected rows, with their summaries and `improves`. Null
 *  when the v2 store does not apply to this device or did not answer. Shared by the check and the pull (WP-F2). */
export async function definitionSourcesOffer(
  cloud: CloudProfilesCloud, store: Store, registry: DeviceRegistry, id: { model: number; firmware: string; key: string },
  opts: { refresh?: boolean; now?: number } = {}
): Promise<DefinitionSourcesOffer | null> {
  const list = await definitionSourcesFor(cloud, registry, id, opts);
  if (!list) return null;
  const verdicts = readCloudVerdicts(store, id.key);
  const facts = await storedSourceFacts(store, id);
  const offered: OfferedSource[] = [];
  const rejected: RejectedSource[] = [];
  for (const row of list.sources) {
    const mine = verdictFor(row, verdicts); // a verdict counts only for the facts it was reached on
    const identical = !!facts?.some((f) => f.kind === row.kind && f.hash === row.factHash);
    const summary = cloudSourceSummary(row, mine, identical);
    if (mine?.verdict === 'failed') rejected.push({ row, summary, verdict: mine });
    else offered.push({ row, summary });
  }
  const rows = offered.map((o) => o.row);
  const refused = rows.length > 0 && mergeRefusal(store, id.key, rows.map((r) => ({ kind: r.kind, origin: 'cloud' as const }))) !== null;
  return { list, offered, rejected, improves: improvesOf(rows, facts, refused) };
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
  /** Which store answered: 2 = the shared definition sources, 1 = the v1 profile store (fallback). Absent when no
   *  store had anything. */
  version?: 1 | 2;
  /** v2: the best shared source per kind, minus the rows this install's device check failed. */
  sources?: CloudSourceSummary[];
  /** v2: the rows this install's device check failed (not offered; a pull with `recheck` checks them again). Also on
   *  a v1 fallback answer when every v2 row was rejected. */
  rejected?: CloudSourceSummary[];
  /** Would a pull change what decides the definitions? `no` when nothing is offered or a stored source of this
   *  firmware outranks (or equals) every offered one; `unknown` for a v1 row (and an undecidable stored source). */
  improves?: 'yes' | 'no' | 'unknown';
}

/** GET /device/cache/cloud — what the cloud offers for the attached device+firmware. The v2 store first (gen-3 grid
 *  units with a read firmware; listing cached for 10 minutes, `refresh` asks again): `version: 2` with the offered
 *  `sources`, the locally `rejected` rows and `improves`. Without a v2 offer (store missing or unreachable, nothing
 *  shared, every row rejected here) the v1 profile store answers as before, with `version: 1` when it had a row; the
 *  v1 row is fetched (and cached) so a following pull is instant. `enabled:false` when cloud is off entirely. */
export async function cloudCacheCheck(
  cloud: CloudProfilesCloud | null, store: Store, registry: DeviceRegistry, opts: { refresh?: boolean; now?: number } = {}
): Promise<CloudCacheCheck> {
  if (!cloud) return { enabled: false, available: false };
  const id = await deviceIdentity(store, registry);
  if (!id) return { enabled: true, available: false };
  const v2 = await definitionSourcesOffer(cloud, store, registry, id, opts);
  const rejected = v2 ? v2.rejected.map((r) => r.summary) : [];
  if (v2 && v2.offered.length > 0) {
    // the v2 store answers: a v1 row cached by an earlier check must not be what a following pull adopts
    LAST_CHECK.delete(registry);
    return { enabled: true, available: true, version: 2, sources: v2.offered.map((o) => o.summary), rejected, improves: v2.improves };
  }
  const v1 = await v1CloudCacheCheck(cloud, registry, id);
  if (v1.version === 1) return rejected.length > 0 ? { ...v1, rejected } : v1;
  // the v2 store answered and offers nothing (nothing shared, or every row failed here); the v1 store has no row
  if (v2) return { enabled: true, available: false, version: 2, sources: [], rejected, improves: 'no' };
  return v1;
}

/** The v1 half of the check (the profile store, M3 behaviour). `version: 1` when the store had a row. */
async function v1CloudCacheCheck(cloud: DeviceProfileCloud, registry: DeviceRegistry, id: { model: number; firmware: string; key: string }): Promise<CloudCacheCheck> {
  const row = await cloud.deviceProfileGet(id.model, id.firmware, CURRENT_CACHE_SCHEMA);
  if (!row) return { enabled: true, available: false };
  // Backstop for a cloud endpoint that ignores the schema filter (older deployment): still judge the row. A format-2
  // row with readable raw sources is re-derived by the pull, whatever schema its derived tables carry.
  const verdict = checkProfileSchema(row.profile);
  const rederivable = rederiveReasonOf(row.profile) !== null;
  if (!verdict.usable && !rederivable) {
    LAST_CHECK.delete(registry); // never let a pull reuse a row that was just judged unusable
    return { enabled: true, available: false, ...staleFields(verdict), version: 1 };
  }
  LAST_CHECK.set(registry, { key: id.key, row });
  return {
    enabled: true, available: true, meta: { source: row.source, recordCount: row.recordCount, createdAt: row.createdAt, contentHash: row.contentHash },
    ...(rederivable ? { rederivable: true as const } : {}),
    version: 1, improves: 'unknown'
  };
}

/** Fields of a format-2 document that never go to the shared cloud store before M4: the raw sources and
 *  everything derived only for this install's coverage view. */
const PUBLISH_STRIPPED_KEYS: readonly string[] = ['raw', 'sections', 'blockMap', 'provenance', 'coverage'];
/** Format-2 `meta` fields stripped with them (the uploaded copy is a plain derived-tables document). */
const PUBLISH_STRIPPED_META: readonly string[] = ['format', 'sources', 'derivedWith', 'derivedRevision', 'derivedAt', 'derivedHidden'];

/** The 409 body of a refused share while the development hook hides a catalog family (devices.ts `hiddenFamily`), or
 *  while the stored document still carries tables derived under it (`meta.derivedHidden`): what would be shared was
 *  derived from a catalog with a family left out. Shared with the editor-cache contribution (services/cacheContribution.ts). */
export function devHookActiveBody(): Record<string, unknown> {
  return {
    error: 'dev-hook-active',
    message: `a development hook (${HIDE_FAMILY_ENV}) hides a catalog family in this session or hid one when the stored definitions were derived; nothing is shared — restart without it (the stored definitions re-derive on the next load), then try again`
  };
}


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
 *     replaces a better local source. The row's raw sources must pass the strict shape check (rawValidation.ts, 422
 *     `cloud profile malformed` with the offending path otherwise); they are stored as the sanitized copies it returns.
 *     A source of another firmware is refused (409 `firmware-differs`). Refused
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
    // nothing a row says about its raw sources is trusted before it passed the strict shape check (rawValidation.ts):
    // a malformed or hostile source set is refused like a malformed row, nothing stored
    const checked = checkRawSources(raw.sources, 'raw.sources');
    if (!checked.ok) return { code: 422, body: { error: 'cloud profile malformed', message: `${checked.path}: ${checked.message}` } };
    const incoming = foreignSources(checked.sources, 'cloud');
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
  // the development hook's hidden catalog never reaches the shared store
  if (hiddenFamily() !== null) return { code: 409, body: devHookActiveBody() };
  const id = await deviceIdentity(store, registry);
  if (!id) return { code: 503, body: { error: 'no device detected' } };
  const doc = store.getDoc('deviceCaches', id.key);
  const storedData = doc && !doc.deleted ? (doc.data as { meta?: { source?: string; derivedHidden?: unknown }; firmware?: unknown }) : null;
  if (!storedData?.meta) return { code: 404, body: { error: 'no locally persisted profile to publish' } };
  if (storedData.meta.derivedHidden !== undefined) return { code: 409, body: devHookActiveBody() };

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
