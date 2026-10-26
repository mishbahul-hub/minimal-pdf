// Settings (Ctrl+,, the gear in the right-click menu and the chat, or the start screen), in tabs:
// General (theme, pop-up style, translation language, version), the chat AI provider and model, the
// offline translation and summary models (download / remove), and the API keys saved on this
// computer (with Remove).
// Keys go to Rust (Windows Credential Manager); everything else is kept in settings.json.
import { getVersion } from "@tauri-apps/api/app";
import { showIndicator } from "./viewer";
import { getSetting, getTheme, getUiStyle, previewUiStyle, setSetting, setTheme, setUiStyle, THEMES, type Theme, type UiStyle } from "./settings";
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
import { downloadModel, LANGS, MODEL_INFO, modelDevice, modelStatus, removeModels } from "./hf";
import type { Which } from "./hfworker";

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
        <input name="glass" type="range" min="0" max="100" step="1" />
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

    <div class="tab" data-tab="hf" hidden>
      <p>Translate (into Hindi, Marathi, Assamese, Bengali and Arabic) and Summarize run open models
      on this computer: no key, and nothing you select leaves your computer. Each model downloads
      once, the first time it's used (or now), then works offline.</p>
      <p class="hint device"></p>
      <ul class="model-list"></ul>
      <div class="row">
        <button type="button" class="primary download-models">Download now</button>
        <button type="button" class="remove-models">Remove downloaded models</button>
        <span class="status" aria-live="polite"></span>
      </div>
      <progress class="model-progress" max="100" value="0" hidden></progress>
      <p class="hint">The translation language is in General. NLLB-200 is licensed for non-commercial use.</p>
    </div>

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

/** Translate / Summarize need nothing set up: the models download on first use. */
export function withOfflineModels(fn: () => void) {
  fn();
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
  showSlider(u.transparency);
}

/** The number and the filled part of the track follow the thumb. */
function showSlider(value: number) {
  glassValue.textContent = `${value}%`;
  glassSlider.style.setProperty("--fill", `${value}%`);
}

for (const b of uiButtons) {
  b.addEventListener("click", async () => {
    await setUiStyle({ ...getUiStyle(), style: b.dataset.uiPick as UiStyle["style"] });
    markUiStyle();
  });
}

// Live while dragging, at most once a frame (blurring what's behind every pop-up is the costly part);
// saved only when let go.
let sliderFrame = 0;
glassSlider.addEventListener("input", () => {
  showSlider(Number(glassSlider.value));
  sliderFrame ||= requestAnimationFrame(() => {
    sliderFrame = 0;
    previewUiStyle({ ...getUiStyle(), transparency: Number(glassSlider.value) });
  });
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
// Translate & summarize (offline models)

const hfTab = el.querySelector<HTMLElement>('.tab[data-tab="hf"]')!;
const hfModelList = hfTab.querySelector<HTMLElement>(".model-list")!;
const hfStatus = hfTab.querySelector<HTMLElement>(".status")!;
const hfDevice = hfTab.querySelector<HTMLElement>(".device")!;
const modelProgress = hfTab.querySelector<HTMLProgressElement>(".model-progress")!;
const downloadBtn = hfTab.querySelector<HTMLButtonElement>(".download-models")!;
const removeBtn = hfTab.querySelector<HTMLButtonElement>(".remove-models")!;
let downloading = false;

async function showHf() {
  hfStatus.textContent = downloading ? hfStatus.textContent : "Checking…";
  let status: Record<Which, boolean>;
  const device = await modelDevice();
  hfDevice.textContent = device === "gpu" ? "Runs on your graphics card (GPU): fast." : "Runs on your processor (CPU): no usable graphics card found, so it is slower.";
  try {
    status = await modelStatus();
  } catch (e) {
    hfStatus.textContent = friendly(e);
    return;
  }
  hfModelList.replaceChildren(
    ...(Object.keys(MODEL_INFO) as Which[]).map((which) => {
      const m = MODEL_INFO[which];
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${m.use}: ${m.name}`;
      const meta = document.createElement("span");
      meta.className = "use";
      meta.textContent = `${m.size[device]} · ${m.licence}`;
      const state = document.createElement("span");
      state.className = status[which] ? "state ok" : "state";
      state.textContent = status[which] ? "Downloaded" : "Not downloaded";
      li.append(name, meta, state);
      return li;
    }),
  );
  const all = Object.values(status).every(Boolean);
  const any = Object.values(status).some(Boolean);
  downloadBtn.disabled = all || downloading;
  removeBtn.disabled = !any || downloading;
  if (!downloading) hfStatus.textContent = all ? "Ready: works offline." : "";
}

downloadBtn.addEventListener("click", async () => {
  if (downloading) return;
  downloading = true;
  downloadBtn.disabled = removeBtn.disabled = true;
  modelProgress.hidden = false;
  try {
    for (const which of Object.keys(MODEL_INFO) as Which[]) {
      const m = MODEL_INFO[which];
      hfStatus.textContent = `Downloading ${m.name}…`;
      modelProgress.value = 0;
      await downloadModel(which, (loaded, total) => {
        if (!total) return;
        modelProgress.value = Math.round((loaded / total) * 100);
        hfStatus.textContent = `Downloading ${m.name}: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`;
      });
    }
    downloading = false;
    showIndicator("Translation and summary models are ready");
  } catch (e) {
    downloading = false;
    hfStatus.textContent = friendly(e);
  }
  modelProgress.hidden = true;
  await showHf();
});

removeBtn.addEventListener("click", async () => {
  hfStatus.textContent = "Removing…";
  try {
    await removeModels();
    showIndicator("Downloaded models removed");
  } catch (e) {
    hfStatus.textContent = friendly(e);
  }
  await showHf();
});

// ---------------------------------------------------------------------------
// API keys

const keyList = el.querySelector<HTMLElement>(".key-list")!;
const USES: Partial<Record<ProviderId, string>> = {};

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
