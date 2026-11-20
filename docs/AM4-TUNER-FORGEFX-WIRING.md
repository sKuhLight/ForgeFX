# AM4 Tuner → ForgeFX → Axis wiring plan

Read-only investigation. Concrete, file-referenced plan to surface the AM4 tuner (and,
secondarily, output meters) in Axis, reusing the existing gen-3 tuner path end-to-end.

Codec facts already shipped in `forgefx-midi/am4` (verified upstream, BigCapture
2026-07-05): `AM4_TUNER_PID_LOW` (0x0023), `AM4_TUNER_CHANNEL` {NOTE_INDEX 0x01,
FREQ_HZ 0x02, CENTS 0x03, STRING_BAND 0x04}, `buildReadParam(param, readType)`,
`READ_TYPE_LIVE_POLL` (0x10), `parseReadResponse(bytes).asFloat32()`, `isPollResponse`,
`decodeAm4Tuner({noteIndex,freqHz,cents,stringBand})` → `Am4TunerReading`
{noteIndex, midiNote, noteName, freqHz, cents, stringBand, inTune}. All re-exported from
`forgefx-midi/am4` barrel (`src/am4/index.ts:247-249`).

---

## TL;DR

- **This is ForgeFX-only.** Axis already renders a tuner from an SSE `{type:'tuner'}`
  event, gated by a `caps.tuner` flag, with a matching `POST /tuner` on/off toggle. If
  ForgeFX flips `capabilities.telemetry.tuner = true` on the AM4 driver and emits the same
  `{type:'tuner', freq, note, cents, octave}` event, **Axis needs zero changes** — the
  Tuner button appears, `POST /tuner {on}` starts/stops, and `TunerOverlay.svelte` renders.
- The one real design decision is *where the AM4 tuner is polled*. The gen-3 tuner is
  polled by the **registry telemetry supervisor** (`registryCore.ts`), which hardcodes
  gen-3 frame builders (`buildTunerPoll` etc.). The AM4 poll is a different codec, so the
  cleanest fit is a **driver method on `Am4Driver`** that the supervisor calls generically.
- Meters (secondary): feasible but needs the AM4 normalized-meter codec (dB curve unpinned)
  and would reuse the gen-3 `{type:'meters', out1L..out2R}` SSE event → Axis `editor.levels`.
  Recommend deferring until the dB mapping is calibrated.

---

## 1. Gen-3 tuner path (the template) — end to end

Trace of how an FM3/FM9/III tuner reaches Axis today:

1. **Capability flag** — `drivers/gen3.ts:177`
   `telemetry: { tuner: true, outputMeters: true, cpu: true }` (in the `Gen3Driver`
   constructor). This is the single gate.

2. **Served to Axis** as `caps.tuner` — `drivers/registryCore.ts:365`
   (`tuner: c.telemetry.tuner`) inside the device-status DTO returned by `describe()`/
   `/device`. Axis reads it as `caps?.tuner` (see step 8).

3. **On/off route** — `server/src/app.ts:278`
   `app.post('/tuner', (req) => registry.setTuner(!!req.body?.on))`.

4. **`setTuner(on)`** — `drivers/registryCore.ts:577-593`. Lives on the **registry**, not
   the driver. It:
   - bails `{ ok:false }` if `!d.capabilities.telemetry.tuner` (line 579);
   - on `on`: remembers `#tunerDriver = d`, sends `buildTunerPageOpen(d.modelId)` (fn 0x12
     sub 0x1e — opens the device tuner page), starts a 30 ms one-shot → `#pollTuner`;
   - on `off`: clears the timer, sends `buildTunerPageClose(d.modelId)`.

5. **Poll loop** — `drivers/registryCore.ts:552-575` `#pollTuner()`. Every ~55 ms it
   `dev.request(buildTunerPoll(d.modelId), { timeoutMs:300, quietMs:35, match: fs =>
   fs.some(isTunerResponse) })`, finds the frame with `isTunerResponse`, decodes
   `parseTunerFreqHz(f)` (float32 Hz @ offset 12), and **emits** (line 569):
   ```
   this.#emit({ type:'tuner', freq: round2(freq), ...(freqToNote(freq) ?? {}) })
   ```
   `freqToNote` (`registryCore.ts:110-119`, equal-temperament A4=440) turns Hz →
   `{ note, cents, octave }`. So the tuner event carries `{ freq, note, cents, octave }`.

6. **DeviceEvent DTO** — `drivers/types.ts:64-65`
   `| { type:'tuner'; freq:number; note?:string; cents?:number; octave?:number }`.

7. **Transport to client = SSE.** `GET /events` — `server/src/app.ts:478-488`. It sets
   `content-type: text/event-stream` and `registry.subscribe(e => raw.write('data: '+JSON+
   '\n\n'))`. The event bus is `registryCore.ts:214-231` (`#subscribers`, `subscribe()`,
   `#emit`). A subscriber arriving also starts meters + edit-watch (lines 218-219).

8. **Axis side (all present today):**
   - Client: `Axis/src/lib/forgefx.ts:390` `setTuner`, `:411` `events()` (opens
     `EventSource(${BASE}/events)`).
   - Store: `Axis/src/lib/editor.svelte.ts`
     - `tuner = $state<{active,freq?,note?,cents?,octave?}>({active:false})` (`:219`)
     - SSE opened at `#openEvents` (`:976`), dispatched by `applyDeviceEvent` (`:988`);
       `case 'tuner'` at `:992` copies `freq/note/cents/octave` into `this.tuner`.
     - `hasTuner` getter (`:92`) = `caps?.tuner` (v2) — this is what gates the UI button.
     - `toggleTuner` (`:1718-1724`) flips `tuner.active` and calls `forgefx.setTuner`.
   - UI: `Axis/src/lib/TunerOverlay.svelte` (renders note/cents/needle/freq, in-tune when
     `|cents|<=5`); toggle buttons in `ToolRail.svelte:193-195` and `TopBar.svelte:171-173`,
     both `{#if editor.hasTuner}`.
   - Axis `DeviceEvent` mirror type: `Axis/src/lib/types.ts:421-422` (same shape).

**What `telemetry:{tuner,outputMeters,cpu}` drives:** it is the gate the registry
supervisor and the served caps DTO both read. `tuner` → `#pollTuner`/`setTuner` allowed +
`caps.tuner` true (Axis shows the tuner). `outputMeters` → `#startMeters`/`#pollMeters`
allowed + `caps.meters.outputLevels`. `cpu` → the CPU sub-poll inside `#pollMeters` +
`caps.meters.cpu`. AM4 declares all three `false` (`drivers/am4.ts:188`), so today the
supervisor never fires gen-3 frames at it and Axis hides the tuner (`hasTuner` false).

---

## 2. AM4 driver today — poll loop / supervisor, and where the tuner plugs in

- `Am4Driver` (`drivers/am4.ts:176`) declares
  `telemetry: { tuner:false, outputMeters:false, cpu:false }` (`:188`) and
  `deviceEditWatch:true` (`:194`).
- **Drivers never poll on their own** (registryCore header, `:4`): all timers live in the
  registry. The AM4's only supervisor-driven loop today is the **device-edit watch**:
  `#startEditWatch`/`#pollEditWatch` (`registryCore.ts:673-708`), which — while ≥1 SSE
  client listens and `capabilities.deviceEditWatch` is set — calls the driver's
  `readDeviceEditState()` (`am4.ts:336-358`) every ~1500 ms (10-30 s on a slow link, by telemetry mode).
- Supervisor lifecycle: a subscriber arriving starts meters + edit-watch
  (`registryCore.ts:214-223`); `#activate` re-gates each loop on the new driver's caps
  (`:510-524`) — importantly `:515` stops the tuner timer for a device without
  `telemetry.tuner`.
- The AM4 driver already owns the exact transport plumbing a tuner poll needs:
  `#openTransport()` → `ctx.transport()` (`am4.ts:201`), the `dev.request(frame, {timeoutMs,
  quietMs, match})` pattern (used all over, e.g. `#readStructure` at `:271-273`), and
  `#withReader` serialization (`:224-229`) for calls that must not interleave on the shared
  port. `dev.slow` is available for cadence backoff (Transport iface `transport/types.ts:16`).

**Where the tuner poll plugs in + cadence.** Two viable shapes; recommend **(A)**:

- **(A) recommended — driver method, supervisor drives it generically.** Add a driver
  method `readTuner()` on `Am4Driver` that does four `buildReadParam({pidLow:0x0023,
  pidHigh:ch}, READ_TYPE_LIVE_POLL)` reads (one per channel), `parseReadResponse(f)
  .asFloat32()` each, composes `decodeAm4Tuner({noteIndex,freqHz,cents,stringBand})`, and
  returns the reading. The registry supervisor's `setTuner`/`#pollTuner` then branch: if the
  active driver exposes `readTuner`, call it and emit; otherwise use the existing gen-3
  `buildTunerPoll` path. This keeps AM4 codec knowledge in the AM4 driver (matches the repo's
  "no cross-device `if (isAm4)`" rule — `types.ts:90`) while the *timer* stays in the
  supervisor (matches "drivers never poll on their own").

- **(B) alternative — self-contained in the registry.** Import the AM4 tuner codec into
  `registryCore.ts` and branch inside `#pollTuner`/`setTuner` on `d.modelId === 0x15`. Faster
  to write but bakes AM4 codec knowledge into the shared supervisor and needs the model-byte
  check the codebase otherwise avoids. Not recommended.

**Cadence.** Only poll while a tuner view is active — the gen-3 `setTuner(true)` gate
already gives this (poll timer starts on `on`, stops on `off`). AM4 has no "open tuner page"
command (the tuner block is always live at 0x0023), so `setTuner(true)` for AM4 skips the
`buildTunerPageOpen`/`Close` sends and just starts/stops the timer. Suggested interval:
the four channel reads are tiny 23-byte round-trips; the gen-3 tuner polls at ~55 ms for one
read. Four serial reads per tick → target **~80–120 ms per full tuner update** (a couple
hundred ms on a slow 5-pin link via `dev.slow`). Serialize the four reads behind
`#withReader` so they don't interleave with a concurrent structure/param read on the shared
port. The reads MUST run only while `tuner.active` — never on the general SSE-subscriber
meter cadence — so an AM4 that isn't showing the tuner pays nothing.

---

## 3. Axis tuner UI — does it already render, and can AM4 reuse it unchanged?

**Yes, and yes.** Axis renders a full tuner today for gen-3 and it is entirely
event-shape-driven, not device-specific:

- Component: `Axis/src/lib/TunerOverlay.svelte` — reads `editor.tuner.{note,octave,cents,
  freq,active}`, draws the big note + octave, a cents needle (`-50..+50 → 0..100%`), a
  `freq.toFixed(1) Hz` readout, and a 6-string highlight by `note[0]`. In-tune when
  `|cents| <= 5`.
- Store subscription: `editor.svelte.ts:992` `case 'tuner': this.tuner = {...this.tuner,
  freq, note, cents, octave}`. Exact fields the gen-3 event carries.
- Toggle + gating: `hasTuner` (`:92`), `toggleTuner` (`:1718`), buttons in
  `ToolRail.svelte`/`TopBar.svelte` guarded by `{#if editor.hasTuner}`.

**Data shape the UI expects:** `{ note:string, octave:number, cents:number, freq:number }`
(all optional on the store; `active` is UI-local). The AM4 codec already produces every
field: from `decodeAm4Tuner` you get `noteName` (e.g. `"D#1"`), `cents`, `freqHz`, and
`midiNote`. The one adaptation is in ForgeFX at emit time — the gen-3 event splits note into
`note` (letter, e.g. `"D#"`) + `octave` (integer), whereas AM4's `noteName` is combined
(`"D#1"`). Two clean options, both ForgeFX-only:

- Emit the same split as gen-3: derive `note`/`octave` from `decodeAm4Tuner`'s `midiNote`
  (same math as `freqToNote`, but from the device's own note index rather than re-deriving
  from Hz — more accurate at the octave edges). i.e. `note = NOTE_NAMES[midiNote%12]`,
  `octave = floor(midiNote/12) - 1`. This is the recommended path — **Axis unchanged**.
- Or just reuse `freqToNote(freqHz)` in the supervisor exactly as gen-3 does, feeding it the
  AM4 `freqHz`. Also Axis-unchanged, but throws away the device's own note/cents (which are
  more reliable than re-deriving from Hz, and are already ±50-clamped on the wire).

Recommendation: emit `{ type:'tuner', freq: freqHz, note, octave, cents }` where
`note/octave/cents` come straight from `decodeAm4Tuner` (device-true), not re-derived.
The Axis overlay renders it identically to gen-3. **No Axis change required.**

---

## 4. Meters (secondary) — feasible?

**Feasible, ForgeFX-only for the transport, but needs a codec calibration first.**

- Axis already renders **output levels** from `{type:'meters', out1L,out1R,out2L,out2R}`
  (in **dB**) → `editor.levels` (`editor.svelte.ts:182, :994`), gated by
  `caps.meters.outputLevels` = `telemetry.outputMeters` (`registryCore.ts:369`). The gen-3
  path is the round-robin envelope-follower in `#pollMeters` (`registryCore.ts:612-671`),
  which emits **dB** values on the `-40..+6` scale (`METER_FLOOR/CEIL`, `:547-548`).
- The AM4 main-output meters (`0x002a`, channels `0x0016` L / `0x0017` R per the task) are
  **normalized [0,1]** (the dB curve is *unpinned*). The gen-3 `meters` event and
  `editor.levels` are **dB**, not 0..1. So AM4 cannot feed the existing `meters` event
  cleanly until either (a) the AM4 0..1 → dB mapping is calibrated (then AM4 emits dB on the
  same scale, Axis unchanged), or (b) a normalized-meter event variant is added (an **Axis
  change** — new event field/handling + a 0..1-friendly meter widget).
- There is also a **per-block meter** surface (`d.meters` / `caps.meters.blockMeters`,
  `gen3.ts:822`, Axis `editor.meters`) that is normalized-friendly, but it is keyed by
  placed effectId and is a different concept from a stereo output meter.

**Recommendation:** defer meters. When wanted, the lowest-friction path is: add the AM4
normalized-meter poll codec + a 0..1→dB calibration in `forgefx-midi/am4`, flip
`telemetry.outputMeters = true`, and have the AM4 meter poll emit the existing
`{type:'meters', out1L,out1R,out2L,out2R}` in dB — **Axis unchanged**. Emitting raw 0..1
instead would require an Axis change. Note only; not part of the tuner work.

---

## Concrete implementation checklist (tuner)

All ForgeFX-only unless flagged. No `forgefx-midi` change (codec already shipped).

1. **`ForgeFX/server/src/drivers/am4.ts`**
   - Import from `forgefx-midi/am4`: `buildReadParam`, `READ_TYPE_LIVE_POLL`,
     `parseReadResponse`, `AM4_TUNER_PID_LOW`, `AM4_TUNER_CHANNEL`, `decodeAm4Tuner`
     (`isPollResponse` for the `match`/parse guard).
   - Flip `capabilities.telemetry.tuner = true` (`am4.ts:188`). Leave `outputMeters/cpu`
     false.
   - Add `async readTuner(): Promise<{ freq:number; note:string; octave:number; cents:number } | null>`:
     serialize behind `#withReader`; for each channel in
     `[NOTE_INDEX, FREQ_HZ, CENTS, STRING_BAND]` do
     `dev.request(buildReadParam({pidLow:AM4_TUNER_PID_LOW, pidHigh:ch}, READ_TYPE_LIVE_POLL),
     {timeoutMs:300, quietMs:35, match: fs => fs.some(f => isPollResponse(f) && echoesCh(f))})`,
     then `parseReadResponse(f).asFloat32()`. Compose `decodeAm4Tuner({noteIndex,freqHz,
     cents,stringBand})`. Map its `midiNote` → `{note, octave}` (`NOTE_NAMES[midiNote%12]`,
     `floor(midiNote/12)-1`) and return `{ freq: r.freqHz, note, octave, cents: r.cents }`.
     Return `null` on any read failure (supervisor keeps polling; no UI churn).
   - (Optional micro-opt: the four channels could be read as one bulk read if the AM4 supports
     it, but four short reads mirror AM4-Edit's capture and are safest.)

2. **`ForgeFX/server/src/drivers/types.ts`**
   - Add optional `readTuner?(): Promise<{freq:number; note:string; octave:number;
     cents:number} | null>` to the `DeviceDriver` interface (near the other optional
     capability-gated methods). Keeps the supervisor branch type-safe.

3. **`ForgeFX/server/src/drivers/registryCore.ts`**
   - `setTuner(on)` (`:577`): AM4 has no tuner page to open/close — guard the
     `buildTunerPageOpen`/`buildTunerPageClose` sends so they only fire for a driver without
     `readTuner` (i.e. gen-3). For AM4 just start/stop `#tunerTimer` (still gated by
     `d.capabilities.telemetry.tuner`, which is now true).
   - `#pollTuner` (`:555`): if `this.#tunerDriver.readTuner` exists, call it and
     `this.#emit({ type:'tuner', ...reading })` (already the right shape); else keep the
     existing `buildTunerPoll` gen-3 path. Reuse the same `if (this.#tunerTimer)
     setTimeout(...)` re-arm; consider a slightly longer interval for AM4 (four reads) — e.g.
     `d.readTuner ? 100 : 55` ms, or back off on `dev.slow`.
   - No change to the caps DTO — `tuner: c.telemetry.tuner` (`:365`) auto-flips to true.

4. **Axis — no change required.** `caps.tuner` becomes true → `hasTuner` true → the Tuner
   button appears; `toggleTuner` → `POST /tuner {on}` → supervisor starts polling → SSE
   `{type:'tuner'}` events → `TunerOverlay.svelte` renders. Verify only.

5. **Tests / verify.** `ForgeFX/server/test` has mocked-driver unit tests (no hardware) —
   add an AM4 `readTuner` decode test against a captured 4-frame set, and assert
   `caps.tuner === true` for AM4. Hardware verify: connect AM4, open Tuner in Axis, play a
   string, confirm note/cents/freq track and the poll stops when the overlay closes.

### ForgeFX-only vs Axis-change summary

| Change | Where | Axis change? |
|---|---|---|
| AM4 tuner poll + decode + emit | ForgeFX `am4.ts`, `registryCore.ts`, `types.ts` | No |
| Flip `telemetry.tuner` → caps.tuner | ForgeFX `am4.ts` | No (Axis reads caps) |
| Tuner UI / toggle / SSE handling | Already exists in Axis | No |
| Output meters in **dB** (calibrate 0..1→dB upstream) | ForgeFX + `forgefx-midi/am4` | No |
| Output meters as **raw 0..1** | ForgeFX + new event variant | **Yes** (new meter handling/widget) |
