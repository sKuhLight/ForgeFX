// Synthetic editor-cache bytes for the import and contribution suites — NO real cache file, no real names.
// Little-endian primitives + record builders (float, enum/name table, cab/IR table) + a 0x2e-byte header
// builder, modelled on the codec's own test builders (forgefx-midi test/cache/cacheBytes.ts; copied, not
// imported across repos), and the seed-record fixture the import suite has always used: the 5 HW-seed
// families, each with a handful of its most distinctive range-bearing float params from the FM3 catalog, so
// the codec's section→family vote anchors every seed.
import { userNameTableKind, type CacheRecord, type UserNameTableKind } from 'forgefx-midi/cache';
import { FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from 'forgefx-midi/am4';
import { PROFILES } from '../../src/devices.js';
import { assert } from './mock.js';

/** A name: a string (written as UTF-8) or raw bytes. */
export type NameBytes = string | readonly number[];

export const pushU16 = (a: number[], v: number) => { a.push(v & 0xff, (v >>> 8) & 0xff); };
export const pushU32 = (a: number[], v: number) => { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
export const pushF32 = (a: number[], v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  a.push(b[0]!, b[1]!, b[2]!, b[3]!);
};
const utf8 = new TextEncoder();
const nameBytes = (n: NameBytes): number[] => (typeof n === 'string' ? [...utf8.encode(n)] : [...n]);
/** Length-prefixed name. */
const pushLp = (a: number[], n: NameBytes) => { const b = nameBytes(n); pushU32(a, b.length); a.push(...b); };
/** 22-byte record head: id, tc, pad, min, max, def, step. */
const pushHead = (a: number[], id: number, tc: number, min: number, max: number, def: number, step: number) => {
  pushU16(a, id); pushU16(a, tc); pushU16(a, 0); pushF32(a, min); pushF32(a, max); pushF32(a, def); pushF32(a, step);
};

/** Append one record exactly as the byte grammar lays it out (float, plain enum / name table). */
export function pushRecord(a: number[], r: CacheRecord): void {
  pushHead(a, r.id, r.tc, r.min, r.max, r.def, r.step);
  if (r.kind === 'float') { pushU32(a, r.t1); pushU32(a, r.t2); pushU16(a, 0); return; }
  pushU32(a, r.values.length);
  for (const v of r.values) pushLp(a, v);
  pushU32(a, r.x);
  pushU16(a, 0);
}

/** A plain name table record (the preset-name table): count, names, u32 x, u16 0. */
export function pushNameTable(a: number[], id: number, names: readonly NameBytes[]): void {
  pushHead(a, id, 16, 0, Math.max(0, names.length - 1), 0, 0);
  pushU32(a, names.length);
  for (const n of names) pushLp(a, n);
  pushU32(a, 0);
  pushU16(a, 0);
}

/** A cab/IR table record (a cab bank id): count, names, u16 0, u32 idCount, wire ids. */
export function pushCabTable(a: number[], id: number, names: readonly NameBytes[], wireIds: readonly number[]): void {
  pushHead(a, id, 0, 0, 0, 0, 0);
  pushU32(a, names.length);
  for (const n of names) pushLp(a, n);
  pushU16(a, 0);
  pushU32(a, wireIds.length);
  for (const w of wireIds) pushU32(a, w);
}

/** Fields of a synthetic 0x2e-byte header. */
export interface HeaderSpec { major?: number; minor?: number; sectionCount?: number; buildDate?: string }

/** A 0x2e-byte header: u32 major @0, u32 minor @4, u16 4 @8, build date @0x0a, u32 sections @0x2a. */
export function header(spec: HeaderSpec = {}): number[] {
  const a: number[] = [];
  pushU32(a, spec.major ?? 0);
  pushU32(a, spec.minor ?? 0);
  pushU16(a, 4);
  const date = spec.buildDate ?? '';
  for (let i = 0; i < 0x2a - 0x0a; i++) a.push(i < date.length ? date.charCodeAt(i) : 0);
  pushU32(a, spec.sectionCount ?? 0);
  return a;
}

/** Records grouped into sections in first-seen order, behind a header (default: all zeros, the import
 *  suite's historic fixture). Returns the bytes; `sections` is how many section headers were written. */
export function encodeCache(records: readonly CacheRecord[], head: readonly number[] = header()): Uint8Array {
  return encodeSections(groupBySection(records), head);
}

/** One section: its tag and a writer for its records (`count` records). */
export interface SectionSpec { tag: number; count: number; write: (a: number[]) => void }

export function groupBySection(records: readonly CacheRecord[]): SectionSpec[] {
  const order: number[] = [];
  const by = new Map<number, CacheRecord[]>();
  for (const r of records) { let g = by.get(r.section); if (!g) { by.set(r.section, (g = [])); order.push(r.section); } g.push(r); }
  return order.map((tag) => { const recs = by.get(tag)!; return { tag, count: recs.length, write: (a) => { for (const r of recs) pushRecord(a, r); } }; });
}

export function encodeSections(sections: readonly SectionSpec[], head: readonly number[]): Uint8Array {
  const a: number[] = [...head];
  for (const s of sections) { pushU32(a, s.tag); pushU32(a, s.count); s.write(a); }
  return new Uint8Array(a);
}

// ── the seed fixture (FM3 catalog rows) ──

/** The 5 HW-seed families and their section tags (what buildCache asserts for a gen-3 unit). */
export const SEED_TAGS: Record<string, number> = { DISTORT: 10, CABINET: 11, REVERB: 12, DELAY: 13, FUZZ: 25 };

/** Each seed family's most distinctive range-bearing float params, straight from the FM3 catalog. `mangle`
 *  rewrites a record (e.g. to make it disagree with the catalog). */
export function seedRecords(mangle?: (r: CacheRecord & { kind: 'float' }) => CacheRecord): CacheRecord[] {
  const byFam = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; unit?: string; displayMin?: number; displayMax?: number }[]>;
  const fams = Object.keys(SEED_TAGS);
  const shareCount = new Map<number, number>();
  for (const f of fams) { const seen = new Set<number>(); for (const p of byFam[f] ?? []) if (!seen.has(p.paramId)) { seen.add(p.paramId); shareCount.set(p.paramId, (shareCount.get(p.paramId) ?? 0) + 1); } }
  const recs: CacheRecord[] = [];
  for (const fam of fams) {
    const cands = (byFam[fam] ?? [])
      .filter((p) => p.paramId < 0xff00 && p.unit !== 'enum' && p.displayMin != null && p.displayMax != null && p.displayMin !== p.displayMax)
      .sort((a, b) => (shareCount.get(a.paramId)! - shareCount.get(b.paramId)!) || a.paramId - b.paramId)
      .slice(0, 6);
    assert(cands.length > 0, `seed family ${fam} has a range-bearing float param for the fixture`);
    for (const p of cands) {
      const r = { kind: 'float' as const, section: SEED_TAGS[fam]!, offset: 0, id: p.paramId, tc: 0, min: p.displayMin!, max: p.displayMax!, def: 1, step: 0, t1: 0, t2: 0 };
      recs.push(mangle ? mangle(r) : r);
    }
  }
  return recs;
}

/** The seed records again, but each written as the bundled FM3 catalog row it stands for (typecode, raw
 *  min/max = display / scale, scale in the default slot, step), so the built rows agree with the catalog the
 *  way a real cache of the catalog firmware does. `foreignUnits` swaps every typecode's unit class instead:
 *  same ranges (the section vote still anchors), but no row is compatible with the catalog any more. */
export function catalogSeedRecords(opts: { foreignUnits?: boolean } = {}): CacheRecord[] {
  const ranges = PROFILES[0x11]!.ranges;
  return seedRecords((r) => {
    const fam = Object.entries(SEED_TAGS).find(([, t]) => t === r.section)![0];
    const c = ranges[fam]?.[r.id];
    if (!c || c.kind !== 'float') return r;
    const scale = c.scale ?? 0;
    const tc = opts.foreignUnits ? ((c.typecode ?? 0) ^ 0x70) : (c.typecode ?? 0);
    return { ...r, tc, def: scale, min: scale ? c.displayMin / scale : c.displayMin, max: scale ? c.displayMax / scale : c.displayMax, step: c.step ?? 0 };
  });
}

/** AM4 seed records (one family per AM4 seed tag) — an AM4 cache's shape. */
export function am4SeedRecords(): CacheRecord[] {
  const recs: CacheRecord[] = [];
  for (const [fam, section] of Object.entries(AM4_SEEDS) as Array<[string, number]>) {
    const cands = (AM4_CACHE_PARAMS as unknown as { family: string; paramId: number; unit?: string; displayMin?: number; displayMax?: number }[])
      .filter((p) => p.family === fam && p.unit !== 'enum' && p.displayMin != null && p.displayMax != null && p.displayMin !== p.displayMax)
      .slice(0, 6);
    assert(cands.length > 0, `AM4 seed family ${fam} has range-bearing params`);
    for (const p of cands) recs.push({ kind: 'float', section, offset: 0, id: p.paramId, tc: 0, min: p.displayMin!, max: p.displayMax!, def: 1, step: 0, t1: 0, t2: 0 });
  }
  return recs;
}

// ── a contribution-shaped cache: seeds + a user cab bank + the preset-name table ──

/** Section tag the synthetic special tables live in (no catalog family uses it). */
export const NAMES_TAG = 60;

export interface ContributionCacheSpec {
  major: number;
  minor: number;
  /** Preset names (the preset-name table). Default: 4 synthetic names incl. an empty one and a UTF-8 one. */
  presetNames?: readonly NameBytes[];
  /** User cab names (a user cab bank, one wire id each). Default: 3 synthetic names. */
  userCabNames?: readonly NameBytes[];
  buildDate?: string;
  /** Write this section count into the header instead of the true one. */
  headerSections?: number;
  /** Seed records (default `catalogSeedRecords()`). */
  records?: readonly CacheRecord[];
}

/** Synthetic names the suites scan responses for: none of these may ever appear in an API body. */
export const SYNTHETIC_PRESET_NAMES = ['Zqx Lead Tone', 'Wvb Clean Room', '', 'Ünïcødé Crunch'] as const;
export const SYNTHETIC_USER_CAB_NAMES = ['Qjk My IR 4x12', 'Xyy Vintage Mic', 'Pzw Room Blend'] as const;

/** The record id the codec classes as `kind` (its own id rules; ForgeFX never spells the ranges out). */
function tableIdOf(kind: UserNameTableKind): number {
  for (let id = 0xffff; id >= 0; id--) if (userNameTableKind(id) === kind) return id;
  throw new Error(`the codec names no ${kind} table id`);
}

/** Build the bytes; also returns the section count and the non-empty name counts. */
export function contributionCache(spec: ContributionCacheSpec): { bytes: Uint8Array; sections: number; presetNames: number; userCabNames: number; records: number } {
  const presets = spec.presetNames ?? SYNTHETIC_PRESET_NAMES;
  const users = spec.userCabNames ?? SYNTHETIC_USER_CAB_NAMES;
  const seeds = spec.records ?? catalogSeedRecords();
  const sections = groupBySection(seeds);
  sections.push({
    tag: NAMES_TAG,
    count: 2,
    write: (a) => {
      pushCabTable(a, tableIdOf('userCabNames'), users, users.map((_, i) => 2000 + i));
      pushNameTable(a, tableIdOf('presetNames'), presets);
    }
  });
  const head = header({ major: spec.major, minor: spec.minor, sectionCount: spec.headerSections ?? sections.length, buildDate: spec.buildDate });
  const nonEmpty = (l: readonly NameBytes[]) => l.filter((n) => nameBytes(n).length > 0).length;
  return { bytes: encodeSections(sections, head), sections: sections.length, presetNames: nonEmpty(presets), userCabNames: nonEmpty(users), records: seeds.length + 2 };
}
