# 02 · Résumé material

Pick 3–5 bullets depending on the role. Every claim below is true for this codebase; don't inflate
the numbers, because interviewers ask follow-up questions.

## Project heading

**Minimal PDF**: keyboard-first desktop PDF reader with an AI assistant
*Tauri 2 · Rust · TypeScript · PDF.js · Transformers.js · GitHub Actions* ·
[github.com/mishbahul-hub/minimal-pdf](https://github.com/mishbahul-hub/minimal-pdf)

## Bullets: general software engineering

- Built a Windows desktop PDF reader with **Tauri 2 (Rust) and vanilla TypeScript**, shipping a
  **~3 MB installer** (vs. 100+ MB for typical readers) by using the OS WebView instead of bundling a
  browser.
- Implemented **viewport-based lazy rendering** with `IntersectionObserver`, a 10-canvas cap,
  2 concurrent renders and render cancellation, so **500-page documents scroll smoothly with stable
  memory**.
- Designed **anchor-preserving zoom** (the point under the cursor stays fixed) with instant CSS
  resizing followed by a debounced sharp re-render (150 ms).
- Built a **keyboard-first UI** driven by a single declarative keymap that also generates the help
  overlay, plus a radial (pie) menu for annotation tools; no UI framework.
- Implemented **annotations** (ink, shapes, text) as scalable SVG layers with undo/redo, and
  **exported them into PDFs** with pdf-lib, mapping coordinates through PDF.js viewports to handle
  crop boxes and rotation.

## Bullets: AI / LLM / RAG roles

- Designed an **agentic RAG** chat over PDFs: the LLM uses four tools (keyword search, page reading,
  outline, user annotations) in a loop of up to 12 rounds and returns answers with **clickable page
  citations**, with no vector database or embeddings.
- Built a **provider-agnostic LLM layer** supporting **Anthropic Claude and OpenAI-compatible APIs**
  (Gemini, Groq, Hugging Face, OpenRouter, Ollama), translating one internal message format
  (text / tool_use / tool_result / thinking blocks) to each protocol, with streaming over SSE.
- Added an automatic **fallback from tool calling to simple RAG** for models that can't call tools,
  and per-provider token budgets for free tiers.
- Diagnosed and fixed a **Gemini 3 tool-calling failure** by preserving and echoing provider
  "thought signatures" across turns.

## Bullets: ML / NLP roles

- Shipped **on-device neural machine translation** (English → Hindi, Marathi, Assamese, Bengali,
  Arabic) with **NLLB-200 (600M)** and a **summarise-then-translate** pipeline (DistilBART → NLLB) via
  Transformers.js/ONNX on **WebGPU (q4f16) or WebAssembly (q8)** in a Web Worker.
- Built an **evaluation harness** that drives the running app and scores translations on
  **FLORES-101** with sacreBLEU-compatible **BLEU and chrF** implemented from scratch
  (Hindi 29.0 BLEU / 52.9 chrF).
- Managed **model memory** (~3–4 GB per loaded model) by isolating one model per worker, terminating
  idle workers after 60 s, and using greedy decoding.

## Bullets: security / DevOps

- Kept **API keys out of the web layer**: stored in the Windows Credential Manager by Rust
  (`keyring`), with all provider HTTP calls proxied through Rust (`reqwest`) and streamed back over
  a Tauri Channel.
- Set up a **CI/CD release pipeline** (GitHub Actions + tauri-action) that builds, signs and drafts
  releases on version tags, with **signed auto-updates** verified by the app.

## Short project description (for a "Projects" section, 2–3 lines)

> Minimal PDF: a ~3 MB keyboard-first PDF reader for Windows (Tauri/Rust/TypeScript/PDF.js) with
> lazy rendering, annotations exported to PDF, an agentic-RAG AI assistant with page citations
> across six LLM providers, and offline English→Indic/Arabic translation benchmarked on FLORES-101.

## Skills this project demonstrates

| Area | Skills |
|---|---|
| Languages | TypeScript, Rust, CSS, a little HTML |
| Desktop | Tauri 2, WebView2, IPC (commands, channels), OS credential store, file associations, single-instance apps |
| Frontend | DOM APIs without a framework, Canvas, SVG, IntersectionObserver, Web Workers, CSS variables/theming, keyboard-driven UI design |
| Performance | Lazy rendering, render cancellation, debouncing, memory management, caching |
| AI / LLM | Tool/function calling, agentic loops, RAG, streaming (SSE), prompt design, multi-provider abstraction, prompt caching |
| ML | Transformers.js, ONNX Runtime, WebGPU, quantisation (q8, q4f16), NMT (NLLB), summarisation (BART), evaluation (BLEU, chrF, FLORES) |
| Security | Secret storage, least-privilege permissions (Tauri capabilities), signed updates |
| DevOps | GitHub Actions, release automation, code signing for updates, semantic versioning |
| Testing | End-to-end testing through the Chrome DevTools Protocol, mock servers, benchmark harnesses |

## LinkedIn / portfolio blurb

> I built Minimal PDF, a tiny (~3 MB) Windows PDF reader where the page is the whole interface:
> no toolbars, everything on the keyboard or a right-click radial menu. It has an AI assistant that
> searches and reads the document itself and cites the pages it used (agentic RAG, works with free
> API keys or fully offline), and on-device translation into Hindi, Marathi, Assamese, Bengali and
> Arabic, which I benchmarked on FLORES-101. Built with Tauri, Rust, TypeScript and PDF.js.
