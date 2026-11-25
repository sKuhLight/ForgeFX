// `.axisdefs` — the portable device-definitions file (M3 contract §4.5). `GET /device/definitions/export` writes the
// applied profile's RAW sources (and nothing derived) into a checksummed JSON envelope; `POST /device/definitions/import`
// reads one back, merges its sources into the profile document of its key and re-derives every table from them. A file
// carries the same data as a profile document and no more: no user content (the byte sources omit exactly the tables the
// editor-cache redaction blanks, the codec's `assertNoUserTables` guards export and import), no derived table (those are
// recomputed here, never read from the file), no origin it chooses itself (`foreignSources`: every imported source is
// tagged `origin: 'file'`, so a file can never pose as a local read and widen walk bounds or hints).
//
// The envelope (`AxisDefsFile`):
//   { kind: 'axis-device-definitions', version: 1, model, firmware, key, exportedAt, app: { engine, codec },
//     profile: { meta: { schema, format: 2, sources }, raw: { format: 1, sources } }, sha256 }
//   `sha256` = hex SHA-256 of the UTF-8 bytes of `canonicalJson(profile)`; `meta` is informational (the schema stamp and
//   the source summaries are recomputed on import), `raw` is the truth.
//
// Canonical JSON (what the checksum covers; `canonicalJson`): exactly what `JSON.stringify` would write, with these
// differences only — no whitespace, and the keys of every object in ascending order of their UTF-16 code units (the
// default string order of `Array.prototype.sort`). Strings are escaped as `JSON.stringify` does; a number is written as
// `JSON.stringify` writes it (ECMAScript's shortest round-trip form; -0 is `0`; a non-finite number is `null`); a
// property whose value is `undefined` (or a function) is omitted, an array element that is one is `null`; arrays keep
// their order. So the text is stable across runtimes and across a JSON write/read of the value, which is what lets an
// exporter hash the in-memory document and an importer hash the parsed file and get the same digest.
//
// Import validation, in this order (the first failing step answers):
//   1. shape (400 `invalid-file`): a plain JSON object, no `__proto__`/`constructor`/`prototype` key, kind, version,
//      model/firmware/key (the firmware in its canonical spelling `13.0`, never `13.00`; the key must be the model's and
//      firmware's own), the profile envelope, every raw source and record (services/rawValidation.ts: types, ranges, sizes,
//      records only in declared sections / walked blocks, a bounded record total, canonical source firmware) — `version` or
//      `meta.format` or `raw.format` NEWER than this build reads: 422 `unsupported-format`;
//   2. checksum (422 `checksum-mismatch`) over the `profile` exactly as received;
//   3. user data (422 `contains-user-data`): `assertNoUserTables` over the sources;
//   4. model = the detected unit's (409 `model-mismatch`);
//   5. firmware = the running firmware (409 `firmware-differs`; `?force=1`, or a unit whose firmware is unknown, stores
//      the sources under the FILE's key without applying them);
//   6. merge + re-derive (profileMerge.ts; 409 `newer-profile` / `local-profile-better` unless `replace`, 422
//      `derivation-failed`): the stored doc keeps its other sources, the file's replace its own (kind, origin `file`) slot.
// What never travels in a file (`portableSource`, applied on export before the checksum and again on import): an editor-cache
// source's `contentSha256` (the hash of the user's redacted cache file is a stable per-unit fingerprint and equals the
// contribution upload's) and, in its tolerant-walk `issues`, the byte offsets into that file (`offset`, `skippedBytes` are
// required numbers in the codec's type and are written as 0, `resumedAt` as null; the issue's section, record, reason and
// dropped-record count stay, so the tolerance is still visible). A foreign hash is never stored either.
// `force` and `replace` are QUERY flags (`?force=1`, `?replace=1`): the body is the file, and what a file says about itself
// never decides whether it overrides the firmware check or replaces local data, so a flag inside the file is not read.
// A body over 8 MiB never reaches the handler (413 `too-large`, the route's body limit). The route gates (503 `no-device`,
// 501 `unsupported` for a device that is not a gen-3 grid unit) run before any of this.
//
// Browser-safe: store/registry as types, codec cache subpath, `globalThis.crypto.subtle`. No node:/fastify imports — this
// module is in the runtime router's import graph (check-browser-safe.ts enforces it).
import {
  PROFILE_FORMAT, ProfileDerivationError, ProfileUserDataError, RAW_FORMAT, assertNoUserTables, sourceSummary,
  type ProfileDoc, type ProfileRaw, type RawSource, type SourceSummary
} from 'forgefx-midi/cache';
import { deviceCacheKey, type DeviceRegistry } from '../drivers/registryCore.js';
import { profileForModel } from '../devices.js';
import { firmwareOfCacheKey, modelOfCacheKey } from '../profileCatalog.js';
import { loadStoredProfile, persistProfile, readableRaw, staleFields } from '../profileSchema.js';
import { resolveCacheKey } from './deviceCache.js';
import { ProfileMergeRefused, foreignSources, mergeSourcesIntoStored, refusalBody } from './profileMerge.js';
import { checkProfileRaw, findUnsafeValue, isCanonicalFirmware } from './rawValidation.js';
import type { Store } from '../runtime/store.js';

export const AXISDEFS_KIND = 'axis-device-definitions';
export const AXISDEFS_VERSION = 1;
export const AXISDEFS_EXTENSION = '.axisdefs';
/** Largest request body the import accepts (413 `too-large` above it). */
export const AXISDEFS_MAX_BYTES = 8 * 1024 * 1024;

export interface AxisDefsFile {
  kind: typeof AXISDEFS_KIND;
  version: 1;
  model: number;
  firmware: string;
  key: string;
  exportedAt: string;
  app: { engine: string; codec: string };
  profile: { meta: { schema: number; format: 2; sources: SourceSummary[] }; raw: ProfileRaw };
  sha256: string;
}

/** What the routes return: an HTTP status and the JSON body; `filename` (a 200 export only) is the suggested file
 *  name the route sends as `Content-Disposition` (`attachmentHeader`). */
export interface DefinitionsFileResult { code: number; body: unknown; filename?: string }

type Json = Record<string, unknown>;
const isPlain = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// ── canonical JSON + checksum ──

/** The canonical JSON text of `value` (see the module comment). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'number': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean': return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        const items = new Array<string>(value.length);
        for (let i = 0; i < value.length; i++) {
          const v: unknown = value[i];
          items[i] = v === undefined || typeof v === 'function' || typeof v === 'symbol' ? 'null' : canonicalJson(v);
        }
        return `[${items.join(',')}]`;
      }
      const o = value as Json;
      const parts: string[] = [];
      for (const k of Object.keys(o).sort()) {
        const v = o[k];
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default: return 'null';
  }
}

/** Hex SHA-256 of `text` (UTF-8), or null where the runtime has no `crypto.subtle` (an insecure browser context). */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** The checksum of a file's `profile` (hex SHA-256 over its canonical JSON), or null without `crypto.subtle`. */
export async function profileChecksum(profile: unknown): Promise<string | null> {
  return sha256Hex(canonicalJson(profile));
}

// ── transport helpers shared by both route twins ──

/** `fm3-13.0.axisdefs`: the suggested file name of an export (the model's short key, the firmware). */
export function axisdefsFilename(model: number, firmware: string): string {
  return `${profileForModel(model).key}-${firmware}${AXISDEFS_EXTENSION}`;
}

/** The `Content-Disposition` header value of an export. */
export function attachmentHeader(filename: string): string {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}

/** The 413 body of an import request over the size limit (`bytes` when the size is known). */
export function tooLargeBody(bytes: number | null): { error: 'too-large'; bytes?: number; limit: number } {
  return { error: 'too-large', ...(bytes !== null && Number.isFinite(bytes) ? { bytes } : {}), limit: AXISDEFS_MAX_BYTES };
}

/** `?force=1` / `?replace=1` (also `true`): the flag the person set on the request. A repeated key counts by its FIRST value
 *  (Fastify hands a repeated key over as an array, URLSearchParams.getAll does too), the same on both surfaces. */
export const flagOn = (v: unknown): boolean => {
  const first = Array.isArray(v) ? v[0] : v;
  return first === '1' || first === 'true';
};

/** A source as it travels in a file (see the module comment): no content hash, no byte offsets of the issues. */
export function portableSource(s: RawSource): RawSource {
  if (s.kind !== 'editor-cache') return s;
  return {
    ...s,
    contentSha256: null,
    ...(s.issues ? { issues: s.issues.map((i) => ({ ...i, offset: 0, skippedBytes: 0, resumedAt: null })) } : {})
  };
}

/** The 422 message of a derivation that failed: generic on purpose (the detail is logged, never echoed to the requester). */
export const DERIVATION_FAILED_MESSAGE = 'the sources could not be turned into a device profile; they may not describe this model and firmware';

const NO_SHA256: { code: number; body: Json } = { code: 501, body: { error: 'unsupported', capability: 'sha256' } };

// ── export ──

/**
 * GET /device/definitions/export — the stored profile of the current key as a `.axisdefs` file (the body; `filename` is
 * the suggested name). Reads the store only (a stored doc whose derived tables are older is read as re-derived, nothing is
 * written back), no device traffic beyond the lazy detection the other cache routes also do.
 *   503 `no-device`: no unit identified; 501 `unsupported` (`portable`): not a gen-3 grid unit; 404 `no-profile`: nothing
 *   stored for the key; 409 `profile-legacy`: a format-1 doc (derived tables only, nothing raw to export; also a legacy
 *   doc of an old schema), 409 `profile-stale`: a format-2 doc this build cannot use (+ the stale fields), 409
 *   `profile-unreadable`: raw sources of a newer format, or ones this build's own validator would refuse on import (the file
 *   written is the validator's sanitized copy, never something the import would reject); 500 `contains-user-data`: the
 *   privacy guard tripped (a bug). `app.engine` is the host's ForgeFX version, `app.codec` the codec that derived the doc.
 */
export async function exportDefinitions(
  store: Store, registry: DeviceRegistry, opts: { versions?: { forgefx?: string }; now?: () => string } = {}
): Promise<DefinitionsFileResult> {
  await registry.driver(); // ensure detection ran so model and firmware are populated
  const ctx = registry.definitionsDiffContext();
  if (!ctx) return { code: 503, body: { error: 'no-device' } };
  if (!ctx.caps.portable) return { code: 501, body: { error: 'unsupported', capability: 'portable' } };
  const key = resolveCacheKey(store, registry);
  const stored = key ? loadStoredProfile(store, key) : null;
  const model = key ? modelOfCacheKey(key) : null;
  const firmware = key ? firmwareOfCacheKey(key) : null;
  if (!key || !stored || stored.state === 'absent' || model === null || firmware === null) {
    return { code: 404, body: { error: 'no-profile', message: 'no device-definition profile is stored for this firmware; read the definitions from the device or import the editor cache first' } };
  }
  const legacy = {
    code: 409, body: { error: 'profile-legacy', message: 'the stored profile holds derived tables only (no raw definition sources), so there is nothing to export; read the definitions from the device again or re-import the editor cache, then export' }
  };
  if (stored.format !== 2) return legacy;
  if (stored.state === 'stale') {
    return { code: 409, body: { error: 'profile-stale', ...staleFields(stored.check), message: 'the stored profile cannot be used by this build (see staleReason); read the definitions again, then export' } };
  }
  const doc = stored.profile as unknown as ProfileDoc;
  const raw = readableRaw(doc);
  if (!raw) {
    return { code: 409, body: { error: 'profile-unreadable', message: 'the stored profile has raw sources of a newer format than this build reads; update, then export' } };
  }
  // the sanitized copy the import's own validator makes of the stored sources: a file this build would refuse is never written
  const checked = checkProfileRaw({ format: raw.format, sources: raw.sources }, 'raw');
  if (!checked.ok) {
    console.warn(`[forgefx] .axisdefs export: the stored raw sources do not pass the validation at ${checked.path}: ${checked.message}`);
    return { code: 409, body: { error: 'profile-unreadable', message: `the stored raw sources do not pass this build's own validation (${checked.path}: ${checked.message}); read the definitions again, then export` } };
  }
  const sources = checked.raw.sources.map(portableSource);
  try {
    assertNoUserTables({ raw: { format: raw.format, sources } }); // the file holds the raw sources only: that is what must be free of user tables
  } catch (e) {
    if (e instanceof ProfileUserDataError) return { code: 500, body: { error: 'contains-user-data', message: e.message } };
    throw e;
  }
  const profile: AxisDefsFile['profile'] = {
    meta: { schema: doc.meta.schema as number, format: 2, sources: sources.map((s) => sourceSummary(s)) },
    raw: { format: checked.raw.format, sources }
  };
  const sha256 = await profileChecksum(profile);
  if (sha256 === null) return NO_SHA256;
  const file: AxisDefsFile = {
    kind: AXISDEFS_KIND, version: AXISDEFS_VERSION, model, firmware, key,
    exportedAt: (opts.now ?? (() => new Date().toISOString()))(),
    app: { engine: opts.versions?.forgefx ?? 'unknown', codec: doc.meta.derivedWith ?? 'unknown' },
    profile, sha256
  };
  return { code: 200, body: file, filename: axisdefsFilename(model, firmware) };
}

// ── import ──

/** The outcome of `parseAxisDefs`: the file's identity and its sources (origin `file`), or the refusal. */
export type AxisDefsParse =
  | { ok: true; file: Pick<AxisDefsFile, 'model' | 'firmware' | 'key' | 'exportedAt' | 'app' | 'sha256'>; sources: RawSource[] }
  | { ok: false; code: number; body: Json };

const invalid = (message: string): AxisDefsParse => ({ ok: false, code: 400, body: { error: 'invalid-file', message } });
const unsupportedFormat = (what: string, got: number, supported: number): AxisDefsParse => ({
  ok: false, code: 422,
  body: { error: 'unsupported-format', what, got, supported, message: `this file's ${what} ${got} is newer than the ${supported} this build reads; update, then import it` }
});

/** Major and minor of a canonical firmware string (`isCanonicalFirmware`). */
const firmwareParts = (fw: string): [number, number] => {
  const [major, minor] = fw.split('.');
  return [Number(major), Number(minor)];
};
const SHA256_RE = /^[0-9a-f]{64}$/;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Validation steps 1-3 of the import (see the module comment), pure apart from the digest: the file's identity and its
 * sources — sanitized copies, tagged `origin: 'file'` — or the refusal (`code`, `body`). Reads nothing but `value`.
 */
export async function parseAxisDefs(value: unknown): Promise<AxisDefsParse> {
  // 1. shape
  if (!isPlain(value)) return invalid('the body is not a .axisdefs file (a JSON object is expected)');
  const unsafe = findUnsafeValue(value, 'file');
  if (unsafe) return invalid(`${unsafe.path}: ${unsafe.message}`);
  if (value.kind !== AXISDEFS_KIND) return invalid(`kind: expected "${AXISDEFS_KIND}"`);
  const version = value.version;
  if (!isInt(version, 1, Number.MAX_SAFE_INTEGER)) return invalid('version: expected a positive integer');
  if (version > AXISDEFS_VERSION) return unsupportedFormat('version', version, AXISDEFS_VERSION);
  const { model, firmware, key, exportedAt, app, sha256, profile } = value;
  if (!isInt(model, 0, 255)) return invalid('model: expected an integer 0..255');
  if (!isCanonicalFirmware(firmware)) return invalid('firmware: expected "<major>.<minor>" without leading zeros (13.0, not 13.00)');
  const [fwMajor, fwMinor] = firmwareParts(firmware);
  if (key !== deviceCacheKey(model, fwMajor, fwMinor)) return invalid('key: does not name this file\'s model and firmware');
  if (typeof exportedAt !== 'string' || exportedAt.length > 64) return invalid('exportedAt: expected a string of at most 64 characters');
  if (!isPlain(app) || typeof app.engine !== 'string' || app.engine.length > 64 || typeof app.codec !== 'string' || app.codec.length > 64) {
    return invalid('app: expected { engine, codec } strings of at most 64 characters');
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return invalid('sha256: expected 64 lowercase hex characters');
  if (!isPlain(profile)) return invalid('profile: expected an object');
  const meta = profile.meta;
  if (!isPlain(meta)) return invalid('profile.meta: expected an object');
  if (!isInt(meta.format, 0, Number.MAX_SAFE_INTEGER)) return invalid('profile.meta.format: expected an integer');
  if (meta.format > PROFILE_FORMAT) return unsupportedFormat('profile format', meta.format, PROFILE_FORMAT);
  if (meta.format !== PROFILE_FORMAT) return invalid(`profile.meta.format: expected ${PROFILE_FORMAT}`);
  if (!isInt(meta.schema, 0, Number.MAX_SAFE_INTEGER)) return invalid('profile.meta.schema: expected an integer');
  if (!Array.isArray(meta.sources) || meta.sources.length > 64) return invalid('profile.meta.sources: expected an array');
  const rawEnvelope = profile.raw;
  if (!isPlain(rawEnvelope)) return invalid('profile.raw: expected an object');
  if (!isInt(rawEnvelope.format, 1, Number.MAX_SAFE_INTEGER)) return invalid('profile.raw.format: expected a positive integer');
  if (rawEnvelope.format > RAW_FORMAT) return unsupportedFormat('raw format', rawEnvelope.format, RAW_FORMAT);
  const checked = checkProfileRaw(rawEnvelope, 'profile.raw', { scanned: true });
  if (!checked.ok) return invalid(`${checked.path}: ${checked.message}`);
  if (checked.raw.sources.length === 0) return invalid('profile.raw.sources: at least one source is required');
  for (const [i, s] of checked.raw.sources.entries()) {
    if (s.firmware !== null && s.firmware !== firmware) return invalid(`profile.raw.sources[${i}].firmware: ${s.firmware} is not the file's firmware ${firmware}`);
  }
  // 2. checksum, over the profile exactly as it was received
  const computed = await profileChecksum(profile);
  if (computed === null) return { ok: false, ...NO_SHA256 };
  if (computed !== sha256) {
    return { ok: false, code: 422, body: { error: 'checksum-mismatch', declared: sha256, computed, message: 'the file was changed or damaged after it was exported' } };
  }
  // 3. user data (a source's origin is not the file's to choose: every source becomes a file source)
  const sources = foreignSources(checked.raw.sources.map(portableSource), 'file');
  try {
    assertNoUserTables({ raw: { format: RAW_FORMAT, sources } });
  } catch (e) {
    if (e instanceof ProfileUserDataError) return { ok: false, code: 422, body: { error: 'contains-user-data', message: e.message } };
    throw e;
  }
  return { ok: true, file: { model, firmware, key, exportedAt, app: { engine: app.engine, codec: app.codec }, sha256 }, sources };
}

/** A failure of the merge / derivation / persist of an import, as its HTTP answer. */
function mergeFailure(e: unknown): DefinitionsFileResult {
  if (e instanceof ProfileMergeRefused) return { code: 409, body: refusalBody(e.refusal) };
  if (e instanceof ProfileUserDataError) return { code: 422, body: { error: 'contains-user-data', message: e.message } };
  if (e instanceof ProfileDerivationError && e.code === 'firmware-mismatch') return { code: 409, body: { error: 'firmware-differs', message: e.message } };
  console.warn(`[forgefx] .axisdefs import: derivation failed: ${(e as Error)?.message ?? String(e)}`);
  return { code: 422, body: { error: 'derivation-failed', message: DERIVATION_FAILED_MESSAGE } };
}

/**
 * POST /device/definitions/import — adopt a `.axisdefs` file (`body`, the parsed JSON). Gates: 503 `no-device`, 501
 * `unsupported` (`portable`); then the validation order of the module comment. `opts.force`: a file of another firmware
 * than the running one is stored under its own key instead of refused (409 `firmware-differs`), and is not applied;
 * `opts.replace`: the document of the key is replaced by the file's sources instead of merged (a doc a newer build wrote
 * and a legacy doc that outranks the file are then not refused either). The flags are the person's, set on the request:
 * nothing inside the file can choose them. Persists with the privacy guard, applies the profile when it is the running
 * firmware's (`applied`), and emits SSE `definitions` (`imported`).
 *   200 `{ ok, imported: true, key, applied, sources, coverage }` — `sources` and `coverage` of the stored document.
 */
export async function importDefinitions(
  store: Store, registry: DeviceRegistry, body: unknown, opts: { force?: boolean; replace?: boolean; now?: () => string } = {}
): Promise<DefinitionsFileResult> {
  await registry.driver(); // ensure detection ran (model, firmware, capabilities)
  const ctx = registry.definitionsDiffContext();
  if (!ctx) return { code: 503, body: { error: 'no-device' } };
  if (!ctx.caps.portable) return { code: 501, body: { error: 'unsupported', capability: 'portable' } };

  const parsed = await parseAxisDefs(body);
  if (!parsed.ok) return { code: parsed.code, body: parsed.body };
  const { file, sources } = parsed;

  // 4. model
  if (file.model !== ctx.model) return { code: 409, body: { error: 'model-mismatch', expected: ctx.model, got: file.model } };
  // 5. firmware (an unknown running firmware has nothing to differ from: the file is stored under its own key, not applied)
  const fw = registry.firmwareInfo();
  const [fileMajor, fileMinor] = firmwareParts(file.firmware);
  const differs = fw !== null && (fw.major !== fileMajor || fw.minor !== fileMinor);
  if (differs && !opts.force) {
    return { code: 409, body: { error: 'firmware-differs', expected: fw.version, got: file.firmware, overridable: true } };
  }
  const runningKey = fw ? deviceCacheKey(ctx.model, fw.major, fw.minor) : null;
  const key = file.key;
  // the merge compares source firmware as text: hand it the key's own (canonical) spelling, whatever the envelope said
  const firmware = firmwareOfCacheKey(key) ?? file.firmware;

  // 6. merge + re-derive, persist
  const now = (opts.now ?? (() => new Date().toISOString()))();
  let doc: ProfileDoc;
  let derivationFailed: string | undefined;
  try {
    const merged = mergeSourcesIntoStored(store, {
      key, model: ctx.model, firmware, incoming: sources, replace: opts.replace,
      extras: { importedAt: now }, now
    });
    doc = merged.doc;
    derivationFailed = merged.derivationFailed;
  } catch (e) {
    return mergeFailure(e); // refused merge, a firmware or user-data problem, a derivation failure
  }
  try {
    persistProfile(store, key, doc);
  } catch (e) {
    if (e instanceof ProfileUserDataError) return mergeFailure(e);
    throw e; // a store failure is not a problem of the file: it propagates
  }
  const applied = runningKey === key && derivationFailed === undefined;
  if (runningKey === key) await registry.applyRuntimeCache(); // adopt the stored doc now (a stale one falls back to the bundled profile)
  if (derivationFailed !== undefined) {
    // the stored doc was stale (its sources did not derive) and still does not derive with the file added: the file's
    // sources are kept next to the others (nothing lost), the doc stays stale. The store changed: other windows refresh.
    console.warn(`[forgefx] .axisdefs import: stored next to a stale profile that still does not derive (${key}): ${derivationFailed}`);
    registry.emitEvent({ type: 'definitions', reason: 'imported', key });
    return { code: 422, body: { error: 'derivation-failed', message: DERIVATION_FAILED_MESSAGE, stored: true, key } };
  }
  registry.emitEvent({ type: 'definitions', reason: 'imported', key });
  return { code: 200, body: { ok: true, imported: true, key, applied, sources: doc.meta.sources, coverage: doc.coverage } };
}
