// Translation (English → Hindi, Marathi, Assamese, Bengali, Arabic) and English summarization with
// open Hugging Face models that run on this computer (Transformers.js in hfworker.ts): no key, and
// nothing leaves the computer. The models download once, on first use, then work offline.
//
// Summarize-and-translate is a two-step pipeline: summarize the English text with the summarization
// model, then translate that summary with the translation model.
import { AiError } from "./llm";
import type { Device, Request, Response, Which } from "./hfworker";

export type LangId = "hi" | "mr" | "as" | "bn" | "ar";

/** Target languages, with their NLLB-200 (FLORES-200) codes. */
export const LANGS: { id: LangId; name: string; native: string; nllb: string; rtl?: boolean }[] = [
  { id: "hi", name: "Hindi", native: "हिन्दी", nllb: "hin_Deva" },
  { id: "mr", name: "Marathi", native: "मराठी", nllb: "mar_Deva" },
  { id: "as", name: "Assamese", native: "অসমীয়া", nllb: "asm_Beng" },
  { id: "bn", name: "Bengali", native: "বাংলা", nllb: "ben_Beng" },
  { id: "ar", name: "Arabic", native: "العربية", nllb: "arb_Arab", rtl: true },
];

export function langInfo(id: LangId) {
  return LANGS.find((l) => l.id === id) ?? LANGS[0];
}

/** What Settings shows about each model. Download sizes differ: 4-bit/fp16 files for the GPU, 8-bit for the CPU. */
export const MODEL_INFO: Record<Which, { name: string; id: string; size: Record<Device, string>; licence: string; use: string }> = {
  translation: {
    name: "NLLB-200 (600M)",
    id: "Xenova/nllb-200-distilled-600M",
    size: { gpu: "about 1.3 GB", cpu: "about 0.9 GB" },
    licence: "CC-BY-NC-4.0",
    use: "Translation",
  },
  summarization: {
    name: "DistilBART CNN",
    id: "Xenova/distilbart-cnn-6-6",
    size: { gpu: "about 0.3 GB", cpu: "about 0.3 GB" },
    licence: "Apache-2.0",
    use: "English summaries",
  },
};

let devicePromise: Promise<Device> | null = null;

/** The graphics card (WebGPU) when the WebView offers one: much faster; otherwise the processor. */
export function modelDevice(): Promise<Device> {
  devicePromise ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return gpu && (await gpu.requestAdapter()) ? "gpu" : "cpu";
    } catch {
      return "cpu";
    }
  })();
  return devicePromise;
}

// ---------------------------------------------------------------------------
// The worker
//
// A model takes 2–4 GB of memory while loaded, and WebAssembly memory never shrinks, even after a
// model is unloaded. So each model gets its own worker, which is ended (memory and all) when the
// other model is needed and after a minute without use. Reloading from the disk cache takes seconds.

const IDLE_MS = 60_000;

/** A request without its id (added here); Omit on each member of the union. */
type Body = Request extends infer R ? (R extends unknown ? Omit<R, "id" | "device"> : never) : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (loaded: number, total: number) => void };
let worker: Worker | null = null;
let workerModel: Which | null = null; // the model this worker has (or will have) loaded
let idleTimer = 0;
let seq = 0;
const pending = new Map<number, Pending>();

/** Send a request; `model` is the model it loads (none for status / remove). */
async function call<T>(req: Body, onProgress?: Pending["onProgress"], model?: Which): Promise<T> {
  const device = await modelDevice();
  clearTimeout(idleTimer);
  if (worker && model && workerModel && workerModel !== model && !pending.size) stopWorker();
  worker ??= startWorker();
  if (model) workerModel = model;
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    worker!.postMessage({ ...req, id, device } as Request);
  });
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  workerModel = null;
}

/** End the worker once nothing has used it for a while, giving its memory back. */
function scheduleIdleStop() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (!pending.size) stopWorker();
  }, IDLE_MS);
}

function startWorker() {
  const w = new Worker(new URL("./hfworker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<Response>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if ("progress" in msg) p.onProgress?.(msg.progress.loaded, msg.progress.total);
    else {
      pending.delete(msg.id);
      if (!pending.size) scheduleIdleStop();
      if ("error" in msg) p.reject(new AiError("api", friendlyError(msg.error)));
      else p.resolve(msg.result);
    }
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new AiError("api", `The translation engine stopped: ${e.message}`));
    pending.clear();
    stopWorker();
  };
  return w;
}

function friendlyError(message: string) {
  if (/fetch|network|Failed to load|ERR_/i.test(message))
    return "Couldn't download the model. Check your internet connection: it's needed once, the first time.";
  return message;
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Progress text for a model download (shown only while one happens). */
function downloadStep(which: Which, onStep?: Progress) {
  return (loaded: number, total: number) => {
    if (!onStep || !total) return;
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    onStep(`Downloading the ${MODEL_INFO[which].use.toLowerCase()} model (one time): ${pct}% · ${mb(loaded)} of ${mb(total)}`);
  };
}

/** Which models are already on this computer. */
export function modelStatus(): Promise<Record<Which, boolean>> {
  return call({ task: "status" });
}

/** Download a model now (otherwise it downloads on first use). */
export function downloadModel(which: Which, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  return call({ task: "download", which }, onProgress, which);
}

/** Delete the downloaded models (they download again on next use). */
export async function removeModels(): Promise<void> {
  if (!pending.size) stopWorker(); // a loaded model can't be deleted from under a running worker
  return call({ task: "remove" });
}

// ---------------------------------------------------------------------------
// Translate and summarize

/** Split text into pieces of at most `max` characters, at sentence ends where possible. */
export function chunks(text: string, max: number): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?।]+[.!?।]*\s*/g) ?? [];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      // One very long sentence: cut it at spaces.
      for (const word of s.split(" ")) {
        if (cur && cur.length + word.length + 1 > max) {
          out.push(cur.trim());
          cur = "";
        }
        cur += word + " ";
      }
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const TRANSLATE_CHUNK = 400; // characters per request: NLLB handles a few sentences at a time
const SUMMARY_CHUNK = 3000; // DistilBART reads about 1,000 tokens
export const MIN_SUMMARY_CHARS = 250; // shorter text is already a summary

export type Progress = (step: string) => void;

/** Translate English text into `lang`, piece by piece. */
export async function translate(text: string, lang: LangId, onStep?: Progress): Promise<string> {
  const l = langInfo(lang);
  const pieces = chunks(text, TRANSLATE_CHUNK);
  const out: string[] = [];
  for (const [i, piece] of pieces.entries()) {
    onStep?.(`Translating into ${l.name}${pieces.length > 1 ? ` (part ${i + 1} of ${pieces.length})` : ""}…`);
    out.push((await call<string>({ task: "translate", text: piece, tgt: l.nllb }, downloadStep("translation", onStep), "translation")).trim());
  }
  return out.join(" ");
}

/** Summarize English text. Long text is summarized in parts, and the parts once more if still long. */
export async function summarize(text: string, onStep?: Progress): Promise<string> {
  const pieces = chunks(text, SUMMARY_CHUNK);
  const parts: string[] = [];
  for (const [i, piece] of pieces.entries()) {
    onStep?.(`Summarizing${pieces.length > 1 ? ` (part ${i + 1} of ${pieces.length})` : ""}…`);
    parts.push((await call<string>({ task: "summarize", text: piece }, downloadStep("summarization", onStep), "summarization")).trim());
  }
  let summary = parts.join(" ");
  if (parts.length > 1 && summary.length > SUMMARY_CHUNK) {
    onStep?.("Combining the parts…");
    summary = (await call<string>({ task: "summarize", text: summary.slice(0, SUMMARY_CHUNK * 1.3) }, undefined, "summarization")).trim();
  }
  return summary;
}
