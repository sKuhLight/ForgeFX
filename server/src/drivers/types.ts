// Shared driver contract + the DTO shapes every route serves. The DTOs moved verbatim from the
// pre-driver Device/Am4Device modules — their JSON shapes are the HTTP contract Axis consumes and
// must not drift. `DeviceDriver` is the per-device surface the routes call; methods a device lacks
// are optional and mirrored by `DriverCapabilities` so routes can answer 501 instead of guessing.
import type { DecodedBlock } from 'forgefx-midi/devices/gen3';
import type { TypeModel, DeviceLayout, DeviceProfile } from '../devices.js';
import type { Transport } from '../transport/types.js';
import type { TelemetryMode, CadenceProfile } from './telemetryProfiles.js';

/** Thrown by a driver's verbatim-dump export when the slot is an unused (empty) preset slot: its dump is
 *  all zeros, not a restorable preset, so there is nothing to export or back up. Routes map it to 422
 *  (`statusCode`), not the generic 503 "device unreachable". No imports — safe in the browser runtime. */
export class EmptyPresetError extends Error {
  readonly statusCode = 422;
  constructor(message = 'empty preset slot') {
    super(message);
    this.name = 'EmptyPresetError';
  }
}

/** Library-friendly decoded preset: name, scenes, and the unique effect blocks it contains. */
export type PresetSummary = {
  number: number;
  name: string;
  model: string;
  crcValid: boolean;
  /** Content fingerprint (stored CRC16) — changes when the preset changes; used to detect stale cache. */
  crc: number;
  /** ADDITIVE: `true` only for an unused preset slot (blank name, no blocks/scenes, `crcValid: false`).
   *  Omitted for every populated preset. Clients skip such slots instead of treating them as presets. */
  empty?: boolean;
  scenes: string[];
  blocks: { effectId: number; slug: string | null; name: string; instance: number | null }[];
  /** Distinct model names in use per block family (amp/drive/cab/reverb/…) — for "presets using model X".
   *  Keyed by family slug; only families with a decoded model are present. FM3 only. */
  models: Record<string, string[]>;
  /** Amp model names in use (distinct across the amp's 4 channels) — for "presets using amp X". FM3 only.
   *  Back-compat alias of `models.amp` (the library still binds to this). */
  amps: string[];
  /** Full per-block decoded params (every family, every param) — for deep search ("amp gain > 7").
   *  Populated for offline file decode + the on-demand /params endpoint; omitted from the bulk device
   *  scan to keep summaries light (use `models` for type search there, fetch /params for deep queries). */
  params?: DecodedBlock[];
};

export interface GridCellDTO {
  row: number; col: number; effectId: number; name: string; isShunt: boolean; routeFlag: number; fromRows: number[];
  /** ADDITIVE (Phase 6): catalog slug where derivable. AM4 cells carry it (its block dictionary is
   *  already slug-shaped) so Axis can key params/help without a pack lookup; gen-3 cells omit it
   *  (their sweep contract is byte-identical). */
  slug?: string;
}
export interface PresetGridDTO { model: string; name: string; crcValid: boolean; rows: number; cols: number; scenes: string[]; cells: GridCellDTO[]; source: 'dump'; }
export interface PresetBlockDTO { slug: string; name: string; effectId: number; row: number; col: number; fromRows: number[]; bypassed: boolean | null; channel: string | null; }
export interface NamedParam { id: number; name: string; value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean; }
export interface EnumParam { id: number; name: string; value: number; options: { value: number; label: string }[]; }
export interface MeterVal { norm: number; value: number; unit?: string; min?: number; max?: number; log?: boolean; }
/** One side (tap/hold) of an FC switch as read by the sub-0x01 structured read. `present` = the
 *  device returned a record whose config/side echo matched the request; `raw` = the 78-byte response
 *  body (the per-switch record is at raw[16..]; field offsets within it are not yet decoded — see
 *  the gen-3 driver's fcReadSwitch). */
export interface FcSideState { selector: number; present: boolean; empty: boolean; raw: number[]; }
export interface FcSwitchState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  tap: FcSideState; hold: FcSideState;
}
/** Decoded current switch state read back from the unit (via the sub-0x1b value channel). Field values
 *  are raw ordinals (category/function/display/color) keyed by FC field name; labels are decoded text.
 *  `null` = the field could not be read. This is the read that actually tracks param edits. */
export interface FcReadState {
  effectId: number;
  layout: number; view: number; switch: number; config: number;
  fields: Record<string, number | null>;
  tapLabel: string; holdLabel: string;
}

// Live pushes streamed to Axis over SSE.
export type DeviceEvent =
  | { type: 'tuner'; freq: number; note?: string; cents?: number; octave?: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'scene'; index: number }
  | { type: 'cpu'; percent: number }
  // Live cross-UI sync (Axis Cloud Remote + multi-window): a mutation happened, so other UIs update.
  // `param` carries the new normalized value (cheap knob update); `changed` = structural (grid/preset)
  // change → reload. Emitted by the mutating driver methods; streamed via SSE + the remote relay channel.
  | { type: 'param'; effectId: number; paramId: number; norm: number }
  | { type: 'blockState'; effectId?: number }
  | { type: 'changed'; scope: 'grid' | 'preset' }
  /** Live output level meters in dB (−40…0, floor-clamped), from the Preset Leveling poll (fn 0x19).
   *  Output 1 & 2, each L/R. Decoded from a 5-septet float (RMS) → 10·log10 → dB; smoothed. */
  | { type: 'meters'; out1L: number; out1R: number; out2L: number; out2R: number }
  /** Device-cache self-describe BUILD progress (the runtime on-connect cache build; capability
   *  selfDescribe). `phase` walks the job: 'walking' (per-block sweep) → 'building' (deriving tables)
   *  → 'done' (persisted) | 'cancelled' | 'error'; 'already-built' is emitted when a build was asked
   *  for but a cache already existed. `done`/`total` are the block-sweep counters; `key`/`model`/
   *  `firmware` identify the cache; `error` carries the failure message on 'error'. */
  | { type: 'cacheBuild'; phase: 'walking' | 'building' | 'done' | 'error' | 'cancelled' | 'already-built'; done: number; total: number; key?: string; model?: number; firmware?: string; error?: string }
  /** A shared Axis config doc (layouts / swipe-quick-actions / tags / surface …) was written by one UI —
   *  streamed to the others so layouts/quick-actions/arrange stay in sync live, both directions. `origin` is
   *  the writer's client id so it can ignore its own echo (and not reload while it's mid-edit). */
  | { type: 'config'; id: string; data: unknown; origin?: string }
  /** The active telemetry cadence mode changed (PUT /telemetry/config, or the setter) — streamed so
   *  every UI reflects the new mode without re-polling the config endpoint. */
  | { type: 'telemetryConfig'; mode: TelemetryMode }
  /** Rolling device-link traffic counters, emitted ~1×/s while ≥1 SSE client is listening (only when a
   *  counter moved since the last emit). All four counters are CUMULATIVE since `since` (epoch ms, the
   *  connection's instrumentation start); `loops` is the currently-active supervisor set. */
  | { type: 'traffic'; txMsgs: number; txBytes: number; rxMsgs: number; rxBytes: number; since: number; loops: string[] };

// ── AM4 (moved verbatim from am4Device.ts) ──
export interface Am4Slot {
  slot: number; // 1..4 signal-chain position
  blockType: string; // canonical block name, 'none' if empty
  pidLow: number; // the block's pidLow (its type value)
}

/** What a device driver can actually do — the single truth the routes gate on (a missing optional
 *  DeviceDriver method always corresponds to a false/absent capability here). No cross-device
 *  `if (isAm4)`-style checks anywhere else. */
export interface DriverCapabilities {
  /** Routing model: gen-3 grid vs the AM4's flat linear chain. */
  slotModel: 'grid' | 'linear';
  /** Grid dimensions (slotModel 'grid' only). */
  grid?: { rows: number; cols: number };
  /** Linear-chain slot count (slotModel 'linear' only). */
  slotCount?: number;
  /** Grid editing (place/clear blocks, cables, cursor select). */
  gridEdit: boolean;
  /** Number of scenes. */
  scenes: number;
  /** Per-block channels (A–D). */
  channels: boolean;
  /** Gen-3 preset dump read (summaries, params, grid-from-dump, backups). */
  presetDump: boolean;
  /** The connected device's CURRENT preset can be dumped + lifted into the cross-device converter IR
   *  (POST /preset/convert with no `source`). True for gen-3 (full lift) / VP4 (skeleton, via its
   *  structure blob) / AM4 (partial). False where no liftable current-preset decode is reachable
   *  (gen-2's preset binary is opaque through the codec's public exports; gen-1 has no lift adapter). */
  presetConvert: boolean;
  /** Full per-block param decode from the preset body (FM3 only today). */
  blockParamDecode: boolean;
  /** Gen-3 live telemetry polls the supervisor may run against this device. */
  telemetry: { tuner: boolean; outputMeters: boolean; cpu: boolean };
  /** Foot Controller address model available. */
  fcModel: boolean;
  /** Live FC per-switch state read (FM3 only today). */
  fcLiveRead: boolean;
  /** Modifier binding (targetEffectId/targetParam/source writes). */
  modBind: boolean;
  /** Bundled cab IR names per bank. */
  cabIrs: boolean;
  /** Editor-authentic block-editor UI layouts (v2 pages → rows → controls) served on the block-params
   *  `layout` field. True on the four devices that ship *_LAYOUTS (FM3 / FM9 / Axe-Fx III / AM4). */
  editorLayouts: boolean;
  /** The server exposes GET/PUT /telemetry/config (cadence-mode control). Registry-level, not per-driver
   *  — advertised on every device so Axis can show the telemetry-mode control unconditionally. */
  telemetryControl?: boolean;
  /** Store-to-slot save supported. */
  supportsSave: boolean;
  /** The device can be walked by the codec's live self-describe (fn 0x01 DEFINITION/ENUM-LABEL
   *  queries) to build a device-true param/roster/enum cache on connect (capability gate for
   *  POST /device/cache/build). Gen-3 grid units only; false everywhere the walk is unverified. */
  selfDescribe: boolean;
  /** An official-editor `effectDefinitions_*.cache` file can be IMPORTED as this device's cache
   *  (capability gate for POST /device/cache/import). The byte source feeds the same buildCache path
   *  the live walk does, so this tracks selfDescribe (gen-3 grid units); false elsewhere. */
  cacheImport: boolean;
  /** The device can run the codec's FULL-mode self-describe walk (`mode:'full'`): the read-only sweep
   *  PLUS a per-float taper sweep that WRITES a normalized value, reads the display back, then restores
   *  the original (capability gate for POST /device/cache/build with `mode:'full'`). True ONLY for the
   *  CaptureRig-proven gen-3 trio (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12); false everywhere the write
   *  sweep is unverified — notably VP4 (the factory-reset incident: its writes stay allowlist-gated). */
  fullCapture: boolean;
  /** The device does NOT push front-panel / editor edits, so the registry supervisor should poll the
   *  driver's `readDeviceEditState()` to catch out-of-band edits (AM4 only — HW-107). Absent = no poll. */
  deviceEditWatch?: boolean;
  /** The device PUSHES front-panel / editor edits as an unsolicited 0x74/0x75/0x76 state-broadcast
   *  burst, so the registry installs a persistent RX listener that reflects them as `param` events
   *  via the driver's `decodeEditBurst()` (gen-3 — the push mirror of deviceEditWatch). Absent = no listener. */
  deviceEditPush?: boolean;
}

/** What the registry hands each driver: the ONE shared transport (a single exclusive MIDI/serial
 *  connection — drivers must never open their own) and the SSE event bus emit. */
export interface DriverCtx {
  transport(): Promise<Transport>;
  emit(e: DeviceEvent): void;
  /** The registry-resolved cadence for the CURRENT telemetry mode + this device's family. Drivers that
   *  run their own edit-watch cadence (the AM4 redesign uses `editRehashMs`) read it here instead of
   *  hardcoding intervals, so a mode switch reaches them without a re-wire. */
  getCadence(): CadenceProfile;
  /** The running firmware the registry read from the device at detect time (gen-3 `fn 0x08`), or null when
   *  it was not read / is not known. Resolved AT CALL TIME (the driver is built before detection reads it).
   *  Optional: a ctx without it simply reports no firmware. */
  getFirmware?(): { major: number; minor: number } | null;
}

/** Why a store was not a plain acknowledged success (gen-3, additive on the store result): 'rejected' = a
 *  fn-0x01 refusal (0x64) was seen in the store window and no ack followed (the 0x64 carries no sub-action, so
 *  a late refusal of a preceding fn-0x01 write can be attributed to the store); 'no-ack' = nothing
 *  acknowledged it in time (the slot may or may not have been written). Callers branch on this instead of
 *  parsing `error` / `warning` text. */
export type StoreReason = 'rejected' | 'no-ack';

/**
 * Per-device driver surface. Method signatures are IDENTICAL to the pre-driver Device methods so the
 * route handlers keep working unchanged. Optional methods are capability-gated: a driver that lacks
 * one (e.g. the AM4 has no grid edit / gen-3 telemetry / FC) simply doesn't implement it, and the
 * route answers `501 {error:'unsupported', capability}`.
 */
export interface DeviceDriver {
  /** SysEx model byte of the device this driver drives (0x10/0x11/0x12/0x15). */
  readonly modelId: number;
  /** Profile key: 'axe3' | 'fm3' | 'fm9' | 'am4'. */
  readonly key: string;
  /** Display name (e.g. 'FM3'). */
  readonly name: string;
  readonly capabilities: DriverCapabilities;

  /** Swap in a device-cache-derived RUNTIME profile (device-true rosters / enum labels / ranges over
   *  the static one). The model byte is unchanged, so the bound codec stays valid — only the data the
   *  driver reads through the profile changes. Implemented by gen-3 (capability selfDescribe); absent
   *  on drivers whose profile is fixed. */
  applyRuntimeProfile?(profile: DeviceProfile): void;

  /** Routing grid (the AM4 serves its 4 slots as a 1×4 grid DTO). */
  grid(): Promise<PresetGridDTO>;

  // ── preset reads ──
  presetRef?(): Promise<{ number: number; name: string }>;
  presetSummary?(presetNumber: number, withParams?: boolean): Promise<PresetSummary>;
  /** Routing grid of the STORED preset in slot `presetNumber` (GET /presets/:n/grid) — a non-disruptive
   *  dump decode that never touches the edit buffer (and never the edit-buffer grid cache) — i.e. the SAVED
   *  state of the slot. Absent on drivers that cannot read a stored slot (capability presetDump): the route
   *  then answers the LIVE grid only when `presetRef()` (AM4 today) says the requested slot is the loaded
   *  one, and 501 otherwise (gen-1 / gen-2 / VP4 have neither method → 501 for every slot). */
  presetGrid?(presetNumber: number): Promise<PresetGridDTO>;
  /** Number of stored preset slots (valid slot numbers are 0..presetCount-1) — the bound the
   *  slot-addressed routes validate against. Absent = unknown (only the integer ≥ 0 check applies). */
  readonly presetCount?: number;
  presetParams?(presetNumber: number): Promise<DecodedBlock[]>;
  /** Raw .syx bytes (the backup blob) + decoded summary for one slot — the backups service's source. */
  dumpRaw?(n: number): Promise<{ bytes: Uint8Array; summary: PresetSummary }>;
  decodePresetBytes?(bytes: Uint8Array): PresetSummary;
  presetBodyHex?(): Promise<{ len: number; hex: string }>;
  placedBlocks?(): Promise<PresetBlockDTO[]>;

  /** Lightweight per-block scene state (bypass + active channel) WITHOUT a preset dump — for reflecting
   *  a scene change snappily. Absent on drivers that can't read it cheaply (callers fall back to a full load). */
  sceneState?(): Promise<{ effectId: number; bypassed: boolean; channel: string | null }[]>;

  // ── catalog ──
  blocksCatalog?(): { slug: string; family: string; instance: number; name: string; page: number; paramCount: number; typeCount: number }[];
  blockTypes?(slug: string): TypeModel[];

  // ── live block params ──
  blockParams?(eid: number): Promise<{ block: string; slug: string; page: number; named: NamedParam[]; enums: EnumParam[]; type: { value: number; name: string } | null; layout?: DeviceLayout }>;
  readParams?(eid: number, pids: number[]): Promise<Record<number, number>>;
  readRange?(eid: number, pids: number[]): Promise<Record<number, number>>;
  rawBlock?(eid: number): Promise<{ eid: number; values: Record<number, number> }>;
  cabIrs?(refresh?: boolean): Promise<Record<string, string[]>>;
  cabState?(eid: number): Promise<unknown>;
  meters?(wants?: Record<string, number[]>): Promise<
    { effectId: number; slug: string; defaultId: number; defaultName: string; typeName: string; vals: Record<number, MeterVal> }[]
  >;
  liveMonitors?(onlyEid?: number): Promise<{ effectId: number; family: string; paramName: string; role: string; norm: number; db: number | null; minDb?: number; maxDb?: number }[]>;
  /** Looper page telemetry (GET /preset/looper): live waveform envelope (0..1 magnitudes) + playhead
   *  position (0..1) + level (0..1). Empty when the block isn't a looper. gen-3 (capability liveMonitors). */
  looperTelemetry?(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }>;
  /** Toggle a looper transport control (POST /preset/looper/control). `action` ∈ record|play|stop|
   *  overdub|undo|once|reverse|half; `on` = 1.0/0.0. gen-3. */
  looperControl?(eid: number, action: string, on: boolean): Promise<{ ok: boolean }>;

  // ── FC / modifier ──
  fcReadSwitch?(layout: number, view: number, sw: number): Promise<FcSwitchState>;
  fcReadState?(layout: number, view: number, sw: number): Promise<FcReadState>;
  bindModifier?(slot: number, targetEffectId: number, targetParam: number, source: number): Promise<{ ok: boolean; error?: string; slotEid?: number; slot?: number; targetEffectId?: number; targetParam?: number; source?: number }>;

  // ── writes ──
  setParam?(eid: number, paramId: number, value: number, continuous: boolean): Promise<{ ok: boolean }>;
  setType?(eid: number, value: number): Promise<{ ok: boolean }>;
  setBypass?(eid: number, bypassed: boolean): Promise<{ ok: boolean }>;
  setChannel?(eid: number, channel: string): Promise<{ ok: boolean }>;
  placeCell?(row: number, col: number, blockId: number): Promise<{ ok: boolean }>;
  selectCell?(row: number, col: number): Promise<{ ok: boolean }>;
  cable?(srcRow: number, srcCol: number, destRow: number, connect: boolean): Promise<{ ok: boolean }>;
  /** Switch the active preset. `code` is ADDITIVE (AM4 bank-letter location code, e.g. "C02"). */
  selectPreset?(n: number): Promise<{ ok: boolean; code?: string }>;
  /** Re-select the CURRENT preset to reload it from flash — the non-destructive safety net the codec's
   *  FULL-mode self-describe walk runs after every block whose params it swept, discarding any lingering
   *  sweep write. Reuses the driver's current-preset ref + preset-select machinery; no new wire bytes.
   *  Implemented by gen-3 (capability fullCapture); absent elsewhere. */
  reloadPreset?(): Promise<void>;
  /** Store the edit buffer to slot n. `location`/`code` are ADDITIVE (AM4). `acked`/`reason`/`error`/`warning`
   *  are ADDITIVE (gen-3): `acked` = the device's own acknowledgement was seen. `ok:false` + `error` = a real
   *  refusal (`reason:'rejected'`), or (where the ack is verified for this model, link and firmware) no
   *  acknowledgement in time (`reason:'no-ack'`, outcome unknown). `ok:true` + `warning` = sent but
   *  unconfirmed (the ack is not verified here and none came; also `reason:'no-ack'`). `reason` is absent on
   *  an acknowledged store. Drivers without a known ack (AM4 / VP4 fire-and-forget; gen-2 lenient) omit all
   *  four. */
  store?(n: number): Promise<{ ok: boolean; location?: number; code?: string; acked?: boolean; reason?: StoreReason; error?: string; warning?: string }>;
  loadPresetBytes?(syx: Uint8Array): Promise<{ ok: boolean }>;
  setSceneName?(index: number, name: string): Promise<{ ok: boolean }>;
  setPresetName?(name: string): Promise<{ ok: boolean }>;

  // ── tempo / scene ──
  getTempo?(): Promise<{ bpm: number }>;
  setTempo?(bpm: number): Promise<{ ok: boolean }>;
  tapTempo?(): Promise<{ ok: boolean }>;
  getScene?(): Promise<{ index: number }>;
  setScene?(index: number): Promise<{ ok: boolean }>;
  /** Live active-channel per placed block (effectId → channel 0-3). Drives the registry's
   *  front-panel channel-change watch so a device-side A–D switch re-reads the per-channel
   *  block type. Gen-3 only (blocks with A–D channels); undefined on devices without channels. */
  getActiveChannels?(): Promise<Map<number, number>>;
  /** One live tuner reading (already resolved to display fields). Devices whose tuner is NOT a
   *  gen-3 tuner-page poll (AM4 polls block 0x0023) implement this; the registry supervisor calls
   *  it on the tuner cadence and emits the `tuner` event. Gen-3 uses the built-in poll instead. */
  readTuner?(): Promise<{ freq: number; note: string; octave: number; cents: number } | null>;

  // ── Phase 6 unified surface (capability-gated; today AM4-only unless noted) ──
  /** Stored preset name lookup (GET /presets/:n). Devices without it get the {number, name:''} stub. */
  storedPresetName?(n: number): Promise<{ number: number; name: string; code?: string }>;
  /** Scan every stored location by name (GET /preset/locations) — capability presets.canScanNames. */
  scanPresets?(): Promise<{ count: number; presets: { location: number; code: string; name: string; isEmpty: boolean }[] }>;
  /** Verbatim .syx dump of one preset (POST /preset/backup) — capability backupDump. `sceneNames`
   *  and `crcValid` are ADDITIVE, opt-in container-decode fields (AM4) alongside the opaque `bytes`;
   *  absent when the device/decoder doesn't surface them. */
  backupPreset?(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[]; sceneNames?: string[]; crcValid?: boolean }>;
  /** Verbatim re-emit of a preset dump (POST /preset/restore) — capability restoreDump. */
  restorePreset?(bytes: number[]): Promise<{ ok: boolean; location: number | null; code: string | null }>;
  /** Offline firmware .syx integrity check (POST /firmware/validate) — capability firmwareValidate. */
  validateFirmware?(bytes: number[]): { valid: boolean; messages?: number; blocks?: number; headerTag?: number[]; finalizeTag?: number[]; error?: string };
  /** Device/global param write by catalog key (PUT /device/param) — capability deviceParams. */
  setParamByKey?(key: string, value: number): Promise<{ ok: boolean }>;
  /** Modifier address model (GET /mod/model). Superset DTO: always carries `bindingSupported`. */
  modifierModel?(): Record<string, unknown> | null;

  // ── device-edit watch (capability deviceEditWatch; AM4-only today) ──
  /** One poll tick of out-of-band edit detection for devices that don't push edits (AM4 front-panel /
   *  AM4-Edit — HW-107). Returns `{changed:true}` when a DEVICE-originated edit happened since the last
   *  tick; suppresses the app's own writes. The registry supervisor calls this while an SSE client is
   *  listening and emits `changed{scope:'preset'}` on a true. */
  readDeviceEditState?(): Promise<{ changed: boolean }>;
  /** Decode a reassembled unsolicited state-broadcast burst (front-panel / editor edit the device
   *  PUSHED — gen-3) into per-param `param` events, diffed against the last-known snapshot so a
   *  whole-block burst yields only the moved param(s). `reload:true` means the burst couldn't be diffed
   *  (first sight of the block) → the registry emits a `changed` reload instead so the edit isn't lost.
   *  Capability `deviceEditPush`. */
  decodeEditBurst?(frames: number[][]): { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean };
}
