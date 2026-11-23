/**
 * profile-check: a local check of the generic block-params path (`GET /preset/blocks/:eid/params?generic=1`).
 *
 * It answers one question: does every parameter row a device profile describes show up in the generic
 * response (listed, or hidden with a reason), with nothing invented and nothing misfiled? Nothing in
 * this script is device-specific data: it reads whatever profile or server you point it at, and prints
 * the result to your terminal. Keep the profile files you check out of the repository.
 *
 * OFFLINE: build the runtime profile the way the server does (`runtimeProfileFrom` over the bundled
 * catalog), index every family (`buildParamIndex`) and print one line per family plus totals.
 *   tsx scripts/profile-check.ts --profile <file> [--model 0x11] [--key <cache-key>] [--allow-stale]
 *
 * ONLINE (read-only: GET requests only, whitelisted by path): ask a running server for its capabilities
 * and for every placed block's generic params, and compare both with the profile the server holds.
 *   tsx scripts/profile-check.ts --url http://127.0.0.1:5056 [--eid 1,2] [--profile <file>]
 *
 * Both modes also list the layout controls that write another block's parameter (a control of one
 * family's editor page that addresses a different family), and flag the ones the write guard would
 * refuse; `--probe FAMILY:pid` shows one row and the guard's verdict for it.
 *
 * DOCUMENT TOOLS (offline, need --profile; the bundled catalog and the given files only, no network, no device),
 * each through the very server function the running server uses:
 *   --rederive       re-derive the document from its raw sources (`rederiveProfileDoc`, the re-derivation of a stored
 *                    profile) and compare the result with the stored derived tables, per family; a format-1 document
 *                    has no raw sources (`no-raw`, not a finding)
 *   --diff           the definitions diff of the document against the bundled catalog, built by the pure builder of
 *                    `GET /device/definitions/diff` (`definitionsDiff`) as if the unit ran the document's firmware
 *   --merge <file2>  merge the raw sources of a second document into this one the way an import / build / pull merges
 *                    into a stored profile (`mergeSourcesIntoStored`), report the merged document and run the offline
 *                    invariants on it
 *   --blocks         the document's block map (state per `blockMapState`), its unassigned sections (`section:<tag>` /
 *                    `block:<eid>`) and the effect ids it knows that map nowhere; on an Axe-Fx III also the
 *                    roster-only ids of the static effect-id table
 *   `--eid` names placed effect ids for --diff and --blocks offline.
 *
 * Exit code: 0 all invariants hold; 1 an invariant failed (a block request the server answered with a status
 * other than 200 counts as one); 2 a usage or input error, a server that cannot be checked (GET /device or
 * /preset/blocks not answered with 200, no generic support), any request that failed at the transport level
 * (connection refused, timeout, redirect), or a --merge document the merge refuses.
 * Run with --help for the options.
 *
 * Tests call `runProfileCheck(argv)` (it never calls process.exit); `main()` only runs when this file is executed.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import {
  ProfileDerivationError, ProfileUserDataError, isInformativeRow, isPlaceholderRow, isSyntheticFamilyKey, paramFingerprint, rowsCompatible,
  sourceSummary, type BuiltCache, type ProfileCoverage, type ProfileDoc, type RawSource, type SourceSummary
} from 'forgefx-midi/cache';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { PROFILES, SLUG_FAMILY, runtimeProfileFrom, type DeviceProfile, type RangeDef } from '../src/devices.js';
import { buildParamIndex, MAX_WIRE_PID, type BlockIndex, type BlockProfileKind } from '../src/drivers/paramIndex.js';
import {
  checkProfileSchema, hasNewerRaw, profileFormatOf, profileSummaryOf, readableRaw, rederiveProfileDoc, rederiveReasonOf,
  type ProfileFormat, type ProfileSchemaCheck, type RederiveReason
} from '../src/profileSchema.js';
import { compareRows, type RowComparison } from '../src/drivers/profileCompare.js';
import { definitionsDiff, definitionsDrift } from '../src/drivers/definitionsDiff.js';
import { blockMapAccess, blockMapState, type BlockMapState } from '../src/drivers/blockMapState.js';
import type { DefinitionsDiffDTO } from '../src/drivers/types.js';
import { deviceCacheKey, firmwareOfCacheKey, staticFamilyForEffectId } from '../src/profileCatalog.js';
import { ProfileMergeRefused, mergeSourcesIntoStored } from '../src/services/profileMerge.js';
import type { Doc } from '../src/runtime/storeBackend.js';

// ── small utilities ───────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (n: number, w = 2): string => n.toString(16).padStart(w, '0');

class UsageError extends Error {}

interface Finding { code: string; where: string; message: string }
const failures: Finding[] = [];
const warnings: Finding[] = [];
const fail = (code: string, where: string, message: string): void => { failures.push({ code, where, message }); };
/** Requests that failed at the transport level (the server was never heard): exit code 2, not a finding. */
const transportErrors: Finding[] = [];
/** Input the document tools cannot use (a --merge document the merge refuses): exit code 2, not a finding. */
const inputErrors: Finding[] = [];
const warn = (code: string, where: string, message: string): void => { warnings.push({ code, where, message }); };

/** Where the report goes: stdout / stderr when executed, a buffer when a test calls `runProfileCheck`. */
let out: (line: string) => void = (line) => console.log(line);
let errOut: (...args: unknown[]) => void = (...args) => console.error(...args);

function table(header: string[], rows: string[][], align: ('l' | 'r')[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// ── arguments ─────────────────────────────────────────────────────────────────────────────────────

const HELP = `profile-check: check the generic block-params path against a device profile

Usage
  tsx scripts/profile-check.ts --profile <file> [--model <m>] [--key <k>] [--allow-stale]   offline
  tsx scripts/profile-check.ts --url http://127.0.0.1:<port> [--eid <n,n>] [--profile <file>] online, read-only
  (both can be combined; the profile file is then the comparison profile for the server)
  tsx scripts/profile-check.ts --profile <file> [--rederive] [--diff] [--merge <file2>] [--blocks] [--eid <n,n>]
                     offline document tools (they add to the offline check; no network, no device)

Options
  --profile <file>   a store file (deviceCaches.json: a map of cache key -> document), one stored document
                     ({ id, collection, data, ... }), a { key: { data } } bundle, or a bare profile document
  --model <m>        0x10 | 0x11 | 0x12, or iii | fm3 | fm9 (default: the document's own model or its key)
  --key <k>          which entry of a store file to use, e.g. 11_99p0 (default: the only one, or the one for --model)
  --allow-stale      check a profile whose schema stamp the server would refuse to use (it would not be applied)
  --url <base>       a running ForgeFX server; only GET requests are sent (/device, /preset/blocks,
                     /preset/blocks/<eid>/params?generic=1, /store/deviceCaches/<key>)
  --eid <n,n>        extra effect ids to read besides the placed blocks (repeatable), e.g. 1 for the setup block;
                     offline: the placed blocks for --diff and --blocks
  --probe FAMILY:pid show the row at that param id and whether the write guard would refuse it (repeatable)
  --list FAMILY      list every param the index serves for that family (repeatable)
  --rederive         re-derive the document from its raw sources the way the server re-derives a stored profile and
                     compare the result with the stored derived tables (rows / labels / sections per family, and the
                     other derived parts); a format-1 document has no raw sources: reported as no-raw
  --diff             the definitions diff (GET /device/definitions/diff) of the document against the bundled
                     catalog, from the same builder the route uses, as if the unit ran the document's firmware
  --merge <file2>    merge the raw sources of a second document (same loader, same model) into this one the way an
                     import / build / pull merges into a stored profile; report the merged sources, provenance,
                     conflicts and coverage, and run the offline invariants on the merged document
  --blocks           the block map (entry state, evidence, candidates), the sections no catalog family took
                     (section:<tag> / block:<eid>), the effect ids the document knows (and --eid) that map nowhere,
                     and on an Axe-Fx III the roster-only ids of the static effect-id table
  --json             print one JSON document instead of the tables (diagnostics go to stderr)
  --strict           treat warnings (layout controls that hit an unused slot) as failures
  --timeout <ms>     per-request timeout for --url (default 20000)
  --help             this text

Invariants (a failure makes the exit code 1)
  - listed + hidden (other than 'removed') equals the informative rows of the family's profile
  - every informative row of the profile's own table is listed or hidden (a live profile: shown covers it)
  - no enum-kind entry in 'named'
  - no value with unresolved 'channel-unknown' (or 'read-failed') in the served response
  - no family flagged as suspect by the section-assignment cross-check
  - the served response lists the same ids, hidden items and fingerprints as the profile predicts
  - --rederive: the raw sources derive, and the re-derived tables equal the stored ones (a document the server
    re-derives on load anyway, e.g. one of an older derivation revision, reports a difference as a warning)
  - --merge: the merged sources derive, and the invariants above hold for the merged document
  - --blocks: the block map is consistent (one entry per effect id, a confirmed entry's key has rows, a section it
    names exists); --diff only reports
Exit codes
  0  all invariants hold
  1  an invariant failed (a block request the server answered with a status other than 200 counts as one)
  2  usage or input error; the server cannot be checked (GET /device or /preset/blocks not answered with 200,
     no generic support); or any request failed at the transport level (connection refused, timeout, redirect);
     or the --merge document cannot be merged (another model, no raw sources, a source of another firmware, a
     merge the server would refuse: newer-profile / local-profile-better)`;

interface Args {
  profile?: string; key?: string; model?: number; allowStale: boolean;
  url?: string; eids: number[]; probes: { family: string; pid: number }[]; lists: string[];
  json: boolean; strict: boolean; timeoutMs: number; help: boolean;
  rederive: boolean; diff: boolean; merge?: string; blocks: boolean;
}

/** Any of the document tools was asked for (they add sections to the report and the JSON document). */
const docTools = (a: Args): boolean => a.rederive || a.diff || a.merge !== undefined || a.blocks;

function parseModel(s: string): number {
  const named: Record<string, number> = { iii: 0x10, axe3: 0x10, fm3: 0x11, fm9: 0x12 };
  const n = named[s.toLowerCase()] ?? Number(s);
  if (!Number.isInteger(n) || !PROFILES[n]) throw new UsageError(`--model: '${s}' is not a gen-3 grid model (0x10, 0x11, 0x12, iii, fm3, fm9)`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { allowStale: false, eids: [], probes: [], lists: [], json: false, strict: false, timeoutMs: 20000, help: false, rederive: false, diff: false, blocks: false };
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    switch (f) {
      case '--help': case '-h': a.help = true; break;
      case '--json': a.json = true; break;
      case '--strict': a.strict = true; break;
      case '--allow-stale': a.allowStale = true; break;
      case '--profile': a.profile = take(i++, f); break;
      case '--key': a.key = take(i++, f); break;
      case '--model': a.model = parseModel(take(i++, f)); break;
      case '--url': a.url = take(i++, f); break;
      case '--rederive': a.rederive = true; break;
      case '--diff': a.diff = true; break;
      case '--merge': a.merge = take(i++, f); break;
      case '--blocks': a.blocks = true; break;
      case '--timeout': {
        const n = Number(take(i++, f));
        if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout needs a positive number of milliseconds');
        a.timeoutMs = n;
        break;
      }
      case '--eid':
        for (const part of take(i++, f).split(',')) {
          const n = Number(part.trim());
          if (!Number.isInteger(n) || n < 0) throw new UsageError(`--eid: '${part}' is not an effect id`);
          a.eids.push(n);
        }
        break;
      case '--probe': {
        const v = take(i++, f);
        const m = /^([A-Za-z0-9_]+):(-?\d+)$/.exec(v);
        if (!m) throw new UsageError(`--probe: '${v}' is not FAMILY:pid`);
        a.probes.push({ family: m[1]!.toUpperCase(), pid: Number(m[2]) });
        break;
      }
      case '--list': a.lists.push(take(i++, f).toUpperCase()); break;
      default: throw new UsageError(`unknown option '${f}' (try --help)`);
    }
  }
  if (!a.help && !a.profile && !a.url) throw new UsageError('give --profile <file> (offline) and/or --url <server> (online); --help lists the options');
  if (!a.help && !a.profile && docTools(a)) throw new UsageError('--rederive, --diff, --merge and --blocks work on a document: give --profile <file>');
  return a;
}

// ── loading a profile ─────────────────────────────────────────────────────────────────────────────

const looksBuilt = (v: unknown): v is BuiltCache => isObj(v) && isObj(v.ranges);

interface LoadedProfile { built: BuiltCache; key: string | null; shape: 'profile' | 'document' | 'store-file' }

/** Accepts a bare `BuiltCache`, one stored document (`{ id, collection, data }`), a `{ key: { data } }` bundle,
 *  or the store collection file (`{ key: document }`). */
function loadProfileFile(path: string, wantKey: string | undefined, model: number | undefined): LoadedProfile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (looksBuilt(json)) return { built: json, key: null, shape: 'profile' };
  if (isObj(json) && looksBuilt(json.data)) return { built: json.data, key: typeof json.id === 'string' ? json.id : null, shape: 'document' };
  if (isObj(json)) {
    const entries = Object.entries(json).filter(([, v]) => looksBuilt(v) || (isObj(v) && looksBuilt(v.data)));
    if (entries.length > 0) {
      let pick = entries;
      if (wantKey) pick = entries.filter(([k]) => k === wantKey);
      else if (entries.length > 1 && model !== undefined) pick = entries.filter(([k]) => k.startsWith(`${hex(model)}_`));
      if (pick.length === 1) {
        const [k, v] = pick[0]!;
        return { built: (looksBuilt(v) ? v : (v as { data: BuiltCache }).data), key: k, shape: 'store-file' };
      }
      throw new UsageError(`${path} holds ${entries.length} profiles (${entries.map(([k]) => k).join(', ')}); pick one with --key`);
    }
  }
  throw new UsageError(`${path} is not a device profile (no 'ranges' found at the top level, under 'data', or under a cache key)`);
}

function modelOf(loaded: LoadedProfile, wanted: number | undefined): number {
  if (wanted !== undefined) return wanted;
  const own = (loaded.built as unknown as { model?: unknown }).model;
  if (typeof own === 'number' && PROFILES[own]) return own;
  const m = loaded.key ? /^([0-9a-f]{2})_/i.exec(loaded.key) : null;
  const fromKey = m ? parseInt(m[1]!, 16) : -1;
  if (PROFILES[fromKey]) return fromKey;
  throw new UsageError('cannot tell the device model from the profile; give --model (0x10, 0x11, 0x12)');
}

// ── what the server resolves (mirrors, so a script never reaches into a driver's privates) ────────

/** The family of an effect id, the way the gen-3 driver resolves it: the audio-block slug first, then the
 *  profile's own map (virtual effects such as the setup block). */
const familyOfEid = (p: DeviceProfile, eid: number): string | undefined =>
  SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()] ?? p.familyForEffectId(eid);

/** family -> the effect ids that resolve to it (0..255). A family absent here has no effect id: no block
 *  addresses it, so the generic response can never reach it. */
function reachableFamilies(p: DeviceProfile): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let eid = 0; eid <= 255; eid++) {
    const fam = familyOfEid(p, eid);
    if (fam) (out.get(fam) ?? out.set(fam, []).get(fam)!).push(eid);
  }
  return out;
}

/** A placed effect id no family describes, the way the gen-3 driver decides it (`unmappedPlacedEffectIds`): not a
 *  block the applied document's block map confirms, and no family by the audio-block slug, the runtime profile's map
 *  (block-map overlay included) or the model's static tables. */
function mapsNowhere(p: DeviceProfile, model: number, eid: number): boolean {
  if (p.profileFacts?.confirmedBlocks.has(eid)) return false;
  return (familyOfEid(p, eid) ?? staticFamilyForEffectId(model, eid)) === undefined;
}

interface GuardVerdict { status: 200 | 400 | 409; reason: string }

/**
 * Would the driver's write guard refuse a write to (family, pid)? A pure re-implementation of the guard in
 * the gen-3 driver (`#guardParamWrite`; a private method, so it cannot be called from here). Keep the two in
 * step. The rules, in order:
 *   - 400: the id is no wire parameter (not an integer, negative, or above 0x3FFF: the editor's pseudo ids);
 *   - allowed: the catalog defines a param at that id (a catalog param with an all-zero row stays writable);
 *   - 409: no catalog definition and the effective row, or a byte-exact profile's own row (a live profile's
 *     placeholder rows say nothing; a family flagged as suspect has none), is an all-zero placeholder row
 *     (an unused slot on this firmware);
 *   - allowed otherwise (no row at all: cross-block and foot-controller writes keep working).
 * The driver resolves the family from the effect id; here it is given.
 */
function writeGuardVerdict(profile: DeviceProfile, family: string, pid: number): GuardVerdict {
  if (!Number.isInteger(pid) || pid < 0 || pid > MAX_WIRE_PID) return { status: 400, reason: `param id ${pid} is not a wire parameter` };
  const catalog = profile.staticBase ?? profile;
  if ((catalog.params[family] ?? []).some((d) => d.paramId === pid)) return { status: 200, reason: 'the catalog defines this param' };
  const facts = profile.profileFacts;
  const effective = profile.ranges[family]?.[pid];
  const profiled = facts?.byteExact && !facts.suspectFamilies.includes(family) ? facts.ranges[family]?.[pid] : undefined;
  if ((effective && isPlaceholderRow(effective)) || (profiled && isPlaceholderRow(profiled))) {
    return { status: 409, reason: `param ${pid} of ${family} is an unused slot on this firmware; write refused` };
  }
  return { status: 200, reason: effective || profiled ? 'row is not a placeholder' : 'no row: not guarded' };
}

// ── per-family analysis ───────────────────────────────────────────────────────────────────────────

interface FamilyReport {
  family: string; eids: number[]; reachable: boolean;
  profile: BlockProfileKind; suspect: boolean; positional: boolean | null;
  /** Informative rows (pid <= 0x3FFF) of the family's profile, counted from the raw rows, not the index. */
  rows: number;
  shown: number; named: number; enums: number;
  /** Hidden for a reason other than 'removed' (they are informative rows too). */
  hidden: number; hiddenByReason: Record<string, number>;
  /** Catalog rows a byte-exact profile no longer has (not informative rows of the profile). */
  removed: number;
  generic: number; isNew: number;
  /** nameConfidence of every named row: the listed ones and the hidden ones (type / bypass rows keep their name). */
  confidence: { high: number; medium: number; low: number };
  /** The same for the listed entries alone. */
  confidenceListed: { high: number; medium: number; low: number };
  newPids: number[]; genericPids: number[]; enumInNamed: number[];
}

function informativeRowCount(profile: DeviceProfile, family: string, kind: BlockProfileKind): number {
  const rows = kind === 'byte-exact' ? profile.profileFacts?.ranges[family] : profile.ranges[family];
  let n = 0;
  for (const [k, r] of Object.entries(rows ?? {})) if (Number(k) <= MAX_WIRE_PID && isInformativeRow(r)) n++;
  return n;
}

/** nameConfidence of a hidden row (the index only reports it for listed entries): the same rule as the index,
 *  from the profile's own rows. Undefined when the catalog has no name at that id. */
function hiddenConfidence(profile: DeviceProfile, family: string, pid: number): 'high' | 'medium' | 'low' | undefined {
  const base = profile.staticBase ?? profile;
  if (!(base.params[family] ?? []).some((d) => d.paramId === pid)) return undefined;
  const facts = profile.profileFacts;
  const e = profile.ranges[family]?.[pid];
  const c = base.ranges[family]?.[pid];
  if (!e) return undefined;
  if (!facts || !(facts.appliedRows[family]?.has(pid) ?? false)) {
    // a suspect family's profile section belongs to another family: its rows say nothing about this one
    const walked = facts && !facts.suspectFamilies.includes(family) ? facts.ranges[family]?.[pid] : undefined;
    return !facts?.byteExact && walked && c && walked.displayMin !== walked.displayMax && walked.kind !== c.kind ? 'medium' : 'high';
  }
  if (!c || !isInformativeRow(c)) return 'low';
  if (c.synthetic) return c.kind === e.kind ? 'medium' : 'low';
  const catLabels = base.enumLabelsFor(family, pid);
  const own = facts.enumLabels[family]?.[String(pid)];
  const effLabels = !facts.byteExact ? profile.enumLabelsFor(family, pid) : own && own.length > 0 ? own : paramFingerprint(c) === paramFingerprint(e) ? catLabels : undefined;
  if (paramFingerprint(c, catLabels) === paramFingerprint(e, effLabels)) return 'high';
  return rowsCompatible(c, catLabels, e, effLabels) ? 'medium' : 'low';
}

/** Informative rows of the profile's own table for `family` that are neither listed nor hidden. For a byte-exact
 *  profile the count check implies none; for a live profile (merged over the catalog) it is the "the served
 *  set covers everything the profile saw" check. A suspect family's profile rows are not used, so none count. */
function unservedProfileRows(profile: DeviceProfile, family: string, served: ReadonlySet<number>): number[] {
  const facts = profile.profileFacts;
  const rows = facts && !facts.suspectFamilies.includes(family) ? facts.ranges[family] : undefined;
  if (!rows) return [];
  return Object.keys(rows).map(Number).filter((pid) => pid <= MAX_WIRE_PID && isInformativeRow(rows[pid]!) && !served.has(pid)).sort((a, b) => a - b);
}

/** `prefix` labels where a finding is (`''` for the checked document, `'merged '` for the --merge result). */
function analyseFamily(profile: DeviceProfile, family: string, reach: Map<string, number[]>, prefix = ''): FamilyReport {
  const idx = buildParamIndex(profile, family);
  const hiddenByReason: Record<string, number> = {};
  for (const h of idx.hidden) hiddenByReason[h.reason] = (hiddenByReason[h.reason] ?? 0) + 1;
  const confidenceListed = { high: 0, medium: 0, low: 0 };
  for (const e of idx.entries) if (e.nameConfidence) confidenceListed[e.nameConfidence]++;
  const confidence = { ...confidenceListed };
  for (const h of idx.hidden) {
    if (h.reason === 'removed') continue;
    const c = hiddenConfidence(profile, family, h.id);
    if (c) confidence[c]++;
  }
  const rep: FamilyReport = {
    family, eids: reach.get(family) ?? [], reachable: reach.has(family),
    profile: idx.profile, suspect: idx.suspect, positional: idx.positional,
    rows: informativeRowCount(profile, family, idx.profile),
    shown: idx.entries.length,
    named: idx.entries.filter((e) => e.list === 'named').length,
    enums: idx.entries.filter((e) => e.list === 'enums').length,
    hidden: idx.hidden.length - (hiddenByReason.removed ?? 0), hiddenByReason,
    removed: hiddenByReason.removed ?? 0,
    generic: idx.entries.filter((e) => e.generic).length,
    isNew: idx.entries.filter((e) => e.isNew).length,
    confidence, confidenceListed,
    newPids: idx.entries.filter((e) => e.isNew).map((e) => e.pid),
    genericPids: idx.entries.filter((e) => e.generic && !e.isNew).map((e) => e.pid),
    enumInNamed: idx.entries.filter((e) => e.list === 'named' && e.kind === 'enum').map((e) => e.pid),
  };
  const where = `${prefix}${family}`;
  const unserved = unservedProfileRows(profile, family, new Set([...idx.entries.map((e) => e.pid), ...idx.hidden.map((h) => h.id)]));
  if (unserved.length) fail('profile-row-not-served', where, `informative profile rows neither listed nor hidden: pid ${unserved.slice(0, 12).join(', ')}${unserved.length > 12 ? ' ...' : ''}`);
  if (rep.shown + rep.hidden !== rep.rows) fail('count-mismatch', where, `listed ${rep.shown} + hidden ${rep.hidden} = ${rep.shown + rep.hidden}, the profile has ${rep.rows} informative rows`);
  if (rep.enumInNamed.length) fail('enum-in-named', where, `enum-kind entries in 'named': pid ${rep.enumInNamed.join(', ')}`);
  if (rep.suspect) fail('suspect-family', where, 'the section-assignment cross-check flagged this family: its profile rows were not used');
  return rep;
}

/** The catalog families of a profile. A synthetic key (`section:<tag>` / `block:<eid>`: an unassigned section of a
 *  profile document) is no catalog family: it is left out of the per-family report and its totals. */
function familiesOf(profile: DeviceProfile): string[] {
  return [...new Set([...Object.keys(profile.ranges), ...Object.keys(profile.params)])].filter((f) => !isSyntheticFamilyKey(f)).sort();
}

interface Totals { rows: number; shown: number; named: number; enums: number; hidden: number; removed: number; generic: number; isNew: number; high: number; medium: number; low: number }
function sumUp(reps: FamilyReport[]): Totals {
  const t: Totals = { rows: 0, shown: 0, named: 0, enums: 0, hidden: 0, removed: 0, generic: 0, isNew: 0, high: 0, medium: 0, low: 0 };
  for (const r of reps) {
    t.rows += r.rows; t.shown += r.shown; t.named += r.named; t.enums += r.enums; t.hidden += r.hidden; t.removed += r.removed;
    t.generic += r.generic; t.isNew += r.isNew; t.high += r.confidence.high; t.medium += r.confidence.medium; t.low += r.confidence.low;
  }
  return t;
}

// compareRows / RowComparison: src/drivers/profileCompare.ts (shared with the editor-cache contribution check).

// ── layout controls that write another block's param ──────────────────────────────────────────────

interface LayoutRef {
  from: string; to: string; pid: number; paramName: string | null;
  controls: number; effects: string[]; eids: number[];
  status: 200 | 400 | 409; reason: string;
}

/** Walks the editor layouts of the profile. `cross`: every control that names another family's param (the
 *  referenced family and id, as `layoutWidgetIndex` reads them). `own`: the controls of a family's own
 *  page whose id the write guard would refuse. A control with no param id, or a cross reference that did
 *  not resolve to a family, names no param and is skipped. */
function layoutRefs(profile: DeviceProfile, reach: Map<string, number[]>, mode: 'cross' | 'own'): LayoutRef[] {
  const layouts = profile.editorLayouts;
  const groups = new Map<string, LayoutRef>();
  if (!layouts) return [];
  for (const block of Object.values(layouts)) {
    for (const variant of block.variants) for (const page of variant.pages) for (const row of page.rows) for (const c of row.controls) {
      let to = block.family;
      let pid = c.paramId;
      if (c.crossBlock) {
        if (!c.crossBlock.family) continue;
        to = c.crossBlock.family;
        pid = c.crossBlock.paramId ?? c.paramId;
      }
      if (pid == null) continue;
      const isCross = to !== block.family;
      if (mode === 'cross' ? !isCross : isCross) continue;
      const verdict = writeGuardVerdict(profile, to, pid);
      if (mode === 'own' && verdict.status !== 409) continue;
      const key = `${block.family}>${to}:${pid}`;
      let g = groups.get(key);
      if (!g) {
        g = { from: block.family, to, pid, paramName: c.crossBlock?.paramName ?? c.paramName, controls: 0, effects: [], eids: reach.get(to) ?? [], status: verdict.status, reason: verdict.reason };
        groups.set(key, g);
      }
      g.controls++;
      if (c.crossBlock && !g.effects.includes(c.crossBlock.effect)) g.effects.push(c.crossBlock.effect);
    }
  }
  return [...groups.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.pid - b.pid);
}

interface LayoutReport { cross: LayoutRef[]; ownRefused: LayoutRef[] }
function layoutReport(profile: DeviceProfile, reach: Map<string, number[]>, where: string): LayoutReport {
  const cross = layoutRefs(profile, reach, 'cross');
  const ownRefused = layoutRefs(profile, reach, 'own');
  for (const r of cross) {
    if (r.status === 409) warn('guard-409-cross-block', where, `${r.from} layout writes ${r.to} pid ${r.pid} (${r.paramName ?? '?'}): ${r.reason}${r.eids.length ? '' : ' (the family has no effect id)'}`);
  }
  for (const r of ownRefused) warn('guard-409-own-block', where, `${r.from} layout control pid ${r.pid} (${r.paramName ?? '?'}): ${r.reason}`);
  return { cross, ownRefused };
}

function printLayoutReport(rep: LayoutReport): void {
  const groups = new Map<string, LayoutRef[]>();
  for (const r of rep.cross) (groups.get(`${r.from} -> ${r.to}`) ?? groups.set(`${r.from} -> ${r.to}`, []).get(`${r.from} -> ${r.to}`)!).push(r);
  out('\nLayout controls that write another block\'s param (cross-block):');
  if (groups.size === 0) out('  none');
  const rows: string[][] = [];
  for (const [k, list] of groups) {
    const hits = list.filter((r) => r.status === 409);
    const pseudo = list.filter((r) => r.status === 400);
    const noRow = list.filter((r) => r.status === 200 && r.reason.startsWith('no row'));
    rows.push([k, String(list.length), String(list.reduce((n, r) => n + r.controls, 0)), list[0]!.eids.length ? list[0]!.eids.slice(0, 3).join(',') : 'none', String(hits.length), String(pseudo.length), String(noRow.length)]);
  }
  if (rows.length) out(table(['LAYOUT -> TARGET', 'PIDS', 'CONTROLS', 'TARGET EID', 'GUARD 409', 'PSEUDO 400', 'NO ROW'], rows, ['l', 'r', 'r', 'l', 'r', 'r', 'r']));
  const hits = rep.cross.filter((r) => r.status === 409);
  for (const r of hits) out(`  HIT  ${r.from} -> ${r.to} pid ${r.pid} ${r.paramName ?? ''}  [${r.effects.join(',') || '-'}]${r.eids.length ? '' : '  (no effect id)'}`);
  out('  GUARD 409 = would be refused (an unused slot, no catalog param); PSEUDO 400 = id above 0x3FFF; NO ROW = the profile has no row at the id, so the guard lets it pass.');
  if (rep.ownRefused.length) {
    out('\nOwn-family layout controls the write guard would refuse:');
    for (const r of rep.ownRefused) out(`  HIT  ${r.from} pid ${r.pid} ${r.paramName ?? ''}  (${r.controls} control${r.controls === 1 ? '' : 's'})`);
  }
}

// ── --probe and --list ────────────────────────────────────────────────────────────────────────────

function describeRow(r: Readonly<RangeDef> | undefined): string {
  if (!r) return '(no row)';
  const tags = [isPlaceholderRow(r) ? 'placeholder' : isInformativeRow(r) ? 'informative' : 'degenerate', r.synthetic ? 'synthetic' : ''].filter(Boolean).join(' ');
  return `${r.kind} tc=0x${r.typecode.toString(16)} ${r.displayMin}..${r.displayMax} step=${r.step} scale=${r.scale}${r.enumCount != null ? ` enumCount=${r.enumCount}` : ''}  [${tags}]`;
}

interface ProbeReport {
  family: string; pid: number; catalogName: string | null; catalogRow: string; effectiveRow: string; profileRow: string | null;
  served: string; guard: GuardVerdict;
}
function probe(profile: DeviceProfile, family: string, pid: number): ProbeReport {
  const base = profile.staticBase ?? profile;
  const def = (base.params[family] ?? []).find((d) => d.paramId === pid);
  const facts = profile.profileFacts;
  const idx = buildParamIndex(profile, family);
  const entry = idx.byPid.get(pid);
  const hid = idx.hidden.find((h) => h.id === pid);
  // a synthetic key is probed like a family when the profile holds rows under it
  const known = familiesOf(profile).includes(family) || (isSyntheticFamilyKey(family) && profile.ranges[family] !== undefined);
  const guard = writeGuardVerdict(profile, family, pid);
  if (!known) warn('probe-family', family, `no family '${family}' in this profile or catalog; the driver would resolve the family from the effect id`);
  return {
    family, pid, catalogName: def ? def.name : null,
    catalogRow: describeRow(base.ranges[family]?.[pid]),
    effectiveRow: describeRow(profile.ranges[family]?.[pid]),
    profileRow: facts ? describeRow(facts.ranges[family]?.[pid]) : null,
    served: entry ? `listed as ${entry.name} (${entry.list}, ${entry.widget}, ${entry.generic ? 'generic' : 'named'}, write=${entry.write ?? 'none'})` : hid ? `hidden (${hid.reason})` : 'not served',
    guard,
  };
}

function printProbe(p: ProbeReport): void {
  out(`\nprobe ${p.family}:${p.pid}${p.catalogName ? `  (catalog name ${p.catalogName})` : '  (no catalog name)'}`);
  out(`  catalog row    ${p.catalogRow}`);
  out(`  effective row  ${p.effectiveRow}`);
  if (p.profileRow !== null) out(`  profile row    ${p.profileRow}`);
  out(`  served         ${p.served}`);
  out(`  write guard    ${p.guard.status === 200 ? 'allows' : `refuses with ${p.guard.status}`}: ${p.guard.reason}`);
}

function listFamily(profile: DeviceProfile, family: string): void {
  const idx = buildParamIndex(profile, family);
  out(`\n${family}: ${idx.entries.length} listed, ${idx.hidden.length} hidden (profile ${idx.profile}${idx.suspect ? ', suspect' : ''})`);
  out(table(
    ['PID', 'NAME', 'LIST', 'KIND', 'WIDGET', 'SRC', 'NAME-SRC', 'CONF', 'FLAGS'],
    idx.entries.map((e) => [String(e.pid), e.name, e.list, e.kind, e.widget, e.source, e.nameSource, e.nameConfidence ?? '-', [e.generic ? 'generic' : '', e.isNew ? 'new' : '', e.write === null ? 'read-only' : ''].filter(Boolean).join(',')]),
    ['r', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l'],
  ));
  if (idx.hidden.length) out(`hidden: ${idx.hidden.map((h) => `${h.id}(${h.reason})`).join(' ')}`);
}

// ── offline ───────────────────────────────────────────────────────────────────────────────────────

interface OfflineReport {
  file: string; key: string | null; shape: string; model: string; source: string; byteExact: boolean;
  firmware: string | null; catalogFirmware: string | null; schema: { stored: number | null; current: number; usable: boolean; reason?: string };
  recordCount: number | null; suspectFamilies: string[];
  families: FamilyReport[]; totals: Totals; unreachable: Totals; rowComparison: RowComparison;
  layout: LayoutReport; probes: ProbeReport[];
}

interface OfflineRun { report: OfflineReport; profile: DeviceProfile; loaded: LoadedProfile; model: number }

function runOffline(args: Args): OfflineRun {
  const loaded = loadProfileFile(args.profile!, args.key, args.model);
  const model = modelOf(loaded, args.model);
  const check = checkProfileSchema(loaded.built);
  if (!check.usable && !args.allowStale) {
    throw new UsageError(`the profile's schema is stale (${check.reason}: stored ${check.schema ?? 'none'}, this build writes ${check.current}), so the server would not apply it. Re-run with --allow-stale to look at it anyway`);
  }
  const { report, profile } = offlineReportOf(loaded.built, { file: args.profile!, key: loaded.key, shape: loaded.shape }, model, check, args.probes, '');
  return { report, profile, loaded, model };
}

/** The offline check of one document (the --profile document, or the --merge result with `prefix` 'merged '). */
function offlineReportOf(
  built: BuiltCache, origin: { file: string; key: string | null; shape: string }, model: number, check: ProfileSchemaCheck,
  probes: Args['probes'], prefix: string
): { report: OfflineReport; profile: DeviceProfile } {
  const staticProfile = PROFILES[model]!;
  const profile = runtimeProfileFrom(built, staticProfile);
  const facts = profile.profileFacts!;
  const reach = reachableFamilies(profile);

  const families = familiesOf(profile)
    .map((f) => analyseFamily(profile, f, reach, prefix))
    .filter((r) => r.rows > 0 || r.shown > 0 || r.hidden > 0);
  const reachable = families.filter((r) => r.reachable);
  const unreachable = families.filter((r) => !r.reachable);
  for (const f of facts.suspectFamilies) {
    if (!families.some((r) => r.family === f && r.suspect)) fail('suspect-family', `${prefix}${f}`, 'the section-assignment cross-check flagged this family');
  }
  const layout = layoutReport(profile, reach, `${prefix}model 0x${hex(model)}`);
  const report: OfflineReport = {
    file: origin.file, key: origin.key, shape: origin.shape, model: `0x${hex(model)} ${staticProfile.name}`,
    source: facts.source, byteExact: facts.byteExact, firmware: facts.firmware, catalogFirmware: staticProfile.catalogFirmware,
    schema: { stored: check.schema, current: check.current, usable: check.usable, ...(check.usable ? {} : { reason: check.reason }) },
    recordCount: typeof built.meta?.recordCount === 'number' ? built.meta.recordCount : null,
    suspectFamilies: [...facts.suspectFamilies],
    families, totals: sumUp(reachable), unreachable: sumUp(unreachable),
    rowComparison: compareRows(built, staticProfile, facts.suspectFamilies, facts.isByteExactFamily),
    layout, probes: probes.map((p) => probe(profile, p.family, p.pid)),
  };
  return { report, profile };
}

/** The per-family table (reachable families + total, then the families no effect id reaches), every line after
 *  `indent` (none for the checked document, so its report stays as it always was). */
function printFamilyTable(r: OfflineReport, indent = ''): void {
  const emit = (text: string): void => out(indent ? text.split('\n').map((l) => (l ? indent + l : l)).join('\n') : text);
  const flag = (f: FamilyReport) => [f.suspect ? 'SUSPECT' : '', f.reachable ? '' : 'no-eid', f.positional === false ? 'non-positional' : ''].filter(Boolean).join(' ');
  const row = (f: FamilyReport) => [
    f.family, f.eids[0] !== undefined ? String(f.eids[0]) : '-', f.profile, String(f.rows), String(f.shown), String(f.named), String(f.enums),
    String(f.hidden), String(f.removed), String(f.generic), String(f.isNew),
    String(f.confidence.high), String(f.confidence.medium), String(f.confidence.low), flag(f),
  ];
  const header = ['FAMILY', 'EID', 'PROFILE', 'ROWS', 'SHOWN', 'NAMED', 'ENUMS', 'HIDDEN', 'REMOVED', 'GENERIC', 'NEW', 'HIGH', 'MED', 'LOW', 'FLAGS'];
  const align: ('l' | 'r')[] = ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];
  const totalRow = (label: string, t: Totals) => [label, '', '', String(t.rows), String(t.shown), String(t.named), String(t.enums), String(t.hidden), String(t.removed), String(t.generic), String(t.isNew), String(t.high), String(t.medium), String(t.low), ''];
  const reachable = r.families.filter((f) => f.reachable);
  const unreachable = r.families.filter((f) => !f.reachable);
  emit(table(header, [...reachable.map(row), totalRow('TOTAL (blocks)', r.totals)], align));
  if (unreachable.length) {
    emit('\nFamilies no effect id reaches (the generic response cannot serve them; not in the total):');
    emit(table(header, [...unreachable.map(row), totalRow('subtotal', r.unreachable)], align));
  }
}

function printOffline(r: OfflineReport, profile: DeviceProfile, args: Args): void {
  out(`Offline check of ${r.file}${r.key ? `  [key ${r.key}]` : ''}`);
  out(`  device ${r.model}; profile source ${r.source} (${r.byteExact ? 'byte-exact' : 'live walk'}); firmware ${r.firmware ?? 'not stated'}; bundled catalog firmware ${r.catalogFirmware ?? 'not settled'}`);
  out(`  schema ${r.schema.stored ?? 'none'} (this build ${r.schema.current})${r.schema.usable ? '' : `  STALE (${r.schema.reason}): the server would not apply it; checked because of --allow-stale`}${r.recordCount !== null ? `; ${r.recordCount} records` : ''}`);
  out(`  suspect families: ${r.suspectFamilies.length ? r.suspectFamilies.join(', ') : 'none'}\n`);
  printFamilyTable(r);
  const reachable = r.families.filter((f) => f.reachable);
  out('\nROWS = informative rows (pid <= 0x3FFF) of the family counted from the profile itself; SHOWN + HIDDEN must equal ROWS.');
  out('HIDDEN = bypass / type / by-design rows; REMOVED = catalog rows a byte-exact profile no longer has (not rows of the profile).');
  out('HIGH / MED / LOW = nameConfidence of every named row, the hidden type / bypass rows included (generic params carry none; --json has the listed-only counts).');
  const nw = reachable.filter((f) => f.newPids.length).map((f) => `${f.family} ${f.newPids.join(',')}`);
  const gn = reachable.filter((f) => f.genericPids.length).map((f) => `${f.family} x${f.genericPids.length}`);
  out(`new params (no informative catalog row): ${nw.length ? nw.join('; ') : 'none'}`);
  out(`generic params the catalog has rows for but no name: ${gn.length ? gn.join('; ') : 'none'}`);
  const c = r.rowComparison;
  out(`\nRow-by-row against the bundled catalog (all families, hidden rows included, before any naming rule): ${c.exact} exact, ${c.compatible} compatible, ${c.incompatible} incompatible, ${c.newRows} new${c.removed !== null ? `, ${c.removed} removed` : ''}${c.skippedFamilies.length ? `; skipped suspect ${c.skippedFamilies.join(', ')}` : ''}`);
  printLayoutReport(r.layout);
  for (const p of r.probes) printProbe(p);
  for (const f of args.lists) listFamily(profile, f);
}

// ── document tools: shared ────────────────────────────────────────────────────────────────────────

/** JSON text of `v` with every object's keys in sorted order: two values are equal as stored JSON exactly when these
 *  texts are (an in-memory `undefined` property is dropped the way a JSON write drops it). */
function canon(v: unknown): string {
  const json = JSON.stringify(v);
  if (json === undefined) return 'undefined';
  const sortKeys = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (isObj(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]));
    return x;
  };
  return JSON.stringify(sortKeys(JSON.parse(json)));
}

const byNum = (a: number, b: number) => a - b;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const list = (xs: readonly (string | number)[], max = 12): string => (xs.length === 0 ? 'none' : `${xs.slice(0, max).join(', ')}${xs.length > max ? ` ... (+${xs.length - max})` : ''}`);

/** One summary line per raw source of a format-2 document (empty when the envelope is malformed). */
function sourceSummariesOf(built: BuiltCache): SourceSummary[] {
  const raw = (built as unknown as { raw?: { sources?: unknown } }).raw;
  if (!isObj(raw) || !Array.isArray(raw.sources)) return [];
  try { return (raw.sources as RawSource[]).map((s) => sourceSummary(s)); } catch { return []; }
}

const sourceTable = (sources: readonly SourceSummary[]): string =>
  table(['ID', 'KIND', 'ORIGIN', 'CAPTURED', 'FIRMWARE', 'RECORDS'],
    sources.map((s) => [s.id, s.kind, s.origin, s.capturedAt ?? '-', s.firmware ?? '-', String(s.records)]), ['l', 'l', 'l', 'l', 'l', 'r']);

/** The document key the tools address the document by: the loaded key, else the model's key of the document's
 *  firmware (`<model-hex>_<major>p<minor>`), else none. */
function documentKey(loaded: LoadedProfile, model: number): string | null {
  if (loaded.key) return loaded.key;
  const fw = typeof loaded.built.firmware === 'string' ? /^(\d+)\.(\d+)$/.exec(loaded.built.firmware) : null;
  return fw ? deviceCacheKey(model, Number(fw[1]), Number(fw[2])) : null;
}

// ── --rederive ────────────────────────────────────────────────────────────────────────────────────

/** The difference of one family key (a catalog family or a synthetic `section:` / `block:` key) between the stored
 *  and the re-derived tables. `added` = only in the re-derived tables, `removed` = only in the stored ones. */
interface FamilyTableDiff {
  family: string;
  rows: { stored: number; rederived: number; added: number[]; removed: number[]; changed: number[] };
  labels: { added: number[]; removed: number[]; changed: number[] };
  section: { stored: unknown; rederived: unknown } | null;
}

interface RederiveReport {
  /** equal / mismatch: re-derived and compared; no-raw: a format-1 document; unreadable-raw: a raw envelope this build
   *  cannot read (a newer build's, or malformed); failed: the derivation threw (`message`). */
  status: 'equal' | 'mismatch' | 'no-raw' | 'unreadable-raw' | 'failed';
  format: ProfileFormat;
  /** What loading the stored document would do (`rederiveReasonOf`): null = the server uses the stored tables as they
   *  are; otherwise it re-derives them on load (and a difference is expected, reported as a warning). */
  onLoad: RederiveReason | null;
  message: string;
  sources: SourceSummary[];
  /** The derivation stamps of the stored and the re-derived document (not compared). */
  stamps: Record<'schema' | 'derivedRevision' | 'derivedWith', { stored: unknown; rederived: unknown }> | null;
  families: { compared: number; differing: number };
  differences: FamilyTableDiff[];
  /** The other derived parts of the document and whether they are equal (`keys`: the keys of a map that differ). */
  parts: Array<{ part: string; equal: boolean; keys?: string[] }>;
}

/** Keys of two maps whose values differ: only in `after`, only in `before`, in both but not equal. */
function keyedDiff(before: unknown, after: unknown): { added: string[]; removed: string[]; changed: string[] } {
  const a = isObj(before) ? before : {};
  const b = isObj(after) ? after : {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === undefined) added.push(k);
    else if (b[k] === undefined) removed.push(k);
    else if (canon(a[k]) !== canon(b[k])) changed.push(k);
  }
  return { added, removed, changed };
}
const pids = (ks: string[]): number[] => ks.map(Number).sort(byNum);

/** Document-level derived parts compared besides the per-family tables (top-level keys, then `meta` keys). */
const DERIVED_PARTS = ['rosters', 'cabIrs', 'unmappedSections', 'unmappedFamilies', 'sections', 'blockMap', 'provenance', 'coverage', 'model', 'firmware'] as const;
const DERIVED_META = ['recordCount', 'source', 'origin', 'walk', 'issues', 'sources'] as const;

function runRederive(built: BuiltCache, model: number): RederiveReport {
  const format = profileFormatOf(built);
  const onLoad = rederiveReasonOf(built);
  const base: RederiveReport = {
    status: 'no-raw', format, onLoad, message: '', sources: sourceSummariesOf(built), stamps: null,
    families: { compared: 0, differing: 0 }, differences: [], parts: []
  };
  if (format === 1) {
    return { ...base, message: 'a format-1 document holds derived tables only, no raw sources to re-derive from (import the editor cache or read the definitions from the device to get a format-2 document)' };
  }
  if (!readableRaw(built)) {
    const f = (built as unknown as { raw: { format?: unknown } }).raw.format;
    return {
      ...base, status: 'unreadable-raw',
      message: hasNewerRaw(built)
        ? `the raw envelope was written by a newer build (raw format ${String(f)}): this build cannot re-derive it`
        : `the raw envelope is malformed (raw format ${String(f)}): no build can re-derive it`
    };
  }
  const doc = built as unknown as ProfileDoc;
  const derivedAt = typeof doc.meta?.derivedAt === 'string' ? doc.meta.derivedAt : new Date().toISOString();
  let re: ProfileDoc;
  try {
    re = rederiveProfileDoc(doc, model, derivedAt);
  } catch (e) {
    fail('rederive-failed', 'rederive', `the raw sources do not derive: ${errMsg(e)}`);
    return { ...base, status: 'failed', message: errMsg(e) };
  }
  const stored = doc as unknown as Record<string, unknown>;
  const fresh = re as unknown as Record<string, unknown>;
  const tableOf = (d: Record<string, unknown>, part: string): Record<string, unknown> => (isObj(d[part]) ? (d[part] as Record<string, unknown>) : {});
  const keys = new Set<string>();
  for (const d of [stored, fresh]) for (const part of ['ranges', 'enumOverrides', 'rangeSections']) for (const k of Object.keys(tableOf(d, part))) keys.add(k);
  const differences: FamilyTableDiff[] = [];
  for (const family of [...keys].sort()) {
    const sRows = tableOf(stored, 'ranges')[family];
    const fRows = tableOf(fresh, 'ranges')[family];
    const rows = keyedDiff(sRows, fRows);
    const labels = keyedDiff(tableOf(stored, 'enumOverrides')[family], tableOf(fresh, 'enumOverrides')[family]);
    const sSec = tableOf(stored, 'rangeSections')[family];
    const fSec = tableOf(fresh, 'rangeSections')[family];
    const section = canon(sSec) === canon(fSec) ? null : { stored: sSec ?? null, rederived: fSec ?? null };
    const rowsDiffer = rows.added.length + rows.removed.length + rows.changed.length > 0 || (sRows === undefined) !== (fRows === undefined);
    const labelsDiffer = labels.added.length + labels.removed.length + labels.changed.length > 0;
    if (!rowsDiffer && !labelsDiffer && !section) continue;
    differences.push({
      family,
      rows: { stored: isObj(sRows) ? Object.keys(sRows).length : 0, rederived: isObj(fRows) ? Object.keys(fRows).length : 0, added: pids(rows.added), removed: pids(rows.removed), changed: pids(rows.changed) },
      labels: { added: pids(labels.added), removed: pids(labels.removed), changed: pids(labels.changed) },
      section
    });
  }
  const parts: RederiveReport['parts'] = [];
  for (const part of DERIVED_PARTS) {
    const equal = canon(stored[part]) === canon(fresh[part]);
    const entry: RederiveReport['parts'][number] = { part, equal };
    if (!equal && (part === 'rosters' || part === 'cabIrs')) {
      const d = keyedDiff(stored[part], fresh[part]);
      entry.keys = [...d.added, ...d.removed, ...d.changed].sort();
    }
    parts.push(entry);
  }
  const sMeta = isObj(stored.meta) ? stored.meta : {};
  const fMeta = isObj(fresh.meta) ? fresh.meta : {};
  for (const k of DERIVED_META) parts.push({ part: `meta.${k}`, equal: canon(sMeta[k]) === canon(fMeta[k]) });
  const stamps: RederiveReport['stamps'] = {
    schema: { stored: sMeta.schema ?? null, rederived: fMeta.schema ?? null },
    derivedRevision: { stored: sMeta.derivedRevision ?? null, rederived: fMeta.derivedRevision ?? null },
    derivedWith: { stored: sMeta.derivedWith ?? null, rederived: fMeta.derivedWith ?? null },
  };
  const otherDiffs = parts.filter((p) => !p.equal);
  const status = differences.length === 0 && otherDiffs.length === 0 ? 'equal' : 'mismatch';
  // a document the server re-derives on load anyway (an older revision, another schema) is expected to differ
  const note = onLoad ? ` (the server re-derives this document on load: ${onLoad})` : '';
  const report = onLoad ? warn : fail;
  for (const d of differences) {
    const bits = [
      d.rows.added.length + d.rows.removed.length + d.rows.changed.length > 0 ? `rows +${d.rows.added.length} -${d.rows.removed.length} ~${d.rows.changed.length} (pid ${list([...d.rows.added, ...d.rows.removed, ...d.rows.changed].sort(byNum), 8)})` : '',
      d.labels.added.length + d.labels.removed.length + d.labels.changed.length > 0 ? `labels +${d.labels.added.length} -${d.labels.removed.length} ~${d.labels.changed.length}` : '',
      d.section ? 'section meta differs' : '',
    ].filter(Boolean).join('; ');
    report('rederive-mismatch', `rederive ${d.family}`, `the re-derived tables differ from the stored ones: ${bits || 'the family is only on one side'}${note}`);
  }
  for (const p of otherDiffs) report('rederive-mismatch', 'rederive', `${p.part} differs from the stored document${p.keys?.length ? ` (${list(p.keys, 8)})` : ''}${note}`);
  return {
    ...base, status, stamps, differences, parts,
    families: { compared: keys.size, differing: differences.length },
    message: status === 'equal'
      ? `the re-derived tables equal the stored ones (${keys.size} family keys, ${parts.length} other parts compared)`
      : `${differences.length} of ${keys.size} family keys and ${otherDiffs.length} other part(s) differ`
  };
}

function printRederive(r: RederiveReport): void {
  out(`\nRe-derivation from the raw sources (--rederive): format ${r.format}${r.sources.length ? `, ${r.sources.length} raw source(s)` : ''}`);
  if (r.format === 2) {
    out(`  on load: ${r.onLoad ? `the server re-derives this document (${r.onLoad}); the stored tables are not what it applies` : 'the server uses the stored tables as they are'}`);
  }
  if (r.sources.length) out(sourceTable(r.sources).split('\n').map((l) => `  ${l}`).join('\n'));
  const label: Record<RederiveReport['status'], string> = { equal: 'EQUAL', mismatch: 'MISMATCH', 'no-raw': 'NO-RAW', 'unreadable-raw': 'UNREADABLE RAW', failed: 'DERIVATION FAILED' };
  out(`  result: ${label[r.status]}: ${r.message}`);
  if (r.stamps) {
    const s = r.stamps;
    out(`  stamps (not compared): schema ${String(s.schema.stored)} -> ${String(s.schema.rederived)}, derivation revision ${String(s.derivedRevision.stored)} -> ${String(s.derivedRevision.rederived)}, codec ${String(s.derivedWith.stored)} -> ${String(s.derivedWith.rederived)}`);
  }
  if (r.differences.length) {
    out(table(
      ['FAMILY', 'ROWS', 'REDERIVED', 'ADDED', 'REMOVED', 'CHANGED', 'LABELS +/-/~', 'SECTION', 'PIDS'],
      r.differences.map((d) => [
        d.family, String(d.rows.stored), String(d.rows.rederived), String(d.rows.added.length), String(d.rows.removed.length), String(d.rows.changed.length),
        `${d.labels.added.length}/${d.labels.removed.length}/${d.labels.changed.length}`, d.section ? 'differs' : '',
        list([...d.rows.added, ...d.rows.removed, ...d.rows.changed, ...d.labels.added, ...d.labels.removed, ...d.labels.changed].filter((v, i, a) => a.indexOf(v) === i).sort(byNum), 8),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'l', 'l', 'l'],
    ).split('\n').map((l) => `  ${l}`).join('\n'));
    out('  ROWS / REDERIVED = row count stored / re-derived; ADDED = only in the re-derived tables, REMOVED = only in the stored ones.');
  }
  const other = r.parts.filter((p) => !p.equal);
  if (r.status === 'mismatch') out(`  other derived parts that differ: ${other.length ? other.map((p) => `${p.part}${p.keys?.length ? ` (${list(p.keys, 6)})` : ''}`).join('; ') : 'none'}`);
}

// ── --diff ────────────────────────────────────────────────────────────────────────────────────────

interface DiffReport {
  /** What the builder was given (the document as the applied profile of a unit running its firmware). */
  input: { key: string; firmware: string | null; state: string; placedEids: number[] | null; unmappedEids: number[] };
  diff: DefinitionsDiffDTO | null;
  error?: string;
}

function runDiff(run: OfflineRun, placed: readonly number[]): DiffReport {
  const { loaded, model, profile } = run;
  const built = loaded.built;
  const staticProfile = PROFILES[model]!;
  const docFw = typeof built.firmware === 'string' ? built.firmware : null;
  const key = documentKey(loaded, model) ?? `${hex(model)}_unknown`;
  const firmware = docFw ?? firmwareOfCacheKey(key);
  const placedEids = placed.length ? [...new Set(placed)].sort(byNum) : null;
  const unmappedEids = (placedEids ?? []).filter((eid) => mapsNowhere(profile, model, eid));
  const summary = profileSummaryOf(built, model);
  // the same drift rule the registry's capabilities use, for a unit running the document's firmware
  const state = definitionsDrift({
    running: firmware, catalogFirmware: staticProfile.catalogFirmware, unmapped: unmappedEids.length > 0, storedStale: false,
    applied: { firmware: docFw, blocking: !summary.coverage.complete }
  });
  const input = { key, firmware, state, placedEids, unmappedEids };
  try {
    const r = definitionsDiff({ model, firmware, state, staticProfile, applied: { key, doc: built, profile }, placedEids, unmappedEids });
    if (!r.ok) throw new Error(`${r.error} ${r.family}`);
    return { input, diff: r.diff };
  } catch (e) {
    fail('diff-failed', 'diff', `the definitions diff builder threw: ${errMsg(e)}`);
    return { input, diff: null, error: errMsg(e) };
  }
}

function printDiff(r: DiffReport): void {
  out(`\nDefinitions diff against the bundled catalog (--diff; GET /device/definitions/diff with this document applied, the unit running firmware ${r.input.firmware ?? 'unknown'}):`);
  const d = r.diff;
  if (!d) { out(`  FAILED: ${r.error ?? 'no diff'}`); return; }
  out(`  state ${d.state}; catalog firmware ${d.catalogFirmware ?? 'not settled'}; ${d.profile ? `profile ${d.profile.key}, source ${d.profile.source} (${d.profile.byteExact ? 'byte-exact' : 'live walk'}), format ${d.profile.format}, ${d.profile.sources.length} source(s)` : 'no applied profile'}`);
  if (r.input.placedEids) out(`  placed (--eid): ${r.input.placedEids.join(', ')}; mapping nowhere: ${list(r.input.unmappedEids)}`);
  const s = d.summary;
  out(`  summary: ${s.newParams} new, ${s.changed.compatible} compatible + ${s.changed.incompatible} incompatible changed, ${s.removed ?? 'unknown'} removed, ${s.movedNames} moved name(s), ${s.rosterChanges} roster change(s), ${s.enumChanges} label-list change(s), ${s.strideChanges} stride change(s), ${s.newSections} new section(s), ${s.unknownBlocks} unknown block(s)`);
  out(`  suspects: ${list(s.suspects)}; disagreements: ${list(s.disagreements)}`);
  if (d.families.length) {
    out(table(
      ['FAMILY', 'EID', 'STATUS', 'ADDED', 'CHANGED', 'REMOVED', 'MOVED', 'ENUMS', 'ROSTER', 'STRIDE'],
      d.families.map((f) => [
        f.family, f.eid === null ? '-' : String(f.eid), f.status, String(f.params?.added.length ?? 0), String(f.params?.changed.length ?? 0),
        f.params?.removed === null ? '?' : String(f.params?.removed.length ?? 0), String(f.params?.moved.length ?? 0), String(f.enums?.length ?? 0),
        f.roster ? `${f.roster.before} -> ${f.roster.after}${f.roster.ordinalShift ? ' shift' : ''}` : '', f.stride ? `${f.stride.before} -> ${f.stride.after}` : '',
      ]),
      ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r', 'l', 'l'],
    ).split('\n').map((l) => `  ${l}`).join('\n'));
    out('  REMOVED ? = cannot be told (the family is not byte-exact, or suspect).');
  } else {
    out('  families: no family differs from the catalog');
  }
  if (d.sections?.length) {
    out('  sections no catalog family took:');
    out(table(['TAG', 'KEY', 'ROLE', 'STRIDE', 'INFORMATIVE', 'MAPPED EIDS'],
      d.sections.map((x) => [String(x.tag), x.key, x.role, String(x.stride), String(x.informative), list(x.mappedEids)]), ['r', 'l', 'l', 'r', 'r', 'l'])
      .split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (d.blocks?.length) {
    out('  blocks no catalog family places:');
    out(table(['EID', 'PLACED', 'STATE', 'KEY', 'SECTION', 'PARAMS'],
      d.blocks.map((b) => [String(b.eid), b.placed ? 'yes' : 'no', b.state, b.key ?? '-', b.sectionTag === null ? '-' : String(b.sectionTag), String(b.params)]), ['r', 'l', 'l', 'l', 'r', 'r'])
      .split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (d.instances?.length) out(`  instance-count mismatches: ${d.instances.map((i) => `${i.family} ${i.static} -> ${i.seen}`).join('; ')}`);
}

// ── --merge ───────────────────────────────────────────────────────────────────────────────────────

interface ProvenanceSummary {
  /** Per source id: the catalog families and the synthetic keys whose existence facts it provides. */
  existence: Array<{ source: string; families: number; synthetic: number }>;
  units: Record<string, number>;
  tapers: Record<string, number>;
  conflicts: { entries: number; pids: number; list: Array<{ key: string; count: number; pids: number[]; winner: string; loser: string }> };
  suspects: Record<string, string[]>;
}

interface MergeReport {
  /** The document merged into (`--profile`) and its key / model / firmware the merge ran for. */
  file: string; key: string; model: string; firmware: string | null;
  stored: { format: ProfileFormat; sources: SourceSummary[] };
  incoming: { file: string; key: string | null; format: ProfileFormat; sources: SourceSummary[] };
  /** merged: a derived document; refused: the input cannot be merged (exit 2); derivation-failed: the sources do not derive. */
  status: 'merged' | 'refused' | 'derivation-failed';
  error?: string; message?: string;
  kept?: number; dropped?: number; replacedLegacy?: boolean;
  result?: { sources: SourceSummary[]; provenance: ProvenanceSummary | null; coverage: ProfileCoverage | null; check: OfflineReport };
}

function provenanceSummary(doc: unknown): ProvenanceSummary | null {
  const p = isObj(doc) ? doc.provenance : undefined;
  if (!isObj(p)) return null;
  const counts = new Map<string, { families: number; synthetic: number }>();
  for (const [key, src] of Object.entries(isObj(p.existence) ? p.existence : {})) {
    if (typeof src !== 'string') continue;
    const c = counts.get(src) ?? { families: 0, synthetic: 0 };
    if (isSyntheticFamilyKey(key)) c.synthetic++; else c.families++;
    counts.set(src, c);
  }
  const conflicts = (Array.isArray(p.conflicts) ? p.conflicts : []).filter(isObj).map((c) => ({
    key: String(c.key), count: Number(c.count) || 0, pids: Array.isArray(c.pids) ? (c.pids as unknown[]).filter((x): x is number => typeof x === 'number') : [],
    winner: String(c.winner), loser: String(c.loser)
  }));
  const numbers = (o: unknown): Record<string, number> => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  const suspects = Object.fromEntries(Object.entries(isObj(p.suspects) ? p.suspects : {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]));
  return {
    existence: [...counts].map(([source, c]) => ({ source, ...c })).sort((a, b) => a.source.localeCompare(b.source)),
    units: numbers(p.units), tapers: numbers(p.tapers),
    conflicts: { entries: conflicts.length, pids: conflicts.reduce((n, c) => n + c.count, 0), list: conflicts },
    suspects
  };
}

function runMerge(run: OfflineRun, file2: string): MergeReport {
  const { loaded, model } = run;
  const loaded2 = loadProfileFile(file2, undefined, model);
  let model2 = model;
  try { model2 = modelOf(loaded2, undefined); } catch { /* the second document states no model: it is taken for the first one's */ }
  const key = documentKey(loaded, model) ?? `${hex(model)}_unknown`;
  const docFw = typeof loaded.built.firmware === 'string' ? loaded.built.firmware : null;
  const firmware = docFw ?? firmwareOfCacheKey(key);
  const rep: MergeReport = {
    file: run.report.file, key, model: `0x${hex(model)} ${PROFILES[model]!.name}`, firmware,
    stored: { format: profileFormatOf(loaded.built), sources: sourceSummariesOf(loaded.built) },
    incoming: { file: file2, key: loaded2.key, format: profileFormatOf(loaded2.built), sources: sourceSummariesOf(loaded2.built) },
    status: 'refused'
  };
  const refuse = (error: string, message: string): MergeReport => {
    inputErrors.push({ code: error, where: 'merge', message });
    return { ...rep, status: 'refused', error, message };
  };
  if (model2 !== model) return refuse('model-mismatch', `the --merge document is for model 0x${hex(model2)} (${PROFILES[model2]!.name}), the --profile document for 0x${hex(model)} (${PROFILES[model]!.name})`);
  const raw2 = readableRaw(loaded2.built);
  if (!raw2) {
    if (profileFormatOf(loaded2.built) === 1) return refuse('no-raw', 'the --merge document is a format-1 profile: it holds derived tables only, no raw sources to merge');
    return refuse('unreadable-raw', hasNewerRaw(loaded2.built) ? 'the --merge document\'s raw sources were written by a newer build: this build cannot read them' : 'the --merge document\'s raw envelope is malformed');
  }
  if (raw2.sources.length === 0) return refuse('no-sources', 'the --merge document lists no raw source');
  // the --profile document stands in for the stored document of its key (the store is read, never written)
  const storedDoc: Doc = { id: key, collection: 'deviceCaches', data: loaded.built, updatedAt: 0, rev: 1 };
  const store = { getDoc: (collection: string, id: string): Doc | null => (collection === 'deviceCaches' && id === key ? storedDoc : null) };
  const now = new Date().toISOString();
  let merged: ReturnType<typeof mergeSourcesIntoStored>;
  try {
    merged = mergeSourcesIntoStored(store, { key, model, firmware, incoming: raw2.sources, now });
  } catch (e) {
    if (e instanceof ProfileMergeRefused) return refuse(e.refusal.error, e.refusal.message);
    if (e instanceof ProfileUserDataError) return refuse('contains-user-data', e.message);
    if (e instanceof ProfileDerivationError) return refuse(e.code === 'firmware-mismatch' ? 'firmware-differs' : e.code, e.message);
    fail('merge-derivation-failed', 'merge', `the merged sources do not derive: ${errMsg(e)}`);
    return { ...rep, status: 'derivation-failed', message: errMsg(e) };
  }
  const base = { ...rep, kept: merged.kept, dropped: merged.dropped, replacedLegacy: merged.replacedLegacy };
  if (merged.derivationFailed !== undefined) {
    fail('merge-derivation-failed', 'merge', `the stored document is stale and the merged sources still do not derive: ${merged.derivationFailed}`);
    return { ...base, status: 'derivation-failed', message: merged.derivationFailed };
  }
  const doc = merged.doc;
  const check = offlineReportOf(doc as unknown as BuiltCache, { file: `${run.report.file} + ${file2}`, key, shape: 'merged' }, model, checkProfileSchema(doc), [], 'merged ').report;
  return {
    ...base, status: 'merged',
    result: {
      sources: Array.isArray(doc.meta?.sources) ? doc.meta.sources : sourceSummariesOf(doc as unknown as BuiltCache),
      provenance: provenanceSummary(doc),
      coverage: isObj(doc.coverage) ? doc.coverage : null,
      check
    }
  };
}

function printMerge(r: MergeReport): void {
  out(`\nMerge (--merge ${r.incoming.file}) into the document of key ${r.key}: device ${r.model}, firmware ${r.firmware ?? 'unknown'}`);
  out(`  stored: format ${r.stored.format}, ${r.stored.sources.length} source(s); incoming: format ${r.incoming.format}, ${r.incoming.sources.length} source(s) (origins as the file states them)`);
  if (r.status === 'refused') { out(`  result: REFUSED [${r.error}]: ${r.message} (exit code 2)`); return; }
  if (r.status === 'derivation-failed') { out(`  result: DERIVATION FAILED: ${r.message}`); return; }
  out(`  result: merged; kept ${r.kept} stored source(s), dropped ${r.dropped}${r.replacedLegacy ? '; the stored document had no raw sources (format 1): the merged one holds the incoming sources only' : ''}`);
  const res = r.result!;
  out(sourceTable(res.sources).split('\n').map((l) => `  ${l}`).join('\n'));
  const p = res.provenance;
  if (p) {
    out(`  provenance: existence facts per source: ${p.existence.map((e) => `${e.source} ${e.families} famil${e.families === 1 ? 'y' : 'ies'}${e.synthetic ? ` + ${e.synthetic} synthetic` : ''}`).join('; ') || 'none'}`);
    out(`  conflicts: ${p.conflicts.entries} entr${p.conflicts.entries === 1 ? 'y' : 'ies'}, ${p.conflicts.pids} pid(s)`);
    if (p.conflicts.entries) {
      out(table(['KEY', 'WINNER', 'LOSER', 'COUNT', 'PIDS'], p.conflicts.list.slice(0, 20).map((c) => [c.key, c.winner, c.loser, String(c.count), list(c.pids, 8)]), ['l', 'l', 'l', 'r', 'l'])
        .split('\n').map((l) => `    ${l}`).join('\n'));
      if (p.conflicts.entries > 20) out(`    ... and ${p.conflicts.entries - 20} more (use --json for all)`);
    }
    const sus = Object.entries(p.suspects).filter(([, v]) => v.length);
    out(`  suspects per source: ${sus.length ? sus.map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : 'none'}`);
  }
  const c = res.coverage;
  if (c) {
    out(`  coverage: ${c.complete ? 'complete' : 'INCOMPLETE (a blocking gap)'}; gaps: ${c.gaps.length ? c.gaps.map((g) => `${g.kind}${g.blocking ? ' (blocking)' : ''}`).join(', ') : 'none'}`);
    out(`  coverage counts: ${c.units} row(s) with a unit, ${c.tapers} with a taper; high ids ${c.highIds.present}/${c.highIds.expected}; sections ${c.sections.total} (assigned ${c.sections.assigned}, system ${c.sections.system}, new ${c.sections.new}, unclassified ${c.sections.unclassified})${c.instances.length ? `; instance mismatches ${c.instances.map((i) => `${i.family} ${i.static}->${i.seen}`).join(', ')}` : ''}`);
  }
  out('  invariants of the merged document (findings are marked \'merged\'):');
  printFamilyTable(res.check, '  ');
}

// ── --blocks ──────────────────────────────────────────────────────────────────────────────────────

interface BlockEntryReport {
  eid: number; key: string | null; confidence: string; state: BlockMapState;
  serves: boolean; writable: boolean; readOnlyReason?: string;
  sectionTag: number | null; evidence: string[]; candidates?: number[]; compared?: unknown; channels: boolean | null;
  /** Rows (and informative rows) the document holds under `key`. */
  rows: number; informative: number;
  /** The family the runtime profile resolves the effect id to (null: none). */
  resolvesTo: string | null;
}
interface UnknownSectionReport { key: string; space: string | null; tags: number[]; role: string | null; stride: number | null; rows: number; informative: number; boundBy: number[] }
interface BlocksReport {
  format: ProfileFormat;
  entries: BlockEntryReport[];
  unknownSections: UnknownSectionReport[];
  /** Effect ids the document knows (or --eid places) that map nowhere, with where each is known from. */
  unmapped: Array<{ eid: number; known: string[] }>;
  /** The static effect-id table's roster-only ids (Axe-Fx III; null for a model without them). */
  roster: Array<{ eid: number; family: string | null; sectionTag: number | null; state: BlockMapState }> | null;
}

function runBlocks(run: OfflineRun, placed: readonly number[]): BlocksReport {
  const { loaded, model, profile } = run;
  const built = loaded.built as unknown as Record<string, unknown> & BuiltCache;
  const staticProfile = PROFILES[model]!;
  const ranges = (isObj(built.ranges) ? built.ranges : {}) as Record<string, Record<string, RangeDef>>;
  const rowCounts = (key: string | null) => {
    const rows = key !== null && isObj(ranges[key]) ? ranges[key]! : null;
    return { rows: rows ? Object.keys(rows).length : 0, informative: rows ? Object.values(rows).filter((r) => isObj(r) && isInformativeRow(r as RangeDef)).length : 0 };
  };
  const sections = (Array.isArray(built.sections) ? built.sections : []).filter(isObj);
  const hasSections = Array.isArray(built.sections);

  // the persisted block map
  const entries: BlockEntryReport[] = [];
  const seen = new Set<number>();
  const map = Array.isArray(built.blockMap) ? (built.blockMap as unknown[]) : [];
  map.forEach((e, i) => {
    if (!isObj(e) || !Number.isInteger(e.eid)) { fail('block-map-malformed', 'blocks', `block-map entry ${i} has no integer effect id`); return; }
    const eid = e.eid as number;
    const where = `blocks eid ${eid}`;
    if (seen.has(eid)) { fail('block-map-duplicate', where, 'more than one block-map entry for this effect id (the server uses the first)'); return; }
    seen.add(eid);
    const key = typeof e.key === 'string' ? e.key : null;
    const confidence = typeof e.confidence === 'string' ? e.confidence : String(e.confidence);
    const evidence = Array.isArray(e.evidence) ? (e.evidence as unknown[]).map(String) : [];
    const access = blockMapAccess({ confidence, evidence });
    const counts = rowCounts(key);
    const sectionTag = Number.isInteger(e.sectionTag) ? (e.sectionTag as number) : null;
    const rep: BlockEntryReport = {
      eid, key, confidence, state: access.state, serves: access.serves, writable: access.writable,
      ...(access.readOnlyReason ? { readOnlyReason: access.readOnlyReason } : {}),
      sectionTag, evidence,
      ...(Array.isArray(e.candidates) ? { candidates: (e.candidates as unknown[]).filter((t): t is number => Number.isInteger(t)) } : {}),
      ...(e.compared !== undefined ? { compared: e.compared } : {}),
      channels: typeof e.channels === 'boolean' ? e.channels : null,
      ...counts,
      resolvesTo: familyOfEid(profile, eid) ?? null,
    };
    entries.push(rep);
    if (confidence === 'confirmed') {
      if (key === null) fail('block-map-no-rows', where, 'a confirmed entry without a key');
      else if (counts.informative === 0) fail('block-map-no-rows', where, `a confirmed entry whose key ${key} has ${counts.rows === 0 ? 'no rows' : 'only placeholder rows'} in the document`);
      if (evidence.includes('device-records') && sectionTag !== null && hasSections && !sections.some((s) => s.space === 'section' && s.tag === sectionTag)) {
        fail('block-map-no-section', where, `a confirmed entry names editor-cache section ${sectionTag}, which the document does not describe`);
      }
      const fixed = staticProfile.familyForEffectId(eid) ?? SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
      if (fixed !== undefined && fixed !== key) warn('block-map-shadowed', where, `the static tables place this effect id (${fixed}): the entry is never used`);
    }
  });

  // sections no catalog family took: the synthetic keys of the tables and the sections
  const synthetic = new Set<string>([...Object.keys(ranges), ...sections.map((s) => String(s.key))].filter((k) => isSyntheticFamilyKey(k)));
  const rangeSections = (isObj(built.rangeSections) ? built.rangeSections : {}) as Record<string, { sectionTag?: number; stride?: number; instanceTags?: number[] }>;
  const unknownSections: UnknownSectionReport[] = [...synthetic].sort((a, b) => {
    const [sa, ta] = a.split(':');
    const [sb, tb] = b.split(':');
    return sa!.localeCompare(sb!) || Number(ta) - Number(tb);
  }).map((key) => {
    const own = sections.filter((s) => s.key === key);
    const meta = rangeSections[key];
    const tags = own.length ? own.map((s) => Number(s.tag)) : meta ? (meta.instanceTags ?? (meta.sectionTag !== undefined ? [meta.sectionTag] : [])) : [];
    return {
      key, space: own[0] ? String(own[0].space) : key.split(':')[0] ?? null, tags: [...new Set(tags)].sort(byNum),
      role: own[0] && typeof own[0].role === 'string' ? own[0].role : null,
      stride: typeof meta?.stride === 'number' ? meta.stride : own[0] && typeof own[0].stride === 'number' ? own[0].stride : null,
      ...rowCounts(key),
      boundBy: entries.filter((e) => e.confidence === 'confirmed' && e.key === key).map((e) => e.eid),
    };
  });

  // effect ids the document knows (block map, live block sections, live-source records) and the placed ones
  const known = new Map<number, Set<string>>();
  const note = (eid: unknown, why: string) => {
    if (!Number.isInteger(eid) || (eid as number) < 0 || (eid as number) > 255) return;
    (known.get(eid as number) ?? known.set(eid as number, new Set()).get(eid as number)!).add(why);
  };
  for (const e of entries) note(e.eid, 'block-map');
  for (const s of sections) if (s.space === 'block') note(s.tag, 'block-section');
  const raw = readableRaw(built);
  for (const s of raw?.sources ?? []) {
    if ((s as { space?: unknown }).space !== 'block') continue;
    for (const r of s.records) note((r as { section?: unknown }).section, 'live-source');
  }
  for (const eid of placed) note(eid, 'placed');
  const unmapped = [...known].filter(([eid]) => mapsNowhere(profile, model, eid)).map(([eid, why]) => ({ eid, known: [...why].sort() })).sort((a, b) => a.eid - b.eid);

  // the static effect-id table's roster-only ids (the Axe-Fx III's)
  let roster: BlocksReport['roster'] = null;
  if (staticProfile.blockMapFor) {
    roster = [];
    for (let eid = 0; eid <= 255; eid++) {
      const e = staticProfile.blockMapFor(eid);
      if (e) roster.push({ eid, family: e.key, sectionTag: e.sectionTag, state: blockMapState(e.confidence) });
    }
  }
  return { format: profileFormatOf(built), entries, unknownSections, unmapped, roster };
}

function printBlocks(r: BlocksReport): void {
  out(`\nBlock map (--blocks): ${r.entries.length} persisted entr${r.entries.length === 1 ? 'y' : 'ies'}${r.format === 1 ? ' (a format-1 document has none)' : ''}`);
  if (r.entries.length) {
    out(table(
      ['EID', 'KEY', 'CONFIDENCE', 'STATE', 'ACCESS', 'SECTION', 'EVIDENCE', 'ROWS', 'CANDIDATES', 'RESOLVES TO'],
      r.entries.map((e) => [
        String(e.eid), e.key ?? '-', e.confidence, e.state,
        !e.serves ? 'not served' : e.writable ? 'writable' : `read-only (${e.readOnlyReason ?? '?'})`,
        e.sectionTag === null ? '-' : String(e.sectionTag), e.evidence.join(',') || '-', `${e.informative}/${e.rows}`,
        e.candidates ? list(e.candidates, 6) : '-', e.resolvesTo ?? '-',
      ]),
      ['r', 'l', 'l', 'l', 'l', 'r', 'l', 'r', 'l', 'l'],
    ).split('\n').map((l) => `  ${l}`).join('\n'));
    out('  ROWS = informative / all rows the document holds under the key; RESOLVES TO = the family the runtime profile gives the effect id.');
  }
  out(`\nSections no catalog family took (section:<tag> / block:<eid>): ${r.unknownSections.length || 'none'}`);
  if (r.unknownSections.length) {
    out(table(['KEY', 'SPACE', 'TAGS', 'ROLE', 'STRIDE', 'ROWS', 'INFORMATIVE', 'BOUND BY'],
      r.unknownSections.map((s) => [s.key, s.space ?? '-', list(s.tags, 6), s.role ?? '-', s.stride === null ? '-' : String(s.stride), String(s.rows), String(s.informative), list(s.boundBy, 6)]),
      ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'l']).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  out(`\nEffect ids the document knows (or --eid places) that map nowhere: ${r.unmapped.length ? r.unmapped.map((u) => `${u.eid} (${u.known.join(', ')})`).join('; ') : 'none'}`);
  if (r.roster) out(`Roster-only effect ids of the static effect-id table (served read-only, never written): ${r.roster.length ? r.roster.map((x) => `${x.eid} ${x.family ?? '?'}`).join('; ') : 'none'}`);
}

// ── online (read-only) ────────────────────────────────────────────────────────────────────────────

/** The only requests this script ever sends. Every one is a GET without a body. */
const READ_ONLY_PATHS: RegExp[] = [
  /^\/device$/,
  /^\/preset\/blocks$/,
  /^\/preset\/blocks\/\d+\/params\?generic=1$/,
  /^\/store\/deviceCaches\/[\w.-]+$/,
];

async function httpGet(base: string, path: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  if (!READ_ONLY_PATHS.some((re) => re.test(path))) throw new Error(`refusing to request ${path}: not on the read-only list`);
  const res = await fetch(base + path, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep the text */ }
  return { status: res.status, body };
}

interface ServedParam {
  id: number; name?: string; kind?: string; generic?: boolean; isNew?: boolean; fp?: string; unresolved?: string;
}
interface ServedBlock {
  block?: string; slug?: string; named?: ServedParam[]; enums?: ServedParam[]; unknownBlock?: boolean; readError?: string;
  definitions?: { family: string | null; profile?: string; suspect?: boolean; hidden?: { id: number; reason: string }[] };
}

interface BlockCheck {
  eid: number; block: string; family: string | null; status: 'ok' | 'fail' | 'unknown-block';
  listed: number; named: number; enums: number; hidden: number; removed: number; rows: number | null;
  generic: number; isNew: number; unresolved: Record<string, number>; problems: string[];
}

interface OnlineReport {
  url: string; device: { model: string | null; firmware: string | null }; definitions: unknown;
  comparison: { source: 'file' | 'store' | 'catalog'; key: string | null; note?: string };
  blocks: BlockCheck[]; layout: LayoutReport | null; probes: ProbeReport[];
}

function checkServedBlock(eid: number, served: ServedBlock, cmp: DeviceProfile): BlockCheck {
  const where = `eid ${eid}`;
  const named = served.named ?? [];
  const enums = served.enums ?? [];
  const defs = served.definitions;
  const bc: BlockCheck = {
    eid, block: served.block ?? '?', family: defs?.family ?? null, status: 'ok',
    listed: named.length + enums.length, named: named.length, enums: enums.length,
    hidden: 0, removed: 0, rows: null, generic: 0, isNew: 0, unresolved: {}, problems: [],
  };
  const problem = (code: string, msg: string) => { bc.problems.push(`${code}: ${msg}`); fail(code, where, msg); };
  if (!defs) { problem('not-v2', 'the response has no `definitions` block (the generic response was not served)'); bc.status = 'fail'; return bc; }
  if (served.unknownBlock) { bc.status = 'unknown-block'; return bc; }

  for (const p of [...named, ...enums]) {
    if (p.generic) bc.generic++;
    if (p.isNew) bc.isNew++;
    if (p.unresolved) bc.unresolved[p.unresolved] = (bc.unresolved[p.unresolved] ?? 0) + 1;
  }
  const hiddenList = defs.hidden ?? [];
  bc.removed = hiddenList.filter((h) => h.reason === 'removed').length;
  bc.hidden = hiddenList.length - bc.removed;

  const enumInNamed = named.filter((p) => p.kind === 'enum').map((p) => p.id);
  if (enumInNamed.length) problem('enum-in-named', `enum-kind entries in 'named': pid ${enumInNamed.join(', ')}`);
  if (bc.unresolved['channel-unknown']) problem('channel-unknown', `${bc.unresolved['channel-unknown']} value(s) with unresolved 'channel-unknown'`);
  if (bc.unresolved['read-failed'] || served.readError) problem('read-failed', `the block read failed${served.readError ? `: ${served.readError}` : ''}`);
  if (defs.suspect) problem('suspect-family', `the server flags ${defs.family} as suspect (its profile section looks mis-assigned)`);

  // what the profile predicts for this family (the server resolves the family the same way)
  const family = familyOfEid(cmp, eid) ?? null;
  if (family !== defs.family) { problem('response-mismatch', `the server resolved family ${defs.family}, the profile side resolves ${family}`); bc.status = 'fail'; return bc; }
  if (!family) return bc;
  const idx: BlockIndex = buildParamIndex(cmp, family);
  bc.rows = informativeRowCount(cmp, family, idx.profile);
  if (bc.listed + bc.hidden !== bc.rows) problem('count-mismatch', `listed ${bc.listed} + hidden ${bc.hidden} = ${bc.listed + bc.hidden}, the profile has ${bc.rows} informative rows`);

  const servedById = new Map([...named, ...enums].map((p) => [p.id, p]));
  const missing = idx.entries.filter((e) => !servedById.has(e.pid)).map((e) => e.pid);
  const extra = [...servedById.keys()].filter((id) => !idx.byPid.has(id));
  if (missing.length) problem('response-mismatch', `the profile predicts pid ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' ...' : ''} but the response does not list it`);
  if (extra.length) problem('response-mismatch', `the response lists pid ${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ' ...' : ''} which the profile does not predict`);
  const hiddenKey = (h: { id: number; reason: string }) => `${h.id}:${h.reason}`;
  const wantHidden = idx.hidden.map(hiddenKey).sort().join(' ');
  const gotHidden = hiddenList.map(hiddenKey).sort().join(' ');
  if (wantHidden !== gotHidden) problem('response-mismatch', `hidden items differ: the profile predicts [${wantHidden}], the response has [${gotHidden}]`);
  const unserved = unservedProfileRows(cmp, family, new Set([...servedById.keys(), ...hiddenList.map((h) => h.id)]));
  if (unserved.length) problem('profile-row-not-served', `informative profile rows neither listed nor hidden in the response: pid ${unserved.slice(0, 12).join(', ')}${unserved.length > 12 ? ' ...' : ''}`);
  const fpDiff = idx.entries.filter((e) => servedById.get(e.pid)?.fp !== undefined && servedById.get(e.pid)!.fp !== e.fp).map((e) => e.pid);
  if (fpDiff.length) problem('response-mismatch', `fingerprint differs for pid ${fpDiff.slice(0, 12).join(', ')}${fpDiff.length > 12 ? ' ...' : ''} (the server holds another profile than the one compared)`);
  const genDiff = idx.entries.filter((e) => servedById.get(e.pid) !== undefined && !!servedById.get(e.pid)!.generic !== e.generic).map((e) => e.pid);
  if (genDiff.length) warn('generic-differs', where, `generic flag differs for pid ${genDiff.slice(0, 12).join(', ')} (a dev override such as FORGEFX_DEFS_FORCE_GENERIC does this)`);
  if (bc.problems.length) bc.status = 'fail';
  return bc;
}

async function runOnline(args: Args, fileProfile: DeviceProfile | null): Promise<{ report: OnlineReport; profile: DeviceProfile | null }> {
  let base: string;
  try {
    const u = new URL(args.url!);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    base = u.origin;
  } catch {
    throw new UsageError(`--url: '${args.url}' is not an http(s) URL`);
  }
  const get = async (path: string) => {
    try { return await httpGet(base, path, args.timeoutMs); }
    catch (e) { throw new UsageError(`GET ${path} failed: ${(e as Error).message}`); }
  };

  const dev = await get('/device');
  if (dev.status !== 200 || !isObj(dev.body)) throw new UsageError(`GET /device answered ${dev.status}`);
  const d = dev.body as { model?: string; modelId?: number; firmware?: { version?: string } | null; capabilities?: { definitions?: Record<string, unknown> } };
  const defs = d.capabilities?.definitions ?? null;
  const modelId = typeof d.modelId === 'number' ? d.modelId : -1;
  const staticProfile = PROFILES[modelId];
  if (!defs) throw new UsageError('the server reports no capabilities.definitions: it predates the generic block-params path');
  if (defs.genericParams !== true || !staticProfile) {
    throw new UsageError(`the attached device (${d.model ?? 'unknown'}) does not serve the generic response (capabilities.definitions.genericParams is ${String(defs.genericParams)})`);
  }
  const caps = defs as { profile?: { key?: string; suspectFamilies?: string[]; byteExact?: boolean } | null };
  if (caps.profile?.suspectFamilies?.length) fail('suspect-family', 'capabilities', `the applied profile has suspect families: ${caps.profile.suspectFamilies.join(', ')}`);

  // the profile to compare with: an explicit file, else the stored document the server applied, else the catalog
  const fw = /^(\d+)\.(\d+)/.exec(d.firmware?.version ?? '');
  const key = caps.profile?.key ?? (fw ? `${hex(modelId)}_${fw[1]}p${fw[2]}` : null);
  let cmp: DeviceProfile = staticProfile;
  let comparison: OnlineReport['comparison'] = { source: 'catalog', key };
  if (fileProfile) {
    cmp = fileProfile;
    comparison = { source: 'file', key, note: 'the --profile file stands in for the server\'s profile' };
  } else if (key) {
    const doc = await get(`/store/deviceCaches/${encodeURIComponent(key)}`);
    if (doc.status === 200 && isObj(doc.body) && looksBuilt(doc.body.data)) {
      const check = checkProfileSchema(doc.body.data);
      if (caps.profile && check.usable) {
        cmp = runtimeProfileFrom(doc.body.data, staticProfile);
        comparison = { source: 'store', key };
      } else {
        comparison = { source: 'catalog', key, note: caps.profile ? 'the stored document is stale' : 'a stored document exists but the server applied none' };
        warn('profile-not-applied', 'store', `deviceCaches/${key} exists but ${caps.profile ? 'is stale for this build' : 'is not applied by the server'}; compared against the bundled catalog`);
      }
    } else if (caps.profile) {
      warn('profile-missing', 'store', `the server reports profile ${key} applied, but GET /store/deviceCaches/${key} answered ${doc.status}; compared against the bundled catalog`);
    }
  }
  const reach = reachableFamilies(cmp);

  const placed = await get('/preset/blocks');
  if (placed.status !== 200 || !Array.isArray(placed.body)) throw new UsageError(`GET /preset/blocks answered ${placed.status}`);
  const eids = [...new Set([...(placed.body as { effectId?: number }[]).map((b) => b.effectId).filter((e): e is number => typeof e === 'number'), ...args.eids])].sort((a, b) => a - b);

  const blocks: BlockCheck[] = [];
  for (const eid of eids) {
    let res: { status: number; body: unknown };
    try {
      res = await httpGet(base, `/preset/blocks/${eid}/params?generic=1`, args.timeoutMs);
    } catch (e) {
      // the server was not heard (connection refused, timeout, redirect): no finding about it, exit code 2
      transportErrors.push({ code: 'transport-error', where: `eid ${eid}`, message: (e as Error).message });
      blocks.push({ eid, block: '?', family: null, status: 'fail', listed: 0, named: 0, enums: 0, hidden: 0, removed: 0, rows: null, generic: 0, isNew: 0, unresolved: {}, problems: [`transport-error: ${(e as Error).message}`] });
      continue;
    }
    if (res.status !== 200 || !isObj(res.body)) {
      // the server answered, but not with a block: that is a finding about the server
      fail('request-failed', `eid ${eid}`, `answered ${res.status}`);
      blocks.push({ eid, block: '?', family: null, status: 'fail', listed: 0, named: 0, enums: 0, hidden: 0, removed: 0, rows: null, generic: 0, isNew: 0, unresolved: {}, problems: [`request-failed: answered ${res.status}`] });
      continue;
    }
    blocks.push(checkServedBlock(eid, res.body as ServedBlock, cmp));
  }
  const layout = layoutReport(cmp, reach, 'server profile');
  const report: OnlineReport = {
    url: base, device: { model: d.model ?? null, firmware: d.firmware?.version ?? null }, definitions: defs,
    comparison, blocks, layout, probes: args.probes.map((p) => probe(cmp, p.family, p.pid)),
  };
  return { report, profile: cmp };
}

function printOnline(r: OnlineReport, profile: DeviceProfile | null, args: Args): void {
  out(`Online check of ${r.url}  (GET only)`);
  out(`  device ${r.device.model ?? '?'}, firmware ${r.device.firmware ?? '?'}`);
  out(`  capabilities.definitions: ${JSON.stringify(r.definitions)}`);
  out(`  compared against: ${r.comparison.source}${r.comparison.key ? ` (key ${r.comparison.key})` : ''}${r.comparison.note ? `; ${r.comparison.note}` : ''}\n`);
  const rows = r.blocks.map((b) => [
    String(b.eid), b.block, b.family ?? '-', String(b.listed), String(b.named), String(b.enums), String(b.hidden), String(b.removed),
    b.rows === null ? '-' : String(b.rows), String(b.generic), String(b.isNew),
    Object.entries(b.unresolved).map(([k, n]) => `${k}:${n}`).join(' ') || '-',
    b.status === 'ok' ? 'OK' : b.status === 'unknown-block' ? 'unknown block' : 'FAIL',
  ]);
  out(table(['EID', 'BLOCK', 'FAMILY', 'LISTED', 'NAMED', 'ENUMS', 'HIDDEN', 'REMOVED', 'ROWS', 'GENERIC', 'NEW', 'UNRESOLVED', 'STATUS'], rows,
    ['r', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l']));
  for (const b of r.blocks) for (const p of b.problems) out(`  eid ${b.eid} ${b.block}: ${p}`);
  out('\nLISTED = named + enums; HIDDEN excludes the reason \'removed\'; LISTED + HIDDEN must equal ROWS (the informative rows of the compared profile).');
  if (r.layout) printLayoutReport(r.layout);
  for (const p of r.probes) printProbe(p);
  if (profile) for (const f of args.lists) listFamily(profile, f);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

/** The JSON document `--json` prints (the document tools' sections and `inputErrors` only when a tool was asked for). */
type ProfileCheckJson = Record<string, unknown>;

/** Run the check for `argv` (the options after the script name) and set the exit code; output goes through `out`. */
async function main(argv: string[]): Promise<{ exitCode: number; json: ProfileCheckJson | null }> {
  const args = parseArgs(argv);
  if (args.help) { out(HELP); return { exitCode: 0, json: null }; }

  let offline: OfflineRun | null = null;
  let online: { report: OnlineReport; profile: DeviceProfile | null } | null = null;
  if (args.profile) offline = runOffline(args);
  const rederive = offline && args.rederive ? runRederive(offline.loaded.built, offline.model) : null;
  const diff = offline && args.diff ? runDiff(offline, args.eids) : null;
  const merge = offline && args.merge !== undefined ? runMerge(offline, args.merge) : null;
  const blocks = offline && args.blocks ? runBlocks(offline, args.eids) : null;
  if (args.url) online = await runOnline(args, offline?.profile ?? null);

  if (args.strict) {
    for (const w of warnings) failures.push({ ...w, code: `${w.code} (strict)` });
  }
  const tools = docTools(args);
  let json: ProfileCheckJson | null = null;
  if (args.json) {
    json = {
      ok: failures.length === 0 && transportErrors.length === 0 && inputErrors.length === 0,
      failures, warnings, transportErrors,
      ...(tools ? { inputErrors } : {}),
      offline: offline?.report ?? null,
      online: online?.report ?? null,
      ...(args.rederive ? { rederive } : {}),
      ...(args.diff ? { diff } : {}),
      ...(args.merge !== undefined ? { merge } : {}),
      ...(args.blocks ? { blocks } : {}),
    };
    out(JSON.stringify(json, null, 2));
  } else {
    if (offline) printOffline(offline.report, offline.profile, args);
    if (rederive) printRederive(rederive);
    if (diff) printDiff(diff);
    if (merge) printMerge(merge);
    if (blocks) printBlocks(blocks);
    if (offline && online) out('\n' + '='.repeat(72) + '\n');
    if (online) printOnline(online.report, online.profile, args);
    if (!args.strict && warnings.length) {
      out(`\nWarnings (${warnings.length}, they do not change the exit code; --strict does):`);
      for (const w of warnings.slice(0, 40)) out(`  [${w.code}] ${w.where}: ${w.message}`);
      if (warnings.length > 40) out(`  ... and ${warnings.length - 40} more (use --json for all)`);
    }
    out(failures.length === 0 ? '\nRESULT: all invariants hold' : `\nRESULT: ${failures.length} invariant failure(s)`);
    for (const f of failures.slice(0, 60)) out(`  FAIL [${f.code}] ${f.where}: ${f.message}`);
    if (failures.length > 60) out(`  ... and ${failures.length - 60} more (use --json for all)`);
    if (transportErrors.length) {
      out(`\nTRANSPORT: ${transportErrors.length} request(s) failed before the server answered (exit code 2)`);
      for (const t of transportErrors) out(`  ${t.where}: ${t.message}`);
    }
    if (inputErrors.length) {
      out(`\nINPUT: ${inputErrors.length} document(s) the tools could not use (exit code 2)`);
      for (const t of inputErrors) out(`  [${t.code}] ${t.where}: ${t.message}`);
    }
  }
  return { exitCode: transportErrors.length > 0 || inputErrors.length > 0 ? 2 : failures.length === 0 ? 0 : 1, json };
}

export interface ProfileCheckResult {
  /** 0 / 1 / 2 as the script exits (see --help). */
  exitCode: number;
  /** Everything printed to stdout (the tables, or the JSON text with --json), one entry per line written. */
  stdout: string;
  /** Diagnostics (usage errors). */
  stderr: string;
  /** The JSON document with --json (null otherwise, or after a usage error). */
  json: ProfileCheckJson | null;
}

/**
 * Run profile-check with `argv` (the options after the script name) and hand back what it printed and its exit code,
 * without exiting the process. `io` receives the output as it is written (default: buffered only). One run at a time:
 * the findings are module state, reset at the start of every run.
 */
export async function runProfileCheck(argv: string[], io: { out?: (line: string) => void; err?: (...args: unknown[]) => void } = {}): Promise<ProfileCheckResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prevOut = out;
  const prevErr = errOut;
  failures.length = 0;
  warnings.length = 0;
  transportErrors.length = 0;
  inputErrors.length = 0;
  out = (line) => { stdout.push(line); io.out?.(line); };
  errOut = (...args) => { stderr.push(format(...args)); io.err?.(...args); };
  try {
    const r = await main(argv);
    return { exitCode: r.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), json: r.json };
  } catch (e: unknown) {
    if (e instanceof UsageError) errOut(`profile-check: ${e.message}`);
    else errOut('profile-check: unexpected error:', e);
    return { exitCode: 2, stdout: stdout.join('\n'), stderr: stderr.join('\n'), json: null };
  } finally {
    out = prevOut;
    errOut = prevErr;
  }
}

/** True when this file is the process entry (`tsx scripts/profile-check.ts`, `npm run profile-check`), not imported.
 *  Compares resolved real paths without the extension; case-insensitively on Windows (drive letters, `C:` vs `c:`). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p: string): string => {
    let r = resolve(p);
    try { r = realpathSync(r); } catch { /* not on disk under that name: compare as given */ }
    r = r.replace(/\.[cm]?[jt]s$/i, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  try { return norm(fileURLToPath(import.meta.url)) === norm(entry); } catch { return false; }
}

if (invokedDirectly()) {
  const r = await runProfileCheck(process.argv.slice(2), { out: (line) => console.log(line), err: (...args) => console.error(...args) });
  process.exitCode = r.exitCode;
}
