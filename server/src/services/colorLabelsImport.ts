// FM3-Edit preset-color import — parses `color-assignments*.dat`, the file FM3-Edit (and sibling
// Fractal editors) write next to `effectDefinitions_*.cache` when the user right-clicks a preset in
// the Preset Picker and assigns it one of 6 fixed colors (Red/Orange/Yellow/Green/Blue/Purple).
//
// Browser-safe (no node:fs) — pure byte parsing, so it can live in the runtime import graph the same
// way editorCacheImport.ts does; the Node-only disk walk stays in editorCacheDiscovery.ts.
//
// Byte layout (reverse-engineered from a real ~2265-byte file; see replicated-purring-bachman plan):
//   uint32 LE  version (e.g. 0x00010001)
//   uint32 LE  reserved
//   uint32 LE  reserved
//   uint16 LE  reserved
//   uint32 LE  groupCount                  // 6 in every FM3-Edit install
//   repeat groupCount times:
//     uint32 LE  color as 0xAARRGGBB
//     uint32 LE  presetCount
//     repeat presetCount times:
//       uint32 LE  nameLen
//       byte[nameLen] name (UTF-8, no terminator)
// The real file has 2 trailing bytes after the last name (ASCII `_F` in the one file inspected —
// purpose unconfirmed). Parsing must NOT validate the buffer's exact total length: ignore whatever
// follows the last declared name so an unexpected trailing field in a future file doesn't break this.

export interface ColorAssignmentGroup { hex: string; names: string[] }
export interface ColorAssignmentsResult { groups: ColorAssignmentGroup[] }

const HEADER_LEN = 4 + 4 + 4 + 2 + 4; // version, reserved, reserved, reserved(u16), groupCount

class Cursor {
  #view: DataView;
  #len: number;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#len = bytes.byteLength;
  }
  need(n: number): void {
    if (this.pos + n > this.#len) throw new Error(`unexpected end of file at byte ${this.pos} (need ${n} more)`);
  }
  u16(): number { this.need(2); const v = this.#view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.#view.getUint32(this.pos, true); this.pos += 4; return v; }
  bytes(n: number): Uint8Array { this.need(n); const v = new Uint8Array(this.#view.buffer, this.#view.byteOffset + this.pos, n); this.pos += n; return v; }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Parse a `color-assignments*.dat` buffer into its 6 color groups + preset names. Throws a clear
 *  error on malformed input (truncated / bad structure) — the route maps that to 422. Any bytes
 *  after the last declared name are ignored (never validated against the buffer's total length). */
export function parseColorAssignments(bytes: Uint8Array): ColorAssignmentsResult {
  if (bytes.byteLength < HEADER_LEN) {
    throw new Error(`color-assignments file too short: ${bytes.byteLength} bytes, need at least ${HEADER_LEN}`);
  }
  const c = new Cursor(bytes);
  c.u32(); // version
  c.u32(); // reserved
  c.u32(); // reserved
  c.u16(); // reserved
  const groupCount = c.u32();
  if (groupCount > 64) throw new Error(`implausible groupCount ${groupCount}`);

  const groups: ColorAssignmentGroup[] = [];
  for (let i = 0; i < groupCount; i++) {
    const color = c.u32();
    const hex = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
    const presetCount = c.u32();
    if (presetCount > 100_000) throw new Error(`implausible presetCount ${presetCount} in group ${i}`);
    const names: string[] = [];
    for (let j = 0; j < presetCount; j++) {
      const nameLen = c.u32();
      if (nameLen > 4096) throw new Error(`implausible nameLen ${nameLen} in group ${i} preset ${j}`);
      names.push(utf8.decode(c.bytes(nameLen)));
    }
    groups.push({ hex, names });
  }
  // Trailing bytes (if any) are intentionally ignored — no length check against bytes.byteLength.
  return { groups };
}
