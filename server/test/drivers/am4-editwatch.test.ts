// AM4 edit-watch unit tests (FORGEFX-25 + follow-up — fixes the audio dropouts). Drives the AM4 driver's
// readDeviceEditState() directly against a scripted MockTransport and asserts ON THE WIRE that the heavy
// fn-0x1F GET_ALL_PARAMS dumps (byte[5]===0x1f) NEVER fire: the periodic latched re-dump glitched AM4
// audio after a channel swap, so latched-rehash is now disabled in EVERY mode (editRehashMs=0). Reloads
// ride the CHEAP transitions only — dirty-onset false→true, scene, channel, save true→false — each of
// which emits WITHOUT a dump. An injected clock (driver.__setClockForTest) keeps cache TTLs deterministic.
// NO hardware. (The #hashPlacedParams path stays parameterised behind rehashMs>0 for a future view-gated
// rehash; with rehashMs=0 it is never reached, which is what these tests pin.)
//
// Wire cheat-sheet (all AM4 frames are F0 00 01 74 15 <fn> …):
//   fn 0x01 buildReadParam — pidLow 0 (bytes6,7=0)  → GET_PATCH edited-bit read (via conn.send)
//                          — pidLow 0x00ce           → fn-0x1F structure read  (via dev.request)
//                          — pidHigh 0x07dd          → 0x07DD active-channel read (via dev.request)
//   fn 0x1f buildGetAllParams                        → GET_ALL_PARAMS dump      (via conn.send) ← COUNTED
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { createAm4Driver } from '../../src/drivers/am4.js';
import type { DriverCtx, DeviceEvent } from '../../src/drivers/types.js';
import { cadenceFor, type TelemetryMode } from '../../src/drivers/telemetryProfiles.js';
import { MockTransport, assert, assertEqual } from '../helpers/mock.js';
import { BLOCK_TYPE_VALUES, resolveBlockTypeValue, AM4_CHANNEL_STATUS_PID_HIGH } from 'forgefx-midi/am4';
import { packValueChunked } from 'forgefx-midi/shared';

export const AM4_EDITWATCH_CASE_COUNT = 12;

const DRIVE = BLOCK_TYPE_VALUES.drive as number; // 0x76 — a real block-type code (resolves to 'drive')
const STRUCT_PID_LOW = 0x00ce; // BLOCK_SLOT_PID_LOW — the fn-0x1F structure read address
const e14 = (n: number): [number, number] => [n & 0x7f, (n >> 7) & 0x7f];

// ── scripted device-frame builders ────────────────────────────────────────────────────────────────
/** GET_PATCH edited-bit response: AM4 param-RW envelope, ≥100 bytes, byte[21]&0x04 carries the bit. */
function getPatchFrame(edited: boolean): number[] {
  const f = new Array(110).fill(0);
  f[0] = 0xf0; f[1] = 0x00; f[2] = 0x01; f[3] = 0x74; f[4] = 0x15; f[5] = 0x01;
  f[21] = edited ? 0x04 : 0x00;
  f[109] = 0xf7;
  return f;
}
/** MSB-first 7→8 bit-packer — the exact inverse of the driver's unpackMsb (used to seed the struct). */
function packMsb(bytes: Uint8Array): number[] {
  const septets: number[] = [];
  let acc = 0, nbits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte; nbits += 8;
    while (nbits >= 7) { nbits -= 7; septets.push((acc >> nbits) & 0x7f); }
  }
  if (nbits > 0) septets.push((acc << (7 - nbits)) & 0x7f);
  return septets;
}
/** fn-0x1F structure response (isStructResponse): 16-byte header + MSB-packed 192-byte struct + cs + F7.
 *  location int32@0x00, scene int32@0x08, per-slot block-type int32 @0xb0/b4/b8/bc. */
function structFrame(scene: number, slotCodes: number[], location = 0): number[] {
  const b = new Uint8Array(192);
  const putI32 = (o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = (v >> 16) & 0xff; b[o + 3] = (v >> 24) & 0xff; };
  putI32(0x00, location);
  putI32(0x08, scene);
  [0xb0, 0xb4, 0xb8, 0xbc].forEach((off, i) => putI32(off, slotCodes[i] ?? 0));
  const header = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0, 0, 0, 0, 0x1f, 0x00, 0, 0, 0, 0];
  return [...header, ...packMsb(b), 0x00, 0xf7];
}
/** fn-0x1F GET_ALL_PARAMS state-broadcast triple (0x74 header + 0x75 chunk + 0x76 footer). itemCount=4
 *  (stride 1 → the hash keys off values[0]), so flipping `value` flips the fingerprint. */
function dumpTriple(eid: number, value: number): number[][] {
  const enc16 = (v: number) => [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03];
  const header = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x74, ...e14(eid), ...e14(4), 0x00, 0xf7];
  const payload = [...enc16(value), ...enc16(0), ...enc16(0), ...enc16(0)];
  const chunk = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x75, ...e14(4), ...payload, 0x00, 0xf7];
  const footer = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x76, 0x00, 0xf7];
  return [header, chunk, footer];
}
/** 0x07DD active-channel long-read response (parseActiveChannelResponse: byte[50] of the chunked payload
 *  is the channel index 0..3; pidLow bytes6,7 echo the requested block). */
function channelFrame(pidLow: number, idx: number): number[] {
  const raw = new Uint8Array(54); raw[50] = idx;
  const header = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, ...e14(pidLow), ...e14(AM4_CHANNEL_STATUS_PID_HIGH), 0, 0, 0, 0, ...e14(54)];
  return [...header, ...Array.from(packValueChunked(raw)), 0x00, 0xf7];
}

// ── rig: a driver over a scripted mock, with pull-based state getters the sub-tests mutate per tick ──
interface RigState { edited: boolean; scene: number; channelIdx: number | null; dumpValue: number; }
function rig(mode: TelemetryMode, st: RigState) {
  const mock = new MockTransport('serial', '/dev/ttyACM0');
  const events: DeviceEvent[] = [];
  const slots = [DRIVE, 0, 0, 0];
  // request() path — the fn-0x1F structure read + the 0x07DD channel reads.
  mock.reply = (req) => {
    if (req[5] === 0x01 && req[6] === (STRUCT_PID_LOW & 0x7f) && req[7] === ((STRUCT_PID_LOW >> 7) & 0x7f)) {
      return [structFrame(st.scene, slots)];
    }
    if (req[5] === 0x01 && req[8] === (AM4_CHANNEL_STATUS_PID_HIGH & 0x7f) && req[9] === ((AM4_CHANNEL_STATUS_PID_HIGH >> 7) & 0x7f)) {
      return st.channelIdx === null ? [] : [channelFrame(req[6] | (req[7] << 7), st.channelIdx)];
    }
    return [];
  };
  // send() path — the GET_PATCH edited-bit read + the fn-0x1F GET_ALL_PARAMS dumps.
  mock.sendReply = (bytes) => {
    if (bytes[5] === 0x1f) return dumpTriple(bytes[6] | (bytes[7] << 7), st.dumpValue); // GET_ALL_PARAMS
    if (bytes[5] === 0x01 && bytes[6] === 0 && bytes[7] === 0) return [getPatchFrame(st.edited)]; // GET_PATCH
    return [];
  };
  const ctx: DriverCtx = { transport: async () => mock, emit: (e) => events.push(e), getCadence: () => cadenceFor(0x15, mode) };
  const driver = createAm4Driver(ctx);
  return { mock, events, driver };
}
/** Count fn-0x1F GET_ALL_PARAMS dumps on the wire (the heavy path the redesign gates). */
const dumps = (mock: MockTransport) => mock.sent.filter((f) => f[4] === 0x15 && f[5] === 0x1f).length;

// ── the ticker: models the registry — a `changed` reaches Axis either as a driver-direct ctx.emit OR
//    as the registry emitting on a `{changed:true}` return. Return the total for this tick. ────────────
async function tickChanged(driver: ReturnType<typeof rig>['driver'], events: DeviceEvent[]): Promise<number> {
  const before = events.length;
  const r = await driver.readDeviceEditState!();
  const direct = events.slice(before).filter((e) => e.type === 'changed').length;
  return direct + (r.changed ? 1 : 0);
}

export async function runAm4EditWatchTests(): Promise<void> {
  const prevDebug = process.env.AM4_DEBUG;
  process.env.AM4_DEBUG = '0'; // silence the struct hex-dump #log while keeping the driver's behavior
  try {
    // sanity: DRIVE resolves to a real placed block (else the struct has nothing to dump/hash).
    assert(resolveBlockTypeValue(DRIVE)?.name === 'drive', 'DRIVE code resolves to the drive block');

    // ── A. false→true onset + steady-latched — ZERO dumps in EVERY mode (latched rehash disabled) ──
    {
      const st: RigState = { edited: false, scene: 0, channelIdx: null, dumpValue: 10 };
      const { mock, events, driver } = rig('performance', st); // performance: editWatchMs 1500, editRehashMs 0 (rehash off)
      let clock = 1000; driver.__setClockForTest(() => clock);

      // tick 1: clean first run → adopt baseline, no dump, no emit.
      clock = 1000; assertEqual(await tickChanged(driver, events), 0, 'A1 clean first tick: no changed');
      assertEqual(dumps(mock), 0, 'A1 clean first tick issues ZERO dumps');

      // tick 2: false→true → EXACTLY one `changed`, and ZERO dumps (no seed dump — rehash disabled).
      st.edited = true; clock = 1100;
      assertEqual(await tickChanged(driver, events), 1, 'A2 false→true emits exactly one changed');
      assertEqual(dumps(mock), 0, 'A2 false→true issues ZERO dumps (latched rehash disabled)');

      // ticks 3–4: bit stays latched → still ZERO dumps, no changed.
      clock = 1600; assertEqual(await tickChanged(driver, events), 0, 'A3 latched-steady: no changed');
      clock = 2100; await tickChanged(driver, events);
      assertEqual(dumps(mock), 0, 'A3/A4 steady latched ticks issue ZERO dumps');

      // tick 5: a 2nd on-device param tweak while ALREADY dirty is NOT reloaded (accepted tradeoff — the
      // fingerprint rehash that used to catch this is disabled; reflection resumes on save/scene/channel).
      st.dumpValue = 20; clock = 4200;
      assertEqual(await tickChanged(driver, events), 0, 'A5 a 2nd on-device tweak while latched is NOT reloaded (rehash disabled)');
      assertEqual(dumps(mock), 0, 'A5 no rehash dump ever');

      // tick 6: still latched → still no dump.
      clock = 4700; await tickChanged(driver, events);
      assertEqual(dumps(mock), 0, 'A6 steady tick issues no dump');
    }

    // ── B. true→false (device-side save): `changed` emitted, NO dump ──────────────────────────────
    {
      const st: RigState = { edited: true, scene: 0, channelIdx: null, dumpValue: 5 };
      const { mock, events, driver } = rig('performance', st);
      let clock = 1000; driver.__setClockForTest(() => clock);
      clock = 1000; await tickChanged(driver, events); // first run, dirty → adopt baseline, NO dump (rehash disabled)
      assertEqual(dumps(mock), 0, 'B dirty first tick issues NO dump (rehash disabled)');
      st.edited = false; clock = 2600;
      assertEqual(await tickChanged(driver, events), 1, 'B save (true→false) emits changed');
      assertEqual(dumps(mock), 0, 'B save issues NO dump (baseline reset is cheap)');
    }

    // ── C. reduced mode (editRehashMs=0): NO dumps ever on latched-steady; save still emits ──────────
    {
      const st: RigState = { edited: false, scene: 0, channelIdx: null, dumpValue: 7 };
      const { mock, events, driver } = rig('reduced', st); // editRehashMs 0
      let clock = 1000; driver.__setClockForTest(() => clock);
      clock = 1000; await tickChanged(driver, events); // clean baseline
      st.edited = true; clock = 2000;
      assertEqual(await tickChanged(driver, events), 1, 'C false→true still emits changed in reduced mode');
      clock = 20000; await tickChanged(driver, events); // long-latched, way past any budget
      clock = 40000; await tickChanged(driver, events);
      assertEqual(dumps(mock), 0, 'C editRehashMs=0: ZERO dumps ever on the latched path');
      // save still reflects with zero dumps.
      st.edited = false; clock = 60000;
      assertEqual(await tickChanged(driver, events), 1, 'C save still emits changed in reduced mode');
      assertEqual(dumps(mock), 0, 'C save path issues no dump in reduced mode');
    }

    // ── D. self-edit pending: silent re-seed (no `changed`), ZERO dumps ──────────────────────────────
    {
      const st: RigState = { edited: false, scene: 0, channelIdx: null, dumpValue: 100 };
      const { mock, events, driver } = rig('performance', st);
      let clock = 1000; driver.__setClockForTest(() => clock);
      clock = 1000; await tickChanged(driver, events); // clean baseline
      // our own write flips #selfEditPending; the buffer is now dirty.
      await driver.setBypass!(DRIVE, true);
      st.edited = true; st.dumpValue = 100; clock = 1500;
      assertEqual(await tickChanged(driver, events), 0, 'D self-edit tick emits NO changed (silent re-seed)');
      assertEqual(dumps(mock), 0, 'D self-edit re-seed issues ZERO dumps (rehash disabled)');
      // With latched-rehash disabled, a later on-device param tweak while STILL dirty is NOT reloaded
      // (accepted tradeoff — reflection resumes on save/scene/channel, tested in B/E/F).
      st.dumpValue = 200; clock = 5000;
      assertEqual(await tickChanged(driver, events), 0, 'D a later on-device param tweak while dirty is NOT reloaded (rehash disabled)');
      assertEqual(dumps(mock), 0, 'D no dump across the whole self-edit path');
    }

    // ── E. scene detection every tick (no edited bit, no dump) ───────────────────────────────────────
    {
      const st: RigState = { edited: false, scene: 0, channelIdx: null, dumpValue: 1 };
      const { mock, events, driver } = rig('performance', st);
      let clock = 1000; driver.__setClockForTest(() => clock);
      clock = 1000; await tickChanged(driver, events); // baseline scene 0
      st.scene = 2; clock = 4000; // advance past the struct TTL so the struct re-reads scene 2
      const before = events.length;
      await tickChanged(driver, events);
      const sceneEvt = events.slice(before).find((e) => e.type === 'scene') as Extract<DeviceEvent, { type: 'scene' }> | undefined;
      assert(sceneEvt !== undefined && sceneEvt.index === 2, 'E footswitch scene change emits scene{index:2}');
      assertEqual(dumps(mock), 0, 'E scene detection issues no dump');
    }

    // ── F. channel (0x07DD) detection every tick (no edited bit, no dump) ────────────────────────────
    {
      const st: RigState = { edited: false, scene: 0, channelIdx: 0, dumpValue: 1 };
      const { mock, events, driver } = rig('performance', st);
      let clock = 1000; driver.__setClockForTest(() => clock);
      clock = 1000; await tickChanged(driver, events); // baseline channel A(0)
      st.channelIdx = 1; clock = 4000; // advance past struct TTL; front-panel switch to channel B
      assertEqual(await tickChanged(driver, events), 1, 'F front-panel channel switch → changed');
      assertEqual(dumps(mock), 0, 'F channel detection issues no dump');
    }
  } finally {
    if (prevDebug === undefined) delete process.env.AM4_DEBUG; else process.env.AM4_DEBUG = prevDebug;
  }
}
