// A mocked gen-3 unit that answers the two reads behind GET /preset/blocks/:eid/params: the fn-0x13 status dump
// (active channel per block) and the fn-0x1F bulk read (one block's body). No hardware; committed catalog data and synthetic bodies only.
import { createGen3Driver, type Gen3Driver } from '../../src/drivers/gen3.js';
import { cadenceFor } from '../../src/drivers/telemetryProfiles.js';
import type { DeviceProfile } from '../../src/devices.js';
import type { DeviceEvent } from '../../src/drivers/types.js';
import { createModernFractalCodec, packValue16 } from 'forgefx-midi/gen3/axe-fx-iii';
import { effectRoster } from 'forgefx-midi/devices/gen3';
import { MockTransport } from './mock.js';

export const compactHex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join('');
export const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

export function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** The fn-0x74 head, one fn-0x75 body and the fn-0x76 end of a block read. `advertised` is the itemCount the
 *  head names (default: the number of values sent; fewer values than advertised is a torn burst). */
export function blockBulkFrames(model: number, effectId: number, values: readonly number[], advertised = values.length): number[][] {
  const body: number[] = [0x00, 0x02];
  for (const v of values) body.push(...packValue16(v));
  return [
    sysex(model, 0x74, [...enc14(effectId), ...enc14(advertised), 0x07]),
    sysex(model, 0x75, body),
    sysex(model, 0x76, []),
  ];
}

/** The effect id of the first instance of the block `slug` ('amp', 'delay', …). */
export function eidOfSlug(slug: string): number {
  const e = effectRoster().find((x) => x.slug === slug);
  if (!e) throw new Error(`no roster entry for slug '${slug}'`);
  return e.page;
}

export interface MockBlock {
  /** The body, one wire value per record (all channels back to back for a channel-bearing block). */
  values: readonly number[];
  /** The itemCount the head advertises (default: `values.length`). */
  advertised?: number;
  /** Active channel the status dump reports; `null` leaves the block out of the status dump. Default 0. */
  channel?: number | null;
  /** The bulk read gets no reply at all. */
  silent?: boolean;
}

/** A gen-3 driver on a mocked link that answers the status dump and each block's bulk read. `blocks` is read at
 *  every request, so a test may change a block's body between two reads; `emit` receives the driver's events. */
export function mockBlockDevice(
  profile: DeviceProfile, blocks: Record<number, MockBlock>, opts: { emit?: (e: DeviceEvent) => void } = {}
): { driver: Gen3Driver; mock: MockTransport } {
  const codec = createModernFractalCodec(profile.model);
  const statusHex = compactHex(codec.buildStatusDump());
  const polls = new Map<string, number>();
  for (const k of Object.keys(blocks)) polls.set(compactHex(codec.buildBlockBulkReadPoll(Number(k))), Number(k));
  const mock = new MockTransport('serial', 'mock-block-read');
  mock.isOpen = true;
  mock.reply = (req) => {
    const h = compactHex(req);
    if (h === statusHex) {
      const status: number[] = [];
      for (const [k, b] of Object.entries(blocks)) {
        if (b.channel === null) continue;
        status.push(...enc14(Number(k)), ((b.channel ?? 0) & 0x07) << 1);
      }
      return status.length > 0 ? [sysex(profile.model, 0x13, status)] : [];
    }
    const eid = polls.get(h);
    if (eid === undefined) return [];
    const b = blocks[eid]!;
    return b.silent ? [] : blockBulkFrames(profile.model, eid, b.values, b.advertised);
  };
  const driver = createGen3Driver(profile, { transport: async () => mock, emit: opts.emit ?? (() => {}), getCadence: () => cadenceFor(null, 'balanced') });
  return { driver, mock };
}
