// On-demand overlays (go-to-page box, shortcut help). Esc closes the most recent one.
import { getCurrentPage, getPageCount, goToPage } from "./viewer";
import type { Binding } from "./keys";

type Overlay = { el: HTMLElement; close: () => void };
const open: Overlay[] = [];

/** Register an open overlay so Esc (closeTopOverlay) can close it. */
export function registerOverlay(el: HTMLElement, close: () => void) {
  open.push({ el, close });
}

export function unregisterOverlay(el: HTMLElement) {
  const i = open.findIndex((o) => o.el === el);
  if (i >= 0) open.splice(i, 1);
}

/** Close the most recently opened overlay. Returns false if none was open. */
export function closeTopOverlay(): boolean {
  const top = open[open.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

// ---------------------------------------------------------------------------
// Go to page (Ctrl+G)

const gotoEl = document.querySelector<HTMLFormElement>("#goto")!;
const gotoInput = document.querySelector<HTMLInputElement>("#goto-input")!;
const gotoTotal = document.querySelector<HTMLElement>("#goto-total")!;

export function openGoTo() {
  if (!getPageCount()) return;
  if (gotoEl.hidden) {
    gotoTotal.textContent = `of ${getPageCount()}`;
    gotoInput.value = String(getCurrentPage());
    gotoEl.hidden = false;
    registerOverlay(gotoEl, closeGoTo);
  }
  gotoInput.focus();
  gotoInput.select();
}

function closeGoTo() {
  if (gotoEl.hidden) return;
  gotoEl.hidden = true;
  unregisterOverlay(gotoEl);
  gotoInput.blur();
}

function submitGoTo() {
  const n = parseInt(gotoInput.value, 10);
  closeGoTo();
  if (Number.isFinite(n)) goToPage(n);
}

gotoEl.addEventListener("submit", (e) => {
  e.preventDefault();
  submitGoTo();
});

// Shortcuts are ignored while typing, so the input handles its own Enter and Esc
// (Enter explicitly, rather than relying on implicit form submission).
gotoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitGoTo();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeGoTo();
  }
});

gotoInput.addEventListener("blur", closeGoTo);

// ---------------------------------------------------------------------------
// Shortcut help (?)

const helpEl = document.querySelector<HTMLElement>("#help")!;
const helpList = document.querySelector<HTMLElement>("#help-list")!;

export function toggleHelp(keymap: Binding[]) {
  if (!helpEl.hidden) return closeHelp();
  helpList.replaceChildren(
    ...keymap.flatMap((b) => {
      const key = document.createElement("dt");
      key.textContent = b.label;
      const desc = document.createElement("dd");
      desc.textContent = b.help;
      return [key, desc];
    }),
  );
  helpEl.hidden = false;
  registerOverlay(helpEl, closeHelp);
}

function closeHelp() {
  helpEl.hidden = true;
  unregisterOverlay(helpEl);
}

// Click outside the panel closes it.
helpEl.addEventListener("click", (e) => {
  if (e.target === helpEl) closeHelp();
});
