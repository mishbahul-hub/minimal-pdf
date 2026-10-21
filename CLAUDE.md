# CLAUDE.md

Minimalist, keyboard-first desktop PDF reader built with **Tauri 2 + vanilla TypeScript + PDF.js**.
The page is the whole interface. Targets: opens instantly, stays out of the way, installer under ~10 MB.

**Current stage: 3 (Keyboard shortcuts).** Stages 0–2 done. Update this line when a stage's "done when" check passes.

## Design principles (do not violate)

- **The page is the UI.** No toolbar by default; controls (search bar, go-to box, sidebar, help) appear only on demand and close with `Esc`.
- **Keyboard first, mouse friendly.** Every feature must be reachable from the keyboard.
- **Render only what is visible.** Never render all pages of a large PDF up front (after Stage 1).
- **Never modify the user's PDF.** Only read it. All app data goes in the settings store (or sidecar JSON for future notes).
- **No frontend framework.** Plain TypeScript and DOM APIs. Don't add React/Vue/etc. or UI libraries.
- Keep dependencies minimal. Ask before adding any new npm package or Rust crate.

## Tech stack

| Layer | Choice |
|-------|--------|
| App shell | Tauri 2 (Rust), system WebView (WebView2 on Windows) |
| Frontend | Vanilla TypeScript + Vite |
| PDF engine | `pdfjs-dist` |
| File picker | `@tauri-apps/plugin-dialog` |
| File reading | `@tauri-apps/plugin-fs` |
| Settings | `@tauri-apps/plugin-store` (`settings.json`) |
| Styling | Plain CSS with variables; themes via `data-theme` (light, dark, sepia) |

## Commands

```bash
npm install              # install JS deps
npm run tauri dev        # run the app with hot reload
npm run tauri build      # build installers (MSI + NSIS on Windows)
npm run tauri add <plugin>   # add a Tauri plugin (dialog, fs, store, single-instance)
npm run tauri icon icon.png  # generate app icons (Stage 6)
npx tsc --noEmit         # type-check
```

Initial scaffold (Stage 0): `npm create tauri-app@latest` → TypeScript, npm, Vanilla template.
Then `npm install pdfjs-dist` and `npm run tauri add dialog`, `fs`, `store`.

## Project structure

```
src/
  main.ts        app start, wiring
  viewer.ts      load PDF, render pages, lazy rendering, zoom
  keys.ts        single keymap object (key -> function), help overlay source
  settings.ts    store: theme, per-file positions, recent files
  search.ts      text search + highlights
  outline.ts     table of contents sidebar
  styles.css
  vite-env.d.ts  Vite client types (needed for CSS and `?url` imports under TS 6)
index.html
src-tauri/
  tauri.conf.json
  capabilities/default.json   plugin permissions
  src/lib.rs
```

Keep each concern in its own module as above. Don't create new top-level modules without a reason.

## Implementation notes and gotchas

- **PDF.js worker under Vite** must use the `?url` import, set once at startup:
  ```ts
  import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  ```
- **Load PDFs from bytes**: read with `readFile(path)` from plugin-fs, then `getDocument({ data })`. `viewer.ts` splits this into `openPdf()` (dialog + read) and `openBytes(data, name)` so loading can be tested without the native dialog.
- **PDF.js v6 API**: `page.render({ canvas, viewport, transform })` (not `canvasContext`); `destroy()` exists only on the loading task, so keep the task to free a document.
- **Page centering**: use `margin: 0 auto` on `.page`, not `align-items: center` on the scroller, or pages wider than the window get clipped on the left.
- **High-DPI rendering**: canvas pixel size = viewport × `devicePixelRatio`; CSS size = unscaled viewport; pass `transform: [dpr,0,0,dpr,0,0]` to `page.render`.
- **Tauri permissions**: any new plugin API call needs a matching permission in `src-tauri/capabilities/default.json`. Current set: `dialog:allow-open`, `fs:allow-read-file`, `store:default`, `core:window:allow-set-title`, `core:window:allow-set-fullscreen`. If an API call fails silently or with a permission error, check this file first. No static fs scope is needed: the dialog plugin adds each file the user picks to the fs scope at runtime. Paths that didn't come from the dialog (e.g. recent files in Stage 4, launch args in Stage 6) will need a scope.
- **Rust on this machine**: if `cargo` isn't found in a shell, prepend `%USERPROFILE%\.cargo\bin` to PATH (or restart VS Code). First `tauri dev` build takes ~3 min; later runs are cached.
- **Lazy rendering (Stage 2)**: one placeholder `<div>` per page sized from `getViewport()`; `IntersectionObserver` with ~1 screen margin; keep ~10 rendered canvases and free the rest; cancel in-flight renders with `renderTask.cancel()` on leave/zoom.
- **Zoom**: steps 50/75/100/125/150/200/300%. 100% = real paper size (`PixelsPerInch.PDF_TO_CSS_UNITS`, 96/72). Default mode is fit-width. A zoom resizes the page boxes instantly (old canvases stretch to fill), then re-renders sharp after ~150 ms; this replaces the plan's CSS-transform idea. Always preserve the anchor (page + fraction under the mouse or screen centre). Fit width/page use the current page's size and the `#pages` padding (`FIT_PADDING`). Re-fit on resize in fit modes. Ctrl+wheel: a notch (|deltaY| ≥ 50) = one step, smaller deltas (trackpad pinch) zoom smoothly. WebView2's own zoom is off (`zoomHotkeysEnabled` defaults to false); `overflow-anchor: none` on `#pages` so the browser doesn't fight the zoom anchoring.
- **viewer.ts exports for Stage 3 keys**: `zoomIn`, `zoomOut`, `resetZoom`, `toggleFit`, `setZoom`, `getZoom`, `getCurrentPage`, `getPageCount`.
- **Keyboard**: all shortcuts in one keymap object in `keys.ts`. Ignore shortcuts while focus is in an input. `g g` uses a ~500 ms sequence timeout. The `?` help overlay is generated from the keymap; never hand-maintain a separate list.
- **Themes**: colours as CSS variables on `:root`. Dark page filter: `invert(1) hue-rotate(180deg)`; sepia: `sepia(0.35) brightness(0.95)`. First launch follows `prefers-color-scheme`, then persists the user's choice.
- **Positions**: per file (keyed by path, optionally + file size): `{ page, offset (0–1), zoom, opened }`. Save debounced ~500 ms on scroll and on window close. On open, restore zoom first, then scroll. Keep last 10 recent files for the start screen.
- **Search (Stage 5)**: cache `page.getTextContent()` per page; search page by page in the background with progress; cancel previous search on query change; case-insensitive, whitespace/line-break tolerant; highlight with `<mark>` in the text layer. Scanned PDFs → show "No searchable text in this PDF".
- **Outline (Stage 5)**: `pdf.getOutline()`; resolve string dests via `getDestination()` then `getPageIndex(ref) + 1`. No outline → fall back to a page list.
- **Errors**: corrupt/renamed and password-protected files must show a clear message, never crash.

## Keymap

| Key | Action |
|-----|--------|
| Ctrl+O | Open file |
| j / k, ↓ / ↑ | Scroll down / up a little |
| Space / Shift+Space | Next / previous screen |
| n / p, → / ← | Next / previous page |
| g g / G | First / last page |
| Ctrl+G | Go to page |
| + / − / 0 | Zoom in / out / reset to 100% |
| w | Toggle fit width / fit page |
| f, F11 | Fullscreen |
| d | Cycle theme |
| / | Search (Enter / Shift+Enter or n / N for next / prev match) |
| t | Table of contents |
| ? | Shortcut help |
| Esc | Close any overlay |

## Stages and "done when" checks

Work one stage at a time. Each stage must end with a working app. Commit after each stage passes.

0. **Setup**: `npm run tauri dev` opens a blank window and hot-reloads.
1. **Open & render**: Ctrl+O opens a PDF; 20-page PDF opens in < 1 s; text sharp at 100% and 150% display scaling; file name in window title.
2. **Scroll & zoom**: 500-page PDF scrolls smoothly with stable memory; zoom 100→200% keeps the same paragraph on screen. (Optional: text layer for selection.)
3. **Shortcuts**: open, navigate, zoom and fullscreen with keyboard only; typing in the go-to box doesn't trigger shortcuts.
4. **Themes & position**: close on page 87 at 150%, reopen → page 87 at 150%; theme survives restart.
5. **Search & TOC**: common word in a 300-page textbook shows first hit in < 1 s; sidebar jumps to the right chapter.
6. **Ship**: icons, `.pdf` file association (`bundle.fileAssociations`), launch-path handling via `std::env::args`, single-instance plugin, installer built and size checked.

Stretch goals (only after v1): password prompt (`onPassword`), Ctrl+P recent-file switcher, sidecar highlights/notes, two-page spread, vim marks, auto-reload on file change.

## Testing

Manually verify against this set of PDFs before calling a stage done (keep them in a local `test-pdfs/` folder, git-ignored):

- 500+ page textbook: lazy rendering, memory, scroll speed
- Scanned images-only PDF: "No searchable text" message
- PDF with bookmarks / without bookmarks: TOC and fallback list
- Password-protected PDF: clear error (or prompt)
- Mixed page sizes (A4 + landscape): placeholders, fit width, position restore
- Corrupt or renamed file: error message, no crash

Always run `npx tsc --noEmit` after changes, and run the app to confirm behaviour when a change affects rendering or input.

## Working agreements for Claude

- Before starting a stage, propose a short plan; implement in small steps.
- Don't jump ahead to later stages' features unless asked.
- Platform is Windows; shell commands should work in PowerShell or Git Bash.
- Don't commit unless asked; when committing, use clear messages per stage/feature.
