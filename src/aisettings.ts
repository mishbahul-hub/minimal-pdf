// Settings (Ctrl+,, the gear in the right-click menu and the chat, or the start screen), in tabs:
// General (theme, translation language, version), the chat AI provider and model, the Hugging Face
// models for translation and summaries, and the API keys saved on this computer (with Remove).
// Keys go to Rust (Windows Credential Manager); everything else is kept in settings.json.
import { getVersion } from "@tauri-apps/api/app";
import { showIndicator } from "./viewer";
import { applyUiStyle, getSetting, getTheme, getUiStyle, setSetting, setTheme, setUiStyle, THEMES, type Theme, type UiStyle } from "./settings";
import { registerOverlay, unregisterOverlay } from "./overlays";
import {
  aiEvents,
  callModel,
  clearKey,
  friendly,
  getAiConfig,
  hasKey,
  listModels,
  providerInfo,
  PROVIDERS,
  saveKey,
  setAiConfig,
  type AiError,
  type ProviderId,
} from "./llm";
import { getHfModels, LANGS, servedModels, setHfModels, SUGGESTED, translate, type HfModels, type LangId } from "./hf";

export type SettingsTab = "general" | "chat" | "hf" | "keys";

const el = document.createElement("div");
el.id = "ai-key";
el.hidden = true;
el.innerHTML = `
  <div class="panel">
    <header>
      <h2>Settings</h2>
      <button type="button" class="ai-x" title="Close (Esc)" aria-label="Close">×</button>
    </header>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="general">General</button>
      <button type="button" role="tab" data-tab="chat">Chat AI</button>
      <button type="button" role="tab" data-tab="hf">Translate &amp; summarize</button>
      <button type="button" role="tab" data-tab="keys">API keys</button>
    </nav>

    <div class="tab" data-tab="general">
      <label>Theme</label>
      <div class="segmented themes" role="group" aria-label="Theme">
        <button type="button" data-theme-pick="light">Light</button>
        <button type="button" data-theme-pick="dark">Dark</button>
        <button type="button" data-theme-pick="sepia">Sepia</button>
      </div>
      <p class="hint">Also with the d key.</p>
      <label>Pop-up style</label>
      <div class="segmented ui-styles" role="group" aria-label="Pop-up style">
        <button type="button" data-ui-pick="normal">Normal</button>
        <button type="button" data-ui-pick="glass">Liquid glass</button>
      </div>
      <label class="glass-row">Transparency <span class="glass-value"></span>
        <input name="glass" type="range" min="0" max="100" step="5" />
      </label>
      <p class="hint">For every pop-up: this window, the right-click menu, the chat, the answer cards, search and help.</p>
      <label>Translate and summarize into
        <select name="hflang"></select>
      </label>
      <p class="hint">The language the Translate and Summarize buttons use. You can also change it in the answer card.</p>
      <label>Keyboard shortcuts</label>
      <p class="hint">Press ? at any time to see every shortcut.</p>
      <p class="about"></p>
    </div>

    <form class="tab" data-tab="chat" hidden>
      <p>Chat, explanations and PDF summaries. Use a free key from Google AI Studio, Groq, Hugging Face
      or OpenRouter, a model running on this computer with Ollama, or Claude.</p>
      <label>Provider <select name="provider"></select></label>
      <p class="hint"></p>
      <label class="url-row">Address <input name="url" type="text" autocomplete="off" spellcheck="false" /></label>
      <label>Model
        <span class="model-row">
          <input name="model" type="text" list="ai-models" autocomplete="off" spellcheck="false" />
          <button type="button" class="load">Load models</button>
        </span>
      </label>
      <datalist id="ai-models"></datalist>
      <label class="key-row">API key <input name="key" type="password" autocomplete="off" spellcheck="false" /></label>
      <div class="row">
        <button type="submit" class="primary">Save and test</button>
        <span class="status" aria-live="polite"></span>
      </div>
    </form>

    <form class="tab" data-tab="hf" hidden>
      <p>Translation of selected English text into Hindi, Marathi, Assamese, Bengali and Arabic, and
      English summaries, use models that Hugging Face runs for you with your Hugging Face token.</p>
      <label>Hugging Face token <input name="hfkey" type="password" autocomplete="off" spellcheck="false" /></label>
      <p class="hint">huggingface.co/settings/tokens → Create new token → Fine-grained → tick “Make calls to Inference Providers”.
      The same token also works for the Hugging Face chat provider.</p>
      <label>Summarization model (English)
        <input name="sum" type="text" list="hf-sum" autocomplete="off" spellcheck="false" />
      </label>
      <datalist id="hf-sum"></datalist>
      <fieldset>
        <legend>Translation model for each language</legend>
        <div class="langs"></div>
      </fieldset>
      <div class="row">
        <button type="submit" class="primary">Save and test</button>
        <button type="button" class="load-hf">Show all served models</button>
        <span class="status" aria-live="polite"></span>
      </div>
    </form>

    <div class="tab" data-tab="keys" hidden>
      <p>API keys saved on this computer, in Windows Credential Manager. Removing a key turns off the
      features that use it until you add a key again.</p>
      <ul class="key-list"></ul>
    </div>
  </div>`;
document.body.append(el);

const tabButtons = [...el.querySelectorAll<HTMLButtonElement>(".tabs button")];
const tabs = [...el.querySelectorAll<HTMLElement>(".tab")];
let afterSave: (() => void) | null = null;

/** Open Settings on a tab (Ctrl+, opens General). */
export function openSettings(tab: SettingsTab = "general") {
  return openKeySetup(undefined, tab);
}

/** Open the settings on a tab. `then` runs once that tab's setup is saved and works. */
export async function openKeySetup(then?: () => void, tab: SettingsTab = "chat") {
  afterSave = then ?? null;
  if (el.hidden) {
    el.hidden = false;
    registerOverlay(el, close);
  }
  await showTab(tab);
}

function close() {
  if (el.hidden) return;
  el.hidden = true;
  unregisterOverlay(el);
  afterSave = null;
}

async function showTab(tab: SettingsTab) {
  for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of tabs) t.hidden = t.dataset.tab !== tab;
  if (tab === "general") await showGeneral();
  else if (tab === "chat") await showChat();
  else if (tab === "hf") await showHf();
  else await showKeys();
}

for (const b of tabButtons) b.addEventListener("click", () => void showTab(b.dataset.tab as SettingsTab));
el.querySelector(".ai-x")!.addEventListener("click", close);
el.addEventListener("click", (e) => {
  if (e.target === el) close();
});
el.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
});

// Anything marked data-open-settings (start screen, chat panel) opens Settings on that tab.
document.addEventListener("click", (e) => {
  const opener = (e.target as Element).closest<HTMLElement>("[data-open-settings]");
  if (opener) void openSettings((opener.dataset.openSettings || "general") as SettingsTab);
});

/** The tab's work is done: close and run what was waiting for it. */
function done(message: string) {
  const then = afterSave;
  close();
  showIndicator(message);
  then?.();
}

/** Run `fn` now if the chat provider is set up, otherwise after the user sets one up. */
export async function withKey(fn: () => void) {
  if (await hasKey((await getAiConfig()).provider)) fn();
  else void openKeySetup(fn, "chat");
}

/** Run `fn` now if a Hugging Face token is saved, otherwise after the user adds one. */
export async function withHfToken(fn: () => void) {
  if (await hasKey("huggingface")) fn();
  else void openKeySetup(fn, "hf");
}

// ---------------------------------------------------------------------------
// General

const general = el.querySelector<HTMLElement>('.tab[data-tab="general"]')!;
const themeButtons = [...general.querySelectorAll<HTMLButtonElement>("[data-theme-pick]")];
const langSelect = general.querySelector<HTMLSelectElement>('[name="hflang"]')!;
langSelect.append(new Option("English only (summaries)", "en"));
for (const l of LANGS) langSelect.append(new Option(`${l.name} · ${l.native}`, l.id));

async function showGeneral() {
  markTheme();
  markUiStyle();
  const lang = await getSetting<string>("hfLanguage");
  langSelect.value = lang && [...langSelect.options].some((o) => o.value === lang) ? lang : "hi";
  general.querySelector(".about")!.textContent = `Minimal PDF ${await getVersion().catch(() => "")}`;
  (themeButtons.find((b) => b.getAttribute("aria-pressed") === "true") ?? themeButtons[0]).focus();
}

function markTheme() {
  const theme = getTheme();
  for (const b of themeButtons) b.setAttribute("aria-pressed", String(b.dataset.themePick === theme));
}

for (const b of themeButtons) {
  b.addEventListener("click", async () => {
    const theme = b.dataset.themePick as Theme;
    if (THEMES.includes(theme)) await setTheme(theme);
    markTheme();
  });
}

const uiButtons = [...general.querySelectorAll<HTMLButtonElement>("[data-ui-pick]")];
const glassRow = general.querySelector<HTMLElement>(".glass-row")!;
const glassSlider = general.querySelector<HTMLInputElement>('[name="glass"]')!;
const glassValue = general.querySelector<HTMLElement>(".glass-value")!;

function markUiStyle() {
  const u = getUiStyle();
  for (const b of uiButtons) b.setAttribute("aria-pressed", String(b.dataset.uiPick === u.style));
  glassRow.hidden = u.style !== "glass";
  glassSlider.value = String(u.transparency);
  glassValue.textContent = `${u.transparency}%`;
}

for (const b of uiButtons) {
  b.addEventListener("click", async () => {
    await setUiStyle({ ...getUiStyle(), style: b.dataset.uiPick as UiStyle["style"] });
    markUiStyle();
  });
}

// Live while dragging; saved when let go.
glassSlider.addEventListener("input", () => {
  applyUiStyle({ ...getUiStyle(), transparency: Number(glassSlider.value) });
  glassValue.textContent = `${glassSlider.value}%`;
});
glassSlider.addEventListener("change", () => void setUiStyle({ ...getUiStyle(), transparency: Number(glassSlider.value) }));

langSelect.addEventListener("change", () => {
  void setSetting("hfLanguage", langSelect.value);
  showIndicator("Saved");
});

// ---------------------------------------------------------------------------
// Chat AI

const chatForm = el.querySelector<HTMLFormElement>('form[data-tab="chat"]')!;
const providerSel = chatForm.querySelector<HTMLSelectElement>('[name="provider"]')!;
const urlInput = chatForm.querySelector<HTMLInputElement>('[name="url"]')!;
const modelInput = chatForm.querySelector<HTMLInputElement>('[name="model"]')!;
const keyInput = chatForm.querySelector<HTMLInputElement>('[name="key"]')!;
const modelList = chatForm.querySelector<HTMLDataListElement>("#ai-models")!;
const chatHint = chatForm.querySelector<HTMLElement>(".hint")!;
const chatStatus = chatForm.querySelector<HTMLElement>(".status")!;
for (const p of PROVIDERS) providerSel.append(new Option(p.label, p.id));

async function showChat() {
  const c = await getAiConfig();
  providerSel.value = c.provider;
  await showProvider(c.model);
  (keyInput.closest("label")!.hidden ? modelInput : keyInput).focus();
}

/** Fill the form for the selected provider. */
async function showProvider(model?: string) {
  const p = providerInfo(providerSel.value as ProviderId);
  const saved = await hasKey(p.id);
  chatHint.textContent = p.keyHint;
  urlInput.closest("label")!.hidden = !p.editableUrl;
  urlInput.value = "";
  urlInput.placeholder = p.baseUrl ?? "https://api.example.com/v1";
  modelInput.value = model ?? p.defaultModel;
  modelInput.placeholder = p.defaultModel || "model name";
  modelList.replaceChildren();
  keyInput.value = "";
  keyInput.placeholder = saved ? "Saved. Paste a new key to replace it." : p.keyOptional ? "Optional" : "Paste your API key";
  chatStatus.textContent = "";
}

providerSel.addEventListener("change", async () => {
  const c = await getAiConfig();
  await showProvider(c.provider === providerSel.value ? c.model : undefined);
});

/** Save what was typed for this provider: the key, and the address for Ollama / custom endpoints. */
async function saveTyped(id: ProviderId) {
  const p = providerInfo(id);
  const key = keyInput.value.trim();
  const url = urlInput.value.trim();
  if (key || url || (p.keyOptional && !(await hasKey(id)))) await saveKey(id, key, url || p.baseUrl);
  else if (!(await hasKey(id))) throw new Error("Paste your API key first.");
  keyInput.value = "";
}

chatForm.querySelector(".load")!.addEventListener("click", async () => {
  const id = providerSel.value as ProviderId;
  chatStatus.textContent = "Loading models…";
  try {
    await saveTyped(id);
    const models = await listModels(id);
    modelList.replaceChildren(...models.map((m) => new Option(m, m)));
    chatStatus.textContent = models.length ? `${models.length} models: pick one in the Model box.` : "The provider listed no models.";
    modelInput.focus();
  } catch (e) {
    chatStatus.textContent = friendly(e);
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = providerSel.value as ProviderId;
  const p = providerInfo(id);
  const model = modelInput.value.trim() || p.defaultModel;
  if (!model) {
    chatStatus.textContent = "Enter a model name (or use Load models).";
    return;
  }
  chatStatus.textContent = "Checking…";
  try {
    await saveTyped(id);
    // A tiny request proves the key and model work before the user relies on them.
    const cfg = { provider: id, model };
    await callModel({ system: [], messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 256, effort: "low" }, { cancelled: false }, {}, cfg);
    const before = await getAiConfig();
    await setAiConfig(cfg);
    if (before.provider !== id || before.model !== model) aiEvents.dispatchEvent(new Event("change"));
    done(`${p.label} connected`);
  } catch (err) {
    if ((err as AiError).kind === "auth") await clearKey(id);
    chatStatus.textContent = friendly(err);
  }
});

// ---------------------------------------------------------------------------
// Translate & summarize (Hugging Face)

const hfForm = el.querySelector<HTMLFormElement>('form[data-tab="hf"]')!;
const hfKeyInput = hfForm.querySelector<HTMLInputElement>('[name="hfkey"]')!;
const sumInput = hfForm.querySelector<HTMLInputElement>('[name="sum"]')!;
const sumList = hfForm.querySelector<HTMLDataListElement>("#hf-sum")!;
const hfStatus = hfForm.querySelector<HTMLElement>(".status")!;
const langRows = hfForm.querySelector<HTMLElement>(".langs")!;
const langInputs = new Map<LangId, HTMLInputElement>();
const langLists = new Map<LangId, HTMLDataListElement>();
for (const l of LANGS) {
  const label = document.createElement("label");
  label.textContent = `${l.name} `;
  const native = document.createElement("span");
  native.className = "native";
  native.textContent = l.native;
  const input = document.createElement("input");
  input.type = "text";
  input.name = `tr-${l.id}`;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("list", `hf-tr-${l.id}`);
  const list = document.createElement("datalist");
  list.id = `hf-tr-${l.id}`;
  label.append(native, input);
  langRows.append(label, list);
  langInputs.set(l.id, input);
  langLists.set(l.id, list);
}

const options = (ids: string[]) => [...new Set(ids)].map((m) => new Option(m, m));

async function showHf() {
  const m = await getHfModels();
  const saved = await hasKey("huggingface");
  hfKeyInput.value = "";
  hfKeyInput.placeholder = saved ? "Saved. Paste a new token to replace it." : "hf_…";
  sumInput.value = m.summarize;
  sumList.replaceChildren(...options(SUGGESTED.summarize));
  for (const l of LANGS) {
    langInputs.get(l.id)!.value = m.translate[l.id];
    langLists.get(l.id)!.replaceChildren(...options(SUGGESTED.translate[l.id]));
  }
  hfStatus.textContent = "";
  (saved ? sumInput : hfKeyInput).focus();
}

hfForm.querySelector(".load-hf")!.addEventListener("click", async () => {
  hfStatus.textContent = "Loading the models Hugging Face serves…";
  try {
    const [tr, sum] = await Promise.all([servedModels("translation"), servedModels("summarization")]);
    sumList.replaceChildren(...options([...SUGGESTED.summarize, ...sum]));
    // Translation models that start from English (or translate between many languages).
    const fromEnglish = tr.filter((m) => /(^|[-_/])en[-_]|madlad|nllb|m2m100|mbart|mul/i.test(m));
    for (const l of LANGS) langLists.get(l.id)!.replaceChildren(...options([...SUGGESTED.translate[l.id], ...fromEnglish]));
    hfStatus.textContent = `${fromEnglish.length} translation and ${sum.length} summarization models: pick in the boxes.`;
  } catch (e) {
    hfStatus.textContent = friendly(e);
  }
});

hfForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const m: HfModels = { summarize: sumInput.value.trim(), translate: {} as Record<LangId, string> };
  for (const l of LANGS) m.translate[l.id] = langInputs.get(l.id)!.value.trim();
  if (!m.summarize || LANGS.some((l) => !m.translate[l.id])) {
    hfStatus.textContent = "Choose a model in every box.";
    return;
  }
  hfStatus.textContent = "Checking…";
  try {
    const token = hfKeyInput.value.trim();
    if (token) await saveKey("huggingface", token);
    else if (!(await hasKey("huggingface"))) throw new Error("Paste your Hugging Face token first.");
    hfKeyInput.value = "";
    await setHfModels(m);
    const test = await translate("Hello.", "hi");
    done(`Hugging Face connected: “Hello.” → “${test}”`);
  } catch (err) {
    if ((err as AiError).kind === "auth") await clearKey("huggingface");
    hfStatus.textContent = friendly(err);
  }
});

// ---------------------------------------------------------------------------
// API keys

const keyList = el.querySelector<HTMLElement>(".key-list")!;
const USES: Partial<Record<ProviderId, string>> = { huggingface: "chat, translation and summaries" };

async function showKeys() {
  const rows: HTMLElement[] = [];
  for (const p of PROVIDERS) {
    if (!(await hasKey(p.id))) continue;
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.label;
    const use = document.createElement("span");
    use.className = "use";
    use.textContent = USES[p.id] ?? (p.keyOptional ? "address saved" : "chat");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.title = `Remove the ${p.label} key from this computer`;
    remove.addEventListener("click", async () => {
      await clearKey(p.id);
      aiEvents.dispatchEvent(new Event("change"));
      showIndicator(`${p.label} key removed`);
      await showKeys();
    });
    li.append(name, use, remove);
    rows.push(li);
  }
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No keys saved.";
    rows.push(li);
  }
  keyList.replaceChildren(...rows);
  keyList.querySelector("button")?.focus();
}
