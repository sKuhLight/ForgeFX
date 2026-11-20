# Write protocol (gen-3)

How ForgeFX writes to the device: parameter edits, bypass/channel, grid editing,
preset switch/store. Implemented in `Fm3Device` (pure body builders + send/verify) and
exposed by the server's write endpoints. Frames are the gen-3 family ops; the FM3 shapes
below are byte-confirmed against FM3-Edit captures (via the mcp-midi-control codec — see
`NOTICE`). Everything is little-endian 7-bit; the envelope is the usual
`F0 00 01 74 11 <fn> <body> <cksum> F7`.

## Ops

| Write | Wire | Body |
|-------|------|------|
| Set param (knob) | fn `0x01` sub `0x52 00` | `eid14 pid14 float32(normalized 0..1) 00 00 00 00` |
| Set param (model/type) | fn `0x01` sub `0x09 00` | `eid14 pid14 float32(ordinal) 00 00 00 00` |
| Bypass | fn `0x0A` | `eid14 dd` (dd: 1=bypassed) |
| Channel | fn `0x0B` | `eid14 ch` (0..3 = A..D) |
| Place/clear block | fn `0x01` sub `0x32` | `blockId14 00 00 gridPos14 …` · `gridPos=(col-1)*rows+(row-1)`, FM3 rows=4 · blockId 0 clears |
| Cable | fn `0x01` sub `0x35` | FM3 4-row: `b21=srcGp>>1`, `b22=((srcGp&1)<<6)\|srcCol`, `b23=(destRow-1)<<5` · `srcGp=(srcCol-1)*4+(srcRow-1)` |
| Switch preset | fn `0x01` sub `0x27` | `preset14 @ pos 6` |
| Store preset | fn `0x01` sub `0x26` | `preset14 @ pos 6` |

`eid` = effect id (the block's base id + instance-1). `pid` = parameter index. The value is a
5-septet float32 — for a knob it's the normalized 0..1 value; for a model/type select it's the
roster ordinal as a float.

## Accept / reject model

The device sends **nothing on accept** (except store — see Safety). On rejection it returns a `0x64`
MULTIPURPOSE_RESPONSE whose 2-byte body is `[echoedFn, resultCode]`. `Fm3Device.SendWrite` sends a frame and watches a
short window for a `0x64` rejection of the function it sent; no rejection ⇒ accepted. Result
codes (`DescribeResultCode`) include `0x05` invalid effect id, `0x06` invalid param id, `0x0b`
bad grid position, `0x0c` DSP overload, etc.

## Safety

- **`?dryRun=true`** on any write endpoint returns the exact frame hex **without sending** —
  use it to preview/verify before touching the device.
- **`--writes false`** starts the server read-only; every write endpoint then returns `403`.
- **Store is beta.** `POST /preset/store` is flagged beta. The device's acknowledgement of a store is
  verified on this project's own FM3 (USB, firmware 12.0 and later; measured on 12.0 and 13.0 — see below)
  but not yet on the FM9 or Axe-Fx III, where a missing ack is reported as a warning (sent, but unconfirmed) and the store should be
  confirmed on the device. ForgeFX never auto-saves during navigation.
- **Store waits for the device's own acknowledgement.** Unlike the other writes, the device answers a store
  with a frame that repeats the request's envelope (fn `0x01`, sub `0x26`) but is not byte-identical to it.
  The ack carries no slot, so a late ack from an earlier store cannot be told apart from this one's.
  On this project's own FM3 it arrives about 0.8–0.9 s after the request on fw 12.0 and about 1.25–1.35 s on
  fw 13.0. `POST /preset/store` waits for it, and what a *missing* ack means depends on a per-model
  evidence level (`storeAck` in the gen-3 driver): `verified` or `unknown`. The FM3 is `verified` only where
  that was measured: a fast (USB) link and firmware 12.0 and later (measured on 12.0 and 13.0), as read
  by the server when it detected the unit. That reading is cleared whenever the unit is re-detected or the
  connection is reopened, and stays empty if the read fails. On a slow (5-pin DIN) link, on older firmware,
  or while the firmware is unknown, the FM3 is `unknown`; so are the FM9 and the Axe-Fx III, until a store
  is confirmed on our own unit of that model. Outcomes (HTTP 200 on every one; `reason` is additive and
  tells a refusal from an unknown outcome without parsing text):

  | outcome | `ok` | `acked` | `reason` | `error` / `warning` |
  |---|---|---|---|---|
  | ack seen | `true` | `true` | absent | none |
  | fn-`0x01` refusal (`0x64`) seen in the store window, no ack followed; any level | `false` | `false` | `rejected` | `error` with the result code |
  | no ack in time, `verified` | `false` | `false` | `no-ack` | `error` — the slot may or may not have been written |
  | no ack in time, `unknown` | `true` | `false` | `no-ack` | `warning` — sent, but unconfirmed |

  The wait is capped and ends the instant the ack arrives, so the cap only costs time when none comes:
  `verified` 6 s (about 4.4x the slowest FM3 ack measured), `unknown` 2.5 s. On a slow link the caps are
  8 s / 6 s; those were not measured, and 8 s stays under the client's 12 s request ceiling (which includes
  queue time). A frame byte-identical to the request (MIDI thru / loopback) never counts as the ack.
  `rejected` is attributed by function only: the `0x64` body carries no sub-action, so a late refusal of a
  preceding fn-`0x01` write can be attributed to the store.
  `POST /version/:id/restore` reports the same verdict for its commit step, including `acked` and `reason`
  when the driver reports them.

## Confidence

Set param (continuous + typed), bypass, switch-preset, and the FM3 4-row cable formula are
FM3-hardware-confirmed (per the source captures). Grid block placement (sub `0x32`) is
spec/capture-derived but **not yet confirmed on this project's FM3** — treat it as beta and
verify with `dryRun` + a single live test first. Store (sub `0x26`): the device's acknowledgement
is confirmed on this project's FM3 (USB, firmware 12.0 and later; measured on 12.0 and 13.0); on the FM9
and Axe-Fx III treat it as beta.
Tracked in
[#4](https://github.com/sKuhLight/ForgeFX/issues/4).
