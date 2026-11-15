# 12 · Interview questions and answers

Answers are written to be said out loud. Adapt the wording to your own voice.

## A. General

**1. Tell me about this project.**
Use the 30-second pitch in [01-overview](01-overview.md), then ask which part they'd like to go deeper on.

**2. Why did you build it?**
"I read a lot of long PDFs and found typical readers heavy and cluttered. I wanted something that
opens instantly and is fully keyboard-driven, and I wanted to learn desktop development with Rust and
practical LLM engineering (tool calling, RAG) on a real problem."

**3. What are you most proud of?**
Pick one: the agentic RAG with page citations working across six providers, or the lazy renderer
making 500-page files smooth, or shipping a real signed, auto-updating release. Explain *why* it was
hard.

**4. What would you do differently?**
"Add unit tests earlier, especially for the provider adapters and the SSE parser; turn on a Content
Security Policy from day one; and run ML inference natively in Rust instead of WebAssembly to avoid
the memory ceiling."

**5. How long did it take, and how did you plan it?**
"About three weeks, in stages: setup, rendering, scroll and zoom, shortcuts, themes and positions,
search and contents, then shipping. Each stage had a 'done when' check (e.g. 'a 500-page PDF scrolls
smoothly') and its own commit. AI, annotations and translation came after v1."

**6. Did you use AI tools to build it?**
Be honest: "Yes, I used Claude Code as a pair programmer. I set the requirements, design rules and
checks, reviewed the changes, tested in the running app, and made the decisions; for example, choosing
agentic RAG over embeddings, or shipping 0.2.1 instead of 0.2.0 after finding a bug."
Then show understanding by explaining any part in depth.

## B. Architecture and desktop

**7. Why Tauri instead of Electron?**
Size and security: Tauri uses the OS WebView instead of bundling Chromium, so the installer is ~3 MB
instead of ~100 MB, and its capability system only exposes the APIs I allow. Trade-off: I depend on
the user's WebView version; on Windows 10/11 WebView2 is evergreen, so that's fine.

**8. How do the Rust and TypeScript sides communicate?**
Commands (`invoke("ai_stream", args)`) for request/response, Channels for streaming data from Rust to
JS (each SSE event is sent over a Channel), and events (e.g. `open-file` from the single-instance
plugin). Arguments and results are JSON-serialised with serde.

**9. Why no React?**
The UI is one scrolling list of canvases plus a few overlays. I needed precise control over canvas
lifetimes (cancel renders, free memory), and a framework would add size and an abstraction in the
way. Plain DOM modules plus an event bus kept it simple.

**10. How are modules decoupled?**
The viewer emits events (`open`, `pagerender`, `pagefree`, `scroll`…) on an `EventTarget`; search,
annotations and settings subscribe. The viewer never imports them, which avoids cycles and makes
features easy to add or remove (the observer pattern).

**11. How does the app handle being opened by double-clicking a PDF?**
A file association registers `.pdf`. Rust reads the path from the command-line arguments, allows it in
the fs scope, and the UI asks for it on start. If the app is already running, the single-instance
plugin forwards the path to the existing window and focuses it.

## C. Performance and rendering

**12. How do you render large PDFs efficiently?**
Placeholders sized from viewports, an `IntersectionObserver` with a one-screen margin, render only
visible pages (2 at a time), keep at most 10 canvases, cancel renders for pages that leave the view.
Work scales with the screen, not the document.

**13. Why IntersectionObserver over scroll events?**
It's computed by the browser efficiently and only fires on visibility changes; scroll handlers fire
constantly and force layout with `getBoundingClientRect`.

**14. How did you make text sharp on high-DPI screens?**
Canvas backing size = CSS size × `devicePixelRatio`, rendered with a matching transform.

**15. How does zoom keep the same paragraph on screen?**
Record the page and relative position under the cursor, resize, then set the scroll so that point is
back under the cursor. Visual resize is instant (stretched canvas); a sharp re-render happens 150 ms
after the last change (debouncing).

**16. What is debouncing vs throttling? Where did you use them?**
Debounce: run once after activity stops (zoom re-render after 150 ms; saving the position 500 ms
after scrolling stops). Throttle: run at most once per interval (the transparency slider preview is
throttled to animation frames with `requestAnimationFrame`).

**17. How does search work?**
Per-page normalised text index (lower case, collapsed whitespace) with a map back to the original
characters, so phrases across line breaks match and highlights land on the right spans. Starts from
the current page, wraps, cancels stale searches. Highlights are re-applied when a page renders.

**18. What happens with scanned PDFs?**
No text layer, so search and AI have nothing to read; the app says "No searchable text in this PDF".
OCR (e.g. Tesseract) would be the fix, which I'd consider as a future feature.

## D. AI, LLMs and RAG

**19. What is RAG and why use it?**
Retrieval-augmented generation: fetch relevant text and give it to the model so answers are grounded
in the document rather than the model's memory. It reduces hallucinations and works on documents the
model never saw.

**20. What's "agentic" about your RAG?**
The model decides what to retrieve by calling tools (`search_document`, `read_pages`, `get_outline`,
`get_annotations`) in a loop, up to 12 rounds, instead of the app retrieving once up front. If a
search fails, it tries other terms; it can read the outline first for summaries.

**21. Why no vector database?**
No infrastructure or extra model, works offline, and reading whole pages gives exact quotes and page
citations. The agent offsets keyword search's synonym weakness by re-searching. For a multi-document
library or semantic queries I'd add embeddings as another tool (hybrid search).

**22. How do you prevent hallucinations?**
A grounding instruction (answer only from text read, cite pages, say if the document doesn't cover
it), tools that return exact text, and citations the user can click to verify. Not perfect, so the
citations are the real safeguard.

**23. How does tool calling work at the API level?**
The request includes tool definitions (name, description, JSON Schema). The model replies with a
`tool_use` (or `tool_calls`) block with arguments and stops with reason `tool_use`. My code runs the
tool and sends the result back as a `tool_result` (or `role: "tool"`) message, then calls again
until the model answers.

**24. How do you support multiple providers?**
One internal message format (Anthropic blocks) and two adapters (Anthropic Messages, OpenAI-compatible
Chat Completions) that translate messages, tools and streaming formats. The agent loop is
provider-agnostic.

**25. How does streaming work end to end?**
Rust sends the request and reads server-sent events from the response; each event's JSON goes to the
UI over a Tauri Channel; the TS parser accumulates text deltas (rendered live) and tool-call argument
fragments (parsed when complete).

**26. What if a model doesn't support tools?**
If the first request with tools fails with a 400/404/422 mentioning tools, the app switches to simple
RAG: it searches itself, sends the top 4 pages with the question, and announces the switch.

**27. How do you handle rate limits and errors?**
Rust maps HTTP status codes to friendly messages (401/403 bad key, 429 too many requests, 503/529 busy);
free tiers get smaller per-request budgets; a failed question is removed from the history so the
conversation stays valid; Stop cancels the stream.

**28. Tell me about a provider-specific bug.**
Gemini 3's thought signatures (see [11-challenges](11-challenges-tradeoffs.md), story 4).

**29. How do you control cost?**
Small budgets for free tiers, prompt caching for Claude (the system prompt and inlined short
documents), cached summaries per file, and nothing is sent until the user asks.

**30. What is prompt caching?**
The provider stores the processed prefix of a prompt (marked with `cache_control`), so later requests
that start with the same prefix are cheaper and faster. Useful when the same document is in every
follow-up question.

**31. How are model answers rendered safely?**
A small Markdown renderer that escapes all HTML first, then adds formatting; citations become buttons.
Model output can't inject HTML or scripts.

**32. Where are the API keys stored?**
Windows Credential Manager, via Rust's `keyring` crate. The web layer can't read them; Rust adds them
to requests. See [08-security](08-security-privacy.md).

## E. Machine learning (offline translation)

**33. Which models and why?**
NLLB-200 distilled 600M covers all five target languages in one model, including low-resource
Assamese; DistilBART-CNN for English summaries. Both are available in ONNX for Transformers.js and
small enough to run locally.

**34. How do you run a Transformer in a desktop app?**
Transformers.js with ONNX Runtime Web, in a Web Worker; WebGPU with 4-bit weights when available,
otherwise WebAssembly on the CPU with 8-bit weights. Models download once and are cached.

**35. What is quantisation?**
Storing weights in fewer bits (8-bit or 4-bit instead of 32-bit floats). Smaller downloads and less
memory, faster inference, small quality loss.

**36. Greedy decoding vs beam search?**
Greedy picks the most likely token each step; beam search keeps several candidate sequences and
picks the best overall. Beam search is usually a bit better but uses more memory and time; I chose
greedy because memory was the bottleneck.

**37. How did you handle long texts?**
Split at sentence boundaries: 400 characters per translation request, 3,000 per summary part;
summaries of parts are summarised again if still long (map-reduce).

**38. What were the memory problems?**
~3–4 GB per loaded model, and WASM memory can't shrink, so the only way to free it is to terminate
the worker. One model per worker, terminate on switch and after 60 s idle, greedy decoding, WebGPU.

**39. How did you evaluate translation quality?**
FLORES-101 devtest, first 100 sentences per language, translated by the running app via the DevTools
protocol, scored with BLEU and chrF implemented to match sacreBLEU. Hindi 29.0/52.9, Arabic
18.8/50.3, Bengali 10.3/42.4, Marathi 9.3/40.0, Assamese 4.5/32.6.

**40. Explain BLEU.**
Precision of 1- to 4-gram overlaps with a reference translation, combined by geometric mean, times a
brevity penalty for short outputs, on a 0–100 scale. Corpus-level.

**41. Why also chrF?**
It uses character n-grams (1–6) and weights recall, so it gives partial credit for word forms, which
suits morphologically rich languages like Hindi and Marathi better than word-level BLEU.

**42. Why is Assamese so low?**
It's low-resource (little training data), and the distilled 600M model has less capacity than the
full models. Greedy decoding and 4-bit quantisation cost a little more.

**43. How would you improve translation quality?**
Beam search when memory allows, a larger NLLB model or a newer one (e.g. IndicTrans2 for Indian
languages), or route translation to the chat LLM as an option; evaluate with COMET and more
sentences.

**44. Licensing concerns?**
NLLB is CC-BY-NC (non-commercial). Fine for a free app; for a commercial product I'd switch to a
permissively licensed model or an API.

## F. Annotations and PDF manipulation

**45. How are annotations kept aligned when zooming?**
They're stored in page units and drawn in an SVG whose `viewBox` is the page size; the SVG scales with
the page, no recalculation.

**46. How does undo/redo work?**
Each change is an operation `{added, removed}`; undo applies the inverse, redo re-applies (the
command pattern).

**47. How do you write annotations into a PDF?**
pdf-lib; coordinates mapped with PDF.js `viewport.convertToPdfPoint` (y-flip, crop box, rotation);
ink as SVG paths; comments as text in standard fonts, or as a high-resolution PNG when the font
can't encode the script.

**48. Why not write annotations straight into the PDF?**
To never risk corrupting the user's file; annotations are a sidecar JSON. Writing into the original
is a separate, confirmed action.

## G. Security, release, testing

**49. How do updates work and how are they secured?**
CI signs installers with a private key; the app has the public key and verifies the signature of the
downloaded update before offering to install it.

**50. What's the SmartScreen warning?**
The installer isn't Authenticode code-signed (that needs a paid certificate), so Windows warns about
an unknown publisher. Update signing is a different thing and is in place.

**51. Walk me through your CI/CD.**
Push a `v*` tag → GitHub Actions on Windows → `npm ci` → tauri-action builds, signs, creates a draft
release with `latest.json` → I review and publish.

**52. How did you test?**
Type-checking; end-to-end tests driving the running app through the Chrome DevTools Protocol (run
code, send real mouse/keyboard input, screenshot); a mock AI server for both streaming formats; a
manual test set of tricky PDFs; and the FLORES benchmark for translation.

**53. What security weaknesses remain?**
CSP is off; ONNX Runtime WASM is fetched from a CDN at runtime; no code signing; no dependency
auditing in CI. I'd fix them in that order.

## H. Behavioural / scaling

**54. How would you support macOS and Linux?**
Tauri builds for both; the code paths are mostly cross-platform (keyring already has the macOS
backend enabled). I'd add those runners to the release workflow, test WebKit-specific rendering
differences, and handle file associations per OS.

**55. How would you scale the AI to a library of 1,000 PDFs?**
Add an index across documents: a persistent full-text index (e.g. SQLite FTS5 / BM25) plus
embeddings for semantic search, exposed as new tools (search across documents, open a document),
with a reranker. Keep page citations by storing page numbers with every chunk.

**56. How would you add OCR for scanned PDFs?**
Run Tesseract (WASM) or a native OCR in a worker on pages without text, build a text layer from the
OCR boxes, and cache the results per file; search and the AI then work unchanged.

**57. How would you make it collaborative?**
Annotations are already operations (`{added, removed}`), a good basis for syncing; I'd add IDs and
timestamps, a server or CRDT for merging, and user identity.

**58. What did you learn?**
Desktop architecture with a privileged backend and an untrusted UI; performance work driven by
measuring what the user sees; how LLM tool calling really works across vendors; evaluating ML
honestly with standard benchmarks; and shipping (signing, CI, updates).

**59. If you had one more week?**
Unit tests + CI checks, a strict CSP, OCR for scanned PDFs, and an option to run Translate through
the chat AI with a BLEU comparison against the offline model.

**60. How would you measure success with users?**
Time to open and first render, crash-free sessions, how often AI answers' citations are clicked,
update adoption; collected only with consent, since privacy is a selling point.
