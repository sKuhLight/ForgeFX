# Layouts & virtual effects

ForgeFX serves two things on top of the raw parameter list, so clients can render a
device-faithful editor without hardcoding a single label or screen:

1. **Editor layouts** — per-family, device-authentic pages/tabs (with control labels and
   positions) attached to a block's parameter response.
2. **Virtual effects** — the device's non-audio editor sections (Setup/global, controllers,
   modifiers, foot controller) read and written through the *same* block endpoints, addressed
   by a reserved effect id.

Both flow from data the device profile carries (per `DeviceProfile`), so the behaviour adapts
to whichever Fractal unit is attached. The layout data itself is **device-authentic editor
layout data derived from the device editor configuration** — pages, control labels, and column
positions as the device organizes them — surfaced as plain JSON.

## The layout shape

Each device supplies a per-family layout map. A family resolves to a layout of pages, and each
page lists its controls in order:

```ts
type DeviceLayout = {
  editorName?: string;                       // the family's editor display name
  pages: {
    name: string;                            // tab/page label
    controls: {
      label: string;                         // control label as shown
      paramName: string;                     // device param name
      paramId: number | null;                // wire paramId (null = label-only / not addressable)
      col?: number;                          // column hint for grid arrangement
    }[];
  }[];
};
```

This is the same shape for every gen-3 device; only the data differs per unit. The profile
exposes it via `layoutFor(family)` (see [`server/src/devices.ts`](../server/src/devices.ts)).

### Page-level controls

The editor places most controls in rows, and some directly on the page: section titles and separators,
but also parameters that appear nowhere else (the Synth's tracking mode, the Graphic EQ's master Q, the
amp's EQ type and location, the Looper's trims). A page carries those in an optional `pageControls` array,
next to its `rows`:

```jsonc
{
  "name": "Voice 1",
  "rows": [ /* … */ ],
  "pageControls": [                           // absent when the page has none
    { "label": "Tracking\nMode", "paramName": "SYNTH_PD_RANGE", "paramId": 41,
      "widget": "dropdown", "rawWidget": "dropdown1Tight",
      "placement": { "positionExact": "196,230" }, "fw": { "gtet": "11,01" } }
  ]
}
```

The entries have the shape of a row control, in editor order, and get the same treatment: a control an
`lt` firmware bound hides on the newest firmware is not served, a `gtet`-gated one is, with its gate in
`fw`. Titles, separators and other decorative entries (`paramName: null`) are included as the editor has
them; a client may ignore them, or the whole array. A page can have `pageControls` and empty `rows`.
`paramId` is also `null` for a parameter that belongs to another block's family: `paramName` still names
it, but it is not addressable on this block. A few entries are editor actions whose `paramId` is a pseudo
id without a live value (the EQ's "Zero All" button), as some row buttons are.

## Layouts on the parameter response

`GET /preset/blocks/:eid/params` returns the block's live, named parameter values and now also
carries the family's editor layout:

```jsonc
{
  "block": "Amp",
  "slug": "amp",
  "page": 58,
  "named": [ /* knob params with live values */ ],
  "enums": [ /* discrete selectors */ ],
  "type":  { "value": 3, "name": "…" },
  "layout": {                                 // ← editor-authentic pages for this family
    "editorName": "Amp",
    "pages": [
      { "name": "…", "controls": [ { "label": "…", "paramName": "…", "paramId": 0, "col": 0 } ] }
    ]
  }
}
```

`layout` is **optional**: it is present when the active device profile has a layout for the
block's family, and omitted otherwise. The `named`/`enums` arrays remain the source of truth for
live values — `layout` only describes *how* a client may arrange and label them. A client that
ignores `layout` still gets a fully functional flat parameter list.

## Virtual effects

The device's non-audio editor sections sit on the same `(effectId, paramId)` parameter path as
audio blocks, so ForgeFX exposes them through the **same endpoints** — there is no separate API.
They are addressed by a reserved effect id:

| Effect id | Family | What it is |
|-----------|--------|------------|
| `1` | `GLOBAL` | Setup / device-global configuration |
| `2` | `CONTROLLERS` | Controllers |
| `3` | `MOD` | Modifier |
| `199` | `FC` | Foot Controller (FC) |

So **"Setup" is just the block editor pointed at effect id `1`.** `blockParams(eid)` resolves an
audio block's family via the codec, and a virtual effect's family via the profile's
`familyForEffectId(eid)` map, then attaches that family's layout the same way. Reads return the
GLOBAL/controllers/etc. params with live values plus the matching editor pages; writes go through
the ordinary param/`PUT` path.

> Confirmed live on the **FM3**: `GET /preset/blocks/1/params` returns the GLOBAL params and the
> Setup pages with real device values.

### Examples

```sh
# Read Setup (GLOBAL) — params + the Setup editor pages, with live values
curl localhost:5056/preset/blocks/1/params

# Read the controllers / modifier / foot-controller sections
curl localhost:5056/preset/blocks/2/params      # Controllers
curl localhost:5056/preset/blocks/3/params      # Modifier
curl localhost:5056/preset/blocks/199/params    # Foot Controller (FC)

# Set a GLOBAL parameter (param id 4 here) — same write endpoint as any audio block
curl -X PUT localhost:5056/preset/blocks/1/params/4 \
  -H 'content-type: application/json' \
  -d '{ "value": 0.5, "continuous": true }'
```

Discrete (enum) writes send the ordinal with `"continuous": false`, exactly as for audio blocks.

## Multi-device

Layouts and the virtual-effect map are per device, supplied by the `DeviceProfile`:

| Device | Layouts | Virtual effect ids |
|--------|---------|--------------------|
| FM3 | `FM3_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |
| FM9 | `FM9_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |
| Axe-Fx III | `AXE3_LAYOUTS` | gen-3 shared (`1`/`2`/`3`/`199`) |

ForgeFX auto-detects the attached unit and selects its profile, so the served layouts and the
virtual-effect resolution match the connected device with no client changes. The three gen-3
units share the virtual effect ids; each ships its own family layouts.

See also [Devices & families](devices.md) for how a device profile is selected.
