// Origin guards (FORGEFX-47) — per-route Fastify `onRequest` hooks for the routes that touch the local
// disk, hand out local paths, or change the device profile. The app registers CORS with
// `origin: true` (every origin is reflected), so without them any web page the user has open could
// call those routes through the user's browser. The hooks run BEFORE body parsing and before the
// handler, so a refused request never reaches the file system.
//
// STRICT — `loopbackOriginGuard` (reads the disk or returns local paths; also the guard for the
// upcoming /device/cache/contribute* routes). Allowed:
//   - no `Origin` header: curl and other non-browser clients, the browser's same-origin GETs, the
//     Electron main process's own fetches, and the Remote relay (remote.ts dispatches with
//     `app.inject`, which sends no Origin);
//   - an `http:`/`https:` Origin whose host is a loopback name (`localhost`, `127.0.0.1`, `[::1]`),
//     any port. This covers the Axis desktop app, whose renderer is loaded from
//     `http://localhost:<port>` (the SPA served by this server, same origin; Chromium still sends
//     Origin on a same-origin POST), and the Axis dev server (Vite on `http://localhost:5173`; its
//     `/api` proxy uses `changeOrigin`, which rewrites Host but forwards Origin unchanged).
// Refused (403 `{ error: 'forbidden-origin' }`): every other origin, including `Origin: null`. The
// Axis renderer never loads from `file://` or a custom scheme, so it never sends `null`; a `null`
// origin comes from sandboxed iframes, `data:` documents and cross-origin redirects, all of which a
// hostile page can produce.
//
// RELAXED — `loopbackOrSameOriginGuard` (writes uploaded bytes, reads nothing local): the strict rules
// plus a SAME-ORIGIN request, i.e. the Origin's host:port equals the request's `Host` header. Headless
// ForgeFX (Docker/GHCR, Raspberry Pi) serves the Axis SPA, so a LAN browser on `http://<host>:5056`
// sends a non-loopback Origin that is its own server's. Trade-off, accepted on purpose: a DNS-
// rebinding page (evil.example re-pointed at this machine) is also "same origin". For the bytes
// import that can only plant a device profile, which `PUT /store/deviceCaches/<key>` already allows
// from any origin today (tracked separately as general API hardening), and it reads nothing local.
// Never use the relaxed guard on a route that reads the disk or returns local paths.
//
// Fastify-only on purpose: the browser runtime router (runtime/router.ts) is an in-page function
// call with no HTTP request and no Origin, and its twins never touch a file path, so there is
// nothing to check there. No value imports: the hooks only need Fastify's types.
import type { FastifyReply, FastifyRequest } from 'fastify';

/** The 403 error code a refused origin gets. */
export const FORBIDDEN_ORIGIN = 'forbidden-origin';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parse a single http(s) `Origin` value, or null (absent, repeated, `null`, other scheme, garbage). */
function parseOrigin(origin: string | string[] | undefined): URL | null {
  if (typeof origin !== 'string') return null;
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/** STRICT: is this `Origin` header value allowed? `undefined` (no header) is allowed; anything present
 *  must parse as an http(s) URL with a loopback host. Repeated headers (an array, or a comma-joined
 *  value) and `null` are refused. */
export function isAllowedOrigin(origin: string | string[] | undefined): boolean {
  if (origin === undefined) return true;
  const url = parseOrigin(origin);
  return url != null && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Is the request same-origin: the Origin's host:port equals the `Host` header? Both sides go through
 *  the URL parser with the Origin's scheme, so case, IPv6 brackets and an explicit default port
 *  (`pi.local:80` vs `http://pi.local`) compare equal. A missing or repeated header is not. */
export function isSameOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  const url = parseOrigin(origin);
  if (!url || typeof host !== 'string' || !host) return false;
  let h: URL;
  try { h = new URL(`${url.protocol}//${host}`); } catch { return false; }
  // a Host header is host[:port] only; anything that parses into more (user info, path) is not one
  if (h.username || h.password || h.pathname !== '/' || h.search || h.hash) return false;
  return h.host === url.host;
}

/** RELAXED: the strict rules, or a same-origin request (see the header comment for when this is OK). */
export function isAllowedOriginOrSameOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  return isAllowedOrigin(origin) || isSameOrigin(origin, host);
}

/** STRICT route-level `onRequest` hook: answers 403 `{ error: 'forbidden-origin' }` for a refused
 *  origin and stops the request there. Use it as `app.get(path, { onRequest: loopbackOriginGuard }, h)`. */
export async function loopbackOriginGuard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (isAllowedOrigin(req.headers.origin)) return undefined;
  // returning the reply tells Fastify it was sent: no later hook, no body parsing, no handler
  return reply.code(403).send({ error: FORBIDDEN_ORIGIN });
}

/** RELAXED route-level `onRequest` hook (strict or same-origin). Only for routes that read nothing
 *  local; a route that serves both kinds of body re-checks the strict rule on its disk branch. */
export async function loopbackOrSameOriginGuard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (isAllowedOriginOrSameOrigin(req.headers.origin, req.headers.host)) return undefined;
  return reply.code(403).send({ error: FORBIDDEN_ORIGIN });
}
