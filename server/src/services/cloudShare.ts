// Sharing device definitions with other Axis users (cloud v2, axis-cloud `definition-sources`; M4 WP-F3) — a
// deliberate, consented step, never automatic. What is shared is this install's own raw definition sources (an
// editor-cache import, a read of the device), one row per kind, sanitized by the codec (`shareableSource`): no record
// of a user name table, no file fingerprint (`contentSha256` null), no ids or origins, the capture time cut to the UTC
// day, no free-text walk note. Routes (app.ts and runtime/router.ts both call this module):
//
//   cloudShareStatus     GET  /device/cache/cloud/share[?refresh=1]  — what could be shared, what was, who can share
//   cloudShare           POST /device/cache/cloud/share              — consent gate → sanitize → validate → share
//   cloudShareWithdraw   POST /device/cache/cloud/share/withdraw     — remove one share, or all of this install's
//
// The order of a share: the body (consent gate: nothing is read or sent without `consent: true` and the current consent
// version, unless `dryRun`) → the development hook (409) → the unit (503 no-device / 409 unsupported-model / 503
// firmware-unknown) → the cloud (503, not for a dry run) → the stored definitions (404 nothing-to-share / 409
// profile-stale) → per source: only LOCAL sources of the device firmware (cloud / file origins and single-block probes
// are skipped), validated as stored, sanitized, and the sanitized copy validated again in the shared mode
// (services/rawValidation.ts `checkSharedSource`): that checked copy is what is sent → a dry run answers the exact
// envelopes here (and `expect`, the facts a later send must still carry) → one contribution per kind. The local record
// of a share (`definitionShares/<key>`, keyed like the device caches) holds the kind, the row id, the fact hash, the
// session kind (`via`), a session tag (`uploaderKey`: sha256 of a domain-prefixed user id, first 32 hex — never the id),
// the time and the consent version; no paths, no names. After a share or a withdraw the cached v2 listing is dropped,
// so the next check lists afresh.
//
// Sessions (runtime/cloud.ts): the signed-in account, else this install's anonymous sharer session (its own slot, never
// the editor-cache one), created by the first share only. When the cloud says it refuses anonymous sharing — its
// listing's `allowAnonymous: false`, or a 403 `account-required` (remembered for a while), or anonymous sign-ins
// switched off — shares while signed out answer 401 `not-signed-in` (`reason: 'account-required'`) without minting an
// anonymous identity only to be refused. An auth outage answers 503 `auth-unavailable` (never 401: the client keeps its
// session). A record is only withdrawn or reconciled under the session that made it (same tag): another signed-in
// account or a re-created anonymous session answers 409 `session-mismatch` and the record stays listed.
//
// Compat: a share with a local editor-cache source also publishes that source's derived tables — derived from it alone —
// to the v1 profile store (services/cloudProfiles.ts `v1PublishBody`), which older clients read: only under an account
// (the v1 store refuses anonymous sessions), only after the editor cache itself was shared, never failing the share. A
// dry run shows the exact v1 request too.
//
// Browser-safe: no node:/fastify imports; the codec's cache subpath; sha256 through globalThis.crypto.subtle.
import { RAW_FORMAT, coarsenCapturedAt, shareableSource, sourceFactHash, type ProfileRaw, type RawSource, type RawSourceKind, type ShareableSource } from 'forgefx-midi/cache';
import { VERSION as CODEC_VERSION } from 'forgefx-midi';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import type { CloudSourceTier, SharedSourceKind } from '../drivers/types.js';
import { hiddenFamily } from '../devices.js';
import { hasNewerRaw, loadStoredProfile, readableRaw, staleFields } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';
import type { DefinitionSourceContribution, DefinitionSourceList, DefinitionSourceOutcome, DefinitionSourceWithdrawal, UploaderSession } from '../runtime/cloud.js';
import { checkRawSources, checkSharedSource, isCanonicalFirmware } from './rawValidation.js';
import {
  CLOUD_CHECK_CACHE_MS, DEFINITION_SOURCE_MODELS, definitionSourcesFor, devHookActiveBody, forgetDefinitionSources, normalizeRowId, v1PublishBody,
  type CloudProfilesCloud, type V1PublishBody
} from './cloudProfiles.js';

// ── constants ──

/** The version of the share explanation (consent text) a share must have been agreed to. Any change of meaning bumps it. */
export const SHARE_CONSENT_VERSION = 1;
/** Consent versions this server accepts. */
export const SUPPORTED_SHARE_CONSENT_VERSIONS: readonly number[] = [SHARE_CONSENT_VERSION];
/** Largest share envelope (UTF-8 JSON text) — the cloud's own limit. Real editor-cache sources are ~0.4 MB. */
export const MAX_SHARE_BYTES = 2 * 1024 * 1024;
/** Local store collection of this install's shares (one doc per device-cache key). */
export const DEFINITION_SHARES_COLLECTION = 'definitionShares';
/** Records kept per device key (the newest). */
export const DEFINITION_SHARES_MAX = 32;
/** How long a refusal of anonymous sharing (or its acceptance) is remembered per cloud client. */
export const ANONYMOUS_POLICY_MS = CLOUD_CHECK_CACHE_MS;
/** The cloud lists at most this many of one's own shares (`GET definition-sources/mine`). */
const MINE_LIMIT = 100;

const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const FACT_HASH_RE = /^[0-9a-f]{64}$/;
const TAG_RE = /^[0-9a-f]{32}$/;
const KEY_RE = /^([0-9a-f]{2})_(\d{1,4})p(\d{1,4})$/;
const ALL_KINDS: readonly RawSourceKind[] = ['editor-cache', 'live-readonly', 'live-full', 'live-probe'];
const SHARED_KINDS: readonly SharedSourceKind[] = ['editor-cache', 'live-full', 'live-readonly'];
const SERVED_TIERS: readonly CloudSourceTier[] = ['official', 'verified', 'candidate'];

// ── types ──

/** The cloud client this module needs: the definition-sources writes (and reads, for the listing), the v1 store for the
 *  compat publish, and three local checks (no network) the real client has. Structural, so tests fake it. */
export type ShareCloud = CloudProfilesCloud & {
  /** Configured and switched on (no network). Absent = on. */
  isEnabled?(): boolean;
  /** A non-anonymous account session is stored (local read, no network). Absent = signed out. */
  hasAccountSession?(): boolean | Promise<boolean>;
  /** The user id of the stored sharer session of that kind (local read), null when there is none. Only a tag of it is
   *  kept (`sessionTag`), to tell whether the current session is the one that shared; the id is never stored or answered. */
  definitionSharer?(via: UploaderSession): string | null | Promise<string | null>;
};

/** An HTTP status and JSON body, what every route of this module answers. */
export interface ShareResult { code: number; body: Record<string, unknown> }

/** Why a source is not shared. */
export type ShareSkipReason =
  | 'probe' | 'cloud-origin' | 'file-origin' | 'tolerant-source' | 'contains-user-data' | 'duplicates' | 'invalid-source'
  | 'firmware-differs' | 'too-large';

/** One stored source as the status lists it. */
export interface ShareableEntry {
  kind: RawSourceKind;
  /** Records the source holds. */
  records: number;
  /** The capture day (`YYYY-MM-DDT00:00:00.000Z`, what a share would carry), null when the source names none. */
  capturedAt: string | null;
  state: 'not-shared' | 'shared' | 'identical-in-cloud' | 'not-shareable';
  /** `not-shareable` only. */
  reason?: ShareSkipReason;
  /** `shared`: this install's row; `identical-in-cloud`: the listed row with the same facts. */
  sourceId?: string;
}

/** One of this install's shares as the status lists it. */
export interface ShareView {
  kind: SharedSourceKind;
  sourceId: string;
  /** Last known tier (the listing's when the row is listed for the attached unit), null when unknown. */
  tier: CloudSourceTier | null;
  contributors: number | null;
  /** When it was shared (ISO). */
  at: string;
  /** The session kind that shared it. */
  via: UploaderSession;
  model: number;
  firmware: string;
  /** The session that shared it is the current one of its kind (it can be removed from here); false when it was
   *  shared under another account or an anonymous session this install no longer has. */
  removable: boolean;
}

/** GET /device/cache/cloud/share. */
export interface CloudShareStatus {
  /** The attached unit's definitions can be shared (a gen-3 grid unit the shared store serves). */
  supported: boolean;
  device: { model: number; firmware: string | null; key: string | null } | null;
  cloud: { enabled: boolean; signedIn: boolean; anonymousAllowed: boolean | null };
  /** The consent version a share must carry. */
  consentVersion: number;
  shareable: ShareableEntry[];
  /** This install's shares, all units and firmwares (the attached unit's first). */
  shares: ShareView[];
  reason: null | 'no-device' | 'unsupported' | 'firmware-unknown' | 'cloud-disabled' | 'dev-hook-active' | 'profile-stale' | 'no-local-source';
}

/** The facts a share is expected to send for a kind (from a dry run's `expect`). */
export interface ExpectedShare { kind: SharedSourceKind; factHash: string }

/** The parsed share request. */
export interface ShareOptions {
  consent: boolean;
  consentVersion: number | null;
  /** The kinds to share; null = every shareable one. */
  kinds: RawSourceKind[] | null;
  dryRun: boolean;
  /** Also publish the editor cache's derived tables to the v1 store (default on). */
  compat: boolean;
  /** What the user previewed: the send must carry exactly these (kind, fact hash) pairs, else 409. */
  expect?: ExpectedShare[];
  axisVersion?: string;
}

/** A stored share record (`definitionShares/<key>` `shares[]`). No user id, no path, no name. */
interface ShareRecord {
  kind: SharedSourceKind;
  sourceId: string;
  /** The facts shared (the codec's fact hash of the sanitized source). */
  factHash: string;
  via: UploaderSession;
  /** `sessionTag` of the session that shared (absent when it could not be known): which session can withdraw it. */
  uploaderKey?: string;
  at: string;
  consentVersion?: number;
  tier?: CloudSourceTier;
  contributors?: number;
  /** When the cloud unlinks the share (after that it can no longer be removed individually), from `?refresh=1`. */
  linkedUntil?: string;
}

/** A stored source judged for sharing. */
interface Candidate {
  kind: RawSourceKind;
  records: number;
  capturedAt: string | null;
  refusal?: { reason: ShareSkipReason; path?: string; bytes?: number };
  /** The sanitized, shared-mode-checked copy: what is sent. */
  source?: ShareableSource;
  factHash?: string;
}

type Identity = { model: number; firmware: string; key: string };

// ── small helpers ──

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isSharedKind = (v: unknown): v is SharedSourceKind => typeof v === 'string' && (SHARED_KINDS as readonly string[]).includes(v);
const isTier = (v: unknown): v is CloudSourceTier => typeof v === 'string' && (SERVED_TIERS as readonly string[]).includes(v);
const isVia = (v: unknown): v is UploaderSession => v === 'account' || v === 'anonymous';
const isStamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}([T ][0-9:.+-]+Z?)?$/.test(v);
const fail = (code: number, body: Record<string, unknown>): ShareResult => ({ code, body });
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

function cloudOn(cloud: ShareCloud | null): cloud is ShareCloud {
  if (!cloud) return false;
  try { return cloud.isEnabled?.() ?? true; } catch { return false; }
}

async function signedIn(cloud: ShareCloud): Promise<boolean> {
  try { return (await cloud.hasAccountSession?.()) === true; } catch { return false; }
}

/** The tag of a session user id: sha256 of `definition-sharer:<id>`, first 32 hex. Domain-prefixed, so it never equals
 *  the tag the editor-cache contribution keeps for the same account. */
async function sessionTag(userId: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`definition-sharer:${userId}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** The tag of the CURRENT stored session of that kind: a tag, null (no such session), or undefined (the client cannot
 *  say: a structural client without `definitionSharer`). Local read, no network. */
async function currentTag(cloud: ShareCloud, via: UploaderSession): Promise<string | null | undefined> {
  if (typeof cloud.definitionSharer !== 'function') return undefined;
  let id: string | null;
  try { id = await cloud.definitionSharer(via); } catch { return undefined; }
  return id === null ? null : sessionTag(id);
}

/** Is a record the current session's? A record without a tag cannot be told apart (counted as the current one's). */
const ownedBy = (r: ShareRecord, tag: string | null | undefined): boolean => tag !== null && (tag === undefined || !r.uploaderKey || r.uploaderKey === tag);

/** The device-cache key's (model, firmware), or null. */
function keyParts(key: string): { model: number; firmware: string } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { model: parseInt(m[1]!, 16), firmware: `${Number(m[2])}.${Number(m[3])}` };
}

// ── what the cloud said about anonymous sharing (per cloud client, for a while) ──

const ANONYMOUS_POLICY = new WeakMap<object, { allowed: boolean; at: number }>();

function learnedPolicy(cloud: ShareCloud, now: number): boolean | null {
  const p = ANONYMOUS_POLICY.get(cloud);
  if (!p || now - p.at < 0 || now - p.at >= ANONYMOUS_POLICY_MS) return null;
  return p.allowed;
}

/** What is known about anonymous sharing: a recent refusal or success first, else the listing's `allowAnonymous` (a
 *  missing field is unknown, never `false`), else null. */
function anonymousPolicy(cloud: ShareCloud, list: DefinitionSourceList | null, now: number): boolean | null {
  return learnedPolicy(cloud, now) ?? (typeof list?.allowAnonymous === 'boolean' ? list.allowAnonymous : null);
}

function noteAnonymousPolicy(cloud: ShareCloud, allowed: boolean, now: number): void {
  ANONYMOUS_POLICY.set(cloud, { allowed, at: now });
}

/** Forget what the cloud said about anonymous sharing (test seam; a sign-in does not need it: an account never asks). */
export function forgetAnonymousSharePolicy(cloud: object): void {
  ANONYMOUS_POLICY.delete(cloud);
}

// ── the local share records (`definitionShares/<key>`) ──

function recordOf(v: unknown): ShareRecord | null {
  if (!isObj(v)) return null;
  const sourceId = normalizeRowId(v.sourceId);
  if (!isSharedKind(v.kind) || !sourceId || typeof v.factHash !== 'string' || !FACT_HASH_RE.test(v.factHash) || !isVia(v.via) || !isStamp(v.at)) return null;
  return {
    kind: v.kind, sourceId, factHash: v.factHash, via: v.via,
    ...(typeof v.uploaderKey === 'string' && TAG_RE.test(v.uploaderKey) ? { uploaderKey: v.uploaderKey } : {}),
    at: v.at,
    ...(isCount(v.consentVersion) && v.consentVersion >= 1 ? { consentVersion: v.consentVersion } : {}),
    ...(isTier(v.tier) ? { tier: v.tier } : {}),
    ...(isCount(v.contributors) ? { contributors: v.contributors } : {}),
    ...(isStamp(v.linkedUntil) ? { linkedUntil: v.linkedUntil } : {})
  };
}

/** The records stored for a device key (malformed entries ignored, never trusted). */
function readShares(store: Pick<Store, 'getDoc'>, key: string): ShareRecord[] {
  const doc = store.getDoc(DEFINITION_SHARES_COLLECTION, key);
  const list = doc && !doc.deleted && isObj(doc.data) ? doc.data.shares : undefined;
  if (!Array.isArray(list)) return [];
  const out: ShareRecord[] = [];
  for (const v of list.slice(0, DEFINITION_SHARES_MAX * 2)) {
    const r = recordOf(v);
    if (r) out.push(r);
  }
  return out;
}

/** Store the records of a key (the newest `DEFINITION_SHARES_MAX`; an empty list deletes the doc). Newest first,
 *  and a stable kind/source tie-break so two writers of the same moment store the same array — the order must not
 *  depend on which request happened to finish first. */
function writeShares(store: Pick<Store, 'putDoc' | 'delDoc'>, key: string, records: ShareRecord[]): void {
  if (records.length === 0) { store.delDoc(DEFINITION_SHARES_COLLECTION, key); return; }
  const kept = [...records]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1
      : a.kind < b.kind ? -1 : a.kind > b.kind ? 1
        : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
    .slice(0, DEFINITION_SHARES_MAX);
  store.putDoc(DEFINITION_SHARES_COLLECTION, key, { shares: kept });
}

/** Every key with stored share records. */
function shareKeys(store: Pick<Store, 'listDocs'>): string[] {
  return store.listDocs(DEFINITION_SHARES_COLLECTION).map((d) => d.id).filter((k) => KEY_RE.test(k));
}

const sameSession = (a: ShareRecord, b: ShareRecord): boolean => a.via === b.via && (!a.uploaderKey || !b.uploaderKey || a.uploaderKey === b.uploaderKey);

/** Record a share: it replaces the same session's record of the same kind (the cloud keeps one share per uploader and
 *  kind) and of the same row; another session's records stay. Read and written without an await in between. */
function addShare(store: Store, key: string, rec: ShareRecord): void {
  const kept = readShares(store, key).filter((r) => !(sameSession(r, rec) && (r.kind === rec.kind || r.sourceId === rec.sourceId)));
  writeShares(store, key, [...kept, rec]);
}

/** Drop the records `drop` selects, in every key. */
function dropShares(store: Store, drop: (r: ShareRecord, key: string) => boolean): number {
  let n = 0;
  for (const key of shareKeys(store)) {
    const all = readShares(store, key);
    const kept = all.filter((r) => !drop(r, key));
    if (kept.length !== all.length) { n += all.length - kept.length; writeShares(store, key, kept); }
  }
  return n;
}

function anyRecord(store: Store, pred: (r: ShareRecord, key: string) => boolean): boolean {
  return shareKeys(store).some((key) => readShares(store, key).some((r) => pred(r, key)));
}

// ── the stored sources, judged for sharing ──

/** The judged candidates per store, device key and stored-doc revision (the sanitizer and the fact hashes are the costly
 *  part of a status read). Callers get copies. */
const CANDIDATES = new WeakMap<object, Map<string, { rev: string; candidates: Candidate[] }>>();

/** The stored sources of `raw` judged for sharing, memoized per stored-doc revision (`rev`). */
async function shareCandidatesFor(store: Store, raw: ProfileRaw, id: Identity, rev: string): Promise<Candidate[]> {
  let memo = CANDIDATES.get(store);
  if (!memo) CANDIDATES.set(store, (memo = new Map()));
  const memoKey = `${id.key}|${id.model}|${id.firmware}`;
  const hit = memo.get(memoKey);
  const candidates = hit && hit.rev === rev ? hit.candidates : await shareCandidates(raw, id);
  if (!hit || hit.rev !== rev) memo.set(memoKey, { rev, candidates });
  return candidates.map((c) => ({ ...c, ...(c.refusal ? { refusal: { ...c.refusal } } : {}) }));
}

/** The local sources of `raw` as a share would send them. Per source, in the stored order: origin (`cloud-origin`,
 *  `file-origin`), kind (`probe`), the stored shape (`invalid-source`), the device firmware (`firmware-differs`), one
 *  source per kind (`duplicates`), the codec's sanitizer (`tolerant-source`, `contains-user-data`, `duplicates`,
 *  `invalid-source`), the shared-mode check of its output (`invalid-source` with the path), the fact hash, the size of
 *  its envelope (`too-large`). */
async function shareCandidates(raw: ProfileRaw, id: Identity): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const kinds = new Set<string>();
  const list = Array.isArray(raw.sources) ? (raw.sources as unknown[]) : [];
  for (const s0 of list) {
    const s = isObj(s0) ? s0 : {};
    const kind = (ALL_KINDS as readonly unknown[]).includes(s.kind) ? (s.kind as RawSourceKind) : null;
    if (!kind) continue; // nothing this build reads; never listed
    const c: Candidate = {
      kind, records: Array.isArray(s.records) ? s.records.length : 0,
      capturedAt: typeof s.capturedAt === 'string' ? coarsenCapturedAt(s.capturedAt) : null
    };
    out.push(c);
    if (s.origin === 'cloud') { c.refusal = { reason: 'cloud-origin' }; continue; }
    if (s.origin === 'file') { c.refusal = { reason: 'file-origin' }; continue; }
    if (kind === 'live-probe') { c.refusal = { reason: 'probe' }; continue; }
    // the stored source is validated before it is sanitized (a damaged store never reaches the sanitizer)
    const stored = checkRawSources([s0], 'sources');
    if (!stored.ok) { c.refusal = { reason: 'invalid-source', path: stored.path }; continue; }
    const v = stored.sources[0]!;
    if (v.origin !== 'local') { c.refusal = { reason: 'invalid-source', path: 'source.origin' }; continue; }
    if (v.firmware !== id.firmware) { c.refusal = { reason: 'firmware-differs' }; continue; }
    if (kinds.has(kind)) { c.refusal = { reason: 'duplicates' }; continue; }
    kinds.add(kind);
    let shared: ReturnType<typeof shareableSource>;
    try { shared = shareableSource(v); } catch { c.refusal = { reason: 'invalid-source' }; continue; }
    if ('refused' in shared) {
      c.refusal = { reason: shared.refused === 'user-data' ? 'contains-user-data' : shared.refused === 'probe' ? 'probe' : shared.refused };
      continue;
    }
    // our own output must pass the strict shared-mode check: the checked copy is what is sent, nothing else
    const checked = checkSharedSource(shared, 'source');
    if (!checked.ok) { c.refusal = { reason: 'invalid-source', path: checked.path }; continue; }
    try {
      c.factHash = await sourceFactHash(checked.source as unknown as RawSource, { model: id.model, firmware: id.firmware });
    } catch {
      c.refusal = { reason: 'invalid-source' };
      continue;
    }
    c.source = checked.source;
    // the envelope's size with the longest version stamps it can carry
    sizeCheck(c, envelopeOf(id, kind as SharedSourceKind, c.source, { forgefx: 'x'.repeat(32), codec: 'x'.repeat(32), axis: 'x'.repeat(32) }, new Date(0).toISOString(), SHARE_CONSENT_VERSION));
  }
  return out;
}

/** The version stamps a share carries (each `[0-9A-Za-z.+-]{1,32}`; others are left out). */
function appStamps(versions: { forgefx?: string; axis?: string }): DefinitionSourceContribution['app'] {
  const app: DefinitionSourceContribution['app'] = {};
  if (versions.forgefx && VERSION_RE.test(versions.forgefx)) app.forgefx = versions.forgefx;
  if (VERSION_RE.test(CODEC_VERSION)) app.codec = CODEC_VERSION;
  if (versions.axis && VERSION_RE.test(versions.axis)) app.axis = versions.axis;
  return app;
}

/** The exact request body of one share (`POST definition-sources`). */
function envelopeOf(id: Identity, kind: SharedSourceKind, source: ShareableSource, app: DefinitionSourceContribution['app'], consentAt: string, consentVersion: number): DefinitionSourceContribution {
  return { model: id.model, firmware: id.firmware, kind, rawFormat: RAW_FORMAT, source, app, consentAt, consentVersion };
}

/** Over the size limit → the candidate is refused `too-large` (`bytes` = the envelope's UTF-8 length). */
function sizeCheck(c: Candidate, env: DefinitionSourceContribution): boolean {
  const bytes = utf8Length(JSON.stringify(env));
  if (bytes <= MAX_SHARE_BYTES) return true;
  c.refusal = { reason: 'too-large', bytes };
  delete c.source;
  return false;
}

// ── the unit and its stored definitions ──

function modelSupported(registry: DeviceRegistry, model: number): boolean {
  const caps = registry.activeCapabilities();
  return DEFINITION_SOURCE_MODELS.includes(model) && !!caps && caps.slotModel === 'grid' && caps.selfDescribe === true;
}

/** The attached unit (model, read firmware, key), or the refusal that says why there is none. */
async function shareIdentity(registry: DeviceRegistry): Promise<{ id: Identity } | { result: ShareResult }> {
  await registry.driver(); // ensure detection ran
  const model = registry.detectedModelId;
  if (model < 0) return { result: fail(503, { error: 'no-device' }) };
  if (!modelSupported(registry, model)) return { result: fail(409, { error: 'unsupported-model', model, message: 'the definitions of this unit are not shared' }) };
  const fw = registry.firmwareInfo();
  if (!fw) return { result: fail(503, { error: 'firmware-unknown' }) };
  return { id: { model, firmware: `${fw.major}.${fw.minor}`, key: deviceCacheKey(model, fw.major, fw.minor) } };
}

/** The stored definitions' raw sources for the key (with the stored doc's revision), or why there are none to share:
 *  404 `nothing-to-share` (nothing stored, a legacy document without raw sources), 409 `profile-stale` (definitions this
 *  build cannot use; raw sources a newer build wrote: `staleReason: 'newer'`), 409 `dev-hook-active` (derived while a
 *  development hook hid a catalog family). */
function storedRaw(store: Store, key: string): { raw: ProfileRaw; rev: string } | { result: ShareResult; reason: 'no-local-source' | 'profile-stale' | 'dev-hook-active' } {
  const doc = store.getDoc('deviceCaches', key);
  const data = doc && !doc.deleted ? doc.data : null;
  if (!doc || !isObj(data)) return { result: fail(404, { error: 'nothing-to-share', message: 'no definitions are stored for this unit and firmware' }), reason: 'no-local-source' };
  if (isObj(data.meta) && data.meta.derivedHidden !== undefined) return { result: fail(409, devHookActiveBody()), reason: 'dev-hook-active' };
  const stored = loadStoredProfile(store, key);
  if (stored.state === 'stale') return { result: fail(409, { error: 'profile-stale', ...staleFields(stored.check) }), reason: 'profile-stale' };
  if (hasNewerRaw(data)) {
    return {
      result: fail(409, { error: 'profile-stale', stale: true, staleReason: 'newer', message: 'the stored definitions were written by a newer version of this app; share them from there' }),
      reason: 'profile-stale'
    };
  }
  const raw = readableRaw(data);
  if (!raw) {
    return {
      result: fail(404, { error: 'nothing-to-share', message: 'the stored definitions carry no raw sources to share (read them from the device or import the editor file again)' }),
      reason: 'no-local-source'
    };
  }
  return { raw, rev: `${doc.rev}:${doc.updatedAt}` };
}

// ── the cloud's answers ──

/** Map a failed `definition-sources` write onto this API's errors. `perSource`: a refusal of THIS source (its size, its
 *  content), after which the other kinds are still shared; anything else (the session, the limits, the service) stops. */
function cloudError(r: DefinitionSourceOutcome): { result: ShareResult; perSource: boolean } {
  const rb = isObj(r.body) ? r.body : {};
  const err = typeof rb.error === 'string' ? rb.error : null;
  const message = typeof rb.message === 'string' ? rb.message.slice(0, 300) : undefined;
  const msg = message !== undefined ? { message } : {};
  const global = (code: number, body: Record<string, unknown>) => ({ result: fail(code, body), perSource: false });
  const source = (code: number, body: Record<string, unknown>) => ({ result: fail(code, body), perSource: true });
  if (r.disabled) return global(503, { error: 'cloud-disabled' });
  if (r.code === 503 && err === 'auth-unavailable') {
    const s = typeof rb.retryAfterSeconds === 'number' ? rb.retryAfterSeconds : Number(r.retryAfter ?? NaN);
    return global(503, { error: 'auth-unavailable', retryAfterSeconds: Number.isFinite(s) ? s : null, ...(typeof rb.reason === 'string' ? { reason: rb.reason } : {}), ...msg });
  }
  if (r.code === 401) return global(401, { error: 'not-signed-in', ...(typeof rb.reason === 'string' ? { reason: rb.reason } : {}) });
  if (r.code === 403 && err === 'account-required') return global(401, { error: 'not-signed-in', reason: 'account-required' });
  if (r.code === 400 && err === 'consent-required') {
    return global(400, { error: 'not-consented', reason: 'consent-refused', message: 'the cloud did not accept the consent (check this computer\'s clock and date)' });
  }
  if (r.code === 409 && err === 'unsupported-model') return global(409, { error: 'unsupported-model' });
  if (r.code === 409 && err === 'rejected') return source(409, { error: 'rejected', message: 'these definitions were rejected by the maintainer' });
  if (r.code === 413) {
    return source(413, { error: 'too-large', ...(isCount(rb.bytes) ? { bytes: rb.bytes } : {}), limit: isCount(rb.limit) ? rb.limit : MAX_SHARE_BYTES });
  }
  if (r.code === 422) {
    const known = ['invalid-source', 'contains-user-data', 'tolerant-source', 'firmware-inconsistent', 'version-mismatch', 'implausible', 'unsupported-raw-format'];
    const e = err && known.includes(err) ? err : 'invalid-source';
    return source(422, {
      error: e, ...(typeof rb.path === 'string' ? { path: rb.path.slice(0, 200) } : {}), ...(typeof rb.reason === 'string' ? { detail: rb.reason.slice(0, 200) } : {}), ...msg
    });
  }
  if (r.code === 429) {
    const fromBody = typeof rb.retryAfterSeconds === 'number' ? rb.retryAfterSeconds : NaN;
    const fromHeader = Number(r.retryAfter ?? NaN);
    const retryAfterSeconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : null;
    return global(429, { error: err === 'quota-exceeded' ? 'quota-exceeded' : 'rate-limited', retryAfterSeconds, ...(typeof rb.scope === 'string' ? { scope: rb.scope } : {}) });
  }
  if (r.code === 503 && err === 'paused') return global(503, { error: 'paused' });
  return global(502, { error: 'cloud', status: r.code, message: message ?? (err ?? (r.code === 0 ? 'cloud unreachable' : `cloud answered ${r.code}`)) });
}

/** A successful contribution answer, or null when the 2xx does not carry a row id. */
function shareAnswer(r: DefinitionSourceOutcome): { sourceId: string; factHash: string | null; deduped: boolean; confirmed: boolean; tier: CloudSourceTier | null; contributors: number | null } | null {
  if (r.disabled || r.code < 200 || r.code >= 300 || !isObj(r.body)) return null;
  const b = r.body;
  const sourceId = normalizeRowId(b.sourceId);
  if (!sourceId) return null;
  return {
    sourceId, factHash: typeof b.factHash === 'string' && FACT_HASH_RE.test(b.factHash) ? b.factHash : null,
    deduped: b.deduped === true, confirmed: b.confirmed === true, tier: isTier(b.tier) ? b.tier : null, contributors: isCount(b.contributors) ? b.contributors : null
  };
}

// ── the request bodies ──

/** The share body `{ consent, consentVersion, kinds?, dryRun?, compat?, expect?, axisVersion? }` — or 400: a body that
 *  is not a JSON object, `kinds` that is not a non-empty list of source kinds, `expect` that is not a list of at most
 *  three `{ kind, factHash }` of distinct shared kinds (`invalid-request`); without `dryRun`, no `consent: true`
 *  (`not-consented`); a `consent: true` without a supported `consentVersion` (`unsupported-consent-version`
 *  `{ consentVersion, supported }`, as the editor-cache contribution answers it). Nothing is read or sent before this
 *  passed. */
export function parseShareBody(body: unknown): { ok: true; opts: ShareOptions } | { ok: false; result: ShareResult } {
  const bad = (message: string) => ({ ok: false as const, result: fail(400, { error: 'invalid-request', message }) });
  if (body !== undefined && body !== null && !isObj(body)) return bad('the body must be a JSON object');
  const b = (body ?? {}) as Record<string, unknown>;
  let kinds: RawSourceKind[] | null = null;
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || b.kinds.length === 0 || b.kinds.length > ALL_KINDS.length) return bad(`kinds must be a list of 1 to ${ALL_KINDS.length} source kinds`);
    kinds = [];
    for (const k of b.kinds) {
      if (!(ALL_KINDS as readonly unknown[]).includes(k)) return bad(`kinds may name ${ALL_KINDS.join(', ')}`);
      if (!kinds.includes(k as RawSourceKind)) kinds.push(k as RawSourceKind);
    }
  }
  let expect: ExpectedShare[] | undefined;
  if (b.expect !== undefined) {
    if (!Array.isArray(b.expect) || b.expect.length === 0 || b.expect.length > SHARED_KINDS.length) return bad(`expect must be a list of 1 to ${SHARED_KINDS.length} { kind, factHash }`);
    expect = [];
    for (const e of b.expect) {
      if (!isObj(e) || !isSharedKind(e.kind) || typeof e.factHash !== 'string' || !FACT_HASH_RE.test(e.factHash)) return bad('expect entries are { kind, factHash } of a shared kind');
      if (expect.some((x) => x.kind === e.kind)) return bad('expect names a kind twice');
      expect.push({ kind: e.kind, factHash: e.factHash });
    }
  }
  const consent = b.consent === true;
  const dryRun = b.dryRun === true;
  const consentVersion = typeof b.consentVersion === 'number' && Number.isInteger(b.consentVersion) ? b.consentVersion : null;
  if (!dryRun && !consent) return { ok: false, result: fail(400, { error: 'not-consented', message: 'sharing needs the user\'s consent (consent: true)' }) };
  if (consent && (consentVersion === null || !SUPPORTED_SHARE_CONSENT_VERSIONS.includes(consentVersion))) {
    return {
      ok: false,
      result: fail(400, {
        error: 'unsupported-consent-version', consentVersion, supported: [...SUPPORTED_SHARE_CONSENT_VERSIONS],
        message: `consent must be given to the explanation version ${SHARE_CONSENT_VERSION}`
      })
    };
  }
  const axis = typeof b.axisVersion === 'string' && VERSION_RE.test(b.axisVersion) ? b.axisVersion : undefined;
  return {
    ok: true,
    opts: { consent, consentVersion, kinds, dryRun, compat: b.compat !== false, ...(expect ? { expect } : {}), ...(axis ? { axisVersion: axis } : {}) }
  };
}

/** The withdraw body `{ sourceId } | { all: true, model?, firmware? }`, or 400 `invalid-request`. */
export function parseWithdrawBody(body: unknown): { ok: true; sel: DefinitionSourceWithdrawal } | { ok: false; result: ShareResult } {
  const bad = (message: string) => ({ ok: false as const, result: fail(400, { error: 'invalid-request', message }) });
  if (!isObj(body)) return bad('POST { sourceId } or { all: true }');
  const hasId = body.sourceId !== undefined;
  const all = body.all === true;
  if (hasId === all) return bad('POST either { sourceId } or { all: true }');
  if (hasId) {
    const sourceId = normalizeRowId(body.sourceId);
    if (!sourceId) return bad('sourceId must be a row id');
    return { ok: true, sel: { sourceId } };
  }
  const sel: { all: true; model?: number; firmware?: string } = { all: true };
  if (body.model !== undefined) {
    if (typeof body.model !== 'number' || !Number.isInteger(body.model) || body.model < 0 || body.model > 255) return bad('model must be a model byte');
    sel.model = body.model;
  }
  if (body.firmware !== undefined) {
    if (!isCanonicalFirmware(body.firmware)) return bad('firmware must be <major>.<minor>');
    sel.firmware = body.firmware;
  }
  return { ok: true, sel };
}

// ── GET /device/cache/cloud/share ──

/** Bring the local records in line with the cloud's list of this install's shares (`?refresh=1`), per session: the
 *  signed-in account, and the anonymous sharer session only when anonymous records exist (no back-to-back calls of
 *  both identities otherwise). The listed shares are recorded under the current session's tag (the cloud keeps one per
 *  uploader, unit, firmware and kind); when the list is complete, the current session's records it no longer lists
 *  (withdrawn elsewhere, unlinked after 180 days) are dropped. Records of another session (another account, a former
 *  anonymous session) and records without a tag are never touched. Never creates a session; a failing list changes
 *  nothing. */
async function reconcileMine(cloud: ShareCloud, store: Store, isSignedIn: boolean): Promise<void> {
  if (typeof cloud.definitionSourcesMine !== 'function') return;
  const vias: UploaderSession[] = [];
  if (isSignedIn) vias.push('account');
  if (anyRecord(store, (r) => r.via === 'anonymous')) vias.push('anonymous');
  for (const via of vias) {
    const tag = await currentTag(cloud, via);
    if (tag === null) continue;
    let r: DefinitionSourceOutcome;
    try { r = await cloud.definitionSourcesMine(via); } catch { continue; }
    if (r.code !== 200 || (r.via !== undefined && r.via !== via) || !isObj(r.body) || !Array.isArray(r.body.contributions)) continue;
    const listed = r.body.contributions as unknown[];
    const seen = new Set<string>();
    for (const c of listed.slice(0, MINE_LIMIT)) {
      if (!isObj(c)) continue;
      const sourceId = normalizeRowId(c.sourceId);
      if (!sourceId || !isSharedKind(c.kind) || typeof c.model !== 'number' || !Number.isInteger(c.model) || c.model < 0 || c.model > 255) continue;
      if (!isCanonicalFirmware(c.firmware) || typeof c.factHash !== 'string' || !FACT_HASH_RE.test(c.factHash)) continue;
      const [maj, min] = c.firmware.split('.').map(Number) as [number, number];
      const key = deviceCacheKey(c.model, maj, min);
      seen.add(`${key}:${sourceId}`);
      const prior = readShares(store, key).find((x) => x.via === via && x.sourceId === sourceId && ownedBy(x, tag));
      addShare(store, key, {
        ...(prior ?? {}), kind: c.kind, sourceId, factHash: prior?.factHash ?? c.factHash, via,
        ...(typeof tag === 'string' ? { uploaderKey: tag } : {}),
        at: prior?.at ?? (isStamp(c.createdAt) ? c.createdAt : new Date(0).toISOString()),
        ...(isStamp(c.linkedUntil) ? { linkedUntil: c.linkedUntil } : {})
      });
    }
    if (listed.length < MINE_LIMIT && typeof tag === 'string') {
      dropShares(store, (x, key) => x.via === via && x.uploaderKey === tag && !seen.has(`${key}:${x.sourceId}`));
    }
  }
}

/**
 * GET /device/cache/cloud/share — what the attached unit could share, what this install shared (every unit and
 * firmware), and who can share. Non-erroring: no unit, no cloud, nothing stored all answer 200 with a `reason`
 * (first match): `no-device`, `unsupported`, `firmware-unknown`, `cloud-disabled`, `dev-hook-active`, `profile-stale`,
 * `no-local-source` (nothing shareable stored). `shareable` lists every stored source of the unit's firmware with its
 * state: `not-shareable` (+ `reason`), `shared` (this install's record has these facts), `identical-in-cloud` (the
 * listing has a row with these facts: sharing confirms it), `not-shared`. The listing is the check's (cached for 10
 * minutes; `refresh` asks again and also reconciles the records with the cloud's list of this install's shares — the
 * app ignores `refresh` on a request the Remote relay carries). `relayed` (a request the Remote relay carries): no
 * refresh, and the anonymous shares are left out — a remote session must not learn which rows this install shared
 * anonymously. No session is ever created here.
 */
export async function cloudShareStatus(
  cloud: ShareCloud | null, store: Store, registry: DeviceRegistry, opts: { refresh?: boolean; now?: number; relayed?: boolean } = {}
): Promise<CloudShareStatus> {
  const now = opts.now ?? Date.now();
  const enabled = cloudOn(cloud);
  const isSignedIn = enabled ? await signedIn(cloud) : false;
  const shown = (r: ShareRecord): boolean => !opts.relayed || r.via !== 'anonymous';
  if (enabled && opts.refresh && !opts.relayed) {
    try { await reconcileMine(cloud, store, isSignedIn); } catch { /* the status never fails on the cloud */ }
  }
  const status: CloudShareStatus = {
    supported: false, device: null,
    cloud: { enabled, signedIn: isSignedIn, anonymousAllowed: null },
    consentVersion: SHARE_CONSENT_VERSION, shareable: [], shares: [], reason: null
  };
  await registry.driver();
  const model = registry.detectedModelId;
  let id: Identity | null = null;
  if (model < 0) status.reason = 'no-device';
  else {
    status.supported = modelSupported(registry, model);
    const fw = registry.firmwareInfo();
    status.device = { model, firmware: fw ? `${fw.major}.${fw.minor}` : null, key: fw ? deviceCacheKey(model, fw.major, fw.minor) : null };
    if (!status.supported) status.reason = 'unsupported';
    else if (!fw) status.reason = 'firmware-unknown';
    else id = { model, firmware: `${fw.major}.${fw.minor}`, key: deviceCacheKey(model, fw.major, fw.minor) };
  }
  // the listing: tiers of this unit's shares, identical rows, the cloud's anonymous policy (the check's cache)
  let list: DefinitionSourceList | null = null;
  if (id && enabled) {
    try { list = await definitionSourcesFor(cloud, registry, id, { refresh: opts.refresh, now }); } catch { list = null; }
  }
  if (enabled) status.cloud.anonymousAllowed = anonymousPolicy(cloud, list, now);
  const listed = new Map((list?.sources ?? []).map((s) => [s.id, s] as const));
  if (id) {
    const records = readShares(store, id.key).filter(shown);
    if (!enabled) status.reason = 'cloud-disabled';
    else if (hiddenFamily() !== null) status.reason = 'dev-hook-active';
    const s = storedRaw(store, id.key);
    if ('result' in s) status.reason ??= s.reason;
    else {
      for (const c of await shareCandidatesFor(store, s.raw, id, s.rev)) {
        const entry: ShareableEntry = { kind: c.kind, records: c.records, capturedAt: c.capturedAt, state: 'not-shared' };
        if (c.refusal) { entry.state = 'not-shareable'; entry.reason = c.refusal.reason; }
        else {
          const mine = records.find((r) => r.kind === c.kind && r.factHash === c.factHash);
          const row = mine ? undefined : [...listed.values()].find((v) => v.kind === c.kind && v.factHash === c.factHash);
          if (mine) { entry.state = 'shared'; entry.sourceId = mine.sourceId; }
          else if (row) { entry.state = 'identical-in-cloud'; entry.sourceId = row.id; }
        }
        status.shareable.push(entry);
      }
      if (!status.shareable.some((e) => e.state !== 'not-shareable')) status.reason ??= 'no-local-source';
    }
  }
  // every share this install recorded, the attached unit's first; removable = made by the current session of its kind
  const tags: Partial<Record<UploaderSession, string | null | undefined>> = {};
  for (const via of ['account', 'anonymous'] as const) tags[via] = enabled ? await currentTag(cloud, via) : null;
  const keys = shareKeys(store).sort((a, b) => (a === id?.key ? -1 : b === id?.key ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) {
    const parts = keyParts(key);
    if (!parts) continue;
    for (const r of readShares(store, key).filter(shown)) {
      const l = key === id?.key ? listed.get(r.sourceId) : undefined;
      status.shares.push({
        kind: r.kind, sourceId: r.sourceId, tier: l?.tier ?? r.tier ?? null, contributors: l?.contributors ?? r.contributors ?? null,
        at: r.at, via: r.via, model: parts.model, firmware: parts.firmware, removable: ownedBy(r, tags[r.via])
      });
    }
  }
  return status;
}

// ── POST /device/cache/cloud/share ──

/** One kind as shared. */
interface SharedItem { kind: SharedSourceKind; sourceId: string; factHash: string; deduped: boolean; confirmed: boolean; tier: CloudSourceTier | null; contributors: number | null }

const notSignedInAnonymousRefused = (): ShareResult =>
  fail(401, { error: 'not-signed-in', reason: 'account-required', message: 'sharing definitions currently needs a signed-in account' });

/**
 * POST /device/cache/cloud/share (order in the module comment). 200 `{ ok, dryRun, shared: [{ kind, sourceId, factHash,
 * deduped, confirmed, tier, contributors }], skipped: [{ kind, reason, … }], wouldSend? + expect? (dry run: the exact
 * request bodies and their facts), via? (the session the shares ran under), compat }`. A refusal of one source by the
 * cloud (413 / 422 / 409 `rejected`) skips that kind and the others are still shared; if none was shared the first such
 * refusal is the answer. Any other failure (401 `not-signed-in`, 429, 502, 503) stops at that kind: its status, with
 * what was shared before. Errors before anything is sent: 400 `invalid-request` / `not-consented` /
 * `unsupported-consent-version`; 409 `dev-hook-active` / `unsupported-model` / `profile-stale` / `share-content-changed`
 * (`expect` no longer matches what would be sent); 404 `nothing-to-share` (`skipped` says why); 503 `no-device` /
 * `firmware-unknown` / `cloud-disabled`; 401 `not-signed-in` (`reason: 'account-required'`) while signed out when the
 * cloud refuses anonymous sharing.
 */
export async function cloudShare(
  cloud: ShareCloud | null, store: Store, registry: DeviceRegistry, body: unknown,
  extra: { versions?: { forgefx?: string; axis?: string }; now?: () => number } = {}
): Promise<ShareResult> {
  const parsed = parseShareBody(body);
  if (!parsed.ok) return parsed.result;
  const opts = parsed.opts;
  const now = extra.now ?? Date.now;
  // the development hook's hidden catalog never reaches the shared store (a walk under it may miss a family)
  if (hiddenFamily() !== null) return fail(409, devHookActiveBody());
  const who = await shareIdentity(registry);
  if ('result' in who) return who.result;
  const id = who.id;
  const enabled = cloudOn(cloud);
  if (!opts.dryRun && !enabled) return fail(503, { error: 'cloud-disabled' });
  const s = storedRaw(store, id.key);
  if ('result' in s) return s.result;

  const candidates = (await shareCandidatesFor(store, s.raw, id, s.rev)).filter((c) => !opts.kinds || opts.kinds.includes(c.kind));
  const app = appStamps({ ...extra.versions, ...(opts.axisVersion ? { axis: opts.axisVersion } : {}) });
  const consentAt = new Date(now()).toISOString();
  const consentVersion = opts.consentVersion ?? SHARE_CONSENT_VERSION;
  const skipped: Array<Record<string, unknown>> = [];
  const toSend: Array<{ c: Candidate; env: DefinitionSourceContribution }> = [];
  for (const c of candidates) {
    if (!c.refusal && c.source) {
      const env = envelopeOf(id, c.kind as SharedSourceKind, c.source, app, consentAt, consentVersion);
      if (sizeCheck(c, env)) { toSend.push({ c, env }); continue; }
    }
    const r = c.refusal ?? { reason: 'invalid-source' as const };
    skipped.push({ kind: c.kind, reason: r.reason, ...(r.path ? { path: r.path } : {}), ...(r.bytes !== undefined ? { bytes: r.bytes, limit: MAX_SHARE_BYTES } : {}) });
  }
  if (toSend.length === 0) {
    return fail(404, { error: 'nothing-to-share', message: 'no definitions read on this install can be shared', skipped });
  }
  const facts: ExpectedShare[] = toSend.map((t) => ({ kind: t.c.kind as SharedSourceKind, factHash: t.c.factHash! }));
  // what the user previewed must be what is sent: the same kinds with the same facts, nothing more
  if (opts.expect) {
    const same = opts.expect.length === facts.length && facts.every((f) => opts.expect!.some((e) => e.kind === f.kind && e.factHash === f.factHash));
    if (!same) {
      return fail(409, {
        error: 'share-content-changed', expected: opts.expect, actual: facts,
        message: 'the definitions to share changed since they were previewed; nothing was sent — preview them again'
      });
    }
  }
  const editorCacheRequested = !opts.kinds || opts.kinds.includes('editor-cache');
  const sendsEditorCache = toSend.some((t) => t.c.kind === 'editor-cache');
  /** The v1 compat request (derived from the local editor cache alone), or why there is none. */
  const compatPlan = async (account: boolean): Promise<{ body: V1PublishBody } | { reason: string; status?: number; error?: string }> => {
    if (!editorCacheRequested) return { reason: 'not-requested' };
    if (!sendsEditorCache) return { reason: 'no-editor-cache' };
    if (!account) return { reason: 'anonymous' };
    const p = await v1PublishBody(store, registry, { sources: ['editor-cache'] });
    if (!p.ok) {
      const e = (p.result.body as { error?: unknown }).error;
      return { reason: 'failed', status: p.result.code, ...(typeof e === 'string' ? { error: e.slice(0, 200) } : {}) };
    }
    return { body: p.body };
  };

  if (opts.dryRun) {
    let compat: Record<string, unknown> | null = null;
    if (opts.compat) {
      if (!enabled) compat = { wouldPublish: false, reason: 'cloud-disabled' };
      else {
        const plan = await compatPlan(await signedIn(cloud));
        compat = 'body' in plan ? { wouldPublish: true, wouldSend: plan.body } : { wouldPublish: false, ...plan };
      }
    }
    return { code: 200, body: { ok: true, dryRun: true, shared: [], skipped, wouldSend: toSend.map((t) => t.env), expect: facts, compat } };
  }

  const c0 = cloud as ShareCloud;
  if (typeof c0.definitionSourceContribute !== 'function') return fail(503, { error: 'cloud-disabled', message: 'this cloud client cannot share definitions' });
  const isSignedIn = await signedIn(c0);
  if (!isSignedIn) {
    // the cloud refuses anonymous sharing (a recent refusal, or its listing says so — a missing field is unknown): do not
    // mint (or use) an anonymous identity only to be refused
    let list: DefinitionSourceList | null = null;
    if (learnedPolicy(c0, now()) === null) {
      try { list = await definitionSourcesFor(c0, registry, id, { now: now() }); } catch { list = null; }
    }
    if (anonymousPolicy(c0, list, now()) === false) return notSignedInAnonymousRefused();
  }

  const shared: SharedItem[] = [];
  let via: UploaderSession | undefined;
  let editorCacheVia: UploaderSession | null = null;
  let firstRefusal: ShareResult | null = null;
  let stop: ShareResult | null = null;
  for (const { c, env } of toSend) {
    let r: DefinitionSourceOutcome;
    try { r = await c0.definitionSourceContribute(env); } catch (e) { r = { code: 0, body: { error: (e as Error).message } }; }
    const answer = shareAnswer(r);
    if (answer) {
      const v: UploaderSession = r.via ?? (isSignedIn ? 'account' : 'anonymous');
      via = v;
      if (v === 'anonymous') noteAnonymousPolicy(c0, true, now());
      const item: SharedItem = {
        kind: c.kind as SharedSourceKind, sourceId: answer.sourceId, factHash: answer.factHash ?? c.factHash!, deduped: answer.deduped,
        confirmed: answer.confirmed, tier: answer.tier, contributors: answer.contributors
      };
      shared.push(item);
      if (item.kind === 'editor-cache') editorCacheVia = v;
      // the session's tag (never its user id), computed before the records are read and written (no await between)
      const tag = r.uploaderId ? await sessionTag(r.uploaderId) : await currentTag(c0, v);
      // our own fact hash is recorded (what the local sources are compared with)
      addShare(store, id.key, {
        kind: item.kind, sourceId: item.sourceId, factHash: c.factHash!, via: v, ...(typeof tag === 'string' ? { uploaderKey: tag } : {}),
        at: new Date(now()).toISOString(), consentVersion,
        ...(item.tier ? { tier: item.tier } : {}), ...(item.contributors !== null ? { contributors: item.contributors } : {})
      });
      continue;
    }
    if (r.code >= 200 && r.code < 300 && !r.disabled) {
      stop = fail(502, { error: 'cloud', status: r.code, message: 'the share answer carries no row id' });
      break;
    }
    const mapped = cloudError(r);
    if (r.code === 403 && r.via !== 'account' && isObj(r.body) && r.body.error === 'account-required') noteAnonymousPolicy(c0, false, now());
    if (r.via) via = r.via;
    if (mapped.perSource) {
      skipped.push({ kind: c.kind, reason: String(mapped.result.body.error), status: mapped.result.code, ...omit(mapped.result.body, 'error') });
      firstRefusal ??= mapped.result;
      continue;
    }
    stop = mapped.result;
    break;
  }
  forgetDefinitionSources(registry);

  if (stop) return { code: stop.code, body: { ...stop.body, shared, skipped, ...(via ? { via } : {}) } };
  if (shared.length === 0) return { code: firstRefusal!.code, body: { ...firstRefusal!.body, shared, skipped, ...(via ? { via } : {}) } };

  // compat: the editor cache's own derived tables to the v1 store, under an account, after the editor cache was shared
  let compat: Record<string, unknown> | null = null;
  if (opts.compat) {
    if (editorCacheRequested && sendsEditorCache && !shared.some((x) => x.kind === 'editor-cache')) compat = { published: false, reason: 'not-shared' };
    else {
      const plan = await compatPlan(editorCacheVia === 'account');
      if (!('body' in plan)) compat = { published: false, ...plan };
      else {
        let p: { code: number; body: unknown };
        try { p = await c0.deviceProfilePublish(plan.body); } catch (e) { p = { code: 0, body: { error: (e as Error).message } }; }
        const pb = isObj(p.body) ? p.body : {};
        compat = p.code >= 200 && p.code < 300
          ? { published: true, status: p.code, deduped: pb.deduped === true }
          : { published: false, reason: 'failed', status: p.code, ...(typeof pb.error === 'string' ? { error: pb.error.slice(0, 200) } : {}) };
      }
    }
  }
  return { code: 200, body: { ok: true, dryRun: false, shared, skipped, ...(via ? { via } : {}), compat } };
}

function omit(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const { [k]: _drop, ...rest } = o;
  return rest;
}

// ── POST /device/cache/cloud/share/withdraw ──

/**
 * POST /device/cache/cloud/share/withdraw — `{ sourceId }`: remove one of this install's shares, under each session that
 * recorded it; `{ all: true, model?, firmware? }`: remove all shares of the signed-in account (from every computer) and,
 * when this install recorded anonymous shares, of its anonymous sharer session — optionally of one unit and firmware.
 * Only the session that made a record withdraws it: a record made under another account or a former anonymous session
 * (its tag differs from the current session's) is not sent and stays listed (`session-mismatch`). The cloud deletes
 * only the caller's own contributions, and a row nobody else shared with it. Works without a unit attached. Never
 * creates a session.
 * 200 `{ ok, withdrawn, deletedSources, sessions: [{ via, result, … }] }` — at least one contribution removed;
 * 409 `session-mismatch` (records of another session, kept) / `unverified` (the cloud has no such share for the
 * current session and the record does not say which session made it: kept); 401 `not-signed-in` (the session that
 * shared is gone: kept); 404 `nothing-to-withdraw` (nothing recorded, or the cloud had none of the current session's:
 * those records are dropped); 400 `invalid-request`; 503 `cloud-disabled` / `auth-unavailable` / `paused`; 502
 * `cloud`. A failure after one session succeeded answers that failure with what was withdrawn so far.
 */
export async function cloudShareWithdraw(cloud: ShareCloud | null, store: Store, registry: DeviceRegistry, body: unknown): Promise<ShareResult> {
  const parsed = parseWithdrawBody(body);
  if (!parsed.ok) return parsed.result;
  const sel = parsed.sel;
  if (!cloudOn(cloud) || typeof cloud.definitionSourceWithdraw !== 'function') return fail(503, { error: 'cloud-disabled' });
  const one = 'sourceId' in sel ? sel.sourceId : null;
  const scoped = (r: ShareRecord, key: string): boolean => {
    if (one !== null) return r.sourceId === one;
    const all = sel as { model?: number; firmware?: string };
    const p = keyParts(key);
    return !!p && (all.model === undefined || p.model === all.model) && (all.firmware === undefined || p.firmware === all.firmware);
  };
  const vias: UploaderSession[] = [];
  const addVia = (v: UploaderSession) => { if (!vias.includes(v)) vias.push(v); };
  if (one === null && (await signedIn(cloud))) addVia('account');
  for (const key of shareKeys(store)) for (const r of readShares(store, key)) if (scoped(r, key)) addVia(r.via);
  if (vias.length === 0) return fail(404, { error: 'nothing-to-withdraw', message: one ? 'this install has not recorded that share' : 'this install holds no shared definitions' });

  let withdrawn = 0;
  let deletedSources = 0;
  const sessions: Array<Record<string, unknown>> = [];
  let notSignedIn: Record<string, unknown> | null = null;
  for (const via of vias) {
    const tag = await currentTag(cloud, via);
    const inScope = (r: ShareRecord, key: string) => r.via === via && scoped(r, key);
    const foreign = shareKeys(store).flatMap((key) => readShares(store, key).filter((r) => inScope(r, key) && tag !== null && !ownedBy(r, tag)));
    if (tag === null) {
      // no session of that kind any more: nothing can be withdrawn under it; the records stay listed
      const reason = via === 'anonymous' ? 'anonymous-session-missing' : 'account-signed-out';
      sessions.push({ via, result: 'not-signed-in', reason });
      notSignedIn ??= { error: 'not-signed-in', reason, via };
      continue;
    }
    if (foreign.length > 0) sessions.push({ via, result: 'session-mismatch', kept: foreign.length });
    const owned = shareKeys(store).flatMap((key) => readShares(store, key).filter((r) => inScope(r, key) && ownedBy(r, tag)));
    if (one !== null && owned.length === 0) continue; // nothing of this session's to withdraw
    const ownedSel = (x: ShareRecord, key: string) => inScope(x, key) && ownedBy(x, tag);
    let r: DefinitionSourceOutcome;
    try { r = await cloud.definitionSourceWithdraw(sel, via); } catch (e) { r = { code: 0, body: { error: (e as Error).message } }; }
    const rb = isObj(r.body) ? r.body : {};
    if (!r.disabled && r.code >= 200 && r.code < 300 && isCount(rb.withdrawn)) {
      const w = rb.withdrawn;
      const d = isCount(rb.deletedSources) ? rb.deletedSources : 0;
      withdrawn += w;
      deletedSources += d;
      // the cloud removed this session's contributions in scope (or had none of them): their records go; a record
      // without a tag stays unless something was withdrawn (it may be another session's)
      dropShares(store, (x, key) => ownedSel(x, key) && (w > 0 || !!x.uploaderKey));
      sessions.push({ via, result: w > 0 ? 'withdrawn' : 'not-found', withdrawn: w, deletedSources: d });
      continue;
    }
    if (r.code === 404 && !r.disabled) {
      // the cloud holds no linked share of this session for it (withdrawn elsewhere, unlinked after 180 days): a record
      // tagged with this session goes; one without a tag cannot be told apart from another session's and stays
      const untagged = owned.filter((x) => !x.uploaderKey).length;
      dropShares(store, (x, key) => ownedSel(x, key) && !!x.uploaderKey);
      sessions.push({ via, result: untagged > 0 ? 'unverified' : 'not-found' });
      continue;
    }
    const mapped = cloudError(r);
    if (mapped.result.code === 401) {
      sessions.push({ via, result: 'not-signed-in', ...(typeof mapped.result.body.reason === 'string' ? { reason: mapped.result.body.reason } : {}) });
      notSignedIn ??= { ...mapped.result.body, via };
      continue;
    }
    forgetDefinitionSources(registry);
    return { code: mapped.result.code, body: { ...mapped.result.body, withdrawn, deletedSources, sessions: [...sessions, { via, result: 'failed', status: r.code }] } };
  }
  forgetDefinitionSources(registry);
  if (withdrawn > 0) return { code: 200, body: { ok: true, withdrawn, deletedSources, sessions } };
  const mismatched = sessions.filter((x) => x.result === 'session-mismatch');
  if (mismatched.length > 0) {
    const parts: string[] = [];
    if (mismatched.some((x) => x.via === 'account')) parts.push('shares made under another account stay listed: sign in with that account to remove them');
    if (mismatched.some((x) => x.via === 'anonymous')) parts.push('shares made under an earlier anonymous session of this install, which it no longer has, can no longer be removed from here');
    return fail(409, { error: 'session-mismatch', withdrawn: 0, deletedSources: 0, sessions, message: parts.join('; ') });
  }
  if (sessions.some((x) => x.result === 'unverified')) {
    return fail(409, { error: 'unverified', withdrawn: 0, deletedSources: 0, sessions, message: 'the cloud has no such share for the current session, and which session made it is not recorded; it stays listed' });
  }
  if (notSignedIn) return fail(401, { ...notSignedIn, withdrawn: 0, deletedSources: 0, sessions });
  return fail(404, { error: 'nothing-to-withdraw', message: 'the cloud holds none of these shares (any more)', withdrawn: 0, deletedSources: 0, sessions });
}
