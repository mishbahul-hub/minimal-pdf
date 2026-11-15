# 01 · Overview and pitch

## The 30-second pitch

> "Minimal PDF is a desktop PDF reader for Windows that I built with Tauri, Rust and TypeScript.
> The idea is that the page is the whole interface: there's no toolbar, everything is on the
> keyboard or a right-click radial menu. It renders only the pages on screen, so a 500-page book
> scrolls smoothly, and the installer is about 3 MB. On top of that I added an AI assistant: you can
> chat with the PDF and it answers with page citations, using an agentic RAG approach where the model
> searches and reads the document through tools. It works with free API keys from Gemini, Groq and
> others, or fully offline with Ollama. I also added on-device translation into five Indian and
> Middle-Eastern languages, which I benchmarked with BLEU and chrF on FLORES-101."

## The 2-minute version (when they say "walk me through it")

1. **Problem.** Most PDF readers are heavy (100+ MB), full of toolbars, and slow on large files. I
   wanted something that opens instantly and stays out of the way, like a code editor for reading.
2. **Core reader.** Tauri app: a small Rust shell around the Windows WebView, with the UI in plain
   TypeScript (no React, deliberately). PDF.js renders pages to canvases. I implemented lazy
   rendering with an `IntersectionObserver`: only pages near the viewport are drawn, at most 10
   canvases are kept alive, and in-flight renders are cancelled when you scroll away or zoom. Zoom
   keeps the paragraph under your mouse in place.
3. **Interaction.** Every feature has a keyboard shortcut (vim-style `j`/`k`, `g g`, `/` to search).
   Annotations (pen, highlighter, shapes, text comments) live in a radial menu around the cursor.
   Annotations are stored separately from the PDF, and can be "baked" into a new PDF with pdf-lib.
4. **AI.** Select text → Explain / Simplify / Define. Or press `c` to chat with the whole document.
   Instead of a vector database, the model gets four tools (`search_document`, `read_pages`,
   `get_outline`, `get_annotations`) and decides what to read, then cites pages like `[p. 41]`, which
   become clickable links. API keys are stored in the Windows Credential Manager by the Rust side
   and never reach the web layer.
5. **Offline ML.** Translation (English → Hindi, Marathi, Assamese, Bengali, Arabic) and
   summarisation run on-device with Transformers.js in a Web Worker, on the GPU via WebGPU when
   available. I measured the quality on FLORES-101 (Hindi BLEU 29, chrF 53).
6. **Shipping.** GitHub Actions builds signed installers on every version tag, and the app updates
   itself from GitHub Releases.

## The problem it solves

| Typical PDF reader | Minimal PDF |
|---|---|
| 100–500 MB install, slow start | ~3 MB installer, starts instantly (uses the WebView2 already in Windows) |
| Toolbars and panels take screen space | No toolbar; controls appear on demand and close with `Esc` |
| Mouse-driven | Keyboard-first; every feature has a shortcut |
| Annotations often modify the file | Annotations are stored separately; the PDF is changed only on explicit, confirmed request |
| AI features (if any) are paid and cloud-only | Works with free API keys, with a local model (Ollama), or fully offline for translation |

## Feature list (grouped)

**Reading**
- Open via `Ctrl+O`, double-click (file association), or recent files (`1`–`9` on the start screen)
- Lazy rendering, high-DPI sharp text, zoom steps 50–300% with anchor preservation, fit width / fit page
- Search (`/`) across line breaks with highlights; table of contents sidebar (`t`)
- Light / dark / sepia themes; remembers page and zoom per file
- Single instance: opening a second PDF reuses the running window

**Annotations and saving**
- Pen, pencil, highlighter, eraser, rectangle, ellipse, text comments; Shift for straight lines / perfect shapes
- Undo / redo; per-file storage in JSON
- Save a new PDF with annotations drawn in, a plain copy, or (after confirmation) replace the original

**AI**
- Selection actions: Explain, Simplify, Define (cloud/local LLM), Translate, Summarize (offline)
- Chat with the PDF: agentic RAG, streaming answers, visible steps, clickable page citations
- Page / section / whole-document summaries, cached per file
- Six providers + any OpenAI-compatible endpoint; keys in Windows Credential Manager

**Offline ML**
- English → Hindi, Marathi, Assamese, Bengali, Arabic (NLLB-200)
- Summarise-then-translate pipeline (DistilBART → NLLB-200)
- GPU (WebGPU) or CPU (WebAssembly), background worker, automatic unloading to free memory

**Engineering**
- Settings dialog with "liquid glass" UI style and transparency slider
- Signed auto-updates; CI release pipeline
- Translation-quality evaluation harness (FLORES-101, BLEU, chrF)

## Timeline

- Started 21 Oct 2026; built in stages (0 setup → 1 render → 2 scroll/zoom → 3 shortcuts → 4 themes
  and positions → 5 search and contents → 6 ship), each stage with a "done when" check and a commit.
- Then: annotations, AI chat, multi-provider support, offline translation, saving, evaluation.
- v0.2.1 released on GitHub (Nov 2026).

## Who it's for

Students and researchers reading long papers and textbooks; people who prefer the keyboard; readers
who need help with English text in their own language (Hindi, Marathi, Assamese, Bengali, Arabic).
