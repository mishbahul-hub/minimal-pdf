// Saved app data: theme, per-file reading positions, recent files. Never touches the PDFs.
import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  events,
  getDoc,
  getPosition,
  setPosition,
  setStartExtras,
  showStartScreen,
  openPath,
  showIndicator,
  type DocInfo,
  type Position,
} from "./viewer";

export type Theme = "light" | "dark" | "sepia";
export const THEMES: Theme[] = ["light", "dark", "sepia"];
export const THEME_NAMES: Record<Theme, string> = { light: "Light theme", dark: "Dark theme", sepia: "Sepia theme" };

type SavedPosition = Position & { opened: number; size: number };
type Recent = { path: string; name: string; opened: number };

const MAX_RECENTS = 10;
const SAVE_DEBOUNCE_MS = 500;
const THEME_CACHE_KEY = "theme"; // localStorage mirror so the theme applies before the store loads

const storeReady: Promise<Store> = load("settings.json", { autoSave: 300, defaults: {} });

/** Generic access to the settings store for other modules (e.g. annotation tool styles). */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await (await storeReady).get<T>(key)) ?? undefined;
}

export async function setSetting(key: string, value: unknown) {
  await (await storeReady).set(key, value);
}

// ---------------------------------------------------------------------------
// Theme

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Storage unavailable: the store still remembers it.
  }
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function cachedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_CACHE_KEY) as Theme | null;
    return t && THEMES.includes(t) ? t : null;
  } catch {
    return null;
  }
}

/** First launch follows the system theme; after that the user's choice is remembered. */
async function initTheme() {
  applyTheme(cachedTheme() ?? systemTheme());
  const saved = (await (await storeReady).get<Theme>("theme")) ?? null;
  if (saved && THEMES.includes(saved)) applyTheme(saved);
}

export function getTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? "light";
}

export async function setTheme(theme: Theme) {
  applyTheme(theme);
  showIndicator(THEME_NAMES[theme]);
  await (await storeReady).set("theme", theme);
}

export async function cycleTheme() {
  const current = getTheme();
  await setTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
}

// ---------------------------------------------------------------------------
// Pop-up style: "normal" (solid) or "glass" (liquid glass) with a transparency of 0–100 %

export type UiStyle = { style: "normal" | "glass"; transparency: number };
const UI_DEFAULT: UiStyle = { style: "glass", transparency: 80 };
const UI_CACHE_KEY = "uiStyle"; // localStorage mirror, so pop-ups look right before the store loads
let uiStyle: UiStyle = UI_DEFAULT;

function validUi(u: unknown): UiStyle | null {
  const v = u as Partial<UiStyle> | null;
  if (!v || (v.style !== "normal" && v.style !== "glass") || typeof v.transparency !== "number") return null;
  return { style: v.style, transparency: Math.min(100, Math.max(0, Math.round(v.transparency))) };
}

/** Show a pop-up style without remembering it (live, while the slider moves). */
export function previewUiStyle(u: UiStyle) {
  uiStyle = u;
  const root = document.documentElement;
  root.dataset.ui = u.style;
  root.style.setProperty("--glass-t", String(u.transparency / 100));
}

/** Apply a pop-up style and remember it on this computer. */
export function applyUiStyle(u: UiStyle) {
  previewUiStyle(u);
  try {
    localStorage.setItem(UI_CACHE_KEY, JSON.stringify(u));
  } catch {
    // Storage unavailable: the store still remembers it.
  }
}

export function getUiStyle(): UiStyle {
  return uiStyle;
}

export async function setUiStyle(u: UiStyle) {
  applyUiStyle(u);
  await (await storeReady).set("uiStyle", u);
}

async function initUiStyle() {
  const saved = validUi(await (await storeReady).get("uiStyle"));
  if (saved) applyUiStyle(saved);
}

// Before anything shows: the last style used on this computer, or the default.
applyUiStyle(
  (() => {
    try {
      return validUi(JSON.parse(localStorage.getItem(UI_CACHE_KEY) ?? "null")) ?? UI_DEFAULT;
    } catch {
      return UI_DEFAULT;
    }
  })(),
);

// ---------------------------------------------------------------------------
// Positions

async function savedPosition(doc: DocInfo): Promise<SavedPosition | null> {
  const all = (await (await storeReady).get<Record<string, SavedPosition>>("positions")) ?? {};
  const pos = all[doc.key];
  // A different file at the same path (replaced or edited) shouldn't jump to a wrong place.
  return pos && pos.size === doc.size ? pos : null;
}

async function savePosition() {
  const doc = getDoc();
  const pos = getPosition();
  if (!doc || !pos) return;
  const store = await storeReady;
  const all = (await store.get<Record<string, SavedPosition>>("positions")) ?? {};
  all[doc.key] = { ...pos, opened: Date.now(), size: doc.size };
  await store.set("positions", all);
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void savePosition(), SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Recent files

let recents: Recent[] = [];

async function loadRecents() {
  recents = (await (await storeReady).get<Recent[]>("recent")) ?? [];
}

async function addRecent(doc: DocInfo) {
  // Files opened without a real path (tests) have key === name; don't list them.
  if (!/[\\/]/.test(doc.key)) return;
  recents = [
    { path: doc.key, name: doc.name, opened: Date.now() },
    ...recents.filter((r) => r.path !== doc.key),
  ].slice(0, MAX_RECENTS);
  await (await storeReady).set("recent", recents);
}

async function removeRecent(path: string) {
  recents = recents.filter((r) => r.path !== path);
  await (await storeReady).set("recent", recents);
}

/** Open recent file number n (1-based), from the start screen. */
export async function openRecent(n: number) {
  if (getDoc()) return; // only on the start screen
  const r = recents[n - 1];
  if (!r) return;
  try {
    // Files from past sessions aren't in the fs scope; Rust allows a path only if it's in this list.
    await invoke("allow_recent", { path: r.path });
  } catch (err) {
    console.error(err);
  }
  await openPath(r.path);
}

function folderOf(path: string) {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("\\");
}

function recentList(): Node | null {
  if (!recents.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "recents";
  const h = document.createElement("h2");
  h.textContent = "Recent";
  const ol = document.createElement("ol");
  recents.forEach((r, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.title = r.path;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i < 9 ? String(i + 1) : "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = r.name;
    const dir = document.createElement("span");
    dir.className = "dir";
    dir.textContent = folderOf(r.path);
    b.append(num, name, dir);
    b.addEventListener("click", () => void openRecent(i + 1));
    li.append(b);
    ol.append(li);
  });
  wrap.append(h, ol);
  return wrap;
}

/** Under the start message: the recent files, and a way into Settings. */
function startExtras(): Node {
  const frag = document.createDocumentFragment();
  const recent = recentList();
  if (recent) frag.append(recent);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "start-settings";
  b.dataset.openSettings = "general"; // handled in aisettings.ts
  b.innerHTML = `<span>Settings</span><kbd>Ctrl+,</kbd>`;
  frag.append(b);
  return frag;
}

// ---------------------------------------------------------------------------
// Wiring

export async function initSettings() {
  await initTheme();
  await initUiStyle();
  await loadRecents();
  setStartExtras(startExtras);

  events.addEventListener("open", async (e) => {
    const doc = (e as CustomEvent<DocInfo>).detail;
    const pos = await savedPosition(doc);
    if (pos && getDoc() === doc) setPosition(pos);
    await addRecent(doc);
    scheduleSave();
  });
  events.addEventListener("scroll", scheduleSave);
  events.addEventListener("openfailed", (e) => {
    void removeRecent((e as CustomEvent<{ key: string }>).detail.key).then(() => {
      if (!getDoc()) showStartScreen();
    });
  });

  // Save once more when the window closes (the handler runs before the window is destroyed).
  await getCurrentWindow().onCloseRequested(async () => {
    clearTimeout(saveTimer);
    await savePosition();
    await (await storeReady).save();
  });
}
