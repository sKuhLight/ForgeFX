// Unified route handlers — the NON-TRIVIAL handler bodies shared verbatim by the Fastify app
// (app.ts, including its deprecated /am4/* aliases) and the browser-facing runtime router
// (runtime/router.ts). Each handler resolves the ACTIVE per-device driver from the registry and
// capability-gates optional driver methods: a device that can't do something answers
// `501 {error:'unsupported', capability}` instead of firing another model's frames at it. Handlers
// signal the HTTP status through the minimal StatusSink seam (FastifyReply satisfies it structurally;
// the router uses a tiny status recorder), so the exact same code produces the exact same
// status+body on both surfaces. NO node:/fastify imports — this module must load in a browser.
import type { DeviceRegistry } from '../drivers/registryCore.js';
import { EmptyPresetError, type BlockParamsOpts } from '../drivers/types.js';
import { presetDumpFramesViolation } from '../drivers/sendPolicy.js';
import { definitionsDiff, parseDefinitionsDiffQuery } from '../drivers/definitionsDiff.js';

/** The one reply capability the shared handlers need: set the response status. FastifyReply's
 *  `code()` matches; the runtime router records the status into its RouterResponse. */
export interface StatusSink { code(statusCode: number): unknown }

/** The `?generic=1` opt-in of GET /preset/blocks/:eid/params, parsed the same way on both surfaces: on iff
 *  the FIRST value is `'1'`. Fastify hands a repeated key over as an array (`?generic=1&generic=0` →
 *  `['1', '0']`), URLSearchParams.get returns its first value. */
export function genericFlag(raw: unknown): boolean {
  return (Array.isArray(raw) ? raw[0] : raw) === '1';
}

export function createUnifiedHandlers(registry: DeviceRegistry) {
  const driver = () => registry.driver();

  /** Capability-gate reply: the active driver doesn't implement this optional method. */
  const unsupported = (reply: StatusSink, capability: string) => {
    reply.code(501);
    return { error: 'unsupported', capability };
  };

  // Decode-path errors are surfaced to the client AND logged (console.error → the desktop debug log),
  // so a failing grid/blocks decode (e.g. on Axe-Fx III presets) shows WHY in the user's log, not just 503.
  const decodeFail = (reply: StatusSink, where: string, e: unknown) => {
    const err = e as Error;
    console.error(`[forgefx] ${where} failed: ${err?.message ?? e}${err?.stack ? `\n${err.stack}` : ''}`);
    reply.code(503);
    return { error: err?.message ?? String(e) };
  };

  const gridH = async (reply: StatusSink) => {
    try { return await (await driver()).grid(); } catch (e) { return decodeFail(reply, 'grid decode', e); }
  };
  // ── slot-addressed routes (GET /presets/:n/{grid,summary,params}) ──
  // The route's number arrives as a raw string so a malformed one (`abc`, `-1`, `1.5`, `1e2`, `0x10`) is a
  // clean 400 BEFORE any device access; a well-formed one is then range-checked against the active
  // driver's slot count (`presetCount`, when it knows it) — also 400.
  const parseSlot = (raw: string): number | null => (/^\d{1,5}$/.test(raw) ? Number(raw) : null);
  const slotOutOfRange = (d: { presetCount?: number }, n: number) =>
    d.presetCount != null && n >= d.presetCount ? { error: 'preset number out of range', max: d.presetCount - 1 } : null;

  // Routing grid of the STORED preset in slot `:n` (GET /presets/:n/grid) — never the edit buffer.
  //  • a driver that can dump a stored slot (gen-3: `presetGrid`) answers from that dump, i.e. the SAVED
  //    state of the slot (unsaved edits in the edit buffer are not in it);
  //  • a driver that cannot but can name its loaded slot (`presetRef` — today only the AM4) answers the LIVE
  //    grid when `:n` IS the loaded slot — that is the edit buffer, so it includes unsaved edits;
  //  • everything else (any other slot; gen-1 / gen-2 / VP4, which have neither) answers 501: a named
  //    refusal, never another preset's grid substituted for the one asked for.
  const presetGridH = async (reply: StatusSink, raw: string) => {
    const n = parseSlot(raw);
    if (n == null) { reply.code(400); return { error: 'invalid preset number' }; }
    try {
      const d = await driver();
      const oob = slotOutOfRange(d, n);
      if (oob) { reply.code(400); return oob; }
      if (d.presetGrid) return await d.presetGrid(n);
      if (d.presetRef && (await d.presetRef()).number === n) return await d.grid();
      return unsupported(reply, 'presetDump');
    } catch (e) { return decodeFail(reply, 'preset grid decode', e); }
  };
  // Decode any stored preset by number (non-disruptive) → library summary (GET /presets/:n/summary).
  const presetSummaryH = async (reply: StatusSink, raw: string, full: boolean) => {
    const n = parseSlot(raw);
    if (n == null) { reply.code(400); return { error: 'invalid preset number' }; }
    try {
      const d = await driver();
      const oob = slotOutOfRange(d, n);
      if (oob) { reply.code(400); return oob; }
      if (!d.presetSummary) return unsupported(reply, 'presetDump');
      return await d.presetSummary(n, full);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  // Full per-block decoded params of one stored preset (GET /presets/:n/params) — deep search + browser detail.
  const presetParamsH = async (reply: StatusSink, raw: string) => {
    const n = parseSlot(raw);
    if (n == null) { reply.code(400); return { error: 'invalid preset number' }; }
    try {
      const d = await driver();
      const oob = slotOutOfRange(d, n);
      if (oob) { reply.code(400); return oob; }
      if (!d.presetParams) return unsupported(reply, 'presetDump');
      return { blocks: await d.presetParams(n) };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const blocksH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.placedBlocks) return unsupported(reply, 'placedBlocks');
      return await d.placedBlocks();
    } catch (e) { return decodeFail(reply, 'blocks decode', e); }
  };
  // Lightweight per-block bypass+channel (no preset dump) — the UI applies this to its cached grid on a
  // scene change instead of re-dumping. 501 on drivers without it → the client falls back to a full load.
  const sceneStateH = async (reply: StatusSink) => {
    try {
      const d = await driver();
      if (!d.sceneState) return unsupported(reply, 'sceneState');
      return await d.sceneState();
    } catch (e) { return decodeFail(reply, 'scene-state', e); }
  };
  // `opts.generic` (the `?generic=1` query on both surfaces) asks for the generic response; a driver without
  // it ignores the flag and answers the classic shape. `opts.observe: false` (`?observe=0`) serves the
  // definitions without a device read.
  const blockParamsH = async (reply: StatusSink, addr: number, opts?: BlockParamsOpts) => {
    try {
      const d = await driver();
      if (!d.blockParams) return unsupported(reply, 'blockParams');
      return await d.blockParams(addr, opts);
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  // Unified param write: {value, continuous}. continuous:true → the driver's normalized write
  // (gen-3 continuous SET; AM4 SET_NORM with value as 0..1), continuous:false → discrete ordinal.
  const setParamH = async (reply: StatusSink, addr: number, paramId: number, value: number, continuous: boolean) => {
    const d = await driver();
    if (!d.setParam) return unsupported(reply, 'setParam');
    return d.setParam(addr, paramId, value, continuous);
  };
  const bypassH = async (reply: StatusSink, addr: number, bypassed: boolean) => {
    const d = await driver();
    if (!d.setBypass) return unsupported(reply, 'setBypass');
    return d.setBypass(addr, bypassed);
  };
  const sceneSetH = async (reply: StatusSink, index: number) => {
    const d = await driver();
    if (!d.setScene) return unsupported(reply, 'scenes');
    return d.setScene(index);
  };
  const presetSelectH = async (reply: StatusSink, number: number) => {
    const d = await driver();
    if (!d.selectPreset) return unsupported(reply, 'selectPreset');
    const r = await d.selectPreset(number);
    // `code` is ADDITIVE: the AM4 reports its bank-letter location code (e.g. "C02"); gen-3 doesn't.
    return { ok: r.ok, number, ...(r.code != null ? { code: r.code } : {}) };
  };
  const presetStoreH = async (reply: StatusSink, number?: number) => {
    const d = await driver();
    if (!d.store) return unsupported(reply, 'supportsSave');
    // number omitted → store to the CURRENT slot (needs a live preset-number query).
    const n = number ?? (d.presetRef ? (await d.presetRef()).number : undefined);
    if (n == null || !Number.isFinite(n) || n < 0) { reply.code(400); return { error: 'number required' }; }
    return d.store(n); // gen-3: {ok, acked, location, error?|warning?} (see Gen3Driver.store); AM4: {ok, location, code}
  };
  // Stored preset name: driver-backed where supported (AM4 → {number, name, code}); the gen-3
  // drivers don't implement it, so they keep the pre-Phase-6 {number, name:''} stub byte-identically.
  const presetNameH = async (n: number) => {
    const d = await driver();
    if (d.storedPresetName) {
      try { return await d.storedPresetName(n); } catch { /* device unreachable → stub below */ }
    }
    return { number: n, name: '' };
  };
  const locationsH = async (reply: StatusSink) => {
    const d = await driver();
    if (!d.scanPresets) return unsupported(reply, 'presets.canScanNames');
    try {
      const r = await d.scanPresets();
      return { count: r.count, locations: r.presets };
    } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const backupH = async (reply: StatusSink, location?: number) => {
    const d = await driver();
    if (!d.backupPreset) return unsupported(reply, 'backupDump');
    try { return await d.backupPreset(location); } catch (e) {
      // an unused slot has nothing to back up (its all-zero dump is not a restorable preset): 422, not 503
      reply.code(e instanceof EmptyPresetError ? e.statusCode : 503);
      return { error: (e as Error).message };
    }
  };
  const restoreH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of one preset dump required' }; }
    const d = await driver();
    if (!d.restorePreset) return unsupported(reply, 'restoreDump');
    // Only preset-dump frames for the connected model, split exactly at their own boundaries, reach the
    // driver — no frame hidden inside a chunk behind an inner F7/F0 (drivers/sendPolicy.ts).
    const refused = presetDumpFramesViolation(bytes, d.modelId);
    if (refused) { reply.code(refused.status); return { error: refused.message }; }
    try { return await d.restorePreset(bytes); } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  const fwValidateH = async (reply: StatusSink, bytes?: number[]) => {
    if (!Array.isArray(bytes) || !bytes.length) { reply.code(400); return { error: 'bytes[] of a firmware .syx required' }; }
    const d = await driver();
    if (!d.validateFirmware) return unsupported(reply, 'firmwareValidate');
    return d.validateFirmware(bytes);
  };
  const deviceParamH = async (reply: StatusSink, key?: string, value?: number) => {
    if (!key || value == null) { reply.code(400); return { error: 'key + value required' }; }
    const d = await driver();
    if (!d.setParamByKey) return unsupported(reply, 'deviceParams');
    try { return await d.setParamByKey(key, value); } catch (e) { reply.code(503); return { error: (e as Error).message }; }
  };
  const modModelH = async () => {
    const d = await driver();
    return d.modifierModel ? d.modifierModel() : null;
  };
  // Telemetry cadence-mode control (registry-level, no driver needed). GET serves the current mode +
  // its resolved cadence + the mode list; PUT switches the mode (400 on an unknown value) and the
  // setter emits a `telemetryConfig` event so every live UI reflects it.
  const telemetryConfigH = () => registry.getTelemetryConfig();
  const telemetrySetH = (reply: StatusSink, mode?: string, meters?: boolean) => {
    if (mode == null && typeof meters !== 'boolean') {
      reply.code(400);
      return { error: 'mode or meters is required', modes: registry.telemetryModes() };
    }
    if (mode != null && !registry.telemetryModes().includes(mode as never)) {
      reply.code(400);
      return { error: 'unknown mode', modes: registry.telemetryModes() };
    }
    if (mode != null) registry.setTelemetryMode(mode);
    if (typeof meters === 'boolean') registry.setMeterDemand(meters);
    return registry.getTelemetryConfig();
  };
  // Offline preset decode with model-byte dispatch: sniff frame[4] of the first F0 frame. 0x15 →
  // the AM4 offline decoder (works whatever unit is attached — decode touches no transport);
  // anything else → the active driver's gen-3 decode, byte-identical to the pre-Phase-6 behavior.
  const decodeH = async (reply: StatusSink, bytes: Uint8Array) => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) {
      try { return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) }; }
      catch (e) { reply.code(400); return { error: (e as Error).message }; }
    }
    const d = await driver();
    if (!d.decodePresetBytes) return unsupported(reply, 'presetDump');
    try { return d.decodePresetBytes(bytes); } catch (e) { reply.code(422); return { error: (e as Error).message }; }
  };
  // Same model-byte dispatch as decodeH, but THROWING instead of reply-coding — for callers that
  // decode many files in one request (the local Presets/ scan) and must not touch the route reply.
  const decodeBytes = async (bytes: Uint8Array): Promise<Record<string, unknown>> => {
    const f0 = bytes.indexOf(0xf0);
    const model = f0 >= 0 ? bytes[f0 + 4] : undefined;
    if (model === 0x15) return { model: 'am4', ...registry.am4().decodeSyx([...bytes]) } as Record<string, unknown>;
    const d = await driver();
    if (!d.decodePresetBytes) throw new Error('unsupported: presetDump');
    return d.decodePresetBytes(bytes) as Record<string, unknown>;
  };

  // GET /device/definitions/diff — the bundled catalog against the applied profile (drivers/definitionsDiff.ts), from
  // state the registry already holds: never a detection, a store read or a device frame. 503 `no-device` before a unit
  // was identified; 501 unsupported(genericParams) on a driver without the generic params (not a gen-3 grid unit); 503
  // `firmware-unknown` while the firmware was not read; 404 `unknown-family` for a `family` neither the catalog nor
  // the profile has. `query` holds the raw `family` / `include` values as the surface parsed them.
  const definitionsDiffH = (reply: StatusSink, query: { family?: unknown; include?: unknown }) => {
    if (registry.detectedModelId < 0) { reply.code(503); return { error: 'no-device' }; }
    const ctx = registry.definitionsDiffContext();
    if (!ctx || !ctx.caps.genericParams) return unsupported(reply, 'genericParams');
    if (ctx.firmware === null) { reply.code(503); return { error: 'firmware-unknown' }; }
    const r = definitionsDiff({
      model: ctx.model, firmware: ctx.firmware, state: ctx.caps.drift, staticProfile: ctx.staticProfile, applied: ctx.applied,
      placedEids: ctx.placedEids, unmappedEids: ctx.unmappedEids
    }, parseDefinitionsDiffQuery(query.family, query.include));
    if (!r.ok) { reply.code(404); return { error: r.error, family: r.family }; }
    return r.diff;
  };

  return {
    driver, unsupported, decodeFail,
    gridH, presetGridH, presetSummaryH, presetParamsH, blocksH, sceneStateH, blockParamsH, setParamH, bypassH, sceneSetH,
    presetSelectH, presetStoreH, presetNameH, locationsH,
    backupH, restoreH, fwValidateH, deviceParamH, modModelH,
    telemetryConfigH, telemetrySetH,
    decodeH, decodeBytes,
    definitionsDiffH
  };
}
