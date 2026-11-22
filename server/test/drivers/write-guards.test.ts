// The gen-3 param-write guards (PUT /preset/blocks/:eid/params/:paramId → gen3 setParam): a write the connected
// device cannot take as a param write is refused with a status code BEFORE anything is sent. An id above 0x3FFF
// (the editor's pseudo ids, e.g. the cab's mute/solo buttons) is no wire parameter: 400. A family row that is an
// unused slot (all-zero placeholder) on the connected firmware, with no catalog param defined there: 409. That is
// the effective row, and for a byte-exact profile also its own row (not for a suspect family); a live profile's
// placeholder rows are no information. Catalog params with a placeholder row (MOD_MIN/MAX/PARAM, *_GLOBALMIX), ids
// without any row (the FC block, cross-block writes) and params the generic response marks `write: null` stay
// writable. FM3, FM9 and Axe-Fx III. Both surfaces (Fastify app and the runtime router) answer the same status
// and body.
//
// Mocked, NO hardware: committed catalog data and synthetic profiles only.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { PROFILES, SLUG_FAMILY, runtimeProfileFrom, type DeviceProfile } from '../../src/devices.js';
import { buildParamIndex } from '../../src/drivers/paramIndex.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { isPlaceholderRow } from 'forgefx-midi/cache';
import { assert, assertEqual, type MockTransport } from '../helpers/mock.js';
import { buildTestApp } from '../helpers/api.js';
import { catalogBuilt, type StoredProfileSource } from '../helpers/catalogProfile.js';
import { mockBlockDevice, eidOfSlug } from '../helpers/blockRead.js';

export const WRITE_GUARDS_CASE_COUNT = 12;

const FM3 = PROFILES[0x11]!;
const CAB = eidOfSlug('cab');
const DELAY = eidOfSlug('delay');
const CHORUS = eidOfSlug('chorus');
const MOD_EID = 3;
const FC_EID = 199;

/** Param-write frames (fn 0x01, continuous sub 0x52 or discrete sub 0x09) among what went out. */
const paramWrites = (mock: MockTransport) => mock.sent.filter((f) => f[5] === 0x01 && (f[6] === 0x52 || f[6] === 0x09));

interface Refusal { statusCode?: number; message: string }
async function refusal(p: Promise<unknown>): Promise<Refusal | null> {
  try { await p; return null; } catch (e) { return { statusCode: (e as { statusCode?: number }).statusCode, message: (e as Error).message }; }
}

/** A driver over a silent mocked link (writes are accepted by silence). */
const rig = (profile: DeviceProfile = FM3) => mockBlockDevice(profile, {});

const FM9 = PROFILES[0x12]!;
const AXE3 = PROFILES[0x10]!;
const PLACEHOLDER = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
const eidOfFamily = (family: string) => eidOfSlug(Object.keys(SLUG_FAMILY).find((s) => SLUG_FAMILY[s] === family)!);

/** The catalog of `model` as a device profile (`source` provenance) whose `family` has an unused slot at `pid`
 *  (all-zero placeholder row), as a newer firmware might carry. `before` may rearrange the tables first. */
function placeholderProfile(
  model: number, family: string, pid: number, source: StoredProfileSource,
  before: (b: ReturnType<typeof catalogBuilt>) => void = () => {}
): DeviceProfile {
  const b = catalogBuilt(model, source);
  before(b);
  (b.ranges[family] as Record<number, unknown>)[pid] = PLACEHOLDER;
  return runtimeProfileFrom(b, PROFILES[model]!);
}

export async function runWriteGuardsTests(): Promise<void> {
  // ---- 1. an id above 0x3FFF is no wire parameter: 400, nothing sent ----------------------------------------
  {
    const btn = FM3.params['CABINET']!.find((p) => p.name === 'CABINET_BTN_MUTE1')!;
    assertEqual(btn.paramId, 65286, 'premise: the cab mute button is an editor pseudo id');
    for (const continuous of [true, false]) {
      const { driver, mock } = rig();
      const r = await refusal(driver.setParam(CAB, 65286, 1, continuous));
      assertEqual(r?.statusCode, 400, `pid 65286 (${continuous ? 'continuous' : 'discrete'}) → 400`);
      assertEqual(r?.message, 'param id 65286 is not a wire parameter', '400 message');
      assertEqual(mock.sent.length, 0, 'nothing went out');
    }
    for (const bad of [-1, 1.5, Number.NaN, 0x4000]) {
      const { driver, mock } = rig();
      assertEqual((await refusal(driver.setParam(DELAY, bad, 0.5, true)))?.statusCode, 400, `pid ${bad} → 400`);
      assertEqual(mock.sent.length, 0, `pid ${bad}: nothing went out`);
    }
    console.log('  drivers/write-guards: an id that is no wire parameter (65286, 0x4000, -1, 1.5, NaN) → 400, nothing sent');
  }

  // ---- 2. an unused slot without a catalog param: 409, nothing sent (bundled catalog) -----------------------
  {
    const row = FM3.ranges['CABINET']![87];
    assert(!!row && isPlaceholderRow(row), 'premise: CABINET pid 87 is a placeholder row on the FM3 catalog');
    assert(!FM3.params['CABINET']!.some((p) => p.paramId === 87), 'premise: and no param is defined there');
    for (const continuous of [true, false]) {
      const { driver, mock } = rig();
      const r = await refusal(driver.setParam(CAB, 87, 0.5, continuous));
      assertEqual(r?.statusCode, 409, `CABINET 87 (${continuous ? 'continuous' : 'discrete'}) → 409`);
      assertEqual(r?.message, 'param 87 of CABINET is an unused slot on this firmware; write refused', '409 message');
      assertEqual(mock.sent.length, 0, 'nothing went out');
    }
    console.log('  drivers/write-guards: a catalog placeholder without a param (CABINET 87) → 409, nothing sent');
  }

  // ---- 3. an unused slot a byte-exact profile reports: 409; the same slot in a live profile is no information --
  {
    assertEqual(FM3.ranges['DELAY']![88], undefined, 'premise: the bundled FM3 catalog has no DELAY row at 88');
    const exact = placeholderProfile(0x11, 'DELAY', 88, 'editor-cache');
    assert(!buildParamIndex(exact, 'DELAY').byPid.has(88), 'byte-exact: the slot is not listed');
    const x = rig(exact);
    const r = await refusal(x.driver.setParam(DELAY, 88, 0.5, true));
    assertEqual(r?.statusCode, 409, 'byte-exact profile: DELAY 88 → 409');
    assertEqual(r?.message, 'param 88 of DELAY is an unused slot on this firmware; write refused', '409 message');
    assertEqual(x.mock.sent.length, 0, 'byte-exact: nothing went out');
    // a live walk's placeholder rows are not merged (no information): the effective row decides, and there is none
    const live = rig(placeholderProfile(0x11, 'DELAY', 88, 'live'));
    assertEqual((await live.driver.setParam(DELAY, 88, 0.5, true)).ok, true, 'live profile: DELAY 88 → written');
    assertEqual(paramWrites(live.mock).length, 1, 'live: one frame');
    // …while a live profile still refuses an effective placeholder row (the catalog's CABINET 87 stays effective)
    const liveCab = rig(runtimeProfileFrom(catalogBuilt(0x11, 'live'), FM3));
    assertEqual((await refusal(liveCab.driver.setParam(CAB, 87, 0.5, true)))?.statusCode, 409, 'live profile: an effective placeholder row → 409');
    assertEqual(liveCab.mock.sent.length, 0, 'live: nothing went out for it');
    // without a profile DELAY 88 has no row at all: a plain write
    const { driver, mock } = rig();
    assertEqual((await driver.setParam(DELAY, 88, 0.5, true)).ok, true, 'static catalog: DELAY 88 has no row → written');
    assertEqual(paramWrites(mock).length, 1, 'one frame');
    console.log('  drivers/write-guards: a byte-exact placeholder slot (DELAY 88) → 409; a live one is no information, an effective one still 409');
  }

  // ---- 4. catalog params with a placeholder row stay writable (MOD_MIN/MAX/PARAM, CHORUS_GLOBALMIX) ---------
  {
    for (const name of ['MOD_MIN', 'MOD_MAX', 'MOD_PARAM']) {
      const def = FM3.params['MOD']!.find((p) => p.name === name)!;
      assert(isPlaceholderRow(FM3.ranges['MOD']![def.paramId]!), `premise: ${name} has a placeholder row`);
      const { driver, mock } = rig();
      assertEqual((await driver.setParam(MOD_EID, def.paramId, 0.25, true)).ok, true, `${name} → written`);
      assertEqual(paramWrites(mock).length, 1, `${name}: one frame`);
    }
    const gm = FM3.params['CHORUS']!.find((p) => p.name === 'CHORUS_GLOBALMIX')!;
    assertEqual(FM3.ranges['CHORUS']![gm.paramId]!.displayMax, 0, 'premise: CHORUS_GLOBALMIX has an empty range row');
    for (const continuous of [true, false]) {
      const { driver, mock } = rig();
      assertEqual((await driver.setParam(CHORUS, gm.paramId, 1, continuous)).ok, true, `CHORUS_GLOBALMIX (${continuous ? 'continuous' : 'discrete'}) → written`);
      assertEqual(paramWrites(mock).length, 1, 'one frame');
    }
    console.log('  drivers/write-guards: MOD_MIN / MOD_MAX / MOD_PARAM and CHORUS_GLOBALMIX stay writable');
  }

  // ---- 5. ids without any row stay writable (FC block, cross-block ids) ---------------------------------------
  {
    assertEqual(SLUG_FAMILY['fc'] ?? FM3.familyForEffectId(FC_EID), 'FC', 'premise: eid 199 is the FC block');
    assertEqual(Object.keys(FM3.ranges['FC'] ?? {}).length, 0, 'premise: the FC block has no range rows');
    const { driver, mock } = rig();
    assertEqual((await driver.setParam(FC_EID, 5, 3, false)).ok, true, 'FC 199 pid 5 → written');
    assertEqual((await driver.setParam(DELAY, 200, 0.5, true)).ok, true, 'a DELAY id without a row → written');
    assertEqual(paramWrites(mock).length, 2, 'two frames');
    console.log('  drivers/write-guards: FC writes and ids without a row are not guarded');
  }

  // ---- 6. a param the generic response marks write:null is not refused (the mark is advice) ----------------
  {
    let found: { profile: DeviceProfile; family: string; pid: number } | undefined;
    for (const profile of [FM3, PROFILES[0x12]!, PROFILES[0x10]!]) {
      for (const family of Object.keys(profile.ranges)) {
        const e = buildParamIndex(profile, family).entries.find((x) => x.write === null);
        if (e) { found = { profile, family, pid: e.pid }; break; }
      }
      if (found) break;
    }
    assert(!!found, 'premise: some catalog param is served with write:null');
    const slug = Object.keys(SLUG_FAMILY).find((s) => SLUG_FAMILY[s] === found!.family);
    const eid = slug ? eidOfSlug(slug) : [1, 2, 3, 190, 199].find((x) => found!.profile.familyForEffectId(x) === found!.family)!;
    const { driver, mock } = rig(found.profile);
    assertEqual((await driver.setParam(eid, found.pid, 1, false)).ok, true, `${found.family} ${found.pid} (write:null) → written`);
    assertEqual(paramWrites(mock).length, 1, 'one frame');
    console.log(`  drivers/write-guards: a write:null param (${found.family} ${found.pid}) is still written`);
  }

  // ---- 7. FM9: a listed generic param stays writable under a live profile; byte-exact removes and refuses it --
  {
    const MIXER = eidOfFamily('MIXER');
    const pid = 17;
    assert(FM9.ranges['MIXER']![pid]!.displayMax > FM9.ranges['MIXER']![pid]!.displayMin, 'premise: FM9 MIXER 17 is an informative catalog row');
    assert(!FM9.params['MIXER']!.some((p) => p.paramId === pid), 'premise: with no param defined there (a generic param)');
    const live = placeholderProfile(0x12, 'MIXER', pid, 'live');
    const listed = buildParamIndex(live, 'MIXER').byPid.get(pid);
    assertEqual(`${listed?.name}/${listed?.write}`, 'P17/norm', 'live: the generic response lists P17 as writable');
    const l = rig(live);
    assertEqual((await l.driver.setParam(MIXER, pid, 0.5, true)).ok, true, 'live: and the write goes through (no 409 for a listed param)');
    assertEqual(paramWrites(l.mock).length, 1, 'live: one frame');
    const exact = placeholderProfile(0x12, 'MIXER', pid, 'editor-cache');
    assert(buildParamIndex(exact, 'MIXER').hidden.some((h) => h.id === pid && h.reason === 'removed'), 'byte-exact: the slot is reported removed, not listed');
    const x = rig(exact);
    assertEqual((await refusal(x.driver.setParam(MIXER, pid, 0.5, true)))?.message, 'param 17 of MIXER is an unused slot on this firmware; write refused', 'byte-exact: 409');
    assertEqual(x.mock.sent.length, 0, 'byte-exact: nothing went out');
    // the bundled FM9 catalog's own placeholder without a param
    assert(isPlaceholderRow(FM9.ranges['CABINET']![101]!) && !FM9.params['CABINET']!.some((p) => p.paramId === 101), 'premise: FM9 CABINET 101 is an unused slot');
    const c = rig(FM9);
    assertEqual((await refusal(c.driver.setParam(CAB, 101, 0.5, true)))?.statusCode, 409, 'FM9 catalog: CABINET 101 → 409');
    assertEqual((await refusal(c.driver.setParam(CAB, 65292, 1, false)))?.statusCode, 400, 'FM9: a cab button id → 400');
    assertEqual(c.mock.sent.length, 0, 'FM9: nothing went out');
    console.log('  drivers/write-guards: FM9 — live placeholder at a listed generic pid writable, byte-exact 409; catalog CABINET 101 409, button 400');
  }

  // ---- 8. a suspect family's profile rows refuse nothing: its section belongs to another family ---------------
  {
    const MIXER = eidOfFamily('MIXER');
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = () => {};
    console.log = () => {}; // the cross-check reports the suspects
    let swapped: DeviceProfile;
    try {
      swapped = placeholderProfile(0x12, 'MIXER', 17, 'editor-cache', (b) => {
        const swap = (o: Record<string, unknown>) => { const t = o.MIXER; o.MIXER = o.OUTPUT; o.OUTPUT = t; };
        swap(b.ranges as Record<string, unknown>);
        swap(b.enumOverrides as Record<string, unknown>);
        swap(b.rangeSections as Record<string, unknown>);
      });
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    assert(swapped.profileFacts!.suspectFamilies.includes('MIXER'), 'premise: MIXER is suspect (sections swapped)');
    assert(isPlaceholderRow(swapped.profileFacts!.ranges['MIXER']![17] as never), 'premise: the profile\'s MIXER section has a placeholder at 17');
    assert(!isPlaceholderRow(swapped.ranges['MIXER']![17]!), 'premise: the effective (catalog) row is informative');
    const s = rig(swapped);
    assertEqual((await s.driver.setParam(MIXER, 17, 0.5, true)).ok, true, 'suspect family: written');
    assertEqual(paramWrites(s.mock).length, 1, 'one frame');
    console.log('  drivers/write-guards: a suspect family\'s profile placeholder refuses nothing (the effective row is informative)');
  }

  // ---- 9. Axe-Fx III ----------------------------------------------------------------------------------------
  {
    const picker = AXE3.params['CABINET']!.find((p) => p.name === 'CABINET_PICKER1')!.paramId;
    const MOD_MIN = AXE3.params['MOD']!.find((p) => p.name === 'MOD_MIN')!.paramId;
    const free = Math.max(...Object.keys(AXE3.ranges['DELAY']!).map(Number).filter((p) => p <= 0x3fff)) + 1; // no catalog row
    assert(!AXE3.params['DELAY']!.some((p) => p.paramId === free), 'premise: no DELAY param at the free pid');
    const a = rig(AXE3);
    assertEqual((await refusal(a.driver.setParam(CAB, picker, 1, false)))?.statusCode, 400, `III: the cab picker id ${picker} → 400`);
    assertEqual(a.mock.sent.length, 0, 'III: nothing went out for it');
    assertEqual((await a.driver.setParam(MOD_EID, MOD_MIN, 0.25, true)).ok, true, 'III: MOD_MIN → written');
    assertEqual((await a.driver.setParam(DELAY, free, 0.5, true)).ok, true, `III catalog: DELAY ${free} has no row → written`);
    assertEqual(paramWrites(a.mock).length, 2, 'III: two frames');
    const x = rig(placeholderProfile(0x10, 'DELAY', free, 'editor-cache'));
    assertEqual((await refusal(x.driver.setParam(DELAY, free, 0.5, true)))?.message, `param ${free} of DELAY is an unused slot on this firmware; write refused`, `III byte-exact: DELAY ${free} → 409`);
    assertEqual(x.mock.sent.length, 0, 'III byte-exact: nothing went out');
    console.log(`  drivers/write-guards: Axe-Fx III — cab picker 400, MOD_MIN writable, byte-exact placeholder DELAY ${free} 409`);
  }

  // ---- 10-12. the same statuses and bodies through the Fastify app and the runtime router --------------------
  {
    const t = await buildTestApp(0x11);
    const router = createRouter({ registry: t.registry, store: store.defaultStore });
    const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const put = async (url: string, body: Record<string, unknown>) => {
      const before = paramWrites(t.mock).length;
      const res = await t.app.inject({ method: 'PUT', url, payload: body });
      const routed = await router.handle('PUT', url, JSON.stringify(body));
      assertEqual(routed.status, res.statusCode, `${url}: router/app status parity (app body ${res.payload})`);
      const appJson = JSON.parse(res.payload) as Record<string, unknown>;
      assert(deepEq(appJson, JSON.parse(String(routed.body))), `${url}: router/app body parity\napp:    ${res.payload}\nrouter: ${String(routed.body)}`);
      return { status: res.statusCode, json: appJson, written: paramWrites(t.mock).length - before };
    };
    try {
      const pseudo = await put(`/preset/blocks/${CAB}/params/65286`, { value: 1, continuous: false });
      assertEqual(pseudo.status, 400, 'pseudo id → 400 on both surfaces');
      assert(deepEq(pseudo.json, { statusCode: 400, error: 'Bad Request', message: 'param id 65286 is not a wire parameter' }), `400 envelope (${JSON.stringify(pseudo.json)})`);
      assertEqual(pseudo.written, 0, '400: nothing written on either surface');

      const slot = await put(`/preset/blocks/${CAB}/params/87`, { value: 0.5, continuous: true });
      assertEqual(slot.status, 409, 'unused slot → 409 on both surfaces');
      assert(deepEq(slot.json, { statusCode: 409, error: 'Conflict', message: 'param 87 of CABINET is an unused slot on this firmware; write refused' }), `409 envelope (${JSON.stringify(slot.json)})`);
      assertEqual(slot.written, 0, '409: nothing written on either surface');

      const ok = await put(`/preset/blocks/${CHORUS}/params/14`, { value: 1, continuous: true });
      assertEqual(ok.status, 200, 'CHORUS_GLOBALMIX → 200 on both surfaces');
      assertEqual(ok.written, 2, 'one frame per surface');
    } finally {
      await t.app.close();
    }
    console.log('  drivers/write-guards: app and router answer the same 400 / 409 / 200 (nothing sent on refusal)');
  }
}
