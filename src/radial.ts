// Right-click radial menu: tools on an inner ring around the cursor, colours and sizes on an outer ring.
// No toolbar: this is the only annotation UI besides the text-comment editor.
import { TOOLS, getStyle, getTool, setStyle, setTool, type Tool } from "./annotate";
import { registerOverlay, unregisterOverlay } from "./overlays";
import { getDoc } from "./viewer";

const R_TOOLS = 66; // radius of the tool ring
const R_OPTIONS = 120; // radius of the colour / size ring
const EDGE = 150; // keep the whole menu inside the window

const ICONS: Record<Tool, string> = {
  pointer: '<path d="M6 3l12 9-5.5 1.2L15 19l-2.4 1.1-2.6-5.7L6 18z"/>',
  pen: '<path d="M4 20l1.2-4.4L15.5 5.3a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z"/><path d="M13.5 7.3l3.2 3.2"/>',
  pencil: '<path d="M5 19l1-4.5L16 4.5l3.5 3.5-10 10z"/><path d="M14 6.5l3.5 3.5M5 19l3-.8"/>',
  highlighter: '<path d="M9 13.5l-3.5 3.5V20h4.5l3.5-3.5"/><path d="M9 13.5L16.5 4l3.5 3.5L10.5 15z"/><path d="M4 20h4"/>',
  eraser: '<path d="M15.5 4.5l4 4-9.5 9.5H6l-2.5-2.5z"/><path d="M10 9l5 5M12 18h8"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<circle cx="12" cy="12" r="8"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
};

const menu = document.createElement("div");
menu.id = "radial";
menu.hidden = true;
menu.setAttribute("role", "menu");
document.body.append(menu);

const colorInput = document.createElement("input");
colorInput.type = "color";
colorInput.className = "hidden-color";
menu.append(colorInput);

let selected: Tool = "pointer"; // tool whose options the outer ring shows
let lastPointer: { x: number; y: number } | null = null;

function icon(t: Tool) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t]}</svg>`;
}

function place(el: HTMLElement, angleDeg: number, radius: number) {
  const a = (angleDeg * Math.PI) / 180;
  el.style.left = `${Math.cos(a) * radius}px`;
  el.style.top = `${Math.sin(a) * radius}px`;
}

function build() {
  menu.querySelectorAll(".tool, .opt, .center").forEach((el) => el.remove());

  TOOLS.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool";
    b.dataset.tool = t.id;
    b.title = `${t.label} (${i + 1})`;
    b.setAttribute("role", "menuitemradio");
    b.innerHTML = icon(t.id);
    place(b, -90 + (i * 360) / TOOLS.length, R_TOOLS);
    b.addEventListener("click", () => pickTool(t.id));
    menu.append(b);
  });

  const center = document.createElement("button");
  center.type = "button";
  center.className = "center";
  center.title = "Close";
  center.addEventListener("click", closeRadial);
  menu.append(center);
  shownFor = null;
  refresh();
}

// Hovering a tool previews its options; leaving the menu goes back to the selected tool's.
menu.addEventListener("pointerover", (e) => {
  const t = (e.target as Element).closest<HTMLElement>(".tool");
  if (t) showOptions(t.dataset.tool as Tool);
});
menu.addEventListener("pointerleave", () => showOptions(selected));

/** Mark the active tool and show the current colour in the middle. */
function refresh() {
  const active = getTool();
  menu.querySelectorAll<HTMLElement>(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === active));
  const center = menu.querySelector<HTMLElement>(".center")!;
  const s = getStyle(active);
  center.innerHTML = active === "pointer" || active === "eraser" ? icon(active) : `<span class="dot" style="background:${s.color}"></span>`;
}

let shownFor: Tool | null = null;

/**
 * Outer ring: the tool's colours, a custom-colour picker, and its size presets.
 * Rebuilt only when the tool changes (or `force`), so options never vanish under the pointer mid-click.
 */
function showOptions(t: Tool, force = false) {
  if (t === shownFor && !force) return;
  shownFor = t;
  menu.querySelectorAll(".opt").forEach((el) => el.remove());
  const def = TOOLS.find((x) => x.id === t)!;
  const style = getStyle(t);
  const items: HTMLElement[] = [];

  for (const c of def.colors) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt swatch";
    b.style.background = c;
    b.title = c;
    if (c.toLowerCase() === style.color.toLowerCase()) b.classList.add("active");
    b.addEventListener("click", () => {
      void setStyle(t, { color: c });
      if (getTool() !== t) setTool(t);
      closeRadial();
    });
    items.push(b);
  }
  if (def.colors.length) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt custom";
    b.title = "Any colour…";
    if (!def.colors.some((c) => c.toLowerCase() === style.color.toLowerCase())) {
      b.classList.add("active");
      b.style.setProperty("--chosen", style.color);
    }
    b.addEventListener("click", () => {
      colorInput.value = style.color;
      colorInput.oninput = () => void setStyle(t, { color: colorInput.value });
      colorInput.onchange = () => {
        if (getTool() !== t) setTool(t);
        closeRadial();
      };
      colorInput.click();
    });
    items.push(b);
  }
  def.widths.forEach((w, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt size";
    const current = t === "text" ? style.size : style.width;
    if (current === w) b.classList.add("active");
    if (t === "text") {
      b.title = `Text size ${w}`;
      b.innerHTML = `<span style="font-size:${10 + i * 4}px">A</span>`;
    } else {
      b.title = `Size ${["small", "medium", "large"][i]}`;
      const d = 4 + i * 5;
      b.innerHTML = `<span class="dot" style="width:${d}px;height:${d}px;background:${t === "eraser" ? "var(--muted)" : style.color}"></span>`;
    }
    b.addEventListener("click", () => {
      void setStyle(t, t === "text" ? { size: w } : { width: w }).then(() => showOptions(t, true));
      if (getTool() !== t) setTool(t);
      selected = t;
      refresh();
    });
    items.push(b);
  });

  // Spread the options evenly, centred on the top of the ring.
  const step = Math.min(360 / Math.max(items.length, 1), 32);
  items.forEach((el, i) => {
    place(el, -90 + (i - (items.length - 1) / 2) * step, R_OPTIONS);
    menu.append(el);
  });
}

function pickTool(t: Tool) {
  setTool(t);
  selected = t;
  refresh();
  if (t === "pointer") closeRadial();
  else showOptions(t, true);
}

export function openRadial(x?: number, y?: number) {
  if (!getDoc()) return;
  const px = x ?? lastPointer?.x ?? window.innerWidth / 2;
  const py = y ?? lastPointer?.y ?? window.innerHeight / 2;
  menu.style.left = `${Math.min(window.innerWidth - EDGE, Math.max(EDGE, px))}px`;
  menu.style.top = `${Math.min(window.innerHeight - EDGE, Math.max(EDGE, py))}px`;
  selected = getTool();
  build();
  showOptions(selected, true);
  if (menu.hidden) {
    menu.hidden = false;
    registerOverlay(menu, closeRadial);
  }
  menu.querySelector<HTMLElement>(`.tool[data-tool="${selected}"]`)?.focus({ preventScroll: true });
}

export function closeRadial() {
  if (menu.hidden) return;
  menu.hidden = true;
  unregisterOverlay(menu);
}

export function radialOpen() {
  return !menu.hidden;
}

// Right-click on a page opens the menu at the cursor. Text fields keep their normal menu.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select")) return;
  e.preventDefault(); // no browser menu anywhere in the app
  if (t.closest("#pages")) openRadial(e.clientX, e.clientY);
});

// Click outside closes it.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.button !== 2) closeRadial();
  },
  true,
);

document.addEventListener("pointermove", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), { passive: true });

// Keys while the menu is open: 1–8 pick a tool, ←/→ move between tools, Enter closes.
window.addEventListener(
  "keydown",
  (e) => {
    if (menu.hidden) return;
    const i = TOOLS.findIndex((t) => t.id === selected);
    let handled = true;
    if (/^[1-8]$/.test(e.key)) pickTool(TOOLS[Number(e.key) - 1].id);
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") focusTool((i + 1) % TOOLS.length);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") focusTool((i - 1 + TOOLS.length) % TOOLS.length);
    else if (e.key === "Enter" || e.key === " ") {
      const f = document.activeElement as HTMLElement | null;
      if (f && menu.contains(f)) f.click();
      else closeRadial();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

function focusTool(i: number) {
  selected = TOOLS[i].id;
  showOptions(selected);
  menu.querySelector<HTMLElement>(`.tool[data-tool="${selected}"]`)?.focus({ preventScroll: true });
}
