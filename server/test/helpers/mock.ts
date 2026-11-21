// Mocked transport layer for the driver/registry unit tests — NO hardware involved.
// MockTransport implements the full Transport interface from src/transport/types.ts and records
// every outgoing frame; `reply` scripts what request() answers (default: silence, i.e. []).
import type { Transport, RequestOpts, ConnKind } from '../../src/transport/types.js';

export class MockTransport implements Transport {
  readonly label: string;
  readonly kind: ConnKind;
  readonly slow = false;
  isOpen = false;
  /** Every outgoing frame, in order, across send/sendQueued/sendPaced/request. */
  readonly sent: number[][] = [];
  /** Scripted replies: request(bytes) → response frames. May return a Promise so a test can hold a
   *  request IN FLIGHT (echo-guard / interactive-yield tests). Default: no reply (device silent). */
  reply: (bytes: readonly number[]) => number[][] | Promise<number[][]> = () => [];
  /** Scripted RESPONSE to a `send()` (the AM4 Am4Conn path — its edited-bit GET_PATCH read and its
   *  fn-0x1F GET_ALL_PARAMS dumps go out via send() and the device replies asynchronously on onFrame,
   *  not via request()). When set, send() emits each returned frame back through onFrame SYNCHRONOUSLY,
   *  so a waiter/listener registered before the send (the AM4 codec always subscribes first) receives
   *  it. Default: no reply — existing suites that only use send/request are unaffected. */
  sendReply: (bytes: readonly number[]) => number[][] = () => [];

  constructor(kind: ConnKind = 'serial', label = 'mock') {
    this.kind = kind;
    this.label = label;
  }

  /** Registered inbound-frame handlers (see onFrame / emitFrame) — lets tests drive the RX path
   *  (traffic counting, edit-push bursts) that request()'s scripted replies don't cover. */
  readonly frameHandlers = new Set<(frame: number[]) => void>();

  async open(): Promise<void> { this.isOpen = true; }
  async close(): Promise<void> { this.isOpen = false; }
  send(bytes: readonly number[]): void {
    this.sent.push([...bytes]);
    for (const f of this.sendReply(bytes)) this.emitFrame(f);
  }
  async sendQueued(bytes: readonly number[], _settleMs?: number): Promise<void> { this.sent.push([...bytes]); }
  async sendPaced(bytes: readonly number[], _chunk?: number, _delayMs?: number): Promise<void> { this.sent.push([...bytes]); }
  async request(bytes: readonly number[], _opts?: RequestOpts): Promise<number[][]> {
    this.sent.push([...bytes]);
    return this.reply(bytes);
  }
  onFrame(handler: (frame: number[]) => void): () => void {
    this.frameHandlers.add(handler);
    return () => { this.frameHandlers.delete(handler); };
  }
  /** TEST HELPER: simulate an inbound SysEx frame — dispatches to every onFrame handler (the transport
   *  contract: additive fan-out, coexists with request() waiters). */
  emitFrame(bytes: readonly number[]): void {
    for (const h of this.frameHandlers) h([...bytes]);
  }
}

/** A plausible fn 0x00 handshake reply frame from a device with the given model byte. */
export function handshakeReply(modelId: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, modelId & 0x7f, 0x00];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** What a gen-3 device sends for a dump request: a dump whose 0x77 header (bytes 6-7, MSB-first 7-bit pair)
 *  names the requested slot, or — for an edit-buffer request (7F 7F) — `7F 00`, as the FM3 does (fw 13.0).
 *  Rewrites a fixture dump's header and its checksum. */
export function dumpAnswering(req: readonly number[], frames: number[][]): number[][] {
  const editBuffer = req[6] === 0x7f && req[7] === 0x7f;
  return frames.map((f) => {
    if (f[5] !== 0x77) return f;
    const g = [...f];
    g[6] = editBuffer ? 0x7f : req[6]!;
    g[7] = editBuffer ? 0x00 : req[7]!;
    let cs = 0;
    for (let i = 0; i < g.length - 2; i++) cs ^= g[i]!;
    g[g.length - 2] = cs & 0x7f;
    return g;
  });
}

/** True when `bytes` is the fn 0x00 identify broadcast (model 0x7F). */
export function isIdentifyBroadcast(bytes: readonly number[]): boolean {
  return bytes[0] === 0xf0 && bytes[4] === 0x7f && bytes[5] === 0x00;
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const hex = (f: readonly number[]) => f.map((b) => b.toString(16).padStart(2, '0')).join(' ');
