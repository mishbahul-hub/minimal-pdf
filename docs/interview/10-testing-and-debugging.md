# 10 · Testing and debugging

## Strategy

The project has no unit-test framework; it's tested end to end against the **real running app**,
plus a type checker and a benchmark harness. Be upfront about this in interviews and explain why,
and what you'd add.

| Layer | How |
|---|---|
| Types | `npx tsc --noEmit` after every change (TypeScript strict) |
| Behaviour | Drive the running app through the **Chrome DevTools Protocol** (CDP) |
| AI without real APIs | A mock server; debug builds read `MINIMALPDF_AI_BASE_URL` and `MINIMALPDF_AI_KEY` |
| Translation quality | The FLORES-101 harness (BLEU/chrF) |
| Manual checklist | A fixed set of tricky PDFs (below) before each stage/release |

## Driving the app over the DevTools protocol

WebView2 is Chromium, so it can expose the DevTools protocol:

1. Launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
2. Connect a WebSocket to the page target listed at `http://127.0.0.1:9222/json`.
3. Use:
   - `Runtime.evaluate` → run code inside the app, e.g. `import("/src/viewer.ts")` then
     `openBytes(pdf, name)`, `goToPage(19)`, `getZoom()`.
   - `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` → real input events (right-click to open
     the radial menu, drag to draw a highlight).
   - `Page.captureScreenshot` → screenshots (the README screenshots were made this way).
   - `Emulation.setDeviceMetricsOverride` → a fixed window size for consistent screenshots.

**Gotcha:** after hot reloads, Vite serves modules with `?t=` timestamps; importing `/src/viewer.ts`
plainly gives a *second* module instance with empty state. The harness imports exactly the URLs the
app loaded (found via `performance.getEntriesByType("resource")`).

This is the same idea as Playwright/Puppeteer, applied to a desktop app.

## Mock AI server

Debug builds send every provider to `{MINIMALPDF_AI_BASE_URL}/v1/...` with a fake key, so tests
never touch real APIs or the real credential store. The mock streams both formats, including tool
calls split across chunks, a Gemini-style variant (no `index`, `finish_reason: "stop"`), and a
"no tools" mode that returns 400 (to test the simple-RAG fallback). Release builds ignore these
variables.

## Manual test set (`test-pdfs/`, not in git)

- 500+ page textbook → lazy rendering, memory, scroll speed
- Scanned image-only PDF → "No searchable text"
- With / without bookmarks → contents sidebar and its fallback page list
- Password-protected → clear message
- Mixed page sizes (A4 + landscape) → placeholders, fit width, position restore
- Corrupt or renamed file → error message, no crash

## Real bugs and how they were found

| Bug | How found | Root cause | Fix |
|---|---|---|---|
| Chat with Gemini 3 stopped after the first search | Taking README screenshots with a real key | Gemini 3 requires its `thought_signature` echoed back on tool calls | Keep `extra_content` on the tool_use block, send it back |
| App closed during long translation runs | Running the FLORES evaluation | ~4 GB per model, WASM memory never shrinks | One model per worker, idle termination, greedy decoding, WebGPU; resumable harness |
| Zoom "jumped" away from the paragraph | Manual testing | The browser's own scroll anchoring fought custom anchoring | `overflow-anchor: none` |
| Save options vanished when moving the mouse to them | User report | The radial closed as the pointer left the ring | Keep the save choices pinned while the pointer travels to them |
| Two save buttons overlapped | User report | Fixed positions collided | Stack the choices above the ring, with room reserved at the top edge |
| Text blurry on 150% displays | Stage 1 check | Canvas pixel size = CSS size | Scale canvas by `devicePixelRatio` |
| Wide pages clipped on the left | Testing landscape PDFs | `align-items: center` on the scroller | `margin: 0 auto` on each page |

## What I'd add next

- **Unit tests** (Vitest) for pure logic: search normalisation and scoring, the message-format
  translation in `llm.ts`, the SSE parser in Rust (`cargo test`), BLEU/chrF against sacreBLEU outputs.
- **Automated E2E** in CI: the CDP harness turned into tests with the mock AI server.
- **Performance regression checks:** time-to-first-page and memory on the 500-page PDF.
