// Device-edit events for every param the block lists, generic ones included, and none where a body carries no
// per-param information. An edit burst (or the FM3's poll of the open block) is diffed against the baseline
// the last block read primed; each moved pid becomes a `param` event.
//   • a param the connected firmware added (a row the catalog does not have) moves on the front panel → an event;
//   • a slot that is an unused row (all-zero placeholder) churns → no event, a catalog param moves → an event;
//   • GLOBAL's body is indexed by record, not by pid: no events, no invented norms, no baseline, no reload,
//     and the FM3 poll leaves it alone.
// Committed catalog data plus a synthetic extra row; mocked link, no device.
import { PROFILES, runtimeProfileFrom, type DeviceProfile } from '../../src/devices.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { isPlaceholderRow, type RangeDef, type BuiltCache } from 'forgefx-midi/cache';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { blockBulkFrames, eidOfSlug, mockBlockDevice, type MockBlock } from '../helpers/blockRead.js';

export const EDIT_BURST_GENERIC_CASE_COUNT = 5;

const FM3 = PROFILES[0x11]!;
const MODEL = 0x11;
const DELAY = eidOfSlug('delay');
const GLOBAL_EID = 1;

/** The FM3 catalog read back as a byte-exact device profile that has two more DELAY slots than the catalog: a
 *  float 0..10 right after the catalog's last slot, then an unused (all-zero) slot. */
function profileWithNewRow(): { profile: DeviceProfile; stride: number; newPid: number; placeholder: number } {
  const built: BuiltCache = catalogBuilt(MODEL);
  const section = built.rangeSections['DELAY']!;
  const newPid = section.stride;
  const placeholder = newPid + 1;
  const rows = built.ranges['DELAY'] as Record<number, RangeDef>;
  rows[newPid] = { kind: 'float', displayMin: 0, displayMax: 10, scale: 1, step: 0.01, typecode: 0x32 };
  rows[placeholder] = { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0 };
  built.rangeSections['DELAY'] = { ...section, stride: section.stride + 2, recordCount: section.recordCount + 2 };
  return { profile: runtimeProfileFrom(built, FM3), stride: section.stride + 2, newPid, placeholder };
}

const zeros = (n: number) => new Array<number>(n).fill(0);
const events = (burst: { events: { paramId: number }[] }) => burst.events.map((e) => e.paramId).sort((a, b) => a - b);

export async function runEditBurstGenericTests(): Promise<void> {
  const { profile, stride, newPid, placeholder } = profileWithNewRow();
  assert(isPlaceholderRow(profile.ranges['DELAY']![placeholder]!), 'the extra slot is an unused one (the premise)');

  // ---- 1. a generic param moves on the front panel → an event -------------------------------------------
  {
    const before = zeros(stride * 4);
    const blocks: Record<number, MockBlock> = { [DELAY]: { values: before, channel: 0 } };
    const { driver } = mockBlockDevice(profile, blocks);
    const r = await driver.blockParams(DELAY, { generic: true });
    const g = r.named.find((n) => n.id === newPid);
    assert(!!g && g.generic === true && g.isNew === true && g.pageHint === 'new-in-firmware', 'the new row is listed as a generic param, new in firmware');
    const after = [...before];
    after[newPid] = 32767;
    after[0] = 10000; // a catalog param moves too
    const burst = driver.decodeEditBurst(blockBulkFrames(MODEL, DELAY, after));
    assertEqual(burst.reload, false, 'the baseline was primed by the read');
    assertEqual(events(burst).join(','), `0,${newPid}`, 'an event for the generic param and for the catalog param');
    const ev = burst.events.find((e) => e.paramId === newPid)!;
    assertEqual(ev.effectId, DELAY, 'the event names the block');
    assertEqual(ev.norm, 32767 / 65534, 'with the normalised value');
    // the classic read primes the same baseline: generic params report in both flows
    const classic = mockBlockDevice(profile, { [DELAY]: { values: before, channel: 0 } });
    await classic.driver.blockParams(DELAY);
    assertEqual(events(classic.driver.decodeEditBurst(blockBulkFrames(MODEL, DELAY, after))).join(','), `0,${newPid}`, 'after a classic read too');
    console.log('  drivers/edit-burst-generic: a new (generic) param and a catalog param both report a front-panel edit');
  }

  // ---- 2. an unused slot churns → no event ----------------------------------------------------------
  {
    const before = zeros(stride * 4);
    const { driver } = mockBlockDevice(profile, { [DELAY]: { values: before, channel: 0 } });
    await driver.blockParams(DELAY, { generic: true });
    const after = [...before];
    after[placeholder] = 40000;
    const burst = driver.decodeEditBurst(blockBulkFrames(MODEL, DELAY, after));
    assertEqual(events(burst).join(','), '', `no event for the unused slot ${placeholder}`);
    assertEqual(burst.reload, false, 'and no reload');
    console.log('  drivers/edit-burst-generic: an unused slot reports nothing');
  }

  // ---- 3. GLOBAL: no events, no baseline, no reload ---------------------------------------------------------
  {
    const body = (v: number) => zeros(136).map((_, i) => (i === 5 ? v : 0));
    for (const generic of [true, false]) {
      const { driver } = mockBlockDevice(FM3, { [GLOBAL_EID]: { values: body(100), channel: null } });
      await (generic ? driver.blockParams(GLOBAL_EID, { generic: true }) : driver.blockParams(GLOBAL_EID));
      const burst = driver.decodeEditBurst(blockBulkFrames(MODEL, GLOBAL_EID, body(30000)));
      assertEqual(burst.events.length, 0, `${generic ? 'generic' : 'classic'} read, then a changed body: no events`);
      assertEqual(burst.reload, false, 'no reload either');
    }
    // never primed: a fresh driver that never read GLOBAL does not ask for a reload on first sight
    const fresh = mockBlockDevice(FM3, {}).driver;
    const first = fresh.decodeEditBurst(blockBulkFrames(MODEL, GLOBAL_EID, body(100)));
    assertEqual(first.reload, false, 'first sight of GLOBAL asks for no reload');
    assertEqual(first.events.length, 0, 'and reports no event');
    console.log('  drivers/edit-burst-generic: GLOBAL — no events, no invented norms, no baseline, no reload');
  }

  // ---- 4. the FM3 poll: generic params emit, GLOBAL is left alone -------------------------------------------
  {
    const seen: DeviceEvent[] = [];
    const blocks: Record<number, MockBlock> = { [DELAY]: { values: zeros(stride * 4), channel: 0 }, [GLOBAL_EID]: { values: zeros(136), channel: null } };
    const { driver, mock } = mockBlockDevice(profile, blocks, { emit: (e) => seen.push(e) });
    await driver.blockParams(DELAY, { generic: true });
    const moved = zeros(stride * 4);
    moved[newPid] = 20000;
    blocks[DELAY]!.values = moved;
    const tick = await driver.readDeviceEditState();
    assertEqual(tick.changed, false, 'the poll reports the edit per param, not as a reload');
    const params = seen.filter((e) => e.type === 'param') as { type: 'param'; effectId: number; paramId: number; norm: number }[];
    assertEqual(params.map((e) => e.paramId).join(','), String(newPid), 'the poll emitted an event for the generic param');
    assertEqual(params[0]!.norm, 20000 / 65534, 'with its normalised value');
    // GLOBAL becomes the watched block: the poll no longer reads it
    await driver.blockParams(GLOBAL_EID, { generic: true });
    const sent = mock.sent.length;
    const idle = await driver.readDeviceEditState();
    assertEqual(idle.changed, false, 'nothing to report for GLOBAL');
    assertEqual(mock.sent.length, sent, 'and nothing was read for it');
    console.log('  drivers/edit-burst-generic: the FM3 poll emits generic-param events and skips GLOBAL');
  }

  // ---- 5. a firmware row that is gone reports nothing ---------------------------------------------------------
  {
    const built: BuiltCache = catalogBuilt(MODEL);
    const gone = Number(Object.entries(built.ranges['DELAY']!).find(([pid]) => FM3.params['DELAY']!.some((d) => d.paramId === Number(pid) && !/bypass|MODEL/i.test(d.name)))?.[0]);
    delete (built.ranges['DELAY'] as Record<number, RangeDef>)[gone];
    const p = runtimeProfileFrom(built, FM3);
    const dStride = built.rangeSections['DELAY']!.stride;
    const before = zeros(dStride * 4);
    const { driver } = mockBlockDevice(p, { [DELAY]: { values: before, channel: 0 } });
    const r = await driver.blockParams(DELAY, { generic: true });
    assert(r.definitions.hidden.some((h) => h.id === gone && h.reason === 'removed'), `pid ${gone} is reported as removed`);
    const after = [...before];
    after[gone] = 40000;
    assertEqual(events(driver.decodeEditBurst(blockBulkFrames(MODEL, DELAY, after))).join(','), '', 'a removed row reports nothing');
    console.log('  drivers/edit-burst-generic: a row the firmware dropped reports nothing');
  }
}
