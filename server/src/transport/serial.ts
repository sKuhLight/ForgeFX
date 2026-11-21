// FM3 (gen-3 Fractal) serial transport. The device exposes a USB CDC serial
// endpoint (interface if03) that carries raw SysEx frames — the same path the
// retired C# ForgeFX used. fractal-midi builds/parses the SysEx; this layer just
// does framed serial I/O with request/response correlation.
import { SerialPort } from 'serialport';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';
import type { Transport, RequestOpts } from './types.js';
import { RequestQueue, pacedWrite } from './requestQueue.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const BY_ID_DIR = '/dev/serial/by-id';

/** The part of a `SerialPort` the transport uses (so tests can hand in a fake port — no hardware). */
export interface SerialPortLike {
  readonly isOpen: boolean;
  on(event: 'data', listener: (buf: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(data: Buffer): unknown;
  close(callback: () => void): unknown;
}

export interface TransportOpts {
  /** explicit device path; otherwise auto-detected */
  path?: string;
  baudRate?: number;
  /** Port factory (default: a real `SerialPort`). Tests pass a fake. */
  openPort?: (opts: { path: string; baudRate: number }, onOpen: (err: Error | null) => void) => SerialPortLike;
}

/** Resolve the device path. An explicit FORGEFX_SERIAL wins (e.g. /dev/fm3 in Docker); otherwise
 * prefer the stable by-id Fractal if03 node (survives ttyACM renumbering), then fall back to ttyACM0. */
export function autoDetectPath(): string | null {
  const env = process.env.FORGEFX_SERIAL;
  if (env && existsSync(env)) return env;
  try {
    if (existsSync(BY_ID_DIR)) {
      const hit = readdirSync(BY_ID_DIR).find((n) => /Fractal/i.test(n) && /if03/i.test(n));
      if (hit) return `${BY_ID_DIR}/${hit}`;
    }
  } catch {
    /* fall through */
  }
  return existsSync('/dev/ttyACM0') ? '/dev/ttyACM0' : null;
}

// Fractal Audio USB vendor id (hex string as serialport reports it) — identical on every OS.
const FRACTAL_VID = '2466';
// Known product ids (hex) → model, for the ports diagnostic. Detection keys on the VID, not these,
// so an unlisted model still detects (and the fn 0x00 handshake names it precisely after connecting).
const FRACTAL_PIDS: Record<string, string> = { '8003': 'Axe-Fx II', '8010': 'Axe-Fx III', '8011': 'FM3', '8012': 'FM9' };
export interface FractalPortInfo {
  path: string;
  model?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  friendlyName?: string;
}
const looksFractal = (p: FractalPortInfo): boolean =>
  (p.vendorId ?? '').toLowerCase() === FRACTAL_VID ||
  /fractal/i.test(p.manufacturer ?? '') ||
  /fractal/i.test(p.pnpId ?? '') ||
  /fractal/i.test(p.friendlyName ?? '');
// gen-3 units expose several CDC interfaces; interface 3 (if03 on Linux/macOS, MI_03 on Windows)
// carries the MIDI/SysEx stream — the others are audio/control and won't answer SysEx.
const isMidiIface = (p: FractalPortInfo): boolean =>
  /if0?3\b/i.test(p.pnpId ?? '') || /MI_0?3/i.test(p.pnpId ?? '') || /if0?3\b/i.test(p.path);

export type SerialPortInfo = FractalPortInfo & { fractal: boolean };
/** Every serial port on the system (for the manual picker), with Fractal nodes flagged. */
export async function listAllPorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => {
      const info: FractalPortInfo = { path: p.path, model: FRACTAL_PIDS[(p.productId ?? '').toLowerCase()], manufacturer: p.manufacturer, vendorId: p.vendorId, productId: p.productId, pnpId: p.pnpId, friendlyName: (p as { friendlyName?: string }).friendlyName };
      return { ...info, fractal: looksFractal(info) };
    });
  } catch {
    return [];
  }
}
/** Just the Fractal serial nodes (USB VID 2466), Windows COM / macOS cu.usbmodem / Linux ttyACM. */
export async function listFractalPorts(): Promise<FractalPortInfo[]> {
  return (await listAllPorts()).filter((p) => p.fractal);
}

/** Resolve the device path on any OS. Explicit FORGEFX_SERIAL wins; else the Fractal USB device,
 *  preferring its MIDI interface (if03 / MI_03); else the legacy Linux by-id / ttyACM0 fallbacks. */
export async function detectPath(): Promise<string | null> {
  const env = process.env.FORGEFX_SERIAL;
  if (env && existsSync(env)) return env;
  const all = await listAllPorts();
  let fractal = all.filter((p) => p.fractal);
  // macOS lists both /dev/tty.* and /dev/cu.* for one node — keep only the callout (cu) device
  fractal = fractal.filter((p) => !(p.path.startsWith('/dev/tty.') && fractal.some((q) => q.path === p.path.replace('/dev/tty.', '/dev/cu.'))));
  if (fractal.length) {
    let pick = fractal.find(isMidiIface);
    // macOS often omits the interface tag in pnpId — when several Fractal nodes exist, prefer the
    // one whose device name ends in interface index 3 (the MIDI CDC); else just take the first.
    if (!pick && process.platform === 'darwin' && fractal.length > 1) pick = fractal.find((p) => /3$/.test(p.path));
    pick = pick ?? fractal[0];
    if (pick) return pick.path;
  }
  try {
    if (existsSync(BY_ID_DIR)) {
      const hit = readdirSync(BY_ID_DIR).find((n) => /Fractal/i.test(n) && /if03/i.test(n));
      if (hit) return `${BY_ID_DIR}/${hit}`;
    }
  } catch {
    /* */
  }
  return existsSync('/dev/ttyACM0') ? '/dev/ttyACM0' : null;
}

export class FractalSerial implements Transport {
  #port: SerialPortLike | null = null;
  #rx: number[] = [];
  #frameHandlers = new Set<(frame: number[]) => void>();
  readonly kind = 'serial' as const;
  readonly slow = false; // USB CDC serial is a fast link
  readonly path: string;
  get label(): string {
    return this.path;
  }

  constructor(opts: TransportOpts = {}) {
    const path = opts.path ?? autoDetectPath();
    if (!path) throw new Error('No FM3 serial port found (looked for by-id Fractal if03, then /dev/ttyACM0)');
    this.path = path;
    this.#baud = opts.baudRate ?? 115200;
    this.#openPort = opts.openPort ?? ((o, onOpen) => new SerialPort(o, onOpen));
  }
  #baud: number;
  #openPort: NonNullable<TransportOpts['openPort']>;

  // ── capture tap (FORGEFX_TAP=1 → ./tap.log, or FORGEFX_TAP=/path) ──
  // Timestamps every RX/TX SysEx frame so we can diff FM3-Edit traffic (CPU + tuner discovery).
  #tapPath: string | null = process.env.FORGEFX_TAP ? (process.env.FORGEFX_TAP === '1' ? 'tap.log' : process.env.FORGEFX_TAP) : null;
  #logTap(dir: 'RX' | 'TX', bytes: readonly number[]) {
    if (!this.#tapPath) return;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    try {
      appendFileSync(this.#tapPath, `${Date.now()} ${dir} ${hex}\n`);
    } catch {
      /* tap is best-effort */
    }
  }

  async open(): Promise<void> {
    if (this.#port?.isOpen) return;
    await new Promise<void>((resolve, reject) => {
      const port = this.#openPort({ path: this.path, baudRate: this.#baud }, (err) => (err ? reject(err) : resolve()));
      port.on('data', (buf: Buffer) => this.#ingest(buf));
      port.on('error', () => {});
      this.#port = port;
    });
  }

  async close(): Promise<void> {
    const p = this.#port;
    this.#port = null;
    if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()));
  }

  get isOpen() {
    return !!this.#port?.isOpen;
  }

  // ── framing ──
  #ingest(buf: Buffer) {
    for (const b of buf) {
      if (b === SYSEX_START) this.#rx = [b];
      else if (this.#rx.length) {
        this.#rx.push(b);
        if (b === SYSEX_END) {
          const frame = this.#rx;
          this.#rx = [];
          this.#logTap('RX', frame);
          for (const h of this.#frameHandlers) h(frame);
        }
      }
    }
  }

  /** Fire-and-forget send of one SysEx frame. */
  send(bytes: readonly number[]): void {
    if (!this.#port?.isOpen) throw new Error('port not open');
    this.#logTap('TX', bytes);
    this.#port.write(Buffer.from(bytes));
  }

  /** Send a large payload (e.g. a full preset dump → edit buffer) in small paced chunks. The FM3's CDC
   *  serial drops bytes if flooded — the editor bridge paces at ~64 B / 3 ms, so we match that. Serialized
   *  on the request queue so it never interleaves with a read. A port that closes (or a write that throws)
   *  mid-pump rejects the send and frees the queue — it never leaves the queue waiting forever. */
  sendPaced(bytes: readonly number[], chunk = 64, delayMs = 3): Promise<void> {
    return this.#queue.serialize(() => {
      if (!this.#port?.isOpen) return Promise.reject(new Error('port not open'));
      this.#logTap('TX', bytes);
      const buf = Buffer.from(bytes);
      return pacedWrite(
        { isOpen: () => !!this.#port?.isOpen, write: (start, end) => { this.#port!.write(buf.subarray(start, end)); } },
        buf.length,
        chunk,
        delayMs
      );
    });
  }

  // serial is a single shared stream — requests MUST run one at a time, or reply frames from concurrent
  // requests interleave and corrupt each other. The queue (shared with the MIDI transport) also decides when
  // a request is complete — see transport/requestQueue.ts. Each request first drops a stale partial frame.
  #queue = new RequestQueue(
    { send: (bytes) => this.send(bytes), onFrame: (handler) => this.onFrame(handler) },
    { tag: 'serial', beforeRequest: () => { this.#rx = []; } }
  );

  /** Send a request and collect reply frames, serialized against all other requests (rules: RequestOpts). */
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    return this.#queue.request(bytes, opts);
  }

  /**
   * Fire-and-forget write, but SERIALIZED on the request queue so it never injects
   * bytes mid-read (which would corrupt a concurrent dump/bulk-read). Resolves after
   * a short settle so any echo is drained before the next request collects.
   */
  sendQueued(bytes: readonly number[], settleMs = 20): Promise<void> {
    return this.#queue.sendQueued(bytes, settleMs);
  }

  onFrame(handler: (frame: number[]) => void): () => void {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }
}
