// Axis Cloud sync client (Supabase) — the STORE- and ENV-AGNOSTIC core. The server binds it to
// process.env + the default fs store in src/cloud.ts (dynamic-imported behind AXIS_CLOUD=1 so release
// builds ship it dark); a browser runtime constructs its own via createCloud(cfg, store). ForgeFX is
// the sync client: the local store stays the source of truth, this pushes/pulls changed `config`
// documents (last-write-wins by updatedAt) and preset versions/blobs to/from Supabase. Per-user
// isolation is enforced by RLS, so the public anon/publishable key is safe here. Free-tier preset
// sync is quota-limited (reconcile-to-target — see syncPlan.ts); paid = unlimited.
// NO node: imports here — supabase-js is isomorphic and this module must load in a browser.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Store } from './store.js';
import { planVersionSync, type FreeLimits, type PlanVersion } from '../syncPlan.js';

/** Cloud endpoint + gate. Publishable key only; never a secret. `enabled` is the operator gate the
 *  server reads from AXIS_CLOUD (checked per call, so a flag flip needs no new instance). */
export interface CloudConfig {
  url: string;
  anonKey: string;
  enabled?: () => boolean;
  // Where the email-confirmation link lands after Supabase verifies the token. Auth is headless
  // (email/password, detectSessionInUrl:false) so this carries NO session — it only needs to be a
  // stable, friendly page. Always the public web domain, never localhost / the desktop's random port,
  // so ONE value works for every build (desktop, portable, cloud, mobile, browser-direct). MUST be on
  // the project's redirect allow-list or Supabase silently falls back to the Site URL. Unset → Supabase
  // uses the Site URL.
  confirmRedirectUrl?: string;
}

/** Reject if a promise doesn't settle in time. storage-js runs its own fetch (no client timeout), so a
 *  stalled blob upload/download would otherwise hang the whole sync forever. */
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

export class Cloud {
  #cfg: CloudConfig;
  #store: Store;
  #client: SupabaseClient | null = null;
  constructor(cfg: CloudConfig, store: Store) {
    this.#cfg = cfg;
    this.#store = store;
  }
  #enabled(): boolean {
    return (this.#cfg.enabled?.() ?? true) && !!this.#cfg.url && !!this.#cfg.anonKey;
  }
  #c(): SupabaseClient {
    // supabase-js persists the auth session via a Web Storage-like API; Node has none, so back it with
    // the store (one doc under the `cloud` collection). Sync get/set/remove is fine for our use.
    const sessionStorage = {
      getItem: (k: string): string | null => (this.#store.getDoc('cloud', k)?.data as string) ?? null,
      setItem: (k: string, v: string): void => { this.#store.putDoc('cloud', k, v); },
      removeItem: (k: string): void => { this.#store.delDoc('cloud', k); }
    };
    if (!this.#client) this.#client = createClient(this.#cfg.url, this.#cfg.anonKey, {
      auth: {
        storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        // supabase-js's default auth lock (navigatorLock/process lock) can DEADLOCK in a long-lived
        // Node process: a stalled token refresh holds the lock and every later getUser()/query waits
        // on it forever — surfacing as "signal timed out" with no recovery until restart. We're
        // single-process, so a passthrough lock is safe and removes the deadlock entirely.
        lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>) => fn()
      },
      global: {
        // supabase-js has no fetch timeout — a stalled REST/Storage call would hang the request
        // forever. Cap each call so it fails fast + loud instead.
        fetch: (input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
          fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(15000) })
      }
    });
    return this.#client;
  }
  async register(email: string, password: string) {
    const { data, error } = await this.#c().auth.signUp({
      email, password,
      ...(this.#cfg.confirmRedirectUrl ? { options: { emailRedirectTo: this.#cfg.confirmRedirectUrl } } : {})
    });
    if (error) throw new Error(error.message);
    return { user: data.user ? { id: data.user.id, email: data.user.email } : null, needsConfirmation: !data.session };
  }
  async login(email: string, password: string) {
    const { data, error } = await this.#c().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return { user: { id: data.user.id, email: data.user.email } };
  }
  async logout() { await this.#c().auth.signOut(); return { ok: true }; }
  /** GDPR erasure (Art. 17): invoke the `delete-account` edge function (runs as service role, verifies
   *  the caller's JWT so a user can only delete themselves) to wipe the account + all its data, then
   *  sign out locally. */
  async deleteAccount() {
    const c = this.#c();
    const { data, error } = await c.functions.invoke('delete-account', { method: 'POST' });
    if (error) throw new Error(error.message ?? 'account deletion failed');
    await c.auth.signOut();
    return { ok: true, ...(data ?? {}) };
  }
  /** Read a user's subscription (RLS: they can only read their own; only the service role can write it, so
   *  the flag can't be spoofed client-side). `active` also honours an expiry if `current_period_end` is set.
   *  No row / no subscription → free tier. */
  async #subscription(userId: string): Promise<{ active: boolean; plan: string | null }> {
    try {
      const { data } = await this.#c().from('subscriptions').select('active,plan,current_period_end').eq('user_id', userId).maybeSingle();
      if (!data) return { active: false, plan: null };
      const notExpired = !data.current_period_end || new Date(data.current_period_end as string).getTime() > Date.now();
      return { active: !!data.active && notExpired, plan: (data.plan as string) ?? null };
    } catch { return { active: false, plan: null }; }
  }
  /** Free-tier quota readout via the preset_quota() RPC (deployed with the quota migration). Null when
   *  signed out or the server predates the migration — callers treat null as "no quota UI, no limits". */
  async quota(): Promise<{ paid: boolean; usedBytes: number; snapshots: number; backups: number; limits: FreeLimits | null } | null> {
    try {
      const { data, error } = await this.#c().rpc('preset_quota');
      if (error || !data) return null;
      const q = data as { paid: boolean; usedBytes: number; snapshots: number; backups: number; limits: { max_stored_bytes: number; max_snapshots: number; max_backups: number } | null };
      return {
        paid: !!q.paid, usedBytes: q.usedBytes ?? 0, snapshots: q.snapshots ?? 0, backups: q.backups ?? 0,
        limits: q.limits ? { maxStoredBytes: q.limits.max_stored_bytes, maxSnapshots: q.limits.max_snapshots, maxBackups: q.limits.max_backups } : null
      };
    } catch { return null; }
  }
  async status() {
    if (!this.#enabled()) return { enabled: false, user: null };
    const { data } = await this.#c().auth.getUser();
    const user = data.user ? { id: data.user.id, email: data.user.email } : null;
    const subscription = user ? await this.#subscription(user.id) : { active: false, plan: null };
    const quota = user ? await this.quota() : null;
    return { enabled: true, url: this.#cfg.url, user, subscription, quota };
  }

  // ── shared device-definition profile store (axis-cloud `device-profiles` edge fn; META-22) ──
  /** Fetch the newest shared device-definition profile for (model, firmware), or null when cloud is
   *  off / none exists / the fetch fails. Anonymous endpoint — no session needed (profiles are shared,
   *  non-user data), so this works signed-out. `schema` is the profile schema this client can use: the
   *  endpoint then answers with the newest row of THAT schema (so clients on different schemas never
   *  hide each other's profiles); omitted, an older endpoint/client contract applies (newest row). */
  async deviceProfileGet(model: number, firmware: string, schema?: number): Promise<{ profile: unknown; contentHash: string; source: string; recordCount: number | null; createdAt: string } | null> {
    if (!this.#enabled()) return null;
    try {
      const sch = schema !== undefined ? `&schema=${encodeURIComponent(String(schema))}` : '';
      const u = `${this.#cfg.url}/functions/v1/device-profiles?model=${model}&firmware=${encodeURIComponent(firmware)}${sch}`;
      const res = await fetch(u, { headers: { apikey: this.#cfg.anonKey }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const d = await res.json() as { profile: unknown; content_hash: string; source: string; record_count: number | null; created_at: string };
      return { profile: d.profile, contentHash: d.content_hash, source: d.source, recordCount: d.record_count, createdAt: d.created_at };
    } catch { return null; }
  }
  /** Publish a derived profile to the shared store. The edge fn verifies the caller's JWT, so this
   *  requires a signed-in session (401 otherwise). Returns the fn's HTTP outcome verbatim — the route
   *  passes code+body straight through (200/201 ok, `{deduped:true}` on an identical existing row). */
  async deviceProfilePublish(body: { model: number; firmware: string; source: 'live-walk' | 'editor-cache'; profile: unknown }): Promise<{ code: number; body: unknown }> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud disabled' } };
    const { data: s } = await this.#c().auth.getSession();
    const token = s.session?.access_token;
    if (!token) return { code: 401, body: { error: 'not signed in' } };
    try {
      const res = await fetch(`${this.#cfg.url}/functions/v1/device-profiles`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: this.#cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });
      return { code: res.status, body: await res.json().catch(() => ({})) };
    } catch (e) { return { code: 503, body: { error: (e as Error).message } }; }
  }

  // ── diagnostic capture upload (axis-cloud `diagnostic-captures`; private bucket, maintainer-read only) ──
  /** Upload a gzip'd diagnostic-capture bundle under the signed-in user: `runDiagnosticUpload` over this
   *  client's session (edge-function calls with the user's token + the anon key, the storage upload through
   *  supabase-js). `disabled` when cloud is off, 401 when nobody is signed in. */
  async diagnosticCaptureUpload(gz: Uint8Array, meta: DiagnosticUploadMeta): Promise<DiagnosticUploadOutcome & { disabled?: boolean }> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    const c = this.#c();
    const { data: s } = await c.auth.getSession();
    const token = s.session?.access_token;
    if (!token) return { code: 401, body: { error: 'not signed in' } };
    return runDiagnosticUpload({
      post: async (fnPath, body) => {
        const res = await fetch(`${this.#cfg.url}/functions/v1/${fnPath}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, apikey: this.#cfg.anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000)
        });
        return { code: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, retryAfter: res.headers.get('retry-after') };
      },
      upload: async (bucket, path, uploadToken, body) => {
        const up = await withTimeout(c.storage.from(bucket).uploadToSignedUrl(path, uploadToken, body, { contentType: 'application/gzip' }), 120000, 'capture upload');
        if (!up.error) return null;
        const e = up.error as { message: string; statusCode?: unknown; status?: unknown };
        const status = Number(e.statusCode ?? e.status);
        return { status: Number.isFinite(status) && status > 0 ? status : 0, message: e.message };
      }
    }, gz, meta);
  }

  /** For Axis Cloud Remote: the authed Supabase client + current user id (for the Realtime host channel),
   *  or null when cloud is off / signed out. The client carries the user's session, so its Realtime
   *  connection is authorized for that user's private channel. */
  async remoteSession(): Promise<{ client: SupabaseClient; userId: string } | null> {
    if (!this.#enabled()) return null;
    const c = this.#c();
    const { data } = await c.auth.getUser();
    if (!data.user) return null;
    // Private Realtime channels authorize via RLS against the JWT — the socket must carry the user's
    // access token, or the authz check runs as anon and the channel errors. setAuth it explicitly (a
    // session loaded from storage doesn't fire the sign-in event that would set it automatically).
    const { data: s } = await c.auth.getSession();
    if (s.session?.access_token) { try { await c.realtime.setAuth(s.session.access_token); } catch { /* */ } }
    return { client: c, userId: data.user.id };
  }

  /** Two-way last-write-wins sync of the `config` collection (tags/collections/favorites/savedFilters/
   *  layouts/swipe). Reconciles per doc by `updatedAt`: push the ones where local is newer/new, pull the
   *  ones where remote is newer/new. Tombstones (deleted) sync both ways. */
  async syncConfig() {
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) throw new Error('not logged in');

    const { data: remoteRows, error: rerr } = await c.from('documents').select('id,data,updated_at,rev,deleted').eq('collection', 'config');
    if (rerr) throw new Error(`pull: ${rerr.message}`);
    const remote = new Map((remoteRows ?? []).map((r) => [r.id as string, r]));
    const localAll = this.#store.docsChangedSince('config', 0); // all local config docs, including tombstones

    // push: local newer than (or missing from) remote
    const toPush = localAll
      .filter((d) => { const r = remote.get(d.id); return !r || d.updatedAt > r.updated_at; })
      .map((d) => ({ user_id: user.id, collection: 'config', id: d.id, data: d.data, updated_at: d.updatedAt, rev: d.rev, deleted: !!d.deleted }));
    if (toPush.length) {
      const { error } = await c.from('documents').upsert(toPush, { onConflict: 'user_id,collection,id' });
      if (error) throw new Error(`push: ${error.message}`);
    }

    // pull: remote newer than (or missing from) local
    let pulled = 0;
    for (const r of remoteRows ?? []) {
      const localDoc = this.#store.getDoc('config', r.id);
      if (!localDoc || r.updated_at > localDoc.updatedAt) { this.#store.putDocRaw('config', r.id, r.data, r.updated_at, r.rev, !!r.deleted); pulled++; }
    }
    return { pushed: toPush.length, pulled };
  }

  /** Sync preset version snapshots: reconcile the cloud to a TARGET SET (see syncPlan.ts) — paid =
   *  the whole local∪remote union (set-difference push, unchanged behavior); free = the newest
   *  full-backup group + the newest N snapshots, pruning replaced remote rows first (the DB trigger
   *  rejects a second backup group until the old one is gone). Versions are immutable
   *  (id = location+crc+ts), so no LWW is needed. Pull is unlimited for everyone — quota is push-only. */
  async syncVersions(paid: boolean) {
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) throw new Error('not logged in');
    const bucket = c.storage.from('preset-blobs');
    const blobPath = (hash: string) => `${user.id}/blobs/${hash}.syx.br`;

    console.log('[cloud] syncVersions: listing remote…');
    const { data: remoteRows, error: rerr } = await c.from('preset_versions').select('*');
    if (rerr) throw new Error(`versions pull-list: ${rerr.message}`);
    const local = this.#store.listPresetVersions();
    console.log(`[cloud] syncVersions: ${remoteRows?.length ?? 0} remote, ${local.length} local`);

    // Union view for the planner (dedup all size accounting by blob_path — content-addressed blobs
    // are shared across versions). RPC failure (server predates the quota migration) → no limits.
    const limits = paid ? null : ((await this.quota())?.limits ?? null);
    const byId = new Map<string, PlanVersion>();
    for (const v of local) byId.set(v.id, { id: v.id, capturedAt: v.capturedAt, source: v.source, backupId: v.backupId ?? null, stored: v.stored, blobPath: blobPath(v.hash), local: true, remote: false });
    for (const r of remoteRows ?? []) {
      const prev = byId.get(r.id as string);
      if (prev) prev.remote = true;
      else byId.set(r.id as string, { id: r.id, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? null, stored: r.stored, blobPath: r.blob_path, local: false, remote: true });
    }
    const plan = planVersionSync(paid || !limits, limits, [...byId.values()]);
    if (plan.overCap) {
      const mb = (limits!.maxStoredBytes / 1048576).toFixed(0);
      throw new Error(`Cloud storage full — the free plan includes ${mb} MB of preset storage. Delete old snapshots or upgrade.`);
    }

    // 1 — prune replaced remote rows FIRST (the quota trigger admits a new backup group only after
    // the old group's rows are gone), then their now-unreferenced blobs. RLS scopes deletes to us.
    if (plan.pruneRemote.length) {
      console.log(`[cloud] syncVersions: pruning ${plan.pruneRemote.length} replaced remote version(s)`);
      for (let i = 0; i < plan.pruneRemote.length; i += 200) {
        const { error } = await c.from('preset_versions').delete().eq('user_id', user.id).in('id', plan.pruneRemote.slice(i, i + 200));
        if (error) throw new Error(`prune: ${error.message}`);
      }
      for (let i = 0; i < plan.pruneBlobPaths.length; i += 100) {
        const { error } = await withTimeout(bucket.remove(plan.pruneBlobPaths.slice(i, i + 100)), 20000, 'blob prune');
        if (error) console.warn(`[cloud] blob prune: ${error.message}`); // orphans are swept by gc-blobs
      }
    }

    // 2 — push. A full-device backup creates 100+ versions; content-addressed blobs mean unchanged
    // presets share one blob (upload each unique hash once), and concurrent batches keep it fast.
    const localById = new Map(local.map((v) => [v.id, v]));
    const toPush = plan.push.map((id) => localById.get(id)!).filter(Boolean);
    console.log(`[cloud] syncVersions: pushing ${toPush.length} new version record(s)`);
    let pushed = 0;
    const uploaded = new Set<string>(); // hashes already uploaded this run → skip duplicate blob writes
    const CONCURRENCY = 6;
    const friendlyQuota = (msg: string): string =>
      msg.includes('quota:storage') ? 'Cloud storage full — free plan limit reached. Delete old snapshots or upgrade.'
      : msg.includes('quota:backups') ? 'The free plan keeps one full backup — another device may be syncing right now; try again in a moment.'
      : msg.includes('quota:snapshots') ? 'Snapshot limit reached on the free plan. Delete old snapshots or upgrade.'
      : msg;
    for (let i = 0; i < toPush.length; i += CONCURRENCY) {
      await Promise.all(toPush.slice(i, i + CONCURRENCY).map(async (v) => {
        const path = blobPath(v.hash);
        if (!uploaded.has(v.hash)) {
          uploaded.add(v.hash);
          const packed = this.#store.getPresetVersionPacked(v.id);
          if (packed) {
            const { error: upErr } = await withTimeout(bucket.upload(path, packed, { upsert: true, contentType: 'application/octet-stream' }), 20000, `blob upload ${v.hash}`);
            if (upErr) throw new Error(`blob upload: ${upErr.message}`);
          }
        }
        const { error: mErr } = await c.from('preset_versions').upsert({
          user_id: user.id, id: v.id, location: v.location, crc: v.crc, name: v.name, model: v.model,
          captured_at: v.capturedAt, source: v.source, backup_id: v.backupId ?? null, bytes: v.bytes, stored: v.stored, blob_path: path
        });
        if (mErr) throw new Error(friendlyQuota(mErr.message)); // quota:* = the DB backstop (pre-flight normally prevents this)
        pushed++;
      }));
      console.log(`[cloud] syncVersions: pushed ${pushed}/${toPush.length}`);
    }

    // 3 — pull cloud-only versions (skipping the ones we just pruned). Unlimited for every tier.
    const prunedIds = new Set(plan.pruneRemote);
    let pulled = 0;
    for (const r of remoteRows ?? []) {
      if (prunedIds.has(r.id as string) || this.#store.hasPresetVersion(r.id)) continue;
      // blob_path is `<uid>/blobs/<hash>.syx.br` — recover the content hash from it.
      const hash = String(r.blob_path).split('/').pop()?.replace(/\.syx\.br$/, '') ?? '';
      const { data: blob, error: dErr } = await withTimeout(bucket.download(r.blob_path), 20000, `blob download ${r.id}`);
      if (dErr || !blob) continue;
      const packed = new Uint8Array(await blob.arrayBuffer());
      this.#store.addVersionRaw({ id: r.id, location: r.location, crc: r.crc, hash, name: r.name, model: r.model, capturedAt: r.captured_at, source: r.source, backupId: r.backup_id ?? undefined, bytes: r.bytes, stored: r.stored }, packed);
      pulled++;
    }
    return { pushed, pulled, pruned: plan.pruneRemote.length };
  }

  /** The cloud's view of every preset version this user has — metadata only (no blobs). Lets Axis
   *  compute each preset's sync state (synced / local-edit / cloud-newer / cloud-only) by cross-referencing
   *  device CRCs + local versions against what's actually backed up. Version ids are deterministic
   *  (location+crc+ts), so a local version is "in cloud" iff its id appears here. */
  async cloudIndex() {
    if (!this.#enabled()) return { versions: [] };
    const c = this.#c();
    const user = (await c.auth.getUser()).data.user;
    if (!user) return { versions: [] };
    const { data, error } = await c.from('preset_versions').select('id,location,crc,name,model,captured_at,source,bytes,stored');
    if (error) throw new Error(`cloud index: ${error.message}`);
    return {
      versions: (data ?? []).map((r) => ({
        id: r.id as string, location: r.location as number, crc: r.crc as number, name: r.name as string,
        model: r.model as string, capturedAt: r.captured_at as number, source: r.source as string,
        bytes: r.bytes as number, stored: r.stored as number
      }))
    };
  }

  /** Full sync: config + preset versions/blobs. `scopes` gates which halves run (per the account
   *  panel's sync toggles); omitted = both. `config` covers tags/collections/favorites/filters/layouts;
   *  `presets` covers version snapshots + blobs. */
  async sync(scopes?: { config?: boolean; presets?: boolean }) {
    const doConfig = scopes?.config ?? true;
    // Preset sync is open to every tier since 0.7.1 — the free tier is quota-limited (3 MB / 1 full
    // backup / N snapshots), enforced by syncVersions' reconcile-to-target plan client-side and the
    // preset_quota DB trigger as the server backstop. Paid = unlimited (yesterday's behavior).
    const user = (await this.#c().auth.getUser()).data.user;
    const sub = user ? await this.#subscription(user.id) : { active: false, plan: null };
    const doPresets = scopes?.presets ?? true;
    console.log(`[cloud] sync: start (config=${doConfig} presets=${doPresets} plan=${sub.plan ?? 'free'} paid=${sub.active})`);
    const config = doConfig ? await this.syncConfig() : { pushed: 0, pulled: 0 };
    console.log('[cloud] sync: config done, versions…');
    const versions = doPresets ? await this.syncVersions(sub.active) : { pushed: 0, pulled: 0, pruned: 0 };
    console.log('[cloud] sync: done');
    return { config, versions };
  }
}

// ── diagnostic capture upload flow (axis-cloud `diagnostic-captures`) ──

/** What the cloud stores next to an uploaded bundle (all derived from the bundle itself). */
export interface DiagnosticUploadMeta {
  /** The bundle id (path-safe). */
  captureId: string;
  model: number;
  firmware: string | null;
  app: { forgefx: string; codec: string; axis?: string };
  state: string;
  /** Exact size of the gzip body in bytes. */
  bytes: number;
}

/** The HTTP outcome of the step that ended the flow: `code` 0 = network failure, `retryAfter` = a
 *  Retry-After header; on success (`code` 200) `body` is `{ captureId: <cloud row id>, status, deduped? }`. */
export interface DiagnosticUploadOutcome { code: number; body: unknown; retryAfter?: string | null }

/** The wire the upload flow runs over (Cloud wires its session; tests fake it). */
export interface DiagnosticUploadTransport {
  /** POST a JSON body to an edge function (`diagnostic-captures`, `diagnostic-captures/finalize`). */
  post(fnPath: string, body: unknown): Promise<{ code: number; body: Record<string, unknown>; retryAfter: string | null }>;
  /** Put the gzip bytes into storage through a signed upload slot (create-only). Null = stored; otherwise
   *  the storage error (`status` 0 = no HTTP answer). Throws on a network failure. */
  upload(bucket: string, path: string, token: string, gz: Uint8Array): Promise<{ status: number; message: string } | null>;
}

const DIAGNOSTIC_BUCKET = 'diagnostic-captures';

/**
 * The three-step diagnostic upload:
 *   1. reserve — POST `diagnostic-captures` with the metadata → the cloud row id (`captureId`, a UUID used
 *      from here on) and a signed upload slot (`bucket`, `path`, `token`). A bundle id the cloud already knows
 *      answers `deduped: true` with status 'complete' (done), 'pending' with a slot (upload again) or 'pending'
 *      without one (the object is there: finalize only);
 *   2. upload — the gzip bytes go straight to storage through the slot (`application/gzip`, create-only: an
 *      object that already exists counts as stored); retried once after a network failure;
 *   3. finalize — POST `diagnostic-captures/finalize` `{ captureId }`; a 409 `not-uploaded` re-runs upload +
 *      finalize once.
 */
export async function runDiagnosticUpload(t: DiagnosticUploadTransport, gz: Uint8Array, meta: DiagnosticUploadMeta): Promise<DiagnosticUploadOutcome> {
  const fail = (code: number, message: string): DiagnosticUploadOutcome => ({ code, body: { error: 'storage', message } });
  /** Upload once, again after a network failure. Null = stored. */
  const upload = async (bucket: string, path: string, token: string): Promise<DiagnosticUploadOutcome | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const err = await t.upload(bucket, path, token, gz);
        if (!err) return null;
        if (err.status === 409 || /already exists|duplicate/i.test(err.message)) return null; // create-only: already stored
        if (err.status > 0 || attempt >= 2) return fail(err.status, err.message);
      } catch (e) {
        if (attempt >= 2) return fail(0, (e as Error).message);
      }
    }
  };
  try {
    const reserve = await t.post('diagnostic-captures', {
      captureId: meta.captureId, model: meta.model, firmware: meta.firmware, app: meta.app, state: meta.state, bytes: meta.bytes
    });
    if (reserve.code < 200 || reserve.code >= 300) return reserve;
    const r = reserve.body;
    const rowId = typeof r.captureId === 'string' ? r.captureId : null;
    if (!rowId) return { code: 502, body: { error: 'cloud', message: 'the reservation carries no capture id' } };
    const deduped = r.deduped === true ? { deduped: true } : {};
    if (r.status === 'complete') return { code: 200, body: { captureId: rowId, status: 'complete', ...deduped } };
    const bucket = typeof r.bucket === 'string' && r.bucket ? r.bucket : DIAGNOSTIC_BUCKET;
    const slot = typeof r.path === 'string' && typeof r.token === 'string' ? { path: r.path, token: r.token } : null;
    if (slot) {
      const err = await upload(bucket, slot.path, slot.token);
      if (err) return err;
    }
    let fin = await t.post('diagnostic-captures/finalize', { captureId: rowId });
    if (fin.code === 409 && fin.body.error === 'not-uploaded' && slot) {
      const err = await upload(bucket, slot.path, slot.token);
      if (err) return err;
      fin = await t.post('diagnostic-captures/finalize', { captureId: rowId });
    }
    if (fin.code < 200 || fin.code >= 300) return fin;
    return { code: 200, body: { captureId: rowId, status: typeof fin.body.status === 'string' ? fin.body.status : 'complete', ...deduped } };
  } catch (e) {
    return { code: 0, body: { error: (e as Error).message } };
  }
}

/** The cloud sync client the router's optional `cloud` dep expects. */
export type CloudService = Cloud;

/** Build a Cloud sync client over an explicit config + store — the browser-runtime entry point
 *  (the server's env-bound singleton lives in src/cloud.ts). */
export function createCloud(cfg: CloudConfig, store: Store): Cloud {
  return new Cloud(cfg, store);
}
