// Gen-3 device driver (Axe-Fx III / FM3 / FM9) — the shared grid codec driven through a per-device
// profile. Wire protocol + catalog/params/rosters/enums/cab-IRs all via forgefx-midi. One driver
// instance per model byte; EVERY frame is built by a codec bound to that byte
// (createModernFractalCodec), so nothing here can fall back to a defaulted model.
import {
  createModernFractalCodec,
  buildSetTempoViaParam,
  resolveEnumValues,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
  buildBlockMonitorPoll,
  isBlockMonitorResponse,
  parseBlockMonitorNorm,
  parseOutputMeterRms,
  meterRmsToDb,
  buildLooperWaveformPoll,
  isLooperWaveformResponse,
  parseLooperWaveform,
  buildLooperControl,
  type ModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'forgefx-midi/shared';
import {
  parsePresetDump, decodeRawPatch, decodeGen3Body,
  readBlockParamsForModel, modelsFromBlocks,
  effectRoster, blockRefForEid, slugForEffectId, blockInstances,
  retargetPresetDumpToEditBuffer,
  type DecodedBlock
} from 'forgefx-midi/devices/gen3';
import { SLUG_FAMILY, type DeviceProfile, type TypeModel, type DeviceLayout, type SelectorValues } from '../devices.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx,
  PresetGridDTO, PresetBlockDTO, PresetSummary, NamedParam, EnumParam, MeterVal,
  FcSwitchState, FcReadState
} from './types.js';

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer

// ── preset-dump decode (forgefx-midi devices/gen3 pipeline) ──
// Adapter producing the exact DTO the pre-Phase-4 server-local codec (fm3PresetGrid.ts
// decodePresetDump) returned — field-level parity was proven over 429 real FM3 dumps
// (scripts/diff-decoders.ts, Phase 2). The JSON shapes downstream are the HTTP contract
// Axis consumes and must not drift.

/** The old decodePresetDump DTO, byte-identical on the HTTP surface. */
interface DecodedDumpDTO {
  modelId: number;
  modelName: string;
  name: string;
  crcValid: boolean;
  /** Stored CRC16 of the preset body — a content fingerprint (changes when the preset changes). */
  crc: number;
  rows: number;
  cols: number;
  grid: { effectId: number; row: number; col: number; routeFlag: number; name: string; isShunt: boolean; fromRows: number[] }[];
  sceneNames: string[];
}
/** Decoded dump: the DTO plus the decompressed body (per-block param decode source). */
interface DecodedDump {
  dump: DecodedDumpDTO;
  body: Uint8Array;
  decompSize: number;
}

/** Keep only the dump frames (0x77 header / 0x78 chunks / 0x79 footer) and flatten to the byte
 *  stream the package parser takes. The live request window can interleave unrelated frames
 *  (beacons, other replies) that the strict frame-walking parser would reject; the old decoder
 *  skipped them the same way. */
function dumpBytesFromFrames(frames: readonly (readonly number[])[]): Uint8Array {
  const keep: number[] = [];
  for (const f of frames) {
    if (f.length < 8 || f[0] !== 0xf0 || f[1] !== 0x00 || f[2] !== 0x01 || f[3] !== 0x74) continue;
    const fn = f[5];
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) keep.push(...f);
  }
  return Uint8Array.from(keep);
}

/** Full dump decode via the package pipeline (parse → raw_patch/CRC/Huffman → structured body),
 *  mapped to the old server DTO. rows/cols/modelName come from the profile — the same values the
 *  old codec's DIMS dict held; the preset name is the raw_patch header ASCII at 0x08..0x28
 *  (NUL-stop, trimmed), exactly the old decoder's source. */
function decodeDump(frames: readonly (readonly number[])[], prof: DeviceProfile): DecodedDump {
  const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, prof.model);
  const raw = decodeRawPatch(parsed.chunkPayloads);
  const body3 = decodeGen3Body(raw.body, prof.model);
  let name = '';
  for (let i = 0x08; i < 0x28; i++) {
    const b = raw.rawPatch[i] ?? 0;
    if (b === 0) break;
    name += String.fromCharCode(b);
  }
  const grid = (body3.grid ?? []).map((c) => ({
    effectId: c.effect_id,
    row: c.row,
    col: c.col,
    routeFlag: c.route_flag,
    name: c.name,
    isShunt: c.is_shunt ?? false,
    fromRows: c.from_rows ?? []
  }));
  return {
    dump: {
      modelId: prof.model,
      modelName: prof.name,
      name: name.trim(),
      crcValid: raw.crcValid,
      crc: raw.storedCrc,
      rows: prof.rows,
      cols: prof.cols,
      grid,
      sceneNames: body3.scene_names ?? []
    },
    body: raw.body,
    decompSize: raw.decompSize
  };
}

const CH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// catalog unit code → display label (blank = show the bare number)
const UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%',
  degrees: '°', semitones: 'st', pf: 'pF', ratio: ':1'
};
// units that mark a musician-facing knob. 'numeric' = a plain unitless knob (Drive, Tone, Level,
// cut freqs…) — primary controls in many families; only 'unverified'/'count'/'enum' are non-knobs.
const KNOB_UNITS = new Set([
  'numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees'
]);

/** Append 1/2/3… to labels that repeat within a list (e.g. the cab's four "Low Cut" mic params),
 * so the UI can tell otherwise-identical controls apart. Mutates the items' `name`. */
function dedupeLabels(items: { name: string }[]): void {
  const total = new Map<string, number>();
  for (const it of items) total.set(it.name, (total.get(it.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const it of items) {
    if ((total.get(it.name) ?? 0) > 1) {
      const n = (seen.get(it.name) ?? 0) + 1;
      seen.set(it.name, n);
      it.name = `${it.name} ${n}`;
    }
  }
}
/** Friendly param label: the catalog displayLabel, else tidy the raw NAME (strip family prefix, _→space). */
function paramLabel(p: { displayLabel?: string; name: string }): string {
  return p.displayLabel ?? p.name.replace(/^[A-Z0-9]+_/, '').replace(/_/g, ' ');
}

class Gen3Driver implements DeviceDriver {
  #prof: DeviceProfile;
  #codec: ModernFractalCodec;
  #ctx: DriverCtx;
  readonly capabilities: DriverCapabilities;

  constructor(profile: DeviceProfile, ctx: DriverCtx) {
    this.#prof = profile;
    this.#codec = createModernFractalCodec(profile.model); // every frame carries THIS device's model byte
    this.#ctx = ctx;
    this.capabilities = {
      slotModel: 'grid',
      grid: { rows: profile.rows, cols: profile.cols },
      gridEdit: true,
      scenes: 8,
      channels: true,
      presetDump: true,
      presetConvert: true, // full gen-3 lift (routing grid + per-scene block state + amp knobs)
      blockParamDecode: profile.model === 0x11, // per-block body decode is FM3-only today
      telemetry: { tuner: true, outputMeters: true, cpu: true },
      fcModel: !!profile.fcModel,
      fcLiveRead: !!profile.fcModel?.liveState,
      modBind: !!profile.modModel,
      cabIrs: Object.keys(profile.cabIrs()).length > 0,
      editorLayouts: true, // FM3 / FM9 / Axe-Fx III all ship *_LAYOUTS (profile.layoutFor)
      supportsSave: true,
      // Live self-describe walk (fn 0x01 DEFINITION/ENUM-LABEL sweep) is HW-verified on the FM3 and
      // shares the gen-3 protocol on the FM9 / Axe-Fx III → the on-connect device-cache build is offered.
      selfDescribe: true,
      // Same buildCache path as the live walk → an official-editor .cache file can be imported too.
      cacheImport: true,
      // FULL-mode self-describe (write-sweep taper capture) is CaptureRig-proven on the trio the rig
      // sweeps: Axe-Fx III (0x10) / FM3 (0x11) / FM9 (0x12). Gated to those model bytes explicitly.
      fullCapture: profile.model === 0x10 || profile.model === 0x11 || profile.model === 0x12,
      // Device-edit reflection splits by whether the unit PUSHES front-panel edits:
      //  • FM9 / Axe-Fx III / VP4 push an unsolicited 0x74/0x75/0x76 burst → registry LISTENS (deviceEditPush).
      //  • FM3 (0x11) proven NOT to push (tap 2026-07-04: a front-panel knob emitted zero unsolicited
      //    frames) → registry POLLS the open block instead (deviceEditWatch → readDeviceEditState below),
      //    the same poll-fallback shape as the AM4. Disable in the field via FORGEFX_FM3_EDITSYNC=0.
      deviceEditPush: profile.model !== 0x11,
      deviceEditWatch: profile.model === 0x11 && process.env.FORGEFX_FM3_EDITSYNC !== '0'
    };
  }

  get modelId() { return this.#prof.model; }
  get key() { return this.#prof.key; }
  get name() { return this.#prof.name; }
  get profile() { return this.#prof; }

  /** Adopt a device-cache-derived runtime profile (device-true rosters / enum labels / ranges). The
   *  model byte is unchanged so the codec bound at construction stays valid; only the data the reads
   *  resolve through (#prof) is swapped. Idempotent — re-applying a fresh profile just replaces it. */
  applyRuntimeProfile(profile: DeviceProfile): void { this.#prof = profile; }

  #gridCache: { grid: PresetGridDTO; at: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load

  #conn() { return this.#ctx.transport(); }
  #emit: DriverCtx['emit'] = (e) => this.#ctx.emit(e);

  #channelSlice(
    family: string | undefined,
    bulk: { itemCount: number; values: readonly number[] },
    activeChannel: number,
  ): { stride: number; channelCount: number; base: number } {
    const tableStride = family ? this.#prof.rangeSections[family]?.stride : undefined;
    const stride = tableStride && tableStride > 0
      ? tableStride
      : (bulk.itemCount > 0 && bulk.itemCount % 4 === 0 ? bulk.itemCount / 4 : Math.max(1, bulk.values.length));
    const basis = bulk.itemCount > 0 ? bulk.itemCount : bulk.values.length;
    const channelCount = Math.max(1, Math.floor(basis / stride));
    return { stride, channelCount, base: Math.min(activeChannel, channelCount - 1) * stride };
  }

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  async #send(bytes: number[]): Promise<{ ok: boolean }> {
    await (await this.#conn()).sendQueued(bytes);
    return { ok: true };
  }

  /** Write + watch a short window for a 0x64 rejection. For structural ops where a reject matters. */
  async #write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const frames = await dev.request(bytes, { timeoutMs: 120, quietMs: 60, match: (fs) => fs.some((f) => f[5] === 0x64) });
    return { ok: !frames.some((f) => f[5] === 0x64) };
  }

  /** Current preset number + name (one query). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildQueryPatchName('current'), {
      timeoutMs: dev.slow ? 4000 : 1200, // slow link: give the reply time to arrive (match returns early)
      match: (fs) => fs.some((f) => this.#codec.isQueryPatchNameResponse(f))
    });
    const f = frames.find((x) => this.#codec.isQueryPatchNameResponse(x));
    if (!f) return { number: -1, name: '' };
    const r = this.#codec.parseQueryPatchNameResponse(f);
    return { number: r.presetNumber, name: r.name };
  }

  /** Routing grid via the hardware-validated dump decoder. Deduped + short-TTL cached. */
  async grid(): Promise<PresetGridDTO> {
    if (this.#gridInflight) return this.#gridInflight; // coalesce concurrent callers
    if (this.#gridCache && Date.now() - this.#gridCache.at < Gen3Driver.GRID_TTL_MS) return this.#gridCache.grid;
    this.#gridInflight = this.#dumpGrid();
    try {
      const g = await this.#gridInflight;
      this.#gridCache = { grid: g, at: Date.now() };
      return g;
    } finally {
      this.#gridInflight = null;
    }
  }

  /** Read a preset dump, retrying when it arrives incomplete. On Windows USB-MIDI a big multi-packet
   *  dump (Axe-Fx III presets ≈ 18 frames / 32 KB) intermittently drops its 0x78 payload chunks between
   *  the 0x77 header and the 0x79 terminator → "no 0x78 chunks found". A re-read almost always succeeds. */
  async #dumpFrames(target: number): Promise<number[][]> {
    const dev = await this.#conn();
    // A slow link (5-pin MIDI) transfers each ~3082B dump chunk in ~1s, so a multi-chunk preset dump takes
    // several seconds with ~1s gaps between chunks. The USB-tuned windows (5s / 180ms quiet) give up mid
    // dump. Widen them so the transfer completes; the 0x79-terminator `match` still returns the instant the
    // dump is whole, so a fast link isn't slowed.
    const slow = dev.slow;
    let frames: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      frames = await dev.request(this.#codec.buildRequestPresetDump(target), {
        timeoutMs: slow ? 25000 : 5000,
        quietMs: slow ? 1500 : 180,
        match: (fs) => fs.some((f) => f[5] === 0x79) // 0x79 = dump terminator
      });
      const ok = frames.some((f) => f[5] === 0x78) && frames.some((f) => f[5] === 0x79);
      if (ok) return frames;
      console.log(`[forgefx] presetDump: incomplete attempt ${attempt}/3 (frames=${frames.length}, 0x78=${frames.some((f) => f[5] === 0x78)}, 0x79=${frames.some((f) => f[5] === 0x79)}) — retrying`);
    }
    return frames; // still incomplete → let decodePresetDump throw its clear error
  }

  async #dumpGrid(): Promise<PresetGridDTO> {
    const frames = await this.#dumpFrames(EDIT_BUFFER);
    // diagnostic: did the dump arrive? (Windows MIDI large-SysEx debugging) — frame count, the function
    // bytes seen, total bytes, and whether the 0x79 terminator came through.
    const fns = [...new Set(frames.map((f) => f[5]))].map((x) => '0x' + (x ?? 0).toString(16));
    const bytes = frames.reduce((n, f) => n + f.length, 0);
    console.log(`[forgefx] presetDump: frames=${frames.length} bytes=${bytes} fns=[${fns.join(',')}] terminator=${frames.some((f) => f[5] === 0x79)}`);
    const d = decodeDump(frames, this.#prof).dump;
    return {
      model: 'fm3',
      name: d.name,
      crcValid: d.crcValid,
      rows: d.rows,
      cols: d.cols,
      scenes: d.sceneNames,
      cells: d.grid.map((c) => ({ row: c.row, col: c.col, effectId: c.effectId, name: c.name, isShunt: c.isShunt, routeFlag: c.routeFlag, fromRows: c.fromRows })),
      source: 'dump'
    };
  }

  /** Decode any preset by number (non-disruptive — does NOT switch the active preset) into a
   *  library-friendly summary: name, scene names, and the unique effect blocks it contains. The
   *  foundation for a preset browser/library (search by block, collections, tags). Param-level facts
   *  (amp model etc.) are a follow-up once the per-block param decode lands. */
  async presetSummary(presetNumber: number, withParams = false): Promise<PresetSummary> {
    const frames = await this.#dumpFrames(presetNumber);
    const decoded = decodeDump(frames, this.#prof);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), presetNumber);
    if (withParams) summary.params = blocks; // cache build: summary + full params in one dump
    return summary;
  }

  /** Full per-block params (every family/param) for one device preset — the deep-search / detail source. */
  async presetParams(presetNumber: number): Promise<DecodedBlock[]> {
    const frames = await this.#dumpFrames(presetNumber);
    return this.#decodeBlocks(decodeDump(frames, this.#prof));
  }

  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  async dumpRaw(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }> {
    const frames = await this.#dumpFrames(n);
    const decoded = decodeDump(frames, this.#prof);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(this.#decodeBlocks(decoded)), n);
    return { bytes: Uint8Array.from(frames.flat()), summary };
  }

  /** Verbatim .syx dump for POST /preset/backup (capability `backupDump`) — the library's
   *  export-to-disk + audition source. Location omitted → the currently selected preset's slot
   *  (gen-3 dumps by slot; the raw edit-buffer stream is a different frame format, not a .syx). */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const n = location ?? (await this.presetRef()).number;
    const { bytes, summary } = await this.dumpRaw(n);
    return { location: n, code: null, name: summary.name, bytes: Array.from(bytes) };
  }

  /** Decode a preset from raw .syx bytes (a saved/exported dump) — offline, no device needed. Splits
   *  the byte stream into F0..F7 SysEx frames and runs the same decoder. For a file-based library. */
  decodePresetBytes(bytes: Uint8Array): PresetSummary {
    const frames: number[][] = [];
    let cur: number[] | null = null;
    for (const b of bytes) {
      if (b === 0xf0) cur = [b];
      else if (cur) {
        cur.push(b);
        if (b === 0xf7) {
          frames.push(cur);
          cur = null;
        }
      }
    }
    const decoded = decodeDump(frames, this.#prof);
    const blocks = this.#decodeBlocks(decoded);
    const summary = this.#summarizeDump(decoded.dump, modelsFromBlocks(blocks), -1);
    summary.params = blocks; // offline files embed full params (few files → fine for search/storage)
    return summary;
  }

  /** Decode every placed block's full params from the preset body, table-driven via the universal
   *  layout (u16 array @ header+0x2e, paramId order) + the fractal-midi catalog (FM3_PARAMS/RANGES/
   *  ENUM_OVERRIDES/ROSTERS). `decoded` supplies the grid's placed effectIds so only placed blocks are
   *  read (rejects phantom headers). Empty for non-FM3. The model/type search index is derived from
   *  this via `modelsFromBlocks`. */
  #decodeBlocks(decoded: DecodedDump): DecodedBlock[] {
    if (decoded.dump.modelId !== 0x11) return []; // gate on the PRESET's model (not the connected device) — so
    try {                                         // an offline FM3 .syx decodes even when no FM3 is attached
      const placedEids = new Set<number>(decoded.dump.grid.filter((c) => !c.isShunt && c.effectId).map((c) => c.effectId));
      return readBlockParamsForModel(decoded.body, placedEids, decoded.dump.modelId);
    } catch {
      return [];
    }
  }

  #summarizeDump(d: DecodedDumpDTO, models: Record<string, string[]>, presetNumber: number): PresetSummary {
    const seen = new Map<number, { effectId: number; slug: string | null; name: string; instance: number | null }>();
    for (const c of d.grid) {
      if (c.isShunt || !c.effectId || seen.has(c.effectId)) continue;
      const ref = blockRefForEid(c.effectId);
      seen.set(c.effectId, { effectId: c.effectId, slug: ref?.slug ?? null, name: c.name, instance: ref?.instance ?? null });
    }
    return { number: presetNumber, name: d.name, model: d.modelName, crcValid: d.crcValid, crc: d.crc, scenes: d.sceneNames, blocks: [...seen.values()], models, amps: models.amp ?? [] };
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  async presetBodyHex(): Promise<{ len: number; hex: string }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildRequestPresetDump(EDIT_BUFFER), {
      timeoutMs: 5000,
      quietMs: 180,
      match: (fs) => fs.some((f) => f[5] === 0x79)
    });
    const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, this.#prof.model);
    const { body } = decodeRawPatch(parsed.chunkPayloads);
    return { len: body.length, hex: Buffer.from(body).toString('hex') };
  }

  async #statusByEffectId(): Promise<Map<number, { bypassed: boolean; channel: number }>> {
    const dev = await this.#conn();
    const map = new Map<number, { bypassed: boolean; channel: number }>();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      const frames = await dev.request(this.#codec.buildStatusDump(), { timeoutMs: 1500, match: (fs) => fs.some((f) => f[5] === 0x13) });
      const f = frames.find((x) => x[5] === 0x13);
      if (f) {
        const payload = f.slice(6, f.length - 2);
        for (let i = 0; i + 2 < payload.length; i += 3) {
          const effectId = (payload[i]! & 0x7f) | ((payload[i + 1]! & 0x7f) << 7);
          const dd = payload[i + 2]! & 0x7f;
          map.set(effectId, { bypassed: (dd & 0x01) !== 0, channel: (dd >> 1) & 0x07 });
        }
      }
    } catch {
      /* status optional */
    }
    return map;
  }

  /** Live active-channel per placed block (effectId → channel 0-3), from the fn 0x13 status dump.
   *  Feeds the registry's front-panel channel-change watch. One small round-trip. */
  async getActiveChannels(): Promise<Map<number, number>> {
    const status = await this.#statusByEffectId();
    const out = new Map<number, number>();
    for (const [eid, st] of status) out.set(eid, st.channel);
    return out;
  }

  /** Placed blocks: position + routing + live bypass/channel. */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const g = await this.grid();
    const status = await this.#statusByEffectId();
    const out: PresetBlockDTO[] = [];
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId) ?? '';
      const st = status.get(c.effectId);
      out.push({
        slug,
        name: c.name,
        effectId: c.effectId,
        row: c.row,
        col: c.col,
        fromRows: c.fromRows,
        bypassed: st ? st.bypassed : null,
        channel: st ? CH_LETTERS[st.channel] ?? null : null
      });
    }
    return out;
  }

  /** LIGHTWEIGHT per-block scene state — just bypass + active channel from the fn 0x13 status dump,
   *  NO preset dump. A scene switch never changes the grid STRUCTURE (block placement/routing is
   *  preset-level), only per-block bypass/channel/param values — so the UI can reuse its cached grid
   *  and re-apply just this. One small round-trip; keeps scene changes snappy and OFF the heavy,
   *  crash-prone dump path (a full dump right after a scene switch hits the device mid-rebuild). */
  async sceneState(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]> {
    const status = await this.#statusByEffectId();
    return [...status].map(([effectId, s]) => ({ effectId, bypassed: s.bypassed, channel: CH_LETTERS[s.channel] ?? null }));
  }

  // ── catalog ──
  // Full placeable roster — one entry PER INSTANCE (Amp 1, …, Output 1, Output 2) so the palette can
  // place a specific instance instead of always re-sending instance 1 (which the device refuses once
  // that instance is on the grid). Instance count = the DEVICE-TRUE count from the profile
  // (`instanceLimits[slug]` else `defaultInstances`), clamped to the protocol's reserved ID range
  // (`blockInstances`). `page` is the exact effect id (firstId + instance-1).
  blocksCatalog() {
    const out: { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] = [];
    for (const e of effectRoster()) {
      const fam = SLUG_FAMILY[e.slug];
      const paramCount = fam ? (this.#prof.params[fam]?.length ?? 0) : 0;
      const typeCount = this.#prof.rosterFor(e.slug).length;
      const limit = this.#prof.instanceLimits[e.slug] ?? this.#prof.defaultInstances;
      const n = Math.max(1, Math.min(blockInstances(e.slug), limit));
      for (let i = 0; i < n; i++) {
        out.push({ slug: e.slug, family: e.slug, instance: i + 1, name: n > 1 ? `${e.name} ${i + 1}` : e.name, page: e.page + i, paramCount, typeCount });
      }
    }
    return out;
  }
  blockTypes(slug: string): TypeModel[] {
    return this.#prof.rosterFor(slug);
  }

  /**
   * Read a placed block's params via the fn=0x1F bulk read. The 0x75 body is
   * CHANNEL-BLOCKED: index = channel*stride + paramId, stride = paramCount,
   * channelCount = values.length/stride (per-block, NOT always 4). `norm` = raw/65534
   * (knob position); `value`/`unit` are the device-true DISPLAY reading via this.#prof.ranges
   * (e.g. 1.2k Hz, -12 dB) where the cache has a range, else the 0..10 position.
   */
  async blockParams(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    this.#watchedEid = eid; // this is the block the user has open → the target the FM3 device-edit poll re-reads
    const codecSlug = slugForEffectId(eid) ?? ''; // audio blocks resolve via the codec
    // virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199) resolve via the profile's effectId map
    const family = SLUG_FAMILY[codecSlug.toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const slug = codecSlug || (family ? family.toLowerCase() : ''); // virtual effects key on the family name
    const meta = BLOCK_META[codecSlug];
    const blockName = meta?.name ?? family ?? slug;
    const page = meta?.page ?? -1;
    // Seed the editor-authentic layout with the family's fallback variant; once the block's CURRENT
    // type is read below we re-resolve to the type-matched (or firmware-pinned) variant.
    let layout = family ? this.#prof.layoutFor(family) : undefined;
    if (!family) {
      return { block: blockName, slug, page, named: [], enums: [], type: null, layout }; // no device-true param family mapped
    }
    const defs = this.#prof.params[family] ?? [];
    // knob params = continuous, musician-facing: a float range + a real display unit
    // (drops enum selectors, internal 'numeric'/'unverified' params, and bypass flags).
    // knobs = every continuous param with a usable range. We expose ALL real controls (the UI
    // organizes them); only genuinely-dead params are dropped: no range (min===max) or the bypass flag.
    const seenIds = new Set<number>();
    const knobs = defs.filter((p) => {
      const range = this.#prof.ranges[family]?.[p.paramId];
      if (range?.kind !== 'float') return false;
      if (/bypass/i.test(p.displayLabel ?? p.name)) return false;
      if (range.displayMin === range.displayMax) return false; // unusable (0..0) knob
      if (seenIds.has(p.paramId)) return false; // dedupe same wire paramId (first wins)
      seenIds.add(p.paramId);
      return true;
    });
    // enums = every discrete selector. The family TYPE selector is excluded (header retype palette),
    // plus the raw bypass flag; everything else (modes, slopes, mics, mic/cab pickers…) is shown.
    const typeId = this.#paramId(family, 'type');
    const enumDefs = defs.filter((p) => {
      const range = this.#prof.ranges[family]?.[p.paramId];
      if (range?.kind !== 'enum' || p.paramId === typeId) return false;
      if (range.displayMax <= range.displayMin) return false;
      if (/^bypass$/i.test(p.displayLabel ?? p.name)) return false;
      return true;
    });
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    {
      const dev = await this.#conn();
      try {
        // Read the block's CURRENT channel (A-D) so a channel switch actually reloads that channel's
        // params/type: the fn-0x1F body is channel-blocked and holds ALL channels, so we must slice the
        // active one, not always channel A. Costs one status round-trip per open — worth it for correctness.
        const activeCh = (await this.#statusByEffectId()).get(eid)?.channel ?? 0;
        this.#watchedChannel = activeCh; // keep the device-edit-burst diff on the same channel (see decodeEditBurst)
        const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 8000 : 2500, quietMs: dev.slow ? 600 : 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        const { stride, base } = this.#channelSlice(family, bulk, activeCh);
        // Prime the device-edit-push baseline with the OPEN channel's values so a later front-panel
        // edit's burst diffs cleanly to the moved param (no first-sight reload — see decodeEditBurst).
        this.#editSnapshot.set(eid, bulk.values.slice(base, base + stride));
        for (const p of knobs) {
          const raw = bulk.values[base + p.paramId] ?? 0;
          named.push({ id: p.paramId, name: paramLabel(p), ...this.#display(family, p.paramId, raw) });
        }
        for (const p of enumDefs) {
          const range = this.#prof.ranges[family]![p.paramId]!;
          const max = Math.round(range.displayMax);
          const min = Math.round(range.displayMin);
          const raw = bulk.values[base + p.paramId] ?? 0;
          // discrete params store the ordinal; if the wire value looks 16-bit-scaled, unscale it
          const value = raw > max ? Math.round((raw / 65534) * (max - min)) + min : raw;
          enums.push({ id: p.paramId, name: paramLabel(p), value, options: this.#enumOptions(family, p.paramId, p.name, min, max) });
        }
        // current model/type (for EQ band layout etc.)
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const max = Math.max(0, roster.length - 1);
          const raw = bulk.values[base + typeId] ?? 0;
          const tv = raw > max ? Math.round((raw / 65534) * max) : raw;
          type = { value: tv, name: roster[tv]?.name ?? '' };
        }
      } catch {
        named.length = 0; // a mid-loop throw left partial data — reset before the zeroed fallback
        for (const p of knobs) named.push({ id: p.paramId, name: paramLabel(p), value: 0, norm: 0 });
      }
    }
    // Current value of any page/control selector param, keyed by its editor symbol: the family type
    // selector answers with the type just decoded; other selectors (EQ type, drive type, …) with the
    // block's read enum/knob value. Lets layoutFor filter the served pages down to the ones the editor
    // would actually show — collapsing e.g. the amp's per-model 'Authentic' pages to the current model.
    const valueByPid = new Map<number, number>();
    for (const e of enums) valueByPid.set(e.id, e.value);
    for (const n of named) if (typeof n.value === 'number') valueByPid.set(n.id, n.value);
    const selectors: SelectorValues = (selectorParamName) => {
      const pid = this.#paramId(family, selectorParamName);
      if (pid == null) return undefined;
      if (typeId != null && pid === typeId) return type?.value;
      return valueByPid.get(pid);
    };
    // Re-resolve the layout to the variant selected by the block's CURRENT type value (EQ band count,
    // amp firmware-pinned variant, etc.) and filter its pages to the current selector/firmware state;
    // falls back to the null/first variant when type is unknown.
    layout = this.#prof.layoutFor(family, type?.value, selectors);
    // disambiguate repeated labels within a block (e.g. the cab's 4× "Low Cut", amp's two "Depth")
    // so identical names get a 1/2/3 suffix the UI can tell apart.
    dedupeLabels(named);
    dedupeLabels(enums);
    return { block: blockName, slug, page, named, enums, type, layout };
  }

  /** Read specific paramIds of an effect via per-pid fn 0x01 GET (sub 01 00) — the path FM3-Edit
   *  uses to load FC state. Returns {pid: float value}. The RX value is a 5×7-bit packed float32 at
   *  byte 12 of the response frame (after F0 00 01 74 <model> 01 | 01 00 | eid:2 | pid:2). */
  async readParams(eid: number, pids: number[]): Promise<Record<number, number>> {
    const dev = await this.#conn();
    const out: Record<number, number> = {};
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const unpackF32 = (b: number[]): number => {
      const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
      return new Float32Array(new Uint32Array([v]).buffer)[0]!;
    };
    // Proper gen-3 GET: fn 0x01 with sub 01 00 + EMPTY value (NOT buildGetParameter, which uses the
    // SET-typed sub 09 00 and therefore WRITES 0). Frame: F0 00 01 74 <model> 01 01 00 <eid> <pid> 0*9 cs F7.
    const buildGet = (e: number, p: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x01, 0x00, ...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    for (const pid of pids) {
      try {
        const frames = await dev.request(buildGet(eid, pid), {
          timeoutMs: 800,
          quietMs: 50,
          match: (fs) => fs.some((f) => f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid)
        });
        const f = frames.find((fr) => fr[5] === 0x01 && fr[6] === 0x01 && fr[7] === 0x00 && (fr[8]! | (fr[9]! << 7)) === eid && (fr[10]! | (fr[11]! << 7)) === pid);
        if (f) {
          if (process.env.FORGEFX_GETDUMP) console.log(`GETDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
          out[pid] = unpackF32(f.slice(12, 17));
        }
      } catch {
        /* skip unreadable pid */
      }
    }
    return out;
  }

  /** FC read path: sub 0x1a range-read (the opcode FM3-Edit uses on FC-page entry; the plain 01 00 GET
   *  returns junk for eid 199). The 60-byte response carries a NORMALIZED float32 at byte 12 (0..1 over
   *  the param's range). Returns {pid: norm}; logs the raw frame when FORGEFX_GETDUMP is set (calibration). */
  async readRange(eid: number, pids: number[]): Promise<Record<number, number>> {
    const dev = await this.#conn();
    const out: Record<number, number> = {};
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const unpackF32 = (b: number[]): number => {
      const v = ((b[0] ?? 0) | ((b[1] ?? 0) << 7) | ((b[2] ?? 0) << 14) | ((b[3] ?? 0) << 21) | ((b[4] ?? 0) << 28)) >>> 0;
      return new Float32Array(new Uint32Array([v]).buffer)[0]!;
    };
    const buildGet = (e: number, p: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1a, 0x00, ...enc14(e), ...enc14(p), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    for (const pid of pids) {
      try {
        const match = (f: number[]) => f[5] === 0x01 && f[6] === 0x1a && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
        const frames = await dev.request(buildGet(eid, pid), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (f) {
          if (process.env.FORGEFX_GETDUMP) console.log(`RANGEDUMP eid=${eid} pid=${pid} raw=${f.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
          out[pid] = unpackF32(f.slice(12, 17));
        }
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /**
   * FC (eid 199) structured switch-config read — the per-switch read FM3-Edit uses on FC-page entry.
   *
   * Request: function 0x01, **sub-action 0x01** (NOT the per-pid 01-00 GET), addressed by a *config
   *   selector* (NOT a paramId): frame `F0 00 01 74 <model> 01 01 00 <sel:2×7bit LE> 0*9 cs F7`.
   *   selector = config*2 + side, side 0 = TAP, 1 = HOLD. (A windowed request form with the high
   *   selector byte = 8 returns the same record; the low form is used here.) config is the standard
   *   FC config index (layout*12 + view*3 + switch).
   *
   * Response: an **87-byte** frame whose body (the 78 bytes after `F0 00 01 74 <model> 01 01`) is:
   *   [0]      00
   *   [1..2]   selector echo (2×7bit LE) — equals the request selector
   *   [3..4]   00 00
   *   [5..9]   session/window context value (NOT per-switch; shared across all configs in a session —
   *            confirmed live: identical for every selector at a given moment, changes on window state,
   *            not on switch content). Ignored.
   *   [10..11] 00 00
   *   [12..13] 38 00  (record-format constant)
   *   [14]     config index (0..107) — echoes the selector's config, AUTHORITATIVE.
   *   [15]     side flag: bit 0x40 set = HOLD, clear = TAP — AUTHORITATIVE (confirmed live & in capture).
   *   [16..]   packed per-switch field record. The field byte offsets within this record are NOT yet
   *            decoded with confidence (see note) — the raw bytes are returned for the caller.
   *
   * ⚠ Field-offset note: the body[14]/[15] config+side echo is confirmed byte-exact against both the
   *   live device and the FM3-Edit capture. The interior field layout (category / value-slots / label)
   *   is NOT decoded: it is a packed format that is neither the 5×7bit-f32 used by writes nor plain
   *   7-bit-ASCII for the label, and it could not be validated on the live device because sub-0x09
   *   param writes to (eid 199, pid) do not surface in this read (exhaustively verified: writing any FC
   *   config param changes zero bytes of any selector's response — the structured read serves the
   *   device's compiled/active layout snapshot, decoupled from the param edit buffer). Until a ground-
   *   truth correlation is available, only `present`, `config`, `side` are trustworthy; `raw` carries
   *   the undecoded record so a future decode can be added without another wire round-trip.
   */
  async fcReadSwitch(layout: number, view: number, sw: number): Promise<FcSwitchState> {
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC switch read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const buildSelRead = (sel: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x01, 0x00, ...enc14(sel), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    // body = frame bytes after the 7-byte header (F0 00 01 74 <model> 01 01), minus checksum+F7
    const readSide = async (side: 0 | 1): Promise<{ present: boolean; raw: number[] }> => {
      const sel = config * 2 + side;
      try {
        const match = (f: number[]) =>
          f[5] === 0x01 && f[6] === 0x01 && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === sel && f.length >= 80;
        const frames = await dev.request(buildSelRead(sel), { timeoutMs: 800, quietMs: 50, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        if (!f) return { present: false, raw: [] };
        const body = f.slice(7, -2);
        if (process.env.FORGEFX_GETDUMP) console.log(`FCDUMP sel=${sel} body=${body.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        // validate the config/side echo (body[14]=config, body[15] bit 0x40 = HOLD)
        const echoCfg = body[14] ?? -1;
        const echoSide = (body[15] ?? 0) & 0x40 ? 1 : 0;
        const present = echoCfg === config && echoSide === side;
        return { present, raw: body };
      // (empty-slot heuristic computed by the caller from raw[16..]; see fcReadSwitch return)
      } catch {
        return { present: false, raw: [] };
      }
    };
    const tap = await readSide(0);
    const hold = await readSide(1);
    // Empty-slot heuristic: an unassigned switch returns its primary value region (body[18],[19]) as
    // 0,0 (confirmed live: an explicitly-unassigned switch reads 0,0 while an assigned/templated one
    // carries a non-zero value there). This is the one interior signal that is stable enough to surface;
    // it is a presence hint, not a field decode.
    const emptyOf = (b: number[]) => !b.length || ((b[18] ?? 0) === 0 && (b[19] ?? 0) === 0);
    return {
      effectId: model.effectId,
      layout,
      view,
      switch: sw,
      config,
      tap: { selector: config * 2, present: tap.present, empty: emptyOf(tap.raw), raw: tap.raw },
      hold: { selector: config * 2 + 1, present: hold.present, empty: emptyOf(hold.raw), raw: hold.raw }
    };
  }

  /**
   * FC current-state read via the **sub-0x1b value channel** — the one that actually reflects param
   * edits. Request `F0 00 01 74 <model> 01 1b 00 <eid:2×7bit> <pid:2×7bit> 0*9 cs F7`; the response
   * carries the field's **raw value as a little-endian 7-bit int at body byte 12** (ordinal for enums,
   * ASCII for label chars) — verified live (category→1=Bank, colour→ordinal) and against the FM3-Edit
   * capture (colour tracked 3/5/1). This is distinct from `readRange` (sub 0x1a → normalized 0..1) and
   * from `fcReadSwitch` (sub 0x01 → a compiled snapshot that does NOT track edits).
   */
  async fcReadState(layout: number, view: number, sw: number): Promise<FcReadState> {
    const dev = await this.#conn();
    const model = this.#prof.fcModel;
    if (!model) throw new Error('device has no decoded Foot Controller model');
    if (!model.liveState) throw new Error('live FC state read is not supported for this device model (FM3 only); the address model is available via GET /fc/model');
    const eid = model.effectId;
    const config = layout * model.configsPerLayout! + view * model.switches! + sw;
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const build = (pid: number): number[] => {
      const f = [0xf0, 0x00, 0x01, 0x74, this.#prof.model, 0x01, 0x1b, 0x00, ...enc14(eid), ...enc14(pid), 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let cs = 0;
      for (const b of f) cs ^= b;
      f.push(cs & 0x7f, 0xf7);
      return f;
    };
    const read = async (pid: number): Promise<number | null> => {
      const match = (f: number[]) =>
        f[5] === 0x01 && f[6] === 0x1b && f[7] === 0x00 && (f[8]! | (f[9]! << 7)) === eid && (f[10]! | (f[11]! << 7)) === pid;
      try {
        const frames = await dev.request(build(pid), { timeoutMs: 800, quietMs: 40, match: (fs) => fs.some(match) });
        const f = frames.find(match);
        return f ? (f[12]! | (f[13]! << 7)) : null; // raw ordinal / ASCII, LE 7-bit
      } catch {
        return null;
      }
    };
    const pidOf = (field: string, idx = 0): number => {
      const fd = model.fields[field];
      if (!fd || fd.base == null || fd.stride == null) throw new Error(`FC field '${field}' has no base/stride on this device`);
      return fd.base + config * fd.stride + idx;
    };
    const readLabel = async (field: string): Promise<string> => {
      let s = '';
      for (let i = 0; i < (model.labelLen ?? 0); i++) {
        const c = await read(pidOf(field, i));
        if (c && c > 0) s += String.fromCharCode(c); // 0 = NUL pad
      }
      return s;
    };
    const fields: Record<string, number | null> = {};
    for (const field of ['tapCategory', 'tapFunction', 'tapDisplay', 'holdCategory', 'holdFunction', 'holdDisplay', 'color']) {
      fields[field] = await read(pidOf(field));
    }
    return { effectId: eid, layout, view, switch: sw, config, fields, tapLabel: await readLabel('tapLabel'), holdLabel: await readLabel('holdLabel') };
  }

  /** Raw bulk-read of any effect's param values indexed by paramId — for FC (eid 199) / Modifier
   *  (eid 3), whose params carry no display range so blockParams returns them empty. Sparse
   *  (only non-zero pids), first channel. The client computes pids from the FC/Modifier model. */
  async rawBlock(eid: number): Promise<{ eid: number; values: Record<number, number> }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), {
      timeoutMs: 2500,
      quietMs: 120,
      match: (fs) => fs.some((f) => f[5] === 0x76)
    });
    const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
    const values: Record<number, number> = {};
    bulk.values.forEach((v, i) => {
      if (v) values[i] = v;
    });
    return { eid, values };
  }

  /** Cab IR catalog. `refresh` is the API hook for live per-device USER/SCRATCHPAD reads; the live
   *  wire path is still RE-pending, so refresh currently preserves the bundled factory/legacy banks
   *  and fails soft instead of breaking the picker/cache build. */
  async cabIrs(refresh = false): Promise<Record<string, string[]>> {
    const base = Object.fromEntries(Object.entries(this.#prof.cabIrs()).map(([k, v]) => [k, [...v]]));
    if (!refresh) return base;
    try {
      const live = await this.#liveCabIrs();
      return { ...base, ...live };
    } catch {
      return base;
    }
  }

  async #liveCabIrs(): Promise<Record<string, string[]>> {
    return {};
  }

  /** Cab block state for the IR picker: current mode (Legacy / DynaCab), per-slot bank + IR index +
   * dyna type, plus the option lists. IR names come from fractal-midi (profile.cabIrs() / GET /cab/irs).
   * Writes are plain setParam calls through the device-true CABINET_* param ids. */
  async cabState(eid: number) {
    const slug = slugForEffectId(eid) ?? '';
    const family = SLUG_FAMILY[slug.toLowerCase()];
    if (family !== 'CABINET') return { error: 'not a cab block' };
    let values: number[] = [];
    let base = 0;
    try {
      const dev = await this.#conn();
      const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: 2500, quietMs: 120, match: (fs) => fs.some((f) => f[5] === 0x76) });
      const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
      values = bulk.values;
      const activeCh = (await this.#statusByEffectId()).get(eid)?.channel ?? 0;
      base = this.#channelSlice(family, bulk, activeCh).base;
    } catch {
      /* device unreachable — return option lists with zeroed current state */
    }
    // discrete params store the ordinal; if it looks 16-bit-scaled, unscale against the known max
    // (base = this channel's slice of the bulk read — cab mode/bank/IR/dyna are per-channel, like everything else on the block)
    const ord = (id: number, max: number) => { const raw = values[base + id] ?? 0; return max > 0 && raw > max ? Math.round((raw / 65534) * max) : raw; };
    const pid = (name: string) => this.#paramId(family, name);
    const bankPids = [1, 2, 3, 4].map((n) => pid(`CABINET_BANK${n}`)).filter((x): x is number => x != null);
    const irPids = [1, 2, 3, 4].map((n) => pid(`CABINET_TYPE${n}`)).filter((x): x is number => x != null);
    const dynaPids = [1, 2, 3, 4].map((n) => pid(`CABINET_DYNACAB_TYPE${n}`)).filter((x): x is number => x != null);
    const modeParam = pid('CABINET_MODE') ?? 31;
    const bankOptionPid = bankPids[0] ?? 0;
    const dynaOptionPid = dynaPids[0] ?? 85;
    const bankOptions = this.#enumOptions(family, bankOptionPid, 'Bank', 0, 4).map((o) => o.label);
    const dynaLabels = this.#prof.enumLabelsFor(family, dynaOptionPid) ?? [];
    const dynaOptions = this.#enumOptions(family, dynaOptionPid, 'DynaCab Type', 0, Math.max(0, dynaLabels.length - 1));
    const modeOptions = this.#enumOptions(family, modeParam, 'Mode', 0, 1);
    const irBanks = await this.cabIrs(false);
    const slots = bankPids.slice(0, 2).map((bankParam, s) => {
      const irParam = irPids[s] ?? 4 + s;
      const dynaParam = dynaPids[s] ?? 85 + s;
      const bankV = ord(bankParam, bankOptions.length - 1);
      const bankLabel = bankOptions[bankV] ?? String(bankV);
      const list = irBanks[bankLabel] ?? [];
      const irIndex = ord(irParam, Math.max(0, list.length - 1));
      const dynaV = ord(dynaParam, Math.max(0, dynaOptions.length - 1));
      return { slot: s + 1, bankParam, irParam, dynaParam, bank: { value: bankV, label: bankLabel }, irIndex, irName: list[irIndex] ?? `#${irIndex}`, dyna: { value: dynaV, label: dynaOptions[dynaV]?.label ?? String(dynaV) } };
    });
    const modeV = ord(modeParam, 1);
    return { modeParam, mode: { value: modeV, label: modeOptions[modeV]?.label ?? '' }, modeOptions, bankOptions, dynaOptions, slots };
  }

  /** Per-block "meter" values for the always-on grid level fill + swipe controls.
   * For each placed block: one bulk read → the norm of its primary param (auto-picked Level/Mix/…)
   * plus any client-requested swipe-control paramIds (`wants[slug]`). One HTTP call, N serial reads. */
  async meters(wants: Record<string, number[]> = {}): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  > {
    const g = await this.grid();
    const out: { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[] = [];
    const dev = await this.#conn();
    const status = await this.#statusByEffectId().catch(() => new Map<number, { bypassed: boolean; channel: number }>());
    for (const c of g.cells) {
      if (c.isShunt) continue;
      const slug = slugForEffectId(c.effectId);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      if (!slug || !family) continue;
      const defs = this.#prof.params[family] ?? [];
      const knobs = defs.filter((p) => {
        const r = this.#prof.ranges[family]?.[p.paramId];
        if (r?.kind !== 'float' || r.displayMin === r.displayMax || (r.displayMin === 0 && r.displayMax === 1)) return false;
        const label = p.displayLabel ?? p.name;
        return KNOB_UNITS.has(p.unit ?? '') && !/bypass/i.test(label) && !/_/.test(label) && !/^[A-Z][A-Z0-9+]*$/.test(label);
      });
      const primary = knobs.find((p) => /level|mix|master|volume|gain|drive/i.test(p.displayLabel ?? p.name)) ?? knobs[0];
      if (!primary) continue;
      const wantIds = new Set<number>([primary.paramId, ...(wants[slug] ?? [])]);
      const vals: Record<number, MeterVal> = {};
      let typeName = '';
      try {
        const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(c.effectId), { timeoutMs: 2000, quietMs: 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        const activeCh = status.get(c.effectId)?.channel ?? 0;
        const { base } = this.#channelSlice(family, bulk, activeCh);
        for (const id of wantIds) {
          const d = this.#display(family, id, bulk.values[base + id] ?? 0);
          vals[id] = { norm: d.norm, value: d.value, unit: d.unit, min: d.min, max: d.max, log: d.log };
        }
        const typeId = this.#paramId(family, 'type');
        if (typeId != null) {
          const roster = this.#prof.rosterFor(slug);
          const tmax = Math.max(0, roster.length - 1);
          const rawT = bulk.values[base + typeId] ?? 0;
          typeName = roster[rawT > tmax ? Math.round((rawT / 65534) * tmax) : rawT]?.name ?? '';
        }
      } catch {
        /* leave vals empty for this block */
      }
      out.push({ effectId: c.effectId, slug, defaultId: primary.paramId, defaultName: primary.displayLabel ?? primary.name, typeName, vals });
    }
    return out;
  }

  /** Live audio meters per placed monitored block. Reads each block's primary monitor level via the
   *  block-level GET (fn 0x01 sub 0x01 00 by effectId); the level is a normalized 0..1 float at
   *  response offset 12-16 (LSB-first 5×7bit → uint32 → float32-LE — confirmed from the FM3 capture
   *  2026-07-02; note the standard gen-3 float decoder does NOT apply to this field). Mapped to dB
   *  via the profile's monitor table. Gen-3 only; [] if the device has no monitor table. */
  async liveMonitors(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]> {
    const mon = this.#prof.monitorParams;
    if (!mon) return [];
    // family → ALL its monitor defs (a block can expose several: OUTPUT VU L+R, M-Comp 3 bands, cab
    // gain+VU, drive gain+supply+headroom). Previously only the family's first def was read.
    const byFamily = new Map<string, { paramName: string; family: string; pid: number; role: string; minDb?: number; maxDb?: number }[]>();
    for (const [paramName, def] of Object.entries(mon)) {
      const arr = byFamily.get(def.family) ?? [];
      arr.push({ paramName, ...def });
      byFamily.set(def.family, arr);
    }
    const dev = await this.#conn();
    const model = this.#prof.model;
    const out: { effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[] = [];
    // Which block(s) to poll. Axis polls the OPEN block (onlyEid) at UI rate — resolve its family
    // straight from the effectId; do NOT fetch grid() here. grid()'s 500ms cache expires right at the
    // ~500ms meter-poll interval, so a full ~24KB preset dump was firing on every tick and serializing
    // behind every read → link latency ballooned to ~400ms. Only the (rare) all-blocks call needs grid().
    const eids = onlyEid != null ? [onlyEid] : (await this.grid()).cells.filter((c) => !c.isShunt).map((c) => c.effectId);
    for (const eid of eids) {
      const slug = slugForEffectId(eid);
      const family = slug ? SLUG_FAMILY[slug] : undefined;
      const defs = family ? byFamily.get(family) : undefined;
      if (!defs) continue;
      // Poll each monitor pid via the capture-confirmed fn 0x01 sub 0x19 state read (FM3-Edit's live-meter
      // poll; value is a normalized 0..1 float mapped to dB by the table's linear range). Model-generic.
      for (const def of defs) {
        try {
          const frames = await dev.request(buildBlockMonitorPoll(eid, def.pid, model), {
            timeoutMs: 800, quietMs: 40,
            match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, def.pid))
          });
          const r = frames.find((f) => isBlockMonitorResponse(f, eid, def.pid));
          if (!r) continue;
          // The OUTPUT block's VU (eid 0x2a, pid 16/17 = sub 0x10/0x11) is the SAME frame as the
          // leveling meters → its value is RMS ENERGY, not a 0..1 norm. Decode it via 10·log10 and
          // renormalize into [min,max] for the bar. Every other block monitor is a 0..1 norm.
          let norm: number;
          let db: number | null;
          if (def.family === 'OUTPUT') {
            const lo = def.minDb ?? -40, hi = def.maxDb ?? 6;
            db = meterRmsToDb(parseOutputMeterRms(r), lo, hi);
            norm = hi > lo ? (db - lo) / (hi - lo) : 0;
          } else {
            norm = parseBlockMonitorNorm(r);
            db = def.minDb != null && def.maxDb != null ? def.minDb + norm * (def.maxDb - def.minDb) : null;
          }
          out.push({ effectId: eid, family: def.family, paramName: def.paramName, role: def.role, norm, db, minDb: def.minDb, maxDb: def.maxDb });
        } catch {
          /* skip this monitor */
        }
      }
    }
    return out;
  }

  /** Looper page telemetry: the live waveform envelope + playhead position + level (FM3 capture 2026-07-04;
   *  gen-3 shared). Waveform = fn 0x01 sub 0x23 (~595 raw 7-bit magnitudes → 0..1); position = sub 0x19
   *  pid 14 (0..1 across the loop); level = sub 0x19 pid 22. Returns empty with NO device I/O when the
   *  block isn't a looper, so Axis can poll it for whatever block is open without cost. */
  async looperTelemetry(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }> {
    if (slugForEffectId(eid) !== 'looper') return { wave: [], position: null, level: null };
    const dev = await this.#conn();
    const model = this.#prof.model;
    let wave: number[] = [];
    let position: number | null = null;
    let level: number | null = null;
    try {
      const wf = await dev.request(buildLooperWaveformPoll(eid, model), { timeoutMs: 900, quietMs: 60, match: (fs) => fs.some((f) => isLooperWaveformResponse(f, eid)) });
      const r = wf.find((f) => isLooperWaveformResponse(f, eid));
      if (r) wave = parseLooperWaveform(r);
    } catch { /* no waveform this tick */ }
    for (const [pid, isPos] of [[14, true], [22, false]] as const) {
      try {
        const fr = await dev.request(buildBlockMonitorPoll(eid, pid, model), { timeoutMs: 500, quietMs: 40, match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, pid)) });
        const rr = fr.find((f) => isBlockMonitorResponse(f, eid, pid));
        if (rr) { const v = parseBlockMonitorNorm(rr); if (isPos) position = v; else level = v; }
      } catch { /* skip */ }
    }
    return { wave, position, level };
  }

  /** Toggle a looper transport control (record/play/stop/overdub/undo/once/reverse/half) — the sub-0x10
   *  float-1.0/0.0 write FM3-Edit uses (capture 2026-07-04). `action` resolves to the block's control pid
   *  via the device catalog, so it's model-agnostic. Fire-and-forget (serialized). */
  async looperControl(eid: number, action: string, on: boolean): Promise<{ ok: boolean }> {
    if (slugForEffectId(eid) !== 'looper') return { ok: false };
    const NAME: Record<string, string> = {
      record: 'LOOPER_RECORD', play: 'LOOPER_PLAY', stop: 'LOOPER_STOP', overdub: 'LOOPER_DUB',
      undo: 'LOOPER_UNDO', once: 'LOOPER_ONCE', reverse: 'LOOPER_REVERSE', half: 'LOOPER_HALF'
    };
    const name = NAME[action];
    if (!name) return { ok: false };
    const pid = (this.#prof.params['LOOPER'] ?? []).find((p) => p.name === name)?.paramId;
    if (pid == null) return { ok: false };
    const dev = await this.#conn();
    await dev.sendQueued(buildLooperControl(eid, pid, on, this.#prof.model));
    return { ok: true };
  }

  /** Build dropdown options for an enum param. Labels come from fractal-midi's enum overlay
   * (matched by device param name) where known; otherwise the bare ordinal. */
  #enumOptions(family: string, paramId: number, name: string, min: number, max: number): { value: number; label: string }[] {
    const cache = this.#prof.enumLabelsFor(family, paramId); // device-true labels from the editor cache
    const ov = resolveEnumValues(name); // III overlay fallback
    const out: { value: number; label: string }[] = [];
    for (let v = min; v <= max && out.length < 128; v++) {
      out.push({ value: v, label: cache?.[v] ?? ov?.values?.[v] ?? String(v) });
    }
    return out;
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true FM3 range.
   * Taper: a device-true explicit `range.taper` ('log'→log10; 'linear'|'flat'|'custom'→linear) wins;
   * absent it falls back to the typecode heuristic (middle nibble 4/5 = log10, e.g. freq cuts, else linear). */
  #display(family: string | undefined, paramId: number, raw: number): { value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean } {
    const norm = clamp01(raw / 65534);
    const range = family ? this.#prof.ranges[family]?.[paramId] : undefined;
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax) && range.displayMin !== range.displayMax) {
      try {
        // Taper (log vs linear). A device-true explicit taper from the capture catalog WINS over the
        // typecode-nibble heuristic: 'log' → log sweep; 'linear' | 'flat' | 'custom' → linear. A
        // 'custom' taper's `taperPoints` are NOT applied on the wire yet, so custom is served linear
        // for now (the Axis side documents the same). A log sweep still requires a positive range —
        // wireToDisplay throws on log10 with displayMin<=0 — the same guard the nibble heuristic uses.
        // When NO explicit taper is present, fall back to the unchanged typecode-nibble heuristic.
        // `range.taper` reads device-true from a static-catalog row today, and reads the same field once
        // walk-built RangeDefs carry it (parallel WP) — no rework needed here either way.
        let log: boolean;
        if (range.taper) {
          log = range.taper === 'log' && range.displayMin > 0;
        } else {
          const taperNib = (range.typecode >> 4) & 0xf;
          log = (taperNib === 4 || taperNib === 5) && range.displayMin > 0;
        }
        const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
        // Prefer the DEVICE-TRUE unit captured by the live-walk (RangeDef.unit, view 0x00)
        // over the AM4-name-overlay catalog code; fall back to the overlay when absent
        // (byte-source/.cache profiles carry no device-true unit).
        const unitCode = family ? this.#prof.params[family]?.find((x) => x.paramId === paramId)?.unit : undefined;
        return { value: round3(v), norm, unit: range.unit ?? ((unitCode && UNIT_LABEL[unitCode]) || undefined), min: range.displayMin, max: range.displayMax, log: log || undefined };
      } catch {
        /* fall through to 0..10 position */
      }
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the model-selector,
   *  in strict preference order:
   *    1. `<FAM>_MODEL` — DELAY: its `DELAY_TYPE` is the 8-value MONO/STEREO routing enum, the
   *       real model list lives on `DELAY_MODEL` (cache-confirmed FM3/FM9/III 2026-07-06);
   *    2. the EXACT `<FAM>_TYPE` name regardless of unit — the FM3/FM9 device-true catalogs tag
   *       it `unverified`, and the old `unit==='enum' && /TYPE$/` heuristic then matched a
   *       DIFFERENT selector entirely (FUZZ → FUZZ_CLIPTYPE pid 10, PITCH → PITCH_XFADETYPE
   *       pid 46; III DYNDIST → DYNDIST_BQTYPE) — so the Drive block's "type" read AND wrote
   *       the clipping-diode param (the field-reported drive-type bug);
   *    3. the enum-unit /TYPE$/ heuristic, as the last resort for families with neither. */
  #paramId(family: string, name: string): number | undefined {
    const defs = this.#prof.params[family] ?? [];
    if (name.toLowerCase() === 'type') {
      return (defs.find((p) => p.name === `${family}_MODEL`)
        ?? defs.find((p) => p.name === `${family}_TYPE`)
        ?? defs.find((p) => p.unit === 'enum' && /TYPE$/i.test(p.name)))?.paramId;
    }
    return defs.find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }

  // ── device-edit push (capability deviceEditPush): reflect front-panel / editor edits the device
  // broadcasts unsolicited (0x74/0x75/0x76). The registry's persistent RX listener hands us the
  // reassembled burst; we diff it against the last-known channel-A values so a whole-block packet
  // yields only the moved param(s). blockParams() primes the baseline when a block is opened. ──
  #editSnapshot = new Map<number, number[]>(); // effectId → last-known active-channel wire values
  #watchedEid: number | null = null; // FM3 poll target: the block Axis last opened (set in blockParams)
  #watchedChannel = 0; // active channel (0-3) of the watched block — the burst slice the poll diffs against
  #lastLocalEditAt = 0; // ms of the last local param write — the FM3 poll pauses briefly after (no self-echo)

  /** FM3 device-edit POLL (capability deviceEditWatch — FM3 doesn't push, unlike FM9/III). The registry
   *  supervisor calls this on a timer; we re-read the currently-open block via the fn-0x1F bulk read and
   *  reuse decodeEditBurst's diff to emit per-param `param` events for any knob moved on the front panel.
   *  Returns {changed:true} only for a first-sight reload (registry emits `changed`); per-param events are
   *  emitted directly here. Paused for ~2s after a local write so it never echoes our own edit mid-drag. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    const eid = this.#watchedEid;
    if (eid == null) return { changed: false }; // no block opened yet — nothing to watch
    if (Date.now() - this.#lastLocalEditAt < 2000) return { changed: false }; // mid local edit → skip (avoid echo)
    const dev = await this.#conn();
    let frames: number[][];
    try {
      frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), { timeoutMs: dev.slow ? 4000 : 1500, quietMs: dev.slow ? 300 : 100, match: (fs) => fs.some((f) => f[5] === 0x76) });
    } catch { return { changed: false }; } // no reply / timeout — keep last baseline
    const res = this.decodeEditBurst(frames);
    if (res.reload) return { changed: true }; // first sight of this block → let the registry emit a reload
    for (const e of res.events) this.#emit({ type: 'param', effectId: e.effectId, paramId: e.paramId, norm: e.norm });
    return { changed: false }; // per-param events already emitted
  }

  decodeEditBurst(frames: number[][]): { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean } {
    let bulk: ReturnType<ModernFractalCodec['assembleGen3BlockBulkRead']>;
    try { bulk = this.#codec.assembleGen3BlockBulkRead(frames); } catch { return { events: [], reload: false }; }
    const eid = bulk.blockId;
    if (bulk.values.length === 0) return { events: [], reload: false }; // head-only / empty — nothing to read
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()] ?? this.#prof.familyForEffectId(eid);
    const defs = family ? (this.#prof.params[family] ?? []) : [];
    if (!family || defs.length === 0) return { events: [], reload: false }; // no param family mapped
    // Slice the block's ACTIVE channel (the one blockParams surfaced) — the body is channel-blocked, so
    // diffing against channel A while the user has B-D open would flag every A/B-different param as "moved".
    const { stride, base } = this.#channelSlice(family, bulk, eid === this.#watchedEid ? this.#watchedChannel : 0);
    const cur = bulk.values.slice(base, base + stride);
    const prev = this.#editSnapshot.get(eid);
    this.#editSnapshot.set(eid, cur);
    // First sight of this block (never opened) → we can't diff. Ask the registry for a full reload so the
    // edit isn't lost; subsequent edits on this block then diff per-param.
    if (!prev) return { events: [], reload: true };
    const events: { effectId: number; paramId: number; norm: number }[] = [];
    for (const p of defs) {
      const id = p.paramId;
      if (id >= stride) continue;
      if (cur[id] === undefined || cur[id] === prev[id]) continue; // unchanged / truncated → skip
      if (!this.#prof.ranges[family]?.[id]) continue; // only real controls (skip internal/bypass churn)
      events.push({ effectId: eid, paramId: id, norm: clamp01((cur[id] ?? 0) / 65534) });
    }
    return { events, reload: false };
  }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    const r = continuous ? await this.#send(this.#codec.buildSetParameterContinuous(eid, paramId, clamp01(value))) : await this.#write(this.#codec.buildSetParameter(eid, paramId, value));
    this.#lastLocalEditAt = Date.now(); // pause the FM3 device-edit poll briefly so it doesn't echo our own write mid-drag
    this.#emit({ type: 'param', effectId: eid, paramId, norm: value }); // live: other UIs move the knob
    return r;
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()];
    const tid = family ? this.#paramId(family, 'type') : undefined;
    if (tid == null) return { ok: false };
    const r = await this.#write(this.#codec.buildSetParameter(eid, tid, value));
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setBypass(eid: number, bypassed: boolean) {
    const r = await this.#send(this.#codec.buildSetBypass(eid, bypassed)); // instant toggle
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async setChannel(eid: number, channel: string) {
    const idx = CH_LETTERS.indexOf(channel.toUpperCase());
    if (idx < 0 || idx > 3) return { ok: false };
    const wireChannel = idx as 0 | 1 | 2 | 3;
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetChannelNative(eid, wireChannel)
      : this.#codec.buildSetChannel(eid, wireChannel);
    const r = await this.#send(frame); // instant
    this.#emit({ type: 'blockState', effectId: eid });
    return r;
  }

  /**
   * Bind a modifier slot to a target parameter. The modifier→target link lives on the modifier's own
   * eid as two params: targetEffectId (the block) + targetParam (the paramId), plus the source. Slot is
   * 1-based; slot N = modModel.effectId + (N-1). Writes the three discrete SETs that activate the link.
   */
  async bindModifier(slot: number, targetEffectId: number, targetParam: number, source: number) {
    const mm = this.#prof.modModel;
    if (!mm) return { ok: false, error: 'device has no modifier model' };
    const f = mm.fields;
    if (!f.targetEffectId || !f.targetParam || !f.source) {
      return { ok: false, error: 'modifier model is missing the target-binding fields (source/targetEffectId/targetParam)' };
    }
    const slotEid = mm.effectId + (Math.max(1, Math.floor(slot)) - 1);
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetEffectId.pid, targetEffectId));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.targetParam.pid, targetParam));
    await this.#write(this.#codec.buildSetParameter(slotEid, f.source.pid, source));
    return { ok: true, slotEid, slot, targetEffectId, targetParam, source };
  }

  /** Modifier address model for GET /mod/model — the profile's ModModel plus the Phase-6 superset
   *  field `bindingSupported` (gen-3 binds via /mod/bind). Prepended so the JSON stays additive-only
   *  against the pre-Phase-6 sweep baseline. */
  modifierModel(): Record<string, unknown> | null {
    const mm = this.#prof.modModel;
    return mm ? { bindingSupported: true, ...mm } : null;
  }

  // ── tempo / scene ──
  /** Current tempo (BPM). Parsed via the bound codec's 0x14 payload parser (LSB-first septet pair). */
  async getTempo(): Promise<{ bpm: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetTempo(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x14) });
    const f = frames.find((x) => x[5] === 0x14);
    if (!f) return { bpm: 0 };
    return { bpm: this.#codec.parseTempoResponse(f).bpm };
  }
  /** Set tempo the way FM3-Edit does (captured): a param write at the global-tempo address,
   * BPM as a 5-septet float32 value. (The 0x14 SET appears not to take on FM3.) */
  async setTempo(bpm: number) {
    await (await this.#conn()).sendQueued(buildSetTempoViaParam(bpm, this.#prof.model));
    this.#emit({ type: 'tempo', bpm });
    return { ok: true };
  }
  async tapTempo() {
    return this.#send(this.#codec.buildTempoTap());
  }
  /** Current scene index (0-based). Parsed via the bound codec's 0x0C payload parser. */
  async getScene(): Promise<{ index: number }> {
    const dev = await this.#conn();
    const frames = await dev.request(this.#codec.buildGetScene(), { timeoutMs: 1200, match: (fs) => fs.some((f) => f[5] === 0x0c) });
    const f = frames.find((x) => x[5] === 0x0c);
    if (!f) return { index: -1 }; // FAILED read (racy/late on a busy link) — sentinel so the scene watch
    //                               and UI skip it, instead of fabricating scene 1 (caused a 2↔1 badge flicker)
    return { index: this.#codec.parseSceneResponse(f).scene };
  }
  async setScene(index: number) {
    if (index < 0 || index > 7) return { ok: false };
    const frame = this.#prof.sceneChannelWriteMode === 'fm3-edit-fn01'
      ? this.#codec.buildSetSceneNative(index)
      : this.#codec.buildSetScene(index);
    const r = await this.#send(frame);
    // scene selects per-scene bypass/channel; status is read fresh each placedBlocks() call, so no
    // cache to bust — just notify subscribers so the UI follows.
    this.#emit({ type: 'scene', index });
    return r;
  }
  /** Rename a scene (0..7) in the WORKING BUFFER (fn 0x01 sub 0x2b, via fractal-midi's buildSetSceneName).
   *  Visible immediately; NOT persisted to flash — that's a separate store op. Name is 32-char ASCII max.
   *  #write watches briefly for a 0x64 rejection so the caller learns if the device refused it. */
  async setSceneName(index: number, name: string) {
    if (index < 0 || index > 7) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, 32 max
    return this.#write(this.#codec.buildSetSceneName(index, clean));
  }
  /** Rename the working-buffer PRESET (fn 0x01 sub 0x28, via fractal-midi's buildRenamePreset). Visible
   *  immediately; persist to flash is the separate store op. Name is 32-char printable ASCII max. */
  async setPresetName(name: string) {
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    return this.#write(this.#codec.buildRenamePreset(clean));
  }
  async placeCell(row: number, col: number, blockId: number) {
    // Guard against placing an instance the unit doesn't have (e.g. Amp 2 on an FM3, which has one
    // amp). The protocol reserves an ID range per family but each unit allows fewer — reject here so
    // the rule is authoritative server-side, not just a UI hint, and we don't waste a doomed write.
    const ref = blockRefForEid(blockId);
    if (ref) {
      const limit = this.#prof.instanceLimits[ref.slug] ?? this.#prof.defaultInstances;
      if (ref.instance > limit) {
        const err = new Error(`${this.#prof.name} has no ${ref.slug} ${ref.instance} (max ${limit} of this block)`);
        (err as Error & { statusCode?: number }).statusCode = 400; // client error, not a server fault
        throw err;
      }
    }
    // FM3 needs a cell-select (sub 0x30) before the insert (sub 0x32), or the block
    // lands at the default cell. buildClearBlock IS that select frame (no-op on an
    // empty cell). For blockId 0 this becomes select + insert-0 = clear, like the C#.
    await this.#write(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
    const r = await this.#write(this.#codec.buildSetGridCell({ row, col, blockId, rows: this.#prof.rows }));
    this.#gridCache = null;
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(this.#codec.buildSetGridRouting({ srcRow, srcCol, destRow, rows: this.#prof.rows, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }));
    this.#gridCache = null;
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async selectPreset(n: number) {
    this.#gridCache = null;
    const r = await this.#write(this.#codec.buildSwitchPresetSysEx(n));
    this.#emit({ type: 'changed', scope: 'preset' });
    return r;
  }
  /** Reload the CURRENT preset from flash by re-selecting it — the FULL-mode self-describe walk's
   *  non-destructive per-block safety net. Reuses presetRef() (current number) + selectPreset() (the
   *  wire builder), so no new preset-switch bytes are minted here. No-op when no preset is resolvable. */
  async reloadPreset(): Promise<void> {
    const { number } = await this.presetRef();
    if (number >= 0) await this.selectPreset(number);
  }
  async store(n: number) {
    return this.#write(this.#codec.buildStorePreset(n));
  }

  /** Load a raw preset dump (.syx bytes) straight into the device's EDIT BUFFER — no slot is touched
   *  (only `store` writes a slot). This is how you play a preset that isn't on the device (e.g. a
   *  cloud-only backup), sidestepping the slot limit. Sent paced (the FM3 CDC drops a flooded write).
   *
   *  The dump's preset-dump header (func 0x77) carries the TARGET slot as a 14-bit, MSB-first
   *  7-bit pair. A dump captured from slot N still names N — re-sending it verbatim makes the unit
   *  treat it as a store-to-N, NOT a load. Retargeting the header to 0x3FFF (`7F 7F`, the
   *  edit-buffer sentinel) is exactly what FM3-Edit's "Audition" does: the preset goes live in the
   *  edit buffer, no slot is written. We patch that field and fix the frame checksum in place. */
  async loadPresetBytes(syx: Uint8Array): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const bytes = Array.from(syx);
    retargetPresetDumpToEditBuffer(bytes);
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    this.#gridCache = null; // edit buffer changed → next grid/blocks read reflects it
    return { ok: true };
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

/** Create a gen-3 driver bound to one device profile (Axe-Fx III / FM3 / FM9). */
export function createGen3Driver(profile: DeviceProfile, ctx: DriverCtx): Gen3Driver {
  return new Gen3Driver(profile, ctx);
}
export type { Gen3Driver };
