// ForgeFX server test runner — mocked-transport unit tests, NO hardware required.
// Same style as forgefx-midi's test/run-all.ts: each suite exports a run*Tests() that throws on
// failure; the runner prints PASS/FAIL per suite and exits non-zero when anything failed.
//
// Run: npm test   (tsx test/run-all.ts)
import './helpers/env.js'; // MUST stay the first import: isolates ~/.forgefx-conn before transport/connection.ts loads
import { runRequestQueueTests, REQUEST_QUEUE_CASE_COUNT } from './transport/request-queue.test.js';
import { runTransportWiringTests, TRANSPORT_WIRING_CASE_COUNT } from './transport/transport-wiring.test.js';
import { runReplyMatchingTests, REPLY_MATCHING_CASE_COUNT } from './drivers/reply-matching.test.js';
import { runDetectionTests, DETECTION_CASE_COUNT } from './drivers/detection.test.js';
import { runGen2Tests, GEN2_CASE_COUNT } from './drivers/gen2.test.js';
import { runGen1Tests, GEN1_CASE_COUNT } from './drivers/gen1.test.js';
import { runAm4Tests, AM4_CASE_COUNT } from './drivers/am4.test.js';
import { runAm4EditWatchTests, AM4_EDITWATCH_CASE_COUNT } from './drivers/am4-editwatch.test.js';
import { runVp4Tests, VP4_CASE_COUNT } from './drivers/vp4.test.js';
import { runModelByteTests, MODELBYTE_CASE_COUNT } from './drivers/modelbyte.test.js';
import { runGen3StoreTests, GEN3_STORE_CASE_COUNT } from './drivers/gen3-store.test.js';
import { runGen3PlaceGuardTests, GEN3_PLACE_GUARD_CASE_COUNT } from './drivers/gen3-place-guard.test.js';
import { runWriteRejectionTests, WRITE_REJECTION_CASE_COUNT } from './drivers/write-rejection.test.js';
import { runDefinitionCompletenessTests, DEFINITION_COMPLETENESS_CASE_COUNT } from './drivers/definition-completeness.test.js';
import { runChannelSliceTests, CHANNEL_SLICE_CASE_COUNT } from './drivers/channel-slice.test.js';
import { runWalkReclassificationTests, WALK_RECLASSIFICATION_CASE_COUNT } from './drivers/walk-reclassification.test.js';
import { runKnobUnitsTests, KNOB_UNITS_CASE_COUNT } from './drivers/knob-units.test.js';
import { runFloatRowSelectorsTests, FLOAT_ROW_SELECTORS_CASE_COUNT } from './drivers/float-row-selectors.test.js';
import { runTablesTests, TABLES_CASE_COUNT } from './drivers/tables.test.js';
import { runLayoutsTests, LAYOUTS_CASE_COUNT } from './drivers/layouts.test.js';
import { runProfileFactsTests, PROFILE_FACTS_CASE_COUNT } from './drivers/profile-facts.test.js';
import { runSelectorsTests, SELECTORS_CASE_COUNT } from './drivers/selectors.test.js';
import { runParamIndexTests, PARAM_INDEX_CASE_COUNT } from './drivers/param-index.test.js';
import { runBlockParamsV2Tests, BLOCK_PARAMS_V2_CASE_COUNT } from './drivers/block-params-v2.test.js';
import { runWriteGuardsTests, WRITE_GUARDS_CASE_COUNT } from './drivers/write-guards.test.js';
import { runEnumOptionsTests, ENUM_OPTIONS_CASE_COUNT } from './drivers/enum-options.test.js';
import { runEditBurstGenericTests, EDIT_BURST_GENERIC_CASE_COUNT } from './drivers/edit-burst-generic.test.js';
import { runTelemetryTests, TELEMETRY_CASE_COUNT } from './drivers/telemetry.test.js';
import { runReflectionTests, REFLECTION_CASE_COUNT } from './drivers/reflection.test.js';
import { runAliasParityTests, ALIAS_PARITY_CASE_COUNT } from './api/alias-parity.test.js';
import { runCapsTests, CAPS_CASE_COUNT } from './api/caps.test.js';
import { runTelemetryConfigTests, TELEMETRY_CONFIG_CASE_COUNT } from './api/telemetryConfig.test.js';
import { runRemoteTests, REMOTE_CASE_COUNT } from './api/remote.test.js';
import { runSendPolicyTests, SEND_POLICY_CASE_COUNT } from './api/send-policy.test.js';
import { runLocalTests, LOCAL_CASE_COUNT } from './api/local.test.js';
import { runSyncPlanTests, SYNCPLAN_CASE_COUNT } from './api/syncplan.test.js';
import { runRouterParityTests, ROUTER_PARITY_CASE_COUNT } from './api/router.test.js';
import { runDeviceCacheTests, DEVICE_CACHE_CASE_COUNT } from './api/device-cache.test.js';
import { runEditorCacheImportTests, EDITOR_CACHE_IMPORT_CASE_COUNT } from './api/editor-cache-import.test.js';
import { runCloudProfilesTests, CLOUD_PROFILES_CASE_COUNT } from './api/cloud-profiles.test.js';
import { runProfileSchemaTests, PROFILE_SCHEMA_CASE_COUNT } from './api/profile-schema.test.js';
import { runPresetConvertTests, PRESET_CONVERT_CASE_COUNT } from './api/preset-convert.test.js';
import { runPresetConvertExportTests, PRESET_CONVERT_EXPORT_CASE_COUNT } from './api/preset-convert-export.test.js';
import { runEmptySlotTests, EMPTY_SLOT_CASE_COUNT } from './api/empty-slot.test.js';
import { runPresetGridSlotTests, PRESET_GRID_SLOT_CASE_COUNT } from './api/preset-grid-slot.test.js';
import { runDiagnosticCaptureTests, DIAGNOSTIC_CAPTURE_CASE_COUNT } from './api/diagnostic-capture.test.js';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  { name: `transport/request-queue (${REQUEST_QUEUE_CASE_COUNT} cases, lost/late/incomplete reply, unrelated frames, quiet gap, bounded drain + floor, reject-only hold-back, guards, close, paced send; fake link, virtual time)`, run: runRequestQueueTests },
  { name: `transport/transport-wiring (${TRANSPORT_WIRING_CASE_COUNT} cases, real serial + MIDI transports on the queue over fake ports)`, run: runTransportWiringTests },
  { name: `drivers/reply-matching (${REPLY_MATCHING_CASE_COUNT} cases, per-model dump header policy, per-block bulk reads, store + write echoes, AM4 backup location over the real queue)`, run: runReplyMatchingTests },
  { name: `drivers/detection (${DETECTION_CASE_COUNT} cases, mocked Conn/Transport)`, run: runDetectionTests },
  { name: `drivers/gen2 (${GEN2_CASE_COUNT} cases, Axe-Fx II write frames + caps)`, run: runGen2Tests },
  { name: `drivers/gen1 (${GEN1_CASE_COUNT} cases, Axe-Fx gen-1 dump grid + caps)`, run: runGen1Tests },
  { name: `drivers/am4 (${AM4_CASE_COUNT} cases, None-selector + decode enrichment)`, run: runAm4Tests },
  { name: `drivers/am4-editwatch (${AM4_EDITWATCH_CASE_COUNT} transition-gated edit-watch cases, scripted MockTransport)`, run: runAm4EditWatchTests },
  { name: `drivers/vp4 (${VP4_CASE_COUNT} cases, VP4 gated writes + structure read + caps)`, run: runVp4Tests },
  { name: `drivers/modelbyte (${MODELBYTE_CASE_COUNT} cases, wrong-model-byte guard)`, run: runModelByteTests },
  { name: `drivers/gen3-store (${GEN3_STORE_CASE_COUNT} cases, store waits for the device ack: ack/late ack/no ack/0x64, virtual-time transport)`, run: runGen3StoreTests },
  { name: `drivers/gen3-place-guard (${GEN3_PLACE_GUARD_CASE_COUNT} cases, placeCell refuses a block already in the grid: 409 + nothing written, cached hit confirmed fresh, same-cell no-op, Axis move flow, unreadable grid falls back, shunts exempt with zero reads, slow link never starts a read, III/FM3/FM9, app↔router parity; mocked)`, run: runGen3PlaceGuardTests },
  { name: `drivers/write-rejection (${WRITE_REJECTION_CASE_COUNT} cases, 0x64 attributed by echoed function, reject-only write timing over the real queue)`, run: runWriteRejectionTests },
  { name: `drivers/definition-completeness (${DEFINITION_COMPLETENESS_CASE_COUNT} cases, blockParams unit/taper passthrough)`, run: runDefinitionCompletenessTests },
  { name: `drivers/channel-slice (${CHANNEL_SLICE_CASE_COUNT} cases, fn-0x1F channel stride, cache overlay by provenance, channel-less edit diffs)`, run: runChannelSliceTests },
  { name: `drivers/walk-reclassification (${WALK_RECLASSIFICATION_CASE_COUNT} cases, non-byte-exact profiles never reclassify a catalog kind; editor-cache / cloud-from-cache override)`, run: runWalkReclassificationTests },
  { name: `drivers/knob-units (${KNOB_UNITS_CASE_COUNT} cases, knob selection: continuous units in, selectors and steppers out)`, run: runKnobUnitsTests },
  { name: `drivers/float-row-selectors (${FLOAT_ROW_SELECTORS_CASE_COUNT} cases, float-row selectors: the III global-mix toggles list as enums, nothing else changes category)`, run: runFloatRowSelectorsTests },
  { name: `drivers/tables (${TABLES_CASE_COUNT} identity checks, paramId cross-contamination guard)`, run: runTablesTests },
  { name: `drivers/layouts (${LAYOUTS_CASE_COUNT} editor-layout v2 variant-selection + passthrough)`, run: runLayoutsTests },
  { name: `drivers/profile-facts (${PROFILE_FACTS_CASE_COUNT} cases, runtime-profile provenance + applied rows + section-assignment suspects, registry reverts to the bundled profile after a delete / a firmware without a profile / an unknown firmware; synthetic + catalog data, mocked)`, run: runProfileFactsTests },
  { name: `drivers/selectors (${SELECTORS_CASE_COUNT} cases, type vs variant selector per device, layout widget index: ownership, pseudo ids, conflicts, memo; catalog + synthetic)`, run: runSelectorsTests },
  { name: `drivers/param-index (${PARAM_INDEX_CASE_COUNT} cases, catalog/profile reconciliation: the five cases + unnamed, name shift + guards, live never hides, byte-exact removal, suspect family, widget/write table, FM3 goldens, no enum in named over FM3/FM9/III; synthetic + catalog)`, run: runParamIndexTests },
  { name: `drivers/block-params-v2 (${BLOCK_PARAMS_V2_CASE_COUNT} cases, generic block params over a mocked status + bulk read: null values per reason (non-positional GLOBAL, torn body, read-failed, unknown channel, out-of-range), classification and fingerprints, hidden rows, de-duplication on copies, selectors and the cab layout variant, diagnostic hook (strict parse, one warning), layout button binding, status read retried once (timeouts per path), concurrent status reads coalesced, no status read for channel-less blocks, served channel, moved type selector (classic + meters), unmapped codec block, GLOBAL served without a read; classic response markers; catalog data)`, run: runBlockParamsV2Tests },
  { name: `drivers/write-guards (${WRITE_GUARDS_CASE_COUNT} cases, gen-3 param writes refused before the wire: no wire pid → 400, unused slot without a param (catalog, byte-exact; live: effective row only; suspect family exempt) → 409; MOD_MIN/MAX/PARAM, CHORUS_GLOBALMIX, FC and row-less ids, write:null stay writable; FM3/FM9/III; app↔router parity; catalog + synthetic rows)`, run: runWriteGuardsTests },
  { name: `drivers/enum-options (${ENUM_OPTIONS_CASE_COUNT} cases, selector options on FM3/FM9/III, classic and generic: label of ordinal v = list[v - first ordinal] (DELAY_SVFTYPE), 138-option DISTORT_TONETYPE, PHASER_ORDER = six ordinals, 4096 cap + optionsTruncated, overlay / bare-ordinal fallback; catalog + synthetic rows)`, run: runEnumOptionsTests },
  { name: `drivers/edit-burst-generic (${EDIT_BURST_GENERIC_CASE_COUNT} cases, device-edit events for generic params (burst and FM3 poll), unused slots and dropped rows silent, GLOBAL: no events / no baseline / no reload / not polled; catalog + one synthetic row, mocked)`, run: runEditBurstGenericTests },
  { name: `drivers/telemetry (${TELEMETRY_CASE_COUNT} cadence/traffic/echo-guard/yield cases)`, run: runTelemetryTests },
  { name: `drivers/reflection (${REFLECTION_CASE_COUNT} slow-link/scene-state/blockState/scene cases)`, run: runReflectionTests },
  { name: `api/alias-parity (${ALIAS_PARITY_CASE_COUNT} alias↔unified twins, mocked AM4)`, run: runAliasParityTests },
  { name: `api/caps (${CAPS_CASE_COUNT} cases, device capability matrices + capabilities.definitions: generic support, catalog firmware, applied profile, drift, key order)`, run: runCapsTests },
  { name: `api/telemetryConfig (${TELEMETRY_CONFIG_CASE_COUNT} GET/PUT mode + event + parity)`, run: runTelemetryConfigTests },
  { name: `api/remote (${REMOTE_CASE_COUNT} cases, whitelist decisions + relayed refused/accepted param writes over a fake channel)`, run: runRemoteTests },
  { name: `api/send-policy (${SEND_POLICY_CASE_COUNT} cases, /debug/raw allowlist + read-poll identity, preset-dump load/restore validation, mocked FM3/AM4/II)`, run: runSendPolicyTests },
  { name: `api/local (${LOCAL_CASE_COUNT} local-folder cases, temp root)`, run: runLocalTests },
  { name: `api/syncplan (${SYNCPLAN_CASE_COUNT} free-tier reconcile plans, pure)`, run: runSyncPlanTests },
  { name: `api/router (${ROUTER_PARITY_CASE_COUNT} app↔runtime-router parity twins, mocked FM3 + a classic-only AM4 for ?generic=1)`, run: runRouterParityTests },
  { name: `api/device-cache (${DEVICE_CACHE_CASE_COUNT} cases, on-connect self-describe build, mocked FM3/AM4)`, run: runDeviceCacheTests },
  { name: `api/editor-cache-import (${EDITOR_CACHE_IMPORT_CASE_COUNT} cases, .cache byte-source import + disk discovery, mocked FM3/AM4)`, run: runEditorCacheImportTests },
  { name: `api/cloud-profiles (${CLOUD_PROFILES_CASE_COUNT} cases, shared profile check/pull/publish, mocked cloud)`, run: runCloudProfilesTests },
  { name: `api/profile-schema (${PROFILE_SCHEMA_CASE_COUNT} cases, stale profile gate: runtime apply, status, build, import/sources, cloud check/pull/publish, walk limits, app↔router parity, mocked FM3)`, run: runProfileSchemaTests },
  { name: `api/preset-convert (${PRESET_CONVERT_CASE_COUNT} cases, cross-device convert offline/connected/501/caps, mocked)`, run: runPresetConvertTests },
  { name: `api/preset-convert-export (${PRESET_CONVERT_EXPORT_CASE_COUNT} cases, FM3→FM3 author round-trip + guards, mocked)`, run: runPresetConvertExportTests },
  { name: `api/empty-slot (${EMPTY_SLOT_CASE_COUNT} cases, unused-slot summary/params/decode/backup/convert/local folder on app + router, mocked FM3)`, run: runEmptySlotTests },
  { name: `api/preset-grid-slot (${PRESET_GRID_SLOT_CASE_COUNT} cases, GET /presets/:n/grid = stored slot never the edit buffer, app↔router, mocked)`, run: runPresetGridSlotTests },
  { name: `api/diagnostic-capture (${DIAGNOSTIC_CAPTURE_CASE_COUNT} cases, steps, stop at first silence, dump headers, reload skip on unsaved edits, bundle on cancel/silence/error/query-bound, redaction, 409/400/501/503, upload, telemetry hold, caps; synthetic FM3)`, run: runDiagnosticCaptureTests }
];

let failures = 0;

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test suite(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test suite(s) passed.`);
process.exit(0); // detection tests may leave a just-cleared timer microtask behind — exit explicitly
