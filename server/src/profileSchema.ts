// Schema gate for persisted device-definition profiles ("device caches", `BuiltCache` docs in the
// `deviceCaches` store collection). The codec stamps every build with `meta.schema` (CACHE_SCHEMA) and
// bumps that constant whenever its derivation rules change in a way that makes an older profile serve
// wrong data. Nothing here rebuilds or deletes anything: a profile whose schema this build does not
// accept is simply NOT USABLE, and every path that would otherwise consume it (runtime apply, status,
// build short-circuit, import/sources, cloud pull/publish) asks THIS module, so they cannot disagree.
//
//   usable  = `meta.schema` is an integer equal to the codec's CACHE_SCHEMA
//   stale   = anything else, with a reason:
//       'missing'  — no (integer) schema stamp: a profile written before profiles were versioned
//       'outdated' — a schema older than this build's: derived under rules that have since changed
//       'newer'    — a schema this build does not understand: written by a later build, not safe to read
//
// A stale profile stays stored (the user can still delete it; nothing auto-deletes) and is replaced by
// the next explicit build / import. The codec's contract is "reject docs whose schema differs", so
// 'newer' is deliberately treated like the other two rather than trusted.
//
// Browser-safe: no node:/fastify imports — this module is in the runtime router's import graph and is
// exported from the runtime barrel so Browser Direct's loader (Axis) applies the very same decision.
import { CACHE_SCHEMA, type BuiltCache } from 'forgefx-midi/cache';
import type { Store } from './runtime/store.js';

/** The schema this build writes and the only one it accepts. */
export const CURRENT_CACHE_SCHEMA: number = CACHE_SCHEMA;

export type StaleReason = 'missing' | 'outdated' | 'newer';

/** Verdict on one profile's `meta.schema`. `schema` is the stored stamp (null when absent/invalid). */
export type ProfileSchemaCheck =
  | { usable: true; schema: number; current: number }
  | { usable: false; reason: StaleReason; schema: number | null; current: number };

/** Judge a profile (the doc `data`, or a cloud row's `profile`) by its schema stamp. Total: anything
 *  that is not an object carrying an integer stamp (absent, a string, NaN, 1.5, ...) comes back 'missing'. */
export function checkProfileSchema(profile: unknown): ProfileSchemaCheck {
  const current = CURRENT_CACHE_SCHEMA;
  const raw = (profile as { meta?: { schema?: unknown } } | null | undefined)?.meta?.schema;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { usable: false, reason: 'missing', schema: null, current };
  if (raw === current) return { usable: true, schema: raw, current };
  return { usable: false, reason: raw < current ? 'outdated' : 'newer', schema: raw, current };
}

/** The additive fields a not-usable verdict contributes to API bodies (status / refusals):
 *  `stale: true`, why, and the stored vs current schema numbers. */
export function staleFields(check: Extract<ProfileSchemaCheck, { usable: false }>): { stale: true; staleReason: StaleReason; schema: number | null; currentSchema: number } {
  return { stale: true, staleReason: check.reason, schema: check.schema, currentSchema: check.current };
}

/** What a store key holds, as far as using it goes. */
export type StoredProfile =
  | { state: 'absent' }
  | { state: 'usable'; profile: BuiltCache; check: Extract<ProfileSchemaCheck, { usable: true }> }
  | { state: 'stale'; profile: BuiltCache; check: Extract<ProfileSchemaCheck, { usable: false }> };

/** Read `deviceCaches/<key>` and classify it. A missing doc and a tombstone are both 'absent'. The
 *  stale profile is handed back too (status reports its meta; nothing else may apply it). */
export function loadStoredProfile(store: Pick<Store, 'getDoc'>, key: string): StoredProfile {
  const doc = store.getDoc('deviceCaches', key);
  if (!doc || doc.deleted) return { state: 'absent' };
  const profile = doc.data as BuiltCache;
  const check = checkProfileSchema(profile);
  return check.usable ? { state: 'usable', profile, check } : { state: 'stale', profile, check };
}

/** The profile stored under `key` ONLY when this build may use it — null when absent, tombstoned or
 *  stale. The one lookup behind every "apply this profile" hook (Node registry, Browser Direct). */
export function loadUsableProfile(store: Pick<Store, 'getDoc'>, key: string): BuiltCache | null {
  const s = loadStoredProfile(store, key);
  return s.state === 'usable' ? s.profile : null;
}
