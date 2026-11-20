// The REAL serial and USB-MIDI transports wired to the shared request queue — with fake ports (no hardware,
// no native port opened): the serial transport drops a stale partial frame before each request, a paced send
// that loses its port mid-pump fails instead of hanging the queue, and MIDI requests run on the same queue
// (a late reply is swallowed, not handed to the next request). Real timers, short windows.
import { FractalSerial, type SerialPortLike } from '../../src/transport/serial.js';
import { MidiTransport, type MidiMod } from '../../src/transport/midi.js';
import { assert, assertEqual } from '../helpers/mock.js';

// One case = one executed check() (the suite verifies the count itself at the end).
export const TRANSPORT_WIRING_CASE_COUNT = 10;
let executed = 0;
function check(cond: unknown, msg: string): void {
  executed++;
  assert(cond, msg);
}

const MODEL = 0x11;
function sysex(fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const REQ_STATUS = sysex(0x0d, [0x01]);
const REQ_GET = sysex(0x01, [0x01, 0x00, 0x05, 0x00, 0x02, 0x00]);
const statusReply = (tag: number) => sysex(0x0d, [0x01, tag]);
const getReply = (tag: number) => sysex(0x01, [0x01, 0x00, 0x05, 0x00, 0x02, 0x00, tag]);
const byFn = (fn: number) => (fs: number[][]) => fs.some((f) => f[5] === fn);
const same = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Settle `p` or fail after `ms` — a hung queue must fail the suite, not stall it. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<{ value?: T; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`HUNG: ${what}`)), ms); });
  try {
    return { value: await Promise.race([p, guard]) };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('HUNG:')) throw e;
    return { error: e };
  } finally {
    clearTimeout(timer);
  }
}

class FakeSerialPort implements SerialPortLike {
  isOpen = false;
  readonly written: number[][] = [];
  #onData: ((buf: Buffer) => void) | null = null;
  constructor(onOpen: (err: Error | null) => void) {
    setImmediate(() => { this.isOpen = true; onOpen(null); });
  }
  on(event: 'data' | 'error', listener: (arg: never) => void): this {
    if (event === 'data') this.#onData = listener as (buf: Buffer) => void;
    return this;
  }
  write(data: Buffer): boolean {
    this.written.push([...data]);
    return true;
  }
  close(callback: () => void): void {
    this.isOpen = false;
    callback();
  }
  feed(bytes: number[]): void {
    this.#onData?.(Buffer.from(bytes));
  }
}

async function openSerial(): Promise<{ serial: FractalSerial; port: () => FakeSerialPort }> {
  let port: FakeSerialPort | null = null;
  const serial = new FractalSerial({ path: 'FAKE-SERIAL', openPort: (_o, onOpen) => (port = new FakeSerialPort(onOpen)) });
  await serial.open();
  return { serial, port: () => port! };
}

async function serialDropsStalePartialFrame(): Promise<void> {
  const { serial, port } = await openSerial();
  // a frame cut off before its F7 (the device was interrupted) sits in the reassembly buffer...
  const stale = statusReply(0xaa);
  port().feed(stale.slice(0, 7));
  const p = serial.request(REQ_STATUS, { timeoutMs: 1000, quietMs: 50, match: byFn(0x0d) });
  await tick();
  check(same(port().written[0], REQ_STATUS), 'serial: the request goes out through the queue');
  // ...its tail arrives after the new request started: without the beforeRequest reset it would complete the
  // stale frame and answer the request with it
  port().feed(stale.slice(7));
  const fresh = statusReply(0xcc);
  port().feed(fresh.slice(0, 5));
  port().feed(fresh.slice(5));
  const r = await within(p, 2000, 'serial request');
  check(r.value?.length === 1 && same(r.value[0], fresh), 'serial: a stale partial frame is dropped before the request — only the fresh reply arrives');
  await serial.close();
}

async function serialPacedSendCloses(): Promise<void> {
  const { serial, port } = await openSerial();
  const big = sysex(0x77, new Array<number>(700).fill(0x10));
  const paced = serial.sendPaced(big, 64, 3);
  setTimeout(() => { port().isOpen = false; }, 8); // the port goes away mid-pump
  const r = await within(paced, 2000, 'paced send after close');
  check(r.error instanceof Error && r.error.message === 'port not open', 'serial: a port closing mid-pump rejects the paced send (it used to hang the queue forever)');
  check(port().written.length > 0 && port().written.length < Math.ceil(big.length / 64), 'serial: some chunks went out before the close');
  const next = await within(serial.request(REQ_STATUS, { timeoutMs: 200, match: byFn(0x0d) }), 2000, 'request after a failed paced send');
  check(next.error instanceof Error && next.error.message === 'port not open', 'serial: the queue moves on — the next request fails fast on the closed port');
}

/** Fake @julusian/midi Input/Output pair; `inst` exposes the instances the transport created. */
function fakeMidi() {
  const inst: { in?: { emit(msg: number[]): void }; out?: { sent: number[][]; onSend?: (m: number[]) => void } } = {};
  class In {
    #cb: ((dt: number, msg: number[]) => void) | null = null;
    constructor() { inst.in = this; }
    getPortCount() { return 1; }
    getPortName() { return 'Fractal FM3 MIDI In'; }
    ignoreTypes() {}
    setBufferSize() {}
    on(_ev: string, cb: (dt: number, msg: number[]) => void) { this.#cb = cb; }
    openPort() {}
    closePort() {}
    destroy() {}
    emit(msg: number[]) { this.#cb?.(0, msg); }
  }
  class Out {
    sent: number[][] = [];
    onSend?: (m: number[]) => void;
    constructor() { inst.out = this; }
    getPortCount() { return 1; }
    getPortName() { return 'Fractal FM3 MIDI Out'; }
    openPort() {}
    closePort() {}
    destroy() {}
    send(m: number[]) { this.sent.push(m); this.onSend?.(m); }
  }
  return { mod: { Input: In, Output: Out } as unknown as MidiMod, inst };
}

async function midiUsesTheQueue(): Promise<void> {
  const { mod, inst } = fakeMidi();
  const midi = new MidiTransport('Fractal FM3 MIDI In', 'Fractal FM3 MIDI Out', mod);
  await midi.open();
  check(midi.isOpen && inst.in && inst.out, 'midi: opens over the injected ports');
  // A gets no reply in time; its reply turns up while the queue drains → swallowed, never given to B
  const a = midi.request(REQ_STATUS, { timeoutMs: 30, quietMs: 20, match: byFn(0x0d) });
  const bSent = new Promise<void>((r) => { inst.out!.onSend = (m) => { if (m[5] === 0x01) r(); }; });
  const b = midi.request(REQ_GET, { timeoutMs: 1000, quietMs: 20, match: byFn(0x01) });
  const ra = await within(a, 2000, 'midi A');
  check(ra.value?.length === 0, 'midi: A is answered at its timeout');
  await sleep(10);
  inst.in!.emit(statusReply(0xaa)); // A's late reply, inside the drain
  check(inst.out!.sent.length === 1, 'midi: B waits while the link drains');
  await within(bSent, 2000, 'midi B sent');
  inst.in!.emit(getReply(0xbb));
  const rb = await within(b, 2000, 'midi B');
  check(rb.value?.length === 1 && same(rb.value[0], getReply(0xbb)), 'midi: B gets only its own reply — A\'s late reply was swallowed');
  await midi.close();
  const closed = await within(midi.request(REQ_STATUS, { timeoutMs: 100, match: byFn(0x0d) }), 2000, 'midi after close');
  check(closed.error instanceof Error, 'midi: a request on a closed port fails fast');
}

export async function runTransportWiringTests(): Promise<void> {
  executed = 0;
  const log = console.log;
  const warn = console.warn;
  console.log = () => {}; // the MIDI transport logs every frame
  console.warn = () => {}; // expected timeout / drain warnings
  try {
    await serialDropsStalePartialFrame();
    await serialPacedSendCloses();
    await midiUsesTheQueue();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  assertEqual(executed, TRANSPORT_WIRING_CASE_COUNT, 'transport-wiring: TRANSPORT_WIRING_CASE_COUNT is in step with the executed checks');
}
