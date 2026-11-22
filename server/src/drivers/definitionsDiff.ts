// The definitions diff (`GET /device/definitions/diff`): the bundled catalog against the profile applied for the
// running firmware — new, changed and removed params, names that moved with their rows, model lists (rosters), other
// label lists, section strides, sections no catalog family took, blocks no catalog family places, and instance-count
// mismatches. Pure and browser-safe (no node:/fastify imports): the Fastify route and the runtime router call it
// through the same shared handler, over state the registry already holds — it never talks to the device.
//
// Nothing here re-decides what the rest of the server decides:
//   - rows: `classifyProfileRows` (drivers/profileCompare.ts), the pass behind `compareRows`, so the summary counts
//     are exactly `compareRows`' counts for the same profile, suspects and byte-exactness;
//   - names and moved names: the param index (`buildParamIndex(...).namedAt` / `byPid`) of the applied runtime
//     profile — the names `?generic=1` serves;
//   - byte-exactness per family: `ProfileFacts.isByteExactFamily` (the source that provides the family's existence
//     facts); a family that is not byte-exact has bounded coverage, so its `removed` is null;
//   - model lists and label lists: the codec's `rosterDiff` over the catalog's and the profile's (cleaned) labels;
//   - `state`: the caller passes `capabilities.definitions.drift` of the same moment (`definitionsDrift` is the one
//     rule both use).
import { enumOrdinalBounds, isInformativeRow, isSyntheticFamilyKey, paramFingerprint, rosterDiff, type BuiltCache, type RosterDiff } from 'forgefx-midi/cache';
import { paramLabel, type DeviceProfile, type ParamDef, type RangeDef } from '../devices.js';
import { profileCatalogFor, rosterSelectorPid } from '../profileCatalog.js';
import { profileSummaryOf } from '../profileSchema.js';
import { buildParamIndex, MAX_WIRE_PID, type BlockIndex } from './paramIndex.js';
import { classifyProfileRows, type ClassifiedFamily } from './profileCompare.js';
import type {
  DefinitionsCaps, DefinitionsDiffDTO, DefinitionsDiffPart, FamilyDiff, ParamDelta, RosterDelta, SectionDiff, UnknownBlockDiff
} from './types.js';

// ── drift (shared with capabilities.definitions) ─────────────────────────────────────────────────────────────────

export type DefinitionsDrift = DefinitionsCaps['drift'];

/** What `capabilities.definitions.drift` is decided from. */
export interface DriftInput {
  /** Running firmware (`"13.0"`), null when it was not read. */
  running: string | null;
  /** The bundled catalog's firmware, null when not settled. */
  catalogFirmware: string | null;
  /** The applied runtime profile: the firmware its document describes and whether its coverage has a blocking gap
   *  of its own. Null while the bundled catalog is live. */
  applied: { firmware: string | null; blocking: boolean } | null;
  /** A placed block no family describes (the runtime `unmapped-block` gap); only counts with an applied profile. */
  unmapped: boolean;
  /** A profile for the running firmware is stored but not usable. */
  storedStale: boolean;
}

/** `capabilities.definitions.drift`: `unknown` (firmware not read, or no catalog firmware and no profile), `none` (an
 *  applied profile of the running firmware — or one layered over the catalog's own firmware — without a blocking gap,
 *  or the catalog's firmware with nothing applied), `partial` (such an applied profile with a blocking gap, its own or
 *  the runtime `unmapped-block`), `stale` (a stored profile for the running firmware that cannot be used),
 *  `unprofiled` (anything else). The registry's capabilities and the definitions diff both use this rule. */
export function definitionsDrift(i: DriftInput): DefinitionsDrift {
  if (i.running === null) return 'unknown';
  if (i.applied && (i.applied.firmware === i.running || i.catalogFirmware === i.running)) {
    // an applied profile with a blocking gap (the document's own, e.g. unresolved replies of its walk, or the runtime
    // unmapped-block) is partial — also on the catalog's own firmware: the profile is layered over the catalog and
    // its gaps are real holes in what is applied (the codec only blocks the gaps the catalog cannot fill — high ids,
    // rosters, blocks above 160 — when the firmware differs)
    return i.unmapped || i.applied.blocking ? 'partial' : 'none';
  }
  if (i.catalogFirmware === i.running) return 'none';
  if (i.storedStale) return 'stale';
  if (!i.applied && i.catalogFirmware === null) return 'unknown';
  return 'unprofiled';
}

// ── input / query ────────────────────────────────────────────────────────────────────────────────────────────────

/** The applied runtime profile: its device-cache key, the stored document it was layered from and the runtime
 *  profile itself (`runtimeProfileFrom(doc, bundled)`, carrying `profileFacts`). */
export interface AppliedDefinitions { key: string; doc: BuiltCache; profile: DeviceProfile }

export interface DefinitionsDiffInput {
  /** Model byte of the connected device. */
  model: number;
  /** Running firmware (`"13.0"`), null when not read. */
  firmware: string | null;
  /** `capabilities.definitions.drift` of the same moment. */
  state: DefinitionsDrift;
  /** The bundled (static) profile of the model. */
  staticProfile: DeviceProfile;
  /** The applied runtime profile, null while the bundled catalog is live. */
  applied: AppliedDefinitions | null;
  /** Effect ids of the edit-buffer grid as last read (no read yet: null → nothing counts as placed). */
  placedEids?: readonly number[] | null;
  /** Placed effect ids no family describes (the driver's `unmappedPlacedEffectIds`). */
  unmappedEids?: readonly number[] | null;
}

export const DEFINITIONS_DIFF_PARTS: readonly DefinitionsDiffPart[] = ['params', 'rosters', 'enums', 'strides', 'sections', 'blocks', 'instances'];

/** What the client selected: `families` (none = every family) and `include` (absent = every part). */
export interface DefinitionsDiffQuery { families?: readonly string[]; include?: ReadonlySet<DefinitionsDiffPart> }

/** The query values of one key, as either surface hands them over (Fastify: a string or, for a repeated key, an array;
 *  the router: `URLSearchParams.getAll`), split at commas, trimmed, empty ones dropped. */
function queryValues(v: unknown): string[] {
  const list = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  return list.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Parse `family=` (repeatable, also comma-separated) and `include=` (comma-separated, also repeatable). An `include`
 *  without any value means every part; unknown part names are ignored (a newer client asking an older server gets
 *  what that server knows). The same parse on both surfaces. */
export function parseDefinitionsDiffQuery(family: unknown, include: unknown): DefinitionsDiffQuery {
  const families = [...new Set(queryValues(family))];
  const parts = queryValues(include);
  const known = new Set<string>(DEFINITIONS_DIFF_PARTS);
  return {
    ...(families.length > 0 ? { families } : {}),
    ...(parts.length > 0 ? { include: new Set(parts.filter((p) => known.has(p)) as DefinitionsDiffPart[]) } : {})
  };
}

export type DefinitionsDiffResult = { ok: true; diff: DefinitionsDiffDTO } | { ok: false; error: 'unknown-family'; family: string };

// ── the builder ──────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const byNumber = (a: number, b: number) => a - b;

type FamilyDetail = Required<Pick<FamilyDiff, 'params' | 'enums'>> & Pick<FamilyDiff, 'roster' | 'stride'> & { status: FamilyDiff['status'] };

/** The label change of a list that differs (`rosterDiff`): only appended labels, only renames, insertions (perhaps
 *  with appended labels), only removals, or a mix (`replaced`). */
function labelChange(d: RosterDiff): 'appended' | 'renamed' | 'inserted' | 'removed' | 'replaced' {
  const ins = d.inserted.length > 0, app = d.appended.length > 0, ren = d.renamed.length > 0, rem = d.removed.length > 0;
  if (app && !ins && !ren && !rem) return 'appended';
  if (ren && !ins && !app && !rem) return 'renamed';
  if (ins && !ren && !rem) return 'inserted';
  if (rem && !ins && !app && !ren) return 'removed';
  return 'replaced';
}

const listChanged = (d: RosterDiff): boolean =>
  d.before !== d.after || d.appended.length > 0 || d.inserted.length > 0 || d.renamed.length > 0 || d.removed.length > 0;

/** A param of the diff from its row: display range and device unit of a float, the option count of an enum row (its
 *  labels, else its ordinal range). `movedFrom`: the catalog pid the param index moved the name from. */
function delta(id: number, row: RangeDef, labels: readonly string[] | undefined, name: { name: string; generic: boolean; movedFrom?: number }): ParamDelta {
  const kind: ParamDelta['kind'] = row.kind === 'enum' ? 'enum' : 'float';
  const d: ParamDelta = { id, name: name.name, kind, generic: name.generic };
  if (kind === 'float') {
    d.min = row.displayMin;
    d.max = row.displayMax;
    if (row.unit) d.unit = row.unit;
  } else {
    const b = enumOrdinalBounds(row);
    d.options = labels && labels.length > 0 ? labels.length : b.hi - b.lo + 1;
  }
  if (name.movedFrom !== undefined) d.movedFrom = name.movedFrom;
  return d;
}

/** The `UnknownBlockDiff.state` of a block-map entry's confidence (`confirmed`, `likely`; `candidate` and anything
 *  else — a `roster` entry included — `candidates`). */
export function blockMapState(confidence: string): UnknownBlockDiff['state'] {
  return confidence === 'confirmed' ? 'confirmed' : confidence === 'likely' ? 'likely' : 'candidates';
}

/**
 * Build the definitions diff. Families: every catalog family and every other family the profile has (synthetic
 * `section:<tag>` / `block:<eid>` keys are never families: they are reported under `sections` / `blocks`). A family is
 * listed when its status is not `unchanged` and it has something to show under the included parts; `suspect`,
 * `disagreement` and `catalog-only` families are always listed. `summary` covers the whole profile whatever the query
 * selects. Without an applied profile there is nothing to compare: no family is listed. An unknown `family` → the
 * `unknown-family` result.
 */
export function definitionsDiff(input: DefinitionsDiffInput, query: DefinitionsDiffQuery = {}): DefinitionsDiffResult {
  const base = input.staticProfile.staticBase ?? input.staticProfile;
  const applied = input.applied?.profile.profileFacts ? input.applied : null;
  const facts = applied?.profile.profileFacts;
  const doc = applied?.doc ?? null;
  const profile = applied?.profile ?? input.staticProfile;
  const docRanges = doc?.ranges ?? {};
  const has = (part: DefinitionsDiffPart) => !query.include || query.include.has(part);

  // the families a client may name: the catalog's and the profile's own (never a synthetic key)
  const known = new Set<string>([...Object.keys(base.ranges), ...Object.keys(base.params)]);
  for (const f of Object.keys(docRanges)) if (!isSyntheticFamilyKey(f)) known.add(f);
  for (const f of query.families ?? []) if (!known.has(f)) return { ok: false, error: 'unknown-family', family: f };

  const summary = doc ? profileSummaryOf(doc, input.model) : null;
  const catalog = profileCatalogFor(input.model);

  // suspects: families whose section looked mis-assigned at runtime (their rows were not merged), and families whose
  // winning source flagged them (provenance); disagreements: the coverage gap (conflicts above 10 % of the rows)
  const suspectSet = new Set<string>(facts?.suspectFamilies ?? []);
  const prov = isObj(doc) ? (doc as { provenance?: unknown }).provenance : undefined;
  if (isObj(prov) && isObj(prov.existence) && isObj(prov.suspects)) {
    for (const [fam, src] of Object.entries(prov.existence)) {
      const list = typeof src === 'string' ? prov.suspects[src] : undefined;
      if (!isSyntheticFamilyKey(fam) && Array.isArray(list) && list.includes(fam)) suspectSet.add(fam);
    }
  }
  const suspects = [...suspectSet].sort();
  const disagreements = [...new Set((summary?.coverage.gaps ?? []).filter((g) => g.kind === 'disagreement').flatMap((g) => g.families ?? []))]
    .filter((f) => !isSyntheticFamilyKey(f)).sort();
  const disagreeSet = new Set(disagreements);

  const classification = doc && facts ? classifyProfileRows(doc, input.staticProfile, suspects, facts.isByteExactFamily) : null;
  const classified = new Map<string, ClassifiedFamily>((classification?.families ?? []).map((f) => [f.family, f]));

  const defOf = (fam: string, pid: number): ParamDef | undefined => base.params[fam]?.find((d) => d.paramId === pid);

  /** The name the param index serves at `pid` (a listed param, or a hidden one through the name that sits there), the
   *  catalog's own name of `pid` when the index does not serve it elsewhere, else generic; `movedFrom` when the index
   *  moved the name to `pid` from another catalog pid. */
  const nameAt = (fam: string, index: BlockIndex, servedAt: ReadonlyMap<number, number>, pid: number): { name: string; generic: boolean; movedFrom?: number } => {
    const from = servedAt.get(pid);
    const moved = from !== undefined && from !== pid ? { movedFrom: from } : {};
    const e = index.byPid.get(pid);
    if (e) return { name: e.name, generic: e.generic, ...moved };
    const d = from !== undefined ? defOf(fam, from) : !index.namedAt.has(pid) ? defOf(fam, pid) : undefined;
    return d ? { name: paramLabel(d), generic: false, ...moved } : { name: `P${pid}`, generic: true };
  };

  const details = new Map<string, FamilyDetail>();
  if (applied && facts) {
    for (const fam of [...known].sort()) {
      const empty = (status: FamilyDetail['status'], removed: ParamDelta[] | null): FamilyDetail =>
        ({ status, params: { added: [], changed: [], removed, moved: [] }, enums: [] });
      // a suspect family's rows were not compared: nothing can be said about removals either
      if (suspectSet.has(fam)) { details.set(fam, empty('suspect', null)); continue; }
      if (docRanges[fam] === undefined) {
        if (Object.values(base.ranges[fam] ?? {}).some((r) => isInformativeRow(r))) details.set(fam, empty('catalog-only', null));
        continue;
      }
      const c = classified.get(fam);
      if (!c) continue;
      const index = buildParamIndex(profile, fam);
      const servedAt = new Map<number, number>();
      for (const [from, at] of index.namedAt) if (!servedAt.has(at)) servedAt.set(at, from);
      const rows = docRanges[fam] ?? {};
      const own = facts.enumLabels[fam] ?? {};
      const catRows = base.ranges[fam] ?? {};

      // params, from the same pass as compareRows: one entry per pid
      const added: ParamDelta[] = [];
      const changed: ParamDelta[] = [];
      const removed: ParamDelta[] | null = c.byteExact ? [] : null;
      for (const r of c.rows) {
        if (r.cls === 'exact') continue;
        if (r.cls === 'removed') {
          // a removed row whose catalog name the index serves at another pid (the name moved with its row) is no
          // longer that param: it is the slot the shift freed
          const d = defOf(fam, r.pid);
          const servedElsewhere = index.namedAt.has(r.pid) && index.namedAt.get(r.pid) !== r.pid;
          removed!.push(delta(r.pid, catRows[r.pid]!, base.enumLabelsFor(fam, r.pid), d && !servedElsewhere ? { name: paramLabel(d), generic: false } : { name: `P${r.pid}`, generic: true }));
          continue;
        }
        const row = rows[r.pid]!;
        const p = delta(r.pid, row, own[String(r.pid)], nameAt(fam, index, servedAt, r.pid));
        if (r.cls === 'new') { added.push(p); continue; }
        p.change = r.cls;
        p.fpBefore = paramFingerprint(catRows[r.pid]!, base.enumLabelsFor(fam, r.pid));
        p.fpAfter = paramFingerprint(row, own[String(r.pid)]);
        changed.push(p);
      }
      if (removed) {
        // a catalog name the index serves nowhere although its pid still holds a row, and whose catalog row no profile
        // row carries any more: the param vanished (its pid now holds another one). A name the index could not place
        // but whose row is still there (an ambiguous shift) did not vanish: its row is listed under its new pid.
        const listed = new Set(removed.map((p) => p.id));
        const carried = new Set<string>();
        for (const [k, e] of Object.entries(rows)) if (isInformativeRow(e)) carried.add(paramFingerprint(e, own[k]));
        const seen = new Set<number>();
        for (const d of base.params[fam] ?? []) {
          const pid = d.paramId;
          if (seen.has(pid)) continue; // the first definition of a pid names it
          seen.add(pid);
          const cr = catRows[pid];
          if (pid > MAX_WIRE_PID || !cr || !isInformativeRow(cr) || cr.synthetic || listed.has(pid) || index.namedAt.has(pid)) continue;
          if (carried.has(paramFingerprint(cr, base.enumLabelsFor(fam, pid)))) continue;
          removed.push(delta(pid, cr, base.enumLabelsFor(fam, pid), { name: paramLabel(d), generic: false }));
        }
        removed.sort((a, b) => a.id - b.id);
      }
      const moved = [...index.namedAt]
        .filter(([from, at]) => from !== at)
        .map(([from, at]) => ({ name: paramLabel(defOf(fam, from)!), from, to: at }))
        .sort((a, b) => a.from - b.from);

      // the model list: the roster selector's labels, catalog against the profile's own at the pid that carries the
      // selector's name now
      let roster: RosterDelta | undefined;
      const selector = rosterSelectorPid(input.model, fam);
      const rosterBefore = selector !== undefined ? base.enumLabelsFor(fam, selector) : undefined;
      if (selector !== undefined && rosterBefore && rosterBefore.length > 0) {
        const at = index.namedAt.get(selector);
        const after = at !== undefined ? own[String(at)] : undefined;
        if (at !== undefined && after && after.length > 0) {
          const d = rosterDiff(rosterBefore, after);
          if (listChanged(d)) roster = { selectorId: at, ...d };
        }
      }

      // other label lists: the catalog's list of a name against the profile's own at the pid that carries the name now
      const enums: FamilyDetail['enums'] = [];
      const catPids = [...new Set([...Object.keys(catRows).map(Number), ...(base.params[fam] ?? []).map((d) => d.paramId)])].sort(byNumber);
      for (const pid of catPids) {
        if (pid === selector) continue;
        const before = base.enumLabelsFor(fam, pid);
        const at = index.namedAt.get(pid);
        if (!before || before.length === 0 || at === undefined) continue;
        const after = own[String(at)];
        if (!after || after.length === 0) continue;
        const d = rosterDiff(before, after);
        if (!listChanged(d)) continue;
        enums.push({ id: at, name: nameAt(fam, index, servedAt, at).name, before: d.before, after: d.after, change: labelChange(d) });
      }
      enums.sort((a, b) => a.id - b.id);

      // the section stride the runtime uses (a live family's stride is a lower bound and never shrinks the catalog's)
      const sBefore = base.rangeSections[fam]?.stride;
      const sAfter = profile.rangeSections[fam]?.stride;
      const stride = typeof sBefore === 'number' && typeof sAfter === 'number' && sBefore !== sAfter ? { before: sBefore, after: sAfter } : undefined;

      const anything = added.length + changed.length + (removed?.length ?? 0) + moved.length + enums.length > 0 || !!roster || !!stride;
      details.set(fam, {
        status: disagreeSet.has(fam) ? 'disagreement' : anything ? 'changed' : 'unchanged',
        params: { added, changed, removed, moved }, enums,
        ...(roster ? { roster } : {}), ...(stride ? { stride } : {})
      });
    }
  }

  // ── sections no catalog family took, and blocks no catalog family places ──
  const v2 = (isObj(doc) ? doc : {}) as { sections?: unknown; blockMap?: unknown };
  const docSections: unknown[] = Array.isArray(v2.sections) ? v2.sections : [];
  const blockMap = (Array.isArray(v2.blockMap) ? (v2.blockMap as unknown[]) : [])
    .filter((e): e is { eid: number; key: string | null; sectionTag: number | null; confidence: string } =>
      isObj(e) && Number.isInteger(e.eid) && typeof e.confidence === 'string');
  const mappedTo = (tag: number) => blockMap.filter((e) => e.sectionTag === tag && e.confidence === 'confirmed').map((e) => e.eid).sort(byNumber);
  const sections: SectionDiff[] = [];
  const seenTags = new Set<number>();
  const newTags = new Set<number>();
  for (const s of docSections) {
    if (!isObj(s) || s.space !== 'section' || !Number.isInteger(s.tag)) continue;
    const tag = s.tag as number;
    if (s.role === 'new') newTags.add(tag);
    if (s.family !== null || seenTags.has(tag)) continue;
    seenTags.add(tag);
    const mappedEids = mappedTo(tag);
    if (s.role !== 'new' && s.role !== 'unclassified' && mappedEids.length === 0) continue; // a system table no block uses
    sections.push({ tag, key: String(s.key), role: s.role as SectionDiff['role'], stride: Number(s.stride), informative: Number(s.informative), mappedEids });
  }
  sections.sort((a, b) => a.tag - b.tag);

  const placed = new Set(input.placedEids ?? []);
  const blocksByEid = new Map<number, UnknownBlockDiff>();
  for (const e of blockMap) {
    if (blocksByEid.has(e.eid)) continue;
    const state = blockMapState(e.confidence);
    const key = typeof e.key === 'string' ? e.key : null;
    const params = state === 'confirmed' && key !== null && profile.ranges[key] !== undefined ? buildParamIndex(profile, key).entries.length : 0;
    blocksByEid.set(e.eid, { eid: e.eid, placed: placed.has(e.eid), state, key, sectionTag: Number.isInteger(e.sectionTag) ? e.sectionTag : null, params });
  }
  for (const eid of input.unmappedEids ?? []) {
    if (!blocksByEid.has(eid)) blocksByEid.set(eid, { eid, placed: true, state: 'none', key: null, sectionTag: null, params: 0 });
  }
  const blocks = [...blocksByEid.values()].sort((a, b) => a.eid - b.eid);

  // ── summary (whole profile) and the selected families ──
  const all = [...details.values()];
  const cmp = classification?.comparison;
  const out: DefinitionsDiffDTO = {
    model: input.model,
    firmware: input.firmware,
    catalogFirmware: input.staticProfile.catalogFirmware,
    state: input.state,
    profile: applied && facts && summary
      ? { key: applied.key, source: facts.source, byteExact: facts.byteExact, format: summary.format, sources: summary.sources.map((s) => ({ ...s })) }
      : null,
    summary: {
      newParams: cmp?.newRows ?? 0,
      changed: { compatible: cmp?.compatible ?? 0, incompatible: cmp?.incompatible ?? 0 },
      removed: cmp ? cmp.removed : input.state === 'none' ? 0 : null,
      movedNames: all.reduce((n, d) => n + d.params.moved.length, 0),
      rosterChanges: all.filter((d) => d.roster).length,
      enumChanges: all.reduce((n, d) => n + d.enums.length, 0),
      strideChanges: all.filter((d) => d.stride).length,
      newSections: newTags.size,
      unknownBlocks: blocks.length,
      suspects,
      disagreements
    },
    families: []
  };

  const wanted = query.families ? new Set(query.families) : null;
  for (const [family, d] of details) {
    if (d.status === 'unchanged' || (wanted && !wanted.has(family))) continue;
    const p = d.params;
    const shows = d.status !== 'changed'
      || (has('params') && p.added.length + p.changed.length + (p.removed?.length ?? 0) + p.moved.length > 0)
      || (has('rosters') && !!d.roster) || (has('enums') && d.enums.length > 0) || (has('strides') && !!d.stride);
    if (!shows) continue;
    const f: FamilyDiff = { family, eid: catalog.familyFirstEid?.[family] ?? null, status: d.status };
    if (has('params')) f.params = d.params;
    if (has('rosters') && d.roster) f.roster = d.roster;
    if (has('enums')) f.enums = d.enums;
    if (has('strides') && d.stride) f.stride = d.stride;
    out.families.push(f);
  }
  if (has('sections')) out.sections = sections;
  if (has('blocks')) out.blocks = blocks;
  if (has('instances')) out.instances = (summary?.coverage.instances ?? []).map((i) => ({ ...i }));
  return { ok: true, diff: out };
}
