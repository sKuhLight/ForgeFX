// Profile fixtures built from the codec's own committed catalogs (no device, no private data): the
// catalog of a device read back as if it were a device cache. For the FM3 that is the profile of the
// firmware the catalog was generated from, so a byte-exact profile built here must agree with the bundled
// catalog on every row.
import { CACHE_SCHEMA, enumOrdinalBounds, type BuiltCache } from 'forgefx-midi/cache';
import { FM3_RANGES, FM3_ENUM_OVERRIDES, FM3_RANGE_SECTIONS, FM3_CATALOG_BASELINE } from 'forgefx-midi/gen3/fm3';
import { FM9_RANGES, FM9_ENUM_OVERRIDES, FM9_RANGE_SECTIONS, FM9_CATALOG_BASELINE } from 'forgefx-midi/gen3/fm9';
import { AXE3_RANGES, AXE3_ENUM_OVERRIDES, AXE3_RANGE_SECTIONS, AXE3_CATALOG_BASELINE } from 'forgefx-midi/gen3/axe-fx-iii';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY, type DeviceProfile, type RangeDef } from '../../src/devices.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { mockBlockDevice, type MockBlock } from './blockRead.js';

type Tables = {
  ranges: Readonly<Record<string, Readonly<Record<number, unknown>>>>;
  enums: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  sections: Readonly<Record<string, unknown>>;
  firmware: string | null;
};

const TABLES: Record<number, Tables> = {
  0x10: { ranges: AXE3_RANGES, enums: AXE3_ENUM_OVERRIDES, sections: AXE3_RANGE_SECTIONS, firmware: AXE3_CATALOG_BASELINE.firmware },
  0x11: { ranges: FM3_RANGES, enums: FM3_ENUM_OVERRIDES, sections: FM3_RANGE_SECTIONS, firmware: FM3_CATALOG_BASELINE.firmware },
  0x12: { ranges: FM9_RANGES, enums: FM9_ENUM_OVERRIDES, sections: FM9_RANGE_SECTIONS, firmware: FM9_CATALOG_BASELINE.firmware },
};

/** The persisted `meta.source` vocabulary of a stored profile (see isByteExactProfile). */
export type StoredProfileSource = 'editor-cache' | 'live' | 'cloud' | 'bytes';

/**
 * A `BuiltCache` made from the codec's catalog of `model`: every row (placeholders included), every label
 * list and the section strides, stamped with the current schema and the catalog's firmware. The row and
 * label maps are per-family copies, so a test may overwrite or delete a pid without touching the codec's
 * tables. `source` is the stored provenance (default: a byte-exact editor-cache import).
 */
export function catalogBuilt(model: number, source: StoredProfileSource = 'editor-cache', meta: Record<string, unknown> = {}): BuiltCache {
  const t = TABLES[model];
  if (!t) throw new Error(`no catalog tables for model 0x${model.toString(16)}`);
  const copyFamilies = <V>(o: Readonly<Record<string, V>>, copy: (v: V) => V): Record<string, V> =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, copy(v)]));
  const ranges = copyFamilies(t.ranges, (rows) => ({ ...rows }));
  const recordCount = Object.values(ranges).reduce((n, rows) => n + Object.keys(rows).length, 0);
  return {
    enumOverrides: copyFamilies(t.enums, (labels) => ({ ...labels })),
    ranges,
    rangeSections: copyFamilies(t.sections, (s) => ({ ...(s as object) })),
    rosters: {},
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    model,
    ...(t.firmware ? { firmware: t.firmware } : {}),
    meta: { schema: CACHE_SCHEMA, source, recordCount, ...meta },
  } as unknown as BuiltCache;
}

// ── a mocked unit with deterministic block bodies ──────────────────────────────────────────────────

/** The family a block read of `eid` resolves to on `profile`, and whether its body is channel-blocked: an audio
 *  block (codec slug with a catalog family) carries channels A-D, a virtual effect (GLOBAL, CONTROLLERS, the
 *  modifier, FC, …) one slice. The same resolution `blockParams` uses. */
export function blockFamilyOf(profile: DeviceProfile, eid: number): { family: string | undefined; hasChannels: boolean } {
  const audio = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
  return { family: audio ?? profile.familyForEffectId(eid), hasChannels: !!audio };
}

/** The synthetic wire value of `pid` in a block body: an enum-kind row holds an ordinal, `lo + pid % count` over
 *  its ordinal range; anything else (float rows, float-row selectors, unused slots, no row) the 16-bit
 *  `(pid * 997) % 65535`. Deterministic, never above full scale. */
export function syntheticRaw(row: RangeDef | undefined, pid: number): number {
  if (row?.kind === 'enum') {
    const { lo, hi } = enumOrdinalBounds(row);
    return lo + (pid % (hi - lo + 1));
  }
  return (pid * 997) % 65535;
}

/** The body a unit running `profile` answers for a bulk read of `eid`: one slice as wide as the family's section
 *  stride (else its highest row + 1), every position holding `syntheticRaw` of the effective row, repeated for
 *  four channels on an audio block. An eid without a family has an empty body. */
export function syntheticBody(profile: DeviceProfile, eid: number): number[] {
  const { family, hasChannels } = blockFamilyOf(profile, eid);
  if (!family) return [];
  const rows = profile.ranges[family] ?? {};
  const stride = profile.rangeSections[family]?.stride
    ?? Object.keys(rows).map(Number).filter((pid) => pid <= 0x3fff).reduce((m, pid) => Math.max(m, pid + 1), 1);
  const slice = Array.from({ length: stride }, (_, pid) => syntheticRaw(rows[pid], pid));
  return hasChannels ? [...slice, ...slice, ...slice, ...slice] : slice;
}

/** A gen-3 driver for `profile` on a mocked link (status dump + block bulk reads, see mockBlockDevice) where every
 *  eid in `eids` is placed on channel A and answers its `syntheticBody`. `overrides` replaces single blocks. */
export function mockGen3Device(
  profile: DeviceProfile, eids: readonly number[],
  opts: { overrides?: Record<number, MockBlock>; emit?: (e: DeviceEvent) => void } = {}
): ReturnType<typeof mockBlockDevice> {
  const blocks: Record<number, MockBlock> = {};
  for (const eid of eids) blocks[eid] = { values: syntheticBody(profile, eid), channel: 0 };
  Object.assign(blocks, opts.overrides ?? {});
  return mockBlockDevice(profile, blocks, opts.emit ? { emit: opts.emit } : {});
}
