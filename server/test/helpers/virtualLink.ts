// Virtual-time device link for the transport-level tests: the REAL request queue (src/transport/requestQueue.ts)
// driven by a fake link and a virtual clock — NO hardware, no wall-clock waits, millisecond-exact timing.
import { RequestQueue, type ExchangeLink, type QueueClock, type RequestQueueOpts } from '../../src/transport/requestQueue.js';
import type { ConnKind, RequestOpts, Transport } from '../../src/transport/types.js';

/** Timers in virtual time: `advanceTo` fires due timers in (time, creation) order and lets promise callbacks
 *  settle between them, so queue hand-offs happen at the virtual instant they would on a link. */
export class VirtualClock implements QueueClock {
  t = 0;
  #seq = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  now(): number {
    return this.t;
  }
  /** Run `fn` at absolute virtual time `at`. */
  at(at: number, fn: () => void): void {
    this.setTimeout(fn, at - this.t);
  }
  async advanceTo(to: number): Promise<void> {
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.#timers) if (e[1].at <= to && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await flush();
    }
    this.t = to;
    await flush();
  }
}
export const flush = () => new Promise<void>((r) => setImmediate(r));

/** A device link: records every TX with its virtual time; `emit` delivers an inbound frame. */
export class FakeLink implements ExchangeLink {
  readonly sent: { at: number; bytes: number[] }[] = [];
  readonly handlers = new Set<(frame: number[]) => void>();
  failNextSend: Error | null = null;
  constructor(readonly clock: VirtualClock) {}
  send(bytes: readonly number[]): void {
    if (this.failNextSend) {
      const e = this.failNextSend;
      this.failNextSend = null;
      throw e;
    }
    this.sent.push({ at: this.clock.t, bytes: [...bytes] });
  }
  onFrame(handler: (frame: number[]) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(frame: readonly number[]): void {
    for (const h of [...this.handlers]) h([...frame]);
  }
  /** Virtual time the n-th frame went out (undefined while it has not). */
  sentAt(n: number): number | undefined {
    return this.sent[n]?.at;
  }
}

/** A Transport whose request()/sendQueued() run on the real RequestQueue over a FakeLink — what the serial and
 *  MIDI transports do, minus the port. */
export class QueueTransport implements Transport {
  readonly label = 'virtual-link';
  readonly slow = false;
  isOpen = true;
  readonly queue: RequestQueue;
  constructor(readonly link: FakeLink, opts: Partial<RequestQueueOpts> = {}, readonly kind: ConnKind = 'serial') {
    this.queue = new RequestQueue(link, { tag: 'virtual', clock: link.clock, warn: () => {}, ...opts });
  }
  async open(): Promise<void> { this.isOpen = true; }
  async close(): Promise<void> { this.isOpen = false; }
  send(bytes: readonly number[]): void { this.link.send(bytes); }
  sendQueued(bytes: readonly number[], settleMs?: number): Promise<void> { return this.queue.sendQueued(bytes, settleMs); }
  request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]> { return this.queue.request(bytes, opts); }
  onFrame(handler: (frame: number[]) => void): () => void { return this.link.onFrame(handler); }
}

export interface Tracked<T> { done: boolean; at: number; value?: T; error?: unknown }
/** Record when (in virtual time) and how a promise settles. */
export function track<T>(clock: VirtualClock, p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false, at: -1 };
  p.then(
    (v) => { t.done = true; t.at = clock.t; t.value = v; },
    (e) => { t.done = true; t.at = clock.t; t.error = e; }
  );
  return t;
}
