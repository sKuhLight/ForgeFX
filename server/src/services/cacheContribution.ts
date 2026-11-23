// Editor-cache CONTRIBUTION — the user sends the official editor's definitions cache for their device's firmware
// to Axis Cloud, so the maintainer can support a firmware the bundled catalog does not describe yet. Everything
// before the upload is local: the file is validated (it must be a real editor cache for the connected model,
// its header must agree with its name, it must resemble the device's catalog), the owner's own names (preset
// names, user cab names) are blanked by the codec's redaction, and only the redacted copy ever leaves the
// machine. Contract: the GET/POST /device/cache/contribute routes and the decision/withdraw routes (app.ts and
// runtime/router.ts both call this module).
//
//   contributionStatus      GET  /device/cache/contribute       — offer or not, why, which local files qualify
//   parseContributionFlags  POST /device/cache/contribute       — consent gate (runs BEFORE any file is read)
//   contribute              POST /device/cache/contribute       — validate → redact → (import) → (dry run) → upload
//   setContributionDecision POST /device/cache/contribute/decision — asked (snooze) / declined / reset
//   withdrawContribution    POST /device/cache/contribute/withdraw — delete this install's upload in the cloud
//
// Decisions live in the local store collection `cacheContributions`, one doc per device-cache key (model +
// firmware): no paths, no names. The cloud client is structural (`ContributionCloud`): the server passes the
// env-bound Cloud when AXIS_CLOUD=1, Browser Direct its own instance, tests a fake; null = no cloud (status says
// so, uploads answer 503 cloud-disabled, dry runs and decisions still work).
//
// Browser-safe: no node:/fastify imports; sha256 through globalThis.crypto.subtle; the codec's cache subpath.
// Disk discovery and the dry-run file writer stay in app.ts (Node).
import {
  cacheHeaderVersion, headerMatchesFileName, headerMatchesWalk, isCacheRedacted, parseCacheRecords, readCacheHeader,
  redactCacheUserNames, verifyCacheRedaction, WalkError, CacheRedactionError,
  type BuiltCache, type CacheHeader, type CacheWalk
} from 'forgefx-midi/cache';
import { VERSION as CODEC_VERSION } from 'forgefx-midi';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import type { DefinitionsCaps } from '../drivers/types.js';
import { PROFILES, hiddenFamily, runtimeProfileFrom } from '../devices.js';
import { devHookActiveBody } from './cloudProfiles.js';
import { catalogAgreement, compareRows } from '../drivers/profileCompare.js';
import { buildEditorCache, importBuiltCache, parseEditorCacheFilename, NOT_A_DISCOVERED_CACHE, type EditorCacheFileInfo } from './editorCacheImport.js';
import { hasLocalByteSource } from './deviceCache.js';
import { hasNewerRaw, loadStoredProfile } from '../profileSchema.js';
import type { Store } from '../runtime/store.js';
import type { EditorCacheCloudOutcome, EditorCacheReserveBody, UploaderSession } from '../runtime/cloud.js';

// ── constants ──

/** The disclosure text version the contribution dialog must have shown for `consent: true` to count. Version 2
 *  is the text that covers anonymous AND signed-in uploads (it does not say "linked to your account"). Any
 *  change of meaning bumps it. */
export const CONTRIBUTION_CONSENT_VERSION = 2;
/** Consent versions this server accepts. Version 1 (account-only wording) is refused: anonymous uploads made it
 *  inaccurate. */
export const SUPPORTED_CONSENT_VERSIONS: readonly number[] = [CONTRIBUTION_CONSENT_VERSION];
/** Largest cache accepted (the cloud's limit too). Real files are ~0.1–0.35 MB. */
export const MAX_CONTRIBUTION_BYTES = 4 * 1024 * 1024;
/** Below this share of rows agreeing with the bundled catalog the file is not this device family's cache. */
export const AGREEMENT_FLOOR = 0.5;
/** Local store collection of the per-firmware decisions (one doc per device-cache key). */
export const CONTRIBUTIONS_COLLECTION = 'cacheContributions';
/** How long a cloud "wanted" answer is reused (per registry and key); `?refresh=1` bypasses it. */
export const WANTED_CACHE_MS = 10 * 60 * 1000;
/** An unreachable cloud is asked again sooner. */
const UNREACHABLE_CACHE_MS = 60 * 1000;
const ASK_DAYS_DEFAULT = 7;
const ASK_DAYS_MAX = 90;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

// ── types ──

/** The slice of the cloud client the contribution needs (runtime/cloud.ts `Cloud`; structural so tests fake it). */
export interface ContributionCloud {
  /** Configured and switched on (no network). Absent = on. */
  isEnabled?(): boolean;
  /** A non-anonymous account session is stored (local check, no network). */
  hasAccountSession(): boolean | Promise<boolean>;
  /** Public "still collecting this firmware?" read; null on any failure. */
  editorCacheWanted(model: number, firmware: string): Promise<boolean | null>;
  /** Reserve → upload → finalize of the REDACTED bytes; account session, else the anonymous one. */
  editorCacheUpload(bytes: Uint8Array, body: EditorCacheReserveBody): Promise<EditorCacheCloudOutcome>;
  /** Delete one of this install's uploads under the session that made it. */
  editorCacheDelete(uploadId: string, via?: UploaderSession): Promise<EditorCacheCloudOutcome>;
  /** The user id of the stored session of that kind (local read, no network), null when there is none. Lets a
   *  withdraw notice that the session that uploaded is not the current one (anonymous session re-minted,
   *  another account signed in). Absent: no such check. */
  editorCacheUploader?(via: UploaderSession): string | null | Promise<string | null>;
}

/** An HTTP status + JSON body, what every route of this module answers. */
export interface ContributionResult { code: number; body: unknown }

/** One discovered editor cache as discovery reports it (editorCacheDiscovery.ts `EditorCacheCandidate`). */
export interface DiscoveredCache {
  path: string; file: string; editor: string; model: number; fwMajor: number; fwMinor: number; size: number; mtime: string;
}

/** A local file the status offers: a discovered cache of the connected model. */
export interface ContributionCandidate {
  path: string; file: string; editor: string; size: number; mtime: string;
  /** The version in the file name. */
  fileVersion: string;
  /** `exact`: the file name names the device firmware; otherwise the file is for another firmware. */
  match: 'exact' | 'firmware-differs';
}

export type DecisionState = 'asked' | 'declined' | 'uploaded' | 'withdrawn';

/** One upload of this install that can still be deleted (a cloud row id + who made it). */
interface UploadHandle {
  uploadId: string;
  /** The session kind the upload ran under (decides which session deletes it). */
  via?: UploaderSession;
  /** sha256 (first 32 hex) of the uploading session's user id — never the id itself: this doc is readable
   *  through the generic store routes. Compared at withdraw to catch a re-minted session or another account. */
  uploaderKey?: string | null;
  uploadedAt: string;
  sha256?: string;
  fileName?: string;
}

/** The stored decision doc (`cacheContributions/<key>`). `uploads` lists EVERY upload of this install for the
 *  key that can still be withdrawn; it survives later uploads (a duplicate with no row of ours never replaces
 *  the handle to an earlier one) and a later asked/declined/reset. No paths, no names, no account ids. */
interface ContributionDoc {
  state?: DecisionState;
  at?: string;
  /** `asked` only: the snooze end. */
  until?: string;
  /** The LAST upload's cloud row id; null when the cloud already had identical bytes from someone else. */
  uploadId?: string | null;
  sha256?: string;
  fileName?: string;
  consentVersion?: number;
  uploads?: UploadHandle[];
  /** Earlier shape of this branch (one handle at the top level); read as one entry of `uploads`. */
  via?: UploaderSession;
  uploadedAt?: string;
}

/** A withdrawable upload as the API shows it. */
export interface ContributionUpload { uploadId: string; via: UploaderSession | null; uploadedAt: string }

/** The decision as the API shows it. */
export interface ContributionDecision {
  state: DecisionState;
  at: string;
  until?: string;
  /** `uploaded` only. */
  uploadId?: string | null;
}

export type ContributionReason =
  | 'no-device' | 'unsupported' | 'firmware-unknown'
  | 'cloud-disabled' | 'cloud-unreachable' | 'paused' | 'not-wanted'
  | 'declined' | 'uploaded' | 'withdrawn' | 'asked';

export type LocalProfileState = 'byte-exact' | 'live' | 'cloud' | 'stale' | 'none';

/** GET /device/cache/contribute. */
export interface ContributionStatus {
  /** The connected device can contribute (`capabilities.definitions.contribute`). */
  supported: boolean;
  device: { model: number; modelHex: string; firmware: string | null; key: string | null } | null;
  cloud: { enabled: boolean; signedIn: boolean; wanted: boolean | null; checkedAt: string | null };
  decision: ContributionDecision | null;
  /** This install has an upload for this firmware it can still delete. */
  withdrawable: boolean;
  /** Those uploads (newest last), each with the session kind that can delete it. */
  uploads: ContributionUpload[];
  offer: boolean;
  reason: ContributionReason | null;
  localProfile: LocalProfileState;
  discovery: 'ok' | 'unavailable';
  candidates: ContributionCandidate[];
  /** The disclosure version a send must carry (`consentVersion`). */
  consentVersion: number;
}

/** The request flags (JSON body, or the query string of an octet-stream body). */
export interface ContributionFlags {
  consent: boolean;
  consentVersion: number | null;
  import: boolean;
  acceptFirmwareMismatch: boolean;
  dryRun: boolean;
  axisVersion?: string;
}

/** The import sub-result every response (success or error after validation) carries. */
export type ContributionImport =
  | { status: number; imported: boolean; key?: string; error?: string }
  | { skipped: 'not-requested' | 'firmware-differs' | 'newer-profile' | 'unsupported' };

/** What contribute() returns: the HTTP result plus, for a successful dry run, the redacted bytes and the
 *  reserve body (app.ts writes them to FORGEFX_CONTRIBUTE_DRY_RUN_DIR; never part of a response). */
export interface ContributeResult extends ContributionResult {
  dryRunArtifacts?: { sha256: string; redacted: Uint8Array; reserveBody: EditorCacheReserveBody };
}

// ── small helpers ──

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (code: number, body: Record<string, unknown>): ContributionResult => ({ code, body });
const modelHex = (m: number) => m.toString(16).padStart(2, '0');
const baseName = (name: string) => name.split(/[\\/]/).pop() ?? name;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A walk/build failure as a short message: the WalkError's reason and offset, never its hex dump (which can
 *  quote the user's names); other errors keep their first line. */
function safeMessage(e: unknown): string {
  if (e instanceof WalkError) return `${e.reason} at 0x${e.offset.toString(16)}`;
  if (e instanceof CacheRedactionError) return e.reason;
  const m = (e as Error)?.message ?? String(e);
  return (m.split('\n')[0] ?? '').slice(0, 300);
}

/** The connected device's capability facts (definitions block + cacheImport) from the caps DTO. */
async function deviceFacts(registry: DeviceRegistry): Promise<{ model: number; defs: DefinitionsCaps | null; cacheImport: boolean }> {
  await registry.driver(); // ensure detection ran (model, firmware, capabilities)
  const model = registry.detectedModelId;
  if (model < 0) return { model, defs: null, cacheImport: false };
  const info = await registry.deviceInfo();
  const caps = info.capabilities as { definitions?: DefinitionsCaps; cacheImport?: boolean } | null;
  return { model, defs: caps?.definitions ?? null, cacheImport: caps?.cacheImport === true };
}

/** The device KIND can contribute (gen-3 grid + editor-cache import), firmware aside. */
const kindSupported = (f: { defs: DefinitionsCaps | null; cacheImport: boolean }) => !!f.defs?.genericParams && f.cacheImport;

// ── decisions (local store) ──

function readDoc(store: Store, key: string): ContributionDoc | null {
  const d = store.getDoc(CONTRIBUTIONS_COLLECTION, key);
  return d && !d.deleted && isObj(d.data) ? (d.data as ContributionDoc) : null;
}

/** The withdrawable uploads a doc carries (none once withdrawn). */
function handlesOf(doc: ContributionDoc | null): UploadHandle[] {
  if (!doc || doc.state === 'withdrawn') return [];
  const list = Array.isArray(doc.uploads) ? doc.uploads.filter((h) => h && typeof h.uploadId === 'string') : [];
  // the earlier one-handle shape
  if (typeof doc.uploadId === 'string' && doc.via !== undefined && !list.some((h) => h.uploadId === doc.uploadId)) {
    list.unshift({ uploadId: doc.uploadId, via: doc.via, uploadedAt: doc.uploadedAt ?? doc.at ?? '', sha256: doc.sha256, fileName: doc.fileName });
  }
  return list.map((h) => ({ ...h }));
}

/** The parts of a doc that a new decision keeps: the withdrawable uploads. */
function keptUploads(doc: ContributionDoc | null): Pick<ContributionDoc, 'uploads'> {
  const uploads = handlesOf(doc);
  return uploads.length ? { uploads } : {};
}

const uploadView = (h: UploadHandle): ContributionUpload => ({ uploadId: h.uploadId, via: h.via ?? null, uploadedAt: h.uploadedAt });

/** sha256 (first 32 hex) of an uploader id: what the doc stores instead of the id. */
async function uploaderKeyOf(id: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(`uploader:${id}`))).slice(0, 32);
}

function decisionView(doc: ContributionDoc | null): ContributionDecision | null {
  if (!doc?.state || typeof doc.at !== 'string') return null;
  const v: ContributionDecision = { state: doc.state, at: doc.at };
  if (doc.state === 'asked' && typeof doc.until === 'string') v.until = doc.until;
  if (doc.state === 'uploaded') v.uploadId = typeof doc.uploadId === 'string' ? doc.uploadId : null;
  return v;
}

/** Does the decision keep the offer closed right now? `asked` only until its snooze ends. */
function isBlocking(doc: ContributionDoc | null, now: number): boolean {
  if (!doc?.state) return false;
  if (doc.state === 'asked') return typeof doc.until === 'string' && Date.parse(doc.until) > now;
  return true;
}

// ── the cloud "wanted" cache ──

interface WantedEntry { wanted: boolean | null; paused: boolean; checkedAt: number }
const WANTED = new WeakMap<DeviceRegistry, Map<string, WantedEntry>>();

function wantedMap(registry: DeviceRegistry): Map<string, WantedEntry> {
  let m = WANTED.get(registry);
  if (!m) WANTED.set(registry, (m = new Map()));
  return m;
}

/** Remember what an upload learned about the cloud (not wanted any more, paused) so the next status shows it. */
function noteWanted(registry: DeviceRegistry, key: string, wanted: boolean, paused: boolean, now: number): void {
  wantedMap(registry).set(key, { wanted, paused, checkedAt: now });
}

async function wantedFor(registry: DeviceRegistry, cloud: ContributionCloud, key: string, model: number, firmware: string, refresh: boolean, now: number): Promise<WantedEntry> {
  const m = wantedMap(registry);
  const hit = m.get(key);
  const ttl = hit?.wanted === null ? UNREACHABLE_CACHE_MS : WANTED_CACHE_MS;
  if (hit && !refresh && now - hit.checkedAt < ttl) return hit;
  let wanted: boolean | null;
  try { wanted = await cloud.editorCacheWanted(model, firmware); } catch { wanted = null; }
  const entry: WantedEntry = { wanted, paused: false, checkedAt: now };
  m.set(key, entry);
  return entry;
}

const cloudOn = (cloud: ContributionCloud | null): cloud is ContributionCloud => !!cloud && (cloud.isEnabled?.() ?? true);

// ── GET /device/cache/contribute ──

/**
 * Whether to offer a contribution for the connected device and firmware, and which local files qualify.
 * `discovery` = the Node discovery scan (all models; filtered here), or null where there is none (Browser
 * Direct: `discovery: 'unavailable'`, no candidates). Reads the cloud's public "wanted" answer at most every
 * 10 minutes per firmware (`refresh` bypasses the cache). `offer` = supported, cloud on, wanted, and no decision
 * that blocks; signing in is not needed (an anonymous session is used for the upload). `reason` names the
 * first thing that closes the offer.
 */
export async function contributionStatus(
  store: Store,
  registry: DeviceRegistry,
  cloud: ContributionCloud | null,
  discovery: readonly DiscoveredCache[] | null,
  opts: { refresh?: boolean; now?: () => number } = {}
): Promise<ContributionStatus> {
  const now = (opts.now ?? Date.now)();
  const facts = await deviceFacts(registry);
  const enabled = cloudOn(cloud);
  let signedIn = false;
  if (enabled) { try { signedIn = (await cloud.hasAccountSession()) === true; } catch { signedIn = false; } }
  const out: ContributionStatus = {
    supported: false,
    device: null,
    cloud: { enabled, signedIn, wanted: null, checkedAt: null },
    decision: null,
    withdrawable: false,
    uploads: [],
    offer: false,
    reason: null,
    localProfile: 'none',
    discovery: discovery ? 'ok' : 'unavailable',
    candidates: [],
    consentVersion: CONTRIBUTION_CONSENT_VERSION
  };
  if (facts.model < 0) { out.reason = 'no-device'; return out; }

  const model = facts.model;
  const fw = registry.firmwareInfo();
  const key = fw ? deviceCacheKey(model, fw.major, fw.minor) : null;
  out.device = { model, modelHex: modelHex(model), firmware: fw?.version ?? null, key };
  out.supported = facts.defs?.contribute === true;

  if (discovery) {
    out.candidates = discovery
      .filter((c) => c.model === model)
      .map((c): ContributionCandidate => {
        const fileVersion = `${c.fwMajor}.${c.fwMinor}`;
        return { path: c.path, file: c.file, editor: c.editor, size: c.size, mtime: c.mtime, fileVersion, match: fw && fileVersion === fw.version ? 'exact' : 'firmware-differs' };
      })
      .sort((a, b) => (a.match === b.match ? b.mtime.localeCompare(a.mtime) : a.match === 'exact' ? -1 : 1));
  }

  let doc: ContributionDoc | null = null;
  if (key) {
    doc = readDoc(store, key);
    out.decision = decisionView(doc);
    out.uploads = handlesOf(doc).map(uploadView);
    out.withdrawable = out.uploads.length > 0;
    const stored = loadStoredProfile(store, key);
    // 'cloud' = data of another install, grouped as `isByteExactProfile` groups them: a pulled cloud profile or an
    // imported definitions file ('axisdefs'), whatever build kind its `origin` names
    const src = stored.state === 'absent' ? undefined : (stored.profile.meta as { source?: unknown } | undefined)?.source;
    out.localProfile = stored.state === 'absent' ? 'none'
      : stored.state === 'stale' ? 'stale'
      : hasLocalByteSource(stored.profile) ? 'byte-exact'
      : src === 'cloud' || src === 'axisdefs' ? 'cloud' : 'live';
  }

  let entry: WantedEntry | null = null;
  if (enabled && out.supported && key && fw) {
    entry = await wantedFor(registry, cloud, key, model, fw.version, opts.refresh === true, now);
    out.cloud.wanted = entry.wanted;
    out.cloud.checkedAt = new Date(entry.checkedAt).toISOString();
  }

  // first match wins (a device without one can't have the rest)
  if (!kindSupported(facts)) out.reason = 'unsupported';
  else if (!fw || !key) out.reason = 'firmware-unknown';
  else if (!enabled) out.reason = 'cloud-disabled';
  else if (entry?.paused) out.reason = 'paused';
  else if (entry?.wanted === null) out.reason = 'cloud-unreachable';
  else if (entry?.wanted === false) out.reason = 'not-wanted';
  else if (isBlocking(doc, now)) out.reason = doc!.state!;
  out.offer = out.supported && enabled && entry?.wanted === true && !isBlocking(doc, now);
  if (out.offer) out.reason = null;
  return out;
}

// ── validation (§ prepareContribution) ──

/** Everything the validation established about one file. */
export interface PreparedContribution {
  model: number;
  key: string;
  file: EditorCacheFileInfo;
  fileName: string;
  deviceFirmware: string;
  fileVersion: string;
  contentVersion: string;
  firmwareMatch: 'exact' | 'firmware-differs';
  /** The ORIGINAL bytes' build (the local import uses it; it never leaves the machine). */
  built: BuiltCache;
  /** The redacted copy: the only bytes that are ever uploaded. */
  redacted: Uint8Array;
  sha256: string;
  validation: {
    model: number; deviceFirmware: string; fileVersion: string; contentVersion: string; firmwareMatch: 'exact' | 'firmware-differs';
    /** Build date in the cache header (some editors write one), null otherwise. */
    buildDate: string | null;
    /** The device's own firmware build string (fn 0x08), null when it sent none. */
    deviceBuild: string | null;
    sections: number; records: number; unmappedSections: number; suspectFamilies: string[];
    catalog: { firmware: string | null; exact: number; compatible: number; incompatible: number; newRows: number; agreement: number };
  };
  redaction: { version: number; tables: number; names: number; presetNames: number; userCabNames: number; reservedNames?: number };
}

/**
 * Validate one editor cache for the connected device, all locally (nothing leaves the machine on failure):
 * size (1 … 4 MiB, else 413), editor-cache file name (400), model = the connected one (409), device firmware
 * known (503), strict walk + header (file-name version = header version, else 422 `renamed-cache`; header
 * section count = the walk's), build through the codec (422 `cache-parse-failed`), section-assignment
 * suspects (reported), catalog agreement ≥ 0.5 (422 `unrelated-cache`), redaction of the user names with the
 * codec's post-check plus an independent re-check (422 `redaction-failed`), sha256 of the redacted bytes. Last,
 * a file for another firmware than the device's is refused unless `acceptFirmwareMismatch` (409, overridable).
 * Error bodies never quote file content.
 */
export async function prepareContribution(
  registry: DeviceRegistry,
  bytes: Uint8Array,
  name: string,
  opts: { acceptFirmwareMismatch?: boolean } = {}
): Promise<{ ok: true; prep: PreparedContribution } | ({ ok: false } & ContributionResult)> {
  const no = (code: number, body: Record<string, unknown>) => ({ ok: false as const, code, body });
  const facts = await deviceFacts(registry);
  if (facts.model < 0) return no(503, { error: 'no-device' });
  if (!kindSupported(facts) || !PROFILES[facts.model]) return no(501, { error: 'unsupported', capability: 'contribute' });
  const model = facts.model;

  const size = sizeRefusal(bytes.length);
  if (size) return { ok: false as const, ...size };
  const fileName = baseName(name);
  const info = parseEditorCacheFilename(fileName);
  if (!info) return no(400, { error: 'not-an-editor-cache-name' });
  if (info.model !== model) return no(409, { error: 'model-mismatch', expected: model, got: info.model });
  const fw = registry.firmwareInfo();
  if (!fw) return no(503, { error: 'firmware-unknown' });

  const fileVersion = `${info.fwMajor}.${info.fwMinor}`;
  let walk: CacheWalk;
  let header: CacheHeader;
  try {
    walk = parseCacheRecords(bytes);
    header = readCacheHeader(bytes);
  } catch (e) {
    return no(422, { error: 'cache-parse-failed', message: safeMessage(e) });
  }
  const contentVersion = cacheHeaderVersion(header);
  if (!headerMatchesFileName(header, fileName)) {
    return no(422, { error: 'renamed-cache', fileVersion, contentVersion, message: 'the version in the file name differs from the version inside the file' });
  }
  if (!headerMatchesWalk(header, walk)) {
    return no(422, { error: 'cache-parse-failed', message: `the header declares ${header.sectionCount} sections, the file holds ${walk.sections.length}` });
  }

  let built: BuiltCache;
  try {
    built = await buildEditorCache(model, bytes, fileVersion);
  } catch (e) {
    return no(422, { error: 'cache-parse-failed', message: safeMessage(e) });
  }

  const staticProfile = PROFILES[model]!;
  const suspects = [...(runtimeProfileFrom(built, staticProfile).profileFacts?.suspectFamilies ?? [])];
  const cmp = compareRows(built, staticProfile, suspects, true);
  const agreement = Math.round(catalogAgreement(cmp) * 10000) / 10000;
  if (catalogAgreement(cmp) < AGREEMENT_FLOOR) return no(422, { error: 'unrelated-cache', agreement, floor: AGREEMENT_FLOOR });

  let red: ReturnType<typeof redactCacheUserNames>;
  try {
    red = redactCacheUserNames(bytes);
    // the codec's function already post-checks; check again here, independently, before anything is sent
    verifyCacheRedaction(bytes, red.bytes);
    if (!isCacheRedacted(red.bytes)) throw new Error('a user name is not blank after redaction');
  } catch (e) {
    return no(422, { error: 'redaction-failed', message: safeMessage(e) });
  }
  const sha256 = await sha256Hex(red.bytes);

  const firmwareMatch = fileVersion === fw.version || contentVersion === fw.version ? 'exact' as const : 'firmware-differs' as const;
  if (firmwareMatch !== 'exact' && opts.acceptFirmwareMismatch !== true) {
    return no(409, { error: 'firmware-differs', deviceFirmware: fw.version, fileVersion, contentVersion, overridable: true });
  }

  const redaction: PreparedContribution['redaction'] = {
    version: red.redaction.version, tables: red.tables, names: red.names,
    presetNames: red.byTable.presetNames, userCabNames: red.byTable.userCabNames,
    ...(red.byTable.reservedNames > 0 ? { reservedNames: red.byTable.reservedNames } : {})
  };
  return {
    ok: true,
    prep: {
      model, key: deviceCacheKey(model, fw.major, fw.minor), file: info, fileName,
      deviceFirmware: fw.version, fileVersion, contentVersion, firmwareMatch,
      built, redacted: red.bytes, sha256,
      validation: {
        model, deviceFirmware: fw.version, fileVersion, contentVersion, firmwareMatch,
        buildDate: header.buildDate, deviceBuild: fw.build ? fw.build : null,
        sections: walk.sections.length, records: walk.records.length,
        unmappedSections: built.unmappedSections?.length ?? 0, suspectFamilies: suspects,
        catalog: { firmware: staticProfile.catalogFirmware, exact: cmp.exact, compatible: cmp.compatible, incompatible: cmp.incompatible, newRows: cmp.newRows, agreement }
      },
      redaction
    }
  };
}

/** The size rule (1 … 4 MiB), shared by every way a file arrives: 413 `too-large` `{ bytes, limit }` outside it
 *  (an empty file too, as the contract has it), null inside. */
export function sizeRefusal(bytes: number): ContributionResult | null {
  if (bytes >= 1 && bytes <= MAX_CONTRIBUTION_BYTES) return null;
  return fail(413, { error: 'too-large', bytes, limit: MAX_CONTRIBUTION_BYTES, ...(bytes < 1 ? { message: 'the cache file is empty' } : {}) });
}

/** The 413 for a request body Fastify refused for its size before any handler ran (the route's body limit). */
export function bodyTooLarge(declaredBytes: number | null): ContributionResult {
  return fail(413, { error: 'too-large', ...(declaredBytes !== null && Number.isFinite(declaredBytes) ? { bytes: declaredBytes } : {}), limit: MAX_CONTRIBUTION_BYTES });
}

// ── POST /device/cache/contribute ──

const truthy = (v: unknown, fromQuery: boolean) => (fromQuery ? v === '1' || v === 'true' : v === true);

/**
 * Read and check the request flags — BEFORE the source is resolved, so a refused request reads no file.
 * JSON bodies take booleans; the query string of an octet-stream body takes `1`/`true`. Without `dryRun` the
 * request must carry `consent: true` (400 `not-consented`); `consent: true` must come with a supported
 * `consentVersion` (400 `unsupported-consent-version`).
 */
export function parseContributionFlags(raw: Record<string, unknown>, fromQuery = false): { ok: true; flags: ContributionFlags } | ({ ok: false } & ContributionResult) {
  const consent = truthy(raw.consent, fromQuery);
  const dryRun = truthy(raw.dryRun, fromQuery);
  const cvRaw = raw.consentVersion;
  const cvNum = typeof cvRaw === 'number' ? cvRaw : typeof cvRaw === 'string' && /^\d{1,5}$/.test(cvRaw) ? Number(cvRaw) : NaN;
  const consentVersion = Number.isInteger(cvNum) ? cvNum : null;
  if (!dryRun && !consent) return { ok: false, code: 400, body: { error: 'not-consented' } };
  if (consent && (consentVersion === null || !SUPPORTED_CONSENT_VERSIONS.includes(consentVersion))) {
    return {
      ok: false, code: 400,
      body: { error: 'unsupported-consent-version', consentVersion, supported: [...SUPPORTED_CONSENT_VERSIONS], message: `consent must be given to disclosure version ${CONTRIBUTION_CONSENT_VERSION}` }
    };
  }
  const axis = typeof raw.axisVersion === 'string' && VERSION_RE.test(raw.axisVersion) ? raw.axisVersion : undefined;
  return {
    ok: true,
    flags: {
      consent, consentVersion, dryRun,
      import: truthy(raw.import, fromQuery),
      acceptFirmwareMismatch: truthy(raw.acceptFirmwareMismatch, fromQuery),
      ...(axis ? { axisVersion: axis } : {})
    }
  };
}

/** The 400 a `{ source: { path } }` body gets when the path is not a fresh discovery's candidate — and always
 *  where there is no discovery (Browser Direct), like the import twin. The path is never opened or stat-ed. */
export const NOT_A_DISCOVERED_CACHE_BODY = { error: NOT_A_DISCOVERED_CACHE } as const;
/** The 400 a POST without a usable source gets. */
export const NO_SOURCE_BODY = { error: 'invalid-request', message: 'POST JSON { source: { path } } (a discovered cache), or the .cache bytes as application/octet-stream with ?name=<file name>' } as const;

export interface ContributeOptions {
  /** Server-wide dry run (env FORGEFX_CONTRIBUTE_DRY_RUN / _DIR): never a cloud write, whatever the request says. */
  serverDryRun?: boolean;
  /** Version stamps for the reserve body (`app`). */
  versions?: { forgefx?: string; codec?: string };
  now?: () => number;
}

/** Map a failed upload/delete outcome onto the API's error catalogue. */
function cloudError(r: EditorCacheCloudOutcome, extra: { bytes?: number } = {}): ContributionResult {
  const rb = isObj(r.body) ? r.body : {};
  if (r.disabled) return fail(503, { error: 'cloud-disabled' });
  if (r.code === 401) return fail(401, { error: 'not-signed-in', ...(typeof rb.reason === 'string' ? { reason: rb.reason } : {}) });
  if (r.code === 403 && rb.error === 'account-required') return fail(401, { error: 'not-signed-in', reason: 'account-required' });
  if (r.code === 409 && rb.error === 'not-wanted') return fail(409, { error: 'not-wanted' });
  if (r.code === 409 && rb.error === 'firmware-limit') return fail(409, { error: 'firmware-limit', ...(typeof rb.limit === 'number' ? { limit: rb.limit } : {}) });
  if (r.code === 413) {
    return fail(413, { error: 'too-large', ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}), limit: typeof rb.limit === 'number' ? rb.limit : MAX_CONTRIBUTION_BYTES, ...(typeof rb.stage === 'string' ? { stage: rb.stage } : {}) });
  }
  if (r.code === 422 && rb.error === 'invalid-cache') {
    return fail(422, { error: 'invalid-cache', ...(typeof rb.reason === 'string' ? { reason: rb.reason } : {}), ...(typeof rb.message === 'string' ? { message: rb.message } : {}) });
  }
  if (r.code === 429) {
    const fromBody = typeof rb.retryAfterSeconds === 'number' ? rb.retryAfterSeconds : NaN;
    const fromHeader = Number(r.retryAfter ?? NaN);
    const retryAfterSeconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : null;
    return fail(429, { error: rb.error === 'quota-exceeded' ? 'quota-exceeded' : 'rate-limited', retryAfterSeconds, ...(typeof rb.scope === 'string' ? { scope: rb.scope } : {}) });
  }
  if (r.code === 503 && rb.error === 'paused') return fail(503, { error: 'paused' });
  const message = typeof rb.message === 'string' ? rb.message : typeof rb.error === 'string' ? rb.error : r.code === 0 ? 'cloud unreachable' : `cloud answered ${r.code}`;
  return fail(502, { error: 'cloud', status: r.code, message });
}

/**
 * POST /device/cache/contribute, after `parseContributionFlags` and the route's source resolution: validate
 * (`prepareContribution`) → optional local import of the ORIGINAL bytes (exact firmware only, never over a
 * profile a newer build wrote) → dry run: answer with `wouldSend`, nothing sent, no decision → cloud on? →
 * upload the REDACTED bytes (reserve with the sha256, signed upload, finalize) → persist the decision
 * `uploaded` (also when deduplicated) → answer. The status is the upload step's; error bodies after validation
 * carry the `import` sub-result. An import that fails stops before the upload.
 */
export async function contribute(
  store: Store,
  registry: DeviceRegistry,
  cloud: ContributionCloud | null,
  source: { bytes: Uint8Array; name: string },
  flags: ContributionFlags,
  opts: ContributeOptions = {}
): Promise<ContributeResult> {
  const now = (opts.now ?? Date.now)();
  // the validation summary (unmapped sections, suspects, catalog agreement) would be computed against the development
  // hook's hidden catalog: no contribution (nor its coupled import or dry run) while the hook is active
  if (hiddenFamily() !== null) return { code: 409, body: devHookActiveBody() };
  const p = await prepareContribution(registry, source.bytes, source.name, { acceptFirmwareMismatch: flags.acceptFirmwareMismatch });
  if (!p.ok) return { code: p.code, body: p.body };
  const prep = p.prep;

  // ── coupled local import (original bytes, the build validation already made) ──
  let imp: ContributionImport;
  if (!flags.import) imp = { skipped: 'not-requested' };
  else if (prep.firmwareMatch !== 'exact') imp = { skipped: 'firmware-differs' };
  else {
    const stored = loadStoredProfile(store, prep.key);
    // a profile a NEWER build wrote (stale format 1, a format-2 doc this build only re-derives in memory, or one whose
    // raw envelope is of a newer format — the import's merge would refuse it, see profileMerge.ts `mergeRefusal`)
    const storedDoc = store.getDoc('deviceCaches', prep.key);
    const newerRaw = !!storedDoc && !storedDoc.deleted && hasNewerRaw(storedDoc.data);
    if ((stored.state === 'stale' && stored.check.reason === 'newer') || (stored.state === 'usable' && stored.rederived === 'newer') || newerRaw) imp = { skipped: 'newer-profile' };
    else {
      try {
        const r = await importBuiltCache(registry, store, prep.built, prep.file);
        const rb = isObj(r.body) ? r.body : {};
        imp = r.code === 200 ? { status: 200, imported: true, key: typeof rb.key === 'string' ? rb.key : prep.key } : { status: r.code, imported: false, error: typeof rb.error === 'string' ? rb.error : 'import failed' };
      } catch (e) {
        imp = { status: 500, imported: false, error: safeMessage(e) };
      }
      if (!imp.imported) return { code: imp.status >= 400 ? imp.status : 500, body: { error: 'import-failed', import: imp } };
    }
  }

  const app: EditorCacheReserveBody['app'] = {
    forgefx: opts.versions?.forgefx && VERSION_RE.test(opts.versions.forgefx) ? opts.versions.forgefx : 'unknown',
    codec: opts.versions?.codec && VERSION_RE.test(opts.versions.codec) ? opts.versions.codec : (CODEC_VERSION || 'unknown'),
    ...(flags.axisVersion ? { axis: flags.axisVersion } : {})
  };
  const v = prep.validation;
  const reserveBody: EditorCacheReserveBody = {
    model: prep.model, deviceFirmware: prep.deviceFirmware, fileVersion: prep.fileVersion, contentVersion: prep.contentVersion,
    fileName: prep.fileName, sha256: prep.sha256, bytes: prep.redacted.length,
    // counts only — never the per-kind split, never bytesReplaced
    redaction: { version: prep.redaction.version, tables: prep.redaction.tables, names: prep.redaction.names },
    summary: {
      sections: v.sections, records: v.records, unmappedSections: v.unmappedSections, suspectFamilies: [...v.suspectFamilies],
      newRows: v.catalog.newRows, incompatibleRows: v.catalog.incompatible, agreement: v.catalog.agreement
    },
    app,
    consentAt: new Date(now).toISOString(),
    consentVersion: flags.consentVersion ?? CONTRIBUTION_CONSENT_VERSION
  };
  const head = {
    ok: true,
    file: { name: prep.fileName, bytes: prep.redacted.length, sha256: prep.sha256 },
    validation: prep.validation,
    redaction: prep.redaction,
    import: imp
  };

  // ── dry run: everything but the cloud writes ──
  if (flags.dryRun || opts.serverDryRun) {
    return {
      code: 200,
      body: { ...head, dryRun: true, upload: null, wouldSend: reserveBody },
      dryRunArtifacts: { sha256: prep.sha256, redacted: prep.redacted, reserveBody }
    };
  }

  // ── upload ──
  let via: UploaderSession | undefined;
  const withImport = (r: ContributionResult): ContributionResult => ({ code: r.code, body: { ...(r.body as object), ...(via ? { via } : {}), import: imp } });
  if (!cloudOn(cloud)) return withImport(fail(503, { error: 'cloud-disabled' }));
  let r: EditorCacheCloudOutcome;
  try { r = await cloud.editorCacheUpload(prep.redacted, reserveBody); } catch (e) { r = { code: 0, body: { error: safeMessage(e) } }; }
  via = r.via;
  const rb = isObj(r.body) ? r.body : {};
  const ok = !r.disabled && r.code >= 200 && r.code < 300 && rb.status === 'complete' && (typeof rb.uploadId === 'string' || rb.uploadId === null);
  if (!ok) {
    if (r.code === 409 && rb.error === 'not-wanted') noteWanted(registry, prep.key, false, false, now);
    if (r.code === 503 && rb.error === 'paused') noteWanted(registry, prep.key, false, true, now);
    if (r.code >= 200 && r.code < 300 && !r.disabled) return withImport(fail(502, { error: 'cloud', status: r.code, message: 'the upload did not complete' }));
    return withImport(cloudError(r, { bytes: prep.redacted.length }));
  }
  const uploadId = typeof rb.uploadId === 'string' ? rb.uploadId : null;
  const covered = rb.covered === true;
  const at = new Date(now).toISOString();
  // computed BEFORE the read: from reading the list to writing it back there must be no await, or two uploads
  // finishing together (or a withdraw) would write from the same old list and drop a handle
  const uploaderKey = r.uploaderId ? await uploaderKeyOf(r.uploaderId) : null;
  // every withdrawable upload stays listed: a later upload (or a duplicate with no row of ours) never drops one
  const uploads = handlesOf(readDoc(store, prep.key));
  if (uploadId && !uploads.some((h) => h.uploadId === uploadId)) {
    uploads.push({ uploadId, ...(r.via ? { via: r.via } : {}), uploaderKey, uploadedAt: at, sha256: prep.sha256, fileName: prep.fileName });
  }
  const doc: ContributionDoc = {
    state: 'uploaded', at, uploadId, sha256: prep.sha256, fileName: prep.fileName, consentVersion: reserveBody.consentVersion,
    ...(uploads.length ? { uploads } : {})
  };
  store.putDoc(CONTRIBUTIONS_COLLECTION, prep.key, doc);
  if (covered) noteWanted(registry, prep.key, false, false, now);
  return {
    code: 200,
    body: { ...head, dryRun: false, upload: { status: 'complete', uploadId, deduped: rb.deduped === true, covered, via: r.via ?? null } }
  };
}

// ── decisions ──

/** The connected device's contribution key, or the 503 that says why there is none. */
async function currentKey(registry: DeviceRegistry): Promise<{ key: string } | ContributionResult> {
  await registry.driver();
  const model = registry.detectedModelId;
  if (model < 0) return fail(503, { error: 'no-device' });
  const fw = registry.firmwareInfo();
  if (!fw) return fail(503, { error: 'firmware-unknown' });
  return { key: deviceCacheKey(model, fw.major, fw.minor) };
}

/**
 * POST /device/cache/contribute/decision for the connected model + firmware: `{ decision: 'declined' }` (never
 * ask again for this firmware), `{ decision: 'asked', days? }` (snooze 1..90 days, default 7) or
 * `{ decision: 'reset' }` (forget). An upload this install made stays withdrawable through any of them.
 * 200 `{ key, decision }`; 400 `invalid-request`; 503 `no-device` / `firmware-unknown`.
 */
export async function setContributionDecision(store: Store, registry: DeviceRegistry, body: unknown, opts: { now?: () => number } = {}): Promise<ContributionResult> {
  const b = isObj(body) ? body : {};
  const decision = b.decision;
  if (decision !== 'declined' && decision !== 'asked' && decision !== 'reset') {
    return fail(400, { error: 'invalid-request', message: "decision must be 'declined', 'asked' or 'reset'" });
  }
  let days = ASK_DAYS_DEFAULT;
  if (decision === 'asked' && b.days !== undefined) {
    if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 1 || b.days > ASK_DAYS_MAX) {
      return fail(400, { error: 'invalid-request', message: `days must be an integer 1..${ASK_DAYS_MAX}` });
    }
    days = b.days;
  }
  const k = await currentKey(registry);
  if (!('key' in k)) return k;
  const now = (opts.now ?? Date.now)();
  const kept = keptUploads(readDoc(store, k.key));
  if (decision === 'reset') {
    if (kept.uploads) store.putDoc(CONTRIBUTIONS_COLLECTION, k.key, kept);
    else store.delDoc(CONTRIBUTIONS_COLLECTION, k.key);
    return { code: 200, body: { key: k.key, decision: null } };
  }
  const at = new Date(now).toISOString();
  const doc: ContributionDoc = { ...kept, state: decision, at, ...(decision === 'asked' ? { until: new Date(now + days * 86400_000).toISOString() } : {}) };
  store.putDoc(CONTRIBUTIONS_COLLECTION, k.key, doc);
  return { code: 200, body: { key: k.key, decision: decisionView(doc) } };
}

/** What happened to one upload during a withdraw. */
export interface WithdrawItem {
  uploadId: string;
  via: UploaderSession | null;
  /** `unverified`: the cloud has no such upload for the current session, and nothing recorded says which session
   *  made it (an entry without a session record) — it may belong to another one, so it stays listed. */
  result: 'deleted' | 'gone' | 'session-mismatch' | 'unverified' | 'not-signed-in' | 'failed';
  status?: number;
  reason?: string;
}

/**
 * POST /device/cache/contribute/withdraw: delete EVERY upload this install made for the connected firmware,
 * each under the session that made it, and record `withdrawn` (blocks re-asking like `declined`) once none is
 * left. Before a delete, the current session of that kind must be the one that uploaded (its user id is
 * compared with the stored key): a re-minted anonymous session or another signed-in account answers
 * `409 session-mismatch` and the upload stays listed — never a silent `withdrawn` for an upload still stored.
 * An entry with no session record cannot be checked: a delete that succeeds proves it was ours (the cloud only
 * deletes the caller's own rows), a "not found" does not (`409 unverified`, it stays listed).
 * Answers (all carry `uploads: [{ uploadId, via, result }]` and `remaining`, the uploads still listed):
 *   200 `{ ok, uploadId, via, deleted: true }` — at least one deleted, none of ours failed;
 *   404 `not-found` — every one already gone in the cloud;
 *   404 `nothing-to-withdraw`; 409 `session-mismatch` / `unverified`; 401 `not-signed-in` (the uploading
 *   session is gone); 503 `cloud-disabled` / `no-device` / `firmware-unknown` / `dry-run` (server-wide dry
 *   run); 502 `cloud`.
 * The deletes are awaited one by one; the doc is re-read AFTER them and only the handles that came back deleted
 * or gone are dropped from it, so an upload or a decision that landed meanwhile is kept (`withdrawn` is
 * recorded only when nothing is left). From that read to the write there is no await.
 */
export async function withdrawContribution(
  store: Store,
  registry: DeviceRegistry,
  cloud: ContributionCloud | null,
  opts: { now?: () => number; serverDryRun?: boolean } = {}
): Promise<ContributionResult> {
  const k = await currentKey(registry);
  if (!('key' in k)) return k;
  const handles = handlesOf(readDoc(store, k.key));
  if (!handles.length) return fail(404, { error: 'nothing-to-withdraw' });
  if (!cloudOn(cloud)) return fail(503, { error: 'cloud-disabled' });
  // a server-wide dry run never writes to the cloud: not even a delete
  if (opts.serverDryRun) return fail(503, { error: 'dry-run', message: 'server-wide dry run: nothing is deleted in the cloud' });

  const items: WithdrawItem[] = [];
  let firstFailure: EditorCacheCloudOutcome | null = null;
  for (const h of handles) {
    const item: WithdrawItem = { uploadId: h.uploadId, via: h.via ?? null, result: 'deleted' };
    items.push(item);
    // is the session of that kind still the one that uploaded?
    const checkable = !!(h.via && h.uploaderKey && cloud.editorCacheUploader);
    if (checkable) {
      let current: string | null = null;
      try { current = await cloud.editorCacheUploader!(h.via!); } catch { current = null; }
      if (current === null) { item.result = 'not-signed-in'; item.reason = h.via === 'anonymous' ? 'anonymous-session-missing' : 'account-signed-out'; continue; }
      if ((await uploaderKeyOf(current)) !== h.uploaderKey) { item.result = 'session-mismatch'; continue; }
    }
    let r: EditorCacheCloudOutcome;
    try { r = await cloud.editorCacheDelete(h.uploadId, h.via); } catch (e) { r = { code: 0, body: { error: safeMessage(e) } }; }
    const rb = isObj(r.body) ? r.body : {};
    if (!r.disabled && r.code >= 200 && r.code < 300) continue; // the cloud deletes only the caller's own rows
    item.status = r.code;
    if (r.code === 404) { item.result = checkable ? 'gone' : 'unverified'; continue; }
    if (r.code === 401 || (r.code === 403 && rb.error === 'account-required')) {
      item.result = 'not-signed-in';
      if (typeof rb.reason === 'string') item.reason = rb.reason;
    } else {
      item.result = 'failed';
      firstFailure ??= r;
    }
  }

  // ── re-read, merge, write: no await from here to the putDoc ──
  const done = new Set(items.filter((i) => i.result === 'deleted' || i.result === 'gone').map((i) => i.uploadId));
  const fresh = readDoc(store, k.key);
  const left = handlesOf(fresh).filter((h) => !done.has(h.uploadId));
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  if (!left.length) {
    store.putDoc(CONTRIBUTIONS_COLLECTION, k.key, { state: 'withdrawn', at, sha256: fresh?.sha256, fileName: fresh?.fileName, consentVersion: fresh?.consentVersion } satisfies ContributionDoc);
  } else {
    const { via: _legacyVia, uploadedAt: _legacyAt, ...rest } = fresh ?? {};
    // the decision's "last upload" must not name a row that was just deleted
    const lastId = typeof rest.uploadId === 'string' && done.has(rest.uploadId) ? left[left.length - 1]!.uploadId : rest.uploadId;
    store.putDoc(CONTRIBUTIONS_COLLECTION, k.key, { ...rest, ...(lastId !== undefined ? { uploadId: lastId } : {}), uploads: left } satisfies ContributionDoc);
  }

  const tail = { uploads: items, remaining: left.length };
  const mismatch = items.find((i) => i.result === 'session-mismatch');
  if (mismatch) {
    return fail(409, { error: 'session-mismatch', uploadId: mismatch.uploadId, via: mismatch.via, message: 'the session that made this upload is no longer the current one; it was not deleted', ...tail });
  }
  const unverified = items.find((i) => i.result === 'unverified');
  if (unverified) {
    return fail(409, { error: 'unverified', uploadId: unverified.uploadId, via: unverified.via, message: 'the cloud has no such upload for the current session, and which session made it is not recorded; it stays listed', ...tail });
  }
  const unsigned = items.find((i) => i.result === 'not-signed-in');
  if (unsigned) return fail(401, { error: 'not-signed-in', ...(unsigned.reason ? { reason: unsigned.reason } : {}), uploadId: unsigned.uploadId, via: unsigned.via, ...tail });
  if (firstFailure) {
    const e = cloudError(firstFailure);
    return { code: e.code, body: { ...(e.body as object), ...tail } };
  }
  const deleted = items.find((i) => i.result === 'deleted');
  if (deleted) return { code: 200, body: { ok: true, uploadId: deleted.uploadId, via: deleted.via, deleted: true, ...tail } };
  return fail(404, { error: 'not-found', uploadId: items[0]!.uploadId, via: items[0]!.via, ...tail });
}
