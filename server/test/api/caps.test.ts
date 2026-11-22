// Phase-6 capabilities DTO — for mocked FM3 / FM9 / Axe-Fx III / AM4 detections, GET /device must
// serve the expected capability matrix (spot-checks on the load-bearing flags Axis will gate on),
// plus the v2 API handshake on /healthz and /device and the capabilities mirror on /device/detect.
// Uses the REAL drivers (the caps DTO derives from DriverCapabilities + the optional-method surface;
// nothing here touches the transport beyond the mocked handshake).
import { fullCaptureAllowedOnFirmware } from '../../src/drivers/registryCore.js';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest, __setDriverForTest, type DeviceRegistry } from '../../src/drivers/registry.js';
import type { DefinitionsCaps, DeviceDriver } from '../../src/drivers/types.js';
import { CACHE_SCHEMA, type BuiltCache } from 'forgefx-midi/cache';
import { loadUsableProfile } from '../../src/profileSchema.js';
import { profileCatalogFor } from '../../src/profileCatalog.js';
import { createStore } from '../../src/runtime/store.js';
import { createMemStoreBackend } from '../../src/runtime/memStoreBackend.js';
import { nodeCodec } from '../../src/runtime/fsStoreBackend.js';
import { clone, editorCacheSource, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';
import { FM3_CATALOG_BASELINE } from 'forgefx-midi/gen3/fm3';
import { FM9_CATALOG_BASELINE } from 'forgefx-midi/gen3/fm9';
import { AXE3_CATALOG_BASELINE } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildTestApp, firmwareVersionReply } from '../helpers/api.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast, assert, assertEqual } from '../helpers/mock.js';

export const CAPS_CASE_COUNT = 14;

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
  telemetryControl: boolean;
  supportsSave: boolean;
};

// fullCapture is firmware-gated per model (FULL_CAPTURE_VERIFIED_FW range), so each gen-3 model's matrix is
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
  assertEqual(caps.telemetryControl, true, `${label} telemetryControl (registry-level cadence-mode control)`);
}

async function fm3(): Promise<void> {
  const { device, caps, app } = await fetchCaps(0x11, [12, 0]);
  try {
    assertEqual(device.apiVersion, 2, 'FM3 /device apiVersion');
    checkGen3Common(caps, 'FM3');
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
    // telemetryControl is registry-level (route availability), so it's true even on the read-only gen-1.
    assertEqual(caps.telemetryControl, true, 'gen1 telemetryControl (registry-level)');
    assertEqual(caps.supportsSave, false, 'gen1 supportsSave');
  } finally {
    await app.close();
  }
}

// fullCapture follows the firmware, per model: offered only on a known firmware inside the model's verified
// range (FM3 12.0 to 13.0, Axe-Fx III 32.6 to 32.6 — inclusive, major.minor), withheld below its minimum, above
// its maximum and when the firmware is unknown / unusable. The FM9 has no verified version, so it is withheld on
// every firmware. The build route refuses full mode in exactly those cases (see deviceCache.ts).
async function fullCaptureFirmwareGate(): Promise<void> {
  type FwCase = { fw?: [number, number]; expected: boolean; label: string };
  const perModel: Array<{ modelId: number; name: string; cases: FwCase[] }> = [
    { modelId: 0x11, name: 'FM3', cases: [
      { fw: [13, 0], expected: true, label: 'fw 13.0 (verified, range max)' },
      { fw: [12, 99], expected: true, label: 'fw 12.99 (inside the range, high minor)' },
      { fw: [12, 0], expected: true, label: 'fw 12.0 (verified, range min)' },
      { fw: [11, 99], expected: false, label: 'fw 11.99 (just below the range, high minor)' },
      { fw: [5, 3], expected: false, label: 'fw 5.3 (an old firmware nobody verified)' },
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
      { fw: [32, 6], expected: true, label: 'fw 32.6 (verified: the only version with a completed full capture)' },
      { fw: [32, 5], expected: false, label: 'fw 32.5 (just below the single verified version)' },
      { fw: [31, 99], expected: false, label: 'fw 31.99 (below the verified version, high minor)' },
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
  assertEqual(fullCaptureAllowedOnFirmware(0x10, { major: 32, minor: 5 }), false, 'policy: Axe-Fx III 32.5 refused (below the verified version)');
  assertEqual(fullCaptureAllowedOnFirmware(0x10, { major: 32, minor: 7 }), false, 'policy: Axe-Fx III 32.7 refused (above the verified version)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 12, minor: 0 }), true, 'policy: FM3 12.0 allowed (range min)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 13, minor: 0 }), true, 'policy: FM3 13.0 allowed (range max)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 11, minor: 99 }), false, 'policy: FM3 11.99 refused (below the range)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 5, minor: 3 }), false, 'policy: FM3 5.3 refused (below the range)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 13, minor: 1 }), false, 'policy: FM3 13.1 refused (above the range)');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, null), false, 'policy: null firmware refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: NaN, minor: 0 }), false, 'policy: NaN major refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 12, minor: -1 }), false, 'policy: negative minor refused');
  assertEqual(fullCaptureAllowedOnFirmware(0x11, { major: 0, minor: 0 }), false, 'policy: major 0 refused');
}

// ── capabilities.definitions ──────────────────────────────────────────────────────────────────────
// A mocked unit whose firmware reply and stored device-cache docs the test controls. `docs` is read by the
// registry's loadDeviceCache hook at every apply, so a test can add/remove a profile and re-apply.
interface DefsRig {
  registry: DeviceRegistry;
  docs: Map<string, BuiltCache>;
  fw: { v: [number, number] | null };
  /** The model byte the mocked unit answers the handshake (and the firmware query) with. */
  model: { v: number };
  app: Awaited<ReturnType<typeof buildApp>>;
}
async function defsRig(modelId: number, firmware: [number, number] | null, docs: Record<string, BuiltCache> = {}): Promise<DefsRig> {
  const mock = new MockTransport('serial', `mock-0x${modelId.toString(16)}`);
  const fw: { v: [number, number] | null } = { v: firmware };
  const model = { v: modelId };
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(model.v)];
    if (fw.v && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(model.v, fw.v[0], fw.v[1])];
    return [];
  };
  const store = new Map(Object.entries(docs));
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (key) => store.get(key) ?? null
  });
  await registry.detect();
  const app = await buildApp(registry);
  return { registry, docs: store, fw, model, app };
}
const definitionsOf = async (r: DefsRig): Promise<DefinitionsCaps> => {
  const res = await r.app.inject({ method: 'GET', url: '/device' });
  assertEqual(res.statusCode, 200, 'GET /device');
  const caps = (res.json() as { capabilities: { definitions?: DefinitionsCaps } }).capabilities;
  assert(caps.definitions !== undefined, 'capabilities.definitions is served');
  return caps.definitions;
};
/** A profile doc for `model` that says it describes firmware `fw`, stored under that firmware's key. */
const docFor = (model: number, fw: string, source: 'editor-cache' | 'live' | 'cloud' = 'editor-cache'): BuiltCache => ({ ...catalogBuilt(model, source), firmware: fw });
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.warn;
  console.warn = () => {};
  return fn().finally(() => { console.warn = orig; });
}

// gen-3 grid drivers serve the generic params; every other driver says so with false (and nothing else)
async function definitionsGenericFlag(): Promise<void> {
  for (const [modelId, name] of [[0x10, 'Axe-Fx III'], [0x11, 'FM3'], [0x12, 'FM9']] as const) {
    const r = await defsRig(modelId, null);
    try { assertEqual((await definitionsOf(r)).genericParams, true, `${name} genericParams`); } finally { await r.app.close(); }
  }
  // AM4 (0x15), Axe-Fx II (0x07), VP4 (0x14: gen-3 codec but a linear front panel, no v2), gen-1 (0x01)
  for (const [modelId, name] of [[0x15, 'AM4'], [0x07, 'Axe-Fx II'], [0x14, 'VP4'], [0x01, 'gen-1']] as const) {
    const r = await defsRig(modelId, null);
    try {
      const d = await definitionsOf(r);
      assertEqual(d.genericParams, false, `${name} genericParams`);
      assertEqual(d.catalogFirmware, null, `${name} has no catalog firmware`);
      assertEqual(d.profile, null, `${name} has no applied profile`);
      assertEqual(d.drift, 'unknown', `${name} drift`);
    } finally { await r.app.close(); }
  }
}

// the catalog baseline each gen-3 device ships (codec baseline exports), as formatFirmwareVersion writes it
async function definitionsCatalogFirmware(): Promise<void> {
  for (const [modelId, name, baseline, literal] of [
    [0x11, 'FM3', FM3_CATALOG_BASELINE.firmware, '12.0'],
    [0x10, 'Axe-Fx III', AXE3_CATALOG_BASELINE.firmware, '32.6'],
    [0x12, 'FM9', FM9_CATALOG_BASELINE.firmware, null]
  ] as const) {
    const r = await defsRig(modelId, [1, 0]);
    try {
      const d = await definitionsOf(r);
      assertEqual(d.catalogFirmware, baseline, `${name} catalogFirmware is the codec baseline`);
      assertEqual(d.catalogFirmware, literal, `${name} catalogFirmware`);
    } finally { await r.app.close(); }
  }
}

// the drift matrix while the bundled catalog is the live profile (profile null)
async function definitionsDriftWithoutProfile(): Promise<void> {
  const table: Array<{ model: number; name: string; fw: [number, number] | null; drift: DefinitionsCaps['drift'] }> = [
    { model: 0x11, name: 'FM3 firmware not read', fw: null, drift: 'unknown' },
    { model: 0x11, name: 'FM3 fw 12.0 = the catalog firmware', fw: [12, 0], drift: 'none' },
    { model: 0x11, name: 'FM3 fw 13.0 without a profile', fw: [13, 0], drift: 'unprofiled' },
    { model: 0x11, name: 'FM3 fw 12.1 (minor differs)', fw: [12, 1], drift: 'unprofiled' },
    { model: 0x10, name: 'III fw 32.6 = the catalog firmware', fw: [32, 6], drift: 'none' },
    { model: 0x10, name: 'III fw 32.7 without a profile', fw: [32, 7], drift: 'unprofiled' },
    { model: 0x10, name: 'III firmware not read', fw: null, drift: 'unknown' },
    { model: 0x12, name: 'FM9 fw 12.0: no catalog firmware, no profile', fw: [12, 0], drift: 'unknown' },
    { model: 0x12, name: 'FM9 firmware not read', fw: null, drift: 'unknown' },
  ];
  for (const c of table) {
    const r = await defsRig(c.model, c.fw);
    try {
      const d = await definitionsOf(r);
      assertEqual(d.profile, null, `${c.name}: no profile applied`);
      assertEqual(d.drift, c.drift, `${c.name}: drift`);
    } finally { await r.app.close(); }
  }
}

// an applied runtime profile: provenance facts, and what it does to drift
async function definitionsAppliedProfile(): Promise<void> {
  // a profile for a newer firmware than the catalog: FM3 fw 13.0, a byte-exact editor-cache profile of 13.0
  let r = await defsRig(0x11, [13, 0], { '11_13p0': docFor(0x11, '13.0') });
  try {
    const d = await definitionsOf(r);
    // profile v2 fields appended after suspectFamilies: a legacy (format-1) doc has no raw sources and reports the
    // non-blocking `no-raw` gap (plus the gaps of what it lacks), complete = no blocking gap
    assertEqual(JSON.stringify(d.profile), JSON.stringify({
      key: '11_13p0', source: 'editor-cache', byteExact: true, firmware: '13.0', suspectFamilies: [],
      format: 1, sources: [], coverage: { complete: true, gaps: ['no-raw', 'no-units', 'no-tapers', 'no-cab-tables'] }
    }), 'FM3 13.0 profile facts');
    assertEqual(d.drift, 'none', 'FM3 13.0 with a 13.0 profile: no drift');
    assertEqual(d.catalogFirmware, '12.0', 'the catalog firmware is the bundled one, not the profile\'s');
    assertEqual(d.genericParams, true, 'genericParams');
    // /device/detect carries the same object
    const det = await r.app.inject({ method: 'GET', url: '/device/detect' });
    assertEqual(JSON.stringify((det.json() as { capabilities: { definitions: unknown } }).capabilities.definitions), JSON.stringify(d), '/device/detect mirrors definitions');
  } finally { await r.app.close(); }

  // provenance: a live walk is not byte-exact; a cloud profile says where it came from
  r = await defsRig(0x11, [13, 0], { '11_13p0': docFor(0x11, '13.0', 'live') });
  try {
    const p = (await definitionsOf(r)).profile;
    assertEqual(p?.source, 'live', 'live profile source');
    assertEqual(p?.byteExact, false, 'live profile is not byte-exact');
    // profile v2 coverage: this live-only fixture carries no model lists, and on a firmware newer than the catalog
    // that is the blocking `rosters` gap (the catalog's lists may be out of date): `partial`, not `none`
    assertEqual((await definitionsOf(r)).drift, 'partial', 'a live profile of the running firmware without rosters: partial');
    assert(p!.coverage.gaps.includes('rosters') && !p!.coverage.complete, 'the blocking rosters gap is listed');
  } finally { await r.app.close(); }
  const allRosters = Object.fromEntries(Object.keys(profileCatalogFor(0x11).rosters ?? {}).map((f) => [f, [{ value: 0, name: 'A', manufacturer: null, basedOn: null }]]));
  assert(Object.keys(allRosters).length > 0, 'fixture: the FM3 catalog has roster families');
  r = await defsRig(0x11, [13, 0], { '11_13p0': { ...docFor(0x11, '13.0', 'live'), rosters: allRosters } as BuiltCache });
  try {
    // with a model list for every catalog roster family the same live profile has no blocking gap
    const d = await definitionsOf(r);
    assert(!d.profile!.coverage.gaps.includes('rosters'), 'no rosters gap');
    assertEqual(d.drift, 'none', 'a live profile of the running firmware with its rosters: no drift');
  } finally { await r.app.close(); }
  r = await defsRig(0x11, [13, 0], { '11_13p0': docFor(0x11, '13.0', 'cloud') });
  try {
    const p = (await definitionsOf(r)).profile;
    assertEqual(p?.source, 'cloud', 'cloud profile source');
    assertEqual(p?.byteExact, false, 'a cloud profile without an origin is not byte-exact');
  } finally { await r.app.close(); }

  // the profile doc names another firmware than the running one (a forced import): drift
  r = await defsRig(0x11, [13, 0], { '11_13p0': docFor(0x11, '12.5') });
  try {
    const d = await definitionsOf(r);
    assertEqual(d.profile?.firmware, '12.5', 'the doc\'s firmware is reported as it is');
    assertEqual(d.drift, 'unprofiled', 'profile firmware differs from the running one, and so does the catalog');
  } finally { await r.app.close(); }

  // the running firmware is the catalog's: no drift whatever the profile says
  r = await defsRig(0x11, [12, 0], { '11_12p0': docFor(0x11, '13.0') });
  try {
    const d = await definitionsOf(r);
    assertEqual(d.profile?.firmware, '13.0', 'profile firmware 13.0');
    assertEqual(d.drift, 'none', 'running firmware equals the catalog firmware');
  } finally { await r.app.close(); }

  // FM9: no catalog firmware, so only a profile of the running firmware settles it
  r = await defsRig(0x12, [12, 0], { '12_12p0': docFor(0x12, '12.0') });
  try {
    const d = await definitionsOf(r);
    assertEqual(d.catalogFirmware, null, 'FM9 catalogFirmware null');
    assertEqual(d.drift, 'none', 'FM9 with a profile of the running firmware');
  } finally { await r.app.close(); }
  r = await defsRig(0x12, [12, 0], { '12_12p0': catalogBuilt(0x12) }); // a doc that carries no firmware
  try {
    const d = await definitionsOf(r);
    assertEqual(d.profile?.firmware, null, 'a doc without firmware reports null');
    assertEqual(d.drift, 'unprofiled', 'catalog null, a profile applied that does not name the running firmware');
  } finally { await r.app.close(); }

  // suspect families ride along (sorted), whether or not the rest of the profile is usable
  const swapped = docFor(0x11, '13.0');
  const swap = <T>(o: Record<string, T>) => { const t = o.MIXER!; o.MIXER = o.OUTPUT!; o.OUTPUT = t; };
  swap(swapped.ranges as Record<string, unknown>);
  swap(swapped.enumOverrides as Record<string, unknown>);
  swap(swapped.rangeSections as Record<string, unknown>);
  r = await quiet(() => defsRig(0x11, [13, 0], { '11_13p0': swapped }));
  try {
    assertEqual((await definitionsOf(r)).profile?.suspectFamilies.join(','), 'MIXER,OUTPUT', 'suspect families are listed');
  } finally { await r.app.close(); }
}

// the profile follows the registry: a delete, a firmware without a profile and a model switch all clear it
async function definitionsFollowsRegistry(): Promise<void> {
  const r = await defsRig(0x11, [13, 0], { '11_13p0': docFor(0x11, '13.0') });
  try {
    assertEqual((await definitionsOf(r)).profile?.key, '11_13p0', 'profile applied');

    r.docs.delete('11_13p0'); // what deleteCache does, then re-applies
    await r.registry.applyRuntimeCache();
    let d = await definitionsOf(r);
    assertEqual(d.profile, null, 'after the profile was deleted the bundled catalog is live again');
    assertEqual(d.drift, 'unprofiled', 'and the running firmware 13.0 has no definitions');

    r.docs.set('11_13p0', docFor(0x11, '13.0'));
    await r.registry.applyRuntimeCache();
    assertEqual((await definitionsOf(r)).profile?.key, '11_13p0', 'profile applied again');

    r.fw.v = [13, 1]; // firmware update: no profile for 13.1
    await r.registry.detect();
    d = await definitionsOf(r);
    assertEqual(d.profile, null, 'a firmware without a profile reverts to the bundled catalog');
    assertEqual(d.drift, 'unprofiled', 'drift on 13.1');

    r.fw.v = null; // the firmware read goes silent
    await r.registry.detect();
    d = await definitionsOf(r);
    assertEqual(d.profile, null, 'unknown firmware: no profile');
    assertEqual(d.drift, 'unknown', 'unknown firmware: drift unknown');

    // the profile is a gen-3 grid fact: another unit attached over the same registry (an AM4 detect keeps the
    // previous gen-3 profile object around) must not inherit it, and the FM3 gets it back on return
    r.fw.v = [13, 0];
    await r.registry.detect();
    assertEqual((await definitionsOf(r)).profile?.key, '11_13p0', 'profile applied once more');
    r.model.v = 0x15;
    r.fw.v = null;
    await r.registry.detect();
    d = await definitionsOf(r);
    assertEqual(d.genericParams, false, 'AM4 attached: no generic params');
    assertEqual(d.profile, null, 'AM4 attached: the FM3 profile does not leak into its caps');
    assertEqual(d.catalogFirmware, null, 'AM4 attached: no catalog firmware');
    r.model.v = 0x11;
    r.fw.v = [13, 0];
    await r.registry.detect();
    assertEqual((await definitionsOf(r)).profile?.key, '11_13p0', 'FM3 back: profile applied');
  } finally { await r.app.close(); }
}

// Key order: `definitions` is appended after `virtualEffects` (before telemetryControl/supportsSave), so a
// pretty-printed diff against the previous caps shape is additive-only: no existing line changes.
const PREVIOUS_GRID_CAPS_KEYS = [
  'slotModel', 'slotCount', 'grid', 'hasScenes', 'sceneCount', 'hasChannels', 'channelNames', 'channelBlocks',
  'presets', 'gridRouting', 'gridCursorSelect', 'shuntBase', 'paramsWithoutPack', 'tempo', 'tuner', 'meters',
  'sceneNamesWritable', 'fc', 'modifiers', 'cabIrs', 'selfDescribe', 'cacheImport', 'fullCapture', 'diagnosticCapture',
  'editorLayouts', 'firmwareValidate', 'presetConvert', 'backupDump', 'restoreDump', 'versionStore', 'deviceParams',
  'virtualEffects', 'telemetryControl', 'supportsSave'
];
async function definitionsKeyOrder(): Promise<void> {
  for (const [modelId, name] of [[0x11, 'FM3'], [0x12, 'FM9'], [0x10, 'Axe-Fx III'], [0x15, 'AM4'], [0x01, 'gen-1']] as const) {
    const r = await defsRig(modelId, modelId === 0x11 ? [13, 0] : null, modelId === 0x11 ? { '11_13p0': docFor(0x11, '13.0') } : {});
    try {
      const res = await r.app.inject({ method: 'GET', url: '/device' });
      const caps = (res.json() as { capabilities: Record<string, unknown> }).capabilities;
      const keys = Object.keys(caps);
      // slotCount (grid models) and grid (linear ones) are undefined, hence absent from the JSON; every other key is always there
      const previous = PREVIOUS_GRID_CAPS_KEYS.filter((k) => keys.includes(k) || (k !== 'slotCount' && k !== 'grid'));
      assertEqual(keys.filter((k) => k !== 'definitions').join(','), previous.join(','), `${name}: every previous key keeps its place, none is added or dropped`);
      assertEqual(keys[keys.indexOf('virtualEffects') + 1], 'definitions', `${name}: definitions follows virtualEffects`);
      assertEqual(keys[keys.indexOf('definitions') + 1], 'telemetryControl', `${name}: definitions comes before telemetryControl`);
      assertEqual(Object.keys(caps.definitions as object).join(','), 'genericParams,catalogFirmware,profile,drift,contribute', `${name}: definitions key order`);
      const profile = (caps.definitions as { profile: Record<string, unknown> | null }).profile;
      if (profile) {
        // the profile v2 fields are appended after the M2 ones (contract §7), coverage as { complete, gaps }
        assertEqual(Object.keys(profile).join(','), 'key,source,byteExact,firmware,suspectFamilies,format,sources,coverage', `${name}: definitions.profile key order`);
        assertEqual(Object.keys(profile.coverage as object).join(','), 'complete,gaps', `${name}: definitions.profile.coverage key order`);
      }
      // the pretty-printed diff against the previous shape only adds lines
      const without = { ...caps };
      delete without.definitions;
      const before = JSON.stringify(without, null, 2).split('\n');
      const after = JSON.stringify(caps, null, 2).split('\n');
      const at = after.findIndex((l) => l.startsWith('  "definitions"'));
      const added = after.length - before.length;
      assert(at > 0 && added > 0, `${name}: definitions adds lines`);
      assertEqual(after.slice(0, at).join('\n'), before.slice(0, at).join('\n'), `${name}: no line before the insertion changes`);
      assertEqual(after.slice(at + added).join('\n'), before.slice(at).join('\n'), `${name}: no line after the insertion changes`);
    } finally { await r.app.close(); }
  }
}

// ── profile v2: drift `partial` / `stale` and the document's format, sources and coverage ──
// A rig whose load hook is the real lookup (`loadUsableProfile` over a memory store), so the caps also see a profile
// that is stored but not usable. `driver` replaces the real gen-3 driver (the runtime `unmapped-block` gap).
async function storeRig(modelId: number, firmware: [number, number] | null, docs: Record<string, unknown>, driver?: DeviceDriver) {
  const mock = new MockTransport('serial', `mock-0x${modelId.toString(16)}`);
  mock.reply = (req) => {
    if (isIdentifyBroadcast(req)) return [handshakeReply(modelId)];
    if (firmware && req[0] === 0xf0 && req[5] === 0x08) return [firmwareVersionReply(modelId, firmware[0], firmware[1])];
    return [];
  };
  const s = createStore(createMemStoreBackend(), nodeCodec);
  for (const [k, v] of Object.entries(docs)) s.putDoc('deviceCaches', k, v);
  const registry = __createRegistryForTest({
    resolveConn: async () => ({ transport: 'serial', id: mock.label }),
    openConn: () => mock,
    loadDeviceCache: (key) => loadUsableProfile(s, key)
  });
  if (driver) __setDriverForTest(registry, modelId, driver);
  await registry.detect();
  const app = await buildApp(registry);
  return { registry, store: s, app } as DefsRig & { store: typeof s };
}

/** A gen-3-grid-shaped fake driver whose last read grid holds the effect ids `unmapped.v` no family describes. */
function unmappedFake(unmapped: { v: number[] | null }): DeviceDriver {
  const capabilities = {
    slotModel: 'grid', grid: { rows: 4, cols: 12 }, gridEdit: true, scenes: 8, channels: true,
    presetDump: true, presetConvert: true, blockParamDecode: true,
    telemetry: { tuner: false, outputMeters: false, cpu: false },
    fcModel: false, fcLiveRead: false, modBind: false, cabIrs: false, editorLayouts: true,
    supportsSave: true, selfDescribe: true, cacheImport: true, fullCapture: false,
    deviceEditPush: false, deviceEditWatch: false
  };
  return {
    modelId: 0x11, key: 'fm3', name: 'FM3', capabilities,
    applyRuntimeProfile: () => {},
    unmappedPlacedEffectIds: () => unmapped.v
  } as unknown as DeviceDriver;
}

async function definitionsDriftV2(): Promise<void> {
  const fw13 = { firmware: '13.0' };
  const bytes13 = profileDoc([await editorCacheSource(undefined, fw13)], fw13);
  const live13 = profileDoc([liveSource(liveSeedRecords(), fw13)], fw13);
  const unresolved12 = profileDoc([liveSource(liveSeedRecords(), { stats: { unresolvedReplies: 3 } })]);
  // stored but unusable: a legacy doc of an older schema, and a format-2 doc whose re-derivation fails
  const legacyOld = (fw: string) => { const d = docFor(0x11, fw); return { ...d, meta: { ...d.meta, schema: CACHE_SCHEMA - 1 } }; };
  const failing13 = clone(live13) as unknown as { meta: Record<string, unknown>; raw: { sources: unknown[] } };
  failing13.meta.derivedRevision = 0; // must re-derive …
  failing13.raw.sources.push(clone(failing13.raw.sources[0])); // … and cannot: two sources share one id

  type Case = { name: string; fw: [number, number]; docs: Record<string, unknown>; drift: DefinitionsCaps['drift']; check?: (d: DefinitionsCaps) => void };
  const table: Case[] = [
    {
      name: 'FM3 13.0, a format-2 editor-cache profile of 13.0', fw: [13, 0], docs: { '11_13p0': bytes13 }, drift: 'none',
      check: (d) => {
        assertEqual(d.profile?.format, 2, 'format 2');
        assertEqual(d.profile?.sources.join(','), 'editor-cache', 'sources: the kinds of the raw sources');
        assertEqual(d.profile?.coverage.complete, true, 'complete');
        assertEqual(d.profile?.byteExact, true, 'byte-exact');
      }
    },
    {
      name: 'FM3 13.0, a live-only format-2 profile of 13.0 (ids > 127 missing, newer than the catalog)', fw: [13, 0], docs: { '11_13p0': live13 }, drift: 'partial',
      check: (d) => {
        assertEqual(d.profile?.sources.join(','), 'live-readonly', 'sources');
        assertEqual(d.profile?.coverage.complete, false, 'not complete');
        assert(d.profile!.coverage.gaps.includes('high-ids'), `the blocking high-ids gap is listed (${d.profile!.coverage.gaps.join(',')})`);
      }
    },
    {
      // an applied profile's blocking gap is a real hole also on the catalog's own firmware (contract R14:
      // unresolved replies → blocking gap + drift partial)
      name: 'FM3 12.0 = the catalog firmware, an applied live profile with unresolved replies', fw: [12, 0], docs: { '11_12p0': unresolved12 }, drift: 'partial',
      check: (d) => {
        assertEqual(d.profile?.coverage.complete, false, 'the document gap is reported');
        assert(d.profile!.coverage.gaps.includes('unresolved-replies'), 'unresolved-replies listed');
      }
    },
    {
      name: 'FM3 12.0 = the catalog firmware, an applied live profile without a blocking gap', fw: [12, 0], docs: { '11_12p0': profileDoc([liveSource(liveSeedRecords())]) }, drift: 'none',
      check: (d) => {
        assertEqual(d.profile?.key, '11_12p0', 'applied');
        assertEqual(d.profile?.coverage.complete, true, 'no blocking gap on the catalog firmware');
      }
    },
    { name: 'FM3 13.0, a stored legacy profile of an older schema', fw: [13, 0], docs: { '11_13p0': legacyOld('13.0') }, drift: 'stale', check: (d) => assertEqual(d.profile, null, 'nothing applied') },
    { name: 'FM3 13.0, a stored format-2 profile whose re-derivation fails', fw: [13, 0], docs: { '11_13p0': failing13 }, drift: 'stale', check: (d) => assertEqual(d.profile, null, 'nothing applied') },
    { name: 'FM3 12.0 = the catalog firmware, a stale stored profile', fw: [12, 0], docs: { '11_12p0': legacyOld('12.0') }, drift: 'none' },
    { name: 'FM3 13.0, nothing stored', fw: [13, 0], docs: {}, drift: 'unprofiled' },
    { name: 'FM3 13.0, a stale profile of ANOTHER firmware only', fw: [13, 0], docs: { '11_12p0': legacyOld('12.0') }, drift: 'unprofiled' }
  ];
  for (const c of table) {
    const r = await quiet(() => storeRig(0x11, c.fw, clone(c.docs)));
    try {
      const d = await definitionsOf(r);
      assertEqual(d.drift, c.drift, `${c.name}: drift`);
      c.check?.(d);
    } finally { await r.app.close(); }
  }

  // runtime gap: a placed block no family describes makes an applied profile `partial` (unmapped-block), only
  // while it is placed; without an applied profile the catalog-firmware answer stays
  const unmapped: { v: number[] | null } = { v: [203] };
  let r = await storeRig(0x11, [13, 0], { '11_13p0': clone(bytes13) }, unmappedFake(unmapped));
  try {
    let d = await definitionsOf(r);
    assertEqual(d.drift, 'partial', 'an unmapped placed block: partial');
    assertEqual(d.profile?.coverage.complete, false, 'unmapped block: not complete');
    assertEqual(d.profile?.coverage.gaps.at(-1), 'unmapped-block', 'the runtime gap is appended');
    unmapped.v = [];
    d = await definitionsOf(r);
    assertEqual(d.drift, 'none', 'no unmapped block: none');
    assert(!d.profile!.coverage.gaps.includes('unmapped-block'), 'no runtime gap');
    unmapped.v = null; // no grid read yet
    assertEqual((await definitionsOf(r)).drift, 'none', 'before the first grid read: none');
  } finally { await r.app.close(); }
  unmapped.v = [203];
  r = await storeRig(0x11, [12, 0], {}, unmappedFake(unmapped));
  try {
    const d = await definitionsOf(r);
    assertEqual(d.profile, null, 'catalog firmware, nothing stored: no applied profile');
    assertEqual(d.drift, 'none', 'no applied profile: the runtime gap does not apply');
  } finally { await r.app.close(); }
}

// editor-cache contribution: the gen-3 grid trio (III/FM3/FM9) with a firmware read; false without one and on
// every other device (AM4, Axe-Fx II, VP4, gen-1)
async function definitionsContribute(): Promise<void> {
  for (const [modelId, name, fw] of [[0x10, 'Axe-Fx III', [32, 6]], [0x11, 'FM3', [13, 0]], [0x12, 'FM9', [12, 0]]] as const) {
    let r = await defsRig(modelId, [fw[0], fw[1]]);
    try { assertEqual((await definitionsOf(r)).contribute, true, `${name} with firmware ${fw.join('.')}: contribute`); } finally { await r.app.close(); }
    r = await defsRig(modelId, null);
    try { assertEqual((await definitionsOf(r)).contribute, false, `${name} without a firmware read: no contribute`); } finally { await r.app.close(); }
  }
  for (const [modelId, name] of [[0x15, 'AM4'], [0x07, 'Axe-Fx II'], [0x14, 'VP4'], [0x01, 'gen-1']] as const) {
    const r = await defsRig(modelId, [13, 0]);
    try { assertEqual((await definitionsOf(r)).contribute, false, `${name}: no contribute`); } finally { await r.app.close(); }
  }
}

export async function runCapsTests(): Promise<void> {
  await fm3();
  await fm9();
  await axe3();
  await am4();
  await gen1();
  await fullCaptureFirmwareGate();
  await definitionsGenericFlag();
  await definitionsCatalogFirmware();
  await definitionsDriftWithoutProfile();
  await definitionsAppliedProfile();
  await definitionsFollowsRegistry();
  await definitionsKeyOrder();
  await definitionsContribute();
  await definitionsDriftV2();
}
