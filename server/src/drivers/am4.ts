// AM4 device driver (model 0x15) — a parallel driver to the gen-3 one. The AM4 is a flat 4-slot,
// linear-routing unit (no grid), addressed by (pidLow=block, pidHigh=param) — totally different from
// the gen-3 grid codec — so it gets its own logic + DTOs. It REUSES the single open connection that
// the registry owns (ctx.transport()), since only one device is ever connected at a time.
// Codec is forgefx-midi/am4 (hardware-verified upstream); this layer just drives it over the transport.
import {
  buildReadParam,
  BLOCK_SLOT_PID_LOW,
  BLOCK_NAMES_BY_VALUE,
  resolveBlockTypeValue,
  BLOCK_TYPE_VALUES,
  buildSetParam,
  buildSetParamNorm,
  buildSetFloatParam,
  buildSetBlockType,
  buildSetBlockBypass,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchScene,
  buildSwitchPreset,
  buildGetPresetName,
  parseGetPresetNameResponse,
  // Tuner readout (block 0x0023) — live-poll reads decoded upstream (BigCapture 2026-07-05).
  // (buildReadParam already imported above for the atomic structure read.)
  buildReadActiveChannel,
  parseActiveChannelResponse,
  READ_TYPE_LIVE_POLL,
  parseReadResponse,
  isPollResponse,
  AM4_TUNER_PID_LOW,
  AM4_TUNER_CHANNEL,
  decodeAm4Tuner,
  isCommandAck,
  buildSaveToLocation,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  parseAm4PresetDump,
  parseAm4PresetBank,
  am4DumpLocation,
  decodeAm4PresetNameFromFrame,
  parseAm4Firmware,
  formatLocationCode,
  AM4_PRESET_FRAME_SIZE,
  AM4_MOD_EFFECT_ORDINAL,
  AM4_MOD_SLOT_COUNT,
  AM4_MOD_FIELDS,
  AM4_MODIFIER_SOURCES,
  AM4_MOD_OPERATIONS,
  AM4_MOD_CHANNELS,
  // param catalog — the reader returns DECODED display values keyed by param name; we join it
  // against KNOWN_PARAMS here to recover the unit / range / enum-option / norm metadata the DTO carries.
  KNOWN_PARAMS,
  TOTAL_LOCATIONS,
  // Raw-int MIDI-config registers (global MIDI map + per-scene MIDI, and the `_cc` CC-assignment
  // slots) read back a literal integer whose 128 value is the "None"/unassigned sentinel (BUG-6/GAP-2).
  RAW_INT_NONE_SENTINEL,
  type Param,
  type ParamKey
} from 'forgefx-midi/am4';
// The VERIFIED high-level descriptor reader (hardware-confirmed upstream). We drive it over an adapter
// that wraps ForgeFX's Transport as the MidiConnection the reader expects (see Am4Conn below).
import { AM4_DESCRIPTOR, readActiveBufferEditedBit, readAllParams, decodeAm4PresetDumpBytes } from 'forgefx-midi/devices/am4';
import type { MidiConnection } from 'forgefx-midi/core/midi';
import type { DispatchCtx, PresetSnapshot } from 'forgefx-midi/core';
import type { Transport } from '../transport/types.js';
import type { DeviceDriver, DriverCapabilities, DriverCtx, PresetGridDTO, PresetBlockDTO, NamedParam, EnumParam, Am4Slot } from './types.js';
import { am4LayoutFor, type TypeModel, type DeviceLayout } from '../devices.js';

/** Split a raw byte stream into its complete F0..F7 SysEx messages. */
function splitSysex(bytes: number[]): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xf0) { i++; continue; }
    const end = bytes.indexOf(0xf7, i);
    if (end < 0) break;
    out.push(bytes.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

/** Raw-int MIDI-config registers (the `_cc` CC-assignment slots) read back the literal string
 *  'None' (RAW_INT_NONE_SENTINEL = 128, decoded upstream by decodeRawIntRegister) when unassigned.
 *  Such a value is NOT a knob position: coercing it in blockParams' continuous branch would land a
 *  broken `Number('None') || 0` → 0 (a real CC). Surface it instead as a single-option selector so
 *  Axis renders "None" verbatim. Returns null for any numeric (or numeric-string) display — the
 *  normal knob/enum path handles those. Exported for unit tests. */
export function am4NoneSelector(id: number, name: string, display: number | string): EnumParam | null {
  if (typeof display !== 'string') return null;
  if (display.trim() === '' || Number.isFinite(Number(display))) return null; // numeric string → normal path
  return { id, name, value: RAW_INT_NONE_SENTINEL, options: [{ value: RAW_INT_NONE_SENTINEL, label: display }] };
}

/** Opt-in container decode of a verbatim AM4 preset dump (the 6-message 0x77/0x78/0x79 stream) →
 *  the CRC-validity flag + the four plaintext scene names, for enriching the backup / offline-decode
 *  DTOs. ADDITIVE: the opaque `bytes` round-trip is untouched. Returns null (never throws) on a
 *  malformed/corrupt dump so the enrichment silently degrades and the opaque backup still succeeds.
 *  Exported for unit tests. */
export function am4DecodeEnrichment(rawBytes: Uint8Array): { sceneNames: string[]; crcValid: boolean } | null {
  try {
    const d = decodeAm4PresetDumpBytes(rawBytes);
    return { sceneNames: [...d.sceneNames].map((s) => s.trim()), crcValid: d.crcValid };
  } catch {
    return null;
  }
}

// ── AM4 preset-structure read (fn 0x01, readType 0x1F) — wire-decoded in fractal-midi's am4 SYSEX-MAP.
// ONE request returns a 192-byte structure (220 septets, continuous MSB-first 7→8 bitstream) carrying
// the preset name, active scene, and — at 0xB0/B4/B8/BC — the four per-slot block-type codes (int32 LE).
// This is how the chain is actually read; the per-slot short reads (0x0E) return 0 for placement.
const ATOMIC_READ_TYPE = 0x1f;
const STRUCT_BYTES = 192;
const STRUCT_SLOT_OFFSETS = [0xb0, 0xb4, 0xb8, 0xbc]; // int32 LE block-type code, slot 1..4
const STRUCT_NAME_OFFSET = 0x10;
const STRUCT_SCENE_OFFSET = 0x08;
// int32 LE @0x00 = the CURRENT stored-preset location (0..103). Verified against a beta log
// (log (8).txt, 2026-07-03) across 7 presets: every /preset/select round-trip left this field
// equal to the selected location (Interface=0, Electric=2, AC-20=7, …, Bass NoAmp DI=11).
const STRUCT_LOCATION_OFFSET = 0x00;

/** The 192-byte structure response: F0 …74 15 01 …[1f 00]… <220 septets> cksum F7. */
function isStructResponse(r: number[]): boolean {
  return r.length >= 230 && r[0] === 0xf0 && r[4] === 0x15 && r[5] === 0x01
    && r[10] === 0x1f && r[11] === 0x00 && r[r.length - 1] === 0xf7;
}
/** Continuous MSB-first 7→8 bitstream unpack (load-bearing direction — LSB-first scrambles the fields). */
function unpackMsb(septets: number[], rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen);
  let acc = 0, nbits = 0, o = 0;
  for (const s of septets) {
    acc = (acc << 7) | (s & 0x7f);
    nbits += 7;
    while (nbits >= 8 && o < rawLen) { nbits -= 8; out[o++] = (acc >> nbits) & 0xff; }
    acc &= (1 << nbits) - 1; // keep acc bounded (nbits < 8 after the loop)
  }
  return out;
}
const int32LE = (b: Uint8Array, o: number) => (((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0);
function asciiAt(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) { const c = b[off + i] ?? 0; if (c === 0) break; if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  return s.trim();
}

// ── MidiConnection adapter over ForgeFX's Transport ──────────────────────────────────────────────
// The VERIFIED descriptor reader (getPreset / scanLocations) talks to a `MidiConnection`: it registers
// a `receiveSysExMatching` waiter, then `send`s the request, on the RAW transport (NOT the serialized
// dev.request chain). Two reader calls racing on the shared transport would interleave their waiters +
// sends, so Am4Driver serializes every reader call behind #withReader (a per-instance promise-chain
// mutex). close() is a no-op — the registry owns the transport's lifecycle; we never tear it down.
class Am4Conn implements MidiConnection {
  hasInput = true;
  lastSendError: Error | undefined = undefined;
  #t: Transport;
  constructor(t: Transport) { this.#t = t; }

  send(bytes: number[]): void {
    try {
      this.#t.send(bytes);
      this.lastSendError = undefined;
    } catch (e) {
      this.lastSendError = e instanceof Error ? e : new Error(String(e));
    }
  }

  onMessage(handler: (bytes: number[]) => void): () => void {
    return this.#t.onFrame(handler);
  }

  /** Resolve on the next complete inbound SysEx frame; reject on timeout. Clears the subscription +
   *  timer on BOTH paths so no dangling onFrame handler leaks past the wait. */
  receiveSysEx(timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(() => true, timeoutMs);
  }

  /** Resolve on the first inbound SysEx frame satisfying `pred`; reject on timeout. */
  receiveSysExMatching(pred: (bytes: number[]) => boolean, timeoutMs = 1000): Promise<number[]> {
    return this.#waitFor(pred, timeoutMs);
  }

  #waitFor(pred: (bytes: number[]) => boolean, timeoutMs: number): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => { unsub?.(); reject(new Error(`AM4 receiveSysEx timeout after ${timeoutMs}ms`)); }, timeoutMs);
      unsub = this.#t.onFrame((frame) => {
        if (!pred(frame)) return;
        clearTimeout(timer);
        unsub?.();
        resolve(frame);
      });
    });
  }

  close(): void { /* no-op: the registry owns the transport lifecycle */ }
}

// AM4 unit tag → the display label the gen-3 blockParams DTO uses (so Axis renders both the same way).
// Blank = show the bare number (count/semitones/ratio are unitless integers; knob_0_10/20 are 0..N knobs).
const AM4_UNIT_LABEL: Record<string, string> = {
  db: 'dB', hz: 'Hz', ms: 'ms', seconds: 's', percent: '%', bipolar_percent: '%', degrees: '°', pf: 'pF'
};
/** A pretty param label from a KNOWN_PARAMS key's name: displayLabel if present, else name with _→space. */
function am4ParamLabel(p: Param): string {
  return p.displayLabel ?? p.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
/** Display name for a block slug in the "add a block" palette. Acronyms/compounds that Title-Case badly
 *  get an explicit label; everything else is just capitalized (drive → Drive, reverb → Reverb). */
const AM4_BLOCK_LABEL: Record<string, string> = { geq: 'Graphic EQ', peq: 'Parametric EQ', volpan: 'Vol/Pan', ingate: 'Input Gate' };
function am4BlockLabel(slug: string): string {
  return AM4_BLOCK_LABEL[slug] ?? slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

class Am4Driver implements DeviceDriver {
  readonly modelId = 0x15;
  readonly key = 'am4';
  readonly name = 'AM4';
  readonly capabilities: DriverCapabilities = {
    slotModel: 'linear',
    slotCount: 4,
    gridEdit: true, // slot block-type write (buildSetBlockType): place/change/clear a block in slots 1..4
    scenes: 4,
    channels: true, // 2026-07-08: every block has an independent A/B/C/D channel register (see setChannel)
    presetDump: false, // AM4 backups run their own verbatim dump path (/am4/preset/backup), not the gen-3 one
    presetConvert: true, // partial lift (name + scenes + amp block per-channel params) via the AM4 dump decode
    blockParamDecode: false,
    telemetry: { tuner: true, outputMeters: false, cpu: false }, // tuner via block-0x0023 live-poll (readTuner); no gen-3 meter/CPU frames
    fcModel: false,
    fcLiveRead: false,
    modBind: false, // modifier model is data-only (see modifierModel); the wire binding is not captured
    cabIrs: false,
    editorLayouts: true, // AM4 ships AM4_LAYOUTS (served via am4LayoutFor in blockParams)
    supportsSave: true,
    selfDescribe: false, // the AM4 has its own (non-gen-3) codec; the gen-3 self-describe walk does not apply
    cacheImport: true, // byte-source import via AM4_CACHE_PARAMS/AM4_SEEDS (codec >= 0.3.20); no live walk
    deviceEditWatch: true // AM4 pushes NOTHING on front-panel / AM4-Edit edits (HW-107) → registry polls readDeviceEditState()
  };

  #ctx: DriverCtx;
  constructor(ctx: DriverCtx) { this.#ctx = ctx; }

  /** The ONE shared transport (single exclusive MIDI/serial connection, owned by the registry). */
  #openTransport(): Promise<Transport> { return this.#ctx.transport(); }

  #log(s: string) {
    console.log(`[forgefx][am4] ${s}`);
  }

  #emptySlots = (): Am4Slot[] => [1, 2, 3, 4].map((n) => ({ slot: n, blockType: 'none', pidLow: 0 }));

  // ── VERIFIED-reader plumbing ─────────────────────────────────────────────────────────────────
  // #reader is the descriptor's DeviceReader (getPreset / scanLocations / …). getPreset/scanLocations
  // are optional on the interface, so we assert them present (the AM4 descriptor implements both).
  #reader = AM4_DESCRIPTOR.reader;
  // #readerLock serializes every reader call: the reader drives the RAW transport (bare send + onFrame
  // waiter), which bypasses dev.request's serialization, so two overlapping getPreset calls would
  // interleave on the shared port. Each #withReader appends to this chain and awaits its predecessor.
  #readerLock: Promise<unknown> = Promise.resolve();
  // Brief TTL cache of the last full getPreset dump: a grid render + several blockParams reads on one
  // page load then reuse ONE ~500 ms atomic read (mirrors the gen-3 driver's #gridCache pattern).
  #presetCache: { snap: PresetSnapshot; at: number } | null = null;
  // Cache TTLs are DERIVED from the active cadence (0.8×editWatchMs, clamped ≥500) rather than a fixed
  // 500 ms — so one edit-watch tick never does a redundant double struct read, and a /telemetry/config
  // mode switch keeps every cache coherent (getCadence resolves at call time against the active model
  // byte). editWatchMs is 1500/2000/4000 (perf/balanced/reduced) ⇒ TTL 1200/1600/3200, always < the
  // tick so each tick still re-reads once, but the two reads WITHIN a tick coalesce.
  #cacheTtlMs(): number { return Math.max(500, Math.round(0.8 * this.#ctx.getCadence().editWatchMs)); }
  // Injectable clock (test seam): the cache TTLs + the edit-watch rehash budget read it, so the
  // time-gated dump decisions can be driven deterministically. Defaults to Date.now in production.
  #now: () => number = () => Date.now();
  /** TEST-ONLY (FORGEFX-25 edit-watch tests): inject the clock the cache TTLs + rehash budget read. */
  __setClockForTest(fn: () => number): void { this.#now = fn; }
  // Active-channel tracking (eid/pidLow → channel idx 0..3). Two sources keep it current:
  //   1) DEVICE read — #refreshActiveChannels reads the real active channel from register 0x07DD (byte
  //      50; decoded FORGEFXMID-16/18 from Channels.pcapng). The channel-SELECT register 0x07D2 is
  //      write-only for switching and reads back cached firmware state, so 0x07DD is the reliable source.
  //      readPreset and the edit-watch call it, so front-panel / AM4-Edit channel switches now reflect.
  //   2) OPTIMISTIC — setChannel() records the target index immediately for instant UI feedback; the next
  //      device read confirms/corrects it. Both feed the slice in #slotParamValues / placedBlocks so the
  //      active channel's params (e.g. reverb type) surface instead of the channel-A fallback.
  // Cleared when the preset/scene context changes (see #readStructure), then repopulated from the device.
  #activeChannel = new Map<number, number>(); // eid (pidLow) → channel idx 0..3
  #ctxSig: string | null = null;
  static #CHAN_LETTERS = ['A', 'B', 'C', 'D'] as const;

  /** Serialize `fn` behind the in-instance reader mutex so no two reader calls interleave on the
   *  shared transport. Returns fn's result; the lock advances whether fn resolves or throws. */
  async #withReader<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#readerLock.then(fn, fn);
    // Keep the chain alive on rejection (swallow here; the awaited `run` still surfaces the error).
    this.#readerLock = run.catch(() => undefined);
    return run;
  }

  /** Build the reader's DispatchCtx. The reader ONLY touches ctx.conn; the descriptor field is required
   *  by the type but unused on the read path, so we hand it the descriptor itself. */
  #dispatchCtx(): DispatchCtx {
    return { conn: new Am4Conn(this.#lastTransport!), descriptor: AM4_DESCRIPTOR };
  }
  #lastTransport: Transport | null = null;

  /** ONE atomic getPreset dump of the active buffer via the VERIFIED reader, cached briefly (TTL) so a
   *  grid + block-param page load reuses a single ~500 ms read. Serialized behind #withReader. */
  async readPreset(): Promise<PresetSnapshot | null> {
    const now = this.#now();
    if (this.#presetCache && now - this.#presetCache.at < this.#cacheTtlMs()) return this.#presetCache.snap;
    return this.#withReader(async () => {
      // Re-check the cache inside the lock — a call we queued behind may have just filled it.
      const t = this.#now();
      if (this.#presetCache && t - this.#presetCache.at < this.#cacheTtlMs()) return this.#presetCache.snap;
      this.#lastTransport = await this.#openTransport();
      try {
        // Read ALL four channels from the single fn-0x1F dump (no extra round-trips): the active channel
        // can't be read from the device (0x07d2 is unreadable), so we slice the tracked channel ourselves
        // in #slotParamValues rather than trust getPreset's channel-A fallback.
        const snap = await this.#reader.getPreset!(this.#dispatchCtx(), { include_channel_state: true });
        this.#presetCache = { snap, at: this.#now() };
        // Resolve the REAL active channel per placed block from the device (0x07DD) so placedBlocks /
        // blockParams slice the channel the UNIT is actually on — not the channel-A fallback. #readStructure
        // (TTL-cached, and it clears #activeChannel on a preset/scene context change) gives the placed pidLows.
        const placed = (await this.#readStructure())?.slots.filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow) ?? [];
        await this.#refreshActiveChannels(placed);
        this.#log(`readPreset: ${snap.slots.length} placed block(s), scene ${snap.active_scene ?? '?'} (${snap._meta.read_duration_ms ?? '?'}ms)`);
        return snap;
      } catch (e) {
        this.#log(`readPreset failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
  }

  // Brief TTL cache of the last structure read: one page load fans out into /preset/grid +
  // /preset/blocks (+ presetRef polls), each of which needs the same fn-0x1F structure — the beta
  // log showed every load doing back-to-back identical struct reads. Invalidated on writes.
  #structCache: { s: { slots: Am4Slot[]; name: string; scene: number; location: number }; at: number } | null = null;
  // (struct TTL is now the shared cadence-derived #cacheTtlMs — see the note on #presetCache.)

  /** One atomic fn-0x1F read of the preset structure → the 4 slots' block types + preset name +
   *  scene + current stored location. TTL-cached (see #structCache). */
  async #readStructure(): Promise<{ slots: Am4Slot[]; name: string; scene: number; location: number } | null> {
    if (this.#structCache && this.#now() - this.#structCache.at < this.#cacheTtlMs()) return this.#structCache.s;
    const dev = await this.#openTransport();
    const read = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh: 0x0000 }, ATOMIC_READ_TYPE);
    try {
      const frames = await dev.request(read, { timeoutMs: 1500, quietMs: 80, match: (fs) => fs.some(isStructResponse) });
      const f = frames.find(isStructResponse);
      if (!f) return null;
      const b = unpackMsb(f.slice(16, f.length - 2), STRUCT_BYTES); // 16-byte header … <septets> cksum F7
      if (process.env.AM4_DEBUG !== '0') {
        // DEBUG: dump the unpacked structure + auto-locate block-type codes at every offset, so we can
        // confirm/fix the slot offset against a real preset. Remove once the slot layout is pinned.
        this.#log(`struct[192]: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
        const hits: string[] = [];
        for (let o = 0; o + 4 <= STRUCT_BYTES; o++) { const v = int32LE(b, o); if (v && BLOCK_NAMES_BY_VALUE[v]) hits.push(`0x${o.toString(16)}=${BLOCK_NAMES_BY_VALUE[v]}`); }
        this.#log(`block-code scan: ${hits.join(' ') || '(none)'}`);
      }
      const slots: Am4Slot[] = STRUCT_SLOT_OFFSETS.map((off, i) => {
        const code = int32LE(b, off);
        // instance-aware: a second instance of a block type occupies base+1 (e.g. drive 0x76 +
        // drive 0x77 in the factory "Bass NoAmp DI") — resolve it instead of showing a hex code
        const name = resolveBlockTypeValue(code)?.name;
        return { slot: i + 1, blockType: name ?? (code ? `0x${code.toString(16)}` : 'none'), pidLow: code };
      });
      const s = {
        slots,
        name: asciiAt(b, STRUCT_NAME_OFFSET, 32),
        scene: int32LE(b, STRUCT_SCENE_OFFSET),
        location: int32LE(b, STRUCT_LOCATION_OFFSET)
      };
      // Drop optimistic channel tracking when the preset/scene context changes — a switch remaps every
      // block's active channel on the device, and we have no way to read the new mapping (0x07d2 is
      // unreadable), so falling back to channel A is the safe default until the user re-selects.
      const sig = `${s.location}:${s.scene}`;
      if (sig !== this.#ctxSig) { this.#ctxSig = sig; this.#activeChannel.clear(); }
      this.#structCache = { s, at: this.#now() };
      return s;
    } catch {
      return null;
    }
  }

  /** Drop both TTL caches after any device write — the next read must reflect the change. */
  #invalidate() {
    this.#presetCache = null;
    this.#structCache = null;
    // Our own write also flips the device's "edited" bit + moves param values, so tell the device-edit
    // watcher to silently re-seed its baseline next tick instead of misreading it as a front-panel edit.
    this.#selfEditPending = true;
  }

  // ── Device-edit watch: catch front-panel / AM4-Edit edits the unit does NOT push (HW-107) ─────────
  // The registry supervisor polls readDeviceEditState() (capability deviceEditWatch) while an SSE client
  // is listening. TRANSITION-GATED (FORGEFX-25 — fixes the audio dropouts a user hit): the old detector
  // ran a full fn-0x1F GET_ALL_PARAMS dump of EVERY placed block on EVERY tick while the edited bit was
  // latched (~3.3 KB/s sustained), and serializing those multi-frame dumps audibly glitched the AM4's
  // audio path. AM4-Edit at idle only polls the small 0x7DD register — it never dumps. So we now split
  // the tick into a CHEAP steady-state path and a GATED heavy path:
  //
  //   Every tick (cheap, always): readActiveBufferEditedBit (one GET_PATCH read — we NEVER hash that
  //     frame: bytes 29/30/31/236 free-run) + the struct read (scene/location) + #refreshActiveChannels
  //     (0x7DD per placed block). ZERO fn-0x1F dumps here.
  //   fn-0x1F hash dumps (#hashPlacedParams) ONLY when:
  //     • edited bit false→true (and not self-edit): emit `changed` IMMEDIATELY (before the slow hash),
  //       then hash once to seed the successive-edit baseline (skipped when rehashing is disabled).
  //     • bit stays latched: re-hash at most every ctx.getCadence().editRehashMs — but this is now 0
  //       (DISABLED) in EVERY mode (FORGEFX-25 follow-up: the periodic latched re-dump glitched AM4 audio
  //       after a channel swap). With rehashMs=0 this branch never runs; on-device edits reflect on
  //       save/scene/channel only. Kept parameterised so a future view-gated rehash can re-enable it.
  //     • edited bit true→false (device-side save): emit `changed` (name/location may have changed) and
  //       reset the hash baseline cheaply — no dump.
  //   #selfEditPending (our own write dirtied the buffer): silent re-seed, no `changed`; the seed hash
  //     follows the rehash budget (only seeds when rehashing is enabled) so the baseline stays consistent
  //     and the NEXT front-panel edit is still detected.
  //
  // #lastHashAt is the wall-clock (via #now) of the last dump so the rehash budget is enforceable. All
  // `changed` reloads still funnel to Axis exactly as before — the false→true case emits directly (for
  // latency) and returns changed:false to avoid a double emit; channel/save/rehash ride the return value
  // (the registry emits `changed{scope:'preset'}` on true), and scene rides its own `scene` event.
  //
  // ASSUMPTION (implement-now, verify-after — needs a hardware capture): two zero-edit fn-0x1F reads
  // return byte-identical value arrays (the fn-0x1F payload is stable). A false positive only costs a
  // redundant reload; it never misses a real edit.
  #deviceEditBaseline: { edited: boolean; hash: string; scene: number; channels: string } | null = null;
  #selfEditPending = false;
  #lastHashAt = 0; // #now() of the last #hashPlacedParams dump — gates the rehash budget

  /** One device-edit watch tick. Returns `{changed:true}` when a DEVICE-originated (front-panel /
   *  AM4-Edit) edit needs the registry to emit a reload; the latency-sensitive false→true case emits
   *  `changed` itself and returns false. Silent right after our own writes and on read failure (never
   *  churns the UI on a transient timeout). Transition-gated — see the block comment above. Serialized
   *  behind #withReader. */
  async readDeviceEditState(): Promise<{ changed: boolean }> {
    return this.#withReader(async () => {
      this.#lastTransport = await this.#openTransport();
      const conn = new Am4Conn(this.#lastTransport);
      let edited: boolean;
      try {
        edited = await readActiveBufferEditedBit(conn);
      } catch {
        return { changed: false }; // device busy / timeout — keep the last baseline, don't reload
      }
      // ── CHEAP, EVERY TICK ── struct (scene/location) + per-block active channel (0x7DD). No fn-0x1F
      // dumps here: the heavy #hashPlacedParams runs ONLY on the gated transitions below.
      const struct = await this.#readStructure();
      const scene = struct?.scene ?? 0;
      const placed = (struct?.slots ?? []).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none').map((sl) => sl.pidLow);
      const channels = await this.#refreshActiveChannels(placed);

      const rehashMs = this.#ctx.getCadence().editRehashMs; // 0 (reduced) = never dump on the latched path
      const base = this.#deviceEditBaseline;

      // First run, or our own write just dirtied the buffer → adopt as baseline and emit nothing. Seed a
      // hash ONLY when the buffer is dirty AND rehashing is enabled — otherwise there is nothing to
      // compare against later, so the dump would be wasted. After a self-edit this keeps the baseline
      // consistent so the NEXT front-panel edit is still detected (correctness first).
      if (base === null || this.#selfEditPending) {
        this.#selfEditPending = false;
        let hash = '';
        if (edited && rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#now(); }
        this.#deviceEditBaseline = { edited, hash, scene, channels };
        return { changed: false };
      }

      // Front-panel scene change (footswitch): emit a `scene` event (same shape gen-3 emits) so Axis
      // moves the badge AND reloads the per-scene grid/params. Separate from the edit `changed` signal,
      // and cheap — struct-derived, no dump.
      if (scene !== base.scene) this.#ctx.emit({ type: 'scene', index: scene });

      let emittedChanged = false;                    // true once we've emitted `changed` directly this tick
      let wantChanged = channels !== base.channels;  // a front-panel channel switch is device-originated
      let hash = base.hash;

      if (edited && !base.edited) {
        // false→true: emit `changed` IMMEDIATELY (before the slow hash) so the reload is not gated on the
        // dump, THEN hash once to seed the successive-edit baseline (only when rehashing is enabled).
        this.#ctx.emit({ type: 'changed', scope: 'preset' });
        emittedChanged = true;
        if (rehashMs > 0) { hash = await this.#hashPlacedParams(conn); this.#lastHashAt = this.#now(); }
        else hash = '';
      } else if (!edited && base.edited) {
        // true→false (device-side save): name/location may have changed → reload; reset the hash baseline
        // cheaply (nothing dirty to fingerprint — no dump).
        hash = '';
        wantChanged = true;
      } else if (edited && base.edited && rehashMs > 0 && this.#now() - this.#lastHashAt >= rehashMs) {
        // Bit stays latched and the rehash budget elapsed: re-fingerprint the placed blocks. A diff means
        // the front panel moved a param while already dirty → reload + adopt the new baseline.
        const fresh = await this.#hashPlacedParams(conn);
        this.#lastHashAt = this.#now();
        if (fresh !== base.hash) { hash = fresh; wantChanged = true; }
      }

      this.#deviceEditBaseline = { edited, hash, scene, channels };
      // A `changed` already emitted directly (false→true) is NOT re-signalled via the return value —
      // that would double-fire the registry's emit.
      return { changed: wantChanged && !emittedChanged };
    });
  }

  /** Fingerprint the placed blocks' current param values via fn-0x1F (channel-A quarter only — stable
   *  and small; B/C/D would add churn). Plain string join, not a digest — the arrays are short. Runs
   *  inside #withReader (the caller already holds the lock). */
  async #hashPlacedParams(conn: Am4Conn): Promise<string> {
    const s = await this.#readStructure(); // TTL-cached; the poll cadence keeps it warm
    const placed = (s?.slots ?? []).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const parts: string[] = [];
    for (const sl of placed) {
      try {
        const r = await readAllParams(conn, sl.pidLow);
        const stride = r.itemCount >= 4 ? Math.floor(r.itemCount / 4) : r.values.length;
        parts.push(`${sl.pidLow}:${r.values.slice(0, stride).join(',')}`);
      } catch {
        // block not readable this tick — skip it (its absence is itself part of the fingerprint)
      }
    }
    return parts.join('|');
  }

  /** Read each placed block's REAL active channel from the device (0x07DD long read, byte 50 —
   *  decoded in FORGEFXMID-16/18 from Channels.pcapng) and update #activeChannel to the device truth.
   *  Unlike the 0x07D2 SELECT register (write-only for switching; reads back cached firmware state),
   *  0x07DD reads back a clean 0..3 index, so this reflects channel switches made on the UNIT / in
   *  AM4-Edit — not just the ones AXIS made. Returns a stable signature (`pidLow:idx|…`) the edit-watch
   *  uses to detect a front-panel channel switch. Best-effort per block: a read miss leaves that block's
   *  tracked value (or the channel-A fallback) untouched. Callers already hold #withReader. */
  async #refreshActiveChannels(placedPidLows: number[]): Promise<string> {
    if (!placedPidLows.length) return '';
    const dev = await this.#openTransport();
    const isFor = (f: number[], pidLow: number) => f[6] === (pidLow & 0x7f) && f[7] === ((pidLow >> 7) & 0x7f);
    const parts: string[] = [];
    for (const pidLow of placedPidLows) {
      try {
        const req = buildReadActiveChannel(pidLow);
        const frames = await dev.request(req, {
          timeoutMs: dev.slow ? 1200 : 800,
          quietMs: dev.slow ? 100 : 50,
          match: (fs) => fs.some((f) => isFor(f, pidLow) && parseActiveChannelResponse(f) !== null),
        });
        const idx = frames
          .filter((f) => isFor(f, pidLow))
          .map((f) => parseActiveChannelResponse(f))
          .find((v) => v !== null);
        if (idx != null) {
          this.#activeChannel.set(pidLow, idx);
          parts.push(`${pidLow}:${idx}`);
        }
      } catch {
        // block unreadable this tick — keep the tracked/fallback channel, don't churn
      }
    }
    return parts.join('|');
  }

  /** Live current-preset query (unified GET /preset; capability presets.liveQuery) — feeds the
   *  Axis top-bar preset display. Number is the stored location decoded from the structure's
   *  int32 @0x00 (see STRUCT_LOCATION_OFFSET); -1 when the structure read fails (Axis ignores
   *  refs with a negative number). */
  async presetRef(): Promise<{ number: number; name: string }> {
    const s = await this.#readStructure();
    return { number: s?.location ?? -1, name: s?.name ?? '' };
  }

  /** Read the 4 signal-chain slots → which block sits in each (the AM4 equivalent of the grid). */
  async slots(): Promise<Am4Slot[]> {
    const out = (await this.#readStructure())?.slots ?? this.#emptySlots();
    this.#log(`slots: ${out.map((s) => `${s.slot}:${s.blockType}`).join(' ')}`);
    return out;
  }

  /** The 4 slots as a PresetGridDTO (1 row × 4, linear chain) so Axis renders the AM4 on the existing
   *  Signal Grid — no separate view needed to get it on screen + testable.
   *
   *  EMPTY slots are OMITTED (no cell), matching gen-3 semantics. They were previously emitted as
   *  shunt cells to draw the pass-through chain, but a gen-3 shunt is a REMOVABLE routing cell —
   *  Axis tapped them into clearCell writes, reported every drop target as occupied, and never
   *  rendered the empty-cell "add a block" button (the whole add/drag/drop path was dead on AM4). */
  async grid(): Promise<PresetGridDTO> {
    const s = await this.#readStructure();
    const slots = s?.slots ?? this.#emptySlots();
    this.#log(`grid: "${s?.name ?? ''}" — ${slots.map((x) => x.blockType).join(', ')}`);
    const cells = slots
      .filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none')
      .map((sl) => ({
        row: 0,
        col: sl.slot - 1,
        effectId: sl.pidLow,
        name: sl.blockType,
        isShunt: false,
        routeFlag: 0,
        fromRows: sl.slot - 1 > 0 ? [0] : [], // linear: each slot feeds from the previous
        // ADDITIVE (Phase 6): the AM4 block dictionary is already slug-shaped ('amp', 'drive', …) —
        // surface it so Axis can key params/help/icons without its `!c.pack` gates. Omitted for
        // unknown cells (nothing derivable there).
        ...(resolveBlockTypeValue(sl.pidLow) ? { slug: resolveBlockTypeValue(sl.pidLow)!.name } : {})
      }));
    return { model: 'am4', name: s?.name ?? '', crcValid: true, rows: 1, cols: 4, scenes: [], cells, source: 'dump' };
  }

  /** Placed blocks in the unified PresetBlockDTO shape (GET /preset/blocks): the 4-slot chain as
   *  row 1 / col 1..4, fromRows [] (linear — the grid DTO carries the chain). Bypass + channel state
   *  ride the TTL-cached atomic reader dump (the same read blockParams uses); null when that read is
   *  unavailable. Channel comes from the dump's `params_by_channel` key — the reader defaults to
   *  reading only the currently-active channel (see getPreset's `include_channel_state`), so there's
   *  exactly one key to report; 'unknown' channel_status (selector read failed) still surfaces its
   *  best-effort fallback key rather than null, consistent with blockParams(). */
  async placedBlocks(): Promise<PresetBlockDTO[]> {
    const s = await this.#readStructure();
    const slots = (s?.slots ?? this.#emptySlots()).filter((sl) => sl.pidLow !== 0 && sl.blockType !== 'none');
    const snap = slots.length ? await this.readPreset() : null;
    return slots.map((sl) => {
      const slug = resolveBlockTypeValue(sl.pidLow)?.name ?? sl.blockType;
      // match the reader slot by POSITION, not block name — a preset can hold two instances of the
      // same block type (drive 0x76 + drive 0x77), and a name match would return the wrong one
      const matched = snap?.slots.find((x) => x.slot === sl.slot) ?? snap?.slots.find((x) => x.block_type === slug);
      // Report the resolved active channel: readPreset() ran #refreshActiveChannels, so #activeChannel
      // holds the REAL device channel (0x07DD) for placed blocks; fall back to the dump's first channel
      // key (A) only if that read missed.
      const trackedIdx = this.#activeChannel.get(sl.pidLow);
      const channel = trackedIdx !== undefined
        ? (Am4Driver.#CHAN_LETTERS[trackedIdx] ?? null)
        : (matched?.params_by_channel ? Object.keys(matched.params_by_channel)[0] ?? null : null);
      return { slug, name: sl.blockType, effectId: sl.pidLow, row: 1, col: sl.slot, fromRows: [], bypassed: matched?.bypassed ?? null, channel };
    });
  }

  /** Read every parameter of the block sitting at `pidLow` (its block-type value, e.g. 58=amp, 118=drive
   *  — the `effectId` the grid/slots report) and return it in the SAME shape as the gen-3 blockParams
   *  so Axis renders the AM4's params through the existing block editor unchanged.
   *
   *  Read path: the VERIFIED descriptor reader's getPreset() atomic dump (see readPreset), cached for the
   *  page load. We pull the slot whose block_type maps to this pidLow and translate its params. getPreset
   *  returns DECODED DISPLAY values keyed by param name (flat `params` for non-channel blocks, or the
   *  active-channel dict inside `params_by_channel` for channel-bearing blocks); we join each against its
   *  KNOWN_PARAMS entry to recover unit / range / enum-option metadata + reconstruct `value`/`norm`.
   *
   *  Mapping (reader field → DTO field):
   *    slot params[name] (display) → NamedParam.value / EnumParam.value (via enum-label→ordinal lookup)
   *    KNOWN_PARAMS[key].unit      → NamedParam.unit (AM4_UNIT_LABEL) / enum split
   *    KNOWN_PARAMS[key].display{Min,Max} → NamedParam.{min,max} + norm (position of value in [min,max])
   *    KNOWN_PARAMS[key].scaling === 'log10' → NamedParam.log (+ log-curve norm inverse)
   *    slot.bypassed              → the leading 'Bypass' EnumParam
   *  `named` carries the continuous knobs, `enums` the discrete selectors, and the block's own `type`
   *  selector is surfaced separately — exactly as gen-3 splits them, so Axis renders both the same way. */
  async blockParams(pidLow: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }> {
    // instance-aware: pidLow may be an instance code (base+N, e.g. drive #2 = 0x77) — the catalog
    // is keyed by the BASE pidLow, the wire address stays the instance code (see encId/setParam)
    const resolved = resolveBlockTypeValue(pidLow);
    const blockName = resolved?.name;
    if (!blockName || blockName === 'none') {
      this.#log(`blockParams: unknown pidLow ${pidLow}`);
      return { block: blockName ?? `0x${pidLow.toString(16)}`, slug: blockName ?? '', page: -1, named: [], enums: [], type: null };
    }
    const basePidLow = resolved.base;
    const snap = await this.readPreset();
    // Find the placed slot for THIS pidLow, then its DECODED param dict (flat, or the one
    // active-channel dict for channel-bearing blocks — getPreset nests exactly one channel per slot).
    // Match by POSITION via the structure (a preset can hold two instances of the same block type);
    // fall back to the name match when the structure read is unavailable.
    const chainSlot = (await this.#readStructure())?.slots.find((sl) => sl.pidLow === pidLow)?.slot;
    const slot = (chainSlot !== undefined ? snap?.slots.find((s) => s.slot === chainSlot) : undefined)
      ?? snap?.slots.find((s) => s.block_type === blockName);
    const decoded = this.#slotParamValues(slot, this.#activeChannel.get(pidLow));
    // The reader's decoded keys should match KNOWN_PARAMS names verbatim, but casing/space/underscore
    // drift between the catalog and the descriptor reader would silently drop every param (display
    // undefined → skipped), leaving a block like `amp` with 154 recovered knobs rendering empty. Index
    // the decoded dict by a normalized key so a cosmetic mismatch still resolves to the right value.
    const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');
    const decByNorm = new Map(Object.entries(decoded).map(([k, v]) => [norm(k), v]));
    const lookup = (name: string) => (name in decoded ? decoded[name] : decByNorm.get(norm(name)));

    const params = Object.values(KNOWN_PARAMS).filter((p) => p.block === blockName) as Param[];
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    // A block's page can aggregate more than one hardware sub-block under one name — the amp block
    // carries its integrated cab (pidLow 0x3e) alongside the amp itself (pidLow 0x3a). Both sub-blocks
    // number their params from pidHigh 0, so pidHigh ALONE is not a unique id across the page (it caused
    // duplicate-key crashes) and is ALSO the wrong write address for the foreign sub-block. Encode the id
    // as the FULL address for foreign params — (pidLow<<16)|pidHigh — and keep the bare pidHigh for the
    // block's own params (compact + back-compatible). setParam() below reverses this. pidLow ≤ 0xce and
    // pidHigh ≤ 0x7d2, so the two never overlap: a bare pidHigh is always < 0x10000, a composite ≥ 0x3a0000.
    const encId = (p: Param) => (p.pidLow === basePidLow ? p.pidHigh : (p.pidLow << 16) | p.pidHigh);
    for (const p of params) {
      const display = lookup(p.name);
      if (display === undefined) continue; // param not in the dump (channel-gated / not placed)
      if (p.unit === 'enum') {
        const options = Object.entries(p.enumValues ?? {}).map(([v, label]) => ({ value: Number(v), label }));
        const value = this.#enumOrdinal(p, display);
        // the block's own type selector is surfaced separately (like gen-3's `type`), not as a plain enum
        if (p.name === 'type') { type = { value, name: p.enumValues?.[value] ?? String(display) }; continue; }
        // channel rides the block header's dedicated A/B/C/D selector (placedBlocks().channel +
        // setChannel), not a generic dropdown — skip it here like `type` above.
        if (p.name === 'channel') continue;
        enums.push({ id: encId(p), name: am4ParamLabel(p), value, options });
      } else {
        // A raw-int `_cc` register reads back the string 'None' when unassigned — surface it as a
        // labeled selector, not a knob coerced to a broken 0 (see am4NoneSelector).
        const none = am4NoneSelector(encId(p), am4ParamLabel(p), display);
        if (none) { enums.push(none); continue; }
        const value = typeof display === 'number' ? display : Number(display) || 0;
        named.push({
          id: encId(p),
          name: am4ParamLabel(p),
          value,
          norm: this.#normOf(p, value),
          unit: AM4_UNIT_LABEL[p.unit] ?? undefined,
          min: p.displayMin,
          max: p.displayMax,
          log: p.scaling === 'log10' || undefined
        });
      }
    }
    // Defensive: never ship two params with the same id — Axis keys its widget {#each} on it, and a
    // duplicate key hard-crashes the Svelte editor (seen live when the catalog briefly carried
    // renamed entries alongside their old keys at the same wire address). First occurrence wins.
    const dedupeById = <T extends { id: number }>(list: T[]): T[] => {
      const seen = new Set<number>();
      return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    };
    const namedOut = dedupeById(named);
    const enumsOut = dedupeById(enums);
    // bypass state — the reader already read it into slot.bypassed as part of the same atomic dump, so we
    // surface it as a leading virtual enum (gen-3 exposes bypass via the grid) with no extra round-trip.
    if (slot && slot.bypassed !== undefined) {
      // 0xffff is a virtual id (bypass has its own route /preset/blocks/:eid/bypass, never setParam):
      // above every bare pidHigh (≤ 0x7d2) and below every composite (≥ 0x3a0000), so it can't collide.
      enumsOut.unshift({ id: 0xffff, name: 'Bypass', value: slot.bypassed ? 1 : 0, options: [{ value: 0, label: 'Engaged' }, { value: 1, label: 'Bypassed' }] });
    }
    // Editor-authentic layout (v2), resolved to the variant for this block's current type value. AM4
    // controls join to the catalog by cacheId in the codec; unresolved paramIds ride through as null
    // (display-only). Same wire shape as the gen-3 driver so Axis renders both through one path.
    const layout = am4LayoutFor(blockName, type?.value);
    this.#log(`blockParams ${blockName} (pidLow ${pidLow}): ${namedOut.length} knobs, ${enumsOut.length} enums${type ? ` type=${type.name}` : ''}`);
    return { block: blockName, slug: blockName, page: -1, named: namedOut, enums: enumsOut, type, layout };
  }

  /** The decoded (display-value) param dict for a placed slot: `params` on non-channel blocks, else the
   *  single active-channel dict the reader nested under `params_by_channel`. Empty when the slot is absent. */
  #slotParamValues(slot: PresetSnapshot['slots'][number] | undefined, preferredIdx?: number): Record<string, number | string> {
    if (!slot) return {};
    if (slot.params) return slot.params as Record<string, number | string>;
    const byCh = slot.params_by_channel;
    if (byCh) {
      // Prefer the tracked active channel (the one Axis last switched to); fall back to the first key
      // (channel A) when nothing is tracked — the dump now carries all four channels A/B/C/D.
      if (preferredIdx !== undefined) {
        const letter = Am4Driver.#CHAN_LETTERS[preferredIdx];
        const pref = letter ? byCh[letter] : undefined;
        if (pref) return pref as Record<string, number | string>;
      }
      const first = Object.values(byCh)[0];
      if (first) return first as Record<string, number | string>;
    }
    return {};
  }

  /** Reverse a decoded enum DISPLAY value back to its wire ordinal: the reader hands us `enumValues[wire]`
   *  (a label) or the raw ordinal when unlabeled. Match the label against the enum table; fall back to a
   *  numeric coercion (the reader's raw-int fallback path). */
  #enumOrdinal(p: Param, display: number | string): number {
    if (typeof display === 'number') return display;
    for (const [ord, label] of Object.entries(p.enumValues ?? {})) if (label === display) return Number(ord);
    return Number(display) || 0;
  }

  /** Slider position (0..1) of a display value within [displayMin, displayMax] — the inverse of the
   *  package's decode(): linear by default, log10 for log-scaled params. Purely presentational (Axis uses
   *  it to seat the knob); clamped to [0,1] and 0 on a degenerate range. */
  #normOf(p: Param, value: number): number {
    const { displayMin: lo, displayMax: hi } = p;
    let n: number;
    if (p.scaling === 'log10' && lo > 0 && hi > 0 && hi !== lo) n = Math.log(value / lo) / Math.log(hi / lo);
    else if (hi !== lo) n = (value - lo) / (hi - lo);
    else n = 0;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }

  /** One READ_PRESET_NAME (action 0x0012) round-trip for a location — non-destructive (does not load the
   *  preset). Returns the decoded name + whether the slot is empty, or null if no name frame came back. */
  async #readPresetName(dev: Transport, location: number): Promise<{ name: string; isEmpty: boolean } | null> {
    const req = buildGetPresetName(location);
    const frames = await dev.request(req, { timeoutMs: dev.slow ? 1200 : 600, quietMs: dev.slow ? 120 : 60, match: (fs) => fs.length > 0 });
    for (const f of frames) {
      try {
        const r = parseGetPresetNameResponse(f, location);
        return { name: r.isEmpty ? '' : r.name.trim(), isEmpty: r.isEmpty };
      } catch {
        /* not the name frame */
      }
    }
    return null;
  }

  /** Stored preset name at a location (0..103). */
  async presetName(location: number): Promise<{ location: number; name: string }> {
    const dev = await this.#openTransport();
    const r = await this.#readPresetName(dev, location);
    return { location, name: r?.name ?? '' };
  }

  /** Scan the AM4 preset library — every stored location (0..103, A01..Z04) by name, via the VERIFIED
   *  reader's scanLocations (one non-destructive READ_PRESET_NAME per slot, ~104 serial round-trips).
   *  Serialized behind #withReader. `scanned[i]` is location index i (the scan starts at 0), so we map by
   *  offset; if the reader bailed early (`failed_at`) the remaining locations are reported empty. `signal`
   *  can veto the scan before it starts — scanLocations reads the whole range atomically, so it cannot
   *  interrupt mid-scan (an already-aborted signal returns an all-empty list without touching the wire). */
  async scanPresets(signal?: AbortSignal): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }> {
    const presets: { location: number; code: string; name: string; isEmpty: boolean }[] = [];
    if (signal?.aborted) {
      for (let location = 0; location < TOTAL_LOCATIONS; location++) presets.push({ location, code: formatLocationCode(location), name: '', isEmpty: true });
      return { count: presets.length, presets };
    }
    const result = await this.#withReader(async () => {
      this.#lastTransport = await this.#openTransport();
      return this.#reader.scanLocations!(this.#dispatchCtx(), 0, TOTAL_LOCATIONS - 1);
    }).catch(() => ({ scanned: [] as { location: string; name: string; is_empty: boolean }[] }));
    // scanned[] is in location order from 0; index === location. Fill any tail the reader didn't reach.
    for (let location = 0; location < TOTAL_LOCATIONS; location++) {
      const s = result.scanned[location];
      presets.push({ location, code: formatLocationCode(location), name: s ? s.name.trim() : '', isEmpty: s ? s.is_empty : true });
    }
    this.#log(`scanPresets: read ${result.scanned.length}/${TOTAL_LOCATIONS} (${presets.filter((p) => !p.isEmpty).length} named)`);
    return { count: presets.length, presets };
  }

  /** Set a parameter by its display value (e.g. 'amp.gain', 7.5). (Named apart from the generic
   *  driver setParam(eid,pid,…) — the AM4 addresses by catalog key here, not by wire address.) */
  async setParamByKey(key: string, displayValue: number) {
    const dev = await this.#openTransport();
    const frame = buildSetParam(key as ParamKey, displayValue);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 60, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Write a continuous param by wire ADDRESS (the block editor's effectId=pidLow + paramId=pidHigh),
   *  normalized 0..1 (action SET_NORM — hardware-verified). Invalidates the preset cache so the next read
   *  reflects the change. */
  async setParamNorm(pidLow: number, pidHigh: number, norm: number) {
    const dev = await this.#openTransport();
    const n = Math.max(0, Math.min(1, norm));
    const frame = buildSetParamNorm({ pidLow, pidHigh }, n);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Write a discrete/enum param by wire ADDRESS to a raw internal value (the enum ordinal). */
  async setParamValue(pidLow: number, pidHigh: number, value: number) {
    const dev = await this.#openTransport();
    const frame = buildSetFloatParam({ pidLow, pidHigh }, value);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Generic driver write (unified PUT /preset/blocks/:addr/params/:paramId): addr = pidLow,
   *  paramId = pidHigh. continuous:true → SET_NORM with `value` as the 0..1 norm; continuous:false →
   *  discrete/enum ordinal write. Thin dispatch over the hardware-verified wire methods.
   *  `paramId` may be a composite address minted by blockParams() for a foreign sub-block (e.g. the
   *  amp page's integrated cab): any value > 0xffff carries its own pidLow in the high bits, which wins
   *  over `addr` so the write lands on the right sub-block. Bare pidHighs (≤ 0x7d2) keep using `addr`. */
  async setParam(pidLow: number, pidHigh: number, value: number, continuous: boolean) {
    if (pidHigh > 0xffff) { pidLow = pidHigh >>> 16; pidHigh &= 0xffff; }
    return continuous ? this.setParamNorm(pidLow, pidHigh, value) : this.setParamValue(pidLow, pidHigh, value);
  }

  /** Toggle/set a block's bypass by its pidLow. */
  async setBypass(blockPidLow: number, bypassed: boolean) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSetBlockBypass(blockPidLow, bypassed));
    this.#invalidate();
    return { ok: true };
  }

  /** Switch a placed block's active channel (A/B/C/D) — POST /preset/blocks/:eid/channel, mirrors
   *  gen-3's setChannel. Unlike gen-3 (dedicated wire frame + fn-0x13 status read), AM4's channel is
   *  an ordinary enum SET_PARAM at `<block>.channel` (pidHigh=0x07d2, hardware-confirmed on
   *  amp/drive/reverb/delay, pattern-extended to every block — see forgefx-midi's params.ts), so this
   *  is a thin wrapper over the existing generic key-write path. */
  async setChannel(eid: number, channel: string) {
    const blockName = resolveBlockTypeValue(eid)?.name;
    if (!blockName || blockName === 'none') return { ok: false };
    const idx = ['A', 'B', 'C', 'D'].indexOf(channel.toUpperCase());
    if (idx < 0) return { ok: false };
    const res = await this.setParamByKey(`${blockName}.channel`, idx);
    // Remember the channel we just selected — the device won't read it back (0x07d2 is unreadable), so
    // this is the only way subsequent reads reflect the switch (keyed by the eid the caller addresses,
    // so two instances of a block type track independently). #invalidate() drops the dump caches but
    // NOT this map; #readStructure clears it on a preset/scene context change.
    this.#activeChannel.set(eid, idx);
    this.#invalidate();
    this.#ctx.emit({ type: 'blockState', effectId: eid });
    return res;
  }

  /** Rename the current preset (POST /preset/name; capability presets.canRename). AM4's rename command
   *  (`buildSetPresetName`, capture-verified) targets a STORED location, so we rename the location the
   *  edit buffer was loaded from (struct int32 @0x00). This persists immediately — no separate store is
   *  needed, unlike gen-3's edit-buffer rename. Returns {ok:false} (not 501) when the location can't be
   *  read or is out of range. Enables the top-bar rename button + the library rename-and-save flow. */
  async setPresetName(name: string): Promise<{ ok: boolean }> {
    const loc = (await this.#readStructure())?.location ?? -1;
    if (!Number.isInteger(loc) || loc < 0 || loc > 103) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32); // printable ASCII, ≤32 (codec throws otherwise)
    const dev = await this.#openTransport();
    const frame = buildSetPresetName(loc, clean);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'preset' });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Rename a scene (POST /scene/name; capability sceneNamesWritable). `index` is 0-based (UI passes
   *  scene-1). AM4's `buildSetSceneName` (capture-verified) writes to the WORKING BUFFER only — the name
   *  shows live but persists to the preset only on the next store (same as gen-3). */
  async setSceneName(index: number, name: string): Promise<{ ok: boolean }> {
    if (!Number.isInteger(index) || index < 0 || index > 3) return { ok: false };
    const clean = (name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    const dev = await this.#openTransport();
    const frame = buildSetSceneName(index, clean);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'preset' });
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Change a placed block's model/type (POST /preset/blocks/:eid/type). AM4 addresses blocks by pidLow
   *  (= the eid the grid reports); the model selector is the block's `type` enum param, written by its
   *  wire ordinal (the same discrete-SET path plain enums use). Mirrors gen-3's setType so the type
   *  picker's selection actually applies — without it the route answered 501 and retype was rejected. */
  async setType(pidLow: number, value: number): Promise<{ ok: boolean }> {
    const blockName = resolveBlockTypeValue(pidLow)?.name;
    const typeParam = blockName
      ? (Object.values(KNOWN_PARAMS) as Param[]).find((p) => p.block === blockName && p.name === 'type')
      : undefined;
    if (!typeParam) return { ok: false };
    const res = await this.setParamValue(pidLow, typeParam.pidHigh, value);
    this.#ctx.emit({ type: 'changed', scope: 'grid' });
    return res;
  }

  /** Placeable-block catalog (GET /blocks) — powers the "add a block" palette. The AM4 roster is fixed
   *  (one instance per type; see BLOCK_TYPE_VALUES). `page` is the block's own type code, which the palette
   *  hands straight back to placeCell → buildSetBlockType. Without this the palette is empty and "add FX"
   *  silently does nothing. `paramCount`/`typeCount` are derived from KNOWN_PARAMS for a richer palette row. */
  blocksCatalog(): { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[] {
    const catalog = Object.values(KNOWN_PARAMS) as Param[];
    return (Object.entries(BLOCK_TYPE_VALUES) as [string, number][])
      .filter(([slug]) => slug !== 'none')
      .map(([slug, page]) => {
        const params = catalog.filter((p) => p.block === slug);
        const typeParam = params.find((p) => p.name === 'type');
        return {
          slug,
          family: slug, // AM4 has a single instance per block type — family == slug
          instance: 1,
          name: am4BlockLabel(slug),
          page,
          paramCount: params.length,
          typeCount: typeParam ? Object.keys(typeParam.enumValues ?? {}).length : 0
        };
      });
  }

  /** Block "type" roster (GET /blocks/:slug/types) — the amp/drive/delay/… model list the type picker
   *  shows. AM4 stores it as the block's `type` enum param (surfaced separately from plain enums in
   *  blockParams); without this the route answered 501 and the picker rendered empty, so "select type of
   *  block" silently did nothing. Mirrors gen-3's rosterFor DTO — manufacturer/basedOn are gen-3-only
   *  catalog fields the AM4 tables don't carry, hence null. Returns [] for a slug with no type selector. */
  blockTypes(slug: string): TypeModel[] {
    const typeParam = (Object.values(KNOWN_PARAMS) as Param[]).find((p) => p.block === slug && p.name === 'type');
    if (!typeParam?.enumValues) return [];
    return Object.entries(typeParam.enumValues)
      .map(([v, name]) => ({ value: Number(v), name, manufacturer: null, basedOn: null }))
      .sort((a, b) => a.value - b.value);
  }

  /** Grid edit (unified PUT /preset/grid/cell) on the AM4's 1×4 linear chain: place/change the block in a
   *  slot, or clear it (blockId 0 — the UI's clearCell). `col` is the 1-indexed slot (1..4, from Axis'
   *  wire conversion); `row` is always 1 on a linear device and is ignored. `blockId` is the target block's
   *  own type code (the effectId the grid/slots report), matching buildSetBlockType's blockTypeValue. */
  async placeCell(row: number, col: number, blockId: number): Promise<{ ok: boolean }> {
    if (!Number.isInteger(col) || col < 1 || col > 4) {
      const err = new Error(`AM4 has 4 linear slots; slot must be 1..4, got ${col}`) as Error & { statusCode?: number };
      err.statusCode = 400; // client error, not a server fault
      throw err;
    }
    const dev = await this.#openTransport();
    const frame = buildSetBlockType(col as 1 | 2 | 3 | 4, blockId);
    const res = await dev.request(frame, { timeoutMs: 600, quietMs: 50, match: (fs) => fs.some((f) => isCommandAck(frame, f)) });
    this.#invalidate();
    this.#ctx.emit({ type: 'changed', scope: 'grid' }); // live: other UIs / SSE re-read the chain
    this.#log(`placeCell: slot ${col} <- ${blockId ? `blockType 0x${blockId.toString(16)}` : 'cleared'}`);
    return { ok: res.some((f) => isCommandAck(frame, f)) };
  }

  /** Switch the active scene (0..3). */
  async switchScene(index: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchScene(index));
    this.#invalidate();
    return { ok: true, scene: index };
  }

  /** Current scene index (0-based), read from the atomic fn-0x1F preset structure. */
  async getScene(): Promise<{ index: number }> {
    const s = await this.#readStructure();
    return { index: s?.scene ?? 0 };
  }

  /** Live tuner reading via block-0x0023 live-poll (4 channels: note-index / freq / cents / string).
   *  Values are absolute float32 (decoded upstream). The registry supervisor calls this on the tuner
   *  cadence while the tuner view is active; it emits the same `{type:'tuner', freq, note, octave,
   *  cents}` event gen-3 uses (Axis renders both identically). Returns null on any incomplete read so
   *  the supervisor keeps polling without churning the overlay. Serialized behind #withReader. */
  async readTuner(): Promise<{ freq: number; note: string; octave: number; cents: number } | null> {
    return this.#withReader(async () => {
      const dev = await this.#openTransport();
      const readCh = async (ch: number): Promise<number | null> => {
        const req = buildReadParam({ pidLow: AM4_TUNER_PID_LOW, pidHigh: ch }, READ_TYPE_LIVE_POLL);
        const hit = (f: number[]) => isPollResponse(f) && f[6] === AM4_TUNER_PID_LOW && f[8] === ch;
        try {
          const frames = await dev.request(req, { timeoutMs: dev.slow ? 400 : 250, quietMs: dev.slow ? 60 : 30, match: (fs) => fs.some(hit) });
          const f = frames.find(hit);
          return f ? parseReadResponse(f).asFloat32() : null;
        } catch {
          return null;
        }
      };
      const noteIndex = await readCh(AM4_TUNER_CHANNEL.NOTE_INDEX);
      const freqHz = await readCh(AM4_TUNER_CHANNEL.FREQ_HZ);
      const cents = await readCh(AM4_TUNER_CHANNEL.CENTS);
      const stringBand = await readCh(AM4_TUNER_CHANNEL.STRING_BAND);
      if (noteIndex === null || freqHz === null || cents === null) return null; // incomplete → skip this tick
      const r = decodeAm4Tuner({ noteIndex, freqHz, cents, stringBand: stringBand ?? 0 });
      // Split the device-true note into gen-3's {note, octave} (NOTE_NAMES indexed by MIDI%12, C=0).
      const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const note = NOTE_NAMES[((r.midiNote % 12) + 12) % 12]!;
      const octave = Math.floor(r.midiNote / 12) - 1;
      return { freq: r.freqHz, note, octave, cents: r.cents };
    });
  }

  /** Generic driver scene switch (unified POST /scene). */
  async setScene(index: number) {
    return this.switchScene(index);
  }

  /** Switch the active preset by location index (0..103, A01..Z04). */
  async switchPreset(location: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSwitchPreset(location));
    this.#invalidate();
    return { ok: true, location };
  }

  /** Generic driver preset select (unified POST /preset/select) — adds the bank-letter `code`. */
  async selectPreset(n: number): Promise<{ ok: boolean; code: string }> {
    const r = await this.switchPreset(n);
    return { ok: r.ok, code: formatLocationCode(n) };
  }

  /** Generic driver store-to-slot (unified POST /preset/store) → {ok, location, code}. */
  async store(n: number) {
    return this.storePreset(n);
  }

  /** Generic stored-name lookup (unified GET /presets/:n) — the AM4 answers with the real stored
   *  name plus the bank-letter `code` (additive; gen-3 keeps its {number, name:''} stub). */
  async storedPresetName(n: number): Promise<{ number: number; name: string; code: string }> {
    const r = await this.presetName(n);
    return { number: n, name: r.name, code: formatLocationCode(n) };
  }

  /** Save the active edit buffer to a stored location (0..103). Wire action 0x1B —
   *  hardware-confirmed byte-exact against a live AM4 capture (2026-07-02). */
  async storePreset(location: number) {
    const dev = await this.#openTransport();
    await dev.sendQueued(buildSaveToLocation(location));
    return { ok: true, location, code: formatLocationCode(location) };
  }

  /** Back up a preset off the device as a verbatim .syx dump (the 6-message 0x77/0x78/0x79 stream).
   *  `location` omitted → the active edit buffer. Returns the raw bytes (byte-identical, replayable)
   *  plus the decoded location + name. Community-beta: the dump-request path is capture-derived. */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[]; sceneNames?: string[]; crcValid?: boolean }> {
    const dev = await this.#openTransport();
    const req = location == null ? buildRequestActiveBufferDump() : buildRequestStoredPresetDump(location);
    const frames = await dev.request(req, { timeoutMs: 5000, quietMs: 200, match: (fs) => fs.some((f) => f[4] === 0x15 && f[5] === 0x79) });
    const dumpMsgs = frames.filter((f) => f[4] === 0x15 && (f[5] === 0x77 || f[5] === 0x78 || f[5] === 0x79));
    const raw = Uint8Array.from(dumpMsgs.flat());
    const dump = parseAm4PresetDump(raw); // validates every envelope + checksum; throws on malformed
    const loc = am4DumpLocation(dump);
    // ADDITIVE opt-in decode (crcValid + scene names) atop the opaque, byte-identical `bytes` — a
    // corrupt dump degrades to no extra fields (am4DecodeEnrichment never throws) and still backs up.
    const enrich = am4DecodeEnrichment(dump.raw);
    this.#log(`backup ${loc.code ?? '(active)'} "${decodeAm4PresetNameFromFrame(dump.raw)}" ${dump.raw.length}B${enrich ? ` crc=${enrich.crcValid ? 'ok' : 'BAD'}` : ''}`);
    return {
      location: loc.active ? null : (loc.index ?? null),
      code: loc.code ?? null,
      name: decodeAm4PresetNameFromFrame(dump.raw),
      bytes: [...dump.raw],
      ...(enrich ? { sceneNames: enrich.sceneNames, crcValid: enrich.crcValid } : {})
    };
  }

  /** Restore a preset .syx (single 12,352-byte dump) to the device by verbatim re-emit (goes back to
   *  the location encoded in the dump's 0x77 header). Validates the dump before sending. */
  async restorePreset(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }> {
    const dump = parseAm4PresetDump(Uint8Array.from(bytes)); // validate first — throws on bad envelope/checksum
    const loc = am4DumpLocation(dump);
    const dev = await this.#openTransport();
    for (const msg of splitSysex([...dump.raw])) await dev.sendQueued(msg);
    this.#invalidate();
    this.#log(`restore -> ${loc.code ?? '(active)'} (${dump.raw.length}B, 6 msgs)`);
    return { ok: true, location: loc.active ? null : (loc.index ?? null), code: loc.code ?? null };
  }

  /** Offline decode of an AM4 .syx (a single dump or a whole bank, e.g. the 104-preset factory file):
   *  returns each preset's location + name. No device needed — for library import / browsing. */
  decodeSyx(bytes: number[]): { count: number; presets: { index: number; location: number | null; code: string | null; name: string; sceneNames?: string[]; crcValid?: boolean }[] } {
    const raw = Uint8Array.from(bytes);
    const dumps = raw.length > AM4_PRESET_FRAME_SIZE && raw.length % AM4_PRESET_FRAME_SIZE === 0
      ? parseAm4PresetBank(raw)
      : [parseAm4PresetDump(raw)];
    const presets = dumps.map((d, index) => {
      const l = am4DumpLocation(d);
      // ADDITIVE opt-in decode (crcValid + scene names); silently omitted on a corrupt dump.
      const enrich = am4DecodeEnrichment(d.raw);
      return {
        index,
        location: l.active ? null : (l.index ?? null),
        code: l.code ?? null,
        name: decodeAm4PresetNameFromFrame(d.raw),
        ...(enrich ? { sceneNames: enrich.sceneNames, crcValid: enrich.crcValid } : {})
      };
    });
    return { count: presets.length, presets };
  }

  /** AM4 modifier address model (16 slots) — field map + enums recovered from the editor def cache,
   *  cross-validated with the resolver table. Data-only: the wire binding (CONNECT_MODIFIER) is not
   *  yet captured, so this exposes the model for a UI/editor, not a bind builder. */
  modifierModel() {
    return {
      effectOrdinal: AM4_MOD_EFFECT_ORDINAL,
      slotCount: AM4_MOD_SLOT_COUNT,
      fields: AM4_MOD_FIELDS,
      sources: AM4_MODIFIER_SOURCES,
      operations: AM4_MOD_OPERATIONS,
      channels: AM4_MOD_CHANNELS,
      bindingSupported: false,
      note: 'AM4 modifier field map + enums are data-only; the wire binding opcode (CONNECT_MODIFIER) is not yet captured.'
    };
  }

  /** Validate an AM4 firmware .syx (fn 0x7D/0x7E/0x7F envelope) — integrity check only, NOT a flasher.
   *  Reports message/block counts + the header/finalize tags. */
  validateFirmware(bytes: number[]) {
    try {
      const fw = parseAm4Firmware(Uint8Array.from(bytes));
      return {
        valid: true,
        messages: fw.messageCount,
        blocks: fw.blockPayloads.length,
        headerTag: [...fw.headerPayload],
        finalizeTag: [...fw.finalizePayload]
      };
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
  }
}

/** Create the AM4 driver over the shared transport. */
export function createAm4Driver(ctx: DriverCtx): Am4Driver {
  return new Am4Driver(ctx);
}
export type { Am4Driver };
