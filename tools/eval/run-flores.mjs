// Translation quality of the app's own Translate (English → Hindi, Marathi, Assamese, Bengali,
// Arabic) on the FLORES-101 devtest set, scored with BLEU and chrF (metrics.mjs).
//
// It drives the running app over the DevTools protocol, so the scores measure exactly what the app
// does (same models, device, chunking and decoding settings):
//   1. npm run tauri dev, with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   2. node tools/eval/run-flores.mjs [sentences per language, default 100] [label, default offline]
// Every translation is saved to results/hyps-<label>.json as it finishes, so if the app closes
// mid-run, start it again and rerun: the evaluation continues where it stopped. Scores go to
// results/scores-<label>.json. Source sentences and references come from the Hugging Face
// datasets server (gsarti/flores_101, devtest split, first N sentences).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bleu, chrf } from "./metrics.mjs";

const N = Number(process.argv[2] ?? 100);
const label = process.argv[3] ?? "offline";
const out = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(out, { recursive: true });

/** Our language ids → FLORES-101 configs. */
const LANGS = [
  ["hi", "hin"],
  ["mr", "mar"],
  ["as", "asm"],
  ["bn", "ben"],
  ["ar", "ara"],
];

async function sentences(config) {
  const all = [];
  for (let off = 0; off < N; off += 100) {
    const len = Math.min(100, N - off);
    const url = `https://datasets-server.huggingface.co/rows?dataset=gsarti/flores_101&config=${config}&split=devtest&offset=${off}&length=${len}`;
    const r = await (await fetch(url)).json();
    all.push(...r.rows.map((x) => x.row.sentence));
  }
  return all;
}

// The app's page over DevTools.
const target = (await (await fetch("http://127.0.0.1:9222/json")).json()).find((x) => x.type === "page" && x.url.includes("localhost:1420"));
if (!target) throw new Error("Start the app with remote debugging on port 9222 first (see the top of this file).");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
});
ws.addEventListener("close", () => {
  console.error("\nThe app closed. Start it again and rerun to continue.");
  process.exit(1);
});
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
async function inApp(code) {
  // Import the module instance the app loaded (Vite adds ?t= after edits).
  const expression = `(async () => { const M = (n) => import(performance.getEntriesByType("resource").map((e) => e.name).filter((x) => x.split("?")[0].endsWith("/src/" + n)).pop() ?? "/src/" + n); ${code} })()`;
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.error ?? r.result.exceptionDetails).slice(0, 400));
  return r.result.result.value;
}

const device = await inApp(`return (await M("hf.ts")).modelDevice()`);
const src = await sentences("eng");
const hypsFile = join(out, `hyps-${label}.json`);
const hyps = existsSync(hypsFile) ? JSON.parse(readFileSync(hypsFile, "utf8")) : {};
const scores = {};
for (const [lang, config] of LANGS) {
  const refs = await sentences(config);
  hyps[lang] ??= [];
  const started = Date.now();
  const before = hyps[lang].length;
  for (let i = hyps[lang].length; i < N; i += 10) {
    const batch = src.slice(i, Math.min(i + 10, N));
    const res = await inApp(`const H = await M("hf.ts"); const out = []; for (const s of ${JSON.stringify(batch)}) out.push(await H.translate(s, "${lang}")); return out;`);
    hyps[lang].push(...res);
    writeFileSync(hypsFile, JSON.stringify(hyps, null, 1));
    process.stdout.write(`${lang} ${hyps[lang].length}/${N}\r`);
  }
  const done = hyps[lang].length - before;
  const h = hyps[lang].slice(0, N);
  scores[lang] = {
    bleu: +bleu(h, refs).toFixed(1),
    chrf: +chrf(h, refs).toFixed(1),
    ...(done ? { secondsPerSentence: +((Date.now() - started) / 1000 / done).toFixed(2) } : {}),
  };
  console.log(lang, JSON.stringify(scores[lang]));
}
writeFileSync(join(out, `scores-${label}.json`), JSON.stringify({ dataset: "FLORES-101 devtest", sentences: N, device, scores }, null, 1));
console.log("done", JSON.stringify(scores));
process.exit(0);
