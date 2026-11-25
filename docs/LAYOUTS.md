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

Each device supplies a per-family layout map. A family's layout holds one or more **variants** (one per
block type, or per firmware version), each with its pages; the server serves ONE variant, resolved for the
block's current state (see *How a layout is resolved*). Each page lists its rows of controls in order:

```ts
type DeviceLayout = {
  editorName: string;                        // the family's editor display name
  family: string;                            // catalog family symbol
  variantName: string;                       // the chosen variant (a block type, a firmware version)
  variantValue: string | null;               // the selector value(s) that choose it, comma-joined; null = unconditional
  fw?: { gtet?: string; lt?: string };       // the chosen variant's firmware gate, when it has one
  pinned?: boolean;                          // the variant pinned to the current firmware (amp block)
  pages: {
    name: string;                            // tab/page label
    rows: {
      section: 'parameters' | 'mixer';
      controls: {
        label: string;                       // control label as shown
        paramName: string | null;            // device param name (null: decorative)
        paramId: number | null;              // wire paramId (null = label-only / not addressable)
        widget: string;                      // knob, toggle, slider, dropdown, button, meter, …
        rawWidget: string;                   // the editor's own widget type
        placement?: { col?: number; offsetX?: number; offsetY?: number; positionExact?: string };
        crossBlock?: { effect: string; family: string | null; paramName: string | null; paramId: number | null; effectId?: number | null };
        fw?: { gtet?: string; lt?: string }; // the control's own firmware gate
      }[];
    }[];
  }[];
};
```

This is the same shape for every gen-3 device; only the data differs per unit. The profile
exposes it via `layoutFor(family, …)` (see [`server/src/devices.ts`](../server/src/devices.ts)).

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
    "editorName": "Amp", "family": "DISTORT", "variantName": "…", "variantValue": null,
    "pages": [
      { "name": "…", "rows": [ { "section": "parameters", "controls": [
        { "label": "…", "paramName": "…", "paramId": 0, "widget": "knob", "rawWidget": "…" } ] } ] }
    ]
  }
}
```

`layout` is **optional**: it is present when the active device profile has a layout for the
block's family, and omitted otherwise. The `named`/`enums` arrays remain the source of truth for
live values — `layout` only describes *how* a client may arrange and label them. A client that
ignores `layout` still gets a fully functional flat parameter list.

The generic response (`?generic=1`) binds the controls to the params the connected device serves
(`boundParamId`, `movedFrom`, `unbound`) and gives every control that addresses another block the
effect id to write it to (`crossBlock.effectId`, `null` = display only); see
[api-design.md](api-design.md#adr-0002--generic-block-params-generic1). The classic response serves the
resolved layout as it is.

## How a layout is resolved

Variants, pages and single controls can carry **firmware gates**: `gtet` (from that firmware on), `lt`
(below it), both (the range in between); versions are written `"maj,min"`. Pages can also be keyed by a
**selector** param (`selectorParamName` + `value`). Both responses, classic and generic, resolve a layout the
same way:

1. **Firmware.** Gates are evaluated against the connected unit's firmware, as the server read it when it
   detected the unit — the last version this unit reported in the session: a later firmware read the unit does
   not answer leaves the running firmware unknown but keeps the layouts on that version (a disconnect, a port
   change or another model forgets it). When no read ever answered, against the newest firmware: every `gtet`
   gate holds and no `lt` gate does, so pages and variants only older firmware shows are not served (a page
   gated by `lt` alone included).
2. **Eligible variants.** A variant takes part when its own gate holds and the gate of at least one of its
   pages does. A variant whose pages are all legacy pages is not eligible even without a gate of its own (the
   shipped layouts have none since the codec gives an editor catch-all page to every type no sibling page
   names). When no variant is eligible on a known firmware, the newest firmware decides (for the variant and
   its pages).
3. **The key.** A variant that names a `selectorParamName` was generated from a page-level selector (the
   Delay's routing type `DELAY_TYPE`, which is not its model selector `DELAY_MODEL`; the Reverb's
   `REVERB_BASETYPE`, which is not its type `REVERB_TYPE`): such variants are chosen by that selector's current
   ordinal — decoded for a selector served as an enum, read from the block body for any other one (the device
   stores `REVERB_BASETYPE`, a `count` dial, as its index: raw 6 is base type 6, and raw 9 / 10 are base types
   9 / 10 even though the catalog row stops at 8 — only a reading too large to be an index is unscaled), never a
   dial's display value; an unknown value picks the default variant. Otherwise the key is the block's type value (or, for a
   family without a type selector, its variant selector, e.g. the cab's mode), as before. The variants whose
   value list holds the key win; else the unconditional ones (value `null`); else every eligible one.
4. **Firmware siblings.** Among the winners, variants that differ only by firmware gate collapse to the one for
   the firmware: on the newest firmware the highest `gtet` (else the ungated ones), on a known firmware the most
   specific gate that holds (the highest `gtet`, then the lowest `lt`). So a family's legacy and current variant
   of the same type (the MultiDelay's pairs) keep the one for the connected firmware, the current one on the
   newest. Then the pinned variant wins, else the first in editor order.
5. **Pages and controls.** Pages whose gate does not hold are dropped; the rest group by name, each group keeps
   the page(s) matching the current selector value (a page with an empty value list is the group's default) and
   then the one for the firmware, like variants. Controls whose own gate does not hold are dropped.

**Behaviour change, also in the classic response.** Layouts used to be resolved for the newest firmware only,
with a page gated by `lt` alone kept, and every variant keyed by the block type. With the connected firmware
deciding the gates and folded variants keyed by their own selector, the served pages differ for some blocks:
an older unit gets the pages its firmware shows, the Delay's pages follow its routing type, and legacy-only
pages are no longer served on the newest firmware. The AM4 resolves its layouts for the newest firmware.

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
