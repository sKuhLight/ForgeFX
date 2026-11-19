// Send policy for client-supplied bytes — the checks that run BEFORE such bytes reach the transport.
//
// Covered paths:
//   • raw probes — POST /debug/raw → DeviceRegistry.rawRequest(): exactly ONE complete SysEx frame of at
//     most RAW_PROBE_MAX_BYTES that is either a read/query frame for a known Fractal model
//     (forgefx-midi/shared isQueryFrame — an allowlist; writes, dump/IR/firmware streams and update
//     opcodes are refused) or, for a connected gen-3 unit, byte-identical to one of the codec's read/poll
//     builders for that model (forgefx-midi/gen3/axe-fx-iii isGen3ReadPollFrame: tuner/CPU/meter polls,
//     tempo/scene GET, raw param-value GET 0x1B).
//   • preset-dump loads — the gen-3 driver's loadPresetBytes() (POST /preset/load and
//     /version/:id/load|restore): exactly ONE well-formed preset dump for the CONNECTED model.
//   • preset-dump restores — the shared restoreH (POST /preset/restore, /am4/preset/restore): every
//     frame must be a preset-dump frame (0x77/0x78/0x79) for the connected model.
// Every dump path also requires the bytes to split into complete 7-bit SysEx frames whose boundaries
// are exactly the dump's frames, so no frame can hide inside a chunk.
// The drivers' own codec-built traffic is not routed through here.
// NO node:/transport imports — registryCore and the drivers load in a browser.
import { DEVICE_MODELS, isFractalHeaderFrame, isQueryFrame } from 'forgefx-midi/shared';
import { isGen3ReadPollFrame } from 'forgefx-midi/gen3/axe-fx-iii';
import { parsePresetDump } from 'forgefx-midi/devices/gen3';
import { AM4_FUNC_PRESET_HEADER, AM4_FUNC_PRESET_CHUNK, AM4_FUNC_PRESET_FOOTER } from 'forgefx-midi/am4';

/** Client bytes the policy refuses: 400 = malformed / not what the route takes, 403 = not allowed. */
export class SendRejectedError extends Error {
  readonly status: 400 | 403;
  constructor(status: 400 | 403, message: string) {
    super(message);
    this.name = 'SendRejectedError';
    this.status = status;
  }
}

/** HTTP status for an error thrown by a send path: the policy's own status, else `fallback`. */
export function sendErrorStatus(e: unknown, fallback: number): number {
  return e instanceof SendRejectedError ? e.status : fallback;
}

/** Largest raw probe accepted — one frame, sent unpaced, so keep it small. */
export const RAW_PROBE_MAX_BYTES = 512;

/** Preset-dump functions (header / chunk / footer) — the same 0x77/0x78/0x79 envelope on every family. */
const PRESET_DUMP_FUNCTIONS: readonly number[] = [AM4_FUNC_PRESET_HEADER, AM4_FUNC_PRESET_CHUNK, AM4_FUNC_PRESET_FOOTER];

/** Parse a hex string (spaces, tabs and line breaks ignored) into bytes; null when missing, empty,
 *  odd-length or non-hex. */
export function parseHexBytes(hex: unknown): number[] | null {
  if (typeof hex !== 'string') return null;
  const s = hex.replace(/[ \t\r\n]+/g, '');
  if (!s.length || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/** Split `bytes` into complete SysEx frames (F0 … F7, only 7-bit data in between), or null when the
 *  bytes are anything else (stray bytes outside a frame, an unterminated frame, a nested F0, 8-bit data). */
export function splitSysexFrames(bytes: ArrayLike<number>): number[][] | null {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (!Number.isInteger(b) || b < 0 || b > 0xff) return null;
    if (b === 0xf0) { if (cur) return null; cur = [b]; continue; }
    if (!cur || (b > 0x7f && b !== 0xf7)) return null;
    cur.push(b);
    if (b === 0xf7) { frames.push(cur); cur = null; }
  }
  return cur ? null : frames;
}

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

/** Why `bytes` may not be sent as a raw probe to a unit whose model byte is `connectedModel` (-1 = not
 *  identified yet), or null when they may. */
export function rawProbeViolation(bytes: readonly number[], connectedModel: number): SendRejectedError | null {
  if (bytes.length > RAW_PROBE_MAX_BYTES) {
    return new SendRejectedError(400, `raw probe is limited to one SysEx frame of at most ${RAW_PROBE_MAX_BYTES} bytes`);
  }
  if (splitSysexFrames(bytes)?.length !== 1) {
    return new SendRejectedError(400, 'raw probe must be exactly one complete SysEx frame (F0 … F7, 7-bit data bytes)');
  }
  if (!isFractalHeaderFrame(bytes)) {
    return new SendRejectedError(403, 'raw probes are limited to Fractal frames (F0 00 01 74 <model> <function> …)');
  }
  if (isQueryFrame(bytes)) return null;
  if (DEVICE_MODELS[connectedModel]?.gen === 3 && isGen3ReadPollFrame(bytes, connectedModel)) return null;
  return new SendRejectedError(403,
    `function ${hex2(bytes[5]!)} for model ${hex2(bytes[4]!)} is not an allowed read/query frame; raw probes are ` +
    'read-only (use the typed routes for edits, POST /preset/load for preset dumps)');
}

/** Why `bytes` is not a stream of preset-dump frames for `model`, or null when it is: complete 7-bit
 *  SysEx frames, each one a Fractal 0x77/0x78/0x79 frame addressed to `model`. Structure (header first,
 *  chunk count, checksums) is the family parser's job; this guarantees no other frame can ride along —
 *  e.g. one hidden inside a chunk behind an inner F7/F0 boundary. */
export function presetDumpFramesViolation(bytes: ArrayLike<number>, model: number): SendRejectedError | null {
  const frames = splitSysexFrames(bytes);
  if (!frames || !frames.length) return new SendRejectedError(400, 'preset dump must consist of complete 7-bit SysEx frames');
  for (const f of frames) {
    if (!isFractalHeaderFrame(f) || f[4] !== model || !PRESET_DUMP_FUNCTIONS.includes(f[5]!)) {
      const what = isFractalHeaderFrame(f) ? `function ${hex2(f[5]!)} for model ${hex2(f[4]!)}` : 'a non-Fractal frame';
      return new SendRejectedError(400, `not a preset dump for the connected device (model ${hex2(model)}): contains ${what}`);
    }
  }
  return null;
}

/** Throw the policy's SendRejectedError unless `bytes` may be sent as a raw probe. */
export function assertRawProbeAllowed(bytes: readonly number[], connectedModel: number): void {
  const v = rawProbeViolation(bytes, connectedModel);
  if (v) throw v;
}

/** Validate client/store bytes as exactly ONE gen-3 preset dump (0x77 header, 0x78 chunks, 0x79 footer,
 *  checksums) addressed to `model`, and return a copy of just those frames. Throws a 400
 *  SendRejectedError otherwise — e.g. other frames before/after the dump, a bank of dumps, a dump for
 *  another model, or bytes hidden in a chunk. */
export function validatedPresetDump(syx: ArrayLike<number>, model: number): number[] {
  const bytes = Uint8Array.from(syx);
  let byteLength: number;
  try {
    byteLength = parsePresetDump(bytes, 0, model).byteLength;
  } catch (e) {
    throw new SendRejectedError(400, `not a preset dump for the connected device (model ${hex2(model)}): ${(e as Error).message}`);
  }
  if (byteLength !== bytes.length) {
    throw new SendRejectedError(400, `expected exactly one preset dump; ${bytes.length - byteLength} byte(s) follow it`);
  }
  const v = presetDumpFramesViolation(bytes, model);
  if (v) throw v;
  return Array.from(bytes);
}
