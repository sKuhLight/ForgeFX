// A Fractal device transport — serial (FM3 CDC) or USB-MIDI (Axe-Fx III, and FM9-if-MIDI).
// Both carry the same gen-3 SysEx frames; the device layer is transport-agnostic.
export interface RequestOpts {
  timeoutMs?: number;
  quietMs?: number;
  match?: (frames: number[][]) => boolean;
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
  /** Send a request and collect reply frames (serialized against other requests). When the hard
   *  timeout passes with NO frame at all, a transport either resolves `[]` (the Node serial/MIDI
   *  transports) or rejects with an error whose `code` is `TRANSPORT_TIMEOUT_CODE` (the browser-direct
   *  ones) — callers that care use `isTransportTimeout()`, never the message text. */
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
