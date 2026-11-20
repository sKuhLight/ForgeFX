# Preset & routing-grid codec

How ForgeFX turns a live preset dump into the real routing grid. This is the gen-3 Fractal
format (Axe-Fx III `0x10`, FM3 `0x11`, FM9 `0x12`); the envelope is shared across the family
and only the model byte and grid dimensions differ. Implemented in
`src/ForgeFX.Core/Fm3PresetCodec.cs`.

## The pipeline

```
device (fn 0x03 request)
   → 0x77 header  +  N × 0x78 chunk  +  0x79 footer       (SysEx dump)
   → reassemble chunk bodies                              (3 wire bytes → 1 uint16)
   → 16384-byte raw_patch                                 (word0 = version, word1 = 0xAA55)
   → Huffman-decompress the patch body
   → grid table @ 0x104                                   (placement + routing)
```

### 1. Dump framing

A preset is exported as one `0x77` header frame, a run of `0x78` chunk frames, and a `0x79`
footer. Frame lengths are family-constant; the **chunk count** varies (FM3/FM9 = 8 chunks,
Axe-Fx III = 16). Each frame is the usual Fractal envelope
`F0 00 01 74 <model> <func> <payload> <checksum> F7` with the XOR-`0x7F` checksum.

### 2. Chunk reassembly (3-byte septets → uint16)

Each `0x78` payload is a 2-byte discriminator followed by 1024 `uint16`s, each packed into
**three 7-bit wire bytes**:

```
value = b0 | (b1 << 7) | (b2 << 14)      // 16-bit, little-endian
```

Concatenating all chunks yields a fixed **16384-byte `raw_patch`** image: word 0 is the
format version (`0x0143` on FM3), word 1 is the `0xAA55` magic, and the preset name is ASCII
at byte `0x08`.

### 3. raw_patch header + Huffman body

| Offset | Field |
|--------|-------|
| `0x04` | CRC-16/CCITT (poly `0x1021`, init `0xAA55`), computed over the patch with this field zeroed |
| `0x08` | 32-byte ASCII preset name |
| `0x48` | decompressed body size (u16) |
| `0x4A` | compressed body size (u16) |
| `0x4C` | dynamic-Huffman bitstream |

The body is **dynamic-Huffman compressed**. The tree is serialized as a prefix: bit `1` = a
leaf followed by an 8-bit symbol; bit `0` = an internal node followed by its left then right
subtrees. Decoding then walks the tree MSB-first (a `1` goes right, a `0` goes left) until a
leaf, emitting `decompSize` bytes.

> The CRC is only valid for a **saved** preset. The live edit buffer is not re-CRC'd until you
> save on the device, so an edited-but-unsaved buffer reports `crcValid: false` — the grid
> still decodes correctly (the decode does not depend on the CRC).

> An **unused preset slot** reads back as a normal full-length dump whose `raw_patch` is entirely
> zero (stored CRC 0, no name, no code tree). There is nothing to decompress, so it is reported as
> an empty preset: `empty: true`, blank name, no grid/scenes/blocks, `crcValid: false`. An all-zero
> dump is not a restorable preset, so exporting it (`POST /preset/backup`) or using it as a
> conversion source is refused with HTTP 422, and the local Presets folder scan skips it.

### 4. The grid

In the decompressed body, the grid table starts at offset `0x104`. It is **column-major**,
two `uint16`s per cell:

```
cell = (effect_id, route_flag)
```

- `effect_id == 0` → empty cell.
- `effect_id  > 1000` → a **shunt** (a cabling/pass-through cell), id `effect_id - 1023`.
- otherwise → a placed block. The id resolves to a family + instance: each family has a base
  id (e.g. Amp = 58, Cab = 62, Filter = 114, Drive = 118) and instances 1..4 are
  `base .. base+3` (so `119` = "Drive 2").
- `route_flag` is an **input bitmask**: bit `r` set means this cell is fed from row `r` of the
  *previous* column. That mask is the cabling — it's what makes parallel branches and merges
  (a cell fed from two rows) explicit.

FM3 is a 4×12 grid; FM9 and the Axe-Fx III are 6×14.

ForgeFX exposes the decoded grid at `GET /preset/grid` (and `GET /presets/{n}/grid`), with each
cell's `effectId`, `name`, `isShunt`, `routeFlag`, and the decoded `fromRows`.

## Provenance & credits

This format knowledge comes from two open-source projects, and ForgeFX's codec is an
**independent C# reimplementation** of the format they document (not a copy of their code):

- [mcp-midi-control](https://github.com/TheAndrewStaker/mcp-midi-control) (Apache-2.0) —
  `packages/fractal-gen3` implements the dump framing, the Huffman body, the CRC, and the grid
  layout in TypeScript.
- **fractal-syx-codec** by Andrew Mercurio / BoodieTraps (Apache-2.0) — the published
  `FORMAT.md` those decoders are built from.

Attribution is retained in [`../NOTICE`](../NOTICE) per Apache-2.0. The decoder is regression-
tested against real FM3 preset dumps in `tests/ForgeFX.Core.Tests/Fm3PresetCodecTests.cs`.
