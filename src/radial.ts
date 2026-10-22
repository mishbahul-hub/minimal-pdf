// Right-click radial menu: tools on an inner ring around the cursor, colours and sizes on an outer ring.
// No toolbar: this is the only annotation UI besides the text-comment editor.
import { TOOLS, getStyle, getTool, setStyle, setTool, type Tool } from "./annotate";
import { registerOverlay, unregisterOverlay } from "./overlays";
import { getDoc } from "./viewer";

const R_TOOLS = 66; // radius of the tool ring
const R_OPTIONS = 120; // radius of the colour / size ring
const EDGE = 150; // keep the whole menu inside the window

/**
 * Two-tone icons on a 24×24 grid: outline in the button's text colour, a soft tinted body, and one
 * detail in the tool's current colour (`c`): the pen's nib hole, the pencil's tip, the highlighter's
 * stroke, the shapes' fill, the text underline. So the ring also shows what each tool will draw with.
 */
const SOFT = 'fill="currentColor" fill-opacity="0.12"';
const ICONS: Record<Tool, (c: string) => string> = {
  pointer: () =>
    `<path ${SOFT} d="M6.3 3.8 18 12.6c.5.4.3 1.2-.4 1.3l-4.5.7 2.5 5.1c.2.5 0 1-.4 1.2l-1.2.6c-.5.2-1 0-1.2-.5l-2.4-5.1-3.3 3c-.5.5-1.3.1-1.3-.6V4.3c0-.6.6-.9 1.1-.5z"/>`,
  pen: (c) =>
    `<path ${SOFT} d="M8.2 3.5h7.6l.9 6.8L12 20.5l-4.7-10.2z"/>` +
    `<path d="M7.3 10.3h9.4M12 20.5v-6.4"/>` +
    `<circle cx="12" cy="12.6" r="1.7" fill="${c}" stroke="none"/>`,
  pencil: (c) =>
    `<path ${SOFT} d="M15.9 3.4a1.5 1.5 0 0 1 2.1 0l2.6 2.6a1.5 1.5 0 0 1 0 2.1L9.2 19.5 4 20.5l1-5.2z"/>` +
    `<path d="M14.2 5.2l4.6 4.6M5 15.3l4.2 4.2"/>` +
    `<path d="M4 20.5l.6-3.1 2.5 2.5z" fill="${c}" stroke="${c}" stroke-width="1"/>`,
  highlighter: (c) =>
    `<path d="M3.5 20.6h10" stroke="${c}" stroke-width="3.2" opacity="0.95"/>` +
    `<path ${SOFT} d="M17.9 2.9 21.1 6.1 13.1 14.1 9.9 10.9z"/>` +
    `<path d="M9.9 10.9 13.1 14.1 10.3 16.9 7.1 13.7z" fill="${c}" fill-opacity="0.85"/>`,
  eraser: () =>
    `<path ${SOFT} d="M14.6 3.6a1.5 1.5 0 0 1 2.1 0l3.7 3.7a1.5 1.5 0 0 1 0 2.1L11 18.8 5.2 13z"/>` +
    `<path d="M5.2 13 11 18.8l-1.2 1.2H7.2l-3-3a1.5 1.5 0 0 1 0-2.1z" fill="#f48fb1" fill-opacity="0.75"/>` +
    `<path d="M13 20h7"/>`,
  rect: (c) => `<rect x="4" y="5.5" width="16" height="13" rx="2.8" fill="${c}" fill-opacity="0.22"/>`,
  ellipse: (c) => `<circle cx="12" cy="12" r="8.2" fill="${c}" fill-opacity="0.22"/>`,
  text: (c) =>
    `<path d="M6 7.2V5.5h12v1.7M12 5.5v11.5M9.6 17h4.8"/>` +
    `<path d="M5.5 20.5h13" stroke="${c}" stroke-width="2.2"/>`,
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
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t](getStyle(t).color)}</svg>`;
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
  menu.querySelectorAll<HTMLElement>(".tool").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === active);
    b.innerHTML = icon(b.dataset.tool as Tool); // icons show each tool's current colour
  });
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
      colorInput.oninput = () => void setStyle(t, { color: colorInput.value }).then(refresh);
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
