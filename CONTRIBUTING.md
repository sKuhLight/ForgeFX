# Contributing to ForgeFX

Thanks for your interest! ForgeFX is an open HTTP API + device server for Fractal devices.
Contributions — new device support, parameter/enum data, bug fixes, docs — are welcome.

## Prerequisites

- **Node 20** (`>=20 <21`) and npm.
- The server code lives in **`server/`** — a Fastify + TypeScript app run with the `tsx` runner.
- For live testing: a Fractal FM3 (or FM9 / Axe-Fx III / AM4) on USB. Most logic runs against
  mocks and needs **no hardware** — only the live `/preset/*`, `/device`, and `/debug/*` endpoints
  touch the serial/MIDI port.

## Setup

ForgeFX consumes the [`forgefx-midi`](https://github.com/sKuhLight/forgefx-midi) codec as a sibling
checkout (`file:../../forgefx-midi`), so that repo **must be checked out next to this one and built
first** — its exports resolve to `dist/`:

```sh
cd ../forgefx-midi && npm install && npm run build
cd server && npm install
```

## Build, test, run

Everything runs in **`server/`**:

```sh
npm run dev         # http://localhost:5056 (tsx watch, hot-reload; owns the serial port)
npm run typecheck   # tsc --noEmit
npm test            # fully mocked — NO hardware needed
# or: npm run build && npm start
```

The dev server **owns the serial port** — close FM3-Edit / any bridge first. On Linux the device
may enumerate as `ttyACM0` or `ttyACM1`; the auto-detected `/dev/serial/by-id/...` path is stable.

## Layering — where does a change go?

```
Axis (UI)  ──HTTP /api──▶  ForgeFX (this repo: device logic + HTTP)  ──▶  forgefx-midi (protocol)
```

- **Protocol facts** (SysEx frames, opcodes, enum vocabularies, address models, block/param
  tables) go **upstream in `forgefx-midi`**, guarded by its golden tests — never hand-edited here.
- **ForgeFX** = device-interaction logic + the HTTP surface. It calls the codec's builders/parsers.
- **Rendering / UX** belongs in **Axis**, which talks only to this API.

## Branches & PRs

- `main` is protected — no direct commits. Work on `feature/<x>` or `fix/<x>` branches.
- Open a PR and get CI green; CI checks out both repos side by side and builds the codec first.
- Commits: `sKuhLight <sKuhLight@users.noreply.github.com>`, messages `<scope>: <imperative>`.

## Releases

Releasing is zero-touch: **merging a PR to `main` releases automatically.** The merged PR's
`release:*` label picks the bump (default **patch**; `release:none` merges without releasing;
docs/`.github`/`*.md`-only PRs auto-skip). **Versions come from tags** — NEVER bump
`server/package.json` in a PR. Full detail: [docs/RELEASING.md](docs/RELEASING.md).

## Notes

- **Pin wire behaviour with tests.** Anything decoded from the device should have a vector or
  fixture test upstream so we don't regress against firmware quirks.
- **Cite hardware claims.** When you mark something device-verified, say on which model + firmware.
- This is an independent, third-party project — see [DISCLAIMER.md](DISCLAIMER.md).
