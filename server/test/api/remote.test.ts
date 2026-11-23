// Phase-6 remote-relay whitelist — the gatekeeper for Axis Cloud Remote. Writable paths must stay
// a tight allowlist: live edits yes; anything that persists to a slot, moves dump/firmware bytes,
// touches auth/hardware selection, or uploads stays local-only. Covers the unified twins added in
// Phase 6 alongside the deprecated /am4 aliases (both allowed during the transition window).
// Plus the relay itself (RemoteHost over a fake private channel and the real app on a mocked FM3): a refused
// param write (400 / 409) travels back to the remote with its status and body, like any other answer.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import type { SupabaseClient } from '@supabase/supabase-js';
import { remoteAllowed, RemoteHost, RELAYED_EVENT_TYPES } from '../../src/remote.js';
import { buildTestApp } from '../helpers/api.js';
import { eidOfSlug } from '../helpers/blockRead.js';
import { assert, assertEqual } from '../helpers/mock.js';

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
  ['GET', '/device/cache/contribute'], // editor-cache contribution status: readable by the same user, like /device/cache/sources
  ['GET', '/device/cache/contribute?refresh=1'],
  ['GET', '/device/definitions/diff'], // the definitions diff: a read, relayed like the caps it explains
  ['GET', '/device/definitions/diff?family=DISTORT&include=params,rosters'],
  ['GET', '/device/definitions/export'], // the .axisdefs export: raw definitions, no user data — a read like the diff
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
  ['GET', '/store/cloud'],             // the auth sessions (account + anonymous upload session) — never relayed
  ['GET', '/store/cloud/sb-x-auth-token'],
  ['GET', '/store/CLOUD/sb-x-auth-token'], // case-insensitive file systems map it to the same file
  // editor-cache contribution: consent comes from the person at the machine whose file is read — never relayed
  ['POST', '/device/cache/contribute'],
  ['POST', '/device/cache/contribute?name=effectDefinitions_11_13p0.cache&consent=1&consentVersion=2'],
  ['POST', '/device/cache/contribute/decision'],
  ['POST', '/device/cache/contribute/withdraw'],
  // `.axisdefs` import: a file the person at the machine hands over — never relayed, whatever the flags
  ['POST', '/device/definitions/import'],
  ['POST', '/device/definitions/import?force=1'],
  ['POST', '/device/definitions/import?replace=1'],
  // block probe: a definition walk of the unit that also rewrites the stored definitions — never relayed
  ['POST', '/device/definitions/blocks/203/probe'],
  ['POST', '/device/definitions/blocks/162/probe'],
];

// Requests relayed end to end, with the status the remote must receive.
const RELAYED: { method: string; path: string; body?: unknown; status: number; message?: string }[] = [
  { method: 'PUT', path: `/preset/blocks/${eidOfSlug('cab')}/params/87`, body: { value: 0.5, continuous: true }, status: 409, message: 'param 87 of CABINET is an unused slot on this firmware; write refused' },
  { method: 'PUT', path: `/preset/blocks/${eidOfSlug('cab')}/params/65286`, body: { value: 1, continuous: false }, status: 400, message: 'param id 65286 is not a wire parameter' },
  { method: 'PUT', path: `/preset/blocks/${eidOfSlug('chorus')}/params/14`, body: { value: 1, continuous: true }, status: 200 },
];

export const REMOTE_CASE_COUNT = ALLOWED.length + REJECTED.length + RELAYED.length;

type Res = { id: string; status: number; contentType: string; body: string; encoding: string };

/** A private Realtime channel stand-in: subscribes at once, hands `req` broadcasts to the host's handler and
 *  records what the host sends back. */
export function fakeChannelSession() {
  const handlers = new Map<string, (msg: { payload?: unknown }) => void>();
  const sent: { event: string; payload: unknown }[] = [];
  const chan = {
    on(type: string, filter: { event: string }, cb: (msg: { payload?: unknown }) => void) { if (type === 'broadcast') handlers.set(filter.event, cb); return chan; },
    subscribe(cb: (status: string) => void) { cb('SUBSCRIBED'); return chan; },
    presenceState: () => ({}),
    send: async (m: { event: string; payload: unknown }) => { sent.push(m); return 'ok'; },
    unsubscribe: async () => 'ok',
  };
  const client = { channel: () => chan } as unknown as SupabaseClient;
  /** Relay one request and wait for the host's answer to it. */
  const relay = async (id: string, method: string, path: string, body?: unknown): Promise<Res> => {
    handlers.get('req')!({ payload: { id, method, path, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } });
    for (let i = 0; i < 200; i++) {
      const res = sent.find((m) => m.event === 'res' && (m.payload as Res).id === id);
      if (res) return res.payload as Res;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`[api/remote] no relayed answer for ${method} ${path}`);
  };
  return { session: { client, userId: 'remote-test' }, relay };
}

async function relayCases(): Promise<void> {
  const t = await buildTestApp(0x11);
  const realLog = console.log;
  // device events bridged to a watching remote: discrete changes incl. definitions; never the high-rate streams
  for (const t of ['param', 'changed', 'scene', 'tempo', 'config', 'telemetryConfig', 'definitions']) {
    assert(RELAYED_EVENT_TYPES.has(t), `[api/remote] the ${t} event is relayed to a remote`);
  }
  for (const t of ['meters', 'tuner', 'cpu', 'traffic', 'cacheBuild']) {
    assert(!RELAYED_EVENT_TYPES.has(t), `[api/remote] the ${t} event stays local`);
  }
  console.log = () => {}; // the host logs every relayed request
  try {
    const { session, relay } = fakeChannelSession();
    const host = new RemoteHost(t.app, async () => session, (fn) => t.registry.subscribe(fn));
    await host.enable(true);
    try {
      for (const [i, c] of RELAYED.entries()) {
        const res = await relay(`r${i}`, c.method, c.path, c.body);
        assertEqual(res.status, c.status, `[api/remote] relayed ${c.method} ${c.path}: status`);
        assertEqual(res.encoding, 'utf8', `[api/remote] relayed ${c.path}: a small JSON answer travels as text`);
        const json = JSON.parse(res.body) as { message?: string; statusCode?: number };
        if (c.message !== undefined) {
          assertEqual(json.message, c.message, `[api/remote] relayed ${c.path}: the refusal's message`);
          assertEqual(json.statusCode, c.status, `[api/remote] relayed ${c.path}: the envelope's statusCode`);
        } else {
          assert((json as { ok?: boolean }).ok === true, `[api/remote] relayed ${c.path}: the write's answer`);
        }
      }
    } finally {
      await host.enable(false);
    }
  } finally {
    console.log = realLog;
    await t.app.close();
  }
}

export async function runRemoteTests(): Promise<void> {
  for (const [m, p] of ALLOWED) {
    if (!remoteAllowed(m, p)) throw new Error(`[api/remote] expected ALLOWED: ${m} ${p}`);
  }
  for (const [m, p] of REJECTED) {
    if (remoteAllowed(m, p)) throw new Error(`[api/remote] expected REJECTED: ${m} ${p}`);
  }
  await relayCases();
}
