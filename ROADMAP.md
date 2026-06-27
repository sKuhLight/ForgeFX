# ForgeFX Roadmap

High-level map of where ForgeFX is headed. Granular work lives in
[GitHub Issues](https://github.com/sKuhLight/ForgeFX/issues) (filter by the **epic** label);
this file is the at-a-glance view. Each item links to its tracking issue.

## ✅ Shipped

- Live preset **routing-grid decode** (placement + cabling) — gen-3 codec
- **Named REST API** + OpenAPI 3.1 + Scalar explorer (`/scalar`)
- **Auto-detecting** serial port (stable by-id, self-healing)
- Preset **backup / restore** (`.syx`)
- Block/parameter **catalog** (`/blocks/...`)
- **Docker** image + Compose (multi-arch) and CI

## 🎚 Editing core

- [ ] Write path: verify set param / bypass / channel / save on hardware — [#4](https://github.com/sKuhLight/ForgeFX/issues/4)
- [ ] Block channels A–D editing — [#5](https://github.com/sKuhLight/ForgeFX/issues/5)
- [ ] Scenes & scene leveling — [#6](https://github.com/sKuhLight/ForgeFX/issues/6)
- [ ] Modifiers & controllers — [#7](https://github.com/sKuhLight/ForgeFX/issues/7)
- [ ] Wah / expression / external control — [#9](https://github.com/sKuhLight/ForgeFX/issues/9)

## 🎛 Performance & control

- [ ] FC / foot controller (+ per-preset FC) — [#8](https://github.com/sKuhLight/ForgeFX/issues/8)
- [ ] Tuner + live streams (WebSocket) — [#10](https://github.com/sKuhLight/ForgeFX/issues/10)
- [ ] Tempo & metronome — [#11](https://github.com/sKuhLight/ForgeFX/issues/11)

## ⚙️ Device configuration

- [ ] Setup / global settings screen — [#12](https://github.com/sKuhLight/ForgeFX/issues/12)
- [ ] MIDI setup — [#13](https://github.com/sKuhLight/ForgeFX/issues/13)
- [ ] Cab / IR / DynaCab management — [#15](https://github.com/sKuhLight/ForgeFX/issues/15)

## 📚 Library & presets

- [ ] Block library (save/recall block settings) — [#14](https://github.com/sKuhLight/ForgeFX/issues/14)
- [ ] Preset management (rename/copy/init/banks/setlists) — [#16](https://github.com/sKuhLight/ForgeFX/issues/16)

## 🔤 Catalog & UX

- [ ] Amp/Drive/Cab real-world names (wiki-sourced) — backend done — [#3](https://github.com/sKuhLight/ForgeFX/issues/3)
- [ ] Parameter metadata completion (units/ranges/enums) — [#17](https://github.com/sKuhLight/ForgeFX/issues/17)

## 🧩 Platform

- [ ] Multi-device: FM9 / Axe-Fx III — [#18](https://github.com/sKuhLight/ForgeFX/issues/18)

## 🖥 Frontend (Axis)

The web UI lives in its own repo: **[sKuhLight/Axis](https://github.com/sKuhLight/Axis)** (it
consumes this API). UI epics are tracked there:

- [ ] Editor screens — block editor, setup, FC, library, tuner — [Axis#1](https://github.com/sKuhLight/Axis/issues/1)
- [ ] Real-world names toggle — [Axis#2](https://github.com/sKuhLight/Axis/issues/2)

---

Want something prioritized or have a request? Open an issue (backend → ForgeFX, UI → Axis).
