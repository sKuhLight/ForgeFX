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
| `write` | `norm`: `PUT { value: 0..1, continuous: true }`; `ordinal`: `PUT { value: <ordinal>, continuous: false }`; `null`: no verified write path; `readOnlyReason` says why |
| `readOnlyReason` | with `write: null`: `unverified-write-path` or `generic-typecode-f0` (advice for a UI; the server does not refuse the write), or, for every param of a read-only block-map block (`definitions.blockMap` below), `unconfirmed-block` or `live-only-block` (the server refuses the write: 409) |
| `step` | display-unit step of a continuous parameter, when known |
| `unit`, `min`, `max`, `log` | `named` only, as in the classic response (`log`: served with a log taper) |
| `unitSource`, `taperSource` | `named` only: where `unit` and the taper came from (below); absent when there is no unit, or nothing names a taper (served linear) |
| `unresolved` | why `value` is `null` (below) |
| `optionsTruncated` | `enums` only: the option list was cut at 4096 |

`unitSource` / `taperSource` (amended with ADR 0005): `device` = the applied device profile's own row supplied it;
`catalog` = the bundled catalog did (its row, or the catalog's unit for the param); `typecode` = derived at read time from
the row's typecode by the codec's typecode rules. A typecode unit is filled in only when neither the device row nor the
catalog has a unit, and it is never persisted. The taper decision is unchanged: an explicit taper of the row wins (`log`,
anything else linear), otherwise the typecode rule. The classic response is unchanged: no source fields, no typecode
unit.

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
- `family`: the family the block is served under: the catalog family, or for a block only the block map binds
  `section:<tag>` / `block:<eid>`; `null` when nothing describes the block (then `named` and `enums` are empty and
  `profile` is `none`). A block the catalog has no family for is answered as
  `{ block: "Block <eid>", slug: "", page: -1, type: null, unknownBlock: true, … }`, with its params when the block map
  serves some, and with `blockMap`.
- `profile`: `byte-exact`, `live` or `none` (no profile applied, the family is not in it, or it was
  flagged `suspect`, which the block then also says: `"suspect": true`).
- `positional`: values are read by position (parameter id = index in the channel slice). `channel`: the
  channel the values were sliced from, `null` for an unknown channel or a block without channels.
- `persistentWrites`: writes are saved settings, not edit-buffer changes (GLOBAL, FC): warn first.
- `hidden`: informative rows that are not listed, by `reason`: `bypass`, `type` (the type selector, shown
  in `type`), `by-design` (a write would retarget something, e.g. a modifier's target), `removed` (a
  byte-exact profile no longer has a row the catalog does).
- `blockMap` (amended with ADR 0005; only for a block the catalog cannot place on its own, absent for every catalog
  block): `{ state, key, sectionTag, evidence, candidates?, probe }`. `key` is the family the block is served under
  (`null` without one), `sectionTag` the editor-cache section it is bound to, `evidence` what binds it
  (`device-records`, `live-only`, `bulk-shape`, `roster`, `pack`), `candidates` the section tags that fit equally.

  | `state` | Meaning | Params | `PUT` |
  |---|---|---|---|
  | `confirmed` | the block's definitions read from the unit equal an editor-cache section (`device-records`) | generic (named for a catalog family) | allowed, the guards below apply |
  | `confirmed` | known from a read-only walk only (`live-only`) | generic from the block's own rows, `write: null`, `readOnlyReason: "live-only-block"` | 409 |
  | `likely` | the block's bulk read fits exactly one editor-cache section (`bulk-shape`, never stored) | that section's params, `write: null`, `readOnlyReason: "unconfirmed-block"` | 409 |
  | `likely` | Axe-Fx III: the effect-id table names the family from the block roster only (`roster`); not an `unknownBlock`, served under its catalog name | named, `write: null`, `readOnlyReason: "unconfirmed-block"` | 409 |
  | `candidates` | several sections fit | none | not refused |
  | `none` | nothing to go by | none | not refused |

  `probe`: `{ available: true }` when `POST /device/definitions/blocks/<eid>/probe` would read the block now; else
  `{ available: false, reason }` with `not-verified` (the probe, and above effect id 160 also definition reads there, is
  not verified on the running firmware) or `not-placed` (the block is not in the edit-buffer grid as last read), and no
  `reason` for a family the catalog knows (the roster-only family). A client treats any other `reason` as unavailable.
  The channels of such a block come from its bulk read (one slice or four), else from its status entry; unknown makes
  every value `channel-unknown`. The classic response lists nothing for a block only the block map binds (as before),
  and serves a roster-only family like any family (its writes are refused all the same).
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
- **Controls that address another block** (amended with ADR 0005). A control with a `crossBlock` reference
  (`{ effect, family, paramName, paramId }`, e.g. the global metronome on a block's tempo page) names a param of the
  REFERENCED family, and follows that family's names on the connected device: moved →
  `paramId` is the new pid and `movedFrom` the catalog pid (`crossBlock.paramId` follows), no longer served →
  `unbound: true`. This applies only where the reference names that family's catalog param at its catalog pid; any other
  reference keeps its binding. Every control with a `crossBlock` reference also carries `crossBlock.effectId`: the effect
  id of the block that owns the param on the connected device, from that model's own effect-id table — the first effect
  id of the referenced family plus the reference token's instance minus 1 (`ID_OUTPUT2`: the second Output block). The
  instance must exist on the device: at most the model's instance count of that family, and within the effect-id span the
  gen-3 roster reserves for it. A family the static table gives no effect id but the applied profile's block map binds
  `confirmed` resolves to its bound effect ids. `effectId` is `null` when there is nothing to address: modifier slots
  (`MOD`), preset-level data (`PRESET`), a reference whose family did not resolve, a family without an effect id, an
  instance the device does not have. **Write such a control to `crossBlock.effectId`, not to the open block:** that
  block's own write guards apply, and a write to GLOBAL (effect id 1) or FC (199) changes persistent settings, as
  `definitions.persistentWrites` says of those blocks. `null` means display only. The classic response serves the layout
  unchanged (no `effectId`).
  **`effectId` is resolved from the device model, not from the current preset:** it may name a block that is not placed
  in the preset (a Delay page's control on Reverb 2 while the preset holds only Reverb 1; a block the preset does not use
  at all). Check the grid (`GET /preset/grid`) before writing: when no cell holds that effect id, show the control
  disabled or display-only rather than writing to a block that is not there. Device-level blocks that are never placed
  on the grid (GLOBAL 1, FC 199, …) are exempt from that check.
- **Which layout is served** (both responses): editor firmware gates are evaluated against the connected firmware — the
  firmware the connected unit last reported this session, so a later firmware read the unit does not answer keeps an
  older unit on its own layout (it is forgotten on a disconnect, a port change or a model change; the newest firmware
  when none was ever read) — and a variant folded from a page-level selector is keyed by that selector's current
  ordinal, read from the block body for a selector that is not an enum (REVERB_BASETYPE); see
  [LAYOUTS.md](LAYOUTS.md#how-a-layout-is-resolved).
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
- **409** (amended with ADR 0005), a block the catalog cannot place on its own: its block-map binding is read-only (a
  roster-only family, a `live-only` binding), or the last generic read of the block matched it by its bulk shape
  (`likely`) and no confirmed, editor-cache-bridged binding serves it:
  `block <eid> has no confirmed definitions on this device; write refused`. Also a pid of a `section:<tag>` /
  `block:<eid>` family that has no informative row there: `param <pid> of block <eid> has no definition on this device;
  write refused`. A block with `candidates` or `none` is not refused (nothing is known about it). The refusals hold for
  every client, whichever response it read.

### Capabilities and tooling
`capabilities.definitions` (`genericParams`, `catalogFirmware`, the applied `profile` with its `format`, `sources` and
`coverage`, `drift`, `contribute`, `walk`, `portable`) and how rows are named are in [definitions.md](definitions.md).
`server/scripts/profile-check.ts` (`npm run profile-check`) checks the response against a profile, offline or against a
running server (GET only), and has offline document tools (`--rederive`, `--diff`, `--merge`, `--blocks`).

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
sources, import by path, the contribution routes; ADR 0003; the `.axisdefs` import, ADR 0005), keep a stricter per-route rule on top: the
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

---

# ADR 0005 — Device-definition profiles v2

Status: accepted · 2026-11-23

## Context
A stored profile used to be the tables one source produced (an editor-cache import or a live walk), and each new source
replaced it. Nothing raw was kept, so a newer build could not re-derive a profile without the device, an editor cache and a
walk could not complement each other, a cloud pull could replace a better local profile, and a block type a newer firmware
added had no definitions at all.

## Decision
A profile document keeps its raw definition sources and derives its tables from all of them; build, import and pull merge
into it instead of replacing it. The model (formats, sources, merge precedence, drift, coverage, unknown blocks, `.axisdefs`)
is described in [definitions.md](definitions.md); this ADR is the HTTP contract. Every route exists on the Fastify app and the
browser runtime router with the same shapes and error codes (the differences are noted below). Gate on
`capabilities.definitions` (`genericParams`, `portable`, `walk.blockProbe`).

| Route | Purpose | Remote | Origin |
|---|---|---|---|
| `GET /device/definitions/diff` | the bundled catalog against the applied profile | allowed | app-wide (ADR 0004) |
| `GET /device/definitions/export` | the stored profile as a `.axisdefs` file | allowed | app-wide |
| `POST /device/definitions/import` | adopt a `.axisdefs` file | denied | loopback peer (ADR 0004's stricter rule) |
| `POST /device/definitions/blocks/:eid/probe` | read one placed unknown block's definitions | denied | app-wide |

Changed: `GET /device/cache`, `POST /device/cache/build`, `POST /device/cache/import`, `GET|POST /device/cache/cloud*`,
`GET /preset/blocks/:eid/params?generic=1` and `PUT /preset/blocks/:eid/params/:paramId` (ADR 0002), `GET /device`
(`capabilities.definitions`, definitions.md), and the event stream (below). Their Remote and origin rules are unchanged:
the relay serves their GETs and the param `PUT`, never the build, the imports, the cloud pull or publish. Error bodies are
`{ "error": "<code>", …fields, "message"? }`; the param write guard keeps ADR 0002's `{ statusCode, error, message }`.

### Merges and refusals (every route that stores a source)
Build, editor-cache import, cloud pull, `.axisdefs` import and probe add their source to the stored document of the key
(definitions.md, *Merging*). Shared answers:
- **409** `newer-profile`: a newer build wrote the stored document; it is not rewritten.
- **409** `local-profile-better`: the stored document has no raw sources (format 1) and its source outranks every incoming
  one, so the incoming sources would replace better data. Both 409 bodies carry `local: { source, format }`.
- `replace` (`replace: true` in a JSON body, `?replace=1` on a query) replaces the stored document and is never refused.
- **422** `derivation-failed`: the sources do not derive into a profile; `stored: true` (with `key`) when the new source was
  kept next to the sources of a stale document that still does not derive.
- SSE `definitions` after a build, editor-cache import or cloud pull that kept stored sources next to its own (`merged`),
  after every `.axisdefs` import (`imported`) and every stored probe (`block-probe`).

### `GET /device/cache` (changed)
Additive fields (numbers illustrative):
```json
{ "key": "11_99p0", "exists": true, "building": false, "stale": false, "currentSchema": 1,
  "meta": { "recordCount": 2400, "builtAt": "…", "firmware": "99.0", "unmappedSections": 2, "unmappedFamilies": 3, "source": "editor-cache", "schema": 1 },
  "format": 2,
  "sources": [ { "id": "editor-cache@2026-11-23T10:00:00.000Z#0", "kind": "editor-cache", "origin": "local",
                 "capturedAt": "2026-11-23T10:00:00.000Z", "firmware": "99.0", "records": 2400 } ],
  "coverage": { "complete": true, "gaps": [ { "kind": "no-tapers", "blocking": false, "fix": ["full-capture"] } ],
                "units": 0, "tapers": 0, "highIds": { "expected": 10, "present": 10 },
                "sections": { "total": 40, "assigned": 38, "system": 2, "new": 0, "unclassified": 0 }, "instances": [] } }
```
- `format` (a stored document): 1 or 2. `sources` (a stored document): one entry per raw source, empty for format 1; a
  stale format-2 document lists its sources too. `coverage`: a usable document only (definitions.md, *Drift and coverage*).
- `rederived: true`: this read derived the stored document again from its raw sources (no device traffic) and wrote it back
  unless a newer build wrote it (then SSE `definitions`, reason `rederived`).
- `staleReason` may be `derivation-failed`; `meta.source` may be `axisdefs`.

### `POST /device/cache/build` (changed)
Body `{ "force"?: boolean, "mode"?: "read-only" | "full", "scope"?: "standard" | "extended", "replace"?: boolean }`.
`200 { ok: true, key, started: true }`, or `200 { ok: true, already: true }` (SSE `cacheBuild` `already-built`).
- The walk is merged into the stored document (`replace`: replaces it).
- **`already`** only when the stored document is format 2, holds a local live source of the requested kind (a full walk
  also satisfies a read-only request), has no blocking gap a repeat walk could close (fix `read-from-device`) and, for an
  extended build, a source whose scope already covers the extension; or when it is a format-1 document made from an editor
  cache (byte-exact tables a walk cannot improve). `force` walks anyway and replaces the stored source of its kind; over a
  format-1 editor-cache document it answers 409 `local-profile-better` (`replace` walks over it).
- **`scope`**: absent = `extended` for a read-only build when `walk.extendedIds` or `walk.above160` of the running firmware
  is open (judged after a fresh firmware read; a failed read keeps the standard scope), else `standard`; a full build stays
  `standard` unless `extended` is asked for. An extended build stores and applies the standard walk first, then runs the
  read-only extension walk; an extension that stops keeps the standard walk's result.
- **409** `newer-profile` / `local-profile-better` (above), besides `building` and `busy`.
- Terminal SSE `cacheBuild`: `done` of an extended build carries `extension: "done" | "skipped" | "aborted"` and, with
  `aborted`, `abortReason`, one of `implausible-reply (block b, param p)`, `silent-run (block b)`, `query-budget (n
  queries)`, `cancelled`, `empty-block (block b)`, `walk-failed`, `derivation-failed`. Over a stale document whose sources
  still do not derive the build ends with `error` (`derivation-failed: …`; the walk is stored with the other sources).

### `POST /device/cache/import`, `/device/cache/cloud/pull`, `/device/cache/cloud/publish` (changed)
- **Import** (editor cache): merged into the stored document; `?replace=1` (or `replace: true` next to `path`) replaces it.
  `200` adds `format: 2, sources, coverage, merged` (`merged`: stored sources were kept). New answers: the shared merge
  refusals, `422 derivation-failed`, `409 firmware-differs` (a merge of another firmware's source), `500
  contains-user-data` (a privacy guard hit: a bug).
- **Pull**: body `{ "replace"?: boolean }`. A cloud row with raw sources this build reads: the sources are validated
  strictly (`422 cloud profile malformed` with the offending path otherwise), stored with origin `cloud` and merged (a
  local source of the same kind always outranks them); a source of another firmware is `409 firmware-differs`. A row with
  derived tables only is adopted only when no usable profile and no raw sources are stored for the key, else `409
  local-profile-better` (`replace: true` adopts it). `200` adds `format: 2, merged` for a merged row. `GET
  /device/cache/cloud` adds `rederivable: true` for a row whose tables are not this build's but whose raw sources it can
  derive (a pull re-derives it).
- **Publish** uploads derived tables only: no raw sources, sections, block map, provenance or coverage, no format-2 meta,
  and no `section:<tag>` / `block:<eid>` family in any table. A format-2 document publishes the tables derived from its
  LOCAL sources alone (cloud and file sources never travel back); one without a local source is `409` (not publishable).
  `409 profile-stale` for a stale document; `409 dev-hook-active` while the `FORGEFX_DEFS_HIDE_FAMILY` development hook
  hides a family (or the stored tables were derived under it).

### `GET /device/definitions/diff`
The bundled catalog against the profile applied for the running firmware. Reads state the server already holds: it never
triggers detection and never talks to the device.
- Query: `family=<F>` (repeatable, also comma-separated; filters `families` only) and `include=` (comma-separated, also
  repeatable) out of `params`, `rosters`, `enums`, `strides`, `sections`, `blocks`, `instances` (absent or empty: all).
  Unknown `include` tokens are ignored; a part not included is omitted, not sent empty. `summary` always covers the whole
  profile.
- `200` whenever a gen-3 grid device is identified and its firmware is known (`state` says the rest); `503 no-device` (no
  unit identified yet); `501 unsupported { capability: "genericParams" }`; `503 firmware-unknown`; `404 unknown-family {
  family }` for a `family` the catalog and the profile do not have (a `section:` / `block:` key included).

Example (numbers illustrative):
```json
{ "model": 17, "firmware": "99.0", "catalogFirmware": "12.0", "state": "none",
  "profile": { "key": "11_99p0", "source": "editor-cache", "byteExact": true, "format": 2, "sources": [ … ] },
  "summary": { "newParams": 1, "changed": { "compatible": 2, "incompatible": 0 }, "removed": 0, "movedNames": 0,
               "rosterChanges": 1, "enumChanges": 0, "strideChanges": 1, "newSections": 0, "unknownBlocks": 0,
               "suspects": [], "disagreements": [] },
  "families": [
    { "family": "FUZZ", "eid": 118, "status": "changed",
      "params": { "added": [ { "id": 60, "name": "P60", "kind": "float", "generic": true, "min": 0, "max": 10 } ],
                  "changed": [ … ], "removed": [], "moved": [] },
      "roster": { "selectorId": 0, "before": 100, "after": 101, "appended": ["…"], "inserted": [], "renamed": [], "removed": [], "ordinalShift": false },
      "enums": [], "stride": { "before": 60, "after": 61 } } ],
  "sections": [], "blocks": [], "instances": [] }
```
- `state` equals `capabilities.definitions.drift` at the same moment; `profile` is null while the bundled catalog is live
  (then no family is listed).
- `families`: every family whose `status` is not `unchanged`: `changed`, `suspect` (its profile section looked
  mis-assigned and was not used), `disagreement` (definitions.md, coverage) or `catalog-only` (the catalog has rows, the
  profile has no such family). `eid` is the family's first effect id (null: none).
- `params`: one entry per pid (`ParamDelta`: `id`, `name`, `kind`, `generic`, a float's `min`/`max`/device `unit`, an enum's
  number of `options`, `change` `compatible`/`incompatible` and `fpBefore`/`fpAfter` on `changed`). Names are the catalog
  names the generic response serves, or `P<pid>`. An `added` entry with `movedFrom` is a param whose name moved with its
  row, not a new one. `removed` is null where nothing can be said (a family that is not byte-exact, a suspect family); it can
  list more entries than `summary.removed` counts (a vanished name whose pid now holds another param).
- `roster`: the model list against the catalog's (`appended`, `inserted`, `renamed`, `removed`; `ordinalShift`: a kept
  label sits at another ordinal now, so stored selections change meaning). `enums`: other changed label lists (`change`:
  `appended`, `renamed`, `inserted`, `removed` or `replaced`). `stride`: the family's table size changed.
- `sections`: editor-cache sections no catalog family took that are new, unclassified or bound to a block
  (`{ tag, key, role, stride, informative, mappedEids }`). `blocks`: block-map entries and placed blocks nothing describes
  (`{ eid, placed, state, key, sectionTag, params }`; `placed` is from the edit-buffer grid as last read, false before any
  grid read). `instances`: the coverage's instance-count mismatches.

### `.axisdefs`: `GET /device/definitions/export`, `POST /device/definitions/import`
The file is UTF-8 JSON (definitions.md, *Portable definitions files*):
```json
{ "kind": "axis-device-definitions", "version": 1, "model": 17, "firmware": "99.0", "key": "11_99p0",
  "exportedAt": "2026-11-23T10:00:00.000Z", "app": { "engine": "…", "codec": "…" },
  "profile": { "meta": { "schema": 1, "format": 2, "sources": [ { "id": "…", "kind": "editor-cache", "origin": "local", "capturedAt": "…", "firmware": "99.0", "records": 2400 } ] },
               "raw": { "format": 1, "sources": [ … ] } },
  "sha256": "<64 lowercase hex>" }
```
- `app.engine`: the exporting ForgeFX version; `app.codec`: the codec that derived the document. `profile.meta` is
  informational (recomputed on import); `profile.raw` is the content.
- `sha256`: hex SHA-256 of the UTF-8 bytes of the canonical JSON of `profile`: what `JSON.stringify` writes, without
  whitespace, with the keys of every object sorted by UTF-16 code units, `undefined` properties left out.

**Export.** `200`, the file as the body, with `Content-Disposition: attachment; filename="<model>-<firmware>.axisdefs"`
(e.g. `fm3-13.0.axisdefs`). The browser runtime returns the same header with its response; the Remote relay does not pass
headers on, so a client there names the file itself. No device traffic besides the detection every cache route runs on
first use. `503 no-device`; `501 unsupported { capability: "portable" }`; `404 no-profile` (nothing stored for the
firmware); `409 profile-legacy` (a format-1 document: nothing raw to export, read the definitions again first); `409
profile-stale` (with the stale fields); `409 profile-unreadable` (raw sources of a newer format, or ones this build's own
import would refuse); `500 contains-user-data` (a bug).

**Import.** The file is the JSON body (at most 8 MiB, else `413 too-large { bytes?, limit }` before it is read). `force`
and `replace` are query flags only (`?force=1`, `?replace=1`): nothing inside the file is read for them. After the gates
(`503 no-device`, `501 unsupported { capability: "portable" }`), the file is checked in this order; the first failure
answers:
1. shape: `400 invalid-file` (a JSON object without prototype keys; `kind`; `version`; `model`; `firmware` in its canonical
   spelling `13.0`; a `key` that is the model's and firmware's own; the profile envelope; every source and record — records
   only in the sections an editor-cache source declares or the blocks a live source walked, a bounded record total, a
   source's firmware, where it names one, the file's). A `version`, profile format or raw format newer than this build reads is `422
   unsupported-format { what, got, supported }`;
2. checksum over `profile` as received: `422 checksum-mismatch { declared, computed }`;
3. user data: `422 contains-user-data`;
4. model = the identified unit's: `409 model-mismatch { expected, got }`;
5. firmware = the running firmware: `409 firmware-differs { expected, got, overridable: true }`. With `?force=1`, or on a
   unit whose firmware is unknown, the sources are stored under the file's key and not applied;
6. merge and derivation: the shared merge answers above (refusals, `422 derivation-failed`).

Every imported source is stored with origin `file`. `200 { ok: true, imported: true, key, applied, sources, coverage }`
(`applied`: the file is the running firmware's and now live; `sources` and `coverage` of the stored document), and SSE
`definitions` (`imported`), also when the file was stored next to a stale document (`422 derivation-failed`, `stored: true`).
On the server the route is loopback-peer guarded (`403 forbidden-origin`). The browser runtime takes the same body and
query flags with the same 8 MiB limit and has no origin guard (an in-page call). A runtime without `crypto.subtle` (a
browser page outside a secure context) answers both routes with `501 unsupported { capability: "sha256" }`.

### `POST /device/definitions/blocks/:eid/probe`
One read-only definition walk of a placed block the catalog does not know, so the block map can bind it. Preconditions,
in this order, every refusal before any device traffic:

| Status | `error` | When |
|---|---|---|
| 503 | `no-device` | no unit identified (detection is never triggered) |
| 501 | `unsupported` `{ capability: "blockProbe" }` | not a gen-3 grid device |
| 503 | `firmware-unknown` | the running firmware was not read |
| 501 | `unsupported` `{ capability: "blockProbe", reason: "firmware", firmware }` | the probe is not verified on the running firmware (`walk.blockProbe` false) |
| 400 | `invalid-eid` | the effect id is not an integer 0..16383 |
| 501 | `unsupported` `{ …, reason: "firmware", scope: "above160" }` | an effect id above 160 while `walk.above160` is false |
| 409 | `known-block` `{ family }` | the bundled tables place the effect id (a catalog family, a roster-only family, a virtual block) |
| 404 | `block-not-placed` | the block is not in the edit-buffer grid as last read (read the grid first) |
| 409 | `newer-profile`, `local-profile-better` | the probe could not be stored (merges, above) |
| 409 | `building`, `busy` `{ what }` | another device job runs |

The walk runs with the device claimed and telemetry paused: read-only, at most param id 127, bounded by the widest
editor-cache section the block's bulk read fits, every query checked against that bound before it is sent. At most 60 s:
`504 probe-timeout` (nothing stored). `500 walk-bound` (a query outside the planned scope: a bug, nothing stored), `503
probe-failed`. The result is stored as a `live-probe` source (replacing an older probe of the same block), the document is
derived again and applied, and SSE `definitions` (`block-probe`, with `eid`) is sent (numbers illustrative):
```json
{ "ok": true, "eid": 203,
  "blockMap": { "eid": 203, "key": "section:60", "sectionTag": 60, "confidence": "confirmed", "evidence": ["device-records"],
                "compared": { "rows": 40, "equal": 40, "probedTo": 72 }, "channels": true },
  "records": 41, "walk": { "queries": 75, "pseudoReplies": { "endMarker": 3, "duplicateId": 0, "implausible": 0 }, "lostReplies": 0 } }
```
`blockMap` is the document's entry for the block, with the codec's `confidence` (`confirmed`, `likely`, `candidate`, …;
ADR 0002's `state` is derived from it); a walk that binds nothing answers a `candidate` entry without candidates. `422
derivation-failed` (`stored: true` when the probe was kept next to a stale document; the event is sent then too).

### Diagnostic capture: definition-walk steps (`POST /diagnostics/capture`)
The device diagnostic (`POST /diagnostics/capture`, both twins, refused over Remote) has three optional steps that collect
the evidence a `walk` flag of a model and firmware is enabled on. They are **never** part of the default steps: a run
includes them only when the request names them in `steps`, e.g.
`{ "acknowledged": true, "steps": ["info", "readonlyWalk", "above160Walk", "blockProbe"], "unverifiedScope": true }`.
`unverifiedScope` (boolean, default false; any other type → **400** `invalid-request`) lets them run on a firmware their
gate does not list (below). Steps always run in this
order: `info`, `readonlyWalk`, `labelProbe`, `extendedWalk`, `above160Walk`, `blockProbe`, `dumpHeaderProbe`,
`reloadProbe`, `fullWalk` (the definition-walk steps come before every step that may switch presets, so the probe reads
the edit buffer as the user left it).

| Step | Reads | Gate it reports on |
|---|---|---|
| `extendedWalk` | the ids above 127 of the known tables of blocks 0..160 — the extension walk of an extended build | `walk.extendedIds` |
| `above160Walk` | the placeable blocks above effect id 160 the unit has, at most id 127 | `walk.above160` |
| `blockProbe` | each block of a fresh read of the edit-buffer grid that the bundled tables do not place (and, on the Axe-Fx III, each placeable one its effect-id table names from the block roster only; never a virtual block): the probe route's walk | `walk.blockProbe` |

Each step re-reads the firmware first (no answer: `skipped`, nothing sent) and records its gate in its result:
`gate: { flag, firmware, verified, devOverride, unverifiedScope, allowance }` with `allowance` `verified` (the firmware is
listed), `dev-override` (only the development override opens it) or `diagnostic` (neither). A `diagnostic` step runs only
with `unverifiedScope: true` — it is how the evidence is collected; without it the step is `skipped` and nothing is sent
past the firmware read. Every run, listed or not, follows the same rules: read-only, the build's bounds, caps and query
budget, every query checked against the plan before it is sent (a query outside it is never sent and ends the whole run as
`query-bound`), and nothing stored or applied (the stored profile and the runtime profile are never changed).
`blockProbe` reads a block above effect id 160 only when `walk.above160` is true or this run's `above160Walk` **passed**
(`passed: true` in its result, not merely `ok`; else the block is `skipped`), and asks for a liveness reply after each
block (no reply ends the run as `device-silent`); one probe takes at most 60 s, and the step stops at the first probe that
does not finish. Its grid read sends no `definitions` event during the run.

Step results (inside the bundle's `steps[].result`, additive; bundle `schema` stays 1):
- every one: `labels: "unscreened"` (below) and `gate`.
- `extendedWalk` / `above160Walk`: `plan { blocks, bounds, knownSize, budget, cap, hinted }`, `outcome`
  (`done` | `aborted`, with `abortReason` in the build's vocabulary: `implausible-reply (block b, param p)`,
  `silent-run (block b)`, `query-budget (n queries)`, `empty-block (block b)`), `passed` (`done` with no implausible,
  lost or unresolved reply and at least one real definition in every planned block), `emptyBlockCheck` (`passed`,
  `failed`, `not-run` without a completed `readonlyWalk` in the run, `not-applicable` above 160), `blocks[] { block,
  family, bound, knownSize, records, lastReal }`, `walk` (reply statistics) and `source`, the records as a
  `live-readonly` raw source (the profile documents' own shape). An abort rule fails the step; the run carries on while
  the unit answers.
- `blockProbe`: `placedBlocks` (a count), `above160` (`verified`, `dev-override`, `this-run` or `not-shown`) and
  `targets[] { eid, kind: "unknown" | "roster", family?, status, reason?, fits, ceiling, ceilingFrom, walk, source,
  blockMap, aliveAfter }` — `ceilingFrom` `shape` (the widest fitting section), `catalog` (a roster-only block without a
  fitting section: its family's catalog stride) or `cap` (127); `source` is a `live-probe` raw source, `blockMap` the
  entry the block map would get with the probe merged into the stored profile (computed only, never stored). `status`
  `aborted` = the block the run ended on; `pending` = not reached.

The wire log and its redaction are unchanged: the steps' frames are in `frames`, dump payloads of the grid read are cut.
**Label and value text of these steps is not screened:** the definition and label replies (in `frames` and in the
results' `source` records) are kept verbatim, and a block's lists or formatted values can carry names the user chose (for
example the names of files loaded into a block). The bundle says so with `redaction.unscreenedLabels: true` whenever one
of these steps talked to the unit.

### Events (`GET /events`, relayed over Remote)
`{ "type": "definitions", "reason": "<reason>", "key": "11_99p0", "eid"?: 203 }`: re-read `capabilities.definitions`,
`GET /device/cache` and the open block.

| `reason` | When |
|---|---|
| `merged` | a build, an editor-cache import or a cloud pull kept stored sources next to its own (after its `cacheBuild` `done`) |
| `imported` | a `.axisdefs` file was imported |
| `block-probe` | a block probe stored its source (`eid`) |
| `rederived` | a stored document was derived again from its raw sources and written back |
| `unmapped-blocks` | gen-3 grid devices: the set of placed blocks nothing describes changed (after a grid read or a profile swap), which moves `coverage` and `drift`; `key` is the running firmware's, nothing stored changed |

`cacheBuild` gains `extension` and `abortReason` on its terminal `done` (above); new outcomes ride on the existing terminal
phases, never on new phases.

### Errors
| Status | `error` |
|---|---|
| 400 | `invalid-file`, `invalid-eid` |
| 403 | `forbidden-origin` (import, server) |
| 404 | `no-profile`, `unknown-family` `{family}`, `block-not-placed` |
| 409 | `newer-profile` / `local-profile-better` `{local}`, `profile-legacy`, `profile-stale`, `profile-unreadable`, `model-mismatch` `{expected, got}`, `firmware-differs` `{expected, got, overridable?}`, `known-block` `{family}`, `building`, `busy` `{what}`, `cloud-profile-stale`, `dev-hook-active` |
| 413 | `too-large` `{bytes?, limit}` |
| 422 | `unsupported-format` `{what, got, supported}`, `checksum-mismatch` `{declared, computed}`, `contains-user-data`, `derivation-failed` `{stored?, key?}`, `cloud profile malformed` |
| 500 | `contains-user-data` (export, persist: a bug), `walk-bound` (probe: a bug) |
| 501 | `unsupported` `{capability: "genericParams" \| "portable" \| "blockProbe" \| "sha256", reason?, scope?, firmware?}` |
| 503 | `no-device`, `firmware-unknown`, `probe-failed` |
| 504 | `probe-timeout` |

## Consequences
- A profile survives a newer build (it is derived again, no new read needed) and gets better as sources are added: an
  editor cache and a walk together give exact rows with device units.
- A format-1 document from an older build stays usable (`no-raw`); the next build, import or pull writes format 2. Older
  builds still read format-2 documents (the derived tables keep their shape).
- A placed block a newer firmware added can be read (and, once bound to an editor-cache section, edited) without an app
  update; until then its writes are refused.
- A `.axisdefs` file proves integrity, not authorship: anyone can edit and re-seal one.
