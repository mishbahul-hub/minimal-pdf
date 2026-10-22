// Text search (/): page-by-page in the background, results as they arrive, highlights in the text layer.
import {
  events,
  getCurrentPage,
  getPageCount,
  getPdfPage,
  getTextContent,
  getTextLayer,
  scrollToPagePoint,
  type TextLayerInfo,
} from "./viewer";
import { registerOverlay, unregisterOverlay } from "./overlays";
import * as pdfjs from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

const TYPE_DEBOUNCE_MS = 200;
const YIELD_EVERY = 16; // pages between yields to the UI when the text is already cached

/**
 * A page's text, normalised for matching: lower case, runs of whitespace (including line breaks)
 * collapsed to one space. `item[i]` / `char[i]` map each normalised character back to the text
 * item (= text layer div) and the character inside it.
 */
type PageIndex = {
  text: string;
  item: Int32Array;
  char: Int32Array;
  // Baseline position of each text item on the page (CSS px at zoom 1), for scrolling to a match.
  pos: { x: number; y: number }[];
};

type Match = { page: number; start: number; end: number };

const searchEl = document.querySelector<HTMLFormElement>("#search")!;
const inputEl = document.querySelector<HTMLInputElement>("#search-input")!;
const statusEl = document.querySelector<HTMLElement>("#search-status")!;
const closeEl = document.querySelector<HTMLButtonElement>("#search-close")!;

const indexCache = new Map<number, Promise<PageIndex>>();
let matches: Match[] = [];
let current = -1;
let searchId = 0; // incremented to cancel a running search
let query = "";
let typeTimer = 0;
let searching = false;

// ---------------------------------------------------------------------------
// Indexing

function buildIndex(n: number, content: TextContent): PageIndex {
  const vp = getPdfPage(n)!.getViewport({ scale: pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS });
  let text = "";
  const item: number[] = [];
  const char: number[] = [];
  const pos: { x: number; y: number }[] = [];
  let lastSpace = true;
  let i = 0;
  const push = (c: string, it: number, ch: number) => {
    text += c;
    item.push(it);
    char.push(ch);
  };
  for (const raw of content.items) {
    if (!("str" in raw)) continue; // marked content: no text layer div either
    const [x, y] = vp.convertToViewportPoint(raw.transform[4], raw.transform[5]);
    pos.push({ x, y });
    const s = raw.str;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (/\s/.test(c)) {
        if (!lastSpace) push(" ", i, j);
        lastSpace = true;
      } else {
        // toLowerCase can (rarely) produce more than one character; map each to the same source.
        for (const lc of c.toLowerCase()) push(lc, i, j);
        lastSpace = false;
      }
    }
    // Items on different lines are joined with a space; items on the same line join directly
    // (PDFs often split one word into several items).
    if (raw.hasEOL && !lastSpace) {
      push(" ", i, s.length);
      lastSpace = true;
    }
    i++;
  }
  return { text, item: Int32Array.from(item), char: Int32Array.from(char), pos };
}

function pageIndex(n: number): Promise<PageIndex> {
  let p = indexCache.get(n);
  if (!p) {
    p = getTextContent(n)!.then((c) => buildIndex(n, c));
    indexCache.set(n, p);
  }
  return p;
}

function normalise(q: string) {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Searching

async function runSearch(q: string) {
  const id = ++searchId;
  clearAllHighlights();
  matches = [];
  current = -1;
  query = normalise(q);
  if (!query) {
    searching = false;
    setStatus("");
    return;
  }

  const total = getPageCount();
  const startPage = getCurrentPage();
  let anyText = false;
  searching = true;
  for (let k = 0; k < total; k++) {
    // Start at the current page and wrap around, so the first hit is the nearest one ahead.
    const n = ((startPage - 1 + k) % total) + 1;
    const cached = indexCache.has(n);
    const idx = await pageIndex(n);
    if (id !== searchId) return; // a newer query replaced this one
    if (idx.text.trim()) anyText = true;

    const found: Match[] = [];
    for (let at = idx.text.indexOf(query); at !== -1; at = idx.text.indexOf(query, at + 1)) {
      found.push({ page: n, start: at, end: at + query.length });
    }
    if (found.length) {
      // Keep matches in document order.
      let insertAt = matches.findIndex((m) => m.page > n);
      if (insertAt === -1) insertAt = matches.length;
      matches.splice(insertAt, 0, ...found);
      if (current === -1) {
        current = insertAt;
        showMatch(current);
      } else if (insertAt <= current) {
        current += found.length;
      }
      highlightPage(n);
    }
    if (k % 4 === 0 || found.length) setStatus(`Searching… page ${k + 1} / ${total}`, true);
    if (cached && k % YIELD_EVERY === 0) await new Promise((r) => setTimeout(r));
  }
  searching = false;
  if (matches.length) setStatus(counter());
  else setStatus(anyText ? "No matches" : "No searchable text in this PDF");
}

function counter() {
  return `${current + 1} of ${matches.length}${searching ? "+" : ""}`;
}

function setStatus(text: string, progress = false) {
  statusEl.textContent = progress && matches.length ? `${counter()} · ${text}` : text;
}

/** Scroll to match i and mark it as the selected one. */
async function showMatch(i: number) {
  const m = matches[i];
  if (!m) return;
  const prevPage = matches[current]?.page;
  current = i;
  const idx = await pageIndex(m.page);
  const p = idx.pos[idx.item[m.start]];
  if (p) scrollToPagePoint(m.page, p.x, p.y);
  if (prevPage && prevPage !== m.page) highlightPage(prevPage);
  highlightPage(m.page);
  if (!searching) setStatus(counter());
}

export function nextMatch() {
  if (matches.length) void showMatch((current + 1) % matches.length);
}

export function prevMatch() {
  if (matches.length) void showMatch((current - 1 + matches.length) % matches.length);
}

/** Whether n / N should step through matches instead of pages. */
export function searchActive() {
  return !searchEl.hidden && matches.length > 0;
}

// ---------------------------------------------------------------------------
// Highlights (in the text layer, only for pages that are currently rendered)

function highlightPage(n: number) {
  const layer = getTextLayer(n);
  if (!layer) return;
  clearHighlights(layer);
  const pageMatches = matches.map((m, i) => ({ m, i })).filter(({ m }) => m.page === n);
  if (!pageMatches.length) return;
  void pageIndex(n).then((idx) => {
    if (getTextLayer(n) !== layer) return;
    // Character ranges per text div: [from, to) plus whether it's the selected match.
    const ranges = new Map<number, { from: number; to: number; selected: boolean }[]>();
    for (const { m, i } of pageMatches) {
      for (let k = m.start; k < m.end; ) {
        const it = idx.item[k];
        let to = k;
        while (to < m.end && idx.item[to] === it) to++;
        const from = idx.char[k];
        const end = idx.char[to - 1] + 1;
        const list = ranges.get(it) ?? [];
        list.push({ from, to: end, selected: i === current });
        ranges.set(it, list);
        k = to;
      }
    }
    for (const [it, list] of ranges) markDiv(layer, it, list);
  });
}

function markDiv(layer: TextLayerInfo, it: number, list: { from: number; to: number; selected: boolean }[]) {
  const div = layer.textDivs[it];
  const str = layer.strs[it];
  if (!div || str === undefined) return;
  list.sort((a, b) => a.from - b.from);
  const parts: Node[] = [];
  let at = 0;
  for (const r of list) {
    if (r.from < at) continue; // overlapping matches: keep the first
    if (r.from > at) parts.push(document.createTextNode(str.slice(at, r.from)));
    const mark = document.createElement("mark");
    if (r.selected) mark.className = "selected";
    mark.textContent = str.slice(r.from, r.to);
    parts.push(mark);
    at = r.to;
  }
  if (at < str.length) parts.push(document.createTextNode(str.slice(at)));
  div.replaceChildren(...parts);
  div.dataset.marked = "";
}

function clearHighlights(layer: TextLayerInfo) {
  layer.textDivs.forEach((div, i) => {
    if (div.dataset.marked === undefined) return;
    div.textContent = layer.strs[i];
    delete div.dataset.marked;
  });
}

function clearAllHighlights() {
  const pages = new Set(matches.map((m) => m.page));
  for (const n of pages) {
    const layer = getTextLayer(n);
    if (layer) clearHighlights(layer);
  }
}

// ---------------------------------------------------------------------------
// Search bar

export function openSearch() {
  if (!getPageCount()) return;
  if (searchEl.hidden) {
    searchEl.hidden = false;
    registerOverlay(searchEl, closeSearch);
  }
  inputEl.focus();
  inputEl.select();
}

function closeSearch() {
  if (searchEl.hidden) return;
  searchEl.hidden = true;
  unregisterOverlay(searchEl);
  searchId++; // stop a running search
  clearAllHighlights();
  matches = [];
  current = -1;
  searching = false;
  inputEl.blur();
}

searchEl.addEventListener("submit", (e) => e.preventDefault());
closeEl.addEventListener("click", closeSearch);

inputEl.addEventListener("input", () => {
  clearTimeout(typeTimer);
  typeTimer = window.setTimeout(() => void runSearch(inputEl.value), TYPE_DEBOUNCE_MS);
});

// Shortcuts are ignored while typing, so the box handles its own Enter / Shift+Enter / Esc.
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    // Enter before the debounce fired: search now.
    if (normalise(inputEl.value) !== query) {
      clearTimeout(typeTimer);
      void runSearch(inputEl.value);
    } else if (e.shiftKey) prevMatch();
    else nextMatch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});

events.addEventListener("pagerender", (e) => {
  const layer = (e as CustomEvent<TextLayerInfo>).detail;
  if (matches.some((m) => m.page === layer.n)) highlightPage(layer.n);
});

events.addEventListener("close", () => {
  closeSearch();
  indexCache.clear();
  inputEl.value = "";
  query = "";
  setStatus("");
});

// ---------------------------------------------------------------------------
// Document text for the AI tools (ai.ts)

export type TextHit = { page: number; hits: number; snippet: string };

const STOPWORDS = new Set(
  "the a an and or of to in on for with by is are was were be been it this that these those as at from what which who how why when where does do did about into than then there their its can".split(" "),
);

/**
 * Pages matching a query, best first. The whole phrase counts most; each keyword also counts,
 * so a question phrased differently from the text still finds the right pages.
 */
export async function searchText(q: string, maxResults = 8): Promise<TextHit[]> {
  const phrase = normalise(q);
  if (!phrase) return [];
  const words = [...new Set(phrase.split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
  const scored: (TextHit & { score: number })[] = [];
  for (let n = 1; n <= getPageCount(); n++) {
    const idx = await pageIndex(n);
    const count = (s: string) => {
      let c = 0;
      for (let at = idx.text.indexOf(s); at !== -1 && c < 50; at = idx.text.indexOf(s, at + 1)) c++;
      return c;
    };
    const phraseHits = count(phrase);
    let matched = 0;
    let wordHits = 0;
    for (const w of words) {
      const c = count(w);
      if (c) matched++;
      wordHits += c;
    }
    if (!phraseHits && !matched) continue;
    // Snippet around the phrase, or the first keyword found.
    const at = phraseHits ? idx.text.indexOf(phrase) : (words.map((w) => idx.text.indexOf(w)).find((i) => i >= 0) ?? 0);
    const snippet = (at > 80 ? "…" : "") + idx.text.slice(Math.max(0, at - 80), at + 160).trim() + "…";
    scored.push({ page: n, hits: phraseHits + wordHits, snippet, score: phraseHits * 10 + matched * 3 + Math.min(wordHits, 20) * 0.2 });
    if (n % YIELD_EVERY === 0) await new Promise((r) => setTimeout(r));
  }
  scored.sort((a, b) => b.score - a.score || a.page - b.page);
  return scored.slice(0, maxResults).map(({ page, hits, snippet }) => ({ page, hits, snippet }));
}

/** A page's text with its original case and line breaks, for reading. */
export async function pageText(n: number): Promise<string> {
  const content = await getTextContent(n);
  if (!content) return "";
  let out = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    out += item.str + (item.hasEOL ? "\n" : "");
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text items with their boxes on the page (CSS px at zoom 1), e.g. to find highlighted text. */
export async function textBoxes(n: number): Promise<{ str: string; x: number; y: number; w: number; h: number }[]> {
  const content = await getTextContent(n);
  const page = getPdfPage(n);
  if (!content || !page) return [];
  const scale = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS;
  const vp = page.getViewport({ scale });
  const boxes = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
    const h = Math.hypot(item.transform[2], item.transform[3]) * scale;
    boxes.push({ str: item.str, x, y: y - h, w: item.width * scale, h });
  }
  return boxes;
}
