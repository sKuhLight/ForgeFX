// `.axisdefs` export / import (M3 WP-F4) — mocked FM3, synthetic raw sources and canned block bodies only, NO hardware, no
// real cache bytes. The file is the applied profile's RAW sources in a checksummed envelope (services/definitionsFile.ts);
// an import validates it, merges its sources (always tagged `origin: 'file'`) into the document of its key and re-derives every
// table. Covers:
//   - canonical JSON and the sha256 (stable key order, JSON.stringify semantics, known digests), the file names;
//   - the strict raw-source validator on its own (services/rawValidation.ts): everything the codec produces passes and comes
//     back unchanged; every malformed shape names its path; unknown keys are dropped, prototype keys / non-finite numbers /
//     oversize values are refused;
//   - the export: envelope key order, no derived table anywhere, raw equal to the stored one, no user table, the checksum
//     recomputed independently, Content-Disposition (and the router twin's `headers`), no device traffic; 404 `no-profile`,
//     409 `profile-legacy` / `profile-stale`, 503 `no-device`, 501;
//   - the roundtrip (plan acceptance A8): export → DELETE /device/cache → drift `unprofiled` → import gives the same caps, the
//     same diff and the same generic params (apart from the provenance the file re-tags: `axisdefs` / origin `file`), sends
//     nothing to the device and emits SSE `definitions` (`imported`);
//   - every error code of contract §4.5 in its order (400 `invalid-file` incl. malformed raw shapes and prototype-poisoning
//     keys, 422 `unsupported-format` ×3, 422 `checksum-mismatch`, 422 `contains-user-data`, 409 `model-mismatch`, 409
//     `firmware-differs` and `?force=1`, 422 `derivation-failed`, 413 `too-large`, 501, 503) with nothing stored, identical
//     through the runtime-router twin;
//   - provenance: origins re-tagged whatever the file claims (no widened walk bounds), derived tables and unknown keys in
//     the file never reach the store, a flag inside the file is never read;
//   - merge (local sources kept, the file's own slot replaced on a re-import, `?replace=1`, legacy / newer docs, a stale doc);
//   - what never travels: the content hash and the issue byte offsets of an editor-cache source (export and import), a
//     source the validator would refuse is never exported, the validator pinned against the codec's own producers;
//   - hostile files: a non-canonical firmware spelling never drops local sources, records outside the declared sections /
//     walked blocks and over-long record lists are refused fast (the derivation's cost stays linear);
//   - guards: the strict origin guard on the import (foreign / null Origin, LAN peer → 403, nothing stored), the Remote relay
//     (export GET relays, import POST refused).
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import {
  CACHE_SCHEMA, RAW_FORMAT, isUserNameTable, rawFromCacheBytes, rawFromLiveWalk, sourceSummary,
  type BuiltCache, type CacheRecord, type EditorCacheRawSource, type LiveRawSource, type ProfileDoc, type RawSource
} from 'forgefx-midi/cache';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import type { DeviceProfile } from '../../src/devices.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import * as deviceCache from '../../src/services/deviceCache.js';
import { classifyProfile, loadStoredProfile } from '../../src/profileSchema.js';
import {
  AXISDEFS_MAX_BYTES, DERIVATION_FAILED_MESSAGE, attachmentHeader, axisdefsFilename, canonicalJson, parseAxisDefs, portableSource, profileChecksum,
  sha256Hex, type AxisDefsFile
} from '../../src/services/definitionsFile.js';
import { RAW_LIMITS, checkProfileRaw, checkRawSources, findUnsafeValue } from '../../src/services/rawValidation.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';
import { firmwareVersionReply } from '../helpers/api.js';
import { compactHex, blockBulkFrames, enc14, sysex } from '../helpers/blockRead.js';
import { catalogBuilt, syntheticBody } from '../helpers/catalogProfile.js';
import { encodeSections, groupBySection, header, pushCabTable, seedRecords as cacheSeedRecords } from '../helpers/cacheBytes.js';
import { NEWER_FIRMWARE_DIFF } from '../helpers/newerFirmware.js';
import { FM3, STAMP, SEED_BLOCKS, clone, editorCacheSource, familyRecords, liveSeedRecords, liveSource, profileDoc, walkResult } from '../helpers/profileDocs.js';
import { fakeChannelSession } from './remote.test.js';
import { RemoteHost } from '../../src/remote.js';

const CASES: Array<[string, () => void | Promise<void>]> = [
  ['canonical JSON, checksum, file names', canonicalAndNames],
  ['raw validator: codec output passes unchanged, malformed shapes name their path', rawValidator],
  ['export: envelope, no derived table, checksum, headers, router twin', exportShape],
  ['export: 404 / 409 / 501 / 503 gates, router twin', exportGates],
  ['roundtrip (A8): export, delete, import = same caps, diff and generic params; no device traffic; SSE', roundtrip],
  ['import errors in the contract order, nothing stored, router twin', importErrors],
  ['import: another firmware, ?force=1, unknown running firmware', importFirmware],
  ['import: origins re-tagged, derived tables and unknown keys never stored, flags in the file ignored', importProvenance],
  ['import: merge with local sources, replace, legacy / newer / stale docs', importMerge],
  ['import: body limit, 501 / 503 gates', importLimitsAndGates],
  ['raw validator against the codec\'s own producers: nothing is dropped silently', rawVsCodec],
  ['import: a firmware spelling never drops local sources; crafted files stay cheap', craftedFiles],
  ['import: strict origin guard, Remote relay', importGuards],
  ['cloud pull: the strict shape check refuses malformed raw sources', cloudPullValidation]
];
export const DEFINITIONS_FILE_CASE_COUNT = CASES.length;

const FW = '13.0';
const KEY = '11_13p0';
const EXPORT_URL = '/device/definitions/export';
const IMPORT_URL = '/device/definitions/import';
/** The seed families' first blocks: the blocks the generic params are compared on. */
const BLOCKS = Object.values(SEED_BLOCKS);

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Records of the invented new section (a block the catalog firmware lacks), as an editor-cache section. */
const newSectionRecords = (): CacheRecord[] => [...NEWER_FIRMWARE_DIFF.newSection.records(NEWER_FIRMWARE_DIFF.newSection.tag)];

/** Three raw sources on firmware 13.0: an editor cache (the seed families plus the invented section), a live read-only walk
 *  that read device units, and a probe of the placed block the invented section belongs to. All local. */
async function sources13(origin: 'local' | 'cloud' | 'file' = 'local'): Promise<RawSource[]> {
  const editor = await editorCacheSource([...cacheSeedRecords(), ...newSectionRecords()], { firmware: FW, origin });
  const live = liveSource(liveSeedRecords({ unit: 'dB' }), { firmware: FW, capturedAt: '2026-11-22T10:30:00.000Z', origin });
  const probeRecords = NEWER_FIRMWARE_DIFF.newSection.records(NEWER_FIRMWARE_DIFF.probedEid);
  const probe = rawFromLiveWalk(
    walkResult(probeRecords),
    { blocks: [NEWER_FIRMWARE_DIFF.probedEid], maxParamId: 36, bounds: {}, extended: false, above160: true, hinted: false },
    { kind: 'live-probe', capturedAt: '2026-11-22T11:00:00.000Z', firmware: FW, origin }
  );
  return [editor, live, probe];
}

/** A complete `.axisdefs` file for `sources`, sealed by the module's own checksum (independent of the export route). */
async function makeFile(sources: readonly RawSource[], o: { model?: number; firmware?: string } = {}): Promise<AxisDefsFile> {
  const model = o.model ?? FM3;
  const firmware = o.firmware ?? FW;
  const [major, minor] = firmware.split('.');
  const profile = { meta: { schema: CACHE_SCHEMA, format: 2 as const, sources: sources.map((s) => sourceSummary(s)) }, raw: { format: RAW_FORMAT as 1, sources: [...sources] } };
  return {
    kind: 'axis-device-definitions', version: 1, model, firmware, key: `${model.toString(16).padStart(2, '0')}_${major}p${minor}`,
    exportedAt: STAMP, app: { engine: 'test', codec: 'test' }, profile: clone(profile), sha256: (await profileChecksum(profile))!
  };
}

/** Seal a (mutated) file again: the checksum over its profile as it is now. */
async function reseal(file: { profile: unknown; sha256: string }): Promise<void> {
  file.sha256 = (await profileChecksum(file.profile))!;
}

type Json = Record<string, unknown>;

/** `assertEqual` over two strings that may be big (a file, a stored document): a failure names the first difference only. */
function assertSame(actual: string, expected: string, msg: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  throw new Error(`${msg}: first difference at ${i}: expected …${expected.slice(Math.max(0, i - 30), i + 90)}… got …${actual.slice(Math.max(0, i - 30), i + 90)}…`);
}

interface Rig {
  app: Awaited<ReturnType<typeof buildApp>>;
  registry: DeviceRegistry;
  mock: MockTransport;
  router: ReturnType<typeof createRouter>;
  events: DeviceEvent[];
  /** The profile the mocked unit's block bodies are shaped by (set once, before any read). */
  bodyProfile: { current: DeviceProfile | null };
  importedEvents: () => DeviceEvent[];
  close: () => Promise<void>;
}

/** A detected unit of `model` (default FM3) whose firmware reply is `fw` (null: a silent unit), the Fastify app and the
 *  runtime-router twin over one registry and the default store; answers the status dump and the bulk reads of `BLOCKS`. */
async function makeRig(o: { model?: number; fw?: readonly [number, number] | null; connected?: boolean } = {}): Promise<Rig> {
  const model = o.model ?? FM3;
  const fw = o.fw === undefined ? [13, 0] as const : o.fw;
  const mock = new MockTransport('serial', `mock-0x${model.toString(16)}`);
  const bodyProfile: Rig['bodyProfile'] = { current: null };
  // only the gen-3 grid units answer block reads (an AM4 rig needs no codec)
  const gen3 = model === 0x10 || model === 0x11 || model === 0x12;
  const codec = gen3 ? createModernFractalCodec(model) : null;
  const statusHex = codec ? compactHex(codec.buildStatusDump()) : '';
  const polls = new Map(codec ? BLOCKS.map((eid) => [compactHex(codec.buildBlockBulkReadPoll(eid)), eid] as const) : []);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model)];
    if (fw && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model, fw[0], fw[1])];
    const h = compactHex(req);
    if (statusHex && h === statusHex) return [sysex(model, 0x13, BLOCKS.flatMap((eid) => [...enc14(eid), 0]))];
    const eid = polls.get(h);
    if (eid !== undefined && bodyProfile.current) return blockBulkFrames(model, eid, syntheticBody(bodyProfile.current, eid));
    return [];
  };
  const registry = __createRegistryForTest({
    resolveConn: async () => (o.connected === false ? null : { transport: 'serial', id: mock.label }),
    openConn: () => mock
  });
  if (o.connected !== false) await registry.detect();
  const app = await buildApp(registry);
  const router = createRouter({ registry: registry as DeviceRegistry, store: store.defaultStore, versions: { forgefx: 'test-engine', codec: 'test-codec' } });
  const events: DeviceEvent[] = [];
  const unsub = registry.subscribe((e) => events.push(e));
  const resume = registry.pauseTelemetry(); // no telemetry frame may blur the traffic counts
  return {
    app, registry: registry as DeviceRegistry, mock, router, events, bodyProfile,
    importedEvents: () => events.filter((e) => e.type === 'definitions' && e.reason === 'imported'),
    close: async () => { resume(); unsub(); await app.close(); }
  };
}

const KEYS = [KEY, '11_14p0', '11_12p0', '12_13p0'];
const clearDocs = () => { for (const k of KEYS) store.defaultStore.delDoc('deviceCaches', k); };
const putDoc = (key: string, data: unknown) => store.defaultStore.putDoc('deviceCaches', key, data);
const storedDoc = (key = KEY): ProfileDoc | null => { const d = store.defaultStore.getDoc('deviceCaches', key); return d && !d.deleted ? (d.data as ProfileDoc) : null; };
const originsOf = (doc: ProfileDoc | null) => (doc?.raw?.sources ?? []).map((s) => `${s.kind}/${s.origin}`).join(',');

interface Answer { status: number; text: string; json: Json; headers: Record<string, string> }
const viaApp = async (r: Rig, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}, remoteAddress?: string): Promise<Answer> => {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await r.app.inject({
    method, url, ...(remoteAddress ? { remoteAddress } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { payload } : {})
  });
  return { status: res.statusCode, text: res.payload, json: (res.payload.startsWith('{') ? JSON.parse(res.payload) : {}) as Json, headers: res.headers as Record<string, string> };
};
const viaRouter = async (r: Rig, method: string, url: string, body?: unknown): Promise<Answer> => {
  const res = await r.router.handle(method, url, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  const text = res.body as string;
  return { status: res.status, text, json: (text.startsWith('{') ? JSON.parse(text) : {}) as Json, headers: res.headers ?? {} };
};

/** Run a request through both twins against the same state: same status and body. Returns the app's answer. */
async function both(r: Rig, method: 'GET' | 'POST', url: string, body: unknown, label: string): Promise<Answer> {
  const a = await viaApp(r, method, url, body);
  const b = await viaRouter(r, method, url, body);
  assertEqual(b.status, a.status, `${label}: router status = app status`);
  assertSame(b.text, a.text, `${label}: router body = app body`);
  return a;
}

/** The file text of the stored doc of `key`, exported through the route. */
async function exportText(r: Rig): Promise<string> {
  const x = await viaApp(r, 'GET', EXPORT_URL);
  assertEqual(x.status, 200, 'export: 200');
  return x.text;
}

/** A file made by the route from a stored `sources13` doc (state left empty afterwards). */
async function exportedFile(r: Rig): Promise<AxisDefsFile> {
  putDoc(KEY, profileDoc(await sources13(), { firmware: FW }));
  await r.registry.applyRuntimeCache();
  const file = JSON.parse(await exportText(r)) as AxisDefsFile;
  clearDocs();
  await r.registry.applyRuntimeCache();
  return file;
}

const importResult = (a: Answer) => `${a.status} ${String(a.json.error ?? 'ok')}`;

// ── 1. canonical JSON, checksum, names ─────────────────────────────────────────────────────────────────────────────

async function canonicalAndNames(): Promise<void> {
  // key order, no whitespace, JSON.stringify's escapes and numbers
  assertEqual(canonicalJson({ b: 1, a: [3, { d: null, c: true }], 'é': 'x\n"', Z: 0 }), '{"Z":0,"a":[3,{"c":true,"d":null}],"b":1,"é":"x\\n\\""}', 'sorted keys, escapes');
  assertEqual(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }), 'insertion order is irrelevant');
  assertEqual(canonicalJson({ a: undefined, b: [undefined, 1], c: () => 1 }), '{"b":[null,1]}', 'undefined / function: omitted in an object, null in an array');
  assertEqual(canonicalJson([NaN, Infinity, -0, 1e21, 0.1, -1.5e-7]), '[null,null,0,1e+21,0.1,-1.5e-7]', 'numbers as JSON.stringify writes them, non-finite as null');
  assertEqual(canonicalJson(' '), JSON.stringify(' '), 'strings as JSON.stringify writes them');
  assertEqual(canonicalJson({ '10': 1, '9': 2, a: 3 }), '{"10":1,"9":2,"a":3}', 'keys by UTF-16 code units, not numerically');
  // a JSON write/read of a value does not change it
  const v = { z: [1, { y: 2.5, x: 'q' }], a: { b: [0.1, -3], c: null }, n: 1e-7 };
  assertEqual(canonicalJson(JSON.parse(JSON.stringify(v))), canonicalJson(v), 'canonical JSON survives a JSON round trip');
  assertEqual(canonicalJson(JSON.parse(JSON.stringify(v, null, 2))), canonicalJson(v), 'and a pretty-printed one');

  // sha256: known digests, and the same as node:crypto over the canonical text
  assertEqual(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc")');
  assertEqual(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("")');
  assertEqual(await sha256Hex('é'), createHash('sha256').update('é', 'utf8').digest('hex'), 'sha256 over UTF-8');
  assertEqual(await profileChecksum(v), createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex'), 'profileChecksum = sha256(canonicalJson)');

  // file names and the header
  assertEqual(axisdefsFilename(0x11, '13.0'), 'fm3-13.0.axisdefs', 'FM3 file name');
  assertEqual(axisdefsFilename(0x12, '12.2'), 'fm9-12.2.axisdefs', 'FM9 file name');
  assertEqual(axisdefsFilename(0x10, '32.6'), 'axe3-32.6.axisdefs', 'Axe-Fx III file name');
  assertEqual(attachmentHeader('fm3-13.0.axisdefs'), 'attachment; filename="fm3-13.0.axisdefs"', 'Content-Disposition');
  assertEqual(attachmentHeader('a"b\r\nc.axisdefs'), 'attachment; filename="a_b__c.axisdefs"', 'a header value cannot be broken out of');
}

// ── 2. the raw validator ────────────────────────────────────────────────────────────────────────────────────────────

/** A full-mode walk source with every optional field the types allow: a unit on every row, a taper, a placeholder slot, an enum
 *  with wire ids, scope bounds and id lists, bound hits, reply statistics, an extension outcome and its abort reason. */
function fullLiveSource(): LiveRawSource {
  const taperRecord: CacheRecord = {
    kind: 'float', section: 58, offset: 0, id: 3, tc: 0x32, min: 0, max: 10, def: 5, step: 0.01, unit: 'dB', t1: 0, t2: 0,
    taper: { shape: 'custom', err: null, reliable: true, points: [[0, 0], [0.5, 3.25], [1, 10]] }
  };
  const enumRecord: CacheRecord = { kind: 'enum', section: 58, offset: 0, id: 4, tc: 0x10, min: 0, max: 2, def: 0, step: 0, count: 3, values: ['A', 'B', 'C'], x: 7, wireIds: [1, 2, 4294967295] };
  const placeholder: CacheRecord = { kind: 'float', section: 58, offset: 0, id: 5, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true };
  return rawFromLiveWalk(
    { ...walkResult([...liveSeedRecords({ unit: 'ms' }), taperRecord, enumRecord, placeholder]), boundHits: [{ block: 58, lastReal: 120, bound: 127 }] },
    { blocks: [58, 62, 66, 70, 118], maxParamId: 127, bounds: { 58: 175, 62: 127 }, idLists: { 58: [128, 129, 140] }, extended: true, above160: false, hinted: true },
    { kind: 'live-full', capturedAt: STAMP, firmware: FW, extension: 'aborted', abortReason: 'a reply was lost' }
  );
}

async function rawValidator(): Promise<void> {
  // everything the codec produces — editor cache (with tolerant-walk issues), live read-only with units, a full-mode walk
  // with tapers, scope id lists and bound hits, a probe — passes and comes back unchanged
  const full = fullLiveSource();
  const editor = { ...(await editorCacheSource(cacheSeedRecords(), { firmware: FW })), issues: [{ section: 7, record: null, offset: 90, reason: 'BAD-PAD', droppedRecords: 3, skippedBytes: 44, resumedAt: null }] };
  const all = [editor, full, ...(await sources13()).slice(2)] as RawSource[];
  const input = clone({ format: 1, sources: all });
  const ok = checkProfileRaw(input);
  assert(ok.ok, `codec output passes (${ok.ok ? '' : `${ok.path}: ${ok.message}`})`);
  assertEqual(JSON.stringify(sortKeys(ok.ok ? ok.raw : null)), JSON.stringify(sortKeys(input)), 'and comes back unchanged');
  const list = checkRawSources(clone(all));
  assert(list.ok && list.sources.length === 3, 'checkRawSources: the same for a bare list');

  // malformed shapes: refused, the path names the field
  const base = () => clone({ format: 1, sources: [full, editor] }) as { format: number; sources: Array<Record<string, any>> };
  const refuse = (label: string, mutate: (raw: ReturnType<typeof base>) => void, path: string): void => {
    const raw = base();
    mutate(raw);
    const r = checkProfileRaw(raw);
    assert(!r.ok, `${label}: refused`);
    if (!r.ok) assert(r.path === path, `${label}: path ${r.path} (expected ${path}) — ${r.message}`);
  };
  const rec0 = 'raw.sources[0].records[0]';
  refuse('record id above u16', (r) => { r.sources[0]!.records[0].id = 70000; }, `${rec0}.id`);
  refuse('record id negative', (r) => { r.sources[0]!.records[0].id = -1; }, `${rec0}.id`);
  refuse('record id fractional', (r) => { r.sources[0]!.records[0].id = 1.5; }, `${rec0}.id`);
  refuse('record id a string', (r) => { r.sources[0]!.records[0].id = '5'; }, `${rec0}.id`);
  refuse('record kind unknown', (r) => { r.sources[0]!.records[0].kind = 'banana'; }, `${rec0}.kind`);
  refuse('record min null', (r) => { r.sources[0]!.records[0].min = null; }, `${rec0}.min`);
  refuse('record max above f32', (r) => { r.sources[0]!.records[0].max = 1e300; }, `${rec0}.max`);
  refuse('record t1 missing', (r) => { delete r.sources[0]!.records[0].t1; }, `${rec0}.t1`);
  refuse('record unit too long', (r) => { r.sources[0]!.records[0].unit = 'u'.repeat(RAW_LIMITS.unit + 1); }, `${rec0}.unit`);
  refuse('taper shape unknown', (r) => { r.sources[0]!.records.find((x: Json) => x.taper).taper.shape = 'wavy'; }, 'raw.sources[0].records[' + base().sources[0]!.records.findIndex((x: Json) => x.taper) + '].taper.shape');
  refuse('enum values not an array', (r) => { const i = r.sources[0]!.records.findIndex((x: Json) => x.kind === 'enum'); r.sources[0]!.records[i].values = 'ABC'; }, `raw.sources[0].records[${base().sources[0]!.records.findIndex((x: Json) => x.kind === 'enum')}].values`);
  refuse('enum label not a string', (r) => { const i = r.sources[0]!.records.findIndex((x: Json) => x.kind === 'enum'); r.sources[0]!.records[i].values[1] = 2; }, `raw.sources[0].records[${base().sources[0]!.records.findIndex((x: Json) => x.kind === 'enum')}].values[1]`);
  refuse('enum label too long', (r) => { const i = r.sources[0]!.records.findIndex((x: Json) => x.kind === 'enum'); r.sources[0]!.records[i].values[0] = 'x'.repeat(RAW_LIMITS.label + 1); }, `raw.sources[0].records[${base().sources[0]!.records.findIndex((x: Json) => x.kind === 'enum')}].values[0]`);
  refuse('wire id negative', (r) => { const i = r.sources[0]!.records.findIndex((x: Json) => x.wireIds); r.sources[0]!.records[i].wireIds[0] = -4; }, `raw.sources[0].records[${base().sources[0]!.records.findIndex((x: Json) => x.wireIds)}].wireIds[0]`);
  refuse('source kind unknown', (r) => { r.sources[0]!.kind = 'live-everything'; }, 'raw.sources[0].kind');
  refuse('source origin unknown', (r) => { r.sources[0]!.origin = 'moon'; }, 'raw.sources[0].origin');
  refuse('source id empty', (r) => { r.sources[0]!.id = ''; }, 'raw.sources[0].id');
  refuse('source id with a control character', (r) => { r.sources[0]!.id = 'live\nsource'; }, 'raw.sources[0].id');
  refuse('source firmware a number', (r) => { r.sources[0]!.firmware = 13; }, 'raw.sources[0].firmware');
  refuse('live source with the editor-cache space', (r) => { r.sources[0]!.space = 'section'; }, 'raw.sources[0].space');
  refuse('editor-cache source with the live space', (r) => { r.sources[1]!.space = 'block'; }, 'raw.sources[1].space');
  refuse('records not an array', (r) => { r.sources[0]!.records = {}; }, 'raw.sources[0].records');
  refuse('scope bound key negative', (r) => { r.sources[0]!.scope.bounds['-1'] = 3; }, 'raw.sources[0].scope.bounds["-1"]');
  refuse('scope bound above u16', (r) => { r.sources[0]!.scope.bounds['58'] = 70000; }, 'raw.sources[0].scope.bounds[58]');
  refuse('scope flag not a boolean', (r) => { r.sources[0]!.scope.extended = 1; }, 'raw.sources[0].scope.extended');
  refuse('walk statistic negative', (r) => { r.sources[0]!.walk.queries = -1; }, 'raw.sources[0].walk.queries');
  refuse('walk extension unknown', (r) => { r.sources[0]!.walk.extension = 'maybe'; }, 'raw.sources[0].walk.extension');
  refuse('section tag above u16', (r) => { r.sources[1]!.sections = [{ tag: 99999, count: 1 }]; }, 'raw.sources[1].sections[0].tag');
  refuse('content hash not a sha256', (r) => { r.sources[1]!.contentSha256 = 'ABC'; }, 'raw.sources[1].contentSha256');
  refuse('raw format not 1', (r) => { r.format = 2; }, 'raw.format');
  refuse('too many sources', (r) => { r.sources = Array.from({ length: RAW_LIMITS.sources + 1 }, () => clone(r.sources[0])); }, 'raw.sources');
  refuse('too many records in one source', (r) => { r.sources = [r.sources[0]!]; r.sources[0]!.records = Array.from({ length: RAW_LIMITS.totalRecords + 1 }, () => clone(r.sources[0]!.records[0])); }, 'raw.sources');
  refuse('too many enum labels', (r) => { const i = r.sources[0]!.records.findIndex((x: Json) => x.kind === 'enum'); r.sources[0]!.records[i].values = Array.from({ length: RAW_LIMITS.enumValues + 1 }, () => 'x'); }, `raw.sources[0].records[${base().sources[0]!.records.findIndex((x: Json) => x.kind === 'enum')}].values`);

  // structure the derivation's cost depends on: records only in declared sections / walked blocks, a bounded total, one
  // spelling of a firmware
  refuse('an editor-cache record in an undeclared section', (r) => { r.sources[1]!.records[0].section = 999; }, 'raw.sources[1].records[0].section');
  refuse('a live record in a block the source did not walk', (r) => { r.sources[0]!.records[0].section = 999; }, `${rec0}.section`);
  refuse('a section declared twice', (r) => { r.sources[1]!.sections.push({ ...r.sources[1]!.sections[0] }); }, `raw.sources[1].sections[${base().sources[1]!.sections.length}].tag`);
  refuse('records over the total of all sources', (r) => {
    for (const i of [0, 1]) r.sources[i]!.records = Array.from({ length: RAW_LIMITS.totalRecords / 2 + 1 }, () => clone(r.sources[i]!.records[0]));
  }, 'raw.sources');
  for (const fw of ['13.00', '013.0', ' 13.0', '13.0 ', '13.0.1', '13', 'v13.0', '13.-1']) {
    refuse(`source firmware ${JSON.stringify(fw)}`, (r) => { r.sources[0]!.firmware = fw; }, 'raw.sources[0].firmware');
  }
  refuse('cache header major above u32', (r) => { r.sources[1]!.header.major = 2 ** 32; }, 'raw.sources[1].header.major');
  const maxHeader = base();
  maxHeader.sources[1]!.header = { major: 4294967295, minor: 4294967295, sectionCount: 4294967295 };
  assert(checkProfileRaw(maxHeader).ok, 'a cache header of u32 values passes (the codec reads u32)');
  const atLimit = base();
  for (const i of [0, 1]) atLimit.sources[i]!.records = Array.from({ length: RAW_LIMITS.totalRecords / 2 }, () => clone(atLimit.sources[i]!.records[0]));
  assert(checkProfileRaw(atLimit).ok, 'exactly the record total passes');

  // unknown keys are dropped (never copied into what is stored), known ones keep their place
  const extra = base();
  extra.sources[0]!.records[0].extra = { deep: [1, 2] };
  extra.sources[0]!.mystery = 'x';
  const dropped = checkProfileRaw(extra);
  assert(dropped.ok, 'unknown keys do not refuse the raw');
  assertEqual(JSON.stringify(sortKeys(dropped.ok ? dropped.raw : null)), JSON.stringify(sortKeys(base())), 'and are dropped from the copy');

  // stage 1: prototype keys, non-finite numbers, unbounded or non-JSON values — anywhere, also under unknown keys
  const poisoned = JSON.parse('{"format":1,"sources":[],"x":{"__proto__":{"polluted":true}}}') as unknown;
  const p = checkProfileRaw(poisoned);
  assert(!p.ok && p.message === 'forbidden key', '__proto__ refused');
  assert(!checkProfileRaw(JSON.parse('{"format":1,"sources":[],"constructor":{"prototype":{}}}')).ok, 'constructor refused');
  assert(!checkProfileRaw({ format: 1, sources: [], prototype: 1 }).ok, 'prototype refused');
  assert(!checkProfileRaw(JSON.parse('{"format":1,"sources":[{"records":[{"min":1e999}]}]}')).ok, 'a number JSON.parse turned into Infinity is refused');
  assertEqual(findUnsafeValue(JSON.parse('{"a":[1,{"b":1e999}]}'))?.path, 'value.a[1].b', 'the path of a non-finite number');
  assertEqual(findUnsafeValue({ a: new Date() })?.message, 'not a plain object', 'a Date is not JSON data');
  assertEqual(findUnsafeValue({ a: new Map() })?.message, 'not a plain object', 'a Map is not JSON data');
  assertEqual(findUnsafeValue({ a: undefined })?.message, 'not JSON data (undefined)', 'undefined is not JSON data');
  assertEqual(findUnsafeValue({ a: 10n })?.message, 'not JSON data (bigint)', 'bigint is not JSON data');
  assertEqual(findUnsafeValue({ s: 'x'.repeat(RAW_LIMITS.string + 1) })?.path, 'value.s', 'an oversize string');
  assertEqual(findUnsafeValue({ s: 'x'.repeat(RAW_LIMITS.string) }), null, 'a string at the limit');
  let deep: unknown = 1;
  for (let i = 0; i < RAW_LIMITS.depth + 5; i++) deep = { d: deep };
  assert(findUnsafeValue(deep)?.message.startsWith('nested deeper'), 'a deeply nested value is refused without recursing into it');
  assertEqual(findUnsafeValue(Object.assign(Object.create(null), { a: 1 })), null, 'a null-prototype object is plain data');
}

// ── 3. export ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function exportShape(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    const stamped = await sources13();
    const withIssues = stamped[0] as EditorCacheRawSource;
    withIssues.issues = [{ section: 7, record: 2, offset: 90, reason: 'BAD-PAD id=0x5', droppedRecords: 3, skippedBytes: 44, resumedAt: 120 }];
    const storedHash = withIssues.contentSha256;
    assert(typeof storedHash === 'string' && storedHash.length === 64, 'fixture: the stored editor-cache source carries its content hash');
    const doc = profileDoc(stamped, { firmware: FW });
    putDoc(KEY, doc);
    await r.registry.applyRuntimeCache();
    const sent = r.mock.sent.length;
    const a = await viaApp(r, 'GET', EXPORT_URL);
    assertEqual(a.status, 200, 'export: 200');
    assertEqual(a.headers['content-disposition'], 'attachment; filename="fm3-13.0.axisdefs"', 'Content-Disposition names the file');
    assert(String(a.headers['content-type']).startsWith('application/json'), 'application/json');
    const file = JSON.parse(a.text) as AxisDefsFile;
    assertEqual(Object.keys(file).join(','), 'kind,version,model,firmware,key,exportedAt,app,profile,sha256', 'envelope key order');
    assertEqual(`${file.kind} ${file.version} ${file.model} ${file.firmware} ${file.key}`, `axis-device-definitions 1 ${FM3} ${FW} ${KEY}`, 'identity');
    assert(!Number.isNaN(Date.parse(file.exportedAt)), 'exportedAt is a date');
    assertEqual(Object.keys(file.app).join(','), 'engine,codec', 'app: engine and codec');
    assert(typeof file.app.engine === 'string' && file.app.engine.length > 0, 'app.engine: the ForgeFX version');
    assertEqual(file.app.codec, doc.meta.derivedWith, 'app.codec: the codec that derived the document');
    // the raw sources only: nothing derived, not even a stamp the importer would trust
    assertEqual(Object.keys(file.profile).join(','), 'meta,raw', 'profile = meta + raw, no derived table');
    assertEqual(Object.keys(file.profile.meta).join(','), 'schema,format,sources', 'meta = schema, format, sources');
    assertEqual(file.profile.meta.format, 2, 'format 2');
    assertEqual(file.profile.meta.schema, CACHE_SCHEMA, 'the current schema stamp');
    assertEqual(Object.keys(file.profile.raw).join(','), 'format,sources', 'raw envelope');
    // the stored sources as they travel: the same, apart from the editor cache's content hash and the issue byte offsets
    const expectedRaw = { format: 1, sources: clone(doc.raw.sources).map(portableSource) };
    assertSame(JSON.stringify(sortKeys(file.profile.raw)), JSON.stringify(sortKeys(expectedRaw)), 'raw = the stored raw sources (portable form; the validator writes the fields in the codec order)');
    assertEqual(JSON.stringify(file.profile.meta.sources), JSON.stringify(doc.raw.sources.map((s) => sourceSummary(s))), 'meta.sources = the summaries of the sources');
    const fileEditor = file.profile.raw.sources[0] as EditorCacheRawSource;
    assertEqual(fileEditor.contentSha256, null, 'no content hash in the file (a stable per-unit fingerprint)');
    assert(!a.text.includes(storedHash!), 'the stored hash is nowhere in the file');
    assertEqual(JSON.stringify(fileEditor.issues), JSON.stringify([{ section: 7, record: 2, offset: 0, reason: 'BAD-PAD id=0x5', droppedRecords: 3, skippedBytes: 0, resumedAt: null }]), 'the issues keep their section, record, reason and count; the byte offsets are zeroed');
    assertEqual(fileEditor.capturedAt, doc.raw.sources[0]!.capturedAt, 'capturedAt is kept');
    assertEqual((storedDoc()!.raw.sources[0] as EditorCacheRawSource).contentSha256, storedHash, 'the stored document keeps its own hash');
    const own = await parseAxisDefs(JSON.parse(a.text));
    assert(own.ok, `the export passes this build's own import validation (${own.ok ? '' : JSON.stringify(own.body).slice(0, 200)})`);
    // (`sections` is no derived table here: an editor-cache source lists the declared record count of each of its sections)
    for (const derived of ['ranges', 'enumOverrides', 'rosters', 'cabIrs', 'blockMap', 'provenance', 'coverage', 'rangeSections', 'unmappedSections']) {
      assert(!a.text.includes(`"${derived}":`), `no derived table (${derived}) in the file`);
    }
    // no user content: the privacy guard of the codec finds no user table, and the file holds none
    for (const s of file.profile.raw.sources) for (const rec of s.records) assert(!isUserNameTable(rec.id), 'no user name table in the file');
    // the checksum, recomputed independently of the module (node:crypto over the documented canonical text)
    const canon = JSON.stringify(sortKeys(file.profile));
    assertEqual(file.sha256, createHash('sha256').update(canon, 'utf8').digest('hex'), 'sha256 = sha256(canonical JSON of profile)');
    assertEqual(file.sha256, await profileChecksum(file.profile), 'and the module agrees');
    assertEqual(r.mock.sent.length, sent, 'the export sends nothing to the device');
    // the stored doc is untouched (a GET writes nothing)
    assertSame(JSON.stringify(storedDoc()), JSON.stringify(doc), 'the stored document is unchanged');

    // router twin: same body (the export time apart), the file name in `headers`
    const b = await viaRouter(r, 'GET', EXPORT_URL);
    assertEqual(b.status, 200, 'router: 200');
    assertEqual(b.headers['content-disposition'], 'attachment; filename="fm3-13.0.axisdefs"', 'router: content-disposition header');
    const bf = JSON.parse(b.text) as AxisDefsFile;
    assertSame(JSON.stringify({ ...bf, exportedAt: '', app: { ...bf.app, engine: '' } }), JSON.stringify({ ...file, exportedAt: '', app: { ...file.app, engine: '' } }), 'router: the same file (the export time and the host\'s engine version apart)');
    assertEqual(bf.app.codec, file.app.codec, 'router: the same codec stamp as the Fastify route (the codec that derived the doc, not a host option)');
    assertEqual(bf.app.engine, 'test-engine', 'router: the engine version of the runtime deps');
    assert(a.text.length > 3_000, `a real export is not tiny (${a.text.length} chars)`);
  } finally { clearDocs(); await r.close(); }
}

/** `JSON.stringify` with every object's keys sorted (the independent canonical form the checksum is checked against). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Json)[k])]));
  return v;
}

async function exportGates(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    // nothing stored
    let x = await both(r, 'GET', EXPORT_URL, undefined, 'nothing stored');
    assertEqual(importResult(x), '404 no-profile', 'nothing stored: 404 no-profile');
    // a legacy (format-1) doc: nothing raw to export
    putDoc(KEY, catalogBuilt(FM3, 'editor-cache'));
    await r.registry.applyRuntimeCache();
    x = await both(r, 'GET', EXPORT_URL, undefined, 'legacy');
    assertEqual(importResult(x), '409 profile-legacy', 'format 1: 409 profile-legacy');
    assert(typeof x.json.message === 'string' && String(x.json.message).includes('re-import'), 'the message says what to do');
    // a legacy doc of an old schema is legacy too (nothing raw), not "stale"
    const old = clone(catalogBuilt(FM3, 'editor-cache')) as BuiltCache;
    (old.meta as { schema?: number }).schema = 0;
    putDoc(KEY, old);
    x = await both(r, 'GET', EXPORT_URL, undefined, 'old legacy');
    assertEqual(importResult(x), '409 profile-legacy', 'an outdated format-1 doc: 409 profile-legacy');
    // a format-2 doc this build cannot derive: stale
    const broken = clone(profileDoc([liveSource(liveSeedRecords(), { firmware: FW })], { firmware: FW })) as unknown as { raw: { sources: unknown[] }; meta: Record<string, unknown> };
    broken.meta.derivedRevision = 0;
    broken.raw.sources.push(clone(broken.raw.sources[0])); // two sources with one id: the codec refuses to derive
    putDoc(KEY, broken);
    x = await both(r, 'GET', EXPORT_URL, undefined, 'stale');
    assertEqual(importResult(x), '409 profile-stale', 'a doc that does not derive: 409 profile-stale');
    assertEqual(`${x.json.stale} ${x.json.staleReason}`, 'true derivation-failed', 'with the stale fields');
    // raw sources of a newer format: unreadable
    const newer = clone(profileDoc(await sources13(), { firmware: FW })) as unknown as { raw: { format: number } };
    newer.raw.format = 2;
    putDoc(KEY, newer);
    x = await both(r, 'GET', EXPORT_URL, undefined, 'newer raw');
    assertEqual(importResult(x), '409 profile-unreadable', 'newer raw format: 409 profile-unreadable');
    // raw sources this build's own validator would refuse (a record outside its source's declared sections): no file is written
    const odd = clone(profileDoc(await sources13(), { firmware: FW })) as unknown as ProfileDoc;
    (odd.raw.sources[0] as EditorCacheRawSource).records[0]!.section = 999;
    putDoc(KEY, odd);
    x = await both(r, 'GET', EXPORT_URL, undefined, 'unreadable raw');
    assertEqual(importResult(x), '409 profile-unreadable', 'raw sources the import would refuse: 409 profile-unreadable');
    assert(String(x.json.message).includes('raw.sources[0].records[0].section'), 'the message names the offending path');
    // a doc that is usable but sits under another firmware's key is not the current one
    clearDocs();
    putDoc('11_12p0', profileDoc(await firmwareSources('12.0'), { firmware: '12.0' }));
    x = await both(r, 'GET', EXPORT_URL, undefined, 'other firmware');
    assertEqual(importResult(x), '404 no-profile', 'only the running firmware\'s key is exported');
  } finally { clearDocs(); await r.close(); }

  // not a gen-3 grid unit
  const am4 = await makeRig({ model: 0x15, fw: null });
  try {
    const x = await both(am4, 'GET', EXPORT_URL, undefined, 'AM4');
    assertEqual(`${x.status} ${JSON.stringify(x.json)}`, `501 ${JSON.stringify({ error: 'unsupported', capability: 'portable' })}`, 'AM4: 501 unsupported (portable)');
  } finally { await am4.close(); }
  // no unit identified: no detection is started by a failing lookup, 503 like the other definitions routes
  const none = await makeRig({ connected: false });
  try {
    const x = await both(none, 'GET', EXPORT_URL, undefined, 'no device');
    assertEqual(`${x.status} ${JSON.stringify(x.json)}`, `503 ${JSON.stringify({ error: 'no-device' })}`, 'no unit: 503 no-device');
  } finally { await none.close(); }
}

// ── 4. the roundtrip (A8) ───────────────────────────────────────────────────────────────────────────────────────────

interface Snapshot { caps: Json; diff: Json; params: Record<number, string>; status: Json }
async function snapshot(r: Rig): Promise<Snapshot> {
  const dev = (await viaApp(r, 'GET', '/device')).json as { capabilities: { definitions: Json } };
  const diff = (await viaApp(r, 'GET', '/device/definitions/diff')).json;
  const params: Record<number, string> = {};
  for (const eid of BLOCKS) {
    const p = await viaApp(r, 'GET', `/preset/blocks/${eid}/params?generic=1`);
    assertEqual(p.status, 200, `generic params of block ${eid}: 200`);
    params[eid] = p.text;
  }
  const status = (await viaApp(r, 'GET', '/device/cache')).json;
  return { caps: dev.capabilities.definitions, diff, params, status };
}

async function roundtrip(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    const doc = profileDoc(await sources13(), { firmware: FW });
    putDoc(KEY, doc);
    await r.registry.applyRuntimeCache();
    r.bodyProfile.current = r.registry.profile;
    const before = await snapshot(r);
    const beforeCaps = before.caps as { drift: string; profile: { key: string; source: string; byteExact: boolean; sources: string[] } };
    assertEqual(beforeCaps.drift, 'none', 'before: the stored profile of the running firmware: no drift');
    assertEqual(beforeCaps.profile.source, 'editor-cache', 'before: a local editor-cache profile');
    assertEqual(beforeCaps.profile.sources.join(','), 'editor-cache,live-readonly,live-probe', 'before: three sources');
    const beforeParams = Object.values(before.params).filter((t) => t.length > 200).length;
    assertEqual(beforeParams, BLOCKS.length, 'before: every compared block answered a full generic response');

    // export, delete, the drift says so
    const text = await exportText(r);
    const del = await viaApp(r, 'DELETE', '/device/cache');
    assertEqual(`${del.status} ${del.json.deleted}`, '200 true', 'DELETE /device/cache');
    const gone = await snapshot(r);
    assertEqual((gone.caps as { drift: string }).drift, 'unprofiled', 'deleted: drift unprofiled (the running firmware is not the catalog\'s)');
    assertEqual((gone.diff as { state: string }).state, 'unprofiled', 'deleted: the diff says unprofiled');
    assertEqual((await viaApp(r, 'GET', EXPORT_URL)).status, 404, 'deleted: nothing to export');

    // import: nothing goes to the device, SSE says so
    const sent = r.mock.sent.length;
    const eventsBefore = r.events.length;
    const imp = await viaApp(r, 'POST', IMPORT_URL, text);
    assertEqual(r.mock.sent.length, sent, 'the import sends nothing to the device');
    assertEqual(imp.status, 200, `import: 200 (${JSON.stringify(imp.json).slice(0, 200)})`);
    assertEqual(Object.keys(imp.json).join(','), 'ok,imported,key,applied,sources,coverage', 'import answer keys');
    assertEqual(`${imp.json.ok} ${imp.json.imported} ${imp.json.key} ${imp.json.applied}`, `true true ${KEY} true`, 'imported and applied under the running key');
    const impSources = imp.json.sources as Array<{ kind: string; origin: string }>;
    assertEqual(impSources.map((s) => `${s.kind}/${s.origin}`).join(','), 'editor-cache/file,live-readonly/file,live-probe/file', 'the sources, all tagged file');
    assertEqual(JSON.stringify(imp.json.coverage), JSON.stringify(storedDoc()!.coverage), 'the coverage of the stored document');
    const events = r.events.slice(eventsBefore).filter((e) => e.type === 'definitions');
    assertEqual(JSON.stringify(events), JSON.stringify([{ type: 'definitions', reason: 'imported', key: KEY }]), 'SSE: exactly one definitions/imported');

    // the stored doc: derived tables were recomputed from the raw, sources are the file's
    const stored = storedDoc()!;
    assertEqual(originsOf(stored), 'editor-cache/file,live-readonly/file,live-probe/file', 'stored: origin file on every source');
    assertSame(JSON.stringify(sortKeys(stored.raw.sources.map((s) => ({ ...s, origin: 'local' })))), JSON.stringify(sortKeys(doc.raw.sources.map(portableSource))), 'stored: the raw sources are the exported ones, origin apart (no content hash)');
    assertEqual((stored.raw.sources[0] as EditorCacheRawSource).contentSha256, null, 'stored: no content hash');
    assertEqual((stored.meta as { source: string; origin?: string }).source, 'axisdefs', 'stored: meta.source axisdefs');
    assertEqual((stored.meta as { origin?: string }).origin, 'bytes', 'stored: the byte class of the best source rides in origin');
    assertEqual(typeof (stored.meta as { importedAt?: unknown }).importedAt, 'string', 'stored: importedAt');
    assertEqual(classifyProfile(stored, KEY).state, 'usable', 'stored: usable');

    // after: the same caps, diff and generic params — the provenance the file re-tags aside
    const after = await snapshot(r);
    const normCaps = (c: Json) => {
      const p = c.profile as Json | null;
      return JSON.stringify({ ...c, profile: p ? { ...p, source: '<source>' } : p });
    };
    assertSame(normCaps(after.caps), normCaps(before.caps), 'caps: identical (profile.source apart)');
    assertEqual((after.caps as { profile: { source: string } }).profile.source, 'axisdefs', 'caps: the profile says it came from a definitions file');
    assertEqual((after.caps as { profile: { byteExact: boolean } }).profile.byteExact, true, 'caps: still byte-exact');
    const normDiff = (d: Json) => {
      const p = d.profile as { source: string; sources: Array<{ origin: string }> } | null;
      return JSON.stringify({ ...d, profile: p ? { ...p, source: '<source>', sources: p.sources.map((s) => ({ ...s, origin: '<origin>' })) } : p });
    };
    assertSame(normDiff(after.diff), normDiff(before.diff), 'diff: identical (profile.source and source origins apart)');
    assertEqual(JSON.stringify((after.diff as { families: unknown }).families), JSON.stringify((before.diff as { families: unknown }).families), 'diff: the same families');
    for (const eid of BLOCKS) assertSame(after.params[eid]!, before.params[eid]!, `generic params of block ${eid}: identical`);
    const dd = after.diff as { families: unknown[]; sections?: unknown[]; blocks?: unknown[]; summary: { newParams: number } };
    console.log(`  api/definitions-file: roundtrip of ${text.length} bytes: ${impSources.length} sources, diff ${dd.families.length} families / ${dd.sections?.length ?? 0} sections / ${dd.blocks?.length ?? 0} blocks / ${dd.summary.newParams} new params, ${BLOCKS.length} blocks of generic params (${Object.values(after.params).reduce((n, t) => n + t.length, 0)} bytes)`);
    const stat = (s: Json) => { const m = s.meta as Json; return JSON.stringify({ ...s, meta: { ...m, source: '<source>', builtAt: '', importedAt: '' }, sources: undefined }); };
    assertSame(stat(after.status), stat(before.status), 'GET /device/cache: identical (provenance and stamps apart)');

    // and through the router twin: the same answer and the same state, from nothing
    const importedKey = storedDoc();
    clearDocs();
    await r.registry.applyRuntimeCache();
    const eventsBeforeRouter = r.events.length;
    const viaR = await viaRouter(r, 'POST', IMPORT_URL, text);
    assertEqual(viaR.status, 200, 'router: import 200');
    assertSame(viaR.text, imp.text, 'router: the same answer as the Fastify route');
    assertSame(JSON.stringify(storedDoc()!.raw), JSON.stringify(importedKey!.raw), 'router: the same stored raw sources');
    assertEqual(r.events.slice(eventsBeforeRouter).filter((e) => e.type === 'definitions' && e.reason === 'imported').length, 1, 'router: the same event');
    assertEqual(((await viaRouter(r, 'GET', '/device')).json as { capabilities: { definitions: { drift: string } } }).capabilities.definitions.drift, 'none', 'router: the profile is applied');
    // a pretty-printed and key-shuffled copy of the file verifies the same (the checksum is over the canonical form)
    clearDocs();
    await r.registry.applyRuntimeCache();
    const shuffled = JSON.stringify(reverseKeys(JSON.parse(text)), null, 2);
    assertEqual((await viaApp(r, 'POST', IMPORT_URL, shuffled)).status, 200, 'a pretty-printed, key-reversed file imports');
  } finally { clearDocs(); await r.close(); }
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Json)[k])]));
  return v;
}

// ── 5. import errors, in the contract's order ───────────────────────────────────────────────────────────────────────

async function importErrors(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    const base = await exportedFile(r);
    const sentAtStart = r.mock.sent.length;
    const fresh = () => clone(base) as unknown as Record<string, any>;
    const eventsAtStart = r.importedEvents().length;
    let asserted = 0;
    /** One refusal: both twins, the same status and body, the expected status and code, the message names `part`. */
    const refused = async (label: string, body: unknown, expected: string, part?: string): Promise<Answer> => {
      const x = await both(r, 'POST', IMPORT_URL, body, label);
      assertEqual(importResult(x), expected, `${label}: ${expected}`);
      if (part !== undefined) assert(String(x.json.message ?? '').includes(part), `${label}: the message names "${part}" (got "${String(x.json.message)}")`);
      assertEqual(storedDoc(), null, `${label}: nothing stored`);
      asserted++;
      return x;
    };

    // 1. shape
    await refused('empty object', {}, '400 invalid-file', 'kind');
    await refused('an array', '[1,2,3]', '400 invalid-file');
    await refused('null', 'null', '400 invalid-file');
    await refused('a string', '"hello"', '400 invalid-file');
    await refused('wrong kind', { ...fresh(), kind: 'axis-preset' }, '400 invalid-file', 'kind');
    await refused('no version', (() => { const f = fresh(); delete f.version; return f; })(), '400 invalid-file', 'version');
    await refused('version 0', { ...fresh(), version: 0 }, '400 invalid-file', 'version');
    await refused('version 1.5', { ...fresh(), version: 1.5 }, '400 invalid-file', 'version');
    await refused('version "1"', { ...fresh(), version: '1' }, '400 invalid-file', 'version');
    await refused('model 300', { ...fresh(), model: 300 }, '400 invalid-file', 'model');
    await refused('firmware without a minor', { ...fresh(), firmware: '13' }, '400 invalid-file', 'firmware');
    // one spelling of a firmware: another one would make every stored source look like another firmware's
    for (const fw of ['13.00', '013.0', ' 13.0', '13.0 ', '13.0.0', '+13.0']) {
      await refused(`firmware ${JSON.stringify(fw)}`, { ...fresh(), firmware: fw }, '400 invalid-file', 'firmware');
    }
    await refused('a source firmware 13.00', (() => { const f = fresh(); f.profile.raw.sources[1].firmware = '13.00'; return f; })(), '400 invalid-file', 'profile.raw.sources[1].firmware');
    await refused('a record in an undeclared section', (() => { const f = fresh(); f.profile.raw.sources[0].records[0].section = 999; return f; })(), '400 invalid-file', 'profile.raw.sources[0].records[0].section');
    await refused('a live record in a block the source did not walk', (() => { const f = fresh(); f.profile.raw.sources[1].records[0].section = 999; return f; })(), '400 invalid-file', 'profile.raw.sources[1].records[0].section');
    await refused('key of another firmware', { ...fresh(), key: '11_12p0' }, '400 invalid-file', 'key');
    await refused('key not a key', { ...fresh(), key: '../../x' }, '400 invalid-file', 'key');
    await refused('exportedAt a number', { ...fresh(), exportedAt: 5 }, '400 invalid-file', 'exportedAt');
    await refused('no app', (() => { const f = fresh(); delete f.app; return f; })(), '400 invalid-file', 'app');
    await refused('sha256 not hex', { ...fresh(), sha256: 'xyz' }, '400 invalid-file', 'sha256');
    await refused('sha256 uppercase', { ...fresh(), sha256: String(base.sha256).toUpperCase() }, '400 invalid-file', 'sha256');
    await refused('no profile', (() => { const f = fresh(); delete f.profile; return f; })(), '400 invalid-file', 'profile');
    await refused('no meta', (() => { const f = fresh(); delete f.profile.meta; return f; })(), '400 invalid-file', 'profile.meta');
    await refused('meta.format 1', (() => { const f = fresh(); f.profile.meta.format = 1; return f; })(), '400 invalid-file', 'profile.meta.format');
    await refused('no raw', (() => { const f = fresh(); delete f.profile.raw; return f; })(), '400 invalid-file', 'profile.raw');
    await refused('raw sources not a list', (() => { const f = fresh(); f.profile.raw.sources = {}; return f; })(), '400 invalid-file', 'profile.raw.sources');
    await refused('no source', (() => { const f = fresh(); f.profile.raw.sources = []; return f; })(), '400 invalid-file', 'at least one source');
    await refused('a source of another firmware', (() => { const f = fresh(); f.profile.raw.sources[1].firmware = '12.0'; return f; })(), '400 invalid-file', 'profile.raw.sources[1].firmware');
    // malformed raw shapes (the whole matrix is the validator's own case; here through the route)
    await refused('a record id out of range', (() => { const f = fresh(); f.profile.raw.sources[0].records[3].id = 70000; return f; })(), '400 invalid-file', 'profile.raw.sources[0].records[3].id');
    await refused('a record min as text', (() => { const f = fresh(); f.profile.raw.sources[1].records[0].min = 'low'; return f; })(), '400 invalid-file', 'profile.raw.sources[1].records[0].min');
    await refused('a record kind unknown', (() => { const f = fresh(); f.profile.raw.sources[0].records[0].kind = 'int'; return f; })(), '400 invalid-file', 'profile.raw.sources[0].records[0].kind');
    await refused('a source kind unknown', (() => { const f = fresh(); f.profile.raw.sources[2].kind = 'live-everything'; return f; })(), '400 invalid-file', 'profile.raw.sources[2].kind');
    await refused('an infinite number', JSON.stringify(fresh()).replace('"def":1,', '"def":1e999,'), '400 invalid-file', 'not a finite number');
    // prototype poisoning: the router refuses the key itself; Fastify's own parser refuses the body first (app-wide, 400 invalid-json)
    const poisonText = JSON.stringify(fresh()).replace('"codecVersion":', '"__proto__":{"polluted":true},"codecVersion":');
    assert(poisonText.includes('"__proto__"'), 'fixture: the poisoned text carries a __proto__ key');
    const poisonApp = await viaApp(r, 'POST', IMPORT_URL, poisonText);
    assertEqual(importResult(poisonApp), '400 invalid-json', 'poisoned body, Fastify: refused as invalid JSON by the app-wide parser');
    const poisonRouter = await viaRouter(r, 'POST', IMPORT_URL, poisonText);
    assertEqual(importResult(poisonRouter), '400 invalid-file', 'poisoned body, router twin: 400 invalid-file');
    assert(String(poisonRouter.json.message).includes('forbidden key'), 'the message says why');
    assert(({} as { polluted?: unknown }).polluted === undefined, 'nothing polluted');
    // a plain `constructor` key passes Fastify's parser but is refused by the file validator, on both twins
    await refused('a constructor key', JSON.stringify(fresh()).replace('"codecVersion":', '"constructor":1,"codecVersion":'), '400 invalid-file', 'forbidden key');
    // oversize string anywhere (also under a key the file has no business with)
    await refused('an oversize string', (() => { const f = fresh(); f.notes = 'x'.repeat(RAW_LIMITS.string + 1); return f; })(), '400 invalid-file', 'string longer than');

    // newer formats are not "invalid": update and import again
    await refused('a newer file version', { ...fresh(), version: 2 }, '422 unsupported-format');
    await refused('a newer profile format', (() => { const f = fresh(); f.profile.meta.format = 3; return f; })(), '422 unsupported-format');
    await refused('a newer raw format', (() => { const f = fresh(); f.profile.raw.format = 2; return f; })(), '422 unsupported-format');
    const newer = await viaApp(r, 'POST', IMPORT_URL, { ...fresh(), version: 7 });
    assertEqual(`${newer.json.what} ${newer.json.got} ${newer.json.supported}`, 'version 7 1', 'unsupported-format says what is newer');

    // 2. checksum: any change of the profile, however small
    const t1 = fresh(); t1.profile.raw.sources[0].records[0].max += 1;
    const sum = await refused('a changed record value', t1, '422 checksum-mismatch');
    assertEqual(sum.json.declared, base.sha256, 'checksum-mismatch: the declared digest');
    assertEqual(sum.json.computed, await profileChecksum(t1.profile), 'checksum-mismatch: the computed digest');
    const t2 = fresh(); t2.profile.meta.schema += 1;
    await refused('a changed meta stamp', t2, '422 checksum-mismatch');
    const t3 = fresh(); t3.profile.raw.sources[1].capturedAt = '2020-01-01T00:00:00.000Z';
    await refused('a changed capture time', t3, '422 checksum-mismatch');
    const t4 = fresh(); t4.profile.raw.sources.pop();
    await refused('a dropped source', t4, '422 checksum-mismatch');
    const t5 = fresh(); t5.profile.raw.sources[0].records.pop();
    await refused('a dropped record', t5, '422 checksum-mismatch');
    const t6 = fresh(); t6.sha256 = '0'.repeat(64);
    await refused('a made-up digest', t6, '422 checksum-mismatch');
    // ...while a change outside `profile` is not the checksum's business (identity is checked on its own)
    assertEqual(JSON.stringify(await parseAxisDefs({ ...fresh(), exportedAt: 'yesterday' }).then((p) => p.ok)), 'true', 'exportedAt is not covered by the checksum');

    // 3. user data: a user name table injected into a source, the checksum made valid again
    for (const id of [0xffff, 0xfff5]) {
      assert(isUserNameTable(id), `fixture: 0x${id.toString(16)} is a user name table id`);
      const u = fresh();
      u.profile.raw.sources[0].records.push({ kind: 'enum', section: 60, id, tc: 16, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['Zqx Lead Tone', 'Wvb Clean Room'], x: 0 });
      await reseal(u);
      const res = await refused(`a user table 0x${id.toString(16)}`, u, '422 contains-user-data');
      assert(!res.text.includes('Zqx'), 'the refusal quotes no user content');
    }

    // 4. model (identity is not covered by the checksum: edit it freely)
    const m = fresh(); m.model = 0x12; m.key = '12_13p0';
    const mm = await refused('a file for another model', m, '409 model-mismatch');
    assertEqual(`${mm.json.expected} ${mm.json.got}`, `${FM3} 18`, 'model-mismatch: expected / got');

    // 5. firmware
    const f14 = await makeFile(await firmwareSources('14.0'), { firmware: '14.0' });
    const fd = await refused('a file of another firmware', f14, '409 firmware-differs');
    assertEqual(`${fd.json.expected} ${fd.json.got} ${fd.json.overridable}`, '13.0 14.0 true', 'firmware-differs: expected / got / overridable');

    // 6. re-derivation: shape-valid sources the derivation cannot use (no seed family anchors the section vote)
    const none = await makeFile([liveSource(familyRecords('CHORUS', 78), { firmware: FW })]);
    const noDerive = await quiet(() => refused('sources that do not derive', none, '422 derivation-failed'));
    assertEqual(noDerive.json.message, DERIVATION_FAILED_MESSAGE, 'a derivation failure answers generically (the detail goes to the log, not to the requester)');
    assertEqual(r.mock.sent.length, sentAtStart, 'no refusal sent anything to the device');
    assertEqual(r.importedEvents().length, eventsAtStart, 'no refusal emitted an event');
    assert(asserted >= 54, `the matrix ran (${asserted} refusals)`);
    console.log(`  api/definitions-file: ${asserted} refusals through both twins, nothing stored, nothing sent`);
    // the contract's order: shape before checksum before user data before model before firmware
    const order = fresh(); order.model = 0x12; order.key = '12_13p0'; order.profile.raw.sources[0].records[0].id = -1;
    assertEqual(importResult(await viaApp(r, 'POST', IMPORT_URL, order)), '400 invalid-file', 'order: shape before model');
    const order2 = fresh(); order2.model = 0x12; order2.key = '12_13p0'; order2.profile.raw.sources[0].records[0].max += 1;
    assertEqual(importResult(await viaApp(r, 'POST', IMPORT_URL, order2)), '422 checksum-mismatch', 'order: checksum before model');
    const order3 = fresh(); order3.model = 0x12; order3.key = '12_13p0';
    order3.profile.raw.sources[0].records.push({ kind: 'enum', section: 60, id: 0xffff, tc: 16, min: 0, max: 0, def: 0, step: 0, count: 1, values: ['x'], x: 0 });
    await reseal(order3);
    assertEqual(importResult(await viaApp(r, 'POST', IMPORT_URL, order3)), '422 contains-user-data', 'order: user data before model');
    assertEqual(importResult(await viaApp(r, 'POST', IMPORT_URL, { ...f14, model: 0x12, key: '12_14p0' })), '409 model-mismatch', 'order: model before firmware');
  } finally { clearDocs(); await r.close(); }
}

/** The three `sources13` sources on another firmware. */
async function firmwareSources(firmware: string): Promise<RawSource[]> {
  const editor = await editorCacheSource([...cacheSeedRecords(), ...newSectionRecords()], { firmware });
  return [editor, liveSource(liveSeedRecords({ unit: 'dB' }), { firmware, capturedAt: '2026-11-22T10:30:00.000Z' })];
}

// ── 6. another firmware ─────────────────────────────────────────────────────────────────────────────────────────────

async function importFirmware(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    const file14 = await makeFile(await firmwareSources('14.0'), { firmware: '14.0' });
    const before = ((await viaApp(r, 'GET', '/device')).json as { capabilities: { definitions: Json } }).capabilities.definitions;
    const events = r.events.length;
    const sent = r.mock.sent.length;
    // forced: stored under the FILE's key, not applied
    const a = await viaApp(r, 'POST', `${IMPORT_URL}?force=1`, file14);
    assertEqual(a.status, 200, `forced import: 200 (${JSON.stringify(a.json).slice(0, 160)})`);
    assertEqual(`${a.json.key} ${a.json.applied}`, '11_14p0 false', 'stored under the file\'s key, not applied');
    assertEqual(originsOf(storedDoc('11_14p0')), 'editor-cache/file,live-readonly/file', 'the file\'s sources are stored');
    assertEqual(storedDoc(KEY), null, 'nothing under the running firmware\'s key');
    assertEqual(r.mock.sent.length, sent, 'nothing sent to the device');
    assertEqual(JSON.stringify(r.events.slice(events).filter((e) => e.type === 'definitions')), JSON.stringify([{ type: 'definitions', reason: 'imported', key: '11_14p0' }]), 'SSE carries the stored key');
    const after = ((await viaApp(r, 'GET', '/device')).json as { capabilities: { definitions: Json } }).capabilities.definitions;
    assertSame(JSON.stringify(after), JSON.stringify(before), 'the running profile and the drift are untouched');
    assertEqual(((await viaApp(r, 'GET', EXPORT_URL)).json).error, 'no-profile', 'the export of the running firmware is still empty');
    // ?force=true is the same flag; the router twin takes the same query
    clearDocs();
    const b = await viaRouter(r, 'POST', `${IMPORT_URL}?force=true`, file14);
    assertEqual(`${b.status} ${b.json.key} ${b.json.applied}`, '200 11_14p0 false', 'router: ?force=true');
    clearDocs();
    // a repeated key counts by its first value, the same on both twins
    for (const [q, on] of [['force=1&force=1', true], ['force=1&force=0', true], ['force=0&force=1', false], ['force=0', false], ['force=true&force=0', true]] as const) {
      clearDocs();
      const ra = await viaApp(r, 'POST', `${IMPORT_URL}?${q}`, file14);
      clearDocs();
      const rb = await viaRouter(r, 'POST', `${IMPORT_URL}?${q}`, file14);
      assertEqual(ra.status, on ? 200 : 409, `?${q} on the Fastify route: ${on ? 'forced' : 'not forced'}`);
      assertEqual(`${rb.status} ${rb.text}`, `${ra.status} ${ra.text}`, `?${q}: the router twin answers the same`);
    }
    clearDocs();
    // `force` only skips the firmware check: model and the rest still decide
    const wrongModel = { ...file14, model: 0x12, key: '12_14p0' };
    assertEqual(importResult(await viaApp(r, 'POST', `${IMPORT_URL}?force=1`, wrongModel)), '409 model-mismatch', '?force=1 does not skip the model check');
    const tampered = clone(file14) as unknown as AxisDefsFile;
    tampered.profile.raw.sources[0]!.records[0]!.max += 1;
    assertEqual(importResult(await viaApp(r, 'POST', `${IMPORT_URL}?force=1`, tampered)), '422 checksum-mismatch', '?force=1 does not skip the checksum');
    // the file of the running firmware is not "forced" by ?force=1: applied
    const same = await viaApp(r, 'POST', `${IMPORT_URL}?force=1`, await makeFile(await sources13()));
    assertEqual(`${same.status} ${same.json.key} ${same.json.applied}`, `200 ${KEY} true`, 'the running firmware\'s file with ?force=1 is applied as usual');
    clearDocs();
    await r.registry.applyRuntimeCache();
  } finally { clearDocs(); await r.close(); }

  // a unit whose firmware was never read has nothing to differ from: the file is stored under its own key, not applied
  const silent = await makeRig({ fw: null });
  try {
    const x = await viaApp(silent, 'POST', IMPORT_URL, await makeFile(await sources13()));
    assertEqual(`${x.status} ${x.json.key} ${x.json.applied}`, `200 ${KEY} false`, 'unknown running firmware: stored under the file\'s key, not applied');
    const caps = ((await viaApp(silent, 'GET', '/device')).json as { capabilities: { definitions: { profile: unknown; portable: boolean } } }).capabilities.definitions;
    assertEqual(`${caps.profile} ${caps.portable}`, 'null true', 'not applied, still portable');
    assertEqual(((await viaApp(silent, 'GET', EXPORT_URL)).json as Json).error === undefined, true, 'with no running firmware the export falls back to the newest stored doc of the model');
  } finally { clearDocs(); await silent.close(); }
}

// ── 7. provenance ───────────────────────────────────────────────────────────────────────────────────────────────────

async function importProvenance(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    // a file that calls its sources local (and cloud) is read as a file: origin file, no local byte source, no widened bounds
    const claimsLocal = await makeFile(await sources13('local'));
    const sources = claimsLocal.profile.raw.sources;
    sources[1]!.origin = 'cloud';
    await reseal(claimsLocal);
    assertEqual(claimsLocal.profile.raw.sources.map((s) => s.origin).join(','), 'local,cloud,local', 'fixture: the file claims local and cloud');
    const res = await viaApp(r, 'POST', IMPORT_URL, claimsLocal);
    assertEqual(res.status, 200, `import: 200 (${JSON.stringify(res.json).slice(0, 160)})`);
    const stored = storedDoc()!;
    assertEqual(originsOf(stored), 'editor-cache/file,live-readonly/file,live-probe/file', 'every stored source is origin file');
    assertEqual(deviceCache.hasLocalByteSource(stored), false, 'a file source is no local byte source');
    assertEqual(JSON.stringify(deviceCache.walkBlockLimits(FM3, 'read-only', stored)), JSON.stringify(deviceCache.walkBlockLimits(FM3, 'read-only', null)), 'and never widens a walk bound');
    assertEqual(JSON.stringify(deviceCache.walkEnumHints(FM3, stored)), JSON.stringify(deviceCache.walkEnumHints(FM3, null)), 'nor creates an enum hint');
    // the control: the same sources as this install's own
    const local = profileDoc(await sources13(), { firmware: FW });
    assertEqual(deviceCache.hasLocalByteSource(local), true, 'control: a local editor-cache source is one');
    assert(JSON.stringify(deviceCache.walkBlockLimits(FM3, 'read-only', local)) !== JSON.stringify(deviceCache.walkBlockLimits(FM3, 'read-only', null)), 'control: and widens the bounds');
    // the same file through the router twin
    clearDocs();
    const viaR = await viaRouter(r, 'POST', IMPORT_URL, claimsLocal);
    assertSame(viaR.text, res.text, 'router: the same answer');
    assertEqual(originsOf(storedDoc()), 'editor-cache/file,live-readonly/file,live-probe/file', 'router: origin file');

    // derived tables in the file are never read: a file that carries doctored tables (inside `profile`, checksum made valid, and
    // next to it) imports to exactly what a clean one does
    clearDocs();
    await viaApp(r, 'POST', IMPORT_URL, await makeFile(await sources13()));
    const clean = JSON.stringify(withoutStamps(storedDoc()!));
    clearDocs();
    const doctored = await makeFile(await sources13());
    const prof = doctored.profile as unknown as Json;
    prof.ranges = { DISTORT: { 0: { kind: 'float', displayMin: -1000, displayMax: 1000, scale: 1, step: 1, typecode: 0 } } };
    prof.enumOverrides = { DISTORT: { 0: ['TAMPERED AMP'] } };
    prof.rosters = { DISTORT: [{ value: 0, name: 'TAMPERED AMP', manufacturer: null, basedOn: null }] };
    prof.cabIrs = { 'USER 1': ['Qjk My IR'] };
    prof.coverage = { complete: true, gaps: [] };
    (prof.meta as Json).ranges = { TAMPERED: 1 };
    await reseal(doctored);
    const top = doctored as unknown as Json;
    top.ranges = { TAMPERED: { 0: 1 } };
    top.sections = [{ tag: 1 }];
    top.blockMap = [{ eid: 1 }];
    top.derived = { everything: 'tampered' };
    const dres = await viaApp(r, 'POST', IMPORT_URL, doctored);
    assertEqual(dres.status, 200, `a file with doctored tables: 200 (${JSON.stringify(dres.json).slice(0, 160)})`);
    assertSame(JSON.stringify(withoutStamps(storedDoc()!)), clean, 'the stored document is what the clean file gives: recomputed from the raw');
    const storedText = JSON.stringify(storedDoc());
    for (const marker of ['TAMPERED', 'Qjk My IR']) assert(!storedText.includes(marker), `nothing of the doctored tables reached the store (${marker})`);
    assertEqual((storedDoc() as unknown as Json).derived, undefined, 'no extra top-level key');

    // unknown keys inside the raw are dropped (the checksum covered them, the store never sees them)
    clearDocs();
    const extra = await makeFile(await sources13());
    (extra.profile.raw.sources[0]!.records[0] as unknown as Json).extra = { nested: ['x'] };
    (extra.profile.raw.sources[0] as unknown as Json).mystery = 'y';
    await reseal(extra);
    assertEqual((await viaApp(r, 'POST', IMPORT_URL, extra)).status, 200, 'unknown keys inside the raw: accepted');
    assert(!JSON.stringify(storedDoc()!.raw).includes('mystery') && !JSON.stringify(storedDoc()!.raw).includes('nested'), 'and dropped from the stored raw');

    // a content hash and issue offsets a file carries are never stored (they would be a fingerprint / offsets into someone's file)
    clearDocs();
    const hashed = await makeFile(await sources13());
    const hashedEditor = hashed.profile.raw.sources[0] as EditorCacheRawSource;
    assertEqual(typeof hashedEditor.contentSha256, 'string', 'fixture: the file carries a content hash');
    const foreignHash = hashedEditor.contentSha256 as string;
    hashedEditor.issues = [{ section: 7, record: null, offset: 90, reason: 'BAD-PAD', droppedRecords: 3, skippedBytes: 44, resumedAt: 120 }];
    await reseal(hashed);
    assertEqual((await viaApp(r, 'POST', IMPORT_URL, hashed)).status, 200, 'a file with a content hash and issue offsets: 200');
    const keptEditor = storedDoc()!.raw.sources[0] as EditorCacheRawSource;
    assertEqual(keptEditor.contentSha256, null, 'the foreign content hash is not stored');
    assertEqual(JSON.stringify(keptEditor.issues), JSON.stringify([{ section: 7, record: null, offset: 0, reason: 'BAD-PAD', droppedRecords: 3, skippedBytes: 0, resumedAt: null }]), 'the foreign byte offsets are not stored');
    assert(!JSON.stringify(storedDoc()).includes(foreignHash), 'the hash is nowhere in the stored document');
    // a flag inside the file is never read: `replace` / `force` in the body change nothing
    clearDocs();
    putDoc(KEY, profileDoc([await editorCacheSource(cacheSeedRecords(), { firmware: FW })], { firmware: FW }));
    await r.registry.applyRuntimeCache();
    const flagged = await makeFile([liveSource(liveSeedRecords({ unit: 'dB' }), { firmware: FW })]);
    (flagged as unknown as Json).replace = true;
    (flagged as unknown as Json).force = true;
    const fl = await viaApp(r, 'POST', IMPORT_URL, flagged);
    assertEqual(fl.status, 200, 'a file with replace/force fields: still a merge');
    assertEqual(originsOf(storedDoc()), 'editor-cache/local,live-readonly/file', 'replace: true inside the file did not replace the local source');
    const f2 = { ...(await makeFile(await firmwareSources('14.0'), { firmware: '14.0' })), force: true };
    assertEqual(importResult(await viaApp(r, 'POST', IMPORT_URL, f2)), '409 firmware-differs', 'force: true inside the file did not force');
  } finally { clearDocs(); await r.close(); }
}

/** A stored doc without the stamps that differ between two imports of the same sources. */
function withoutStamps(doc: ProfileDoc): unknown {
  const m = { ...(doc.meta as unknown as Json) };
  delete m.importedAt;
  delete m.derivedAt;
  return { ...doc, meta: m };
}

// ── 8. merge ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function importMerge(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    // a local editor-cache source stays, the file's walk joins it; the editor cache keeps outranking
    putDoc(KEY, profileDoc([await editorCacheSource(cacheSeedRecords(), { firmware: FW })], { firmware: FW }));
    await r.registry.applyRuntimeCache();
    const file = await makeFile([liveSource(liveSeedRecords({ unit: 'dB' }), { firmware: FW })]);
    let x = await viaApp(r, 'POST', IMPORT_URL, file);
    assertEqual(x.status, 200, 'merge: 200');
    assertEqual(originsOf(storedDoc()), 'editor-cache/local,live-readonly/file', 'merge: the local source stays, the file\'s joins');
    assertEqual((storedDoc()!.meta as { source: string }).source, 'editor-cache', 'merge: the best source is still the local editor cache');
    assertEqual(((x.json.sources as unknown[]).length), 2, 'merge: the answer lists both sources');
    // a re-import replaces the file's own slot: still two sources, ids unique
    x = await viaApp(r, 'POST', IMPORT_URL, file);
    assertEqual(x.status, 200, 're-import: 200');
    assertEqual(originsOf(storedDoc()), 'editor-cache/local,live-readonly/file', 're-import: the same slot is replaced, nothing piles up');
    assertEqual(new Set(storedDoc()!.raw.sources.map((s) => s.id)).size, 2, 're-import: ids unique');
    // the router twin merges the same way
    const viaR = await viaRouter(r, 'POST', IMPORT_URL, file);
    assertEqual(`${viaR.status} ${originsOf(storedDoc())}`, '200 editor-cache/local,live-readonly/file', 'router: the same merge');
    // ?replace=1: only the file's sources remain
    x = await viaApp(r, 'POST', `${IMPORT_URL}?replace=1`, file);
    assertEqual(`${x.status} ${originsOf(storedDoc())}`, '200 live-readonly/file', '?replace=1: the document is replaced by the file\'s sources');
    putDoc(KEY, profileDoc([await editorCacheSource(cacheSeedRecords(), { firmware: FW })], { firmware: FW }));
    const rr = await viaRouter(r, 'POST', `${IMPORT_URL}?replace=true`, file);
    assertEqual(`${rr.status} ${originsOf(storedDoc())}`, '200 live-readonly/file', 'router: ?replace=true');

    // a legacy (format-1) doc that outranks the file's sources is not replaced silently
    clearDocs();
    putDoc(KEY, catalogBuilt(FM3, 'editor-cache'));
    await r.registry.applyRuntimeCache();
    const lp = await both(r, 'POST', IMPORT_URL, file, 'legacy better');
    assertEqual(importResult(lp), '409 local-profile-better', 'a legacy local editor-cache doc outranks a file walk: 409 local-profile-better');
    assertEqual(JSON.stringify((lp.json.local as Json)), JSON.stringify({ source: 'editor-cache', format: 1 }), 'the refusal says what is stored');
    assertEqual(storedDoc()!.raw, undefined, 'nothing was replaced');
    x = await viaApp(r, 'POST', `${IMPORT_URL}?replace=1`, file);
    assertEqual(`${x.status} ${originsOf(storedDoc())}`, '200 live-readonly/file', '?replace=1 adopts it');
    // a repeated replace key counts by its first value, the same on both twins
    for (const [q, on] of [['replace=1&replace=0', true], ['replace=0&replace=1', false]] as const) {
      putDoc(KEY, catalogBuilt(FM3, 'editor-cache'));
      const ra = await viaApp(r, 'POST', `${IMPORT_URL}?${q}`, file);
      putDoc(KEY, catalogBuilt(FM3, 'editor-cache'));
      const rb = await viaRouter(r, 'POST', `${IMPORT_URL}?${q}`, file);
      assertEqual(ra.status, on ? 200 : 409, `?${q}: ${on ? 'replaces' : 'refused'}`);
      assertEqual(`${rb.status} ${rb.text}`, `${ra.status} ${ra.text}`, `?${q}: the router twin answers the same`);
    }

    // a doc a newer build wrote is not rewritten
    clearDocs();
    const newer = clone(profileDoc(await sources13(), { firmware: FW })) as unknown as { raw: { format: number } };
    newer.raw.format = 2;
    putDoc(KEY, newer);
    const np = await both(r, 'POST', IMPORT_URL, file, 'newer doc');
    assertEqual(importResult(np), '409 newer-profile', 'a newer build\'s doc: 409 newer-profile');
    assertEqual((storedDoc() as unknown as { raw: { format: number } }).raw.format, 2, 'left as it was');
    x = await viaApp(r, 'POST', `${IMPORT_URL}?replace=1`, file);
    assertEqual(x.status, 200, '?replace=1 replaces it');

    // a stale doc whose sources do not derive keeps them next to the file's; still not derivable: 422 with stored: true
    clearDocs();
    const failing = clone(profileDoc([liveSource(liveSeedRecords(), { origin: 'cloud', firmware: FW })], { firmware: FW })) as unknown as ProfileDoc & { meta: Record<string, unknown> };
    failing.raw.sources[0]!.records = familyRecords('CHORUS', 78) as never;
    failing.meta.derivedRevision = 0;
    putDoc(KEY, failing);
    assertEqual(loadStoredProfile(store.defaultStore, KEY).state, 'stale', 'fixture: stale');
    const importedBefore = r.importedEvents().length;
    const st = await quiet(async () => viaApp(r, 'POST', IMPORT_URL, await makeFile([await editorCacheSource(cacheSeedRecords(), { firmware: FW })])));
    assertEqual(`${st.status} ${st.json.error} ${st.json.stored} ${st.json.key}`, `422 derivation-failed true ${KEY}`, 'a still-failing stale doc: 422 derivation-failed, stored: true');
    assertEqual(originsOf(storedDoc()), 'live-readonly/cloud,editor-cache/file', 'both sources are kept (nothing lost)');
    assertEqual(r.importedEvents().length, importedBefore + 1, 'the store changed (the file\'s sources were kept): other windows are told');
    assertEqual(st.json.message, DERIVATION_FAILED_MESSAGE, 'the failure is described generically');
    assert((await viaApp(r, 'GET', '/device/cache')).json.stale === true, 'the doc stays stale');
  } finally { clearDocs(); await r.close(); }
}

// ── 9. size limit and the device gates ──────────────────────────────────────────────────────────────────────────────

async function importLimitsAndGates(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    // exactly at the limit the size gate lets the body through (it is no file: 400); one byte more never reaches the handler
    const atLimit = `"${'a'.repeat(AXISDEFS_MAX_BYTES - 2)}"`;
    assertEqual(Buffer.byteLength(atLimit), AXISDEFS_MAX_BYTES, 'fixture: a body of exactly the limit');
    assertEqual(importResult(await both(r, 'POST', IMPORT_URL, atLimit, 'at the limit')), '400 invalid-file', 'at the limit: read (and refused as no file)');
    const over = `"${'a'.repeat(AXISDEFS_MAX_BYTES - 1)}"`;
    const big = await both(r, 'POST', IMPORT_URL, over, 'over the limit');
    assertEqual(`${big.status} ${JSON.stringify(big.json)}`, `413 ${JSON.stringify({ error: 'too-large', bytes: AXISDEFS_MAX_BYTES + 1, limit: AXISDEFS_MAX_BYTES })}`, 'over the limit: 413 too-large with the size and the limit');
    // a multi-byte body is measured in bytes, not characters
    const wide = `"${'é'.repeat(AXISDEFS_MAX_BYTES / 2)}"`; // 2 bytes each: over the limit by the quotes
    assertEqual(importResult(await viaRouter(r, 'POST', IMPORT_URL, wide)), '413 too-large', 'router: the size is the UTF-8 byte length');
    assertEqual(storedDoc(), null, 'nothing stored');
    assertEqual(r.importedEvents().length, 0, 'no event');
  } finally { clearDocs(); await r.close(); }

  // not a gen-3 grid unit: the gate comes before the body is looked at
  const am4 = await makeRig({ model: 0x15, fw: null });
  try {
    for (const body of [{}, 'null', await makeFile(await sources13())]) {
      const x = await both(am4, 'POST', IMPORT_URL, body, 'AM4');
      assertEqual(`${x.status} ${JSON.stringify(x.json)}`, `501 ${JSON.stringify({ error: 'unsupported', capability: 'portable' })}`, 'AM4: 501 unsupported (portable), whatever the body');
    }
  } finally { await am4.close(); }
  // no unit identified
  const none = await makeRig({ connected: false });
  try {
    const x = await both(none, 'POST', IMPORT_URL, await makeFile(await sources13()), 'no device');
    assertEqual(`${x.status} ${JSON.stringify(x.json)}`, `503 ${JSON.stringify({ error: 'no-device' })}`, 'no unit: 503 no-device');
  } finally { await none.close(); }
  // an FM9 unit refuses an FM3 file
  const fm9 = await makeRig({ model: 0x12, fw: [13, 0] });
  try {
    const x = await both(fm9, 'POST', IMPORT_URL, await makeFile(await sources13()), 'FM9');
    assertEqual(importResult(x), '409 model-mismatch', 'FM9 with an FM3 file: 409 model-mismatch');
    assertEqual(`${x.json.expected} ${x.json.got}`, '18 17', 'expected 0x12, got 0x11');
  } finally { clearDocs(); await fm9.close(); }
}

// ── 10. origin guard, Remote ────────────────────────────────────────────────────────────────────────────────────────

async function importGuards(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    const file = await makeFile(await sources13());
    const refusedWith = async (label: string, a: Answer): Promise<void> => {
      assertEqual(`${a.status} ${JSON.stringify(a.json)}`, `403 ${JSON.stringify({ error: 'forbidden-origin' })}`, `${label}: 403 forbidden-origin`);
      assertEqual(storedDoc(), null, `${label}: nothing stored`);
      assertEqual(r.importedEvents().length, 0, `${label}: no event`);
    };
    // a web page of another origin, the opaque origin, a LAN same-origin page, a LAN peer
    await refusedWith('foreign origin', await viaApp(r, 'POST', IMPORT_URL, file, { origin: 'https://evil.example' }));
    await refusedWith('null origin', await viaApp(r, 'POST', IMPORT_URL, file, { origin: 'null' }));
    await refusedWith('a LAN page', await viaApp(r, 'POST', IMPORT_URL, file, { origin: 'http://192.168.1.20:5056', host: '192.168.1.20:5056' }, '192.168.1.30'));
    await refusedWith('a LAN peer without an Origin', await viaApp(r, 'POST', IMPORT_URL, file, {}, '192.168.1.30'));
    await refusedWith('a LAN peer (IPv4-mapped)', await viaApp(r, 'POST', IMPORT_URL, file, {}, '::ffff:192.168.1.30'));
    // and the body is never parsed: the refusal needs no valid JSON
    await refusedWith('the guard runs before the body is read', await viaApp(r, 'POST', IMPORT_URL, '{not json', { origin: 'https://evil.example' }));
    // a foreign page cannot read the export either (the app-wide origin rule)
    putDoc(KEY, profileDoc(await sources13(), { firmware: FW }));
    await r.registry.applyRuntimeCache();
    const ex = await viaApp(r, 'GET', EXPORT_URL, undefined, { origin: 'https://evil.example' });
    assertEqual(`${ex.status} ${ex.json.error}`, '403 forbidden-origin', 'export from a foreign origin: 403');
    assert(!ex.text.includes('"raw"'), 'and carries nothing of the file');
    clearDocs();
    await r.registry.applyRuntimeCache();
    // the Axis desktop renderer and the dev server (loopback origins), no Origin, a loopback peer: allowed
    for (const [label, headers, peer] of [
      ['no origin', {}, undefined], ['localhost origin', { origin: 'http://localhost:5173' }, undefined],
      ['127.0.0.1 origin', { origin: 'http://127.0.0.1:5056' }, '127.0.0.1'], ['::1 peer', {}, '::1'], ['IPv4-mapped loopback', {}, '::ffff:127.0.0.1']
    ] as const) {
      clearDocs();
      const ok = await viaApp(r, 'POST', IMPORT_URL, file, { ...headers }, peer);
      assertEqual(ok.status, 200, `${label}: allowed (${JSON.stringify(ok.json).slice(0, 120)})`);
    }

    // the Remote relay: the export GET relays, the import POST is refused before the app is reached
    clearDocs();
    const importedBefore = r.importedEvents().length;
    putDoc(KEY, profileDoc(await sources13(), { firmware: FW }));
    await r.registry.applyRuntimeCache();
    const log = console.log;
    console.log = () => {};
    try {
      const { session, relay } = fakeChannelSession();
      const host = new RemoteHost(r.app, async () => session, (fn) => r.registry.subscribe(fn));
      await host.enable(true);
      try {
        const got = await relay('e1', 'GET', EXPORT_URL);
        assertEqual(got.status, 200, '[remote] the export relays');
        const body = got.encoding === 'gzip' ? gunzipSync(Buffer.from(got.body, 'base64')).toString('utf8') : got.body;
        assertEqual((JSON.parse(body) as AxisDefsFile).kind, 'axis-device-definitions', '[remote] the relayed body is the file');
        clearDocs();
        await r.registry.applyRuntimeCache();
        const text = JSON.stringify(file);
        for (const [id, path] of [['i1', IMPORT_URL], ['i2', `${IMPORT_URL}?force=1`], ['i3', `${IMPORT_URL}?replace=1`]] as const) {
          const res = await relay(id, 'POST', path, file);
          assertEqual(res.status, 403, `[remote] POST ${path} refused`);
          assertEqual(res.body, JSON.stringify({ error: 'not allowed remotely' }), `[remote] POST ${path}: the relay's own refusal`);
        }
        assert(text.length > 1000, 'fixture: a real file was offered');
        assertEqual(storedDoc(), null, '[remote] nothing was imported');
        assertEqual(r.importedEvents().length, importedBefore, '[remote] no event');
      } finally { await host.enable(false); }
    } finally { console.log = log; }
  } finally { clearDocs(); await r.close(); }
}

// ── 11. cloud pull: the shared strict shape check ───────────────────────────────────────────────────────────────────

async function cloudPullValidation(): Promise<void> {
  const { cloudCachePull } = await import('../../src/services/cloudProfiles.js');
  clearDocs();
  const r = await makeRig();
  try {
    const row = (doc: unknown) => ({
      deviceProfileGet: async () => ({ profile: doc, contentHash: 'h', source: 'editor-cache', recordCount: 1, createdAt: STAMP }),
      deviceProfilePublish: async () => ({ code: 200, body: {} })
    });
    const good = clone(profileDoc(await sources13(), { firmware: FW })) as unknown as { raw: { sources: Array<{ records: Array<Record<string, unknown>> } & Record<string, unknown>> } };
    // a hostile row: a malformed record, a prototype key under the raw, an infinite number — all refused, nothing stored
    const bad1 = clone(good); bad1.raw.sources[0]!.records[0]!.id = 'not a number';
    const bad2 = JSON.parse(JSON.stringify(good).replace('"codecVersion":', '"__proto__":{"x":1},"codecVersion":')) as unknown;
    const bad3 = JSON.parse(JSON.stringify(good).replace('"def":1,', '"def":1e999,')) as unknown;
    const bad4 = clone(good); bad4.raw.sources[0]!.records[0]!.section = 999; // not a section the source declares
    const bad5 = clone(good); bad5.raw.sources[0]!.firmware = '13.00';
    for (const [label, doc] of [['a malformed record', bad1], ['a __proto__ key', bad2], ['an infinite number', bad3], ['a record in an undeclared section', bad4], ['a non-canonical source firmware', bad5]] as const) {
      const res = await cloudCachePull(row(doc), store.defaultStore, r.registry);
      assertEqual(res.code, 422, `${label}: 422`);
      assertEqual((res.body as { error: string }).error, 'cloud profile malformed', `${label}: cloud profile malformed`);
      assert(typeof (res.body as { message?: string }).message === 'string' && String((res.body as { message?: string }).message).includes('raw.sources'), `${label}: the message names the path`);
      assertEqual(storedDoc(), null, `${label}: nothing stored`);
    }
    // an honest row still pulls, its sources stored as the sanitized copies, origin cloud
    const ok = await cloudCachePull(row(good), store.defaultStore, r.registry);
    assertEqual(ok.code, 200, 'an honest format-2 row: 200');
    assertEqual(originsOf(storedDoc()), 'editor-cache/cloud,live-readonly/cloud,live-probe/cloud', 'pulled sources are origin cloud');
    // an unknown key under a record is dropped on the way in
    clearDocs();
    const extra = clone(good);
    extra.raw.sources[0]!.records[0]!.extra = 'x';
    assertEqual((await cloudCachePull(row(extra), store.defaultStore, r.registry)).code, 200, 'an unknown key: accepted');
    assert(!JSON.stringify(storedDoc()!.raw).includes('"extra"'), 'and not stored');
  } finally { clearDocs(); await r.close(); }
}

/** Run `fn` with `console.warn` muted (the import logs the detail of a refused derivation). */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

// ── 12. the validator against the codec's own producers ──────────────────────────────────────────────────────────────

async function rawVsCodec(): Promise<void> {
  // a cache with a header, a file name, a firmware cab bank (wire ids) and a seed set; strict and (damaged) tolerant walks
  const sections = groupBySection([...cacheSeedRecords(), ...newSectionRecords()]);
  sections.push({ tag: 70, count: 1, write: (a) => pushCabTable(a, 0xfff0, ['Factory A', 'Factory B'], [11, 22]) });
  const bytes = encodeSections(sections, header({ major: 13, minor: 0, sectionCount: sections.length }));
  assert(!isUserNameTable(0xfff0), 'fixture: 0xfff0 is a firmware cab bank, not a user table');
  const strict = await rawFromCacheBytes(bytes, { fileName: 'effectDefinitions_11_13p0.cache', capturedAt: STAMP, origin: 'local' });
  let tolerant: EditorCacheRawSource | null = null;
  for (let i = bytes.length - 1; i >= 46 && !tolerant; i--) {
    const damaged = bytes.slice();
    damaged[i] = damaged[i]! ^ 0xff;
    try {
      const t = await rawFromCacheBytes(damaged, { fileName: 'effectDefinitions_11_13p0.cache', tolerant: true, capturedAt: STAMP, origin: 'local', seq: 1 });
      if ((t.issues?.length ?? 0) > 0) tolerant = t;
    } catch { /* damage even a tolerant walk cannot take */ }
  }
  assert(tolerant !== null, 'fixture: a damaged cache a tolerant walk reports issues for');
  const full = fullLiveSource();
  const probe = (await sources13())[2]!;
  const all: RawSource[] = [strict, tolerant!, full, probe];

  // the fixture exercises every optional field the types allow
  assert(strict.header !== null && strict.fileVersion === '13.0' && typeof strict.contentSha256 === 'string', 'fixture: header, file version and content hash');
  assert(strict.records.some((r) => r.kind === 'enum' && Array.isArray(r.wireIds)), 'fixture: a cab table with wire ids');
  assert((tolerant!.issues?.length ?? 0) > 0, 'fixture: tolerant-walk issues');
  assert(full.scope.idLists !== undefined && full.walk.extension === 'aborted' && full.walk.abortReason !== undefined && full.walk.pseudoReplies !== undefined && full.walk.boundHits.length > 0, 'fixture: id lists, extension, abort reason, reply statistics, bound hits');
  assert(full.records.some((r) => r.kind === 'float' && r.taper !== undefined) && full.records.some((r) => r.unit !== undefined) && full.records.some((r) => r.kind === 'float' && r.placeholder === true), 'fixture: taper, unit, placeholder');
  assertEqual(new Set(all.map((s) => s.id)).size, 4, 'fixture: four distinct sources');

  // a codec field the validator does not know would be dropped silently: the sanitized copy must equal the input
  const input = clone({ format: 1, sources: all });
  const ok = checkProfileRaw(input);
  assert(ok.ok, `the codec's raw sources pass (${ok.ok ? '' : `${ok.path}: ${ok.message}`})`);
  assertSame(JSON.stringify(sortKeys(ok.ok ? ok.raw : null)), JSON.stringify(sortKeys(input)), 'the sanitized copy deep-equals the codec\'s sources: no field dropped silently');
  // the same through the file: validation, checksum, re-tagging — and the sources a file carries are these, portable
  const file = await makeFile(all);
  const parsed = await parseAxisDefs(JSON.parse(JSON.stringify(file)));
  assert(parsed.ok, `a file of the codec's sources parses (${parsed.ok ? '' : JSON.stringify(parsed.body).slice(0, 200)})`);
  if (parsed.ok) {
    assertSame(JSON.stringify(sortKeys(parsed.sources.map((s) => ({ ...s, origin: 'local' })))), JSON.stringify(sortKeys(all.map(portableSource))), 'file sources = the codec\'s sources, portable form, origin file');
    assertEqual(parsed.sources.every((s) => s.origin === 'file'), true, 'every parsed source is tagged file');
  }
  // a stand-in a test double might write (no records at all, no sections) is still a valid source
  const empty: EditorCacheRawSource = { ...strict, id: 'editor-cache@x#9', sections: [], records: [], header: null, fileVersion: null, contentSha256: null, omitted: { tables: 0, records: 0 } };
  assert(checkRawSources(clone([empty])).ok, 'an editor-cache source without records or sections is valid');
}

// ── 13. a firmware spelling never drops local sources; crafted files stay cheap ──────────────────────────────────────

/** An editor-cache source of `records` float records (one section tag each, or round-robin over `declared` sections). */
function craftedSource(records: number, opts: { declared: number }): EditorCacheRawSource {
  const tags = opts.declared > 0 ? opts.declared : 0;
  const recs = Array.from({ length: records }, (_, i) => ({
    kind: 'float' as const, section: tags > 0 ? 100 + (i % tags) : 100 + i, id: tags > 0 ? Math.floor(i / tags) : 1, tc: 0, min: 0, max: 1, def: 0, step: 0, t1: 0, t2: 0
  }));
  return {
    id: 'editor-cache@x#0', kind: 'editor-cache', origin: 'local', capturedAt: null, firmware: FW, codecVersion: 'x', space: 'section',
    sections: Array.from({ length: tags }, (_, i) => ({ tag: 100 + i, count: Math.ceil(records / tags) })),
    omitted: { tables: 0, records: 0 }, header: null, fileVersion: null, contentSha256: null, records: recs
  };
}

async function craftedFiles(): Promise<void> {
  clearDocs();
  const r = await makeRig();
  try {
    // 1. "13.00" names the same key as "13.0": it must never be merged as if it were another firmware (that dropped every
    //    stored source of "13.0" without `replace`)
    putDoc(KEY, profileDoc([await editorCacheSource(cacheSeedRecords(), { firmware: FW }), liveSource(liveSeedRecords({ unit: 'dB' }), { firmware: FW })], { firmware: FW }));
    await r.registry.applyRuntimeCache();
    const before = JSON.stringify(storedDoc());
    assertEqual(originsOf(storedDoc()), 'editor-cache/local,live-readonly/local', 'fixture: a local editor cache and a local walk');
    const live = clone(liveSource(liveSeedRecords(), { firmware: FW, capturedAt: '2026-11-22T12:00:00.000Z' })) as unknown as { firmware: string | null };
    live.firmware = null;
    const spelled = await makeFile([live as unknown as RawSource]);
    spelled.firmware = '13.00';
    spelled.key = KEY; // numerically the right key
    const refused = await both(r, 'POST', IMPORT_URL, spelled, 'firmware 13.00');
    assertEqual(importResult(refused), '400 invalid-file', 'firmware "13.00": refused');
    assertSame(JSON.stringify(storedDoc()), before, 'the stored sources are untouched');
    assertEqual(r.importedEvents().length, 0, 'no event');
    // the canonical spelling merges and keeps the local sources next to the file's
    const good = await makeFile([live as unknown as RawSource]);
    assertEqual((await viaApp(r, 'POST', IMPORT_URL, good)).status, 200, 'the same file with the canonical firmware: 200');
    assertEqual(originsOf(storedDoc()), 'editor-cache/local,live-readonly/local,live-readonly/file', 'the local sources stay, the file\'s joins');
    clearDocs();
    await r.registry.applyRuntimeCache();

    // 2. one section tag per record, none declared: the derivation would filter the records once per tag (quadratic); refused
    //    at the first record, long before that, through both twins
    const undeclared = await makeFile([craftedSource(30_000, { declared: 0 })]);
    const text = JSON.stringify(undeclared);
    assert(text.length > 2_000_000 && text.length < AXISDEFS_MAX_BYTES, `fixture: a file of ${(text.length / 1048576).toFixed(1)} MiB, within the size limit`);
    let t0 = performance.now();
    const ua = await viaApp(r, 'POST', IMPORT_URL, text);
    const appMs = performance.now() - t0;
    assertEqual(importResult(ua), '400 invalid-file', 'undeclared sections: 400 invalid-file');
    assert(String(ua.json.message).includes('records[0].section') && String(ua.json.message).includes('declares'), `the message names the first record (${String(ua.json.message)})`);
    t0 = performance.now();
    const ub = await viaRouter(r, 'POST', IMPORT_URL, text);
    const routerMs = performance.now() - t0;
    assertEqual(`${ub.status} ${ub.text}`, `${ua.status} ${ua.text}`, 'the router twin answers the same');
    assert(appMs < 3_000 && routerMs < 3_000, `refused fast (Fastify ${appMs.toFixed(0)} ms, router ${routerMs.toFixed(0)} ms)`);
    assertEqual(storedDoc(), null, 'nothing stored');

    // 3. more records than the total: refused before any record is read
    const many = await makeFile([craftedSource(RAW_LIMITS.totalRecords + 1, { declared: 1 })]);
    const manyText = JSON.stringify(many);
    assert(manyText.length < AXISDEFS_MAX_BYTES, `fixture: ${(manyText.length / 1048576).toFixed(1)} MiB, within the size limit`);
    const ma = await both(r, 'POST', IMPORT_URL, manyText, 'record total');
    assertEqual(importResult(ma), '400 invalid-file', 'over the record total: 400 invalid-file');
    assert(String(ma.json.message).includes(`at most ${RAW_LIMITS.totalRecords}`), 'the message names the limit');

    // 4. the worst a valid file can be: the record total spread over the most declared sections — still cheap to derive
    const worst = await makeFile([craftedSource(RAW_LIMITS.totalRecords, { declared: RAW_LIMITS.sections })]);
    const worstText = JSON.stringify(worst);
    assert(worstText.length < AXISDEFS_MAX_BYTES, `fixture: ${(worstText.length / 1048576).toFixed(1)} MiB, within the size limit`);
    t0 = performance.now();
    const parsedWorst = await parseAxisDefs(JSON.parse(worstText));
    const parseMs = performance.now() - t0;
    assert(parsedWorst.ok, `the worst declared file passes validation (${parsedWorst.ok ? '' : JSON.stringify(parsedWorst.body).slice(0, 200)})`);
    assert(parseMs < 3_000, `validated in ${parseMs.toFixed(0)} ms`);
    t0 = performance.now();
    const wa = await quiet(() => viaApp(r, 'POST', IMPORT_URL, worstText));
    const worstMs = performance.now() - t0;
    assertEqual(importResult(wa), '422 derivation-failed', 'it describes no seed family: 422 derivation-failed');
    assert(worstMs < 8_000, `and the whole import stays cheap (${worstMs.toFixed(0)} ms)`);
    assertEqual(storedDoc(), null, 'nothing stored');
    console.log(`  api/definitions-file: crafted files: 30000 undeclared-section records refused in ${appMs.toFixed(0)} ms, the worst valid file (${RAW_LIMITS.totalRecords} records in ${RAW_LIMITS.sections} sections) validated in ${parseMs.toFixed(0)} ms and imported (refused) in ${worstMs.toFixed(0)} ms`);
  } finally { clearDocs(); await r.close(); }
}

export async function runDefinitionsFileTests(): Promise<void> {
  for (const [name, fn] of CASES) {
    try { await fn(); }
    catch (e) { throw new Error(`[api/definitions-file] ${name}: ${(e as Error).message}`); }
  }
}
