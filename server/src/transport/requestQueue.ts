// Request/response engine shared by the device transports (serial + USB-MIDI). A link carries one exchange
// at a time; this module owns that queue and decides when a request is complete, so the transports only do
// framing and I/O. Browser-safe on purpose (no node: imports): the runtime barrel exports it so the in-page
// transports can run the same rules.
//
// A request's life:
//   WAIT  subscribed, request sent, every inbound frame collected.
//         - `match(frames)` true                  -> deliver, release the link.
//         - an OWNED frame (below)                -> (re)arm the quiet gap (`quietMs`).
//         - any other frame                       -> collected, nothing else: it neither completes the
//                                                    request nor arms its quiet gap.
//         - the quiet gap expires, or the hard timeout (`timeoutMs`) passes, without `match`:
//             no `match`        -> deliver what arrived, release (the classic quiet-gap request, unchanged).
//             ANSWERED          -> the device's 0x64 result frame for this request arrived (a refusal), or
//                                  the last owned frame was one `settles` marks as the end of a reply (a dump
//                                  terminator): deliver, release. The device has finished answering.
//             `rejectOnly`      -> deliver, release: silence (or the quiet gap after an owned positive echo)
//                                  IS the answer of a write whose only meaningful reply is a refusal — no
//                                  warning, no drain.
//             otherwise         -> the reply is lost or incomplete: deliver what arrived (same result and
//                                  timing as before), warn, and go to DRAIN.
//   DRAIN the caller already has its result; only the LINK stays held, so the rest of a reply that is merely
//         late is swallowed here instead of landing in the next request. Bounded: it ends at the first of
//           - a quiet gap of clamp(quietMs, quietFloorMs, maxMs) with no frame,
//           - maxMs after the drain began,
//           - maxFrames late frames,
//         then releases the link (one summary warning names what was swallowed).
//
// OWNED frames: without `match`, every frame. With `match`: the device's 0x64 result frame that echoes this
// request's function byte (a refusal: a poll of an unplaced block, a GET the device does not answer), plus
// whatever `owns` accepts (the pieces of a multi-frame reply).
//
// What this does NOT guarantee: a reply that arrives after the drain released the link and that the next
// request's `match` accepts still completes that request. The drain only catches replies up to ~maxMs late;
// beyond that, protection comes from the matcher being specific (address / block / slot echoes, not just the
// function byte). A request whose reply carries nothing that identifies it can be answered by a late reply.
//
// REFUSALS: a 0x64 refusal carries only the function it refuses ([echoedFn, resultCode] — no sub-action, no
// address), so it cannot say WHICH request of that function it answers. It goes to the request in flight
// whenever it could be that request's answer: same model and function, and not arriving within SAME_TICK_MS
// of that request going out (too soon to be its answer — it then belongs to something earlier and is kept
// from this request). A refusal of another function is never this request's. When the request before was a
// reject-only write that was reported accepted, a same-function refusal credited to the current request is
// logged as POSSIBLY that earlier write's: misattributing it that way is the lesser evil — holding refusals
// back on timing would hide the real refusal of back-to-back writes (clear-then-place a grid cell).
import type { RequestOpts } from './types.js';

/** The I/O a queue drives: put one frame on the wire, subscribe to inbound frames. */
export interface ExchangeLink {
  send(bytes: readonly number[]): void;
  onFrame(handler: (frame: number[]) => void): () => void;
}

/** Bound on the drain (see the header). */
export interface LateDrainLimits {
  /** Longest the link stays held for a lost/incomplete reply, counted from the start of the drain. */
  maxMs: number;
  /** Most late frames swallowed before the link is released anyway. */
  maxFrames: number;
  /** Shortest drain quiet window: a short-quiet request (a 12 ms meter poll) still waits this long for a
   *  late reply before releasing the link. Capped by `maxMs`. */
  quietFloorMs: number;
}
export const LATE_DRAIN_LIMITS: Readonly<LateDrainLimits> = Object.freeze({ maxMs: 250, maxFrames: 32, quietFloorMs: 100 });

/** A refusal arriving within this many ms of a request going out cannot be that request's answer (it was on
 *  the wire already): it is kept from the request. */
export const SAME_TICK_MS = 2;

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

/** Repeated warnings of one kind (per function + sub-action) are coalesced to one line per interval. */
export const WARN_INTERVAL_MS = 10_000;

const FN_RESULT = 0x64;
const isFractalFrame = (f: readonly number[]): boolean => f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74;
const hex2 = (b: number | undefined): string => `0x${(b ?? 0).toString(16).padStart(2, '0')}`;
/** Function + sub-action of a request ("fn=0x01/0x1b"): the warning key, so different kinds of request on one
 *  function byte (GET, range read, monitor poll, store) are never folded into one line. */
const kindOf = (bytes: readonly number[]): string => `fn=${hex2(bytes[5])}${bytes.length > 8 ? `/${hex2(bytes[6])}` : ''}`;
/** The address part of a request (the bytes after the function byte) for log lines. */
const addrOf = (bytes: readonly number[]): string =>
  bytes.slice(6, Math.min(12, Math.max(6, bytes.length - 2))).map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** True when `frame` is the device's 0x64 result frame for `request`: Fractal header, the request's model
 *  byte, and the request's function byte echoed as the first payload byte (`[echoedFn, resultCode]`). */
export function isResultEcho(request: readonly number[], frame: readonly number[]): boolean {
  return frame.length > 8 && isFractalFrame(frame) && isFractalFrame(request)
    && frame[4] === request[4] && frame[5] === FN_RESULT && frame[6] === request[5];
}

/** The port a paced write drives. */
export interface PacedPort {
  isOpen(): boolean;
  /** Write bytes [start, end) of the payload. */
  write(start: number, end: number): void;
}
/** A paced, chunked write (a big preset dump into a CDC serial port that drops a flooded write). Checks the
 *  port before every chunk and REJECTS — never hangs the queue — when it closed or a write throws mid-pump. */
export function pacedWrite(port: PacedPort, length: number, chunk = 64, delayMs = 3, settleMs = 20, clock: QueueClock = realClock): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let off = 0;
    const pump = () => {
      try {
        if (!port.isOpen()) throw new Error('port not open');
        if (off >= length) {
          clock.setTimeout(resolve, settleMs); // settle before the next request
          return;
        }
        port.write(off, Math.min(off + chunk, length));
        off += chunk;
        clock.setTimeout(pump, delayMs);
      } catch (e) {
        reject(e);
      }
    };
    pump();
  });
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
  /** The last exchange, when it was a reject-only write reported accepted — only for the "possibly" warning. */
  #lastAccepted: { request: number[]; at: number } | null = null;

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

  /** Run `task` with the link to itself (e.g. a paced multi-chunk write). The link is released when the
   *  task settles, so a task must always settle (see `pacedWrite`). */
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
    const { timeoutMs = 1500, quietMs = 90, match, owns, settles, rejectOnly = false, routine = false } = opts;
    const clock = this.#clock;
    const kind = kindOf(bytes);
    const drainQuietMs = Math.min(Math.max(quietMs, this.#drain.quietFloorMs), this.#drain.maxMs);
    const frames: number[][] = [];
    const late: number[] = []; // function bytes of the frames swallowed by the drain
    const prevAccepted = this.#lastAccepted;
    this.#lastAccepted = null;
    let phase: 'wait' | 'drain' | 'done' = 'wait';
    let answered = false; // the device's 0x64 result frame for this request arrived
    let lastOwnedSettles = false; // the last owned frame ended a reply (`settles`)
    let warnedPossibly = false;
    let sentAt = clock.now();
    let quiet: unknown = null;
    let hard: unknown = null;
    let drainCap: unknown = null;
    let unsubscribe: () => void = () => {};

    const clearTimers = () => {
      for (const t of [quiet, hard, drainCap]) if (t !== null) clock.clearTimeout(t);
      quiet = hard = drainCap = null;
    };
    const armQuiet = (then: () => void, ms: number) => {
      if (quiet !== null) clock.clearTimeout(quiet);
      quiet = clock.setTimeout(then, ms);
    };
    /** Leave for good: stop every timer, unsubscribe, free the link. Idempotent. */
    const finish = () => {
      if (phase === 'done') return;
      phase = 'done';
      clearTimers();
      try {
        unsubscribe();
      } catch {
        /* a failing unsubscribe must not keep the link */
      }
      release();
    };
    /** Settle the caller with what arrived (or the silence error). Never throws. */
    const answerCaller = () => {
      try {
        if (frames.length === 0 && this.#silenceError && !rejectOnly) fail(this.#silenceError(timeoutMs));
        else deliver(frames);
      } catch (e) {
        fail(e);
      }
    };
    const endDrain = (capped: boolean) => {
      if (phase !== 'drain') return;
      finish();
      if (late.length > 0) {
        const fns = [...new Set(late)].map(hex2).join(',');
        this.#warn(`late:${kind}`, `swallowed ${late.length} late frame(s) after ${kind} [${addrOf(bytes)}] ended without its reply (fn ${fns})${capped ? ' — drain cap reached, link released' : ''}`);
      }
    };
    /** WAIT ended without `match` (quiet gap or hard timeout) — see the header for the cases. */
    const endUnmatched = (why: 'timeout' | 'quiet') => {
      if (phase !== 'wait') return;
      if (!match || answered || lastOwnedSettles) {
        answerCaller();
        finish();
        return;
      }
      if (rejectOnly) {
        answerCaller();
        this.#lastAccepted = { request: [...bytes], at: clock.now() };
        finish();
        return;
      }
      phase = 'drain';
      clearTimers();
      answerCaller();
      if (!routine || why === 'quiet') {
        this.#warn(
          `${why}:${kind}`,
          why === 'timeout'
            ? `request ${kind} [${addrOf(bytes)}] got no reply within ${timeoutMs} ms (${frames.length} other frame(s) seen); holding the link up to ${this.#drain.maxMs} ms for a late reply`
            : `request ${kind} [${addrOf(bytes)}] reply incomplete (${frames.length} frame(s), then quiet for ${quietMs} ms); holding the link up to ${this.#drain.maxMs} ms for the rest`
        );
      }
      if (this.#drain.maxMs <= 0 || this.#drain.maxFrames <= 0) return endDrain(false);
      armQuiet(() => endDrain(false), drainQuietMs);
      drainCap = clock.setTimeout(() => endDrain(true), this.#drain.maxMs);
    };
    const complete = () => {
      if (phase !== 'wait') return;
      try {
        deliver(frames);
      } finally {
        finish();
      }
    };
    /** A predicate (match / owns) threw: fail the caller with it and free the link — never let it escape into
     *  the transport's RX dispatch loop. */
    const blowUp = (e: unknown) => {
      if (phase === 'wait') fail(e);
      finish();
    };

    const onFrame = (frame: number[]) => {
      try {
        if (phase === 'drain') {
          late.push(frame[5] ?? 0);
          if (late.length >= this.#drain.maxFrames) return endDrain(true);
          armQuiet(() => endDrain(false), drainQuietMs);
          return;
        }
        if (phase !== 'wait') return;
        const echo = isResultEcho(bytes, frame);
        if (echo) {
          const into = clock.now() - sentAt;
          if (into <= SAME_TICK_MS) {
            // on the wire before this request could have been answered: an earlier request's refusal
            this.#warn(`too-soon:${kind}`, `a refusal for ${kind} arrived ${into} ms after [${addrOf(bytes)}] went out — too soon to be its answer, so it belongs to an earlier request (possibly one reported accepted); kept from this one`);
            return;
          }
          if (prevAccepted && !warnedPossibly && isResultEcho(prevAccepted.request, frame)) {
            warnedPossibly = true;
            this.#warn(`possibly:${kind}`, `a refusal for ${kind} arrived ${into} ms into [${addrOf(bytes)}] and is credited to it; it is possibly the refusal of the write before it [${addrOf(prevAccepted.request)}], reported accepted ${clock.now() - prevAccepted.at} ms earlier`);
          }
        }
        frames.push(frame);
        if (match?.(frames)) return complete();
        if (echo) answered = true;
        if (!match || echo || owns?.(frame)) {
          lastOwnedSettles = !echo && !!settles?.(frame);
          armQuiet(() => endUnmatched('quiet'), quietMs);
        }
      } catch (e) {
        blowUp(e);
      }
    };

    try {
      this.#beforeRequest?.();
      hard = clock.setTimeout(() => {
        hard = null;
        try {
          endUnmatched('timeout');
        } catch (e) {
          blowUp(e);
        }
      }, timeoutMs);
      unsubscribe = this.#link.onFrame(onFrame);
      sentAt = clock.now();
      this.#link.send(bytes);
    } catch (e) {
      // subscribing or sending failed (e.g. the port closed): the request never went out (a caller that was
      // somehow settled already keeps its answer — a promise settles once)
      fail(e);
      finish();
    }
  }

  /** console.warn, coalesced per `key` to one line per WARN_INTERVAL_MS (a request the device never answers
   *  would otherwise log every time). Never throws. */
  #warn(key: string, msg: string): void {
    try {
      const now = this.#clock.now();
      const last = this.#lastWarn.get(key);
      if (last && now - last.at < WARN_INTERVAL_MS) {
        last.suppressed++;
        return;
      }
      this.#lastWarn.set(key, { at: now, suppressed: 0 });
      const more = last && last.suppressed > 0 ? ` (+${last.suppressed} more like it since the last report)` : '';
      this.#warnSink(`[forgefx][${this.#tag}] ${msg}${more}`);
    } catch {
      /* logging must never break the queue */
    }
  }
}
