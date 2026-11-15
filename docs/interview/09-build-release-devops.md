# 09 · Build, release and DevOps

## Build

| Command | What it does |
|---|---|
| `npm run tauri dev` | Vite dev server (hot reload) + a debug Rust build that loads from `localhost:1420` |
| `npm run tauri build` | Production frontend bundle + optimised Rust build + installers |
| `npx tsc --noEmit` | Type-check only |

Release profile in `Cargo.toml`: `opt-level = 3`, `lto = true` (link-time optimisation),
`codegen-units = 1`, `panic = "abort"`, `strip = true`. These trade build time for a smaller, faster
binary.

**Outputs:** NSIS installer ~3 MB, MSI ~4 MB, app exe ~8.5 MB.

**Why so small?** No bundled browser (WebView2 ships with Windows), no Node runtime, no UI framework,
a stripped and LTO-optimised Rust binary, and ML runtime/models downloaded on demand instead of
bundled.

## Desktop integration

- **File association:** `bundle.fileAssociations` registers `.pdf` ("Open with Minimal PDF").
- **Launch file:** `lib.rs` reads the first existing `.pdf` argument (relative paths resolved against
  the working directory), allows it in the fs scope, and hands it to the UI via `take_launch_file`.
- **Single instance:** the single-instance plugin (registered first, order matters) forwards a second
  launch's file to the running window as an `open-file` event and focuses it.
- **Window:** starts hidden; Rust shrinks it to fit the monitor's work area if needed, centres it,
  then shows it (no flash of a wrongly sized window).

## Release pipeline (GitHub Actions)

`.github/workflows/release.yml`, triggered by pushing a tag like `v0.2.1`:

1. Windows runner: checkout, Node 22, Rust stable, Rust build cache.
2. `npm ci` (exact versions from the lock file).
3. `tauri-apps/tauri-action`: builds, signs with `TAURI_SIGNING_PRIVATE_KEY` (repo secret), creates a
   **draft** GitHub Release with the installers, `.sig` files and `latest.json`.
4. A human reviews the draft and presses **Publish**, a manual gate before users get the update.

**Releasing a new version:** bump the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` (and the lock files), commit, tag `vX.Y.Z`, push the tag, publish the draft.

## Auto-update flow

1. Release build starts → after 5 s, `update.ts` checks
   `releases/latest/download/latest.json`.
2. If a newer version exists: download, verify the signature, prompt "Install and restart".
3. Nothing installs without the user's click.

## A real release story (v0.2.0 → v0.2.1)

The first build (v0.2.0) finished, but before publishing it I found the Gemini 3 tool-calling bug
while taking screenshots. Instead of shipping a known bug, I left the v0.2.0 draft unpublished,
fixed the bug, bumped to 0.2.1 (including lock files, because `npm ci` fails if `package-lock.json`
doesn't match), rebuilt, and published 0.2.1 as the first public release. Lesson: the draft-then-
publish gate is useful.

## Versioning

**Semantic versioning** (MAJOR.MINOR.PATCH): 0.2.0 → 0.2.1 is a patch (bug fix). The 0.x major
version signals "not yet 1.0", so the API/behaviour may still change.

## Git practice

- Work in stages (0–6), each with a "done when" check and its own commit.
- Clear commit messages per feature ("Fix Gemini 3 tool calls: send back the thought signature").
- Generated/large/private files ignored (`test-pdfs/`, build output).
