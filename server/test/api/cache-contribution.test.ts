// Editor-cache contribution, the LOCAL half (WP-F1): validation, redaction, preview (dry run), decisions and
// the hardening of the routes. Mocked FM3 / AM4 / FM3 without a firmware read, NO hardware, NO cloud (the
// upload half is cache-contribution-upload.test.ts). Every cache is synthetic (test/helpers/cacheBytes.ts) and
// discovery is pointed at temp trees through buildApp's seams — the user's real editor directories are never
// scanned. Covers: the validation matrix (413, empty, bad name, model, firmware-differs + accept, garbage,
// renamed file, header/walk section count, unrelated content, AM4 content, unknown firmware, AM4 device);
// preview numbers and redaction counts, the sha256 of the redacted bytes, the reserve body shape; that no
// response ever carries an original name (also a walk error right after the name table); the consent gate
// (dry run without consent, non-dry without consent, wrong/missing consent version — before any file is read);
// the discovered-path allowlist; the strict origin guard on all four routes; the dry-run copy on disk; decisions
// (asked expiry, declined, reset, invalid, persisted across a new registry); the status matrix (candidates of
// the connected model only, exact first then newest, editor name, reasons, local profile); router parity.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactCacheUserNames, parseCacheRecords, isUserNameTable } from 'forgefx-midi/cache';
import { buildApp, type AppOptions } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import * as store from '../../src/store.js';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { createRouter } from '../../src/runtime/router.js';
import { readCandidateFile, type DiscoverOpts, type DiscoveryFs } from '../../src/services/editorCacheDiscovery.js';
import {
  CONTRIBUTIONS_COLLECTION, CONTRIBUTION_CONSENT_VERSION, MAX_CONTRIBUTION_BYTES, contributionStatus, setContributionDecision,
  type ContributionStatus
} from '../../src/services/cacheContribution.js';
import {
  am4SeedRecords, catalogSeedRecords, contributionCache, encodeCache, SYNTHETIC_PRESET_NAMES, SYNTHETIC_USER_CAB_NAMES
} from '../helpers/cacheBytes.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

const FM3 = 0x11;
const KEY = '11_13p0';
const FILE13 = 'effectDefinitions_11_13p0.cache';

// ── fixtures ──

const CACHE13 = contributionCache({ major: 13, minor: 0 });
const CACHE12 = contributionCache({ major: 12, minor: 0 });
const CACHE11 = contributionCache({ major: 11, minor: 0 });
const NAMES = [...SYNTHETIC_PRESET_NAMES, ...SYNTHETIC_USER_CAB_NAMES].filter((n) => n.length > 0);

/** No synthetic user name (nor a distinctive fragment of one) appears in `text`. */
function assertNoNames(text: string, label: string): void {
  for (const n of NAMES) {
    assert(!text.includes(n), `${label}: an original name leaked`);
    assert(!text.includes(n.slice(0, 6)), `${label}: a name fragment leaked`);
  }
}

function firmwareReply(model: number, major: number, minor: number): number[] {
  return [0xf0, 0x00, 0x01, 0x74, model, 0x08, major, minor, 0x00, 0x00, 0xf7];
}

/** A temp editor tree (simulated macOS layout): FM3-Edit with the 13.0, 12.0 and 11.0 caches (mtimes chosen so
 *  11.0 is newer than 12.0), FM9-Edit with an FM9 cache that must never be offered to an FM3. */
function makeTree(): { root: string; dir: string; discover: DiscoverOpts; fsCalls: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'forgefx-contrib-'));
  const home = join(root, 'home');
  const base = join(home, 'Library', 'Application Support', 'Fractal Audio');
  const dir = join(base, 'FM3-Edit');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(base, 'FM9-Edit'), { recursive: true });
  const put = (p: string, b: Uint8Array, mtime: number) => { writeFileSync(p, b); utimesSync(p, mtime, mtime); };
  put(join(dir, FILE13), CACHE13.bytes, 1_700_000_000);
  put(join(dir, 'effectDefinitions_11_12p0.cache'), CACHE12.bytes, 1_700_000_100);
  put(join(dir, 'effectDefinitions_11_11p0.cache'), CACHE11.bytes, 1_700_000_200);
  put(join(base, 'FM9-Edit', 'effectDefinitions_12_12p0.cache'), contributionCache({ major: 12, minor: 0 }).bytes, 1_700_000_300);
  const fsCalls: string[] = [];
  const fs: DiscoveryFs = {
    existsSync: (p) => { fsCalls.push(p); return existsSync(p); },
    readdirSync: (p) => { fsCalls.push(p); return readdirSync(p); },
    statSync: (p) => { fsCalls.push(p); const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; }
  };
  return { root, dir, discover: { platform: 'darwin', home, env: {}, fs }, fsCalls };
}

interface Rig {
  app: Awaited<ReturnType<typeof buildApp>>;
  registry: DeviceRegistry;
  tree: ReturnType<typeof makeTree>;
  reads: string[];
  close(): Promise<void>;
}

async function rig(model = FM3, fw: [number, number] | null = [13, 0], contribute: AppOptions['contribute'] = {}): Promise<Rig> {
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (fw && req[5] === 0x08) return [firmwareReply(model, fw[0], fw[1])];
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (k: string) => loadUsableProfile(store.defaultStore, k)
  });
  await registry.detect();
  const tree = makeTree();
  const reads: string[] = [];
  const app = await buildApp(registry, {
    editorCaches: { discover: tree.discover, readFile: (p) => { reads.push(p); return readCandidateFile(p); } },
    // hermetic: no cloud, and never the ambient dry-run env
    contribute: { cloud: null, dryRun: false, dryRunDir: null, ...contribute }
  });
  return { app, registry, tree, reads, close: async () => { await app.close(); rmSync(tree.root, { recursive: true, force: true }); } };
}

function clean(): void {
  for (const k of ['11_13p0', '11_12p0', '11_11p0', '15_66p1']) {
    store.defaultStore.delDoc(CONTRIBUTIONS_COLLECTION, k);
    store.defaultStore.delDoc('deviceCaches', k);
  }
}

type App = Rig['app'];
const postBytes = (app: App, name: string, bytes: Uint8Array, q: Record<string, string> = { dryRun: '1' }, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/device/cache/contribute?${new URLSearchParams({ name, ...q }).toString()}`, headers: { 'content-type': 'application/octet-stream', ...headers }, payload: Buffer.from(bytes) });
const postJson = (app: App, url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
const status = async (app: App, headers: Record<string, string> = {}): Promise<ContributionStatus> => {
  const res = await app.inject({ method: 'GET', url: '/device/cache/contribute', headers });
  assertEqual(res.statusCode, 200, 'status 200');
  assertNoNames(res.payload, 'status');
  return res.json() as ContributionStatus;
};
const errorOf = (res: { json(): unknown }) => (res.json() as { error?: string }).error;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ── 1. validation matrix ──
async function validationMatrix(): Promise<void> {
  clean();
  const r = await rig();
  try {
    const cases: Array<{ label: string; name: string; bytes: Uint8Array; q?: Record<string, string>; code: number; error: string }> = [
      { label: 'over 4 MiB', name: FILE13, bytes: new Uint8Array(MAX_CONTRIBUTION_BYTES + 1), code: 413, error: 'too-large' },
      { label: 'empty file (outside 1 … 4 MiB)', name: FILE13, bytes: new Uint8Array(0), code: 413, error: 'too-large' },
      { label: 'not an editor-cache name', name: 'definitions.bin', bytes: CACHE13.bytes, code: 400, error: 'not-an-editor-cache-name' },
      { label: 'another model', name: 'effectDefinitions_12_13p0.cache', bytes: CACHE13.bytes, code: 409, error: 'model-mismatch' },
      { label: 'another firmware', name: 'effectDefinitions_11_12p0.cache', bytes: CACHE12.bytes, code: 409, error: 'firmware-differs' },
      { label: 'garbage', name: FILE13, bytes: Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) & 0xff), code: 422, error: 'cache-parse-failed' },
      { label: 'renamed file (12.0 inside, 13.0 in the name)', name: FILE13, bytes: CACHE12.bytes, code: 422, error: 'renamed-cache' },
      { label: 'header section count off', name: FILE13, bytes: contributionCache({ major: 13, minor: 0, headerSections: CACHE13.sections + 1 }).bytes, code: 422, error: 'cache-parse-failed' },
      { label: 'unrelated content (no row agrees with the catalog)', name: FILE13, bytes: contributionCache({ major: 13, minor: 0, records: catalogSeedRecords({ foreignUnits: true }) }).bytes, code: 422, error: 'unrelated-cache' },
      { label: 'AM4 content under an FM3 name (seed anchors fail)', name: FILE13, bytes: contributionCache({ major: 13, minor: 0, records: am4SeedRecords() }).bytes, code: 422, error: 'cache-parse-failed' },
      { label: 'the old headerless fixture', name: FILE13, bytes: encodeCache(catalogSeedRecords()), code: 422, error: 'renamed-cache' }
    ];
    for (const c of cases) {
      const res = await postBytes(r.app, c.name, c.bytes, c.q);
      assertEqual(res.statusCode, c.code, `[contribute] ${c.label}: status (${res.payload.slice(0, 160)})`);
      assertEqual(errorOf(res), c.error, `[contribute] ${c.label}: error code`);
      assertNoNames(res.payload, `[contribute] ${c.label}`);
    }
    const fwd = (await postBytes(r.app, 'effectDefinitions_11_12p0.cache', CACHE12.bytes)).json() as Record<string, unknown>;
    assertEqual(JSON.stringify(fwd), JSON.stringify({ error: 'firmware-differs', deviceFirmware: '13.0', fileVersion: '12.0', contentVersion: '12.0', overridable: true }), '[contribute] firmware-differs body');
    const unrelated = (await postBytes(r.app, FILE13, contributionCache({ major: 13, minor: 0, records: catalogSeedRecords({ foreignUnits: true }) }).bytes)).json() as { agreement: number; floor: number };
    assertEqual(unrelated.agreement, 0, '[contribute] unrelated: agreement');
    assertEqual(unrelated.floor, 0.5, '[contribute] unrelated: floor');
    const big = (await postBytes(r.app, FILE13, new Uint8Array(MAX_CONTRIBUTION_BYTES + 1))).json() as { bytes: number; limit: number };
    assertEqual(big.limit, MAX_CONTRIBUTION_BYTES, '[contribute] too-large: limit');
    assertEqual(big.bytes, MAX_CONTRIBUTION_BYTES + 1, '[contribute] too-large: bytes');
    // a body over the route's body limit never reaches the handler: same 413 shape
    const huge = await postBytes(r.app, FILE13, new Uint8Array(MAX_CONTRIBUTION_BYTES + 128 * 1024));
    assertEqual(huge.statusCode, 413, '[contribute] over the body limit → 413');
    assertEqual(JSON.stringify(huge.json()), JSON.stringify({ error: 'too-large', bytes: MAX_CONTRIBUTION_BYTES + 128 * 1024, limit: MAX_CONTRIBUTION_BYTES }), '[contribute] body-limit 413 in the contract shape');
    const empty = (await postBytes(r.app, FILE13, new Uint8Array(0))).json() as { bytes: number; limit: number };
    assertEqual(`${empty.bytes}/${empty.limit}`, `0/${MAX_CONTRIBUTION_BYTES}`, '[contribute] empty: bytes/limit');
    const model = (await postBytes(r.app, 'effectDefinitions_12_13p0.cache', CACHE13.bytes)).json() as { expected: number; got: number };
    assertEqual(`${model.expected}/${model.got}`, `${FM3}/${0x12}`, '[contribute] model-mismatch: expected/got');

    // an older file with the mismatch accepted: previewed, flagged
    const ok = await postBytes(r.app, 'effectDefinitions_11_12p0.cache', CACHE12.bytes, { dryRun: '1', acceptFirmwareMismatch: '1' });
    assertEqual(ok.statusCode, 200, '[contribute] firmware-differs accepted → 200');
    assertEqual((ok.json() as { validation: { firmwareMatch: string } }).validation.firmwareMatch, 'firmware-differs', '[contribute] accepted mismatch is flagged');

    // a walk error right after the name table: the walker's hex dump would quote the names — the answer must not
    const broken = CACHE13.bytes.slice();
    broken[broken.length - 1] = 0x7f;
    const bad = await postBytes(r.app, FILE13, broken);
    assertEqual(bad.statusCode, 422, '[contribute] broken trailer → 422');
    assertNoNames(bad.payload, '[contribute] walk error after the name table');
    assert(!bad.payload.includes('\\n'), '[contribute] the walk error carries no hex dump');
    assertEqual(r.reads.length, 0, '[contribute] bytes bodies never read the disk');
    const dd = store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY);
    assert(!dd || dd.deleted, '[contribute] a refused request stores no decision');
  } finally {
    await r.close();
  }
  // device-side refusals
  const noFw = await rig(FM3, null);
  try {
    const res = await postBytes(noFw.app, FILE13, CACHE13.bytes);
    assertEqual(res.statusCode, 503, '[contribute] FM3 without a firmware read → 503');
    assertEqual(errorOf(res), 'firmware-unknown', '[contribute] firmware-unknown');
  } finally { await noFw.close(); }
  const am4 = await rig(0x15, null);
  try {
    const res = await postBytes(am4.app, 'effectDefinitions_15_66p1.cache', encodeCache(am4SeedRecords()));
    assertEqual(res.statusCode, 501, '[contribute] AM4 → 501');
    assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: 'unsupported', capability: 'contribute' }), '[contribute] 501 body');
  } finally { await am4.close(); }
}

// ── 2. preview numbers, redaction counts, sha256, reserve body ──
async function previewNumbers(): Promise<void> {
  clean();
  const r = await rig();
  try {
    const res = await postBytes(r.app, FILE13, CACHE13.bytes, { dryRun: '1', axisVersion: '0.11.0-beta' });
    assertEqual(res.statusCode, 200, '[preview] 200');
    assertNoNames(res.payload, '[preview]');
    const b = res.json() as {
      ok: boolean; dryRun: boolean; upload: null; file: { name: string; bytes: number; sha256: string };
      validation: Record<string, unknown> & { catalog: Record<string, unknown> }; redaction: Record<string, number>;
      import: unknown; wouldSend: Record<string, unknown> & { redaction: Record<string, unknown>; summary: Record<string, unknown>; app: Record<string, unknown> };
    };
    assertEqual(b.ok && b.dryRun, true, '[preview] ok + dryRun');
    assertEqual(b.upload, null, '[preview] upload null');
    const expected = redactCacheUserNames(CACHE13.bytes);
    assertEqual(b.file.name, FILE13, '[preview] file name');
    assertEqual(b.file.bytes, CACHE13.bytes.length, '[preview] the redacted copy keeps the size');
    assertEqual(b.file.sha256, sha256(expected.bytes), '[preview] sha256 of the REDACTED bytes');
    assert(b.file.sha256 !== sha256(CACHE13.bytes), '[preview] not the sha256 of the original');
    const v = b.validation;
    assertEqual(`${v.model} ${v.deviceFirmware} ${v.fileVersion} ${v.contentVersion} ${v.firmwareMatch}`, `${FM3} 13.0 13.0 13.0 exact`, '[preview] identity');
    assertEqual(v.sections, CACHE13.sections, '[preview] sections');
    assertEqual(v.records, CACHE13.records, '[preview] records');
    assertEqual(JSON.stringify(v.suspectFamilies), '[]', '[preview] no suspect families');
    assertEqual(v.buildDate, null, '[preview] no build date in this header');
    assert(typeof v.catalog.exact === 'number' && v.catalog.exact > 0, '[preview] the seed rows match the catalog exactly');
    assertEqual(`${v.catalog.compatible}/${v.catalog.incompatible}/${v.catalog.agreement}`, '0/0/1', '[preview] catalog counts');
    assertEqual(v.catalog.firmware, '12.0', '[preview] catalog baseline firmware');
    assertEqual(JSON.stringify(b.redaction), JSON.stringify({ version: 1, tables: 2, names: CACHE13.presetNames + CACHE13.userCabNames, presetNames: CACHE13.presetNames, userCabNames: CACHE13.userCabNames }), '[preview] redaction counts');
    assertEqual(JSON.stringify(b.import), JSON.stringify({ skipped: 'not-requested' }), '[preview] import not requested');
    // the exact reserve body: counts only, consent version 2, no per-kind split, no bytesReplaced
    const w = b.wouldSend;
    assertEqual(Object.keys(w).join(','), 'model,deviceFirmware,fileVersion,contentVersion,fileName,sha256,bytes,redaction,summary,app,consentAt,consentVersion', '[preview] reserve body keys');
    assertEqual(JSON.stringify(w.redaction), JSON.stringify({ version: 1, tables: 2, names: CACHE13.presetNames + CACHE13.userCabNames }), '[preview] reserve redaction = { version, tables, names }');
    assertEqual(Object.keys(w.summary).join(','), 'sections,records,unmappedSections,suspectFamilies,newRows,incompatibleRows,agreement', '[preview] summary keys');
    assertEqual(w.sha256, b.file.sha256, '[preview] reserve sha256');
    assertEqual(w.contentVersion, '13.0', '[preview] content version from the header');
    assertEqual(w.consentVersion, CONTRIBUTION_CONSENT_VERSION, '[preview] consent version 2');
    assertEqual(w.app.axis, '0.11.0-beta', '[preview] the Axis version stamp');
    assert(typeof w.app.codec === 'string' && typeof w.app.forgefx === 'string', '[preview] version stamps');
    assert(!JSON.stringify(w).includes('instance'), '[preview] no instance id travels');

    // FM9-style header build date is recorded
    const dated = contributionCache({ major: 13, minor: 0, buildDate: 'May 30 2025 12:40:41' });
    const d = (await postBytes(r.app, FILE13, dated.bytes)).json() as { validation: { buildDate: string } };
    assertEqual(d.validation.buildDate, 'May 30 2025 12:40:41', '[preview] header build date recorded');
    // deterministic: the same file previews to the same sha256 (also through JSON vs bytes)
    const again = (await postBytes(r.app, FILE13, CACHE13.bytes)).json() as { file: { sha256: string } };
    assertEqual(again.file.sha256, b.file.sha256, '[preview] deterministic redaction');
  } finally {
    await r.close();
  }
}

// ── 3. consent gate (before any file is read) ──
async function consentGate(): Promise<void> {
  clean();
  const r = await rig();
  try {
    const path = join(r.tree.dir, FILE13);
    // dry run needs no consent
    const dry = await postJson(r.app, '/device/cache/contribute', { source: { path }, dryRun: true });
    assertEqual(dry.statusCode, 200, '[consent] dry run without consent → 200');
    r.reads.length = 0;
    const cases: Array<{ label: string; body: Record<string, unknown>; error: string }> = [
      { label: 'no consent', body: { source: { path } }, error: 'not-consented' },
      { label: 'consent as a string', body: { source: { path }, consent: 'true', consentVersion: 2 }, error: 'not-consented' },
      { label: 'consent false', body: { source: { path }, consent: false, consentVersion: 2 }, error: 'not-consented' },
      { label: 'consent version 1 (account-only text)', body: { source: { path }, consent: true, consentVersion: 1 }, error: 'unsupported-consent-version' },
      { label: 'consent without a version', body: { source: { path }, consent: true }, error: 'unsupported-consent-version' },
      { label: 'dry run with consent v1', body: { source: { path }, consent: true, consentVersion: 1, dryRun: true }, error: 'unsupported-consent-version' }
    ];
    for (const c of cases) {
      const res = await postJson(r.app, '/device/cache/contribute', c.body);
      assertEqual(res.statusCode, 400, `[consent] ${c.label} → 400`);
      assertEqual(errorOf(res), c.error, `[consent] ${c.label}: error`);
    }
    const v1 = (await postJson(r.app, '/device/cache/contribute', { source: { path }, consent: true, consentVersion: 1 })).json() as { supported: number[] };
    assertEqual(JSON.stringify(v1.supported), '[2]', '[consent] the supported versions are named');
    // the octet-stream twin: flags in the query
    const q = await postBytes(r.app, FILE13, CACHE13.bytes, {});
    assertEqual(errorOf(q), 'not-consented', '[consent] bytes without consent → not-consented');
    const qv = await postBytes(r.app, FILE13, CACHE13.bytes, { consent: '1', consentVersion: '1' });
    assertEqual(errorOf(qv), 'unsupported-consent-version', '[consent] bytes with consent v1');
    assertEqual(r.reads.length, 0, '[consent] a refused request reads no file');
    // consent v2 without a cloud: everything local passes, then 503 cloud-disabled (nothing persisted)
    const nocloud = await postJson(r.app, '/device/cache/contribute', { source: { path }, consent: true, consentVersion: 2 });
    assertEqual(nocloud.statusCode, 503, '[consent] consent v2, no cloud → 503');
    assertEqual(JSON.stringify(nocloud.json()), JSON.stringify({ error: 'cloud-disabled', import: { skipped: 'not-requested' } }), '[consent] cloud-disabled carries the import sub-result');
    const d = store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY);
    assert(!d || d.deleted, '[consent] no decision persisted without an upload');
  } finally {
    await r.close();
  }
}

// ── 4. discovered-path allowlist ──
async function pathAllowlist(): Promise<void> {
  clean();
  const r = await rig();
  const outsideDir = mkdtempSync(join(tmpdir(), 'forgefx-contrib-outside-'));
  try {
    const outside = join(outsideDir, FILE13);
    writeFileSync(outside, CACHE13.bytes); // a valid cache: only the allowlist stops it
    for (const p of [outside, join(r.tree.dir, '..', '..', '..', '..', '..', '..', outsideDir.split(/[\\/]/).pop()!, FILE13), 'relative/' + FILE13]) {
      const res = await postJson(r.app, '/device/cache/contribute', { source: { path: p }, dryRun: true });
      assertEqual(res.statusCode, 400, `[allowlist] ${p} → 400`);
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: 'not-a-discovered-cache' }), '[allowlist] body');
    }
    assertEqual(r.reads.length, 0, '[allowlist] an undiscovered path is never read');
    assert(!r.tree.fsCalls.some((c) => c.includes(outsideDir)), '[allowlist] an undiscovered path is never stat-ed');
    const missing = await postJson(r.app, '/device/cache/contribute', { dryRun: true });
    assertEqual(errorOf(missing), 'invalid-request', '[allowlist] no source → 400 invalid-request');
    // a discovered path: read through the candidate's own path
    const ok = await postJson(r.app, '/device/cache/contribute', { source: { path: join(r.tree.dir, FILE13) }, dryRun: true });
    assertEqual(ok.statusCode, 200, '[allowlist] discovered path → 200');
    assertEqual(JSON.stringify(r.reads), JSON.stringify([join(r.tree.dir, FILE13)]), '[allowlist] read the candidate');
    // a discovered file larger than the cap is refused from its discovered size, never read
    const bigTree = makeTree();
    const bigReads: string[] = [];
    const fs0 = bigTree.discover.fs!;
    const bigApp = await buildApp(r.registry, {
      editorCaches: {
        discover: { ...bigTree.discover, fs: { ...fs0, statSync: (p) => (p.endsWith(FILE13) ? { size: MAX_CONTRIBUTION_BYTES + 1, mtimeMs: 1 } : fs0.statSync(p)) } },
        readFile: (p) => { bigReads.push(p); return readCandidateFile(p); }
      },
      contribute: { cloud: null, dryRun: false, dryRunDir: null }
    });
    try {
      const res = await postJson(bigApp, '/device/cache/contribute', { source: { path: join(bigTree.dir, FILE13) }, dryRun: true });
      assertEqual(res.statusCode, 413, '[allowlist] oversize candidate → 413');
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: 'too-large', bytes: MAX_CONTRIBUTION_BYTES + 1, limit: MAX_CONTRIBUTION_BYTES }), '[allowlist] 413 body');
      assertEqual(bigReads.length, 0, '[allowlist] the oversize file is never read');
    } finally {
      await bigApp.close();
      rmSync(bigTree.root, { recursive: true, force: true });
    }
    // the import route keeps its allowlist (FORGEFX-47)
    const imp = await postJson(r.app, '/device/cache/import', { path: outside });
    assertEqual(imp.statusCode, 400, '[allowlist] import of an undiscovered path → 400');
  } finally {
    await r.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
}

// ── 5. strict origin guard on all four routes ──
async function originGuard(): Promise<void> {
  clean();
  const r = await rig();
  try {
    const path = join(r.tree.dir, FILE13);
    const calls = () => [
      r.app.inject({ method: 'GET', url: '/device/cache/contribute', headers: { origin: 'https://evil.example' } }),
      postJson(r.app, '/device/cache/contribute', { source: { path }, consent: true, consentVersion: 2 }, { origin: 'https://evil.example' }),
      postBytes(r.app, FILE13, CACHE13.bytes, { consent: '1', consentVersion: '2' }, { origin: 'https://evil.example' }),
      postJson(r.app, '/device/cache/contribute/decision', { decision: 'declined' }, { origin: 'https://evil.example' }),
      postJson(r.app, '/device/cache/contribute/withdraw', {}, { origin: 'null' }),
      // same-origin is NOT enough on these routes (strict guard)
      postBytes(r.app, FILE13, CACHE13.bytes, { dryRun: '1' }, { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' })
    ];
    r.tree.fsCalls.length = 0;
    for (const res of await Promise.all(calls())) {
      assertEqual(res.statusCode, 403, '[origin] foreign origin → 403');
      assertEqual(JSON.stringify(res.json()), JSON.stringify({ error: 'forbidden-origin' }), '[origin] body');
    }
    assertEqual(r.tree.fsCalls.length, 0, '[origin] a refused request never reaches discovery');
    assertEqual(r.reads.length, 0, '[origin] a refused request reads no file');
    const d = store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY);
    assert(!d || d.deleted, '[origin] a refused decision is not stored');
    for (const origin of [undefined, 'http://localhost:5173', 'http://localhost:5056', 'http://127.0.0.1:5056']) {
      const h: Record<string, string> = origin ? { origin } : {};
      await status(r.app, h);
      const res = await postBytes(r.app, FILE13, CACHE13.bytes, { dryRun: '1' }, h);
      assertEqual(res.statusCode, 200, `[origin] ${String(origin)} → 200`);
    }
  } finally {
    await r.close();
  }
}

// ── 6. the dry-run copy on disk ──
async function dryRunCopy(): Promise<void> {
  clean();
  const out = mkdtempSync(join(tmpdir(), 'forgefx-contrib-dry-'));
  const r = await rig(FM3, [13, 0], { dryRun: undefined, dryRunDir: out });
  try {
    // the directory alone makes every request a dry run, even one with consent and no dryRun flag
    const res = await postJson(r.app, '/device/cache/contribute', { source: { path: join(r.tree.dir, FILE13) }, consent: true, consentVersion: 2 });
    assertEqual(res.statusCode, 200, '[dry-dir] 200');
    const b = res.json() as { dryRun: boolean; file: { sha256: string }; wouldSend: unknown };
    assertEqual(b.dryRun, true, '[dry-dir] a server-wide dry run');
    const cache = readFileSync(join(out, `${b.file.sha256}.cache`));
    const json = JSON.parse(readFileSync(join(out, `${b.file.sha256}.json`), 'utf8')) as unknown;
    assertEqual(cache.length, CACHE13.bytes.length, '[dry-dir] the copy keeps the size');
    assertEqual(sha256(cache), b.file.sha256, '[dry-dir] the copy is the hashed bytes');
    assertEqual(JSON.stringify(json), JSON.stringify(b.wouldSend), '[dry-dir] the json is the reserve body');
    assertNoNames(cache.toString('latin1') + cache.toString('utf8'), '[dry-dir] redacted copy');
    // differs from the original only inside the user name spans, and re-parses to the same structure
    const spans = parseCacheRecords(CACHE13.bytes, { nameSpans: true }).records
      .filter((x) => x.kind === 'enum' && isUserNameTable(x.id))
      .flatMap((x) => (x.kind === 'enum' ? [...(x.nameSpans ?? [])] : []));
    const inSpan = (i: number) => spans.some(([o, l]) => i >= o && i < o + l);
    let diffs = 0;
    for (let i = 0; i < cache.length; i++) if (cache[i] !== CACHE13.bytes[i]) { diffs++; assert(inSpan(i), `[dry-dir] byte 0x${i.toString(16)} changed outside a name span`); }
    assert(diffs > 0, '[dry-dir] names were blanked');
    const re = parseCacheRecords(new Uint8Array(cache));
    assertEqual(re.records.length, CACHE13.records, '[dry-dir] same record count after redaction');
    const d = store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY);
    assert(!d || d.deleted, '[dry-dir] no decision persisted');
  } finally {
    await r.close();
    rmSync(out, { recursive: true, force: true });
  }
}

// ── 7. decisions ──
async function decisions(): Promise<void> {
  clean();
  let r = await rig();
  try {
    const bad = await postJson(r.app, '/device/cache/contribute/decision', { decision: 'maybe' });
    assertEqual(bad.statusCode, 400, '[decision] unknown decision → 400');
    const badDays = await postJson(r.app, '/device/cache/contribute/decision', { decision: 'asked', days: 91 });
    assertEqual(badDays.statusCode, 400, '[decision] days > 90 → 400');
    const asked = await postJson(r.app, '/device/cache/contribute/decision', { decision: 'asked' });
    assertEqual(asked.statusCode, 200, '[decision] asked → 200');
    const a = asked.json() as { key: string; decision: { state: string; at: string; until: string } };
    assertEqual(a.key, KEY, '[decision] keyed by model + firmware');
    assertEqual(a.decision.state, 'asked', '[decision] asked');
    const days = (Date.parse(a.decision.until) - Date.parse(a.decision.at)) / 86400_000;
    assertEqual(days, 7, '[decision] snooze defaults to 7 days');
    let s = await status(r.app);
    assertEqual(s.reason, 'cloud-disabled', '[decision] cloud reasons come first');
    assertEqual(s.decision?.state, 'asked', '[decision] the status shows it');
    // expiry: a snooze set 8 days ago no longer blocks
    const past = Date.now() - 8 * 86400_000;
    await setContributionDecision(store.defaultStore, r.registry, { decision: 'asked', days: 7 }, { now: () => past });
    const fakeCloud = { hasAccountSession: () => false, editorCacheWanted: async () => true, editorCacheUpload: async () => ({ code: 500, body: {} }), editorCacheDelete: async () => ({ code: 500, body: {} }) };
    s = await contributionStatus(store.defaultStore, r.registry, fakeCloud, null);
    assertEqual(s.offer, true, '[decision] an expired snooze offers again');
    await setContributionDecision(store.defaultStore, r.registry, { decision: 'asked', days: 7 }, { now: () => Date.now() });
    s = await contributionStatus(store.defaultStore, r.registry, fakeCloud, null);
    assertEqual(`${s.offer}/${s.reason}`, 'false/asked', '[decision] a running snooze blocks');
    const declined = await postJson(r.app, '/device/cache/contribute/decision', { decision: 'declined' });
    assertEqual((declined.json() as { decision: { state: string } }).decision.state, 'declined', '[decision] declined');
    s = await contributionStatus(store.defaultStore, r.registry, fakeCloud, null);
    assertEqual(`${s.offer}/${s.reason}`, 'false/declined', '[decision] declined blocks');
    assertEqual(s.withdrawable, false, '[decision] nothing to withdraw');
  } finally {
    await r.close();
  }
  // persisted across a new registry on the same store
  r = await rig();
  try {
    const s = await status(r.app);
    assertEqual(s.decision?.state, 'declined', '[decision] survives a new registry');
    const reset = await postJson(r.app, '/device/cache/contribute/decision', { decision: 'reset' });
    assertEqual(JSON.stringify(reset.json()), JSON.stringify({ key: KEY, decision: null }), '[decision] reset → null');
    assertEqual((await status(r.app)).decision, null, '[decision] forgotten');
    // the doc holds no path and no name
    await postJson(r.app, '/device/cache/contribute/decision', { decision: 'declined' });
    const raw = JSON.stringify(store.defaultStore.getDoc(CONTRIBUTIONS_COLLECTION, KEY)?.data);
    assert(!raw.includes(r.tree.root) && !raw.includes('/'), '[decision] no path stored');
  } finally {
    clean();
    await r.close();
  }
  // no firmware → 503 firmware-unknown
  const nf = await rig(FM3, null);
  try {
    const res = await postJson(nf.app, '/device/cache/contribute/decision', { decision: 'declined' });
    assertEqual(`${res.statusCode} ${errorOf(res)}`, '503 firmware-unknown', '[decision] no firmware → 503');
  } finally { await nf.close(); }
}

// ── 8. status matrix ──
async function statusMatrix(): Promise<void> {
  clean();
  const r = await rig();
  try {
    const s = await status(r.app);
    assertEqual(s.supported, true, '[status] FM3 13.0 can contribute');
    assertEqual(JSON.stringify(s.device), JSON.stringify({ model: FM3, modelHex: '11', firmware: '13.0', key: KEY }), '[status] device');
    assertEqual(JSON.stringify(s.cloud), JSON.stringify({ enabled: false, signedIn: false, wanted: null, checkedAt: null }), '[status] no cloud');
    assertEqual(`${s.offer}/${s.reason}`, 'false/cloud-disabled', '[status] no cloud → no offer');
    assertEqual(s.localProfile, 'none', '[status] no local profile');
    assertEqual(s.discovery, 'ok', '[status] discovery ok');
    assertEqual(s.consentVersion, 2, '[status] consent version');
    assertEqual(s.candidates.map((c) => c.file).join(','), `${FILE13},effectDefinitions_11_11p0.cache,effectDefinitions_11_12p0.cache`, '[status] connected model only, exact first, then newest');
    const c0 = s.candidates[0]!;
    assertEqual(`${c0.editor} ${c0.fileVersion} ${c0.match} ${c0.size}`, `FM3-Edit 13.0 exact ${CACHE13.bytes.length}`, '[status] candidate fields');
    assertEqual(c0.path, join(r.tree.dir, FILE13), '[status] candidate path');
    assertEqual(s.candidates[1]!.match, 'firmware-differs', '[status] older file flagged');
    assertEqual(Object.keys(s).join(','), 'supported,device,cloud,decision,withdrawable,uploads,offer,reason,localProfile,discovery,candidates,consentVersion', '[status] key order');
    assertEqual(JSON.stringify(s.uploads), '[]', '[status] no uploads');
    // a coupled import (dry run) makes the local profile byte-exact
    const imp = await postBytes(r.app, FILE13, CACHE13.bytes, { dryRun: '1', import: '1' });
    assertEqual(JSON.stringify((imp.json() as { import: unknown }).import), JSON.stringify({ status: 200, imported: true, key: KEY }), '[status] dry run + import imports');
    assertEqual((await status(r.app)).localProfile, 'byte-exact', '[status] byte-exact after the import');
    // an import of a mismatched file is skipped, never forced
    const skip = await postBytes(r.app, 'effectDefinitions_11_12p0.cache', CACHE12.bytes, { dryRun: '1', import: '1', acceptFirmwareMismatch: '1' });
    assertEqual(JSON.stringify((skip.json() as { import: unknown }).import), JSON.stringify({ skipped: 'firmware-differs' }), '[status] mismatch import skipped');
  } finally {
    clean();
    await r.close();
  }
  const nf = await rig(FM3, null);
  try {
    const s = await status(nf.app);
    assertEqual(`${s.supported} ${s.reason} ${s.device?.key}`, 'false firmware-unknown null', '[status] no firmware');
    assert(s.candidates.every((c) => c.match === 'firmware-differs'), '[status] nothing matches an unknown firmware');
  } finally { await nf.close(); }
  const am4 = await rig(0x15, null);
  try {
    const s = await status(am4.app);
    assertEqual(`${s.supported} ${s.reason}`, 'false unsupported', '[status] AM4 unsupported');
    assertEqual(s.candidates.length, 0, '[status] no AM4 candidates in the tree');
  } finally { await am4.close(); }
}

// ── 9. router parity (Browser Direct): same shapes, bytes only, no discovery ──
async function routerParity(): Promise<void> {
  clean();
  const r = await rig();
  try {
    // the host passes its ForgeFX version stamp, as Axis Browser Direct does (the app reads package.json)
    const forgefx = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const router = createRouter({ registry: r.registry, store: store.defaultStore, versions: { forgefx } });
    const st = await router.handle('GET', '/device/cache/contribute');
    assertEqual(st.status, 200, '[router] status 200');
    const rs = JSON.parse(st.body as string) as ContributionStatus;
    const as = await status(r.app);
    assertEqual(rs.discovery, 'unavailable', '[router] no discovery');
    assertEqual(rs.candidates.length, 0, '[router] no candidates');
    const strip = (x: ContributionStatus) => ({ ...x, discovery: null, candidates: null });
    assertEqual(JSON.stringify(strip(rs)), JSON.stringify(strip(as)), '[router] same status otherwise');
    // bytes: identical answers (dry run; the consent gate; a refused file)
    const both = async (q: Record<string, string>, bytes: Uint8Array, name = FILE13) => {
      const a = await postBytes(r.app, name, bytes, q);
      const b = await router.handle('POST', `/device/cache/contribute?${new URLSearchParams({ name, ...q }).toString()}`, bytes);
      assertEqual(b.status, a.statusCode, `[router] ${JSON.stringify(q)}: status`);
      const strip2 = (s: string) => s.replace(/"consentAt":"[^"]+"/, '').replace(/"builtAt":"[^"]+"/, '');
      assertEqual(strip2(b.body as string), strip2(a.payload), `[router] ${JSON.stringify(q)}: body`);
    };
    await both({ dryRun: '1' }, CACHE13.bytes);
    await both({}, CACHE13.bytes);
    await both({ consent: '1', consentVersion: '1' }, CACHE13.bytes);
    await both({ consent: '1', consentVersion: '2' }, CACHE13.bytes); // no cloud on either: 503 cloud-disabled
    await both({ dryRun: '1' }, CACHE12.bytes, 'effectDefinitions_11_12p0.cache');
    // a path body: the server's allowlist answer (nothing is discovered in a browser)
    const p = await router.handle('POST', '/device/cache/contribute', JSON.stringify({ source: { path: join(r.tree.dir, FILE13) }, dryRun: true }));
    assertEqual(p.status, 400, '[router] path → 400');
    assertEqual(p.body, JSON.stringify({ error: 'not-a-discovered-cache' }), '[router] path body');
    // decisions + withdraw
    const d = await router.handle('POST', '/device/cache/contribute/decision', JSON.stringify({ decision: 'asked', days: 3 }));
    assertEqual(d.status, 200, '[router] decision 200');
    const w = await router.handle('POST', '/device/cache/contribute/withdraw');
    const wa = await postJson(r.app, '/device/cache/contribute/withdraw', {});
    assertEqual(`${w.status} ${w.body}`, `${wa.statusCode} ${wa.payload}`, '[router] withdraw parity (nothing to withdraw)');
  } finally {
    clean();
    await r.close();
  }
}

const CASES = [validationMatrix, previewNumbers, consentGate, pathAllowlist, originGuard, dryRunCopy, decisions, statusMatrix, routerParity];
export const CACHE_CONTRIBUTION_CASE_COUNT = CASES.length;

export async function runCacheContributionTests(): Promise<void> {
  const log = console.log;
  console.log = () => {}; // detection chatter
  try {
    for (const c of CASES) await c();
  } finally {
    console.log = log;
    clean();
  }
}
