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
