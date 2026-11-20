// Cross-device preset converter service (POST /preset/convert). Turns a preset — either an uploaded
// .syx dump or the CONNECTED device's current preset — into a target-device preset, best-effort,
// with a per-decision event log the UI renders. ALL codec calls live here; the route in app.ts is a
// thin validation + error-mapping shim.
//
// SERVER-ONLY: this pulls the codec's `forgefx-midi/convert` engine + the gen-3/AM4 dump decoders,
// which are Node-safe but heavy. Keep it under services/ (never in runtime/*, which is browser-shared
// and probed by check-browser-safe.ts).
import {
  decodeGen3PresetDump,
  authorGen3PresetFromIRFull,
  defaultScaffoldSyx,
  hasSynthModel,
  validateGen3Preset,
  MODEL_FM3,
  MODEL_FM9,
  MODEL_AXE_FX_III,
  type SynthPreset,
  type SynthSkip,
} from 'forgefx-midi/devices/gen3';
import { decodeAm4PresetDumpBytes } from 'forgefx-midi/devices/am4';
import {
  liftGen3Preset,
  liftAm4Preset,
  liftVp4Preset,
  convertPreset,
  severityOf,
  CONVERTER_DEVICE_IDS,
  type ConverterDeviceId,
  type Gen3DeviceId,
  type ConverterPreset,
  type ConversionEvent,
} from 'forgefx-midi/convert';
import { EmptyPresetError, type DeviceDriver } from '../drivers/types.js';

/** The response DTO both the offline (`convertFromSyx`) and connected (`convertFromDriver`) paths
 *  return — exactly the wire contract POST /preset/convert serves on 200. */
export interface ConvertResponse {
  source: { device: string; name: string; decodeDepth: string };
  /** The fully-decoded SOURCE preset IR (blocks + routing.gridCells for grid-shaped sources). Lets the
   *  UI render the source device grid alongside the converted target — Axis has no protocol decoder, so
   *  the decoded source must ride along (the engine already decoded it as `ir`; it is not re-decoded). */
  sourcePreset: ConverterPreset;
  target: ConverterPreset;
  events: ConversionEvent[];
  summary: { total: number; info: number; warn: number; loss: number };
}

/** A service error carrying the HTTP status the route should map it to (400 undecodable/bad target,
 *  422 source is an empty preset slot, 501 no source capability, 503 device unreachable). */
export class ConvertError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ConvertError';
    this.statusCode = statusCode;
  }
}

/** Every device the converter can target (for validation + the 400 error payload). */
export const SUPPORTED_TARGETS = CONVERTER_DEVICE_IDS;

/** SysEx envelope model byte → gen-3 device id (Axe-Fx III / FM3 / FM9 share the gen-3 codec). */
const GEN3_DEVICE_BY_MODEL: Readonly<Record<number, Gen3DeviceId>> = {
  0x10: 'axe-fx-iii',
  0x11: 'fm3',
  0x12: 'fm9',
};
/** gen-3 device id → SysEx envelope model byte (inverse of GEN3_DEVICE_BY_MODEL). */
const GEN3_MODEL_BY_DEVICE: Readonly<Record<Gen3DeviceId, number>> = {
  'axe-fx-iii': MODEL_AXE_FX_III,
  fm3: MODEL_FM3,
  fm9: MODEL_FM9,
};
/** Display name per gen-3 target, for honest error/validation messages. */
const GEN3_DEVICE_NAME: Readonly<Record<Gen3DeviceId, string>> = {
  'axe-fx-iii': 'Axe-Fx III',
  fm3: 'FM3',
  fm9: 'FM9',
};
const AM4_MODEL_BYTE = 0x15;
const VP4_MODEL_BYTE = 0x14;

/** True when `x` is a converter device id (route validation of `targetDevice`). */
export function isConverterDeviceId(x: unknown): x is ConverterDeviceId {
  return typeof x === 'string' && (CONVERTER_DEVICE_IDS as readonly string[]).includes(x);
}

/** The Fractal envelope model byte from a raw .syx stream (F0 00 01 74 <model> …), or undefined. */
function sniffModelByte(bytes: Uint8Array): number | undefined {
  const f0 = bytes.indexOf(0xf0);
  return f0 >= 0 ? bytes[f0 + 4] : undefined;
}

/**
 * Decode + lift a raw .syx preset dump into the converter IR, dispatched on the envelope model byte.
 * Supports gen-3 preset dumps (Axe-Fx III / FM3 / FM9) and AM4 single-preset frames — the families
 * whose offline decode is validated. Anything else → `ConvertError(400)`.
 */
function liftFromSyx(bytes: Uint8Array): ConverterPreset {
  const model = sniffModelByte(bytes);
  if (model === undefined) throw new ConvertError(400, 'not a SysEx preset dump (no F0 frame found)');
  const gen3 = GEN3_DEVICE_BY_MODEL[model];
  if (gen3) {
    let decoded: ReturnType<typeof decodeGen3PresetDump>;
    try {
      decoded = decodeGen3PresetDump(bytes, model);
    } catch (e) {
      throw new ConvertError(400, `could not decode gen-3 preset dump: ${(e as Error).message}`);
    }
    // An unused slot decodes to an empty preset: there is nothing to convert (and nothing the export
    // authoring path could validate), so refuse it instead of "converting" it to an empty target.
    if (decoded.empty) throw new ConvertError(422, 'source preset slot is empty');
    try {
      return liftGen3Preset(decoded, gen3);
    } catch (e) {
      throw new ConvertError(400, `could not decode gen-3 preset dump: ${(e as Error).message}`);
    }
  }
  if (model === AM4_MODEL_BYTE) {
    try {
      return liftAm4Preset(decodeAm4PresetDumpBytes(bytes));
    } catch (e) {
      throw new ConvertError(400, `could not decode AM4 preset dump: ${(e as Error).message}`);
    }
  }
  throw new ConvertError(
    400,
    `unsupported source preset family (model byte 0x${model.toString(16)}); offline conversion supports ` +
      'gen-3 (Axe-Fx III / FM3 / FM9) and AM4 preset dumps',
  );
}

/** Run the codec engine + fold the event severities into the summary the UI reads. */
function buildResponse(ir: ConverterPreset, targetDevice: ConverterDeviceId): ConvertResponse {
  const { target, events } = convertPreset(ir, targetDevice);
  const summary = { total: events.length, info: 0, warn: 0, loss: 0 };
  for (const e of events) summary[severityOf(e)] += 1;
  return {
    source: { device: ir.sourceDevice, name: ir.name, decodeDepth: ir.decodeDepth },
    sourcePreset: ir,
    target,
    events,
    summary,
  };
}

/** Convert an uploaded preset .syx to `targetDevice` — offline, touches no device/transport. */
export function convertFromSyx(syx: Uint8Array, targetDevice: ConverterDeviceId): ConvertResponse {
  return buildResponse(liftFromSyx(syx), targetDevice);
}

/**
 * Convert the CONNECTED device's current preset to `targetDevice`. Reads the current preset through
 * the driver — VP4 via its structure blob (its only decode surface), every other liftable family via
 * its verbatim dump (`backupPreset`) fed back through the same model-byte dispatch — then converts.
 * Callers MUST gate on `driver.capabilities.presetConvert` first (the route answers 501 otherwise).
 */
export async function convertFromDriver(
  driver: DeviceDriver,
  targetDevice: ConverterDeviceId,
): Promise<ConvertResponse> {
  return buildResponse(await liftCurrentPreset(driver), targetDevice);
}

async function liftCurrentPreset(driver: DeviceDriver): Promise<ConverterPreset> {
  // VP4: the whole-preset structure blob is the only decode surface — no verbatim .syx dump path.
  if (driver.modelId === VP4_MODEL_BYTE) {
    const readStructure = (driver as { readStructure?: () => Promise<unknown> }).readStructure;
    if (typeof readStructure !== 'function') {
      throw new ConvertError(501, 'the VP4 driver cannot read the current preset structure');
    }
    const blob = await readStructure.call(driver);
    if (!blob) throw new ConvertError(503, 'no VP4 structure blob returned (device not responding)');
    return liftVp4Preset(blob as Parameters<typeof liftVp4Preset>[0]);
  }
  // Everything else liftable: dump the current preset verbatim, then decode + lift by model byte.
  if (!driver.backupPreset) {
    throw new ConvertError(501, 'the connected device cannot dump its current preset');
  }
  let dump: Awaited<ReturnType<NonNullable<DeviceDriver['backupPreset']>>>;
  try {
    dump = await driver.backupPreset();
  } catch (e) {
    if (e instanceof EmptyPresetError) throw new ConvertError(422, 'source preset slot is empty');
    throw e;
  }
  return liftFromSyx(Uint8Array.from(dump.bytes));
}

// ── offline .syx EXPORT (author a target preset from a converted IR) ───────────────────────────────

/** The response DTO POST /preset/convert/export serves on 200. `syx` is a FILE-level-valid FM3 preset
 *  dump (valid CRC, decodes back to the written values) — this is NOT a proof of DEVICE acceptance; a
 *  hardware load test on a real FM3 is still required before trusting an authored preset. */
/** One block that was synthesized into the authored output chain (a template clone overlaid with the
 *  converted block's type + params). Joined with the converted IR so the UI/report can name its family. */
export interface LandedBlockRecord {
  blockKey: string;
  family: string;
  displayName: string;
  instance: number;
  eid: number;
  /** Type ordinal written (absent when the family carries no swappable type, e.g. Cab). */
  typeWritten?: number;
  params: { paramId: number; channel: number; raw: number }[];
}

export interface ExportConvertedSyxResult {
  /** The authored FM3 preset `.syx` bytes (a plain number[] so it serializes cleanly over JSON). */
  syx: number[];
  /** Blocks synthesized into the output (template clone + type/param overlay). */
  written: LandedBlockRecord[];
  /** IR blocks/params that could not be synthesized (no harvested FM3 template, no type-location rule,
   *  or a param that failed to encode) — reported, never guessed onto a wrong address. */
  skipped: { blockKey?: string; family?: string; reason: string }[];
  /** The preset name written into the header. */
  name: string;
  /** END-TO-END VALIDATION GATE result for the AUTHORED output, decoded back with our own codec. On a
   *  200 this is always `ok:true` (a failing authored preset is refused with 422, never returned). */
  validation: { ok: boolean; issues: string[] };
  /** FULL-SYNTHESIS FIDELITY: how many converted source blocks LANDED in the freshly-synthesized body vs
   *  were DROPPED because their family has no harvested FM3 template yet. Synthesis reproduces the whole
   *  block chain from the IR — it is NOT bounded by any base's block set. Lets the UI report
   *  "exported N of M blocks — K families have no FM3 template yet". */
  fidelity: { sourceBlocks: number; landedBlocks: number; droppedNoTemplate: number };
}

/** True when `d` is a gen-3 device id the authoring path can synthesize for. */
function isGen3Target(d: string): d is Gen3DeviceId {
  return d === 'fm3' || d === 'fm9' || d === 'axe-fx-iii';
}

/**
 * Author a target-device `.syx` from a converted preset by FULL-BODY SYNTHESIS — the whole FM3 body
 * (scene names + grid + block chain) is synthesized fresh from the converted IR onto a clean FM3 scaffold,
 * NOT edited in place on a caller base. Lifts the source (offline `sourceSyx` OR the connected `driver`'s
 * current preset) → converts to `targetDevice` → hands the converted `ConverterPreset` (structurally the
 * codec's `SynthPreset`) to the FM3-calibrated `authorGen3PresetFromIRFull`.
 *
 * The converted IR's `paramId` is ALWAYS the TARGET (FM3) device's address — the conversion engine
 * re-resolves each param's id to FM3 via its concept key (gen-3 paramIds are device-specific), so the
 * synthesizer writes every mapped param's value directly by id. A param the engine could not map to an FM3
 * concept carries NO id and is reported skipped — never guessed onto a wrong address.
 *
 * BASE OVERRIDE: `base` is OPTIONAL. When omitted, the codec's bundled default FM3 scaffold is used — no
 * caller-supplied preset is needed. When supplied AND a valid FM3 dump, it is used as the scaffold instead
 * (its raw-patch header, modifier/scene-controller prelude and trailing region are carried; its scene
 * names, grid and block chain are replaced from the IR). A supplied non-FM3 or invalid base is refused (400).
 *
 * SCOPE: FM3 (model 0x11) targets ONLY — every other target throws `ConvertError(501)`. HONESTY: synthesis
 * reproduces the conversion faithfully for families with a harvested FM3 template; families without one are
 * dropped + reported. Input/Output params, amp channels B/C/D, Cab IR, modifiers and the trailing region are
 * scaffold-carried (not per-conversion). File-level validity does NOT prove DEVICE acceptance — a hardware
 * load test on a real FM3 is still required. `slot` is accepted for forward-compatibility but not yet applied.
 */
export async function exportConvertedSyx(opts: {
  targetDevice: string;
  /** EDITED IR (preferred): the caller's edited converter preset — carries the user's grid
   *  routing/cables + block/param edits verbatim. When supplied it is authored DIRECTLY (no
   *  re-lift, no re-convert), so nothing the user drew in the editor is discarded. */
  preset?: ConverterPreset;
  /** OFFLINE source: a raw uploaded preset `.syx` (gen-3 / AM4). Used when no edited `preset`. */
  sourceSyx?: Uint8Array;
  /** CONNECTED source: the active driver whose current preset is dumped + lifted (fallback). */
  driver?: DeviceDriver;
  /** OPTIONAL FM3 base override used as the synthesis scaffold. Omit to use the bundled default scaffold. */
  base?: Uint8Array;
  name?: string;
  slot?: number;
}): Promise<ExportConvertedSyxResult> {
  const { targetDevice, preset, sourceSyx, driver, base, name } = opts;

  // Target guard — gen-3 devices with a calibrated synthesis model (FM3/FM9/Axe-Fx III). AM4/VP4 have
  // no harvested block templates, so their authoring stays refused (501) until FORGEFXMID-45.
  if (!isGen3Target(targetDevice) || !hasSynthModel(GEN3_MODEL_BY_DEVICE[targetDevice])) {
    throw new ConvertError(501, `offline .syx export is not available for ${targetDevice} targets yet (FM3/FM9/Axe-Fx III only)`);
  }
  const modelId = GEN3_MODEL_BY_DEVICE[targetDevice];
  const deviceName = GEN3_DEVICE_NAME[targetDevice];

  // Resolve the SCAFFOLD: an optional caller base override (must be a valid dump of the SAME target device)
  // or the codec's bundled default scaffold for that device. Base pre-validation applies ONLY when supplied.
  let scaffold: Uint8Array;
  if (base && base.length > 0) {
    if (sniffModelByte(base) !== modelId) {
      throw new ConvertError(400, `the base override must be a ${deviceName} preset`);
    }
    const baseValidation = validateGen3Preset(base, modelId);
    if (!baseValidation.ok) {
      throw new ConvertError(
        400,
        `base override is not a valid ${deviceName} preset: ${baseValidation.issues.join('; ')}. ` +
          'Omit the base to use the bundled default scaffold, or pick a different one.',
      );
    }
    scaffold = base;
  } else {
    scaffold = defaultScaffoldSyx(modelId);
  }

  // Resolve the IR to author from. PREFERRED: the caller's EDITED converter preset — author it
  // DIRECTLY so the user's grid routing/cables and block/param edits are carried verbatim (no
  // re-lift/re-convert, which would discard them). FALLBACK: lift the source (offline upload or the
  // connected device) and convert to the FM3 target IR. Either way the IR is structurally a
  // `SynthPreset` (name, sceneNames, blocks-with-target-paramId, routing.gridCells w/ routeFlag).
  let ir: SynthPreset;
  let irBlocks: ConverterPreset['blocks'];
  if (preset) {
    ir = preset as unknown as SynthPreset;
    irBlocks = preset.blocks;
  } else {
    let source: ConverterPreset;
    if (sourceSyx && sourceSyx.length > 0) {
      source = liftFromSyx(sourceSyx);
    } else {
      if (!driver) throw new ConvertError(400, 'no source: supply an edited preset, source.syx, or connect a device');
      source = await liftCurrentPreset(driver);
    }
    const converted = convertPreset(source, targetDevice);
    ir = converted.target;
    irBlocks = converted.target.blocks;
  }

  // SYNTHESIZE the whole body from the IR onto the scaffold.
  const effectiveName = name?.trim() || ir.name || '';
  const result = authorGen3PresetFromIRFull(scaffold, { ...ir, name: effectiveName }, modelId);

  // GATE — validate the AUTHORED OUTPUT before returning. A synthesis that produced an incoherent preset
  // (bad CRC, garbage block/type, undecodable scene name) is refused with 422 — we NEVER hand back bytes
  // that fail our own decode.
  const outValidation = validateGen3Preset(result.syx, modelId);
  if (!outValidation.ok) {
    // Permanent operational diagnostic: a 422 here means synthesis produced an incoherent preset.
    // The IR shape (block/cell counts, placed eids, skip reasons, a grid sample) is what pins the
    // cause (e.g. FORGEFXMID-43: cross-device cells with undefined effectId collapsing onto one block).
    // eslint-disable-next-line no-console
    console.error('[convert/export] 422 authored preset failed validation', {
      issues: outValidation.issues,
      irBlocks: ir.blocks?.length,
      irGridCells: ir.routing?.gridCells?.length,
      irSceneNames: ir.sceneNames?.length ?? 0,
      placed: result.blocks.length,
      placedEids: result.blocks.map((b) => b.eid),
      skipped: result.skipped.length,
      skipReasons: [...new Set(result.skipped.map((s) => s.reason))],
      gridSample: (ir.routing?.gridCells ?? []).slice(0, 20).map((c: { row: number; col: number; effectId?: number; routeFlag?: number; blockKey?: string; isShunt?: boolean }) => ({ r: c.row, c: c.col, eid: c.effectId, rf: c.routeFlag, k: c.blockKey, sh: c.isShunt })),
    });
    throw new ConvertError(422, `authored preset failed validation: ${outValidation.issues.join('; ')}`);
  }

  // Join the synthesized placed blocks back to the converted IR (by stable key) so the report names the
  // family/instance the UI shows.
  const byKey = new Map(irBlocks.map((b) => [b.key, b] as const));
  const written: LandedBlockRecord[] = result.blocks.map((pb) => {
    const src = byKey.get(pb.key);
    return {
      blockKey: pb.key,
      family: src?.family ?? '',
      displayName: pb.displayName,
      instance: src?.instance ?? 0,
      eid: pb.eid,
      ...(pb.typeWritten != null ? { typeWritten: pb.typeWritten } : {}),
      params: pb.params,
    };
  });

  // FIDELITY — full synthesis reproduces the ENTIRE block chain from the IR (not bounded by any base's
  // blocks). The only drops are families whose FM3 template has not been harvested yet.
  const sourceBlocks = irBlocks.length;
  const landedBlocks = result.blocks.length;
  const droppedNoTemplate = result.skipped.filter((s: SynthSkip) =>
    s.reason.startsWith('no harvested template') || s.reason.startsWith('no template or geometry'),
  ).length;

  return {
    syx: Array.from(result.syx),
    written,
    skipped: result.skipped.map((s) => ({
      ...(s.key != null ? { blockKey: s.key } : {}),
      ...(s.family != null ? { family: s.family } : {}),
      reason: s.reason,
    })),
    name: result.nameWritten ?? effectiveName ?? '',
    validation: { ok: outValidation.ok, issues: outValidation.issues },
    fidelity: { sourceBlocks, landedBlocks, droppedNoTemplate },
  };
}
