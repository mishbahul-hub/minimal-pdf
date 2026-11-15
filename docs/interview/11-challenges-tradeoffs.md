# 11 · Challenges and trade-offs (STAR stories)

Use the **STAR** format: **S**ituation, **T**ask, **A**ction, **R**esult. Practise saying each in
about 90 seconds. End with what you learned.

---

## Story 1: Making a 500-page PDF scroll smoothly

- **Situation:** The first version (Stage 1) rendered every page on open. A 500-page textbook took
  seconds to open and used gigabytes of memory.
- **Task:** Make memory and speed independent of document length.
- **Action:** Replaced eager rendering with placeholders sized from each page's viewport (so the
  scrollbar is right immediately), an `IntersectionObserver` with a one-screen margin to decide what
  to render, a cap of 10 live canvases (freeing the furthest), 2 concurrent renders, and cancellation
  of in-flight renders for pages that scroll away or when zoom changes.
- **Result:** Large PDFs open instantly and scroll smoothly with stable memory.
- **Learned:** Do work proportional to what the user sees; let the browser's observers do geometry.

---

## Story 2: Zoom that doesn't lose your place

- **Situation:** Zooming re-rendered everything and the paragraph you were reading jumped away.
- **Task:** Zoom must feel instant and keep the point under the cursor fixed.
- **Action:** Recorded the page and the fraction across/down it under the focus point, resized all
  page boxes, then restored the scroll so the same spot sits under the cursor. Showed stretched old
  canvases instantly and re-rendered sharply after 150 ms of no zoom changes. Found that Chromium's
  scroll anchoring fought this and turned it off with `overflow-anchor: none`.
- **Result:** Smooth Ctrl+wheel and pinch zoom; the paragraph stays put.
- **Learned:** Separate the cheap visual response from the expensive correct render (debounce).

---

## Story 3: One AI layer, six providers

- **Situation:** The AI started Claude-only. Users wanted free keys (Gemini, Groq, Hugging Face,
  OpenRouter) and local models (Ollama).
- **Task:** Support all of them without rewriting the agent loop for each.
- **Action:** Kept one internal conversation format (Anthropic content blocks) and wrote two adapters:
  Anthropic Messages and OpenAI-compatible Chat Completions. The adapter translates tool calls,
  tool results and schemas, and parses each streaming format. Handled quirks: Gemini omits tool-call
  `index`; some providers report `stop` when they called a tool; Gemini rejects some JSON Schema
  keywords; reasoning models emit `<think>` tags. Added a "Load models" button because model names
  change, and a simple-RAG fallback for models without tool support.
- **Result:** Any of seven provider options works with the same features; switching is a setting.
- **Learned:** The adapter pattern + one canonical internal format keeps complexity in one file.

---

## Story 4: A bug found before release (Gemini 3 thought signatures)

- **Situation:** v0.2.0 was built and ready to publish. While capturing README screenshots with a real
  Gemini key, the chat failed after its first search: "Function call is missing a thought_signature".
- **Task:** Decide whether to ship, and fix it.
- **Action:** Reproduced it with several Gemini models (older ones worked, Gemini 3 failed), read the
  error, and found that Gemini 3 attaches `extra_content.google.thought_signature` to tool calls and
  requires it back on the next request. Our adapter dropped unknown fields. I stored `extra_content`
  on the internal `tool_use` block and echoed it in `tool_calls`. Verified the chat then completed
  multiple tool rounds with citations. Didn't publish v0.2.0; released v0.2.1 instead.
- **Result:** The first public release shipped without the bug.
- **Learned:** Test with real providers, not only mocks; adapters should preserve provider data they
  don't understand; a manual publish gate is worth having.

---

## Story 5: The translation feature that didn't work for users

- **Situation:** Translation first used Hugging Face's hosted API with the user's token, but free
  tokens often lack inference-provider access, so it failed.
- **Task:** Make translation work for everyone, without a key.
- **Action:** Moved inference on-device with Transformers.js: NLLB-200 for translation, DistilBART for
  summaries, in a Web Worker, WebGPU when available, quantised weights, models downloaded once and
  cached. Built a settings tab to show status, download and remove models.
- **Result:** No key, private, offline after the first download; 2–3 s per sentence on GPU.
- **Learned:** Remove external dependencies when they're the main failure point.

---

## Story 6: Memory crashes during long runs

- **Situation:** During the FLORES evaluation (500 translations), the app kept closing.
- **Task:** Find out why, make it stable enough, and still finish the evaluation.
- **Action:** Found that each loaded model uses ~3–4 GB of renderer memory and that WebAssembly memory
  can't shrink. Put each model in its own worker and terminate the worker when switching models or
  after 60 s idle; switched to greedy decoding; prefer WebGPU. Made the evaluation harness save after
  every batch and resume, with a script that restarted the app when it closed.
- **Result:** Normal use is stable; the evaluation completed (Hindi BLEU 29.0 / chrF 52.9).
- **Learned:** Know the runtime's memory model; design long jobs to be resumable. Next step would be
  native inference in Rust (`ort`) in a separate process.

---

## Story 7: Exporting annotations into a real PDF

- **Situation:** Annotations lived beside the PDF; users wanted to share annotated files.
- **Task:** Write annotations into a PDF that looks the same in any reader.
- **Action:** Used pdf-lib; mapped coordinates with PDF.js's `viewport.convertToPdfPoint` (handles
  the y-flip, crop box and rotation); drew ink as SVG paths with multiply blending; wrote comments as
  real text in standard fonts, falling back to a 3× PNG for scripts the standard fonts can't encode
  (Hindi, Arabic…). Added "Replace original" only behind a confirmation dialog.
- **Result:** Annotated PDFs open correctly in other readers, including rotated pages and non-Latin
  comments.
- **Learned:** Reuse the library that already knows the coordinate system instead of re-deriving it.

---

## Key trade-offs (for "why did you choose X?" questions)

| Decision | Chosen | Alternative | Why | Cost |
|---|---|---|---|---|
| App framework | Tauri | Electron | ~3 MB vs ~100 MB, Rust security model | Depends on the OS WebView |
| UI | Vanilla TS | React/Vue | Size, direct control of canvases | More manual DOM code |
| Retrieval | Agentic keyword search | Embeddings + vector DB | No infra, offline, exact page citations | More LLM round-trips, synonym gaps |
| Translation | On-device NLLB | Cloud API / chat LLM | Free, private, no key | 1.2 GB download, memory, non-commercial licence |
| Decoding | Greedy | Beam search | Memory, speed | Slightly lower quality, rare repeats |
| Annotation storage | Sidecar JSON | Write into the PDF | Never corrupts the user's file | Annotations don't travel with the PDF unless exported |
| Keys | OS credential store via Rust | Settings file / web storage | Not readable by the web layer | Platform-specific code |
| Testing | E2E via CDP + manual | Unit test suite | Fast to build for a UI-heavy app | Less regression safety |
