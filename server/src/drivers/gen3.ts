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
  GRAPH_CURVE_SLOTS,
  buildGraphCurvePoll,
  isGraphCurveResponse,
  parseGraphCurve,
  isMultipurposeResponse,
  parseMultipurposeResponse,
  describeMultipurposeResultCode,
  buildGetRawParamValue,
  type ModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import { wireToDisplay } from 'forgefx-midi/shared';
import {
  LIVE_WALK_LIMITS, blockBindableSection, enumOrdinalBounds, isInformativeRow, isPlaceholderRow, isSyntheticFamilyKey, matchBulkShape,
  typecodeTaper, typecodeUnit,
  type BlockMapEntry, type DerivedSection, type RangeDef as CodecRangeDef
} from 'forgefx-midi/cache';
import { crossBlockEffectId, gen3RosterSpan, type CrossBlockRefKey } from 'forgefx-midi/gen3/fm3';
import {
  parsePresetDump, decodeRawPatch, decodeGen3Body,
  readBlockParamsForModel, modelsFromBlocks,
  effectRoster, blockRefForEid, slugForEffectId, blockInstances,
  retargetPresetDumpToEditBuffer,
  blockStateParams, hasBlockStateParams, firmwareAtLeast, formatBlockStateFirmware, isMutingBypassMode,
  resolveBlockVisuals, layoutParamIds, hasBlockVisuals,
  type DecodedBlock,
  type BlockVisual
} from 'forgefx-midi/devices/gen3';
import { isTransportTimeout, type Transport } from '../transport/types.js';
import {
  SLUG_FAMILY, isEnumOnAnyDevice, paramLabel, typeSelectorPid, unlessHidden, variantSelectorPid,
  type DeviceProfile, type ParamDef, type TypeModel, type DeviceLayout, type DeviceLayoutControl, type LayoutFirmware, type RangeDef,
  type SelectorValues
} from '../devices.js';
import { buildParamIndex, MAX_WIRE_PID, type BlockIndex, type ParamEntry } from './paramIndex.js';
import { catalogFamilyOfBlock, deviceCacheKey, profileCatalogFor, staticFamilyForEffectId } from '../profileCatalog.js';
import { blockMapAccess, blockWriteRefusedMessage, type BlockMapAccess } from './blockMapState.js';
import { EmptyPresetError } from './types.js';
import type {
  DeviceDriver, DriverCapabilities, DriverCtx, DiagnosticDump, SelectPresetOpts,
  PresetGridDTO, GridCellDTO, PresetBlockDTO, PresetSummary, NamedParam, EnumParam, MeterVal,
  FcSwitchState, FcReadState, StoreReason, BlockStateDTO,
  BlockParamsDTO, BlockParamsV2DTO, BlockParamsOpts, NamedParamV2, EnumParamV2, ParamMeta, UnresolvedReason, BlockMapMeta,
  ValueSource
} from './types.js';
import { validatedPresetDump } from './sendPolicy.js';
import { devHookValue, processEnv } from '../devHooks.js';

// slug → { name, page=base effect id } from the authoritative codec base table (replaces the old
// defs.js pack lookup; block names + base ids are codec facts, not editor-cache definitions).
const BLOCK_META: Record<string, { name: string; page: number }> = (() => {
  const out: Record<string, { name: string; page: number }> = {};
  for (const e of effectRoster()) out[e.slug] = { name: e.name, page: e.page };
  return out;
})();

/** The catalog family of an audio block by the codec's block roster (`slugForEffectId` → `SLUG_FAMILY`): a block with
 *  channels A-D. Never the family the development hook hides (devices.ts `hiddenFamily`): such a block is served as a
 *  block the catalog does not know. */
const audioFamilyOf = (eid: number): string | undefined => unlessHidden(SLUG_FAMILY[(slugForEffectId(eid) ?? '').toLowerCase()]);

/** Whether a bulk read of `itemCount` items is a block with channels A-D over a section of `stride` slots: one slice
 *  (`false`) or four (`true`); null when it is neither or the stride is unknown (contract E4). */
function shapeChannels(itemCount: number, stride: number | undefined): boolean | null {
  if (!stride || !(stride > 0) || !(itemCount > 0)) return null;
  return itemCount === stride ? false : itemCount === 4 * stride ? true : null;
}

const EDIT_BUFFER = 0x3fff; // preset number sentinel = current edit buffer
/** Gen-3 grid shunt (routing cell) effect-id base: shunt k is `1023 + k`, real blocks sit well below it. */
export const GEN3_SHUNT_BASE = 1024;

// ── reply shapes of the two multi-frame reads, so a late reply to an EARLIER read can never pass for this
// one (the transport only holds the link for a short drain after a lost reply; anything later reaches the
// next request, and only these matchers keep it out) ──
const isFrameOf = (f: readonly number[], model: number, fn: number): boolean =>
  f.length > 6 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f[4] === model && f[5] === fn;

/** Preset dump: a 0x77 header, 0x78 chunks, a 0x79 terminator. The header names the dump's preset number in
 *  bytes 6-7 (MSB-first 7-bit pair — the field retargetPresetDumpToEditBuffer rewrites; 0x3FFF = the edit
 *  buffer). How strictly a read holds the device to that number is per model (DUMP_HEADER_POLICY). */
type DumpHeaderCheck =
  /** Only a header naming the requested preset number counts. */
  | 'strict'
  /** Complete at once on a header naming the requested number; if only whole dumps naming another number
   *  arrive, use the LAST of them after the quiet gap (a device answers in order, so a late reply to an
   *  earlier read comes first) and log it once. Owned frames and the terminator logic still keep a stale
   *  tail out. */
  | 'prefer'
  /** Any header (the device does not name the request in it). */
  | 'any';
/** Per model: [stored-slot reads, edit-buffer reads] — the STARTING policy of a connection; tighten as tester
 *  evidence comes in. Within a connection a 'prefer' kind turns 'strict' as soon as the device has sent one
 *  header naming the requested number (the driver's per-connection session, see #dumpHeaderPlan).
 *   FM3 stored slots: strict — the header names exactly the requested slot (hardware, fw 13.0: populated and
 *   empty slots, slots >= 128).
 *   Edit buffer, every model: prefer. A read counts EDIT_BUFFER_HEADERS (the FM3 answers a 0x3FFF request
 *   with 7F 00 on fw 13.0) and the known CURRENT slot as named, so only a header naming another stored slot (a
 *   late scan reply, or a convention not seen yet — 7F 00 is proven on one firmware only) falls back: one quiet
 *   gap and a log line, never failed reads. The connection turns strict once a named header has been seen.
 *   FM9 / Axe-Fx III stored slots: prefer — not verified on these yet. */
const DUMP_HEADER_POLICY: Readonly<Record<number, readonly [stored: DumpHeaderCheck, editBuffer: DumpHeaderCheck]>> = {
  0x11: ['strict', 'prefer'], // FM3
  0x12: ['prefer', 'prefer'], // FM9
  0x10: ['prefer', 'prefer'] // Axe-Fx III
};
/** Header numbers that name the EDIT BUFFER in a dump answering an edit-buffer (0x3FFF) request: the 0x3FFF
 *  sentinel itself, and 0x3F80 (`7F 00`) — what the FM3 sends on fw 13.0 and what the Axe-Fx III fixture
 *  carries. A stored-slot read never uses a dump with one of these headers, not even as a 'prefer' fallback
 *  (a late grid() dump must not be backed up as slot n).
 *  Limit: two edit-buffer dumps are indistinguishable (same header, no request id). An edit-buffer read whose
 *  dump arrives only after its request gave up and the drain released the link (> ~5 s late, rare) can
 *  therefore answer the NEXT edit-buffer read — with the older contents of the edit buffer. */
const EDIT_BUFFER_HEADERS: readonly number[] = [EDIT_BUFFER, 0x3f80];
const dumpHeaderCheck = (model: number, target: number): DumpHeaderCheck =>
  (DUMP_HEADER_POLICY[model] ?? ['prefer', 'prefer'])[target === EDIT_BUFFER ? 1 : 0];
const dumpHeaderNumber = (f: readonly number[]) => ((f[6]! & 0x7f) << 7) | (f[7]! & 0x7f);
/** Does header number `n` name the request for `target` itself (proof of the device's convention)? */
const headerNamesRequest = (n: number, target: number): boolean =>
  n === target || (target === EDIT_BUFFER && EDIT_BUFFER_HEADERS.includes(n));
const dumpFramesOnly = (fs: number[][], model: number) => fs.filter((f) => isFrameOf(f, model, 0x77) || isFrameOf(f, model, 0x78) || isFrameOf(f, model, 0x79));
/** Every WHOLE dump in `frames` whose header passes `want` — each its header through the 0x79 after it, that
 *  dump's frames only. A terminator without a wanted header before it (the tail of an earlier dump) is never
 *  part of one. */
function wholeDumps(frames: number[][], model: number, want: (header: number[]) => boolean): number[][][] {
  const out: number[][][] = [];
  let start = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (isFrameOf(f, model, 0x77)) start = want(f) ? i : -1;
    else if (start >= 0 && isFrameOf(f, model, 0x79)) {
      out.push(dumpFramesOnly(frames.slice(start, i + 1), model));
      start = -1;
    }
  }
  return out;
}
/** How one dump read judges headers: the effective check, which headers NAME the request, and which ones the
 *  read may use at all (named ones, plus — under 'prefer' — fallback candidates). */
interface DumpHeaderPlan { check: DumpHeaderCheck; named: (header: number[]) => boolean; usable: (header: number[]) => boolean }
/** Request options for one dump: complete at once on a whole dump whose header the plan calls named; own the
 *  headers the plan may use and the chunks after them, so a dump that stops short ends one quiet gap after
 *  its last chunk (the transport drains the rest), and a whole dump under 'prefer' ends one quiet gap after its
 *  terminator without a drain (`settles`). */
function presetDumpOpts(model: number, plan: DumpHeaderPlan, timeoutMs: number, quietMs: number) {
  const { named, usable } = plan;
  let inOurs = false;
  return {
    timeoutMs,
    quietMs,
    match: (fs: number[][]) => wholeDumps(fs, model, named).length > 0,
    owns: (f: number[]) => {
      if (isFrameOf(f, model, 0x77)) return (inOurs = usable(f));
      return inOurs && (isFrameOf(f, model, 0x78) || isFrameOf(f, model, 0x79));
    },
    settles: (f: number[]) => isFrameOf(f, model, 0x79)
  };
}

/** Block bulk read (fn 0x1F poll): a 0x74 head naming the block (bytes 6-7, LSB-first 7-bit pair), 0x75
 *  bodies, a 0x76 end. Only a burst whose head names THIS block answers the poll — a spontaneous broadcast or
 *  another block's late burst does not. */
const isBulkHeadFor = (f: readonly number[], model: number, eid: number): boolean =>
  isFrameOf(f, model, 0x74) && f.length >= 11 && ((f[6]! & 0x7f) | ((f[7]! & 0x7f) << 7)) === eid;
const bulkFramesOnly = (fs: number[][], model: number) => fs.filter((f) => isFrameOf(f, model, 0x74) || isFrameOf(f, model, 0x75) || isFrameOf(f, model, 0x76));
/** The first whole burst for `eid` (its head through the next 0x76), or null. */
function bulkReadSpan(frames: number[][], model: number, eid: number): number[][] | null {
  let start = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (isFrameOf(f, model, 0x74)) start = isBulkHeadFor(f, model, eid) ? i : -1;
    else if (start >= 0 && isFrameOf(f, model, 0x76)) return bulkFramesOnly(frames.slice(start, i + 1), model);
  }
  return null;
}
/** What a bulk read hands its caller: the whole burst for `eid`, else the last one that started for it (a lost
 *  0x76 — assembleGen3BlockBulkRead decodes what arrived), else nothing (→ "no 0x74 head", as for silence). */
function bulkReadFrames(frames: number[][], model: number, eid: number): number[][] {
  const whole = bulkReadSpan(frames, model, eid);
  if (whole) return whole;
  let last = -1;
  frames.forEach((f, i) => { if (isBulkHeadFor(f, model, eid)) last = i; });
  if (last < 0) return [];
  const tail: number[][] = [frames[last]!];
  for (const f of frames.slice(last + 1)) {
    if (isFrameOf(f, model, 0x74)) break; // another block's burst
    if (isFrameOf(f, model, 0x75)) tail.push(f);
  }
  return tail;
}

/** Is the device's own acknowledgement of a preset store EVIDENCED on this model? ForgeFX-side table (the
 *  codec does not carry this fact; FOLLOW-UP: move it into the codec's per-device config).
 *   'verified' — an ack was seen on our OWN hardware: a missing ack is a failure (`ok:false`).
 *   'unknown'  — not seen on our own hardware: a missing ack is only a warning (`ok:true, acked:false,
 *                warning`); a real 0x64 refusal is `ok:false` either way.
 *  The ack repeats the request's fn/sub envelope (it is not byte-identical to the request). It is VERIFIED
 *  on our own FM3 (model byte 0x11): it arrives ~0.8–0.9 s after the request on fw 12.0 and ~1.25–1.35 s on
 *  fw 13.0, over USB. FM9 (0x12) and Axe-Fx III (0x10) are still 'unknown' — flip one only with our own
 *  hardware evidence for that model, never on a report.
 *
 *  A level is only as wide as what was measured, so the table entry carries its scope as data
 *  (`StoreAckScope`) and `resolveStoreAck` narrows it to 'unknown' outside it: the FM3's 'verified' holds on
 *  a fast (USB) link and firmware >= 12.0 only; a slow (5-pin DIN) link, older firmware, or firmware that
 *  could not be read all fall back to the lenient 'unknown'. */
export type StoreAckEvidence = 'verified' | 'unknown';
export interface StoreAckScope {
  readonly level: StoreAckEvidence;
  /** The level holds on firmware >= [major, minor] only; older or unknown firmware → 'unknown'. */
  readonly minFirmware?: readonly [number, number];
  /** The level holds on a fast (USB) link only; a slow (5-pin DIN) link → 'unknown'. */
  readonly fastLinkOnly?: boolean;
}
const STORE_ACK_EVIDENCE: Readonly<Record<number, StoreAckScope>> = {
  0x10: { level: 'unknown' },
  0x11: { level: 'verified', minFirmware: [12, 0], fastLinkOnly: true },
  0x12: { level: 'unknown' }
};

/** The effective store-ack evidence for one model entry on THIS link and firmware (pure). `firmware` is the
 *  running firmware the registry read at detect time (null = not read / not known). */
export function resolveStoreAck(
  scope: StoreAckScope | undefined,
  link: { slow: boolean; firmware: { major: number; minor: number } | null }
): StoreAckEvidence {
  if (!scope || scope.level !== 'verified') return 'unknown';
  if (scope.fastLinkOnly && link.slow) return 'unknown';
  if (scope.minFirmware) {
    const fw = link.firmware;
    if (!fw) return 'unknown';
    const [major, minor] = scope.minFirmware;
    if (fw.major < major || (fw.major === major && fw.minor < minor)) return 'unknown';
  }
  return 'verified';
}

/** How long `store()` waits for the ack, per evidence level and link. The wait ends the instant the ack
 *  arrives, so the cap only costs time when none comes. 'verified': the fast 6 s is ~4.4x the slowest FM3 ack
 *  measured (~1.35 s, fw 13.0); the slow 8 s was not measured and stays under the client's 12 s request
 *  ceiling, which includes queue time. 'unknown': shorter, because on a model that never acks EVERY
 *  successful save would otherwise pay the full cap. A slow (5-pin DIN) link gets more. */
const STORE_ACK_TIMEOUT_MS: Readonly<Record<StoreAckEvidence, { fast: number; slow: number }>> = {
  verified: { fast: 6000, slow: 8000 },
  unknown: { fast: 2500, slow: 6000 }
};

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
  /** ADDITIVE: present (true) only for an unused preset slot — an all-zero patch with no name, grid,
   *  scenes or valid CRC. Omitted for every populated preset so existing payloads are unchanged. */
  empty?: boolean;
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
  const kept = frames.filter((f) => f.length >= 8 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && (f[5] === 0x77 || f[5] === 0x78 || f[5] === 0x79));
  const out = new Uint8Array(kept.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of kept) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Full dump decode via the package pipeline (parse → raw_patch/CRC/Huffman → structured body),
 *  mapped to the old server DTO. rows/cols/modelName come from the profile — the same values the
 *  old codec's DIMS dict held; the preset name is the raw_patch header ASCII at 0x08..0x28
 *  (NUL-stop, trimmed), exactly the old decoder's source. */
function decodeDump(frames: readonly (readonly number[])[], prof: DeviceProfile): DecodedDump {
  const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, prof.model);
  const raw = decodeRawPatch(parsed.chunkPayloads);
  if (raw.empty) {
    // An unused slot reads back as a normal full-length dump with an all-zero patch: nothing to
    // decompress or decode. Answer it as an empty preset (blank name, no grid/scenes, CRC not valid)
    // so every dump-backed route answers normally instead of failing the whole request.
    return {
      dump: {
        modelId: prof.model,
        modelName: prof.name,
        name: '',
        crcValid: false,
        crc: raw.storedCrc,
        rows: prof.rows,
        cols: prof.cols,
        grid: [],
        sceneNames: [],
        empty: true
      },
      body: raw.body,
      decompSize: 0
    };
  }
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
// Catalog unit codes that mark a CONTINUOUS control (a dial), i.e. everything except 'enum'.
// A float-kind range alone is not enough to call a param a knob: some selectors ship a float-typed
// range record under unit 'enum' (CABINET_ZOOM, the CONTROLLERS_*_MODE rows, GLOBAL_SEND_MIDI_CLOCK
// …), and rendering those as dials would write fractional values into a selector.
// This allowlist is an interim guard; the lasting source for widget choice is the device-true
// kind/labels of the profile.
//   'numeric' = a plain unitless knob (Drive, Tone, Level, cut freqs…) and the other unit codes below
//   are established continuous controls.
const ESTABLISHED_KNOB_UNITS = ['numeric', 'knob_0_10', 'knob_0_20', 'db', 'hz', 'ms', 'seconds', 'percent', 'bipolar_percent', 'ratio', 'semitones', 'degrees'];
//   'unverified' = the catalog could not confirm a unit, 'count' = a catch-all that holds both real
//   continuous values (a filter Q) and plain stepper counts, 'pf' = capacitance. The catalog's unit
//   is NOT evidence of continuity for these, so they are admitted conservatively (see isKnobParam).
const PROVISIONAL_KNOB_UNITS = new Set(['unverified', 'count', 'pf']);
const KNOB_UNITS = new Set([...ESTABLISHED_KNOB_UNITS, ...PROVISIONAL_KNOB_UNITS]);

// Params that look like a dial but are not one, which no range heuristic can tell apart. Keyed by the
// catalog param name; extend only with a reason.
const NOT_A_KNOB = new Set([
  'MOD_EFFECTID', // the modifier's target block id: a knob would silently retarget the modifier
  'GLOBAL_CS_CHAN_BEGIN', // its paramId lies outside the fn-0x1F body, so the read-back is always the minimum
]);

/** A range that reads like a stepper or selector rather than a dial: integral bounds with either an
 *  integer step, or no step and a small span (<= 64 values). Deliberately conservative (it also hides
 *  a plain 0..1 range): used only to vet the provisional units, whose catalog unit proves nothing. */
function looksDiscrete(range: { displayMin: number; displayMax: number; step?: number }): boolean {
  if (!Number.isInteger(range.displayMin) || !Number.isInteger(range.displayMax)) return false;
  const step = range.step ?? 0;
  if (step >= 1 && Number.isInteger(step)) return true;
  return step === 0 && range.displayMax - range.displayMin <= 64;
}

type FamilyParam = DeviceProfile['params'][string][number];

/** Unit code by paramId for one family's param list, built once per list (a block read asks per param). */
const unitIndexes = new WeakMap<readonly FamilyParam[], Map<number, string | undefined>>();
function unitOfParam(defs: readonly FamilyParam[], paramId: number): string | undefined {
  let index = unitIndexes.get(defs);
  if (!index) {
    index = new Map();
    for (const p of defs) if (!index.has(p.paramId)) index.set(p.paramId, p.unit);
    unitIndexes.set(defs, index);
  }
  return index.get(paramId);
}

/** Is this catalog param a knob: a float-kind range with a usable span (min !== max), a continuous
 *  catalog unit (KNOB_UNITS), not the bypass flag and not a known non-dial (NOT_A_KNOB). A param on one
 *  of the provisional units ('unverified' / 'count' / 'pf') must also not be a selector on another
 *  gen-3 device, be label-less, and not look like a stepper (integer step, or integral bounds over a
 *  small span). Shared by blockParams() and meters(), so the grid's meter param is always one of the
 *  block's knobs. */
function isKnobParam(profile: DeviceProfile, family: string, p: FamilyParam): boolean {
  const range = profile.ranges[family]?.[p.paramId];
  if (range?.kind !== 'float') return false;
  if (!KNOB_UNITS.has(p.unit ?? '')) return false;
  if (/bypass/i.test(p.displayLabel ?? p.name)) return false;
  if (range.displayMin === range.displayMax) return false; // 0..0 is an unusable knob
  if (NOT_A_KNOB.has(p.name)) return false;
  if (PROVISIONAL_KNOB_UNITS.has(p.unit ?? '')) {
    // Only where this device's catalog unit proves nothing: an established unit is trusted as-is, so a
    // later catalog change on one device can never silently hide a dial on the others.
    if (isEnumOnAnyDevice(family, p.name)) return false;
    if ((profile.enumLabelsFor(family, p.paramId)?.length ?? 0) > 0) return false; // labels = a selector
    if (looksDiscrete(range)) return false;
  }
  return true;
}

/** The family's knob params, one per wire paramId (first wins). Exported for the per-device
 *  knob-count test. */
export function knobParams(profile: DeviceProfile, family: string): FamilyParam[] {
  const seenIds = new Set<number>();
  return (profile.params[family] ?? []).filter((p) => {
    if (!isKnobParam(profile, family, p) || seenIds.has(p.paramId)) return false;
    seenIds.add(p.paramId);
    return true;
  });
}

/** Selectors whose range row is a FLOAT row although the device ships a label list for them. The codec
 *  reports these under unit 'enum' (a device label list makes a param a selector), which keeps them out of
 *  the knobs (isKnobParam) while the enum list only looked at enum-kind rows: they listed nowhere and the
 *  block editor lost the control. Today that is the Axe-Fx III's 13 `*_GLOBALMIX` toggles (OFF / ON over a
 *  0..1 float row; they were dials while the catalog still read them as 'percent').
 *
 *  Deliberately a narrow, named class and not "every float row with labels": that wider set also holds
 *  selectors that were never shown (KILLDRY, GLOBAL_IRCAPTURE_PROCESS, the bypass flags) and admitting them
 *  is a separate decision. The structural guards below make sure a later catalog change cannot turn a
 *  non-selector into an enum through this name alone. */
const FLOAT_ROW_SELECTOR_NAME = /_GLOBALMIX$/;

/** Is this catalog param a float-row selector (see FLOAT_ROW_SELECTOR_NAME): the 'enum' unit, a named
 *  class member, a float row spanning exactly 0..1 and a device label list of exactly 2 entries (OFF / ON).
 *  The writes are the existing discrete path: float32(ordinal), which is also how the codec routes a
 *  param that carries a label list; that path is only proven for a 0..1 toggle, so a wider row (0..2 with
 *  3 labels, ...) is deliberately not admitted. */
function isFloatRowSelector(profile: DeviceProfile, family: string, p: FamilyParam): boolean {
  if (p.unit !== 'enum' || !FLOAT_ROW_SELECTOR_NAME.test(p.name)) return false;
  const range = profile.ranges[family]?.[p.paramId];
  if (range?.kind !== 'float') return false;
  if (range.displayMin !== 0 || range.displayMax !== 1) return false;
  return profile.enumLabelsFor(family, p.paramId)?.length === 2;
}

/** The family's enum (selector) params for the block editor: every param whose device range row is an
 *  enum with a usable span, plus the float-row selectors (isFloatRowSelector, one per wire paramId, first
 *  wins like knobParams). The family TYPE selector (`typeId`, shown by the header retype palette) and the
 *  raw bypass flag are left out. Exported for the per-device classification test. */
export function enumParams(profile: DeviceProfile, family: string, typeId?: number): FamilyParam[] {
  const floatSelectorIds = new Set<number>();
  return (profile.params[family] ?? []).filter((p) => {
    const range = profile.ranges[family]?.[p.paramId];
    if (p.paramId === typeId) return false;
    if (/^bypass$/i.test(p.displayLabel ?? p.name)) return false;
    if (range?.kind === 'enum') return range.displayMax > range.displayMin;
    if (!isFloatRowSelector(profile, family, p) || floatSelectorIds.has(p.paramId)) return false;
    floatSelectorIds.add(p.paramId);
    return true;
  });
}

/** The read-only visuals served with a gen-3 block's params: the family's role tables (forgefx-midi
 *  visuals) resolved against THIS profile's catalog, so every role is the device's own paramId, limited
 *  to the ids this response serves (knobs + selectors) and — when the block has a layout — STRICTLY to
 *  the resolved layout variant's own controls (a sustain-only compressor type shows SUSTAIN, not THRESH →
 *  gain reduction only; a comb-filter type shows no FREQ and no LFO → neither visual). A block without a
 *  layout (DELAY) keeps every served role. Monitor roles (gain reduction) are never narrowed.
 *
 *  One exception: a variant whose pages share no page name with the family's Default variant (the
 *  value-less one) is a partial variant that only ADDS pages to the Default ones — the REVERB types whose
 *  only page is 'Pitch Shift' still have the Default's Basic page with Time / Pre-Delay. A visual the
 *  strict pass drops is then resolved once more against the Default's controls PLUS the selected
 *  variant's. Visuals the strict pass already keeps stay as they are (so e.g. the TREMOLO panner variant,
 *  which also shares no page name with the Default 'Tremolo' page, does not pick up its depth knob).
 *  Families without a Default variant (FILTER) stay strict. Exported for the mocked tests. */
export function blockVisualsFor(
  profile: DeviceProfile,
  family: string,
  layout: DeviceLayout | undefined,
  servedIds: Iterable<number>,
): BlockVisual[] {
  if (!hasBlockVisuals(profile.model)) return [];
  const served = new Set(servedIds);
  const params = profile.params[family];
  if (!layout) return resolveBlockVisuals(params, family, served);
  const selectedIds = layoutParamIds(layout.pages);
  const strict = resolveBlockVisuals(params, family, served, { layoutParamIds: selectedIds, pages: layout.pages });
  if (layout.variantValue === null) return strict; // the selected variant IS a Default variant
  const dflt = profile.layoutFor(family); // no type value → the value-less Default variant, if the family has one
  if (!dflt || dflt.variantValue !== null) return strict;
  const selectedNames = new Set(layout.pages.map((p) => p.name));
  if (dflt.pages.some((p) => selectedNames.has(p.name))) return strict;
  const union = new Set([...selectedIds, ...layoutParamIds(dflt.pages)]);
  const relaxed = resolveBlockVisuals(params, family, served, { layoutParamIds: union, pages: [...layout.pages, ...dflt.pages] });
  const strictKeys = new Set(strict.map((v) => v.key));
  // keep the family's visual order: a strict visual where it exists, else the relaxed one
  return relaxed.flatMap((v) => (strictKeys.has(v.key) ? strict.filter((s) => s.key === v.key) : [v]))
    .concat(strict.filter((s) => !relaxed.some((v) => v.key === s.key)));
}

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

// ── reading a block: geometry and value decoding shared by the classic and the generic response ──

/** Most options one selector lists. The longest real list (a CC list of GLOBAL) has 162 entries; the cap only
 *  keeps a corrupt row from producing an unbounded list. */
export const MAX_ENUM_OPTIONS = 4096;

type EnumOption = { value: number; label: string };

/** The options of a selector over the ordinals `lo..hi`. A label is the device's own list at `v - lo` (a list
 *  starts at the row's first ordinal, not at 0), else the model overlay at `v`, else the bare ordinal. Cut at
 *  MAX_ENUM_OPTIONS (`truncated`). */
function buildEnumOptions(
  lo: number, hi: number, labels: readonly string[] | undefined, overlay: Readonly<Record<number, string>> | undefined
): { options: EnumOption[]; truncated: boolean } {
  const options: EnumOption[] = [];
  let v = lo;
  for (; v <= hi && options.length < MAX_ENUM_OPTIONS; v++) options.push({ value: v, label: labels?.[v - lo] ?? overlay?.[v] ?? String(v) });
  return { options, truncated: v <= hi };
}

/** A selector row read as the wire value `raw`: the ordinal range its options cover, the decoded ordinal, and
 *  whether the reading lies inside the range. An enum-KIND row stores the ordinal; a value above the top ordinal
 *  looks 16-bit scaled and is unscaled onto the ordinal range. A FLOAT row (a float-row selector) always
 *  carries the normalised raw/65534 value, so it is always scaled onto its label range: guessing "ordinal or
 *  scaled" there would read raw 1 (~0.0) as ON. The midpoint raw 32767 (exactly 0.5) rounds up, like Math.round
 *  does for the rest of the decode. */
function decodeSelector(range: Pick<RangeDef, 'kind' | 'displayMin' | 'displayMax' | 'scale' | 'enumCount'>, raw: number): { lo: number; hi: number; value: number; inRange: boolean } {
  if (range.kind === 'float') {
    const lo = Math.round(range.displayMin);
    const hi = Math.round(range.displayMax);
    const value = Math.min(hi, Math.max(lo, Math.round((raw / 65534) * (hi - lo)) + lo));
    return { lo, hi, value, inRange: raw <= 65534 };
  }
  const { lo, hi } = enumOrdinalBounds(range);
  const value = raw > hi ? Math.round((raw / 65534) * (hi - lo)) + lo : raw;
  return { lo, hi, value, inRange: value >= lo && value <= hi };
}

/** The ordinal an editor layout keys a selector param on (a variant's / page's `value` list), read from the raw wire
 *  value `raw` in the block body, for a selector that is NOT served as an enum (an enum entry keys by the value it
 *  decodes). The editor's selector values are ordinals, and the device stores such a selector as one even on a float
 *  row: REVERB_BASETYPE (a `count` float row 0..8) reads raw 6 for base type 6, which its continuous display reading
 *  shows as 0.0007. So the rule is decodeSelector's ordinal rule for any row with a usable span: the raw value when it
 *  lies within the top ordinal, else a 16-bit scaled reading unscaled onto the span — except a reading above the top
 *  ordinal that would unscale onto the BOTTOM one, which is an ordinal the row does not reach: a scaled reading of the
 *  bottom ordinal is exactly 0, so 1..(half an ordinal step) is no plausible scaled reading, while the row's span can
 *  trail the firmware (REVERB_BASETYPE's row ends at 8, the current firmware's Reverb layouts name base types up to
 *  10: raw 9 / 10 are those base types, not a scaled base type 0). An enum row is decoded exactly as decodeSelector
 *  does, an out-of-range reading keying nothing; a row without a usable span (LOOPER_DUB's 0..0 — whether the device
 *  stores that selector as an ordinal or scaled is not verified on hardware), or no row at all, keys by the raw value. A reading that is no wire value (above 65534, not an integer) keys nothing. */
function selectorOrdinal(range: Pick<RangeDef, 'kind' | 'displayMin' | 'displayMax' | 'scale' | 'enumCount'> | undefined, raw: number): number | undefined {
  if (!Number.isInteger(raw) || raw < 0 || raw > 65534) return undefined;
  if (!range) return raw;
  if (range.kind === 'enum') {
    const dec = decodeSelector(range, raw);
    return dec.inRange ? dec.value : undefined;
  }
  const lo = Math.round(range.displayMin);
  const hi = Math.round(range.displayMax);
  if (!(hi > lo) || raw <= hi) return raw;
  const scaled = Math.round((raw / 65534) * (hi - lo)) + lo;
  return scaled === lo ? raw : scaled;
}

/** One continuous param's reading for display (`#displayRow`). `unitSource` / `taperSource` are set for the generic
 *  response only. */
interface DisplayReading {
  value: number; norm: number; unit?: string; min?: number; max?: number; log?: boolean;
  unitSource?: ValueSource; taperSource?: ValueSource;
}

/** Where the row a generic reading is taken from comes from: the applied profile (`fromProfile`, the index entry's
 *  `source`), and the bundled catalog's own row of the param (to tell a field the device supplied from the
 *  catalog's). */
interface RowProvenance { fromProfile: boolean; catalogRow: Readonly<RangeDef> | undefined }

/** What one fn-0x1F read of a block gave, and how its body is laid out. */
interface BlockRead {
  /** The body (one wire value per record, all channels back to back); null when it was not read or failed. */
  values: readonly number[] | null;
  /** The read threw or timed out: `values` is null and this says why. */
  readError?: string;
  /** Active channel (0-3) of a channel-bearing block, as served: the one the status read reported, clamped onto
   *  the channels the body carries. Null when the status read did not report the block, and for a block without
   *  channels. */
  channel: number | null;
  /** One channel slice's width and where the active channel's slice starts. */
  stride: number;
  base: number;
  /** The body is indexed by param id: every informative row of the family lies inside one slice. */
  positional: boolean;
}

/** What the two response builders share about the block they serve. */
interface BlockContext {
  family: string;
  slug: string;
  blockName: string;
  page: number;
  hasChannels: boolean;
  read: BlockRead;
}

/** What a param's slot of the read holds (a wire value), or the reason it holds nothing usable. */
function readSlot(read: BlockRead, hasChannels: boolean, pid: number): number | UnresolvedReason {
  if (!read.values) return 'read-failed';
  if (!read.positional) return 'non-positional';
  if (hasChannels && read.channel === null) return 'channel-unknown';
  const at = read.base + pid;
  return pid >= read.stride || at >= read.values.length ? 'not-in-body' : read.values[at]!;
}

/** The value of the `FORGEFX_DEFS_FORCE_GENERIC` hook, parsed: family → pids, plus the entries that did not
 *  parse. Entries are comma-separated. `FAMILY:pid` names a family (upper case, as the catalogs spell it) and a
 *  pid; a bare `pid` adds one more pid to the family named just before it (`DELAY:3,5, CHORUS:8`). Anything
 *  else is malformed and ignored: `CHORUS:8:9`, a lower-case family, a pid that is not a wire parameter, a
 *  bare pid with no family before it, or one right after a malformed entry. */
export function parseForcedGeneric(raw: string): { pids: ReadonlyMap<string, ReadonlySet<number>>; malformed: string[] } {
  const pids = new Map<string, Set<number>>();
  const malformed: string[] = [];
  let family: string | undefined;
  for (const token of raw.split(',')) {
    const entry = token.trim();
    if (entry === '') continue;
    const m = /^(?:([A-Z][A-Z0-9_]*):)?(\d{1,5})$/.exec(entry);
    const fam = m ? m[1] ?? family : undefined;
    const pid = m ? Number(m[2]) : NaN;
    if (fam === undefined || !(pid <= MAX_WIRE_PID)) {
      malformed.push(entry);
      family = undefined; // a bare pid after a malformed entry has no family to join
      continue;
    }
    family = fam;
    let set = pids.get(fam);
    if (!set) pids.set(fam, (set = new Set()));
    set.add(pid);
  }
  return { pids, malformed };
}

/** The last hook value parsed (re-parsed only when the variable changes, so a malformed value warns once). */
let forcedGeneric: { raw: string; pids: ReadonlyMap<string, ReadonlySet<number>> } | undefined;

/** Name of the diagnostic hook's environment variable. */
export const FORCE_GENERIC_ENV = 'FORGEFX_DEFS_FORCE_GENERIC';

/** Diagnostic hook, off by default: pids to serve as generic params whatever the catalog names them, from
 *  `FORGEFX_DEFS_FORCE_GENERIC` (see parseForcedGeneric; for testing only). Read through a guarded process
 *  access: a browser runtime has none and never forces anything. Like every development hook it needs the explicit
 *  opt-in `FORGEFX_DEV_HOOKS=1` and is ignored when `NODE_ENV=production` (devHooks.ts `devHookValue`). */
function forcedGenericPids(family: string): ReadonlySet<number> | undefined {
  const raw = devHookValue(processEnv(), FORCE_GENERIC_ENV);
  if (!raw) return undefined;
  if (forcedGeneric?.raw !== raw) {
    const parsed = parseForcedGeneric(raw);
    if (parsed.malformed.length > 0) {
      console.warn(`[forgefx] ${FORCE_GENERIC_ENV}: ignored malformed ${parsed.malformed.length === 1 ? 'entry' : 'entries'} ${parsed.malformed.map((e) => JSON.stringify(e)).join(', ')} (expected FAMILY:pid[,pid...])`);
    }
    forcedGeneric = { raw, pids: parsed.pids };
  }
  return forcedGeneric.pids.get(family);
}

/** The meta every generic param carries besides its value (the `unresolved` reason is added by the caller). */
function paramMetaOf(e: ParamEntry): ParamMeta {
  return {
    kind: e.kind,
    source: e.source,
    generic: e.generic,
    ...(e.isNew ? { isNew: true as const } : {}),
    ...(e.pageHint ? { pageHint: e.pageHint } : {}),
    nameSource: e.nameSource,
    ...(e.nameConfidence ? { nameConfidence: e.nameConfidence } : {}),
    ...(e.movedFrom !== undefined ? { movedFrom: e.movedFrom } : {}),
    fp: e.fp,
    widget: e.widget,
    widgetSource: e.widgetSource,
    write: e.write,
    ...(e.readOnlyReason ? { readOnlyReason: e.readOnlyReason } : {}),
    ...(e.step !== undefined ? { step: e.step } : {}),
  };
}

/** A layout button symbol `<F>_BTN_<X><n>` and the served param `<F>_<X><n>` it presses (`CABINET_BTN_MUTE1` →
 *  `CABINET_MUTE1`). The button's own `paramId` is an editor pseudo id and stays as it is. */
const BUTTON_SYMBOL = /^([A-Z0-9]+)_BTN_([A-Z]+\d*)$/;

/** Layout widgets that only display a value (a button is excluded: a scene-ignore button writes its param). */
const DISPLAY_ONLY_WIDGETS: ReadonlySet<string> = new Set(['meter', 'readout', 'label', 'graph', 'spacer']);

/** A copy of `layout` with every control passed through `fn`. A control `fn` returns as it is stays shared, and
 *  so does every row, page and layout in which nothing changed. */
function mapLayoutControls(layout: DeviceLayout, fn: (c: DeviceLayoutControl) => DeviceLayoutControl): DeviceLayout {
  let touched = false;
  const pages = layout.pages.map((page) => {
    let pageTouched = false;
    const rows = page.rows.map((row) => {
      let rowTouched = false;
      const controls = row.controls.map((c): DeviceLayoutControl => {
        const out = fn(c);
        if (out !== c) rowTouched = true;
        return out;
      });
      if (!rowTouched) return row;
      pageTouched = true;
      return { ...row, controls };
    });
    if (!pageTouched) return page;
    touched = true;
    return { ...page, rows };
  });
  return touched ? { ...layout, pages } : layout;
}

/** The fn 0x13 status dump read: effect id → bypass flag and active channel (0-3). */
type StatusMap = Map<number, { bypassed: boolean; channel: number }>;

class Gen3Driver implements DeviceDriver {
  #prof: DeviceProfile;
  #codec: ModernFractalCodec;
  #ctx: DriverCtx;
  readonly capabilities: DriverCapabilities;

  /** Store-ack evidence scope for THIS model (see STORE_ACK_EVIDENCE). */
  readonly storeAckScope: StoreAckScope | undefined;
  /** An INJECTED evidence level (tests / a hardware run): overrides the table, scope included. */
  readonly storeAckOverride: StoreAckEvidence | undefined;

  constructor(profile: DeviceProfile, ctx: DriverCtx, opts: { storeAck?: StoreAckEvidence } = {}) {
    this.storeAckScope = STORE_ACK_EVIDENCE[profile.model];
    this.storeAckOverride = opts.storeAck;
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
      // FM3 only: the `sub 0x23` graph-curve reply was observed on the FM3; the FM9 / Axe-Fx III share
      // the codec but no reply was captured from either, so the route stays 501 there until one is.
      telemetry: { tuner: true, outputMeters: true, cpu: true, graphCurves: profile.model === 0x11 },
      fcModel: !!profile.fcModel,
      fcLiveRead: !!profile.fcModel?.liveState,
      modBind: !!profile.modModel,
      cabIrs: Object.keys(profile.cabIrs()).length > 0,
      editorLayouts: true, // FM3 / FM9 / Axe-Fx III all ship *_LAYOUTS (profile.layoutFor)
      // Read-only block visuals (blockParams `visuals` + stamped layout graph slots): every model this
      // driver serves has a catalog the codec's role tables resolve against.
      blockVisuals: hasBlockVisuals(profile.model),
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
      deviceEditWatch: profile.model === 0x11 && process.env.FORGEFX_FM3_EDITSYNC !== '0',
      // Scene Ignore + Bypass Mode tagged on the block-params response (codec blockStateParams: III/FM3/FM9).
      blockState: hasBlockStateParams(profile.model)
    };
  }

  get modelId() { return this.#prof.model; }
  get key() { return this.#prof.key; }
  get name() { return this.#prof.name; }
  get profile() { return this.#prof; }
  /** Stored preset slots: 1024 on the Axe-Fx III, 512 on the FM3 / FM9. Slot-addressed routes validate
   *  against this. These numbers MIRROR the codec's per-model `preset_count` (forgefx-midi
   *  devices/gen3/configs/*), but that field is not exported — so they are hard-coded here. FOLLOW-UP:
   *  export `preset_count` from the codec and read it from the profile instead of this model-byte switch. */
  get presetCount(): number { return this.#prof.model === 0x10 ? 1024 : 512; }

  /** Adopt a device-cache-derived runtime profile (device-true rosters / enum labels / ranges). The
   *  model byte is unchanged so the codec bound at construction stays valid; only the data the reads
   *  resolve through (#prof) is swapped. Idempotent — re-applying a fresh profile just replaces it. */
  applyRuntimeProfile(profile: DeviceProfile): void {
    this.#prof = profile;
    this.#nonPositional.clear(); // the new rows may lay a family out differently
    this.#runtimeLikely.clear(); // a runtime bulk-shape match was made against the old profile's sections
    this.#noteUnmappedChange(); // the new profile may describe a placed block the old one did not (or the reverse)
  }

  /** Effect ids whose last generic block read matched exactly one editor-cache section by its bulk shape (the runtime
   *  `likely`, never persisted): param writes to them are refused (contract §3.4) without a fresh read. Forgotten on a
   *  profile swap and a new session. */
  #runtimeLikely = new Map<number, number>();

  #gridCache: { grid: PresetGridDTO; at: number; gen: number } | null = null;
  #gridInflight: Promise<PresetGridDTO> | null = null;
  /** Bumped by every grid-changing write / preset switch (#invalidateGrid). A cached or in-flight read carries the
   *  generation it STARTED in, so "was this read taken after the last write?" is a plain comparison. */
  #gridGen = 0;
  #gridInflightGen = 0;
  static GRID_TTL_MS = 500; // coalesce the grid()+presetBlocks() burst on a single load
  #invalidateGrid(): void { this.#gridCache = null; this.#gridGen++; }

  #conn() { return this.#ctx.transport(); }
  #emit: DriverCtx['emit'] = (e) => this.#ctx.emit(e);

  /** fn-0x1F channel-block geometry for a family: one channel's slice width, how many channels the
   *  body carries, and where the active channel's slice starts.
   *
   *  The profile's table stride is only a hint. A static catalog stride was measured on one firmware
   *  (and some were never confirmed on the device they ship for), and a walk-built stride is the
   *  number of records the walk managed to collect, not the section's true width. A wrong stride is
   *  silent and destructive: base = channel x stride lands mid-way through an EARLIER channel's slice,
   *  so every param read for channels B-D, the amp model included, is a real, valid-looking value
   *  from the wrong param.
   *
   *  The reply is the tiebreaker. The body is whole channel slices back to back (at most A-D), so
   *  itemCount = channels x stride, and a stride only counts when it divides itemCount into 1-4
   *  slices. That also rejects a short stride that merely happens to divide the body, because it
   *  would imply more than four channels. Order of preference:
   *    1. the table stride, when the reply agrees with it (or advertised no count at all);
   *    2. itemCount / 4, the four-channel layout of a channel-bearing block;
   *    3. one slice spanning the whole body (a block that is not channel-blocked; only channel A is
   *       real there, so base stays 0).
   *  `channelBlocked: false` (the virtual effects GLOBAL / CONTROLLERS / MODIFIER / FC, which have no
   *  channels A-D) skips all of that: the whole body is the one slice. Dividing it by four, or trusting
   *  a drifted table stride, would shrink the slice and make decodeEditBurst drop every device edit
   *  from that paramId on. */
  #channelSlice(
    family: string | undefined,
    bulk: { itemCount: number; values: readonly number[] },
    activeChannel: number,
    channelBlocked = true,
  ): { stride: number; channelCount: number; base: number } {
    if (!channelBlocked) return { stride: Math.max(1, bulk.values.length), channelCount: 1, base: 0 };
    const MAX_CHANNELS = 4;
    const tableStride = family ? this.#prof.rangeSections[family]?.stride : undefined;
    const tableFits = !!tableStride && tableStride > 0
      && (bulk.itemCount <= 0 || (bulk.itemCount % tableStride === 0 && bulk.itemCount / tableStride <= MAX_CHANNELS));
    const stride = tableFits
      ? tableStride!
      : bulk.itemCount > 0 && bulk.itemCount % MAX_CHANNELS === 0
        ? bulk.itemCount / MAX_CHANNELS
        : Math.max(1, bulk.values.length);
    const basis = bulk.itemCount > 0 ? bulk.itemCount : bulk.values.length;
    const channelCount = Math.max(1, Math.floor(basis / stride));
    return { stride, channelCount, base: Math.min(activeChannel, channelCount - 1) * stride };
  }

  /** Fire-and-forget write, serialized on the request chain (so it never injects mid-read). */
  async #send(bytes: number[]): Promise<{ ok: boolean }> {
    await (await this.#conn()).sendQueued(bytes);
    return { ok: true };
  }

  /** Write + watch a short window for a 0x64 rejection. For structural ops where a reject matters.
   *  The device answers an accepted write with silence and a refused one with a 0x64 MULTIPURPOSE_RESPONSE
   *  `[echoedFn, resultCode]`, so only a 0x64 from this model echoing THIS write's function is its refusal (one
   *  too short to carry a function counts, conservatively). A foreign 0x64 — a late refusal of another
   *  operation — neither ends the window nor fails the write.
   *  `rejectOnly`: silence until the window closes is the success outcome, so the transport neither warns nor
   *  holds the link for a late reply after it; a browser-direct transport that still reports the silence as
   *  a typed timeout gets the same answer. */
  async #write(bytes: number[]): Promise<{ ok: boolean }> {
    const dev = await this.#conn();
    const model = bytes[4]!;
    const fn = bytes[5];
    const isOwnRejection = (f: number[]) => isMultipurposeResponse(f, model) && (f.length < 9 || f[6] === fn);
    // The device's synchronous echo of THIS write — a SET's value echo carries the same function, sub-action,
    // effect id and param id (bytes 6-11). A frame byte-identical to the request is our own write coming back
    // (loopback), not an echo. The echo is OWNED, not a match: whether a device ever echoes a write it then
    // refuses is not known, so after an echo the write stays open for its quiet gap (half the window) and a
    // refusal of its function arriving in that time is still this write's; then it ends as accepted, earlier
    // than the full window.
    const sameAsRequest = (f: number[]) => f.length === bytes.length && f.every((b, i) => b === bytes[i]);
    const isOwnEcho = (f: number[]) =>
      bytes.length >= 14 && f.length >= 14 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74
      && f[4] === model && f[5] === fn && [6, 7, 8, 9, 10, 11].every((i) => f[i] === bytes[i]) && !sameAsRequest(f);
    // A slow link (5-pin DIN) needs a longer refusal window: the request itself takes ~10-20 ms on the wire.
    const timeoutMs = dev.slow ? 250 : 120;
    let frames: number[][];
    try {
      frames = await dev.request(bytes, {
        timeoutMs,
        quietMs: timeoutMs / 2,
        rejectOnly: true,
        match: (fs) => fs.some(isOwnRejection),
        owns: isOwnEcho
      });
    } catch (e) {
      if (isTransportTimeout(e)) return { ok: true }; // silence: accepted
      throw e;
    }
    return { ok: !frames.some(isOwnRejection) };
  }

  /** One fn-0x1F bulk read of block `eid`: the burst whose 0x74 head names `eid` (bulkReadFrames), never another
   *  block's late burst. Its head and bodies are owned, so a burst whose 0x76 is lost still ends one quiet gap
   *  after its last body (and the transport drains the rest) instead of waiting the full timeout. */
  async #bulkRead(dev: Transport, eid: number, timeoutMs: number, quietMs: number, routine = false): Promise<number[][]> {
    const model = this.#prof.model;
    let inOurs = false;
    const frames = await dev.request(this.#codec.buildBlockBulkReadPoll(eid), {
      timeoutMs,
      quietMs,
      routine,
      match: (fs) => bulkReadSpan(fs, model, eid) !== null,
      owns: (f) => {
        if (isFrameOf(f, model, 0x74)) return (inOurs = isBulkHeadFor(f, model, eid));
        return inOurs && isFrameOf(f, model, 0x75);
      }
    });
    return bulkReadFrames(frames, model, eid);
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
    if (r.presetNumber >= 0) this.#session(dev).currentSlot = r.presetNumber;
    return { number: r.presetNumber, name: r.name };
  }

  /** Routing grid via the hardware-validated dump decoder. Deduped + short-TTL cached. */
  async grid(): Promise<PresetGridDTO> {
    if (this.#gridInflight) return this.#gridInflight; // coalesce concurrent callers
    if (this.#gridCache && Date.now() - this.#gridCache.at < Gen3Driver.GRID_TTL_MS) return this.#gridCache.grid;
    const gen = this.#gridGen;
    this.#gridInflight = this.#dumpGrid();
    this.#gridInflightGen = gen;
    try {
      const g = await this.#gridInflight;
      this.#gridCache = { grid: g, at: Date.now(), gen };
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
    // Only a whole dump counts (a 0x77 header through the 0x79 after it — a tail never does), and which header
    // is acceptable is per model (DUMP_HEADER_POLICY): a late whole dump of another slot decoded as this one
    // shifted every later slot by one in a library scan.
    const slow = dev.slow;
    const model = this.#prof.model;
    const what = target === EDIT_BUFFER ? 'edit buffer' : `slot ${target}`;
    let partial: number[][] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {

      const plan = this.#dumpHeaderPlan(dev, target);
      // The FM3 can pause for several hundred ms between the 0x77 header and its first 0x78 chunk (and
      // needs ~5 s before it starts at all when its queue is busy). A 180 ms quiet gap aborted such a
      // dump mid-read, retried, and piled another transfer onto the device's queue - which then starved
      // every later slot. The 0x79 `settles` still ends a whole dump immediately.
      const frames = await dev.request(this.#codec.buildRequestPresetDump(target), presetDumpOpts(model, plan, slow ? 25000 : 5000, slow ? 1500 : 180));
      let whole = wholeDumps(frames, model, plan.named)[0];
      if (whole && headerNamesRequest(dumpHeaderNumber(whole[0]!), target)) this.#session(dev).learned.add(target === EDIT_BUFFER ? 'edit' : 'stored');
      if (!whole && plan.check === 'prefer') {
        whole = wholeDumps(frames, model, plan.usable).at(-1);
        if (whole) this.#noteDumpHeader(what, dumpHeaderNumber(whole[0]!));
      }
      if (whole && whole.some((f) => f[5] === 0x78)) return whole;
      // keep what started (from the last usable header) for the decoder's error message
      let last = -1;
      frames.forEach((f, i) => { if (isFrameOf(f, model, 0x77) && plan.usable(f)) last = i; });
      partial = last < 0 ? [] : dumpFramesOnly(frames.slice(last), model);
      console.log(`[forgefx] presetDump: incomplete ${what} attempt ${attempt}/3 (frames=${frames.length}, header=${last >= 0}, 0x78=${partial.some((f) => f[5] === 0x78)}, 0x79=${partial.some((f) => f[5] === 0x79)}) — retrying`);
    }
    return partial; // still incomplete → let decodePresetDump throw its clear error
  }
  /** Log ONCE per driver and kind of read that a 'prefer' dump read fell back to a dump whose header names
   *  another preset number — the evidence needed to tighten DUMP_HEADER_POLICY for this model. */
  #noteDumpHeader(what: string, named: number): void {
    const kind = what === 'edit buffer' ? what : 'stored slot';
    if (this.#dumpHeaderNoted.has(kind)) return;
    this.#dumpHeaderNoted.add(kind);
    const n = EDIT_BUFFER_HEADERS.includes(named) ? `the edit buffer (0x${named.toString(16)})` : `slot ${named}`;
    console.warn(`[forgefx] presetDump: ${what} read answered by a dump whose header names ${n} — used it (no dump naming the request arrived; header check is lenient for model 0x${this.#prof.model.toString(16)}). Logged once.`);
  }
  #dumpHeaderNoted = new Set<string>();

  /** What the driver learned about THIS connection (reset on reconnect — a new transport — and on re-detect,
   *  see resetSession): which dump-read kinds the device has proven to name the requested number in their
   *  header, and the current slot when the driver knows it (set by presetRef / selectPreset). */
  #sessionState: { transport: Transport; learned: Set<'stored' | 'edit'>; currentSlot: number | null } | null = null;
  #session(dev: Transport) {
    if (this.#sessionState?.transport !== dev) {
      this.#sessionState = { transport: dev, learned: new Set(), currentSlot: null };
      // a new connection: the placed blocks read on the old one say nothing about this one
      if (this.#lastPlaced && this.#lastPlaced.transport !== dev) { this.#lastPlaced = null; this.#unmappedSig = ''; }
    }
    return this.#sessionState;
  }
  /** A fresh detect (a reconnect, a port or model switch): forget what was learned about the connection, including
   *  the placed blocks of the last grid read. */
  resetSession(): void {
    this.#sessionState = null;
    this.#lastPlaced = null;
    this.#unmappedSig = '';
    this.#runtimeLikely.clear();
  }
  /** How a dump read of `target` judges headers on this connection. Starts from DUMP_HEADER_POLICY; a
   *  'prefer' kind becomes 'strict' once the device has named the requested number in a header (so a late dump
   *  of another slot can never be used as a fallback again). An edit-buffer read is named by any of
   *  EDIT_BUFFER_HEADERS (0x3FFF, 0x3F80) — proof of the convention — and also by a header naming the CURRENT
   *  slot when the driver knows it, which does not count as proof (a front-panel preset change can make the
   *  known slot stale). */
  #dumpHeaderPlan(dev: Transport, target: number): DumpHeaderPlan {
    const s = this.#session(dev);
    const base = dumpHeaderCheck(this.#prof.model, target);
    const kind = target === EDIT_BUFFER ? 'edit' : 'stored';
    const check: DumpHeaderCheck = base === 'prefer' && s.learned.has(kind) ? 'strict' : base;
    const current = target === EDIT_BUFFER ? s.currentSlot : null;
    const named = (h: number[]) => {
      if (check === 'any') return true;
      const n = dumpHeaderNumber(h);
      return headerNamesRequest(n, target) || (current !== null && n === current);
    };
    // Fallback candidates under 'prefer': any other header — except that a stored-slot read never takes a dump
    // whose header is an edit-buffer value (a late grid() dump is not slot n).
    const usable = (h: number[]) =>
      named(h) || (check === 'prefer' && (target === EDIT_BUFFER || !EDIT_BUFFER_HEADERS.includes(dumpHeaderNumber(h))));
    return { check, named, usable };
  }

  /** Routing grid of ONE STORED SLOT (GET /presets/:n/grid): the dump the device returns for slot `n`,
   *  decoded exactly like the edit-buffer grid. Deliberately bypasses `#gridCache`/`#gridInflight` —
   *  those are keyed on the edit buffer, so routing a slot through them would serve one preset's grid
   *  for another (the very confusion this method exists to end). */
  async presetGrid(n: number): Promise<PresetGridDTO> {
    // Concurrent requests for the SAME slot share one dump (a browser can fire several for one slot);
    // nothing is kept once the dump settles, so the next call always reads the device again.
    const inflight = this.#slotGridInflight.get(n);
    if (inflight) return inflight;
    const p = this.#gridFromDump(n).finally(() => { this.#slotGridInflight.delete(n); });
    this.#slotGridInflight.set(n, p);
    return p;
  }
  #slotGridInflight = new Map<number, Promise<PresetGridDTO>>();

  /** `silent`: the read does not announce a changed set of unmapped placed blocks (the next grid read or profile swap
   *  does, since the announced set is left as it was). */
  async #dumpGrid(opts: { silent?: boolean } = {}): Promise<PresetGridDTO> {
    const dev = await this.#conn();
    const g = await this.#gridFromDump(EDIT_BUFFER);
    this.#lastPlaced = { transport: dev, eids: g.cells.filter((c) => !c.isShunt && c.effectId > 0 && c.effectId < GEN3_SHUNT_BASE).map((c) => c.effectId) };
    if (!opts.silent) this.#noteUnmappedChange();
    return g;
  }

  /** Effect ids of the blocks in the edit-buffer grid as last read on `transport` (shunts and empty cells left out),
   *  null before the first read of this session. Forgotten on a (re)detect (`resetSession`: a reconnect, a port or
   *  model switch) and when the connection's transport changes (`#session`). */
  #lastPlaced: { transport: Transport; eids: number[] } | null = null;
  /** The unmapped set the last `definitions`/`unmapped-blocks` event (or the session start) reported, as a key. */
  #unmappedSig = '';

  /** The edit-buffer grid read afresh: one dump read, never the short-TTL cache or a read already in flight. It refreshes
   *  `placedEffectIds` and, unless a grid-changing write landed meanwhile, the grid cache. `silent`: no `definitions` /
   *  `unmapped-blocks` event from this read (it is left to the next grid read or profile swap). */
  async freshGrid(opts: { silent?: boolean } = {}): Promise<PresetGridDTO> {
    const gen = this.#gridGen;
    const g = await this.#dumpGrid(opts);
    if (gen === this.#gridGen) this.#gridCache = { grid: g, at: Date.now(), gen };
    return g;
  }

  /** Effect ids of the blocks in the edit-buffer grid as last read (shunts and empty cells left out), sorted and
   *  unique; null before the first grid read of the session. No device traffic. */
  placedEffectIds(): number[] | null {
    if (!this.#lastPlaced) return null;
    return [...new Set(this.#lastPlaced.eids)].sort((a, b) => a - b);
  }

  /** Effect ids of the last read edit-buffer grid that no param family describes, sorted and unique; null before
   *  the first grid read of the session. No device traffic: the capabilities report the runtime coverage gap
   *  `unmapped-block` from it. A block counts as described when:
   *   - the CURRENT profile resolves it like `blockParams` (the codec's audio-block slug, then the profile's own
   *     effect-id map), or
   *   - the model's STATIC tables place it (`staticFamilyForEffectId`: the static roster's instance slots and
   *     virtual blocks, the catalog's effect-id spans — e.g. an Axe-Fx III fifth Input, or a III roster block such
   *     as Vocoder that gets read-only service, WP-F5), or
   *   - the applied profile document's persisted block map binds it with confidence `confirmed`
   *     (`ProfileFacts.confirmedBlocks`).
   *  Only a block none of these knows (a block a newer firmware added, no confirmed map) is unmapped. */
  unmappedPlacedEffectIds(): number[] | null {
    if (!this.#lastPlaced) return null;
    const model = this.#prof.model;
    const confirmed = this.#prof.profileFacts?.confirmedBlocks;
    const out = new Set<number>();
    for (const eid of this.#lastPlaced.eids) {
      if (confirmed?.has(eid)) continue;
      const family = audioFamilyOf(eid) ?? this.#prof.familyForEffectId(eid) ?? staticFamilyForEffectId(model, eid);
      if (family === undefined) out.add(eid);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** After a grid read or a profile swap: when the unmapped set changed, tell live UIs to re-read the capabilities
   *  (SSE `definitions`, reason `unmapped-blocks`, keyed by the running firmware's profile key). Without a known
   *  firmware there is no profile key and no applied profile, so the set cannot change the drift: nothing is sent. */
  #noteUnmappedChange(): void {
    const sig = (this.unmappedPlacedEffectIds() ?? []).join(',');
    if (sig === this.#unmappedSig) return;
    this.#unmappedSig = sig;
    const fw = this.#ctx.getFirmware?.() ?? null;
    if (fw) this.#emit({ type: 'definitions', reason: 'unmapped-blocks', key: deviceCacheKey(this.#prof.model, fw.major, fw.minor) });
  }

  /** Decode a preset dump (the edit buffer or a stored slot) into the routing-grid DTO. */
  async #gridFromDump(target: number): Promise<PresetGridDTO> {
    const frames = await this.#dumpFrames(target);
    // diagnostic: did the dump arrive? (Windows MIDI large-SysEx debugging) — frame count, the function
    // bytes seen, total bytes, and whether the 0x79 terminator came through.
    const fns = [...new Set(frames.map((f) => f[5]))].map((x) => '0x' + (x ?? 0).toString(16));
    const bytes = frames.reduce((n, f) => n + f.length, 0);
    console.log(`[forgefx] presetDump: frames=${frames.length} bytes=${bytes} fns=[${fns.join(',')}] terminator=${frames.some((f) => f[5] === 0x79)}`);
    const d = decodeDump(frames, this.#prof).dump;
    return {
      model: this.#prof.key, // 'fm3' | 'fm9' | 'axe3' (was a hard-coded 'fm3' for every gen-3 unit)
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

  /** Diagnostic capture: ONE read-only dump request for `target` that accepts ANY whole dump the device
   *  answers with (header check 'any'), so the caller learns which preset number the 0x77 header names —
   *  the evidence DUMP_HEADER_POLICY is tightened on. Unlike #dumpFrames it never retries, never falls back
   *  and does not teach the connection's header strictness. The raw patch is decoded only far enough to
   *  tell an unused slot and to let the caller compare two dumps in memory. */
  async diagnosticDump(target: number | 'edit-buffer'): Promise<DiagnosticDump> {
    const dev = await this.#conn();
    const model = this.#prof.model;
    const requested = target === 'edit-buffer' ? EDIT_BUFFER : target;
    const named = (h: number[]) => headerNamesRequest(dumpHeaderNumber(h), requested);
    const plan: DumpHeaderPlan = { check: 'any', named, usable: () => true };
    const t0 = Date.now();
    const frames = await dev.request(this.#codec.buildRequestPresetDump(requested), presetDumpOpts(model, plan, dev.slow ? 25000 : 5000, dev.slow ? 1500 : 180));
    const ms = Date.now() - t0;
    const whole = wholeDumps(frames, model, named)[0] ?? wholeDumps(frames, model, () => true)[0] ?? null;
    const dumpFrames = whole ?? dumpFramesOnly(frames, model);
    const headerFrame = dumpFrames.find((f) => isFrameOf(f, model, 0x77));
    const chunks = dumpFrames.filter((f) => isFrameOf(f, model, 0x78)).length;
    let patch: DiagnosticDump['patch'] = null;
    let empty: boolean | null = null;
    if (whole && chunks > 0) {
      try {
        const raw = decodeRawPatch(parsePresetDump(dumpBytesFromFrames(whole), 0, model).chunkPayloads);
        empty = raw.empty;
        patch = { raw: raw.rawPatch, body: raw.body };
      } catch { /* undecodable: header facts only */ }
    }
    return {
      requested,
      header: headerFrame ? dumpHeaderNumber(headerFrame) : null,
      complete: !!whole && chunks > 0,
      frames: dumpFrames.length,
      chunks,
      bytes: dumpFrames.reduce((n, f) => n + f.length, 0),
      ms,
      empty,
      patch
    };
  }

  /** Verbatim .syx dump for POST /preset/backup (capability `backupDump`) — the library's
   *  export-to-disk + audition source. Location omitted → the currently selected preset's slot
   *  (gen-3 dumps by slot; the raw edit-buffer stream is a different frame format, not a .syx).
   *  An unused slot is refused (`EmptyPresetError` → 422): its all-zero dump is not a restorable preset. */
  async backupPreset(location?: number): Promise<{ location: number | null; code: string | null; name: string; bytes: number[] }> {
    const n = location ?? (await this.presetRef()).number;
    const { bytes, summary } = await this.dumpRaw(n);
    if (summary.empty) throw new EmptyPresetError();
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
    return {
      number: presetNumber, name: d.name, model: d.modelName, crcValid: d.crcValid, crc: d.crc, scenes: d.sceneNames,
      blocks: [...seen.values()], models, amps: models.amp ?? [],
      ...(d.empty ? { empty: true } : {})
    };
  }

  /** Decompressed preset body as hex — for per-block param-decode RE (diff bodies across known param
   *  changes to locate offsets). Dumps the active edit buffer. */
  async presetBodyHex(): Promise<{ len: number; hex: string }> {
    const frames = await this.#dumpFrames(EDIT_BUFFER); // the same whole-dump matching (and retry) as every dump read
    const parsed = parsePresetDump(dumpBytesFromFrames(frames), 0, this.#prof.model);
    const { body } = decodeRawPatch(parsed.chunkPayloads);
    return { len: body.length, hex: Buffer.from(body).toString('hex') };
  }

  /** Active channel and bypass per placed block, from the fn 0x13 status dump. An EMPTY map means the read
   *  failed: no reply in time, or a reply that lists no block, which a real preset never gives (it always has
   *  its Output blocks). Such a read is re-issued once, shortly after, before giving up: a scene switch leaves
   *  the unit busy for a moment, and a slow link can miss one reply window. The first request waits longer on
   *  a slow link, the retry the normal 1.5 s, so a lost reply costs at most ~5.7 s there before the caller's
   *  next request (the queue is serialised, and Axis gives a request 12 s). The routine channel-watch poll
   *  passes `retry: false`: one request with the fixed 1.5 s it always had (its next tick is the retry). */
  async #statusByEffectId(opts: { retry?: boolean } = {}): Promise<StatusMap> {
    const dev = await this.#conn();
    const retry = opts.retry !== false;
    let map = await this.#readStatusDump(dev, retry && dev.slow ? 4000 : 1500);
    if (map.size === 0 && retry) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      map = await this.#readStatusDump(dev, 1500);
    }
    return map;
  }

  /** The status-dump request in flight, if any, and how long it waits for its reply: a caller that needs the
   *  status while one is pending awaits that request instead of queueing another, as long as it would not wait
   *  longer itself (each caller still decides on its own retry). */
  #statusInflight: { promise: Promise<StatusMap>; timeoutMs: number } | null = null;

  /** One fn 0x13 status-dump request; an empty map when it failed or timed out. A request already in flight is
   *  joined when its timeout is at least `timeoutMs`. A caller that waits longer (the first request of a block
   *  read on a slow link, 4 s, while the channel-watch poll's 1.5 s request is pending) issues its own, which the
   *  serialised queue sends after the pending one: joining would cut its wait short exactly when the unit is
   *  busy (after a scene switch). Later callers then join the longer request. */
  #readStatusDump(dev: Transport, timeoutMs: number): Promise<StatusMap> {
    const pending = this.#statusInflight;
    if (pending && pending.timeoutMs >= timeoutMs) return pending.promise;
    const p: Promise<StatusMap> = this.#requestStatusDump(dev, timeoutMs).finally(() => {
      if (this.#statusInflight?.promise === p) this.#statusInflight = null;
    });
    this.#statusInflight = { promise: p, timeoutMs };
    return p;
  }

  async #requestStatusDump(dev: Transport, timeoutMs: number): Promise<StatusMap> {
    const map: StatusMap = new Map();
    try {
      // fractal-midi's isStatusDumpResponse is locked to model 0x10 (III), so match the
      // 0x13 frame ourselves (any model) and parse the id-id-dd triples inline.
      // fn-only matcher: the status dump carries no request id (polled by the channel watch)
      const frames = await dev.request(this.#codec.buildStatusDump(), { timeoutMs, routine: true, match: (fs) => fs.some((f) => f[5] === 0x13) });
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
   *  Feeds the registry's front-panel channel-change watch. One small round-trip (a failed one is not
   *  repeated: the watch skips an empty answer and asks again on its next tick). */
  async getActiveChannels(): Promise<Map<number, number>> {
    const status = await this.#statusByEffectId({ retry: false });
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
    // A scene switch leaves the unit busy rebuilding for a moment, so the first status read can come back
    // empty even though the device is fine. #statusByEffectId retries once shortly after before treating it
    // as a failure — the alternative (503 → the client's full preset dump) lands on the device exactly while
    // it is rebuilding.
    const status = await this.#statusByEffectId();
    // An EMPTY status map means the fn-0x13 read failed/timed out (#statusByEffectId swallows the
    // error). A real preset always has ≥ Output blocks, so `[]` can never be a legitimate scene state —
    // returning it made the route answer 200 `[]` and Axis kept the previous scene's bypass/channel
    // forever. Throw so the route maps it to 503 and Axis's `.catch(() => null) → load()` fallback fires.
    if (status.size === 0) throw new Error('scene-state read failed (no status dump from the device)');
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
   *
   * Two responses share one read. The classic one (default) lists the catalog's dials and selectors and always
   * carries numbers; a value that had to be invented (a zero for a position the read did not cover, a guessed
   * channel, a family whose body is not indexed by param id) keeps its number and gains `unresolved`. The generic
   * one (`opts.generic`) lists every param the block has on the connected device (see buildParamIndex), serves
   * `null` plus the `unresolved` reason where no value could be resolved, and adds a `definitions` block.
   */
  blockParams(eid: number): Promise<BlockParamsDTO>;
  blockParams(eid: number, opts: BlockParamsOpts & { generic: true }): Promise<BlockParamsV2DTO>;
  blockParams(eid: number, opts?: BlockParamsOpts): Promise<BlockParamsDTO | BlockParamsV2DTO>;
  async blockParams(eid: number, opts?: BlockParamsOpts): Promise<BlockParamsDTO | BlockParamsV2DTO> {
    // A background read (observe === false) must not retarget the device-edit watch: only the block the user has open is watched.
    const observe = opts?.observe !== false;
    if (observe) this.#watchedEid = eid; // this is the block the user has open → the target the FM3 device-edit poll re-reads
    const generic = opts?.generic === true;
    const codecSlug = slugForEffectId(eid) ?? ''; // audio blocks resolve via the codec
    // virtual effects (GLOBAL=1, Controllers=2, Modifier=3, FC=199) resolve via the profile's effectId map, and so do a
    // block the effect-id table names from the roster only and one the applied document's block map binds
    const { audio, family, mapEntry } = this.#resolveBlock(eid);
    // a block the catalog cannot place on its own: a roster-only family, a block-map binding, or no family at all
    if (generic && !audio && (mapEntry !== undefined || family === undefined)) return this.#paramsMapped(eid, family, mapEntry);
    const hasChannels = !!audio; // an audio block; the virtual effects have no channels A-D
    const meta = BLOCK_META[codecSlug];
    const page = meta?.page ?? -1;
    // no device-true param family mapped — and the classic response serves a block the block map binds the same way
    // (nothing listed, nothing read); a roster-only family (named in the catalog) is served like any family, its
    // writes are refused (#guardParamWrite). Known follow-up: the classic response reads a roster-only block as one
    // slice (`hasChannels` false, no audio slug), so for a channel-bearing one it shows channel A's values; the generic
    // response decides channels from the bulk shape (#paramsMapped).
    if (!family || (mapEntry !== undefined && mapEntry.confidence !== 'roster')) {
      return { block: meta?.name ?? codecSlug, slug: codecSlug, page, named: [], enums: [], type: null, layout: undefined };
    }
    const slug = codecSlug || family.toLowerCase(); // virtual effects key on the family name
    const blockName = meta?.name ?? family;
    const forced = generic ? forcedGenericPids(family) : undefined;
    const index = buildParamIndex(this.#prof, family, forced ? { forceGeneric: forced } : undefined);
    // GLOBAL's body holds one record per param, not one per pid: the generic response can resolve no value from
    // it (every one is `non-positional`), so it is not read at all. The classic response still reads it.
    const read = generic && family === 'GLOBAL' && !hasChannels && index.positional === false
      ? this.#unreadNonPositional(eid)
      : await this.#readBlock(eid, family, hasChannels, index, observe);
    const shared = { family, slug, blockName, page, hasChannels, read };
    return generic ? this.#paramsGeneric(shared, index) : this.#paramsClassic(shared, index);
  }

  /** A block read that was skipped because its body says nothing about any pid: no values to resolve, and none
   *  to watch for device edits. */
  #unreadNonPositional(eid: number): BlockRead {
    this.#nonPositional.add(eid);
    return { values: [], channel: null, stride: 0, base: 0, positional: false };
  }

  /** The block's status (active channel) and its fn-0x1F body, sliced to the active channel. Primes the
   *  device-edit baseline of a block whose body is indexed by param id; a family whose body is not (GLOBAL: one
   *  record per param, in id order) has no per-param information to diff and is never watched. */
  async #readBlock(eid: number, family: string, hasChannels: boolean, index: BlockIndex, observe = true): Promise<BlockRead> {
    const dev = await this.#conn();
    let channel: number | null = null;
    try {
      // Read the block's CURRENT channel (A-D) so a channel switch actually reloads that channel's
      // params/type: the fn-0x1F body is channel-blocked and holds ALL channels, so we must slice the
      // active one, not always channel A. Costs one status round-trip per open — worth it for correctness.
      // A block without channels (the virtual effects: GLOBAL, CONTROLLERS, MODIFIER, MIDI block, FC) is one
      // slice: its status says nothing the read needs, so it is not asked for.
      const status = hasChannels ? (await this.#statusByEffectId()).get(eid) : undefined;
      channel = status ? status.channel : null;
      const activeCh = status?.channel ?? 0;
      if (observe) this.#watchedChannel = activeCh; // keep the device-edit-burst diff on the same channel (see decodeEditBurst)
      const frames = await this.#bulkRead(dev, eid, dev.slow ? 8000 : 2500, dev.slow ? 600 : 120);
      const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
      const { stride, base, channelCount } = this.#channelSlice(family, bulk, activeCh, hasChannels);
      // the channel whose values are served: the reported one, clamped onto the channels the body carries
      if (channel !== null) channel = Math.min(channel, channelCount - 1);
      const positional = this.#isPositional(index, bulk, stride, hasChannels);
      if (positional) {
        // Prime the device-edit-push baseline with the OPEN channel's values so a later front-panel
        // edit's burst diffs cleanly to the moved param (no first-sight reload — see decodeEditBurst).
        this.#editSnapshot.set(eid, bulk.values.slice(base, base + stride));
        this.#nonPositional.delete(eid);
      } else {
        this.#nonPositional.add(eid);
      }
      return { values: bulk.values, channel, stride, base, positional };
    } catch (e) {
      return { values: null, readError: e instanceof Error ? e.message : String(e), channel, stride: 0, base: 0, positional: index.positional ?? false };
    }
  }

  /** Is a family's body indexed by param id, i.e. does one channel slice hold every informative row? Either the
   *  section stride the profile carries says so (the index's own answer) or the slice the reply actually shows
   *  does: a table stride is only a hint (see #channelSlice) and may be too short for the connected firmware, and
   *  a short body leaves the high pids `not-in-body`, not the family unreadable. A block without channels is one
   *  slice, as wide as the body the device advertised. GLOBAL (pids up to 14879 over a 136-record body) is
   *  neither. */
  #isPositional(index: BlockIndex, bulk: { itemCount: number }, stride: number, hasChannels: boolean): boolean {
    return index.positional === true || index.maxPid < Math.max(stride, hasChannels ? 0 : bulk.itemCount);
  }

  // ── blocks the catalog cannot place on its own (contract M3 §3.3/§3.4) ──

  /** How a block address resolves: its audio family (the codec's block roster), else the profile's family (static
   *  effect-id table, the block-map overlay of a confirmed binding) or the family of a roster-only entry (every reserved
   *  instance slot of an Axe-Fx III roster family); `mapEntry` = the block-map entry of a block the catalog cannot place
   *  on its own (`DeviceProfile.blockMapFor`), never for an audio block. */
  #resolveBlock(eid: number): { audio: string | undefined; family: string | undefined; mapEntry: BlockMapEntry | undefined } {
    const audio = audioFamilyOf(eid);
    if (audio !== undefined) return { audio, family: audio, mapEntry: undefined };
    const mapEntry = this.#prof.blockMapFor?.(eid);
    const rosterFamily = mapEntry?.confidence === 'roster' && mapEntry.key !== null ? mapEntry.key : undefined;
    return { audio, family: this.#prof.familyForEffectId(eid) ?? rosterFamily, mapEntry };
  }

  /**
   * The generic response of a block the catalog cannot place on its own:
   *   - a family the model's effect-id table names from the roster only (Axe-Fx III, FORGEFX-45): its named catalog
   *     params, read-only (`unconfirmed-block`); not an unknown block;
   *   - a block the applied document's block map binds `confirmed`: the params of the entry's key (generic for a
   *     `section:<tag>` / `block:<eid>` key, named for a catalog family), writable when byte-bridged, read-only
   *     (`live-only-block`) when known from a live read only;
   *   - any other block without a family: matched by its bulk read against the applied document's editor-cache
   *     sections a block may bind to (`matchBulkShape`): exactly one fits → `likely`, the section's params read-only
   *     (`unconfirmed-block`); several → `candidates`, nothing listed; none, or no section to match → `none`, nothing
   *     listed. Without such a section nothing is read at all.
   * Every one carries `definitions.blockMap` (state per drivers/blockMapState.ts, the probe's availability); every one
   * but the roster family is an `unknownBlock` named `Block <eid>`. Channels of a non-audio block come from its bulk
   * shape (one slice or four), else from its status entry; unknown → every value `channel-unknown`.
   */
  async #paramsMapped(eid: number, family: string | undefined, entry: BlockMapEntry | undefined): Promise<BlockParamsV2DTO> {
    const roster = entry?.confidence === 'roster';
    const probe = this.#probeAvailability(eid);
    // a known family (roster-only, or a confirmed block-map binding with rows)
    if (family !== undefined && entry !== undefined && (roster || entry.confidence === 'confirmed')) {
      const access = blockMapAccess(entry);
      const forced = forcedGenericPids(family);
      const index = buildParamIndex(this.#prof, family, forced ? { forceGeneric: forced } : undefined);
      // a family that lists nothing (the III's IR Capture: no catalog section) has nothing a read could resolve
      const shaped = index.entries.length === 0
        ? { read: this.#unreadNonPositional(eid), hasChannels: false }
        : await (async () => {
          const raw = await this.#readRaw(eid);
          return this.#sliceShaped(eid, raw, family, index, 'error' in raw ? null : shapeChannels(raw.bulk.itemCount, this.#prof.rangeSections[family]?.stride) ?? (raw.channel !== null ? true : null));
        })();
      const codecSlug = slugForEffectId(eid) ?? '';
      const meta = BLOCK_META[codecSlug];
      const ctx: BlockContext = roster
        ? { family, slug: codecSlug || family.toLowerCase(), blockName: meta?.name ?? family, page: meta?.page ?? -1, hasChannels: shaped.hasChannels, read: shaped.read }
        : { family, slug: '', blockName: `Block ${eid}`, page: -1, hasChannels: shaped.hasChannels, read: shaped.read };
      const blockMap: BlockMapMeta = {
        state: access.state, key: family, sectionTag: entry.sectionTag, evidence: [...entry.evidence],
        ...(entry.candidates ? { candidates: [...entry.candidates] } : {}), probe
      };
      return this.#withBlockMap(this.#paramsGeneric(ctx, index), { unknown: !roster, access, blockMap });
    }
    // no family: the runtime bulk-shape match against the applied document's editor-cache sections
    const sections = this.#bindableSections();
    const persisted = entry?.confidence === 'candidate' && entry.candidates && entry.candidates.length > 0 ? entry : undefined;
    const noInfo = (readError?: string): BlockParamsV2DTO => {
      // a failed read says nothing new: a refusal earned by an earlier read (`likely`) stands until a read settles it
      if (readError === undefined) this.#runtimeLikely.delete(eid);
      const blockMap: BlockMapMeta = persisted
        ? { state: 'candidates', key: null, sectionTag: null, evidence: [...persisted.evidence], candidates: [...persisted.candidates!], probe }
        : { state: 'none', key: null, sectionTag: null, evidence: [], probe };
      return this.#unknownBlockResponse(eid, blockMap, readError);
    };
    if (sections.length === 0) return noInfo();
    const raw = await this.#readRaw(eid);
    if ('error' in raw) return noInfo(raw.error);
    const shape = this.#matchShape(raw.bulk, sections);
    if (shape.confidence !== 'likely' || shape.sectionTag === null) {
      this.#runtimeLikely.delete(eid);
      const fits = shape.candidates ?? [];
      if (fits.length === 0) return noInfo();
      return this.#unknownBlockResponse(eid, { state: 'candidates', key: null, sectionTag: null, evidence: ['bulk-shape'], candidates: [...fits], probe });
    }
    const key = sections.find((s) => s.tag === shape.sectionTag)!.key;
    this.#runtimeLikely.set(eid, shape.sectionTag);
    const access = blockMapAccess({ confidence: 'likely', evidence: ['bulk-shape'] });
    const index = buildParamIndex(this.#prof, key);
    const shaped = this.#sliceShaped(eid, raw, key, index, shape.channels);
    const ctx: BlockContext = { family: key, slug: '', blockName: `Block ${eid}`, page: -1, hasChannels: shaped.hasChannels, read: shaped.read };
    const blockMap: BlockMapMeta = { state: access.state, key, sectionTag: shape.sectionTag, evidence: ['bulk-shape'], probe };
    return this.#withBlockMap(this.#paramsGeneric(ctx, index), { unknown: true, access, blockMap });
  }

  /** The runtime bulk-shape match of a block's body against editor-cache sections (`matchBulkShape`: a section's rows
   *  are the applied document's own rows of its key) under the model's catalog. */
  #matchShape(bulk: { itemCount: number; values: readonly number[] }, sections: readonly DerivedSection[]): ReturnType<typeof matchBulkShape> {
    const keyOf = new Map(sections.map((s) => [s.tag, s.key] as const));
    const docRows = this.#prof.profileFacts?.ranges ?? {};
    const enumRaw = new Map(bulk.values.map((v, i) => [i, v] as const));
    const rowsOf = (tag: number): ReadonlyMap<number, CodecRangeDef> =>
      new Map(Object.entries(docRows[keyOf.get(tag) ?? ''] ?? {}).map(([pid, row]) => [Number(pid), row] as const));
    return matchBulkShape(bulk.itemCount, enumRaw, sections, rowsOf, profileCatalogFor(this.#prof.model));
  }

  /** The block probe's sizing read (services/blockProbe.ts): the editor-cache sections of the applied document a placed
   *  block's bulk read fits (`matchBulkShape` — one for `likely`, several for `candidates`, none), with their strides.
   *  Null when the applied profile has no section a block may bind to (nothing is read then); empty when the read
   *  failed or nothing fits. One status + bulk read. */
  async probeShape(eid: number): Promise<Array<{ tag: number; stride: number }> | null> {
    const sections = this.#bindableSections();
    if (sections.length === 0) return null;
    const raw = await this.#readRaw(eid);
    if ('error' in raw) return [];
    const shape = this.#matchShape(raw.bulk, sections);
    const tags = shape.confidence === 'likely' && shape.sectionTag !== null ? [shape.sectionTag] : shape.candidates ?? [];
    return tags.map((tag) => ({ tag, stride: sections.find((s) => s.tag === tag)!.stride }));
  }

  /** The generic response of a block that lists nothing (no family, or nothing to bind it to). */
  #unknownBlockResponse(eid: number, blockMap: BlockMapMeta, readError?: string): BlockParamsV2DTO {
    return {
      block: `Block ${eid}`, slug: '', page: -1, named: [], enums: [], type: null, unknownBlock: true,
      definitions: { family: null, profile: 'none', positional: false, channel: null, persistentWrites: false, hidden: [], blockMap },
      ...(readError !== undefined ? { readError } : {})
    };
  }

  /** A generic response of a block-map block: the block-level write mode (a read-only binding serves every param with
   *  `write: null` and the block's reason), `unknownBlock` for a block without a catalog family, and
   *  `definitions.blockMap`. */
  #withBlockMap(res: BlockParamsV2DTO, o: { unknown: boolean; access: BlockMapAccess; blockMap: BlockMapMeta }): BlockParamsV2DTO {
    const reason = o.access.writable ? undefined : o.access.readOnlyReason ?? 'unconfirmed-block';
    const readOnly = <T extends NamedParamV2 | EnumParamV2>(p: T): T => (reason ? { ...p, write: null, readOnlyReason: reason } : p);
    const { block, slug, page, named, enums, type, layout, definitions, readError } = res;
    return {
      block, slug, page, named: named.map(readOnly), enums: enums.map(readOnly), type,
      ...(o.unknown ? { unknownBlock: true as const } : {}),
      ...(layout ? { layout } : {}),
      definitions: { ...definitions, blockMap: o.blockMap },
      ...(readError !== undefined ? { readError } : {})
    };
  }

  /** The applied document's editor-cache sections a block may bind to (`blockBindableSection` under the model's
   *  catalog: unassigned ones, and those of catalog families without an effect id). Empty without a profile document. */
  #bindableSections(): DerivedSection[] {
    const all = this.#prof.profileFacts?.byteSections ?? [];
    if (all.length === 0) return [];
    const firstEid = profileCatalogFor(this.#prof.model).familyFirstEid;
    return all.filter((s) => blockBindableSection(s, firstEid));
  }

  /** Whether the block probe would read `eid` now (`definitions.blockMap.probe`), by the route's own rules
   *  (services/blockProbe.ts): never for a block the bundled catalog places (`catalogFamilyOfBlock`: the route's
   *  409 `known-block`, a roster-only family included; no reason); else the probe gate of the running firmware — and
   *  above effect id 160 the above-160 gate too — (`not-verified`), then the edit-buffer grid as last read
   *  (`not-placed`; known follow-up: like the route, it trusts the last read, which a front-panel change can make
   *  stale). No device traffic. */
  #probeAvailability(eid: number): BlockMapMeta['probe'] {
    if (catalogFamilyOfBlock(this.#prof.model, eid) !== undefined) return { available: false };
    const gates = this.#ctx.walkScope?.();
    const gated = gates?.blockProbe === true && (eid <= LIVE_WALK_LIMITS.standardMaxBlock || gates.above160 === true);
    if (!gated) return { available: false, reason: 'not-verified' };
    if (!(this.placedEffectIds() ?? []).includes(eid)) return { available: false, reason: 'not-placed' };
    return { available: true };
  }

  /** One block's status entry (its active channel, null when the status names none) and its fn-0x1F body, unsliced.
   *  The read the block-map blocks share; a failed bulk read comes back as `error`. */
  async #readRaw(eid: number): Promise<{ bulk: { itemCount: number; values: number[] }; channel: number | null } | { error: string }> {
    try {
      const dev = await this.#conn();
      const status = (await this.#statusByEffectId()).get(eid);
      const frames = await this.#bulkRead(dev, eid, dev.slow ? 8000 : 2500, dev.slow ? 600 : 120);
      const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
      return { bulk: { itemCount: bulk.itemCount, values: [...bulk.values] }, channel: status ? status.channel : null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A raw block read sliced for `family`: `channels` true = four channel slices (the status channel's is served;
   *  unknown channel → `channel-unknown`), false = one slice, null = unknown (every value `channel-unknown`). Primes the
   *  device-edit baseline like #readBlock. */
  #sliceShaped(
    eid: number,
    raw: { bulk: { itemCount: number; values: number[] }; channel: number | null } | { error: string },
    family: string, index: BlockIndex, channels: boolean | null
  ): { read: BlockRead; hasChannels: boolean } {
    const hasChannels = channels !== false;
    if ('error' in raw) return { read: { values: null, readError: raw.error, channel: null, stride: 0, base: 0, positional: index.positional ?? false }, hasChannels };
    const { bulk } = raw;
    const activeCh = channels === true ? raw.channel ?? 0 : 0;
    this.#watchedChannel = activeCh;
    const { stride, base, channelCount } = this.#channelSlice(family, bulk, activeCh, channels === true);
    const channel = channels === true && raw.channel !== null ? Math.min(raw.channel, channelCount - 1) : null;
    const positional = this.#isPositional(index, bulk, stride, hasChannels);
    if (positional) {
      this.#editSnapshot.set(eid, bulk.values.slice(base, base + stride));
      this.#nonPositional.delete(eid);
    } else {
      this.#nonPositional.add(eid);
    }
    return { read: { values: bulk.values, channel, stride, base, positional }, hasChannels };
  }

  /** The classic response (see blockParams). */
  #paramsClassic(c: BlockContext, index: BlockIndex): BlockParamsDTO {
    const { family, slug, hasChannels, read } = c;
    // knobs = every continuous param with a usable range: a float-kind range AND a continuous catalog
    // unit (KNOB_UNITS; this keeps selectors that carry a float-typed range record out of the dial
    // list). We expose ALL real controls (the UI organizes them); besides that only genuinely-dead
    // params are dropped: no range (min===max) or the bypass flag.
    const knobs = knobParams(this.#prof, family);
    // enums = every discrete selector. The family TYPE selector is excluded (header retype palette),
    // plus the raw bypass flag; everything else (modes, slopes, mics, mic/cab pickers…) is shown, and so
    // are the float-row selectors (enumParams: the III's GLOBALMIX toggles). The entry set stays the
    // catalog's; the type VALUE is read where the type selector sits on the connected device (it follows its
    // name when the row moved, the pid setType writes), else at the catalog's pid.
    const catalogTypeId = typeSelectorPid(this.#prof, family);
    const typeId = index.typePid ?? catalogTypeId;
    const enumDefs = enumParams(this.#prof, family, catalogTypeId);
    const named: NamedParam[] = [];
    const enums: EnumParam[] = [];
    let type: { value: number; name: string } | null = null;
    if (read.values) {
      const values = read.values;
      // The number a param gets even when the read has nothing for it: the classic response falls back to
      // whatever sits at the slot, else 0, and the entry says so through `unresolved`.
      const rawOf = (slot: number | UnresolvedReason, pid: number): number => (typeof slot === 'number' ? slot : (values[read.base + pid] ?? 0));
      for (const p of knobs) {
        const slot = readSlot(read, hasChannels, p.paramId);
        const raw = rawOf(slot, p.paramId);
        const item: NamedParam = { id: p.paramId, name: paramLabel(p), ...this.#display(family, p.paramId, raw) };
        const why = typeof slot === 'string' ? slot : raw > 65534 ? 'out-of-range' : undefined;
        if (why) item.unresolved = why;
        named.push(item);
      }
      for (const p of enumDefs) {
        const range = this.#prof.ranges[family]![p.paramId]!;
        const slot = readSlot(read, hasChannels, p.paramId);
        const dec = decodeSelector(range, rawOf(slot, p.paramId));
        const item: EnumParam = {
          id: p.paramId, name: paramLabel(p), value: dec.value,
          options: this.#enumOptions(family, p.paramId, p.name, dec.lo, dec.hi)
        };
        const why = typeof slot === 'string' ? slot : dec.inRange ? undefined : 'out-of-range';
        if (why) item.unresolved = why;
        enums.push(item);
      }
      // current model/type (for EQ band layout etc.)
      if (typeId != null) {
        const roster = this.#prof.rosterFor(slug);
        const max = Math.max(0, roster.length - 1);
        const raw = rawOf(readSlot(read, hasChannels, typeId), typeId);
        const tv = raw > max ? Math.round((raw / 65534) * max) : raw;
        type = { value: tv, name: roster[tv]?.name ?? '' };
      }
    } else {
      // the read failed: dials at rest (the selectors cannot be told apart from a lost read, so none are listed)
      for (const p of knobs) named.push({ id: p.paramId, name: paramLabel(p), value: 0, norm: 0, unresolved: 'read-failed' });
    }
    // Current value of any page/control selector param, keyed by its editor symbol: the family type
    // selector answers with the type just decoded; a selector listed as an enum with the ordinal it decoded;
    // every other selector (listed as a dial or not listed at all: REVERB_BASETYPE, a `count` float row this
    // response never lists) with the ordinal read from its raw body value (selectorOrdinal) — never a dial's
    // display value, which no editor `value` list names. Lets layoutFor filter the served pages down to the
    // ones the editor would actually show — collapsing e.g. the amp's per-model 'Authentic' pages to the
    // current model.
    const enumValueByPid = new Map<number, number>();
    for (const e of enums) enumValueByPid.set(e.id, e.value);
    const selectorAt = (pid: number): number | undefined => {
      if (enumValueByPid.has(pid)) return enumValueByPid.get(pid);
      const slot = readSlot(read, hasChannels, pid);
      return typeof slot === 'number' ? selectorOrdinal(this.#prof.ranges[family]?.[pid], slot) : undefined;
    };
    const selectors: SelectorValues = (selectorParamName) => {
      const pid = this.#paramId(family, selectorParamName); // a catalog pid
      if (pid == null) return undefined;
      if (pid === catalogTypeId) return type?.value;
      return selectorAt(pid);
    };
    // Re-resolve the layout to the variant selected by the block's CURRENT type value (EQ band count,
    // amp firmware-pinned variant, etc.) and filter its pages to the current selector/firmware state. A family
    // without a type selector is told apart by its variant selector instead (the cab's Legacy / DynaCab mode,
    // the plex's base type); a variant folded from another selector (the Delay's DELAY_TYPE) is keyed by that
    // selector's value; falls back to the null/first variant when the value is unknown. Firmware gates are
    // evaluated against the connected firmware (the newest when it is not known).
    const variantPid = variantSelectorPid(this.#prof, family);
    const variantValue = typeId != null ? type?.value : variantPid != null ? selectorAt(variantPid) : undefined;
    const layout = this.#prof.layoutFor(family, variantValue, selectors, this.#layoutFirmware());
    // disambiguate repeated labels within a block (e.g. the cab's 4× "Low Cut", amp's two "Depth")
    // so identical names get a 1/2/3 suffix the UI can tell apart.
    dedupeLabels(named);
    dedupeLabels(enums);
    // a failed read is not "the block has none": flag it, so the client says the block could not be read
    const blockState: BlockStateDTO = !read.readError ? this.#blockState(family, enums) : { sceneIgnore: null, bypassMode: null, readError: true };
    // ADDITIVE: the read-only displays this block can show, narrowed to its current type/variant (see
    // blockVisualsFor). Last keys, so existing response consumers see the same leading shape.
    const visuals = blockVisualsFor(this.#prof, family, layout, [...named.map((n) => n.id), ...enums.map((e) => e.id)]);
    return { block: c.blockName, slug, page: c.page, named, enums, type, layout, blockState, visuals };
  }

  /** Tag the block's Scene Ignore + Bypass Mode (additive `blockState`, capability `blockState`). WHICH param
   *  each one is comes from the codec (`blockStateParams`: by name in THIS model's catalog, with the firmware
   *  gate); the VALUE is the active-channel enum just read into `enums`, so the header and the board's own
   *  control can never disagree. A member is null when the family has no such param (a failed read is flagged by the caller). */
  #blockState(family: string, enums: readonly EnumParam[]): BlockStateDTO {
    const facts = blockStateParams(this.#prof.model, family);
    let sceneIgnore: BlockStateDTO['sceneIgnore'] = null;
    const si = facts.sceneIgnore;
    const siEnum = si ? enums.find((e) => e.id === si.paramId) : undefined;
    if (si && siEnum) {
      const supported = firmwareAtLeast(this.#ctx.getFirmware?.() ?? null, si.minFw);
      sceneIgnore = {
        paramId: si.paramId,
        value: siEnum.value,
        supported,
        ...(supported || !si.minFw ? {} : { reason: `Needs firmware = ${formatBlockStateFirmware(si.minFw)}` })
      };
    }
    let bypassMode: BlockStateDTO['bypassMode'] = null;
    const bm = facts.bypassMode;
    const bmEnum = bm ? enums.find((e) => e.id === bm.paramId) : undefined;
    if (bm && bmEnum) {
      bypassMode = {
        paramId: bm.paramId,
        value: bmEnum.value,
        options: bmEnum.options.map((o) => ({ value: o.value, label: o.label, muting: isMutingBypassMode(o.label) }))
      };
    }
    return { sceneIgnore, bypassMode };
  }

  /** The generic response (see blockParams): one item per index entry, in index order. */
  #paramsGeneric(c: BlockContext, index: BlockIndex): BlockParamsV2DTO {
    const { family, slug, hasChannels, read } = c;
    const named: NamedParamV2[] = [];
    const enums: EnumParamV2[] = [];
    const enumValueByPid = new Map<number, number>();
    const catalogRows = (this.#prof.staticBase ?? this.#prof).ranges[family] ?? {};
    for (const e of index.entries) {
      const slot = readSlot(read, hasChannels, e.pid);
      const meta = paramMetaOf(e);
      if (e.list === 'named') {
        const why = typeof slot === 'string' ? slot : slot > 65534 ? 'out-of-range' : undefined;
        // no reading: the row's facts alone
        const d = this.#displayRow(e.row, e.def?.unit, why ? 0 : (slot as number), { fromProfile: e.source === 'profile', catalogRow: catalogRows[e.pid] });
        named.push({
          id: e.pid, name: e.name,
          value: why ? null : d.value, norm: why ? null : d.norm,
          ...(d.unit !== undefined ? { unit: d.unit } : {}),
          ...(d.unitSource !== undefined ? { unitSource: d.unitSource } : {}),
          ...(d.min !== undefined ? { min: d.min } : {}),
          ...(d.max !== undefined ? { max: d.max } : {}),
          ...(d.log ? { log: true } : {}),
          ...(d.taperSource !== undefined ? { taperSource: d.taperSource } : {}),
          ...meta,
          ...(why ? { unresolved: why } : {}),
        });
      } else {
        const dec = decodeSelector(e.row, typeof slot === 'number' ? slot : 0);
        const why = typeof slot === 'string' ? slot : dec.inRange ? undefined : 'out-of-range';
        const { lo, hi } = e.options!;
        const opts = buildEnumOptions(lo, hi, e.labels, e.def ? resolveEnumValues(e.def.name)?.values : undefined);
        enums.push({
          id: e.pid, name: e.name, value: why ? null : dec.value, options: opts.options,
          ...meta,
          ...(opts.truncated ? { optionsTruncated: true as const } : {}),
          ...(why ? { unresolved: why } : {}),
        });
        if (!why) enumValueByPid.set(e.pid, dec.value);
      }
    }
    // the type selector is hidden from the lists (the header retype palette shows it): read it on its own
    let type: { value: number; name: string } | null = null;
    const typeId = index.typePid;
    if (typeId != null) {
      const slot = readSlot(read, hasChannels, typeId);
      if (typeof slot === 'number') {
        const roster = this.#prof.rosterFor(slug);
        const max = Math.max(0, roster.length - 1);
        const tv = slot > max ? Math.round((slot / 65534) * max) : slot;
        type = { value: tv, name: roster[tv]?.name ?? '' };
      }
    }
    // The catalog symbols of the editor layout resolve to the pids that carry those names on this device: a name
    // that moved with its row follows it (listed or hidden, the type selector too), a name the device no longer
    // has resolves to nothing.
    const served = (catalogPid: number | undefined): number | undefined => (catalogPid === undefined ? undefined : index.namedAt.get(catalogPid));
    // A selector served as an enum keys by the ordinal it decoded (none when its reading is unresolved); any other
    // one — a listed dial or a hidden row — by the ordinal read from its raw body value (selectorOrdinal), never by a
    // dial's display value: the device reads REVERB_BASETYPE raw 6 (base type 6), which the dial shows as 0.0007.
    const selectorAt = (pid: number): number | undefined => {
      const entry = index.byPid.get(pid);
      if (entry?.list === 'enums') return enumValueByPid.get(pid);
      const slot = readSlot(read, hasChannels, pid);
      return typeof slot === 'number' ? selectorOrdinal(entry?.row ?? this.#prof.ranges[family]?.[pid], slot) : undefined;
    };
    const selectors: SelectorValues = (selectorParamName) => {
      const pid = served(this.#paramId(family, selectorParamName));
      if (pid == null) return undefined;
      if (typeId != null && pid === typeId) return type?.value;
      return selectorAt(pid);
    };
    const variantValue = typeId != null ? type?.value : index.variantPid != null ? selectorAt(index.variantPid) : undefined;
    let layout = this.#prof.layoutFor(family, variantValue, selectors, this.#layoutFirmware());
    if (layout) layout = this.#servedLayout(layout, family, index);
    dedupeLabels(named);
    dedupeLabels(enums);
    return {
      block: c.blockName, slug, page: c.page, named, enums, type,
      ...(layout ? { layout } : {}),
      definitions: {
        family,
        profile: index.profile,
        ...(index.suspect ? { suspect: true as const } : {}),
        positional: read.positional,
        channel: read.channel,
        persistentWrites: family === 'GLOBAL' || family === 'FC',
        hidden: index.hidden.map((h) => ({ id: h.id, reason: h.reason })),
      },
      ...(read.readError !== undefined ? { readError: read.readError } : {}),
    };
  }

  /** The firmware the editor layouts' firmware gates are evaluated against: the registry's layout firmware (the running
   *  firmware, else the last one this connected unit reported: a later re-read that got no answer does not flip the
   *  layouts to the newest firmware mid-session), else the running firmware for a ctx without it; null (the newest
   *  firmware) when none was read. */
  #layoutFirmware(): LayoutFirmware {
    return this.#ctx.getLayoutFirmware ? this.#ctx.getLayoutFirmware() : this.#ctx.getFirmware?.() ?? null;
  }

  /** The generic response's layout: the editor layout with its controls bound to the params the connected device
   *  serves (the classic response keeps the editor layout as it is). A control names its param in the family that
   *  owns it: its cross-block reference's family (`crossBlock.family`), else the layout's own family.
   *  - A button control (`<F>_BTN_<X><n>`, an editor pseudo id) gains `boundParamId`: the served param it presses.
   *  - A control whose catalog name now sits at another pid of the owning family (the name followed its row) is
   *    pointed there: `paramId` becomes that pid and `movedFrom` keeps the catalog pid; a cross-block reference's
   *    `paramId` follows along. The owning family's own param index decides: the REFERENCED family's `namedAt` for a
   *    control that addresses another block (FORGEFX-48).
   *  - A control whose catalog name the device does not serve any more although the catalog has a device-mined row
   *    for it (a byte-exact profile dropped it, or a shift left its name without a unique row) keeps its `paramId`
   *    and is marked `unbound`, so it is not written to whatever sits at that pid now. Display-only controls
   *    (meters, readouts, labels, graphs) and rows the catalog made up from inline bounds are never unbound.
   *  - Every cross-block reference gains `crossBlock.effectId`: the effect id of the block that owns the referenced
   *    param on this device (#crossBlockOwners), or null where there is none to address (modifier slots, preset-level
   *    data, a family without an effect id, an instance the device does not have). A write to that block keeps every
   *    guard its own address has (GLOBAL's setup writes are persistent; #guardParamWrite).
   *  A reference that did not resolve to a family, a reference into another family that does not name that family's
   *  catalog param at its catalog pid, pseudo ids and names that did not move keep their binding. Every control that
   *  changes is a copy; the profile's layout objects are never modified. */
  #servedLayout(layout: DeviceLayout, family: string, index: BlockIndex): DeviceLayout {
    type Owner = { index: BlockIndex; defByName: ReadonlyMap<string, ParamDef>; catalogRows: Readonly<Record<number, RangeDef>> };
    const owners = new Map<string, Owner | null>();
    const ownerOf = (fam: string): Owner | null => {
      let o = owners.get(fam);
      if (o !== undefined) return o;
      const defs = this.#prof.params[fam] ?? [];
      if (fam !== family && defs.length === 0) o = null; // no catalog family of this device (PRESET)
      else {
        const defByName = new Map<string, ParamDef>();
        for (const d of defs) if (!defByName.has(d.name)) defByName.set(d.name, d);
        o = { index: fam === family ? index : buildParamIndex(this.#prof, fam), defByName, catalogRows: (this.#prof.staticBase ?? this.#prof).ranges[fam] ?? {} };
      }
      owners.set(fam, o);
      return o;
    };
    let ownerEid: ((ref: CrossBlockRefKey) => number | null) | undefined;
    const bound = (c: DeviceLayoutControl): DeviceLayoutControl => {
      if (!c.paramName) return c;
      const button = BUTTON_SYMBOL.exec(c.paramName);
      if (button) {
        const catalogPid = ownerOf(family)!.defByName.get(`${button[1]}_${button[2]}`)?.paramId;
        const at = catalogPid === undefined ? undefined : index.namedAt.get(catalogPid);
        return at !== undefined && index.byPid.has(at) ? { ...c, boundParamId: at } : c;
      }
      const ownerFamily = c.crossBlock ? c.crossBlock.family : family;
      if (ownerFamily === null) return c; // a reference that did not resolve names no param of ours
      const owner = ownerOf(ownerFamily);
      if (!owner) return c;
      if (c.paramId == null || c.paramId > MAX_WIRE_PID) return c;
      const def = owner.defByName.get(c.crossBlock?.paramName ?? c.paramName);
      if (!def || def.paramId > MAX_WIRE_PID) return c; // not a symbol of the owning family
      // a reference into another family is followed only where it names that family's catalog param at its catalog pid
      if (ownerFamily !== family && (c.crossBlock!.paramId ?? c.paramId) !== def.paramId) return c;
      const at = owner.index.namedAt.get(def.paramId);
      if (at === def.paramId) return c;
      if (at !== undefined) {
        const crossBlock = c.crossBlock && c.crossBlock.paramId === def.paramId ? { crossBlock: { ...c.crossBlock, paramId: at } } : {};
        return { ...c, paramId: at, movedFrom: def.paramId, ...crossBlock };
      }
      // Only a row the catalog mined from the device proves the param existed: a row the III table made up from
      // inline bounds (synthetic) is not in any device cache, so its absence from the profile says nothing (the
      // gain-reduction meters). A control that only displays something writes nothing to protect.
      const row = owner.catalogRows[def.paramId];
      return row && isInformativeRow(row) && !row.synthetic && !DISPLAY_ONLY_WIDGETS.has(c.widget) ? { ...c, unbound: true } : c;
    };
    return mapLayoutControls(layout, (c) => {
      const out = bound(c);
      if (!out.crossBlock) return out;
      ownerEid ??= this.#crossBlockOwners();
      return { ...out, crossBlock: { ...out.crossBlock, effectId: ownerEid(out.crossBlock) } };
    });
  }

  /** The owning effect id of a layout's cross-block reference on this device (codec `crossBlockEffectId`:
   *  `firstId(family) + instance - 1` from the reference's `ID_<SYMBOL><n>` token), over a table of THIS device: the
   *  model's own first effect ids (profileCatalogFor: FM3, FM9 and Axe-Fx III each their own table, the virtual blocks
   *  GLOBAL 1 / CONTROLLERS 2 / FC 199 included, the development hook's hidden family left out), plus every catalog
   *  family that table gives no effect id but the applied profile's block map binds `confirmed` (first id = its
   *  lowest bound effect id, instances = the run of consecutive bound ids from there). The instance must exist on the
   *  device: at most the model's instance count of the family (`instanceLimits`, 1 when unlisted) and never beyond
   *  the effect-id span the gen-3 roster reserves for it (`gen3RosterSpan`). MOD (modifier slots) and PRESET
   *  (preset-level data) references, a reference without a family, a family without an effect id and an instance
   *  beyond the device's count resolve to null. Pure apart from reading the profile. */
  #crossBlockOwners(): (ref: CrossBlockRefKey) => number | null {
    const catalog = profileCatalogFor(this.#prof.model);
    const first: Record<string, number | null> = { ...(catalog.familyFirstEid ?? {}) };
    const counts: Record<string, number> = { ...(catalog.instanceLimits ?? {}) };
    const mapped = new Map<string, number[]>();
    for (const eid of this.#prof.profileFacts?.confirmedBlocks ?? []) {
      const key = this.#prof.familyForEffectId(eid);
      if (key === undefined || isSyntheticFamilyKey(key) || first[key] != null) continue; // the static table places it
      let eids = mapped.get(key);
      if (!eids) mapped.set(key, (eids = []));
      eids.push(eid);
    }
    for (const [key, eids] of mapped) {
      eids.sort((a, b) => a - b);
      let n = 1;
      while (eids.includes(eids[0]! + n)) n++;
      first[key] = eids[0]!;
      counts[key] = n;
    }
    return (ref) => crossBlockEffectId(ref, first, ref.family !== null ? counts[ref.family] ?? 1 : 1, gen3RosterSpan);
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
    const build = (pid: number): number[] => buildGetRawParamValue(eid, pid, this.#prof.model); // codec raw-value GET (sub 0x1B)
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
    const frames = await this.#bulkRead(dev, eid, 2500, 120);
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
      const frames = await this.#bulkRead(dev, eid, 2500, 120);
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
      // A knob in blockParams()'s sense (isKnobParam), narrowed to the meter-worthy ones: not a 0..1
      // flag-like range and a human label rather than a raw symbol.
      const knobs = defs.filter((p) => {
        const r = this.#prof.ranges[family]?.[p.paramId];
        if (!isKnobParam(this.#prof, family, p) || (r?.displayMin === 0 && r.displayMax === 1)) return false;
        const label = p.displayLabel ?? p.name;
        return !/_/.test(label) && !/^[A-Z][A-Z0-9+]*$/.test(label);
      });
      const primary = knobs.find((p) => /level|mix|master|volume|gain|drive/i.test(p.displayLabel ?? p.name)) ?? knobs[0];
      if (!primary) continue;
      const wantIds = new Set<number>([primary.paramId, ...(wants[slug] ?? [])]);
      const vals: Record<number, MeterVal> = {};
      let typeName = '';
      try {
        const frames = await this.#bulkRead(dev, c.effectId, 2000, 100);
        const bulk = this.#codec.assembleGen3BlockBulkRead(frames);
        const activeCh = status.get(c.effectId)?.channel ?? 0;
        const { base } = this.#channelSlice(family, bulk, activeCh);
        for (const id of wantIds) {
          const d = this.#display(family, id, bulk.values[base + id] ?? 0);
          vals[id] = { norm: d.norm, value: d.value, unit: d.unit, min: d.min, max: d.max, log: d.log };
        }
        // the type selector where it sits on the connected device (see #paramsClassic), else the catalog's pid
        const typeId = buildParamIndex(this.#prof, family).typePid ?? typeSelectorPid(this.#prof, family);
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
            timeoutMs: 800, quietMs: 40, routine: true,
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

  /** Looper page telemetry: the live waveform envelope + playhead position + level (gen-3 shared).
   *  Waveform = fn 0x01 sub 0x23 at curve slot 0: the same 609-byte container as the block graph curves,
   *  decoded to 128 envelope magnitudes. Those are device values whose envelope can exceed 1 (observed
   *  up to ~2.17), so each is clamped to 0..1 for this method's HTTP contract. Position = sub 0x19 pid 14
   *  (0..1 across the loop); level = sub 0x19 pid 22. Returns empty with NO device I/O when the block
   *  isn't a looper, so Axis can poll it for whatever block is open without cost. */
  async looperTelemetry(eid: number): Promise<{ wave: number[]; position: number | null; level: number | null }> {
    if (slugForEffectId(eid) !== 'looper') return { wave: [], position: null, level: null };
    const dev = await this.#conn();
    const model = this.#prof.model;
    let wave: number[] = [];
    let position: number | null = null;
    let level: number | null = null;
    try {
      const wf = await dev.request(buildLooperWaveformPoll(eid, model), { timeoutMs: 900, quietMs: 60, routine: true, match: (fs) => fs.some((f) => isLooperWaveformResponse(f, eid)) });
      const r = wf.find((f) => isLooperWaveformResponse(f, eid));
      if (r) wave = parseLooperWaveform(r).map((v) => Math.max(0, Math.min(1, v)));
    } catch { /* no waveform this tick */ }
    for (const [pid, isPos] of [[14, true], [22, false]] as const) {
      try {
        const fr = await dev.request(buildBlockMonitorPoll(eid, pid, model), { timeoutMs: 500, quietMs: 40, routine: true, match: (fs) => fs.some((f) => isBlockMonitorResponse(f, eid, pid)) });
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

  /** One page's device-rendered graph curve (fn 0x01 sub 0x23): the block page asks for it on a state
   *  change (page open, parameter echo, type/zoom), NOT on a timer. The reply is a fixed container whose
   *  declared byte count sizes it (a full-size curve is 609 bytes = 128 float32 magnitudes). Null when no
   *  reply matched; a frame for another block/slot is ignored by the matcher. */
  async blockCurve(eid: number, slot: number): Promise<{ eid: number; slot: number; values: number[] } | null> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= GRAPH_CURVE_SLOTS) {
      throw new Error(`curve slot ${slot} out of range 0..${GRAPH_CURVE_SLOTS - 1}`);
    }
    const dev = await this.#conn();
    const frames = await dev.request(buildGraphCurvePoll(eid, slot, this.#prof.model), {
      timeoutMs: 900, quietMs: 60, routine: true,
      match: (fs) => fs.some((f) => isGraphCurveResponse(f, eid, slot))
    });
    const r = frames.find((f) => isGraphCurveResponse(f, eid, slot));
    if (!r) return null;
    return { eid, slot, values: parseGraphCurve(r) };
  }

  /** Build dropdown options for the enum param over the ordinals `min..max`. A label is the device's own list
   * (the editor cache) at `v - min`, else fractal-midi's enum overlay (matched by device param name) where
   * known, else the bare ordinal. */
  #enumOptions(family: string, paramId: number, name: string, min: number, max: number): EnumOption[] {
    return buildEnumOptions(min, max, this.#prof.enumLabelsFor(family, paramId), resolveEnumValues(name)?.values).options;
  }

  /** Map a raw 0..65534 wire value to {value, norm, unit, min, max, log} via the device-true FM3 range.
   * Taper: a device-true explicit `range.taper` ('log'→log10; 'linear'|'flat'|'custom'→linear) wins;
   * absent it falls back to the typecode heuristic (middle nibble 4 = log10, e.g. freq cuts; every other nibble linear). */
  #display(family: string | undefined, paramId: number, raw: number): DisplayReading {
    const range = family ? this.#prof.ranges[family]?.[paramId] : undefined;
    const unitCode = family ? this.#prof.params[family]?.find((x) => x.paramId === paramId)?.unit : undefined;
    return this.#displayRow(range, unitCode, raw);
  }

  /** `#display` for a row the caller already holds, with the catalog unit code of the param it belongs to. With
   *  `sourced` (the generic response) the reading also says where its unit and taper came from (`unitSource` /
   *  `taperSource`), and a row without a device or catalog unit takes the one its typecode implies (the codec's
   *  typecode rules, read-time only). Without it (the classic response, meters) the reading is what it always was. */
  #displayRow(range: RangeDef | undefined, unitCode: string | undefined, raw: number, sourced?: RowProvenance): DisplayReading {
    const norm = clamp01(raw / 65534);
    if (range && range.kind === 'float' && Number.isFinite(range.displayMin) && Number.isFinite(range.displayMax) && range.displayMin !== range.displayMax) {
      try {
        // Taper (log vs linear). A device-true explicit taper from the capture catalog WINS over the
        // typecode rule: 'log' → log sweep; 'linear' | 'flat' | 'custom' → linear. A
        // 'custom' taper's `taperPoints` are NOT applied on the wire yet, so custom is served linear
        // for now (the Axis side documents the same). A log sweep still requires a positive range —
        // wireToDisplay throws on log10 with displayMin<=0 — the same guard the typecode rule gets.
        // When NO explicit taper is present, the codec's typecode rules decide (`typecodeTaper`): middle
        // nibble 4 is a log taper, 3 and 5..9 linear, every other nibble predicts nothing (served linear).
        // That is the nibble heuristic this code carried before, checked by the codec against the explicit
        // tapers of the committed FM3 / FM9 / Axe-Fx III catalogs. `range.taper` reads device-true from a
        // static-catalog row, and from a profile row that carries one.
        const rowFromDevice = (field: 'taper' | 'unit') => !!sourced && (sourced.fromProfile || sourced.catalogRow?.[field] !== range[field]);
        let log: boolean;
        let taperSource: ValueSource | undefined;
        if (range.taper) {
          log = range.taper === 'log' && range.displayMin > 0;
          taperSource = rowFromDevice('taper') ? 'device' : 'catalog';
        } else {
          const rule = typecodeTaper(range.typecode);
          log = rule?.taper === 'log' && range.displayMin > 0;
          if (rule) taperSource = 'typecode';
        }
        const v = wireToDisplay(raw, { displayMin: range.displayMin, displayMax: range.displayMax, displayScale: log ? 'log10' : 'linear' });
        // Prefer the DEVICE-TRUE unit captured by the live-walk (RangeDef.unit, view 0x00)
        // over the AM4-name-overlay catalog code; fall back to the overlay when absent
        // (byte-source/.cache profiles carry no device-true unit). The generic response then falls back to the unit
        // the row's typecode implies (`typecodeUnit`: a few exact typecodes, measured, never contradicting a
        // catalog unit); the classic response does not.
        const catalogUnit = (unitCode && UNIT_LABEL[unitCode]) || undefined;
        const typecodeUnitCode = sourced && range.unit === undefined && catalogUnit === undefined ? typecodeUnit(range.typecode)?.unit : undefined;
        const unit = range.unit ?? catalogUnit ?? (typecodeUnitCode !== undefined ? UNIT_LABEL[typecodeUnitCode] : undefined);
        const unitSource: ValueSource | undefined = range.unit !== undefined ? (rowFromDevice('unit') ? 'device' : 'catalog')
          : catalogUnit !== undefined ? 'catalog' : unit !== undefined ? 'typecode' : undefined;
        return {
          value: round3(v), norm, unit, min: range.displayMin, max: range.displayMax, log: log || undefined,
          ...(sourced && unitSource ? { unitSource } : {}),
          ...(sourced && taperSource ? { taperSource } : {}),
        };
      } catch {
        /* fall through to 0..10 position */
      }
    }
    return { value: Math.round(norm * 1000) / 100, norm }; // 0..10 fallback
  }

  /** Resolve a param name (display label) → device-true paramId. 'Type' → the family's type selector
   *  (`typeSelectorPid`): `<FAM>_MODEL` where it exists (DELAY: its `DELAY_TYPE` is the 8-value MONO/STEREO
   *  routing enum, the real model list lives on `DELAY_MODEL`), else the EXACT `<FAM>_TYPE` name regardless of
   *  unit (the catalogs tag it `unverified`; guessing "the first enum that ends in TYPE" picked a DIFFERENT
   *  selector: FUZZ → FUZZ_CLIPTYPE, PITCH → PITCH_XFADETYPE, CABINET → CABINET_PRETYPE). A family with
   *  neither has no type: its other selectors list like any param. */
  #paramId(family: string, name: string): number | undefined {
    if (name.toLowerCase() === 'type') return typeSelectorPid(this.#prof, family);
    return (this.#prof.params[family] ?? []).find((p) => p.displayLabel === name || p.name === name)?.paramId;
  }

  // ── device-edit push (capability deviceEditPush): reflect front-panel / editor edits the device
  // broadcasts unsolicited (0x74/0x75/0x76). The registry's persistent RX listener hands us the
  // reassembled burst; we diff it against the last-known channel-A values so a whole-block packet
  // yields only the moved param(s). blockParams() primes the baseline when a block is opened. ──
  #editSnapshot = new Map<number, number[]>(); // effectId → last-known active-channel wire values
  #watchedEid: number | null = null; // FM3 poll target: the block Axis last opened (set in blockParams)
  /** Blocks whose body is not indexed by param id (GLOBAL): nothing to diff, so the poll leaves them alone. */
  #nonPositional = new Set<number>();
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
    if (this.#nonPositional.has(eid)) return { changed: false }; // no per-param information in that body to diff
    const dev = await this.#conn();
    let frames: number[][];
    try {
      frames = await this.#bulkRead(dev, eid, dev.slow ? 4000 : 1500, dev.slow ? 300 : 100, true); // edit-watch tick: routine poll
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
    const { audio: audioFamily, family } = this.#resolveBlock(eid);
    if (!family) return { events: [], reload: false }; // no param family mapped
    const defs = this.#prof.params[family] ?? [];
    const index = buildParamIndex(this.#prof, family);
    if (defs.length === 0 && index.entries.length === 0) return { events: [], reload: false }; // nothing to report on
    // A block the catalog cannot place on its own (a roster-only family, a block-map binding) has channels when its body
    // is four slices of its section; a body that is neither one slice nor four says nothing about any pid.
    let channelBlocked = !!audioFamily;
    if (!audioFamily && this.#prof.blockMapFor?.(eid) !== undefined) {
      const ch = shapeChannels(bulk.itemCount, this.#prof.rangeSections[family]?.stride);
      if (ch === null) return { events: [], reload: false };
      channelBlocked = ch;
    }
    // Slice the block's ACTIVE channel (the one blockParams surfaced) — the body is channel-blocked, so
    // diffing against channel A while the user has B-D open would flag every A/B-different param as "moved".
    const { stride, base } = this.#channelSlice(family, bulk, eid === this.#watchedEid ? this.#watchedChannel : 0, channelBlocked);
    // A body that is not indexed by param id (GLOBAL: one record per param) says nothing about any pid: no
    // events, and no baseline to prime.
    if (!this.#isPositional(index, bulk, stride, channelBlocked)) {
      this.#nonPositional.add(eid);
      return { events: [], reload: false };
    }
    this.#nonPositional.delete(eid);
    const cur = bulk.values.slice(base, base + stride);
    const prev = this.#editSnapshot.get(eid);
    this.#editSnapshot.set(eid, cur);
    // First sight of this block (never opened) → we can't diff. Ask the registry for a full reload so the
    // edit isn't lost; subsequent edits on this block then diff per-param.
    if (!prev) return { events: [], reload: true };
    // The params that can move: the catalog's (with a row) and everything the index lists, generic params
    // included; not the rows the connected firmware no longer has.
    const removed = new Set(index.hidden.filter((h) => h.reason === 'removed').map((h) => h.id));
    const pids: number[] = [];
    const seen = new Set<number>();
    const add = (id: number) => { if (!seen.has(id) && !removed.has(id)) { seen.add(id); pids.push(id); } };
    for (const p of defs) if (this.#prof.ranges[family]?.[p.paramId]) add(p.paramId); // only real controls (skip internal churn)
    for (const e of index.entries) add(e.pid);
    const events: { effectId: number; paramId: number; norm: number }[] = [];
    for (const id of pids) {
      if (id >= stride) continue;
      if (cur[id] === undefined || cur[id] === prev[id]) continue; // unchanged / truncated → skip
      events.push({ effectId: eid, paramId: id, norm: clamp01((cur[id] ?? 0) / 65534) });
    }
    return { events, reload: false };
  }

  /** Refuses a param write the connected device cannot take, before anything is sent (thrown with a
   *  `statusCode`, which both the Fastify app and the runtime router keep):
   *  - 400: the id is no wire parameter (above 0x3FFF sit the editor's pseudo ids, e.g. the cab's
   *    `_BTN_` buttons; a negative or fractional id is none either);
   *  - 409: the block's family has a row at that id, the row is an unused slot (all-zero placeholder) on the
   *    connected firmware, and the catalog defines no param there. "On the connected firmware" is the
   *    effective row, and for a byte-exact profile also the profile's own row. A live profile's placeholder
   *    rows are no information (the merge skips them, and the param index lists the effective row), so only
   *    the effective row counts there. A catalog param with a placeholder row (`MOD_MIN`/`MOD_MAX`/`MOD_PARAM`,
   *    the `*_GLOBALMIX` toggles) is a real param and stays writable, and so does an id with no row at all (the
   *    FC block, a cross-block write).
   *  - 409: a block the catalog cannot place on its own whose binding is read-only (see below), and a pid of a
   *    synthetic family (`section:<tag>` / `block:<eid>`, a block known from its device rows alone) without an
   *    informative row: no definition says what that pid is.
   *  A param the generic response marks `write: null` is NOT refused: that mark is advice for the UI. */
  #guardParamWrite(eid: number, paramId: number): void {
    const refuse = (statusCode: number, message: string): never => {
      throw Object.assign(new Error(message), { statusCode });
    };
    if (!Number.isInteger(paramId) || paramId < 0 || paramId > MAX_WIRE_PID) refuse(400, `param id ${paramId} is not a wire parameter`);
    const { audio, family, mapEntry } = this.#resolveBlock(eid);
    if (!audio) {
      // a block the catalog cannot place on its own: its block-map binding decides (drivers/blockMapState.ts) — a
      // roster-only family and a live-only binding are read-only, a byte-bridged binding is writable (the guards below
      // still apply). A block the last generic read served as a runtime bulk-shape match (`likely`) is read-only too,
      // whatever persisted entry it has, unless that entry itself serves the block with writable params (a confirmed
      // byte-bridged binding the profile resolves): a `candidate` entry, or a confirmed one whose key the profile does
      // not serve, never makes a `likely` block writable. Candidates / no binding and no `likely` read: nothing is
      // known, nothing is refused.
      const access = mapEntry ? blockMapAccess(mapEntry) : null;
      const entryRefuses = !!access && access.serves && !access.writable;
      const entryServesWritable = !!access && access.serves && access.writable && mapEntry!.key !== null && family === mapEntry!.key;
      if (entryRefuses || (this.#runtimeLikely.has(eid) && !entryServesWritable)) refuse(409, blockWriteRefusedMessage(eid));
    }
    if (!family) return;
    if (isSyntheticFamilyKey(family)) {
      const row = this.#prof.ranges[family]?.[paramId];
      if (!row || !isInformativeRow(row)) refuse(409, `param ${paramId} of block ${eid} has no definition on this device; write refused`);
    }
    const catalog = this.#prof.staticBase ?? this.#prof;
    if ((catalog.params[family] ?? []).some((d) => d.paramId === paramId)) return;
    const facts = this.#prof.profileFacts;
    const effective = this.#prof.ranges[family]?.[paramId];
    // a byte-exact profile's own row (byte-exact per family: a merged profile document can provide this family from
    // a live walk only); a suspect family's profile section belongs to another family, so its rows say nothing about
    // this one
    const profiled = facts?.isByteExactFamily(family) && !facts.suspectFamilies.includes(family) ? facts.ranges[family]?.[paramId] : undefined;
    if ((effective && isPlaceholderRow(effective)) || (profiled && isPlaceholderRow(profiled))) {
      refuse(409, `param ${paramId} of ${family} is an unused slot on this firmware; write refused`);
    }
  }

  // ── writes (all address the exact placed instance by effect id) ──
  async setParam(eid: number, paramId: number, value: number, continuous: boolean) {
    this.#guardParamWrite(eid, paramId); // throws (400/409) before anything goes on the wire
    // continuous knob writes stream at high frequency → fire-and-forget (instant);
    // a discrete write (enum) is rarer + worth confirming, so reject-watch it.
    const r = continuous ? await this.#send(this.#codec.buildSetParameterContinuous(eid, paramId, clamp01(value))) : await this.#write(this.#codec.buildSetParameter(eid, paramId, value));
    this.#lastLocalEditAt = Date.now(); // pause the FM3 device-edit poll briefly so it doesn't echo our own write mid-drag
    this.#emit({ type: 'param', effectId: eid, paramId, norm: value }); // live: other UIs move the knob
    return r;
  }
  /** Change a block's model/type (the family TYPE selector ordinal). */
  async setType(eid: number, value: number) {
    const family = audioFamilyOf(eid);
    // the pid that carries the family's type selector on this device (it follows its name when the row moved);
    // a family without one (CABINET, PLEX, …) has no type to set
    const tid = family ? buildParamIndex(this.#prof, family).typePid : undefined;
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
    // fn-only matcher: the scene reply carries nothing that ties it to one request (polled by the scene watch)
    const frames = await dev.request(this.#codec.buildGetScene(), { timeoutMs: 1200, routine: true, match: (fs) => fs.some((f) => f[5] === 0x0c) });
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
    // Both frames are built up front so a bad row/col/blockId throws before any wire traffic
    // (the duplicate guard below reads the grid, which must not happen for a request that cannot be sent).
    const select = this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows });
    const insert = this.#codec.buildSetGridCell({ row, col, blockId, rows: this.#prof.rows });
    // A block can sit in the grid only once, but the device answers an insert of a block that is already
    // placed elsewhere with an echo and then silently ignores it (no 0x64 refusal — hardware, FM3 fw 13), so
    // `ok:true` would report a placement that never happened. Refuse it here, before writing anything. The
    // grid cells are 0-indexed, this method's row/col are 1-indexed. Clearing (blockId 0) and shunts (routing
    // cells, effect id >= GEN3_SHUNT_BASE, which may repeat) are not blocks and never reach the guard — and so
    // never cost a grid read.
    if (blockId !== 0 && blockId < GEN3_SHUNT_BASE) {
      const held = await this.#placedCellOf(blockId);
      if (held) {
        if (held.row === row - 1 && held.col === col - 1) return { ok: true }; // already exactly there: nothing to write
        const err = new Error(`${held.name} is already placed at row ${held.row + 1} col ${held.col + 1} — move it instead`);
        (err as Error & { statusCode?: number }).statusCode = 409; // conflict with the current grid, not a server fault
        throw err;
      }
    }
    await this.#write(select);
    const r = await this.#write(insert);
    this.#invalidateGrid();
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  /** The grid cell that currently holds the block `blockId`, or null when it is not placed — or when the grid
   *  cannot be read, or on a slow link has not been read: an unreadable/unread grid never blocks a placement
   *  (today's behaviour).
   *  Fast link: reads through grid() (its 500 ms cache and in-flight coalescing), so no new wire pattern. Such a read
   *  can predate a clear the caller just made (a move clears the source, then places at the destination), and
   *  a refusal or no-op decided on it would be wrong, so a hit is confirmed with one fresh dump before it counts.
   *  Slow link (5-pin DIN, `Transport.slow` — the flag the dump windows already use): a fresh dump costs ~8 s and a
   *  failing one several times that, so the guard never starts a read, fresh or confirming. It uses only a grid read
   *  that already exists (cached, or in flight) AND started after the last grid-changing write (#gridGen) — which is
   *  exactly what the confirm read establishes on a fast link — and is skipped otherwise. */
  async #placedCellOf(blockId: number): Promise<GridCellDTO | null> {
    const find = (g: PresetGridDTO) => g.cells.find((c) => !c.isShunt && c.effectId === blockId) ?? null;
    let slow: boolean;
    try {
      slow = (await this.#conn()).slow;
    } catch {
      return null; // no link: the write below reports it as it always did
    }
    if (slow) {
      const gen = this.#gridGen;
      const cached = this.#gridCache;
      try {
        if (cached && cached.gen === gen && Date.now() - cached.at < Gen3Driver.GRID_TTL_MS) return find(cached.grid);
        if (this.#gridInflight && this.#gridInflightGen === gen) {
          const g = await this.#gridInflight;
          return gen === this.#gridGen ? find(g) : null; // a write landed while it ran: that read is out of date now
        }
      } catch {
        /* the awaited read failed: unread grid */
      }
      return null;
    }
    // grid() starts a fresh dump read itself unless it can reuse a cached or in-flight one (decided synchronously here)
    const reused = this.#gridInflight !== null || (this.#gridCache !== null && Date.now() - this.#gridCache.at < Gen3Driver.GRID_TTL_MS);
    let hit: GridCellDTO | null;
    try {
      hit = find(await this.grid());
    } catch {
      return null;
    }
    if (!hit || !reused) return hit;
    try {
      const gen = this.#gridGen;
      const g = await this.#dumpGrid();
      this.#gridCache = { grid: g, at: Date.now(), gen };
      return find(g);
    } catch {
      return null;
    }
  }
  /** Move the device's edit cursor to a cell (sub 0x30) so the FM3 screen follows the UI.
   * Non-destructive: this is the cursor-select frame (no companion = no clear). */
  async selectCell(row: number, col: number) {
    return this.#send(this.#codec.buildClearBlock({ row, col, rows: this.#prof.rows }));
  }
  async cable(srcRow: number, srcCol: number, destRow: number, connect: boolean) {
    const r = await this.#write(this.#codec.buildSetGridRouting({ srcRow, srcCol, destRow, rows: this.#prof.rows, op: connect ? ROUTING_OP_CONNECT : ROUTING_OP_DISCONNECT }));
    this.#invalidateGrid();
    this.#emit({ type: 'changed', scope: 'grid' });
    return r;
  }
  async selectPreset(n: number, opts?: SelectPresetOpts) {
    this.#invalidateGrid();
    const r = await this.#write(this.#codec.buildSwitchPresetSysEx(n));
    if (r.ok) this.#session(await this.#conn()).currentSlot = n; // the edit buffer now holds slot n
    else if (this.#sessionState) this.#sessionState.currentSlot = null; // refused: no longer sure
    if (!opts?.silent) this.#emit({ type: 'changed', scope: 'preset' });
    return r;
  }
  /** Reload the CURRENT preset from flash by re-selecting it — the FULL-mode self-describe walk's
   *  non-destructive per-block safety net. Reuses presetRef() (current number) + selectPreset() (the
   *  wire builder), so no new preset-switch bytes are minted here. No-op when no preset is resolvable. */
  async reloadPreset(opts?: SelectPresetOpts): Promise<void> {
    const { number } = await this.presetRef();
    if (number >= 0) await this.selectPreset(number, opts);
  }
  /** The store-ack evidence in force right now: an injected level wins, else the model's table entry narrowed
   *  to this link (`slow`) and the firmware the registry read at detect time (see `resolveStoreAck`). */
  storeAckFor(slow: boolean): StoreAckEvidence {
    return this.storeAckOverride ?? resolveStoreAck(this.storeAckScope, { slow, firmware: this.#ctx.getFirmware?.() ?? null });
  }
  /**
   * Persist the working buffer to preset slot `n`.
   *
   * The device acknowledges a store by repeating the request's envelope (fn 0x01, sub 0x26) — on our own
   * FM3 about 0.8–0.9 s after the request on fw 12.0 and about 1.25–1.35 s on fw 13.0, while the generic
   * `#write` window is only 120 ms. So the old call could never see its own ack: it returned
   * `{ok:true}` by ABSENCE of a refusal, and any foreign `0x64` that happened to land in that window (a
   * refused read while the meter poll was running, say) was misread as the device rejecting the save.
   * Wait for the acknowledgement instead.
   *
   * Result contract (HTTP 200 on every outcome; the body says which). The evidence level in force on this
   * link and firmware (`storeAckFor`, see STORE_ACK_EVIDENCE) decides what a MISSING ack means. `reason`
   * (additive) tells a refusal from an unknown outcome without parsing text: 'rejected' = a fn-0x01 refusal
   * (0x64) was seen in the store window and no ack followed; 'no-ack' = nothing acknowledged the store in
   * time. It is set on every `ok:false` and on the lenient no-ack warning, and absent on an acknowledged
   * store.
   *  • ack seen          → `{ok:true, acked:true, location}` — the device's own reply, even if a stray
   *                         0x64 from another exchange landed in the same window;
   *  • 0x64, no ack      → `{ok:false, acked:false, reason:'rejected', location, error}` — a real refusal
   *                         (the error carries the device's result code), whatever the evidence level;
   *  • neither in time   → 'verified': `{ok:false, acked:false, reason:'no-ack', location, error}` (the
   *                         outcome is unknown — the slot may or may not have been written); 'unknown':
   *                         `{ok:true, acked:false, reason:'no-ack', location, warning}` — the store was
   *                         SENT but could not be confirmed, which is all a model without a proven ack (or
   *                         a link / firmware outside what was measured) can honestly say.
   *
   * The wait ends only on the ack or the hard cap: `quietMs` is set to the cap so a gap of silence after
   * some unrelated early frame can't end it before the (late) ack, and a 0x64 does not end it early either
   * (a refusal costs the full cap, which is rare and keeps a foreign 0x64 from faking one).
   */
  async store(n: number): Promise<{ ok: boolean; acked: boolean; reason?: StoreReason; location: number; error?: string; warning?: string }> {
    const dev = await this.#conn();
    const bytes = this.#codec.buildStorePreset(n);
    const model = bytes[4]!;
    const fn = bytes[5];
    // The ack repeats the request's envelope up to and including the sub-action: Fractal header, model
    // byte, fn 0x01, sub 0x26. A frame BYTE-IDENTICAL to the request is our own request coming back (MIDI
    // thru / loopback), not the device's answer — it is not an ack. (On our own FM3 the real ack differs
    // from the request on fw 12.0 and 13.0; for the other models that is still an assumption — if a unit's
    // ack ever turns out byte-identical, revisit this.)
    const sameAsRequest = (f: number[]) => f.length === bytes.length && f.every((b, i) => b === bytes[i]);
    // The ack carries no slot (nothing after the sub-action identifies which preset it answers), so a late
    // ack from an EARLIER store cannot be told apart from this one's.
    const isAck = (f: number[]) => f.length > 7 && f[0] === 0xf0 && [1, 2, 3, 4, 5, 6].every((i) => f[i] === bytes[i]) && !sameAsRequest(f);
    // A refusal is a 0x64 MULTIPURPOSE_RESPONSE echoing fn 0x01. Its body carries no sub-action, so ANY fn-0x01
    // refusal seen in the store window counts: a late refusal of a preceding fn-0x01 write can be attributed
    // to this store. That is what `reason:'rejected'` means — a fn-0x01 refusal was seen and no ack followed.
    const isReject = (f: number[]) => isMultipurposeResponse(f, model) && f[6] === fn;
    const evidence = this.storeAckFor(dev.slow);
    const caps = STORE_ACK_TIMEOUT_MS[evidence];
    const timeoutMs = dev.slow ? caps.slow : caps.fast;
    const unconfirmed = (why: string) => evidence === 'verified'
      ? {
          ok: false,
          acked: false,
          reason: 'no-ack' as const,
          location: n,
          error: `${why} — the device did not acknowledge the store within ${timeoutMs} ms, so the preset may or may not have been written to slot ${n}`
        }
      : {
          ok: true,
          acked: false,
          reason: 'no-ack' as const,
          location: n,
          warning: `${why} — no store acknowledgement from the device within ${timeoutMs} ms; the store to slot ${n} was sent but is unconfirmed (acknowledgement not verified for this model, link and firmware)`
        };
    let frames: number[][];
    try {
      frames = await dev.request(bytes, { timeoutMs, quietMs: timeoutMs, match: (fs) => fs.some(isAck) });
    } catch (e) {
      // The browser-direct transports REJECT a no-frame request timeout (the Node transports resolve []):
      // same outcome as silence. Typed (`code`), never matched on message text — see transport/types.ts.
      if (isTransportTimeout(e)) return unconfirmed('no reply');
      throw e;
    }
    if (frames.some(isAck)) return { ok: true, acked: true, location: n };
    const reject = frames.find(isReject);
    if (reject) {
      let detail = '';
      try {
        const code = parseMultipurposeResponse(reject, model).resultCode;
        detail = ` (result 0x${code.toString(16).padStart(2, '0')}${describeMultipurposeResultCode(code) ? `: ${describeMultipurposeResultCode(code)}` : ''})`;
      } catch { /* malformed 0x64 — keep the bare message */ }
      return { ok: false, acked: false, reason: 'rejected', location: n, error: `store to slot ${n} rejected by the device${detail}` };
    }
    return unconfirmed('no acknowledgement');
  }

  /** Load a raw preset dump (.syx bytes) straight into the device's EDIT BUFFER — no slot is touched
   *  (only `store` writes a slot). This is how you play a preset that isn't on the device (e.g. a
   *  cloud-only backup), sidestepping the slot limit. Sent paced (the FM3 CDC drops a flooded write).
   *
   *  The dump's preset-dump header (func 0x77) carries the TARGET slot as a 14-bit, MSB-first
   *  7-bit pair. A dump captured from slot N still names N — re-sending it verbatim makes the unit
   *  treat it as a store-to-N, NOT a load. Retargeting the header to 0x3FFF (`7F 7F`, the
   *  edit-buffer sentinel) is exactly what FM3-Edit's "Audition" does: the preset goes live in the
   *  edit buffer, no slot is written. We patch that field and fix the frame checksum in place.
   *
   *  Only ONE well-formed preset dump for THIS model goes out: anything else (other frames around it,
   *  a bank, another model's dump, 8-bit bytes) throws a 400 SendRejectedError before the transport
   *  is touched (sendPolicy.ts). */
  async loadPresetBytes(syx: Uint8Array): Promise<{ ok: boolean }> {
    const bytes = validatedPresetDump(syx, this.#prof.model);
    const dev = await this.#conn();
    retargetPresetDumpToEditBuffer(bytes);
    if (dev.sendPaced) await dev.sendPaced(bytes);
    else await dev.sendQueued(bytes);
    this.#invalidateGrid(); // edit buffer changed → next grid/blocks read reflects it
    return { ok: true };
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function round3(v: number) { return Math.round(v * 1000) / 1000; }

/** Create a gen-3 driver bound to one device profile (Axe-Fx III / FM3 / FM9). */
export function createGen3Driver(profile: DeviceProfile, ctx: DriverCtx, opts?: { storeAck?: StoreAckEvidence }): Gen3Driver {
  return new Gen3Driver(profile, ctx, opts);
}
export type { Gen3Driver };