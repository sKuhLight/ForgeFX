// Axe-Fx Standard / Ultra (gen-1) driver (model byte 0x01). Gen-1 is the Fractal family's FIRST
// generation — its OWN codec (model 0x01, every field nibble-split, fixed trailer, no checksum),
// sibling to the gen-2 (Axe-Fx II, septet-packed) and gen-3 (modern, sub-action) codecs. It is
// dump-based and effectively READ-ONLY here: the whole-patch dump (fn 0x03 request → fn 0x04
// MIDI_PATCH_DUMP) ships the preset name + the 4×12 effect grid; the parameter region is opaque (a
// byte count only). So this driver mirrors the gen-2 one as the closest analog — a dump read that
// builds the grid DTO — but drives the direct gen-1 codec builders (buildGetPatchDump / parsePatchDump)
// rather than a descriptor reader (the gen-1 descriptor's reader does NOT wire the whole-patch dump).
//
// COMMUNITY-BETA, HARDWARE-UNVERIFIED: the wire is decoded byte-exactly from the published gen-1
// SysEx spec + its 0..255 conversion table; the project owns no gen-1 hardware. Scene/channel/save
// and preset switching are NOT part of gen-1's protocol, so those routes stay omitted → 501.
import {
  buildGetPatchDump,
  parsePatchDump,
  isPatchDumpResponse,
  GEN1_GRID_ROWS,
  GEN1_GRID_COLS,
} from 'forgefx-midi/gen1';
import type { Transport } from '../transport/types.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetSummary, GridCellDTO,
} from './types.js';

const MODEL_ID = 0x01;

class Gen1Driver implements DeviceDriver {
  readonly modelId = MODEL_ID;
  readonly key = 'gen1';
  readonly name = 'Axe-Fx Std/Ultra';
  readonly capabilities: DriverCapabilities = {
    // Matches the upstream gen-1 descriptor's slot_model (its SET/READ protocol has no slot
    // placement); keeping it in sync with DESCRIPTOR_BY_MODEL[0x01] keeps the caps DTO self-consistent.
    slotModel: 'linear',
    slotCount: GEN1_GRID_ROWS * GEN1_GRID_COLS,
    gridEdit: false, // gen-1 has no grid-cell write in this protocol
    scenes: 0, // gen-1 predates scenes
    channels: false, // no X/Y channels
    presetDump: false, // the dump's param region is opaque (byte count only) — not a gen-3-style decode
    presetConvert: false, // no gen-1 lift adapter (its dump decode is minimal); gen-1 is a converter TARGET only
    blockParamDecode: false,
    telemetry: { tuner: false, outputMeters: false, cpu: false, graphCurves: false },
    fcModel: false,
    fcLiveRead: false,
    modBind: false,
    cabIrs: false,
    editorLayouts: false, // gen-1 (Axe-Fx Standard/Ultra) ships no editor layouts
    supportsSave: false, // save/store is not part of the pinned gen-1 subset
    selfDescribe: false, // gen-1 predates the gen-3 self-describe protocol
    cacheImport: false, // no gen-3 editor .cache grammar for gen-1
    fullCapture: false, // no self-describe walk at all → no write-sweep full capture
    deviceEditPush: false,
    deviceEditWatch: false,
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }
  #log(s: string) { console.log(`[forgefx][gen1] ${s}`); }
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  /** One placed cell of a parsed gen-1 patch dump → the unified GridCellDTO (empty cells dropped). */
  #cellsFrom(dump: ReturnType<typeof parsePatchDump>): GridCellDTO[] {
    return dump.cells
      .filter((c) => c.effectId !== 0)
      .map((c) => ({
        row: c.row,
        col: c.col,
        effectId: c.effectId,
        name: c.blockName ?? `0x${c.effectId.toString(16)}`,
        isShunt: false,
        routeFlag: 0,
        fromRows: [] as number[],
      }));
  }

  /** The active edit buffer's 4×12 effect grid, read live via the fn 0x03 GET → fn 0x04 dump. The
   *  parameter region is not decoded (opaque per the spec), so this is grid + name + source only. */
  async grid(): Promise<PresetGridDTO> {
    const dev = await this.#openTransport();
    const req = buildGetPatchDump(undefined, MODEL_ID); // undefined = edit buffer (fully spec-pinned form)
    const frames = await dev.request(req, {
      timeoutMs: dev.slow ? 5000 : 2500,
      quietMs: dev.slow ? 300 : 120,
      match: (fs) => fs.some((f) => isPatchDumpResponse(req, f)),
    });
    const f = frames.find((x) => isPatchDumpResponse(req, x));
    if (!f) throw new Error('no MIDI_PATCH_DUMP response from the Axe-Fx (gen-1)');
    const dump = parsePatchDump(f);
    const cells = this.#cellsFrom(dump);
    this.#log(`grid "${dump.name}" (${dump.source}): ${cells.map((c) => c.name).join(', ') || '(empty)'}`);
    return { model: 'gen1', name: dump.name, crcValid: true, rows: GEN1_GRID_ROWS, cols: GEN1_GRID_COLS, scenes: [], cells, source: 'dump' };
  }

  /** Offline decode of a gen-1 patch-dump .syx (fn 0x04) → a library summary: name + the placed
   *  blocks. gen-1 has no CRC and no scenes; the param region is opaque, so no deep params. Routed by
   *  /preset/decode's model-byte dispatch (frame[4]===0x01 → the active gen-1 driver). Throws on a
   *  non-gen-1-dump frame (surfaced by the route as a 422). */
  decodePresetBytes(bytes: Uint8Array): PresetSummary {
    const dump = parsePatchDump([...bytes]);
    const blocks = dump.cells
      .filter((c) => c.effectId !== 0)
      .map((c) => ({ effectId: c.effectId, slug: null, name: c.blockName ?? `0x${c.effectId.toString(16)}`, instance: null }));
    return {
      number: 0,
      name: dump.name,
      model: 'gen1',
      crcValid: true, // gen-1 dumps carry no CRC; a successful parse is the integrity signal
      crc: 0,
      scenes: [],
      blocks,
      models: {},
      amps: [],
    };
  }
}

/** Create the Axe-Fx gen-1 driver over the shared transport. */
export function createGen1Driver(ctx: DriverCtx): Gen1Driver {
  return new Gen1Driver(ctx);
}
export type { Gen1Driver };
