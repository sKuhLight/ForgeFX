// Walk-kind reclassification guard — a profile that is NOT byte-exact (a live walk, a cloud profile
// that was published from one, unknown provenance) must never change the kind of a pid the static
// catalog already classifies, in either direction. Byte-exact profiles (an editor-cache import, or a
// cloud profile published from one) are the device's own data, possibly for a newer firmware than the
// catalog, and always override. Provenance is the REAL persisted `meta` (see isByteExactProfile):
// 'live' | 'editor-cache' | 'cloud' + `origin`.
//
// The live walk's enum/float split is a numeric heuristic (integral bounds + step/scale shape gated
// on a label-list probe) and is not reliable either way:
//   • FM3 fw13.0 DISTORT_INPUTSELECT (paramId 21) walks as 'float' over the catalog's 'enum' row →
//     reached Axis as a bare number instead of the LEFT/RIGHT/SUM L+R dropdown.
//   • FM3 CABINET_LOCUT1/2 (paramId 62/63) walk as 'enum' over the catalog's 'float' row → rendered
//     as dropdowns.
// So for such a profile the catalog's kind stands (the dropped row still contributes its device-true
// unit); its rows still win for brand-new pids and still refine a same-kind float's display range.
// A byte-exact profile is the other way round: its rows win even when they change a kind.
import { runtimeProfileFrom, isByteExactProfile } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { assertEqual } from '../helpers/mock.js';

export const WALK_RECLASSIFICATION_CASE_COUNT = 18;

const DISTORT = 'DISTORT';
const CABINET = 'CABINET';
const INPUTSELECT_PID = 21; // catalog enum, live walk says float
const LOCUT_PID = 62; // catalog float, live walk says enum (and carries a unit)
const TRIODE_PID = 114; // catalog float, walk float with a refined range
const NEW_PID = 999; // not in the catalog

function synthProfile(): DeviceProfile {
  return {
    model: 0x11, key: 'fm3', name: 'FM3-walk-reclassification-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: {},
    ranges: {
      [DISTORT]: {
        [INPUTSELECT_PID]: { kind: 'enum', displayMin: 0, displayMax: 2, typecode: 0x10 },
        [TRIODE_PID]: { kind: 'float', displayMin: -200, displayMax: 200, typecode: 0x531 },
      },
      [CABINET]: {
        [LOCUT_PID]: { kind: 'float', displayMin: 10, displayMax: 500, typecode: 0x40, unit: 'Hz' },
      },
    },
    rangeSections: {},
    rosterFor: () => [],
    enumLabelsFor: () => undefined,
    cabIrs: () => ({}),
    familyForEffectId: () => undefined,
    layoutFor: () => undefined,
  } as unknown as DeviceProfile;
}

/** A cache whose rows disagree with the catalog on both selector kinds (INPUTSELECT, LOCUT). */
function builtWith(meta: Record<string, unknown> | undefined, locutUnit?: string): never {
  return {
    enumOverrides: {}, rosters: {}, cabIrs: {}, rangeSections: {},
    ...(meta ? { meta } : {}),
    ranges: {
      [DISTORT]: {
        [INPUTSELECT_PID]: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10 },
        [TRIODE_PID]: { kind: 'float', displayMin: -300, displayMax: 300, scale: 1, step: 0, typecode: 0x531 },
        [NEW_PID]: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x20 },
      },
      [CABINET]: {
        [LOCUT_PID]: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x40, ...(locutUnit ? { unit: locutUnit } : {}) },
      },
    },
  } as never;
}

/** Does the overlay keep the catalog's kind (true) or take the cache's row (false) for this provenance? */
function catalogKindStands(meta: Record<string, unknown> | undefined): boolean {
  const merged = runtimeProfileFrom(builtWith(meta), synthProfile());
  const locut = merged.ranges[CABINET]![LOCUT_PID]?.kind === 'float';
  const inputselect = merged.ranges[DISTORT]![INPUTSELECT_PID]?.kind === 'enum';
  assertEqual(locut, inputselect, 'both selector kinds are treated alike for one provenance');
  return locut;
}

export function runWalkReclassificationTests(): void {
  // ---- live walk: the catalog's kind stands ----------------------------------------------
  const live = runtimeProfileFrom(builtWith({ source: 'live', recordCount: 3 }, 'Hz'), synthProfile());
  assertEqual(live.ranges[CABINET]![LOCUT_PID]?.kind, 'float', 'live walk enum must not reclassify a catalog float (LOCUT regression)');
  assertEqual(live.ranges[DISTORT]![INPUTSELECT_PID]?.kind, 'enum', 'live walk float must not reclassify a catalog enum (INPUTSELECT regression)');
  assertEqual(live.ranges[DISTORT]![NEW_PID]?.kind, 'enum', 'live walk still proves a brand-new enum the catalog lacks');
  assertEqual(live.ranges[DISTORT]![TRIODE_PID]?.displayMax, 300, 'live walk still refines a same-kind float display range');

  // The dropped row keeps the catalog's range but donates its device-true unit.
  const liveUnit = runtimeProfileFrom(builtWith({ source: 'live', recordCount: 3 }, 'kHz'), synthProfile());
  assertEqual(liveUnit.ranges[CABINET]![LOCUT_PID]?.unit, 'kHz', 'the dropped live row still contributes its device-true unit');
  assertEqual(liveUnit.ranges[CABINET]![LOCUT_PID]?.displayMax, 500, 'the catalog range of a dropped live row is untouched');

  // ---- byte-exact profiles: the device's own rows always win -----------------------------
  const imported = runtimeProfileFrom(builtWith({ source: 'editor-cache', recordCount: 3 }), synthProfile());
  assertEqual(imported.ranges[CABINET]![LOCUT_PID]?.kind, 'enum', 'an editor-cache import may change a catalog kind');
  assertEqual(imported.ranges[DISTORT]![INPUTSELECT_PID]?.kind, 'float', 'an editor-cache import may change a catalog kind, both directions');
  assertEqual(catalogKindStands({ source: 'cloud', origin: 'bytes' }), false, 'a cloud profile published from an editor cache is byte-exact and overrides');

  // ---- everything else is treated like a live walk ----------------------------------------
  // A pulled cloud profile keeps meta.source 'cloud' and the build kind it came from in `origin`:
  // one that came from a live walk (or whose origin is missing/unknown) must stay protected.
  assertEqual(catalogKindStands({ source: 'cloud', origin: 'live' }), true, 'a cloud profile published from a live walk keeps the catalog kind');
  assertEqual(catalogKindStands({ source: 'cloud' }), true, 'a cloud profile without an origin keeps the catalog kind');
  assertEqual(catalogKindStands({ source: 'cloud', origin: 'something-new' }), true, 'a cloud profile with an unknown origin keeps the catalog kind');
  assertEqual(catalogKindStands({ recordCount: 3 }), true, 'a profile without a source (GET /device/cache calls it live) keeps the catalog kind');
  assertEqual(catalogKindStands(undefined), true, 'a profile without meta keeps the catalog kind');
  assertEqual(catalogKindStands({ source: 'from-the-future' }), true, 'an unknown source keeps the catalog kind');

  // ---- the helper itself ---------------------------------------------------------------------
  assertEqual(isByteExactProfile({ source: 'bytes' }), true, "the codec's raw byte-source value is byte-exact");
  assertEqual(isByteExactProfile({ source: 'editor-cache', origin: 'live' }), true, 'origin only matters for a cloud profile');
  assertEqual(isByteExactProfile({ source: 'live', origin: 'bytes' }), false, 'origin only matters for a cloud profile (live stays live)');
}
