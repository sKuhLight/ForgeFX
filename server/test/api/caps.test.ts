// Phase-6 capabilities DTO — for mocked FM3 / FM9 / Axe-Fx III / AM4 detections, GET /device must
// serve the expected capability matrix (spot-checks on the load-bearing flags Axis will gate on),
// plus the v2 API handshake on /healthz and /device and the capabilities mirror on /device/detect.
// Uses the REAL drivers (the caps DTO derives from DriverCapabilities + the optional-method surface;
// nothing here touches the transport beyond the mocked handshake).
import { fullCaptureAllowedOnFirmware } from '../../src/drivers/registryCore.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const CAPS_CASE_COUNT = 6;

type Caps = {
  slotModel: string;
  presets: { count: number; addressing: string; canRename: boolean; canScanNames: boolean; canDeepScan: boolean; liveQuery: boolean };
  gridRouting: boolean;
  gridCursorSelect: boolean;
  shuntBase: number | null;
  paramsWithoutPack: boolean;
  tempo: boolean;
  tuner: boolean;
  meters: { blockMeters: boolean; liveMonitors: boolean; outputLevels: boolean; cpu: boolean };
  sceneNamesWritable: boolean;
  fc: { model: boolean; liveState: boolean };
  modifiers: { model: boolean; bind: boolean };
  cabIrs: boolean;
  editorLayouts: boolean;
  fullCapture: boolean;
  firmwareValidate: boolean;
  backupDump: boolean;
  restoreDump: boolean;
  versionStore: boolean;
  deviceParams: boolean;
  virtualEffects: { eid: number; slug: string; name: string }[];
  blockState: boolean;
  telemetryControl: boolean;
  supportsSave: boolean;
};

// fullCapture is firmware-gated per model (FULL_CAPTURE_MAX_VERIFIED_FW), so each gen-3 model's matrix is
// served for a unit reporting a firmware its full capture is verified on (FM3 12.0, Axe-Fx III 32.6); the
// FM9 has no verified firmware at all, so its matrix carries fullCapture false on every version. The gate
// itself is covered by fullCaptureFirmwareGate().
async function fetchCaps(modelId: number, firmware?: [number, number]): Promise<{ device: Record<string, unknown>; caps: Caps; app: Awaited<ReturnType<typeof buildTestApp>>['app'] }> {
  const { app } = await buildTestApp(modelId, undefined, firmware ? { firmware } : undefined);
  const res = await app.inject({ method: 'GET', url: '/device' });
  assertEqual(res.statusCode, 200, `GET /device (0x${modelId.toString(16)})`);
  const device = res.json() as Record<string, unknown>;
  return { device, caps: device.capabilities as Caps, app };
}

function checkGen3Common(caps: Caps, label: string, fullCapture = true): void {
  assertEqual(caps.presets.count, 512, `${label} presets.count`);
  assertEqual(caps.presets.addressing, 'numeric', `${label} presets.addressing`);
  assertEqual(caps.presets.canRename, true, `${label} presets.canRename`);
  assertEqual(caps.presets.canScanNames, false, `${label} presets.canScanNames (501 for now)`);
  assertEqual(caps.presets.canDeepScan, true, `${label} presets.canDeepScan`);
  assertEqual(caps.presets.liveQuery, true, `${label} presets.liveQuery`);
  assertEqual(caps.gridRouting, true, `${label} gridRouting`);
  assertEqual(caps.gridCursorSelect, true, `${label} gridCursorSelect`);
  assertEqual(caps.shuntBase, 1024, `${label} shuntBase`);
  assertEqual(caps.paramsWithoutPack, true, `${label} paramsWithoutPack`);
  assertEqual(caps.tempo, true, `${label} tempo`);
  assertEqual(caps.tuner, true, `${label} tuner`);
  assertEqual(caps.meters.blockMeters, true, `${label} meters.blockMeters`);
  assertEqual(caps.meters.liveMonitors, true, `${label} meters.liveMonitors`);
  assertEqual(caps.meters.outputLevels, true, `${label} meters.outputLevels`);
  assertEqual(caps.meters.cpu, true, `${label} meters.cpu`);
  assertEqual(caps.sceneNamesWritable, true, `${label} sceneNamesWritable`);
  assertEqual(caps.fc.model, true, `${label} fc.model`);
  assertEqual(caps.modifiers.model, true, `${label} modifiers.model`);
  assertEqual(caps.modifiers.bind, true, `${label} modifiers.bind`);
  assertEqual(caps.editorLayouts, true, `${label} editorLayouts (ships *_LAYOUTS)`);
  assertEqual(caps.fullCapture, fullCapture, `${label} fullCapture (only on a model + firmware a full capture completed on)`);
  assertEqual(caps.firmwareValidate, false, `${label} firmwareValidate`);
  // gen-3 dumps raw .syx by slot (library export-to-disk + audition); restore stays the
  // version-store flow (loadPresetBytes + store), so restoreDump remains false.
  assertEqual(caps.backupDump, true, `${label} backupDump`);
  assertEqual(caps.restoreDump, false, `${label} restoreDump`);
  assertEqual(caps.versionStore, true, `${label} versionStore`);
  assertEqual(caps.deviceParams, false, `${label} deviceParams`);
  assertEqual(caps.virtualEffects.length, 4, `${label} virtualEffects (Setup/Controllers/Modifier/FC)`);
  assertEqual(caps.virtualEffects.map((v) => v.eid).join(','), '1,2,3,199', `${label} virtualEffects eids`);
  assertEqual(caps.blockState, true, `${label} blockState (Scene Ignore + Bypass Mode on block params)`);
  assertEqual(caps.telemetryControl, true, `${label} telemetryControl (registry-level cadence-mode control)`);
}

/** The blockState flag is the LAST key of the extended matrix (additive-only ordering): it sits right after
 *  virtualEffects and before the registry-level telemetryControl / supportsSave. */
function checkBlockStateOrdering(caps: Caps, label: string): void {
  const keys = Object.keys(caps);
  const at = keys.indexOf('blockState');
  assert(at > 0, `${label} blockState key present`);
  assertEqual(keys[at - 1], 'virtualEffects', `${label} blockState follows virtualEffects`);
  assertEqual(keys[at + 1], 'telemetryControl', `${label} blockState precedes telemetryControl`);
}

async function fm3(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x11, [12, 0]);
  try {
    assertEqual(device.apiVersion, 2, 'FM3 /device apiVersion');
    checkGen3Common(caps, 'FM3');
    checkBlockStateOrdering(caps, 'FM3');
    assertEqual(caps.fc.liveState, true, 'FM3 fc.liveState (FM3 only)');
    assertEqual(caps.cabIrs, true, 'FM3 cabIrs (bundled IR names)');

    // v2 handshake on /healthz (still ok:true, device:'FM3')
    const hz = await app.inject({ method: 'GET', url: '/healthz' });
    const h = hz.json() as { ok: boolean; api?: { version: number }; device: string };
    assertEqual(h.ok, true, 'healthz ok');
    assertEqual(h.api?.version, 2, 'healthz api.version');
    assertEqual(h.device, 'FM3', 'healthz device');

    // /device/detect mirrors the capabilities object
    const det = await app.inject({ method: 'GET', url: '/device/detect' });
    const d = det.json() as { modelId: number; capabilities?: { fc?: { liveState?: boolean } } };
    assertEqual(d.modelId, 0x11, 'detect modelId');
    assertEqual(d.capabilities?.fc?.liveState, true, 'detect carries capabilities');
  } finally {
    await app.close();
  }
}

async function fm9(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x12, [12, 0]);
  try {
    assertEqual(device.apiVersion, 2, 'FM9 /device apiVersion');
    checkGen3Common(caps, 'FM9', false); // no full capture has completed on an FM9: never offered
    assertEqual(caps.fc.liveState, false, 'FM9 fc.liveState false (address model only)');
    assertEqual(caps.cabIrs, true, 'FM9 cabIrs (factory banks bundled from the FM9-Edit cache, 2026-07-06)');
  } finally {
    await app.close();
  }
}

async function axe3(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x10, [32, 6]);
  try {
    assertEqual(device.apiVersion, 2, 'III /device apiVersion');
    checkGen3Common(caps, 'III');
    assertEqual(caps.fc.liveState, false, 'III fc.liveState false');
    assertEqual(caps.cabIrs, true, 'III cabIrs (factory banks bundled from the III editor cache, 2026-07-06)');
  } finally {
    await app.close();
  }
}

async function am4(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x15);
  try {
    assertEqual(device.apiVersion, 2, 'AM4 /device apiVersion');
    assertEqual(device.modelId, 0x15, 'AM4 modelId');
    assertEqual(caps.slotModel, 'linear', 'AM4 slotModel (curated key intact)');
    assertEqual(caps.presets.count, 104, 'AM4 presets.count');
    assertEqual(caps.presets.addressing, 'bankLetter', 'AM4 presets.addressing');
    assertEqual(caps.presets.canRename, true, 'AM4 presets.canRename (buildSetPresetName wired)');
    assertEqual(caps.presets.canScanNames, true, 'AM4 presets.canScanNames');
    assertEqual(caps.presets.canDeepScan, false, 'AM4 presets.canDeepScan');
    // presetRef() decodes the current location from the fn-0x1F structure (int32 @0x00) → the
    // unified GET /preset works on the AM4 and Axis shows the preset in the top bar.
    assertEqual(caps.presets.liveQuery, true, 'AM4 presets.liveQuery');
    assertEqual(caps.gridRouting, false, 'AM4 gridRouting');
    assertEqual(caps.gridCursorSelect, false, 'AM4 gridCursorSelect');
    assertEqual(caps.shuntBase, null, 'AM4 shuntBase');
    assertEqual(caps.paramsWithoutPack, true, 'AM4 paramsWithoutPack (KNOWN_PARAMS is server-side)');
    assertEqual(caps.tempo, false, 'AM4 tempo');
    assertEqual(caps.tuner, true, 'AM4 tuner (block-0x0023 live-poll via readTuner, 2026-07-07)');
    assertEqual(caps.meters.blockMeters, false, 'AM4 meters.blockMeters');
    assertEqual(caps.meters.liveMonitors, false, 'AM4 meters.liveMonitors');
    assertEqual(caps.meters.outputLevels, false, 'AM4 meters.outputLevels');
    assertEqual(caps.meters.cpu, false, 'AM4 meters.cpu');
    assertEqual(caps.sceneNamesWritable, true, 'AM4 sceneNamesWritable (buildSetSceneName wired)');
    assertEqual(caps.fc.model, false, 'AM4 fc.model');
    assertEqual(caps.fc.liveState, false, 'AM4 fc.liveState');
    assertEqual(caps.modifiers.model, true, 'AM4 modifiers.model (data-only model exists)');
    assertEqual(caps.modifiers.bind, false, 'AM4 modifiers.bind');
    assertEqual(caps.cabIrs, false, 'AM4 cabIrs');
    assertEqual(caps.editorLayouts, true, 'AM4 editorLayouts (ships AM4_LAYOUTS)');
    assertEqual(caps.fullCapture, false, 'AM4 fullCapture false (own non-gen-3 codec, no walk)');
    assertEqual(caps.firmwareValidate, true, 'AM4 firmwareValidate');
    assertEqual(caps.backupDump, true, 'AM4 backupDump');
    assertEqual(caps.restoreDump, true, 'AM4 restoreDump');
    assertEqual(caps.versionStore, false, 'AM4 versionStore');
    assertEqual(caps.deviceParams, true, 'AM4 deviceParams');
    assert(Array.isArray(caps.virtualEffects) && caps.virtualEffects.length === 0, 'AM4 virtualEffects empty');
    assertEqual(caps.blockState, false, 'AM4 blockState (no Scene Ignore / bypass-mode tagging)');
    checkBlockStateOrdering(caps, 'AM4');
    assertEqual(caps.telemetryControl, true, 'AM4 telemetryControl');
    assertEqual(caps.supportsSave, true, 'AM4 supportsSave (curated key intact)');
    // 2026-07-08: HW-009 (amp/drive/reverb/delay only) was superseded — every AM4 block has an
    // independent channel register. hasChannels/channelBlocks aren't in the curated Caps type (Axis
    // doesn't consume them yet — see the block-header CH selector's ad-hoc gate), but the raw
    // forgefx-midi descriptor values still ride the DTO and are worth locking in here.
    const raw = device.capabilities as unknown as { hasChannels: boolean; channelNames: string[]; channelBlocks: string[] };
    assertEqual(raw.hasChannels, true, 'AM4 hasChannels');
    assertEqual(raw.channelNames.join(','), 'A,B,C,D', 'AM4 channelNames');
    assertEqual(raw.channelBlocks.length, 18, 'AM4 channelBlocks (all 18 blocks)');
  } finally {
    await app.close();
  }
}

// gen-1 (Axe-Fx Standard/Ultra, model 0x01) — a conservative, read-only capability matrix: no grid
// edit / scenes / channels / save / telemetry / backup, everything the driver doesn't implement is false.
async function gen1(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x01);
  try {
    assertEqual(device.modelId, 0x01, 'gen1 modelId');
    assertEqual(caps.slotModel, 'linear', 'gen1 slotModel (matches upstream descriptor)');
    assertEqual(caps.presets.canRename, false, 'gen1 presets.canRename');
    assertEqual(caps.presets.canScanNames, false, 'gen1 presets.canScanNames');
    assertEqual(caps.presets.canDeepScan, false, 'gen1 presets.canDeepScan (param region opaque)');
    assertEqual(caps.presets.liveQuery, false, 'gen1 presets.liveQuery (no live preset ref)');
    assertEqual(caps.gridRouting, false, 'gen1 gridRouting');
    assertEqual(caps.gridCursorSelect, false, 'gen1 gridCursorSelect');
    assertEqual(caps.shuntBase, null, 'gen1 shuntBase');
    assertEqual(caps.tempo, false, 'gen1 tempo');
    assertEqual(caps.tuner, false, 'gen1 tuner');
    assertEqual(caps.meters.blockMeters, false, 'gen1 meters.blockMeters');
    assertEqual(caps.meters.outputLevels, false, 'gen1 meters.outputLevels');
    assertEqual(caps.meters.cpu, false, 'gen1 meters.cpu');
    assertEqual(caps.sceneNamesWritable, false, 'gen1 sceneNamesWritable');
    assertEqual(caps.fc.model, false, 'gen1 fc.model');
    assertEqual(caps.modifiers.model, false, 'gen1 modifiers.model');
    assertEqual(caps.modifiers.bind, false, 'gen1 modifiers.bind');
    assertEqual(caps.cabIrs, false, 'gen1 cabIrs');
    assertEqual(caps.editorLayouts, false, 'gen1 editorLayouts (none)');
    assertEqual(caps.fullCapture, false, 'gen1 fullCapture false (predates self-describe)');
    assertEqual(caps.firmwareValidate, false, 'gen1 firmwareValidate');
    assertEqual(caps.backupDump, false, 'gen1 backupDump');
    assertEqual(caps.restoreDump, false, 'gen1 restoreDump');
    assertEqual(caps.versionStore, false, 'gen1 versionStore');
    assertEqual(caps.deviceParams, false, 'gen1 deviceParams');
    assert(Array.isArray(caps.virtualEffects) && caps.virtualEffects.length === 0, 'gen1 virtualEffects empty');
    assertEqual(caps.blockState, false, 'gen1 blockState');
    // telemetryControl is registry-level (route availability), so it's true even on the read-only gen-1.
    assertEqual(caps.telemetryControl, true, 'gen1 telemetryControl (registry-level)');
    assertEqual(caps.supportsSave, false, 'gen1 supportsSave');
  } finally {
    await app.close();
  }
}

// fullCapture follows the firmware, per model: offered only on a known firmware at or below the model's
// verified version (FM3 13.0, Axe-Fx III 32.6 — major.minor), withheld above it and when the firmware is
// unknown / unusable. The FM9 has no verified version, so it is withheld on every firmware. The build route
// refuses full mode in exactly those cases (see deviceCache.ts).
async function fullCaptureFirmwareGate(): Promise<void> {
  type FwCase = { fw?: [number, number]; expected: boolean; label: string };
  const perModel: Array<{ modelId: number; name: string; cases: FwCase[] }> = [
    { modelId: 0x11, name: 'FM3', cases: [
      { fw: [13, 0], expected: true, label: 'fw 13.0 (verified)' },
      { fw: [12, 99], expected: true, label: 'fw 12.99 (lower major, high minor)' },
      { fw: [12, 0], expected: true, label: 'fw 12.0' },
      { fw: [13, 1], expected: false, label: 'fw 13.1' },
      { fw: [13, 99], expected: false, label: 'fw 13.99 (high minor boundary)' },
      { fw: [14, 0], expected: false, label: 'fw 14.0' }
    ] },
    { modelId: 0x12, name: 'FM9', cases: [
      { fw: [12, 0], expected: false, label: 'fw 12.0 (no full capture completed on it)' },
      { fw: [11, 99], expected: false, label: 'fw 11.99 (lower major, high minor)' },
      { fw: [12, 1], expected: false, label: 'fw 12.1' },
      { fw: [12, 99], expected: false, label: 'fw 12.99 (high minor boundary)' },
      { fw: [13, 0], expected: false, label: 'fw 13.0' }
    ] },
    { modelId: 0x10, name: 'Axe-Fx III', cases: [
      { fw: [32, 6], expected: true, label: 'fw 32.6 (verified)' },
      { fw: [31, 99], expected: true, label: 'fw 31.99 (lower major, high minor)' },
      { fw: [32, 7], expected: false, label: 'fw 32.7' },
      { fw: [32, 99], expected: false, label: 'fw 32.99 (high minor boundary)' },
      { fw: [33, 0], expected: false, label: 'fw 33.0' }
    ] }
  ];
  // unknown / unusable firmware is refused on every model: silent unit, major 0
  const unusable: FwCase[] = [
    { expected: false, label: 'unknown firmware (silent unit)' },
    { fw: [0, 5], expected: false, label: 'fw major 0 (not a real version)' }
  ];
  for (const m of perModel) {
    for (const c of [...m.cases, ...unusable]) {
      const { caps, app } = await fetchCaps(m.modelId, c.fw);
      try {
        assertEqual(caps.fullCapture, c.expected, `${m.name} ${c.label}: GET /device fullCapture`);
        const det = await app.inject({ method: 'GET', url: '/device/detect' });
        const d = det.json() as { capabilities?: { fullCapture?: boolean } };
        assertEqual(d.capabilities?.fullCapture, c.expected, `${m.name} ${c.label}: /device/detect mirrors fullCapture`);
      } finally {
        await app.close();
      }
    }
  }
  // the policy function itself: a model without an allowlist entry is never allowed, nor is a malformed version
  assertEqual(fullCaptureAllowedOnFirmware(0x15, { major: 1, minor: 0 }), false, 'AM4 (no allowlist entry) never allowed');
  assertEqual(fullCaptureAllowedOnFirmware(0x12, { major: 12, minor: 0 }), false, 'FM9 (no allowlist entry) never allowed, not even on 12.0');
  assertEqual(fullCaptureAllowedOnFirmware(0x12, { major: 1, minor: 0 }), false, 'FM9 (no allowlist entry) never allowed on an old firmware either');
  assertEqual(fullCaptureAllowedOnFirmware(0x10, { major: 32, minor: 6 }), true, 'policy: Axe-Fx III 32.6 allowed');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 12, minor: 0 }), true, 'policy: FM3 12.0 allowed');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, null), false, 'policy: null firmware refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: NaN, minor: 0 }), false, 'policy: NaN major refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 12, minor: -1 }), false, 'policy: negative minor refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 0, minor: 0 }), false, 'policy: major 0 refused');
}

// VP4 (0x14): its catalog names Scene Ignore on four families, but VP4 discrete writes are not decoded, so the
// block-state tagging (and its capability) stays off.
async function vp4(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x14);
  try {
    assertEqual(device.modelId, 0x14, 'VP4 modelId');
    assertEqual(caps.blockState, false, 'VP4 blockState (writes not decoded)');
    checkBlockStateOrdering(caps, 'VP4');
  } finally {
    await app.close();
  }
}

export async function runCapsTests(): Promise<void> {
  await fm3();
  await fm9();
  await axe3();
  await am4();
  await gen1();
  await vp4();
  await fullCaptureFirmwareGate();
}
