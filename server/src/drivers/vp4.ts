// VP4 driver (model byte 0x14). The VP4 is a gen-3 effects PEDAL: it reuses the gen-3 SysEx envelope +
// the III's effect codec / block effect IDs, but it is AM4-SHAPE on the front panel — a serial 4-slot
// chain (NOT the gen-3 6×14 grid), with 4 scenes, A-D channels, A01..Z04 locations, and no amp/cab.
//
// Reads go through the shared gen-3 descriptor reader (VP4_DESCRIPTOR.reader.getPreset) over the
// descriptorConn bridge, serialized behind #withReader. Writes use the VP4-specific wire builders
// (buildVp4SetParam / buildVp4SetBypass / buildVp4Save — their own frame shape: no sub-action, a `tc`
// sub-opcode, a swapped-septet float). COMMUNITY-BETA, UNTESTED ON HARDWARE:
//   - grid() lists the blocks the device REPORTS as present, in DISCOVERY ORDER — NOT their true
//     physical slot position. The gen-3 grid-layout read has no VP4 4-slot geometry, so real placement
//     is not decodable; two presets with the same blocks in different slots render identically.
//   - Only continuous set_param, set_bypass, and save are decoded (byte-exact from a community capture,
//     fw 4.03). Discrete/enum set_param, block placement, scene switch, preset select, and rename are
//     GENUINELY UNDECODED and are OMITTED (their routes answer 501).
import {
  buildVp4SetParam,
  buildVp4SetBypass,
  buildVp4Save,
  buildVp4GetStructureBlob,
  parseVp4StructureBlob,
  VP4_PARAMS,
  type Vp4StructureBlob,
} from 'forgefx-midi/gen3/vp4';
import { VP4_DESCRIPTOR, slugForEffectId } from 'forgefx-midi/devices/gen3';
import { resolveBlock } from 'forgefx-midi/gen3/axe-fx-iii';
import type { DispatchCtx, PresetSnapshot } from 'forgefx-midi/core';
import { dispatchCtx } from './descriptorConn.js';
import type { Transport } from '../transport/types.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetBlockDTO, NamedParam, EnumParam,
} from './types.js';

const MODEL_ID = 0x14;
const SLOT_COUNT = 4;

// name → VP4 param metadata (for the display label). VP4 params are all uncalibrated ('unverified'),
// so every knob is a bare opaque continuous control — no ranges, no enums.
const VP4_PARAM_BY_NAME = new Map<string, { name: string; displayLabel?: string }>(
  (VP4_PARAMS as ReadonlyArray<{ name: string; displayLabel?: string }>).map((p) => [p.name, p]),
);
function paramLabel(name: string): string {
  const p = VP4_PARAM_BY_NAME.get(name);
  if (p?.displayLabel) return p.displayLabel;
  return name.replace(/^[A-Z]+_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

class Vp4Driver implements DeviceDriver {
  readonly modelId = MODEL_ID;
  readonly key = 'vp4';
  readonly name = 'VP4';
  readonly capabilities: DriverCapabilities = {
    slotModel: 'linear',
    slotCount: SLOT_COUNT,
    gridEdit: false, // block placement (set_block) is undecoded → no placeCell → route 501
    scenes: 4,
    channels: false, // A-D exist but channel-switch writes are undecoded; reads use channel A only
    presetDump: false,
    presetConvert: true, // skeleton lift (name + scenes + 4-slot chain identity) via readStructure()
    blockParamDecode: false,
    telemetry: { tuner: false, outputMeters: false, cpu: false, graphCurves: false },
    fcModel: false,
    fcLiveRead: false,
    modBind: false,
    cabIrs: false,
    editorLayouts: false, // no VP4 editor layouts shipped yet
    supportsSave: true, // save is allowlisted (byte-exact captured; community-beta)
    // gen-3 self-describe is expected to work over the VP4's shared codec but is hardware-unverified —
    // keep the on-connect cache build off until a VP4 walk is captured, then flip this to true.
    selfDescribe: false,
    cacheImport: false, // paired with selfDescribe — flip both on once a VP4 walk is captured
    // FULL-mode walk WRITES to sweep tapers. The VP4's write path is community-beta / allowlist-gated
    // (the factory-reset incident that keeps selfDescribe off), so full capture stays OFF — never
    // sweep-write an unverified unit. Flip on only after a hardware-captured VP4 walk.
    fullCapture: false,
    deviceEditPush: false,
    deviceEditWatch: false,
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }
  #log(s: string) { console.log(`[forgefx][vp4] ${s}`); }
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  // ── reader plumbing (mirrors the AM4 / gen2 drivers) ──────────────────────────────────────────
  #reader = VP4_DESCRIPTOR.reader;
  #readerLock: Promise<unknown> = Promise.resolve();
  #presetCache: { snap: PresetSnapshot; at: number } | null = null;
  #structureCache: { blob: Vp4StructureBlob; at: number } | null = null;
  static #PRESET_TTL_MS = 500;
  #lastTransport: Transport | null = null;

  async #withReader<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#readerLock.then(fn, fn);
    this.#readerLock = run.catch(() => undefined);
    return run;
  }
  #dispatchCtx(): DispatchCtx { return dispatchCtx(VP4_DESCRIPTOR, this.#lastTransport!); }

  async readPreset(): Promise<PresetSnapshot | null> {
    const now = Date.now();
    if (this.#presetCache && now - this.#presetCache.at < Vp4Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
    return this.#withReader(async () => {
      const t = Date.now();
      if (this.#presetCache && t - this.#presetCache.at < Vp4Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
      this.#lastTransport = await this.#openTransport();
      try {
        const snap = await this.#reader.getPreset!(this.#dispatchCtx(), {});
        this.#presetCache = { snap, at: Date.now() };
        this.#log(`readPreset: ${snap.slots.length} block(s) present (discovery order)`);
        return snap;
      } catch (e) {
        this.#log(`readPreset failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }
  #invalidate() { this.#presetCache = null; this.#structureCache = null; }

  /** True when `f` is a well-formed VP4 structure-blob response (parseVp4StructureBlob accepts it). */
  #isStructure(f: number[]): boolean {
    try { parseVp4StructureBlob(f); return true; } catch { return false; }
  }

  /** Read the whole-preset STRUCTURE blob (eid206 pid0 tc=0x1f): preset + scene names, current scene,
   *  and the TRUE 4-slot serial chain (effect IDs in physical slot order — unlike the discovery-order
   *  block inventory getPreset returns). One read = the register VP4-Edit itself polls to render the
   *  chain. TTL-cached; null on a silent/malformed response so grid() falls back to the legacy read. */
  async readStructure(): Promise<Vp4StructureBlob | null> {
    const now = Date.now();
    if (this.#structureCache && now - this.#structureCache.at < Vp4Driver.#PRESET_TTL_MS) return this.#structureCache.blob;
    const dev = await this.#openTransport();
    try {
      const req = buildVp4GetStructureBlob();
      const frames = await dev.request(req, {
        timeoutMs: dev.slow ? 4000 : 1500,
        quietMs: dev.slow ? 300 : 120,
        match: (fs) => fs.some((f) => this.#isStructure(f)),
      });
      const f = frames.find((x) => this.#isStructure(x));
      if (!f) { this.#log('readStructure: no structure-blob response'); return null; }
      const blob = parseVp4StructureBlob(f);
      this.#structureCache = { blob, at: Date.now() };
      this.#log(`readStructure: "${blob.presetName}" scene ${blob.currentSceneDisplay}, chain [${blob.chain.map((c) => c?.name ?? '—').join(', ')}]`);
      return blob;
    } catch (e) {
      this.#log(`readStructure failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** slug → wire effectId (gen-3 first-instance effect ID). null when the block isn't in the roster. */
  #eidFor(slug: string): number | null {
    return resolveBlock(slug)?.firstId ?? null;
  }

  /** The block present at effectId `eid` (matched via slug), from the cached snapshot. */
  #slotForEid(snap: PresetSnapshot | null, eid: number): PresetSnapshot['slots'][number] | undefined {
    return snap?.slots.find((s) => this.#eidFor(s.block_type) === eid);
  }

  /** 1×4 linear grid DTO. PREFERS the whole-preset structure blob (readStructure): it carries the
   *  TRUE serial chain (physical slot order), the preset name, the four scene names, and the current
   *  scene — so scenes are finally populated and slot placement is real, not discovery order. Falls
   *  back to the legacy block-inventory read (discovery order, no scene names — see the file header)
   *  when the structure register is unavailable. */
  async grid(): Promise<PresetGridDTO> {
    const st = await this.readStructure();
    if (st) {
      const cells = st.chain.flatMap((slot, i) => {
        if (!slot) return [];
        const slug = slugForEffectId(slot.effectId) ?? slot.name ?? `0x${slot.effectId.toString(16)}`;
        const name = slot.name ?? slug;
        return [{ row: 0, col: i, effectId: slot.effectId, name, isShunt: false, routeFlag: 0, fromRows: [] as number[], slug }];
      });
      this.#log(`grid (structure): "${st.presetName}" — ${cells.map((c) => c.name).join(', ') || '(empty)'}`);
      return { model: 'vp4', name: st.presetName, crcValid: true, rows: 1, cols: SLOT_COUNT, scenes: [...st.sceneNames], cells, source: 'dump' };
    }
    const snap = await this.readPreset();
    const live = (snap as unknown as { live_grid?: { effect_id: number; row: number; col: number; is_shunt: boolean }[] } | null)?.live_grid;
    let cells;
    if (live && live.length) {
      cells = live.filter((c) => !c.is_shunt).map((c) => ({
        row: 0, col: c.col, effectId: c.effect_id, name: this.#nameForEid(c.effect_id),
        isShunt: false, routeFlag: 0, fromRows: [] as number[], slug: this.#slugForEid(c.effect_id),
      }));
    } else {
      cells = (snap?.slots ?? []).flatMap((s, i) => {
        const eid = this.#eidFor(s.block_type);
        if (eid === null) return [];
        return [{ row: 0, col: i, effectId: eid, name: s.block_type, isShunt: false, routeFlag: 0, fromRows: [] as number[], slug: s.block_type }];
      });
    }
    this.#log(`grid: ${cells.map((c) => c.slug).join(', ') || '(empty)'}`);
    return { model: 'vp4', name: snap?.name ?? '', crcValid: true, rows: 1, cols: SLOT_COUNT, scenes: [], cells, source: 'dump' };
  }

  /** Reverse effectId → slug via the cached snapshot's block list. */
  #slugForEid(eid: number): string {
    const snap = this.#presetCache?.snap ?? null;
    return snap?.slots.find((s) => this.#eidFor(s.block_type) === eid)?.block_type ?? `0x${eid.toString(16)}`;
  }
  #nameForEid(eid: number): string {
    return this.#slugForEid(eid);
  }

  /** Placed blocks in the unified PresetBlockDTO shape (GET /preset/blocks). */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const snap = await this.readPreset();
    return (snap?.slots ?? []).flatMap((s, i) => {
      const eid = this.#eidFor(s.block_type);
      if (eid === null) return [];
      return [{ slug: s.block_type, name: s.block_type, effectId: eid, row: 1, col: i + 1, fromRows: [], bypassed: s.bypassed ?? null, channel: null }];
    });
  }

  /** Every parameter of the block at `eid`. VP4 params are all uncalibrated opaque continuous knobs
   *  (no ranges, no enums), so everything lands in `named` with the raw decoded value + norm 0. */
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null }> {
    const snap = await this.readPreset();
    const slot = this.#slotForEid(snap, eid);
    const slug = slot?.block_type ?? this.#slugForEid(eid);
    if (!slot) {
      this.#log(`blockParams: no block present at effectId ${eid}`);
      return { block: slug, slug, page: -1, named: [], enums: [], type: null };
    }
    const decoded = (slot.params ?? {}) as Record<string, number | string>;
    const named: NamedParam[] = [];
    for (const [name, display] of Object.entries(decoded)) {
      if (name === 'BLOCK_BYPASS') continue; // bypass has its own route
      const value = typeof display === 'number' ? display : Number(display) || 0;
      const p = VP4_PARAM_BY_NAME.get(name);
      if (!p) continue; // not a known VP4 param
      named.push({ id: this.#paramIdFor(name) ?? 0, name: paramLabel(name), value, norm: 0 });
    }
    const enums: EnumParam[] = [];
    if (slot.bypassed !== undefined) {
      enums.unshift({ id: 0xffff, name: 'Bypass', value: slot.bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] });
    }
    this.#log(`blockParams ${slug} (eid ${eid}): ${named.length} knobs`);
    return { block: slug, slug, page: -1, named, enums, type: null };
  }

  #paramIdFor(name: string): number | undefined {
    return (VP4_PARAMS as ReadonlyArray<{ name: string; paramId: number }>).find((p) => p.name === name)?.paramId;
  }

  // ── writes (allowlisted, community-beta; the rest are OMITTED → routes 501) ─────────────────────
  /** Continuous knob write only (VP4's decoded write). `value` is the 0..1 knob norm. A discrete/enum
   *  write (continuous:false) is UNDECODED on VP4 → clean 400 rather than an unverified frame. */
  async setParam(eid: number, paramId: number, value: number, continuous: boolean): Promise<{ ok: boolean }> {
    if (!continuous) {
      const err = new Error('VP4 discrete/enum parameter writes are not decoded (community-beta gate)') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    const dev = await this.#openTransport();
    await dev.sendQueued(buildVp4SetParam(eid, paramId, Math.min(1, Math.max(0, value)), { continuous: true }));
    this.#invalidate();
    return { ok: true };
  }

  /** Current scene (0-based) from the structure blob — read-only (scene SWITCH is undecoded, so
   *  setScene stays omitted and POST /scene answers 501). Surfaces the active scene on GET /scene. */
  async getScene(): Promise<{ index: number }> {
    const st = await this.readStructure();
    return { index: st?.currentScene ?? 0 };
  }

  async setBypass(eid: number, bypassed: boolean): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildVp4SetBypass(eid, bypassed));
    this.#invalidate();
    return { ok: true };
  }

  /** Save the working buffer (VP4's decoded save; the location is device-side, not addressable here). */
  async store(_n: number): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildVp4Save());
    return { ok: true };
  }
}

/** Create the VP4 driver over the shared transport. */
export function createVp4Driver(ctx: DriverCtx): Vp4Driver {
  return new Vp4Driver(ctx);
}
export type { Vp4Driver };
