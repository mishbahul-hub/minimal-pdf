import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const APP_NAME = "Minimal PDF";
const START_MESSAGE = "Press Ctrl+O to open a PDF";
const DEFAULT_SCALE = 1.25;

const pagesEl = document.querySelector<HTMLElement>("#pages")!;
const messageEl = document.querySelector<HTMLElement>("#message")!;

// The loading task owns the document; destroying it frees the document and its worker data.
let currentTask: pdfjs.PDFDocumentLoadingTask | null = null;
// Incremented on every open, so a slow earlier load can't overwrite a newer one.
let loadId = 0;

export function showStartScreen() {
  showMessage(START_MESSAGE);
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
  if (!path) return;

  const name = fileName(path);
  let data: Uint8Array;
  try {
    data = await readFile(path);
  } catch (err) {
    console.error(err);
    await showError(name, "the file could not be read.");
    return;
  }
  await openBytes(data, name);
}

/** Load PDF bytes and render every page. Split out from openPdf so it can be driven without the dialog. */
export async function openBytes(data: Uint8Array, name: string) {
  const id = ++loadId;
  await closeCurrent();
  const task = pdfjs.getDocument({ data });
  currentTask = task;

  let pdf: pdfjs.PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    await showError(name, describeLoadError(err));
    return;
  }
  if (id !== loadId) return;

  hideMessage();
  await setTitle(`${name} — ${APP_NAME}`);

  // Rendering every page up front is fine for now; Stage 2 replaces it with lazy rendering.
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      if (id !== loadId) return;
      await renderPage(pdf, n, DEFAULT_SCALE);
    }
  } catch (err) {
    // A newer open destroys this document mid-render; that's expected.
    if (id === loadId) console.error(err);
  }
}

async function renderPage(pdf: pdfjs.PDFDocumentProxy, n: number, scale: number) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const wrapper = document.createElement("div");
  wrapper.className = "page";
  wrapper.dataset.page = String(n);

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${Math.floor(vp.width)}px`;
  canvas.style.height = `${Math.floor(vp.height)}px`;

  wrapper.append(canvas);
  pagesEl.append(wrapper);

  await page.render({
    canvas,
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;
}

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
  showMessage(`Couldn't open ${name}: ${reason}\n\n${START_MESSAGE}`);
}

async function closeCurrent() {
  pagesEl.replaceChildren();
  pagesEl.scrollTop = 0;
  const task = currentTask;
  currentTask = null;
  await task?.destroy();
}

function showMessage(text: string) {
  messageEl.textContent = text;
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
