// Profile v2 fixtures (raw sources + documents derived from them) for the profile store suites — synthetic
// records from the FM3 catalog only (no real cache, no device frames). An editor-cache source is made from
// synthetic cache bytes (test/helpers/cacheBytes.ts) through the codec's own `rawFromCacheBytes`; a live source
// from canned walk records through `rawFromLiveWalk`; a document through ForgeFX's `deriveProfileDoc` (the very
// derivation every write path and the re-derivation use).
import {
  rawFromCacheBytes, rawFromLiveWalk,
  type CacheRecord, type EditorCacheRawSource, type LiveRawSource, type LiveWalkResult, type ProfileDoc, type RawSource,
  type SourceOrigin
} from 'forgefx-midi/cache';
import { FM3_PARAMS_BY_FAMILY } from 'forgefx-midi/gen3/fm3';
import { deriveProfileDoc } from '../../src/profileSchema.js';
import { encodeCache, seedRecords as cacheSeedRecords, SEED_TAGS } from './cacheBytes.js';

export const FM3 = 0x11;
/** A fixed capture / derivation stamp (fixtures never read the clock). */
export const STAMP = '2026-11-22T10:00:00.000Z';

/** The seed families' block addresses (FM3 first effect ids): where a live walk reports their tables. */
export const SEED_BLOCKS: Record<string, number> = { DISTORT: 58, CABINET: 62, REVERB: 66, DELAY: 70, FUZZ: 118 };

/** The editor-cache seed records (test/helpers/cacheBytes.ts) keyed by block address instead of section tag:
 *  the same tables as a live walk reports them. `unit` adds a device unit to every row (a live walk that read
 *  values). */
export function liveSeedRecords(opts: { unit?: string } = {}): CacheRecord[] {
  const blockOf = new Map(Object.entries(SEED_TAGS).map(([fam, tag]) => [tag, SEED_BLOCKS[fam]!] as const));
  return cacheSeedRecords().map((r) => ({ ...r, section: blockOf.get(r.section)!, ...(opts.unit ? { unit: opts.unit } : {}) }));
}

/** An all-zero placeholder slot (an unused id of a table). */
const placeholder = (section: number, id: number): CacheRecord =>
  ({ kind: 'float', section, offset: 0, id, tc: 0, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, placeholder: true } as CacheRecord);

/** `records` with the table of `section` widened to `slots` ids: placeholder slots fill every id its rows leave
 *  free, so the derived stride of that table is `slots`. With `enumOf`, the family's first catalog enum param is
 *  written as a two-label enum row (a table of 100 slots or more without any enum row is a lookup table to the
 *  section voter, never a family). */
export function widenTable(records: readonly CacheRecord[], section: number, slots: number, enumOf?: string): CacheRecord[] {
  const out = [...records];
  const taken = new Set(records.filter((r) => r.section === section).map((r) => r.id));
  if (enumOf) {
    const byFam = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; unit?: string }[]>;
    const p = (byFam[enumOf] ?? []).find((q) => q.unit === 'enum' && !taken.has(q.paramId) && q.paramId < slots);
    if (p) {
      out.push({ kind: 'enum', section, offset: 0, id: p.paramId, tc: 0, min: 0, max: 1, def: 0, step: 0, count: 2, values: ['One', 'Two'], x: 0 });
      taken.add(p.paramId);
    }
  }
  for (let id = 0; id < slots; id++) if (!taken.has(id)) out.push(placeholder(section, id));
  return out;
}

/** Every range-bearing float param of an FM3 catalog family as a record at `section` (seed style: display range,
 *  default 1), so the section voter scores the family's own table decisively. */
export function familyRecords(family: string, section: number): CacheRecord[] {
  const byFam = FM3_PARAMS_BY_FAMILY as unknown as Record<string, { paramId: number; unit?: string; displayMin?: number; displayMax?: number }[]>;
  const seen = new Set<number>();
  const out: CacheRecord[] = [];
  for (const p of byFam[family] ?? []) {
    if (seen.has(p.paramId) || p.paramId >= 0xff00 || p.unit === 'enum' || p.displayMin == null || p.displayMax == null || p.displayMin === p.displayMax) continue;
    seen.add(p.paramId);
    out.push({ kind: 'float', section, offset: 0, id: p.paramId, tc: 0, min: p.displayMin, max: p.displayMax, def: 1, step: 0, t1: 0, t2: 0 });
  }
  return out;
}

/** A live walk result over `records` (reply-loss statistics zero unless given). */
export function walkResult(records: readonly CacheRecord[], stats: Partial<Omit<LiveWalkResult, 'records'>> = {}): LiveWalkResult {
  return {
    records: [...records], queries: records.length, enumLabels: 0, lostReplies: 0, recoveredReplies: 0, unresolvedReplies: 0,
    placeholderSlots: 0, missingSlots: 0, silentAddresses: 0, pseudoReplies: { endMarker: 0, duplicateId: 0, implausible: 0 },
    ...stats
  };
}

export interface SourceOpts {
  origin?: SourceOrigin;
  capturedAt?: string;
  firmware?: string;
}

/** A live raw source of the standard scope (blocks 0..160, ids ≤ 127) over `records`. */
export function liveSource(records: readonly CacheRecord[], opts: SourceOpts & { kind?: LiveRawSource['kind']; stats?: Partial<Omit<LiveWalkResult, 'records'>> } = {}): LiveRawSource {
  return rawFromLiveWalk(
    walkResult(records, opts.stats),
    { blocks: Array.from({ length: 161 }, (_, i) => i), maxParamId: 127, bounds: {}, extended: false, above160: false, hinted: false },
    { kind: opts.kind ?? 'live-readonly', capturedAt: opts.capturedAt ?? STAMP, firmware: opts.firmware ?? '12.0', origin: opts.origin ?? 'local' }
  );
}

/** An editor-cache raw source of synthetic cache bytes holding `records` (default: the seed records). */
export function editorCacheSource(records: readonly CacheRecord[] = cacheSeedRecords(), opts: SourceOpts = {}): Promise<EditorCacheRawSource> {
  return rawFromCacheBytes(encodeCache(records), { firmware: opts.firmware ?? '12.0', capturedAt: opts.capturedAt ?? STAMP, origin: opts.origin ?? 'local' });
}

/** A complete format-2 document of `model` / `firmware` derived from `sources` (ForgeFX meta included). */
export function profileDoc(sources: RawSource[], opts: { model?: number; firmware?: string; extras?: Record<string, unknown> } = {}): ProfileDoc {
  return deriveProfileDoc({ format: 1, sources }, opts.model ?? FM3, opts.firmware ?? '12.0', STAMP, opts.extras ?? {});
}

/** A deep copy (stored docs are plain JSON). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
