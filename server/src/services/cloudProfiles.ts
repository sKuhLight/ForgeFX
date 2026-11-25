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
// Pull v2 (M4): the offered rows of the check (`definitionSourcesOffer`, the same split) are fetched, each body bound to
// its listed row (model, firmware, kind, raw format, the strict shared-mode shape check, the recomputed fact hash),
// re-tagged `origin: 'cloud'` and merged IN MEMORY; a dry run answers a preview from that candidate without device
// traffic or a store write. Before the candidate is stored, every pull that lets a cloud source decide which parameters
// exist — v2 rows and v1 rows alike — is spot-checked against the unit (services/spotCheck.ts, read-only definition
// queries); a failed check stores nothing but this install's verdict on the row (`cloudVerdicts`, by row id and fact
// hash), which hides the row from the offer until a pull with `recheck` checks it again. A passed or failed verdict is
// reported to the cloud when a session already exists (never creating one).
//
// Browser-safe: registry/store/cloud are type-only or structural imports; the fetch work lives in
// runtime/cloud.ts (itself browser-safe). check-browser-safe.ts enforces it.
import {
  assertNoUserTables, isSyntheticFamilyKey, ProfileDerivationError, ProfileUserDataError, RAW_FORMAT, SPOT_CHECK_LIMITS, rawSourceId,
  sourceFactHash, sourceRank,
  type BuiltCache, type ProfileDoc, type RawSource, type RawSourceKind, type SourceOrigin, type SpotCheckGates, type SpotCheckResult
} from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import type { CloudSourceSummary, DefinitionsDiffDTO, SharedSourceKind } from '../drivers/types.js';
import { definitionsDiff } from '../drivers/definitionsDiff.js';
import { resolveCacheKey } from './deviceCache.js';
import {
  CURRENT_CACHE_SCHEMA, checkProfileSchema, deriveProfileDoc, loadStoredProfile, metaExtrasOf, persistProfile, profileFormatOf,
  profileSummaryOf, readableRaw, rederiveReasonOf, staleFields, type StaleReason
} from '../profileSchema.js';
import { ProfileMergeRefused, foreignSources, mergeRefusal, mergeSourcesIntoStored, refusalBody, type MergedProfile } from './profileMerge.js';
import { checkRawSources, checkSharedSource } from './rawValidation.js';
import { HIDE_FAMILY_ENV, hiddenFamily, runtimeProfileFrom } from '../devices.js';
import { planSpotCheck, runDeviceSpotCheck, spotCheckRngFor, spotCheckSupported, spotCheckTestOptions, type HostSpotCheckPlan } from './spotCheck.js';
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
  // The store serves the best row per kind. Whatever a (structural) client hands over, only the FIRST row of a kind with a
  // canonical, not yet seen id is considered: a pull maps its sources to rows by kind, so a second row of a kind could
  // otherwise be blamed for (and reported with) another row's verdict.
  const kinds = new Set<string>();
  const ids = new Set<string>();
  for (const row of list.sources) {
    if (kinds.has(row.kind) || ids.has(row.id) || normalizeRowId(row.id) !== row.id) continue;
    kinds.add(row.kind);
    ids.add(row.id);
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
/** The only `meta` fields a published (or a pulled derived-tables-only) copy keeps — an ALLOW list, so a bookkeeping
 *  field added later (when this install built, imported or pulled, which row it pulled, the format-2 fields) never
 *  travels: `schema` (the v1 store filters on it), `recordCount` and `source` (the v1 store requires them), `walk` (the
 *  reply-loss counts a client's coverage reads for a document without raw sources; numbers only) and `issues` (a
 *  tolerant parse's damaged stretches, coarsened: section and counts, no free-text reason, no positions). */
const PUBLISH_META_KEYS: readonly string[] = ['schema', 'recordCount', 'source', 'walk', 'issues'];
/** The counters of `meta.walk` (`BuiltCacheWalkStats`) a published copy keeps. */
const PUBLISH_WALK_COUNTS: readonly string[] = ['queries', 'lostReplies', 'recoveredReplies', 'unresolvedReplies', 'placeholderSlots', 'missingSlots', 'silentAddresses'];
const PUBLISH_PSEUDO_COUNTS: readonly string[] = ['endMarker', 'duplicateId', 'implausible'];

const countsOf = (v: unknown, keys: readonly string[]): Record<string, number> => {
  const o = isPlainObject(v) ? v : {};
  return Object.fromEntries(keys.filter((k) => typeof o[k] === 'number' && Number.isFinite(o[k])).map((k) => [k, o[k] as number]));
};

/** `meta` reduced to `PUBLISH_META_KEYS`: `walk` to its counters, each `issues` entry to its section and counts (the
 *  reason text and the byte positions are dropped; the entry still says the section was damaged). */
function publishableMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLISH_META_KEYS) {
    if (!(k in meta)) continue;
    const v = meta[k];
    if (k === 'walk') {
      if (!isPlainObject(v)) continue;
      out.walk = { ...countsOf(v, PUBLISH_WALK_COUNTS), ...(isPlainObject(v.pseudoReplies) ? { pseudoReplies: countsOf(v.pseudoReplies, PUBLISH_PSEUDO_COUNTS) } : {}) };
    } else if (k === 'issues') {
      if (!Array.isArray(v)) continue;
      out.issues = v.filter(isPlainObject).map((i) => ({
        section: typeof i.section === 'number' ? i.section : null, record: null, offset: 0, reason: 'damaged',
        droppedRecords: typeof i.droppedRecords === 'number' ? i.droppedRecords : 0, skippedBytes: 0, resumedAt: null
      }));
    } else out[k] = v;
  }
  return out;
}

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
 *  readable raw sources stores: no raw sources, sections, block map, provenance or coverage, `meta` reduced to the
 *  allow list (`publishableMeta`), and no synthetic family (`section:<tag>` / `block:<eid>`, an unassigned section of
 *  this install's document) in any derived table. Exported for the tests. */
export function publishableProfile(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (PUBLISH_STRIPPED_KEYS.includes(k)) continue;
    out[k] = k !== 'meta' && isPlainObject(v) && Object.keys(v).some(isSyntheticFamilyKey)
      ? Object.fromEntries(Object.entries(v).filter(([fk]) => !isSyntheticFamilyKey(fk)))
      : v;
  }
  const meta = data.meta as Record<string, unknown> | undefined;
  if (meta) out.meta = publishableMeta(meta);
  return out;
}

/** Options of `POST /device/cache/cloud/pull` (the request body, see `parsePullBody`). */
export interface CloudPullOptions {
  /** Drop every stored source (the whole doc is replaced) and skip the merge refusals. */
  replace?: boolean;
  /** Preview only: what the pull would store and whether a device check is needed. No device traffic, no store write. */
  dryRun?: boolean;
  /** v2: the listed rows to pull, by id (default: every offered row). */
  sourceIds?: readonly string[];
  /** v2: rows this install's device check failed before are pulled (and checked) again. */
  recheck?: boolean;
  /** Version stamps a report to the cloud carries (where the host knows them). */
  app?: DefinitionSourceReport['app'];
}

/** Most row ids a pull names (the v2 store lists one row per kind). */
export const PULL_MAX_SOURCE_IDS = 3;

/** The pull body `{ replace?, dryRun?, sourceIds?, recheck? }` as options — each flag counts only when it is `true`,
 *  unknown keys are ignored — or 400 `invalid-request`: a body that is not a JSON object, `sourceIds` that is not an
 *  array of at most `PULL_MAX_SOURCE_IDS` row ids (lower-cased, duplicates dropped). */
export function parsePullBody(body: unknown): { ok: true; opts: CloudPullOptions } | { ok: false; result: ImportResult } {
  const bad = (message: string) => ({ ok: false as const, result: { code: 400, body: { error: 'invalid-request', message } } });
  if (body !== undefined && body !== null && !isPlainObject(body)) return bad('the body must be a JSON object');
  const b = (body ?? {}) as Record<string, unknown>;
  let sourceIds: string[] | undefined;
  if (b.sourceIds !== undefined) {
    if (!Array.isArray(b.sourceIds) || b.sourceIds.length > PULL_MAX_SOURCE_IDS) return bad(`sourceIds must be an array of at most ${PULL_MAX_SOURCE_IDS} row ids`);
    sourceIds = [];
    for (const v of b.sourceIds) {
      const sid = normalizeRowId(v);
      if (!sid) return bad('sourceIds must hold row ids');
      if (!sourceIds.includes(sid)) sourceIds.push(sid);
    }
  }
  return { ok: true, opts: { replace: b.replace === true, dryRun: b.dryRun === true, recheck: b.recheck === true, ...(sourceIds ? { sourceIds } : {}) } };
}

/** `POST /device/cache/cloud/pull` as both twins serve it: 503 without a cloud, the body parsed (`parsePullBody`), then
 *  `cloudCachePull`. `app` = the version stamps a device-check report carries. */
export async function cloudPullRoute(
  cloud: CloudProfilesCloud | null, store: Store, registry: DeviceRegistry, body: unknown, extra: { app?: DefinitionSourceReport['app'] } = {}
): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const parsed = parsePullBody(body);
  if (!parsed.ok) return parsed.result;
  return cloudCachePull(cloud, store, registry, { ...parsed.opts, ...(extra.app ? { app: extra.app } : {}) });
}

/** A cloud client that can pull from the v2 store (the listing and the bodies). */
type V2Cloud = CloudProfilesCloud & Pick<DefinitionSourceCloud, 'definitionSourcesList' | 'definitionSourceGet'>;
const hasV2Reads = (cloud: CloudProfilesCloud): cloud is V2Cloud =>
  typeof cloud.definitionSourcesList === 'function' && typeof cloud.definitionSourceGet === 'function';

/** 409 `spot-check-rejected-before`: this install's device check failed the row before. */
const rejectedBeforeResult = (sourceId: string): ImportResult => ({
  code: 409,
  body: {
    error: 'spot-check-rejected-before', sourceId,
    message: 'these shared definitions did not match this device in an earlier check; pull with recheck: true to check them again'
  }
});

/** 404 `not-found`: a named row is not listed for this device and firmware (any more). */
const notOfferedResult = (sourceId: string): ImportResult => ({
  code: 404, body: { error: 'not-found', sourceId, message: 'no shared source with this id is listed for this device and firmware; check again' }
});

/** The rows a v2 pull takes from the check's offer: the named ones (a row this install's check failed only with
 *  `recheck`, else 409 `spot-check-rejected-before`; an unlisted id 404 `not-found`), or every offered row (with
 *  `recheck` the rejected rows too). */
function chooseRows(offer: DefinitionSourcesOffer, opts: CloudPullOptions): { rows: OfferedSource[] } | { result: ImportResult } {
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    const rows: OfferedSource[] = [];
    for (const raw of opts.sourceIds) {
      const sid = normalizeRowId(raw);
      if (!sid) return { result: notOfferedResult(String(raw).slice(0, 64)) };
      if (rows.some((o) => o.row.id === sid)) continue;
      const offered = offer.offered.find((o) => o.row.id === sid);
      const rejected = offered ? undefined : offer.rejected.find((r) => r.row.id === sid);
      if (!offered && !rejected) return { result: notOfferedResult(sid) };
      if (rejected && !opts.recheck) return { result: rejectedBeforeResult(sid) };
      const row = (offered ?? rejected)!;
      if (!rows.some((o) => o.row.kind === row.row.kind)) rows.push(row); // one row per kind (the offer guarantees it)
    }
    return { rows };
  }
  return { rows: [...offer.offered, ...(opts.recheck ? offer.rejected : [])] };
}

/**
 * POST /device/cache/cloud/pull — adopt shared definitions for the attached device (body: `parsePullBody`). Model and
 * firmware match is inherent (rows are fetched BY the attached identity) and re-checked on every body. Gated on the
 * same capability as import (only cache-capable devices apply profiles). Nothing from the wire is trusted for
 * provenance: every source a pull brings in is re-tagged `origin: 'cloud'` (`foreignSources`).
 *
 * v2 (the shared definition store answers and offers rows; `pullV2`): the check's offer (`definitionSourcesOffer`, the
 * cached listing split into offered and locally rejected rows) → the chosen rows (`chooseRows`) → each body fetched and
 * bound to its listed row (`fetchBoundSource`) → merged in memory (`mergeSourcesIntoStored`: M3 refusals apply) →
 * `dryRun`: a preview (`pullPreview`), else the spot check when a cloud source decides any family
 * (`verifyCandidate`) → stored and applied only after it passed (or was not needed). Verdicts: `passed` / `failed` on
 * the rows that decide a checked / mismatching family, stored by row id and fact hash and reported when a session
 * exists; `inconclusive` stores nothing. 200 `{ ok, pulled, key, model, firmware, source: 'cloud', format: 2, merged,
 * adopted: [{ id, kind, tier }], spotCheck: { verdict: 'passed' | 'not-needed', checked, answered, mismatches,
 * durationMs }, coverage: { complete, gaps } }`.
 *
 * v1 (no v2 client, the v2 store does not answer or offers nothing — also when this install rejected every v2 row;
 * `pullV1`): today's M3 path — a format-2 row merges its raw sources (strict shape check, 422 `cloud profile malformed`),
 * a derived-tables-only row is adopted only without a usable local profile (409 `local-profile-better` unless
 * `replace`; 409 `cloud-profile-stale` for a schema this build cannot use) — plus the same spot check against the rows
 * the cloud profile would decide, on a unit that can be checked (`spotCheckSupported`); a unit that cannot keeps
 * today's path unchanged. A v1 row has no row id: a failed check stores no verdict.
 *
 * Errors of the check (nothing stored in any of them): 501 `unsupported` (`capability: 'spotCheck'`), 503
 * `firmware-unknown`, 409 `spot-check-insufficient` `{ eligible, needed }`, 409 `building` / `busy`, 409
 * `spot-check-failed` / `spot-check-inconclusive` `{ spotCheck }`, 409 `busy` (`what: 'definitions'`: the stored
 * definitions changed while the check ran). A candidate that does not derive is not stored either on a unit that can
 * be checked (422 `derivation-failed`, `stored: false`): it could not be checked.
 */
export async function cloudCachePull(cloud: CloudProfilesCloud | null, store: Store, registry: DeviceRegistry, opts: CloudPullOptions = {}): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const caps = registry.activeCapabilities();
  if (!caps?.cacheImport) return { code: 501, body: { error: 'unsupported', capability: 'cacheImport' } };
  const id = await deviceIdentity(store, registry);
  if (!id) return { code: 503, body: { error: 'no device detected' } };
  let rejectedBefore: string | null = null;
  if (hasV2Reads(cloud)) {
    const offer = await definitionSourcesOffer(cloud, store, registry, id);
    if (offer) {
      const chosen = chooseRows(offer, opts);
      if ('result' in chosen) return chosen.result;
      if (chosen.rows.length > 0) return pullV2(cloud, store, registry, id, chosen.rows, opts);
      rejectedBefore = offer.rejected[0]?.row.id ?? null;
    }
  }
  if (opts.sourceIds && opts.sourceIds.length > 0) return notOfferedResult(opts.sourceIds[0]!);
  return pullV1(cloud, store, registry, id, opts, rejectedBefore);
}

type Identity = { model: number; firmware: string; key: string };

/** 422 `invalid-source` of a fetched v2 body (the path names the offending field; never a value). */
const invalidSource = (kind: SharedSourceKind, path: string, message: string): ImportResult => ({ code: 422, body: { error: 'invalid-source', kind, path, message } });

/**
 * Fetch one listed row's body and bind it to the row before anything is derived from it: the body names the row's
 * id, model, kind, raw format (≤ this build's `RAW_FORMAT`) and fact hash (else 502 `cloud`) and the device firmware
 * (else 409 `firmware-differs`); its source passes the strict shared-mode shape check (`checkSharedSource`: 422
 * `invalid-source` with the path), is of the listed kind, of the device firmware (409 `firmware-differs`), and its fact
 * hash, recomputed here with the codec's `sourceFactHash`, equals the listed one (else 422 `invalid-source`): a verdict
 * stored under that hash is about these very facts. The source comes back with a fresh id (`rawSourceId`) and
 * `origin: 'cloud'`.
 * A row whose body cannot be fetched (withdrawn after the listing was cached, a 404, the cloud not answering) or does
 * not match its listing answers 502 `cloud` and drops the cached listing — never a silent substitute (another row the
 * user did not choose or preview) and never the v1 store: the next check lists afresh.
 */
async function fetchBoundSource(cloud: V2Cloud, registry: DeviceRegistry, id: Identity, row: DefinitionSourceSummary): Promise<{ source: RawSource } | { result: ImportResult }> {
  const unavailable = (message: string): { result: ImportResult } => {
    forgetDefinitionSources(registry);
    return { result: { code: 502, body: { error: 'cloud', status: null, message } } };
  };
  let body: DefinitionSourceBody | null;
  try { body = await cloud.definitionSourceGet(row.id); } catch { body = null; }
  if (!body) return unavailable('the shared definitions could not be fetched (withdrawn, or the cloud did not answer); check again');
  if (body.id !== row.id || body.model !== id.model || body.kind !== row.kind || body.factHash !== row.factHash
    || body.rawFormat !== row.rawFormat || body.rawFormat > RAW_FORMAT) {
    return unavailable('the shared source does not match its listing; check again');
  }
  if (body.firmware !== id.firmware) return { result: { code: 409, body: { error: 'firmware-differs', kind: row.kind, expected: id.firmware, got: body.firmware } } };
  const checked = checkSharedSource(body.source, 'source');
  if (!checked.ok) return { result: invalidSource(row.kind, checked.path, checked.message) };
  const s = checked.source;
  if (s.kind !== row.kind) return { result: invalidSource(row.kind, 'source.kind', 'not the kind of the listed row') };
  if (s.firmware !== id.firmware) return { result: { code: 409, body: { error: 'firmware-differs', kind: row.kind, expected: id.firmware, got: s.firmware } } };
  let hash: string | null;
  try { hash = await sourceFactHash(s as unknown as RawSource, { model: id.model, firmware: id.firmware }); } catch { hash = null; }
  if (hash !== row.factHash) return { result: invalidSource(row.kind, 'source', 'its facts do not match the listed fact hash') };
  return { source: { ...s, id: rawSourceId(s.kind, s.capturedAt, 0), origin: 'cloud' } as unknown as RawSource };
}

/** The answer of a merge that threw (refusals, user data, a source of another firmware, a derivation failure). */
function mergeFailure(e: unknown): ImportResult {
  if (e instanceof ProfileMergeRefused) return { code: 409, body: refusalBody(e.refusal) };
  if (e instanceof ProfileUserDataError) return { code: 422, body: { error: 'contains-user-data', message: e.message } };
  if (e instanceof ProfileDerivationError && e.code === 'firmware-mismatch') return { code: 409, body: { error: 'firmware-differs', message: e.message } };
  return { code: 422, body: { error: 'derivation-failed', message: (e as Error).message } };
}

/** 422 of a candidate that does not derive on a unit that can be checked: nothing stored (it could not be checked). */
const notDerivable = (id: Identity, message: string): ImportResult => ({
  code: 422,
  body: {
    error: 'derivation-failed', stored: false, key: id.key,
    message: `${message} — nothing was stored (definitions that do not derive cannot be checked against the device); pull with replace: true to replace the stored definitions instead`
  }
});

/** Is the attached unit still the one `id` names: the same model, and the same firmware when one is read? A unit swapped
 *  while the rows were fetched or checked never gets the old model's queries, nor its definitions under the old key. */
function sameUnit(registry: DeviceRegistry, id: Identity): boolean {
  if (registry.detectedModelId !== id.model) return false;
  const fw = registry.firmwareInfo();
  return !fw || `${fw.major}.${fw.minor}` === id.firmware;
}
const unitChanged = (): ImportResult => ({
  code: 503, body: { error: 'no-device', message: 'the attached unit changed while the shared definitions were fetched or checked; nothing was stored — check again' }
});

/** The walk-scope gates of the running firmware, as the spot check takes them. */
function gatesOf(registry: DeviceRegistry): SpotCheckGates {
  const g = registry.walkScopeGates();
  return { above160: g.above160 === true, extendedIds: g.extendedIds === true };
}

/** The plan a check of `doc` would run (no device traffic); a suite whose subject is the merge may skip it (test seam). */
function planFor(registry: DeviceRegistry, store: Store, id: Identity, doc: BuiltCache, cloudSourceIds: readonly string[] | undefined, gates: SpotCheckGates): HostSpotCheckPlan {
  if (spotCheckTestOptions(registry).skip) {
    return { status: 'not-needed', eligible: 0, needed: SPOT_CHECK_LIMITS.minTargets, pools: { new: 0, changed: 0, other: 0, unverifiable: 0 }, targets: [], winners: [] };
  }
  return planSpotCheck({
    model: id.model, firmware: id.firmware, doc, ...(cloudSourceIds !== undefined ? { cloudSourceIds } : {}),
    store, key: id.key, gates, rng: spotCheckRngFor(registry)
  });
}

/** The revision of the stored doc of `key` (a pull stores its candidate only when it is unchanged after the check). */
function docRevision(store: Pick<Store, 'getDoc'>, key: string): string {
  const d = store.getDoc('deviceCaches', key);
  return d ? `${d.deleted ? 'deleted' : 'doc'}:${d.rev}:${d.updatedAt}` : 'none';
}

type Verification = { state: 'not-needed' } | { state: 'ran'; result: SpotCheckResult } | { state: 'refused'; result: ImportResult };

/** The spot check of a candidate (§4.3), in the contract's order: not needed (no cloud-decided family) → 503 `no-device`
 *  (the unit was swapped since the rows were fetched for it) → 501 no spot check on this unit → 503 `firmware-unknown` →
 *  409 `spot-check-insufficient` (no traffic) → the claimed run (409 `building` / `busy`, 500 `walk-bound` /
 *  `spot-check-error`, 503 `no-device`; the last three after a terminal SSE error). */
async function verifyCandidate(registry: DeviceRegistry, id: Identity, plan: HostSpotCheckPlan, gates: SpotCheckGates): Promise<Verification> {
  if (plan.status === 'not-needed') return { state: 'not-needed' };
  if (registry.detectedModelId !== id.model) return { state: 'refused', result: unitChanged() };
  if (!spotCheckSupported(registry)) return { state: 'refused', result: { code: 501, body: { error: 'unsupported', capability: 'spotCheck' } } };
  const fw = registry.firmwareInfo();
  if (!fw || `${fw.major}.${fw.minor}` !== id.firmware) return { state: 'refused', result: { code: 503, body: { error: 'firmware-unknown' } } };
  if (plan.status === 'insufficient') {
    return {
      state: 'refused',
      result: {
        code: 409,
        body: { error: 'spot-check-insufficient', eligible: plan.eligible, needed: plan.needed, message: 'too few of these definitions can be checked against this device; nothing was stored' }
      }
    };
  }
  const run = await runDeviceSpotCheck(registry, plan, { key: id.key, model: id.model, firmware: id.firmware }, gates);
  if (!run.ok) {
    if (run.code !== 409) {
      registry.emitEvent({
        type: 'cacheBuild', phase: 'error', done: 0, total: plan.targets.length, key: id.key, model: id.model, firmware: id.firmware,
        reason: 'spot-check-error', error: String(run.body.error)
      });
    }
    return { state: 'refused', result: { code: run.code, body: run.body } };
  }
  return { state: 'ran', result: run.result };
}

/** The `spotCheck` field of a refused pull: counts and the mismatching (family, pid) addresses only, never a value. */
function spotCheckBody(r: SpotCheckResult): Record<string, unknown> {
  return {
    verdict: r.verdict, checked: r.checked, answered: r.answered, mismatches: r.mismatches, failures: r.failures.map((f) => ({ family: f.family, pid: f.pid })),
    durationMs: r.durationMs, ...(r.stopped !== undefined ? { stopped: r.stopped } : {})
  };
}

/** A check that did not pass: the terminal SSE `cacheBuild` error (`reason`) and 409 `spot-check-failed` (a mismatch) or
 *  `spot-check-inconclusive` (too few answers, the budget, the device stopped answering). Nothing is stored here. */
function checkNotPassed(registry: DeviceRegistry, id: Identity, r: SpotCheckResult): ImportResult {
  const reason = r.verdict === 'failed' ? 'spot-check-failed' as const : 'spot-check-inconclusive' as const;
  registry.emitEvent({
    type: 'cacheBuild', phase: 'error', done: r.checked, total: r.planned, key: id.key, model: id.model, firmware: id.firmware, reason,
    error: r.verdict === 'failed' ? 'the shared definitions did not match the device; nothing was stored' : 'the device did not answer enough of the check; nothing was stored'
  });
  if (r.verdict === 'insufficient') {
    return { code: 409, body: { error: 'spot-check-insufficient', eligible: r.planned, needed: SPOT_CHECK_LIMITS.minTargets } };
  }
  return { code: 409, body: { error: reason, spotCheck: spotCheckBody(r) } };
}

/** Store and apply a candidate that passed (or needed no check): refused (409 `busy`, `what: 'definitions'`) when the
 *  stored doc changed since the candidate was merged; 503 `no-device` when the attached unit changed (`sameUnit`); 422
 *  `contains-user-data` from the privacy guard. After a check that ran (`checked`: the client saw `verifying`), a refusal
 *  also emits the terminal `cacheBuild error` with its `reason`. On success emits the terminal `cacheBuild done` and, with
 *  stored sources kept, `definitions { reason: 'merged' }`. Null = stored. */
async function adoptCandidate(
  store: Store, registry: DeviceRegistry, id: Identity, doc: unknown, rev: string, kept: number, checked: boolean
): Promise<ImportResult | null> {
  const refuse = (result: ImportResult, reason: 'definitions-changed' | 'unit-changed' | 'contains-user-data'): ImportResult => {
    if (checked) {
      const message = (result.body as { message?: unknown }).message;
      registry.emitEvent({
        type: 'cacheBuild', phase: 'error', done: 0, total: 0, key: id.key, model: id.model, firmware: id.firmware, reason,
        error: typeof message === 'string' ? message : reason
      });
    }
    return result;
  };
  if (docRevision(store, id.key) !== rev) {
    return refuse({ code: 409, body: { error: 'busy', what: 'definitions', message: 'the stored definitions changed while the shared ones were checked; nothing was stored — pull again' } }, 'definitions-changed');
  }
  if (!sameUnit(registry, id)) return refuse(unitChanged(), 'unit-changed');
  try {
    persistProfile(store, id.key, doc);
  } catch (e) {
    return refuse({ code: 422, body: { error: 'contains-user-data', message: (e as Error).message } }, 'contains-user-data');
  }
  await registry.applyRuntimeCache();
  registry.emitEvent({ type: 'cacheBuild', phase: 'done', done: 0, total: 0, key: id.key, model: id.model, firmware: id.firmware });
  if (kept > 0) registry.emitEvent({ type: 'definitions', reason: 'merged', key: id.key });
  return null;
}

/** The pulled rows whose sources decide any of `families` in the candidate (`provenance.existence`). */
function rowsDeciding(doc: ProfileDoc, rowBySource: ReadonlyMap<string, OfferedSource>, families: Iterable<string>): OfferedSource[] {
  const existence = doc.provenance?.existence ?? {};
  const out = new Set<OfferedSource>();
  for (const f of families) {
    const src = Object.prototype.hasOwnProperty.call(existence, f) ? existence[f] : undefined;
    const row = typeof src === 'string' ? rowBySource.get(src) : undefined;
    if (row) out.add(row);
  }
  return [...out];
}

/** Store this install's verdict on each row (by row id and listed fact hash) and report it to the cloud when a
 *  session already exists (the client never creates one for a report). The report is a bonus signal: not awaited,
 *  its failure ignored. */
function settleVerdicts(cloud: CloudProfilesCloud, store: Store, key: string, rows: readonly OfferedSource[], verdict: 'passed' | 'failed', r: SpotCheckResult, app: CloudPullOptions['app']): void {
  const at = new Date().toISOString();
  for (const { row } of rows) {
    recordCloudVerdict(store, key, row.id, { factHash: row.factHash, kind: row.kind, verdict, at, checked: r.checked, answered: r.answered, mismatches: r.mismatches });
    if (typeof cloud.definitionSourceReport !== 'function') continue;
    const report: DefinitionSourceReport = { sourceId: row.id, verdict, checked: r.checked, answered: r.answered, mismatches: r.mismatches, ...(app ? { app } : {}) };
    try { void cloud.definitionSourceReport(report).catch(() => undefined); } catch { /* a report never fails a pull */ }
  }
}

/** What a pull would change, per the candidate's provenance: the families its pulled sources decide, their rows, and
 *  the rows whose unit / taper they contribute. `pulled` null = a v1 profile adopted as a whole (every family; units
 *  and tapers counted on its rows). */
function winsOf(doc: BuiltCache, pulled: ReadonlySet<string> | null): { families: number; rows: number; units: number; tapers: number } {
  const ranges = (doc.ranges ?? {}) as Record<string, Record<string, { unit?: unknown; taper?: unknown }>>;
  let families = 0;
  let rows = 0;
  if (pulled === null) {
    let units = 0;
    let tapers = 0;
    for (const [fam, byPid] of Object.entries(ranges)) {
      if (isSyntheticFamilyKey(fam)) continue;
      families += 1;
      for (const r of Object.values(byPid)) {
        rows += 1;
        if (typeof r.unit === 'string' && r.unit.length > 0) units += 1;
        if (r.taper !== undefined && r.taper !== null) tapers += 1;
      }
    }
    return { families, rows, units, tapers };
  }
  const prov = (doc as unknown as ProfileDoc).provenance;
  for (const [fam, src] of Object.entries(prov?.existence ?? {})) {
    if (isSyntheticFamilyKey(fam) || !pulled.has(src)) continue;
    families += 1;
    rows += Object.keys(ranges[fam] ?? {}).length;
  }
  const sum = (m: Record<string, number> | undefined) => [...pulled].reduce((n, sid) => n + (m && Object.prototype.hasOwnProperty.call(m, sid) ? m[sid]! : 0), 0);
  return { families, rows, units: sum(prov?.units), tapers: sum(prov?.tapers) };
}

/** The definitions diff summary the candidate would have once applied (the same computation as
 *  `GET /device/definitions/diff`, over the candidate instead of the applied profile); null without a diff context. */
function candidateDiffSummary(registry: DeviceRegistry, id: Identity, doc: BuiltCache): DefinitionsDiffDTO['summary'] | null {
  const ctx = registry.definitionsDiffContext();
  if (!ctx || ctx.model !== id.model) return null;
  try {
    const profile = runtimeProfileFrom(doc, ctx.staticProfile);
    const r = definitionsDiff({
      model: id.model, firmware: id.firmware, state: ctx.caps.drift, staticProfile: ctx.staticProfile,
      applied: { key: id.key, doc, profile }, placedEids: ctx.placedEids, unmappedEids: ctx.unmappedEids
    });
    return r.ok ? r.diff.summary : null;
  } catch {
    return null;
  }
}

/** The dry-run preview of a candidate: its coverage, the diff summary it would have, what the pulled sources would
 *  decide (`wins`) and whether (and how far) a device check is needed. Pure: no traffic, no store write. */
function pullPreview(registry: DeviceRegistry, id: Identity, doc: BuiltCache, pulled: ReadonlySet<string> | null, plan: HostSpotCheckPlan): Record<string, unknown> {
  return {
    coverage: profileSummaryOf(doc, id.model).coverage,
    diff: candidateDiffSummary(registry, id, doc),
    wins: winsOf(doc, pulled),
    spotCheck: { needed: plan.status !== 'not-needed', status: plan.status, eligible: plan.eligible, planned: plan.targets.length, unverifiable: plan.pools.unverifiable }
  };
}

/** The v2 half of the pull (see `cloudCachePull`). */
async function pullV2(cloud: V2Cloud, store: Store, registry: DeviceRegistry, id: Identity, chosen: readonly OfferedSource[], opts: CloudPullOptions): Promise<ImportResult> {
  const pulledAt = new Date().toISOString();
  const incoming: RawSource[] = [];
  for (const offered of chosen) {
    const got = await fetchBoundSource(cloud, registry, id, offered.row);
    if ('result' in got) return got.result;
    incoming.push(got.source);
  }
  let merged: MergedProfile;
  try {
    merged = mergeSourcesIntoStored(store, {
      key: id.key, model: id.model, firmware: id.firmware, incoming: foreignSources(incoming, 'cloud'), replace: opts.replace, extras: { pulledAt }, now: pulledAt
    });
  } catch (e) {
    return mergeFailure(e);
  }
  if (merged.derivationFailed !== undefined) return notDerivable(id, merged.derivationFailed);
  const rev = docRevision(store, id.key);
  const doc = merged.doc;
  // every cloud source of the candidate counts as cloud for the check (also one an earlier pull stored); the pulled ones
  // by their ids in the candidate — one cloud source per kind: a pulled source replaced the stored cloud source of its kind
  const cloudSources = doc.raw.sources.filter((s) => s.origin === 'cloud');
  const rowBySource = new Map<string, OfferedSource>();
  for (const s of cloudSources) {
    const o = chosen.find((c) => c.row.kind === s.kind);
    if (o) rowBySource.set(s.id, o);
  }
  const gates = gatesOf(registry);
  const plan = planFor(registry, store, id, doc as unknown as BuiltCache, cloudSources.map((s) => s.id), gates);
  if (opts.dryRun) {
    return { code: 200, body: { ok: true, dryRun: true, sources: chosen.map((c) => c.summary), ...pullPreview(registry, id, doc as unknown as BuiltCache, new Set(rowBySource.keys()), plan) } };
  }
  const v = await verifyCandidate(registry, id, plan, gates);
  if (v.state === 'refused') return v.result;
  if (v.state === 'ran' && v.result.verdict !== 'passed') {
    if (v.result.verdict === 'failed') {
      const blamed = rowsDeciding(doc, rowBySource, v.result.failures.map((f) => f.family));
      settleVerdicts(cloud, store, id.key, blamed, 'failed', v.result, opts.app);
    }
    return checkNotPassed(registry, id, v.result);
  }
  const refused = await adoptCandidate(store, registry, id, doc, rev, merged.kept, v.state === 'ran');
  if (refused) return refused;
  if (v.state === 'ran') settleVerdicts(cloud, store, id.key, rowsDeciding(doc, rowBySource, plan.targets.map((t) => t.family)), 'passed', v.result, opts.app);
  const coverage = profileSummaryOf(doc as unknown as BuiltCache, id.model).coverage;
  return {
    code: 200,
    body: {
      ok: true, pulled: true, key: id.key, model: id.model, firmware: id.firmware, source: 'cloud', format: 2, merged: merged.kept > 0,
      adopted: chosen.map((c) => ({ id: c.row.id, kind: c.row.kind, tier: c.row.tier })),
      spotCheck: v.state === 'ran'
        ? { verdict: 'passed', checked: v.result.checked, answered: v.result.answered, mismatches: 0, durationMs: v.result.durationMs, unverifiable: plan.pools.unverifiable }
        : { verdict: 'not-needed', checked: 0, answered: 0, mismatches: 0, durationMs: 0, unverifiable: plan.pools.unverifiable },
      coverage: { complete: coverage.complete, gaps: coverage.gaps }
    }
  };
}

/** The v1 half of the pull (see `cloudCachePull`): the M3 path, plus the spot check on a unit that can be checked.
 *  `rejectedBefore`: a v2 row this install rejected, answered (409 `spot-check-rejected-before`) when the v1 store has
 *  no row either. */
async function pullV1(cloud: DeviceProfileCloud, store: Store, registry: DeviceRegistry, id: Identity, opts: CloudPullOptions, rejectedBefore: string | null): Promise<ImportResult> {
  const cached = LAST_CHECK.get(registry);
  const row = cached?.key === id.key ? cached.row : await cloud.deviceProfileGet(id.model, id.firmware, CURRENT_CACHE_SCHEMA);
  if (!row) return rejectedBefore ? rejectedBeforeResult(rejectedBefore) : { code: 404, body: { error: 'no cloud profile for this device+firmware' } };

  const p = row.profile as { meta?: Record<string, unknown> } | null;
  if (!p || typeof p !== 'object' || !p.meta) return { code: 422, body: { error: 'cloud profile malformed' } };
  const pulledAt = new Date().toISOString();
  const raw = readableRaw(p);
  const checkable = spotCheckSupported(registry);
  let candidate: { doc: BuiltCache; kept: number; cloudSourceIds?: string[]; pulled: ReadonlySet<string> | null };
  if (raw) {
    // nothing a row says about its raw sources is trusted before it passed the strict shape check (rawValidation.ts):
    // a malformed or hostile source set is refused like a malformed row, nothing stored
    const checked = checkRawSources(raw.sources, 'raw.sources');
    if (!checked.ok) return { code: 422, body: { error: 'cloud profile malformed', message: `${checked.path}: ${checked.message}` } };
    const incoming = foreignSources(checked.sources, 'cloud');
    const foreign = incoming.find((s) => s.firmware !== null && s.firmware !== id.firmware);
    if (foreign) return { code: 409, body: { error: 'firmware-differs', expected: id.firmware, got: foreign.firmware } };
    let merged: MergedProfile;
    try {
      merged = mergeSourcesIntoStored(store, {
        key: id.key, model: id.model, firmware: id.firmware, incoming,
        replace: opts.replace, extras: { pulledAt, contentHash: row.contentHash }, now: pulledAt
      });
    } catch (e) {
      return mergeFailure(e);
    }
    if (merged.derivationFailed !== undefined) {
      // a unit that can be checked never stores cloud sources it could not check; elsewhere (today's path) the stale
      // doc keeps every source, stored and new (nothing lost)
      if (checkable || opts.dryRun) return notDerivable(id, merged.derivationFailed);
      if (!sameUnit(registry, id)) return unitChanged();
      try { persistProfile(store, id.key, merged.doc); } catch (e) { return mergeFailure(e); }
      await registry.applyRuntimeCache();
      return { code: 422, body: { error: 'derivation-failed', message: merged.derivationFailed, stored: true, key: id.key } };
    }
    const cloudIds = merged.doc.raw.sources.filter((s) => s.origin === 'cloud').map((s) => s.id);
    candidate = { doc: merged.doc as unknown as BuiltCache, kept: merged.kept, cloudSourceIds: cloudIds, pulled: new Set(cloudIds) };
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
    const doc = { ...tables, meta: { ...(tables.meta as Record<string, unknown>), source: 'cloud' as const, origin: p.meta.source, pulledAt, contentHash: row.contentHash } };
    candidate = { doc: doc as unknown as BuiltCache, kept: 0, pulled: null };
  }
  const gates = gatesOf(registry);
  // a unit without a spot check keeps today's path: nothing to plan
  const plan: HostSpotCheckPlan = checkable
    ? planFor(registry, store, id, candidate.doc, candidate.cloudSourceIds, gates)
    : { status: 'not-needed', eligible: 0, needed: SPOT_CHECK_LIMITS.minTargets, pools: { new: 0, changed: 0, other: 0, unverifiable: 0 }, targets: [], winners: [] };
  if (opts.dryRun) {
    return {
      code: 200,
      body: {
        ok: true, dryRun: true, version: 1, meta: { source: row.source, recordCount: row.recordCount, createdAt: row.createdAt, contentHash: row.contentHash },
        ...pullPreview(registry, id, candidate.doc, candidate.pulled, plan)
      }
    };
  }
  const rev = docRevision(store, id.key);
  const v = await verifyCandidate(registry, id, plan, gates);
  if (v.state === 'refused') return v.result;
  // a v1 row has no row id: no verdict is stored, no report sent
  if (v.state === 'ran' && v.result.verdict !== 'passed') return checkNotPassed(registry, id, v.result);
  const refused = await adoptCandidate(store, registry, id, candidate.doc, rev, candidate.kept, v.state === 'ran');
  if (refused) return refused;
  return {
    code: 200,
    body: {
      ok: true, pulled: true, key: id.key, model: id.model, firmware: id.firmware, source: 'cloud', contentHash: row.contentHash,
      ...(raw ? { format: 2, merged: candidate.kept > 0 } : {}),
      ...(v.state === 'ran'
        ? { spotCheck: { verdict: 'passed', checked: v.result.checked, answered: v.result.answered, mismatches: 0, durationMs: v.result.durationMs, unverifiable: plan.pools.unverifiable } }
        // a unit without a spot check keeps the M3 path: marked, so a client can tell an unchecked adoption
        : checkable ? {} : { spotCheck: { verdict: 'unavailable' } })
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
export async function cloudCachePublish(
  cloud: DeviceProfileCloud | null, store: Store, registry: DeviceRegistry, opts: { sources?: readonly RawSourceKind[] } = {}
): Promise<ImportResult> {
  if (!cloud) return { code: 503, body: { error: 'cloud disabled' } };
  const prepared = await v1PublishBody(store, registry, opts);
  if (!prepared.ok) return prepared.result;
  const r = await cloud.deviceProfilePublish(prepared.body);
  return { code: r.code, body: r.body };
}

/** The v1 publish request body (`cloudCachePublish`). */
export interface V1PublishBody { model: number; firmware: string; source: 'live-walk' | 'editor-cache'; profile: Record<string, unknown> }

/** The exact v1 publish request `cloudCachePublish` sends (no cloud call), or the refusal it answers. `sources`: derive
 *  only from the LOCAL raw sources of these kinds (the compat publish of a share passes `['editor-cache']`, so nothing
 *  the user did not share reaches the v1 store); a document without raw sources is then refused (409). The body is a
 *  pure function of the stored document (no clock), so a preview equals what is sent. */
export async function v1PublishBody(
  store: Store, registry: DeviceRegistry, opts: { sources?: readonly RawSourceKind[] } = {}
): Promise<{ ok: true; body: V1PublishBody } | { ok: false; result: ImportResult }> {
  const no = (result: ImportResult) => ({ ok: false as const, result });
  // the development hook's hidden catalog never reaches the shared store
  if (hiddenFamily() !== null) return no({ code: 409, body: devHookActiveBody() });
  const id = await deviceIdentity(store, registry);
  if (!id) return no({ code: 503, body: { error: 'no device detected' } });
  const doc = store.getDoc('deviceCaches', id.key);
  const storedData = doc && !doc.deleted ? (doc.data as { meta?: { source?: string; derivedHidden?: unknown }; firmware?: unknown }) : null;
  if (!storedData?.meta) return no({ code: 404, body: { error: 'no locally persisted profile to publish' } });
  if (storedData.meta.derivedHidden !== undefined) return no({ code: 409, body: devHookActiveBody() });

  const kind = storedData.meta.source;
  const notPublishable = (why: string) => no({ code: 409, body: { error: `profile source '${kind}' is not publishable (${why})` } });
  let apiSource: 'live-walk' | 'editor-cache' | null;
  let tables: Record<string, unknown>;
  if (profileFormatOf(storedData) === 2) {
    const raw = readableRaw(storedData);
    if (!raw) return notPublishable('raw sources this build cannot read');
    const local = raw.sources.filter((s) => s.origin === 'local' && (!opts.sources || opts.sources.includes(s.kind)));
    if (local.length === 0) return notPublishable('no source read on this install: already from the cloud or a file?');
    const stored = loadStoredProfile(store, id.key);
    if (stored.state === 'stale') return no({ code: 409, body: { error: 'profile-stale', ...staleFields(stored.check) } });
    if (stored.state !== 'usable') return no({ code: 404, body: { error: 'no locally persisted profile to publish' } });
    apiSource = local.some((s) => s.kind === 'editor-cache') ? 'editor-cache' : 'live-walk';
    let own: ProfileDoc;
    try {
      const fw = typeof storedData.firmware === 'string' ? storedData.firmware : id.firmware;
      own = deriveProfileDoc({ format: 1, sources: local }, id.model, fw, new Date().toISOString(), metaExtrasOf(storedData.meta));
    } catch (e) {
      return no({ code: 422, body: { error: 'derivation-failed', message: (e as Error).message } });
    }
    tables = publishableProfile(own as unknown as Record<string, unknown>);
  } else {
    // a legacy document has no raw sources to choose from: a publish restricted to some kinds cannot use it
    if (opts.sources) return notPublishable('no raw sources to publish from');
    apiSource = kind === 'live' ? 'live-walk' : kind === 'editor-cache' ? 'editor-cache' : null;
    if (!apiSource) return notPublishable('already from the cloud?');
    const stored = loadStoredProfile(store, id.key);
    if (stored.state === 'stale') return no({ code: 409, body: { error: 'profile-stale', ...staleFields(stored.check) } });
    if (stored.state !== 'usable') return no({ code: 404, body: { error: 'no locally persisted profile to publish' } });
    tables = publishableProfile(stored.profile as unknown as Record<string, unknown>);
  }
  const data = tables;
  try {
    assertNoUserTables(data as Parameters<typeof assertNoUserTables>[0]);
  } catch (e) {
    return no({ code: 500, body: { error: 'contains-user-data', message: (e as Error).message } });
  }
  const upload = { ...data, meta: { ...(data.meta as Record<string, unknown>), source: apiSource === 'live-walk' ? 'live' : 'bytes' } };
  return { ok: true, body: { model: id.model, firmware: id.firmware, source: apiSource, profile: upload } };
}
