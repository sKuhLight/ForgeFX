# Releasing ForgeFX

ForgeFX is **stage 2** of the cross-repo release chain:

```
forgefx-midi  →  ForgeFX  →  Axis  →  axisapp.live
```

Releases are **zero-touch**: after a PR merges to `main` with green CI, the version is computed
from the last tag, a tag is pushed, the image is built and validated, and the draft is published
automatically — which fires the ripple to Axis. There are no manual version bumps, tags, or
publishes in the normal case.

Release builds pin the sibling codec ref via `stack.lock.json`; CI keeps tracking the codec's
default-branch HEAD (latest-against-latest integration testing). Only tag builds pin.

## Normal flow (nothing to do but merge)

1. **Open a PR** against `main`. Optionally add a `release:*` label (default is `patch`):
   - `release:patch` — bug fixes / internal changes (default).
   - `release:minor` — new features.
   - `release:major` — breaking wire/API changes.
   - `release:none` — merge without cutting a release (changes ride the next release).
   - `release:hold` — merge but pause the release (release it later via workflow_dispatch).
   - Docs/CI-only PRs (everything under `docs/`, `.github/`, or `*.md`) auto-classify as `none`.
   - `release:hold` / `release:none` win over a co-present bump label; `pr-labels.yml` fails only
     when more than one *bump* label (`release:patch`/`minor`/`major`) is present.
2. **Merge the PR.** `release-on-main.yml` runs after CI is green on `main`:
   - reads the merged PR's label → computes the next `vX.Y.Z-beta` from the last tag →
     pushes the tag with `STACK_DISPATCH_TOKEN` (a `GITHUB_TOKEN`-pushed tag would not trigger
     `release.yml`).
3. The tag fires **`release.yml`**:
   - `gate` — full test suite (codec build + server typecheck/test/build) against the **pinned**
     codec ref, with the tag version injected into `server/package.json`;
   - `docker` — multi-arch image (amd64 + arm64) staged from the pinned codec, pushed to GHCR as
     **`:tag` only**;
   - `release` — a **draft** release stamped with the shipped stack + a `release-manifest.json`
     asset (schemaVersion 1, channel `beta`, upstream codec pin, chainId);
   - `validate-and-publish` — asserts the GHCR image lists both `linux/amd64` and `linux/arm64`,
     then `gh release edit --draft=false` (publish) and moves **`:latest`** to the published tag.
4. **Publishing** fires `release-published.yml` → `server-released` dispatch (with `chain_id` and
   `manifest`) → Axis opens its stack-bump PR pinning this server release + the codec ref it
   shipped against.

The draft exists only briefly (race-avoidance); `:latest` moves **only after** the image is
validated, so an unvalidated image is never `:latest`.

## Codec pin adoption (`codec-bump.yml`)

When forgefx-midi publishes, `codec-released` opens/updates ONE PR on the stable branch
`bump/forgefx-midi` (labels `bot/stack-sync` + `release:patch`) bumping `stack.lock.json →
forgefx-midi.ref`. It **auto-merges once required checks pass** — which then auto-releases ForgeFX
(the pin adoption ships).

- **Adopt the pin WITHOUT releasing:** add the `release:none` label to the pin PR **before it
  merges** (the pin then rides the next release).
- **Hold it:** add `release:hold`, or set `RELEASE_AUTOMATION_ENABLED=false`.
- Auto-merge requires `STACK_DISPATCH_TOKEN`; without it the PR stays open for a manual merge.

## Manual recovery (workflow_dispatch)

- **`release-on-main`** — inputs `version` (exact, no leading `v`; empty = auto) and `dry_run`
  (compute + print only). Use to re-drive a stalled release or cut a specific version.
- **`codec-bump`** — input `ref` (codec tag/SHA; empty = codec default HEAD) to re-pin.
- Re-running `release.yml` is safe **only while the release is still a DRAFT**: the tag-driven build
  is idempotent (asset re-upload overwrites). Never re-run a published release's workflow — cut the
  next version instead.

## Emergency stop & rollback

- **`RELEASE_AUTOMATION_ENABLED=false`** (repo Actions variable) halts `release-on-main`, pin-PR
  auto-merge, and auto-publish (drafts are left unpublished).
- **`release:hold`** does the same per-PR.
- Published artifacts and tags are never mutated. Rollback = publish the next fixed version, or
  re-point `:latest` to a known-good digest (`docker buildx imagetools create -t ...:latest
  ...:vX.Y.Z-beta`), or delete a bad release **only if it was never published**.
- Every automated stage that fails creates/updates a single `release-failure` issue keyed by the
  chainId (`ForgeFX@vX.Y.Z-beta`) — that is the notification.

## Secrets & variables

- **`STACK_DISPATCH_TOKEN`** — PAT with `repo` scope on `sKuhLight/ForgeFX` + `sKuhLight/Axis`.
  Used to push tags (`release-on-main`), enable pin-PR auto-merge (`codec-bump`), and dispatch
  `server-released` to Axis (`release-published`). Soft-gated everywhere: unset → that hop is
  skipped with a notice (never a red X).
- **`GITHUB_TOKEN`** — GHCR push/inspect/retag and release publishing.
- **`RELEASE_AUTOMATION_ENABLED`** — Actions variable; unset = automation on, `false` = halted.

## What changed vs. the old flow

- **No `version-guard`** — feature PRs never bump `server/package.json`; the version is injected
  from the tag at build time in every job that builds or reports it.
- **No `notify-axis` on main pushes** — axisapp.live now deploys from Axis releases, not ForgeFX
  main pushes (the `stack-updated` dispatch is retired).
- **No manual tag / publish** — `release-on-main` tags; `validate-and-publish` publishes.
