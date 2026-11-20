// Request/response engine shared by the device transports (serial + USB-MIDI). A link carries one exchange
// at a time; this module owns that queue and decides when a request is complete, so the transports only do
// framing and I/O. Browser-safe on purpose (no node: imports): the runtime barrel exports it so the in-page
// transports can run the same rules.
//
// A request's life:
//   WAIT  subscribed, request sent, every inbound frame collected.
//         - `match(frames)` true                  -> deliver, release the link.
//         - an OWNED frame (below)                -> (re)arm the quiet gap; when it expires: deliver, release.
//         - any other frame                       -> collected, nothing else. A request with a `match` is
//                                                    never ended by traffic it does not own: a late reply
//                                                    to an earlier request cannot complete it.
//         - hard timeout (`timeoutMs`):
//             no `match`    -> deliver what arrived, release (the classic quiet-gap request, unchanged).
//             `rejectOnly`  -> deliver, release. Silence IS the answer of a write that only ever gets a
//                              refusal back; no warning and no drain.
//             otherwise     -> the reply is lost: deliver what arrived (same result and timing as before),
//                              warn, and go to DRAIN.
//   DRAIN the caller already has its result; only the LINK stays held, so a reply that is merely late is
//         swallowed here instead of landing in the next request. Bounded: it ends at the first of
//           - a quiet gap of min(quietMs, maxMs) with no frame,
//           - maxMs after the timeout,
//           - maxFrames late frames,
//         then releases the link (one summary warning names what was swallowed).
//
// OWNED frames: without `match`, every frame. With `match`: the device's 0x64 result frame that echoes this
// request's function byte (a refusal: a poll of an unplaced block, a GET the device does not answer), so a
// refused request still ends after the quiet gap instead of the full timeout; plus whatever `owns` accepts
// (the pieces of a multi-frame reply).
import type { RequestOpts } from './types.js';

/** The I/O a queue drives: put one frame on the wire, subscribe to inbound frames. */
export interface ExchangeLink {
  send(bytes: readonly number[]): void;
  onFrame(handler: (frame: number[]) => void): () => void;
}

/** Bound on the post-timeout drain (see the header). */
export interface LateDrainLimits {
  /** Longest the link stays held after a lost reply, counted from the timeout. */
  maxMs: number;
  /** Most late frames swallowed before the link is released anyway. */
  maxFrames: number;
}
export const LATE_DRAIN_LIMITS: Readonly<LateDrainLimits> = Object.freeze({ maxMs: 250, maxFrames: 32 });

/** Timer source (injectable so tests run in virtual time). */
export interface QueueClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
const realClock: QueueClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now()
};

export interface RequestQueueOpts {
  /** Log tag: 'serial' -> "[forgefx][serial] ...". */
  tag: string;
  /** Runs right before each request's TX (the serial transport drops a stale partial frame here). */
  beforeRequest?: () => void;
  /** Override the drain bound (defaults: LATE_DRAIN_LIMITS). */
  drain?: Partial<LateDrainLimits>;
  /** Reject a request that timed out without receiving ANY frame with this error instead of resolving `[]`
   *  (the browser-direct convention, see `Transport.request`). Never applied to a `rejectOnly` request. */
  silenceError?: (timeoutMs: number) => Error;
  warn?: (msg: string) => void;
  clock?: QueueClock;
}

/** Repeated warnings of one kind (per function byte) are coalesced to one line per interval. */
export const WARN_INTERVAL_MS = 10_000;

const FN_RESULT = 0x64;
const isFractalFrame = (f: readonly number[]): boolean => f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74;
const hexFn = (fn: number | undefined): string => `0x${(fn ?? 0).toString(16).padStart(2, '0')}`;

/** True when `frame` is the device's 0x64 result frame for `request`: Fractal header, the request's model
 *  byte, and the request's function byte echoed as the first payload byte (`[echoedFn, resultCode]`). */
export function isResultEcho(request: readonly number[], frame: readonly number[]): boolean {
  return frame.length > 8 && isFractalFrame(frame) && isFractalFrame(request)
    && frame[4] === request[4] && frame[5] === FN_RESULT && frame[6] === request[5];
}

export class RequestQueue {
  readonly #link: ExchangeLink;
  readonly #tag: string;
  readonly #beforeRequest: (() => void) | undefined;
  readonly #drain: LateDrainLimits;
  readonly #silenceError: ((timeoutMs: number) => Error) | undefined;
  readonly #warnSink: (msg: string) => void;
  readonly #clock: QueueClock;
  #chain: Promise<void> = Promise.resolve();
  #lastWarn = new Map<string, { at: number; suppressed: number }>();

  constructor(link: ExchangeLink, opts: RequestQueueOpts) {
    this.#link = link;
    this.#tag = opts.tag;
    this.#beforeRequest = opts.beforeRequest;
    this.#drain = { ...LATE_DRAIN_LIMITS, ...opts.drain };
    this.#silenceError = opts.silenceError;
    this.#warnSink = opts.warn ?? ((m) => console.warn(m));
    this.#clock = opts.clock ?? realClock;
  }

  /** Send a request and collect its reply frames, serialized against every other queued operation. */
  request(bytes: readonly number[], opts: RequestOpts = {}): Promise<number[][]> {
    return this.#enqueue<number[][]>((deliver, fail, release) => this.#exchange(bytes, opts, deliver, fail, release));
  }

  /** Fire-and-forget send, serialized so it never lands mid-exchange; resolves after `settleMs`. */
  sendQueued(bytes: readonly number[], settleMs = 20): Promise<void> {
    return this.#enqueue<void>((deliver, _fail, release) => {
      this.#link.send(bytes);
      this.#clock.setTimeout(() => {
        deliver();
        release();
      }, settleMs);
    });
  }

  /** Run `task` with the link to itself (e.g. a paced multi-chunk write). */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    return this.#enqueue<T>((deliver, fail, release) => {
      task().then(
        (v) => { deliver(v); release(); },
        (e) => { fail(e); release(); }
      );
    });
  }

  /** Queue `start`; it runs once every earlier operation has released the link. `deliver`/`fail` settle the
   *  caller's promise; `release` frees the link. They are separate so a lost reply can answer the caller on
   *  time while the link stays held for the drain. The chain itself never rejects. */
  #enqueue<T>(start: (deliver: (v: T) => void, fail: (e: unknown) => void, release: () => void) => void): Promise<T> {
    return new Promise<T>((deliver, fail) => {
      this.#chain = this.#chain.then(
        () =>
          new Promise<void>((release) => {
            try {
              start(deliver, fail, release);
            } catch (e) {
              fail(e);
              release();
            }
          })
      );
    });
  }

  #exchange(
    bytes: readonly number[],
    opts: RequestOpts,
    deliver: (frames: number[][]) => void,
    fail: (e: unknown) => void,
    release: () => void
  ): void {
    const { timeoutMs = 1500, quietMs = 90, match, owns, rejectOnly = false } = opts;
    const clock = this.#clock;
    const fn = hexFn(bytes[5]);
    const drainQuietMs = Math.max(0, Math.min(quietMs, this.#drain.maxMs));
    const frames: number[][] = [];
    const late: number[] = []; // function bytes of the frames swallowed by the drain
    let phase: 'wait' | 'drain' | 'done' = 'wait';
    let quiet: unknown = null;
    let drainCap: unknown = null;

    const armQuiet = (then: () => void, ms: number) => {
      if (quiet !== null) clock.clearTimeout(quiet);
      quiet = clock.setTimeout(then, ms);
    };
    const finish = () => {
      phase = 'done';
      clock.clearTimeout(hard);
      if (quiet !== null) clock.clearTimeout(quiet);
      if (drainCap !== null) clock.clearTimeout(drainCap);
      unsubscribe();
      release();
    };
    const answer = () => {
      if (frames.length === 0 && this.#silenceError && !rejectOnly) fail(this.#silenceError(timeoutMs));
      else deliver(frames);
    };
    const complete = () => {
      if (phase !== 'wait') return;
      deliver(frames);
      finish();
    };
    const endDrain = (capped: boolean) => {
      if (phase !== 'drain') return;
      finish();
      if (late.length > 0) {
        const fns = [...new Set(late)].map(hexFn).join(',');
        this.#warn(`late:${fn}`, `swallowed ${late.length} late frame(s) after the fn=${fn} timeout (fn ${fns})${capped ? ' — drain cap reached, link released' : ''}`);
      }
    };
    const owned = (frame: number[]) => !match || isResultEcho(bytes, frame) || (owns?.(frame) ?? false);

    const onFrame = (frame: number[]) => {
      if (phase === 'drain') {
        late.push(frame[5] ?? 0);
        if (late.length >= this.#drain.maxFrames) return endDrain(true);
        armQuiet(() => endDrain(false), drainQuietMs);
        return;
      }
      if (phase !== 'wait') return;
      frames.push(frame);
      if (match?.(frames)) return complete();
      if (owned(frame)) armQuiet(complete, quietMs);
    };

    const onTimeout = () => {
      if (phase !== 'wait') return;
      if (!match || rejectOnly) {
        answer();
        finish();
        return;
      }
      phase = 'drain';
      if (quiet !== null) clock.clearTimeout(quiet);
      quiet = null;
      answer();
      this.#warn(
        `timeout:${fn}`,
        `request fn=${fn} got no reply within ${timeoutMs} ms (${frames.length} other frame(s) seen); holding the link up to ${this.#drain.maxMs} ms for a late reply`
      );
      if (this.#drain.maxMs <= 0 || this.#drain.maxFrames <= 0) return endDrain(false);
      armQuiet(() => endDrain(false), drainQuietMs);
      drainCap = clock.setTimeout(() => endDrain(true), this.#drain.maxMs);
    };

    this.#beforeRequest?.();
    const hard = clock.setTimeout(onTimeout, timeoutMs);
    const unsubscribe = this.#link.onFrame(onFrame);
    try {
      this.#link.send(bytes);
    } catch (e) {
      phase = 'done';
      clock.clearTimeout(hard);
      if (quiet !== null) clock.clearTimeout(quiet);
      unsubscribe();
      fail(e);
      release();
    }
  }

  /** console.warn, coalesced per `key` to one line per WARN_INTERVAL_MS (a poll the device never answers
   *  would otherwise log every tick). */
  #warn(key: string, msg: string): void {
    const now = this.#clock.now();
    const last = this.#lastWarn.get(key);
    if (last && now - last.at < WARN_INTERVAL_MS) {
      last.suppressed++;
      return;
    }
    this.#lastWarn.set(key, { at: now, suppressed: 0 });
    const more = last && last.suppressed > 0 ? ` (+${last.suppressed} more like it since the last report)` : '';
    this.#warnSink(`[forgefx][${this.#tag}] ${msg}${more}`);
  }
}
