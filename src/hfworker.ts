// Web Worker: runs the translation and summarization models (Transformers.js, ONNX) off the main
// thread, so reading stays smooth while a model works. On the graphics card (WebGPU) when there is
// one, otherwise on the processor (WASM). Models download from Hugging Face once, then load from the
// WebView's cache ("transformers-cache"), which keeps them working offline.
import { ModelRegistry, pipeline, type ProgressInfo } from "@huggingface/transformers";

export const MODELS = {
  translation: { id: "Xenova/nllb-200-distilled-600M", task: "translation" },
  summarization: { id: "Xenova/distilbart-cnn-6-6", task: "summarization" },
} as const;
export type Which = keyof typeof MODELS;

/** Where the models run. Each needs its own model files (4-bit/fp16 for the GPU, 8-bit for the CPU). */
export type Device = "gpu" | "cpu";
const OPTIONS = {
  gpu: { device: "webgpu", dtype: "q4f16" },
  cpu: { device: "wasm", dtype: "q8" },
} as const;

export type Request =
  | { id: number; device: Device; task: "translate"; text: string; tgt: string }
  | { id: number; device: Device; task: "summarize"; text: string }
  | { id: number; device: Device; task: "status" }
  | { id: number; device: Device; task: "download"; which: Which }
  | { id: number; device: Device; task: "remove" };

export type Response =
  | { id: number; progress: { which: Which; loaded: number; total: number } }
  | { id: number; result: unknown }
  | { id: number; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loaded = new Map<string, Promise<any>>();

/**
 * The model's pipeline, loading (and the first time downloading) it, with byte progress. hf.ts runs
 * one model per worker and ends the worker to free its memory.
 */
function load(which: Which, device: Device, id: number) {
  const key = `${which}/${device}`;
  let p = loaded.get(key);
  if (!p) {
    const m = MODELS[which];
    p = pipeline(m.task, m.id, {
      ...OPTIONS[device],
      progress_callback: (info: ProgressInfo) => {
        if (info.status === "progress_total") post({ id, progress: { which, loaded: info.loaded, total: info.total } });
      },
    });
    p.catch(() => loaded.delete(key)); // a failed download can be retried
    loaded.set(key, p);
  }
  return p;
}

function post(msg: Response) {
  self.postMessage(msg);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    if (req.task === "translate") {
      const translator = await load("translation", req.device, req.id);
      // Greedy decoding (one candidate, not a beam of several): far less memory and time.
      const out = await translator(req.text, { src_lang: "eng_Latn", tgt_lang: req.tgt, max_new_tokens: 400, num_beams: 1 });
      post({ id: req.id, result: (Array.isArray(out) ? out[0] : out)?.translation_text ?? "" });
    } else if (req.task === "summarize") {
      const summarizer = await load("summarization", req.device, req.id);
      const out = await summarizer(req.text, { max_new_tokens: 160, num_beams: 1, no_repeat_ngram_size: 3 });
      post({ id: req.id, result: (Array.isArray(out) ? out[0] : out)?.summary_text ?? "" });
    } else if (req.task === "status") {
      const status: Record<string, boolean> = {};
      for (const [which, m] of Object.entries(MODELS)) status[which] = await ModelRegistry.is_pipeline_cached(m.task, m.id, OPTIONS[req.device]);
      post({ id: req.id, result: status });
    } else if (req.task === "download") {
      await load(req.which, req.device, req.id);
      post({ id: req.id, result: true });
    } else if (req.task === "remove") {
      loaded.clear();
      // Both the GPU and the CPU files, whichever were downloaded.
      for (const m of Object.values(MODELS)) for (const o of Object.values(OPTIONS)) await ModelRegistry.clear_pipeline_cache(m.task, m.id, o);
      post({ id: req.id, result: true });
    }
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};
