# 04 · The reader engine (rendering, zoom, search)

Source: `src/viewer.ts`, `src/search.ts`, `src/outline.ts`, `src/keys.ts`, `src/settings.ts`.

## PDF.js basics

PDF.js (by Mozilla, used in Firefox) parses PDFs in a **Web Worker** and draws pages onto a
`<canvas>`. Key objects:

- `getDocument({ data })` → a loading task → a `PDFDocumentProxy` (the document).
- `doc.getPage(n)` → a `PDFPageProxy`.
- `page.getViewport({ scale })` → size and the transform from PDF units to pixels.
- `page.render({ canvas, viewport, transform })` → a `RenderTask` that can be `cancel()`ed.
- `page.getTextContent()` → the text items (strings with positions), used for selection and search.

Units: PDF uses **points** (1/72 inch). CSS uses 96 px per inch, so 100% zoom = real paper size
uses the factor 96/72 (`PixelsPerInch.PDF_TO_CSS_UNITS`).

## Lazy rendering (the main performance idea)

**Problem:** rendering all pages of a 500-page PDF up front takes seconds and gigabytes of memory
(each canvas at high DPI can be ~10–30 MB).

**Solution:**
1. On open, create one empty placeholder `<div>` per page, sized from that page's viewport. The
   scrollbar and page positions are correct instantly, without rendering anything.
2. An `IntersectionObserver` with `rootMargin: "100% 0px"` (about one screen above and below) reports
   which placeholders are near the viewport.
3. Visible pages are rendered, at most **2 at a time** (`MAX_CONCURRENT`), so scrolling stays smooth.
4. At most **10 canvases** (`MAX_RENDERED`) are kept; the ones furthest from the view are freed
   (canvas width/height set to 0 releases GPU/bitmap memory).
5. When a page leaves the view before its render finishes, its `RenderTask` is **cancelled**.

**Result:** memory and work depend on the screen size, not the document size.

**Why `IntersectionObserver` and not a scroll listener?** The browser computes intersections
efficiently off the main thread and only calls back on changes; a scroll handler fires dozens of
times per second and needs manual geometry maths (`getBoundingClientRect` forces layout).

## Sharp text on high-DPI screens

On a 150% display, `devicePixelRatio` is 1.5. If the canvas has the same pixel size as its CSS size,
the browser upscales it and text looks blurry. So:

- canvas pixel size = viewport size × `devicePixelRatio`
- canvas CSS size = viewport size
- render with `transform: [dpr, 0, 0, dpr, 0, 0]`

## Zoom that keeps your place

Zoom steps: 50, 75, 100, 125, 150, 200, 300% (min 25%, max 500%). Modes: fit width (default), fit
page, custom.

**Anchor preservation:** before zooming, record which page is under the focus point (the mouse, or
the screen centre) and the fraction down/across that page. After resizing all placeholders, set the
scroll position so the same fraction of the same page is under the same point. That's why the
paragraph you were reading doesn't jump.

**Two-phase zoom for responsiveness:**
1. Instantly resize the page boxes; existing canvases stretch with CSS (slightly blurry but immediate).
2. After **150 ms** without further zoom changes (`SETTLE_MS`), cancel stale renders and re-render
   the visible pages sharply.

This is **debouncing**: the expensive work happens once, after the user stops.

Ctrl + mouse wheel: a notch (|deltaY| ≥ 50) = one zoom step; small deltas (trackpad pinch) zoom
smoothly with `zoom × e^(−deltaY × 0.01)`. The WebView's own zoom is disabled so it doesn't fight.

A detail: `overflow-anchor: none` on the scroller stops Chromium's "scroll anchoring" feature from
also adjusting the scroll position, which would fight the custom anchoring.

## Text layer (selection)

PDF.js `TextLayer` places transparent, absolutely positioned `<span>`s over the canvas, one per text
item, so the user can select and copy text. It's built once per rendered page and scaled with a CSS
variable (`--total-scale-factor`) on zoom, so zooming never rebuilds it.

## Search

- Each page's text is **normalised** (lower case, runs of whitespace → one space; items ending a line
  are joined with a space, others directly) and cached, with a map from each normalised character
  back to (text item, character offset).
- A query is normalised the same way and found with `indexOf`; phrases split across lines still match.
- Searching starts at the current page and wraps; it jumps to the first hit immediately while
  continuing in the background; a new query cancels the old one (a `searchId` counter).
- Highlights are `<mark>` elements inserted into the text-layer spans, re-applied whenever a page
  renders (`pagerender` event), because pages are rendered lazily.
- Scanned PDFs (no text) show "No searchable text in this PDF".

## Table of contents

Built lazily on first `t` from `doc.getOutline()`. PDF destinations come in two forms: named
destinations (strings, resolved with `getDestination`) and explicit ones (a page reference resolved
with `getPageIndex`). No outline → a plain list of pages. Arrow keys / `j` `k` / Enter navigate it.

## Keyboard system

- `KEYMAP` in `keys.ts` is a list of `{ keys, label, help, action }`. It drives both key handling and
  the `?` help overlay (one source of truth).
- Key names are normalised (`Ctrl+o`, `G`, `Shift+Space`); sequences like `g g` use a 500 ms timeout.
- Shortcuts are ignored while typing in an input; bindings ignore key auto-repeat unless marked.
- `Esc` closes the top overlay (a stack in `overlays.ts`), otherwise leaves fullscreen.

## Remembering positions

Per file (keyed by path, ignored if the file size changed): page, offset within the page (0–1),
zoom, zoom mode. Saved debounced (500 ms) on scroll/zoom and on window close. On open, zoom is
restored first, then the scroll position (order matters: position depends on page sizes).

## Themes

Colours are CSS variables on `:root`, overridden per `data-theme` (light, dark, sepia). Dark mode
inverts only the page **canvas** (`invert(1) hue-rotate(180deg)`, which keeps hues roughly right), so
annotations keep their real colours. The choice is mirrored to `localStorage` so it applies before
the settings store finishes loading (no white flash on start).

## Error handling

Corrupt or renamed files and password-protected PDFs show a clear message; the app never crashes.
