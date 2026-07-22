// USB-MIDI transport for Fractal units that present as a MIDI-class device (Axe-Fx III, and FM9 if
// it enumerates as MIDI). Uses @julusian/midi (RtMidi, N-API prebuilds → bundles like serialport).
// SysEx framing is trivial here: RtMidi delivers each F0..F7 message whole, so no byte reassembly.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import type { Input as MidiInput, Output as MidiOutput } from '@julusian/midi';
import type { Transport, RequestOpts } from './types.js';

// LAZY + FAULT-TOLERANT load of the native MIDI binding. In a packaged desktop build the native
// .node may be missing/incompatible; a static import would throw at module load and take down the
// whole server (and with it the serial/FM3 path). Loading it lazily + guarded means MIDI simply
// degrades to "no MIDI ports" while serial keeps working.
type MidiMod = { Input: new () => MidiInput; Output: new () => MidiOutput };
let _midi: MidiMod | null | undefined;
function midi(): MidiMod | null {
  if (_midi === undefined) {
    try {
      _midi = createRequire(import.meta.url)('@julusian/midi') as MidiMod;
    } catch (e) {
      console.warn(`[forgefx] MIDI transport unavailable (@julusian/midi failed to load): ${(e as Error).message}`);
      _midi = null;
    }
  }
  return _midi;
}
export const midiAvailable = (): boolean => midi() !== null;

const SYSEX_START = 0xf0;
// Fractal-looking MIDI port names (CoreMIDI/ALSA expose the unit by name).
const FRACTAL_RE = /fractal|axe[ -]?fx|fm[ -]?3|fm[ -]?9|ax8|am[ -]?4|vp4/i;

export interface MidiPortInfo {
  id: string; // the port name (used to reopen it)
  label: string;
  fractal: boolean;
  dir: 'input' | 'output';
}

/**
 * Pair the matching OUTPUT port for a given INPUT port name. USB-MIDI Fractal units expose two
 * endpoints named like "Axe-Fx III MIDI In" / "Axe-Fx III MIDI Out" — same stem, In/Out suffix.
 * Try an In→Out token swap (exact), else match by the suffix-stripped stem, else fall back to the
 * sole output (or the input name itself).
 */
export function pairMidiOutput(inputName: string, outputs: string[]): string | null {
  if (!outputs.length) return null;
  const swap = inputName
    .replace(/\bInput\b/gi, 'Output')
    .replace(/\bIn\b/gi, 'Out')
    .replace(/\bRX\b/gi, 'TX');
  if (swap !== inputName) {
    const exact = outputs.find((o) => o === swap);
    if (exact) return exact;
  }
  const stem = (s: string) => s.replace(/\b(midi|usb)\b/gi, '').replace(/\b(in|out|input|output|rx|tx)\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const inStem = stem(inputName);
  const byStem = outputs.find((o) => stem(o) === inStem);
  if (byStem) return byStem;
  return outputs.length === 1 ? outputs[0]! : null;
}

type PortLister = { getPortCount(): number; getPortName(i: number): string };
// ALSA appends a "<client>:<port>" sequence id to MIDI port names (e.g. "… MIDI 1 28:0") that RENUMBERS
// across reboots/replugs — so a saved port id goes stale. Strip it to match on the stable device name.
export const stripSeqId = (s: string): string => s.replace(/\s+\d+:\d+$/, '').trim();
function findPort(p: PortLister, id: string): number {
  for (let i = 0; i < p.getPortCount(); i++) if (p.getPortName(i) === id) return i; // exact
  for (let i = 0; i < p.getPortCount(); i++) {
    const n = p.getPortName(i);
    if (n.includes(id) || id.includes(n)) return i; // substring
  }
  const nid = stripSeqId(id); // ALSA seq id renumbered → match on the stable name
  for (let i = 0; i < p.getPortCount(); i++) if (stripSeqId(p.getPortName(i)) === nid) return i;
  return -1;
}

/** All MIDI ports visible to the OS — inputs and outputs listed SEPARATELY (USB-MIDI devices like
 *  the Axe-Fx III / FM9 expose distinct In and Out endpoints), Fractal ones flagged. */
export function listMidiPorts(): MidiPortInfo[] {
  const out: MidiPortInfo[] = [];
  const m = midi();
  if (!m) return out; // MIDI native binding unavailable → no MIDI ports (serial still works)
  const collect = (p: PortLister, dir: 'input' | 'output') => {
    for (let i = 0; i < p.getPortCount(); i++) {
      const name = p.getPortName(i);
      if (name) out.push({ id: name, label: name, fractal: FRACTAL_RE.test(name), dir });
    }
  };
  let inp: MidiInput | null = null;
  let outp: MidiOutput | null = null;
  try {
    inp = new m.Input();
    outp = new m.Output();
    collect(inp, 'input');
    collect(outp, 'output');
  } catch (e) {
    console.warn(`[forgefx] MIDI port enumeration failed: ${(e as Error).message}`);
  } finally {
    inp?.destroy();
    outp?.destroy();
  }
  return out;
}

export class MidiTransport implements Transport {
  #in: MidiInput | null = null;
  #out: MidiOutput | null = null;
  #handlers = new Set<(frame: number[]) => void>();
  readonly kind = 'midi' as const;
  /** A Fractal-named MIDI endpoint (Axe-Fx III / FM9) is the device's own fast USB-MIDI port; anything
   *  else is a generic interface bridging to 5-pin DIN (≈31.25 kbaud) → a slow link. */
  readonly slow: boolean;
  readonly label: string;
  #inId: string;
  #outId: string;

  /** Open a USB-MIDI device by its (independent) input + output port names. */
  constructor(inId: string, outId: string) {
    this.#inId = inId;
    this.#outId = outId;
    this.label = inId === outId ? inId : `${inId} ⇄ ${outId}`;
    this.slow = !FRACTAL_RE.test(inId) && !FRACTAL_RE.test(outId);
  }

  async open(): Promise<void> {
    if (this.#in && this.#out) return;
    const m = midi();
    if (!m) throw new Error('MIDI transport unavailable (native binding @julusian/midi not loaded)');
    const inp = new m.Input();
    const out = new m.Output();
    const ii = findPort(inp, this.#inId);
    const oi = findPort(out, this.#outId);
    if (ii < 0 || oi < 0) {
      const ins = Array.from({ length: inp.getPortCount() }, (_, i) => inp.getPortName(i));
      const outs = Array.from({ length: out.getPortCount() }, (_, i) => out.getPortName(i));
      inp.destroy();
      out.destroy();
      console.warn(`[forgefx][midi] open failed — port not found: in="${this.#inId}"(${ii}) out="${this.#outId}"(${oi}); available in=${JSON.stringify(ins)} out=${JSON.stringify(outs)}`);
      throw new Error(`MIDI port not found: in="${this.#inId}" (${ii}) / out="${this.#outId}" (${oi})`);
    }
    inp.ignoreTypes(false, true, true); // RECEIVE SysEx (ignored by default)
    // The incoming-SysEx buffer defaults to 2048 bytes, which TRUNCATES larger messages. Gen-3 preset
    // dumps arrive as ~3082-byte 0x78 chunks (Axe-Fx III / FM9 6x14 presets) — at the default they were
    // silently cut to 2048, so the dump's Huffman body was incomplete and the grid/blocks decode threw
    // (FM3 chunks are smaller, so the FM3 was unaffected — which is why only the III showed an empty grid).
    // 16 KB per message with extra buffers comfortably holds the largest chunk and the 18-chunk dump burst.
    inp.setBufferSize(16384, 16);
    inp.on('message', (_dt, msg) => {
      if (msg[0] === SYSEX_START) {
        const frame = msg as number[];
        this.#logTap('RX', frame);
        console.log(`[forgefx][midi] RX ${frame.length}B: ${frame.slice(0, 64).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${frame.length > 64 ? '…' : ''}`);
        for (const h of this.#handlers) h(frame);
      }
    });
    try {
      inp.openPort(ii);
      out.openPort(oi);
    } catch (e) {
      // Windows MIDI is exclusive: if another app (Axe-Edit III, a DAW) holds the port, openPort throws.
      inp.destroy();
      out.destroy();
      console.warn(`[forgefx][midi] openPort failed (port busy / held by another app?): ${(e as Error).message}`);
      throw e;
    }
    this.#in = inp;
    this.#out = out;
    console.log(`[forgefx][midi] opened: in="${this.#inId}"(${ii}) out="${this.#outId}"(${oi})`);
  }

  async close(): Promise<void> {
    try {
      this.#in?.closePort();
      this.#in?.destroy();
    } catch {
      /* */
    }
    try {
      this.#out?.closePort();
      this.#out?.destroy();
    } catch {
      /* */
    }
    this.#in = null;
    this.#out = null;
  }

  get isOpen(): boolean {
    return !!(this.#in && this.#out);
  }

  send(bytes: readonly number[]): void {
    if (!this.#out) throw new Error('midi port not open');
    this.#logTap('TX', bytes);
    console.log(`[forgefx][midi] TX ${bytes.length}B: ${bytes.slice(0, 64).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${bytes.length > 64 ? '…' : ''}`);
    this.#out.send([...bytes]);
  }

  onFrame(handler: (frame: number[]) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  // requests run one at a time (shared MIDI stream), same contract as the serial transport
  #chain: Promise<unknown> = Promise.resolve();
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    const task = () => this.#once(bytes, opts);
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }
  sendQueued(bytes: readonly number[], settleMs = 20): Promise<void> {
    const task = () =>
      new Promise<void>((resolve) => {
        this.send(bytes);
        setTimeout(resolve, settleMs);
      });
    const p = this.#chain.then(task, task);
    this.#chain = p.then(
      () => {},
      () => {}
    );
    return p;
  }
  #once(bytes: readonly number[], { timeoutMs = 1500, quietMs = 90, match }: RequestOpts = {}): Promise<number[][]> {
    return new Promise((resolve) => {
      const frames: number[][] = [];
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let hardTimer: ReturnType<typeof setTimeout> | null = null;
      let drainingLate = false;
      const clear = () => {
        if (quietTimer) clearTimeout(quietTimer);
        if (hardTimer) clearTimeout(hardTimer);
        this.#handlers.delete(handler);
      };
      const finish = () => { clear(); resolve(frames); };
      const armQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      const handler = (frame: number[]) => {
        if (drainingLate) {
          console.warn(`[forgefx][midi] late RX after timeout fn=0x${(frame[5] ?? 0).toString(16)} len=${frame.length}`);
          armQuiet();
          return;
        }
        frames.push(frame);
        if (match?.(frames)) return finish();
        // A matched request has a concrete response owner. Do not let unrelated stale frames quiet-complete
        // it; that releases the queue before the real reply arrives and poisons the next request.
        if (!match) armQuiet();
      };
      hardTimer = setTimeout(() => {
        if (!match) return finish();
        drainingLate = true;
        console.warn(`[forgefx][midi] request timeout fn=0x${(bytes[5] ?? 0).toString(16)} frames=${frames.length}; draining late RX`);
        armQuiet();
      }, timeoutMs);
      this.#handlers.add(handler);
      this.send(bytes);
    });
  }

  #tapPath: string | null = process.env.FORGEFX_TAP ? (process.env.FORGEFX_TAP === '1' ? 'tap.log' : process.env.FORGEFX_TAP) : null;
  #logTap(dir: 'RX' | 'TX', bytes: readonly number[]) {
    if (!this.#tapPath) return;
    try {
      appendFileSync(this.#tapPath, `${Date.now()} ${dir} ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
    } catch {
      /* best-effort */
    }
  }
}
