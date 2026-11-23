// Device registry — everything that is CROSS-device: the one shared transport (a single exclusive
// MIDI/serial connection), connection selection/diagnostics, the fn 0x00 detection state machine that
// picks the active per-device driver, the SSE event bus, and the telemetry supervisor (tuner / output
// meters / CPU polls). Drivers never open ports and never poll on their own — they get the transport +
// event emit through DriverCtx and are otherwise pure device logic.
//
// Since the browser-runtime split this module is the TRANSPORT-AGNOSTIC core: everything Node-specific
// (serial/MIDI port enumeration, connection open, the persisted overrides file) arrives via
// RegistryDeps, so the same registry runs over the real transports (drivers/registry.ts wires them and
// owns the process singleton) or a browser's Web MIDI implementation. NO node:/transport imports here —
// this module must load in a browser (transport/types.js is type-only).
import {
  DEVICE_MODELS,
  buildIdentifyBroadcast,
  isFractalHeaderFrame,
  parseIdentifyResponse,
  modelFromPortName,
  buildFirmwareVersionQuery,
  parseFirmwareVersionReply,
  formatFirmwareVersion,
  FN_FIRMWARE_VERSION
} from 'forgefx-midi/shared';
import type { BuiltCache } from 'forgefx-midi/cache';
import {
  buildTunerPageOpen,
  buildTunerPageClose,
  buildTunerPoll,
  isTunerResponse,
  parseTunerFreqHz,
  GEN3_OUTPUT_METERS,
  buildOutputMeterPoll,
  isOutputMeterResponse,
  parseOutputMeterRms,
  meterRmsToDb,
  buildCpuPoll,
  isCpuResponse,
  parseCpuRawLoad,
  cpuPercentFromRaw
} from 'forgefx-midi/gen3/axe-fx-iii';
// Per-device capability declarations (the package's single source of truth: scenes, channels, slot
// model, save, …). Surfaced via /device so Axis drives its UI from what each model actually supports,
// instead of hardcoded per-model assumptions.
import { FM3_DESCRIPTOR, FM9_DESCRIPTOR, AXEFX3_DESCRIPTOR, VP4_DESCRIPTOR } from 'forgefx-midi/devices/gen3';
import { AM4_DESCRIPTOR } from 'forgefx-midi/devices/am4';
import { AXEFX2_DESCRIPTOR } from 'forgefx-midi/devices/gen2';
import { AXEFXGEN1_DESCRIPTOR } from 'forgefx-midi/devices/gen1';
import { TRANSPORT_TIMEOUT_CODE, isTransportTimeout, type Transport, type Conn, type ConnKind } from '../transport/types.js';
import { DEFAULT_PROFILE, PROFILES, profileForModel, profileForKey, runtimeProfileFrom, type DeviceProfile } from '../devices.js';
import { checkProfileSchema } from '../profileSchema.js';
import { createGen3Driver, GEN3_SHUNT_BASE } from './gen3.js';
import { createAm4Driver, type Am4Driver } from './am4.js';
import { createGen2Driver } from './gen2.js';
import { createGen1Driver } from './gen1.js';
import { createVp4Driver } from './vp4.js';
import type { DeviceDriver, DeviceEvent, DriverCtx, DriverCapabilities } from './types.js';
import { assertRawProbeAllowed } from './sendPolicy.js';
import { cadenceFor, isTelemetryMode, TELEMETRY_MODES, type TelemetryMode, type CadenceProfile } from './telemetryProfiles.js';

/** Device-cache doc key for the deviceCaches store collection: `<model-hex>_<major>p<minor>`
 *  (e.g. FM3 fw 12.0 → `11_12p0`). Shared by the registry (runtime profile swap) + the deviceCache
 *  service (status / build / delete) so both address the exact same doc. */
export function deviceCacheKey(modelId: number, major: number, minor: number): string {
  return `${modelId.toString(16).padStart(2, '0')}_${major}p${minor}`;
}

/** Per gen-3 model, the HIGHEST firmware (major.minor) on which the cache build's FULL mode — the live
 *  self-describe walk that also taper-sweeps, i.e. WRITES to the device — is allowed. Each entry is a
 *  version on which a full capture was actually carried out successfully; anything newer is refused
 *  (fail closed) because a newer firmware may change the end-of-table behaviour the walk relies on —
 *  FM3 firmware 13.0 did: a walk without the table-end bound does not stop at the end of a block (the
 *  end-marker replies are counted as real records), so it runs for a very long time and would write sweep
 *  values to parameters that do not exist. The bounded walk is verified on FM3 13.0. Fractal numbers firmware per model (the Axe-Fx III is on 32.x while the
 *  FM3/FM9 are on 12.x/13.x), so the table is keyed by model byte. A model without an entry is never
 *  allowed. Add or raise an entry only after a full capture has completed on that model and version.
 *  The FM9 has NO entry: no full capture has completed on an FM9 yet (the attempts on firmware 12.0
 *  stopped responding part-way through the walk), so full mode stays off there until one does.
 *  Read-only mode is intentionally NOT governed by this table. */
export const FULL_CAPTURE_MAX_VERIFIED_FW: Readonly<Record<number, { readonly major: number; readonly minor: number }>> = {
  0x11: { major: 13, minor: 0 }, // FM3 (13.0 verified with the table-end-bounded walk)
  0x10: { major: 32, minor: 6 }  // Axe-Fx III (a complete full capture exists on 32.6)
};

/** Whether FULL-mode capture is permitted for `modelId` on the given running firmware: only a KNOWN,
 *  well-formed firmware (major >= 1) that is at or below the model's entry in
 *  {@link FULL_CAPTURE_MAX_VERIFIED_FW} (major.minor comparison). Unknown firmware, an unknown model, or
 *  a version above the verified one is refused — full mode writes to the device, so it never runs
 *  against a version it has not been verified on. Shared by the cache-build service (the actual gate)
 *  and the capabilities DTO (so the UI does not offer it). */
export function fullCaptureAllowedOnFirmware(modelId: number, fw: { major: number; minor: number } | null | undefined): boolean {
  if (fw == null || !Number.isInteger(fw.major) || !Number.isInteger(fw.minor) || fw.major < 1 || fw.minor < 0) return false;
  const max = FULL_CAPTURE_MAX_VERIFIED_FW[modelId];
  if (!max) return false;
  return fw.major < max.major || (fw.major === max.major && fw.minor <= max.minor);
}

/** Whether the in-app diagnostic capture (POST /diagnostics/capture) may run on a device: gen-3 units whose
 *  driver offers the self-describe walk (its read-only walk, label probe and dump probes are gen-3 wire
 *  features). Shared by the capabilities DTO (`diagnosticCapture`) and the capture service (the 501 gate). */
export function diagnosticCaptureSupported(modelId: number, caps: Pick<DriverCapabilities, 'selfDescribe'> | null | undefined): boolean {
  return !!caps?.selfDescribe && DEVICE_MODELS[modelId]?.gen === 3;
}

/** The /telemetry/config DTO both surfaces serve: the current mode, its resolved cadence, and the
 *  full mode list. Cumulative-counter-free — traffic rides the SSE `traffic` event + /diag. */
export interface TelemetryConfigDto { mode: TelemetryMode; effective: CadenceProfile; modes: readonly TelemetryMode[]; }

const DESCRIPTOR_BY_MODEL: Record<number, { capabilities: Record<string, unknown> }> = {
  0x01: AXEFXGEN1_DESCRIPTOR as never,
  0x07: AXEFX2_DESCRIPTOR as never,
  0x10: AXEFX3_DESCRIPTOR as never,
  0x11: FM3_DESCRIPTOR as never,
  0x12: FM9_DESCRIPTOR as never,
  0x14: VP4_DESCRIPTOR as never,
  0x15: AM4_DESCRIPTOR as never
};

// Gen-3 virtual effects Axis exposes as rail screens (ToolRail's VIRTUAL map + the Modifier flyout's
// effectId 3) — surfaced in the capabilities DTO so the client stops hardcoding them per model.
const GEN3_VIRTUAL_EFFECTS: readonly { eid: number; slug: string; name: string }[] = [
  { eid: 1, slug: 'global', name: 'Setup' },
  { eid: 2, slug: 'controllers', name: 'Controllers' },
  { eid: 3, slug: 'modifier', name: 'Modifier' },
  { eid: 199, slug: 'fc', name: 'Footswitches' }
];
// gen-3 grid shunt effect-id base (GEN3_SHUNT_BASE, shunt eids = 1024+); the AM4's linear chain has no shunts.

// Per-transport-instance idempotency flag for #instrumentTransport (double-wrapping would double-count
// the fn-0x1F echo guard and silently break front-panel edit reflection).
const INSTRUMENTED = Symbol('forgefx.transport.instrumented');

/** TRANSITIONAL shim: the browser-direct transports (Axis webmidi / webserial / nativeMidi) still reject a
 *  no-frame request timeout with a plain `Error('<MIDI|Serial> request timed out after Nms')` and no
 *  `code`. Tag exactly those with the typed `code` the transport contract defines, HERE at the one choke
 *  point every transport passes through, so no driver ever has to parse that text. Drop the shim once the
 *  transports set `code` at source (Axis follow-up). Other errors pass through untouched. */
function withTimeoutCode(e: unknown): unknown {
  if (e instanceof Error && !isTransportTimeout(e) && /^(?:MIDI|Serial) request timed out after \d+ ?ms$/i.test(e.message)) {
    (e as Error & { code?: string }).code = TRANSPORT_TIMEOUT_CODE;
  }
  return e;
}

/** One selectable connection as the deps' lister reports it (serial + MIDI, Fractal flagged) —
 *  structurally identical to transport/connection.ts's ConnInfo, re-declared here so the core stays
 *  free of transport imports. */
export interface ConnInfo {
  transport: ConnKind;
  id: string;
  label: string;
  fractal: boolean;
  model?: string;
  /** MIDI only: which endpoint this entry is (the picker offers In + Out separately). */
  dir?: 'input' | 'output';
}

/**
 * Everything Node-specific the registry needs, injected: connection resolution/opening/listing, the
 * persisted connection + profile overrides, serial path autodetect and MIDI availability. The server
 * wires the real transport/connection.ts functions (drivers/registry.ts); the mocked unit tests and a
 * browser runtime supply their own.
 */
export interface RegistryDeps {
  /** Resolve the active connection (manual override → serial auto → MIDI auto). */
  resolveConn(): Promise<Conn | null>;
  /** Open a Transport over a resolved connection. */
  openConn(conn: Conn): Transport;
  /** Every selectable connection, for /ports + /diag. */
  listConnections(): Promise<ConnInfo[]>;
  /** Manual connection override (persisted); null = auto. */
  getConnOverride(): Conn | null;
  setConnOverride(c: Conn | null): void;
  /** Manual device-profile override key (persisted; 'fm3'/'fm9'/'axe3'/'am4'); null = auto. */
  getProfileOverride(): string | null;
  setProfileOverride(key: string | null): void;
  /** Serial auto-detect path — display fallback while no transport is open. */
  autoDetectPath(): string | null;
  /** Native MIDI binding availability (diagnostics only). */
  midiAvailable(): boolean;
  /** Load a persisted device cache for the given key (deviceCacheKey), or null when none exists.
   *  Injected so the core stays store-agnostic: the Node server reads defaultStore; a browser runtime
   *  its own. Absent → the registry never swaps in a runtime profile (static profile only). A hook
   *  should return only profiles this build may use (`loadUsableProfile`); applyRuntimeCache re-checks
   *  the schema anyway, so a hook that forgets cannot make a stale profile live. */
  loadDeviceCache?(key: string): BuiltCache | null | Promise<BuiltCache | null>;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Detected frequency (Hz) → musical note + cents offset (equal temperament, A4=440). */
function freqToNote(f: number): { note: string; cents: number; octave: number } | null {
  if (!(f > 0) || !Number.isFinite(f)) return null;
  const midi = 69 + 12 * Math.log2(f / 440);
  const nearest = Math.round(midi);
  return {
    note: NOTE_NAMES[((nearest % 12) + 12) % 12]!,
    cents: Math.round((midi - nearest) * 100),
    octave: Math.floor(nearest / 12) - 1
  };
}

// The Node process object where available (server/Electron) — a browser runtime has none, and /diag
// must still answer there. Guarded access, not an import, so the browser bundle stays clean.
const proc = typeof process !== 'undefined' ? process : null;

export class DeviceRegistry {
  // Everything Node-specific — the real transport/connection.ts functions in production (wired by
  // drivers/registry.ts), mock implementations in the unit tests, Web MIDI in a browser runtime.
  #deps: RegistryDeps;
  // Provisional gen-3 profile (model byte, grid size, params, ranges, rosters). Starts from a persisted
  // manual profile override (Axis "Connection & Device"), then FORGEFX_DEVICE, else FM3; corrected to the
  // real unit on the first auto-detect (only when no override is set). Used for reporting (health/diag/
  // /ports) and as the fallback driver's profile when the attached unit hasn't identified itself.
  #prof: DeviceProfile;
  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    this.#prof = ((): DeviceProfile => {
      const forced = deps.getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) return p; }
      if (proc?.env.FORGEFX_DEVICE) { const p = profileForKey(proc.env.FORGEFX_DEVICE); if (p) return p; }
      return DEFAULT_PROFILE;
    })();
  }

  #transport: Transport | null = null;
  #connecting: Promise<Transport> | null = null;
  #detected = false;
  #modelId = -1; // the ACTUAL attached/forced model byte (-1 = not identified yet)
  // Running firmware, populated best-effort during detect() on gen-3 units (fn 0x08). null until a
  // reply lands (silence/timeout/non-gen-3 keeps it null); surfaced via deviceInfo() + firmwareInfo().
  #firmware: { major: number; minor: number; version: string; build: string } | null = null;
  // The active driver — set ONLY by detect() from a positively identified (or forced) model. No
  // identification → no active driver → the telemetry supervisor never fires a frame at an unknown
  // unit (this replaces the old `#modelId === -1` wait-loop AND every #isAm4() gate).
  #active: DeviceDriver | null = null;
  // One driver instance per model byte (grid caches etc. survive re-detects of the same unit).
  #drivers = new Map<number, DeviceDriver>();
  #ctx: DriverCtx = {
    transport: () => this.transport(),
    emit: (e) => this.#emit(e),
    getCadence: () => this.#cadence(),
    getFirmware: () => this.#firmware // read at call time: drivers are built before detect() reads it
  };

  get profile() { return this.#prof; }

  /** The positively-detected model byte (-1 until detection identifies a unit). */
  get detectedModelId() { return this.#modelId; }
  /** The active driver's capabilities, or null when nothing is positively identified (the deviceCache
   *  service gates its selfDescribe precondition on this). */
  activeCapabilities(): DriverCapabilities | null { return this.#active?.capabilities ?? null; }
  /** Running firmware (populated best-effort on gen-3 during detect), or null. Includes the numeric
   *  major/minor the deviceCache key needs alongside the display `version`. */
  firmwareInfo(): { major: number; minor: number; version: string; build: string } | null { return this.#firmware; }
  /** Re-read the running firmware (fn 0x08, the same path detect() uses) for the CURRENT model and
   *  return it — null when the device is silent / replies for another model / reports major 0. The
   *  previous value is always cleared first, so a unit that changed firmware (or went quiet) since
   *  detect() never leaves a stale version behind. Used by the full-capture gate right before it decides. */
  async refreshFirmware(): Promise<{ major: number; minor: number; version: string; build: string } | null> {
    await this.#populateFirmware(this.#modelId);
    return this.#firmware;
  }
  /** Public emit seam: services (device-cache build progress) publish on the same SSE bus the drivers
   *  reach through DriverCtx.emit. */
  emitEvent(e: DeviceEvent): void { this.#emit(e); }

  // ── telemetry cadence mode (in-memory; resets to the balanced default on restart) ──
  #telemetryMode: TelemetryMode = 'balanced';
  /** The cadence bundle for the CURRENT mode + the ACTIVE driver's model family (falls back to the
   *  detected/provisional model, then generic). Resolved AT CALL TIME so a mode switch applies on the
   *  next reschedule of every loop without touching timers directly. */
  #cadence(): CadenceProfile {
    const mid = this.#active?.modelId ?? (this.#modelId >= 0 ? this.#modelId : null);
    return cadenceFor(mid, this.#telemetryMode);
  }
  /** GET /telemetry/config payload. */
  getTelemetryConfig(): TelemetryConfigDto {
    return { mode: this.#telemetryMode, effective: this.#cadence(), modes: TELEMETRY_MODES };
  }
  /** Set the cadence mode (PUT /telemetry/config). Validates, stores in-memory, and emits a
   *  `telemetryConfig` event so every live UI reflects it. Throws on an unknown mode (the route maps
   *  that to 400). Returns the fresh DTO. */
  setTelemetryMode(mode: string): TelemetryConfigDto {
    if (!isTelemetryMode(mode)) throw new Error(`unknown telemetry mode '${mode}'`);
    this.#telemetryMode = mode;
    this.#emit({ type: 'telemetryConfig', mode });
    return this.getTelemetryConfig();
  }
  /** The accepted mode set — the route uses it to 400 an unknown value before calling the setter. */
  telemetryModes(): readonly TelemetryMode[] { return TELEMETRY_MODES; }

  /** Driver factory: model byte → per-device driver over the shared transport. */
  #driverFor(modelId: number): DeviceDriver | null {
    const cached = this.#drivers.get(modelId);
    if (cached) return cached;
    const make: Record<number, () => DeviceDriver> = {
      0x01: () => createGen1Driver(this.#ctx),
      0x07: () => createGen2Driver(this.#ctx),
      0x10: () => createGen3Driver(PROFILES[0x10]!, this.#ctx),
      0x11: () => createGen3Driver(PROFILES[0x11]!, this.#ctx),
      0x12: () => createGen3Driver(PROFILES[0x12]!, this.#ctx),
      0x14: () => createVp4Driver(this.#ctx),
      0x15: () => createAm4Driver(this.#ctx)
    };
    const f = make[modelId];
    if (!f) return null;
    const d = f();
    this.#drivers.set(modelId, d);
    return d;
  }

  /**
   * The driver for the attached device. Runs detection once, lazily (like the old Device.#ready), so
   * direct API use (not just the Axis client, which calls /device/detect first) still adapts to the
   * attached unit. When nothing identified itself (silent handshake, unsupported model, no device),
   * this serves the provisional gen-3 profile's driver — exactly the pre-driver behavior, where every
   * route simply tried the default profile and transport errors surfaced as the clear
   * "No Fractal device found…" 503s.
   */
  async driver(): Promise<DeviceDriver> {
    await this.#ready();
    return this.#active ?? this.#driverFor(this.#prof.model)!;
  }

  /** The AM4 driver instance — used by the /preset/decode model-byte dispatch (offline decode of an
   *  AM4 .syx works whatever unit is attached) and pre-fold by the /am4/* singleton routes. */
  am4(): Am4Driver {
    return this.#driverFor(0x15) as Am4Driver;
  }

  /** TEST-ONLY seam (see __setDriverForTest): pre-seed the driver cache for one model byte so the
   *  API suites can run against a hand-built fake driver. Production never calls this. */
  __seedDriver(modelId: number, d: DeviceDriver): void {
    this.#drivers.set(modelId, d);
  }

  /** TEST-ONLY: route-driven (non-supervisor) requests currently in flight — the value the supervisor
   *  yields on (FORGEFX-28). Production never calls this. */
  __interactiveInFlightForTest(): number { return this.#interactiveInFlight(); }
  /** TEST-ONLY: re-run transport instrumentation to prove it is idempotent (a second wrap must be a
   *  no-op — double-wrapping would double-count the fn-0x1F echo guard and break edit reflection). */
  __instrumentTransportForTest(t: Transport): void { this.#instrumentTransport(t); }

  /** Map a manual profile-override key to a model byte. Gen-3 keys resolve via profileForKey; AM4 has no
   *  gen-3 profile (it uses the separate am4 codec) so it maps to its model byte directly. -1 = unknown. */
  #forcedModelId(key: string): number {
    const p = profileForKey(key);
    if (p) return p.model;
    // Descriptor-based devices have no gen-3 DeviceProfile (their codec is separate), so map directly.
    if (key === 'am4') return 0x15;
    if (key === 'axe2') return 0x07;
    if (key === 'vp4') return 0x14;
    if (key === 'gen1') return 0x01;
    return -1;
  }

  // ── event bus (SSE source): live tuner/scene/tempo/cpu pushes ──
  #subscribers = new Set<(e: DeviceEvent) => void>();
  subscribe(fn: (e: DeviceEvent) => void): () => void {
    this.#subscribers.add(fn);
    this.#startMeters(); // a listener is present → stream CPU + audio meters (gen-3 only)
    this.#startEditWatch(); // …and poll for front-panel edits on devices that don't push them (AM4 + FM3)
    this.#startEditPush(); // …and listen for gen-3's unsolicited front-panel state-broadcast bursts
    this.#startTraffic(); // …and stream ~1×/s device-link traffic counters
    return () => {
      this.#subscribers.delete(fn);
      if (this.#subscribers.size === 0) { this.#stopMeters(); this.#stopEditWatch(); this.#stopEditPush(); this.#stopTraffic(); }
    };
  }
  /** Broadcast a shared-config change to every live UI (SSE + remote relay). Called by the store route on
   *  a `config` collection write. Does not touch the device — pure fan-out. */
  broadcastConfig(id: string, data: unknown, origin?: string) {
    this.#emit({ type: 'config', id, data, origin });
  }
  #emit(e: DeviceEvent) {
    // Keep the scene-watch baseline in sync with EVERY scene event (app writes via
    // setScene included), so the poll never re-emits a scene change a client already saw.
    // A scene switch also remaps per-block active channels — reset the channel-watch baseline
    // too, so it re-primes silently instead of emitting a redundant `changed` (which would drive a
    // second, heavy grid reload on top of the scene handler's own lightweight refresh).
    if (e.type === 'scene') { this.#lastSceneIdx = e.index; this.#lastChannels = null; }
    // A UI channel write (gen3 setChannel) emits `blockState` AFTER moving the device's active channel —
    // keep the channel-watch baseline in sync so the next tick doesn't re-emit a redundant
    // blockState against the stale baseline. (A scene event above also resets it.)
    else if (e.type === 'blockState') this.#lastChannels = null;
    for (const fn of this.#subscribers) {
      try {
        fn(e);
      } catch {
        /* a dead subscriber must not break the others */
      }
    }
  }

  get port() { return this.#transport?.label ?? this.#deps.autoDetectPath(); }

  /** The ONE shared open transport — every driver reads/writes through this, so AM4 + gen-3 never
   *  double-open the single exclusive MIDI/serial connection. */
  async transport(): Promise<Transport> {
    if (this.#transport?.isOpen) return this.#transport;
    // share a single open across concurrent callers — the UI fires many requests on load, and
    // opening the same port twice fails the exclusive lock ("Cannot lock port").
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const conn = await this.#deps.resolveConn(); // serial (FM3 CDC) or MIDI (Axe-Fx III), manual override wins
        if (!conn) throw new Error('No Fractal device found on any serial or MIDI port. Connect the unit, quit other editors, or pick it under Connection.');
        const t = this.#deps.openConn(conn);
        await t.open();
        this.#instrumentTransport(t); // echo-guard + traffic counters + interactive-request tracking
        this.#transport = t;
        this.#linkSlow = t.slow;
        // A NEW transport may reach another unit, or the same one after a reboot / re-plug, so a firmware
        // read over the previous one can no longer be trusted. Clear it rather than re-read here: the read
        // itself goes through transport() (it would recurse), and the next detect() redoes it. Null is the
        // safe value — the FM3 store-ack scope reads it as "unknown" (lenient), deviceInfo() reports no
        // firmware, and applyRuntimeCache() simply does nothing (no cache key is built from a stale value).
        // (Today a dropped connection goes through selectConnection(), which clears it too; this keeps the
        // invariant for any other path that ends up opening a new transport.)
        this.#firmware = null;
        return t;
      })().catch((e) => {
        this.#connecting = null; // allow a retry on the next request
        throw e;
      });
    }
    return this.#connecting;
  }

  async health() {
    const conn = await this.#deps.resolveConn();
    return { ok: !!conn, device: this.#prof.name };
  }

  /** Full connection diagnostic for the desktop debug log — platform, MIDI availability, every
   *  serial + MIDI in/out port, the resolved connection, and the live transport state. */
  async diagnostics() {
    let ports: ConnInfo[] = [];
    let listError: string | null = null;
    let resolved: Conn | null = null;
    try { ports = await this.#deps.listConnections(); } catch (e) { listError = (e as Error).message; }
    try { resolved = await this.#deps.resolveConn(); } catch (e) { listError = (listError ?? '') + ' | resolve: ' + (e as Error).message; }
    const midi = ports.filter((p) => p.transport === 'midi');
    return {
      ok: true,
      platform: proc?.platform ?? 'browser',
      arch: proc?.arch ?? '',
      versions: { node: proc?.versions.node ?? '', napi: proc?.versions.napi ?? '' },
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      detected: this.#detected,
      midiAvailable: this.#deps.midiAvailable(),
      ports: {
        serial: ports.filter((p) => p.transport === 'serial').map((p) => ({ id: p.id, fractal: p.fractal, model: p.model })),
        midiIn: midi.filter((p) => p.dir === 'input').map((p) => ({ id: p.id, fractal: p.fractal })),
        midiOut: midi.filter((p) => p.dir === 'output').map((p) => ({ id: p.id, fractal: p.fractal }))
      },
      override: this.#deps.getConnOverride(),
      profileOverride: this.#deps.getProfileOverride(),
      resolved,
      transportOpen: !!this.#transport?.isOpen,
      transportLabel: this.#transport?.label ?? null,
      // Cumulative device-link traffic since the connection was instrumented (matches the SSE `traffic`
      // event's counters); telemetryMode surfaces the active cadence mode + its currently-active loops.
      telemetryMode: this.#telemetryMode,
      traffic: { ...this.#traffic, since: this.#trafficSince, loops: this.#activeLoops() },
      listError
    };
  }

  /** Every connection (serial + MIDI, Fractal flagged) + the chosen one + any manual override. */
  async connections() {
    return {
      chosen: await this.#deps.resolveConn(),
      override: this.#deps.getConnOverride(),
      profileOverride: this.#deps.getProfileOverride(),
      profile: { key: this.#prof.key, name: this.#prof.name, model: `0x${this.#prof.model.toString(16)}` },
      ports: await this.#deps.listConnections()
    };
  }
  /** Manually pick a connection (persisted); null clears it back to auto-detect. Optionally force the
   *  device profile (`model` key: fm3/fm9/axe3/am4, or 'auto'/null to clear). Drops the live connection so
   *  the next request reconnects on the chosen port; a forced profile skips the handshake in detect(). */
  async selectConnection(conn: Conn | null, model?: string | null) {
    this.#deps.setConnOverride(conn);
    if (model !== undefined) {
      this.#deps.setProfileOverride(model && model !== 'auto' ? model : null);
      const forced = this.#deps.getProfileOverride();
      if (forced) { const p = profileForKey(forced); if (p) this.#prof = p; } // apply gen-3 profile now (AM4 handled in detect)
    }
    if (this.#transport) {
      await this.#transport.close().catch(() => {});
      this.#transport = null;
    }
    this.#connecting = null;
    this.#detected = false;
    this.#firmware = null; // re-query firmware against whatever the next detect identifies
    this.#active = null; // the next detect re-identifies — never poll the new port with the old model
    return { ok: true, chosen: await this.#deps.resolveConn(), profileOverride: this.#deps.getProfileOverride() };
  }

  /** Phase-6 extended capability matrix for a model byte — the ADDITIVE superset fields merged into
   *  the curated descriptor subset (see #capabilitiesDto). Derived from the driver's own
   *  DriverCapabilities + which optional driver methods it implements (capability-, never
   *  model-gated), so the DTO can't drift from what the routes actually answer. Null when no driver
   *  exists for the model (e.g. VP4) — the curated subset is then served alone. */
  #extendedCaps(mid: number): Record<string, unknown> | null {
    const d = this.#driverFor(mid);
    if (!d) return null;
    const c = d.capabilities;
    const grid = c.slotModel === 'grid';
    const prof = grid ? profileForModel(mid) : null;
    return {
      presets: {
        count: grid ? 512 : 104, // 512 slots on every gen-3 unit; 104 (A01..Z04) on the AM4
        addressing: grid ? 'numeric' : 'bankLetter',
        canRename: !!d.setPresetName,
        canScanNames: !!d.scanPresets,
        canDeepScan: c.presetDump,
        liveQuery: !!d.presetRef
      },
      // Routing = rewiring the signal path with CABLES, which is a real driver method (d.cable) — NOT the
      // same as being able to place/clear blocks. The AM4 edits its chain (d.placeCell) but has a fixed
      // linear route with no cables, so gridRouting is false there while block placement still works.
      gridRouting: !!d.cable,
      gridCursorSelect: !!d.selectCell,
      shuntBase: grid ? GEN3_SHUNT_BASE : null,
      // both codecs serve full param catalogs server-side (gen-3 tables + AM4 KNOWN_PARAMS) — Axis
      // can drop its client-side `!c.pack` gates on either device.
      paramsWithoutPack: true,
      tempo: !!d.getTempo,
      tuner: c.telemetry.tuner,
      meters: {
        blockMeters: !!d.meters,
        liveMonitors: !!d.liveMonitors && !!prof?.monitorParams,
        outputLevels: c.telemetry.outputMeters,
        cpu: c.telemetry.cpu
      },
      sceneNamesWritable: !!d.setSceneName,
      fc: { model: c.fcModel, liveState: c.fcLiveRead },
      modifiers: { model: (d.modifierModel?.() ?? null) != null, bind: c.modBind },
      cabIrs: c.cabIrs,
      // On-connect device-cache self-describe build (POST /device/cache/build). Gen-3 grid units only.
      selfDescribe: c.selfDescribe,
      // Official-editor .cache import (POST /device/cache/import). Tracks selfDescribe (gen-3 grid units).
      cacheImport: c.cacheImport,
      // FULL-mode self-describe write-sweep (POST /device/cache/build with mode:'full'). True only for the
      // CaptureRig-proven gen-3 trio (III/FM3/FM9); false on VP4/AM4/gen-1/gen-2. Derived from the driver
      // cap so the DTO can't drift. Inserted after cacheImport (additive-only ordering — see #capabilitiesDto).
      // Also firmware-gated per model (FULL_CAPTURE_MAX_VERIFIED_FW; unknown firmware = false): detect()
      // populates #firmware before any caps DTO is served, so the UI never offers a mode the build route
      // would refuse. (The build route re-reads the firmware itself right before gating.)
      fullCapture: c.fullCapture && fullCaptureAllowedOnFirmware(mid, this.#firmware),
      // In-app diagnostic capture (POST /diagnostics/capture): gen-3 units with the self-describe walk.
      // Inserted after fullCapture (additive-only ordering).
      diagnosticCapture: diagnosticCaptureSupported(mid, c),
      editorLayouts: c.editorLayouts,
      firmwareValidate: !!d.validateFirmware,
      // Cross-device preset conversion (POST /preset/convert with no source): the current preset can be
      // dumped + lifted into the converter IR. Derived from DriverCapabilities so the DTO can't drift.
      presetConvert: c.presetConvert,
      backupDump: !!d.backupPreset,
      restoreDump: !!d.restorePreset,
      versionStore: !!d.dumpRaw && !!d.loadPresetBytes,
      deviceParams: !!d.setParamByKey,
      virtualEffects: grid ? GEN3_VIRTUAL_EFFECTS : [],
      // The block-params response carries `blockState` (Scene Ignore + Bypass Mode, tagged from the codec's
      // per-model catalog lookup; written through the ordinary enum write). Gen-3 III / FM3 / FM9 only.
      // Appended last (additive-only ordering).
      blockState: !!c.blockState,
      // Read-only block visuals: `visuals` on GET /preset/blocks/:eid/params + `graphKey` on the served
      // layout's graph slots. Derived from the driver cap AND the route method so the DTO can't drift.
      // Appended last (additive-only ordering — see #capabilitiesDto).
      blockVisuals: !!c.blockVisuals && !!d.blockParams
    };
  }

  /** The capabilities object /device and /device/detect serve: the curated descriptor subset
   *  (unchanged keys, byte-compatible) with the Phase-6 extended matrix merged in BEFORE
   *  `supportsSave`, so a pretty-printed JSON diff against the pre-Phase-6 sweep stays
   *  additive-only (appending after the last key would rewrite its comma line). */
  #capabilitiesDto(mid: number): Record<string, unknown> | null {
    const c = DESCRIPTOR_BY_MODEL[mid]?.capabilities as Record<string, unknown> | undefined;
    if (!c) return null;
    // curated subset (drop the RegExp preset_location_format — not JSON-clean, not needed by the UI)
    return {
      slotModel: c.slot_model, slotCount: c.slot_count, grid: c.grid,
      hasScenes: !!c.has_scenes, sceneCount: c.scene_count ?? 0,
      hasChannels: !!c.has_channels, channelNames: c.channel_names ?? [], channelBlocks: c.channel_blocks ?? [],
      ...(this.#extendedCaps(mid) ?? {}),
      // Registry-level cadence-mode control (GET/PUT /telemetry/config) — advertised on every device so
      // Axis can surface the control unconditionally. Placed before supportsSave so the pretty-printed
      // caps diff stays additive-only (see #capabilitiesDto's ordering contract).
      telemetryControl: true,
      supportsSave: !!c.supports_save
    };
  }

  async deviceInfo() {
    await this.#ready(); // ensure detection ran so #modelId reflects the ACTUAL attached unit
    // Report the DETECTED model id/byte (the provisional gen-3 profile can't identify an AM4) so
    // consumers (e.g. the library) can tell what is actually attached.
    const mid = this.#modelId >= 0 ? this.#modelId : this.#prof.model;
    const m = DEVICE_MODELS[mid];
    // apiVersion mirrors /healthz's api.version — the unified-API handshake (placed mid-object so
    // the route-sweep diff stays additive-only).
    return { model: m?.name ?? this.#prof.name, modelByte: `0x${mid.toString(16)}`, modelId: mid, apiVersion: 2, capabilities: this.#capabilitiesDto(mid), firmware: this.#firmware ? { version: this.#firmware.version, build: this.#firmware.build } : (null as null | { version: string; build: string }), port: this.port };
  }

  /** Ensure the active driver matches the attached unit — runs detect once, lazily, so direct API
   * use (not just the Axis client) still adapts to an FM9 vs FM3 without an explicit detect call. */
  async #ready() {
    if (this.#detected) return;
    this.#detected = true;
    try {
      await this.detect();
    } catch {
      /* keep the default/env profile if detection fails */
    }
  }

  /** Auto-detect the connected Fractal unit. Broadcasts the fn 0x00 handshake to the wildcard
   * model 0x7F; the device replies with its own header, whose model byte (f[4]) identifies it.
   * Lets clients auto-connect and know whether a live codec exists for what's attached. */
  async detect(): Promise<{ connected: boolean; modelId: number; name: string; short: string; gen: number; supported: boolean; capabilities: Record<string, unknown> | null; port: string | null }> {
    // Gate on a connection resolvable over ANY transport — serial CDC (FM3) OR USB-MIDI (Axe-Fx III /
    // FM9). The old guard used the serial-only `this.port`, which is null for a MIDI-only unit, so the
    // handshake was skipped and the profile stayed on the default model byte — the Windows Axe-Fx III
    // "device offline" bug (macOS worked only because the III also exposes a serial node there).
    const conn = await this.#deps.resolveConn();
    if (!conn) return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, capabilities: null, port: null };
    // Forced profile (Axis "Connection & Device" override): trust the chosen model, skip the handshake.
    // This is the MIDI-DIN→USB-adapter case — a generic MIDI interface into an FM3 won't answer the 0x7F
    // broadcast or carry a Fractal port name, so auto-detect can't ID it. We still open the transport (so a
    // dead port is visible) but never let a silent handshake downgrade the user's explicit choice.
    const forced = this.#deps.getProfileOverride();
    if (forced) {
      const modelId = this.#forcedModelId(forced);
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p; // gen-3; AM4 keeps the provisional profile but reports 0x15 below
      this.#modelId = modelId;
      this.#detected = true;
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      await this.#afterActivate(modelId); // firmware populate + runtime-cache profile swap (best-effort)
      let port: string | null = null;
      try { await this.transport(); port = this.#transport?.label ?? conn.id; } catch { /* dead port — report best-effort */ }
      const m = DEVICE_MODELS[modelId];
      console.log(`[forgefx] detect: FORCED profile '${forced}' → model 0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake skipped)`);
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.#capabilitiesDto(modelId),
        port: port ?? conn.id
      };
    }
    try {
      const dev = await this.transport();
      const port = this.#transport?.label ?? conn.id;
      // Any Fractal-headed frame identifies the unit (its model byte is all detection needs), so the matcher is
      // deliberately broad: this is the first exchange on a freshly opened link, and whichever Fractal frame
      // arrives first names the same device.
      const frames = await dev.request(buildIdentifyBroadcast(), { timeoutMs: 1500, quietMs: 60, match: (fs) => fs.some((f) => isFractalHeaderFrame(f)) });
      const f = frames.find((x) => isFractalHeaderFrame(x));
      let modelId = f ? parseIdentifyResponse(f)!.modelId : -1;
      // MIDI fallback: USB-MIDI Fractal units (Axe-Fx III on Windows, which has no serial node) may not
      // answer the 0x7F broadcast — infer the model from the port name so the profile still switches.
      if (modelId < 0 && conn.transport === 'midi') {
        const inferred = modelFromPortName(conn.inId ?? conn.id);
        if (inferred != null) modelId = inferred;
      }
      console.log(`[forgefx] detect: transport=${conn.transport} frames=${frames.length} modelId=0x${modelId >= 0 ? modelId.toString(16) : '?'} (handshake=${f ? 'reply' : 'silent'})`);
      const m = DEVICE_MODELS[modelId];
      // adopt the detected unit's profile so all reads/writes use its model byte, grid + ranges
      // (profileForModel falls back to FM3, so only switch when there's a real profile for this model)
      const p = profileForModel(modelId);
      if (p.model === modelId) this.#prof = p;
      this.#modelId = modelId;
      this.#detected = true;
      this.#activate(modelId >= 0 ? this.#driverFor(modelId) : null);
      await this.#afterActivate(modelId); // firmware populate + runtime-cache profile swap (best-effort)
      // Report what actually handles the unit — the ACTIVE DRIVER, not the vestigial gen-3 `#prof`. A
      // non-gen-3 unit (the AM4) has a real driver (its own codec + capabilities) even though `#prof`
      // keeps its FM3 default; logging "profile fm3 kept default" for an AM4 reads as a detection failure
      // when detection in fact succeeded. Only genuinely unhandled models fall through to the profile note.
      const drv = this.#active;
      if (drv) {
        const c = drv.capabilities;
        const shape = c.slotModel === 'grid' && c.grid ? `${c.grid.rows}x${c.grid.cols} grid` : `${c.slotCount ?? '?'} linear slots`;
        console.log(`[forgefx] active driver: ${drv.key} (model 0x${modelId.toString(16)}, ${shape}) — ${p.model === modelId ? 'gen-3 profile adopted' : 'own codec (no gen-3 profile, as expected)'}`);
      } else {
        console.log(`[forgefx] no driver for 0x${modelId >= 0 ? modelId.toString(16) : '?'} — kept default profile ${this.#prof.key} (0x${this.#prof.model.toString(16)})`);
      }
      return {
        connected: modelId >= 0,
        modelId,
        name: m?.name ?? (modelId >= 0 ? `Unknown (0x${modelId.toString(16).padStart(2, '0')})` : 'No device'),
        short: m?.short ?? (modelId >= 0 ? `0x${modelId.toString(16)}` : '—'),
        gen: m?.gen ?? 0,
        supported: !!m?.codec,
        capabilities: this.#capabilitiesDto(modelId),
        port
      };
    } catch {
      return { connected: false, modelId: -1, name: 'No device', short: '—', gen: 0, supported: false, capabilities: null, port: this.#transport?.label ?? conn.id };
    }
  }

  /** Swap the active driver and re-gate the telemetry supervisor on its capabilities (a device
   *  without gen-3 telemetry — the AM4 — must never receive gen-3 polls). */
  #activate(d: DeviceDriver | null) {
    this.#active = d;
    d?.resetSession?.(); // a (re)detect starts a new session: forget what the driver learned about the last one
    if (d && !d.capabilities.telemetry.outputMeters) this.#stopMeters();
    if (d && !d.capabilities.telemetry.tuner && this.#tunerTimer) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; }
    // Device-edit watch is capability-gated (deviceEditWatch = AM4 + FM3, which don't push): stop it on a device that doesn't need it,
    // start it on one that does when a listener is already connected (detect() can activate after subscribe).
    if (d && !d.capabilities.deviceEditWatch) this.#stopEditWatch();
    else if (d && d.capabilities.deviceEditWatch && this.#subscribers.size > 0) this.#startEditWatch();
    // Device-edit push (gen-3): (re)attach the RX listener now that detect() has opened the transport +
    // picked the driver, or drop it on a device that doesn't push.
    if (d && !d.capabilities.deviceEditPush) this.#stopEditPush();
    else if (d && d.capabilities.deviceEditPush && this.#subscribers.size > 0) this.#startEditPush();
  }

  /** Post-activation best-effort work, run inside detect() after the driver is chosen: populate the
   *  running firmware (gen-3 fn 0x08) then, if a device cache exists for this model+firmware, swap the
   *  driver's static profile for the device-true runtime one. Both are wrapped so neither can fail
   *  detection — silence/timeout/no-cache simply leave the static behavior in place. */
  async #afterActivate(modelId: number): Promise<void> {
    await this.#populateFirmware(modelId);
    await this.applyRuntimeCache();
  }

  /** Best-effort firmware-version read (fn 0x08) over the shared transport — gen-3 only (the query is
   *  HW-verified on the FM3, shared on FM9/III; AM4/gen1/gen2 are never queried). Always clears the
   *  previous value first, so silence/timeout, a non-gen-3 model, a reply whose model byte is not the
   *  connected model, or a major of 0 all leave `#firmware` null (= unknown) instead of a stale version;
   *  never throws (detection must not depend on it). The store-ack scope and the device-cache key
   *  both read it; while the read is in flight the value is null, which consumers treat as "unknown". */
  async #populateFirmware(modelId: number): Promise<void> {
    this.#firmware = null;
    if (modelId < 0 || DEVICE_MODELS[modelId]?.gen !== 3) return;
    try {
      const dev = await this.transport();
      const frames = await dev.request(buildFirmwareVersionQuery(modelId), {
        timeoutMs: 800,
        quietMs: 40,
        // same predicate as the extraction below (connected model only), so a stray 0x08 from elsewhere neither
        // completes the read nor gets parsed
        match: (fs) => fs.some((f) => isFractalHeaderFrame(f) && f[5] === FN_FIRMWARE_VERSION && f[4] === modelId)
      });
      // only a reply from the CONNECTED model counts (f[4] = model byte); a major of 0 is no real version
      const f = frames.find((x) => isFractalHeaderFrame(x) && x[5] === FN_FIRMWARE_VERSION && x[4] === modelId);
      const v = f ? parseFirmwareVersionReply(f) : null;
      if (v && v.major > 0) this.#firmware = { major: v.major, minor: v.minor, version: formatFirmwareVersion(v.major, v.minor), build: v.build ?? '' };
    } catch {
      /* silence / timeout / dead port → firmware stays null */
    }
  }

  /** Swap the active driver's profile for a device-cache-derived RUNTIME profile when a cache doc
   *  exists for the attached model+firmware. Called on a fresh detect AND by the deviceCache service
   *  after a build completes. No-op without a loadDeviceCache hook, a selfDescribe driver, known
   *  firmware, or a stored cache this build may use (a profile with a missing/outdated/newer schema
   *  is never applied — the static profile stays). Never throws. */
  async applyRuntimeCache(): Promise<void> {
    if (!this.#deps.loadDeviceCache) return;
    const d = this.#active;
    const mid = this.#modelId;
    if (mid < 0 || !d || !d.capabilities.selfDescribe || !d.applyRuntimeProfile || !this.#firmware) return;
    const key = deviceCacheKey(mid, this.#firmware.major, this.#firmware.minor);
    let built: BuiltCache | null = null;
    try { built = (await this.#deps.loadDeviceCache(key)) ?? null; } catch { built = null; }
    if (!built || !checkProfileSchema(built).usable) return; // absent, or stale (see profileSchema.ts): keep the static profile
    const runtime = runtimeProfileFrom(built, PROFILES[mid] ?? this.#prof);
    d.applyRuntimeProfile(runtime);
    if (PROFILES[mid]) this.#prof = runtime; // keep /diag + reporting profile in sync for gen-3
  }

  /** Pause the telemetry supervisor for the duration of an exclusive operation (the device-cache
   *  self-describe walk and the diagnostic capture saturate the port, and the capture records the wire).
   *  Stops the tuner / meters / edit-watch / edit-push and HOLDS them off until the returned resume fn
   *  runs: while held, nothing restarts them — not a new SSE subscriber, not a re-activated driver, not
   *  the tuner switched on (its poll waits for the resume). The last resume restarts what was running
   *  plus whatever the listeners present by then need. The resume fn is idempotent. */
  pauseTelemetry(): () => void {
    this.#telemetryHolds++;
    const held = this.#heldLoops;
    if (this.#tunerTimer) { held.tuner = true; clearTimeout(this.#tunerTimer); this.#tunerTimer = null; }
    if (this.#metersTimer) held.meters = true;
    if (this.#editWatchTimer) held.editWatch = true;
    if (this.#editPushUnsub) held.editPush = true;
    this.#stopMeters();
    this.#stopEditWatch();
    this.#stopEditPush();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.#telemetryHolds = Math.max(0, this.#telemetryHolds - 1);
      if (this.#telemetryHolds > 0) return; // another exclusive operation still holds the supervisor
      const h = this.#heldLoops;
      this.#heldLoops = { tuner: false, meters: false, editWatch: false, editPush: false };
      const listening = this.#subscribers.size > 0;
      if (h.meters || listening) this.#startMeters();
      if (h.editWatch || listening) this.#startEditWatch();
      if (h.editPush || listening) this.#startEditPush();
      // the tuner page is still open (only its poll was held) — just restart the poll timer.
      if ((h.tuner || this.#tunerPending) && this.#tunerDriver && !this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
      this.#tunerPending = false;
    };
  }
  /** Exclusive operations currently holding the supervisor (see pauseTelemetry). */
  #telemetryHolds = 0;
  /** The loops that were running when the first hold began (restarted by the last resume). */
  #heldLoops = { tuner: false, meters: false, editWatch: false, editPush: false };
  /** The tuner was switched on while held: its poll starts on the last resume. */
  #tunerPending = false;

  /** DEBUG probe: send ONE raw read-only SysEx frame, return every response frame as hex. The probe
   *  policy (sendPolicy.ts) is enforced HERE, before the transport is opened or written: only a
   *  read/query frame for a known model, or — on a connected gen-3 unit — a frame byte-identical to a
   *  codec read/poll builder for that model (tuner/CPU/meter polls, tempo/scene GET, raw param-value
   *  GET 0x1B as used by the FC read-back); anything else throws a 400/403 SendRejectedError. */
  async rawRequest(bytes: number[]): Promise<string[]> {
    assertRawProbeAllowed(bytes, this.#modelId);
    const dev = await this.transport();
    // Debug probe, deliberately accept-anything: the probe exists to show WHATEVER the device answers to an
    // arbitrary read frame, so the first frame completes it (a late frame from an earlier request can too —
    // it is shown as hex, never interpreted).
    const frames = await dev.request(bytes, { timeoutMs: 1200, quietMs: 120, match: (fs: number[][]) => fs.length > 0 });
    return frames.map((f) => f.map((b) => b.toString(16).padStart(2, '0')).join(''));
  }

  // ── telemetry supervisor: tuner / output meters / CPU ──
  // Timers live HERE, not in the drivers: they run only while (a) a driver whose capabilities allow the
  // poll is active — or, for the tuner, the driver setTuner() was invoked with — and (b) for the meters,
  // ≥1 SSE subscriber is listening. All cadence + smoothing constants moved verbatim from the old Device.
  #tunerTimer: ReturnType<typeof setTimeout> | null = null;
  // The driver the tuner was opened against (setTuner ran driver()) — polls use ITS model byte.
  #tunerDriver: DeviceDriver | null = null;
  #metersTimer: ReturnType<typeof setTimeout> | null = null;
  // Smoothed output-meter levels in dB (−40…0). Values come from the Preset Leveling poll (fn 0x19),
  // decoded from a 5-septet float (RMS energy). They're instantaneous (drop to −40 between transients),
  // so we run an asymmetric envelope follower (fast attack / slow release) for a natural meter feel.
  #mDb = [-40, -40, -40, -40]; // [out1L, out1R, out2L, out2R]
  #meterStep = 0; // round-robin index over the 4 meters (+ a CPU read) — one small read per tick
  #lastMeterTs = 0; // wall-clock of the last meter smoothing pass — the envelope follower scales by actual dt
  #lastSceneIdx: number | null = null; // last device-reported scene — front-panel scene-change watch
  #lastChannels: Map<number, number> | null = null; // last device-reported active channel per eid — channel-change watch
  static METER_FLOOR = -40; // display floor (matches FM3-Edit's Preset Leveling page)
  static METER_CEIL = 6; // meters run above 0 dB into clip (live-verified peaks to +5.8 dB)
  // Envelope-follower gap fractions, CALIBRATED FOR A 60 ms TICK (the historical meter cadence).
  // #meterFactor() rescales them to the actual elapsed dt so the ballistics hold at 100/400 ms ticks
  // (balanced/reduced) instead of getting sluggish.
  static METER_ATTACK = 0.7; // fraction of the gap closed when the level rises (snappy) @ 60 ms
  static METER_RELEASE = 0.35; // …when it falls (natural meter fall-off) @ 60 ms
  /** Rescale a 60 ms-calibrated envelope fraction to the actual elapsed dt (exponential time-constant),
   *  so meters keep their attack/release feel at any meter tick cadence. Clamped to a sane dt window. */
  static #meterFactor(base60: number, dtMs: number): number {
    const scale = Math.min(8, Math.max(0.25, dtMs / 60));
    return 1 - Math.pow(1 - base60, scale);
  }

  // Tuner: FM3-Edit opens the tuner page (fn 0x12 sub 0x1e) then POLLS fn 0x01 sub 0x19 field 0x02,
  // whose value field (float32 @ off 12) is the detected fundamental in Hz. We replicate that and
  // stream note/cents over SSE. (Reverse-engineered from an FM3-Edit capture.)
  async #pollTuner() {
    if (!this.#tunerTimer) return;
    const d = this.#tunerDriver;
    if (!d || !d.capabilities.telemetry.tuner) { clearTimeout(this.#tunerTimer); this.#tunerTimer = null; return; } // no tuner on this device
    // Drivers whose tuner isn't a gen-3 tuner-page poll (AM4 polls block 0x0023) resolve a full
    // reading themselves via readTuner(); everyone else uses the built-in gen-3 fn 0x01 poll.
    try {
      await this.#supervised(async () => {
        if (d.readTuner) {
          const r = await d.readTuner();
          if (r) this.#emit({ type: 'tuner', freq: Math.round(r.freq * 100) / 100, note: r.note, octave: r.octave, cents: r.cents });
        } else {
          const dev = await this.transport();
          const frames = await dev.request(buildTunerPoll(d.modelId), {
            timeoutMs: 300,
            quietMs: 35,
            routine: true,
            match: (fs) => fs.some((f) => isTunerResponse(f))
          });
          const f = frames.find((x) => isTunerResponse(x));
          if (f) {
            const freq = parseTunerFreqHz(f);
            this.#emit({ type: 'tuner', freq: Math.round(freq * 100) / 100, ...(freqToNote(freq) ?? {}) });
          }
        }
      });
    } catch {
      /* transient — keep polling */
    }
    // Cadence is family-fixed + mode-independent (gen-3 55 ms; AM4's four short reads → 100 ms), resolved
    // at reschedule time so it tracks the detected model.
    if (this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), this.#cadence().tunerMs);
  }

  async setTuner(on: boolean) {
    const d = await this.driver();
    if (!d.capabilities.telemetry.tuner) return { ok: false }; // no tuner on this device
    const dev = await this.transport();
    if (on) {
      this.#tunerDriver = d;
      // Gen-3 opens/closes a device tuner PAGE; AM4's tuner block (0x0023) is always live, so a
      // readTuner driver skips the page open/close and just runs the poll timer.
      if (!d.readTuner) await dev.sendQueued(buildTunerPageOpen(d.modelId)); // open the tuner page
      if (this.#telemetryHolds > 0) this.#tunerPending = true; // an exclusive operation runs: poll after it
      else if (!this.#tunerTimer) this.#tunerTimer = setTimeout(() => this.#pollTuner(), 30);
    } else {
      this.#tunerPending = false;
      if (this.#tunerTimer) {
        clearTimeout(this.#tunerTimer);
        this.#tunerTimer = null;
      }
      if (!d.readTuner) await dev.sendQueued(buildTunerPageClose(d.modelId)); // leave tuner page (back to layout)
    }
    return { ok: true };
  }

  // Live output meters + CPU. Reverse-engineered from FM3-Edit's Preset Leveling page (see
  // fm3-scratchpad findings/live-capture-2026-07.md):
  //   METERS — fn 0x01 sub 0x19, round-robin over Output 1/2 × L/R (addr 0x2A/0x2B, sub 0x10/0x11).
  //     Reply bytes[12..16] = 5-septet-LE float32 = RMS energy → dB = 10·log10(v), floor −40. The REAL,
  //     calibrated meters (matched the live readout to ~1 dB). 0x2E bytes 35/36 saturate → not used.
  //   CPU — fn 0x01 sub 0x2E, byte 37 = block DSP load → CPU% ≈ CPU_BASE + byte37·CPU_SLOPE. That's a
  //     590-byte frame, so we read it only once per round-robin cycle (meters are tiny 23-byte reads).
  // Runs while ≥1 SSE client is subscribed AND the active driver's telemetry capability allows it.
  #startMeters() {
    if (this.#metersTimer || this.#telemetryHolds > 0) return; // held by an exclusive operation (pauseTelemetry)
    if (this.#active && !this.#active.capabilities.telemetry.outputMeters) return; // no gen-3 meter frames on this device
    this.#metersTimer = setTimeout(() => this.#pollMeters(), this.#cadence().meterTickMs); // primer at the mode's meter tick
  }
  #stopMeters() {
    if (this.#metersTimer) clearTimeout(this.#metersTimer);
    this.#metersTimer = null;
  }
  async #pollMeters() {
    if (!this.#metersTimer) return;
    // Wait until a driver is ACTIVE (positively identified) before poking the unit — the SSE
    // subscription can start the meter poll before detect() runs, and we must not fire gen-3 frames at
    // an as-yet-unknown device (e.g. an auto-detected AM4). Once detect() activates a driver we either
    // proceed (its capabilities allow) or stop (they don't).
    const d = this.#active;
    if (!d) {
      this.#metersTimer = setTimeout(() => this.#pollMeters(), 300);
      return;
    }
    if (!d.capabilities.telemetry.outputMeters) { this.#stopMeters(); return; }
    // Resolve the CURRENT-mode cadence once per tick (a mode switch applies from the next reschedule).
    const cad = this.#cadence();
    // YIELD (FORGEFX-28): while a route-driven request is in flight (or queued behind one), SKIP this
    // tick's device I/O but keep the cadence — so a live edit never waits behind the meter round-robin.
    // A starvation guard forces the poll through after MAX_SKIPS consecutive skips so the front-panel
    // scene/channel watches never fully starve under sustained UI traffic.
    if (this.#interactiveInFlight() > 0 && this.#meterSkips < DeviceRegistry.MAX_SKIPS) {
      this.#meterSkips++;
      if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), this.#linkSlow ? cad.meterSlowMs : cad.meterTickMs);
      return;
    }
    this.#meterSkips = 0;
    let slow = false;
    const step = this.#meterStep++; // advance once per tick; the every-Nth gates + #pollReflection read this snapshot
    try {
      const dev = await this.transport();
      // A slow link — a generic MIDI interface into 5-pin DIN (≈31.25 kbaud) — can't carry meter polling
      // without inflating every other request to seconds, so SKIP it there (a cheap re-check resumes it
      // instantly on a fast link). Fast USB-MIDI (Axe-Fx III / FM9) and USB-CDC serial are NOT slow.
      slow = this.#linkSlow = dev.slow;
      if (!slow) await this.#supervised(async () => {
        // Envelope-follower dt: keep the meter ballistics constant in wall-clock terms across the
        // per-mode tick cadences (60/100/400 ms) by scaling the 60 ms-calibrated fractions to elapsed dt.
        const now = Date.now();
        const dt = this.#lastMeterTs ? now - this.#lastMeterTs : cad.meterTickMs;
        this.#lastMeterTs = now;
        const aUp = DeviceRegistry.#meterFactor(DeviceRegistry.METER_ATTACK, dt);
        const aDn = DeviceRegistry.#meterFactor(DeviceRegistry.METER_RELEASE, dt);
        // Read ALL 4 output meters back-to-back each tick (tiny 23-byte reads — this is exactly what
        // FM3-Edit's leveling page does; NOT the many-block sweep that stutters audio) so every bar
        // refreshes every tick, not once per round-robin → smooth, not choppy.
        for (let i = 0; i < 4; i++) {
          const meter = GEN3_OUTPUT_METERS[i]!;
          const frames = await dev.request(buildOutputMeterPoll(meter, d.modelId), { timeoutMs: 200, quietMs: 12, routine: true, match: (fs) => fs.some((f) => isOutputMeterResponse(f, meter)) });
          const f = frames.find((x) => isOutputMeterResponse(x, meter));
          if (f) {
            const raw = meterRmsToDb(parseOutputMeterRms(f), DeviceRegistry.METER_FLOOR, DeviceRegistry.METER_CEIL);
            const prev = this.#mDb[i]!;
            const a = raw > prev ? aUp : aDn;
            this.#mDb[i] = prev + a * (raw - prev);
          }
        }
        this.#emit({ type: 'meters', out1L: this.#mDb[0]!, out1R: this.#mDb[1]!, out2L: this.#mDb[2]!, out2R: this.#mDb[3]! });
        // CPU is a heavy 590-byte read → poll it only occasionally (every Nth tick), off the meter path.
        if (step % cad.cpuEveryNTicks === 0) {
          const frames = await dev.request(buildCpuPoll(d.modelId), { timeoutMs: 400, quietMs: 25, routine: true, match: (fs) => fs.some((f) => isCpuResponse(f)) });
          const f = frames.find((x) => isCpuResponse(x));
          if (f) this.#emit({ type: 'cpu', percent: cpuPercentFromRaw(parseCpuRawLoad(f)) });
        }
      });
      // The cheap scene/channel reflection watches run on BOTH link speeds — on a slow link each
      // tick is already the throttle (meterSlowMs), so wrapping them in the meter `if (!slow)` and
      // disabling ALL device→UI reflection was wrong. The METERS above stay skipped on a slow link.
      await this.#supervised(() => this.#pollReflection(step, cad, !slow));
    } catch {
      /* transient — keep polling */
    }
    // reschedule at the mode's meter tick (or the slow-link cadence)
    if (this.#metersTimer) this.#metersTimer = setTimeout(() => this.#pollMeters(), slow ? cad.meterSlowMs : cad.meterTickMs);
  }

  /** Front-panel SCENE + active-CHANNEL watches. Run on EVERY tick regardless of link speed —
   *  gated by the every-Nth divider on a fast link, but on a slow link each (meterSlowMs) tick already
   *  IS the throttle. First read only primes the baseline (no event). Kept out of the meter `if (!slow)`
   *  so a 5-pin-DIN link still reflects scene/channel changes even though its meters are skipped. */
  async #pollReflection(step: number, cad: CadenceProfile, gated: boolean): Promise<void> {
    const d = this.#active;
    if (!d) return;
    // SCENE-change watch: gen-3 devices emit NO unsolicited frame on a scene switch (FM3 field report
    // 2026-07-06 — the panel changed, Axis didn't follow), so poll the tiny fn 0x0C scene GET. Emits the
    // SAME `scene` event the setScene write path emits, so clients need no new wiring.
    // Runs BEFORE the channel watch: on a slow link both watches run every tick, and a front-panel scene
    // change also moves the per-block active channels. The `scene` event re-primes the channel baseline
    // (see #emit), so the channel watch below then adopts the new channels silently instead of emitting a
    // `blockState` for them just ahead of the `scene`.
    if ((!gated || step % cad.sceneEveryNTicks === 4) && d.getScene) {
      const { index } = await d.getScene();
      if (Number.isInteger(index) && index >= 0) {
        if (this.#lastSceneIdx !== null && index !== this.#lastSceneIdx) this.#emit({ type: 'scene', index });
        this.#lastSceneIdx = index;
      }
    }
    // CHANNEL-change watch: a device-side amp/block A–D switch emits no unsolicited frame and moves no
    // param value (only the active-channel pointer), so the edit-burst diff can't see it — the amp TYPE
    // NAME is per-channel, so Axis showed the old channel's model. Poll the tiny fn 0x13 status dump and
    // emit `blockState` on any block's active-channel delta → Axis re-reads only live scene/block state.
    if ((!gated || step % cad.channelEveryNTicks === 2) && d.getActiveChannels) {
      const chans = await d.getActiveChannels();
      if (chans.size > 0) {
        let moved = false;
        if (this.#lastChannels) {
          for (const [eid, ch] of chans) {
            if (this.#lastChannels.get(eid) !== ch) { moved = true; break; }
          }
        }
        if (moved) this.#emit({ type: 'blockState' });
        this.#lastChannels = chans;
      }
    }
  }

  // ── device-edit watch (poll): catch front-panel edits on devices that DON'T push them (AM4 + FM3) ──
  // AM4 and FM3 emit no unsolicited frame on a front-panel knob turn (AM4 HW-107; FM3 tap-confirmed
  // 2026-07-04), so — while ≥1 SSE client listens and such a device is active — we poll the driver's
  // readDeviceEditState(): AM4 uses a device-true edited-bit + fn-0x1F content fingerprint (→ {changed}
  // → we emit `changed{scope:'preset'}`); FM3 re-reads the open block via fn-0x1F and emits per-param
  // `param` events itself (→ {changed:false}). Both suppress the app's own writes. Slow-link throttled.
  // (FM9 / Axe-Fx III DO push → they use the RX listener path instead; see #startEditPush.)
  #editWatchTimer: ReturnType<typeof setTimeout> | null = null;
  #startEditWatch() {
    if (this.#editWatchTimer || this.#telemetryHolds > 0) return; // held by an exclusive operation (pauseTelemetry)
    if (this.#active && !this.#active.capabilities.deviceEditWatch) return; // active device doesn't need it
    this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), this.#cadence().editWatchMs);
  }
  #stopEditWatch() {
    if (this.#editWatchTimer) clearTimeout(this.#editWatchTimer);
    this.#editWatchTimer = null;
  }
  async #pollEditWatch() {
    if (!this.#editWatchTimer) return;
    const d = this.#active;
    // Wait for a positively-identified driver before poking the unit — subscribe() can start the watch
    // before detect() runs (mirrors #pollMeters' unknown-device guard).
    if (!d) { this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), 1000); return; }
    if (!d.capabilities.deviceEditWatch || !d.readDeviceEditState) { this.#stopEditWatch(); return; }
    const cad = this.#cadence();
    // YIELD (FORGEFX-28): skip this tick's poll (keep the cadence) while a route-driven request is in
    // flight, with the same MAX_SKIPS starvation guard as the meter loop.
    if (this.#interactiveInFlight() > 0 && this.#editWatchSkips < DeviceRegistry.MAX_SKIPS) {
      this.#editWatchSkips++;
      if (this.#editWatchTimer) this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), this.#linkSlow ? cad.editWatchSlowMs : cad.editWatchMs);
      return;
    }
    this.#editWatchSkips = 0;
    let slow = false;
    try {
      const dev = await this.transport();
      slow = this.#linkSlow = dev.slow; // a generic 5-pin DIN adapter throttles the poll (reschedule below) — but it
      //                  STILL runs; skipping it entirely left a slow link with no FM3 edit reflection at all.
      await this.#supervised(async () => {
        const r = await d.readDeviceEditState!();
        if (r.changed) this.#emit({ type: 'changed', scope: 'preset' });
      });
    } catch {
      /* transient — keep polling */
    }
    if (this.#editWatchTimer) this.#editWatchTimer = setTimeout(() => this.#pollEditWatch(), slow ? cad.editWatchSlowMs : cad.editWatchMs);
  }

  // ── gen-3 device-edit PUSH: reflect front-panel / editor edits the unit broadcasts unsolicited ──
  // Unlike the AM4 (which pushes nothing → we poll), gen-3 devices emit an unsolicited 0x74/0x75/0x76
  // state-broadcast burst on a front-panel param edit. We keep ONE persistent onFrame listener (the
  // transport dispatches every inbound frame to all handlers — additive, coexists with request()'s
  // temporary waiters) that reassembles an unsolicited burst and asks the driver to decode it into
  // per-param `param` events. ECHO GUARD: the ONLY server-issued source of a 0x74 burst is our own
  // fn-0x1F BULK-READ poll (blockParams / meters sweep / cab / monitors) — so if a fn-0x1F read is in
  // flight the burst is that reply (its request() waiter consumes it) and we skip it; otherwise it's a
  // genuine front-panel edit. Crucially this counts ONLY fn-0x1F reads: gen-3 also runs a 60ms OUTPUT-
  // meter poll (fn 0x19) + tempo/scene/writes, none of which elicit a 0x74 burst — gating on those would
  // wrongly drop a front-panel edit that lands during the meter poll (the bug that broke gen-3 sync).
  #pendingBulkReads = 0;
  #editPushUnsub: (() => void) | null = null;
  #burst: number[][] | null = null;
  #burstTimer: ReturnType<typeof setTimeout> | null = null;

  // ── traffic counters (FORGEFX-27) + interactive-request tracking (FORGEFX-28) ──
  // Cumulative since the connection was instrumented; survive across reconnects (each new transport
  // re-instruments and keeps counting into the same totals). Emitted ~1×/s over SSE + folded into /diag.
  #traffic = { txMsgs: 0, txBytes: 0, rxMsgs: 0, rxBytes: 0 };
  #trafficSince = Date.now();
  // ALL requests currently awaiting a reply (route-driven AND supervisor polls); #supervisorInFlight is
  // the subset the telemetry supervisor itself issued (wrapped in #supervised). interactive = the
  // difference → the supervisor yields to genuine route traffic without counting its own polls (28).
  #inFlightRequests = 0;
  #supervisorInFlight = 0;

  /** Wrap a freshly-opened transport with: (1) the edit-push ECHO GUARD — each in-flight fn-0x1F
   *  bulk-read (bytes[5]===0x1f) bumps #pendingBulkReads so the edit-push listener drops our own poll
   *  replies; (2) TX traffic counting (and frame observing) on every outgoing frame, exactly once each
   *  (send/sendQueued/sendPaced/request — a request's own send() is not counted again);
   *  (3) ONE persistent onFrame handler for RX counting; (4) an all-requests in-flight counter for the
   *  interactive-yield logic. IDEMPOTENT per transport instance (a Symbol flag) so a re-wrap is a
   *  no-op — double-wrapping would double-count the echo guard and silently break edit reflection. */
  #instrumentTransport(t: Transport) {
    const inst = t as Transport & { [INSTRUMENTED]?: boolean };
    if (inst[INSTRUMENTED]) return; // already wrapped — never double-wrap (breaks the echo guard)
    inst[INSTRUMENTED] = true;

    const countTx = (bytes: readonly number[]) => {
      this.#traffic.txMsgs++;
      this.#traffic.txBytes += bytes.length;
      if (this.#frameObservers.size > 0) this.#observeFrame('TX', bytes);
    };

    // A frame handed to request()/sendQueued() is counted ONCE, when it is handed over. The serial and MIDI
    // transports put it on the wire later through their own send() — the wrapped one below, since their
    // queues call `this.send` — so the hand-over leaves a token per frame and the wrapped send consumes a
    // matching token instead of counting the frame again. A token the transport never consumed (it wrote to
    // its port another way, as the mocks do) is dropped when the call settles.
    const handedOver = new Map<string, { consumed: boolean }[]>();
    const keyOf = (bytes: readonly number[]) => bytes.join(',');
    const handOver = (bytes: readonly number[]): (() => void) => {
      countTx(bytes);
      const key = keyOf(bytes);
      const token = { consumed: false };
      const list = handedOver.get(key);
      if (list) list.push(token);
      else handedOver.set(key, [token]);
      return () => {
        if (token.consumed) return;
        const l = handedOver.get(key);
        const i = l ? l.indexOf(token) : -1;
        if (i >= 0) l!.splice(i, 1);
        if (l && l.length === 0) handedOver.delete(key);
      };
    };
    const consumeHandedOver = (bytes: readonly number[]): boolean => {
      if (handedOver.size === 0) return false;
      const key = keyOf(bytes);
      const l = handedOver.get(key);
      if (!l?.length) return false;
      l.shift()!.consumed = true;
      if (l.length === 0) handedOver.delete(key);
      return true;
    };

    const origRequest = t.request.bind(t);
    t.request = (bytes, opts) => {
      const settle = handOver(bytes);
      this.#inFlightRequests++;
      const bulk = bytes[5] === 0x1f; // only a bulk read can elicit a 0x74 burst → echo guard counts it
      if (bulk) this.#pendingBulkReads++;
      return origRequest(bytes, opts).catch((e: unknown) => { throw withTimeoutCode(e); }).finally(() => {
        settle();
        this.#inFlightRequests = Math.max(0, this.#inFlightRequests - 1);
        if (bulk) this.#pendingBulkReads = Math.max(0, this.#pendingBulkReads - 1);
      });
    };
    const origSend = t.send.bind(t);
    t.send = (bytes) => {
      if (!consumeHandedOver(bytes)) countTx(bytes); // a request's / queued send's own frame is counted already
      return origSend(bytes);
    };
    const origSendQueued = t.sendQueued.bind(t);
    t.sendQueued = (bytes, settleMs) => {
      const settle = handOver(bytes);
      return origSendQueued(bytes, settleMs).finally(settle);
    };
    if (t.sendPaced) {
      const origSendPaced = t.sendPaced.bind(t);
      t.sendPaced = (bytes, chunk, delayMs) => { countTx(bytes); return origSendPaced(bytes, chunk, delayMs); };
    }
    // RX: one persistent handler for the transport's life (additive — coexists with request() waiters
    // and the edit-push listener, which register their own onFrame handlers).
    t.onFrame((frame) => {
      this.#traffic.rxMsgs++;
      this.#traffic.rxBytes += frame.length;
      if (this.#frameObservers.size > 0) this.#observeFrame('RX', frame);
    });
  }

  // ── frame observers (the diagnostic capture's wire log) ──
  // Every frame the instrumented transport sends (request/send/sendQueued/sendPaced, at the moment the
  // caller hands it over) or receives, while at least one observer is registered. Nothing is recorded
  // or copied without an observer, so this costs one size check per frame otherwise.
  #frameObservers = new Set<(dir: 'TX' | 'RX', bytes: readonly number[]) => void>();
  #observeFrame(dir: 'TX' | 'RX', bytes: readonly number[]): void {
    for (const fn of this.#frameObservers) {
      try { fn(dir, bytes); } catch { /* an observer must never break the link */ }
    }
  }
  /** Observe every frame on the device link (TX + RX) until the returned function is called. Used by the
   *  diagnostic capture to record the wire log of its run only; observers must not keep a reference to
   *  `bytes` (the transport may reuse it). */
  addFrameObserver(fn: (dir: 'TX' | 'RX', bytes: readonly number[]) => void): () => void {
    this.#frameObservers.add(fn);
    return () => { this.#frameObservers.delete(fn); };
  }

  /** Run a supervisor-issued device call while marking it so it doesn't register as INTERACTIVE traffic
   *  (both meters and edit-watch poll concurrently — without this, one loop's request would make the
   *  other yield). */
  async #supervised<T>(fn: () => Promise<T>): Promise<T> {
    this.#supervisorInFlight++;
    try { return await fn(); }
    finally { this.#supervisorInFlight = Math.max(0, this.#supervisorInFlight - 1); }
  }
  /** Route-driven (non-supervisor) requests currently in flight — the supervisor yields to these. */
  #interactiveInFlight(): number { return Math.max(0, this.#inFlightRequests - this.#supervisorInFlight); }

  // Consecutive skips per yielding loop — a starvation guard forces a poll after MAX_SKIPS so a busy
  // UI never fully starves the front-panel watches.
  static MAX_SKIPS = 3;
  #meterSkips = 0;
  #editWatchSkips = 0;
  // Last-known link speed of the open transport (set when it opens, refreshed every poll). The yield
  // back-off reschedules before a tick has read `dev.slow`, so it needs the speed remembered: on a slow
  // link a back-off at the fast tick would force the status + scene reads through after ~MAX_SKIPS fast
  // ticks of UI traffic instead of throttling at the slow cadence.
  #linkSlow = false;

  // ── traffic emitter: ~1×/s while ≥1 SSE client is listening; only emits when a counter moved ──
  #trafficTimer: ReturnType<typeof setInterval> | null = null;
  #lastTrafficEmit = { txMsgs: 0, txBytes: 0, rxMsgs: 0, rxBytes: 0 };
  #startTraffic() {
    if (this.#trafficTimer) return;
    this.#trafficTimer = setInterval(() => this.#emitTraffic(), 1000);
  }
  #stopTraffic() {
    if (this.#trafficTimer) clearInterval(this.#trafficTimer);
    this.#trafficTimer = null;
  }
  #emitTraffic() {
    const t = this.#traffic;
    const p = this.#lastTrafficEmit;
    if (t.txMsgs === p.txMsgs && t.txBytes === p.txBytes && t.rxMsgs === p.rxMsgs && t.rxBytes === p.rxBytes) return; // no change → stay quiet
    this.#lastTrafficEmit = { ...t };
    this.#emit({ type: 'traffic', ...t, since: this.#trafficSince, loops: this.#activeLoops() });
  }
  /** The currently-live supervisor loops, derived from which timers/listeners are active. */
  #activeLoops(): string[] {
    const l: string[] = [];
    if (this.#metersTimer) l.push('meters');
    if (this.#editWatchTimer) l.push('editWatch');
    if (this.#tunerTimer) l.push('tuner');
    if (this.#editPushUnsub) l.push('editPush');
    return l;
  }

  #startEditPush() {
    if (this.#editPushUnsub || this.#telemetryHolds > 0) return; // held by an exclusive operation (pauseTelemetry)
    const t = this.#transport;
    if (!t?.isOpen) return; // not connected yet — #activate re-attaches once detection opens the transport
    if (this.#active && !this.#active.capabilities.deviceEditPush) return; // active device doesn't push
    this.#editPushUnsub = t.onFrame((frame) => this.#onInboundFrame(frame));
  }
  #stopEditPush() {
    this.#editPushUnsub?.();
    this.#editPushUnsub = null;
    this.#resetBurst();
  }
  #resetBurst() {
    this.#burst = null;
    if (this.#burstTimer) { clearTimeout(this.#burstTimer); this.#burstTimer = null; }
  }
  #armBurstTimer() {
    if (this.#burstTimer) clearTimeout(this.#burstTimer);
    this.#burstTimer = setTimeout(() => this.#finalizeBurst(), 120); // flush even if the 0x76 end was lost
  }
  #onInboundFrame(frame: number[]) {
    const d = this.#active;
    if (!d?.capabilities.deviceEditPush || !d.decodeEditBurst) return;
    // Reply to our own fn-0x1F bulk-read — the request()'s own handler owns it; skip (+ drop any partial).
    if (this.#pendingBulkReads > 0) { this.#resetBurst(); return; }
    const fn = frame[5];
    if (fn === 0x74) { this.#burst = [frame]; this.#armBurstTimer(); return; } // burst head (new supersedes partial)
    if (!this.#burst) return; // stray body/end/other with no head we own
    if (fn === 0x75) { this.#burst.push(frame); this.#armBurstTimer(); return; } // body chunk
    if (fn === 0x76) { this.#burst.push(frame); this.#finalizeBurst(); return; } // end terminator
    this.#finalizeBurst(); // any other frame mid-burst → the burst ended, flush what we have
  }
  #finalizeBurst() {
    const frames = this.#burst;
    this.#resetBurst();
    const d = this.#active;
    if (!frames || frames.length === 0 || !d?.decodeEditBurst) return;
    let res: { events: { effectId: number; paramId: number; norm: number }[]; reload: boolean };
    try { res = d.decodeEditBurst(frames); } catch { return; }
    if (res.reload) { this.#emit({ type: 'changed', scope: 'grid' }); return; } // first sight → full reload
    for (const e of res.events) this.#emit({ type: 'param', effectId: e.effectId, paramId: e.paramId, norm: e.norm });
  }
}

/** Build a DeviceRegistry over the given deps — the server wires the real transports
 *  (drivers/registry.ts singleton), the mocked tests and a browser runtime their own. */
export function createRegistry(deps: RegistryDeps): DeviceRegistry {
  return new DeviceRegistry(deps);
}
