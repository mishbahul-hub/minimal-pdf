# Minimal PDF: project guide for résumés and interviews

These notes explain the whole project so you can describe it on a résumé and answer interview
questions about it with confidence. Every number and name here comes from the actual code.

## How to use these notes

Read them in this order the first time. Before an interview, reread **01**, **02**, **11** and **12**.

| # | File | What it gives you |
|---|---|---|
| 01 | [Overview](01-overview.md) | The 30-second and 2-minute pitch, the problem, the features, the numbers |
| 02 | [Résumé](02-resume.md) | Ready-to-use résumé bullets, a project description, skills to list |
| 03 | [Architecture](03-architecture.md) | The big picture: layers, modules, how data flows, key design decisions |
| 04 | [Reader engine](04-reader-engine.md) | PDF rendering, lazy loading, zoom, text layer, search, keyboard |
| 05 | [Annotations and saving](05-annotations-and-saving.md) | Drawing on pages, undo/redo, storage, writing annotations into a PDF |
| 06 | [AI and agentic RAG](06-ai-agentic-rag.md) | Multi-provider AI, streaming, tool calling, the agent loop, citations |
| 07 | [Offline translation (ML)](07-offline-translation-ml.md) | On-device models, WebGPU/WASM, memory limits, BLEU/chrF evaluation |
| 08 | [Security and privacy](08-security-privacy.md) | API keys, permissions, signed updates, what could be improved |
| 09 | [Build, release, DevOps](09-build-release-devops.md) | Installer size, GitHub Actions, code signing for updates, versioning |
| 10 | [Testing and debugging](10-testing-and-debugging.md) | How the app was tested, the DevTools-protocol harness, real bugs found |
| 11 | [Challenges and trade-offs](11-challenges-tradeoffs.md) | STAR stories for "tell me about a hard problem" |
| 12 | [Interview questions](12-interview-questions.md) | 60+ likely questions with answers you can say out loud |
| 13 | [Glossary](13-glossary.md) | Every technical term, in one line each |

## The project in one sentence

> I built **Minimal PDF**, a fast, keyboard-first desktop PDF reader for Windows (Tauri 2 + Rust +
> TypeScript + PDF.js) with a ~3 MB installer, annotations, an AI assistant that answers questions
> about the document using **agentic RAG** with page citations across six AI providers, and
> **on-device** English → Hindi/Marathi/Assamese/Bengali/Arabic translation that I evaluated on the
> FLORES-101 benchmark.

## A note on honesty

If you built parts of this with an AI coding assistant (Claude Code), say so when asked; it is a
normal, valued skill now. What interviewers check is whether **you understand the decisions**. These
notes exist so you can explain every decision, its alternatives, and its trade-offs in your own
words. If you can't explain something here yet, open the source file named in the notes and read it
until you can.

## Quick facts to memorise

| Fact | Value |
|---|---|
| Platform | Windows desktop (Tauri 2, uses the WebView2 built into Windows) |
| Languages | TypeScript (frontend, ~5,400 lines), Rust (backend, ~500 lines), CSS (~1,800 lines) |
| Installer size | ~3 MB (NSIS), ~4 MB (MSI); installed app ~8.5 MB |
| PDF engine | PDF.js (Mozilla) |
| AI providers | Gemini, Groq, Hugging Face, OpenRouter, Ollama (local), Anthropic Claude, any OpenAI-compatible API |
| AI technique | Agentic RAG with 4 tools, up to 12 tool rounds (24 for whole-document summaries) |
| Offline models | NLLB-200 distilled 600M (translation), DistilBART CNN 6-6 (summaries), via Transformers.js |
| Translation quality | Hindi BLEU 29.0 / chrF 52.9 … Assamese BLEU 4.5 / chrF 32.6 (FLORES-101, 100 sentences) |
| Releases | GitHub Actions builds and signs installers; the app auto-updates from GitHub Releases |
| Current version | 0.2.1 |
| Repository | https://github.com/mishbahul-hub/minimal-pdf |
