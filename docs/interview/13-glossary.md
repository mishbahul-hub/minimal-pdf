# 13 · Glossary

| Term | Meaning (as used in this project) |
|---|---|
| **Adapter pattern** | Code that converts one interface to another; here, the internal message format → each AI provider's API |
| **Agent loop** | Call the model → run the tools it asks for → send results → repeat until it answers |
| **Agentic RAG** | RAG where the model decides what to retrieve by calling tools, possibly several times |
| **Anchor (zoom)** | The point that should stay under the cursor while zooming |
| **Beam search** | Decoding that keeps several candidate outputs and picks the best overall |
| **BLEU** | Translation metric: n-gram precision vs a reference, with a brevity penalty (0–100) |
| **Capabilities (Tauri)** | The allow-list of APIs the WebView may call |
| **CDP (Chrome DevTools Protocol)** | A WebSocket protocol to control Chromium: run code, send input, take screenshots |
| **Channel (Tauri)** | An ordered stream of messages from Rust to the WebView, used for AI streaming |
| **chrF** | Translation metric: character n-gram F-score, recall-weighted (chrF2) |
| **Command (Tauri)** | A Rust function the UI can call with `invoke` |
| **Command pattern** | Representing actions as data so they can be undone/redone |
| **Credential Manager** | Windows' secure store for passwords and keys |
| **Crop box** | The visible region of a PDF page, which can be offset from the page origin |
| **CSP** | Content Security Policy: browser rules limiting which scripts and connections a page may use |
| **Debounce** | Run once after activity stops for a set time |
| **devicePixelRatio** | Physical pixels per CSS pixel (1.5 on a 150% display) |
| **Distillation** | Training a smaller model to mimic a larger one (DistilBART, NLLB distilled) |
| **Embedding** | A vector representing meaning, used for semantic search |
| **Encoder-decoder** | Transformer architecture that reads input (encoder) and generates output (decoder); used for translation and summarisation |
| **FLORES-101** | Meta's benchmark of professionally translated sentences in 101 languages |
| **FNV-1a** | A fast, simple hash function; used to name per-file notes |
| **Greedy decoding** | Pick the single most likely next token each step |
| **Hallucination** | A model stating things not supported by its sources |
| **IntersectionObserver** | Browser API that reports when elements enter or leave a region (the viewport) |
| **keyring (crate)** | Rust library for the OS credential store |
| **LTO** | Link-time optimisation: whole-program optimisation for a smaller, faster binary |
| **Map-reduce summarisation** | Summarise parts, then summarise the summaries |
| **minisign** | The signature scheme Tauri uses to sign updates |
| **NLLB-200** | Meta's "No Language Left Behind" translation model for 200 languages |
| **NSIS / MSI** | Two Windows installer formats |
| **Observer pattern** | Components subscribe to events instead of being called directly |
| **ONNX / ONNX Runtime** | A portable model format and the engine that runs it (here in the browser via WASM/WebGPU) |
| **PDF.js** | Mozilla's JavaScript PDF renderer |
| **pdf-lib** | A JavaScript library to create and modify PDFs |
| **Points (pt)** | PDF units, 1/72 inch |
| **Prompt caching** | The provider reuses a processed prompt prefix to cut cost and latency |
| **Quantisation** | Storing model weights in fewer bits (q8 = 8-bit, q4f16 = 4-bit weights with fp16 compute) |
| **RAG** | Retrieval-augmented generation: give the model retrieved text to ground its answer |
| **reqwest** | Rust HTTP client used for AI requests |
| **sacreBLEU** | The standard tool for reproducible BLEU/chrF scores; the metrics here match its defaults |
| **SSE (server-sent events)** | A streaming HTTP format: events separated by blank lines, `data:` lines with JSON |
| **Semantic versioning** | MAJOR.MINOR.PATCH version numbers |
| **Single instance** | Only one app process; new launches hand their file to it |
| **SmartScreen** | Windows' reputation check that warns about unsigned installers |
| **Stop reason** | Why the model stopped: end of turn, tool use, max tokens, refusal |
| **Tauri** | Framework for desktop apps with a Rust core and the OS WebView for the UI |
| **Text layer** | Transparent positioned text over a PDF canvas, for selecting and searching |
| **Thought signature** | Gemini 3's opaque token on tool calls that must be sent back on the next request |
| **Tool calling / function calling** | The model asks the app to run a named function with JSON arguments |
| **Transformers.js** | Hugging Face's library to run Transformer models in JavaScript |
| **Viewport (PDF.js)** | A page's size and transform at a given scale/rotation |
| **WebAssembly (WASM)** | A fast binary code format browsers run; its memory can grow but never shrink |
| **WebGPU** | Browser API for GPU compute, used for faster model inference |
| **WebView2** | Microsoft's Chromium-based web engine built into Windows 10/11 |
| **Web Worker** | A background JavaScript thread that keeps heavy work off the UI thread |
