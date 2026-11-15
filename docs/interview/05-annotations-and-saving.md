# 05 · Annotations and saving

Source: `src/annotate.ts`, `src/radial.ts`, `src/export.ts`.

## The radial menu

Right-click (or `a`) opens a ring around the cursor: the **inner ring** has the tools (pointer, pen,
pencil, highlighter, eraser, rectangle, ellipse, text), the **outer ring** shows colours and three
sizes for the hovered tool, plus a custom colour picker. Number keys `1`–`8` pick tools, `9` opens
the AI. At the bottom: save and settings buttons.

**Why a radial menu?** Fitts's law: targets arranged around the cursor are all the same short
distance away, so they're fast to hit, and nothing is on screen until you ask. It respects the "no
toolbar" principle.

When text is selected, the ring also shows the AI actions (Explain, Simplify, Define, Translate,
Summarize, Ask).

## How annotations are drawn

- Each rendered page gets an `<svg class="ink">` layer over the canvas, with `viewBox` = the page
  size in **page units** (CSS px at zoom 1).
- Annotations are stored in page units, so the SVG scales with zoom **for free**; no recalculation.
- Pen/pencil/highlighter are SVG paths; shapes are rect/ellipse; comments are SVG `<text>`.
- Pointer events: a stroke only accepts moves from the pointer that started it (no stray input
  from a second finger or pen).
- Shift constrains to straight lines / squares / circles.
- The ink layer uses `mix-blend-mode: multiply` (and `screen` in dark mode) so highlighter colour
  looks like real highlighter on paper and black ink stays visible on inverted dark pages.

## Undo / redo

Every change is an operation `{ added: Item[], removed: Item[] }`:

- Draw a stroke → `{ added: [stroke] }`
- Erase → `{ removed: [stroke] }`
- Edit a comment → `{ removed: [old], added: [new] }`

Undo applies the inverse (remove the added, re-add the removed at their original index); redo
re-applies. This is the **command pattern**, with operations as data. It's simpler than storing
snapshots and uses little memory.

## Storage

Annotations are saved per file as `notes-<fnv1a(path)>.json` in the app data folder (via the Tauri
store plugin), keyed by page number. The PDF is never touched. The same file stores cached AI
summaries for that PDF.

## Saving annotations into a PDF (export.ts)

Three options from the radial menu's save button:

| Option | Shortcut | How |
|---|---|---|
| New PDF with annotations | `Ctrl+S` | Copy the PDF bytes, draw each annotation with pdf-lib, save to a new file |
| Plain copy | `Ctrl+Shift+S` | Write the original bytes |
| Replace original | | Ask for confirmation, write the annotated bytes over the open file, clear the stored annotations (or they'd appear twice), reopen and restore the position |

### The coordinate problem (a good interview topic)

Screen/SVG coordinates have their origin at the **top-left with y going down**. PDF coordinates have
the origin at the **bottom-left with y going up**, and pages can have a **crop box** offset and a
**rotation** (90/180/270°). Doing this maths by hand is error-prone.

**Solution:** use PDF.js's own viewport: `viewport.convertToPdfPoint(x, y)` converts a point in page
units to PDF user-space, handling crop box and rotation. Then:

- ink and shapes → `page.drawSvgPath(d, …)`; pdf-lib's `drawSvgPath` flips y, so the code passes `-y`
  to land on the right point; multiply blend; highlighter at 0.5 opacity
- comments → real text in the PDF standard fonts (Helvetica, Times, Courier, Helvetica-Oblique)

### The font problem

The 14 standard PDF fonts only cover Latin characters (WinAnsi encoding). A comment in Hindi,
Bengali or Arabic can't be encoded. **Solution:** detect when the font can't encode the text, render
that comment to a canvas at 3× resolution, and embed it as a PNG image at the right position. It
looks the same and avoids embedding large Unicode fonts (which would bloat the app and the PDF).

### Safety

- Saving a copy over the open file is refused (the original would be lost mid-read).
- Replace original always asks first (dialog plugin `ask`), matching the rule "never modify the
  user's PDF without an explicit, confirmed request".

## Interview angle

- "How do you keep annotations aligned when zooming?" → page-unit coordinates + SVG `viewBox`.
- "How did you implement undo?" → command pattern with `{added, removed}` operations.
- "What was tricky about exporting?" → coordinate systems (y-flip, crop box, rotation) and fonts for
  non-Latin scripts.
