import {
  openPdf,
  scrollLines,
  scrollScreens,
  nextPage,
  prevPage,
  firstPage,
  lastPage,
  zoomIn,
  zoomOut,
  resetZoom,
  toggleFit,
  toggleFullscreen,
  exitFullscreen,
} from "./viewer";
import { closeTopOverlay, openGoTo, toggleHelp } from "./overlays";
import { cycleTheme, openRecent } from "./settings";

type Action = (e: KeyboardEvent) => void | Promise<unknown>;

export type Binding = {
  /** Key names as produced by keyName(); a space separates a two-key sequence ("g g"). */
  keys: string[];
  /** Shown in the ? help overlay. */
  label: string;
  help: string;
  action: Action;
  /** Act on auto-repeat while the key is held (scrolling, zooming). */
  repeat?: boolean;
};

// The single keymap. The ? help overlay is generated from it, so edit shortcuts only here.
export const KEYMAP: Binding[] = [
  { keys: ["Ctrl+o"], label: "Ctrl+O", help: "Open file", action: openPdf },
  { keys: ["j", "ArrowDown"], label: "j / ↓", help: "Scroll down a little", action: () => scrollLines(1), repeat: true },
  { keys: ["k", "ArrowUp"], label: "k / ↑", help: "Scroll up a little", action: () => scrollLines(-1), repeat: true },
  { keys: ["Space", "PageDown"], label: "Space", help: "Next screen", action: () => scrollScreens(1), repeat: true },
  { keys: ["Shift+Space", "PageUp"], label: "Shift+Space", help: "Previous screen", action: () => scrollScreens(-1), repeat: true },
  { keys: ["n", "ArrowRight"], label: "n / →", help: "Next page", action: nextPage, repeat: true },
  { keys: ["p", "ArrowLeft"], label: "p / ←", help: "Previous page", action: prevPage, repeat: true },
  { keys: ["g g", "Home"], label: "g g", help: "First page", action: firstPage },
  { keys: ["G", "End"], label: "G", help: "Last page", action: lastPage },
  { keys: ["Ctrl+g"], label: "Ctrl+G", help: "Go to page", action: openGoTo },
  { keys: ["+", "=", "Ctrl+=", "Ctrl++"], label: "+", help: "Zoom in", action: zoomIn, repeat: true },
  { keys: ["-", "Ctrl+-"], label: "−", help: "Zoom out", action: zoomOut, repeat: true },
  { keys: ["0", "Ctrl+0"], label: "0", help: "Reset zoom to 100%", action: resetZoom },
  { keys: ["w"], label: "w", help: "Toggle fit width / fit page", action: toggleFit },
  { keys: ["f", "F11"], label: "f / F11", help: "Fullscreen", action: toggleFullscreen },
  { keys: ["d"], label: "d", help: "Cycle theme (light, dark, sepia)", action: cycleTheme },
  {
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    label: "1–9",
    help: "Open a recent file (start screen)",
    action: (e) => openRecent(Number(e.key)),
  },
  { keys: ["?"], label: "?", help: "Show shortcut help", action: () => toggleHelp(KEYMAP) },
  { keys: ["Escape"], label: "Esc", help: "Close overlay / leave fullscreen", action: escape },
];

const SEQUENCE_MS = 500; // time allowed between the keys of "g g"
const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

function escape() {
  if (!closeTopOverlay()) return exitFullscreen();
}

/**
 * "Ctrl+o", "j", "G", "?", "Space", "Shift+Space", "ArrowDown", ...
 * Printable keys already include Shift in e.key ("G", "?"), so Shift is only
 * named for non-printable keys. Letters with Ctrl are lowercased.
 */
function keyName(e: KeyboardEvent): string {
  const ctrl = e.ctrlKey || e.metaKey;
  let key = e.key === " " ? "Space" : e.key;
  if (ctrl && key.length === 1) key = key.toLowerCase();
  const shift = e.shiftKey && key.length > 1 ? "Shift+" : "";
  return (ctrl ? "Ctrl+" : "") + shift + key;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function bindKeys(keymap: Binding[] = KEYMAP) {
  const byKey = new Map<string, Binding>();
  const prefixes = new Set<string>();
  for (const b of keymap) {
    for (const k of b.keys) {
      byKey.set(k, b);
      const parts = k.split(" ");
      if (parts.length > 1) prefixes.add(parts[0]);
    }
  }

  let pending = "";
  let pendingTimer = 0;
  const clearPending = () => {
    pending = "";
    clearTimeout(pendingTimer);
  };

  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target) || e.altKey || MODIFIERS.has(e.key)) return;
    const name = keyName(e);

    let binding: Binding | undefined;
    if (pending) {
      binding = byKey.get(`${pending} ${name}`);
      clearPending();
    }
    if (!binding && prefixes.has(name) && !e.repeat) {
      // First key of a sequence: wait for the second.
      pending = name;
      pendingTimer = window.setTimeout(clearPending, SEQUENCE_MS);
      e.preventDefault();
      return;
    }
    binding ??= byKey.get(name);
    if (!binding) return;

    e.preventDefault();
    if (e.repeat && !binding.repeat) return;
    void binding.action(e);
  });
}
