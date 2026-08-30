// Walk-kind reclassification guard — the device-cache overlay must never change the kind of a pid
// the static catalog already classifies, in either direction.
//
// The live walk's enum/float split is a numeric heuristic (integral bounds + step/scale shape gated
// on a label-list probe) and is not reliable either way:
//   • FM3 fw13.0 DISTORT_INPUTSELECT (paramId 21) walks as 'float' over the catalog's 'enum' row →
//     reached Axis as a bare number instead of the LEFT/RIGHT/SUM L+R dropdown.
//   • FM3 CABINET_LOCUT1/2 (paramId 62/63) walk as 'enum' over the catalog's 'float' row → rendered
//     as dropdowns.
// The static catalog's 'kind' is mined offline from the editor's own cache, so when the walk
// disagrees on a pid the catalog already classifies, trust the catalog. The walk still wins for
// brand-new pids and still refines a same-kind float's display range.
import { runtimeProfileFrom } from '../../src/devices.js';
import type { DeviceProfile } from '../../src/devices.js';
import { assertEqual } from '../helpers/mock.js';

export const WALK_RECLASSIFICATION_CASE_COUNT = 4;

const FAMILY = 'DISTORT';
const TYPE_PID = 6; // DISTORT_TYPE
const VPLATEMON_PID = 132;
const TRIODE1RATIO_PID = 114;

function synthProfile(): DeviceProfile {
  return {
    model: 0x11, key: 'fm3', name: 'FM3-walk-reclassification-test', rows: 4, cols: 12,
    defaultInstances: 1, instanceLimits: {},
    params: {},
    ranges: {
      [FAMILY]: {
        [TYPE_PID]: { kind: 'enum', displayMin: 0, displayMax: 329, typecode: 0x10 },
        [VPLATEMON_PID]: { kind: 'float', displayMin: 0, displayMax: 1, typecode: 0x00 },
        [TRIODE1RATIO_PID]: { kind: 'float', displayMin: -200, displayMax: 200, typecode: 0x531 },
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

export function runWalkReclassificationTests(): void {
  const staticProfile = synthProfile();
  const merged = runtimeProfileFrom(
    {
      enumOverrides: {}, rosters: {}, cabIrs: {},
      ranges: {
        [FAMILY]: {
          [VPLATEMON_PID]: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x00, unit: 'Hz' },
          [TYPE_PID]: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10 },
          [TRIODE1RATIO_PID]: { kind: 'float', displayMin: -300, displayMax: 300, scale: 1, step: 0, typecode: 0x531 },
          999: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x20 },
        },
      },
    } as never,
    staticProfile,
  );
  assertEqual(merged.ranges[FAMILY]![VPLATEMON_PID]?.kind, 'float', 'walk enum must not reclassify a catalog float (LOCUT regression)');
  assertEqual(merged.ranges[FAMILY]![TYPE_PID]?.kind, 'enum', 'walk float must not reclassify a catalog enum (INPUTSELECT regression)');
  assertEqual(merged.ranges[FAMILY]![999]?.kind, 'enum', 'walk still proves a brand-new enum the catalog lacks');
  assertEqual(merged.ranges[FAMILY]![TRIODE1RATIO_PID]?.displayMax, 300, 'walk still refines a same-kind float display range');
}
