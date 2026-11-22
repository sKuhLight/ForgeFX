// Strict structural validation of RAW definition sources (the `raw` envelope of a profile v2 document) that come from
// OUTSIDE this install: a `.axisdefs` file (services/definitionsFile.ts) and a cloud profile (services/cloudProfiles.ts).
// Nothing a foreign document says is trusted before it passed here: the derivation (`deriveProfile`) and the merge read
// these records by property, so a hostile or damaged file must not be able to put a prototype key, a non-number, a
// non-finite value or an unbounded array in front of them.
//
// What it does, in two stages:
//   1. `findUnsafeValue` walks the whole value once (bounded depth, value count, array and string sizes): only JSON data
//      (null, booleans, finite numbers, strings, arrays, plain objects), no `__proto__` / `constructor` / `prototype`
//      key anywhere, no non-finite number (`1e999` parses to Infinity), no oversize string or array;
//   2. `checkProfileRaw` / `checkRawSources` validate the shape of every source and record (types, integer and range
//      limits, array lengths, the kind <-> space pairing) and hand back a SANITIZED COPY: built field by field from the
//      known keys only, in the codec's field order. Keys this build does not know are dropped (never stored), so what
//      is derived and persisted is exactly what was validated.
// Two structural rules keep the derivation's cost linear in what the document declares (the codec's `planUnit` filters the
// records once per section tag a source does not declare, so an attacker-chosen tag per record would be quadratic):
//   - every record of an editor-cache source sits in one of that source's DECLARED sections (`sections[].tag`, unique,
//     at most `RAW_LIMITS.sections`), every record of a live source in a block of its `scope.blocks`;
//   - all sources together hold at most `RAW_LIMITS.totalRecords` records (real data: an FM3 byte source has ~2.5 k records,
//     a live walk ~3 k, a whole document with probes 6-8 k; the bound is five times that).
// A source's `firmware` is canonical (`isCanonicalFirmware`: `<major>.<minor>`, no leading zeros): the merge compares
// firmware strings as text, so another spelling of the same version would count as another firmware.
//
// The limits are plausibility bounds, deliberately a few times above what real firmware produces (an FM3 byte source is
// ~2.5 k records, a live source ~3 k; the largest label list ~340 entries), not tight protocol facts: a bound that real
// data could exceed would refuse the document this build exported itself.
//
// Browser-safe: pure, only codec types.
import type {
  CacheWalkIssue, EditorCacheRawSource, FloatTaper, LiveRawSource, LiveSourceScope, ProfileRaw, RawRecord, RawSource,
  SourceOrigin, WalkBoundHit
} from 'forgefx-midi/cache';

/** Why a value was refused: where (`raw.sources[0].records[3].id`) and what is wrong. */
export interface RawIssue { path: string; message: string }

export type RawCheck = { ok: true; raw: ProfileRaw } | ({ ok: false } & RawIssue);
export type RawSourcesCheck = { ok: true; sources: RawSource[] } | ({ ok: false } & RawIssue);

/** The size limits of the validation (exported for the tests; never lowered below real data). */
export const RAW_LIMITS = Object.freeze({
  /** Nesting depth of a whole document (a file is ~10 deep). */
  depth: 32,
  /** Values (nodes) of a whole document; `totalRecords` records of ~15 values stay far below. */
  nodes: 6_000_000,
  /** Characters of any string in the document. */
  string: 65_536,
  /** Length of any array in the document. */
  array: 200_000,
  /** Keys of any object in the document / characters of a key. */
  keys: 100_000,
  keyLength: 256,
  sources: 32,
  /** Records of all sources of a document together, and so of any one source (see the module comment for the real numbers). */
  totalRecords: 40_000,
  /** Labels of one enum record (the biggest real roster has ~340). */
  enumValues: 16_384,
  /** Wire ids of one cab/IR table record (the codec's own limit). */
  wireIds: 0xffff,
  /** A label (a model name, a cab name, an effect label). */
  label: 512,
  unit: 32,
  taperPoints: 1_024,
  sections: 4_096,
  issues: 1_024,
  blocks: 4_096,
  idList: 65_536,
  boundHits: 4_096,
  /** Magnitude of a float field (the largest f32). */
  float: 3.5e38
});

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const U16 = 0xffff;
const U32 = 0xffffffff;

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** `a.b[3].c` from a path trail. */
function formatPath(root: string, trail: ReadonlyArray<string | number>): string {
  let out = root;
  for (const k of trail) out += typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
  return out;
}

/**
 * Stage 1: is `root` plain, bounded JSON data? Null when it is, else the first problem found. Recursion is bounded by
 * `RAW_LIMITS.depth` before it descends, so a deeply nested value cannot exhaust the stack; paths are only formatted on
 * a failure (the walk visits millions of values on a big document).
 */
export function findUnsafeValue(root: unknown, rootPath = 'value'): RawIssue | null {
  const trail: Array<string | number> = [];
  let nodes = 0;
  const fail = (message: string): RawIssue => ({ path: formatPath(rootPath, trail), message });
  const visit = (v: unknown, depth: number): RawIssue | null => {
    if (++nodes > RAW_LIMITS.nodes) return fail('too many values');
    if (v === null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? null : fail('not a finite number');
    if (typeof v === 'string') return v.length <= RAW_LIMITS.string ? null : fail(`string longer than ${RAW_LIMITS.string} characters`);
    if (typeof v !== 'object') return fail(`not JSON data (${typeof v})`);
    if (depth >= RAW_LIMITS.depth) return fail(`nested deeper than ${RAW_LIMITS.depth} levels`);
    if (Array.isArray(v)) {
      if (v.length > RAW_LIMITS.array) return fail(`array longer than ${RAW_LIMITS.array}`);
      for (let i = 0; i < v.length; i++) {
        trail.push(i);
        const r = visit(v[i], depth + 1);
        trail.pop();
        if (r) return r;
      }
      return null;
    }
    if (!isPlain(v)) return fail('not a plain object');
    const keys = Object.keys(v);
    if (keys.length > RAW_LIMITS.keys) return fail(`object with more than ${RAW_LIMITS.keys} keys`);
    for (const k of keys) {
      trail.push(k);
      if (FORBIDDEN_KEYS.has(k)) return fail('forbidden key');
      if (k.length > RAW_LIMITS.keyLength) return fail('key too long');
      const r = visit(v[k], depth + 1);
      trail.pop();
      if (r) return r;
    }
    return null;
  };
  return visit(root, 0);
}

// ── stage 2: shape ──

class Invalid extends Error {
  readonly path: string;
  readonly why: string;
  constructor(path: string, why: string) {
    super(`${path}: ${why}`);
    this.path = path;
    this.why = why;
  }
}
const bad = (path: string, why: string): never => { throw new Invalid(path, why); };

const obj = (v: unknown, path: string): Record<string, unknown> => (isPlain(v) ? v : bad(path, 'expected an object'));
const arr = (v: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(v)) return bad(path, 'expected an array');
  return v.length <= max ? v : bad(path, `array longer than ${max}`);
};
const int = (v: unknown, path: string, min: number, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : bad(path, `expected an integer ${min}..${max}`);
const flt = (v: unknown, path: string): number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= RAW_LIMITS.float ? v : bad(path, 'expected a finite number');
const str = (v: unknown, path: string, max: number): string =>
  typeof v === 'string' && v.length <= max ? v : bad(path, `expected a string of at most ${max} characters`);
/** A short identifier-like string: printable ASCII only (ids, stamps, versions). */
const ident = (v: unknown, path: string, max: number, min = 0): string =>
  typeof v === 'string' && v.length >= min && v.length <= max && /^[\x20-\x7e]*$/.test(v) ? v : bad(path, `expected printable ASCII, ${min}..${max} characters`);
const bool = (v: unknown, path: string): boolean => (typeof v === 'boolean' ? v : bad(path, 'expected a boolean'));
function oneOf<T extends string>(v: unknown, path: string, set: readonly T[]): T {
  return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : bad(path, `expected one of ${set.join(' | ')}`);
}
const nullable = <T>(v: unknown, path: string, f: (x: unknown, p: string) => T): T | null => (v === null ? null : f(v, path));
/** `undefined` (key absent) stays undefined; anything else must pass `f`. */
const optional = <T>(v: unknown, path: string, f: (x: unknown, p: string) => T): T | undefined => (v === undefined ? undefined : f(v, path));

const CANONICAL_FIRMWARE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
/** `<major>.<minor>` as `formatFirmwareVersion` writes it: decimal numbers without leading zeros or spaces (`13.0`, not
 *  `13.00`, `013.0` or ` 13.0`). The one spelling every firmware comparison and device-cache key relies on. */
export const isCanonicalFirmware = (v: unknown): v is string => typeof v === 'string' && CANONICAL_FIRMWARE.test(v);
const firmwareString = (v: unknown, path: string): string =>
  isCanonicalFirmware(v) ? v : bad(path, 'expected "<major>.<minor>" without leading zeros');

const SOURCE_KINDS = ['editor-cache', 'live-readonly', 'live-full', 'live-probe'] as const;
const ORIGINS: readonly SourceOrigin[] = ['local', 'cloud', 'file'];
const TAPER_SHAPES = ['linear', 'log', 'flat', 'custom', 'unknown'] as const;
const EXTENSIONS = ['done', 'skipped', 'aborted'] as const;

function taper(v: unknown, path: string): FloatTaper {
  const o = obj(v, path);
  const points = arr(o.points, `${path}.points`, RAW_LIMITS.taperPoints).map((p, i) => {
    const pair = arr(p, `${path}.points[${i}]`, 2);
    if (pair.length !== 2) bad(`${path}.points[${i}]`, 'expected a [normalized, display] pair');
    return [flt(pair[0], `${path}.points[${i}][0]`), flt(pair[1], `${path}.points[${i}][1]`)] as const;
  });
  return {
    shape: oneOf(o.shape, `${path}.shape`, TAPER_SHAPES),
    err: nullable(o.err, `${path}.err`, flt),
    reliable: bool(o.reliable, `${path}.reliable`),
    points
  };
}

/** One walker record without its byte position (a `RawRecord`), fields in the codec's order. */
function record(v: unknown, path: string): RawRecord {
  const o = obj(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, ['float', 'enum'] as const);
  const section = int(o.section, `${path}.section`, 0, U16);
  const id = int(o.id, `${path}.id`, 0, U16);
  const tc = int(o.tc, `${path}.tc`, 0, U32);
  const min = flt(o.min, `${path}.min`);
  const max = flt(o.max, `${path}.max`);
  const def = flt(o.def, `${path}.def`);
  const step = flt(o.step, `${path}.step`);
  const unit = optional(o.unit, `${path}.unit`, (x, p) => str(x, p, RAW_LIMITS.unit));
  if (kind === 'float') {
    const t1 = int(o.t1, `${path}.t1`, 0, U32);
    const t2 = int(o.t2, `${path}.t2`, 0, U32);
    const tp = optional(o.taper, `${path}.taper`, taper);
    const placeholder = optional(o.placeholder, `${path}.placeholder`, bool);
    return {
      kind: 'float', section, id, tc, min, max, def, step, ...(unit !== undefined ? { unit } : {}), t1, t2,
      ...(tp !== undefined ? { taper: tp } : {}), ...(placeholder === true ? { placeholder: true } : {})
    };
  }
  const count = int(o.count, `${path}.count`, 0, U32);
  const values = arr(o.values, `${path}.values`, RAW_LIMITS.enumValues).map((x, i) => str(x, `${path}.values[${i}]`, RAW_LIMITS.label));
  const x = int(o.x, `${path}.x`, 0, U32);
  const wireIds = optional(o.wireIds, `${path}.wireIds`, (w, p) => arr(w, p, RAW_LIMITS.wireIds).map((n, i) => int(n, `${p}[${i}]`, 0, U32)));
  return { kind: 'enum', section, id, tc, min, max, def, step, ...(unit !== undefined ? { unit } : {}), count, values, x, ...(wireIds !== undefined ? { wireIds } : {}) };
}

function walkIssue(v: unknown, path: string): CacheWalkIssue {
  const o = obj(v, path);
  return {
    section: nullable(o.section, `${path}.section`, (x, p) => int(x, p, 0, U32)),
    record: nullable(o.record, `${path}.record`, (x, p) => int(x, p, 0, U32)),
    offset: int(o.offset, `${path}.offset`, 0, Number.MAX_SAFE_INTEGER),
    reason: str(o.reason, `${path}.reason`, 256),
    droppedRecords: int(o.droppedRecords, `${path}.droppedRecords`, 0, U32),
    skippedBytes: int(o.skippedBytes, `${path}.skippedBytes`, 0, Number.MAX_SAFE_INTEGER),
    resumedAt: nullable(o.resumedAt, `${path}.resumedAt`, (x, p) => int(x, p, 0, Number.MAX_SAFE_INTEGER))
  };
}

/** A `{ '<int>': T }` dictionary: keys are plain decimal integers up to 65535. */
function intKeyed<T>(v: unknown, path: string, f: (x: unknown, p: string) => T): Record<number, T> {
  const o = obj(v, path);
  const keys = Object.keys(o);
  if (keys.length > RAW_LIMITS.blocks) bad(path, `more than ${RAW_LIMITS.blocks} entries`);
  const out: Record<number, T> = {};
  for (const k of keys) {
    if (!/^(0|[1-9]\d{0,4})$/.test(k) || Number(k) > U16) bad(`${path}[${JSON.stringify(k)}]`, 'expected an integer key 0..65535');
    out[Number(k)] = f(o[k], `${path}[${k}]`);
  }
  return out;
}

function scope(v: unknown, path: string): LiveSourceScope {
  const o = obj(v, path);
  const blocks = arr(o.blocks, `${path}.blocks`, RAW_LIMITS.blocks).map((b, i) => int(b, `${path}.blocks[${i}]`, 0, U16));
  const maxParamId = int(o.maxParamId, `${path}.maxParamId`, 0, U16);
  const bounds = intKeyed(o.bounds, `${path}.bounds`, (x, p) => int(x, p, 0, U16));
  const idLists = optional(o.idLists, `${path}.idLists`, (x, p) =>
    intKeyed(x, p, (l, lp) => arr(l, lp, RAW_LIMITS.idList).map((n, i) => int(n, `${lp}[${i}]`, 0, U16))));
  return {
    blocks, maxParamId, bounds, ...(idLists !== undefined ? { idLists } : {}),
    extended: bool(o.extended, `${path}.extended`), above160: bool(o.above160, `${path}.above160`), hinted: bool(o.hinted, `${path}.hinted`)
  };
}

function liveWalk(v: unknown, path: string): LiveRawSource['walk'] {
  const o = obj(v, path);
  const n = (key: string): number => int(o[key], `${path}.${key}`, 0, U32);
  const pseudo = optional(o.pseudoReplies, `${path}.pseudoReplies`, (x, p) => {
    const q = obj(x, p);
    return {
      endMarker: int(q.endMarker, `${p}.endMarker`, 0, U32), duplicateId: int(q.duplicateId, `${p}.duplicateId`, 0, U32),
      implausible: int(q.implausible, `${p}.implausible`, 0, U32)
    };
  });
  const boundHits: WalkBoundHit[] = arr(o.boundHits, `${path}.boundHits`, RAW_LIMITS.boundHits).map((h, i) => {
    const q = obj(h, `${path}.boundHits[${i}]`);
    return {
      block: int(q.block, `${path}.boundHits[${i}].block`, 0, U16), lastReal: int(q.lastReal, `${path}.boundHits[${i}].lastReal`, 0, U16),
      bound: int(q.bound, `${path}.boundHits[${i}].bound`, 0, U16)
    };
  });
  const extension = optional(o.extension, `${path}.extension`, (x, p) => oneOf(x, p, EXTENSIONS));
  const abortReason = optional(o.abortReason, `${path}.abortReason`, (x, p) => str(x, p, 256));
  return {
    queries: n('queries'), lostReplies: n('lostReplies'), recoveredReplies: n('recoveredReplies'), unresolvedReplies: n('unresolvedReplies'),
    placeholderSlots: n('placeholderSlots'), missingSlots: n('missingSlots'), silentAddresses: n('silentAddresses'),
    ...(pseudo !== undefined ? { pseudoReplies: pseudo } : {}), boundHits,
    ...(extension !== undefined ? { extension } : {}), ...(abortReason !== undefined ? { abortReason } : {})
  };
}

/** `records` of one source, each checked and (through `accept`) required to sit in a section / block the source declares. */
function sourceRecords(recs: unknown[], path: string, accept: (section: number) => boolean, what: string): RawRecord[] {
  const records: RawRecord[] = new Array<RawRecord>(recs.length);
  for (let i = 0; i < recs.length; i++) {
    const r = record(recs[i], `${path}.records[${i}]`);
    if (!accept(r.section)) bad(`${path}.records[${i}].section`, what);
    records[i] = r;
  }
  return records;
}

function source(v: unknown, path: string): RawSource {
  const o = obj(v, path);
  const kind = oneOf(o.kind, `${path}.kind`, SOURCE_KINDS);
  const id = ident(o.id, `${path}.id`, 160, 1);
  const origin = oneOf(o.origin, `${path}.origin`, ORIGINS);
  const capturedAt = nullable(o.capturedAt, `${path}.capturedAt`, (x, p) => ident(x, p, 64));
  const firmware = nullable(o.firmware, `${path}.firmware`, firmwareString);
  const codecVersion = ident(o.codecVersion, `${path}.codecVersion`, 64);
  const recs = arr(o.records, `${path}.records`, RAW_LIMITS.totalRecords);
  if (kind === 'editor-cache') {
    oneOf(o.space, `${path}.space`, ['section'] as const);
    const declared = new Set<number>();
    const sections = arr(o.sections, `${path}.sections`, RAW_LIMITS.sections).map((s, i) => {
      const q = obj(s, `${path}.sections[${i}]`);
      const tag = int(q.tag, `${path}.sections[${i}].tag`, 0, U16);
      if (declared.has(tag)) bad(`${path}.sections[${i}].tag`, 'section declared twice');
      declared.add(tag);
      return { tag, count: int(q.count, `${path}.sections[${i}].count`, 0, U32) };
    });
    const records = sourceRecords(recs, path, (t) => declared.has(t), 'not a section this source declares');
    const om = obj(o.omitted, `${path}.omitted`);
    const omitted = { tables: int(om.tables, `${path}.omitted.tables`, 0, U32), records: int(om.records, `${path}.omitted.records`, 0, U32) };
    const header = nullable(o.header, `${path}.header`, (x, p) => {
      const h = obj(x, p);
      return { major: int(h.major, `${p}.major`, 0, U32), minor: int(h.minor, `${p}.minor`, 0, U32), sectionCount: int(h.sectionCount, `${p}.sectionCount`, 0, U32) };
    });
    const fileVersion = nullable(o.fileVersion, `${path}.fileVersion`, (x, p) => ident(x, p, 32));
    const contentSha256 = nullable(o.contentSha256, `${path}.contentSha256`, (x, p) =>
      typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? x : bad(p, 'expected 64 lowercase hex characters'));
    const issues = optional(o.issues, `${path}.issues`, (x, p) => arr(x, p, RAW_LIMITS.issues).map((q, i) => walkIssue(q, `${p}[${i}]`)));
    const out: EditorCacheRawSource = {
      id, kind, origin, capturedAt, firmware, codecVersion, space: 'section', sections, omitted, header, fileVersion, contentSha256, records,
      ...(issues !== undefined ? { issues } : {})
    };
    return out;
  }
  oneOf(o.space, `${path}.space`, ['block'] as const);
  const sc = scope(o.scope, `${path}.scope`);
  const blocks = new Set<number>(sc.blocks);
  const walk = liveWalk(o.walk, `${path}.walk`);
  const records = sourceRecords(recs, path, (b) => blocks.has(b), 'not a block this source walked (scope.blocks)');
  const out: LiveRawSource = { id, kind, origin, capturedAt, firmware, codecVersion, space: 'block', scope: sc, walk, records };
  return out;
}

/** The records of all `list` entries together stay within `RAW_LIMITS.totalRecords` (checked before any record is read). */
function totalRecords(list: unknown[], path: string): void {
  let total = 0;
  for (const s of list) if (isPlain(s) && Array.isArray(s.records)) total += s.records.length;
  if (total > RAW_LIMITS.totalRecords) bad(path, `${total} records in all sources (at most ${RAW_LIMITS.totalRecords})`);
}

const issueOf = (e: unknown): RawIssue => {
  if (e instanceof Invalid) return { path: e.path, message: e.why };
  throw e; // a bug in the validator, not a problem of the input
};

/** Stage 1 + 2 over a list of raw sources (`raw.sources`): the sanitized copies, or the first problem. `path` names
 *  the list in the messages; `scanned: true` skips stage 1 for a value `findUnsafeValue` already passed (as part of a
 *  bigger document). */
export function checkRawSources(value: unknown, path = 'sources', opts: { scanned?: boolean } = {}): RawSourcesCheck {
  const unsafe = opts.scanned ? null : findUnsafeValue(value, path);
  if (unsafe) return { ok: false, ...unsafe };
  try {
    const list = arr(value, path, RAW_LIMITS.sources);
    totalRecords(list, path);
    return { ok: true, sources: list.map((s, i) => source(s, `${path}[${i}]`)) };
  } catch (e) {
    return { ok: false, ...issueOf(e) };
  }
}

/** Stage 1 + 2 over a raw envelope (`{ format: 1, sources }`): a sanitized copy, or the first problem (`scanned`: see
 *  `checkRawSources`). The envelope's `format` must be this build's RAW_FORMAT (1): the caller decides what a newer one
 *  means. */
export function checkProfileRaw(value: unknown, path = 'raw', opts: { scanned?: boolean } = {}): RawCheck {
  const unsafe = opts.scanned ? null : findUnsafeValue(value, path);
  if (unsafe) return { ok: false, ...unsafe };
  try {
    const o = obj(value, path);
    if (o.format !== 1) bad(`${path}.format`, 'expected the raw format 1');
    const list = arr(o.sources, `${path}.sources`, RAW_LIMITS.sources);
    totalRecords(list, `${path}.sources`);
    return { ok: true, raw: { format: 1, sources: list.map((s, i) => source(s, `${path}.sources[${i}]`)) } };
  } catch (e) {
    return { ok: false, ...issueOf(e) };
  }
}
