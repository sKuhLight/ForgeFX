// Axis Cloud Remote — HOST agent (runs on the user's PC, inside ForgeFX). When enabled AND signed in, it
// subscribes to the user's PRIVATE Supabase Realtime channel `remote:<uid>` and executes ALLOWLISTED API
// requests coming from a remote browser against the local server (via in-process Fastify inject), replying
// on the same channel. The channel's RLS guarantees only the SAME authenticated user can join, so
// cross-user access is impossible by construction. OFF by default — started only via POST /remote/enable.
import { gzipSync } from 'node:zlib';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { DeviceEvent } from './drivers/types.js';
import { isPrivateStorePath } from './runtime/storeAccess.js';

type Session = { client: SupabaseClient; userId: string };
type Subscribe = (fn: (e: DeviceEvent) => void) => () => void;
type ReqMsg = { id: string; method: string; path: string; body?: string };
type ResMsg = { id: string; status: number; contentType: string; body: string; encoding: 'utf8' | 'base64' | 'gzip' };

// Gzip response bodies above this size before base64-framing them onto the channel. Cuts transfer latency
// for the chatty catalog/grid/blocks payloads and keeps large ones under Supabase's broadcast size limit.
// Small responses skip it (gzip + base64 overhead isn't worth it under a few KB).
const GZIP_MIN = 2048;

/** What may be driven remotely. Reads are broadly allowed (except cloud account); writes are limited to
 *  live performance edits (params, bypass, channel, type, scene, tempo, tuner, grid moves/cables). NEVER
 *  remotely reachable: preset store-to-slot (/preset/store), backups/restore (incl. the Phase-6
 *  /preset/backup + /preset/restore dump movers), /firmware/validate (flash-adjacent byte mover), raw
 *  SysEx, cloud account (incl. the auth sessions in the private `cloud` store collection), port selection,
 *  store writes/deletes, telemetry uploads, remote-enable itself. */
export function remoteAllowed(method: string, path: string): boolean {
  const p = (path.split('?')[0] || '').replace(/\/+$/, '') || '/';
  // never the auth sessions (the private `cloud` store collection), however the path is spelled
  if (method === 'GET') return !p.startsWith('/cloud') && !p.startsWith('/remote') && p !== '/debug/raw' && !isPrivateStorePath(p);
  if (method === 'PUT')
    return (
      /^\/preset\/blocks\/\d+\/params(\/\d+)?$/.test(p) ||
      /^\/preset\/grid\/cell$/.test(p) ||
      /^\/am4\/param$/.test(p) ||
      /^\/device\/param$/.test(p) || // unified twin of /am4/param (live device/global param edit)
      p === '/telemetry/config' || // cadence-mode control — a benign perf/UX setting (no device data moves)
      /^\/store\/config\/[^/]+$/.test(p) // shared UI config (layouts/swipe/surface/tags…) — lets remote edits sync back to the host. Config only, never presets/backups.
    );
  if (method === 'POST')
    return (
      /^\/preset\/blocks\/\d+\/(bypass|channel|type|read|readrange)$/.test(p) ||
      p === '/preset/meters' || // a READ (block level/quick-control snapshot); drives the on-block quick controls
      p === '/preset/select' ||
      p === '/preset/grid/cable' ||
      p === '/preset/grid/select' ||
      p === '/scene' ||
      p === '/tempo' ||
      p === '/tempo/tap' ||
      p === '/tuner' ||
      p === '/mod/bind' ||
      /^\/am4\/(bypass|scene|preset)$/.test(p)
    );
  return false;
}

const TEXTY = /json|text|javascript|xml|svg/i;

export class RemoteHost {
  #app: FastifyInstance;
  #getSession: () => Promise<Session | null>;
  #subscribe: Subscribe;
  #chan: RealtimeChannel | null = null;
  #enabled = false;
  #userId: string | null = null;
  #devUnsub: (() => void) | null = null;
  #remotesPresent = 0; // how many remote browsers are watching (Realtime presence) — gates event broadcasts

  constructor(app: FastifyInstance, getSession: () => Promise<Session | null>, subscribe: Subscribe) {
    this.#app = app;
    this.#getSession = getSession;
    this.#subscribe = subscribe;
  }

  status(): { enabled: boolean; connected: boolean; userId: string | null } {
    return { enabled: this.#enabled, connected: !!this.#chan, userId: this.#userId };
  }

  /** Turn the remote host on/off. On enable, subscribe to the signed-in user's private channel. */
  async enable(on: boolean): Promise<{ enabled: boolean; connected: boolean; userId: string | null; error?: string }> {
    if (!on) {
      await this.#teardown();
      this.#enabled = false;
      return this.status();
    }
    this.#enabled = true;
    const s = await this.#getSession();
    if (!s) return { ...this.status(), error: 'cloud not enabled or not signed in' };
    await this.#teardown();
    this.#userId = s.userId;
    const chan = s.client.channel(`remote:${s.userId}`, { config: { private: true, broadcast: { ack: false } } });
    chan.on('broadcast', { event: 'req' }, (msg: { payload?: unknown }) => {
      const rq = msg.payload as ReqMsg | undefined;
      if (rq) void this.#handle(chan, rq);
    });
    // Track how many remote browsers are actually connected. We only bridge live device events onto the
    // channel while ≥1 is present, so local-only editing (toggle on, nobody watching) costs no Realtime
    // messages. Presence join/leave is low-frequency — negligible next to a param-drag event stream.
    const countPresence = () => {
      try { this.#remotesPresent = Object.keys(chan.presenceState()).length; } catch { this.#remotesPresent = 0; }
    };
    chan.on('presence', { event: 'sync' }, countPresence);
    chan.on('presence', { event: 'join' }, countPresence);
    chan.on('presence', { event: 'leave' }, countPresence);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('subscribe timed out')), 12000);
      chan.subscribe((st: string) => {
        if (st === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') { clearTimeout(t); reject(new Error(`realtime ${st}`)); }
      });
    }).catch((e) => { this.#chan = null; throw e; });
    this.#chan = chan;
    // Bridge CHANGE events → the channel, so the remote UI reflects host/device changes instantly. Only
    // discrete changes (param edits, grid/preset/scene, tempo) — NOT the high-frequency meter/CPU/tuner
    // poll (~8×/s), which would flood the relay. Those live-telemetry streams are a Phase 1.5 item.
    // 'traffic' stays local-only: a 1 Hz stream would break the zero-idle-cost rule below; remote
    // clients keep mode control (PUT relays) and just lose the live rate readout.
    const RELAYED = new Set(['param', 'changed', 'scene', 'tempo', 'config', 'telemetryConfig']);
    this.#devUnsub = this.#subscribe((e) => {
      if (!RELAYED.has(e.type)) return;
      // Only bridge events while a remote is actually watching — a remote pulls config + full state at
      // connect, so nothing is missed, and idle/local editing spends zero Realtime messages.
      if (this.#remotesPresent === 0) return;
      chan.send({ type: 'broadcast', event: 'evt', payload: e }).catch(() => {});
    });
    console.log(`[forgefx][remote] host online on remote:${s.userId}`);
    return this.status();
  }

  async #handle(chan: RealtimeChannel, rq: ReqMsg): Promise<void> {
    console.log(`[forgefx][remote] ← ${rq?.method ?? '?'} ${rq?.path ?? '?'}`); // proof + trace that a remote req arrived over the relay
    let res: ResMsg;
    if (!rq?.id || typeof rq.method !== 'string' || typeof rq.path !== 'string' || !remoteAllowed(rq.method, rq.path)) {
      res = { id: rq?.id ?? '?', status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'not allowed remotely' }), encoding: 'utf8' };
    } else {
      try {
        const inj: InjectOptions = { method: rq.method as InjectOptions['method'], url: rq.path, headers: { 'content-type': 'application/json' } };
        if (rq.body != null) inj.payload = rq.body;
        const r = await this.#app.inject(inj);
        const ct = (r.headers['content-type']?.toString()) ?? 'application/json';
        const raw = r.rawPayload; // Buffer of the full body (text or binary)
        if (raw.length > GZIP_MIN) {
          res = { id: rq.id, status: r.statusCode, contentType: ct, body: gzipSync(raw).toString('base64'), encoding: 'gzip' };
        } else if (TEXTY.test(ct)) {
          res = { id: rq.id, status: r.statusCode, contentType: ct, body: r.payload, encoding: 'utf8' };
        } else {
          res = { id: rq.id, status: r.statusCode, contentType: ct, body: raw.toString('base64'), encoding: 'base64' };
        }
      } catch (e) {
        res = { id: rq.id, status: 502, contentType: 'application/json', body: JSON.stringify({ error: (e as Error).message }), encoding: 'utf8' };
      }
    }
    try { await chan.send({ type: 'broadcast', event: 'res', payload: res }); } catch { /* client gone */ }
  }

  async #teardown(): Promise<void> {
    if (this.#devUnsub) { try { this.#devUnsub(); } catch { /* */ } this.#devUnsub = null; }
    if (this.#chan) {
      try { await this.#chan.unsubscribe(); } catch { /* */ }
      this.#chan = null;
    }
  }
}
