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
import { runUnmappedBlocksTests, UNMAPPED_BLOCKS_CASE_COUNT } from './drivers/unmapped-blocks.test.js';
import { runUnknownBlocksTests, UNKNOWN_BLOCKS_CASE_COUNT } from './drivers/unknown-blocks.test.js';
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
import { runParamCoverageTests, PARAM_COVERAGE_CASE_COUNT } from './drivers/param-coverage.test.js';
import { runNewerFirmwareGoldenTests, NEWER_FIRMWARE_GOLDEN_CASE_COUNT } from './drivers/newer-firmware-golden.test.js';
import { runDefinitionsDiffTests, DEFINITIONS_DIFF_CASE_COUNT } from './drivers/definitions-diff.test.js';
import { runCrossFamilyLayoutTests, CROSS_FAMILY_LAYOUT_CASE_COUNT } from './drivers/cross-family-layout.test.js';
import { runProfileCheckTests, PROFILE_CHECK_CASE_COUNT } from './scripts/profile-check.test.js';
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
import { runWalkScopeTests, WALK_SCOPE_CASE_COUNT } from './api/walk-scope.test.js';
import { runEditorCacheImportTests, EDITOR_CACHE_IMPORT_CASE_COUNT } from './api/editor-cache-import.test.js';
import { runOriginGuardTests, ORIGIN_GUARD_CASE_COUNT } from './api/origin-guard.test.js';
import { runStorePrivateTests, STORE_PRIVATE_CASE_COUNT } from './api/store-private.test.js';
import { runCloudOriginTests, CLOUD_ORIGIN_CASE_COUNT } from './api/cloud-origin.test.js';
import { runCacheContributionTests, CACHE_CONTRIBUTION_CASE_COUNT } from './api/cache-contribution.test.js';
import { runCacheContributionUploadTests, CACHE_CONTRIBUTION_UPLOAD_CASE_COUNT } from './api/cache-contribution-upload.test.js';
import { runCloudProfilesTests, CLOUD_PROFILES_CASE_COUNT } from './api/cloud-profiles.test.js';
import { runProfileSchemaTests, PROFILE_SCHEMA_CASE_COUNT } from './api/profile-schema.test.js';
import { runProfileV2Tests, PROFILE_V2_CASE_COUNT } from './api/profile-v2.test.js';
import { runProfileMergeTests, PROFILE_MERGE_CASE_COUNT } from './api/profile-merge.test.js';
import { runDefinitionsFileTests, DEFINITIONS_FILE_CASE_COUNT } from './api/definitions-file.test.js';
import { runPresetConvertTests, PRESET_CONVERT_CASE_COUNT } from './api/preset-convert.test.js';
import { runPresetConvertExportTests, PRESET_CONVERT_EXPORT_CASE_COUNT } from './api/preset-convert-export.test.js';
import { runEmptySlotTests, EMPTY_SLOT_CASE_COUNT } from './api/empty-slot.test.js';
import { runPresetGridSlotTests, PRESET_GRID_SLOT_CASE_COUNT } from './api/preset-grid-slot.test.js';
import { runDiagnosticCaptureTests, DIAGNOSTIC_CAPTURE_CASE_COUNT } from './api/diagnostic-capture.test.js';
import { runDiagnosticWalkStepsTests, DIAGNOSTIC_WALK_STEPS_CASE_COUNT } from './api/diagnostic-walk-steps.test.js';
import { runHttpPolicyTests, HTTP_POLICY_CASE_COUNT } from './api/http-policy.test.js';

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
  { name: `drivers/unmapped-blocks (${UNMAPPED_BLOCKS_CASE_COUNT} cases, the runtime unmapped-block gap through the real gen-3 driver: only a placed block no family describes (profile, static roster/instance spans incl. III Input 5 and roster blocks, confirmed block map), SSE definitions/unmapped-blocks on a change only, forgotten on a new session or transport, grid → caps gap + drift partial/none through the registry; codec-authored synthetic grids, mocked III/FM3/FM9)`, run: runUnmappedBlocksTests },
  { name: `drivers/unknown-blocks (${UNKNOWN_BLOCKS_CASE_COUNT} cases, blocks the catalog cannot place (M3 WP-F5): likely by bulk shape = read-only generic (unconfirmed-block, PUT 409 nothing sent), candidates/none list nothing and are not guarded, live-only read-only (live-only-block), the block probe (preconditions in order with zero traffic, scope + ceiling + watchdog at the wire, 504 with the claim held until the walk settles, live-probe source replaced per block, re-derived + persisted + applied, SSE block-probe once, confirmed = writable, router twin parity), FORGEFX-45 III roster ids read-only and never hinted/bounded, the hide hook (effect table, static roster, familyFirstEid, inventory, one warning, production/malformed ignored, leave-one-out RESONATOR via probe and FORMANT via a read-only walk, meta.derivedHidden both ways), walk-scope gates fail closed, one confidence→state mapping for params and diff, instance/bridged blocks share their key; synthetic + catalog data, mocked FM3/III/AM4)`, run: runUnknownBlocksTests },
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
  { name: `drivers/block-params-v2 (${BLOCK_PARAMS_V2_CASE_COUNT} cases, generic block params over a mocked status + bulk read: null values per reason (non-positional GLOBAL, torn body, read-failed, unknown channel, out-of-range), classification and fingerprints, hidden rows, de-duplication on copies, selectors and the cab layout variant, diagnostic hook (strict parse, one warning), layout button binding, status read retried once (timeouts per path), concurrent status reads coalesced, no status read for channel-less blocks, served channel, moved type selector (classic + meters), unmapped codec block, GLOBAL served without a read, generic layout follows moved names (dropped ones unbound, III meters stay bound), a pending status request joined only with no longer timeout, a status read after an awaited write asks again (serialised queue); classic response markers; catalog data)`, run: runBlockParamsV2Tests },
  { name: `drivers/write-guards (${WRITE_GUARDS_CASE_COUNT} cases, gen-3 param writes refused before the wire: no wire pid → 400, unused slot without a param (catalog, byte-exact; live: effective row only; suspect family exempt) → 409; MOD_MIN/MAX/PARAM, CHORUS_GLOBALMIX, FC and row-less ids, write:null stay writable; FM3/FM9/III; app↔router parity; catalog + synthetic rows)`, run: runWriteGuardsTests },
  { name: `drivers/enum-options (${ENUM_OPTIONS_CASE_COUNT} cases, selector options on FM3/FM9/III, classic and generic: label of ordinal v = list[v - first ordinal] (DELAY_SVFTYPE), 138-option DISTORT_TONETYPE, PHASER_ORDER = six ordinals, 4096 cap + optionsTruncated, overlay / bare-ordinal fallback; catalog + synthetic rows)`, run: runEnumOptionsTests },
  { name: `drivers/edit-burst-generic (${EDIT_BURST_GENERIC_CASE_COUNT} cases, device-edit events for generic params (burst and FM3 poll), unused slots and dropped rows silent, GLOBAL: no events / no baseline / no reload / not polled; catalog + one synthetic row, mocked)`, run: runEditBurstGenericTests },
  { name: `drivers/param-coverage (${PARAM_COVERAGE_CASE_COUNT} cases, generic block params over every first-instance eid of FM3/FM9/III, catalog and byte-exact catalog profile: listed = informative - bypass - type - by design, listed + hidden = informative, per-device totals with their scope (FM3 1611/27, FM9 1685/49, III 1947|1936/30 incl. the six read-only roster families); a synthetic newer firmware, byte-exact and live: new params, unused slot (409), dropped param, inserted rows (names follow / ambiguous window), revised rows, swapped sections, unknown block; invariants; catalog + synthetic, mocked)`, run: runParamCoverageTests },
  { name: `drivers/newer-firmware-golden (${NEWER_FIRMWARE_GOLDEN_CASE_COUNT} cases, exact goldens of the generic response for 8 FM3 blocks on the catalog profile and on a synthetic newer firmware, deterministic synthetic bodies, lossless stored form, size bound; UPDATE_GOLDEN=1 regenerates; catalog + synthetic, mocked)`, run: runNewerFirmwareGoldenTests },
  { name: `drivers/definitions-diff (${DEFINITIONS_DIFF_CASE_COUNT} cases, GET /device/definitions/diff: catalog profile and no profile empty with state none, newer-firmware profile v2 document exact golden (UPDATE_GOLDEN=1 regenerates), summary = compareRows counts (independent suspects), deletion shift (freed slot P<pid>, vanished name removed, movedFrom), legacy format 1, live-only removed null, suspect (removed null) + disagreement families, family/include filters + 404 unknown-family, route reads no device (state = caps drift, body = builder), 501/503 gates, router twin parity; catalog + synthetic, mocked FM3/AM4)`, run: runDefinitionsDiffTests },
  { name: `drivers/cross-family-layout (${CROSS_FAMILY_LAYOUT_CASE_COUNT} cases, FORGEFX-48 + WP-F7: generic layout controls that address another block follow the REFERENCED family's names (moved pid + movedFrom, dropped name unbound) and carry the owning crossBlock.effectId from the device's own table (instance > 1 bounded by the device's instance count, MOD/PRESET/unknown family null, block-map confirmed family, GLOBAL refs keep the eid-1 write guard), classic layout untouched; DELAY variants keyed by DELAY_TYPE, MULTITAP current-firmware variant, layout firmware gates on the connected firmware incl. the TREMOLO fallback; catalog + synthetic, mocked FM3/FM9/III)`, run: runCrossFamilyLayoutTests },
  { name: `drivers/telemetry (${TELEMETRY_CASE_COUNT} cadence/traffic/echo-guard/yield cases)`, run: runTelemetryTests },
  { name: `drivers/reflection (${REFLECTION_CASE_COUNT} slow-link/scene-state/blockState/scene cases)`, run: runReflectionTests },
  { name: `scripts/profile-check (${PROFILE_CHECK_CASE_COUNT} cases, offline document tools of scripts/profile-check.ts: plain run unchanged (JSON keys), --rederive equal / tampered row / older-revision warning / derivation failure / format-1 no-raw, --diff catalog empty + newer firmware = the definitions-diff golden, --merge editor cache + live walk (provenance, coverage, invariants) and model / format-1 / firmware refusals exit 2, --blocks map + unassigned sections + unmapped eids + no-rows finding + Axe-Fx III roster, usage; catalog + synthetic docs)`, run: runProfileCheckTests },
  { name: `api/alias-parity (${ALIAS_PARITY_CASE_COUNT} alias↔unified twins, mocked AM4)`, run: runAliasParityTests },
  { name: `api/caps (${CAPS_CASE_COUNT} cases, device capability matrices + capabilities.definitions: generic support, catalog firmware, applied profile, drift, key order)`, run: runCapsTests },
  { name: `api/telemetryConfig (${TELEMETRY_CONFIG_CASE_COUNT} GET/PUT mode + event + parity)`, run: runTelemetryConfigTests },
  { name: `api/remote (${REMOTE_CASE_COUNT} cases, whitelist decisions + relayed refused/accepted param writes over a fake channel)`, run: runRemoteTests },
  { name: `api/send-policy (${SEND_POLICY_CASE_COUNT} cases, /debug/raw allowlist + read-poll identity, preset-dump load/restore validation, mocked FM3/AM4/II)`, run: runSendPolicyTests },
  { name: `api/local (${LOCAL_CASE_COUNT} local-folder cases, temp root)`, run: runLocalTests },
  { name: `api/syncplan (${SYNCPLAN_CASE_COUNT} free-tier reconcile plans, pure)`, run: runSyncPlanTests },
  { name: `api/router (${ROUTER_PARITY_CASE_COUNT} app↔runtime-router parity twins, mocked FM3 + a classic-only AM4 for ?generic=1)`, run: runRouterParityTests },
  { name: `api/device-cache (${DEVICE_CACHE_CASE_COUNT} cases, on-connect self-describe build, mocked FM3/AM4)`, run: runDeviceCacheTests },
  { name: `api/walk-scope (${WALK_SCOPE_CASE_COUNT} cases, M3 WP-F6 walk scope: extension bounds per device (FM3 DISTORT 175 / CONTROLLERS 161 / GLOBAL 163 + the present roster blocks above 160, III CONTROLLERS 209, nothing above 255, never block 0/190/199/200/roster-only/absent instances, cloud/file/live never widen), budget formula + phase-B options, gates fail closed, the override needs FORGEFX_DEV_HOOKS=1 / ignored in production / no hook on the router twin, phase A persisted before phase B, phase B joins phase A's source (extended, done) + already rule, aborts (implausible at 140, silent run, liveness, budget, cancel) keep phase A marked aborted, bound watchdog at the host adapter (refused unsent, build error, nothing of that phase persisted), transport timeout = lost reply, SSE extension done/skipped/aborted, caps walk per gate, bound-hit gap, instance evidence, the opt-in of all three development hooks, gates judged on a fresh firmware read (changed / unreadable), full mode standard by default, a fixed abortReason vocabulary (no message stored or exported), empty-block abort + superseded loss counters, exact roster lists per model, an H3 dry run of the real walk (each block to exactly its bound; implausible at 140 aborts), derivation failure and late cancel keep phase A; catalog + synthetic, mocked FM3/FM9/III/VP4)`, run: runWalkScopeTests },
  { name: `api/editor-cache-import (${EDITOR_CACHE_IMPORT_CASE_COUNT} cases, .cache byte-source import + disk discovery, mocked FM3/AM4)`, run: runEditorCacheImportTests },
  { name: `api/origin-guard (${ORIGIN_GUARD_CASE_COUNT} cases, FORGEFX-47: loopback-origin guard on the editor-cache routes (foreign origin and null → 403 before any fs access; no Origin, loopback, Axis desktop + Vite dev origins allowed), discovered-path allowlist on the path import (400, never stat-ed or read; Windows case folding), LAN same-origin bytes import allowed (path import + listing stay 403, Origin/Host mismatch 403), router twin, Remote relay; temp trees, mocked FM3)`, run: runOriginGuardTests },
  { name: `api/store-private (${STORE_PRIVATE_CASE_COUNT} cases, the auth sessions (store collection cloud) never reachable over /store/* (any spelling, any origin, router twin, Remote relay: 403 forbidden-collection, a foreign origin forbidden-origin first, nothing read or changed), removal blanks the token, old tombstones scrubbed, sign-out leaves no token on disk; mocked FM3, faked auth endpoint)`, run: runStorePrivateTests },
  { name: `api/cloud-origin (${CLOUD_ORIGIN_CASE_COUNT} cases, /cloud/* and /remote/* refuse foreign origins (incl. null and a foreign page against a LAN server) with 403 forbidden-origin; no Origin, loopback and same-origin pass; AXIS_CLOUD on with the client configured off, and the off stubs; no network)`, run: runCloudOriginTests },
  { name: `api/cache-contribution (${CACHE_CONTRIBUTION_CASE_COUNT} cases, editor-cache contribution, local half: validation matrix (413/empty/name/model/firmware-differs + accept/garbage/renamed/header-walk/unrelated/AM4 content/unknown firmware/AM4 device), preview numbers + redaction counts + sha256 of the redacted bytes + reserve body, no original name in any answer, consent gate (v2 only, before any read), discovered-path allowlist, strict origin guard on all four routes, dry-run copy on disk, decisions (asked expiry/declined/reset/persisted), status matrix, router parity; synthetic caches, temp trees, mocked FM3/AM4)`, run: runCacheContributionTests },
  { name: `api/cache-contribution-upload (${CACHE_CONTRIBUTION_UPLOAD_CASE_COUNT} cases, editor-cache contribution, cloud half: wanted → offer/reason + 10-min cache, upload of the redacted bytes + persisted decision, own/cross-uploader dedupe, error mapping (401/anonymous/403/429 scope/413/409/422 invalid-cache/503 paused/502), coupled import (kept on upload failure, stops the upload on failure, newer-profile, mismatch), dry-run env = zero cloud writes, withdraw (ok/401/404/502/reset keeps it), Remote relay refused, signed-upload flow, Cloud sessions over a faked Supabase (anonymous slot, account slot untouched); structural fake cloud, no network)`, run: runCacheContributionUploadTests },
  { name: `api/cloud-profiles (${CLOUD_PROFILES_CASE_COUNT} cases, shared profile check/pull/publish, mocked cloud)`, run: runCloudProfilesTests },
  { name: `api/profile-schema (${PROFILE_SCHEMA_CASE_COUNT} cases, stale profile gate: runtime apply, status, build, import/sources, cloud check/pull/publish, walk limits, app↔router parity, mocked FM3)`, run: runProfileSchemaTests },
  { name: `api/profile-v2 (${PROFILE_V2_CASE_COUNT} cases, profile store v2 lifecycle: import writes format 2 without user name tables, an older derivation (schema, revision) re-derives on status and apply with no device traffic and is written back once, a newer build's doc only in memory, derivation-failed stays stored as stale, legacy format 1 usable with no-raw, publish strips raw, router twin + Browser Direct lookup parity; synthetic docs, mocked FM3)`, run: runProfileV2Tests },
  { name: `api/profile-merge (${PROFILE_MERGE_CASE_COUNT} cases, profile v2 merge on build/import/pull: import then walk and walk then import (two sources, device units on intact byte rows, same tables either order), pull never replaces a local byte source (409 local-profile-better, replace, format-2 cloud doc ranked below local, unique ids, other firmware 409), force/replace, the already rule (only re-walkable gaps), unresolved replies kept as a blocking gap, router twin plumbing through the real build route; legacy format-1 fixtures: a build never replaces a legacy editor-cache profile (already / force 409 local-profile-better / no-raw fix = re-import), a format-2 pull never replaces a raw-less doc that outranks it, no wire origin trusted (rewritten to cloud, unreadable raw stored stripped, bounds unchanged), raw sources never dropped (still-failing stale doc keeps every source), newer-profile 409; byte-exactness per family; synthetic caches + canned walks, mocked FM3)`, run: runProfileMergeTests },
  { name: `api/definitions-file (${DEFINITIONS_FILE_CASE_COUNT} cases, .axisdefs export/import (WP-F4): canonical JSON + sha256, the strict raw-source validator (codec output passes, malformed shapes name their path, unknown keys dropped, prototype keys / non-finite numbers / oversize values refused), export envelope (raw only, no derived table, checksum independently recomputed, Content-Disposition, router headers; 404/409/501/503), roundtrip export -> DELETE /device/cache -> import = same caps, diff and generic params with no device traffic and SSE definitions/imported, every error code of the contract in its order (400 invalid-file, 422 unsupported-format/checksum-mismatch/contains-user-data/derivation-failed, 409 model-mismatch/firmware-differs, 413, 501, 503) with nothing stored, ?force=1 and an unknown running firmware, origins re-tagged to file / derived tables and unknown keys never stored / flags inside the file ignored, merge + replace + legacy/newer/stale docs, strict origin guard, Remote relay (GET relays, POST refused), cloud pull shape check; no content hash / issue offsets in a file (export and import), a source the validator refuses is never exported, validator pinned against the codec's own producers, canonical firmware only (13.00 never drops local sources), records only in declared sections / walked blocks + a record total (crafted files refused in ms), repeated ?force / ?replace keys the same on both twins; app<->router parity; synthetic raw sources, mocked FM3/FM9/AM4)`, run: runDefinitionsFileTests },
  { name: `api/preset-convert (${PRESET_CONVERT_CASE_COUNT} cases, cross-device convert offline/connected/501/caps, mocked)`, run: runPresetConvertTests },
  { name: `api/preset-convert-export (${PRESET_CONVERT_EXPORT_CASE_COUNT} cases, FM3→FM3 author round-trip + guards, mocked)`, run: runPresetConvertExportTests },
  { name: `api/empty-slot (${EMPTY_SLOT_CASE_COUNT} cases, unused-slot summary/params/decode/backup/convert/local folder on app + router, mocked FM3)`, run: runEmptySlotTests },
  { name: `api/preset-grid-slot (${PRESET_GRID_SLOT_CASE_COUNT} cases, GET /presets/:n/grid = stored slot never the edit buffer, app↔router, mocked)`, run: runPresetGridSlotTests },
  { name: `api/diagnostic-capture (${DIAGNOSTIC_CAPTURE_CASE_COUNT} cases, steps, stop at first silence, dump headers, reload skip on unsaved edits, bundle on cancel/silence/error/query-bound, redaction, 409/400/501/503, upload, telemetry hold, caps; synthetic FM3)`, run: runDiagnosticCaptureTests },
  { name: `api/diagnostic-walk-steps (${DIAGNOSTIC_WALK_STEPS_CASE_COUNT} cases, M3 WP-F8: the opt-in definition-walk steps extendedWalk / above160Walk / blockProbe — never default steps, gates recorded (unknown firmware skipped with nothing sent, unlisted firmware = read-only diagnostic run, dev override, verified table), the build's extension plan through the codec's own walk on a synthetic unit (exact bounds, live-readonly raw source, nothing stored or applied, no write), abort rules (implausible reply, query budget, empty block; the run carries on while the unit answers), block probe targets from a fresh grid read (unknown and roster-only blocks; above 160 only after above160Walk), the would-be block map never stored, probe timeout, abort mid-step leaves a bundle, the bound watchdog (query-bound, never sent), app<->router parity, Remote refusal, dump redaction; mocked FM3 / Axe-Fx III)`, run: runDiagnosticWalkStepsTests },
  { name: `api/http-policy (${HTTP_POLICY_CASE_COUNT} cases, FORGEFX-51: Host allowlist (IP literals, loopback names, this machine's names, env list; a loopback bind takes loopback names/addresses + env list only; rebinding names → 403 forbidden-host), app-wide origin rule (no Origin, loopback, same-origin, env list; foreign, null and Sec-Fetch-Site cross-site → 403 forbidden-origin), CORS reflects loopback + listed origins only, public = GET/HEAD /healthz + unmatched GETs; every registered route and method swept in a static build and an AXIS_CLOUD build; strict routes need a loopback peer (LAN peer → 403 before any fs access); bind host (Electron → 127.0.0.1, else 0.0.0.0, FORGEFX_HOST wins); static SPA containment (same-prefix sibling, encoded .., backslash, Windows device names), HEAD, malformed escape → 400; invalid and prototype-poisoning JSON → 400 app-wide + router twin; mocked FM3)`, run: runHttpPolicyTests }
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
