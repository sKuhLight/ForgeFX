// Static catalog facts a device-definition profile is derived against, per model byte: the section voter's
// param catalog + seed anchors (`catalogForModel`), and the codec's `ProfileCatalog` / `DeriveOptions` (catalog
// firmware, reference rows and labels for the assignment suspect check, rosters, first effect ids, instance
// counts, the catalog section inventory). Every derivation of a profile document (import, build, cloud pull,
// re-derivation on load, Browser Direct) goes through `deriveOptionsFor`, so a stored document re-derives to
// exactly what the write path derived.
//
// Browser-safe: codec catalogs + the static device profiles only. No node:/fastify imports — this module is in
// the runtime router's import graph (check-browser-safe.ts enforces it).
import { HW_SEEDS, effectIdOwners, type CatalogSection, type DeriveOptions, type DeviceParam, type ProfileCatalog } from 'forgefx-midi/cache';
import { FM3_PARAMS, FM3_RANGES, FM3_ENUM_OVERRIDES, FM3_CATALOG_SECTIONS, FM3_EFFECT_ID_TABLE } from 'forgefx-midi/gen3/fm3';
import { FM9_PARAMS, FM9_RANGES, FM9_ENUM_OVERRIDES, FM9_CATALOG_SECTIONS, FM9_EFFECT_ID_TABLE } from 'forgefx-midi/gen3/fm9';
import {
  PARAMS as AXE3_PARAMS, AXE3_RANGES, AXE3_ENUM_OVERRIDES, AXE3_CATALOG_SECTIONS, AXE3_EFFECT_ID_TABLE, AXE_FX_III_BLOCKS
} from 'forgefx-midi/gen3/axe-fx-iii';
import { AM4_CACHE_PARAMS, AM4_SEEDS } from 'forgefx-midi/am4';
import { slugForEffectId } from 'forgefx-midi/devices/gen3';
import { PROFILES, SLUG_FAMILY, hiddenFamily, unlessHidden, type DeviceProfile } from './devices.js';

/** Device-cache doc key for the deviceCaches store collection: `<model-hex>_<major>p<minor>`
 *  (e.g. FM3 fw 12.0 → `11_12p0`). Shared by the registry (runtime profile swap), the deviceCache service
 *  (status / build / delete) and the gen-3 driver so all address the exact same doc. */
export function deviceCacheKey(modelId: number, major: number, minor: number): string {
  return `${modelId.toString(16).padStart(2, '0')}_${major}p${minor}`;
}

/** The full gen-3 param catalog of a model (every family). */
function allParamsForModel(model: number): DeviceParam[] {
  switch (model) {
    case 0x12: return FM9_PARAMS as unknown as DeviceParam[];
    case 0x10: return AXE3_PARAMS as unknown as DeviceParam[];
    case 0x11:
    default: return FM3_PARAMS as unknown as DeviceParam[];
  }
}

/** The params without the hidden family (memoised per catalog array and family). */
const HIDDEN_PARAMS = new WeakMap<object, Map<string, DeviceParam[]>>();
function withoutHidden(params: DeviceParam[], hidden: string | null): DeviceParam[] {
  if (hidden === null) return params;
  let perFamily = HIDDEN_PARAMS.get(params);
  if (!perFamily) HIDDEN_PARAMS.set(params, (perFamily = new Map()));
  let out = perFamily.get(hidden);
  if (!out) perFamily.set(hidden, (out = params.filter((p) => p.family !== hidden)));
  return out;
}

/** Gen-3 param catalog for the walk's section→family voter, by model byte. Only selfDescribe (gen-3
 *  grid) models reach here; FM3 is the defensive default. Without the family the development hook hides
 *  (devices.ts `hiddenFamily`). */
export function paramsForModel(model: number): DeviceParam[] {
  return withoutHidden(allParamsForModel(model), hiddenFamily());
}

/** Per-model catalog + seed anchors for the section voter. Gen-3 grid models share HW_SEEDS (cache-tag
 *  space); the AM4 has its own section tags and param model (cacheImport only, no live walk). The family the
 *  development hook hides is neither voted for nor seeded. */
export function catalogForModel(model: number): { params: DeviceParam[]; seeds: Record<string, number> } {
  if (model === 0x15) return { params: AM4_CACHE_PARAMS as unknown as DeviceParam[], seeds: AM4_SEEDS };
  const hidden = hiddenFamily();
  const seeds = hidden !== null && hidden in HW_SEEDS ? Object.fromEntries(Object.entries(HW_SEEDS).filter(([f]) => f !== hidden)) : HW_SEEDS;
  return { params: paramsForModel(model), seeds };
}

type EffectIdRow = { readonly family: string; readonly firstId: number | null };
type Tables = {
  ranges: NonNullable<ProfileCatalog['ranges']>;
  enumOverrides: NonNullable<ProfileCatalog['enumOverrides']>;
  sections: readonly CatalogSection[];
  /** The codec's family -> first effect id table of the model. */
  effectIds: readonly EffectIdRow[];
};

/** The codec's own catalog tables per gen-3 model (what the on-device rows of that device were mined into). */
function tablesFor(model: number): Tables | null {
  switch (model) {
    case 0x11: return { ranges: FM3_RANGES as unknown as Tables['ranges'], enumOverrides: FM3_ENUM_OVERRIDES as unknown as Tables['enumOverrides'], sections: FM3_CATALOG_SECTIONS, effectIds: FM3_EFFECT_ID_TABLE };
    case 0x12: return { ranges: FM9_RANGES as unknown as Tables['ranges'], enumOverrides: FM9_ENUM_OVERRIDES as unknown as Tables['enumOverrides'], sections: FM9_CATALOG_SECTIONS, effectIds: FM9_EFFECT_ID_TABLE };
    case 0x10: return { ranges: AXE3_RANGES as unknown as Tables['ranges'], enumOverrides: AXE3_ENUM_OVERRIDES as unknown as Tables['enumOverrides'], sections: AXE3_CATALOG_SECTIONS, effectIds: AXE3_EFFECT_ID_TABLE };
    default: return null;
  }
}

/** Highest effect id the first-id lookup scans (the whole effect-id byte). */
const MAX_EID = 255;
/** The voter's roster selector per family: `<F>_TYPE`, except where the codec names another one. */
const ROSTER_SELECTOR: Readonly<Record<string, string>> = { DELAY: 'DELAY_MODEL' };

/** The catalog pid of `family`'s roster selector (the param whose labels are the family's model list: `<F>_TYPE`,
 *  `DELAY_MODEL` for DELAY — the section voter's rule, as `profileCatalogFor(model).rosters` uses it), undefined when
 *  the model's catalog has no such param. */
export function rosterSelectorPid(model: number, family: string): number | undefined {
  const name = ROSTER_SELECTOR[family] ?? `${family}_TYPE`;
  return paramsForModel(model).find((p) => p.family === family && p.name === name)?.paramId;
}

/** Memo of `profileCatalogFor`, keyed by model and the hidden family (devices.ts `hiddenFamily`). */
const CATALOGS = new Map<string, ProfileCatalog>();

/** `rec` without the key `family` (the same object when it has none). */
const dropKey = <T>(rec: Readonly<Record<string, T>>, family: string | null): Record<string, T> => {
  if (family === null || !Object.prototype.hasOwnProperty.call(rec, family)) return rec as Record<string, T>;
  const out = { ...rec };
  delete out[family];
  return out;
};

/**
 * The codec `ProfileCatalog` of a model (memoised): catalog firmware, reference rows + labels (the assignment
 * suspect check), the model lists the section voter would derive from the catalog (family → labels of its
 * roster selector), each family's first effect id (`null` = not addressable, e.g. PRESET), the device-true
 * instance counts keyed by FAMILY symbol (the profile's per-slug counts, only those above one: an unlisted
 * family has one instance), and the catalog section inventory. A model without a gen-3 catalog (the AM4) gets an
 * empty catalog: coverage then only reports what the document itself says.
 *
 * First effect ids: the codec's effect-id table of the model (FM3 / FM9 / Axe-Fx III — each its own table, the
 * III's roster-only entries included: their blocks are placed, served read-only), then the profile's virtual blocks
 * (GLOBAL 1, MOD 3, …) for families the table gives no id. They switch on the codec's
 * block-space vote restriction (`effectIdOwners`): a live block may only take the family whose reserved span
 * holds it, every other block stays `block:<eid>` for the block map.
 */
export function profileCatalogFor(model: number): ProfileCatalog {
  // the family the development hook hides (devices.ts `hiddenFamily`) is left out of every part: no first effect id
  // (its blocks take part in the block map), no instance count, roster, reference rows or labels, and none of its
  // section-inventory entries (its editor-cache section stays `section:<tag>`, role `new`)
  const hidden = hiddenFamily();
  const memo = `${model}|${hidden ?? ''}`;
  const hit = CATALOGS.get(memo);
  if (hit) return hit;
  const tables = tablesFor(model);
  const profile = PROFILES[model];
  let out: ProfileCatalog = {};
  if (tables && profile) {
    const familyFirstEid: Record<string, number | null> = {};
    for (const e of tables.effectIds) {
      if (typeof e.firstId === 'number' && familyFirstEid[e.family] == null) familyFirstEid[e.family] = e.firstId;
    }
    for (let eid = 0; eid <= MAX_EID; eid++) {
      const fam = profile.familyForEffectId(eid);
      if (fam !== undefined && familyFirstEid[fam] == null) familyFirstEid[fam] = eid;
    }
    for (const fam of Object.keys(tables.ranges)) if (familyFirstEid[fam] === undefined) familyFirstEid[fam] = null;
    const instanceLimits: Record<string, number> = {};
    for (const [slug, n] of Object.entries(profile.instanceLimits)) {
      const fam = SLUG_FAMILY[slug];
      if (fam && n > 1) instanceLimits[fam] = n;
    }
    const rosters: Record<string, readonly string[]> = {};
    for (const p of paramsForModel(model)) {
      if (p.name !== (ROSTER_SELECTOR[p.family] ?? `${p.family}_TYPE`)) continue;
      const labels = tables.enumOverrides[p.family]?.[String(p.paramId)];
      if (labels && labels.length > 0) rosters[p.family] = labels;
    }
    out = {
      firmware: profile.catalogFirmware,
      ranges: dropKey(tables.ranges, hidden),
      enumOverrides: dropKey(tables.enumOverrides, hidden),
      rosters: dropKey(rosters, hidden),
      familyFirstEid: dropKey(familyFirstEid, hidden),
      instanceLimits: dropKey(instanceLimits, hidden),
      sections: hidden === null ? tables.sections : tables.sections.filter((s) => s.family !== hidden),
    };
  }
  CATALOGS.set(memo, out);
  return out;
}

/** Highest block (effect id) address the static roster covers: the whole effect-id byte. */
const ROSTER_MAX_BLOCK = 255;

/** A block address of the model's static roster: its catalog family, which instance of the family it is
 *  (1-based) and the family's editor slug (undefined for families without one, e.g. GLOBAL). `roster`: the model's
 *  effect-id table names the family from the roster only (no device read has bound it: Axe-Fx III FORGEFX-45 entries)
 *  — the block is described, but never walk-hinted, given a known size or bound, or swept. */
export interface StaticBlockRef { family: string; instance: number; slug?: string; roster?: true }

/** Catalog family -> editor slug (the inverse of `SLUG_FAMILY`). */
const FAMILY_SLUG: Record<string, string> = Object.fromEntries(Object.entries(SLUG_FAMILY).map(([slug, family]) => [family, slug]));

/** Number of reserved effect ids per first id in the shared gen-3 roster (the Axe-Fx III block table). */
const GEN3_RESERVED_IDS: ReadonlyMap<number, number> = new Map(
  AXE_FX_III_BLOCKS.filter((b) => b.firstId !== null).map((b) => [b.firstId as number, b.instances] as const)
);

/** Memo of `staticRoster`, keyed by model and the hidden family (devices.ts `hiddenFamily`). */
const STATIC_ROSTERS = new Map<string, ReadonlyMap<number, StaticBlockRef>>();

type RosterTableRow = { family: string; firstId: number | null; instances: number; addressing: string; confidence?: string };

/** The model's own effect-id table (the Axe-Fx III's since FORGEFX-45). */
function effectIdTableFor(model: number): readonly RosterTableRow[] | undefined {
  return model === 0x11 ? FM3_EFFECT_ID_TABLE : model === 0x12 ? FM9_EFFECT_ID_TABLE : model === 0x10 ? AXE3_EFFECT_ID_TABLE : undefined;
}

/** How the model's effect-id table addresses `eid` ('block' for a placeable block, 'virtual', …): the entry whose
 *  reserved ids (its first id up to the shared roster's reserved count) hold it; undefined when no entry does. */
export function effectIdAddressing(model: number, eid: number): string | undefined {
  for (const e of effectIdTableFor(model) ?? []) {
    if (e.firstId === null) continue;
    const span = Math.max(1, GEN3_RESERVED_IDS.get(e.firstId) ?? e.instances);
    if (eid >= e.firstId && eid < e.firstId + span) return e.addressing;
  }
  return undefined;
}

/** Block address -> family through the model's STATIC roster only, never a section→family vote of a walk
 *  (per-block walk options keyed through a vote would land on the wrong block whenever the vote is wrong).
 *  Shared by the walk limits and hints (services/deviceCache.ts) and the gen-3 driver's runtime
 *  `unmapped-block` gap.
 *   - Placeable blocks: every family the model's effect-id table classifies as a block (FM3 / FM9 / Axe-Fx III: each
 *     its own table) maps its ids first..first+n-1, where n is the model's instance count for the family: the
 *     table's (on the III: the ids the gen-3 roster reserves), raised to the unit's device-true count
 *     (`instanceLimits`) where the table lists fewer (the FM3/FM9 table lists one Input and one Output; the units
 *     have more), never past the ids the gen-3 roster reserves for the family. So an Axe-Fx III fifth Input (41) is
 *     mapped, a fourth FM3/FM9 multiplexer (194) is not. A table entry the codec trusts from the roster only
 *     (`confidence: 'roster'`, the six Axe-Fx III ids of FORGEFX-45 and their instance slots) is mapped with
 *     `roster: true`: described, never walk-hinted or bounded.
 *   - Everything else: the profile's virtual effect ids (GLOBAL 1, CONTROLLERS 2, MOD 3, ...).
 *  The family the development hook hides (devices.ts `hiddenFamily`) is left out. */
export function staticRoster(model: number): ReadonlyMap<number, StaticBlockRef> {
  const hidden = hiddenFamily();
  const memo = `${model}|${hidden ?? ''}`;
  const cached = STATIC_ROSTERS.get(memo);
  if (cached) return cached;
  const out = new Map<number, StaticBlockRef>();
  const profile: DeviceProfile | undefined = PROFILES[model];
  const table = effectIdTableFor(model);
  if (profile && table) {
    for (const e of table) {
      if (e.addressing !== 'block' || e.firstId === null || e.family === hidden) continue;
      const slug = FAMILY_SLUG[e.family];
      const reserved = GEN3_RESERVED_IDS.get(e.firstId) ?? e.instances;
      const rosterCount = model === 0x10 ? reserved : e.instances;
      const deviceCount = slug ? (profile.instanceLimits[slug] ?? profile.defaultInstances) : 0;
      const n = Math.min(Math.max(rosterCount, deviceCount), reserved);
      const rosterOnly = e.confidence === 'roster' ? { roster: true as const } : {};
      for (let i = 0; i < n; i++) out.set(e.firstId + i, { family: e.family, instance: i + 1, ...(slug ? { slug } : {}), ...rosterOnly });
    }
    const rosterFirst = new Set(table.filter((e) => e.confidence === 'roster' && e.firstId !== null).map((e) => e.firstId as number));
    for (let block = 0; block <= ROSTER_MAX_BLOCK; block++) {
      if (out.has(block)) continue;
      const family = profile.familyForEffectId(block); // the hidden family resolves to nothing here
      if (family !== undefined) out.set(block, { family, instance: 1, ...(rosterFirst.has(block) ? { roster: true as const } : {}) });
    }
  }
  STATIC_ROSTERS.set(memo, out);
  return out;
}

/** Memo of the effect-id span owners per model and hidden family. */
const STATIC_OWNERS = new Map<string, ReadonlyMap<number, string> | null>();

/** The catalog family a placed block address belongs to by the model's STATIC tables, without any profile:
 *  the static roster (`staticRoster`: every family's reserved instance slots and the virtual blocks), else the
 *  codec's effect-id span owner of the model's profile catalog (`effectIdOwners(profileCatalogFor(model))`: each
 *  family's first effect id plus its instance span — on the Axe-Fx III the III's own effect-id table). Undefined
 *  for an address no static table places (a block a newer firmware added, or one of the family the development
 *  hook hides). Pure, memoised per model. */
export function staticFamilyForEffectId(model: number, eid: number): string | undefined {
  const fromRoster = staticRoster(model).get(eid)?.family;
  if (fromRoster !== undefined) return fromRoster;
  const memo = `${model}|${hiddenFamily() ?? ''}`;
  let owners = STATIC_OWNERS.get(memo);
  if (owners === undefined) {
    owners = effectIdOwners(profileCatalogFor(model));
    STATIC_OWNERS.set(memo, owners);
  }
  return owners?.get(eid);
}

/** The catalog family a block address has by the bundled catalog alone: its audio family through the codec's block
 *  roster (`slugForEffectId` → `SLUG_FAMILY`), else `staticFamilyForEffectId` (static roster incl. the roster-only
 *  entries, effect-id spans, virtual blocks). Undefined for a block no static table places — the only blocks the block
 *  probe reads (services/blockProbe.ts `known-block`, and the probe availability of the generic block params). The
 *  family the development hook hides counts as unknown. */
export function catalogFamilyOfBlock(model: number, eid: number): string | undefined {
  return unlessHidden(SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()]) ?? staticFamilyForEffectId(model, eid);
}

/** The `deriveProfile` options of a document of `model` for `firmware` (the document's firmware; null/undefined
 *  = unknown, sources then only have to agree with each other). `derivedAt` is the caller's clock. */
export function deriveOptionsFor(model: number, firmware: string | null | undefined, derivedAt?: string): DeriveOptions {
  const catalog = profileCatalogFor(model);
  return {
    model,
    ...(firmware ? { firmware } : {}),
    ...(derivedAt ? { derivedAt } : {}),
    catalog,
    ...(catalog.sections ? { catalogSections: catalog.sections } : {}),
  };
}

/** The model byte of a device-cache key (`<model-hex>_<major>p<minor>`), or null when it is not one. */
export function modelOfCacheKey(key: string): number | null {
  const m = /^([0-9a-f]{1,2})_\d+p\d+$/i.exec(key);
  return m ? parseInt(m[1]!, 16) : null;
}

/** The firmware (`major.minor`) of a device-cache key, or null when it is not one. */
export function firmwareOfCacheKey(key: string): string | null {
  const m = /^[0-9a-f]{1,2}_(\d+)p(\d+)$/i.exec(key);
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}
