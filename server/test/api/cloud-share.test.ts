// Sharing device definitions (cloud v2, M4 WP-F3) — a structural fake cloud and a detected FM3 on firmware 13.0 over a
// mocked transport, NO hardware, NO network (the Cloud client cases fake `fetch`). Covers:
//   - the consent gate: no `consent: true` / an unsupported consent version / a malformed body or `expect` → 400, nothing
//     read or sent;
//   - the dry run: the exact envelopes + their facts (`expect`), nothing sent; each carries no file fingerprint
//     (`contentSha256` null), no record of a user name table, no `issues`, no free-text walk note, no ids or origins, a
//     day-only `capturedAt`, and its source is the shared-mode checked copy of the sanitized stored source; cloud / file /
//     probe sources are skipped, a tolerant parse and a planted user table are refused;
//   - one POST per kind (the dry run's envelopes), the local records (a session tag, never a user id), the listing cache
//     dropped, the status after it (`shared`, `identical-in-cloud`, `removable`), `kinds`, `expect` (409 when the facts
//     changed since the preview);
//   - anonymous vs account sessions; the cloud refusing anonymous sharing (403 → 401 account-required, then no request
//     and no new identity while signed out); the listing's `allowAnonymous` true / false / absent; the Cloud client:
//     anonymous sign-ins switched off mint nothing (403), only the function refusing mints once, an auth outage answers 503
//     (never 401) and never replaces the stored anonymous session;
//   - compat v1 publish: only with a local editor cache and an account, derived from the editor cache ALONE (no data of
//     another kind), no install bookkeeping times, the dry run shows the exact v1 request the share then sends;
//   - the error mapping (401 / 403 / 413 / 422 / 429 / 503 / 502), per-source refusals vs refusals that stop;
//   - withdraw one / all (the account; the anonymous session only with anonymous records) / 404 / 401 / 503 / 400; an
//     account switch and a re-created anonymous session answer 409 session-mismatch and keep the records;
//   - the status reasons; `?refresh=1` reconciles the current session's records only (never over the Remote relay); the
//     records are write-protected;
//   - app ↔ router twin parity (Browser Direct), the origin guard, the Remote relay refusing share and withdraw.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import {
  RAW_FORMAT, isUserNameTable, rawFromLiveWalk, shareableSource, sourceFactHash,
  type ProfileDoc, type RawSource, type ShareableSource
} from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { deriveProfileDoc, loadUsableProfile } from '../../src/profileSchema.js';
import { cloudCachePublish, forgetDefinitionSources, publishableProfile, type V1PublishBody } from '../../src/services/cloudProfiles.js';
import {
  DEFINITION_SHARES_COLLECTION, SHARE_CONSENT_VERSION, cloudShare, cloudShareStatus, cloudShareWithdraw, forgetAnonymousSharePolicy, parseShareBody,
  parseWithdrawBody, type ShareCloud
} from '../../src/services/cloudShare.js';
import { checkSharedSource } from '../../src/services/rawValidation.js';
import { REMOTE_RELAY_HEADER } from '../../src/services/originGuard.js';
import { remoteAllowed } from '../../src/remote.js';
import {
  DEFINITION_SHARER_STORAGE_KEY, createCloud, isAuthOutage, parseDefinitionSourceList,
  type DefinitionSourceContribution, type DefinitionSourceList, type DefinitionSourceOutcome, type DefinitionSourceWithdrawal, type UploaderSession
} from '../../src/runtime/cloud.js';
import { createStore, type Store } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { clone, editorCacheSource, liveSeedRecords, liveSource, profileDoc, walkResult } from '../helpers/profileDocs.js';
import { NEWER_FIRMWARE_DIFF } from '../helpers/newerFirmware.js';

const FM3 = 0x11;
const AM4 = 0x15;
const FW = '13.0';
const KEY = '11_13p0';
const ID_EC = '0b7c6a2e-1111-4222-8333-944455556666';
const ID_LR = '1c8d7b3f-2222-4333-8444-a55566667777';
const ID_LF = '2d9e8c40-3333-4444-8555-b66677778888';
const DAY_RE = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
const TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ENVELOPE_KEYS = 'model,firmware,kind,rawFormat,source,app,consentAt,consentVersion';
const BOOKKEEPING = { importedAt: '2026-11-22T10:47:13.123Z', builtAt: '2026-11-22T10:47:14.456Z', pulledAt: '2026-11-21T09:12:13.000Z', contentHash: 'c0ffee', futureKey: 'not-for-the-cloud' };

type Json = Record<string, unknown>;
type CloudShareStatusJson = { shares: Array<{ sourceId: string }>; shareable: Array<{ state: string }> };
const json = (v: unknown) => JSON.stringify(v);
const idOf: Record<string, string> = { 'editor-cache': ID_EC, 'live-readonly': ID_LR, 'live-full': ID_LF };

const putDoc = (data: unknown) => store.defaultStore.putDoc('deviceCaches', KEY, data);
const sharesDoc = (key = KEY) => { const d = store.defaultStore.getDoc(DEFINITION_SHARES_COLLECTION, key); return d && !d.deleted ? d.data as { shares: Json[] } : null; };
const clearDocs = () => {
  store.defaultStore.delDoc('deviceCaches', KEY);
  for (const d of store.defaultStore.listDocs(DEFINITION_SHARES_COLLECTION)) store.defaultStore.delDoc(DEFINITION_SHARES_COLLECTION, d.id);
};
/** The tag a record keeps for a session user id (the module's rule, recomputed independently). */
async function tagOf(userId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`definition-sharer:${userId}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ── fixtures ──

/** The five stored sources of firmware 13.0: a LOCAL editor cache (with its file fingerprint and a precise capture time),
 *  a LOCAL read-only walk (device units, a free-text walk note), a full walk pulled from the cloud, a read-only walk from
 *  a definitions file, and a local single-block probe. */
async function storedSources(): Promise<RawSource[]> {
  const ec = await editorCacheSource(undefined, { firmware: FW, capturedAt: '2026-11-22T10:47:13.123Z' });
  assert(typeof ec.contentSha256 === 'string' && ec.contentSha256.length === 64, 'fixture: the stored editor cache carries its file fingerprint');
  const lr = liveSource(liveSeedRecords({ unit: 'dB' }), { firmware: FW, capturedAt: '2026-11-22T23:59:58.000Z' });
  (lr.walk as { abortReason?: string; extension?: string }).abortReason = 'walk-failed';
  (lr.walk as { extension?: string }).extension = 'aborted';
  const lfCloud = liveSource(liveSeedRecords(), { firmware: FW, kind: 'live-full', origin: 'cloud' });
  const lrFile = liveSource(liveSeedRecords(), { firmware: FW, origin: 'file', capturedAt: '2026-11-20T08:00:00.000Z' });
  const probe = rawFromLiveWalk(
    walkResult(NEWER_FIRMWARE_DIFF.newSection.records(NEWER_FIRMWARE_DIFF.probedEid)),
    { blocks: [NEWER_FIRMWARE_DIFF.probedEid], maxParamId: 36, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-probe', capturedAt: '2026-11-22T11:00:00.000Z', firmware: FW, origin: 'local' }
  );
  return [ec, lr, lfCloud, lrFile, probe];
}
/** The stored document (with this install's bookkeeping times in its meta), optionally changed before it is stored. */
async function storeAll(mutate?: (doc: ProfileDoc) => void): Promise<ProfileDoc> {
  const doc = clone(profileDoc(await storedSources(), { firmware: FW, extras: BOOKKEEPING }));
  mutate?.(doc);
  putDoc(doc);
  return doc;
}
/** The shared-mode checked copy of the sanitized stored source of `kind` (what a share must send). */
function expectedSource(doc: ProfileDoc, kind: string): ShareableSource {
  const s = doc.raw.sources.find((x) => x.kind === kind && x.origin === 'local')!;
  const sh = shareableSource(s);
  assert(!('refused' in sh), `fixture: ${kind} is shareable`);
  const c = checkSharedSource(sh, 'source');
  assert(c.ok, `fixture: ${kind} passes the shared mode`);
  return (c as { source: ShareableSource }).source;
}

interface FakeState {
  enabled: boolean;
  signedIn: boolean;
  anonSession: boolean;
  /** The user ids of the current sessions (an account switch / a re-created anonymous session changes them). */
  accountId: string;
  anonId: string;
  listing: DefinitionSourceList | null;
  contribute: ((env: DefinitionSourceContribution, via: UploaderSession) => DefinitionSourceOutcome | Promise<DefinitionSourceOutcome>) | null;
  withdraw: ((sel: DefinitionSourceWithdrawal, via: UploaderSession) => DefinitionSourceOutcome) | null;
  mine: ((via: UploaderSession) => DefinitionSourceOutcome) | null;
  publish: { code: number; body: unknown };
}
/** A structural fake cloud. A share runs under the account when signed in, else the anonymous sharer session (created on
 *  the first share: `anonSession`). Every call is recorded. */
function fakeCloud(o: Partial<FakeState> = {}) {
  const state: FakeState = {
    enabled: true, signedIn: false, anonSession: false, accountId: 'acct-1', anonId: 'anon-1', listing: null, contribute: null, withdraw: null, mine: null,
    publish: { code: 201, body: { ok: true } }, ...o
  };
  const calls = {
    contribute: [] as DefinitionSourceContribution[], withdraw: [] as Array<{ sel: DefinitionSourceWithdrawal; via?: UploaderSession }>,
    mine: [] as Array<UploaderSession | undefined>, list: 0, publish: [] as V1PublishBody[]
  };
  const cloud: ShareCloud = {
    isEnabled: () => state.enabled,
    hasAccountSession: () => state.signedIn,
    definitionSharer: (via) => (via === 'account' ? (state.signedIn ? state.accountId : null) : state.anonSession ? state.anonId : null),
    async deviceProfileGet() { return null; },
    async deviceProfilePublish(body) { calls.publish.push(clone(body) as V1PublishBody); return clone(state.publish); },
    async definitionSourcesList() { calls.list++; return state.listing ? clone(state.listing) : null; },
    async definitionSourceGet() { return null; },
    async definitionSourceContribute(env) {
      calls.contribute.push(clone(env));
      const via: UploaderSession = state.signedIn ? 'account' : 'anonymous';
      if (state.contribute) return state.contribute(env, via);
      if (via === 'anonymous') state.anonSession = true;
      const factHash = await sourceFactHash(env.source as unknown as RawSource, { model: env.model, firmware: env.firmware });
      return {
        code: 201, via, uploaderId: via === 'account' ? state.accountId : state.anonId,
        body: { sourceId: idOf[env.kind], factHash, created: true, deduped: false, confirmed: false, tier: 'candidate', contributors: 1, networks: 1 }
      };
    },
    async definitionSourceWithdraw(sel, via) {
      calls.withdraw.push({ sel: clone(sel), ...(via ? { via } : {}) });
      if (state.withdraw) return state.withdraw(sel, via ?? 'account');
      return { code: 200, body: { withdrawn: 1, deletedSources: 1 }, via };
    },
    async definitionSourcesMine(via) {
      calls.mine.push(via);
      if (state.mine) return state.mine(via ?? 'account');
      return { code: 200, body: { contributions: [] }, via };
    },
    async definitionSourceReport() { return { code: 200, body: { ok: true } }; }
  };
  return { cloud, state, calls };
}

const emptyListing = (o: Partial<DefinitionSourceList> = {}): DefinitionSourceList =>
  ({ model: FM3, firmware: FW, sources: [], alternatives: { 'editor-cache': 0, 'live-full': 0, 'live-readonly': 0 }, ...o });

/** A detected unit of `model` whose firmware reply is `fw` (null: a silent unit). */
async function makeRegistry(model = FM3, fw: readonly [number, number] | null = [13, 0]): Promise<DeviceRegistry> {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (fw && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model, fw[0], fw[1])];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  return registry as DeviceRegistry;
}

const consentBody = (extra: Json = {}) => ({ consent: true, consentVersion: SHARE_CONSENT_VERSION, ...extra });
const errorOf = (b: unknown) => (b as { error?: string }).error;

// ── 1. the consent gate ──
async function consentGate(): Promise<void> {
  clearDocs();
  await storeAll();
  const f = fakeCloud();
  const reg = await makeRegistry();
  const cases: Array<[string, unknown, number, string]> = [
    ['no body', undefined, 400, 'not-consented'],
    ['consent false', { consent: false, consentVersion: 1 }, 400, 'not-consented'],
    ['consent "true" (not a boolean)', { consent: 'true', consentVersion: 1 }, 400, 'not-consented'],
    ['no consent version', { consent: true }, 400, 'unsupported-consent-version'],
    ['an unknown consent version', { consent: true, consentVersion: 2 }, 400, 'unsupported-consent-version'],
    ['a dry run with a bad version', { consent: true, consentVersion: 0, dryRun: true }, 400, 'unsupported-consent-version'],
    ['not an object', [1], 400, 'invalid-request'],
    ['kinds not a list', { ...consentBody(), kinds: 'editor-cache' }, 400, 'invalid-request'],
    ['kinds empty', { ...consentBody(), kinds: [] }, 400, 'invalid-request'],
    ['an unknown kind', { ...consentBody(), kinds: ['presets'] }, 400, 'invalid-request'],
    ['expect not a list', { ...consentBody(), expect: {} }, 400, 'invalid-request'],
    ['expect a probe', { ...consentBody(), expect: [{ kind: 'live-probe', factHash: 'a'.repeat(64) }] }, 400, 'invalid-request'],
    ['expect a bad hash', { ...consentBody(), expect: [{ kind: 'editor-cache', factHash: 'xyz' }] }, 400, 'invalid-request'],
    ['expect a kind twice', { ...consentBody(), expect: [{ kind: 'editor-cache', factHash: 'a'.repeat(64) }, { kind: 'editor-cache', factHash: 'b'.repeat(64) }] }, 400, 'invalid-request']
  ];
  for (const [label, body, code, err] of cases) {
    const r = await cloudShare(f.cloud, store.defaultStore, reg, body);
    assertEqual(`${r.code} ${errorOf(r.body)}`, `${code} ${err}`, `[consent] ${label}`);
  }
  const v = await cloudShare(f.cloud, store.defaultStore, reg, { consent: true, consentVersion: 7 });
  assertEqual(json([v.body.consentVersion, v.body.supported]), json([7, [SHARE_CONSENT_VERSION]]), '[consent] the supported versions are named (as the editor-cache contribution does)');
  assertEqual(`${f.calls.contribute.length} ${f.calls.list} ${f.calls.publish.length} ${sharesDoc()}`, '0 0 0 null', '[consent] nothing sent, nothing listed, nothing recorded');
  // the parser on its own
  const ok = parseShareBody({ ...consentBody(), kinds: ['live-readonly', 'editor-cache', 'editor-cache'], compat: false, axisVersion: '0.12.0', extra: 1 });
  assert(ok.ok, '[consent] a good body parses');
  assertEqual(json(ok.ok && ok.opts), json({ consent: true, consentVersion: 1, kinds: ['live-readonly', 'editor-cache'], dryRun: false, compat: false, axisVersion: '0.12.0' }), '[consent] parsed options (kinds once, compat off)');
  const dry = parseShareBody({ dryRun: true });
  assertEqual(json(dry.ok && dry.opts), json({ consent: false, consentVersion: null, kinds: null, dryRun: true, compat: true }), '[consent] a dry run needs no consent; compat defaults on');
  const badAxis = parseShareBody({ ...consentBody(), axisVersion: 'bad version!' });
  assert(badAxis.ok && !('axisVersion' in badAxis.opts), '[consent] a malformed axisVersion is ignored, not an error');
}

// ── 2. the dry run: the exact envelopes, nothing sent ──
async function dryRunEnvelopes(): Promise<void> {
  clearDocs();
  const doc = await storeAll();
  const ecStored = doc.raw.sources.find((s) => s.kind === 'editor-cache')!;
  const f = fakeCloud();
  const reg = await makeRegistry();
  const r = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true }, { versions: { forgefx: '9.9.9' }, now: () => Date.parse('2026-11-23T12:00:00.000Z') });
  assertEqual(r.code, 200, `[dry] 200 (${json(r.body).slice(0, 300)})`);
  const b = r.body as Json;
  assertEqual(Object.keys(b).join(','), 'ok,dryRun,shared,skipped,wouldSend,expect,compat', '[dry] answer keys');
  assertEqual(`${b.ok} ${b.dryRun} ${json(b.shared)}`, 'true true []', '[dry] head');
  assertEqual(json(b.skipped), json([{ kind: 'live-full', reason: 'cloud-origin' }, { kind: 'live-readonly', reason: 'file-origin' }, { kind: 'live-probe', reason: 'probe' }]),
    '[dry] cloud, file and probe sources are skipped');
  const envs = b.wouldSend as DefinitionSourceContribution[];
  assertEqual(envs.map((e) => e.kind).join(','), 'editor-cache,live-readonly', '[dry] one envelope per local kind');
  for (const e of envs) {
    const label = `[dry] ${e.kind}`;
    assertEqual(Object.keys(e).join(','), ENVELOPE_KEYS, `${label}: envelope keys`);
    assertEqual(`${e.model} ${e.firmware} ${e.rawFormat} ${e.consentVersion} ${e.consentAt}`, `${FM3} ${FW} ${RAW_FORMAT} ${SHARE_CONSENT_VERSION} 2026-11-23T12:00:00.000Z`, `${label}: envelope head`);
    assertEqual(json(Object.keys(e.app)), json(['forgefx', 'codec']), `${label}: version stamps only`);
    assertEqual(e.app.forgefx, '9.9.9', `${label}: the host's version`);
    const s = e.source as unknown as Json;
    assertEqual(json(s), json(expectedSource(doc, e.kind)), `${label}: the source is the shared-mode checked copy of the sanitized stored source`);
    assert(!('id' in s) && !('origin' in s), `${label}: no id, no origin`);
    assert(!('issues' in s), `${label}: no issues`);
    assert(s.contentSha256 === undefined || s.contentSha256 === null, `${label}: no file fingerprint`);
    assert(typeof s.capturedAt === 'string' && DAY_RE.test(s.capturedAt), `${label}: capturedAt is a day (${s.capturedAt})`);
    assert(!(s.records as Array<{ id: number }>).some((x) => isUserNameTable(x.id)), `${label}: no record of a user name table`);
    if (e.kind === 'live-readonly') {
      assert(!('abortReason' in (s.walk as Json)), `${label}: no free-text walk note`);
      assertEqual((s.walk as Json).extension, 'aborted', `${label}: the walk outcome stays`);
    }
  }
  const facts = await Promise.all(envs.map(async (e) => ({ kind: e.kind, factHash: await sourceFactHash(e.source as unknown as RawSource, { model: FM3, firmware: FW }) })));
  assertEqual(json(b.expect), json(facts), '[dry] expect = the facts of the envelopes');
  assertEqual((envs[0]!.source as unknown as Json).capturedAt, '2026-11-22T00:00:00.000Z', '[dry] editor cache: the capture day');
  assertEqual((envs[1]!.source as unknown as Json).capturedAt, '2026-11-22T00:00:00.000Z', '[dry] live read: the capture day (UTC)');
  assert(!json(b).includes(ecStored.contentSha256!), '[dry] the stored file fingerprint appears nowhere in the answer');
  assert(!json(envs).includes('10:47:13') && !json(envs).includes('23:59:58'), '[dry] no time of day in the envelopes');
  assertEqual(json(b.compat), json({ wouldPublish: false, reason: 'anonymous' }), '[dry] compat: signed out → no v1 publish');
  assertEqual(`${f.calls.contribute.length} ${f.calls.publish.length} ${f.calls.list} ${sharesDoc()} ${f.state.anonSession}`, '0 0 0 null false',
    '[dry] nothing sent, nothing listed, nothing recorded, no session created');
  // a dry run works without a cloud too (nothing is sent anyway); compat says why it would not run
  const off = await cloudShare(null, store.defaultStore, reg, { dryRun: true });
  assertEqual(`${off.code} ${(off.body.wouldSend as unknown[]).length} ${json(off.body.compat)}`, `200 2 ${json({ wouldPublish: false, reason: 'cloud-disabled' })}`, '[dry] no cloud: still a preview');
  // kinds narrows it
  const one = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true, kinds: ['live-readonly', 'live-probe'] });
  assertEqual(json([(one.body.wouldSend as Json[]).map((e) => e.kind), one.body.skipped, one.body.compat]),
    json([['live-readonly'], [{ kind: 'live-readonly', reason: 'file-origin' }, { kind: 'live-probe', reason: 'probe' }], { wouldPublish: false, reason: 'not-requested' }]), '[dry] kinds: only those');
  const none = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true, kinds: ['live-full'] });
  assertEqual(`${none.code} ${errorOf(none.body)} ${json(none.body.skipped)}`, `404 nothing-to-share ${json([{ kind: 'live-full', reason: 'cloud-origin' }])}`, '[dry] only a cloud source asked for → 404');

  // a tolerant parse and a planted user name table are refused; a source of another firmware is skipped
  await storeAll((d) => {
    const ec = d.raw.sources[0] as unknown as Json;
    ec.issues = [{ section: 1, record: 0, offset: 12, reason: 'BAD-PAD', droppedRecords: 1, skippedBytes: 40, resumedAt: 52 }];
  });
  const tol = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true });
  assertEqual(json((tol.body.skipped as Json[])[0]), json({ kind: 'editor-cache', reason: 'tolerant-source' }), '[dry] a tolerant parse is never shared');
  assertEqual((tol.body.wouldSend as Json[]).map((e) => e.kind).join(','), 'live-readonly', '[dry] the others still are');
  // a stored source with a record of a user name table (a user cab-name table id; never written by this build): refused
  await storeAll((d) => {
    const ec = d.raw.sources[0] as unknown as { records: Json[] };
    ec.records.push({ ...ec.records[0]!, id: 0xfff5 });
  });
  const ud = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true });
  assertEqual(json((ud.body.skipped as Json[])[0]), json({ kind: 'editor-cache', reason: 'contains-user-data' }), '[dry] a planted user name table is refused');
  assertEqual((ud.body.wouldSend as Json[]).map((e) => e.kind).join(','), 'live-readonly', '[dry] only the clean source would be sent');
  assert(!json(ud.body.wouldSend).includes(`"id":${0xfff5}`), '[dry] the planted record is in no envelope');
  await storeAll((d) => { (d.raw.sources[1] as unknown as Json).firmware = '12.0'; });
  const fwd = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true });
  assertEqual(json((fwd.body.skipped as Json[]).find((x) => x.kind === 'live-readonly' && x.reason !== 'file-origin')), json({ kind: 'live-readonly', reason: 'firmware-differs' }), '[dry] another firmware is skipped');
  assertEqual(f.calls.contribute.length, 0, '[dry] still nothing sent');
  clearDocs();
}

// ── 3. one POST per kind, the records, the status after it, `expect` ──
async function perKindShares(): Promise<void> {
  clearDocs();
  const doc = await storeAll();
  const f = fakeCloud({ listing: emptyListing() });
  const reg = await makeRegistry();
  const now = () => Date.parse('2026-11-23T12:00:00.000Z');
  // the status before: both local kinds offered, nothing shared
  const st0 = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(Object.keys(st0).join(','), 'supported,device,cloud,consentVersion,shareable,shares,reason', '[share] status keys');
  assertEqual(json(st0.shareable.map((s) => [s.kind, s.state, s.reason ?? null, s.capturedAt])), json([
    ['editor-cache', 'not-shared', null, '2026-11-22T00:00:00.000Z'], ['live-readonly', 'not-shared', null, '2026-11-22T00:00:00.000Z'],
    ['live-full', 'not-shareable', 'cloud-origin', '2026-11-22T00:00:00.000Z'], ['live-readonly', 'not-shareable', 'file-origin', '2026-11-20T00:00:00.000Z'],
    ['live-probe', 'not-shareable', 'probe', '2026-11-22T00:00:00.000Z']
  ]), '[share] status: what could be shared');
  assertEqual(json([st0.supported, st0.device, st0.cloud, st0.consentVersion, st0.shares, st0.reason]),
    json([true, { model: FM3, firmware: FW, key: KEY }, { enabled: true, signedIn: false, anonymousAllowed: null }, 1, [], null]), '[share] status head (no allowAnonymous in the listing: unknown)');
  const dry = await cloudShare(f.cloud, store.defaultStore, reg, { dryRun: true }, { versions: { forgefx: 't' }, now });
  // the facts changed since the preview (a different expect): 409, nothing sent
  const stale = await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ expect: [{ kind: 'editor-cache', factHash: 'a'.repeat(64) }] }), { now });
  assertEqual(`${stale.code} ${errorOf(stale.body)} ${json(stale.body.actual)} ${f.calls.contribute.length}`, `409 share-content-changed ${json(dry.body.expect)} 0`, '[share] expect does not match → 409, nothing sent');
  const r = await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ expect: dry.body.expect }), { versions: { forgefx: 't' }, now });
  const lists0 = f.calls.list;
  assertEqual(r.code, 200, `[share] 200 (${json(r.body).slice(0, 300)})`);
  assertEqual(Object.keys(r.body).join(','), 'ok,dryRun,shared,skipped,via,compat', '[share] answer keys');
  assertEqual(json(f.calls.contribute), json(dry.body.wouldSend), '[share] the POSTs are exactly the dry run\'s envelopes, one per kind');
  const ecHash = await sourceFactHash(expectedSource(doc, 'editor-cache') as unknown as RawSource, { model: FM3, firmware: FW });
  assertEqual(json((r.body.shared as Json[])[0]), json({ kind: 'editor-cache', sourceId: ID_EC, factHash: ecHash, deduped: false, confirmed: false, tier: 'candidate', contributors: 1 }), '[share] shared item');
  assertEqual(`${(r.body.shared as Json[]).length} ${r.body.via} ${r.body.dryRun}`, '2 anonymous false', '[share] both kinds, anonymously');
  // the local records: kind, row, facts, session kind + tag, time, consent — never the uploading user id
  const rec = sharesDoc()!;
  const fields = 'kind,sourceId,factHash,via,uploaderKey,at,consentVersion,tier,contributors';
  assertEqual(json(rec.shares.map((x) => Object.keys(x).join(','))), json([fields, fields]), '[share] record fields');
  assertEqual(json(rec.shares.map((x) => [x.kind, x.sourceId, x.via, x.uploaderKey, x.at])),
    json([['editor-cache', ID_EC, 'anonymous', await tagOf('anon-1'), '2026-11-23T12:00:00.000Z'], ['live-readonly', ID_LR, 'anonymous', await tagOf('anon-1'), '2026-11-23T12:00:00.000Z']]), '[share] records');
  assert(!json(rec).includes('anon-1') && !json(r.body).includes('anon-1'), '[share] the uploading user id is neither stored nor answered');
  // the listing cache was dropped: the next status lists afresh, and the shares show as shared and removable
  const st1 = await cloudShareStatus(f.cloud, store.defaultStore, reg, { now: now() });
  assertEqual(f.calls.list, lists0 + 1, '[share] the cached listing was dropped');
  assertEqual(json(st1.shareable.slice(0, 2).map((s) => [s.state, s.sourceId])), json([['shared', ID_EC], ['shared', ID_LR]]), '[share] status: shared');
  assertEqual(json(st1.shares.map((s) => [s.kind, s.sourceId, s.tier, s.contributors, s.via, s.model, s.firmware, s.removable])),
    json([['editor-cache', ID_EC, 'candidate', 1, 'anonymous', FM3, FW, true], ['live-readonly', ID_LR, 'candidate', 1, 'anonymous', FM3, FW, true]]), '[share] status: this install\'s shares');
  assert(!json(st1).includes('uploaderKey') && !json(st1).includes(await tagOf('anon-1')), '[share] the status never shows the session tag');
  assertEqual(st1.cloud.anonymousAllowed, true, '[share] an anonymous share went through');
  // identical in the cloud (someone else shared these facts; nothing recorded here): sharing would confirm it
  clearDocs();
  await storeAll();
  f.state.listing = emptyListing({ sources: [{
    id: ID_LF, kind: 'editor-cache', rawFormat: 1, factHash: ecHash, tier: 'verified', quality: 3, contributors: 2, networks: 2,
    spotChecks: { passed: 1, failed: 0 }, firstSeen: '2026-11-20', lastConfirmedAt: null, bytes: 1000, summary: { records: 10 }
  }], alternatives: { 'editor-cache': 1, 'live-full': 0, 'live-readonly': 0 } });
  forgetDefinitionSources(reg);
  const st2 = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(json([st2.shareable[0]!.state, st2.shareable[0]!.sourceId, st2.shareable[1]!.state]), json(['identical-in-cloud', ID_LF, 'not-shared']), '[share] identical in the cloud');
  // kinds: only the live read
  f.calls.contribute.length = 0;
  const lo = await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['live-readonly'] }));
  assertEqual(`${lo.code} ${f.calls.contribute.map((e) => e.kind).join(',')} ${json(lo.body.compat)}`, `200 live-readonly ${json({ published: false, reason: 'not-requested' })}`, '[share] kinds: one POST');
  // a re-share of the same kind by the same session replaces its record (the cloud keeps one per uploader and kind)
  f.state.contribute = async (_env, via) => ({ code: 200, via, uploaderId: 'anon-1', body: { sourceId: ID_LF, factHash: 'a'.repeat(64), created: false, deduped: true, confirmed: true, tier: 'verified', contributors: 2, networks: 2 } });
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['live-readonly'] }));
  assertEqual(json(sharesDoc()!.shares.filter((x) => x.kind === 'live-readonly').map((x) => [x.sourceId, x.tier])), json([[ID_LF, 'verified']]), '[share] one record per kind and session');
  // nothing stored → 404
  clearDocs();
  const nothing = await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${nothing.code} ${errorOf(nothing.body)}`, '404 nothing-to-share', '[share] nothing stored → 404');
  clearDocs();
}

// ── 4. anonymous vs account; anonymous sharing refused; the listing's allowAnonymous ──
async function sessions(): Promise<void> {
  clearDocs();
  await storeAll();
  const reg = await makeRegistry();
  // signed out: anonymous, never a v1 publish
  const anon = fakeCloud();
  const n = await cloudShare(anon.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${n.code} ${n.body.via} ${json(n.body.compat)} ${anon.calls.publish.length}`, `200 anonymous ${json({ published: false, reason: 'anonymous' })} 0`, '[sessions] anonymous: shared, no v1 publish');
  // the cloud refuses anonymous sharing: 401 account-required; then, while signed out, no further request (no identity is
  // minted only to be refused)
  clearDocs(); await storeAll();
  const off = fakeCloud();
  off.state.contribute = (_env, via) => ({ code: 403, via, body: { error: 'account-required', message: 'sharing definitions currently needs a signed-in account' } });
  const r1 = await cloudShare(off.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${r1.code} ${errorOf(r1.body)} ${r1.body.reason} ${off.calls.contribute.length}`, '401 not-signed-in account-required 1', '[sessions] 403 account-required → 401, stops at the first kind');
  const r2 = await cloudShare(off.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${r2.code} ${r2.body.reason} ${off.calls.contribute.length}`, '401 account-required 1', '[sessions] remembered: no further request while signed out');
  assertEqual((await cloudShareStatus(off.cloud, store.defaultStore, reg)).cloud.anonymousAllowed, false, '[sessions] status: anonymous sharing not allowed');
  off.state.signedIn = true;
  off.state.contribute = null;
  const r3 = await cloudShare(off.cloud, store.defaultStore, reg, consentBody({ compat: false }));
  assertEqual(`${r3.code} ${r3.body.via}`, '200 account', '[sessions] signed in: the account shares');

  // the listing's allowAnonymous: false → no share while signed out (nothing minted); true / absent → as before
  for (const [label, allow, expectCode, expectStatus] of [['false', false, 401, false], ['true', true, 200, true], ['absent', undefined, 200, null]] as const) {
    clearDocs(); await storeAll();
    forgetDefinitionSources(reg);
    const g = fakeCloud({ listing: emptyListing(allow === undefined ? {} : { allowAnonymous: allow }) });
    const st = await cloudShareStatus(g.cloud, store.defaultStore, reg);
    assertEqual(st.cloud.anonymousAllowed, expectStatus, `[sessions] allowAnonymous ${label}: status`);
    forgetDefinitionSources(reg);
    const sh = await cloudShare(g.cloud, store.defaultStore, reg, consentBody());
    assertEqual(`${sh.code} ${expectCode === 401 ? sh.body.reason : sh.body.via} ${g.calls.contribute.length} ${g.state.anonSession}`,
      expectCode === 401 ? '401 account-required 0 false' : '200 anonymous 2 true', `[sessions] allowAnonymous ${label}: share while signed out`);
    if (allow === false) {
      g.state.signedIn = true;
      const acct = await cloudShare(g.cloud, store.defaultStore, reg, consentBody({ compat: false }));
      assertEqual(`${acct.code} ${acct.body.via}`, '200 account', '[sessions] allowAnonymous false: an account still shares');
    }
  }
  // the parser: a listing without the field reads as unknown, never false
  const asked = { model: FM3, firmware: FW, rawFormat: 1 };
  assertEqual(json(parseDefinitionSourceList({ model: FM3, firmware: FW, sources: [], alternatives: {} }, asked)?.allowAnonymous), json(undefined), '[sessions] no field → unknown');
  assertEqual(parseDefinitionSourceList({ model: FM3, firmware: FW, sources: [], alternatives: {}, allowAnonymous: false }, asked)?.allowAnonymous, false, '[sessions] field false');
  assertEqual(parseDefinitionSourceList({ model: FM3, firmware: FW, sources: [], alternatives: {}, allowAnonymous: 'no' }, asked)?.allowAnonymous, undefined, '[sessions] a non-boolean is ignored');
  clearDocs();
}

// ── 5. compat v1 publish ──
async function compatPublish(): Promise<void> {
  clearDocs();
  const doc = await storeAll();
  const reg = await makeRegistry();
  // signed in, editor cache only (a local live read is stored too): the v1 request is derived from the editor cache ALONE,
  // carries no bookkeeping time, and is exactly what the dry run showed
  const acct = fakeCloud({ signedIn: true });
  const dry = await cloudShare(acct.cloud, store.defaultStore, reg, { dryRun: true, kinds: ['editor-cache'] });
  const dc = dry.body.compat as { wouldPublish: boolean; wouldSend: V1PublishBody };
  assertEqual(`${dc.wouldPublish} ${acct.calls.publish.length}`, 'true 0', '[compat] the dry run shows the v1 request, sends nothing');
  const a = await cloudShare(acct.cloud, store.defaultStore, reg, consentBody({ kinds: ['editor-cache'] }));
  assertEqual(`${a.code} ${a.body.via} ${json(a.body.compat)}`, `200 account ${json({ published: true, status: 201, deduped: false })}`, '[compat] account: shared + v1 compat publish');
  assertEqual(acct.calls.publish.length, 1, '[compat] one v1 publish');
  const sent = acct.calls.publish[0]!;
  assertEqual(json(sent), json(dc.wouldSend), '[compat] the v1 request = the dry run\'s');
  assertEqual(`${sent.model} ${sent.firmware} ${sent.source} ${(sent.profile.meta as Json).source}`, `${FM3} ${FW} editor-cache bytes`, '[compat] v1 request head');
  const ec = doc.raw.sources.find((s) => s.kind === 'editor-cache')!;
  const alone = publishableProfile(deriveProfileDoc({ format: 1, sources: [ec] }, FM3, FW, '2026-11-23T00:00:00.000Z', {}) as unknown as Json);
  assertEqual(json(sent.profile.ranges), json(alone.ranges), '[compat] the tables are those of the editor cache alone');
  const lr = doc.raw.sources.find((s) => s.kind === 'live-readonly' && s.origin === 'local')!;
  const withLive = publishableProfile(deriveProfileDoc({ format: 1, sources: [ec, lr] }, FM3, FW, '2026-11-23T00:00:00.000Z', {}) as unknown as Json);
  assert(json(withLive.ranges) !== json(alone.ranges), '[compat] (precondition) the local live read would change the tables');
  assert(!('raw' in sent.profile) && !('provenance' in sent.profile), '[compat] derived tables only');
  for (const k of Object.keys(BOOKKEEPING)) assert(!(k in (sent.profile.meta as Json)), `[compat] meta.${k} is stripped`);
  assert(!TIME_RE.test(json(sent)), '[compat] no time of day anywhere in the v1 request');
  // the deprecated publish route strips the bookkeeping too
  await cloudCachePublish(acct.cloud, store.defaultStore, reg);
  const legacy = acct.calls.publish.at(-1)!;
  for (const k of Object.keys(BOOKKEEPING)) assert(!(k in (legacy.profile.meta as Json)), `[compat] legacy publish: meta.${k} is stripped`);
  assert(!TIME_RE.test(json(legacy)), '[compat] legacy publish: no time of day');
  // the meta of a published copy is an allow list: unknown keys never travel, walk keeps its counters, issues lose their
  // reason text and positions
  for (const m of [sent.profile.meta, legacy.profile.meta] as Json[]) {
    assert(Object.keys(m).every((k) => ['schema', 'recordCount', 'source', 'walk', 'issues'].includes(k)), `[compat] meta keys allowed only (${Object.keys(m).join(',')})`);
  }
  const pm = publishableProfile({
    ranges: {}, meta: {
      schema: 1, recordCount: 3, source: 'live', someday: 'x', origin: 'bytes',
      walk: { queries: 9, lostReplies: 1, unresolvedReplies: 0, abortReason: 'free text', extension: 'aborted', pseudoReplies: { endMarker: 2, note: 'x' } },
      issues: [{ section: 7, record: 3, offset: 1234, reason: 'BAD-PAD id=0x5 text', droppedRecords: 2, skippedBytes: 40, resumedAt: 1274 }]
    }
  }).meta as Json;
  assertEqual(json(pm), json({
    schema: 1, recordCount: 3, source: 'live', walk: { queries: 9, lostReplies: 1, unresolvedReplies: 0, pseudoReplies: { endMarker: 2 } },
    issues: [{ section: 7, record: null, offset: 0, reason: 'damaged', droppedRecords: 2, skippedBytes: 0, resumedAt: null }]
  }), '[compat] publishable meta: allow list, walk counters, coarsened issues');
  // compat off → no v1 publish
  clearDocs(); await storeAll();
  const acct2 = fakeCloud({ signedIn: true });
  const a2 = await cloudShare(acct2.cloud, store.defaultStore, reg, consentBody({ compat: false }));
  assertEqual(`${a2.code} ${a2.body.compat} ${acct2.calls.publish.length}`, '200 null 0', '[compat] compat: false → no v1 publish');
  // an account but no local editor cache → no v1 publish
  clearDocs(); await storeAll((d) => { d.raw.sources = d.raw.sources.filter((s) => s.kind !== 'editor-cache'); });
  const a3 = await cloudShare(acct2.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${a3.code} ${json(a3.body.compat)} ${acct2.calls.publish.length}`, `200 ${json({ published: false, reason: 'no-editor-cache' })} 0`, '[compat] no local editor cache → no v1 publish');
  // a failing v1 publish never fails the share
  clearDocs(); await storeAll();
  const acct3 = fakeCloud({ signedIn: true, publish: { code: 401, body: { error: 'not signed in' } } });
  const a4 = await cloudShare(acct3.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${a4.code} ${json(a4.body.compat)}`, `200 ${json({ published: false, reason: 'failed', status: 401, error: 'not signed in' })}`, '[compat] a failed v1 publish is reported, the share stands');
  clearDocs();
}

// ── 6. the Cloud client: anonymous sign-ins off, the function refusing, auth outages ──
const SUPA = 'http://127.0.0.1:54321';
const jwt = (payload: Record<string, unknown>) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload, 'sig'].map((p) => (typeof p === 'string' ? p : Buffer.from(JSON.stringify(p)).toString('base64url'))).join('.');
const sessionJson = (token: string, anonymous: boolean, userId: string, expired = false) => {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  return {
    access_token: token, token_type: 'bearer', expires_in: expired ? -3600 : 3600, expires_at: exp, refresh_token: `r-${userId}`,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', is_anonymous: anonymous, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
  };
};
async function cloudClientSessions(): Promise<void> {
  const memStore = (): Store => createStore(createMemStoreBackend(), nodeCodec);
  assert(isAuthOutage({ name: 'AuthRetryableFetchError', status: 0 }) && isAuthOutage({ status: 503 }) && isAuthOutage({ status: 429 }) && isAuthOutage({}), '[client] outages');
  assert(!isAuthOutage({ status: 400 }) && !isAuthOutage({ status: 422 }) && !isAuthOutage(null), '[client] verdicts');
  const env = (): DefinitionSourceContribution => ({ model: FM3, firmware: FW, kind: 'live-readonly', rawFormat: 1, source: {} as ShareableSource, app: {}, consentAt: new Date().toISOString(), consentVersion: 1 });
  let mode: 'disabled' | 'fn-refuses' | 'down' | 'refresh-down' = 'disabled';
  clearDocs(); await storeAll();
  const reg = await makeRegistry(); // before the timers are hurried below
  const reqs: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = globalThis.setTimeout;
  const realError = console.error;
  console.error = () => {}; // the auth client logs every failed request
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    reqs.push(`${method} ${u.pathname}`);
    const reply = (status: number, b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
    if (method === 'POST' && u.pathname === '/auth/v1/signup') {
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'disabled') return reply(422, { code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' }, { 'x-supabase-api-version': '2024-01-01' });
      return reply(200, sessionJson(jwt({ sub: 'fresh', is_anonymous: true }), true, 'fresh'));
    }
    if (method === 'POST' && u.pathname === '/auth/v1/token') return reply(503, { message: 'upstream unavailable' });
    if (method === 'GET' && u.pathname === '/functions/v1/definition-sources') return reply(404, { error: 'not-found' }); // an older cloud: no listing
    if (method === 'POST' && u.pathname === '/functions/v1/definition-sources') {
      if (mode === 'fn-refuses') return reply(403, { error: 'account-required' });
      return reply(201, { sourceId: ID_EC });
    }
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  try {
    // anonymous sign-ins switched off: nothing minted, 403 account-required, no function call
    const s1 = memStore();
    const c1 = createCloud({ url: SUPA, anonKey: 'anon-key' }, s1);
    const o1 = await c1.definitionSourceContribute(env());
    assertEqual(`${o1.code} ${errorOf(o1.body)} ${(o1.body as Json).reason}`, '403 account-required anonymous-sign-in-disabled', '[client] anonymous sign-ins off → 403');
    assert(!reqs.some((x) => x.startsWith('POST /functions/')), '[client] nothing shared');
    assertEqual(s1.getDoc('cloud', DEFINITION_SHARER_STORAGE_KEY), null, '[client] no anonymous session stored');
    const via1 = await cloudShare(c1 as unknown as ShareCloud, store.defaultStore, reg, consentBody());
    assertEqual(`${via1.code} ${errorOf(via1.body)} ${via1.body.reason}`, '401 not-signed-in account-required', '[client] the route: 401 account-required');
    reqs.length = 0;
    await cloudShare(c1 as unknown as ShareCloud, store.defaultStore, reg, consentBody());
    assertEqual(reqs.length, 0, '[client] remembered: no further sign-in attempt');
    // only the function refuses anonymous sessions (the auth service accepts them): the first share mints ONE anonymous
    // session and is refused; it is kept and nothing further is sent or minted while signed out
    mode = 'fn-refuses';
    reqs.length = 0;
    const s5 = memStore();
    const c5 = createCloud({ url: SUPA, anonKey: 'anon-key' }, s5);
    const f1 = await cloudShare(c5 as unknown as ShareCloud, store.defaultStore, reg, consentBody());
    assertEqual(`${f1.code} ${errorOf(f1.body)} ${f1.body.reason}`, '401 not-signed-in account-required', '[client] function refuses → 401 account-required');
    assertEqual(reqs.filter((x) => x === 'POST /auth/v1/signup').length, 1, '[client] one anonymous session minted');
    assert(s5.getDoc('cloud', DEFINITION_SHARER_STORAGE_KEY) !== null, '[client] … and kept for the next try');
    reqs.length = 0;
    const f2 = await cloudShare(c5 as unknown as ShareCloud, store.defaultStore, reg, consentBody());
    assertEqual(`${f2.code} ${f2.body.reason} ${reqs.length}`, '401 account-required 0', '[client] remembered: nothing sent, nothing minted');
    // the auth service unreachable: 503 auth-unavailable, never 401
    mode = 'down';
    reqs.length = 0;
    const s2 = memStore();
    const c2 = createCloud({ url: SUPA, anonKey: 'anon-key' }, s2);
    const o2 = await c2.definitionSourceContribute(env());
    assertEqual(`${o2.code} ${errorOf(o2.body)}`, '503 auth-unavailable', '[client] sign-in outage → 503');
    const via2 = await cloudShare(c2 as unknown as ShareCloud, store.defaultStore, reg, consentBody());
    assertEqual(`${via2.code} ${errorOf(via2.body)}`, '503 auth-unavailable', '[client] the route: 503 auth-unavailable (the client keeps its session)');
    // a stored anonymous sharer session whose refresh hits an outage is kept, never replaced by a new identity (the refresh
    // retries with backoff: its pauses run at once here)
    mode = 'refresh-down';
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, _ms?: number, ...a: unknown[]) => realTimeout(fn, 0, ...a)) as typeof setTimeout;
    const s3 = memStore();
    const old = JSON.stringify(sessionJson(jwt({ sub: 'old-anon', is_anonymous: true }), true, 'old-anon', true));
    s3.putDoc('cloud', DEFINITION_SHARER_STORAGE_KEY, old);
    reqs.length = 0;
    const o3 = await createCloud({ url: SUPA, anonKey: 'anon-key' }, s3).definitionSourceContribute(env());
    assertEqual(`${o3.code} ${errorOf(o3.body)} ${(o3.body as Json).reason}`, '503 auth-unavailable anonymous-session-unavailable', '[client] refresh outage → 503');
    assert(!reqs.includes('POST /auth/v1/signup') && !reqs.some((x) => x.startsWith('POST /functions/')), '[client] no new identity, nothing shared');
    assertEqual(s3.getDoc('cloud', DEFINITION_SHARER_STORAGE_KEY)?.data, old, '[client] the stored anonymous session is untouched');
    const w3 = await createCloud({ url: SUPA, anonKey: 'anon-key' }, s3).definitionSourceWithdraw({ all: true }, 'anonymous');
    assertEqual(`${w3.code} ${errorOf(w3.body)}`, '503 auth-unavailable', '[client] a withdraw during the outage → 503, not "session missing"');
    // a stored ACCOUNT session whose refresh hits an outage: 503, never an anonymous share behind the user's back
    const s4 = memStore();
    const acctKey = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
    s4.putDoc('cloud', acctKey, JSON.stringify(sessionJson(jwt({ sub: 'acct' }), false, 'acct', true)));
    reqs.length = 0;
    const o4 = await createCloud({ url: SUPA, anonKey: 'anon-key' }, s4).definitionSourceContribute(env());
    assertEqual(`${o4.code} ${errorOf(o4.body)} ${o4.via}`, '503 auth-unavailable account', '[client] account refresh outage → 503 (signed in stays signed in)');
    assert(!reqs.includes('POST /auth/v1/signup'), '[client] no anonymous fallback');
    assert(s4.getDoc('cloud', acctKey) !== null && !s4.getDoc('cloud', acctKey)!.deleted, '[client] the account session is kept');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
    console.error = realError;
    clearDocs();
  }
}

// ── 7. the error mapping ──
async function errorMapping(): Promise<void> {
  clearDocs();
  await storeAll();
  const reg = await makeRegistry();
  const cases: Array<[string, DefinitionSourceOutcome, number, Json]> = [
    ['401 (session missing)', { code: 401, body: { error: 'not signed in', reason: 'anonymous-sign-in-failed' } }, 401, { error: 'not-signed-in', reason: 'anonymous-sign-in-failed' }],
    ['401 (token refused by the cloud)', { code: 401, body: { error: 'unauthorized' } }, 401, { error: 'not-signed-in' }],
    ['403 account-required', { code: 403, body: { error: 'account-required' } }, 401, { error: 'not-signed-in', reason: 'account-required' }],
    ['413 too-large', { code: 413, body: { error: 'too-large', limit: 2097152, bytes: 3000000 } }, 413, { error: 'too-large', bytes: 3000000, limit: 2097152 }],
    ['422 invalid-source', { code: 422, body: { error: 'invalid-source', path: 'source.records[3].id', reason: 'range' } }, 422, { error: 'invalid-source', path: 'source.records[3].id', detail: 'range' }],
    ['422 implausible', { code: 422, body: { error: 'implausible' } }, 422, { error: 'implausible' }],
    ['422 unknown code', { code: 422, body: { error: 'new-rule' } }, 422, { error: 'invalid-source' }],
    ['429 rate-limited', { code: 429, body: { error: 'rate-limited', scope: 'network', retryAfterSeconds: 120 }, retryAfter: '120' }, 429, { error: 'rate-limited', retryAfterSeconds: 120, scope: 'network' }],
    ['429 quota (header)', { code: 429, body: { error: 'quota-exceeded', scope: 'uploader' }, retryAfter: '60' }, 429, { error: 'quota-exceeded', retryAfterSeconds: 60, scope: 'uploader' }],
    ['503 paused', { code: 503, body: { error: 'paused' } }, 503, { error: 'paused' }],
    ['503 auth-unavailable', { code: 503, body: { error: 'auth-unavailable', retryAfterSeconds: 30 } }, 503, { error: 'auth-unavailable', retryAfterSeconds: 30 }],
    ['409 rejected', { code: 409, body: { error: 'rejected' } }, 409, { error: 'rejected', message: 'these definitions were rejected by the maintainer' }],
    ['409 unsupported-model', { code: 409, body: { error: 'unsupported-model' } }, 409, { error: 'unsupported-model' }],
    ['404 (function missing)', { code: 404, body: { error: 'not-found' } }, 502, { error: 'cloud', status: 404, message: 'not-found' }],
    ['network', { code: 0, body: { error: 'fetch failed' } }, 502, { error: 'cloud', status: 0, message: 'fetch failed' }],
    ['400 consent refused', { code: 400, body: { error: 'consent-required' } }, 400, { error: 'not-consented', reason: 'consent-refused' }],
    ['disabled', { code: 503, body: { error: 'cloud-disabled' }, disabled: true }, 503, { error: 'cloud-disabled' }]
  ];
  for (const [label, outcome, code, expected] of cases) {
    const f = fakeCloud();
    f.state.contribute = () => clone(outcome);
    const r = await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['editor-cache'] }));
    assertEqual(r.code, code, `[errors] ${label}: status`);
    for (const [k, v] of Object.entries(expected)) assertEqual(json(r.body[k]), json(v), `[errors] ${label}: ${k}`);
    assertEqual(json([r.body.shared, sharesDoc()]), json([[], null]), `[errors] ${label}: nothing recorded`);
  }
  // a per-source refusal skips that kind; the other kind is still shared
  const f = fakeCloud();
  f.state.contribute = async (env, via) => (env.kind === 'editor-cache'
    ? { code: 422, via, body: { error: 'implausible' } }
    : { code: 201, via, body: { sourceId: ID_LR, factHash: 'b'.repeat(64), created: true, deduped: false, confirmed: false, tier: 'candidate', contributors: 1, networks: 1 } });
  const mixed = await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${mixed.code} ${(mixed.body.shared as Json[]).map((x) => x.kind).join(',')}`, '200 live-readonly', '[errors] 422 on one kind: the other is shared');
  assertEqual(json((mixed.body.skipped as Json[]).find((x) => x.kind === 'editor-cache')), json({ kind: 'editor-cache', reason: 'implausible', status: 422 }), '[errors] the refusal is listed');
  assertEqual(json(mixed.body.compat), json({ published: false, reason: 'not-shared' }), '[errors] compat: the editor cache was not shared');
  // a refusal that stops: 429 on the second kind keeps what the first shared
  clearDocs(); await storeAll();
  const g = fakeCloud();
  g.state.contribute = async (env, via) => (env.kind === 'editor-cache'
    ? { code: 201, via, body: { sourceId: ID_EC, factHash: 'e'.repeat(64), created: true, deduped: false, confirmed: false, tier: 'candidate', contributors: 1, networks: 1 } }
    : { code: 429, via, body: { error: 'rate-limited', scope: 'uploader', retryAfterSeconds: 3000 } });
  const stop = await cloudShare(g.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${stop.code} ${errorOf(stop.body)} ${(stop.body.shared as Json[]).map((x) => x.kind).join(',')}`, '429 rate-limited editor-cache', '[errors] 429 stops; the earlier share is reported');
  assertEqual(json(sharesDoc()!.shares.map((x) => x.kind)), json(['editor-cache']), '[errors] and recorded');
  // without the cloud: 503 before anything is read
  const none = await cloudShare(null, store.defaultStore, reg, consentBody());
  assertEqual(`${none.code} ${errorOf(none.body)}`, '503 cloud-disabled', '[errors] no cloud → 503');
  const offCloud = fakeCloud({ enabled: false });
  const off = await cloudShare(offCloud.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${off.code} ${errorOf(off.body)} ${offCloud.calls.contribute.length}`, '503 cloud-disabled 0', '[errors] cloud switched off → 503');
  clearDocs();
}

// ── 8. withdraw ──
async function withdraw(): Promise<void> {
  clearDocs();
  await storeAll();
  const reg = await makeRegistry();
  const f = fakeCloud();
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  f.state.signedIn = true;
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['editor-cache'], compat: false }));
  assertEqual(json(sharesDoc()!.shares.map((x) => `${x.kind}/${x.via}`).sort()), json(['editor-cache/account', 'editor-cache/anonymous', 'live-readonly/anonymous']), '[withdraw] three records');
  const lists0 = f.calls.list;
  // one row, shared by both sessions: withdrawn under each
  const one = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_EC.toUpperCase() });
  assertEqual(`${one.code} ${one.body.ok} ${one.body.withdrawn} ${one.body.deletedSources}`, '200 true 2 2', '[withdraw] one row: 200');
  assertEqual(json(f.calls.withdraw.map((x) => json(x)).sort()), json([json({ sel: { sourceId: ID_EC }, via: 'account' }), json({ sel: { sourceId: ID_EC }, via: 'anonymous' })]), '[withdraw] under each session that recorded it (id lower-cased)');
  assertEqual(json(sharesDoc()!.shares.map((x) => x.sourceId)), json([ID_LR]), '[withdraw] its records are gone');
  await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(f.calls.list, lists0 + 1, '[withdraw] the cached listing was dropped');
  // an unknown row: 404, nothing asked
  f.calls.withdraw.length = 0;
  const unknown = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_LF });
  assertEqual(`${unknown.code} ${errorOf(unknown.body)} ${f.calls.withdraw.length}`, '404 nothing-to-withdraw 0', '[withdraw] not recorded → 404, no request');
  // the cloud no longer has this session's share (withdrawn elsewhere, unlinked): 404, the record is dropped
  f.state.withdraw = (_sel, via) => ({ code: 404, via, body: { error: 'not-found' } });
  const gone = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_LR });
  assertEqual(`${gone.code} ${errorOf(gone.body)} ${sharesDoc()}`, '404 nothing-to-withdraw null', '[withdraw] gone in the cloud → 404, record dropped');
  // all, nothing recorded: the signed-in account only (its shares from every computer); the anonymous sharer session is
  // not touched without anonymous records
  f.state.withdraw = (_sel, via) => ({ code: 200, via, body: { withdrawn: via === 'account' ? 3 : 1, deletedSources: 1 } });
  f.calls.withdraw.length = 0;
  const all = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { all: true });
  assertEqual(`${all.code} ${all.body.withdrawn} ${all.body.deletedSources} ${json(f.calls.withdraw.map((x) => x.via))}`, '200 3 1 ["account"]', '[withdraw] all: the account; no anonymous call without anonymous records');
  // all, with an anonymous record: both sessions
  f.state.signedIn = false;
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['live-readonly'] }));
  f.state.signedIn = true;
  f.calls.withdraw.length = 0;
  const all2 = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { all: true });
  assertEqual(`${all2.code} ${all2.body.withdrawn} ${json(f.calls.withdraw.map((x) => [x.via, x.sel]))}`, `200 4 ${json([['account', { all: true }], ['anonymous', { all: true }]])}`, '[withdraw] all: under every session');
  assertEqual(json(all2.body.sessions), json([{ via: 'account', result: 'withdrawn', withdrawn: 3, deletedSources: 1 }, { via: 'anonymous', result: 'withdrawn', withdrawn: 1, deletedSources: 1 }]), '[withdraw] per session');
  assertEqual(sharesDoc(), null, '[withdraw] all records gone');
  // all of one firmware: narrowed
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ compat: false }));
  f.calls.withdraw.length = 0;
  await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { all: true, model: FM3, firmware: FW });
  assertEqual(json(f.calls.withdraw[0]!.sel), json({ all: true, model: FM3, firmware: FW }), '[withdraw] all, narrowed to a unit and firmware');
  assertEqual(sharesDoc(), null, '[withdraw] its records are gone');
  // the session that shared is gone: 401, nothing asked, the record stays listed
  f.state.signedIn = false;
  f.state.anonSession = false;
  f.state.withdraw = null;
  await cloudShare(fakeCloud().cloud, store.defaultStore, reg, consentBody({ kinds: ['live-readonly'] }));
  f.calls.withdraw.length = 0;
  const lost = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_LR });
  assertEqual(`${lost.code} ${errorOf(lost.body)} ${lost.body.reason} ${sharesDoc()?.shares.length} ${f.calls.withdraw.length}`, '401 not-signed-in anonymous-session-missing 1 0', '[withdraw] session gone → 401, kept, nothing sent');
  // an outage: 503, kept
  f.state.anonSession = true;
  f.state.withdraw = (_sel, via) => ({ code: 503, via, body: { error: 'auth-unavailable', retryAfterSeconds: 30 } });
  const down = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_LR });
  assertEqual(`${down.code} ${errorOf(down.body)} ${sharesDoc()?.shares.length}`, '503 auth-unavailable 1', '[withdraw] outage → 503, kept');
  // nothing held at all: 404, nothing asked
  clearDocs();
  f.state.anonSession = false;
  f.calls.withdraw.length = 0;
  const empty = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { all: true });
  assertEqual(`${empty.code} ${errorOf(empty.body)} ${f.calls.withdraw.length}`, '404 nothing-to-withdraw 0', '[withdraw] nothing held → 404, no request');
  // bodies; no cloud
  for (const [label, body] of [['empty', {}], ['both', { sourceId: ID_EC, all: true }], ['bad id', { sourceId: '../x' }], ['all not true', { all: 1 }], ['bad model', { all: true, model: 300 }], ['bad firmware', { all: true, firmware: '13.00' }], ['array', [ID_EC]]] as const) {
    const r = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, body);
    assertEqual(`${r.code} ${errorOf(r.body)}`, '400 invalid-request', `[withdraw] ${label} → 400`);
  }
  assert(parseWithdrawBody({ all: true }).ok, '[withdraw] { all: true } parses');
  const nc = await cloudShareWithdraw(null, store.defaultStore, reg, { all: true });
  assertEqual(`${nc.code} ${errorOf(nc.body)}`, '503 cloud-disabled', '[withdraw] no cloud → 503');
  // works without a unit (settings); a record without a session tag is withdrawn under the current session
  const noUnit = await makeRegistry(FM3, null);
  store.defaultStore.putDoc(DEFINITION_SHARES_COLLECTION, '12_12p0', { shares: [{ kind: 'live-full', sourceId: ID_LF, factHash: 'f'.repeat(64), via: 'account', at: '2026-11-01T00:00:00.000Z' }] });
  f.state.withdraw = null;
  f.state.signedIn = true;
  const nu = await cloudShareWithdraw(f.cloud, store.defaultStore, noUnit, { sourceId: ID_LF });
  assertEqual(`${nu.code} ${sharesDoc('12_12p0')}`, '200 null', '[withdraw] without the unit: an FM9 share is removed');
  clearDocs();
}

// ── 9. another account, a re-created anonymous session ──
async function sessionSwitch(): Promise<void> {
  clearDocs();
  await storeAll();
  const reg = await makeRegistry();
  const f = fakeCloud({ signedIn: true });
  await cloudShare(f.cloud, store.defaultStore, reg, consentBody({ kinds: ['editor-cache'], compat: false }));
  const before = json(sharesDoc());
  // another account signs in on this install
  f.state.accountId = 'acct-2';
  const st = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(json(st.shares.map((s) => [s.sourceId, s.via, s.removable])), json([[ID_EC, 'account', false]]), '[switch] status: the earlier account\'s share is not removable here');
  const one = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_EC });
  assertEqual(`${one.code} ${errorOf(one.body)} ${f.calls.withdraw.length} ${json(sharesDoc()) === before}`, '409 session-mismatch 0 true', '[switch] withdraw one → 409, nothing sent, record kept');
  assert(String(one.body.message).includes('sign in with that account'), `[switch] account wording (${one.body.message})`);
  f.state.withdraw = (_sel, via) => ({ code: 200, via, body: { withdrawn: 0, deletedSources: 0 } }); // the new account shared nothing
  const all = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { all: true });
  f.state.withdraw = null;
  assertEqual(`${all.code} ${json(f.calls.withdraw.map((x) => x.via))} ${json(sharesDoc()) === before}`, '409 ["account"] true', '[switch] withdraw all → the new account\'s own shares only; the earlier record kept');
  assert((all.body.sessions as Json[]).some((x) => x.via === 'account' && x.result === 'session-mismatch' && x.kept === 1), '[switch] … reported as session-mismatch');
  // ?refresh=1 under the new account (it has no shares) never drops the earlier account's record
  await cloudShareStatus(f.cloud, store.defaultStore, reg, { refresh: true });
  assertEqual(json(f.calls.mine), json(['account']), '[switch] refresh: the current account asked');
  assertEqual(json(sharesDoc()) === before, true, '[switch] refresh: the earlier account\'s record kept');
  // back to the earlier account: removable, withdrawn
  f.state.accountId = 'acct-1';
  f.calls.withdraw.length = 0;
  const back = await cloudShareWithdraw(f.cloud, store.defaultStore, reg, { sourceId: ID_EC });
  assertEqual(`${back.code} ${back.body.withdrawn} ${sharesDoc()}`, '200 1 null', '[switch] the earlier account withdraws it');
  // a re-created anonymous session (the earlier one lost): the record is kept as shared, not silently dropped
  clearDocs(); await storeAll();
  const g = fakeCloud();
  await cloudShare(g.cloud, store.defaultStore, reg, consentBody({ kinds: ['live-readonly'] }));
  g.state.anonId = 'anon-2';
  g.state.withdraw = (_sel, via) => ({ code: 404, via, body: { error: 'not-found' } });
  const re = await cloudShareWithdraw(g.cloud, store.defaultStore, reg, { sourceId: ID_LR });
  assertEqual(`${re.code} ${errorOf(re.body)} ${g.calls.withdraw.length} ${sharesDoc()?.shares.length}`, '409 session-mismatch 0 1', '[switch] re-created anonymous session → 409, kept');
  assert(String(re.body.message).includes('can no longer be removed from here') && !String(re.body.message).includes('sign in'), `[switch] former anonymous session wording (${re.body.message})`);
  const st2 = await cloudShareStatus(g.cloud, store.defaultStore, reg);
  assertEqual(st2.shares[0]?.removable, false, '[switch] listed as shared, no longer removable from here');
  clearDocs();
}

// ── 10. the status: reasons, refresh, write protection ──
async function statusReasons(): Promise<void> {
  clearDocs();
  const f = fakeCloud();
  // no cloud: the unit's sources still listed, reason cloud-disabled
  await storeAll();
  const reg = await makeRegistry();
  const st1 = await cloudShareStatus(null, store.defaultStore, reg);
  assertEqual(json([st1.cloud, st1.reason, st1.shareable.length]), json([{ enabled: false, signedIn: false, anonymousAllowed: null }, 'cloud-disabled', 5]), '[status] no cloud');
  // nothing stored → no-local-source; only non-shareable sources → no-local-source
  clearDocs();
  assertEqual((await cloudShareStatus(f.cloud, store.defaultStore, reg)).reason, 'no-local-source', '[status] nothing stored');
  await storeAll((d) => { d.raw.sources = d.raw.sources.filter((s) => s.origin !== 'local' || s.kind === 'live-probe'); });
  const st2 = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(json([st2.reason, st2.shareable.map((s) => s.state)]), json(['no-local-source', ['not-shareable', 'not-shareable', 'not-shareable']]), '[status] only cloud / file / probe sources');
  const nts = await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${nts.code} ${errorOf(nts.body)} ${(nts.body.skipped as unknown[]).length}`, '404 nothing-to-share 3', '[status] … and a share → 404 with the reasons');
  // raw sources a newer build wrote; a legacy doc of an old schema: profile-stale (409 on a share)
  await storeAll((d) => { (d.raw as unknown as Json).format = RAW_FORMAT + 1; });
  const st3 = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(st3.reason, 'profile-stale', '[status] raw sources of a newer build');
  const newer = await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${newer.code} ${errorOf(newer.body)} ${newer.body.staleReason}`, '409 profile-stale newer', '[status] … a share → 409');
  putDoc({ ranges: {}, meta: { schema: 0, recordCount: 1, source: 'live' } });
  assertEqual((await cloudShareStatus(f.cloud, store.defaultStore, reg)).reason, 'profile-stale', '[status] an outdated legacy doc');
  const stale = await cloudShare(f.cloud, store.defaultStore, reg, consentBody());
  assertEqual(`${stale.code} ${errorOf(stale.body)} ${stale.body.staleReason}`, '409 profile-stale outdated', '[status] a share of a stale doc → 409');
  assertEqual(f.calls.contribute.length, 0, '[status] nothing sent for a stale doc');
  // no unit, an unsupported unit, firmware unknown
  const am4 = await makeRegistry(AM4, [2, 0]);
  const st4 = await cloudShareStatus(f.cloud, store.defaultStore, am4);
  assertEqual(json([st4.supported, st4.reason]), json([false, 'unsupported']), '[status] AM4: unsupported');
  const am4Share = await cloudShare(f.cloud, store.defaultStore, am4, consentBody());
  assertEqual(`${am4Share.code} ${errorOf(am4Share.body)}`, '409 unsupported-model', '[status] AM4 share → 409');
  const silent = await makeRegistry(FM3, null);
  const st5 = await cloudShareStatus(f.cloud, store.defaultStore, silent);
  assertEqual(json([st5.supported, st5.device, st5.reason]), json([true, { model: FM3, firmware: null, key: null }, 'firmware-unknown']), '[status] firmware unknown');
  const fwu = await cloudShare(f.cloud, store.defaultStore, silent, consentBody());
  assertEqual(`${fwu.code} ${errorOf(fwu.body)}`, '503 firmware-unknown', '[status] share without a firmware → 503');
  // ?refresh=1 reconciles the current session's records with the cloud's list: its record the cloud no longer lists goes,
  // one it lists is added; a record without a tag is kept (it cannot be told apart from another session's)
  clearDocs();
  await storeAll();
  store.defaultStore.putDoc(DEFINITION_SHARES_COLLECTION, KEY, { shares: [
    { kind: 'editor-cache', sourceId: ID_EC, factHash: 'e'.repeat(64), via: 'anonymous', uploaderKey: await tagOf('anon-1'), at: '2026-11-01T00:00:00.000Z' },
    { kind: 'live-full', sourceId: ID_LF, factHash: 'f'.repeat(64), via: 'anonymous', at: '2026-10-01T00:00:00.000Z' }
  ] });
  f.state.anonSession = true;
  f.state.mine = (via) => ({
    code: 200, via,
    body: { contributions: via === 'anonymous' ? [{ id: 'c1', sourceId: ID_LR, model: FM3, firmware: FW, kind: 'live-readonly', factHash: 'b'.repeat(64), createdAt: '2026-11-21T09:00:00.000Z', linkedUntil: '2027-05-20T09:00:00.000Z' }] : [] }
  });
  const before = await cloudShareStatus(f.cloud, store.defaultStore, reg);
  assertEqual(`${before.shares.map((s) => s.sourceId).join(',')} ${f.calls.mine.length}`, `${ID_EC},${ID_LF} 0`, '[status] without refresh: the local records, the cloud not asked');
  const after = await cloudShareStatus(f.cloud, store.defaultStore, reg, { refresh: true });
  assertEqual(json(after.shares.map((s) => [s.kind, s.sourceId, s.via, s.at])), json([['live-readonly', ID_LR, 'anonymous', '2026-11-21T09:00:00.000Z'], ['live-full', ID_LF, 'anonymous', '2026-10-01T00:00:00.000Z']]), '[status] refresh: reconciled with the cloud');
  assertEqual(json(f.calls.mine), json(['anonymous']), '[status] refresh: asked under the session this install holds');
  // without anonymous records, the anonymous session is not asked (N2), even when it exists
  clearDocs(); await storeAll();
  f.calls.mine.length = 0;
  await cloudShareStatus(f.cloud, store.defaultStore, reg, { refresh: true });
  assertEqual(json(f.calls.mine), '[]', '[status] refresh: no anonymous call without anonymous records');
  // the records are private on the generic store routes (both twins); over the Remote relay the status leaves the
  // anonymous shares out and ignores ?refresh=1
  const ecHash = await sourceFactHash(expectedSource(await storeAll(), 'editor-cache') as unknown as RawSource, { model: FM3, firmware: FW });
  store.defaultStore.putDoc(DEFINITION_SHARES_COLLECTION, KEY, { shares: [
    { kind: 'editor-cache', sourceId: ID_EC, factHash: ecHash, via: 'anonymous', at: '2026-11-02T00:00:00.000Z' },
    { kind: 'live-full', sourceId: ID_LF, factHash: 'f'.repeat(64), via: 'account', at: '2026-11-01T00:00:00.000Z' }
  ] });
  const rec0 = json(sharesDoc());
  const app = await buildApp(reg, { cloudProfiles: { cloud: f.cloud } });
  const router = createRouter({ registry: reg, store: store.defaultStore, cloud: f.cloud as never });
  try {
    for (const [m, url, body] of [['GET', `/store/${DEFINITION_SHARES_COLLECTION}/${KEY}`, undefined], ['GET', `/store/${DEFINITION_SHARES_COLLECTION}`, undefined], ['PUT', `/store/${DEFINITION_SHARES_COLLECTION}/${KEY}`, { shares: [] }], ['DELETE', `/store/${DEFINITION_SHARES_COLLECTION}/${KEY}`, undefined]] as const) {
      const a = await app.inject({ method: m, url, ...(body ? { payload: body } : {}) });
      const b = await router.handle(m, url, body ? json(body) : undefined);
      assertEqual(`${a.statusCode} ${errorOf(a.json())} ${b.status}`, '403 forbidden-collection 403', `[status] ${m} ${url}: private on both twins`);
    }
    assert(!remoteAllowed('GET', `/store/${DEFINITION_SHARES_COLLECTION}/${KEY}`), '[status] never over the Remote relay');
    assertEqual(json(sharesDoc()), rec0, '[status] untouched');
    f.calls.mine.length = 0;
    const relayed = (await app.inject({ method: 'GET', url: '/device/cache/cloud/share?refresh=1', headers: { [REMOTE_RELAY_HEADER]: '1' } })).json() as CloudShareStatusJson;
    assertEqual(`${f.calls.mine.length} ${json(relayed.shares.map((s) => s.sourceId))} ${relayed.shareable[0]?.state}`, `0 ${json([ID_LF])} not-shared`, '[status] relayed: no refresh, no anonymous share, no anonymous row id');
    assert(!JSON.stringify(relayed).includes(ID_EC), '[status] relayed: the anonymous row id appears nowhere');
    const local = (await app.inject({ method: 'GET', url: '/device/cache/cloud/share' })).json() as CloudShareStatusJson;
    assertEqual(`${json(local.shares.map((s) => s.sourceId))} ${local.shareable[0]?.state}`, `${json([ID_EC, ID_LF])} shared`, '[status] local: every share');
    await app.inject({ method: 'GET', url: '/device/cache/cloud/share?refresh=1' });
    assertEqual(json(f.calls.mine), json(['anonymous']), '[status] a local ?refresh=1 asks the cloud');
  } finally { await app.close(); }
  clearDocs();
}

// ── 11. app ↔ router twins, origin guard, Remote ──
async function twins(): Promise<void> {
  clearDocs();
  const reg = await makeRegistry();
  const f = fakeCloud();
  const app = await buildApp(reg, { cloudProfiles: { cloud: f.cloud } });
  try {
    // the router gets the app's version stamps, so the envelopes match
    await storeAll();
    const probe = (await app.inject({ method: 'POST', url: '/device/cache/cloud/share', payload: { dryRun: true } })).json() as { wouldSend: DefinitionSourceContribution[] };
    const forgefx = probe.wouldSend[0]!.app.forgefx;
    const router = createRouter({ registry: reg, store: store.defaultStore, cloud: f.cloud as never, versions: { forgefx } });
    const viaApp = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.inject({ method: method as 'GET', url, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { payload: json(body) } : {}) });
      return { status: res.statusCode, text: res.payload };
    };
    const viaRouter = async (method: string, url: string, body?: unknown) => {
      const res = await router.handle(method, url, body !== undefined ? json(body) : undefined);
      return { status: res.status, text: res.body as string };
    };
    const stripTimes = (t: string) => t.replace(/"consentAt":"[^"]+"/g, '"consentAt":"T"').replace(/"at":"[^"]+"/g, '"at":"T"');
    const reset = async () => { clearDocs(); await storeAll(); f.state.anonSession = false; forgetAnonymousSharePolicy(f.cloud); forgetDefinitionSources(reg); };
    for (const [label, method, url, body, expect] of [
      ['status', 'GET', '/device/cache/cloud/share', undefined, 200],
      ['status refresh', 'GET', '/device/cache/cloud/share?refresh=1', undefined, 200],
      ['dry run', 'POST', '/device/cache/cloud/share', { dryRun: true }, 200],
      ['share', 'POST', '/device/cache/cloud/share', consentBody(), 200],
      ['share one kind', 'POST', '/device/cache/cloud/share', consentBody({ kinds: ['editor-cache'] }), 200],
      ['no consent', 'POST', '/device/cache/cloud/share', {}, 400],
      ['bad consent version', 'POST', '/device/cache/cloud/share', { consent: true, consentVersion: 9 }, 400],
      ['malformed', 'POST', '/device/cache/cloud/share', [1], 400],
      ['stale expect', 'POST', '/device/cache/cloud/share', consentBody({ expect: [{ kind: 'live-full', factHash: 'a'.repeat(64) }] }), 409],
      ['withdraw nothing', 'POST', '/device/cache/cloud/share/withdraw', { sourceId: ID_EC }, 404],
      ['withdraw malformed', 'POST', '/device/cache/cloud/share/withdraw', {}, 400]
    ] as const) {
      await reset();
      const a = await viaApp(method, url, body);
      const appRecords = json(sharesDoc());
      const appCalls = json(f.calls.contribute.splice(0).map((e) => ({ ...e, consentAt: 'T' })));
      await reset();
      const b = await viaRouter(method, url, body);
      assertEqual(a.status, expect, `[twins] ${label}: app status (${a.text.slice(0, 200)})`);
      assertEqual(b.status, a.status, `[twins] ${label}: router status = app status`);
      assertEqual(stripTimes(b.text), stripTimes(a.text), `[twins] ${label}: router body = app body`);
      assertEqual(stripTimes(json(sharesDoc())), stripTimes(appRecords), `[twins] ${label}: the same records`);
      assertEqual(json(f.calls.contribute.splice(0).map((e) => ({ ...e, consentAt: 'T' }))), appCalls, `[twins] ${label}: the same requests`);
    }
    // withdraw after a share, both twins
    for (const via of ['app', 'router'] as const) {
      await reset();
      await viaApp('POST', '/device/cache/cloud/share', consentBody());
      const w = via === 'app' ? await viaApp('POST', '/device/cache/cloud/share/withdraw', { sourceId: ID_EC }) : await viaRouter('POST', '/device/cache/cloud/share/withdraw', { sourceId: ID_EC });
      assertEqual(`${w.status} ${(JSON.parse(w.text) as Json).withdrawn}`, '200 1', `[twins] withdraw via the ${via}`);
    }
    // the origin guard (FORGEFX-51): a foreign page is refused before anything happens
    await reset();
    f.calls.contribute.length = 0;
    f.calls.withdraw.length = 0;
    for (const [method, url, body] of [['POST', '/device/cache/cloud/share', consentBody()], ['POST', '/device/cache/cloud/share/withdraw', { all: true }], ['GET', '/device/cache/cloud/share', undefined]] as const) {
      const r = await viaApp(method, url, body, { origin: 'https://evil.example' });
      assertEqual(`${r.status} ${errorOf(JSON.parse(r.text))}`, '403 forbidden-origin', `[twins] a foreign origin → 403 (${method} ${url})`);
    }
    assertEqual(`${f.calls.contribute.length} ${f.calls.withdraw.length} ${sharesDoc()}`, '0 0 null', '[twins] nothing sent, nothing recorded');
    // without a cloud the routes still answer (status disabled, a send 503)
    const bare = await buildApp(reg, { cloudProfiles: { cloud: null } });
    try {
      const st = (await bare.inject({ method: 'GET', url: '/device/cache/cloud/share' })).json() as Json;
      const sh = await bare.inject({ method: 'POST', url: '/device/cache/cloud/share', payload: consentBody() });
      assertEqual(`${json(st.cloud)} ${st.reason} ${sh.statusCode}`, `${json({ enabled: false, signedIn: false, anonymousAllowed: null })} cloud-disabled 503`, '[twins] no cloud: status disabled, share 503');
    } finally { await bare.close(); }
    // the Remote relay never carries a share or a withdraw; the status is a read
    for (const p of ['/device/cache/cloud/share', '/device/cache/cloud/share/withdraw', '/device/cache/cloud/share?dryRun=1']) assert(!remoteAllowed('POST', p), `[twins] Remote refuses POST ${p}`);
    assert(remoteAllowed('GET', '/device/cache/cloud/share'), '[twins] Remote reads the share status');
  } finally { await app.close(); clearDocs(); }
}

const CASES: Array<[string, () => Promise<void>]> = [
  ['consent gate', consentGate],
  ['dry run envelopes (privacy)', dryRunEnvelopes],
  ['per-kind shares, records, status after, expect', perKindShares],
  ['anonymous vs account, anonymous refused, allowAnonymous true/false/absent', sessions],
  ['compat v1 publish (editor cache alone, no bookkeeping times, dry run = sent)', compatPublish],
  ['Cloud client: anonymous sign-ins off, the function refusing, auth outages', cloudClientSessions],
  ['error mapping', errorMapping],
  ['withdraw one / all / 404', withdraw],
  ['another account, a re-created anonymous session', sessionSwitch],
  ['status reasons, refresh, write protection, relayed refresh', statusReasons],
  ['app ↔ router twins, origin guard, Remote', twins]
];
export const CLOUD_SHARE_CASE_COUNT = CASES.length;

export async function runCloudShareTests(): Promise<void> {
  for (const [name, run] of CASES) {
    try {
      await run();
    } catch (e) {
      throw new Error(`[api/cloud-share] ${name}: ${(e as Error).message}`);
    }
  }
}
