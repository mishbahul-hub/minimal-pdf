// Annotations: pen, pencil, highlighter, eraser, rectangle, ellipse and text notes.
// Drawn as SVG over each page in page coordinates (CSS px at zoom 1), so they scale with zoom.
// Stored per file in the app's data folder (notes-<hash>.json); the PDF itself is never modified.
import { load, type Store } from "@tauri-apps/plugin-store";
import { events, getDoc, getPageElement, getPageSize, showIndicator, type DocInfo } from "./viewer";
import { getSetting, setSetting } from "./settings";

export type Tool = "pointer" | "pen" | "pencil" | "highlighter" | "eraser" | "rect" | "ellipse" | "text";
type InkKind = "pen" | "pencil" | "highlighter";

type Ink = { id: string; kind: InkKind; color: string; width: number; points: number[] };
type Shape = { id: string; kind: "rect" | "ellipse"; color: string; width: number; x: number; y: number; w: number; h: number };
type Note = { id: string; kind: "text"; color: string; font: FontKey; size: number; x: number; y: number; text: string };
type Ann = Ink | Shape | Note;

export type FontKey = "sans" | "serif" | "mono" | "hand";
export const FONTS: Record<FontKey, { label: string; family: string }> = {
  sans: { label: "Sans", family: 'system-ui, "Segoe UI", sans-serif' },
  serif: { label: "Serif", family: 'Georgia, "Times New Roman", serif' },
  mono: { label: "Mono", family: 'Consolas, ui-monospace, monospace' },
  hand: { label: "Handwriting", family: '"Segoe Print", "Comic Sans MS", cursive' },
};
export const TEXT_SIZES = [10, 12, 14, 16, 20, 24, 32, 48];

export type Style = { color: string; width: number; font?: FontKey; size?: number };

/** Tool metadata for the radial menu: label, colour palette, and width (or text size) presets. */
export const TOOLS: { id: Tool; label: string; colors: string[]; widths: number[] }[] = [
  { id: "pointer", label: "Select text (no tool)", colors: [], widths: [] },
  { id: "pen", label: "Pen", colors: ["#1f1f1f", "#e53935", "#1e63d6", "#2e7d32", "#f57c00", "#7b1fa2"], widths: [1.5, 2.5, 4.5] },
  { id: "pencil", label: "Pencil", colors: ["#4a4a4a", "#8d6e63", "#1e63d6", "#c62828", "#2e7d32", "#6a1b9a"], widths: [1, 1.8, 3] },
  // Light, see-through colours so the text underneath stays readable.
  { id: "highlighter", label: "Highlighter", colors: ["#fff176", "#b9f6ca", "#b3e5fc", "#f8bbd0", "#ffe0b2", "#e1bee7"], widths: [10, 16, 24] },
  { id: "eraser", label: "Eraser", colors: [], widths: [8, 16, 32] },
  { id: "rect", label: "Rectangle", colors: ["#e53935", "#1e63d6", "#2e7d32", "#f57c00", "#1f1f1f", "#7b1fa2"], widths: [1.5, 2.5, 4.5] },
  { id: "ellipse", label: "Circle", colors: ["#e53935", "#1e63d6", "#2e7d32", "#f57c00", "#1f1f1f", "#7b1fa2"], widths: [1.5, 2.5, 4.5] },
  { id: "text", label: "Text comment", colors: ["#1f1f1f", "#e53935", "#1e63d6", "#2e7d32", "#f57c00", "#7b1fa2"], widths: [12, 16, 24] },
];

const DEFAULT_STYLES: Record<Exclude<Tool, "pointer">, Style> = {
  pen: { color: "#1f1f1f", width: 2.5 },
  pencil: { color: "#4a4a4a", width: 1.8 },
  highlighter: { color: "#fff176", width: 16 },
  eraser: { color: "#000000", width: 16 },
  rect: { color: "#e53935", width: 2.5 },
  ellipse: { color: "#e53935", width: 2.5 },
  text: { color: "#1f1f1f", width: 16, font: "sans", size: 16 },
};

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_POINT_DIST = 0.6; // page units between recorded ink points
const LINE_HEIGHT = 1.25;

const scroller = document.querySelector<HTMLElement>("#pages")!;

let tool: Tool = "pointer";
scroller.dataset.tool = tool;
let styles: Record<string, Style> = structuredClone(DEFAULT_STYLES);
const stylesReady = getSetting<Record<string, Style>>("annotationStyles").then((s) => {
  if (s) styles = { ...styles, ...s };
});

// Current document's annotations.
let pages = new Map<number, Ann[]>();
let store: Store | null = null;
let docKey = "";
let undoStack: Op[] = [];
let redoStack: Op[] = [];

type Item = { page: number; ann: Ann; index: number };
/** One undoable change: annotations added and removed (an edit is a remove plus an add). */
type Op = { added: Item[]; removed: Item[] };

// ---------------------------------------------------------------------------
// Tool state

export function getTool() {
  return tool;
}

export function getStyle(t: Tool): Style {
  return styles[t] ?? { color: "#000000", width: 2 };
}

export function setTool(t: Tool) {
  if (tool === "text" && t !== "text") commitEditor();
  tool = t;
  scroller.dataset.tool = t;
  updateCursor();
  showIndicator(TOOLS.find((x) => x.id === t)!.label);
}

export async function setStyle(t: Tool, patch: Partial<Style>) {
  await stylesReady;
  styles[t] = { ...getStyle(t), ...patch };
  updateCursor();
  if (t === "text" && editor) applyEditorStyle();
  await setSetting("annotationStyles", styles);
}

/** Esc with no overlay open: put the tool down. Returns false if no tool was active. */
export function dropTool(): boolean {
  if (editor) {
    commitEditor();
    return true;
  }
  if (tool === "pointer") return false;
  setTool("pointer");
  return true;
}

/** A cursor showing the tool's size and colour (pen, pencil, highlighter, eraser). */
function updateCursor() {
  const s = getStyle(tool);
  const zoom = parseFloat(getComputedStyle(scroller).getPropertyValue("--zoom")) || 1;
  let cursor = "";
  if (tool === "pen" || tool === "pencil" || tool === "highlighter" || tool === "eraser") {
    const d = Math.max(4, Math.min(64, Math.round(s.width * zoom)));
    const size = d + 4;
    const c = size / 2;
    const fill = tool === "eraser" ? "rgba(255,255,255,0.6)" : tool === "highlighter" ? s.color + "99" : s.color;
    const svg = `<svg xmlns="${SVG_NS}" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${d / 2}" fill="${fill}" stroke="${tool === "eraser" ? "#555" : "white"}" stroke-width="1"/></svg>`;
    cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
  }
  scroller.style.setProperty("--tool-cursor", cursor || "crosshair");
}

// ---------------------------------------------------------------------------
// Storage

function hashKey(s: string) {
  // FNV-1a, enough to give each file its own notes file.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function loadNotes(doc: DocInfo) {
  docKey = doc.key;
  const s = await load(`notes-${hashKey(doc.key)}.json`, { autoSave: 300, defaults: {} });
  if (getDoc() !== doc) return;
  store = s;
  const saved = (await s.get<Record<string, Ann[]>>("pages")) ?? {};
  if (getDoc() !== doc) return;
  pages = new Map(Object.entries(saved).map(([n, list]) => [Number(n), list]));
  for (const n of pages.keys()) renderPage(n);
}

async function saveNotes() {
  // Capture both now: the document can close (store = null) while the writes are in flight.
  const s = store;
  const key = docKey;
  if (!s) return;
  const obj: Record<string, Ann[]> = {};
  for (const [n, list] of pages) if (list.length) obj[n] = list;
  await s.set("file", key);
  await s.set("pages", obj);
}

// ---------------------------------------------------------------------------
// Rendering

function layerFor(n: number, create: boolean): SVGSVGElement | null {
  const el = getPageElement(n);
  if (!el) return null;
  let svg = el.querySelector<SVGSVGElement>(":scope > svg.ink");
  if (!svg && create) {
    const size = getPageSize(n)!;
    svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("ink");
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.dataset.page = String(n);
    el.append(svg);
  }
  return svg;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Smooth path through the points: quadratic curves between midpoints. */
function inkPath(p: number[]): string {
  if (p.length <= 2) return `M${p[0]} ${p[1]} l0.01 0`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    d += ` Q${p[i]} ${p[i + 1]} ${r2((p[i] + p[i + 2]) / 2)} ${r2((p[i + 1] + p[i + 3]) / 2)}`;
  }
  return d + ` L${p[p.length - 2]} ${p[p.length - 1]}`;
}

function annElement(a: Ann): SVGElement {
  let el: SVGElement;
  if (a.kind === "pen" || a.kind === "pencil" || a.kind === "highlighter") {
    el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", inkPath(a.points));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", a.color);
    el.setAttribute("stroke-width", String(a.width));
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
  } else if (a.kind === "rect") {
    el = document.createElementNS(SVG_NS, "rect");
    el.setAttribute("x", String(a.x));
    el.setAttribute("y", String(a.y));
    el.setAttribute("width", String(a.w));
    el.setAttribute("height", String(a.h));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", a.color);
    el.setAttribute("stroke-width", String(a.width));
  } else if (a.kind === "ellipse") {
    el = document.createElementNS(SVG_NS, "ellipse");
    el.setAttribute("cx", String(a.x + a.w / 2));
    el.setAttribute("cy", String(a.y + a.h / 2));
    el.setAttribute("rx", String(a.w / 2));
    el.setAttribute("ry", String(a.h / 2));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", a.color);
    el.setAttribute("stroke-width", String(a.width));
  } else {
    const note = a as Note;
    el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("x", String(note.x));
    el.setAttribute("y", String(note.y));
    el.setAttribute("fill", note.color);
    el.setAttribute("font-size", String(note.size));
    el.setAttribute("dominant-baseline", "hanging");
    el.style.fontFamily = FONTS[note.font]?.family ?? FONTS.sans.family;
    note.text.split("\n").forEach((line, i) => {
      const t = document.createElementNS(SVG_NS, "tspan");
      t.setAttribute("x", String(note.x));
      if (i > 0) t.setAttribute("dy", `${LINE_HEIGHT}em`);
      t.textContent = line || " ";
      el.append(t);
    });
  }
  el.classList.add(a.kind === "highlighter" ? "hl" : a.kind);
  el.dataset.id = a.id;
  return el;
}

function renderPage(n: number) {
  const list = pages.get(n) ?? [];
  const svg = layerFor(n, list.length > 0);
  if (!svg) return;
  svg.replaceChildren(...list.filter((a) => !(editor && editor.note.id === a.id)).map(annElement));
}

// ---------------------------------------------------------------------------
// Changes and undo

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function apply(op: Op, reverse = false) {
  const add = reverse ? op.removed : op.added;
  const remove = reverse ? op.added : op.removed;
  const touched = new Set<number>();
  for (const it of remove) {
    const list = pages.get(it.page) ?? [];
    const i = list.findIndex((a) => a.id === it.ann.id);
    if (i >= 0) list.splice(i, 1);
    touched.add(it.page);
  }
  // Re-insert at the original positions (ascending), so stacking order is kept on undo.
  for (const it of [...add].sort((a, b) => a.index - b.index)) {
    const list = pages.get(it.page) ?? [];
    list.splice(Math.min(it.index, list.length), 0, it.ann);
    pages.set(it.page, list);
    touched.add(it.page);
  }
  for (const n of touched) renderPage(n);
  void saveNotes();
}

function commit(op: Op) {
  if (!op.added.length && !op.removed.length) return;
  apply(op);
  undoStack.push(op);
  redoStack = [];
}

export function undo() {
  if (editor) commitEditor();
  const op = undoStack.pop();
  if (!op) return showIndicator("Nothing to undo");
  apply(op, true);
  redoStack.push(op);
  showIndicator("Undo");
}

export function redo() {
  const op = redoStack.pop();
  if (!op) return showIndicator("Nothing to redo");
  apply(op);
  undoStack.push(op);
  showIndicator("Redo");
}

// ---------------------------------------------------------------------------
// Pointer input

type Gesture = { pointerId: number } & (
  | { kind: "ink"; n: number; ann: Ink; el: SVGPathElement; startX: number; startY: number }
  | { kind: "shape"; n: number; ann: Shape; el: SVGElement; x0: number; y0: number }
  | { kind: "erase"; n: number; removed: Item[]; lastX: number; lastY: number }
  | { kind: "text"; n: number; x: number; y: number }
  | { kind: "move"; n: number; note: Note; el: SVGElement | null; x0: number; y0: number; dx: number; dy: number; moved: boolean }
);

const MOVE_THRESHOLD = 3; // page units of drag before a press on a comment becomes a move

let gesture: Gesture | null = null;

function pageAt(e: PointerEvent): { n: number; el: HTMLElement } | null {
  const el = (e.target as Element | null)?.closest<HTMLElement>(".page");
  if (!el) return null;
  return { n: Number(el.dataset.index) + 1, el };
}

function toPage(el: HTMLElement, n: number, e: PointerEvent | MouseEvent) {
  const r = el.getBoundingClientRect();
  const k = r.width / getPageSize(n)!.width;
  return { x: r2((e.clientX - r.left) / k), y: r2((e.clientY - r.top) / k), k };
}

scroller.addEventListener("pointerdown", (e) => {
  if ((e.target as Element).closest(".note-editor")) return;
  if (editor) {
    commitEditor();
    if (tool === "text" || tool === "pointer") return; // a click outside the editor just finishes it
  }
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const hit = pageAt(e);

  // With no tool or the text tool, pressing on a comment grabs it: dragging moves it.
  if (hit && (tool === "pointer" || tool === "text")) {
    const p = toPage(hit.el, hit.n, e);
    const note = noteAt(hit.n, p.x, p.y);
    if (note) {
      e.preventDefault(); // don't start a text selection underneath
      const el = layerFor(hit.n, false)?.querySelector<SVGElement>(`[data-id="${note.id}"]`) ?? null;
      // The pointer is only captured once it actually drags (see pointermove), so a plain click or
      // double-click keeps its normal target (double-click edits the comment).
      gesture = { pointerId: e.pointerId, kind: "move", n: hit.n, note, el, x0: p.x, y0: p.y, dx: 0, dy: 0, moved: false };
      return;
    }
  }

  if (tool === "pointer" || !hit) return;
  e.preventDefault();
  const { x, y } = toPage(hit.el, hit.n, e);
  const s = getStyle(tool);

  if (tool === "pen" || tool === "pencil" || tool === "highlighter") {
    const ann: Ink = { id: newId(), kind: tool, color: s.color, width: s.width, points: [x, y] };
    const el = annElement(ann) as SVGPathElement;
    layerFor(hit.n, true)!.append(el);
    gesture = { pointerId: e.pointerId, kind: "ink", n: hit.n, ann, el, startX: x, startY: y };
  } else if (tool === "rect" || tool === "ellipse") {
    const ann: Shape = { id: newId(), kind: tool, color: s.color, width: s.width, x, y, w: 0, h: 0 };
    const el = annElement(ann);
    layerFor(hit.n, true)!.append(el);
    gesture = { pointerId: e.pointerId, kind: "shape", n: hit.n, ann, el, x0: x, y0: y };
  } else if (tool === "eraser") {
    gesture = { pointerId: e.pointerId, kind: "erase", n: hit.n, removed: [], lastX: x, lastY: y };
    eraseAt(gesture, x, y);
  } else if (tool === "text") {
    gesture = { pointerId: e.pointerId, kind: "text", n: hit.n, x, y };
  }
  scroller.setPointerCapture(e.pointerId);
});

scroller.addEventListener("pointermove", (e) => {
  // Only the pointer that started the stroke draws (a resting palm or second pointer is ignored).
  if (!gesture || gesture.kind === "text" || e.pointerId !== gesture.pointerId) return;
  const el = getPageElement(gesture.n)!;
  if (gesture.kind === "move") {
    const { x, y } = toPage(el, gesture.n, e);
    const dx = x - gesture.x0;
    const dy = y - gesture.y0;
    if (!gesture.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    if (!gesture.moved) {
      scroller.classList.add("moving-note");
      scroller.setPointerCapture(e.pointerId);
    }
    gesture.moved = true;
    gesture.dx = dx;
    gesture.dy = dy;
    gesture.el?.setAttribute("transform", `translate(${dx} ${dy})`);
    return;
  }
  // Coalesced events give every sample the pointer produced since the last frame: smoother ink.
  const samples = gesture.kind === "ink" ? (e.getCoalescedEvents?.() ?? [e]) : [e];
  for (const ev of samples.length ? samples : [e]) {
    const { x, y } = toPage(el, gesture.n, ev);
    if (gesture.kind === "ink") {
      const p = gesture.ann.points;
      if (e.shiftKey) {
        // Shift: straight line from the start point.
        gesture.ann.points = [gesture.startX, gesture.startY, x, y];
      } else if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= MIN_POINT_DIST) {
        p.push(x, y);
      }
    } else if (gesture.kind === "shape") {
      let w = x - gesture.x0;
      let h = y - gesture.y0;
      if (e.shiftKey) {
        // Shift: square / perfect circle.
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      Object.assign(gesture.ann, { x: Math.min(gesture.x0, gesture.x0 + w), y: Math.min(gesture.y0, gesture.y0 + h), w: Math.abs(w), h: Math.abs(h) });
    } else if (gesture.kind === "erase") {
      eraseAlong(gesture, x, y);
    }
  }
  const g = gesture;
  if (g.kind === "ink") g.el.setAttribute("d", inkPath(g.ann.points));
  if (g.kind === "shape") g.el.replaceWith((g.el = annElement(g.ann)));
});

function endGesture(e: PointerEvent) {
  if (gesture && e.pointerId !== gesture.pointerId) return;
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (scroller.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
  scroller.classList.remove("moving-note");
  if (g.kind === "ink") {
    g.el.remove();
    commit({ added: [{ page: g.n, ann: g.ann, index: pages.get(g.n)?.length ?? 0 }], removed: [] });
  } else if (g.kind === "shape") {
    g.el.remove();
    if (g.ann.w > 2 || g.ann.h > 2) commit({ added: [{ page: g.n, ann: g.ann, index: pages.get(g.n)?.length ?? 0 }], removed: [] });
  } else if (g.kind === "erase") {
    if (g.removed.length) {
      // Already removed live; record it so undo brings them back.
      undoStack.push({ added: [], removed: g.removed });
      redoStack = [];
      void saveNotes();
    }
  } else if (g.kind === "move") {
    if (g.moved) {
      const index = (pages.get(g.n) ?? []).findIndex((a) => a.id === g.note.id);
      const moved: Note = { ...g.note, x: r2(g.note.x + g.dx), y: r2(g.note.y + g.dy) };
      commit({ removed: [{ page: g.n, ann: g.note, index }], added: [{ page: g.n, ann: moved, index }] });
    } else if (tool === "text") {
      openEditor(g.n, g.note, false); // a click (no drag) with the text tool edits it
    }
  } else if (g.kind === "text") {
    const existing = noteAt(g.n, g.x, g.y);
    openEditor(g.n, existing ?? { id: newId(), kind: "text", color: getStyle("text").color, font: getStyle("text").font ?? "sans", size: getStyle("text").size ?? 16, x: g.x, y: g.y, text: "" }, !existing);
  }
}

scroller.addEventListener("pointerup", endGesture);
scroller.addEventListener("pointercancel", endGesture);

// ---------------------------------------------------------------------------
// Eraser: removes whole annotations it touches

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(a: Ann, x: number, y: number, r: number, n: number): boolean {
  if (a.kind === "pen" || a.kind === "pencil" || a.kind === "highlighter") {
    const p = a.points;
    const reach = r + a.width / 2;
    if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
    for (let i = 0; i < p.length - 2; i += 2) if (distToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
    return false;
  }
  if (a.kind === "rect") {
    const reach = r + a.width / 2;
    const [x1, y1, x2, y2] = [a.x, a.y, a.x + a.w, a.y + a.h];
    return (
      distToSegment(x, y, x1, y1, x2, y1) <= reach ||
      distToSegment(x, y, x2, y1, x2, y2) <= reach ||
      distToSegment(x, y, x2, y2, x1, y2) <= reach ||
      distToSegment(x, y, x1, y2, x1, y1) <= reach
    );
  }
  if (a.kind === "ellipse") {
    const reach = r + a.width / 2;
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2, rx = a.w / 2, ry = a.h / 2;
    for (let i = 0; i < 64; i++) {
      const t1 = (i / 64) * 2 * Math.PI, t2 = ((i + 1) / 64) * 2 * Math.PI;
      if (distToSegment(x, y, cx + rx * Math.cos(t1), cy + ry * Math.sin(t1), cx + rx * Math.cos(t2), cy + ry * Math.sin(t2)) <= reach) return true;
    }
    return false;
  }
  // Text: inside its box.
  const el = layerFor(n, false)?.querySelector<SVGGraphicsElement>(`[data-id="${a.id}"]`);
  if (!el) return false;
  const b = el.getBBox();
  return x >= b.x - r && x <= b.x + b.width + r && y >= b.y - r && y <= b.y + b.height + r;
}

function eraseAt(g: Extract<Gesture, { kind: "erase" }>, x: number, y: number) {
  const list = pages.get(g.n);
  if (!list) return;
  const r = getStyle("eraser").width / 2;
  for (let i = list.length - 1; i >= 0; i--) {
    if (hits(list[i], x, y, r, g.n)) {
      g.removed.push({ page: g.n, ann: list[i], index: i });
      list.splice(i, 1);
    }
  }
  if (g.removed.length) renderPage(g.n);
}

function eraseAlong(g: Extract<Gesture, { kind: "erase" }>, x: number, y: number) {
  // Sample the movement so fast strokes don't skip over thin lines.
  const steps = Math.max(1, Math.ceil(Math.hypot(x - g.lastX, y - g.lastY) / 4));
  for (let i = 1; i <= steps; i++) eraseAt(g, g.lastX + ((x - g.lastX) * i) / steps, g.lastY + ((y - g.lastY) * i) / steps);
  g.lastX = x;
  g.lastY = y;
}

// ---------------------------------------------------------------------------
// Text notes: an editor on the page with font, size and colour controls

type Editor = { n: number; note: Note; original: Note | null; wrap: HTMLDivElement; area: HTMLTextAreaElement };
let editor: Editor | null = null;

function noteAt(n: number, x: number, y: number): Note | null {
  const list = pages.get(n) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a.kind === "text" && hits(a, x, y, 2, n)) return a;
  }
  return null;
}

function swatch(color: string, onPick: () => void, title = color) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.title = title;
  b.style.background = color;
  b.addEventListener("click", onPick);
  return b;
}

function openEditor(n: number, note: Note, isNew: boolean) {
  const page = getPageElement(n);
  const size = getPageSize(n);
  if (!page || !size) return;
  if (editor) commitEditor();
  const working: Note = { ...note };

  const wrap = document.createElement("div");
  wrap.className = "note-editor";
  wrap.style.left = `${(working.x / size.width) * 100}%`;
  wrap.style.top = `${(working.y / size.height) * 100}%`;

  const bar = document.createElement("div");
  bar.className = "note-bar panel";
  const font = document.createElement("select");
  font.title = "Font";
  for (const [k, f] of Object.entries(FONTS)) font.append(new Option(f.label, k, false, k === working.font));
  const fontSize = document.createElement("select");
  fontSize.title = "Size";
  for (const s of TEXT_SIZES) fontSize.append(new Option(`${s}`, String(s), false, s === working.size));
  const colors = document.createElement("div");
  colors.className = "note-colors";
  for (const c of TOOLS.find((t) => t.id === "text")!.colors) colors.append(swatch(c, () => setNoteStyle({ color: c })));
  const custom = document.createElement("input");
  custom.type = "color";
  custom.title = "Any colour";
  custom.value = working.color;
  custom.addEventListener("input", () => setNoteStyle({ color: custom.value }));
  colors.append(custom);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "note-delete";
  del.title = "Delete comment";
  del.textContent = "Delete";
  const grip = document.createElement("span");
  grip.className = "note-grip";
  grip.title = "Drag to move";
  grip.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
  bar.append(grip, font, fontSize, colors, del);

  // Drag the grip to move the comment while editing (saved with the edit).
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const x0 = working.x;
    const y0 = working.y;
    const k = page.getBoundingClientRect().width / size.width; // screen px per page unit
    const onMove = (ev: PointerEvent) => {
      working.x = r2(x0 + (ev.clientX - startX) / k);
      working.y = r2(y0 + (ev.clientY - startY) / k);
      wrap.style.left = `${(working.x / size.width) * 100}%`;
      wrap.style.top = `${(working.y / size.height) * 100}%`;
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      area.focus();
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  const area = document.createElement("textarea");
  area.value = working.text;
  area.rows = 1;
  area.spellcheck = false;
  area.placeholder = "Comment…";
  wrap.append(bar, area);
  page.append(wrap);

  editor = { n, note: working, original: isNew ? null : note, wrap, area };
  renderPage(n); // hide the SVG copy while editing
  applyEditorStyle();
  area.focus();

  font.addEventListener("change", () => setNoteStyle({ font: font.value as FontKey }));
  fontSize.addEventListener("change", () => setNoteStyle({ size: Number(fontSize.value) }));
  del.addEventListener("click", () => {
    area.value = "";
    commitEditor();
  });
  area.addEventListener("input", autosize);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commitEditor();
    }
  });
  // Keep focus in the text while using the controls' mouse clicks.
  bar.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)) e.preventDefault();
  });
}

function setNoteStyle(patch: Partial<Note>) {
  if (!editor) return;
  Object.assign(editor.note, patch);
  void setStyle("text", { color: editor.note.color, font: editor.note.font, size: editor.note.size });
  applyEditorStyle();
  editor.area.focus();
}

function applyEditorStyle() {
  if (!editor) return;
  const { note, area } = editor;
  area.style.color = note.color;
  area.style.fontFamily = FONTS[note.font].family;
  // --zoom is set on #pages by the viewer, so the editor text matches the rendered size at any zoom.
  area.style.fontSize = `calc(var(--zoom) * ${note.size}px)`;
  autosize();
}

function autosize() {
  if (!editor) return;
  const a = editor.area;
  a.style.height = "auto";
  a.style.height = `${a.scrollHeight}px`;
  a.style.width = "auto";
  a.style.width = `${Math.max(a.scrollWidth + 4, 80)}px`;
}

function commitEditor() {
  const ed = editor;
  if (!ed) return;
  editor = null;
  ed.wrap.remove();
  const text = ed.area.value.replace(/\s+$/, "");
  const list = pages.get(ed.n) ?? [];
  const index = ed.original ? list.findIndex((a) => a.id === ed.original!.id) : list.length;
  const removed = ed.original ? [{ page: ed.n, ann: ed.original as Ann, index }] : [];
  const added = text ? [{ page: ed.n, ann: { ...ed.note, text } as Ann, index: Math.max(0, index) }] : [];
  const unchanged = ed.original && text && JSON.stringify({ ...ed.note, text }) === JSON.stringify(ed.original);
  if (unchanged) renderPage(ed.n);
  else if (added.length || removed.length) commit({ added, removed });
  else renderPage(ed.n);
}

// Double-click a comment (with no tool) to edit it. Hit-tested by its box, not the glyphs,
// so the gaps between letters and lines count too.
scroller.addEventListener("dblclick", (e) => {
  if (tool !== "pointer") return;
  const el = (e.target as Element).closest<HTMLElement>(".page");
  if (!el) return;
  const n = Number(el.dataset.index) + 1;
  const { x, y } = toPage(el, n, e);
  const note = noteAt(n, x, y);
  if (!note) return;
  getSelection()?.removeAllRanges(); // the double-click also selected a word underneath
  openEditor(n, note, false);
});

// ---------------------------------------------------------------------------
// Document lifecycle

events.addEventListener("open", (e) => void loadNotes((e as CustomEvent<DocInfo>).detail));
events.addEventListener("close", () => {
  if (editor) commitEditor();
  void saveNotes();
  pages = new Map();
  store = null;
  undoStack = [];
  redoStack = [];
});
// The page cursor depends on the zoom.
events.addEventListener("scroll", () => {
  if (tool !== "pointer") updateCursor();
});

/** For tests: the current document's annotations. */
export function getAnnotations() {
  return Object.fromEntries(pages);
}

// ---------------------------------------------------------------------------
// For the AI features (ai.ts)

/** Add a text comment at (x, y) on page n with the current text style. Undoable like any edit. */
export function addComment(n: number, x: number, y: number, text: string) {
  const s = getStyle("text");
  const note: Note = { id: newId(), kind: "text", color: s.color, font: s.font ?? "sans", size: 12, x: r2(x), y: r2(y), text };
  const list = pages.get(n) ?? [];
  commit({ added: [{ page: n, ann: note, index: list.length }], removed: [] });
}

export type AnnotationInfo =
  | { page: number; kind: "comment"; text: string }
  | { page: number; kind: "highlight" | "pen" | "pencil" | "rect" | "ellipse"; color: string; box: { x: number; y: number; w: number; h: number } };

/** The user's annotations on pages from..to, with each mark's bounding box (page units). */
export function annotationList(from: number, to: number): AnnotationInfo[] {
  const out: AnnotationInfo[] = [];
  for (const n of [...pages.keys()].sort((a, b) => a - b)) {
    if (n < from || n > to) continue;
    for (const a of pages.get(n)!) {
      if (a.kind === "text") out.push({ page: n, kind: "comment", text: a.text });
      else if (a.kind === "rect" || a.kind === "ellipse") out.push({ page: n, kind: a.kind, color: a.color, box: { x: a.x, y: a.y, w: a.w, h: a.h } });
      else {
        const ink = a as Ink;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < ink.points.length; i += 2) {
          x0 = Math.min(x0, ink.points[i]);
          x1 = Math.max(x1, ink.points[i]);
          y0 = Math.min(y0, ink.points[i + 1]);
          y1 = Math.max(y1, ink.points[i + 1]);
        }
        const pad = ink.width / 2;
        const box = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
        out.push({ page: n, kind: ink.kind === "highlighter" ? "highlight" : ink.kind, color: ink.color, box });
      }
    }
  }
  return out;
}

/** Extra per-file data kept next to the annotations (e.g. saved AI summaries). */
export async function getDocData<T>(key: string): Promise<T | undefined> {
  return store?.get<T>(key);
}

export async function setDocData(key: string, value: unknown) {
  await store?.set(key, value);
}
