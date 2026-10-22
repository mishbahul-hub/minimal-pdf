import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const APP_NAME = "Minimal PDF";
const START_MESSAGE = "Press Ctrl+O to open a PDF";

// 100% zoom = real paper size: 1 PDF point is 96/72 CSS pixels.
const CSS_UNITS = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const FIT_PADDING = 16; // must match #pages padding
const MAX_RENDERED = 10; // canvases kept alive (more only if more are on screen)
const MAX_CONCURRENT = 2; // renders in flight at once
const SETTLE_MS = 150; // re-render this long after the last zoom change
const INDICATOR_MS = 1200;

export type ZoomMode = "custom" | "fit-width" | "fit-page";

type Slot = {
  n: number;
  page: pdfjs.PDFPageProxy;
  baseW: number; // page size in CSS px at zoom 1
  baseH: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedKey: number; // zoom × dpr the canvas was drawn at; 0 = nothing drawn
  task: pdfjs.RenderTask | null;
  visible: boolean; // within the observer's one-screen margin
  text: Promise<TextContent> | null; // cached; shared by the text layer and search
  textLayer: TextLayerInfo | null;
};

/** A rendered text layer: one div per text item, in the same order as textContent items with a `str`. */
export type TextLayerInfo = { n: number; div: HTMLDivElement; textDivs: HTMLElement[]; strs: string[] };

const scroller = document.querySelector<HTMLElement>("#pages")!;
const messageEl = document.querySelector<HTMLElement>("#message")!;
const indicatorEl = document.querySelector<HTMLElement>("#indicator")!;

// The loading task owns the document; destroying it frees the document and its worker data.
let currentTask: pdfjs.PDFDocumentLoadingTask | null = null;
// Incremented on every open, so a slow earlier load can't overwrite a newer one.
let loadId = 0;

let slots: Slot[] = [];
let zoom = 1;
let zoomMode: ZoomMode = "fit-width";
let currentPage = 1;
let activeRenders = 0;
let settling = false;
let settleTimer = 0;
let indicatorTimer = 0;
let scrollFrame = 0;
let resizeFrame = 0;

const observer = new IntersectionObserver(onIntersect, {
  root: scroller,
  rootMargin: "100% 0px", // about one screen above and below
});

scroller.addEventListener("scroll", onScroll, { passive: true });
scroller.addEventListener("wheel", onWheel, { passive: false });
new ResizeObserver(onResize).observe(scroller);
// Fires when the window moves to a screen with a different scale factor.
window.addEventListener("resize", () => pump());

/**
 * Viewer events for other modules (settings, search, outline, annotations):
 * - "open"        detail: DocInfo        a document finished loading and is laid out
 * - "close"                              the current document was closed (another open or an error)
 * - "pagechange"  detail: number         the current page changed
 * - "scroll"                             the view scrolled or zoomed (for saving the position)
 * - "pagerender"  detail: PageRender     a page's canvas (and text layer) was rendered
 * - "pagefree"    detail: number         a page's canvas and text layer were freed
 * - "openfailed"  detail: { key }        a file could not be read (e.g. a missing recent file)
 */
export const events = new EventTarget();

export type DocInfo = { key: string; name: string; size: number; pageCount: number };

function emit(type: string, detail?: unknown) {
  events.dispatchEvent(new CustomEvent(type, { detail }));
}

let doc: DocInfo | null = null;

export function getDoc() {
  return doc;
}

// Extra content (the recent-files list) shown under the start message; set by settings.ts.
let startExtras: () => Node | null = () => null;

export function setStartExtras(fn: () => Node | null) {
  startExtras = fn;
}

export function showStartScreen() {
  showMessage(START_MESSAGE, startExtras());
}

/** Ctrl+O: pick a PDF with the native dialog and show it. */
export async function openPdf() {
  let path: string | null;
  try {
    path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (err) {
    console.error(err);
    return;
  }
  if (path) await openPath(path);
}

/** Open a PDF by path. The path must already be in the fs scope (dialog pick, allowed recent or launch file). */
export async function openPath(path: string): Promise<boolean> {
  const name = fileName(path);
  let data: Uint8Array;
  try {
    data = await readFile(path);
  } catch (err) {
    console.error(err);
    emit("openfailed", { key: path });
    await showError(name, "the file could not be read. It may have been moved or deleted.");
    return false;
  }
  return openBytes(data, name, path);
}

/**
 * Load PDF bytes and lay out placeholders for every page. Split out from openPath so it can be
 * driven without the dialog. `key` identifies the file for saved positions and annotations.
 */
export async function openBytes(data: Uint8Array, name: string, key = name): Promise<boolean> {
  const size = data.byteLength;
  const id = ++loadId;
  await closeCurrent();
  const task = pdfjs.getDocument({ data });
  currentTask = task;

  let pages: pdfjs.PDFPageProxy[];
  try {
    const pdf = await task.promise;
    pages = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
    );
  } catch (err) {
    if (id !== loadId) return false;
    console.error(err);
    await showError(name, describeLoadError(err));
    return false;
  }
  if (id !== loadId) return false;

  hideMessage();
  await setTitle(`${name} — ${APP_NAME}`);
  if (id !== loadId) return false;

  slots = pages.map((page, i) => {
    const vp = page.getViewport({ scale: CSS_UNITS });
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.index = String(i);
    return {
      n: i + 1,
      page,
      baseW: vp.width,
      baseH: vp.height,
      el,
      canvas: null,
      renderedKey: 0,
      task: null,
      visible: false,
      text: null,
      textLayer: null,
    };
  });
  currentPage = 1;
  if (zoomMode !== "custom") zoom = fitZoom(zoomMode);
  applySizes();

  const frag = document.createDocumentFragment();
  for (const s of slots) frag.append(s.el);
  scroller.append(frag);
  for (const s of slots) observer.observe(s.el);
  showIndicator(pageLabel());

  doc = { key, name, size, pageCount: slots.length };
  emit("open", doc);
  return true;
}

export function getPdfPage(n: number): pdfjs.PDFPageProxy | undefined {
  return slots[n - 1]?.page;
}

/** The page element for page n (for overlays such as annotations). */
export function getPageElement(n: number): HTMLDivElement | undefined {
  return slots[n - 1]?.el;
}

/** Page size in CSS px at zoom 1. */
export function getPageSize(n: number): { width: number; height: number } | undefined {
  const s = slots[n - 1];
  return s && { width: s.baseW, height: s.baseH };
}

// ---------------------------------------------------------------------------
// Reading position (saved per file by settings.ts)

export type Position = { page: number; offset: number; zoom: number; mode: ZoomMode };

/** Page at the top of the view, how far down it the view starts (0–1), and the zoom. */
export function getPosition(): Position | null {
  const s = topSlot();
  if (!s) return null;
  const offset = (scroller.scrollTop + FIT_PADDING - s.el.offsetTop) / s.el.offsetHeight;
  return { page: s.n, offset: Math.min(1, Math.max(0, offset)), zoom, mode: zoomMode };
}

/** Restore zoom first, then scroll to the saved page and offset. */
export function setPosition(pos: Position) {
  if (!slots.length) return;
  const n = Math.min(slots.length, Math.max(1, Math.round(pos.page)));
  currentPage = n;
  zoomMode = pos.mode;
  zoom = pos.mode === "custom" ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pos.zoom)) : fitZoom(pos.mode);
  applySizes();
  const el = slots[n - 1].el;
  scroller.scrollTop = el.offsetTop + pos.offset * el.offsetHeight - FIT_PADDING;
  pump();
}

// ---------------------------------------------------------------------------
// Lazy rendering

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const e of entries) {
    const slot = slots[Number((e.target as HTMLElement).dataset.index)];
    if (!slot || slot.el !== e.target) continue;
    slot.visible = e.isIntersecting;
    if (!slot.visible) slot.task?.cancel();
  }
  pump();
}

/** Start renders for nearby pages that need one, closest to the current page first. */
function pump() {
  if (settling || activeRenders >= MAX_CONCURRENT) return;
  const key = renderKey();
  const wanted = slots
    .filter((s) => s.visible && !s.task && s.renderedKey !== key)
    .sort((a, b) => Math.abs(a.n - currentPage) - Math.abs(b.n - currentPage));
  for (const s of wanted) {
    if (activeRenders >= MAX_CONCURRENT) break;
    render(s);
  }
}

function render(slot: Slot) {
  const id = loadId;
  const key = renderKey();
  const dpr = window.devicePixelRatio || 1;
  const vp = slot.page.getViewport({ scale: zoom * CSS_UNITS });

  // Draw into a new canvas and swap it in when done, so the old (stretched) one stays visible meanwhile.
  const canvas = document.createElement("canvas");
  // Round to whole device pixels of the page box, so the canvas maps 1:1 onto the screen.
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);

  const task = slot.page.render({
    canvas,
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  slot.task = task;
  activeRenders++;

  task.promise.then(
    () => {
      if (id !== loadId) return;
      slot.task = null;
      activeRenders--;
      freeCanvas(slot);
      slot.canvas = canvas;
      slot.renderedKey = key;
      slot.el.prepend(canvas); // under the text and annotation layers
      evictFarPages();
      pump();
      if (!slot.textLayer) void buildTextLayer(slot, vp);
      else emit("pagerender", slot.textLayer);
    },
    (err) => {
      canvas.width = canvas.height = 0;
      if (id !== loadId) return;
      slot.task = null;
      activeRenders--;
      if (!(err instanceof pdfjs.RenderingCancelledException)) console.error(err);
      pump();
    },
  );
}

/** Keep memory flat: free canvases far from the current page, never ones on screen. */
function evictFarPages() {
  const rendered = slots.filter((s) => s.canvas);
  let excess = rendered.length - MAX_RENDERED;
  if (excess <= 0) return;
  const candidates = rendered
    .filter((s) => !s.visible)
    .sort((a, b) => Math.abs(b.n - currentPage) - Math.abs(a.n - currentPage));
  for (const s of candidates) {
    if (excess-- <= 0) break;
    freeCanvas(s);
    freeTextLayer(s);
    s.page.cleanup();
  }
}

/** Page text, fetched once and cached (search reads every page; the text layer reuses it). */
export function getTextContent(n: number): Promise<TextContent> | undefined {
  const s = slots[n - 1];
  if (!s) return undefined;
  s.text ??= s.page.getTextContent();
  return s.text;
}

/**
 * Invisible, selectable text over the canvas. Positions are in % of the page and font sizes use
 * --total-scale-factor, so the layer follows zoom changes through CSS without being rebuilt.
 */
async function buildTextLayer(slot: Slot, vp: pdfjs.PageViewport) {
  const id = loadId;
  const div = document.createElement("div");
  div.className = "textLayer";
  const info: TextLayerInfo = { n: slot.n, div, textDivs: [], strs: [] };
  slot.textLayer = info;
  try {
    const layer = new pdfjs.TextLayer({ textContentSource: await getTextContent(slot.n)!, container: div, viewport: vp });
    await layer.render();
    if (id !== loadId || slot.textLayer !== info) return;
    info.textDivs = layer.textDivs;
    info.strs = layer.textContentItemsStr;
    slot.canvas?.after(div);
    emit("pagerender", info);
  } catch (err) {
    if (slot.textLayer === info) slot.textLayer = null;
    console.error(err);
  }
}

function freeTextLayer(slot: Slot) {
  if (!slot.textLayer) return;
  slot.textLayer.div.remove();
  slot.textLayer = null;
  emit("pagefree", slot.n);
}

/** The rendered text layer of page n, if it's currently built. */
export function getTextLayer(n: number): TextLayerInfo | null {
  const t = slots[n - 1]?.textLayer;
  return t && t.textDivs.length ? t : null;
}

/** Scroll so a point on page n (CSS px at zoom 1) sits a third of the way down the view. */
export function scrollToPagePoint(n: number, x: number, y: number) {
  const s = slots[n - 1];
  if (!s) return;
  scroller.scrollTop = s.el.offsetTop + y * zoom - scroller.clientHeight / 3;
  const left = s.el.offsetLeft + x * zoom;
  if (left < scroller.scrollLeft + FIT_PADDING || left > scroller.scrollLeft + scroller.clientWidth - FIT_PADDING) {
    scroller.scrollLeft = left - scroller.clientWidth / 3;
  }
}

export function getPdfDocument(): Promise<pdfjs.PDFDocumentProxy> | null {
  return currentTask?.promise ?? null;
}

function freeCanvas(slot: Slot) {
  if (!slot.canvas) return;
  // Zero size first so the browser releases the pixel buffer right away.
  slot.canvas.width = slot.canvas.height = 0;
  slot.canvas.remove();
  slot.canvas = null;
  slot.renderedKey = 0;
}

function renderKey() {
  return zoom * (window.devicePixelRatio || 1);
}

// ---------------------------------------------------------------------------
// Current page

function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const n = slotAt(scroller.scrollTop + scroller.clientHeight / 2)?.n ?? 1;
    if (n !== currentPage) {
      currentPage = n;
      pump();
      emit("pagechange", n);
    }
    showIndicator(pageLabel());
    emit("scroll");
  });
}

/** The page covering document offset y (binary search; pages are stacked in order). */
function slotAt(y: number): Slot | undefined {
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slots[mid].el.offsetTop <= y) lo = mid;
    else hi = mid - 1;
  }
  return slots[lo];
}

export function getCurrentPage() {
  return currentPage;
}

export function getPageCount() {
  return slots.length;
}

function pageLabel() {
  return `${currentPage} / ${slots.length}`;
}

// ---------------------------------------------------------------------------
// Navigation

const LINE_PX = 64; // j / k
const SCREEN_OVERLAP = 0.1; // Space keeps 10% of the previous screen in view

export function scrollLines(n: number) {
  scroller.scrollTop += n * LINE_PX;
}

export function scrollScreens(n: number) {
  scroller.scrollTop += n * scroller.clientHeight * (1 - SCREEN_OVERLAP);
}

/** Scroll so page n's top sits at the top of the view (same gap as the first page). */
export function goToPage(n: number) {
  if (!slots.length) return;
  n = Math.min(slots.length, Math.max(1, Math.round(n)));
  scroller.scrollTop = slots[n - 1].el.offsetTop - FIT_PADDING;
}

/** The page at the top edge of the view; next/previous page are relative to it, not to the centre. */
function topSlot(): Slot | undefined {
  return slotAt(scroller.scrollTop + FIT_PADDING + 1);
}

export function nextPage() {
  const s = topSlot();
  if (s) goToPage(s.n + 1);
}

export function prevPage() {
  const s = topSlot();
  if (!s) return;
  // Partway down a page: go back to its top first.
  const partway = scroller.scrollTop > s.el.offsetTop - FIT_PADDING + 1;
  goToPage(partway ? s.n : s.n - 1);
}

export function firstPage() {
  goToPage(1);
}

export function lastPage() {
  goToPage(slots.length);
}

// ---------------------------------------------------------------------------
// Fullscreen

export async function toggleFullscreen() {
  try {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch (err) {
    console.error(err);
  }
}

export async function exitFullscreen() {
  try {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) await win.setFullscreen(false);
  } catch (err) {
    console.error(err);
  }
}

/** Briefly show a short status ("12 / 340", "150%", "Dark theme") in the corner. */
export function showIndicator(text: string) {
  indicatorEl.textContent = text;
  indicatorEl.classList.add("shown");
  clearTimeout(indicatorTimer);
  indicatorTimer = window.setTimeout(() => indicatorEl.classList.remove("shown"), INDICATOR_MS);
}

// ---------------------------------------------------------------------------
// Zoom

export function getZoom() {
  return { zoom, mode: zoomMode };
}

export function zoomIn() {
  setZoom(ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? MAX_ZOOM, "custom");
}

export function zoomOut() {
  setZoom([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? MIN_ZOOM, "custom");
}

export function resetZoom() {
  setZoom(1, "custom");
}

/** Toggle between fit width and fit page. */
export function toggleFit() {
  const mode: ZoomMode = zoomMode === "fit-width" ? "fit-page" : "fit-width";
  setZoom(fitZoom(mode), mode);
}

/**
 * Change zoom while keeping the point at `focus` (scroller-relative px; default: the
 * centre) over the same spot of the same page.
 */
export function setZoom(next: number, mode: ZoomMode, focus?: { x: number; y: number }) {
  if (!slots.length) return;
  next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  zoomMode = mode;
  if (Math.abs(next - zoom) < 0.0001) return;

  const fx = focus?.x ?? scroller.clientWidth / 2;
  const fy = focus?.y ?? scroller.clientHeight / 2;
  const docY = scroller.scrollTop + fy;
  const docX = scroller.scrollLeft + fx;
  const anchor = slotAt(docY)!;
  const fracY = (docY - anchor.el.offsetTop) / anchor.el.offsetHeight;
  const fracX = (docX - anchor.el.offsetLeft) / anchor.el.offsetWidth;

  zoom = next;
  applySizes();
  scroller.scrollTop = anchor.el.offsetTop + fracY * anchor.el.offsetHeight - fy;
  scroller.scrollLeft = anchor.el.offsetLeft + fracX * anchor.el.offsetWidth - fx;

  // Stretched canvases show instantly; re-render sharp once zooming pauses.
  for (const s of slots) s.task?.cancel();
  settling = true;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settling = false;
    pump();
  }, SETTLE_MS);
  showIndicator(`${Math.round(zoom * 100)}%`);
  emit("scroll");
}

function fitZoom(mode: ZoomMode): number {
  const s = slots[currentPage - 1] ?? slots[0];
  if (!s) return zoom;
  const byWidth = (scroller.clientWidth - 2 * FIT_PADDING) / s.baseW;
  if (mode === "fit-width") return byWidth;
  return Math.min(byWidth, (scroller.clientHeight - 2 * FIT_PADDING) / s.baseH);
}

function applySizes() {
  // Text layers (and anything else sized in PDF units) scale with this variable, without re-rendering.
  scroller.style.setProperty("--total-scale-factor", String(zoom * CSS_UNITS));
  for (const s of slots) {
    s.el.style.width = `${s.baseW * zoom}px`;
    s.el.style.height = `${s.baseH * zoom}px`;
  }
}

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey) return; // plain wheel scrolls as usual
  e.preventDefault(); // also stops the WebView's own page zoom
  if (!slots.length) return;
  const rect = scroller.getBoundingClientRect();
  const focus = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
  if (Math.abs(dy) >= 50) {
    // Mouse wheel notch: one zoom step.
    const next =
      dy < 0
        ? ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? MAX_ZOOM
        : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? MIN_ZOOM;
    setZoom(next, "custom", focus);
  } else {
    // Trackpad pinch arrives as small Ctrl+wheel deltas: zoom smoothly.
    setZoom(zoom * Math.exp(-dy * 0.01), "custom", focus);
  }
}

// Re-fit on the next frame: resizing pages inside the ResizeObserver callback can
// change the scroller's size again and trigger "ResizeObserver loop" errors.
function onResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (slots.length && zoomMode !== "custom") setZoom(fitZoom(zoomMode), zoomMode);
  });
}

// ---------------------------------------------------------------------------
// Errors, messages, cleanup

function describeLoadError(err: unknown): string {
  if (err instanceof pdfjs.PasswordException) {
    return "it is password-protected. Encrypted PDFs aren't supported yet.";
  }
  if (err instanceof pdfjs.InvalidPDFException) {
    return "it isn't a valid PDF, or it is damaged.";
  }
  return "something went wrong while loading it.";
}

async function showError(name: string, reason: string) {
  loadId++;
  await closeCurrent();
  await setTitle(APP_NAME);
  showMessage(`Couldn't open ${name}: ${reason}\n\n${START_MESSAGE}`, startExtras());
}

async function closeCurrent() {
  if (doc) {
    doc = null;
    emit("close");
  }
  observer.disconnect();
  for (const s of slots) {
    s.task?.cancel();
    freeCanvas(s);
  }
  slots = [];
  activeRenders = 0;
  settling = false;
  clearTimeout(settleTimer);
  scroller.replaceChildren();
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
  const task = currentTask;
  currentTask = null;
  await task?.destroy();
}

function showMessage(text: string, extra: Node | null = null) {
  const p = document.createElement("p");
  p.textContent = text;
  messageEl.replaceChildren(p);
  if (extra) messageEl.append(extra);
  messageEl.hidden = false;
}

function hideMessage() {
  messageEl.hidden = true;
}

async function setTitle(title: string) {
  try {
    await getCurrentWindow().setTitle(title);
  } catch (err) {
    console.error(err);
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
