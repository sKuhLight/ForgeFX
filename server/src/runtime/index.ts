// Browser runtime barrel — everything Axis Browser Direct needs to assemble a full in-page ForgeFX:
// the request router (its HTTP-transport replacement), the transport-agnostic device registry + the
// per-device driver factories, the backend-agnostic store (+ the in-memory backend), the local-folder
// logic and the parameterizable cloud sync client. Exposed as the `forgefx-server/runtime` package
// subpath. NOTHING in this module's import graph may touch node:/fastify/serialport/@julusian/midi —
// scripts/check-browser-safe.ts (chained into `npm test`) bundles it with esbuild platform:'browser'
// and fails the suite if a Node-only module sneaks in.

// ── request router (the browser's transport) ──
export { createRouter, type RouterResponse, type RuntimeDeps, type RouterLocalDeps, type TelemetryService } from './router.js';

// ── device registry + drivers ──
export { createRegistry, DeviceRegistry, type RegistryDeps, type ConnInfo } from '../drivers/registryCore.js';
export { createGen3Driver } from '../drivers/gen3.js';
export { createAm4Driver, type Am4Driver } from '../drivers/am4.js';
export type { DeviceDriver, DriverCapabilities, DriverCtx, DeviceEvent } from '../drivers/types.js';
export type { Transport, RequestOpts, Conn, ConnKind } from '../transport/types.js';
// the request/completion engine of the Node transports, for in-page transports to share (browser-safe)
export {
  RequestQueue, LATE_DRAIN_LIMITS, SAME_TICK_MS, isResultEcho, pacedWrite,
  type ExchangeLink, type LateDrainLimits, type RequestQueueOpts, type QueueClock, type PacedPort
} from '../transport/requestQueue.js';
export { PROFILES, DEFAULT_PROFILE, profileForModel, profileForKey, SLUG_FAMILY, type DeviceProfile } from '../devices.js';

// ── persistent store (backend-agnostic core + the browser-usable backend) ──
export { createStore, type Store } from './store.js';
export { createMemStoreBackend } from './memStoreBackend.js';
export type { StoreBackend, StoreCodec, Doc, PresetVersion, Backup, JsonWriteOpts } from './storeBackend.js';

// ── device-definition profile schema gate (usable vs stale; the lookup behind every apply hook) ──
export {
  CURRENT_CACHE_SCHEMA, checkProfileSchema, staleFields, loadStoredProfile, loadUsableProfile,
  type StaleReason, type ProfileSchemaCheck, type StoredProfile
} from '../profileSchema.js';

// ── local storage folder (Presets/ library + Sync/ mirror) ──
export type { FolderAdapter, FolderEntry } from './folderAdapter.js';
export {
  PRESETS_SUB, SYNC_SUB, safeRel, sanitize, isSyx, writableProbe,
  scanPresets, syncToFolder, restoreFromFolder,
  type DecodeFn, type VersionStore, type ScanCache, type ScanCachePersistence, type LocalPresetEntry
} from './localFolder.js';
export { createLocalService, type LocalService, type LocalServiceDeps, type LocalResult } from './localService.js';

// ── shared route services (also used by the Fastify app) ──
export { createUnifiedHandlers, type StatusSink } from './handlers.js';
export { putStoreDoc } from './services.js';
export { blockHelpBySlug, helpIndex, type BlockHelpDTO } from '../help.js';

// ── cloud sync (optional router dep; supabase-js is isomorphic) ──
export { createCloud, Cloud, type CloudConfig, type CloudService } from './cloud.js';
