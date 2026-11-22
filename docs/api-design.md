# ADR 0001 — Real-time transport: WebSockets + REST (not SignalR)

Status: accepted · 2026-06-26

## Context
ForgeFX is an **open** platform/SDK for Fractal devices. The frontend (and third-party
clients) need:
- one-off request/response (read firmware, list/load presets, bulk block dump),
- low-latency interactive editing (knob drags fire many updates/sec),
- server→client push (tuner, tempo, meters from the `0x64` stream; *external* changes when
  someone edits on the unit itself; preset-switched events).

## Decision
Use **raw WebSockets for the interactive/event channel and REST for stateless ops.** Do not
use SignalR.

| Channel | Use |
|---------|-----|
| **REST** `/firmware`, `/presets`, `/preset`, `/dump/{page}` | stateless, cacheable, curl-able |
| **WebSocket** `/ws` | live param get/set + server→client events |

### Why not SignalR
SignalR is great for .NET/JS clients (auto-reconnect, hubs, streaming) but speaks an
MS-specific hub protocol. ForgeFX is meant to be driven from *any* language (Python, Rust,
Go, hardware controllers, Max/MSP…); raw WebSockets is universal and the protocol becomes
part of the open spec. The main thing SignalR gives us for free — reconnect/heartbeat — is
~30 lines in a client wrapper, worth it to keep interop. (If ForgeFX ever becomes .NET/JS-only
and wants batteries-included, SignalR is a drop-in on the ASP.NET side.)

## Protocol sketch (documented JSON envelope)
```json
// client → server
{ "type": "setParam", "effect": 82, "addr": [0,62,0,62,0], "value": 0.699 }
{ "type": "subscribe", "streams": ["tuner","meters"] }

// server → client
{ "type": "paramChanged", "block": "Cab", "param": "Low Cut", "value": 100, "unit": "Hz" }
{ "type": "tuner", "note": "E", "cents": -3 }
{ "type": "presetChanged", "n": 430, "name": "DEBUG" }
```

## Client requirements
- reconnect with backoff + ping/pong heartbeat (important for a Pi on wifi during a gig),
- treat REST as the source of truth for snapshots, WS for deltas/streams.

## Implementation note
ASP.NET Core `app.UseWebSockets()` + a `/ws` endpoint. Build the `/ws` stub when the frontend
phase starts. Keep DTOs/JSON stable as the public contract.

---

# ADR 0002 — Generic block params (`?generic=1`)

Status: accepted · 2026-11-22

## Context
`GET /preset/blocks/:eid/params` lists the parameters the bundled catalog names, with a number for
every one. A unit on newer firmware has parameters the catalog does not know, and a value the read
did not produce (a channel the status read missed, a position past a short body, a block whose body
is not indexed by parameter id) was served as a plausible `0`. Both are wrong in a way a client
cannot see.

## Decision
An opt-in, additive **generic** response, next to the classic one. Nothing a v0.10 client reads
changes shape.

- **Request:** `GET /preset/blocks/:eid/params?generic=1` (on only when the first `generic` value is
  `1`). Same on the Fastify app and the browser runtime router; relayed over Remote like the classic
  request. Gate on `capabilities.definitions.genericParams`; tell the response by the presence of
  `definitions`. Drivers without it (gen-1, gen-2, VP4, AM4) ignore the flag and answer the classic
  shape.
- **Classic response:** no field removed, no type changed, `value`/`norm` always numbers, never
  `null`. Additions: an `unresolved` reason on an entry whose number was invented, and bug fixes (enum
  labels start at the row's own minimum; option lists are bounded by the row's own count and cut at
  4096; a type selector is only `<F>_MODEL` / `<F>_TYPE` by exact name, so `type` is `null` on families
  without one and a layout variant follows the family's mode selector where there is one).
- **Generic response:** every informative row the connected device has for the block, in catalog
  order then generic parameters by ascending id; `value`/`norm` are `null` with an `unresolved`
  reason where no number could be resolved.

### A parameter (`named[]` and `enums[]`)
`named` holds continuous parameters, `enums` selectors; an enum-kind row is never in `named`.
```json
{ "id": 40, "name": "P40", "value": 3.5, "norm": 0.35, "min": 0, "max": 10,
  "kind": "float", "source": "profile", "generic": true, "isNew": true,
  "pageHint": "new-in-firmware", "nameSource": "generic", "fp": "1:0d41c7e2",
  "widget": "knob", "widgetSource": "device", "write": "norm", "step": 0.01 }
```
| Field | Meaning |
|---|---|
| `kind` | `float` or `enum`: the device row's own kind |
| `source` | `profile` (the row came from the applied profile) or `catalog` |
| `generic`, `isNew`, `pageHint` | no name known (the name is `P<pid>`); the catalog has no row here; `new-in-firmware` for a new generic row, `more` for the rest |
| `nameSource`, `nameConfidence`, `movedFrom` | `catalog`, `catalog-moved` or `generic`; `high`/`medium`/`low` (absent when generic); the catalog id a moved name came from |
| `fp` | fingerprint of the row and its labels (`1:xxxxxxxx`) |
| `widget`, `widgetSource` | `knob`, `stepper`, `dropdown` or `toggle`; whether the row (`device`), the catalog or the editor layout settled it |
| `write` | `norm`: `PUT { value: 0..1, continuous: true }`; `ordinal`: `PUT { value: <ordinal>, continuous: false }`; `null`: no verified write path (advice for a UI; the server does not refuse it); `readOnlyReason` says why |
| `step` | display-unit step of a continuous parameter, when known |
| `unresolved` | why `value` is `null` (below) |
| `optionsTruncated` | `enums` only: the option list was cut at 4096 |

`unresolved`: `read-failed` (the block read failed; `readError` is set on the response and every
parameter is listed), `channel-unknown` (a channel block whose active channel the status read did not
report), `non-positional` (the block's body is indexed by record, not by parameter id; GLOBAL), `not-in-body`
(the position is past the body that arrived), `out-of-range` (the raw value decodes outside the row's range).

### The `definitions` block
```json
"definitions": { "family": "FUZZ", "profile": "byte-exact", "positional": true, "channel": 0,
                 "persistentWrites": false,
                 "hidden": [ { "id": 0, "reason": "type" }, { "id": 41, "reason": "bypass" } ] }
```
- `family`: the catalog family (`null` for an effect id with no family: the response is then
  `{ block: "Block <eid>", slug: "", page: -1, named: [], enums: [], type: null, unknownBlock: true }`).
- `profile`: `byte-exact`, `live` or `none` (no profile applied, the family is not in it, or it was
  flagged `suspect`, which the block then also says: `"suspect": true`).
- `positional`: values are read by position (parameter id = index in the channel slice). `channel`: the
  channel the values were sliced from, `null` for an unknown channel or a block without channels.
- `persistentWrites`: writes are saved settings, not edit-buffer changes (GLOBAL, FC): warn first.
- `hidden`: informative rows that are not listed, by `reason`: `bypass`, `type` (the type selector, shown
  in `type`), `by-design` (a write would retarget something, e.g. a modifier's target), `removed` (a
  byte-exact profile no longer has a row the catalog does).
- **Invariant for a byte-exact profile:** `named + enums + hidden (other than removed)` equals the number of
  informative rows of the family in the profile. `profile-check` verifies it.

Notes for clients (Axis):
- **`type: null`** means the block has no type selector **or** its value could not be resolved. `hidden`
  carries a `type` item only when a selector exists, so check it to tell the two apart.
- **Stepper (and knob) values are not rounded.** They are the device's float converted to display units
  (`5.2000001`); format with `step` (as many decimals as `step` has).
- `value: null`: render a dash, never compute a relative edit from it; an absolute write is allowed when
  `write` is not `null`. A layout button that presses a served parameter carries `boundParamId`.
- **Layout controls follow the device.** In the generic response a control whose parameter name now sits at
  another id (the name followed its row) carries that id in `paramId` and the catalog id in `movedFrom`. A
  control whose parameter the device no longer serves (dropped, or its name could not follow a shifted row)
  keeps its `paramId` and carries `unbound: true`: disable it, the id may now hold another parameter. The
  classic response serves the editor layout unchanged.
- Generic ids appear in `param` events like any other; a non-positional block emits none.

### Write guards (`PUT /preset/blocks/:eid/params/:paramId`)
A write the device cannot take as a parameter write is refused **before anything is sent**, with the
usual error body on both surfaces and over Remote:
```json
{ "statusCode": 409, "error": "Conflict", "message": "param 200 of DELAY is an unused slot on this firmware; write refused" }
```
- **400**: the id is not a wire parameter (not a non-negative integer, or above `0x3FFF`: the editor's
  button and picker pseudo ids).
- **409**: the family has an unused-slot (all-zero) row at the id, in the effective table or, for a
  byte-exact profile, in the profile's own row (not for a suspect family), and the catalog defines no
  parameter there. A catalog
  parameter with such a row (the modifier's min/max/param, the `*_GLOBALMIX` toggles) stays writable,
  and so does an id with no row at all (the FC block, a cross-block write).

### Capabilities and tooling
`capabilities.definitions` (`genericParams`, `catalogFirmware`, the applied `profile`, `drift`) and how
rows are named are in [definitions.md](definitions.md). `server/scripts/profile-check.ts` (`npm run profile-check`)
checks the response against a profile, offline or against a running server (GET only).

---

# ADR 0003 — Editor-cache contribution

Status: accepted · 2026-11-22

## Context
A device on a firmware the bundled catalog does not describe is best served from the official editor's
definitions file for that firmware. Users who have the file can send it, but the file also holds their own
preset and cab names, and the endpoints that read local files must not be reachable from an arbitrary web
page or over the Remote relay.

## Decision
Four additive routes, on the Fastify app and the browser runtime router (same shapes; the router has no
disk discovery and takes the file's bytes). Gate on `capabilities.definitions.contribute`; a server without
the routes answers 404.

| Route | Purpose |
|---|---|
| `GET /device/cache/contribute[?refresh=1]` | offer or not, why, which local files qualify |
| `POST /device/cache/contribute` | validate, redact, optionally import, then upload (or preview with `dryRun`) |
| `POST /device/cache/contribute/decision` | `{ decision: "asked", days? }` (1..90, default 7) · `"declined"` · `"reset"` |
| `POST /device/cache/contribute/withdraw` | delete this install's upload for the connected firmware |

- **Origin:** every route is loopback-only (`loopbackOriginGuard`, on top of the app-wide policy of
  ADR 0004: no `Origin`, or an http(s) loopback host); anything else is `403 { "error": "forbidden-origin" }`
  before any file is touched.
- **Remote:** the status GET is readable over the relay; the three POSTs are not on its allowlist (consent
  must come from the person at the machine whose file is read).
- **No new SSE event.** A coupled import emits the existing `cacheBuild` `done` event.

### Status
```json
{ "supported": true,
  "device": { "model": 17, "modelHex": "11", "firmware": "13.0", "key": "11_13p0" },
  "cloud": { "enabled": true, "signedIn": false, "wanted": true, "checkedAt": "2026-11-23T10:00:00.000Z" },
  "decision": null, "withdrawable": false, "uploads": [], "offer": true, "reason": null,
  "localProfile": "none", "discovery": "ok",
  "candidates": [ { "path": "<editor dir>/effectDefinitions_11_13p0.cache", "file": "effectDefinitions_11_13p0.cache",
                    "editor": "FM3-Edit", "size": 281000, "mtime": "2026-11-20T08:30:11.000Z", "fileVersion": "13.0", "match": "exact" } ],
  "consentVersion": 2 }
```
- `cloud.wanted`: the cloud's public answer (`true`/`false`), `null` when there is no cloud or it could not
  be reached; reused for 10 minutes per firmware (`?refresh=1` asks again). `signedIn` is a local check;
  signing in is not required (an anonymous session is used).
- `offer` = `supported` and a cloud that wants the file and no blocking decision. `reason` (when not
  offered, first match): `no-device`, `unsupported`, `firmware-unknown`, `cloud-disabled`, `paused`,
  `cloud-unreachable`, `not-wanted`, `declined`, `uploaded`, `withdrawn`, `asked` (while the snooze runs).
- `candidates`: discovered editor files of the connected model only, exact firmware first, then newest.
  The router answers `"discovery": "unavailable"` and no candidates.
- `localProfile`: `byte-exact`, `live`, `cloud`, `stale` or `none` (the stored profile for this firmware).
- `uploads`: this install's uploads for this firmware that can still be deleted, `[{ uploadId, via, uploadedAt }]`
  (`via`: `account` or `anonymous`, the session that can delete it); `withdrawable` = any.
- `consentVersion`: the disclosure text version a send must carry.

### Sending
JSON `{ "source": { "path": "<a candidates[].path>" }, "consent": true, "consentVersion": 2, "import": false,
"acceptFirmwareMismatch": false, "dryRun": false, "axisVersion": "0.11.0" }`, or the raw bytes as
`application/octet-stream` with the flags in the query (`?name=<file>&consent=1&consentVersion=2&import=1&
acceptFirmwareMismatch=1&dryRun=1&axisVersion=…`). The path must be one of a fresh discovery's candidates
(`400 not-a-discovered-cache` otherwise; never opened or stat-ed). Order: consent gate (nothing is read
without it, unless `dryRun`) → source → validation → optional import → dry run answers here → upload → the
decision `uploaded` is stored (also for a duplicate). The status of an error is the failing step's; error
bodies after the validation carry the `import` sub-result, and `via` once a session was chosen. Size: 1 …
4 MiB (`413 too-large { bytes, limit }` otherwise — an empty file too, a discovered file by its size before it
is read, and a body over the route's limit in the same shape). Signed in but the account session cannot be
loaded: `401 not-signed-in` `reason: account-session-unavailable` — never a silent anonymous upload.

```json
{ "ok": true, "dryRun": false,
  "file": { "name": "effectDefinitions_11_13p0.cache", "bytes": 281000, "sha256": "<64 hex, of the redacted bytes>" },
  "validation": { "model": 17, "deviceFirmware": "13.0", "fileVersion": "13.0", "contentVersion": "13.0", "firmwareMatch": "exact",
    "buildDate": null, "deviceBuild": null, "sections": 45, "records": 2500, "unmappedSections": 4, "suspectFamilies": [],
    "catalog": { "firmware": "12.0", "exact": 1600, "compatible": 70, "incompatible": 2, "newRows": 8, "agreement": 0.9988 } },
  "redaction": { "version": 1, "tables": 2, "names": 1024, "presetNames": 512, "userCabNames": 512 },
  "import": { "skipped": "not-requested" },
  "upload": { "status": "complete", "uploadId": "<uuid>", "deduped": false, "covered": false, "via": "anonymous" } }
```
- A dry run answers `"dryRun": true, "upload": null, "wouldSend": { …the exact upload request… }`.
- `import`: `{ "status": 200, "imported": true, "key": "11_13p0" }` or `{ "skipped": "not-requested" |
  "firmware-differs" | "newer-profile" }` (never over a profile a newer build wrote). A failed import stops
  before the upload (`500 import-failed`); a failed upload keeps a successful import.
- `upload.uploadId` is `null` when the cloud already holds identical bytes from someone else (nothing of
  this install's to withdraw; earlier uploads stay listed). `covered`: the firmware is no longer being
  collected. `via`: the session the upload ran under.

The upload request (also `wouldSend`) carries counts and version stamps only:
```json
{ "model": 17, "deviceFirmware": "13.0", "fileVersion": "13.0", "contentVersion": "13.0",
  "fileName": "effectDefinitions_11_13p0.cache", "sha256": "…", "bytes": 281000,
  "redaction": { "version": 1, "tables": 2, "names": 1024 },
  "summary": { "sections": 45, "records": 2500, "unmappedSections": 4, "suspectFamilies": [], "newRows": 8, "incompatibleRows": 2, "agreement": 0.9988 },
  "app": { "forgefx": "…", "codec": "…", "axis": "…" },
  "consentAt": "2026-11-23T10:00:00.000Z", "consentVersion": 2 }
```

### Decisions and withdraw
- Decision: `200 { "key": "11_13p0", "decision": { "state": "asked", "at": "…", "until": "…" } | null }`;
  `400 invalid-request`; `503 no-device` / `firmware-unknown`. Decisions are per model and firmware; an
  upload stays withdrawable through any later decision.
- Withdraw deletes **every** listed upload, each under the session that made it, and records `withdrawn`
  once none is left. Before a delete, the current session of that kind must be the one that uploaded (an
  anonymous session that was re-minted, or another signed-in account, is refused). An entry without a session
  record is deleted only if the cloud confirms it (a "not found" is not proof: `unverified`, it stays listed).
  Answers carry `uploads: [{ uploadId, via, result }]` (`deleted`, `gone`, `session-mismatch`, `unverified`,
  `not-signed-in`, `failed`) and `remaining` (uploads still listed):
  `200 { "ok": true, "uploadId": "…", "via": "anonymous", "deleted": true }`; `404 nothing-to-withdraw`;
  `404 not-found` (all already gone in the cloud, still recorded as withdrawn); `409 session-mismatch` /
  `unverified` (not deleted, stays listed); `401 not-signed-in` (the session that uploaded is gone);
  `503 cloud-disabled` / `dry-run`; `502 cloud`. Only the uploads that came back deleted or gone leave the list:
  an upload or a decision that lands while a withdraw runs is kept, and `withdrawn` is recorded only when
  nothing is left. The decision's `uploadId` never names a deleted row.
- The decisions live in the `cacheContributions` store collection: the generic `/store` routes may read it but
  refuse to write or delete it (`403 forbidden-collection`).

### Errors
| Status | `error` |
|---|---|
| 400 | `not-consented`, `unsupported-consent-version` `{consentVersion, supported}`, `invalid-request`, `not-an-editor-cache-name`, `not-a-discovered-cache`, `cannot-read-file` |
| 401 | `not-signed-in` (`reason`: `account-required`, `account-session-unavailable`, `account-signed-out`, `anonymous-sign-in-failed`, `anonymous-session-missing`) |
| 403 | `forbidden-origin` |
| 404 | `nothing-to-withdraw`, `not-found` |
| 409 | `model-mismatch` `{expected, got}`, `firmware-differs` `{deviceFirmware, fileVersion, contentVersion, overridable}`, `not-wanted`, `firmware-limit` `{limit}`, `session-mismatch` / `unverified` (withdraw) |
| 413 | `too-large` `{bytes, limit, stage?}` (outside 1 … 4 MiB, here or in the cloud) |
| 422 | `cache-parse-failed` `{message}`, `renamed-cache`, `unrelated-cache` `{agreement, floor}`, `redaction-failed`, `invalid-cache` `{reason}` (refused by the cloud's own check) |
| 429 | `rate-limited`, `quota-exceeded` `{retryAfterSeconds, scope?}` |
| 500 | `import-failed` |
| 501 | `unsupported` `{capability: "contribute"}` |
| 502 | `cloud` `{status, message}` |
| 503 | `no-device`, `firmware-unknown`, `cloud-disabled`, `paused`, `dry-run` |

Messages never quote the file's content.

---

# ADR 0004 — Origin and Host policy for the HTTP API

Status: accepted · 2026-11-22

## Context
The API drives the device and reads and writes local state (settings, preset versions, the local folder,
port selection). Browsers let any web page send requests to `http://localhost:<port>` or to a LAN address,
and a DNS-rebinding page can even make those requests look same-origin. The server used to reflect every
origin in CORS and listened on all interfaces in every build, the desktop app included.

## Decision
One app-wide `onRequest` hook runs before body parsing and before any handler, on every route (CORS
preflights and the static UI included):

1. **Host allowlist** → `403 { "error": "forbidden-host" }`. Accepted `Host` values: none at all;
   `localhost` and `*.localhost`; any hostname in `FORGEFX_ALLOWED_HOSTS`; and, by listen address:
   - **loopback bind** (the desktop app): loopback addresses only (`127.0.0.0/8`, `[::1]`). The machine's
     own names, LAN addresses and `0.0.0.0` are refused: a loopback-only server reached under such a name
     is being reached through something that points it at `127.0.0.1`.
   - **any other bind** (Docker, headless, dev): every IP literal (IPv4/IPv6), plus this machine's hostname,
     its first label and `<first label>.local`.

   Ports are not compared.
2. **Public requests** skip the next two checks (never the Host check): `GET`/`HEAD /healthz` and
   `GET`/`HEAD` requests that match no route (the static UI under `FORGEFX_STATIC`, or the 404 body).
3. **Cross-site fetch metadata** → `403 { "error": "forbidden-origin" }`: a request with
   `Sec-Fetch-Site: cross-site` is refused unless its `Origin` is in `FORGEFX_ALLOWED_ORIGINS`. This covers
   what carries no `Origin` (an `<img>` or `<script>` load, a link from another site), which would otherwise
   run side-effect GETs such as device detection or preset decodes. `same-origin`, `same-site`, `none` and no
   header at all (Node clients, older browsers) pass. Browsers send the header only to potentially
   trustworthy targets (`localhost`, `https`), so it protects the desktop app; a plain-`http` LAN address
   relies on the Origin check and on the browser's own private-network restrictions.
4. **Origin check** → `403 { "error": "forbidden-origin" }`. Accepted: no `Origin` header (curl, scripts,
   the desktop app's main process, the Remote relay, a page's own same-origin GETs); an `http(s)` loopback
   origin (`localhost`, `127.0.0.1`, `[::1]`, any port: the desktop app, the dev server); a same-origin
   request (`Origin` host:port equals `Host`: a browser on the LAN using the UI a headless server serves);
   any exact origin in `FORGEFX_ALLOWED_ORIGINS`. `Origin: null` is always refused.

CORS reflects only loopback and listed origins (a same-origin page needs no CORS header), so a foreign page
cannot read even a public answer. The static UI is sent with `X-Frame-Options: SAMEORIGIN` and
`frame-ancestors 'self'`, so another site cannot frame it and borrow its origin.

Routes that read files the server did not write, or return paths on the server machine (editor-cache
sources, import by path, the contribution routes; ADR 0003), keep a stricter per-route rule on top: the
TCP connection must come from a **loopback peer** (`127.0.0.0/8` or `::1`, IPv4-mapped included), with no
`Origin` or a loopback origin. LAN clients (with or without an `Origin`), same-origin LAN pages and listed
origins are refused there with `403 forbidden-origin`.

**Listen address.** Inside the desktop app (`process.versions.electron` is set) the server listens on
`127.0.0.1`; everywhere else (Docker, a headless box, `npm run dev`) on `0.0.0.0`. `FORGEFX_HOST` overrides
both.

| Variable | Format | Effect |
|---|---|---|
| `FORGEFX_HOST` | an address, e.g. `127.0.0.1`, `0.0.0.0`, `::` | listen address (default above); a loopback address also narrows the Host allowlist |
| `FORGEFX_ALLOWED_HOSTS` | comma-separated hostnames | extra names accepted in `Host` (see the proxy notes below) |
| `FORGEFX_ALLOWED_ORIGINS` | comma-separated exact origins (`scheme://host[:port]`) | extra origins that may call every route except the stricter ones (also cross-site), and that CORS reflects |

Entries that do not parse are ignored with a warning in the log.

Typical setups:
- **Docker reached by name** (`http://raspberrypi.local:5056`): a container's hostname is not the host
  machine's, so list the name in `FORGEFX_ALLOWED_HOSTS`. By IP address nothing is needed.
- **Reverse proxy that keeps `Host`** (Traefik, Caddy by default): list the public name in
  `FORGEFX_ALLOWED_HOSTS`; the page is then same-origin.
- **Reverse proxy that rewrites `Host`** to its upstream (nginx's default for `proxy_pass`): the upstream
  name, unless it is an IP, goes into `FORGEFX_ALLOWED_HOSTS`, and the public origin into
  `FORGEFX_ALLOWED_ORIGINS` (the page's origin no longer matches `Host`).
- **Testing the dev UI from another device** (`vite --host`, opened at `http://<lan-ip>:5173`): the dev
  proxy forwards the page's origin, so put that exact origin into `FORGEFX_ALLOWED_ORIGINS` of the server
  behind it.

**Other request hygiene.** A JSON body that does not parse, or that tries prototype poisoning (a
`__proto__` key, a `constructor.prototype` path; Fastify's secure parser), answers
`400 { "error": "invalid-json" }` on every route (an empty body is still `{}`). The static UI handler serves
`GET` and `HEAD`, resolves a path inside its root by a real containment check (an escape answers 404),
refuses Windows device names (`CON`, `NUL`, `COM1`…) and `:` in a path segment on Windows before touching
the disk (404), and answers `400 { "error": "invalid-url" }` to a path that does not decode.

## Consequences
- A browser on the LAN still works against a headless server by IP address or by that machine's own name;
  Docker and proxy setups need the entries above.
- **Non-browser clients on the LAN are not authenticated.** On a `0.0.0.0` bind anything on the network can
  call the API without an `Origin` (curl, scripts), exactly like before; only the stricter routes above
  require a loopback peer. Use `FORGEFX_HOST=127.0.0.1` (or a firewall) where the LAN is not trusted. A
  reverse proxy on the same machine makes every client a loopback peer.
- Residual risk: anyone who controls name resolution on the local network for a name the server accepts
  (for example by answering mDNS for `<name>.local`) can rebind that name. Only a non-loopback server accepts
  its own names, and such a party can reach it directly anyway; the desktop app listens on loopback and
  accepts loopback names and addresses only (plus an operator's `FORGEFX_ALLOWED_HOSTS`). Other web pages
  served from loopback (local dev servers, other local apps) count as loopback origins. Non-browser software
  on the same machine is not a browser-borne threat and is out of scope.
