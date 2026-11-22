# Definition packs (parameter naming)

The device wire protocol exposes each parameter by a numeric `paramId` (== dump-array index
== SET address index), but not a human label. ForgeFX therefore ships **open data packs** —
one JSON per block — mapping each block's `paramId` to a name (and, where known, the unit,
range, and how the wire value scales to engineering units).

## Pack format (`definitions/fm3-<block>.json`)
```json
{
  "name": "Cab",
  "page": 62,
  "params": [
    { "index": 8,  "name": "Level 1" },
    { "index": 62, "name": "LowCut 1", "unit": "Hz", "min": 20, "max": 200, "scale": "Log" }
  ]
}
```
- `page` — the block's dump page (func 0x1f / 0x75), which equals the block id.
- `index` — the parameter's `paramId` (dump-array index == SET address index, unified).
- `scale` — `Linear` (`min + n·(max−min)`), `Log` (`min·(max/min)^n`), or `Raw` (integer/index).
- `unit`/`min`/`max`/`scale` are optional; when absent the raw normalized value is used.

## Reading named params
`Definitions.ReadNamed(blockDef, dump)` decodes the dump and applies the pack →
`[{name, value, unit, norm}]`. Served at `GET /block/{name}/params`.

## Validation
Packs are validated against the device by dumping a block and confirming known anchors —
e.g. Cab `Level 1`=8, `Pan 1`=12, `Proximity 1`=20, `LowCut 1`=62, `HiCut 1`=66,
`Low Slope 1`=74 all match hardware dumps. Packs are open data and crowd-sourceable.

---

# The connected device's own definitions

The bundled packs and catalogs describe the firmware they were made from. A unit can run a newer
one, so ForgeFX can also adopt the device's **own** definitions (a *profile*: the parameter rows,
ranges and label lists of the connected unit) and reconcile them with the bundled catalog, row by
row. What the reconciliation finds is served by the *generic* block-params response
([api-design.md](api-design.md#adr-0002--generic-block-params-generic1)), so a parameter the
catalog has no name for still appears, as `P<pid>`, instead of vanishing.

## Profiles
`GET /device/cache` and `GET /store/deviceCaches/<key>` (key `<model-hex>_<major>p<minor>`, e.g.
`11_99p0` for an FM3 on a firmware 99.0) show what is stored; a profile is **applied** only when its schema stamp is current
(`GET /device/cache` reports `stale` otherwise) and one is stored for the running firmware.
`capabilities.definitions.profile` (see below) says which one is live. Three sources:

| `source` | Where it comes from | `byteExact` |
|---|---|---|
| `editor-cache` | imported from the official editor's definition cache | yes |
| `live` | a read-only walk of the connected unit (heuristic, bounded coverage) | no |
| `cloud` | pulled from the cloud; counts as byte-exact only if it was published from an import | by origin |

A **byte-exact** profile is exact device data for its firmware: a catalog row it lacks is gone
(`hidden` reason `removed`), a row it adds is new. A **live** profile is a reconstruction: it never
hides a catalog row, never re-classifies a catalog parameter's kind, and never replaces a catalog
range with an unused-slot row. A family whose profile rows match *another* family's catalog rows
clearly better than their own (a section assigned to the wrong family) is flagged **suspect**: its
profile data is not used, it is listed in `suspectFamilies`, and the block is served from the catalog.
When no usable profile exists (deleted, or the firmware changed to one without a profile) the bundled
catalog is live again.

## How a row is named
Each informative row (a row with an editable span) is compared with the catalog's row at the same
id by a **fingerprint** (`fp`, `"1:xxxxxxxx"`: kind, typecode, bounds, step, enum count and label
list; not unit, taper or default).

| Profile vs catalog | Served as |
|---|---|
| same fingerprint | the catalog name, `nameConfidence: "high"` |
| differs, still the same kind of parameter (labels appended, a range revised) | the catalog name, `"medium"` |
| differs, no longer compatible | the catalog name, `"low"` (a client should show a warning) |
| the row moved to another id (the name follows it when exactly one row now carries its fingerprint) | the catalog name at the new id, `nameSource: "catalog-moved"`, `movedFrom`, `"medium"` |
| in the profile only, at an id the catalog names but has no row for (or only an unused-slot row) | the catalog name, `nameConfidence: "low"`, `isNew: true` (there is no catalog row to compare it with) |
| in the profile only, no catalog name | **generic**: name `P<pid>`, `generic: true`, `isNew: true`, `pageHint: "new-in-firmware"` |
| in the catalog only, no name (a row the catalog never labelled) | **generic**, `pageHint: "more"` |
| in the catalog only, named | shown as before; `hidden` reason `removed` when a byte-exact profile of the family no longer has it |

A parameter's kind and widget come from the device's row, not from a name. An enum row is never a knob
(`widget` is `toggle` for two states, else `dropdown`). A float row is a `knob`, or a `stepper` (a knob
with whole-number detents) when its bounds and step are whole numbers or the catalog or the editor layout
marks it as a selector. A float row that ships a label list is a selector too: a `toggle` over a 0..1 span
with two labels, else a `dropdown` with `write: null`. `write` says how to write it (`norm`: `{ value: 0..1, continuous: true }`; `ordinal`:
`{ value: <ordinal>, continuous: false }`; `null`: no verified write path, advice for a UI only).

## `capabilities.definitions`
Served by `GET /device` and `GET /device/detect` on every device:
```json
"definitions": { "genericParams": true, "catalogFirmware": "12.0",
  "profile": { "key": "11_99p0", "source": "editor-cache", "byteExact": true, "firmware": "99.0", "suspectFamilies": [] },
  "drift": "none" }
```
- `genericParams`: the device serves `?generic=1` (gen-3 grid devices with self-describe: Axe-Fx III, FM3,
  FM9). Others ignore the flag and answer the classic shape without a `definitions` block.
- `catalogFirmware`: the firmware the bundled catalog was made from (`null` where that is not settled).
- `profile`: the **applied** profile (provenance only), `null` while the bundled catalog is live.
- `drift`: `none` (an applied profile of the running firmware, or the running firmware is the catalog's),
  `unprofiled` (neither: the generic response may be missing newer parameters), `unknown` (firmware not
  read, or no catalog firmware and no profile to compare).

## Checking it: `profile-check`
`server/scripts/profile-check.ts` checks that every row a profile describes is listed or hidden, and that
the served response agrees with it. It reads files or a running server and prints to the terminal; keep
profile files out of the repository.
```
npm run profile-check -- --profile <file> [--model 0x11] [--key 11_99p0] [--allow-stale]   # offline
npm run profile-check -- --url http://127.0.0.1:5056 [--eid 1] [--profile <file>]           # online, GET only
```
- **Offline** builds the runtime profile the way the server does and prints one line per family
  (informative rows, listed, hidden, generic, new, name-confidence counts, suspect), then totals.
  `--profile` takes a store file (`deviceCaches.json`), one stored document, or a bare profile. A profile
  with a stale schema is refused unless `--allow-stale` (the server would not apply it either).
- **Online** reads `/device` (printing `capabilities.definitions`), `/preset/blocks`, and
  `/preset/blocks/<eid>/params?generic=1` for every placed block (plus any `--eid`), and compares each
  with the stored profile. It sends nothing but GET requests.
- Both modes list the layout controls that write **another block's** parameter and flag those the
  write guard would refuse; `--probe FAMILY:pid` (repeatable) prints a row and the guard's verdict;
  `--list FAMILY` lists what is served; `--json` prints one JSON document.
- Exit code 1 when an invariant fails: listed + hidden (other than `removed`) differs from the profile's
  informative rows; an enum-kind entry in `named`; a value `unresolved: "channel-unknown"` or
  `"read-failed"`; a suspect family; the response disagrees with the profile; a block request the server
  answered with a status other than 200. Exit code 2: a usage or input error (bad options, an unreadable or
  stale profile), a server that cannot be checked (`/device` or `/preset/blocks` not answered with 200, no
  generic support), or any request that failed at the transport level (connection refused, timeout,
  redirect); requests never follow redirects.

## Testing hook
`FORGEFX_DEFS_FORCE_GENERIC="CHORUS:8"` (comma-separated `FAMILY:pid`, a bare pid joins the previous
family) serves the listed ids as generic parameters whatever the catalog knows. For testing only:
default off, read from the process environment, never read by the browser runtime.
