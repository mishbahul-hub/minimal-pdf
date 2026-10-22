// Table of contents (t): a slide-in sidebar built from the PDF's bookmarks, or a page list if it has none.
import { events, getCurrentPage, getPageCount, getPdfDocument, goToPage } from "./viewer";
import { registerOverlay, unregisterOverlay } from "./overlays";

type Entry = { title: string; page: number | null; el: HTMLButtonElement; li: HTMLLIElement; parent: Entry | null };

const sidebarEl = document.querySelector<HTMLElement>("#outline")!;
const treeEl = document.querySelector<HTMLElement>("#outline-tree")!;

let entries: Entry[] = []; // document order
let built: Promise<void> | null = null;
let buildId = 0;

type OutlineNode = { title: string; dest: string | unknown[] | null; items: OutlineNode[] };

async function build() {
  const id = ++buildId;
  entries = [];
  treeEl.replaceChildren();
  const pdf = await getPdfDocument();
  if (!pdf || id !== buildId) return;
  const outline = (await pdf.getOutline()) as OutlineNode[] | null;
  if (id !== buildId) return;

  if (!outline?.length) {
    // No bookmarks: fall back to a plain page list.
    const note = document.createElement("p");
    note.className = "outline-note";
    note.textContent = "No table of contents in this PDF";
    const ul = document.createElement("ul");
    for (let n = 1; n <= getPageCount(); n++) ul.append(item({ title: `Page ${n}`, dest: null, items: [] }, null, n));
    treeEl.append(note, ul);
    return;
  }

  /** Resolve a destination to a 1-based page number (string destinations are named in the document). */
  const pageOf = async (dest: OutlineNode["dest"]): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      const ref = explicit?.[0];
      if (ref == null) return null;
      if (typeof ref === "number") return ref + 1; // some PDFs store a page index directly
      return (await pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0])) + 1;
    } catch {
      return null;
    }
  };

  const walk = async (nodes: OutlineNode[], parent: Entry | null): Promise<HTMLUListElement> => {
    const ul = document.createElement("ul");
    for (const node of nodes) {
      const li = item(node, parent, await pageOf(node.dest));
      const entry = entries[entries.length - 1];
      if (node.items?.length) {
        li.classList.add("has-children", "collapsed");
        li.append(await walk(node.items, entry));
      }
      ul.append(li);
    }
    return ul;
  };
  const root = await walk(outline, null);
  if (id === buildId) treeEl.append(root);
}

function item(node: OutlineNode, parent: Entry | null, page: number | null): HTMLLIElement {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.tabIndex = -1;
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = node.title || "Untitled";
  const num = document.createElement("span");
  num.className = "pnum";
  num.textContent = page ? String(page) : "";
  b.append(title, num);
  if (!page) b.disabled = true;
  const entry: Entry = { title: node.title, page, el: b, li, parent };
  entries.push(entry);
  b.addEventListener("click", (e) => {
    // Clicking the arrow area of a parent toggles it; the rest jumps.
    if (li.classList.contains("has-children") && e.offsetX < 18) toggle(entry);
    else jump(entry);
  });
  li.append(b);
  return li;
}

function jump(entry: Entry) {
  if (!entry.page) return;
  goToPage(entry.page);
  markCurrent();
}

function toggle(entry: Entry, open?: boolean) {
  if (!entry.li.classList.contains("has-children")) return;
  entry.li.classList.toggle("collapsed", open === undefined ? undefined : !open);
}

function isVisible(entry: Entry) {
  for (let p = entry.parent; p; p = p.parent) if (p.li.classList.contains("collapsed")) return false;
  return true;
}

/** Highlight the chapter being read: the last entry starting on or before the current page. */
function markCurrent() {
  const page = getCurrentPage();
  let best: Entry | null = null;
  for (const e of entries) if (e.page && e.page <= page && (!best || e.page >= best.page!)) best = e;
  for (const e of entries) e.el.classList.toggle("current", e === best);
  return best;
}

function focusEntry(entry: Entry | undefined) {
  if (!entry) return;
  for (const e of entries) e.el.tabIndex = e === entry ? 0 : -1;
  entry.el.focus();
  entry.el.scrollIntoView({ block: "nearest" });
}

// Arrow-key navigation inside the tree. Handled keys stop here so the global shortcuts don't also act.
treeEl.addEventListener("keydown", (e) => {
  const i = entries.findIndex((x) => x.el === document.activeElement);
  if (i === -1) return;
  const entry = entries[i];
  const visible = entries.filter(isVisible);
  const vi = visible.indexOf(entry);
  let handled = true;
  switch (e.key) {
    case "ArrowDown":
    case "j":
      focusEntry(visible[vi + 1]);
      break;
    case "ArrowUp":
    case "k":
      focusEntry(visible[vi - 1]);
      break;
    case "Home":
      focusEntry(visible[0]);
      break;
    case "End":
      focusEntry(visible[visible.length - 1]);
      break;
    case "ArrowRight":
      if (entry.li.classList.contains("collapsed")) toggle(entry, true);
      else if (entry.li.classList.contains("has-children")) focusEntry(entries[i + 1]);
      break;
    case "ArrowLeft":
      if (entry.li.classList.contains("has-children") && !entry.li.classList.contains("collapsed")) toggle(entry, false);
      else focusEntry(entry.parent ?? undefined);
      break;
    case "Enter":
    case " ":
      jump(entry);
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
});

export async function toggleOutline() {
  if (!sidebarEl.hidden) return closeOutline();
  if (!getPageCount()) return;
  built ??= build();
  sidebarEl.hidden = false;
  registerOverlay(sidebarEl, closeOutline);
  await built;
  if (sidebarEl.hidden) return;
  // Open the branches leading to the current chapter and focus it.
  const cur = markCurrent();
  for (let p = cur?.parent; p; p = p.parent) toggle(p, true);
  focusEntry(cur ?? entries.find((x) => x.page) ?? entries[0]);
}

function closeOutline() {
  if (sidebarEl.hidden) return;
  sidebarEl.hidden = true;
  unregisterOverlay(sidebarEl);
  (document.activeElement as HTMLElement | null)?.blur();
}

events.addEventListener("pagechange", () => {
  if (!sidebarEl.hidden) markCurrent();
});

events.addEventListener("close", () => {
  closeOutline();
  buildId++;
  built = null;
  entries = [];
  treeEl.replaceChildren();
});
