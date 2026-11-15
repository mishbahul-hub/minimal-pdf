# 07 · Offline translation and summarisation (on-device ML)

Source: `src/hf.ts`, `src/hfworker.ts`, `tools/eval/`.

## What it does

- **Translate:** selected English text → Hindi, Marathi, Assamese, Bengali or Arabic.
- **Summarize:** English text → English summary → (optionally) translated summary.
- Runs **on the user's computer**, with no key and no data leaving the machine, after a one-time
  model download (~1.2 GB in all).

## Why offline? (the backstory)

The first version called Hugging Face's hosted Inference API with the user's token. In practice,
free tokens often lack "Inference Providers" access, so the feature didn't work for many users
(including me). Options were: another paid API, use the chat LLM for translation, or run open models
locally. Running locally removed the key requirement and the privacy question entirely.

## The models

| Task | Model | Parameters | Licence |
|---|---|---|---|
| Translation | `Xenova/nllb-200-distilled-600M` (Meta's NLLB-200, "No Language Left Behind") | 600M | CC-BY-NC-4.0 (non-commercial) |
| Summarisation | `Xenova/distilbart-cnn-6-6` (DistilBART trained on CNN/DailyMail) | ~230M | Apache-2.0 |

NLLB-200 is a **multilingual encoder-decoder Transformer** for 200 languages; you tell it the
source and target with language codes: `eng_Latn` → `hin_Deva`, `mar_Deva`, `asm_Beng`, `ben_Beng`,
`arb_Arab`. One model covers all five targets.

DistilBART is a **distilled** (smaller, faster) BART, an encoder-decoder model fine-tuned for
abstractive news summarisation.

**Licence caveat:** NLLB's CC-BY-NC licence forbids commercial use. Fine for a free app; it would
need replacing (e.g. with a commercially licensed model or an API) for a paid product.

## How it runs in a desktop app

- **Transformers.js** (`@huggingface/transformers`) runs Hugging Face models in JavaScript using
  **ONNX Runtime Web**.
- **Device choice** (`modelDevice()` in hf.ts):
  - If WebGPU has an adapter → `device: "webgpu"`, `dtype: "q4f16"` (4-bit weights, fp16 compute);
    about 2–3 s per sentence on this machine.
  - Otherwise → `device: "wasm"` (CPU, WebAssembly), `dtype: "q8"` (8-bit quantised).
- **Quantisation** shrinks the weights (fp32 → 8-bit or 4-bit), cutting download size and memory
  with a small quality loss.
- **Web Worker:** inference runs in `hfworker.ts`, a module worker, so the UI thread never freezes.
  Messages: translate, summarize, status (is the model cached?), download, remove; progress events
  come back for the download bar.
- **Caching:** model files download from huggingface.co on first use and are stored in the
  WebView's **Cache Storage** (`transformers-cache`); the ONNX Runtime WASM binaries come from the
  jsDelivr CDN and are cached too, which keeps the installer at ~3 MB.

## The memory problem (a strong interview story)

**Symptom:** the app closed itself during longer translation runs.

**Cause:** a loaded model holds ~3–4 GB of renderer memory, and **WebAssembly memory never shrinks**:
once a WASM heap grows, it can't give memory back to the OS. Loading the second model on top of the
first, or running long batches, exhausted the renderer process.

**Fixes:**
1. **One model per worker:** translation and summarisation live in separate workers; switching
   tasks terminates the other worker, which frees its whole heap (terminating is the only way to
   release WASM memory).
2. **Idle unload:** a worker is terminated after **60 s** without requests.
3. **Greedy decoding** (`num_beams: 1`) instead of beam search: less memory and time. Trade-off: an
   occasional repeated word at the end of a sentence.
4. **WebGPU** when available, which moves the weights off the WASM heap.

**Honest status:** it's much better but not perfect on very long runs; a more robust option would be
running inference natively in Rust (ONNX Runtime via the `ort` crate) in a separate process.

## Chunking

Encoder-decoder models have input limits, and quality drops on long inputs:

- **Translation:** text is split at sentence ends into pieces of ≤ 400 characters.
- **Summaries:** split into parts of ≤ 3,000 characters, each summarised; if the joined summaries are
  still long, they're summarised again (a simple **map-reduce** summarisation). Text under 250
  characters isn't summarised (it's already short).
- Summarise-then-translate: the English summary is translated with the same chunking.

## Evaluation: how good is the translation?

### The benchmark

**FLORES-101** (Meta): the same ~1,000 English sentences from Wikipedia-style articles translated by
professionals into 101 languages. I used the first **100 devtest** sentences per language.

### The metrics

- **BLEU** (0–100): the geometric mean of **n-gram precision** (1- to 4-word sequences shared with
  the reference translation) × a **brevity penalty** (punishes too-short output). Tokenised with
  sacreBLEU's "13a" tokeniser. Corpus-level (counts summed over all sentences, then the score).
- **chrF** (0–100): an F-score over **character n-grams** (1–6 characters), with recall weighted 2×
  (chrF2, β = 2). It's fairer for **morphologically rich languages** (Hindi, Marathi, Bengali), where
  one word has many forms and exact word matches are rare.
- Both are implemented from scratch in `tools/eval/metrics.mjs`, matching sacreBLEU's defaults, with
  no dependencies.

### Results (app's own Translate, GPU, greedy decoding)

| Language | BLEU | chrF |
|---|---:|---:|
| Hindi | 29.0 | 52.9 |
| Arabic | 18.8 | 50.3 |
| Bengali | 10.3 | 42.4 |
| Marathi | 9.3 | 40.0 |
| Assamese | 4.5 | 32.6 |

**How to interpret:** Hindi and Arabic are good; Bengali and Marathi convey the meaning with awkward
wording; Assamese (a low-resource language with little training data) is weakest. These numbers are
in line with published results for the 600M distilled NLLB model, slightly lower because of greedy
decoding and 4-bit quantisation.

### How the harness works

`tools/eval/run-flores.mjs` connects to the **running app** over the Chrome DevTools Protocol
(remote debugging on port 9222) and calls the app's own `translate()` function, so it measures
exactly what users get (same model, device, chunking, decoding). It saves each translation as it
goes (`results/hyps-<label>.json`), so if the app closes mid-run it **resumes** where it stopped.
Source sentences and references come from the Hugging Face datasets server.

### Limits of the evaluation (say this if asked)

- 100 sentences per language is small; scores have a few points of variance.
- One reference translation per sentence; BLEU underrates valid paraphrases.
- FLORES is Wikipedia-style text; PDFs (papers, textbooks) may differ.
- Better: more sentences, COMET (a neural metric), and human ratings.
