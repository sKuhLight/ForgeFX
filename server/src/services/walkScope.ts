// Walk scope gates: which read-only extensions of the definition walk are verified per (model, firmware). Each flag is
// true only for an exact (model, major.minor) listed in `WALK_SCOPE_VERIFIED_FW` — unknown or unlisted firmware is
// false (fail closed, like `ENUM_HINTS_VERIFIED_FW` in services/deviceCache.ts, which re-exports everything here):
//   - extendedIds: param ids above 127 of known contiguous tables;
//   - above160:    the roster blocks above effect id 160;
//   - blockProbe:  the single-block probe of a placed block the catalog does not know
//                  (`POST /device/definitions/blocks/:eid/probe`, services/blockProbe.ts);
//   - farIds:      explicit far ids of non-contiguous tables (implemented, never enabled).
// The table is empty in this build: a (model, firmware) is added only after its hardware acceptance.
//
// A development override (`FORGEFX_WALK_SCOPE_OVERRIDE=extended,above160,probe`) opens flags for an acceptance run.
// It is read from the Node environment by the Node registry only (drivers/registry.ts → `RegistryDeps.walkScopeOverride`),
// never in Browser Direct (its registry has no such hook). Like every development hook it needs the explicit opt-in
// `FORGEFX_DEV_HOOKS=1` and is ignored when NODE_ENV=production (devHooks.ts `devHookValue`); it is announced with
// one warning line. It never opens `farIds`, and it opens nothing while the running firmware is unknown.
//
// Pure and browser-safe: its only import is the import-free leaf devHooks.ts (the registry core, the probe service and
// the gen-3 driver all use this module, so it must not import any of them).
import { devHookValue } from '../devHooks.js';

export type WalkScopeFlag = 'extendedIds' | 'above160' | 'blockProbe' | 'farIds';
export type FwList = ReadonlyArray<Readonly<{ major: number; minor: number }>>;

/** Verified (model, firmware) pairs per walk-scope flag. Empty until a unit passes its hardware acceptance. */
export const WALK_SCOPE_VERIFIED_FW: Readonly<Record<number, Readonly<Record<WalkScopeFlag, FwList>>>> = {};

/** The walk-scope flags for one running firmware. */
export interface WalkScopeGates { extendedIds: boolean; above160: boolean; blockProbe: boolean; farIds: boolean }

/** Tokens of the development override. */
export type WalkScopeOverrideToken = 'extended' | 'above160' | 'probe';
export type WalkScopeOverride = ReadonlySet<WalkScopeOverrideToken>;

/** Name of the development override's environment variable. */
export const WALK_SCOPE_OVERRIDE_ENV = 'FORGEFX_WALK_SCOPE_OVERRIDE';

const TOKENS: ReadonlySet<string> = new Set<WalkScopeOverrideToken>(['extended', 'above160', 'probe']);
const NONE: WalkScopeOverride = new Set();

/** Parse an override value: comma-separated tokens (`extended`, `above160`, `probe`), whitespace ignored; anything else
 *  is malformed (listed, ignored). */
export function parseWalkScopeOverride(raw: string): { flags: Set<WalkScopeOverrideToken>; malformed: string[] } {
  const flags = new Set<WalkScopeOverrideToken>();
  const malformed: string[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (t === '') continue;
    if (TOKENS.has(t)) flags.add(t as WalkScopeOverrideToken);
    else malformed.push(t);
  }
  return { flags, malformed };
}

/** The last active value seen (re-parsed and re-announced only when it changes). */
let announced: { raw: string; flags: WalkScopeOverride } | undefined;

/** The override from a Node environment (`process.env` of the Node registry): empty when unset, and ignored (empty)
 *  without the explicit opt-in `FORGEFX_DEV_HOOKS=1` or when `NODE_ENV=production` (devHooks.ts, which announces
 *  that with one warning line). One warning line per distinct active value: what it opens. */
export function walkScopeOverrideFromEnv(env: Readonly<Record<string, string | undefined>>): WalkScopeOverride {
  const raw = devHookValue(env, WALK_SCOPE_OVERRIDE_ENV);
  if (raw === undefined) return NONE;
  if (announced?.raw === raw) return announced.flags;
  const parsed = parseWalkScopeOverride(raw);
  const flags: WalkScopeOverride = parsed.flags;
  const bad = parsed.malformed.length > 0 ? ` (ignored: ${parsed.malformed.map((m) => JSON.stringify(m)).join(', ')})` : '';
  console.warn(`[forgefx] ${WALK_SCOPE_OVERRIDE_ENV}: development override opens ${flags.size > 0 ? [...flags].join(', ') : 'nothing'} for the running firmware${bad}`);
  announced = { raw, flags };
  return flags;
}

const listed = (list: FwList | undefined, fw: { major: number; minor: number }): boolean =>
  (list ?? []).some((v) => v.major === fw.major && v.minor === fw.minor);

/** The walk-scope flags of `model` on the running firmware `fw`: an exact match in `WALK_SCOPE_VERIFIED_FW`, or (not
 *  `farIds`) a token of the development override. Unknown or malformed firmware: every flag false. */
export function walkScopeGates(
  model: number,
  fw: { major: number; minor: number } | null | undefined,
  override: WalkScopeOverride = NONE
): WalkScopeGates {
  if (fw == null || !Number.isInteger(fw.major) || !Number.isInteger(fw.minor) || fw.major < 1 || fw.minor < 0) {
    return { extendedIds: false, above160: false, blockProbe: false, farIds: false };
  }
  const v = WALK_SCOPE_VERIFIED_FW[model];
  return {
    extendedIds: listed(v?.extendedIds, fw) || override.has('extended'),
    above160: listed(v?.above160, fw) || override.has('above160'),
    blockProbe: listed(v?.blockProbe, fw) || override.has('probe'),
    farIds: listed(v?.farIds, fw)
  };
}
