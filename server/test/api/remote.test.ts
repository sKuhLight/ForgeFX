// Phase-6 remote-relay whitelist — the gatekeeper for Axis Cloud Remote. Writable paths must stay
// a tight allowlist: live edits yes; anything that persists to a slot, moves dump/firmware bytes,
// touches auth/hardware selection, or uploads stays local-only. Covers the unified twins added in
// Phase 6 alongside the deprecated /am4 aliases (both allowed during the transition window).
import { remoteAllowed } from '../../src/remote.js';

const ALLOWED: [string, string][] = [
  // reads relay broadly
  ['GET', '/preset/grid'],
  ['GET', '/preset/blocks'],
  ['GET', '/preset/blocks/58/params'],
  ['GET', '/preset/blocks/58/params?generic=1'], // the query is no part of the match: the generic response relays like the classic one
  ['GET', '/device'],
  ['GET', '/preset/locations'],
  ['GET', '/healthz'],
  // live-edit writes
  ['PUT', '/preset/blocks/58/params/1'],
  ['PUT', '/preset/grid/cell'],
  ['POST', '/preset/blocks/58/bypass'],
  ['POST', '/preset/blocks/58/channel'],
  ['POST', '/preset/blocks/58/type'],
  ['POST', '/preset/select'],
  ['POST', '/preset/grid/cable'],
  ['POST', '/preset/grid/select'],
  ['POST', '/scene'],
  ['POST', '/tempo'],
  ['POST', '/tempo/tap'],
  ['POST', '/tuner'],
  ['POST', '/mod/bind'],
  ['PUT', '/device/param'],
  ['GET', '/telemetry/config'],  // read relays broadly
  ['PUT', '/telemetry/config'],  // benign cadence-mode control (no device data moves)
  // deprecated aliases stay relayable during the window
  ['PUT', '/am4/param'],
  ['POST', '/am4/bypass'],
  ['POST', '/am4/scene'],
  ['POST', '/am4/preset'],
  // shared UI config (any id incl. library) — pre-migration behavior, preserved
  ['PUT', '/store/config/library'],
  ['PUT', '/store/config/layouts'],
];

const REJECTED: [string, string][] = [
  ['POST', '/preset/store'],          // persists to a slot — never remote
  ['POST', '/preset/backup'],         // dump byte mover
  ['POST', '/preset/restore'],        // dump byte mover
  ['POST', '/firmware/validate'],     // flash-adjacent byte mover
  ['POST', '/preset/load'],           // raw .syx import
  ['POST', '/backup/preset/5'],
  ['POST', '/backup/device'],
  ['POST', '/version/x/restore'],
  ['POST', '/ports/select'],
  ['POST', '/cloud/login'],
  ['GET', '/cloud/status'],
  ['GET', '/remote/status'],
  ['POST', '/debug/raw'],
  ['POST', '/telemetry/report'],
  ['PUT', '/store/library/someid'],  // only the config collection relays — never presets/backups/library docs
  ['PUT', '/store/backups/someid'],
  ['DELETE', '/store/config/layouts'],
];

export const REMOTE_CASE_COUNT = ALLOWED.length + REJECTED.length;

export function runRemoteTests(): void {
  for (const [m, p] of ALLOWED) {
    if (!remoteAllowed(m, p)) throw new Error(`[api/remote] expected ALLOWED: ${m} ${p}`);
  }
  for (const [m, p] of REJECTED) {
    if (remoteAllowed(m, p)) throw new Error(`[api/remote] expected REJECTED: ${m} ${p}`);
  }
}
