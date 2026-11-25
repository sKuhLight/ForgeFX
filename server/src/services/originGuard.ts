// Origin and Host policy for the HTTP surface (FORGEFX-47, FORGEFX-51). Browsers attach the calling page's
// `Origin` to cross-origin requests and to same-origin writes, and the `Host` the page's URL named. Without
// a check, any web page the user has open (and, through DNS rebinding, any page at all) could drive the
// device and read or change local state through the user's browser. Everything here runs as Fastify
// `onRequest` hooks: BEFORE body parsing and before any handler, so a refused request touches nothing.
//
// APP-WIDE — `createRequestPolicy(...).onRequest`, registered once in buildApp for every route:
//   1. Host allowlist (DNS rebinding), 403 `{ error: 'forbidden-host' }`. Allowed: no `Host` header;
//      `localhost` and `*.localhost`; an operator entry from FORGEFX_ALLOWED_HOSTS; and, depending on the
//      listen address: on a LOOPBACK bind (the desktop app) only loopback addresses (127.0.0.0/8, [::1]),
//      on any other bind every IP literal (v4/v6, any port) plus this machine's hostname (also its first
//      label and `<first label>.local`). A rebinding page's requests carry ITS hostname (evil.example),
//      never an IP literal, so they stop here. Applies to every request, the public ones included.
//   2. Public requests skip the remaining checks: GET/HEAD `/healthz` (liveness; CORS does not reflect a
//      foreign origin, so a foreign page still cannot read the answer) and GET/HEAD requests no route
//      matched (the static SPA build under FORGEFX_STATIC, or the 404 body: public files only).
//   3. Cross-site fetch metadata, 403 `{ error: 'forbidden-origin' }`: `Sec-Fetch-Site: cross-site` (an
//      `<img>`/`<script>` load or a link from another site; those send no Origin) unless the Origin is an
//      operator entry. `same-origin`, `same-site`, `none` (typed URL, bookmark) and an absent header (Node
//      clients, older browsers) pass. Browsers send the header only to potentially trustworthy targets
//      (localhost, https), so it guards the desktop app, not a plain-http LAN address.
//   4. Origin check, 403 `{ error: 'forbidden-origin' }`. Allowed: no `Origin` (curl and other non-browser
//      clients, the browser's same-origin GETs, the Electron main process, the Remote relay's in-process
//      `app.inject`); an http(s) loopback origin (`localhost`, `127.0.0.1`, `[::1]`, any port: the Axis
//      desktop renderer at `http://localhost:<port>` and the Axis dev server, whose `/api` proxy forwards
//      the page's Origin unchanged); a same-origin request (Origin host:port equals `Host`: a LAN browser
//      on a headless ForgeFX that serves the SPA); an exact operator entry from FORGEFX_ALLOWED_ORIGINS.
//      Refused: every other origin, including `Origin: null` (sandboxed iframes, `data:` documents and
//      cross-origin redirects, all of which a hostile page can produce; no Axis build sends it).
//   CORS reflects only loopback and operator-listed origins (same-origin needs no CORS header).
//
// STRICT — `loopbackOriginGuard`, per route ON TOP of the app-wide hook, for routes that read files the
// server did not write or hand out paths of the machine ForgeFX runs on (editor-cache discovery, import by
// path, contribution). Allowed: a request from a LOOPBACK PEER (the TCP connection comes from 127.0.0.0/8
// or ::1, IPv4-mapped included; `app.inject` reports 127.0.0.1) with no `Origin` or an http(s) loopback
// origin. LAN clients (with or without an Origin), same-origin LAN pages and operator-listed origins are
// refused there: those requests must come from the person at this machine.
//
// Fastify-only on purpose: the browser runtime router (runtime/router.ts) is an in-page function call with
// no HTTP request, no Origin and no Host, so there is nothing to check there. No value imports: the
// machine hostname and the operator lists are passed in by the caller (app.ts).
import type { FastifyReply, FastifyRequest } from 'fastify';

/** The 403 error code a refused origin gets. */
export const FORBIDDEN_ORIGIN = 'forbidden-origin';

/** Header the Remote relay (remote.ts) sets on every request it injects, so a route can tell a relayed request from a
 *  local one where that matters (the share status skips its cloud round trips for a relayed `?refresh=1`). Not a
 *  security boundary: a local caller can send it too, which only makes its own answer more conservative. */
export const REMOTE_RELAY_HEADER = 'x-forgefx-remote-relay';
/** The 403 error code a refused `Host` header gets (DNS rebinding). */
export const FORBIDDEN_HOST = 'forbidden-host';

/** Routes a foreign origin may call (GET/HEAD only); unmatched GET/HEAD requests (static SPA) are public too. */
export const PUBLIC_ROUTES: readonly string[] = ['/healthz'];

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

/** The strict rule, or a same-origin request (the app-wide rule without the operator list). */
export function isAllowedOriginOrSameOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  return isAllowedOrigin(origin) || isSameOrigin(origin, host);
}

/** Is this a loopback address? Accepts a socket peer (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), a listen
 *  address, or a hostname as `hostnameOf` returns it (`[::1]`, `[::ffff:7f00:1]`). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('::ffff:')) {
    a = a.slice(7);
    if (/^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(a)) return true; // IPv4-mapped 127/8 in hex form
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** STRICT rule: a loopback peer, with no Origin or a loopback one. */
export function isStrictAllowed(origin: string | string[] | undefined, remoteAddress: string | undefined): boolean {
  return isLoopbackAddress(remoteAddress) && isAllowedOrigin(origin);
}

/** STRICT route-level `onRequest` hook: answers 403 `{ error: 'forbidden-origin' }` unless the request
 *  comes from a loopback peer with no or a loopback Origin, and stops the request there. Use it as
 *  `app.get(path, { onRequest: loopbackOriginGuard }, h)`. */
export async function loopbackOriginGuard(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (isStrictAllowed(req.headers.origin, req.socket?.remoteAddress)) return undefined;
  // returning the reply tells Fastify it was sent: no later hook, no body parsing, no handler
  return reply.code(403).send({ error: FORBIDDEN_ORIGIN });
}

/** Is this `Sec-Fetch-Site` value `cross-site` (a repeated header counts if any value is)? */
export function isCrossSiteFetch(site: string | string[] | undefined): boolean {
  if (site === undefined) return false;
  return [site].flat().join(',').split(',').some((s) => s.trim().toLowerCase() === 'cross-site');
}

// ── operator lists ──

/** Split a comma-separated env value into trimmed, non-empty entries. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Canonical form of an origin (an operator entry or a request's `Origin`), or null when it is not one.
 *  http(s): the URL's serialized origin (lowercase host, default port dropped). Other schemes (an app
 *  shell such as `capacitor://localhost`) are opaque origins to the URL parser, so they compare as the
 *  lowercased `scheme://host[:port]`. Paths, queries, credentials and `null` never form an origin. */
export function normalizeOrigin(value: string): string | null {
  const s = value.trim();
  if (!s || s.toLowerCase() === 'null') return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '' && u.pathname !== '/')) return null;
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  if (!u.host) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

/** The hostname of a `Host` header value (lowercase, punycode, IPv4 canonical, IPv6 in brackets), or null
 *  when the value is not a plain host[:port]. */
export function hostnameOf(host: string): string | null {
  if (!host) return null;
  let u: URL;
  try { u = new URL(`http://${host}`); } catch { return null; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  return u.hostname.toLowerCase();
}

/** An IP literal, as `hostnameOf` returns it: the URL parser rewrites every numeric IPv4 form to dotted
 *  decimal (and refuses a hostname whose last label is numeric but not an address); IPv6 keeps brackets. */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** The names this machine answers to, from its hostname: the name, its first label, `<first label>.local`. */
export function hostnameAliases(machine: string): string[] {
  const h = hostnameOf(machine.trim());
  if (!h || isIpLiteral(h)) return [];
  const first = h.split('.')[0]!;
  return [...new Set([h, first, `${first}.local`].map((n) => hostnameOf(n)).filter((n): n is string => n != null))];
}

// ── the app-wide policy ──

export interface RequestPolicyOptions {
  /** FORGEFX_ALLOWED_ORIGINS entries: exact origins (`scheme://host[:port]`) that may call every route. */
  allowedOrigins?: readonly string[];
  /** FORGEFX_ALLOWED_HOSTS entries: extra hostnames accepted in `Host` (a port in an entry is ignored). */
  allowedHosts?: readonly string[];
  /** This machine's hostname(s), e.g. `os.hostname()` (aliases are derived, see `hostnameAliases`).
   *  Only used on a non-loopback bind. */
  machineHostnames?: readonly string[];
  /** The address the server listens on (services/bindHost.ts). A loopback bind (`127.x`, `::1`,
   *  `localhost`) accepts loopback names and addresses only (+ `allowedHosts`); omitted = all interfaces. */
  bindHost?: string;
}

/** Is this listen address loopback-only? */
export function isLoopbackBind(bindHost: string | undefined): boolean {
  return bindHost !== undefined && (bindHost.trim().toLowerCase() === 'localhost' || isLoopbackAddress(bindHost));
}

export interface RequestPolicy {
  /** Host allowlist (DNS rebinding). `undefined` (no header) passes; a repeated header does not. */
  isAllowedHost(host: string | string[] | undefined): boolean;
  /** The app-wide origin rule: no Origin, loopback, same-origin, or an operator entry. */
  isAllowedRequestOrigin(origin: string | string[] | undefined, host: string | string[] | undefined): boolean;
  /** Should CORS reflect this origin? Loopback and operator entries only (same-origin needs no header). */
  isCorsOrigin(origin: string | undefined): boolean;
  /** The app-wide `onRequest` hook (Host, then public routes, then Sec-Fetch-Site, then Origin). */
  onRequest(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined>;
  /** Operator entries that did not parse and were ignored (the caller logs them). */
  ignored: string[];
}

/** Is this request public (exempt from the fetch-metadata and origin checks, never from the Host check)? */
export function isPublicRequest(req: { method: string; is404?: boolean; routeOptions?: { url?: string } }): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.is404) return true;
  const url = req.routeOptions?.url;
  return url !== undefined && PUBLIC_ROUTES.includes(url);
}

export function createRequestPolicy(opts: RequestPolicyOptions = {}): RequestPolicy {
  const ignored: string[] = [];
  const origins = new Set<string>();
  for (const e of opts.allowedOrigins ?? []) {
    const n = normalizeOrigin(e);
    if (n) origins.add(n); else ignored.push(`origin ${e}`);
  }
  const hosts = new Set<string>();
  for (const e of opts.allowedHosts ?? []) {
    const n = hostnameOf(e.trim());
    if (n) hosts.add(n); else ignored.push(`host ${e}`);
  }
  // a loopback-bound server is reached through loopback only: its own LAN names and LAN addresses in Host
  // can only come from something pointing such a name at 127.0.0.1 (or from `0.0.0.0`, which some systems
  // route to loopback), so they are not accepted there
  const loopbackOnly = isLoopbackBind(opts.bindHost);
  if (!loopbackOnly) for (const m of opts.machineHostnames ?? []) for (const a of hostnameAliases(m)) hosts.add(a);

  const isListedOrigin = (origin: string | string[] | undefined): boolean => {
    if (typeof origin !== 'string') return false;
    const n = normalizeOrigin(origin);
    return n != null && origins.has(n);
  };

  const isAllowedHost = (host: string | string[] | undefined): boolean => {
    if (host === undefined) return true;
    if (typeof host !== 'string') return false;
    const h = hostnameOf(host);
    if (h == null) return false;
    if (h === 'localhost' || h.endsWith('.localhost') || hosts.has(h)) return true;
    return isIpLiteral(h) && (!loopbackOnly || isLoopbackAddress(h));
  };

  const isAllowedRequestOrigin = (origin: string | string[] | undefined, host: string | string[] | undefined): boolean =>
    isAllowedOriginOrSameOrigin(origin, host) || isListedOrigin(origin);

  const isCorsOrigin = (origin: string | undefined): boolean =>
    typeof origin === 'string' && (isAllowedOrigin(origin) || isListedOrigin(origin));

  const onRequest = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!isAllowedHost(req.headers.host)) return reply.code(403).send({ error: FORBIDDEN_HOST });
    if (isPublicRequest(req)) return undefined;
    // cross-site loads carry no Origin (<img>, <script>, links): refuse them unless the Origin is listed
    if (isCrossSiteFetch(req.headers['sec-fetch-site']) && !isListedOrigin(req.headers.origin)) return reply.code(403).send({ error: FORBIDDEN_ORIGIN });
    if (!isAllowedRequestOrigin(req.headers.origin, req.headers.host)) return reply.code(403).send({ error: FORBIDDEN_ORIGIN });
    return undefined;
  };

  return { isAllowedHost, isAllowedRequestOrigin, isCorsOrigin, onRequest, ignored };
}
