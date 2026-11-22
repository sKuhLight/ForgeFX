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
 * Exit code: 0 all invariants hold; 1 an invariant failed (a block request the server answered with a status
 * other than 200 counts as one); 2 a usage or input error, a server that cannot be checked (GET /device or
 * /preset/blocks not answered with 200, no generic support), or any request that failed at the transport level
 * (connection refused, timeout, redirect).
 * Run with --help for the options.
 */
import { readFileSync } from 'node:fs';
import { isInformativeRow, isPlaceholderRow, paramFingerprint, rowsCompatible, type BuiltCache } from 'forgefx-midi/cache';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { PROFILES, SLUG_FAMILY, runtimeProfileFrom, type DeviceProfile, type RangeDef } from '../src/devices.js';
import { buildParamIndex, MAX_WIRE_PID, type BlockIndex, type BlockProfileKind } from '../src/drivers/paramIndex.js';
import { checkProfileSchema } from '../src/profileSchema.js';

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
const warn = (code: string, where: string, message: string): void => { warnings.push({ code, where, message }); };

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

Options
  --profile <file>   a store file (deviceCaches.json: a map of cache key -> document), one stored document
                     ({ id, collection, data, ... }), a { key: { data } } bundle, or a bare profile document
  --model <m>        0x10 | 0x11 | 0x12, or iii | fm3 | fm9 (default: the document's own model or its key)
  --key <k>          which entry of a store file to use, e.g. 11_99p0 (default: the only one, or the one for --model)
  --allow-stale      check a profile whose schema stamp the server would refuse to use (it would not be applied)
  --url <base>       a running ForgeFX server; only GET requests are sent (/device, /preset/blocks,
                     /preset/blocks/<eid>/params?generic=1, /store/deviceCaches/<key>)
  --eid <n,n>        extra effect ids to read besides the placed blocks (repeatable), e.g. 1 for the setup block
  --probe FAMILY:pid show the row at that param id and whether the write guard would refuse it (repeatable)
  --list FAMILY      list every param the index serves for that family (repeatable)
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
Exit codes
  0  all invariants hold
  1  an invariant failed (a block request the server answered with a status other than 200 counts as one)
  2  usage or input error; the server cannot be checked (GET /device or /preset/blocks not answered with 200,
     no generic support); or any request failed at the transport level (connection refused, timeout, redirect)`;

interface Args {
  profile?: string; key?: string; model?: number; allowStale: boolean;
  url?: string; eids: number[]; probes: { family: string; pid: number }[]; lists: string[];
  json: boolean; strict: boolean; timeoutMs: number; help: boolean;
}

function parseModel(s: string): number {
  const named: Record<string, number> = { iii: 0x10, axe3: 0x10, fm3: 0x11, fm9: 0x12 };
  const n = named[s.toLowerCase()] ?? Number(s);
  if (!Number.isInteger(n) || !PROFILES[n]) throw new UsageError(`--model: '${s}' is not a gen-3 grid model (0x10, 0x11, 0x12, iii, fm3, fm9)`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { allowStale: false, eids: [], probes: [], lists: [], json: false, strict: false, timeoutMs: 20000, help: false };
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

function analyseFamily(profile: DeviceProfile, family: string, reach: Map<string, number[]>): FamilyReport {
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
  const where = `${family}`;
  const unserved = unservedProfileRows(profile, family, new Set([...idx.entries.map((e) => e.pid), ...idx.hidden.map((h) => h.id)]));
  if (unserved.length) fail('profile-row-not-served', where, `informative profile rows neither listed nor hidden: pid ${unserved.slice(0, 12).join(', ')}${unserved.length > 12 ? ' ...' : ''}`);
  if (rep.shown + rep.hidden !== rep.rows) fail('count-mismatch', where, `listed ${rep.shown} + hidden ${rep.hidden} = ${rep.shown + rep.hidden}, the profile has ${rep.rows} informative rows`);
  if (rep.enumInNamed.length) fail('enum-in-named', where, `enum-kind entries in 'named': pid ${rep.enumInNamed.join(', ')}`);
  if (rep.suspect) fail('suspect-family', where, 'the section-assignment cross-check flagged this family: its profile rows were not used');
  return rep;
}

function familiesOf(profile: DeviceProfile): string[] {
  return [...new Set([...Object.keys(profile.ranges), ...Object.keys(profile.params)])].sort();
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

/** The profile's rows against the catalog's, row by row, before any naming rule is applied: how many
 *  informative profile rows carry the catalog row's fingerprint (exact), a compatible revision of it, an
 *  incompatible one, or have no informative catalog row at all (new). It also covers the rows the index
 *  hides (type, bypass) and the families no block reaches, so it is a wider count than the index histogram. */
interface RowComparison { exact: number; compatible: number; incompatible: number; newRows: number; removed: number | null; skippedFamilies: string[]; newByFamily: Record<string, number[]> }
function compareRows(built: BuiltCache, staticProfile: DeviceProfile, suspects: readonly string[], byteExact: boolean): RowComparison {
  const base = staticProfile.staticBase ?? staticProfile;
  const out: RowComparison = { exact: 0, compatible: 0, incompatible: 0, newRows: 0, removed: byteExact ? 0 : null, skippedFamilies: [...suspects], newByFamily: {} };
  for (const [fam, rows] of Object.entries(built.ranges ?? {})) {
    if (suspects.includes(fam)) continue;
    const cat = base.ranges[fam] ?? {};
    const own = built.enumOverrides?.[fam] ?? {};
    for (const [k, e] of Object.entries(rows)) {
      const pid = Number(k);
      if (pid > MAX_WIRE_PID || !isInformativeRow(e)) continue;
      const c = cat[pid];
      if (!c || !isInformativeRow(c)) { out.newRows++; (out.newByFamily[fam] ??= []).push(pid); continue; }
      if (c.synthetic) { if (c.kind === e.kind) out.compatible++; else out.incompatible++; continue; }
      const ownLabels = own[String(pid)];
      const catLabels = base.enumLabelsFor(fam, pid);
      if (paramFingerprint(c, catLabels) === paramFingerprint(e, ownLabels)) out.exact++;
      else if (rowsCompatible(c, catLabels, e, ownLabels)) out.compatible++;
      else out.incompatible++;
    }
    if (byteExact) {
      for (const [k, c] of Object.entries(cat)) {
        const pid = Number(k);
        if (pid > MAX_WIRE_PID || !isInformativeRow(c) || c.synthetic) continue;
        const e = rows[pid];
        if (!e || !isInformativeRow(e)) out.removed = (out.removed ?? 0) + 1;
      }
    }
  }
  return out;
}

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
  console.log('\nLayout controls that write another block\'s param (cross-block):');
  if (groups.size === 0) console.log('  none');
  const rows: string[][] = [];
  for (const [k, list] of groups) {
    const hits = list.filter((r) => r.status === 409);
    const pseudo = list.filter((r) => r.status === 400);
    const noRow = list.filter((r) => r.status === 200 && r.reason.startsWith('no row'));
    rows.push([k, String(list.length), String(list.reduce((n, r) => n + r.controls, 0)), list[0]!.eids.length ? list[0]!.eids.slice(0, 3).join(',') : 'none', String(hits.length), String(pseudo.length), String(noRow.length)]);
  }
  if (rows.length) console.log(table(['LAYOUT -> TARGET', 'PIDS', 'CONTROLS', 'TARGET EID', 'GUARD 409', 'PSEUDO 400', 'NO ROW'], rows, ['l', 'r', 'r', 'l', 'r', 'r', 'r']));
  const hits = rep.cross.filter((r) => r.status === 409);
  for (const r of hits) console.log(`  HIT  ${r.from} -> ${r.to} pid ${r.pid} ${r.paramName ?? ''}  [${r.effects.join(',') || '-'}]${r.eids.length ? '' : '  (no effect id)'}`);
  console.log('  GUARD 409 = would be refused (an unused slot, no catalog param); PSEUDO 400 = id above 0x3FFF; NO ROW = the profile has no row at the id, so the guard lets it pass.');
  if (rep.ownRefused.length) {
    console.log('\nOwn-family layout controls the write guard would refuse:');
    for (const r of rep.ownRefused) console.log(`  HIT  ${r.from} pid ${r.pid} ${r.paramName ?? ''}  (${r.controls} control${r.controls === 1 ? '' : 's'})`);
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
  const known = familiesOf(profile).includes(family);
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
  console.log(`\nprobe ${p.family}:${p.pid}${p.catalogName ? `  (catalog name ${p.catalogName})` : '  (no catalog name)'}`);
  console.log(`  catalog row    ${p.catalogRow}`);
  console.log(`  effective row  ${p.effectiveRow}`);
  if (p.profileRow !== null) console.log(`  profile row    ${p.profileRow}`);
  console.log(`  served         ${p.served}`);
  console.log(`  write guard    ${p.guard.status === 200 ? 'allows' : `refuses with ${p.guard.status}`}: ${p.guard.reason}`);
}

function listFamily(profile: DeviceProfile, family: string): void {
  const idx = buildParamIndex(profile, family);
  console.log(`\n${family}: ${idx.entries.length} listed, ${idx.hidden.length} hidden (profile ${idx.profile}${idx.suspect ? ', suspect' : ''})`);
  console.log(table(
    ['PID', 'NAME', 'LIST', 'KIND', 'WIDGET', 'SRC', 'NAME-SRC', 'CONF', 'FLAGS'],
    idx.entries.map((e) => [String(e.pid), e.name, e.list, e.kind, e.widget, e.source, e.nameSource, e.nameConfidence ?? '-', [e.generic ? 'generic' : '', e.isNew ? 'new' : '', e.write === null ? 'read-only' : ''].filter(Boolean).join(',')]),
    ['r', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l'],
  ));
  if (idx.hidden.length) console.log(`hidden: ${idx.hidden.map((h) => `${h.id}(${h.reason})`).join(' ')}`);
}

// ── offline ───────────────────────────────────────────────────────────────────────────────────────

interface OfflineReport {
  file: string; key: string | null; shape: string; model: string; source: string; byteExact: boolean;
  firmware: string | null; catalogFirmware: string | null; schema: { stored: number | null; current: number; usable: boolean; reason?: string };
  recordCount: number | null; suspectFamilies: string[];
  families: FamilyReport[]; totals: Totals; unreachable: Totals; rowComparison: RowComparison;
  layout: LayoutReport; probes: ProbeReport[];
}

function runOffline(args: Args): { report: OfflineReport; profile: DeviceProfile } {
  const loaded = loadProfileFile(args.profile!, args.key, args.model);
  const model = modelOf(loaded, args.model);
  const staticProfile = PROFILES[model]!;
  const check = checkProfileSchema(loaded.built);
  if (!check.usable && !args.allowStale) {
    throw new UsageError(`the profile's schema is stale (${check.reason}: stored ${check.schema ?? 'none'}, this build writes ${check.current}), so the server would not apply it. Re-run with --allow-stale to look at it anyway`);
  }
  const profile = runtimeProfileFrom(loaded.built, staticProfile);
  const facts = profile.profileFacts!;
  const reach = reachableFamilies(profile);

  const families = familiesOf(profile)
    .map((f) => analyseFamily(profile, f, reach))
    .filter((r) => r.rows > 0 || r.shown > 0 || r.hidden > 0);
  const reachable = families.filter((r) => r.reachable);
  const unreachable = families.filter((r) => !r.reachable);
  for (const f of facts.suspectFamilies) {
    if (!families.some((r) => r.family === f && r.suspect)) fail('suspect-family', f, 'the section-assignment cross-check flagged this family');
  }
  const layout = layoutReport(profile, reach, `model 0x${hex(model)}`);
  const report: OfflineReport = {
    file: args.profile!, key: loaded.key, shape: loaded.shape, model: `0x${hex(model)} ${staticProfile.name}`,
    source: facts.source, byteExact: facts.byteExact, firmware: facts.firmware, catalogFirmware: staticProfile.catalogFirmware,
    schema: { stored: check.schema, current: check.current, usable: check.usable, ...(check.usable ? {} : { reason: check.reason }) },
    recordCount: typeof loaded.built.meta?.recordCount === 'number' ? loaded.built.meta.recordCount : null,
    suspectFamilies: [...facts.suspectFamilies],
    families, totals: sumUp(reachable), unreachable: sumUp(unreachable),
    rowComparison: compareRows(loaded.built, staticProfile, facts.suspectFamilies, facts.byteExact),
    layout, probes: args.probes.map((p) => probe(profile, p.family, p.pid)),
  };
  return { report, profile };
}

function printOffline(r: OfflineReport, profile: DeviceProfile, args: Args): void {
  console.log(`Offline check of ${r.file}${r.key ? `  [key ${r.key}]` : ''}`);
  console.log(`  device ${r.model}; profile source ${r.source} (${r.byteExact ? 'byte-exact' : 'live walk'}); firmware ${r.firmware ?? 'not stated'}; bundled catalog firmware ${r.catalogFirmware ?? 'not settled'}`);
  console.log(`  schema ${r.schema.stored ?? 'none'} (this build ${r.schema.current})${r.schema.usable ? '' : `  STALE (${r.schema.reason}): the server would not apply it; checked because of --allow-stale`}${r.recordCount !== null ? `; ${r.recordCount} records` : ''}`);
  console.log(`  suspect families: ${r.suspectFamilies.length ? r.suspectFamilies.join(', ') : 'none'}\n`);
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
  console.log(table(header, [...reachable.map(row), totalRow('TOTAL (blocks)', r.totals)], align));
  if (unreachable.length) {
    console.log('\nFamilies no effect id reaches (the generic response cannot serve them; not in the total):');
    console.log(table(header, [...unreachable.map(row), totalRow('subtotal', r.unreachable)], align));
  }
  console.log('\nROWS = informative rows (pid <= 0x3FFF) of the family counted from the profile itself; SHOWN + HIDDEN must equal ROWS.');
  console.log('HIDDEN = bypass / type / by-design rows; REMOVED = catalog rows a byte-exact profile no longer has (not rows of the profile).');
  console.log('HIGH / MED / LOW = nameConfidence of every named row, the hidden type / bypass rows included (generic params carry none; --json has the listed-only counts).');
  const nw = reachable.filter((f) => f.newPids.length).map((f) => `${f.family} ${f.newPids.join(',')}`);
  const gn = reachable.filter((f) => f.genericPids.length).map((f) => `${f.family} x${f.genericPids.length}`);
  console.log(`new params (no informative catalog row): ${nw.length ? nw.join('; ') : 'none'}`);
  console.log(`generic params the catalog has rows for but no name: ${gn.length ? gn.join('; ') : 'none'}`);
  const c = r.rowComparison;
  console.log(`\nRow-by-row against the bundled catalog (all families, hidden rows included, before any naming rule): ${c.exact} exact, ${c.compatible} compatible, ${c.incompatible} incompatible, ${c.newRows} new${c.removed !== null ? `, ${c.removed} removed` : ''}${c.skippedFamilies.length ? `; skipped suspect ${c.skippedFamilies.join(', ')}` : ''}`);
  printLayoutReport(r.layout);
  for (const p of r.probes) printProbe(p);
  for (const f of args.lists) listFamily(profile, f);
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
  console.log(`Online check of ${r.url}  (GET only)`);
  console.log(`  device ${r.device.model ?? '?'}, firmware ${r.device.firmware ?? '?'}`);
  console.log(`  capabilities.definitions: ${JSON.stringify(r.definitions)}`);
  console.log(`  compared against: ${r.comparison.source}${r.comparison.key ? ` (key ${r.comparison.key})` : ''}${r.comparison.note ? `; ${r.comparison.note}` : ''}\n`);
  const rows = r.blocks.map((b) => [
    String(b.eid), b.block, b.family ?? '-', String(b.listed), String(b.named), String(b.enums), String(b.hidden), String(b.removed),
    b.rows === null ? '-' : String(b.rows), String(b.generic), String(b.isNew),
    Object.entries(b.unresolved).map(([k, n]) => `${k}:${n}`).join(' ') || '-',
    b.status === 'ok' ? 'OK' : b.status === 'unknown-block' ? 'unknown block' : 'FAIL',
  ]);
  console.log(table(['EID', 'BLOCK', 'FAMILY', 'LISTED', 'NAMED', 'ENUMS', 'HIDDEN', 'REMOVED', 'ROWS', 'GENERIC', 'NEW', 'UNRESOLVED', 'STATUS'], rows,
    ['r', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l']));
  for (const b of r.blocks) for (const p of b.problems) console.log(`  eid ${b.eid} ${b.block}: ${p}`);
  console.log('\nLISTED = named + enums; HIDDEN excludes the reason \'removed\'; LISTED + HIDDEN must equal ROWS (the informative rows of the compared profile).');
  if (r.layout) printLayoutReport(r.layout);
  for (const p of r.probes) printProbe(p);
  if (profile) for (const f of args.lists) listFamily(profile, f);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  let offline: { report: OfflineReport; profile: DeviceProfile } | null = null;
  let online: { report: OnlineReport; profile: DeviceProfile | null } | null = null;
  if (args.profile) offline = runOffline(args);
  if (args.url) online = await runOnline(args, offline?.profile ?? null);

  if (args.strict) {
    for (const w of warnings) failures.push({ ...w, code: `${w.code} (strict)` });
  }
  if (args.json) {
    console.log(JSON.stringify({
      ok: failures.length === 0 && transportErrors.length === 0,
      failures, warnings, transportErrors,
      offline: offline?.report ?? null,
      online: online?.report ?? null,
    }, null, 2));
  } else {
    if (offline) printOffline(offline.report, offline.profile, args);
    if (offline && online) console.log('\n' + '='.repeat(72) + '\n');
    if (online) printOnline(online.report, online.profile, args);
    if (!args.strict && warnings.length) {
      console.log(`\nWarnings (${warnings.length}, they do not change the exit code; --strict does):`);
      for (const w of warnings.slice(0, 40)) console.log(`  [${w.code}] ${w.where}: ${w.message}`);
      if (warnings.length > 40) console.log(`  ... and ${warnings.length - 40} more (use --json for all)`);
    }
    console.log(failures.length === 0 ? '\nRESULT: all invariants hold' : `\nRESULT: ${failures.length} invariant failure(s)`);
    for (const f of failures.slice(0, 60)) console.log(`  FAIL [${f.code}] ${f.where}: ${f.message}`);
    if (failures.length > 60) console.log(`  ... and ${failures.length - 60} more (use --json for all)`);
    if (transportErrors.length) {
      console.log(`\nTRANSPORT: ${transportErrors.length} request(s) failed before the server answered (exit code 2)`);
      for (const t of transportErrors) console.log(`  ${t.where}: ${t.message}`);
    }
  }
  process.exitCode = transportErrors.length > 0 ? 2 : failures.length === 0 ? 0 : 1;
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) console.error(`profile-check: ${e.message}`);
  else console.error('profile-check: unexpected error:', e);
  process.exitCode = 2;
});
