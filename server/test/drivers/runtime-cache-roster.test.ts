// runtimeProfileFrom roster hardening (FORGEFX bug: FM3 DISTORT showed the wrong amp model).
// Root cause was two-fold: (1) the forgefx-midi live-walk enum-label sweep could silently
// truncate a family's roster by a dropped/timed-out reply near the tail (fixed there with a
// bounded retry — see forgefx-midi test/cache/livewalk.test.ts), and (2) runtimeProfileFrom
// trusted whatever length a cache roster happened to produce, so a short cache roster shifted
// gen3.ts's `raw/65534*(roster.length-1)` rescale and decoded the WRONG model near the top of
// the range. This covers (2) directly: a cache roster shorter than the known-good static one
// must fall back to the static roster, not be trusted at its short length.
import { PROFILES, runtimeProfileFrom } from '../../src/devices.js';
import type { BuiltCache } from 'forgefx-midi/cache';
import { assert, assertEqual } from '../helpers/mock.js';

export const RUNTIME_CACHE_ROSTER_CASE_COUNT = 4;

const fm3Static = PROFILES[0x11]!;

function builtCacheWithDistortRoster(names: string[]): BuiltCache {
  return {
    enumOverrides: {},
    ranges: {},
    rangeSections: {},
    rosters: { DISTORT: names.map((name, value) => ({ value, name, manufacturer: null, basedOn: null })) },
    cabIrs: {},
    unmappedSections: [],
    unmappedFamilies: [],
    meta: { recordCount: 0, source: 'live' }
  };
}

export function runRuntimeCacheRosterTests(): void {
  const staticAmp = fm3Static.rosterFor('amp');
  assert(staticAmp.length > 1, 'fixture assumption: FM3 static amp roster has more than one entry');

  // Case 1: a cache roster ONE ENTRY SHORT of the static roster (the exact FM3 DISTORT bug —
  // 330/331, missing the top entry "Deluxe 6G3") falls back to the static roster WHOLE, not the
  // short one — this is what protects gen3.ts's roster.length-1 rescale from an off-by-one shift.
  {
    const shortNames = staticAmp.slice(0, -1).map((t) => t.name);
    const runtime = runtimeProfileFrom(builtCacheWithDistortRoster(shortNames), fm3Static);
    const got = runtime.rosterFor('amp');
    assertEqual(got.length, staticAmp.length, 'short cache roster: length must fall back to the static count');
    assertEqual(got[got.length - 1]!.name, staticAmp[staticAmp.length - 1]!.name, 'short cache roster: must recover the missing top entry');
  }

  // Case 2: a cache roster that MATCHES the static length is still trusted as device-true
  // (current firmware content wins even when it happens to equal the static count).
  {
    const sameLenNames = staticAmp.map((t) => t.name);
    const runtime = runtimeProfileFrom(builtCacheWithDistortRoster(sameLenNames), fm3Static);
    const got = runtime.rosterFor('amp');
    assertEqual(got.length, staticAmp.length, 'equal-length cache roster: length must match');
    assertEqual(got[0]!.name, sameLenNames[0], 'equal-length cache roster: cache names must win');
  }

  // Case 3: a cache roster LONGER than the static one (e.g. a firmware update added a model) is
  // trusted at its own (longer) length — the guard only distrusts SHORT caches, never long ones.
  {
    const longerNames = [...staticAmp.map((t) => t.name), 'New Amp Model'];
    const runtime = runtimeProfileFrom(builtCacheWithDistortRoster(longerNames), fm3Static);
    const got = runtime.rosterFor('amp');
    assertEqual(got.length, longerNames.length, 'longer cache roster: length must match the cache, not the static count');
    assertEqual(got[got.length - 1]!.name, 'New Amp Model', 'longer cache roster: the new tail entry must survive');
  }

  // Case 4: a family with NO static roster at all (empty) still uses whatever the cache has,
  // however short — there is nothing known-good to validate a length against.
  {
    const built: BuiltCache = {
      enumOverrides: {}, ranges: {}, rangeSections: {},
      rosters: { RESONATOR: [{ value: 0, name: 'Only Model', manufacturer: null, basedOn: null }] },
      cabIrs: {}, unmappedSections: [], unmappedFamilies: [],
      meta: { recordCount: 0, source: 'live' }
    };
    const staticResonator = fm3Static.rosterFor('resonator');
    assertEqual(staticResonator.length, 0, 'fixture assumption: FM3 static resonator roster is empty');
    const runtime = runtimeProfileFrom(built, fm3Static);
    const got = runtime.rosterFor('resonator');
    assertEqual(got.length, 1, 'family with no static roster: the lone cache entry must still be used');
  }
}
