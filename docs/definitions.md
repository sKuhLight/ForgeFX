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
A profile is one document per model and firmware in the local store (collection `deviceCaches`, key
`<model-hex>_<major>p<minor>`, e.g. `11_99p0` for an FM3 on a firmware 99.0). `GET /device/cache` summarises the one of
the running firmware; `GET /store/deviceCaches/<key>` returns the whole document (it can be large: read the summary for
display). A profile is **applied** only when one is stored for the running firmware and it is usable (`GET /device/cache`
reports `stale` otherwise, see *Document formats* below). `capabilities.definitions.profile` (see below) says which one is
live. Its `source` names the best source the document holds:

| `source` | Where it comes from | `byteExact` |
|---|---|---|
| `editor-cache` | imported from the official editor's definition cache | yes |
| `live` | a read-only walk of the connected unit (heuristic, bounded coverage) | no |
| `cloud` | pulled from the cloud; counts as byte-exact only if its data came from an editor cache | by origin |
| `axisdefs` | imported from a definitions file (`.axisdefs`, see below); byte-exact only if its data came from an editor cache | by origin |

A **byte-exact** profile is exact device data for its firmware: a catalog row it lacks is gone
(`hidden` reason `removed`), a row it adds is new. A **live** profile is a reconstruction: it never
hides a catalog row, never re-classifies a catalog parameter's kind, and never replaces a catalog
range with an unused-slot row. A family whose profile rows match *another* family's catalog rows
clearly better than their own (a section assigned to the wrong family) is flagged **suspect**: its
profile data is not used, it is listed in `suspectFamilies`, and the block is served from the catalog.
When no usable profile exists (deleted, or the firmware changed to one without a profile) the bundled
catalog is live again.

### Document formats and sources
- **Format 2** (`format: 2`): the document keeps its **raw definition sources** and the tables derived from them. The
  derived tables are a cache: whenever this build derives differently from the build that wrote them (another schema, an
  older derivation), they are derived again from the raw sources when the profile is loaded, without any device traffic,
  and written back (`GET /device/cache` answers `rederived: true`, SSE `definitions` with reason `rederived`). A document a
  newer build wrote is never rewritten (where this build cannot use its tables, it re-derives them in memory only).
- **Format 1** (written by older builds): derived tables only. Usable while its schema stamp is current, stale otherwise
  (there is nothing to re-derive from). It reports the non-blocking coverage gap `no-raw`; the next build, import or pull
  for its key writes a format-2 document.

One raw source per line of `GET /device/cache` `sources`: `{ id, kind, origin, capturedAt, firmware, records }`.

| `kind` | What it holds |
|---|---|
| `editor-cache` | the records of an imported editor definition cache (without their byte positions in the file) |
| `live-full` | a full-capture walk of the unit |
| `live-readonly` | a read-only walk of the unit (the standard walk, plus the extension walk where it ran) |
| `live-probe` | a read-only walk of one placed block the catalog does not know (the block probe, see below) |

`origin` is `local` (read on this install), `cloud` (a cloud pull) or `file` (a `.axisdefs` import). A source that came
from outside this install is always stored with that origin, whatever it claims.

**No user content.** The editor's cache file also holds tables of the owner's own names (preset names, user cab names).
An editor-cache source leaves those tables out when it is created (it keeps only how many records it left out); every
write of a document, every export and every import checks that none is present.

**Stale.** A document that cannot be used is kept, not deleted, and `GET /device/cache` says why (`staleReason`):
`missing` (no schema stamp), `outdated` (an older schema of a format-1 document), `newer` (a schema this build does not
understand), `derivation-failed` (the raw sources of a format-2 document could not be derived). The next build, import
or pull adds to it or replaces it.

### Merging
A build, an editor-cache import, a cloud pull, a definitions-file import and a block probe each **add** their source to the
stored document of the key, and the document is derived again from all of its sources:
- **One source per kind and origin** (a probe: per block): a new source replaces the stored one of the same kind and
  origin. There is no history.
- **Precedence, per family:** `editor-cache` > `live-full` > `live-readonly` > `live-probe`; within a kind a local source
  outranks a cloud or file source. The best-ranked source that has a family provides its parameters, kinds, ranges, label
  lists and table size. A live row's device unit (and a full capture's measured taper) is added to the winning row only
  when both rows are otherwise identical; a live row never changes an editor-cache row's kind.
- **Conflicts:** rows that differ between two sources of a family are recorded; a family whose conflicts exceed 10 % of
  its informative rows is a `disagreement` (the better source still wins).
- A source taken on another firmware than the document's is never merged.
- The bounds and label hints of later walks come from a **local** editor-cache source only.
- `replace` (`replace: true` in a body, `?replace=1` on a query) stores the new source alone, as before profile v2.
- **Refused** (409, unless `replace`): `newer-profile` (a newer build wrote the stored document) and
  `local-profile-better` (the stored document is a format-1 document whose source outranks every incoming one: it has no
  raw sources to merge with, so the new source would replace better data).
- A stale document whose sources do not derive keeps them; the new source is stored next to them. If the document still
  does not derive, the request answers 422 `derivation-failed` with `stored: true`.

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
`{ value: <ordinal>, continuous: false }`; `null`: no verified write path, advice for a UI only, except on a
read-only block of the block map, see below).

### Units and tapers
A continuous parameter of the generic response says where its unit and its taper came from (`unitSource`,
`taperSource`):
- `device`: the applied profile's own row supplied it;
- `catalog`: the bundled catalog did (its row, or the catalog's unit for the parameter);
- `typecode`: derived when the response is built, from the row's typecode by the codec's typecode rules. A typecode unit
  is used only when neither the device row nor the catalog has one, and is never stored.

The taper itself is decided as before: an explicit taper of the row wins (`log`, anything else linear), otherwise the
typecode rule (log or linear). Without `taperSource` nothing names a taper and the parameter is served linear; without
`unitSource` it has no unit. The classic response is unchanged: it carries neither field and never a typecode unit.

## Blocks the catalog does not know
A newer firmware can add a block type the bundled catalog has no family for. Its effect id then maps to nothing, and the
generic response serves it as an unknown block (`unknownBlock: true`, named `Block <eid>`). A profile can still describe
it: the editor's definition cache has a section for every block type of its firmware, and a read of the placed block
shows which section it is. The profile document's **block map** binds such an effect id to that section (its parameters
are then served as generic `P<pid>` parameters of the family `section:<tag>`), or, without an editor cache, to the
block's own rows from a read-only walk (family `block:<eid>`).

How a block is bound decides what is served and whether it can be written (`definitions.blockMap` of the generic
response, [api-design.md](api-design.md#adr-0002--generic-block-params-generic1)):

| `blockMap.state` | Bound by | Served | Writes |
|---|---|---|---|
| `confirmed` | the block's own definitions, read from the unit, equal an editor-cache section | generic params of the section (named for a catalog family) | allowed (the usual write guards apply) |
| `confirmed` | a read-only walk only, no editor cache to compare with (`evidence: ["live-only"]`) | generic params of the block's rows | refused (a walk can mistake a parameter's kind) |
| `likely` | the block's current values fit exactly one editor-cache section | that section's params, read-only | refused |
| `likely` | Axe-Fx III: the model's effect-id table names the family from the block roster only, no read confirmed it | the family's named params, read-only (not an unknown block) | refused |
| `candidates` | several sections fit | nothing | not refused (nothing is known) |
| `none` | nothing to go by | nothing | not refused |

A `likely` block is confirmed by the **block probe** (`POST /device/definitions/blocks/<eid>/probe`): one read-only
definition walk of that placed block, stored as a `live-probe` source of the profile and merged like any other source
(API: [api-design.md](api-design.md#adr-0005--device-definition-profiles-v2)). The probe runs only on a firmware it has been
verified on (`capabilities.definitions.walk.blockProbe`; above effect id 160 also `walk.above160`). A placed block that
nothing describes makes the applied profile incomplete (runtime coverage gap `unmapped-block`, `drift: "partial"`).

## Drift and coverage
`capabilities.definitions.drift` says whether the running firmware has definitions to go by:

| `drift` | When |
|---|---|
| `none` | an applied profile of the running firmware without a blocking gap (also on the catalog's own firmware); or no profile is applied and the running firmware is the one the catalog was made from |
| `partial` | an applied profile with a blocking gap: one of the document's own (`coverage.gaps`), or the runtime `unmapped-block` |
| `stale` | the running firmware is not the catalog's, and its stored profile cannot be used (`GET /device/cache` `staleReason`) |
| `unprofiled` | the running firmware is not the catalog's and nothing usable is stored: newer parameters or models may be missing |
| `unknown` | the firmware was not read, or there is no catalog firmware and no profile to compare with |

A client treats a value it does not know like `unknown`.

**Coverage** (`GET /device/cache` `coverage`, for a usable document): `{ complete, gaps, units, tapers, highIds: { expected,
present }, sections: { total, assigned, system, new, unclassified }, instances, walk? }`. `complete` is true when no gap
blocks. `units` and `tapers` count the rows with a device unit and a measured taper, `highIds` the informative rows above id
127 the reference (the editor cache, else the catalog) has and the document holds, `instances` the families whose count of
instances seen on the unit differs from the bundled count (reported only, nothing changes), `walk` the reply losses of the
live sources. Each gap is `{ kind, blocking, families?, eids?, tags?, count?, fix }`; `fix` lists what closes it, best first.

| Gap | Blocking | `fix` |
|---|---|---|
| `no-raw` | never (a format-1 document) | `import-editor-cache`, `read-from-device` (only the first for a document made from an editor cache) |
| `high-ids` | when a document without an editor cache lacks rows above id 127 of a contiguous table, on a firmware other than the catalog's | `read-extended`, `import-editor-cache` |
| `far-ids` | never (rows beyond a contiguous read) | `import-editor-cache` |
| `blocks-above-160` | when a document without an editor cache lacks catalog families above effect id 160, on a firmware other than the catalog's | `read-extended`, `import-editor-cache` |
| `unresolved-replies`, `missing-slots`, `bound-hit` | always (a walk that still provides families lost replies, could not resolve them, or stopped at its bound inside a table) | `read-from-device` |
| `rosters` | when a document without an editor cache lacks the catalog's model lists, on a firmware other than the catalog's | `import-editor-cache` |
| `new-section` | never (editor-cache sections the catalog's firmware does not have) | `pack` |
| `disagreement` | always (two sources conflict on more than 10 % of a family's rows) | `import-editor-cache` |
| `no-units`, `no-tapers`, `no-cab-tables` | never | `read-from-device`, `full-capture`, `import-editor-cache` respectively |
| `unmapped-block` | always; runtime only (in `capabilities.definitions.profile.coverage`, never in the document) | probe the block, or import the editor cache |

What each fix means: `import-editor-cache` = `POST /device/cache/import`; `read-from-device` = `POST /device/cache/build`;
`read-extended` = a build with `scope: "extended"` (useful only where `walk.extendedIds` or `walk.above160` is true);
`probe-block` = `POST /device/definitions/blocks/<eid>/probe`; `full-capture` = a build with `mode: "full"`; `pack` = no
action yet.

## `capabilities.definitions`
Served by `GET /device` and `GET /device/detect` on every device:
```json
"definitions": { "genericParams": true, "catalogFirmware": "12.0",
  "profile": { "key": "11_99p0", "source": "editor-cache", "byteExact": true, "firmware": "99.0", "suspectFamilies": [],
               "format": 2, "sources": ["editor-cache", "live-readonly"], "coverage": { "complete": true, "gaps": ["no-tapers"] } },
  "drift": "none", "contribute": true,
  "walk": { "extendedIds": false, "above160": false, "blockProbe": false, "farIds": false }, "portable": true,
  "spotCheck": true }
```
The keys come in this order; new keys are appended, never inserted (also inside `profile`).
- `genericParams`: the device serves `?generic=1` (gen-3 grid devices with self-describe: Axe-Fx III, FM3,
  FM9). Others ignore the flag and answer the classic shape without a `definitions` block.
- `catalogFirmware`: the firmware the bundled catalog was made from (`null` where that is not settled).
- `profile`: the **applied** profile (provenance only), `null` while the bundled catalog is live. `format`: 1 or 2 (see
  *Document formats*); `sources`: the kinds of its raw sources, each once, in source order (empty for format 1);
  `coverage`: `complete` and the kinds of its gaps, the document's own plus the runtime `unmapped-block` (the details are
  in `GET /device/cache`).
- `drift`: `none`, `partial`, `stale`, `unprofiled` or `unknown` (see *Drift and coverage*).
- `contribute`: the device can contribute its editor definitions file (see below): a `genericParams` device
  that imports editor caches and whose firmware was read. Whether the cloud wants the file is not a device
  fact; it is in the contribution status.
- `walk`: how far a read-only definition walk may query the unit on its running firmware: `extendedIds`
  (ids above 127 of known tables), `above160` (the placeable blocks above effect id 160), `blockProbe` (the
  single-block probe), `farIds` (never enabled). Each is true only on a model and firmware it has been
  verified on; all false on an unknown firmware (the device diagnostic's optional `extendedWalk`, `above160Walk` and
  `blockProbe` steps collect the evidence for a model and firmware without storing anything: api-design.md, ADR 0005).
  With `extendedIds` or `above160`, a read-only
  `POST /device/cache/build` defaults to `scope: "extended"` (a full build only on request): the firmware is
  re-read, the standard walk is stored first, then a bounded read-only extension walk adds to it; the terminal
  `cacheBuild` `done` event says `extension: "done" | "skipped" | "aborted"` (with an `abortReason` code;
  an aborted extension keeps the standard walk's result).
- `portable`: the stored profile can be exported to and imported from a `.axisdefs` file (a gen-3 grid device). Whether
  a profile is stored to export is the export route's answer (404 `no-profile`), not this flag's.
- `spotCheck`: shared definitions pulled from the cloud can be checked against this unit before they are used
  (see "Shared definitions" below): a `genericParams` device with a bundled catalog whose firmware was read.

## Portable definitions files (`.axisdefs`)
`GET /device/definitions/export` writes the stored profile of the running firmware into a file; `POST
/device/definitions/import` adopts one, for example on a machine without the editor or after the store was reset. The
API is in [api-design.md](api-design.md#adr-0005--device-definition-profiles-v2).
- **Raw sources only.** A file carries the profile's raw definition sources and nothing derived: the importing build
  derives every table itself, so a file cannot bring in tables that do not follow from its sources.
- **No user content.** The tables of the owner's own names are never part of a source (see *Document formats*); export
  and import both check it. The hash of the user's editor-cache file and byte positions into that file are not written
  either. A file holds firmware content only: definitions, label lists, factory cab names.
- **Integrity, not authenticity.** The file's `sha256` covers its profile, so a damaged or edited file is refused, but
  anyone can edit a file and compute the checksum again. An imported editor-cache source counts as byte-exact and enables
  writes like a local import does: import files from others only when you trust them.
- **Never local.** Every imported source is stored with origin `file`: it ranks below a local source of the same kind and
  never widens the bounds or label hints of a later walk.
- **Same firmware.** A file of another firmware than the running one is refused unless `?force=1`; it is then stored
  under its own key and not applied. A file for another model is always refused.

## Checking it: `profile-check`
`server/scripts/profile-check.ts` checks that every row a profile describes is listed or hidden, and that
the served response agrees with it. It reads files or a running server and prints to the terminal; keep
profile files out of the repository.
```
npm run profile-check -- --profile <file> [--model 0x11] [--key 11_99p0] [--allow-stale]   # offline
npm run profile-check -- --url http://127.0.0.1:5056 [--eid 1] [--profile <file>]           # online, GET only
npm run profile-check -- --profile <file> [--rederive] [--diff] [--merge <file2>] [--blocks] [--eid <n,n>]   # document tools
```
- **Offline** builds the runtime profile the way the server does and prints one line per family
  (informative rows, listed, hidden, generic, new, name-confidence counts, suspect), then totals.
  `--profile` takes a store file (`deviceCaches.json`), one stored document, or a bare profile. A profile
  with a stale schema is refused unless `--allow-stale` (the server would not apply it either).
- **Online** reads `/device` (printing `capabilities.definitions`), `/preset/blocks`,
  `/preset/blocks/<eid>/params?generic=1` for every placed block (plus any `--eid`) and the stored profile
  (`/store/deviceCaches/<key>`), and compares each block with that profile. It sends nothing but GET requests.
- Both modes list the layout controls that write **another block's** parameter and flag those the
  write guard would refuse; `--probe FAMILY:pid` (repeatable) prints a row and the guard's verdict;
  `--list FAMILY` lists what is served; `--json` prints one JSON document.
- **Document tools** (offline, with `--profile`; they add to the offline check and use only the bundled catalog and the
  given files, never the network or a device), each through the function the server itself uses:
  - `--rederive` derives the document again from its raw sources and compares the result with its stored tables, per
    family. A format-1 document has no raw sources (reported as `no-raw`, not a failure); a difference on a document the
    server re-derives on load anyway (an older derivation) is a warning.
  - `--diff` prints the definitions diff of the document against the bundled catalog (the builder of
    `GET /device/definitions/diff`), as if the unit ran the document's firmware. It only reports.
  - `--merge <file2>` merges the raw sources of a second document of the same model into this one the way a build, import
    or pull merges into a stored profile, prints the merged sources, provenance, conflicts and coverage, and runs the
    offline invariants on the merged document.
  - `--blocks` prints the block map (state, evidence, candidates), the sections no catalog family took
    (`section:<tag>` / `block:<eid>`) and the effect ids the document knows that map nowhere (on an Axe-Fx III also the
    roster-only ids of its effect-id table). `--eid` names the placed effect ids for `--diff` and `--blocks`.
- Exit code 1 when an invariant fails: listed + hidden (other than `removed`) differs from the profile's
  informative rows; an enum-kind entry in `named`; a value `unresolved: "channel-unknown"` or
  `"read-failed"`; a suspect family; the response disagrees with the profile; a block request the server
  answered with a status other than 200; `--rederive`: the raw sources do not derive, or the derived tables differ
  from the stored ones; `--merge`: the merged sources do not derive, or an invariant fails on the merged document;
  `--blocks`: an inconsistent block map (two entries for one effect id, a confirmed entry whose family has no rows, a
  section it names that does not exist). Exit code 2: a usage or input error (bad options, an unreadable or
  stale profile), a server that cannot be checked (`/device` or `/preset/blocks` not answered with 200, no
  generic support), any request that failed at the transport level (connection refused, timeout,
  redirect; requests never follow redirects), or a `--merge` document that cannot be merged (another model, no raw
  sources, a source of another firmware, a merge the server would refuse: `newer-profile` / `local-profile-better`).

## Development hooks
For testing and acceptance runs only. Every hook is read from the process environment (never by the browser
runtime) and is ignored unless `FORGEFX_DEV_HOOKS=1` is set as well, and always when `NODE_ENV=production`;
an ignored hook is reported with one warning line.
- `FORGEFX_DEFS_FORCE_GENERIC="CHORUS:8"` (comma-separated `FAMILY:pid`, a bare pid joins the previous
  family) serves the listed ids as generic parameters whatever the catalog knows.
- `FORGEFX_DEFS_HIDE_FAMILY=RESONATOR` hides one catalog family, so its blocks are served like blocks a newer
  firmware added.
- `FORGEFX_WALK_SCOPE_OVERRIDE=extended,above160,probe` opens the named `walk` gates (see above) for the
  running firmware (never `farIds`, nothing on an unknown firmware).

## Contributing the editor's definitions file
A firmware the bundled catalog does not describe yet is supported fastest from the official editor's
definitions file for it. With the user's explicit consent, ForgeFX sends that file to Axis Cloud, where only
the maintainer can read it (API: [api-design.md](api-design.md#adr-0003--editor-cache-contribution)).

- **Only what is needed leaves the machine.** Next to the firmware's definitions, the file the editor writes
  for a connected unit holds the owner's own **preset names** and **user cab names**. They are replaced by
  placeholders (every character becomes `_`) before anything is sent, by the codec's redaction, which
  re-checks its own output; ForgeFX checks it once more. Sizes, offsets and every other byte stay as they
  are, so the copy is still a valid definitions file. Only that redacted copy is uploaded, with counts
  (`redaction: { version, tables, names }`), never the names. Residue that remains: name lengths and the
  number of entries.
- **Validated locally first.** The file must carry the editor's own name for the connected model, the
  version in its name must equal the version inside the file (a renamed file is refused), it must parse
  completely, and its rows must agree with the device's bundled catalog (at least half of the comparable
  rows). The firmware that counts is the one read from the device; a file for another firmware needs an
  explicit confirmation and never counts as covering the device's firmware.
- **Who sends it.** A signed-in Axis Cloud account, or, when nobody is signed in, an anonymous upload
  session that ForgeFX creates on first use and keeps next to the account session in the local store. The
  anonymous id is minted by the cloud's auth service; it is not, and is not derived from, the telemetry
  instance id. The same session can delete the upload later; every upload this install made for a firmware
  stays listed (with the session kind that made it) until it is withdrawn, and a withdraw refuses to run
  under a session other than the one that uploaded. A signed-in user whose account session cannot be loaded
  gets an error, never a silent anonymous upload.
- **Asked once per firmware.** The status says whether the cloud still wants a file for the connected
  model and firmware; the user's choice (later / never for this firmware / uploaded / withdrawn) is stored
  locally in the `cacheContributions` collection, keyed like the device caches, without paths or names.
- **Optionally used locally too.** `import: true` also applies the (original, unredacted) file as the
  device profile, exactly like an editor-cache import, when its firmware matches the device's.
- **Dry run.** `dryRun: true` does everything except the cloud writes and answers with the exact request it
  would send (`wouldSend`). Server-wide: `FORGEFX_CONTRIBUTE_DRY_RUN=1`, or
  `FORGEFX_CONTRIBUTE_DRY_RUN_DIR=<dir>`, which also writes `<dir>/<sha256>.cache` (the redacted copy) and
  `<dir>/<sha256>.json` (the request body) so the redaction can be checked by hand. Node server only.

## Shared definitions (cloud)
Users can share the definitions Axis read for their unit, so the same model and firmware is supported for
everyone without an app update (API: [api-design.md](api-design.md#adr-0006--shared-device-definitions-cloud-v2)).

- **The shared store keeps sources.** Each row is one sanitized raw source — an editor-cache import, a full or a
  read-only read of the device — for one model and firmware, identified by a **fact hash** over its content
  (not over who read it, when, or how the read went). Identical shares from different users land on the same
  row and confirm it. Rows of different kinds never compete; within a kind, the tier, then the quality, the
  coverage and the number of confirmations rank them, and among equals the oldest wins — never the newest upload.
- **Tiers.** `official` (confirmed by the maintainer), `verified` (identical facts from at least two contributors
  on two networks, and a complete read), `candidate` (everything else). A tier orders what is offered; it never
  exempts a row from the device check.
- **Pulling checks first.** Before shared rows decide which parameters exist, a sample of them (at most 24) is
  read back from the connected unit with read-only definition queries — no value reads, no label reads, no
  writes — within the same per-block bounds as the read-only definition walk, which come from the bundled
  catalog or a local editor cache, never from cloud data. Rows the catalog lacks or that differ from it are
  checked first. Any difference refuses the pull and nothing is stored; the verdict is remembered per row (the
  `cloudVerdicts` collection) and a failed row is not offered again unless checked again on request. A pull
  that would only add units or display curves to rows the stored definitions already decide needs no check.
  `capabilities.definitions.spotCheck` says whether the unit can be checked. Shared rows from the earlier
  store are checked the same way.
- **Sharing is a deliberate step.** Nothing is shared without the user's consent to the current explanation
  (`consentVersion`). Only this install's own sources are shared (never one that came from the cloud or a
  definitions file, never a single-block probe, never an editor file read with damaged parts). Before sending,
  the codec's sanitizer removes everything that could identify the installation or the moment: no ids, no file
  fingerprint, no user name tables (preset names, user cab names), no free-text notes, the capture time cut to
  the day; the result is validated again in its strict shared form, and exactly that copy is sent. A dry run
  returns the exact requests without sending them.
- **Who shares.** A signed-in account, or an anonymous session of this install that the first share creates —
  its own, separate from the one of the editor-cache contribution, and unrelated to the telemetry id. What this
  install shared is recorded locally in the private `definitionShares` collection (not readable over `/store` or the
  Remote relay; kind, row id, fact hash, session kind
  and a one-way tag of the session, time, consent version; no user ids, paths or names) and can be removed again
  by the session that made it, one share or all — "all" under a signed-in account also removes the shares that
  account made on other computers. A share made under another account, or under an anonymous session this
  install no longer has, stays listed but cannot be removed from here. If the cloud refuses anonymous sharing,
  ForgeFX asks for a sign-in instead of creating an anonymous session. If the definitions changed between the
  preview and the share, nothing is sent. After 180 days the cloud unlinks a share from its sharer; it then stays
  published but can no longer be removed individually.
- **Older clients.** A share that includes a local editor-cache source made under an account also publishes
  that source's derived tables — derived from it alone, without this install's bookkeeping times — to the earlier
  shared store, which older versions read. The preview shows that request too.
