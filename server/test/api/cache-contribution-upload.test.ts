// Editor-cache contribution, the CLOUD half (WP-F2): status from the cloud's "wanted" answer, the upload of the
// redacted bytes, the error mapping, deduplication, the decision it persists, the coupled import, the dry-run
// switches, withdraw, the Remote relay, the generic signed-upload flow, and the Cloud client's sessions (the
// anonymous upload session in its own slot, never the account's). NO network: the contribution routes get a
// structural fake cloud; the Cloud class runs against a faked `fetch` that plays the Supabase endpoints.
// Synthetic caches only (test/helpers/cacheBytes.ts).
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type AppOptions } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import * as store from '../../src/store.js';
import { loadUsableProfile, CURRENT_CACHE_SCHEMA } from '../../src/profileSchema.js';
import { RemoteHost } from '../../src/remote.js';
import {
  CONTRIBUTIONS_COLLECTION, contribute, parseContributionFlags,
  type ContributionCloud, type ContributionStatus
} from '../../src/services/cacheContribution.js';
import {
  ANONYMOUS_UPLOADER_STORAGE_KEY, createCloud, runSignedUpload,
  type EditorCacheCloudOutcome, type EditorCacheReserveBody, type SignedUploadTransport, type UploaderSession
} from '../../src/runtime/cloud.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import type { Store } from '../../src/runtime/store.js';
import { contributionCache, SYNTHETIC_PRESET_NAMES, SYNTHETIC_USER_CAB_NAMES } from '../helpers/cacheBytes.js';
import { fakeChannelSession } from './remote.test.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

const FM3 = 0x11;
const KEY = '11_13p0';
const FILE13 = 'effectDefinitions_11_13p0.cache';
const UUID = '5b0e1c2a-1111-4222-8333-944455556666';
const UUID2 = '7c1f2d3b-2222-4333-8444-a55566667777';
const CACHE13 = contributionCache({ major: 13, minor: 0 });
const CACHE12 = contributionCache({ major: 12, minor: 0 });
const NAMES = [...SYNTHETIC_PRESET_NAMES, ...SYNTHETIC_USER_CAB_NAMES].filter((n) => n.length > 0);
const present = (d: { deleted?: boolean } | null | undefined) => !!d && !d.deleted;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1') + Buffer.from(b).toString('utf8');

function assertNoNames(text: string, label: string): void {
  for (const n of NAMES) assert(!text.includes(n) && !text.includes(n.slice(0, 6)), `${label}: an original name leaked`);
}

// ── a structural fake cloud ──

interface FakeScript {
  enabled: boolean;
  signedIn: boolean;
  wanted: boolean | null;
  upload: (bytes: Uint8Array, body: EditorCacheReserveBody) => EditorCacheCloudOutcome;
  del: (uploadId: string, via?: UploaderSession) => EditorCacheCloudOutcome | Promise<EditorCacheCloudOutcome>;
  /** The user id of the stored session per kind (what editorCacheUploader reports). */
  sessions: { account: string | null; anonymous: string | null };
}
function fakeCloud(over: Partial<FakeScript> = {}) {
  const script: FakeScript = {
    enabled: true, signedIn: false, wanted: true,
    upload: () => ({ code: 200, body: { uploadId: UUID, status: 'complete', covered: false }, via: 'anonymous', uploaderId: 'anon-user-1' }),
    del: (uploadId) => ({ code: 200, body: { uploadId, deleted: true } }),
    sessions: { account: 'acct-user-1', anonymous: 'anon-user-1' },
    ...over
  };
  const calls = { wanted: 0, uploads: [] as { bytes: Uint8Array; body: EditorCacheReserveBody }[], deletes: [] as { uploadId: string; via?: UploaderSession }[] };
  const cloud: ContributionCloud = {
    isEnabled: () => script.enabled,
    hasAccountSession: () => script.signedIn,
    editorCacheWanted: async () => { calls.wanted++; return script.wanted; },
    editorCacheUpload: async (bytes, body) => { calls.uploads.push({ bytes: bytes.slice(), body }); return script.upload(bytes, body); },
    editorCacheDelete: async (uploadId, via) => { calls.deletes.push({ uploadId, via }); return script.del(uploadId, via); },
    editorCacheUploader: (via) => script.sessions[via]
  };
  return { cloud, calls, script };
}

function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

interface Rig { app: Awaited<ReturnType<typeof buildApp>>; registry: DeviceRegistry }
async function rig(contribute: AppOptions['contribute']): Promise<Rig> {
  const mock = new MockTransport('serial', 'mock-0x11');
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(FM3)];
    if (req[5] === 0x08) return [firmwareReply(FM3, 13, 0)];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  // discovery points at a directory that does not exist: the user's real editor dirs are never scanned
  const app = await buildApp(registry, {
    editorCaches: { discover: { platform: 'darwin', home: join(tmpdir(), `forgefx-no-editors-${process.pid}`), env: {} } },
    contribute: { dryRun: false, dryRunDir: null, ...contribute }
  });
  return { app, registry };
}

function clean(): void {
  for (const k of [KEY, '11_12p0']) {
    store.defaultStore.delDoc(CONTRIBUTIONS_COLLECTION, k);
    store.defaultStore.delDoc('deviceCaches', k);
  }
}
const decisionDoc = (): Record<string, unknown> | null => {
  const d = store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY);
  return d && !d.deleted ? (d.data as Record<string, unknown>) : null;
};

type App = Rig['app'];
const send = (app: App, q: Record<string, string> = {}, bytes = CACHE13.bytes, name = FILE13) =>
  app.inject({
    method: 'POST',
    url: `/device/cache/contribute?${new URLSearchParams({ name, consent: '1', consentVersion: '2', ...q }).toString()}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(bytes)
  });
const statusOf = async (app: App, refresh = false): Promise<ContributionStatus> => {
  const res = await app.inject({ method: 'GET', url: `/device/cache/contribute${refresh ? '?refresh=1' : ''}` });
  assertEqual(res.statusCode, 200, 'status 200');
  return res.json() as ContributionStatus;
};
const post = (app: App, url: string, body: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

// ── 1. status from the cloud's wanted answer ──
async function statusWanted(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  try {
    let s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}`, 'true/null', '[wanted] wanted → offer');
    assertEqual(`${s.cloud.enabled} ${s.cloud.signedIn} ${s.cloud.wanted}`, 'true false true', '[wanted] signed out still offers (anonymous upload)');
    assert(typeof s.cloud.checkedAt === 'string', '[wanted] checkedAt');
    await statusOf(r.app);
    assertEqual(f.calls.wanted, 1, '[wanted] the answer is cached');
    f.script.wanted = false;
    s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}`, 'true/null', '[wanted] still the cached answer');
    s = await statusOf(r.app, true);
    assertEqual(f.calls.wanted, 2, '[wanted] ?refresh=1 asks again');
    assertEqual(`${s.offer}/${s.reason}/${s.cloud.wanted}`, 'false/not-wanted/false', '[wanted] not wanted');
    f.script.wanted = null;
    s = await statusOf(r.app, true);
    assertEqual(`${s.offer}/${s.reason}/${s.cloud.wanted}`, 'false/cloud-unreachable/null', '[wanted] unreachable');
    f.script.signedIn = true;
    f.script.wanted = true;
    s = await statusOf(r.app, true);
    assertEqual(`${s.offer} ${s.cloud.signedIn}`, 'true true', '[wanted] signed in');
    f.script.enabled = false;
    const before = f.calls.wanted;
    s = await statusOf(r.app, true);
    assertEqual(`${s.offer}/${s.reason}/${s.cloud.enabled}`, 'false/cloud-disabled/false', '[wanted] cloud switched off');
    assertEqual(f.calls.wanted, before, '[wanted] no read while off');
  } finally { await r.app.close(); }
}

// ── 2. upload: the redacted bytes, the reserve body, the decision ──
async function uploadSuccess(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  try {
    const dry = (await send(r.app, { dryRun: '1' })).json() as { wouldSend: Record<string, unknown>; file: { sha256: string } };
    assertEqual(f.calls.uploads.length, 0, '[upload] the preview uploads nothing');
    const res = await send(r.app, { axisVersion: '0.11.0-beta' });
    assertEqual(res.statusCode, 200, `[upload] 200 (${res.payload.slice(0, 200)})`);
    assertNoNames(res.payload, '[upload] response');
    const b = res.json() as { ok: boolean; dryRun: boolean; file: { sha256: string; bytes: number }; upload: unknown; import: unknown };
    assertEqual(b.dryRun, false, '[upload] not a dry run');
    assertEqual(JSON.stringify(b.upload), JSON.stringify({ status: 'complete', uploadId: UUID, deduped: false, covered: false, via: 'anonymous' }), '[upload] upload result (with the session kind)');
    assertEqual(JSON.stringify(b.import), JSON.stringify({ skipped: 'not-requested' }), '[upload] import not requested');
    assertEqual(f.calls.uploads.length, 1, '[upload] one upload');
    const up = f.calls.uploads[0]!;
    assertEqual(sha256(up.bytes), b.file.sha256, '[upload] the uploaded bytes are the previewed (redacted) ones');
    assertEqual(sha256(up.bytes), dry.file.sha256, '[upload] same sha256 as the dry run');
    assert(sha256(up.bytes) !== sha256(CACHE13.bytes), '[upload] never the original bytes');
    assertEqual(up.bytes.length, CACHE13.bytes.length, '[upload] same size');
    assertNoNames(latin(up.bytes), '[upload] uploaded bytes');
    const { consentAt: _a, ...sent } = up.body as unknown as Record<string, unknown>;
    const { consentAt: _b, ...previewed } = dry.wouldSend;
    assertEqual(JSON.stringify({ ...sent, app: null }), JSON.stringify({ ...previewed, app: null }), '[upload] reserve body = the dry run\'s wouldSend');
    assertEqual(JSON.stringify(up.body.redaction), JSON.stringify({ version: 1, tables: 2, names: CACHE13.presetNames + CACHE13.userCabNames }), '[upload] redaction = { version, tables, names }');
    assertEqual(up.body.consentVersion, 2, '[upload] consent version 2');
    assertEqual(up.body.fileName, FILE13, '[upload] the editor\'s file name');
    assertEqual(`${up.body.fileVersion} ${up.body.contentVersion} ${up.body.deviceFirmware}`, '13.0 13.0 13.0', '[upload] versions');
    assertEqual(up.body.app.axis, '0.11.0-beta', '[upload] axis version stamp');
    assert(Math.abs(Date.parse(up.body.consentAt) - Date.now()) < 60_000, '[upload] consentAt is now');
    const doc = decisionDoc()! as Record<string, unknown> & { uploads: Array<Record<string, unknown>> };
    assertEqual(`${doc.state} ${doc.uploadId} ${doc.sha256} ${doc.fileName} ${doc.consentVersion}`, `uploaded ${UUID} ${b.file.sha256} ${FILE13} 2`, '[upload] decision persisted');
    assertEqual(doc.uploads.length, 1, '[upload] one withdrawable upload');
    const h = doc.uploads[0]!;
    assertEqual(`${h.uploadId} ${h.via}`, `${UUID} anonymous`, '[upload] the handle: id + session kind');
    assert(typeof h.uploaderKey === 'string' && (h.uploaderKey as string).length === 32, '[upload] the uploader is recorded as a key');
    assert(!JSON.stringify(doc).includes('anon-user-1'), '[upload] never the uploader id itself');
    assertNoNames(JSON.stringify(doc), '[upload] decision doc');
    const s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}/${s.withdrawable}/${s.decision?.uploadId}`, `false/uploaded/true/${UUID}`, '[upload] status after the upload');
    assertEqual(JSON.stringify(s.uploads.map((u) => [u.uploadId, u.via])), JSON.stringify([[UUID, 'anonymous']]), '[upload] status lists the upload and its session kind');
  } finally { clean(); await r.app.close(); }
}

// ── 3. deduplication ──
async function deduped(): Promise<void> {
  clean();
  const f = fakeCloud({ upload: () => ({ code: 200, body: { uploadId: UUID, status: 'complete', deduped: true }, via: 'account', uploaderId: 'acct-user-1' }) });
  const r = await rig({ cloud: f.cloud });
  const handles = () => ((decisionDoc() as { uploads?: Array<{ uploadId: string; via: string }> } | null)?.uploads ?? []).map((h) => `${h.uploadId}:${h.via}`);
  try {
    let res = await send(r.app);
    assertEqual(JSON.stringify((res.json() as { upload: unknown }).upload), JSON.stringify({ status: 'complete', uploadId: UUID, deduped: true, covered: false, via: 'account' }), '[dedupe] own duplicate');
    res = await send(r.app);
    assertEqual(JSON.stringify(handles()), JSON.stringify([`${UUID}:account`]), '[dedupe] the same upload is listed once');
    // a later duplicate the cloud holds from someone else (no row of ours) must NOT drop the handle to ours
    f.script.upload = () => ({ code: 200, body: { uploadId: null, status: 'complete', deduped: true }, via: 'anonymous', uploaderId: 'anon-user-1' });
    res = await send(r.app);
    assertEqual(res.statusCode, 200, '[dedupe] cross-uploader duplicate → 200');
    assertEqual((res.json() as { upload: { uploadId: unknown } }).upload.uploadId, null, '[dedupe] no upload id');
    assertEqual(decisionDoc()?.uploadId, null, '[dedupe] the last upload left no row of ours');
    assertEqual(JSON.stringify(handles()), JSON.stringify([`${UUID}:account`]), '[dedupe] the earlier upload is still listed');
    let s = await statusOf(r.app);
    assertEqual(`${s.reason} ${s.withdrawable}`, 'uploaded true', '[dedupe] still withdrawable');
    const w = await post(r.app, '/device/cache/contribute/withdraw');
    assertEqual(w.statusCode, 200, '[dedupe] the earlier upload is withdrawn');
    assertEqual(JSON.stringify(f.calls.deletes), JSON.stringify([{ uploadId: UUID, via: 'account' }]), '[dedupe] deleted under the account session');
    // only a cross-uploader duplicate: nothing of ours to delete
    clean();
    res = await send(r.app);
    s = await statusOf(r.app);
    assertEqual(`${s.reason} ${s.withdrawable}`, 'uploaded false', '[dedupe] nothing withdrawable');
    const w2 = await post(r.app, '/device/cache/contribute/withdraw');
    assertEqual(`${w2.statusCode} ${(w2.json() as { error: string }).error}`, '404 nothing-to-withdraw', '[dedupe] nothing to withdraw');
    assertEqual(f.calls.deletes.length, 1, '[dedupe] no further delete sent');
  } finally { clean(); await r.app.close(); }
}

// ── 4. error mapping ──
async function errorMapping(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  const bytes = CACHE13.bytes.length;
  const imp = { skipped: 'not-requested' };
  const cases: Array<{ label: string; out: EditorCacheCloudOutcome; code: number; body: Record<string, unknown> }> = [
    { label: 'no session, anonymous sign-in failed', out: { code: 401, body: { error: 'not signed in', reason: 'anonymous-sign-in-failed' } }, code: 401, body: { error: 'not-signed-in', reason: 'anonymous-sign-in-failed' } },
    { label: 'anonymous refused by the cloud', out: { code: 403, body: { error: 'account-required' } }, code: 401, body: { error: 'not-signed-in', reason: 'account-required' } },
    { label: 'rate limited per network', out: { code: 429, body: { error: 'rate-limited', scope: 'ip', retryAfterSeconds: 120 } }, code: 429, body: { error: 'rate-limited', retryAfterSeconds: 120, scope: 'ip' } },
    { label: 'quota per uploader, Retry-After header', out: { code: 429, body: { error: 'quota-exceeded', scope: 'uploader' }, retryAfter: '30' }, code: 429, body: { error: 'quota-exceeded', retryAfterSeconds: 30, scope: 'uploader' } },
    { label: 'too large in the cloud', out: { code: 413, body: { error: 'too-large', stage: 'stored', limit: 4194304 } }, code: 413, body: { error: 'too-large', bytes, limit: 4194304, stage: 'stored' } },
    { label: 'firmware limit', out: { code: 409, body: { error: 'firmware-limit', limit: 2 } }, code: 409, body: { error: 'firmware-limit', limit: 2 } },
    { label: 'server-side validation refused the file', out: { code: 422, body: { error: 'invalid-cache', reason: 'not-redacted', message: 'a user name table is not blank' } }, code: 422, body: { error: 'invalid-cache', reason: 'not-redacted', message: 'a user name table is not blank' } },
    { label: 'network failure', out: { code: 0, body: { error: 'fetch failed' } }, code: 502, body: { error: 'cloud', status: 0, message: 'fetch failed' } },
    { label: 'hash mismatch (a client bug)', out: { code: 409, body: { error: 'hash-mismatch', message: 'the stored file does not match the announced sha256' } }, code: 502, body: { error: 'cloud', status: 409, message: 'the stored file does not match the announced sha256' } },
    { label: 'cloud switched off meanwhile', out: { code: 503, body: { error: 'cloud-disabled' }, disabled: true }, code: 503, body: { error: 'cloud-disabled' } },
    { label: 'signed in, but the account session cannot be loaded (no silent anonymous upload)', out: { code: 401, body: { error: 'not signed in', reason: 'account-session-unavailable', message: 'offline' }, via: 'account' }, code: 401, body: { error: 'not-signed-in', reason: 'account-session-unavailable', via: 'account' } },
    { label: 'rate limited, with the session kind', out: { code: 429, body: { error: 'rate-limited', scope: 'uploader', retryAfterSeconds: 9 }, via: 'anonymous' }, code: 429, body: { error: 'rate-limited', retryAfterSeconds: 9, scope: 'uploader', via: 'anonymous' } },
    { label: 'a 2xx that did not complete', out: { code: 200, body: { uploadId: UUID, status: 'pending' } }, code: 502, body: { error: 'cloud', status: 200, message: 'the upload did not complete' } }
  ];
  try {
    for (const c of cases) {
      f.script.upload = () => c.out;
      const res = await send(r.app);
      assertEqual(res.statusCode, c.code, `[errors] ${c.label}: status`);
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ ...c.body, import: imp }), `[errors] ${c.label}: body`);
      assertEqual(decisionDoc(), null, `[errors] ${c.label}: no decision persisted`);
    }
    // not wanted / paused: the next status says so without asking the cloud again
    await statusOf(r.app); // primes the wanted cache (wanted: true)
    const asked = f.calls.wanted;
    f.script.upload = () => ({ code: 409, body: { error: 'not-wanted' } });
    let res = await send(r.app);
    assertEqual(`${res.statusCode} ${(res.json() as { error: string }).error}`, '409 not-wanted', '[errors] not wanted');
    let s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}`, 'false/not-wanted', '[errors] status after not-wanted');
    f.script.upload = () => ({ code: 503, body: { error: 'paused', message: 'editor-cache uploads are paused' } });
    res = await send(r.app);
    assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: 'paused', import: imp }), '[errors] paused');
    s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}`, 'false/paused', '[errors] status after paused');
    assertEqual(f.calls.wanted, asked, '[errors] the status did not ask the cloud again');
  } finally { clean(); await r.app.close(); }
}

// ── 5. the coupled import ──
async function importCoupling(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  try {
    // import + upload: both reported
    let res = await send(r.app, { import: '1' });
    assertEqual(res.statusCode, 200, '[import] 200');
    let b = res.json() as { import: unknown; upload: unknown };
    assertEqual(JSON.stringify(b.import), JSON.stringify({ status: 200, imported: true, key: KEY }), '[import] imported');
    assert(present(store.defaultStore.getDoc('deviceCaches', KEY)), '[import] the profile is stored');
    assertEqual((await statusOf(r.app)).localProfile, 'byte-exact', '[import] byte-exact');
    // upload failure keeps the import and reports both
    clean();
    f.script.upload = () => ({ code: 0, body: { error: 'fetch failed' } });
    res = await send(r.app, { import: '1' });
    assertEqual(res.statusCode, 502, '[import] upload failed → 502');
    b = res.json() as { import: unknown; upload: unknown };
    assertEqual(JSON.stringify(b.import), JSON.stringify({ status: 200, imported: true, key: KEY }), '[import] the import stands');
    assert(present(store.defaultStore.getDoc('deviceCaches', KEY)), '[import] the profile stays stored');
    // a profile a NEWER build wrote is never replaced
    clean();
    f.script.upload = () => ({ code: 200, body: { uploadId: UUID, status: 'complete' }, via: 'anonymous' });
    store.defaultStore.putDoc('deviceCaches', KEY, { ranges: {}, meta: { schema: CURRENT_CACHE_SCHEMA + 1, recordCount: 1, source: 'editor-cache' } });
    res = await send(r.app, { import: '1' });
    assertEqual(JSON.stringify((res.json() as { import: unknown }).import), JSON.stringify({ skipped: 'newer-profile' }), '[import] newer profile kept');
    assertEqual(((store.defaultStore.getDoc('deviceCaches', KEY)!.data as { meta: { schema: number } }).meta.schema), CURRENT_CACHE_SCHEMA + 1, '[import] untouched');
    // a mismatched file is never imported
    clean();
    res = await send(r.app, { import: '1', acceptFirmwareMismatch: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache');
    assertEqual(JSON.stringify((res.json() as { import: unknown }).import), JSON.stringify({ skipped: 'firmware-differs' }), '[import] mismatch skipped');
    // an import that fails stops before the upload
    clean();
    const uploadsBefore = f.calls.uploads.length;
    const failing: Store = { ...store.defaultStore, putDoc: (c: string, id: string, data: unknown) => { if (c === 'deviceCaches') throw new Error('disk full'); return store.defaultStore.putDoc(c, id, data); } };
    const flags = parseContributionFlags({ consent: true, consentVersion: 2, import: true });
    assert(flags.ok, '[import] flags');
    const out = await contribute(failing, r.registry, f.cloud, { bytes: CACHE13.bytes, name: FILE13 }, flags.flags);
    assertEqual(out.code, 500, '[import] import failure → 500');
    assertEqual(JSON.stringify(out.body), JSON.stringify({ error: 'import-failed', import: { status: 500, imported: false, error: 'disk full' } }), '[import] import-failed body');
    assertEqual(f.calls.uploads.length, uploadsBefore, '[import] no upload after a failed import');
  } finally { clean(); await r.app.close(); }
}

// ── 6. dry-run switches: zero cloud writes, no decision ──
async function dryRunSwitches(): Promise<void> {
  clean();
  const f = fakeCloud();
  const prev = process.env.FORGEFX_CONTRIBUTE_DRY_RUN;
  process.env.FORGEFX_CONTRIBUTE_DRY_RUN = '1';
  const r = await rig({ cloud: f.cloud, dryRun: undefined }); // read the env
  try {
    const res = await send(r.app, { import: '1' });
    assertEqual(res.statusCode, 200, '[dry-env] 200');
    const b = res.json() as { dryRun: boolean; upload: unknown; wouldSend: unknown; import: unknown };
    assertEqual(`${b.dryRun} ${b.upload}`, 'true null', '[dry-env] a dry run');
    assert(b.wouldSend !== undefined, '[dry-env] wouldSend');
    assertEqual(JSON.stringify(b.import), JSON.stringify({ status: 200, imported: true, key: KEY }), '[dry-env] the local import still runs');
    assertEqual(f.calls.uploads.length, 0, '[dry-env] zero uploads');
    assertEqual(decisionDoc(), null, '[dry-env] no decision persisted');
    // even an earlier upload is not deleted under a server-wide dry run
    store.defaultStore.putDoc(CONTRIBUTIONS_COLLECTION, KEY, { state: 'uploaded', at: new Date().toISOString(), uploadId: UUID, via: 'anonymous' });
    const w = await post(r.app, '/device/cache/contribute/withdraw');
    assertEqual(`${w.statusCode} ${(w.json() as { error: string }).error}`, '503 dry-run', '[dry-env] withdraw refused');
    assertEqual(f.calls.deletes.length, 0, '[dry-env] zero deletes');
    // the public status read is allowed
    assertEqual((await statusOf(r.app)).cloud.wanted, true, '[dry-env] the public wanted read works');
    // decisions still work locally
    const d = await post(r.app, '/device/cache/contribute/decision', { decision: 'asked', days: 2 });
    assertEqual(d.statusCode, 200, '[dry-env] decisions work');
  } finally {
    if (prev === undefined) delete process.env.FORGEFX_CONTRIBUTE_DRY_RUN; else process.env.FORGEFX_CONTRIBUTE_DRY_RUN = prev;
    clean();
    await r.app.close();
  }
}

// ── 7. withdraw ──
type WBody = { ok?: boolean; error?: string; reason?: string; uploadId?: string; via?: string | null; deleted?: boolean; remaining?: number; uploads?: Array<{ uploadId: string; via: string | null; result: string }> };
async function withdraw(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  const w = async () => { const res = await post(r.app, '/device/cache/contribute/withdraw'); return { code: res.statusCode, b: res.json() as WBody }; };
  try {
    assertEqual((await send(r.app)).statusCode, 200, '[withdraw] uploaded');
    // the cloud says the uploading session is gone → 401, nothing changes
    f.script.del = () => ({ code: 401, body: { error: 'not signed in', reason: 'anonymous-session-missing' } });
    let x = await w();
    assertEqual(`${x.code} ${x.b.error} ${x.b.reason} ${x.b.uploadId} ${x.b.via}`, `401 not-signed-in anonymous-session-missing ${UUID} anonymous`, '[withdraw] 401');
    assertEqual(decisionDoc()?.state, 'uploaded', '[withdraw] still uploaded');
    f.script.del = () => ({ code: 0, body: { error: 'fetch failed' } });
    x = await w();
    assertEqual(`${x.code} ${x.b.error}`, '502 cloud', '[withdraw] network → 502');
    assertEqual((await statusOf(r.app)).withdrawable, true, '[withdraw] still withdrawable after a failure');
    // ok
    f.script.del = (uploadId) => ({ code: 200, body: { uploadId, deleted: true } });
    x = await w();
    assertEqual(JSON.stringify(x.b), JSON.stringify({ ok: true, uploadId: UUID, via: 'anonymous', deleted: true, uploads: [{ uploadId: UUID, via: 'anonymous', result: 'deleted' }], remaining: 0 }), '[withdraw] 200');
    assertEqual(JSON.stringify(f.calls.deletes.at(-1)), JSON.stringify({ uploadId: UUID, via: 'anonymous' }), '[withdraw] deleted as the uploading session');
    assertEqual(decisionDoc()?.state, 'withdrawn', '[withdraw] recorded');
    let s = await statusOf(r.app);
    assertEqual(`${s.offer}/${s.reason}/${s.withdrawable}/${s.uploads.length}`, 'false/withdrawn/false/0', '[withdraw] status');
    x = await w();
    assertEqual(`${x.code} ${x.b.error}`, '404 nothing-to-withdraw', '[withdraw] twice → 404 nothing-to-withdraw');
    // already gone in the cloud → 404 not-found, still recorded as withdrawn
    clean();
    assertEqual((await send(r.app)).statusCode, 200, '[withdraw] uploaded again');
    f.script.del = () => ({ code: 404, body: { error: 'not-found' } });
    x = await w();
    assertEqual(`${x.code} ${x.b.error} ${x.b.uploadId}`, `404 not-found ${UUID}`, '[withdraw] cloud 404');
    assertEqual(decisionDoc()?.state, 'withdrawn', '[withdraw] withdrawn anyway');
    // reset (and declined) keep the upload withdrawable — the maintainer's P8/P10 path
    clean();
    f.script.del = (uploadId) => ({ code: 200, body: { uploadId, deleted: true } });
    assertEqual((await send(r.app)).statusCode, 200, '[withdraw] uploaded once more');
    await post(r.app, '/device/cache/contribute/decision', { decision: 'reset' });
    s = await statusOf(r.app);
    assertEqual(`${s.decision} ${s.withdrawable} ${s.offer}`, 'null true true', '[withdraw] reset: no decision, still withdrawable, offered again');
    await post(r.app, '/device/cache/contribute/decision', { decision: 'declined' });
    assertEqual((await statusOf(r.app)).withdrawable, true, '[withdraw] declined keeps it withdrawable');
    x = await w();
    assertEqual(x.code, 200, '[withdraw] withdrawn after reset + declined');
  } finally { clean(); await r.app.close(); }
  // no cloud → 503 cloud-disabled
  const n = await rig({ cloud: null });
  try {
    store.defaultStore.putDoc(CONTRIBUTIONS_COLLECTION, KEY, { state: 'uploaded', at: new Date().toISOString(), uploadId: UUID, uploads: [{ uploadId: UUID, via: 'anonymous', uploadedAt: new Date().toISOString() }] });
    const res = await post(n.app, '/device/cache/contribute/withdraw');
    assertEqual(`${res.statusCode} ${(res.json() as { error: string }).error}`, '503 cloud-disabled', '[withdraw] no cloud');
  } finally { clean(); await n.app.close(); }
}

// ── 7b. every upload stays withdrawable, each under its own session; a changed session is reported ──
async function withdrawHandles(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  const w = async () => { const res = await post(r.app, '/device/cache/contribute/withdraw'); return { code: res.statusCode, b: res.json() as WBody }; };
  try {
    // two uploads for the same firmware: anonymously, then (another file) signed in
    assertEqual((await send(r.app)).statusCode, 200, '[handles] first upload (anonymous)');
    f.script.upload = () => ({ code: 200, body: { uploadId: UUID2, status: 'complete', covered: false }, via: 'account', uploaderId: 'acct-user-1' });
    assertEqual((await send(r.app, { acceptFirmwareMismatch: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache')).statusCode, 200, '[handles] second upload (account)');
    let s = await statusOf(r.app);
    assertEqual(JSON.stringify(s.uploads.map((u) => [u.uploadId, u.via])), JSON.stringify([[UUID, 'anonymous'], [UUID2, 'account']]), '[handles] both listed');

    // the anonymous session was re-minted: 409 session-mismatch, nothing deleted, nothing recorded as withdrawn
    f.script.sessions.anonymous = 'anon-user-2';
    let x = await w();
    assertEqual(`${x.code} ${x.b.error} ${x.b.uploadId} ${x.b.via}`, `409 session-mismatch ${UUID} anonymous`, '[handles] re-minted anonymous session → 409');
    assertEqual(JSON.stringify(f.calls.deletes), JSON.stringify([{ uploadId: UUID2, via: 'account' }]), '[handles] only the account upload was deleted');
    assertEqual(decisionDoc()?.state, 'uploaded', '[handles] not recorded as withdrawn');
    s = await statusOf(r.app);
    assertEqual(JSON.stringify(s.uploads.map((u) => u.uploadId)), JSON.stringify([UUID]), '[handles] the mismatched upload stays listed');
    // the anonymous session is gone entirely: 401, no delete sent
    f.script.sessions.anonymous = null;
    x = await w();
    assertEqual(`${x.code} ${x.b.error} ${x.b.reason}`, '401 not-signed-in anonymous-session-missing', '[handles] lost anonymous session → 401');
    assertEqual(f.calls.deletes.length, 1, '[handles] no delete without the uploading session');
    // the original session is back: withdrawn
    f.script.sessions.anonymous = 'anon-user-1';
    x = await w();
    assertEqual(`${x.code} ${x.b.uploadId} ${x.b.via}`, `200 ${UUID} anonymous`, '[handles] withdrawn once the session matches');
    assertEqual(decisionDoc()?.state, 'withdrawn', '[handles] recorded');

    // another account signed in → 409 session-mismatch
    clean();
    assertEqual((await send(r.app)).statusCode, 200, '[handles] account upload');
    f.script.sessions.account = 'acct-user-2';
    x = await w();
    assertEqual(`${x.code} ${x.b.error} ${x.b.via}`, '409 session-mismatch account', '[handles] another account → 409');
    // partial failure: the deleted one is dropped, the failing one stays
    f.script.sessions.account = 'acct-user-1';
    f.script.upload = () => ({ code: 200, body: { uploadId: UUID, status: 'complete', covered: false }, via: 'anonymous', uploaderId: 'anon-user-1' });
    assertEqual((await send(r.app, { acceptFirmwareMismatch: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache')).statusCode, 200, '[handles] a second upload');
    f.script.del = (uploadId) => (uploadId === UUID2 ? { code: 200, body: { uploadId, deleted: true } } : { code: 500, body: { error: 'internal' } });
    x = await w();
    assertEqual(`${x.code} ${x.b.error}`, '502 cloud', '[handles] partial failure → 502');
    assertEqual(JSON.stringify(x.b.uploads?.map((u) => u.result)), JSON.stringify(['deleted', 'failed']), '[handles] per-upload results');
    s = await statusOf(r.app);
    assertEqual(JSON.stringify(s.uploads.map((u) => u.uploadId)), JSON.stringify([UUID]), '[handles] only the failed one is left');
    assertEqual(x.b.remaining, 1, '[handles] remaining count');
    assertEqual(s.decision?.uploadId, UUID, '[handles] the decision no longer names the deleted row');
    f.script.del = (uploadId) => ({ code: 200, body: { uploadId, deleted: true } });
    x = await w();
    assertEqual(x.code, 200, '[handles] the rest withdrawn');
  } finally { clean(); await r.app.close(); }
}

// ── 7c. races: an upload or a decision landing during a withdraw; two uploads finishing together ──
async function races(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  const w = async () => { const res = await post(r.app, '/device/cache/contribute/withdraw'); return { code: res.statusCode, b: res.json() as WBody }; };
  try {
    // an upload completes while the withdraw waits for the cloud's delete: it must survive the withdraw
    assertEqual((await send(r.app)).statusCode, 200, '[race] first upload');
    f.script.del = async (uploadId) => {
      f.script.upload = () => ({ code: 200, body: { uploadId: UUID2, status: 'complete', covered: false }, via: 'account', uploaderId: 'acct-user-1' });
      const up = await send(r.app); // interleaves: completes before the delete answers
      assertEqual(up.statusCode, 200, '[race] the interleaved upload succeeded');
      return { code: 200, body: { uploadId, deleted: true } };
    };
    let x = await w();
    assertEqual(`${x.code} ${x.b.uploadId} ${x.b.remaining}`, `200 ${UUID} 1`, '[race] the first upload deleted, one left');
    let doc = decisionDoc() as { state?: string; uploadId?: string; uploads?: Array<{ uploadId: string }> } | null;
    assertEqual(doc?.state, 'uploaded', '[race] not recorded as withdrawn: the new upload is still in the cloud');
    assertEqual(JSON.stringify(doc?.uploads?.map((h) => h.uploadId)), JSON.stringify([UUID2]), '[race] the interleaved upload stays listed');
    assertEqual(doc?.uploadId, UUID2, '[race] the decision names the new upload');
    assertEqual((await statusOf(r.app)).withdrawable, true, '[race] still withdrawable');

    // a decision made during a (partial) withdraw is kept
    clean();
    f.script.upload = () => ({ code: 200, body: { uploadId: UUID, status: 'complete', covered: false }, via: 'anonymous', uploaderId: 'anon-user-1' });
    assertEqual((await send(r.app)).statusCode, 200, '[race] upload A');
    f.script.upload = () => ({ code: 200, body: { uploadId: UUID2, status: 'complete', covered: false }, via: 'account', uploaderId: 'acct-user-1' });
    assertEqual((await send(r.app, { acceptFirmwareMismatch: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache')).statusCode, 200, '[race] upload B');
    f.script.del = async (uploadId) => {
      if (uploadId === UUID) {
        const d = await post(r.app, '/device/cache/contribute/decision', { decision: 'declined' });
        assertEqual(d.statusCode, 200, '[race] the interleaved decision');
        return { code: 200, body: { uploadId, deleted: true } };
      }
      return { code: 500, body: { error: 'internal' } };
    };
    x = await w();
    assertEqual(`${x.code} ${x.b.remaining}`, '502 1', '[race] B failed, one left');
    doc = decisionDoc() as { state?: string; uploads?: Array<{ uploadId: string }> } | null;
    assertEqual(doc?.state, 'declined', '[race] the decision made meanwhile is kept');
    assertEqual(JSON.stringify(doc?.uploads?.map((h) => h.uploadId)), JSON.stringify([UUID2]), '[race] only B left');

    // two uploads finishing together never drop a handle (repeated: the old code lost one in most runs)
    for (let round = 0; round < 5; round++) {
      clean();
      let n = 0;
      f.script.upload = () => {
        n++;
        return { code: 200, body: { uploadId: `${'0'.repeat(8)}-0000-4000-8000-${String(round * 10 + n).padStart(12, '0')}`, status: 'complete', covered: false }, via: 'anonymous', uploaderId: 'anon-user-1' };
      };
      const [a, b] = await Promise.all([send(r.app), send(r.app, { acceptFirmwareMismatch: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache')]);
      assertEqual(`${a.statusCode} ${b.statusCode}`, '200 200', `[race] round ${round}: both uploads`);
      const handles = ((decisionDoc() as { uploads?: unknown[] } | null)?.uploads ?? []).length;
      assertEqual(handles, 2, `[race] round ${round}: both handles kept`);
    }
  } finally { clean(); await r.app.close(); }
}

// ── 7d. an entry with no session record: a "not found" is not proof it is gone ──
async function unverifiedHandles(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  try {
    const at = new Date().toISOString();
    store.defaultStore.putDoc(CONTRIBUTIONS_COLLECTION, KEY, { state: 'uploaded', at, uploadId: UUID, uploads: [{ uploadId: UUID, uploadedAt: at }] });
    f.script.del = () => ({ code: 404, body: { error: 'not-found' } });
    let res = await post(r.app, '/device/cache/contribute/withdraw');
    let b = res.json() as WBody;
    assertEqual(`${res.statusCode} ${b.error} ${b.uploads?.[0]?.result} ${b.remaining}`, '409 unverified unverified 1', '[unverified] 404 without an identity → 409, kept');
    assertEqual(decisionDoc()?.state, 'uploaded', '[unverified] not recorded as withdrawn');
    // the same entry recorded with a session kind but no uploader key: still unverified
    store.defaultStore.putDoc(CONTRIBUTIONS_COLLECTION, KEY, { state: 'uploaded', at, uploadId: UUID, uploads: [{ uploadId: UUID, via: 'anonymous', uploadedAt: at }] });
    res = await post(r.app, '/device/cache/contribute/withdraw');
    assertEqual((res.json() as WBody).error, 'unverified', '[unverified] a session kind alone is not an identity');
    // a delete that succeeds proves it was ours (the cloud deletes only the caller's own rows)
    f.script.del = (uploadId) => ({ code: 200, body: { uploadId, deleted: true } });
    res = await post(r.app, '/device/cache/contribute/withdraw');
    b = res.json() as WBody;
    assertEqual(`${res.statusCode} ${b.uploads?.[0]?.result}`, '200 deleted', '[unverified] deleted');
    assertEqual(decisionDoc()?.state, 'withdrawn', '[unverified] withdrawn');
  } finally { clean(); await r.app.close(); }
}

// ── 8. Remote: the status relays, no upload / decision / withdraw ──
async function remoteRelay(): Promise<void> {
  clean();
  const f = fakeCloud();
  const r = await rig({ cloud: f.cloud });
  const log = console.log;
  console.log = () => {};
  try {
    const { session, relay } = fakeChannelSession();
    const host = new RemoteHost(r.app, async () => session, (fn) => r.registry.subscribe(fn));
    await host.enable(true);
    try {
      const st = await relay('c1', 'GET', '/device/cache/contribute');
      assertEqual(st.status, 200, '[remote] status relays');
      for (const [id, path, body] of [
        ['c2', '/device/cache/contribute', { source: { path: '/x/' + FILE13 }, consent: true, consentVersion: 2 }],
        ['c3', '/device/cache/contribute/decision', { decision: 'declined' }],
        ['c4', '/device/cache/contribute/withdraw', {}]
      ] as const) {
        const res = await relay(id, 'POST', path, body);
        assertEqual(res.status, 403, `[remote] POST ${path} refused`);
      }
      assertEqual(f.calls.uploads.length + f.calls.deletes.length, 0, '[remote] nothing reached the cloud');
      assertEqual(decisionDoc(), null, '[remote] no decision');
    } finally { await host.enable(false); }
  } finally { console.log = log; clean(); await r.app.close(); }
}

// ── 9. the generic signed-upload flow with the editor-cache spec ──
async function signedUploadFlow(): Promise<void> {
  const body = { model: FM3 } as Record<string, unknown>;
  const spec = { fn: 'editor-caches', idField: 'uploadId', defaultBucket: 'editor-caches', contentType: 'application/octet-stream', reserveBody: body, allowNullIdWhenComplete: true, finalizeFields: ['covered'] as const };
  const rigT = (reserve: Record<string, unknown>, fin: Record<string, unknown> = { status: 'complete', covered: true }) => {
    const log: string[] = [];
    const t: SignedUploadTransport = {
      post: async (p, b) => { log.push(`${p} ${JSON.stringify(b)}`); return { code: 200, body: p === 'editor-caches' ? reserve : fin, retryAfter: null }; },
      upload: async (bucket, path, token, bytes, contentType) => { log.push(`upload ${bucket}/${path}/${token}/${bytes.length}/${contentType}`); return null; }
    };
    return { t, log };
  };
  const bytes = Uint8Array.from([1, 2, 3]);
  let x = rigT({ uploadId: UUID, status: 'pending', path: 'u/s.cache', token: 'tok', bucket: 'editor-caches' });
  let out = await runSignedUpload(x.t, bytes, spec);
  assertEqual(JSON.stringify(out), JSON.stringify({ code: 200, body: { uploadId: UUID, status: 'complete', covered: true } }), '[signed] flow + covered');
  assertEqual(x.log.join(' | '), `editor-caches {"model":17} | upload editor-caches/u/s.cache/tok/3/application/octet-stream | editor-caches/finalize {"uploadId":"${UUID}"}`, '[signed] reserve → upload (octet-stream) → finalize');
  x = rigT({ uploadId: null, status: 'complete', deduped: true });
  out = await runSignedUpload(x.t, bytes, spec);
  assertEqual(JSON.stringify(out.body), JSON.stringify({ uploadId: null, status: 'complete', deduped: true }), '[signed] cross-uploader duplicate: null id accepted');
  assertEqual(x.log.length, 1, '[signed] nothing after the reservation');
  x = rigT({ uploadId: null, status: 'pending' });
  out = await runSignedUpload(x.t, bytes, spec);
  assertEqual(out.code, 502, '[signed] a pending reservation without an id → 502');
  x = rigT({ uploadId: null, status: 'complete' });
  out = await runSignedUpload(x.t, bytes, { ...spec, allowNullIdWhenComplete: false });
  assertEqual(out.code, 502, '[signed] null id refused unless allowed');
}

// ── 10. the Cloud client's sessions, against a faked Supabase (no network) ──
const SUPA = 'http://127.0.0.1:54321';
const ACCOUNT_KEY = 'sb-127-auth-token';
const jwt = (payload: Record<string, unknown>) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload, 'sig'].map((p) => (typeof p === 'string' ? p : Buffer.from(JSON.stringify(p)).toString('base64url'))).join('.');
const sessionJson = (token: string, anonymous: boolean, userId: string) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `r-${userId}`,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', is_anonymous: anonymous, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  };
};

async function cloudSessions(): Promise<void> {
  const memStore = (): Store => createStore(createMemStoreBackend(), nodeCodec);
  // off: no network, nothing pretends to work
  const off = createCloud({ url: '', anonKey: '' }, memStore());
  assertEqual(off.isEnabled(), false, '[cloud] off');
  assertEqual(await off.editorCacheWanted(FM3, '13.0'), null, '[cloud] off: wanted null');
  assertEqual((await off.editorCacheUpload(new Uint8Array(1), {} as EditorCacheReserveBody)).disabled, true, '[cloud] off: upload disabled');
  assertEqual(off.hasAccountSession(), false, '[cloud] off: no account');

  // hasAccountSession: a local read of the account slot only
  const st = memStore();
  const c = createCloud({ url: SUPA, anonKey: 'anon-key' }, st);
  assertEqual(c.hasAccountSession(), false, '[cloud] empty store: signed out');
  st.putDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY, JSON.stringify(sessionJson('anon', true, 'anon-user')));
  assertEqual(c.hasAccountSession(), false, '[cloud] an anonymous upload session is not an account');
  st.putDoc('cloud', ACCOUNT_KEY, JSON.stringify(sessionJson('acct', true, 'x')));
  assertEqual(c.hasAccountSession(), false, '[cloud] an anonymous user in the account slot is not an account');
  st.putDoc('cloud', ACCOUNT_KEY, JSON.stringify(sessionJson('acct', false, 'acct-user')));
  assertEqual(c.hasAccountSession(), true, '[cloud] an account session');
  st.delDoc('cloud', ACCOUNT_KEY);
  assertEqual(c.hasAccountSession(), false, '[cloud] a removed (tombstoned) session reads as signed out');

  // the full flow over a faked fetch
  const anonToken = jwt({ sub: 'anon-user', role: 'authenticated', is_anonymous: true, exp: Math.floor(Date.now() / 1000) + 3600 });
  const acctToken = jwt({ sub: 'acct-user', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const reqs: Array<{ method: string; url: string; auth: string | null; ctype: string | null; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    const raw = init.body;
    const body = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : raw instanceof Uint8Array ? raw.length : raw ?? null;
    reqs.push({ method, url, auth: h.get('authorization'), ctype: h.get('content-type'), body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (!url.startsWith(SUPA)) throw new Error(`unexpected host ${url}`);
    const u = new URL(url);
    if (method === 'POST' && u.pathname === '/auth/v1/signup') return json(200, sessionJson(anonToken, true, 'anon-user'));
    // a revoked account session: the refresh is refused for good (not retryable)
    if (method === 'POST' && u.pathname === '/auth/v1/token') return json(400, { code: 'refresh_token_not_found', error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
    if (method === 'GET' && u.pathname === '/functions/v1/editor-caches') return json(200, { model: Number(u.searchParams.get('model')), firmware: u.searchParams.get('firmware'), wanted: true });
    if (method === 'POST' && u.pathname === '/functions/v1/editor-caches') return json(200, { uploadId: UUID, status: 'pending', uploadUrl: `${SUPA}/x`, token: 'up-tok', path: `anon-user/${'a'.repeat(64)}.cache`, bucket: 'editor-caches', expiresIn: 7200 });
    if (method === 'PUT' && u.pathname.startsWith('/storage/v1/object/upload/sign/editor-caches/')) return json(200, { Key: 'editor-caches/x' });
    if (method === 'POST' && u.pathname === '/functions/v1/editor-caches/finalize') return json(200, { uploadId: UUID, status: 'complete', covered: false });
    if (method === 'POST' && u.pathname === '/functions/v1/editor-caches/delete') return json(200, { uploadId: UUID, deleted: true });
    return json(404, { error: 'not-found' });
  }) as typeof fetch;
  try {
    const s2 = memStore();
    const cl = createCloud({ url: SUPA, anonKey: 'anon-key' }, s2);
    assertEqual(await cl.editorCacheWanted(FM3, '13.0'), true, '[cloud] public wanted read');
    assertEqual(reqs.at(-1)!.auth, null, '[cloud] the wanted read carries no session');
    const body = { model: FM3, deviceFirmware: '13.0', fileVersion: '13.0', contentVersion: '13.0', fileName: FILE13, sha256: 'a'.repeat(64), bytes: 3, redaction: { version: 1, tables: 2, names: 6 }, summary: { sections: 6, records: 28, unmappedSections: 0, suspectFamilies: [], newRows: 0, incompatibleRows: 0, agreement: 1 }, app: { forgefx: 't', codec: 't' }, consentAt: new Date().toISOString(), consentVersion: 2 };
    const out = await cl.editorCacheUpload(Uint8Array.from([9, 9, 9]), body);
    assertEqual(`${out.code} ${out.via}`, '200 anonymous', `[cloud] signed out: uploaded anonymously (${JSON.stringify(out.body)})`);
    assertEqual(JSON.stringify(out.body), JSON.stringify({ uploadId: UUID, status: 'complete', covered: false }), '[cloud] upload result');
    const steps = reqs.slice(1).map((r) => `${r.method} ${new URL(r.url).pathname.replace(/sign\/editor-caches\/.*/, 'sign/editor-caches/…')}`);
    assertEqual(steps.join(' | '), 'POST /auth/v1/signup | POST /functions/v1/editor-caches | PUT /storage/v1/object/upload/sign/editor-caches/… | POST /functions/v1/editor-caches/finalize', '[cloud] anonymous sign-in → reserve → upload → finalize');
    const reserve = reqs.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/functions/v1/editor-caches')!;
    assertEqual(reserve.auth, `Bearer ${anonToken}`, '[cloud] reserve under the anonymous session');
    assertEqual(JSON.stringify(reserve.body), JSON.stringify(body), '[cloud] the reserve body verbatim');
    const put = reqs.find((r) => r.method === 'PUT')!;
    assertEqual(`${put.ctype} ${put.body}`, 'application/octet-stream 3', '[cloud] the bytes as octet-stream');
    // the anonymous session lives in its own slot; the account slot stays empty
    assert(present(s2.getDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY)), '[cloud] anonymous session persisted in its own slot');
    assertEqual(s2.getDoc('cloud', ACCOUNT_KEY), null, '[cloud] the account slot is untouched');
    assertEqual(cl.hasAccountSession(), false, '[cloud] still signed out');
    assertEqual(out.uploaderId, 'anon-user', '[cloud] the upload reports the uploading user id');
    assertEqual(`${cl.editorCacheUploader('anonymous')} ${cl.editorCacheUploader('account')}`, 'anon-user null', '[cloud] stored session ids per kind (local read)');
    // a second upload reuses the stored anonymous session (no second sign-in)
    reqs.length = 0;
    await cl.editorCacheUpload(Uint8Array.from([9, 9, 9]), body);
    assert(!reqs.some((r) => r.url.includes('/auth/v1/signup')), '[cloud] no second anonymous sign-in');
    // a fresh client over the same store (restart) finds it too
    reqs.length = 0;
    const restarted = createCloud({ url: SUPA, anonKey: 'anon-key' }, s2);
    const del = await restarted.editorCacheDelete(UUID, 'anonymous');
    assertEqual(`${del.code} ${del.via}`, '200 anonymous', '[cloud] delete under the anonymous session');
    assertEqual(reqs.at(-1)!.auth, `Bearer ${anonToken}`, '[cloud] delete carries the anonymous token');
    assertEqual(JSON.stringify(reqs.at(-1)!.body), JSON.stringify({ uploadId: UUID }), '[cloud] delete body');
    assert(!reqs.some((r) => r.url.includes('/auth/v1/signup')), '[cloud] a delete never signs in');
    // an account upload's delete while signed out: 401, no request
    reqs.length = 0;
    const no = await restarted.editorCacheDelete(UUID, 'account');
    assertEqual(no.code, 401, '[cloud] account delete while signed out → 401');
    assertEqual(reqs.length, 0, '[cloud] without sending anything');
    // a missing anonymous session is never re-created for a delete
    const s3 = memStore();
    const fresh = createCloud({ url: SUPA, anonKey: 'anon-key' }, s3);
    const gone = await fresh.editorCacheDelete(UUID, 'anonymous');
    assertEqual(JSON.stringify(gone.body), JSON.stringify({ error: 'not signed in', reason: 'anonymous-session-missing' }), '[cloud] lost anonymous session → 401');
    // signed in: the account session uploads (not the anonymous one)
    s3.putDoc('cloud', ACCOUNT_KEY, JSON.stringify(sessionJson(acctToken, false, 'acct-user')));
    const acct = createCloud({ url: SUPA, anonKey: 'anon-key' }, s3);
    reqs.length = 0;
    const ao = await acct.editorCacheUpload(Uint8Array.from([9, 9, 9]), body);
    assertEqual(`${ao.code} ${ao.via} ${ao.uploaderId}`, '200 account acct-user', '[cloud] signed in: the account uploads');
    assertEqual(acct.editorCacheUploader('account'), 'acct-user', '[cloud] the account session id');
    assert(!reqs.some((r) => r.url.includes('/auth/v1/signup')), '[cloud] no anonymous sign-in while signed in');
    assertEqual(reqs.find((r) => r.method === 'POST')!.auth, `Bearer ${acctToken}`, '[cloud] reserve under the account session');
    assertEqual(s3.getDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY), null, '[cloud] no anonymous session created');

    // a stored account session the server has revoked: supabase-js deletes it while loading it — the upload
    // must fail as account-session-unavailable, not slip to an anonymous upload in the same request
    const s4 = memStore();
    const expired = { ...sessionJson(acctToken, false, 'acct-user'), expires_at: Math.floor(Date.now() / 1000) - 3600, expires_in: -3600 };
    s4.putDoc('cloud', ACCOUNT_KEY, JSON.stringify(expired));
    const revoked = createCloud({ url: SUPA, anonKey: 'anon-key' }, s4);
    assertEqual(revoked.hasAccountSession(), true, '[cloud] (precondition) an account session is stored');
    reqs.length = 0;
    const ro = await revoked.editorCacheUpload(Uint8Array.from([9, 9, 9]), body);
    assertEqual(`${ro.code} ${ro.via} ${(ro.body as { reason?: string }).reason}`, '401 account account-session-unavailable', `[cloud] revoked account → 401 account-session-unavailable (${JSON.stringify(ro.body)})`);
    assert(!reqs.some((r) => r.url.includes('/auth/v1/signup')), '[cloud] no anonymous sign-in for a signed-in user whose session failed');
    assert(!reqs.some((r) => r.url.includes('/functions/v1/editor-caches')), '[cloud] nothing reserved');
    assertEqual(s4.getDoc('cloud', ANONYMOUS_UPLOADER_STORAGE_KEY), null, '[cloud] no anonymous session created');
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CASES = [statusWanted, uploadSuccess, deduped, errorMapping, importCoupling, dryRunSwitches, withdraw, withdrawHandles, races, unverifiedHandles, remoteRelay, signedUploadFlow, cloudSessions];
export const CACHE_CONTRIBUTION_UPLOAD_CASE_COUNT = CASES.length;

export async function runCacheContributionUploadTests(): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    for (const c of CASES) await c();
  } finally {
    console.log = log;
    clean();
  }
}
