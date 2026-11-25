// Shared driver contract + the DTO shapes every route serves. The DTOs moved verbatim from the
// pre-driver Device/Am4Device modules — their JSON shapes are the HTTP contract Axis consumes and
// must not drift. `DeviceDriver` is the per-device surface the routes call; methods a device lacks
// are optional and mirrored by `DriverCapabilities` so routes can answer 501 instead of guessing.
import type { DecodedBlock, BlockVisual } from 'forgefx-midi/devices/gen3';
import type { TypeModel, DeviceLayout, DeviceProfile, ProfileSource } from '../devices.js';
import type {
  HiddenParam, NameConfidence, NameSource, ParamKind, ParamSource, ParamWidget, ReadOnlyReason, WidgetSource, WriteMode
} from './paramIndex.js';
import type { Transport } from '../transport/types.js';
import type { BlockMapEntry, CoverageGapKind, ProfileCoverage, RawSourceKind, SectionRole, SourceSummary } from 'forgefx-midi/cache';
import type { TelemetryMode, CadenceProfile } from './telemetryProfiles.js';
import type { WalkScopeGates } from '../services/walkScope.js';
import type { BlockMapState } from './blockMapState.js';

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
/** Why a param has no resolved value. A value that was invented (a zero for a position the read did not
 *  cover, a guessed channel) is never served as a reading: the generic response carries `null` and one of
 *  these, the classic response keeps its number and adds the reason. */
export type UnresolvedReason =
  /** The block read threw or timed out. */
  | 'read-failed'
  /** A channel-bearing block whose active channel the status read did not report. */
  | 'channel-unknown'
  /** The family's body is indexed by record, not by param id (GLOBAL): a position says nothing about a pid. */
  | 'non-positional'
  /** The param's position lies beyond the body that arrived (a torn or short burst). */
  | 'not-in-body'
  /** The raw value decodes outside the param's range (an enum ordinal outside its bounds, a float above full scale). */
  | 'out-of-range';
export type { HiddenParam, ParamWidget };

/** One continuous param of the classic response. `unresolved` is additive: set only on a value that was
 *  invented (the number is kept for compatibility). */
export interface NamedParam { id: number; name: string; value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean; unresolved?: UnresolvedReason; }
/** One selector param of the classic response. */
export interface EnumParam { id: number; name: string; value: number; options: { value: number; label: string }[]; unresolved?: UnresolvedReason; }

/** What the generic response says about every param besides its value. */
export interface ParamMeta {
  /** Device-true kind of the effective row. */
  kind: ParamKind;
  /** Where the existence and range facts came from: the applied device profile or the bundled catalog. */
  source: ParamSource;
  /** No name is known: the name is `P<pid>`. */
  generic: boolean;
  /** The bundled catalog has no informative row for this family and pid. */
  isNew?: true;
  /** Generic params only: `isNew` gives 'new-in-firmware', else 'more'. */
  pageHint?: 'new-in-firmware' | 'more';
  nameSource: NameSource;
  /** Absent on a generic param. */
  nameConfidence?: NameConfidence;
  /** `nameSource` 'catalog-moved': the catalog pid the name came from. */
  movedFrom?: number;
  /** Fingerprint of the effective row and labels ("1:xxxxxxxx"). */
  fp: string;
  widget: ParamWidget;
  widgetSource: WidgetSource;
  /** PUT body: `norm` = `{ value: 0..1, continuous: true }`, `ordinal` = `{ value: ordinal, continuous: false }`,
   *  null = no verified write path (advisory: the server does not refuse it). */
  write: WriteMode;
  readOnlyReason?: ReadOnlyReason;
  /** Display-unit step of a continuous param. */
  step?: number;
  unresolved?: UnresolvedReason;
}
/** Where a continuous param's display unit or taper came from: the applied device profile's row (`device`), the
 *  bundled catalog (its row, or the catalog unit code: `catalog`), or the row's typecode (`typecode`: the codec's
 *  typecode rules, used only where neither of the others says anything). */
export type ValueSource = 'device' | 'catalog' | 'typecode';
export interface NamedParamV2 extends Omit<NamedParam, 'value' | 'norm' | 'unresolved'>, ParamMeta {
  value: number | null;
  norm: number | null;
  /** Where `unit` came from; absent when the param has no unit. */
  unitSource?: ValueSource;
  /** Where the taper (`log`, or linear when absent) came from; absent when nothing names one (served linear). */
  taperSource?: ValueSource;
}
export interface EnumParamV2 extends Omit<EnumParam, 'value' | 'unresolved'>, ParamMeta {
  value: number | null;
  /** The option list was cut at the cap. */
  optionsTruncated?: true;
}

/** What the generic response says about the block as a whole. */
export interface BlockDefinitionsMeta {
  /** The catalog family the block resolved to; null for a block the device model has no family for. */
  family: string | null;
  /** What backs the family's rows: a byte-exact profile, a live-walk profile, or the bundled catalog alone
   *  (no profile applied, the family is not in it, or the family was flagged as mis-assigned). */
  profile: 'byte-exact' | 'live' | 'none';
  /** The family's cache section was dropped by the assignment cross-check. */
  suspect?: true;
  /** The family's values are read by position (param id = index in the channel slice). */
  positional: boolean;
  /** Active channel (0-3) the values were sliced from; null when unknown or the block has no channels. */
  channel: number | null;
  /** Writes to this block are persistent settings, not edit-buffer changes (GLOBAL, FC). */
  persistentWrites: boolean;
  /** Informative rows that are not listed, with the reason. */
  hidden: HiddenParam[];
  /** A block the catalog cannot place on its own (no catalog family, or a family the model's effect-id table only
   *  names from the roster): how it is bound to definitions on this device. Absent for every catalog block. */
  blockMap?: BlockMapMeta;
}

/** `definitions.blockMap` of the generic block params (see `blockMapState` for the state of a block-map confidence). */
export interface BlockMapMeta {
  /** `confirmed`: device records bind the block (generic or named params; writable only when byte-bridged);
   *  `likely`: a known but unconfirmed binding — an editor-cache section matched by the block's bulk read, or a
   *  family the effect-id table names from the roster only — served read-only; `candidates`: several sections fit,
   *  nothing is served; `none`: no information. */
  state: BlockMapState;
  /** The family the block is served under: a catalog family, `section:<tag>` or `block:<eid>`; null without one. */
  key: string | null;
  sectionTag: number | null;
  evidence: BlockMapEntry['evidence'];
  /** Section tags that fit equally (`candidates`). */
  candidates?: number[];
  /** Whether `POST /device/definitions/blocks/:eid/probe` would read this block now, and why not:
   *  `not-verified` = the block probe is not verified on the running firmware, `not-placed` = the block is not in the
   *  edit-buffer grid as last read. Absent reason with `available: false`: the block has a catalog (roster) family. */
  probe: { available: boolean; reason?: 'not-verified' | 'not-placed' | 'remote' | 'no-byte-source' };
}

/** `capabilities.definitions` of `GET /device` and `/device/detect`: what the generic block-params
 *  response can rely on for the attached unit. Served on every device; a client reads it, not the model. */
export interface DefinitionsCaps {
  /** `?generic=1` is understood (gen-3 grid drivers); false on drivers that ignore the flag. */
  genericParams: boolean;
  /** Firmware the bundled catalog was generated from (`"12.0"`), null when that is not settled or the
   *  device has no catalog. Formatted like the running firmware (`formatFirmwareVersion`). */
  catalogFirmware: string | null;
  /** The APPLIED runtime profile (provenance only, no rows), null while the bundled catalog is live. */
  profile: {
    /** Device-cache key the profile was loaded under (`<model-hex>_<major>p<minor>`). */
    key: string;
    source: ProfileSource;
    byteExact: boolean;
    /** Firmware the profile document says it describes, null when it carries none. */
    firmware: string | null;
    /** Families whose cache section looked mis-assigned and were not merged. */
    suspectFamilies: string[];
    /** Document format: 1 = derived tables only (legacy), 2 = raw sources + derived tables. */
    format: 1 | 2;
    /** Kinds of the document's raw sources, each once, in source order (empty for a format-1 doc). */
    sources: RawSourceKind[];
    /** Coverage of the applied profile: `complete` = no blocking gap, the document's own gaps plus the runtime
     *  `unmapped-block` (a placed block no family describes). The gap kinds only; `GET /device/cache` has
     *  the details. */
    coverage: { complete: boolean; gaps: CoverageGapKind[] };
  } | null;
  /** Does the running firmware have definitions to go by? `none`: an applied profile of this firmware without
   *  a blocking gap, or the firmware the catalog was generated from with no profile applied (or an applied one
   *  without a blocking gap). `partial`: an applied profile of this firmware with a blocking gap — the
   *  document's own (`coverage.gaps`) or the runtime `unmapped-block` — also on the catalog's firmware.
   *  `stale`: a profile of this firmware is stored but not usable. `unprofiled`: none of these. `unknown`: the
   *  firmware is not known, or there is no catalog firmware and no profile to compare against. Clients treat
   *  values they do not know like `unknown`. */
  drift: 'none' | 'partial' | 'stale' | 'unprofiled' | 'unknown';
  /** This device can contribute its editor definitions cache (`/device/cache/contribute`): a gen-3 grid
   *  driver that imports editor caches and whose firmware was read. Whether the cloud wants the file, and
   *  whether a cloud is configured at all, is in the contribution status, not here. */
  contribute: boolean;
  /** The walk-scope gates of the running firmware (services/walkScope.ts): how far a read-only definition walk may
   *  query the unit beyond the standard scope — `extendedIds` (ids above 127 of known tables), `above160` (roster
   *  blocks above effect id 160), `blockProbe` (`POST /device/definitions/blocks/:eid/probe`), `farIds` (never
   *  enabled). True only on a (model, firmware) verified for it (or under the development override); all false
   *  on unknown firmware and on devices without a definition walk. */
  walk: WalkScopeGates;
  /** The stored definitions can be exported to and imported from a `.axisdefs` file (`/device/definitions/export`,
   *  `/device/definitions/import`): a gen-3 grid driver (the generic-params trio). Whether a profile is stored to
   *  export is the route's answer (404 `no-profile`), not this flag's. */
  portable: boolean;
  /** Shared definitions pulled from the cloud can be checked against this unit before they are used (the spot check of
   *  `POST /device/cache/cloud/pull`: read-only definition queries): a gen-3 grid driver with a bundled catalog of its
   *  model whose firmware was read. Without it a pull that needs the check is refused (501 `unsupported` with
   *  `capability: 'spotCheck'`, or 503 `firmware-unknown` while the firmware is not read). Whether a cloud is
   *  configured is in the cloud status routes, not here. */
  spotCheck: boolean;
}

/** The kind of a SHARED definition source (cloud v2, `definition-sources`): a raw source of one read. Single-block
 *  probes (`live-probe`) are never shared. */
export type SharedSourceKind = Exclude<RawSourceKind, 'live-probe'>;

/** How far a shared source is confirmed: `official` by the maintainer, `verified` by at least two contributors on
 *  two networks with identical facts, `candidate` otherwise. A tier orders the offer; it never exempts a source
 *  from the device check before use. */
export type CloudSourceTier = 'official' | 'verified' | 'candidate';

/** One shared definition source the cloud offers for the attached device and firmware (`GET /device/cache/cloud`,
 *  v2): the best row of its kind, as a summary (counts only, no content). */
export interface CloudSourceSummary {
  /** The cloud row id (a UUID). */
  id: string;
  kind: SharedSourceKind;
  tier: CloudSourceTier;
  /** 0..3, computed by the cloud without the catalogs: 3 = a self-consistent editor cache of this firmware, or a
   *  device read without unresolved replies, missing slots, bound hits or an aborted extension. */
  quality: number;
  /** `quality === 3`. */
  complete: boolean;
  /** Uploaders whose shares carried these exact facts. */
  contributors: number;
  /** Device checks other installs reported for this row (distinct networks per outcome). */
  deviceChecks: { passed: number; failed: number };
  /** When the cloud first saw these facts (a UTC day, `YYYY-MM-DD`). */
  firstSeen: string;
  /** Distinct definition records. */
  records: number;
  /** Editor-cache sources: declared sections. */
  sections?: number;
  /** Device reads: blocks that carry records, and whether the read went beyond the standard scope. */
  blocks?: number;
  extended?: boolean;
  above160?: boolean;
  /** This install's last device check of this row (`passed` / `failed`), null when it was never checked here. */
  verdict: 'passed' | 'failed' | null;
  /** The facts equal a source already stored for this firmware (same kind, same fact hash): nothing to gain. */
  identical: boolean;
}

/** The parts of `GET /device/definitions/diff` a client can ask for (`include=`; default: all of them). */
export type DefinitionsDiffPart = 'params' | 'rosters' | 'enums' | 'strides' | 'sections' | 'blocks' | 'instances';

/** One param in the definitions diff: the device's row (added / changed) or the catalog's (removed). */
export interface ParamDelta {
  id: number;
  /** The public catalog label the param index serves at this pid, or `P<pid>`. */
  name: string;
  kind: 'float' | 'enum';
  /** `name` is a generic `P<pid>` name. */
  generic: boolean;
  /** Display range of a float row. */
  min?: number;
  max?: number;
  /** Device-true display unit of the row, when the profile carries one. */
  unit?: string;
  /** Number of options of an enum-kind row (its labels, else its ordinal range). */
  options?: number;
  /** The param index moved `name` here with its row: the catalog pid the name came from (an `added` entry with it is a
   *  param that moved, not a new one). */
  movedFrom?: number;
  /** `changed` only: how the device row relates to the catalog row at the same pid. */
  change?: 'compatible' | 'incompatible';
  fpBefore?: string;
  fpAfter?: string;
}

/** A model list (roster selector labels) of a family, catalog against the device. */
export interface RosterDelta {
  /** The device pid of the roster selector (it follows the selector's name when the row moved). */
  selectorId: number;
  before: number;
  after: number;
  appended: string[];
  inserted: Array<{ ordinal: number; label: string }>;
  renamed: Array<{ ordinal: number; from: string; to: string }>;
  removed: Array<{ ordinal: number; label: string }>;
  /** A kept label sits at another ordinal now (stored selections change meaning). */
  ordinalShift: boolean;
}

export interface FamilyDiff {
  family: string;
  /** The family's first effect id, null when it has none (not addressable). */
  eid: number | null;
  status: 'unchanged' | 'changed' | 'suspect' | 'disagreement' | 'catalog-only';
  /** Absent when `include` leaves out `params`. One entry per pid in `added` / `changed` (the profile rows) and for every
   *  catalog row the profile no longer has in `removed` — named `P<pid>` (generic) when the param index serves that
   *  pid's catalog name at another pid. `removed` also lists, under its catalog name and pid, every catalog name the
   *  index serves nowhere whose catalog row no profile row carries any more (the param vanished; its pid now holds
   *  another one). `removed` is null where nothing can be said: the family's rows are not byte-exact, or a suspect
   *  family was not compared. */
  params?: { added: ParamDelta[]; changed: ParamDelta[]; removed: ParamDelta[] | null; moved: Array<{ name: string; from: number; to: number }> };
  /** Present when the roster changed (and `include` has `rosters`). */
  roster?: RosterDelta;
  /** Changed label lists other than the roster. Absent when `include` leaves out `enums`. */
  enums?: Array<{ id: number; name: string; before: number; after: number; change: 'appended' | 'renamed' | 'inserted' | 'removed' | 'replaced' }>;
  /** Present when the section stride changed (and `include` has `strides`). */
  stride?: { before: number; after: number };
}

/** An editor-cache section no catalog family took: one the catalog firmware lacks (`new`), one there is no inventory
 *  to judge (`unclassified`), or any unassigned section a block is bound to. */
export interface SectionDiff { tag: number; key: string; role: SectionRole; stride: number; informative: number; mappedEids: number[] }

/** A block no catalog family places: a block-map entry of the applied profile, or a placed block nothing describes. */
export interface UnknownBlockDiff {
  eid: number;
  /** In the edit-buffer grid as last read (false when no grid was read this session). */
  placed: boolean;
  /** The block-map entry's state (`blockMapState`, the mapping the generic block params use too). */
  state: BlockMapState;
  key: string | null;
  sectionTag: number | null;
  /** Params a block read serves for it (the param index of `key`), 0 unless confirmed. */
  params: number;
}

/** `GET /device/definitions/diff`: the bundled catalog against the applied profile of the running firmware. */
export interface DefinitionsDiffDTO {
  model: number;
  firmware: string | null;
  catalogFirmware: string | null;
  /** Equal to `capabilities.definitions.drift` at the same moment. */
  state: DefinitionsCaps['drift'];
  profile: { key: string; source: ProfileSource; byteExact: boolean; format: 1 | 2; sources: SourceSummary[] } | null;
  /** Over the whole profile, whatever `family` and `include` select. */
  summary: {
    /** Row counts (`compareRows`): `removed` counts catalog rows the profile no longer has. */
    newParams: number; changed: { compatible: number; incompatible: number }; removed: number | null;
    movedNames: number; rosterChanges: number; enumChanges: number; strideChanges: number;
    newSections: number; unknownBlocks: number; suspects: string[]; disagreements: string[];
  };
  families: FamilyDiff[];
  /** Absent when `include` leaves them out. */
  sections?: SectionDiff[];
  blocks?: UnknownBlockDiff[];
  instances?: ProfileCoverage['instances'];
}

/** `GET /preset/blocks/:eid/params` as classic clients know it. */
export interface BlockParamsDTO {
  block: string; slug: string; page: number;
  named: NamedParam[]; enums: EnumParam[];
  type: { value: number; name: string } | null;
  layout?: DeviceLayout;
  /** Additive `blockState`: the block's Scene Ignore + Bypass Mode on its active channel (gen-3
   *  III/FM3/FM9, capability `blockState`). */
  blockState?: BlockStateDTO;
  /** Additive `visuals`: the read-only displays the block can show (capability `blockVisuals`). */
  visuals?: BlockVisualDTO[];
}
/** The generic response (`?generic=1`): every param the block has on the connected device, values that are
 *  `null` where none could be resolved, and a `definitions` block. A client tells it from the classic one
 *  by the presence of `definitions`. */
export interface BlockParamsV2DTO extends Omit<BlockParamsDTO, 'named' | 'enums'> {
  named: NamedParamV2[]; enums: EnumParamV2[];
  definitions: BlockDefinitionsMeta;
  /** The effect id maps to no family on this device model: nothing is listed. */
  unknownBlock?: true;
  /** The block read failed (every value is `read-failed`). */
  readError?: string;
}
export interface BlockParamsOpts {
  /** Serve the generic response. Drivers without it ignore the flag and answer the classic shape. */
  generic?: boolean;
  /** Read live values (default true). `false` serves the block's definitions/named rows without a device
   *  read: the Axis board build asks for the layout only, so opening a block does not queue behind the
   *  telemetry poll on a busy serial link. */
  observe?: boolean;
}

/** The block's Scene Ignore toggle on its ACTIVE channel (the param is per channel). `paramId` is the
 *  device catalog's `<FAMILY>_SCENEIGNORE` id (codec `blockStateParams`) - the same id the block's
 *  `enums[]` entry carries, so a write goes through the ordinary enum write (PUT .../params/:paramId,
 *  continuous:false). `supported:false` + `reason` when the device firmware is known and below the
 *  param's gate. */
export interface BlockSceneIgnoreDTO { paramId: number; value: number; supported: boolean; reason?: string }
/** The block's Bypass Mode selector (what the block does WHILE bypassed) on its active channel. Options are
 *  the device's own labels; `muting` marks the modes that silence the block (codec `isMutingBypassMode`). */
export interface BlockBypassModeDTO { paramId: number; value: number; options: { value: number; label: string; muting: boolean }[] }
/** Additive `blockState` on the block-params response (gen-3 III / FM3 / FM9; capability `blockState`).
 *  A null member = the block family has no such param. `readError: true` = the block's read failed, so
 *  nothing is known about either param (both members null). */
export interface BlockStateDTO { sceneIgnore: BlockSceneIgnoreDTO | null; bypassMode: BlockBypassModeDTO | null; readError?: true }
/** ADDITIVE on the gen-3 block-params response: the read-only displays ("graphs") the block can show,
 *  `{ key, kind, title, mode?, roles: { role: paramId } }` (forgefx-midi `BlockVisual`). Every role is a
 *  paramId of THIS response (a served knob or selector, or a read-only monitor pid), already narrowed to
 *  the block's current type/variant. Served only where `capabilities.blockVisuals` is true.
 *  The served layout's graph slots carry the matching `graphKey`; a stamped key may have NO entry here
 *  (the current variant lacks the visual's required params, or the key is 'eq') - clients treat such a
 *  slot as a gap. Visuals without a stamped slot are offered but not anchored (e.g. DELAY, REVERB). */
export type BlockVisualDTO = BlockVisual;
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
   *  `firmware` identify the cache; `error` carries the failure message on 'error'. A cloud pull that checks shared
   *  definitions against the device first reports 'verifying' (`done`/`total` = definitions read back so far / to
   *  read), then the terminal 'done' — or 'error' with `reason` when the check did not pass (nothing was stored). */
  | { type: 'cacheBuild'; phase: 'walking' | 'building' | 'verifying' | 'done' | 'error' | 'cancelled' | 'already-built'; done: number; total: number; key?: string; model?: number; firmware?: string; error?: string;
      /** Terminal 'error' of a cloud pull after 'verifying': the shared definitions did not match the device
       *  (`spot-check-failed`), the device did not answer enough of the check (`spot-check-inconclusive`), the check could
       *  not run to its end (`spot-check-error`), or the checked definitions were not stored: the stored ones changed
       *  meanwhile (`definitions-changed`), the unit was swapped (`unit-changed`), the privacy guard refused them
       *  (`contains-user-data`). */
      reason?: 'spot-check-failed' | 'spot-check-inconclusive' | 'spot-check-error' | 'definitions-changed' | 'unit-changed' | 'contains-user-data';
      /** Terminal `done` of a build with the extended scope: the extension walk (phase B) completed (`done`), had
       *  nothing to walk under the running firmware's gates (`skipped`), or stopped (`aborted`: the standard walk's
       *  result is kept, `abortReason` says why). */
      extension?: 'done' | 'skipped' | 'aborted';
      /** With `extension: 'aborted'`: why the extension walk stopped, a fixed vocabulary (never an error message):
       *  `implausible-reply (block b, param p)`, `silent-run (block b)`, `query-budget (n queries)`, `cancelled`,
       *  `empty-block (block b)`, `walk-failed`, `derivation-failed`. */
      abortReason?: string }
  /** The stored device-definition profile of `key` changed without a build walk of its own: re-derived from its
   *  raw sources (`rederived`), new sources merged into it (`merged`), a definitions file imported
   *  (`imported`), an unknown block probed (`block-probe`, with `eid`). Or (`unmapped-blocks`, gen-3 grid drivers)
   *  the set of placed blocks no family describes changed — after a grid read or a profile swap — which moves
   *  `capabilities.definitions.profile.coverage` (the runtime `unmapped-block` gap) and `drift`; `key` is the
   *  running firmware's profile key, nothing in the store changed. Clients re-read caps / status. */
  | { type: 'definitions'; reason: 'block-probe' | 'imported' | 'rederived' | 'merged' | 'unmapped-blocks'; key: string; eid?: number }
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

/** Options of a preset switch. `silent`: a job-internal switch (the diagnostic capture's reload probe and
 *  its full walk's reloads) — no `changed` event goes to the clients, which would otherwise reload their
 *  views in the middle of the job. */
export interface SelectPresetOpts { silent?: boolean }

/** One diagnostic dump request (DeviceDriver.diagnosticDump). `header` is the preset number the first
 *  whole dump's 0x77 header names (or the first header seen when no dump completed), null when no header
 *  arrived. `patch` is the decoded raw patch of the whole dump — for an in-memory comparison only (the
 *  edit buffer against its stored slot); callers must never persist or log it. */
export interface DiagnosticDump {
  /** The preset number the request asked for (0x3FFF = the edit buffer). */
  requested: number;
  header: number | null;
  /** A whole dump (0x77 header through its 0x79 terminator, at least one 0x78 chunk) arrived. */
  complete: boolean;
  /** Dump frames received (0x77 / 0x78 / 0x79) and their total size in bytes. */
  frames: number;
  chunks: number;
  bytes: number;
  /** Request round trip in ms. */
  ms: number;
  /** The whole dump decodes to an unused (all-zero) slot; null when it could not be decoded. */
  empty: boolean | null;
  patch: { raw: Uint8Array; body: Uint8Array } | null;
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
  /** Gen-3 live telemetry polls the supervisor may run against this device. `graphCurves` gates the
   *  block graph-curve read (GET /preset/blocks/:eid/curve), not a supervisor poll. */
  telemetry: { tuner: boolean; outputMeters: boolean; cpu: boolean; graphCurves: boolean };
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
  /** Read-only block visuals (`visuals` on the block-params response: role → paramId per display,
   *  resolved against the device's own catalog and narrowed to the block's current type/variant), and
   *  layout graph slots stamped with their normalised `graphKey`. Gen-3 grid units (FM3 / FM9 /
   *  Axe-Fx III) only. */
  blockVisuals: boolean;
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
  /** The block-params response carries `blockState` (Scene Ignore + Bypass Mode of the open block, tagged
   *  from the codec's per-model catalog lookup). Gen-3 Axe-Fx III / FM3 / FM9 only; absent = false. */
  blockState?: boolean;
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
  /** The firmware the editor layouts' firmware gates are evaluated against: the running firmware when it is known,
   *  else the last one read from the SAME connected unit this session (a re-read that got no answer — silence, a read
   *  in flight — does not flip an older unit to the newest firmware's layout). It is forgotten on disconnect, a port
   *  change or a model change. Null when no read of this unit ever answered. Optional: a ctx without it evaluates the
   *  layouts against `getFirmware`. */
  getLayoutFirmware?(): { major: number; minor: number } | null;
  /** The walk-scope gates of the running firmware (services/walkScope.ts; the registry's `walkScopeGates`), read at
   *  call time. Optional: a ctx without it has every gate closed. */
  walkScope?(): WalkScopeGates;
}

/** Why a store was not a plain acknowledged success (gen-3, additive on the store result): 'rejected' = a
 *  fn-0x01 refusal (0x64) was seen in the store window and no ack followed (the 0x64 carries no sub-action, so
 *  a late refusal of a preceding fn-0x01 write can be attributed to the store); 'no-ack' = nothing
 *  acknowledged it in time (the slot may or may not have been written). Callers branch on this instead of
 *  parsing `error` / `warning` text. */
export type StoreReason = 'rejected' | 'no-ack';

/** Result of a confirmed write (see the `── writes ──` note on DeviceDriver for what `ok` means per family).
 *  `acked` is ADDITIVE: `true` when the device's own acknowledgement of THIS write was seen (AM4 command ack /
 *  param-write echo) — acknowledged and not refused, which is still not proof the write took effect. */
export interface WriteResult { ok: boolean; acked?: boolean }

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
  /** Gen-3 grid drivers: effect ids of the blocks in the edit-buffer grid as last read that no param family
   *  describes — not the current profile, not the model's static roster / effect-id spans, not a `confirmed`
   *  block-map entry of the applied document (no device traffic); null before the first grid read of the session. */
  unmappedPlacedEffectIds?(): number[] | null;
  /** Gen-3 grid drivers: effect ids of the blocks in the edit-buffer grid as last read, sorted and unique (no device
   *  traffic); null before the first grid read of the session. */
  placedEffectIds?(): number[] | null;
  /** Gen-3 grid drivers: the edit-buffer grid read afresh (one dump read, never a cached or in-flight read), which also
   *  refreshes `placedEffectIds` — the diagnostic capture's block probe step reads its targets from it. `silent`: no
   *  `definitions` / `unmapped-blocks` event from this read (the next grid read or profile swap announces the change). */
  freshGrid?(opts?: { silent?: boolean }): Promise<PresetGridDTO>;
  /** Gen-3 grid drivers: the editor-cache sections of the applied profile a placed block's bulk read fits (the runtime
   *  bulk-shape match), with their strides — what the block probe sizes its walk by. Null when the profile has no section
   *  a block may bind to (nothing is read); empty when the read failed or nothing fits. One status + bulk read. */
  probeShape?(eid: number): Promise<Array<{ tag: number; stride: number }> | null>;
  /** A (re)detect activated this driver: forget what it learned about the previous connection (gen-3: the
   *  dump-header strictness proven on it and the known current slot). Drivers keep no such state otherwise. */
  resetSession?(): void;

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
  /** Diagnostic capture: ONE read-only dump request for a stored slot or the edit buffer that accepts
   *  whatever whole dump the device answers with, so the caller learns which number the dump header
   *  names. Never retried, never cached. gen-3 (capability presetDump). */
  diagnosticDump?(target: number | 'edit-buffer'): Promise<DiagnosticDump>;
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
  blockParams?(eid: number, opts?: BlockParamsOpts): Promise<BlockParamsDTO | BlockParamsV2DTO>;
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
   *  position (0..1) + level (0..1). Empty when the block isn't a looper. */
  looperTelemetry?(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }>;
  /** Toggle a looper transport control (POST /preset/looper/control). `action` ∈ record|play|stop|
   *  overdub|undo|once|reverse|half; `on` = 1.0/0.0. gen-3. */
  looperControl?(eid: number, action: string, on: boolean): Promise<{ ok: boolean }>;
  /** Device-rendered block graph curve for one page slot (GET /preset/blocks/:eid/curve): the
   *  `sub 0x23` reply decoded to `count/4` float32 magnitudes (128 for a full-size curve). Null when
   *  no reply matched. gen-3 (capability telemetry.graphCurves). */
  blockCurve?(eid: number, slot: number): Promise<{ eid: number; slot: number; values: number[] } | null>;

  // ── FC / modifier ──
  fcReadSwitch?(layout: number, view: number, sw: number): Promise<FcSwitchState>;
  fcReadState?(layout: number, view: number, sw: number): Promise<FcReadState>;
  bindModifier?(slot: number, targetEffectId: number, targetParam: number, source: number): Promise<{ ok: boolean; error?: string; slotEid?: number; slot?: number; targetEffectId?: number; targetParam?: number; source?: number }>;

  // ── writes ──
  // What `ok` on a write result means differs by family — none of them means "applied":
  //   gen-3 confirmed writes (discrete setParam, setType, placeCell, cable, names, preset select): `ok:true` =
  //     no refusal for this write's function in its window (silence, or the device's value echo); `ok:false` =
  //     a 0x64 refusal echoing that function. Fire-and-forget writes (continuous setParam, bypass, channel,
  //     scene, tempo) report `ok:true` = sent.
  //   AM4: `ok:true` = the device ACKNOWLEDGED the write (the 18-byte command ack or the 64-byte param-write
  //     echo) and did not refuse it, with `acked:true` (WriteResult). The AM4 acks a write to an absent block
  //     the same way while it silently does nothing, so this is "acknowledged, not refused", not "applied".
  //     `ok:false` = no acknowledgement in time.
  setParam?(eid: number, paramId: number, value: number, continuous: boolean): Promise<WriteResult>;
  setType?(eid: number, value: number): Promise<WriteResult>;
  setBypass?(eid: number, bypassed: boolean): Promise<{ ok: boolean }>;
  setChannel?(eid: number, channel: string): Promise<WriteResult>;
  /** Place `blockId` at the 1-indexed cell (0 clears it). gen-3 refuses a block that is already placed at ANOTHER
   *  cell with a 409 error (the device would echo the insert and silently ignore it) and answers the same block
   *  onto its own cell with `ok:true` without writing — move a block by clearing its source first. Shunts and clears
   *  are not checked; on a slow link only an already existing grid read is consulted (never a fresh dump). */
  placeCell?(row: number, col: number, blockId: number): Promise<WriteResult>;
  selectCell?(row: number, col: number): Promise<{ ok: boolean }>;
  cable?(srcRow: number, srcCol: number, destRow: number, connect: boolean): Promise<{ ok: boolean }>;
  /** Switch the active preset. `code` is ADDITIVE (AM4 bank-letter location code, e.g. "C02"). */
  selectPreset?(n: number, opts?: SelectPresetOpts): Promise<{ ok: boolean; code?: string }>;
  /** Re-select the CURRENT preset to reload it from flash — the non-destructive safety net the codec's
   *  FULL-mode self-describe walk runs after every block whose params it swept, discarding any lingering
   *  sweep write. Reuses the driver's current-preset ref + preset-select machinery; no new wire bytes.
   *  Implemented by gen-3 (capability fullCapture); absent elsewhere. */
  reloadPreset?(opts?: SelectPresetOpts): Promise<void>;
  /** Store the edit buffer to slot n. `location`/`code` are ADDITIVE (AM4). `acked`/`reason`/`error`/`warning`
   *  are ADDITIVE (gen-3): `acked` = the device's own acknowledgement was seen. `ok:false` + `error` = a real
   *  refusal (`reason:'rejected'`), or (where the ack is verified for this model, link and firmware) no
   *  acknowledgement in time (`reason:'no-ack'`, outcome unknown). `ok:true` + `warning` = sent but
   *  unconfirmed (the ack is not verified here and none came; also `reason:'no-ack'`). `reason` is absent on
   *  an acknowledged store. Drivers without a known ack (AM4 / VP4 fire-and-forget; gen-2 lenient) omit all
   *  four. */
  store?(n: number): Promise<{ ok: boolean; location?: number; code?: string; acked?: boolean; reason?: StoreReason; error?: string; warning?: string }>;
  loadPresetBytes?(syx: Uint8Array): Promise<{ ok: boolean }>;
  setSceneName?(index: number, name: string): Promise<WriteResult>;
  setPresetName?(name: string): Promise<WriteResult>;

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
  setParamByKey?(key: string, value: number): Promise<WriteResult>;
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