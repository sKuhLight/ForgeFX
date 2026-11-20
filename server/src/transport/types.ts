// A Fractal device transport — serial (FM3 CDC) or USB-MIDI (Axe-Fx III, and FM9-if-MIDI).
// Both carry the same gen-3 SysEx frames; the device layer is transport-agnostic.
export interface RequestOpts {
  /** Hard cap on the wait for the reply (default 1500 ms). */
  timeoutMs?: number;
  /** Quiet gap after the last OWNED frame that ends the exchange (default 90 ms). Without `match` every
   *  frame is owned (classic quiet-gap collection); with `match` see `owns`. */
  quietMs?: number;
  /** The reply is complete: resolve now with every frame collected so far. With a `match`, frames the request
   *  does not own (a late reply to an earlier request, unsolicited traffic) are still collected but never end
   *  the exchange — only `match`, an owned frame's quiet gap, or the hard timeout do. */
  match?: (frames: number[][]) => boolean;
  /** With `match`: frames that belong to this exchange without completing it (the pieces of a multi-frame
   *  reply). Each one (re)arms the quiet gap, so a reply that ends without satisfying `match` (a lost
   *  terminator) completes after `quietMs` instead of the full timeout. The device's 0x64 result frame that
   *  echoes this request's function byte is always owned. */
  owns?: (frame: number[]) => boolean;
  /** With `match`: the request normally gets NO reply and `match` recognises only a refusal (a write the device
   *  answers with silence on success). Silence until `timeoutMs` is then the success outcome: the request
   *  resolves at the timeout without a timeout warning and without holding the link for a late reply. */
  rejectOnly?: boolean;
}

export interface Transport {
  /** Human-readable identifier (serial path or MIDI port name) for display. */
  readonly label: string;
  readonly kind: ConnKind;
  /** True for a bandwidth-constrained link that can't sustain high-rate polling (live meters). This is a
   *  generic MIDI interface into a device's 5-pin DIN (≈31.25 kbaud) — NOT a device's own fast USB-MIDI
   *  endpoint (Axe-Fx III / FM9), which is full USB speed. Serial (USB CDC) is always fast. */
  readonly slow: boolean;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Fire-and-forget single SysEx frame. */
  send(bytes: readonly number[]): void;
  /** Serialized fire-and-forget (won't inject mid-read). */
  sendQueued(bytes: readonly number[], settleMs?: number): Promise<void>;
  /** Serialized large paced send (chunked) for big payloads like a preset-dump → edit buffer.
   *  Optional: transports that don't need pacing (USB-MIDI) can omit it; callers fall back to sendQueued. */
  sendPaced?(bytes: readonly number[], chunk?: number, delayMs?: number): Promise<void>;
  /** Send a request and collect reply frames (serialized against other requests; completion rules on
   *  `RequestOpts`). When the hard timeout passes with NO frame at all, a transport either resolves `[]` (the
   *  Node serial/MIDI transports) or rejects with an error whose `code` is `TRANSPORT_TIMEOUT_CODE` (the
   *  browser-direct ones) — callers that care use `isTransportTimeout()`, never the message text. A request
   *  with a `match` (and not `rejectOnly`) that times out answers its caller at the timeout but keeps the link
   *  for a short, bounded drain, so its late reply cannot land in the next request (transport/requestQueue.ts). */
  request(bytes: readonly number[], opts?: RequestOpts): Promise<number[][]>;
  /** Subscribe to every inbound SysEx frame; returns an unsubscribe fn. */
  onFrame(handler: (frame: number[]) => void): () => void;
}

/** `Error.code` of a `request()` that timed out without receiving any frame (Node's ETIMEDOUT spelling). */
export const TRANSPORT_TIMEOUT_CODE = 'ETIMEDOUT';
/** True for a request-timeout error as described on `Transport.request`. Matches the typed `code` only. */
export function isTransportTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === TRANSPORT_TIMEOUT_CODE;
}

export type ConnKind = 'serial' | 'midi';
/**
 * A selectable connection. Serial (FM3) is one bidirectional port (`id` = path). USB-MIDI devices
 * (Axe-Fx III / FM9) expose INPUT and OUTPUT as independent endpoints with possibly different names
 * — confirmed against FM9-Edit / Axe-Edit III, which select an Input Port and an Output Port
 * separately — so MIDI carries `inId` + `outId` (the input/output port names). `id` is a display key.
 */
export interface Conn {
  transport: ConnKind;
  id: string;
  /** MIDI input port name (USB-MIDI only). */
  inId?: string;
  /** MIDI output port name (USB-MIDI only). */
  outId?: string;
}
