// Translation (English → Hindi, Marathi, Assamese, Bengali, Arabic) and English summarization with
// Hugging Face models, run by Hugging Face (Inference Providers, hf-inference route) with the user's
// token: the same one the Hugging Face chat provider uses. Rust (ai.rs, hf_task) holds the token.
//
// Summarize-and-translate is a two-step pipeline: summarize the English text with a summarization
// model, then translate that summary with the language's translation model.
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./settings";
import { AiError } from "./llm";

export type LangId = "hi" | "mr" | "as" | "bn" | "ar";

/** Target languages, with the codes each model family uses. */
export const LANGS: { id: LangId; name: string; native: string; iso3: string; nllb: string; rtl?: boolean }[] = [
  { id: "hi", name: "Hindi", native: "हिन्दी", iso3: "hin", nllb: "hin_Deva" },
  { id: "mr", name: "Marathi", native: "मराठी", iso3: "mar", nllb: "mar_Deva" },
  { id: "as", name: "Assamese", native: "অসমীয়া", iso3: "asm", nllb: "asm_Beng" },
  { id: "bn", name: "Bengali", native: "বাংলা", iso3: "ben", nllb: "ben_Beng" },
  { id: "ar", name: "Arabic", native: "العربية", iso3: "ara", nllb: "arb_Arab", rtl: true },
];

export function langInfo(id: LangId) {
  return LANGS.find((l) => l.id === id) ?? LANGS[0];
}

// MADLAD-400 (Google, Apache-2.0) translates into 400+ languages, all five of ours included, and
// Hugging Face serves it. Dedicated pairs exist only for Hindi and Arabic.
const MADLAD = "google/madlad400-3b-mt";
export const SUGGESTED: { summarize: string[]; translate: Record<LangId, string[]> } = {
  summarize: ["facebook/bart-large-cnn", "sshleifer/distilbart-cnn-12-6", "google/pegasus-xsum"],
  translate: {
    hi: [MADLAD, "Helsinki-NLP/opus-mt-en-hi", "Helsinki-NLP/opus-mt-en-mul"],
    mr: [MADLAD, "Helsinki-NLP/opus-mt-en-mul"],
    as: [MADLAD, "Helsinki-NLP/opus-mt-en-mul"],
    bn: [MADLAD, "Helsinki-NLP/opus-mt-en-mul"],
    ar: [MADLAD, "Helsinki-NLP/opus-mt-tc-big-en-ar", "Helsinki-NLP/opus-mt-en-ar"],
  },
};

export type HfModels = { summarize: string; translate: Record<LangId, string> };
const DEFAULTS: HfModels = {
  summarize: SUGGESTED.summarize[0],
  translate: { hi: MADLAD, mr: MADLAD, as: MADLAD, bn: MADLAD, ar: MADLAD },
};

let models: HfModels | null = null;

/** The chosen models (settings `hfModels`), filled in with the defaults. */
export async function getHfModels(): Promise<HfModels> {
  if (!models) {
    const saved = await getSetting<Partial<HfModels>>("hfModels");
    models = { summarize: saved?.summarize || DEFAULTS.summarize, translate: { ...DEFAULTS.translate, ...saved?.translate } };
  }
  return models;
}

export async function setHfModels(m: HfModels) {
  models = m;
  await setSetting("hfModels", m);
}

/** Models Hugging Face currently serves for a task. */
export async function servedModels(task: "translation" | "summarization"): Promise<string[]> {
  return invoke<string[]>("hf_models", { task }).catch(rethrow);
}

function rethrow(e: unknown): never {
  const info = e as { kind?: string; message?: string };
  throw new AiError(info?.kind ?? "api", info?.message ?? String(e));
}

async function runTask(model: string, inputs: string, parameters?: Record<string, unknown>): Promise<unknown> {
  return invoke("hf_task", { model, inputs, parameters: parameters ?? null }).catch(rethrow);
}

/** The text field of an answer: [{translation_text}] / [{summary_text}] / [{generated_text}] or the object itself. */
function answerText(res: unknown): string {
  const first = (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | undefined;
  const text = first?.translation_text ?? first?.summary_text ?? first?.generated_text;
  if (typeof text !== "string") throw new AiError("api", "Hugging Face returned no text.");
  return text.trim();
}

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

/** How a model is told the target language. */
function translationRequest(model: string, text: string, lang: LangId): { inputs: string; parameters?: Record<string, unknown> } {
  const l = langInfo(lang);
  if (/madlad400/i.test(model)) return { inputs: `<2${l.id}> ${text}` };
  // Multi-target Marian models pick the language from a >>xxx<< prefix.
  if (/opus-mt-(tc-[a-z]+-)?en-(mul|dra|inc)\b/i.test(model)) return { inputs: `>>${l.iso3}<< ${text}` };
  if (/nllb/i.test(model)) return { inputs: text, parameters: { src_lang: "eng_Latn", tgt_lang: l.nllb } };
  if (/m2m100/i.test(model)) return { inputs: text, parameters: { src_lang: "en", tgt_lang: l.id } };
  return { inputs: text }; // a model for this one language pair
}

const TRANSLATE_CHUNK = 400; // characters per request: translation models handle a few sentences at a time
const SUMMARY_CHUNK = 3000; // BART reads about 1,000 tokens
export const MIN_SUMMARY_CHARS = 250; // shorter text is already a summary

export type Progress = (step: string) => void;

/** Translate English text into `lang`, piece by piece. */
export async function translate(text: string, lang: LangId, onStep?: Progress): Promise<string> {
  const model = (await getHfModels()).translate[lang];
  const pieces = chunks(text, TRANSLATE_CHUNK);
  onStep?.(`Translating into ${langInfo(lang).name} with ${model}${pieces.length > 1 ? ` (${pieces.length} parts)` : ""}…`);
  const out: string[] = [];
  for (const piece of pieces) {
    const req = translationRequest(model, piece, lang);
    out.push(answerText(await runTask(model, req.inputs, req.parameters)));
  }
  return out.join(" ");
}

/** Summarize English text. Long text is summarized in parts, and the parts once more if still long. */
export async function summarize(text: string, onStep?: Progress): Promise<string> {
  const model = (await getHfModels()).summarize;
  const pieces = chunks(text, SUMMARY_CHUNK);
  onStep?.(`Summarizing with ${model}${pieces.length > 1 ? ` (${pieces.length} parts)` : ""}…`);
  const parts: string[] = [];
  for (const piece of pieces) parts.push(answerText(await runTask(model, piece)));
  let summary = parts.join(" ");
  if (parts.length > 1 && summary.length > SUMMARY_CHUNK) summary = answerText(await runTask(model, summary.slice(0, SUMMARY_CHUNK * 1.3)));
  return summary;
}
