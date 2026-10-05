// Axe-Fx II family driver (model byte 0x07, XL+). A grid device (4×12, 8 scenes, X/Y channels) that
// speaks the gen-2 SysEx envelope (fn 0x02 GET/SET_BLOCK_PARAMETER_VALUE + fn 0x1F bulk state-broadcast
// triples), totally distinct from the gen-3 grid codec — so it gets its own driver + DTO mapping.
//
// Reads reuse the VERIFIED forgefx-midi descriptor reader (AXEFX2_DESCRIPTOR.reader.getPreset does the
// full grid + per-block fn 0x1F param dump + name/scene/bypass read in one orchestrated pass) driven
// over the shared registry Transport via the descriptorConn bridge, serialized behind #withReader (the
// reader drives the RAW transport, so overlapping reads would interleave their fn 0x1F bursts). Writes
// use the low-level wire builders directly (mirrors AM4) so setParam(eid,paramId,…) stays wire-precise
// and byte-testable. Community-beta: the read path is hardware-verified upstream on an Axe-Fx II XL+
// (Quantum 8.02); this ForgeFX layer is untested on hardware here.
import {
  BLOCK_BY_ID,
  IDS_BY_GROUP,
  KNOWN_PARAMS,
  buildSetBlockParameterValue,
  buildSetBlockParameterValueInteger,
  buildSetBlockBypass,
  buildSetBlockChannel,
  buildSetGridCell,
  buildSetSceneNumber,
  buildSwitchPreset,
  buildStorePreset,
  buildSetPresetName,
  isSetGridCellResponse,
  parseSetGridCellResponse,
  isStorePresetResponse,
  parseStorePresetResponse,
  type AxeFxIIParam,
  type AxeFxIIBlock,
} from 'forgefx-midi/gen2/axe-fx-ii';
import { AXEFX2_DESCRIPTOR } from 'forgefx-midi/devices/gen2';
import { resolveParamKind, type DispatchCtx, type PresetSnapshot } from 'forgefx-midi/core';
import { dispatchCtx } from './descriptorConn.js';
import type { Transport } from '../transport/types.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetBlockDTO, NamedParam, EnumParam,
} from './types.js';

const MODEL_ID = 0x07;
const SCENE_COUNT = 8;

// gen-2 unit tag → display label the block-editor DTO renders (mirrors the AM4 map). Blank = bare number.
const UNIT_LABEL: Record<string, string> = { db: 'dB', hz: 'Hz', ms: 'ms', percent: '%', degrees: '°' };

/** "Amp 1" → { slug:'amp', instance:1 }. The trailing number encodes the instance; the slug is the rest. */
function slugInstance(block: AxeFxIIBlock): { slug: string; instance: number } {
  const m = /^(.+?)\s+(\d+)$/.exec(block.name);
  return { slug: (m?.[1] ?? block.name).toLowerCase(), instance: m ? Number(m[2]) : 1 };
}
/** The display-unit token for a param (dB/Hz/ms/percent/…) via the cross-device paramKind resolver —
 *  AxeFxIIParam itself carries no unit; the resolver is the same one the reader used to decode. */
function unitOf(p: AxeFxIIParam): string {
  return resolveParamKind('axe-fx-ii', p.block, p.name).unit;
}
/** Pretty knob label from an AxeFxIIParam: xmlLabel if present, else the snake_case name Title-Cased. */
function paramLabel(p: AxeFxIIParam): string {
  return p.xmlLabel ?? p.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

class Gen2Driver implements DeviceDriver {
  readonly modelId = MODEL_ID;
  readonly key = 'axe2';
  readonly name = 'Axe-Fx II';
  readonly capabilities: DriverCapabilities = {
    slotModel: 'grid',
    grid: { rows: 4, cols: 12 },
    gridEdit: true,
    scenes: SCENE_COUNT,
    channels: true,
    presetDump: false, // gen-2 dump is an opaque .syx blob (no gen-3 decode) → backup via backupPreset, not the gen-3 service
    presetConvert: false, // the gen-2 preset-parse decoder isn't reachable through the codec's public exports (only the descriptor barrel); the lift is name-only anyway
    blockParamDecode: false, // params come from the fn 0x1F dump, not a preset-body decode (that path is FM3-only)
    telemetry: { tuner: false, outputMeters: false, cpu: false }, // no gen-3 telemetry frames on gen-2
    fcModel: false,
    fcLiveRead: false,
    modBind: false,
    cabIrs: false,
    editorLayouts: false, // gen-2 (Axe-Fx II) ships no editor layouts
    supportsSave: true,
    selfDescribe: false, // gen-2 has no gen-3 self-describe walk (params come from the fn 0x1F dump)
    cacheImport: false, // no gen-3 editor .cache grammar for gen-2
    fullCapture: false, // no self-describe walk at all → no write-sweep full capture
    deviceEditPush: false,
    deviceEditWatch: false,
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }

  #log(s: string) { console.log(`[forgefx][axe2] ${s}`); }
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  // ── reader plumbing (mirrors the AM4 driver) ──────────────────────────────────────────────────
  #reader = AXEFX2_DESCRIPTOR.reader;
  #readerLock: Promise<unknown> = Promise.resolve();
  #presetCache: { snap: PresetSnapshot; at: number } | null = null;
  static #PRESET_TTL_MS = 500;
  #lastTransport: Transport | null = null;

  async #withReader<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#readerLock.then(fn, fn);
    this.#readerLock = run.catch(() => undefined);
    return run;
  }

  #dispatchCtx(): DispatchCtx { return dispatchCtx(AXEFX2_DESCRIPTOR, this.#lastTransport!); }

  /** ONE atomic getPreset dump (grid + per-block fn 0x1F params + name/scene/bypass), TTL-cached so a
   *  grid + block-param page load reuses a single read. Serialized behind #withReader. */
  async readPreset(): Promise<PresetSnapshot | null> {
    const now = Date.now();
    if (this.#presetCache && now - this.#presetCache.at < Gen2Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
    return this.#withReader(async () => {
      const t = Date.now();
      if (this.#presetCache && t - this.#presetCache.at < Gen2Driver.#PRESET_TTL_MS) return this.#presetCache.snap;
      this.#lastTransport = await this.#openTransport();
      try {
        const snap = await this.#reader.getPreset!(this.#dispatchCtx(), {});
        this.#presetCache = { snap, at: Date.now() };
        this.#log(`readPreset: ${snap.slots.length} placed block(s), scene ${snap.active_scene ?? '?'}`);
        return snap;
      } catch (e) {
        this.#log(`readPreset failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }

  /** Drop the preset cache after any device write so the next read reflects the change. */
  #invalidate() { this.#presetCache = null; }

  /** Match a snapshot slot to a block effectId (via its slug+instance). */
  #slotForEid(snap: PresetSnapshot | null, eid: number): PresetSnapshot['slots'][number] | undefined {
    const block = BLOCK_BY_ID[eid];
    if (!block || !snap) return undefined;
    const { slug, instance } = slugInstance(block);
    return snap.slots.find((s) => s.block_type === slug && (s.instance ?? 1) === instance);
  }

  /** The decoded (display-value) param dict for a slot: flat `params`, else the single active-channel dict. */
  #slotParamValues(slot: PresetSnapshot['slots'][number] | undefined): Record<string, number | string> {
    if (!slot) return {};
    if (slot.params) return slot.params as Record<string, number | string>;
    const byCh = slot.params_by_channel;
    if (byCh) { const first = Object.values(byCh)[0]; if (first) return first as Record<string, number | string>; }
    return {};
  }

  // ── grid / blocks ─────────────────────────────────────────────────────────────────────────────
  /** The active preset's placed blocks as a 4×12 grid DTO. Built from the getPreset snapshot's slots
   *  (their true row/col, converted 1-based → 0-based). Routing edges/shunts are NOT included (the
   *  reader omits them — routing_omitted); Axis renders the block tiles, no cables. */
  async grid(): Promise<PresetGridDTO> {
    const snap = await this.readPreset();
    const cells = (snap?.slots ?? []).flatMap((s) => {
      const pos = typeof s.slot === 'object' ? s.slot : null;
      if (!pos) return [];
      const slug = s.block_type;
      const eid = this.#eidFor(s.block_type, s.instance ?? 1);
      return [{
        row: Math.max(0, pos.row - 1),
        col: Math.max(0, pos.col - 1),
        effectId: eid ?? 0,
        name: BLOCK_BY_ID[eid ?? -1]?.name ?? slug,
        isShunt: false,
        routeFlag: 0,
        fromRows: [] as number[],
        slug,
      }];
    });
    this.#log(`grid: "${snap?.name ?? ''}" — ${cells.map((c) => c.name).join(', ')}`);
    return { model: 'axe2', name: snap?.name ?? '', crcValid: true, rows: 4, cols: 12, scenes: [], cells, source: 'dump' };
  }

  /** Resolve a block slug + instance to its wire effectId (e.g. amp #1 → 106). */
  #eidFor(slug: string, instance: number): number | undefined {
    const base = Object.values(BLOCK_BY_ID).find((b) => slugInstance(b).slug === slug && slugInstance(b).instance === 1);
    if (!base) return undefined;
    if (instance === 1) return base.id;
    return IDS_BY_GROUP[base.groupCode]?.[instance - 1];
  }

  /** Placed blocks in the unified PresetBlockDTO shape (GET /preset/blocks). */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const snap = await this.readPreset();
    return (snap?.slots ?? []).flatMap((s) => {
      const pos = typeof s.slot === 'object' ? s.slot : null;
      const eid = this.#eidFor(s.block_type, s.instance ?? 1);
      if (eid === undefined) return [];
      // active channel key when the reader nested params under one channel
      const ch = s.params_by_channel ? Object.keys(s.params_by_channel)[0] ?? null : null;
      return [{
        slug: s.block_type,
        name: BLOCK_BY_ID[eid]?.name ?? s.block_type,
        effectId: eid,
        row: pos ? pos.row : 1,
        col: pos ? pos.col : 1,
        fromRows: [],
        bypassed: s.bypassed ?? null,
        channel: ch,
      }];
    });
  }

  /** Every parameter of the block at `eid`, in the gen-3 blockParams DTO shape so Axis renders it
   *  through the existing block editor. Values come from the getPreset fn 0x1F dump (decoded display
   *  values keyed by param name); we join each against KNOWN_PARAMS for unit/range/enum + norm. */
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null }> {
    const block = BLOCK_BY_ID[eid];
    if (!block) {
      this.#log(`blockParams: unknown effectId ${eid}`);
      return { block: `0x${eid.toString(16)}`, slug: '', page: -1, named: [], enums: [], type: null };
    }
    const { slug } = slugInstance(block);
    const snap = await this.readPreset();
    const slot = this.#slotForEid(snap, eid);
    const decoded = this.#slotParamValues(slot);
    const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');
    const decByNorm = new Map(Object.entries(decoded).map(([k, v]) => [norm(k), v]));
    const lookup = (name: string) => (name in decoded ? decoded[name] : decByNorm.get(norm(name)));

    const params = Object.values(KNOWN_PARAMS).filter((p) => (p as AxeFxIIParam).groupCode === block.groupCode) as AxeFxIIParam[];
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    for (const p of params) {
      const display = lookup(p.name);
      if (display === undefined) continue; // not in the dump (channel-gated / not placed)
      const isEnum = p.controlType === 'select' || p.enumValues !== undefined;
      if (isEnum) {
        const options = Object.entries(p.enumValues ?? {}).map(([v, label]) => ({ value: Number(v), label }));
        const value = this.#enumOrdinal(p, display);
        if (p.name === 'type') { type = { value, name: p.enumValues?.[value] ?? String(display) }; continue; }
        enums.push({ id: p.paramId, name: paramLabel(p), value, options });
      } else {
        const value = typeof display === 'number' ? display : Number(display) || 0;
        named.push({
          id: p.paramId,
          name: paramLabel(p),
          value,
          norm: this.#normOf(p, value),
          unit: UNIT_LABEL[unitOf(p)] ?? undefined,
          min: p.displayMin,
          max: p.displayMax,
          log: p.displayScale === 'log10' || undefined,
        });
      }
    }
    const dedupe = <T extends { id: number }>(list: T[]): T[] => {
      const seen = new Set<number>();
      return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    };
    const namedOut = dedupe(named);
    const enumsOut = dedupe(enums);
    // bypass as a leading virtual enum (id 0xffff — its own route /preset/blocks/:eid/bypass; never setParam)
    if (slot && slot.bypassed !== undefined) {
      enumsOut.unshift({ id: 0xffff, name: 'Bypass', value: slot.bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] });
    }
    this.#log(`blockParams ${block.name} (eid ${eid}): ${namedOut.length} knobs, ${enumsOut.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: block.name, slug, page: -1, named: namedOut, enums: enumsOut, type };
  }

  #enumOrdinal(p: AxeFxIIParam, display: number | string): number {
    if (typeof display === 'number') return display;
    for (const [ord, label] of Object.entries(p.enumValues ?? {})) if (label === display) return Number(ord);
    return Number(display) || 0;
  }
  #normOf(p: AxeFxIIParam, value: number): number {
    const lo = p.displayMin, hi = p.displayMax;
    if (lo === undefined || hi === undefined) return 0;
    let n: number;
    if (p.displayScale === 'log10' && lo > 0 && hi > 0 && hi !== lo) n = Math.log(value / lo) / Math.log(hi / lo);
    else if (hi !== lo) n = (value - lo) / (hi - lo);
    else n = 0;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }
  /** Inverse of #normOf: a display value from a 0..1 knob position (for the fn 0x2e display-float write). */
  #displayFromNorm(p: AxeFxIIParam, norm: number): number | null {
    const lo = p.displayMin, hi = p.displayMax;
    if (lo === undefined || hi === undefined) return null;
    const n = Math.min(1, Math.max(0, norm));
    if (p.displayScale === 'log10' && lo > 0 && hi > 0) return lo * Math.pow(hi / lo, n);
    return lo + n * (hi - lo);
  }
  #paramFor(eid: number, paramId: number): AxeFxIIParam | undefined {
    const block = BLOCK_BY_ID[eid];
    if (!block) return undefined;
    return (Object.values(KNOWN_PARAMS) as AxeFxIIParam[]).find((p) => p.groupCode === block.groupCode && p.paramId === paramId);
  }

  // ── writes (raw builders; gen-2 SET is fire-and-forget except grid-cell / store which ack) ──────
  /** Unified PUT /preset/blocks/:eid/params/:paramId. continuous:true → fn 0x2e display-float write
   *  (value is a 0..1 knob norm, converted to a display value via the param's calibration; opaque knobs
   *  with no display range fall back to a wire-int write). continuous:false → fn 0x02 integer (enum ordinal). */
  async setParam(eid: number, paramId: number, value: number, continuous: boolean): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    const p = this.#paramFor(eid, paramId);
    let frame: number[];
    if (continuous && p) {
      const display = this.#displayFromNorm(p, value);
      frame = display !== null
        ? buildSetBlockParameterValue({ effectId: eid, paramId }, display)
        : buildSetBlockParameterValueInteger({ effectId: eid, paramId }, Math.round(Math.min(1, Math.max(0, value)) * 65534));
    } else {
      frame = buildSetBlockParameterValueInteger({ effectId: eid, paramId }, Math.round(value));
    }
    await dev.sendQueued(frame);
    this.#invalidate();
    return { ok: true };
  }

  /** Set the block's type/model selector (the 'type' enum surfaced by blockParams). */
  async setType(eid: number, value: number): Promise<{ ok: boolean }> {
    const block = BLOCK_BY_ID[eid];
    const typeParam = block ? (Object.values(KNOWN_PARAMS) as AxeFxIIParam[]).find((p) => p.groupCode === block.groupCode && p.name === 'type') : undefined;
    if (!typeParam) {
      const err = new Error(`No 'type' selector on ${block?.name ?? `block 0x${eid.toString(16)}`}`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockParameterValueInteger({ effectId: eid, paramId: typeParam.paramId }, Math.round(value)));
    this.#invalidate();
    return { ok: true };
  }

  async setBypass(eid: number, bypassed: boolean): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockBypass(eid, bypassed));
    this.#invalidate();
    return { ok: true };
  }

  /** X/Y channel select. `channel` is 'X'/'Y' (or 'A'/'B' → X/Y). */
  async setChannel(eid: number, channel: string): Promise<{ ok: boolean }> {
    const ch = channel.trim().toUpperCase();
    const wire = ch === 'Y' || ch === 'B' ? 'Y' : 'X';
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockChannel(eid, wire));
    this.#invalidate();
    return { ok: true };
  }

  /** Grid edit (PUT /preset/grid/cell): place/clear a block. `row`/`col` are the shared 1-indexed
   *  grid coordinates (docs/api-design.md + the /preset/grid/cell contract, "1-indexed row/col,
   *  matching FM-Edit") — the SAME convention Axis sends for every device. The gen-2 wire grid is also
   *  1-indexed (buildSetGridCell validates 1..4/1..12), so they pass straight through, like gen-3/AM4.
   *  `blockId` 0 = clear. */
  async placeCell(row: number, col: number, blockId: number): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    const frame = buildSetGridCell({ row, col, blockId });
    const frames = await dev.request(frame, { timeoutMs: 800, quietMs: 80, match: (fs) => fs.some(isSetGridCellResponse) });
    const ack = frames.find(isSetGridCellResponse);
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'grid' });
    return { ok: ack ? parseSetGridCellResponse(ack).ok : false };
  }

  async getScene(): Promise<{ index: number }> {
    const snap = await this.readPreset();
    return { index: snap?.active_scene !== undefined ? Math.max(0, snap.active_scene - 1) : 0 };
  }
  /** Switch scene. `index` is 0-based; the wire scene is 0..7. */
  async setScene(index: number): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetSceneNumber(Math.max(0, Math.min(SCENE_COUNT - 1, index))));
    this.#invalidate();
    this.#ctx.emit({ type: 'scene', index });
    return { ok: true };
  }

  /** Switch the active preset (POST /preset/select). `n` is the wire preset index (0-based). */
  async selectPreset(n: number): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchPreset(n));
    this.#invalidate();
    return { ok: true };
  }

  /** Store the working buffer to slot `n` (fn 0x7E; acks with a result code). */
  async store(n: number): Promise<{ ok: boolean; location: number }> {
    const dev = await this.#openTransport();
    const frames = await dev.request(buildStorePreset(n), { timeoutMs: 800, quietMs: 80, match: (fs) => fs.some(isStorePresetResponse) });
    const ack = frames.find(isStorePresetResponse);
    return { ok: ack ? parseStorePresetResponse(ack).ok : true, location: n };
  }

  /** Rename the working-buffer preset (fire-and-forget; persists on the next store). */
  async setPresetName(name: string): Promise<{ ok: boolean }> {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetPresetName(name));
    this.#invalidate();
    return { ok: true };
  }

  /** Back up the active buffer as a verbatim 66-frame .syx (POST /preset/backup). Blob backup, not a decode. */
  async backupPreset(): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const dump = await this.#withReader(async () => {
      this.#lastTransport = await this.#openTransport();
      return this.#reader.dumpActivePresetBinary!(this.#dispatchCtx());
    });
    this.#log(`backup "${dump.name ?? ''}" ${dump.byte_length}B`);
    return { location: null, code: null, name: dump.name ?? '', bytes: [...dump.bytes] };
  }

  /** Restore a verbatim .syx dump to the working buffer (POST /preset/restore). */
  async restorePreset(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }> {
    const restore = AXEFX2_DESCRIPTOR.writer.restorePresetBinary;
    if (!restore) { const e = new Error('restore unsupported') as Error & { statusCode?: number }; e.statusCode = 501; throw e; }
    await this.#withReader(async () => {
      this.#lastTransport = await this.#openTransport();
      return restore(this.#dispatchCtx(), Uint8Array.from(bytes), {});
    });
    this.#invalidate();
    return { ok: true, location: null, code: null };
  }
}

/** Create the Axe-Fx II driver over the shared transport. */
export function createGen2Driver(ctx: DriverCtx): Gen2Driver {
  return new Gen2Driver(ctx);
}
export type { Gen2Driver };
