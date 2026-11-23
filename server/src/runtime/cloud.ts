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
import { createStoreSessionStorage, type SessionStorageAdapter } from './sessionStorage.js';
import { planVersionSync, type FreeLimits, type PlanVersion } from '../syncPlan.js';
import type { ShareableSource } from 'forgefx-midi/cache';
import type { CloudSourceTier, SharedSourceKind } from '../drivers/types.js';

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

/** The session an editor-cache call runs under (see Cloud#uploaderSession). */
type UploaderWho = { client: SupabaseClient; token: string; via: UploaderSession; uploaderId: string | null };

export class Cloud {
  #cfg: CloudConfig;
  #store: Store;
  #client: SupabaseClient | null = null;
  /** The auth-session storage (store-backed; removal blanks the token — see sessionStorage.ts). */
  #storage: SessionStorageAdapter;
  constructor(cfg: CloudConfig, store: Store) {
    this.#cfg = cfg;
    this.#store = store;
    this.#storage = createStoreSessionStorage(store);
  }
  /** The anonymous clients per storage slot (editor-cache uploads, definition shares: separate identities). */
  #anonClients = new Map<string, SupabaseClient>();
  #enabled(): boolean {
    return (this.#cfg.enabled?.() ?? true) && !!this.#cfg.url && !!this.#cfg.anonKey;
  }
  /** Is the cloud configured and switched on in this runtime? (No network call.) */
  isEnabled(): boolean {
    return this.#enabled();
  }
  #createClient(storageKey: string, autoRefreshToken: boolean): SupabaseClient {
    return createClient(this.#cfg.url, this.#cfg.anonKey, {
      auth: {
        // supabase-js persists the auth session via a Web Storage-like API; Node has none, so back it with
        // the store (one doc per key under the `cloud` collection; see sessionStorage.ts).
        storage: this.#storage, storageKey, persistSession: true, autoRefreshToken, detectSessionInUrl: false,
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
  }
  #c(): SupabaseClient {
    // The account session lives under supabase-js's default storage key (passed explicitly so
    // hasAccountSession() can read it without a client round trip; existing sessions keep working).
    if (!this.#client) this.#client = this.#createClient(defaultAuthStorageKey(this.#cfg.url), true);
    return this.#client;
  }
  /** The client of one of this install's ANONYMOUS sessions: `ANONYMOUS_UPLOADER_STORAGE_KEY` for editor-cache
   *  contributions, `DEFINITION_SHARER_STORAGE_KEY` for shared definitions (a separate anonymous identity, so the two
   *  stores' rows can never be linked by user id). Each has its own storage key, so it never replaces or masks the
   *  account session; tokens refresh on demand (no timer). */
  #anon(slot: AnonymousSlot): SupabaseClient {
    let c = this.#anonClients.get(slot);
    if (!c) this.#anonClients.set(slot, (c = this.#createClient(slot, false)));
    return c;
  }
  /** Is a (non-anonymous) account session stored? A local read of the persisted session — no network call, so
   *  an expired access token with a refresh token still counts as signed in. False when the cloud is off. */
  hasAccountSession(): boolean {
    if (!this.#enabled()) return false;
    const s = parseStoredSession(this.#storage.getItem(defaultAuthStorageKey(this.#cfg.url)));
    return !!s && typeof s.refresh_token === 'string' && s.refresh_token.length > 0 && s.user?.is_anonymous !== true;
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

  // ── editor-cache contributions (axis-cloud `editor-caches`) ──
  /** Public "is this firmware still wanted?" read (`GET editor-caches?model=&firmware=`, no session). True or
   *  false as the cloud answers; null when the cloud is off or the read fails in any way. */
  async editorCacheWanted(model: number, firmware: string): Promise<boolean | null> {
    if (!this.#enabled()) return null;
    try {
      const u = `${this.#cfg.url}/functions/v1/${EDITOR_CACHE_FN}?model=${encodeURIComponent(String(model))}&firmware=${encodeURIComponent(firmware)}`;
      const res = await fetch(u, { headers: { apikey: this.#cfg.anonKey }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const d = (await res.json()) as { wanted?: unknown };
      return typeof d.wanted === 'boolean' ? d.wanted : null;
    } catch { return null; }
  }

  /** The session an editor-cache (or, with `slot`, a shared-definitions) call runs under: the signed-in account when
   *  there is one; otherwise this install's anonymous session of that slot, signed in on first use when `create` (an
   *  upload / a share) — never for a delete, which must run as whoever uploaded. `prefer` pins the session kind (a
   *  delete of an anonymous upload). */
  async #uploaderSession(create: boolean, prefer?: UploaderSession, slot: AnonymousSlot = ANONYMOUS_UPLOADER_STORAGE_KEY): Promise<UploaderWho | EditorCacheCloudOutcome> {
    if (prefer !== 'anonymous') {
      // read BEFORE getSession(): a refresh the server refuses (revoked session) makes supabase-js delete the stored
      // session inside getSession(), and a check after it would then let the upload slip to the anonymous session
      const storedAccount = this.hasAccountSession();
      const c = this.#c();
      const { data: s, error } = await c.auth.getSession();
      const session = s.session;
      if (session?.access_token && session.user?.is_anonymous !== true) return { client: c, token: session.access_token, via: 'account', uploaderId: session.user?.id ?? null };
      // a stored account session that cannot be loaded (refresh failed, offline): say so, never fall back to an
      // anonymous upload behind the signed-in user's back
      if (storedAccount) {
        return { code: 401, body: { error: 'not signed in', reason: 'account-session-unavailable', message: error?.message ?? 'the account session could not be loaded' }, via: 'account' };
      }
      if (prefer === 'account') return { code: 401, body: { error: 'not signed in', reason: 'account-signed-out' }, via: 'account' };
    }
    const a = this.#anon(slot);
    const { data: as } = await a.auth.getSession();
    if (as.session?.access_token) return { client: a, token: as.session.access_token, via: 'anonymous', uploaderId: as.session.user?.id ?? null };
    if (!create) return { code: 401, body: { error: 'not signed in', reason: 'anonymous-session-missing' }, via: 'anonymous' };
    const { data, error } = await a.auth.signInAnonymously();
    if (error || !data.session?.access_token) {
      return { code: 401, body: { error: 'not signed in', reason: 'anonymous-sign-in-failed', message: error?.message ?? 'no session' }, via: 'anonymous' };
    }
    return { client: a, token: data.session.access_token, via: 'anonymous', uploaderId: data.session.user?.id ?? null };
  }

  /** POST a JSON body to an edge function with a session token. */
  async #postFn(fnPath: string, token: string, body: unknown): Promise<{ code: number; body: Record<string, unknown>; retryAfter: string | null }> {
    const res = await fetch(`${this.#cfg.url}/functions/v1/${fnPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: this.#cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    return { code: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, retryAfter: res.headers.get('retry-after') };
  }

  /** Upload a REDACTED editor cache (`runSignedUpload` against `editor-caches`): reserve with `body`, upload the
   *  bytes through the signed slot, finalize. Runs under the account session, or the anonymous one while signed
   *  out (`via`). `disabled` when the cloud is off. Success body: `{ uploadId (null for a cross-uploader
   *  duplicate), status, deduped?, covered? }`. */
  async editorCacheUpload(bytes: Uint8Array, body: EditorCacheReserveBody): Promise<EditorCacheCloudOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    let who: UploaderWho | EditorCacheCloudOutcome;
    try { who = await this.#uploaderSession(true); } catch (e) { return { code: 0, body: { error: (e as Error).message } }; }
    if (!('token' in who)) return who;
    const { client, token, via, uploaderId } = who;
    const out = await runSignedUpload({
      post: (fnPath, b) => this.#postFn(fnPath, token, b),
      upload: async (bucket, path, uploadToken, data, contentType) => {
        const up = await withTimeout(client.storage.from(bucket).uploadToSignedUrl(path, uploadToken, data, { contentType }), 120000, 'cache upload');
        if (!up.error) return null;
        const e = up.error as { message: string; statusCode?: unknown; status?: unknown };
        const status = Number(e.statusCode ?? e.status);
        return { status: Number.isFinite(status) && status > 0 ? status : 0, message: e.message };
      }
    }, bytes, {
      fn: EDITOR_CACHE_FN,
      idField: 'uploadId',
      defaultBucket: EDITOR_CACHE_BUCKET,
      contentType: 'application/octet-stream',
      reserveBody: { ...body },
      allowNullIdWhenComplete: true,
      finalizeFields: ['covered']
    });
    return { ...out, via, uploaderId };
  }

  /** The user id of the STORED session of that kind (local read, no network), null when there is none: the
   *  account slot for 'account', this install's anonymous slot for 'anonymous'. */
  editorCacheUploader(via: UploaderSession): string | null {
    return this.#storedUploader(via, ANONYMOUS_UPLOADER_STORAGE_KEY);
  }

  /** Like `editorCacheUploader`, for shared definitions: the account slot, or this install's anonymous SHARER slot. */
  definitionSharer(via: UploaderSession): string | null {
    return this.#storedUploader(via, DEFINITION_SHARER_STORAGE_KEY);
  }

  #storedUploader(via: UploaderSession, slot: AnonymousSlot): string | null {
    if (!this.#enabled()) return null;
    const key = via === 'account' ? defaultAuthStorageKey(this.#cfg.url) : slot;
    const s = parseStoredSession(this.#storage.getItem(key)) as { refresh_token?: unknown; user?: { id?: unknown; is_anonymous?: unknown } | null } | null;
    if (!s || typeof s.refresh_token !== 'string' || !s.refresh_token) return null;
    if (via === 'account' && s.user?.is_anonymous === true) return null;
    return typeof s.user?.id === 'string' ? s.user.id : null;
  }

  /** Delete one of this install's editor-cache uploads (`editor-caches/delete { uploadId }`), under the session
   *  that uploaded it (`via`; unknown → the account, else the anonymous one). Never signs in anonymously: a fresh
   *  anonymous user could not delete anything. */
  async editorCacheDelete(uploadId: string, via?: UploaderSession): Promise<EditorCacheCloudOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    try {
      const who = await this.#uploaderSession(false, via);
      if (!('token' in who)) return who;
      return { ...(await this.#postFn(`${EDITOR_CACHE_FN}/delete`, who.token, { uploadId })), via: who.via };
    } catch (e) {
      return { code: 0, body: { error: (e as Error).message } };
    }
  }

  // ── shared device definitions, cloud v2 (axis-cloud `definition-sources`) ──
  // Public rows of sanitized raw definition sources, the best one per kind for (model, firmware). The reads are
  // anonymous; sharing, withdrawing, listing one's own shares and reporting a device check run under the same session
  // choice as the editor-cache uploads (#uploaderSession): the signed-in account, else an anonymous session - but in a
  // slot of its own (`DEFINITION_SHARER_STORAGE_KEY`), never the editor-cache one: a separate anonymous identity, so a
  // public shared row and a private editor-cache upload can never be linked by user id (D-M4-6, maintainer D2).

  /** The best shared source per kind for (model, firmware) whose raw format this build reads (`rawFormat` = the
   *  newest it reads). Null when the cloud is off, the function is missing (404) or answers anything but a
   *  well-formed 200 (the caller then falls back to the v1 store). An empty `sources` = nothing shared yet. */
  async definitionSourcesList(model: number, firmware: string, rawFormat: number): Promise<DefinitionSourceList | null> {
    if (!this.#enabled()) return null;
    try {
      const u = `${this.#cfg.url}/functions/v1/${DEFINITION_SOURCES_FN}?model=${encodeURIComponent(String(model))}&firmware=${encodeURIComponent(firmware)}&rawFormat=${encodeURIComponent(String(rawFormat))}`;
      // `no-cache`: a browser runtime (Browser Direct) must revalidate, never answer a refresh from its HTTP cache
      // (the listing is served with max-age=300); this client caches the listing itself (services/cloudProfiles.ts)
      // (Node's RequestInit typing omits `cache`; Node's fetch accepts and ignores it, browsers honour it)
      const init: RequestInit & { cache?: 'no-cache' } = { headers: { apikey: this.#cfg.anonKey }, cache: 'no-cache', signal: AbortSignal.timeout(15000) };
      const res = await fetch(u, init);
      if (!res.ok) return null;
      return parseDefinitionSourceList(await res.json(), { model, firmware, rawFormat });
    } catch { return null; }
  }

  /** One shared source with its content (`GET definition-sources/source/<id>`). Null when the cloud is off, the id
   *  is not a row id, the row is gone (404: withdrawn, rejected, quarantined) or the answer is malformed. The
   *  `source` is NOT validated here: the caller runs the shared-source check (services/rawValidation.ts). */
  async definitionSourceGet(rawId: string): Promise<DefinitionSourceBody | null> {
    const id = typeof rawId === 'string' ? rawId.toLowerCase() : rawId;
    if (!this.#enabled() || !isRowId(id)) return null;
    try {
      const u = `${this.#cfg.url}/functions/v1/${DEFINITION_SOURCES_FN}/source/${encodeURIComponent(id)}`;
      const res = await fetch(u, { headers: { apikey: this.#cfg.anonKey }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      return parseDefinitionSourceBody(await res.json(), id);
    } catch { return null; }
  }

  /** Share one sanitized source (`POST definition-sources`): the account session, else this install's anonymous
   *  slot, signed in on first use. The function's HTTP outcome verbatim (201 created / 200 deduped, 4xx/5xx with
   *  their bodies, `retryAfter` on a 429), `via` = the session it ran under. */
  async definitionSourceContribute(body: DefinitionSourceContribution): Promise<DefinitionSourceOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    try {
      const who = await this.#uploaderSession(true, undefined, DEFINITION_SHARER_STORAGE_KEY);
      if (!('token' in who)) return who;
      return { ...(await this.#postFn(DEFINITION_SOURCES_FN, who.token, body)), via: who.via, uploaderId: who.uploaderId };
    } catch (e) {
      return { code: 0, body: { error: (e as Error).message } };
    }
  }

  /** Withdraw this install's shares (`POST definition-sources/withdraw`): one row, or all (optionally of one model
   *  and firmware). Runs under the session that shared (`via`; unknown → the account, else the anonymous one) and
   *  never signs in anonymously: a fresh anonymous user has nothing to withdraw. */
  async definitionSourceWithdraw(sel: DefinitionSourceWithdrawal, via?: UploaderSession): Promise<DefinitionSourceOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    try {
      const who = await this.#uploaderSession(false, via, DEFINITION_SHARER_STORAGE_KEY);
      if (!('token' in who)) return who;
      return { ...(await this.#postFn(`${DEFINITION_SOURCES_FN}/withdraw`, who.token, sel)), via: who.via };
    } catch (e) {
      return { code: 0, body: { error: (e as Error).message } };
    }
  }

  /** The caller's linked shares (`GET definition-sources/mine`, at most 100) under the session `via` (unknown → the
   *  account, else the anonymous one). Never signs in anonymously. */
  async definitionSourcesMine(via?: UploaderSession): Promise<DefinitionSourceOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    try {
      const who = await this.#uploaderSession(false, via, DEFINITION_SHARER_STORAGE_KEY);
      if (!('token' in who)) return who;
      const res = await fetch(`${this.#cfg.url}/functions/v1/${DEFINITION_SOURCES_FN}/mine`, {
        headers: { Authorization: `Bearer ${who.token}`, apikey: this.#cfg.anonKey },
        signal: AbortSignal.timeout(15000)
      });
      return { code: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, retryAfter: res.headers.get('retry-after'), via: who.via };
    } catch (e) {
      return { code: 0, body: { error: (e as Error).message } };
    }
  }

  /** Report this install's device check of a row (`POST definition-sources/report`) — ONLY under a session that
   *  already exists (the account, else this install's anonymous slot): a report never creates one. 401 without. */
  async definitionSourceReport(body: DefinitionSourceReport): Promise<DefinitionSourceOutcome> {
    if (!this.#enabled()) return { code: 503, body: { error: 'cloud-disabled' }, disabled: true };
    try {
      const who = await this.#uploaderSession(false, undefined, DEFINITION_SHARER_STORAGE_KEY);
      if (!('token' in who)) return who;
      return { ...(await this.#postFn(`${DEFINITION_SOURCES_FN}/report`, who.token, body)), via: who.via };
    } catch (e) {
      return { code: 0, body: { error: (e as Error).message } };
    }
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

// ── the generic signed-upload flow (reserve → storage upload → finalize) ──

/** The HTTP outcome of the step that ended a signed upload: `code` 0 = network failure, `retryAfter` = a
 *  Retry-After header. On success (`code` 200) `body` is `{ [idField]: <row id>, status, deduped?, … }`. */
export interface SignedUploadOutcome { code: number; body: unknown; retryAfter?: string | null }

/** The wire a signed upload runs over (Cloud wires its session; tests fake it). */
export interface SignedUploadTransport {
  /** POST a JSON body to an edge function path (`<fn>`, `<fn>/finalize`). */
  post(fnPath: string, body: unknown): Promise<{ code: number; body: Record<string, unknown>; retryAfter: string | null }>;
  /** Put the bytes into storage through a signed upload slot (create-only) with the given content type. Null =
   *  stored; otherwise the storage error (`status` 0 = no HTTP answer). Throws on a network failure. */
  upload(bucket: string, path: string, token: string, bytes: Uint8Array, contentType: string): Promise<{ status: number; message: string } | null>;
}

/** What differs between the signed-upload endpoints. */
export interface SignedUploadSpec {
  /** Edge function name: reserve is POST `<fn>`, finalize POST `<fn>/finalize`. */
  fn: string;
  /** The row-id field in the reserve/finalize answers and the finalize body (`captureId`, `uploadId`). */
  idField: string;
  /** Bucket when the reservation names none. */
  defaultBucket: string;
  contentType: string;
  /** The reserve request body. */
  reserveBody: Record<string, unknown>;
  /** A 'complete' reservation may carry a null row id (the cloud already holds identical bytes from another
   *  uploader and created no row for this one). Off: a missing id is a 502. */
  allowNullIdWhenComplete?: boolean;
  /** Finalize answer fields to pass through into the success body (e.g. `covered`). */
  finalizeFields?: readonly string[];
}

/**
 * The three-step signed upload shared by the diagnostic captures and the editor-cache contributions:
 *   1. reserve — POST `<fn>` with the metadata → the cloud row id (a UUID used from here on) and a signed upload
 *      slot (`bucket`, `path`, `token`). Bytes the cloud already knows answer `deduped: true` with status
 *      'complete' (done), 'pending' with a slot (upload again) or 'pending' without one (the object is there:
 *      finalize only);
 *   2. upload — the bytes go straight to storage through the slot (create-only: an object that already exists
 *      counts as stored); retried once after a network failure;
 *   3. finalize — POST `<fn>/finalize` `{ [idField]: rowId }`; a 409 `not-uploaded` re-runs upload + finalize once.
 * Any non-2xx answer ends the flow and is returned verbatim (with its Retry-After).
 */
export async function runSignedUpload(t: SignedUploadTransport, bytes: Uint8Array, spec: SignedUploadSpec): Promise<SignedUploadOutcome> {
  const fail = (code: number, message: string): SignedUploadOutcome => ({ code, body: { error: 'storage', message } });
  /** Upload once, again after a network failure. Null = stored. */
  const upload = async (bucket: string, path: string, token: string): Promise<SignedUploadOutcome | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const err = await t.upload(bucket, path, token, bytes, spec.contentType);
        if (!err) return null;
        if (err.status === 409 || /already exists|duplicate/i.test(err.message)) return null; // create-only: already stored
        if (err.status > 0 || attempt >= 2) return fail(err.status, err.message);
      } catch (e) {
        if (attempt >= 2) return fail(0, (e as Error).message);
      }
    }
  };
  const id = spec.idField;
  try {
    const reserve = await t.post(spec.fn, spec.reserveBody);
    if (reserve.code < 200 || reserve.code >= 300) return reserve;
    const r = reserve.body;
    const rowId = typeof r[id] === 'string' ? (r[id] as string) : null;
    const deduped = r.deduped === true ? { deduped: true } : {};
    if (!rowId && spec.allowNullIdWhenComplete && r[id] === null && r.status === 'complete') {
      return { code: 200, body: { [id]: null, status: 'complete', ...deduped } };
    }
    if (!rowId) return { code: 502, body: { error: 'cloud', message: `the reservation carries no ${id === 'captureId' ? 'capture' : 'upload'} id` } };
    if (r.status === 'complete') return { code: 200, body: { [id]: rowId, status: 'complete', ...deduped } };
    const bucket = typeof r.bucket === 'string' && r.bucket ? r.bucket : spec.defaultBucket;
    const slot = typeof r.path === 'string' && typeof r.token === 'string' ? { path: r.path, token: r.token } : null;
    if (slot) {
      const err = await upload(bucket, slot.path, slot.token);
      if (err) return err;
    }
    const finalizePath = `${spec.fn}/finalize`;
    let fin = await t.post(finalizePath, { [id]: rowId });
    if (fin.code === 409 && fin.body.error === 'not-uploaded' && slot) {
      const err = await upload(bucket, slot.path, slot.token);
      if (err) return err;
      fin = await t.post(finalizePath, { [id]: rowId });
    }
    if (fin.code < 200 || fin.code >= 300) return fin;
    const extra: Record<string, unknown> = {};
    for (const k of spec.finalizeFields ?? []) if (fin.body[k] !== undefined) extra[k] = fin.body[k];
    return { code: 200, body: { [id]: rowId, status: typeof fin.body.status === 'string' ? fin.body.status : 'complete', ...deduped, ...extra } };
  } catch (e) {
    return { code: 0, body: { error: (e as Error).message } };
  }
}

/**
 * The diagnostic-capture upload (`diagnostic-captures`): `runSignedUpload` with the capture metadata as the
 * reserve body, `captureId` as the row id and the gzip content type.
 */
export async function runDiagnosticUpload(t: DiagnosticUploadTransport, gz: Uint8Array, meta: DiagnosticUploadMeta): Promise<DiagnosticUploadOutcome> {
  return runSignedUpload({ post: (p, b) => t.post(p, b), upload: (bucket, path, token, bytes) => t.upload(bucket, path, token, bytes) }, gz, {
    fn: 'diagnostic-captures',
    idField: 'captureId',
    defaultBucket: DIAGNOSTIC_BUCKET,
    contentType: 'application/gzip',
    reserveBody: { captureId: meta.captureId, model: meta.model, firmware: meta.firmware, app: meta.app, state: meta.state, bytes: meta.bytes }
  });
}

// ── editor-cache contributions (axis-cloud `editor-caches`; private bucket, maintainer-read only) ──

const EDITOR_CACHE_FN = 'editor-caches';
const EDITOR_CACHE_BUCKET = 'editor-caches';

/** The reserve body of an editor-cache contribution (axis-cloud `editor-caches` POST). Counts and version
 *  stamps only: no names, no paths, no instance or account identifiers. */
export interface EditorCacheReserveBody {
  model: number;
  deviceFirmware: string;
  fileVersion: string;
  contentVersion: string | null;
  fileName: string;
  /** sha256 (lowercase hex) of the bytes uploaded (the redacted copy). */
  sha256: string;
  bytes: number;
  redaction: { version: number; tables: number; names: number };
  summary: {
    sections: number; records: number; unmappedSections: number; suspectFamilies: string[];
    newRows: number; incompatibleRows: number; agreement: number;
  };
  app: { forgefx: string; codec: string; axis?: string };
  consentAt: string;
  consentVersion: number;
}

/** Which session an editor-cache upload ran under: the signed-in account, or this install's anonymous one. */
export type UploaderSession = 'account' | 'anonymous';

/** Outcome of `Cloud.editorCacheUpload` / `editorCacheDelete`: the final HTTP status and body (0 = network),
 *  `disabled` when the cloud is off in this runtime, `via` = the session it ran under. */
export interface EditorCacheCloudOutcome {
  code: number; body: unknown; retryAfter?: string | null; disabled?: boolean; via?: UploaderSession;
  /** The uploading session's user id (Supabase auth user id; minted by the cloud, never the telemetry id). */
  uploaderId?: string | null;
}

/** Store key (in the `cloud` collection, next to the account session) of this install's anonymous upload session.
 *  Separate from the account session so a signed-out user never appears signed in, and so the anonymous user —
 *  minted by Supabase Auth, unrelated to the telemetry instance id — is only ever used for these uploads. */
export const ANONYMOUS_UPLOADER_STORAGE_KEY = 'axis-editor-cache-anonymous-session';

/** Store key (same `cloud` collection) of this install's anonymous session for SHARED DEFINITIONS (cloud v2 shares,
 *  withdrawals, `/mine`, device-check reports while signed out). Deliberately not the editor-cache slot: a separate
 *  anonymous identity, so the public definition store and the private editor-cache uploads never share a user id. */
export const DEFINITION_SHARER_STORAGE_KEY = 'axis-definition-sources-anonymous-session';

/** The anonymous session slots of this install. */
type AnonymousSlot = typeof ANONYMOUS_UPLOADER_STORAGE_KEY | typeof DEFINITION_SHARER_STORAGE_KEY;

// ── shared device definitions, cloud v2 (axis-cloud `definition-sources`): wire types and answer parsers ──
// Everything the function answers is checked here before anyone reads it: a row that does not have the documented
// shape is dropped (a malformed listing as a whole reads as "no answer", so the caller falls back to v1). Only counts,
// enumerated values and short stamps pass; a summary keeps scalar fields only. Pure, exported for the tests.

const DEFINITION_SOURCES_FN = 'definition-sources';
const SHARED_SOURCE_KINDS: readonly SharedSourceKind[] = ['editor-cache', 'live-full', 'live-readonly'];
const SERVED_TIERS: readonly CloudSourceTier[] = ['official', 'verified', 'candidate'];
const ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FACT_HASH_RE = /^[0-9a-f]{64}$/;
const CANONICAL_FIRMWARE_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
/** A UTC day (`2026-11-23`), or a full ISO stamp (an older deployment); nothing else. */
const CLOUD_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
/** At most this many rows of a listing are looked at (the function serves one per kind, three at most). */
const LIST_ROWS_MAX = 16;
const SUMMARY_KEYS_MAX = 32;

/** A shared source as the cloud lists it (axis-cloud `SourceSummary`). */
export interface DefinitionSourceSummary {
  id: string;
  kind: SharedSourceKind;
  rawFormat: number;
  /** sha256 (hex) of the source's facts: equal to the codec's `sourceFactHash` of the same source. */
  factHash: string;
  tier: CloudSourceTier;
  quality: number;
  contributors: number;
  networks: number;
  /** Distinct networks that reported a passed / failed device check. */
  spotChecks: { passed: number; failed: number };
  firstSeen: string;
  lastConfirmedAt: string | null;
  bytes: number;
  /** The cloud's counts (scalar fields only, `walk` one level deep). */
  summary: Record<string, unknown>;
}

/** `GET definition-sources?model&firmware&rawFormat`: the best row per kind (none = nothing shared yet) and how
 *  many servable rows each kind has (the listed one included). */
export interface DefinitionSourceList {
  model: number;
  firmware: string;
  sources: DefinitionSourceSummary[];
  alternatives: Record<SharedSourceKind, number>;
}

/** `GET definition-sources/source/<id>`: one row with its sanitized raw source (still to be validated). */
export interface DefinitionSourceBody {
  id: string;
  model: number;
  firmware: string;
  kind: SharedSourceKind;
  rawFormat: number;
  factHash: string;
  tier: CloudSourceTier;
  quality: number;
  summary: Record<string, unknown>;
  source: Record<string, unknown>;
}

/** The share envelope (`POST definition-sources`). `source` is the codec's `shareableSource` output; `consentAt`
 *  is when the user ticked the consent (ISO, within a day of the cloud's clock), `consentVersion` the text shown. */
export interface DefinitionSourceContribution {
  model: number;
  firmware: string;
  kind: SharedSourceKind;
  rawFormat: number;
  source: ShareableSource;
  app: { forgefx?: string; codec?: string; axis?: string };
  consentAt: string;
  consentVersion: number;
}

/** What `POST definition-sources/withdraw` removes: one share, or all (optionally of one model and firmware). */
export type DefinitionSourceWithdrawal = { sourceId: string } | { all: true; model?: number; firmware?: string };

/** A device-check report (`POST definition-sources/report`): counts only, never a value. */
export interface DefinitionSourceReport {
  sourceId: string;
  verdict: 'passed' | 'failed';
  checked: number;
  answered: number;
  mismatches: number;
  app?: { forgefx?: string; codec?: string; axis?: string };
}

/** Outcome of a `definition-sources` write or `/mine`: the function's status and body (0 = network failure),
 *  `disabled` when the cloud is off, `via` = the session it ran under. */
export type DefinitionSourceOutcome = EditorCacheCloudOutcome;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isIntIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isCloudDate = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && CLOUD_DATE_RE.test(v);
const isSharedKind = (v: unknown): v is SharedSourceKind => typeof v === 'string' && (SHARED_SOURCE_KINDS as readonly string[]).includes(v);
const isServedTier = (v: unknown): v is CloudSourceTier => typeof v === 'string' && (SERVED_TIERS as readonly string[]).includes(v);

/** A cloud row id (a lower-case UUID, as Postgres prints it). */
export const isRowId = (v: unknown): v is string => typeof v === 'string' && ROW_ID_RE.test(v);
/** A fact hash (sha256, lower-case hex). */
export const isFactHash = (v: unknown): v is string => typeof v === 'string' && FACT_HASH_RE.test(v);

/** A summary value worth passing on: null, a boolean, a finite number or a short printable stamp. */
const isSummaryScalar = (v: unknown): boolean =>
  v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= 32 && /^[\x20-\x7e]*$/.test(v));

function cleanSummary(v: unknown, nested = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(v)) return out;
  for (const k of Object.keys(v).slice(0, SUMMARY_KEYS_MAX)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) continue;
    const x = v[k];
    if (isSummaryScalar(x)) out[k] = x;
    else if (nested && k === 'walk' && isPlainObject(x)) out[k] = cleanSummary(x, false);
  }
  return out;
}

function listedRow(r: unknown, rawFormatMax: number): DefinitionSourceSummary | null {
  if (!isPlainObject(r)) return null;
  const sc = r.spotChecks;
  if (
    !isRowId(r.id) || !isSharedKind(r.kind) || !isIntIn(r.rawFormat, 1, rawFormatMax) || !isFactHash(r.factHash) ||
    !isServedTier(r.tier) || !isIntIn(r.quality, 0, 3) || !isCount(r.contributors) || !isCount(r.networks) ||
    !isPlainObject(sc) || !isCount(sc.passed) || !isCount(sc.failed) || !isCloudDate(r.firstSeen) ||
    !(r.lastConfirmedAt === null || isCloudDate(r.lastConfirmedAt)) || !isCount(r.bytes)
  ) return null;
  return {
    id: r.id, kind: r.kind, rawFormat: r.rawFormat, factHash: r.factHash, tier: r.tier, quality: r.quality,
    contributors: r.contributors, networks: r.networks, spotChecks: { passed: sc.passed, failed: sc.failed },
    firstSeen: r.firstSeen, lastConfirmedAt: r.lastConfirmedAt as string | null, bytes: r.bytes, summary: cleanSummary(r.summary)
  };
}

/**
 * The listing answer for (model, firmware, rawFormat), or null when it is not one: no `sources` array, or another
 * model / firmware than asked for. Rows without the documented shape, of a raw format above `rawFormat`, of a kind
 * that is never shared or of a tier that is never served are dropped; of several rows of one kind the first stays.
 */
export function parseDefinitionSourceList(body: unknown, asked: { model: number; firmware: string; rawFormat: number }): DefinitionSourceList | null {
  if (!isPlainObject(body) || !Array.isArray(body.sources)) return null;
  if (body.model !== asked.model || body.firmware !== asked.firmware) return null;
  const sources: DefinitionSourceSummary[] = [];
  const kinds = new Set<SharedSourceKind>();
  for (const r of body.sources.slice(0, LIST_ROWS_MAX)) {
    const row = listedRow(r, asked.rawFormat);
    if (!row || kinds.has(row.kind)) continue;
    kinds.add(row.kind);
    sources.push(row);
  }
  const alt = isPlainObject(body.alternatives) ? body.alternatives : {};
  const alternatives = Object.fromEntries(SHARED_SOURCE_KINDS.map((k) => [k, isCount(alt[k]) ? alt[k] : 0])) as Record<SharedSourceKind, number>;
  return { model: asked.model, firmware: asked.firmware, sources, alternatives };
}

/** The `/source/<id>` answer for `id`, or null when it is not one (another id, a kind never shared, a tier never
 *  served, a non-canonical firmware, no source object). The source itself is checked by the caller. */
export function parseDefinitionSourceBody(body: unknown, id: string): DefinitionSourceBody | null {
  if (!isPlainObject(body)) return null;
  const b = body;
  if (
    b.id !== id || !isIntIn(b.model, 0, 255) || typeof b.firmware !== 'string' || !CANONICAL_FIRMWARE_RE.test(b.firmware) ||
    !isSharedKind(b.kind) || !isIntIn(b.rawFormat, 1, 100) || !isFactHash(b.factHash) || !isServedTier(b.tier) ||
    !isIntIn(b.quality, 0, 3) || !isPlainObject(b.source)
  ) return null;
  return {
    id, model: b.model, firmware: b.firmware, kind: b.kind, rawFormat: b.rawFormat, factHash: b.factHash, tier: b.tier,
    quality: b.quality, summary: cleanSummary(b.summary), source: b.source
  };
}

/** supabase-js's default auth storage key for a project URL (`sb-<first host label>-auth-token`). */
function defaultAuthStorageKey(url: string): string {
  try { return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`; } catch { return 'sb-auth-token'; }
}

/** A stored supabase-js session (the JSON the auth client writes), or null. */
function parseStoredSession(raw: unknown): { refresh_token?: unknown; user?: { is_anonymous?: unknown } | null } | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const s = JSON.parse(raw) as unknown;
    return s && typeof s === 'object' ? (s as { refresh_token?: unknown; user?: { is_anonymous?: unknown } | null }) : null;
  } catch { return null; }
}

/** The cloud sync client the router's optional `cloud` dep expects. */
export type CloudService = Cloud;

/** Build a Cloud sync client over an explicit config + store — the browser-runtime entry point
 *  (the server's env-bound singleton lives in src/cloud.ts). */
export function createCloud(cfg: CloudConfig, store: Store): Cloud {
  return new Cloud(cfg, store);
}
