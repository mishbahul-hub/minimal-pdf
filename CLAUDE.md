# CLAUDE.md

Minimalist, keyboard-first desktop PDF reader built with **Tauri 2 + vanilla TypeScript + PDF.js**.
The page is the whole interface. Targets: opens instantly, stays out of the way, installer under ~10 MB.

**Current stage: 6 (Polish, test and ship).** Stages 0–5 and annotations done. Update this line when a stage's "done when" check passes.

## Design principles (do not violate)

- **The page is the UI.** No toolbar, ever: controls (search bar, go-to box, sidebar, help, the right-click radial menu) appear only on demand and close with `Esc`. Annotation tools live only in the radial menu (right-click or `a`), never in a top bar.
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
  keys.ts        single keymap (KEYMAP: keys, label, help, action) + key dispatch; help overlay source
  overlays.ts    on-demand overlays (go-to box, ? help) + registerOverlay/unregisterOverlay; Esc closes the most recent one (search bar and TOC register here too)
  settings.ts    store: theme, per-file positions, recent files
  search.ts      text search + highlights
  outline.ts     table of contents sidebar
  annotate.ts    annotation tools (pen, pencil, highlighter, eraser, rect, ellipse, text comments), SVG layers, undo/redo, per-file notes store
  radial.ts      right-click radial menu: tools on the inner ring, colours/sizes on the outer ring (the only annotation UI)
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
- **Tauri permissions**: any new plugin API call needs a matching permission in `src-tauri/capabilities/default.json`. Current set: `dialog:allow-open`, `fs:allow-read-file`, `store:default`, `core:window:allow-set-title`, `core:window:allow-set-fullscreen`, `core:window:allow-destroy` (needed by `onCloseRequested`). If an API call fails silently or with a permission error, check this file first. No static fs scope is needed: the dialog plugin adds each file the user picks to the fs scope at runtime. Paths that didn't come from the dialog need allowing in Rust: recent files go through the `allow_recent` command (only paths already in the saved recent list), launch args (Stage 6) are allowed in `lib.rs`.
- **Rust on this machine**: if `cargo` isn't found in a shell, prepend `%USERPROFILE%\.cargo\bin` to PATH (or restart VS Code). First `tauri dev` build takes ~3 min; later runs are cached.
- **Lazy rendering (Stage 2)**: one placeholder `<div>` per page sized from `getViewport()`; `IntersectionObserver` with ~1 screen margin; keep ~10 rendered canvases and free the rest; cancel in-flight renders with `renderTask.cancel()` on leave/zoom.
- **Zoom**: steps 50/75/100/125/150/200/300%. 100% = real paper size (`PixelsPerInch.PDF_TO_CSS_UNITS`, 96/72). Default mode is fit-width. A zoom resizes the page boxes instantly (old canvases stretch to fill), then re-renders sharp after ~150 ms; this replaces the plan's CSS-transform idea. Always preserve the anchor (page + fraction under the mouse or screen centre). Fit width/page use the current page's size and the `#pages` padding (`FIT_PADDING`). Re-fit on resize in fit modes. Ctrl+wheel: a notch (|deltaY| ≥ 50) = one step, smaller deltas (trackpad pinch) zoom smoothly. WebView2's own zoom is off (`zoomHotkeysEnabled` defaults to false); `overflow-anchor: none` on `#pages` so the browser doesn't fight the zoom anchoring.
- **viewer.ts exports for Stage 3 keys**: `zoomIn`, `zoomOut`, `resetZoom`, `toggleFit`, `setZoom`, `getZoom`, `getCurrentPage`, `getPageCount`.
- **Keyboard**: all shortcuts in `KEYMAP` in `keys.ts`. Key names come from `keyName()`: `Ctrl+o`, `j`, `G`, `?`, `Space`, `Shift+Space`, `ArrowDown`; Shift is only spelled out for non-printable keys; a space separates sequences (`g g`, 500 ms timeout). Ignore shortcuts while focus is in an input; inputs handle their own Enter/Esc explicitly (don't rely on implicit form submission). Bindings without `repeat: true` ignore key auto-repeat. Esc closes the top overlay, otherwise leaves fullscreen. The `?` help overlay is generated from the keymap; never hand-maintain a separate list. Stage 4/5 keys (`d`, `/`, `t`) get added to `KEYMAP` when their features land.
- **Navigation**: next/previous page are relative to the page at the top edge of the view (not the centre-based current page); `goToPage` aligns the page top with `FIT_PADDING` of space.
- **Window**: starts hidden (`visible: false`); `lib.rs` shrinks it to the monitor work area if the 900×1100 default doesn't fit, centres it, then shows it.
- **Testing in the running app**: launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and drive it over the DevTools protocol (`Runtime.evaluate` with `import("/src/viewer.ts")`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`). Don't use the window during a run; real input skews results.
- **Themes**: colours as CSS variables on `:root`, overridden per `:root[data-theme=…]`. The page filter (`--page-filter`: dark `invert(1) hue-rotate(180deg)`, sepia `sepia(0.35) brightness(0.95)`) applies to the canvas only, so annotations keep their real colours. First launch follows `prefers-color-scheme`, then persists the user's choice (store + a localStorage mirror so it applies before the store loads).
- **viewer events**: `viewer.events` (EventTarget) emits `open` (DocInfo), `close`, `pagechange`, `scroll`, `pagerender`, `pagefree`, `openfailed`. Feature modules (settings, search, outline, annotations) listen instead of being called from viewer.ts.
- **Positions**: per file, keyed by path, ignored if the file size changed: `{ page, offset (0–1), zoom, mode, opened, size }`. Save debounced 500 ms on scroll/zoom and on window close (`onCloseRequested`). On open, `setPosition` restores zoom first, then scrolls. Last 10 recent files on the start screen; keys 1–9 open them; a missing file is removed with a clear message.
- **Text layer**: built once per rendered page with `pdfjs.TextLayer` (viewport at render time) and freed with the canvas. It scales through `--total-scale-factor` on `#pages` (set in `applySizes`), so zooming never rebuilds it. `textDivs[i]` corresponds to the i-th text item that has a `str` (marked-content items are skipped by both PDF.js and the search index).
- **Search**: `search.ts` caches a normalised index per page (lower case, whitespace runs → one space, items with `hasEOL` joined by a space, others joined directly) with maps back to (item, char). Searches start at the current page and wrap, jump to the first hit immediately, keep matches in document order, cancel via `searchId`. Highlights are `<mark>` elements inside text-layer spans, applied on `pagerender`. Typing the same query again + Enter = next match. Scanned PDFs → "No searchable text in this PDF".
- **Outline**: `outline.ts` builds the tree lazily on first `t`; resolves string dests via `getDestination()`, explicit dests via `getPageIndex(ref) + 1` (or a numeric page index). Arrow keys / j k / Home End / Enter inside the tree, with `stopPropagation` so global shortcuts don't also fire. No outline → plain page list.
- **Tests and saved positions**: the app restores each file's last position, including files opened by tests with `openBytes(data, name)` (key = name). Tests must navigate explicitly (e.g. `goToPage(1)`) rather than assume a file opens at page 1.
- **Errors**: corrupt/renamed and password-protected files must show a clear message, never crash.
- **Annotations**: stored per file in the app data folder as `notes-<fnv1a(path)>.json` (plugin-store), keyed by page; never written into the PDF. Coordinates are page units (CSS px at zoom 1); each page gets an `svg.ink` with `viewBox` = page size, so ink scales with zoom for free. The ink layer shares `--page-filter` and blends (`multiply`, `screen` in dark) so black ink stays visible on dark pages. A stroke only accepts moves from the pointer that started it. Text comments are SVG `<text>` (hanging baseline, 1.25 line height); editing uses an on-page textarea + a small font/size/colour bar, sized with `--zoom`. Undo/redo ops are `{ added, removed }` item lists (an edit = remove + add). Tool styles persist in settings (`annotationStyles`); the active tool resets to pointer on launch. Right-click anywhere except text fields never shows the browser menu.
- **Dev server hygiene**: stopping a background `tauri dev` can leave Vite on port 1420; kill leftover `node … vite` processes for this project before relaunching, or the new run fails with "Port 1420 is already in use". Modules served after edits carry `?t=` timestamps: tests must import the same URLs the app loaded (see `performance.getEntriesByType("resource")`), or they get a second module instance.

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
| a / right-click | Annotation tools (radial menu); inside it 1–8 pick a tool |
| Ctrl+Z / Ctrl+Y | Undo / redo annotation |
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
