// Save a copy of the open PDF (Ctrl+Shift+S), or a copy with the annotations drawn into it (Ctrl+S),
// so they show in any PDF reader. The original file is never written: the save dialog refuses it.
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { BlendMode, LineCapStyle, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import { getDoc, getPdfDocument, getPdfPage, showIndicator } from "./viewer";
import { FONTS, getAnnotations, type FontKey } from "./annotate";

const CSS_TO_PT = 72 / 96; // annotation units are CSS px at zoom 1; PDF units are points
const LINE_HEIGHT = 1.25; // same as the on-page comments
const IMAGE_SCALE = 3; // comments drawn as images (non-Latin scripts) render at 3× for sharp print

type Mode = "annotated" | "copy";

/** Save the open PDF: with annotations drawn in, or as an exact copy. */
export async function savePdf(mode: Mode) {
  const doc = getDoc();
  const pdf = getPdfDocument() && (await getPdfDocument());
  if (!doc || !pdf) return showIndicator("Open a PDF first");

  const base = doc.name.replace(/\.pdf$/i, "");
  const folder = /[\\/]/.test(doc.key) ? doc.key.replace(/[\\/][^\\/]*$/, "") : "";
  const suggested = `${base} ${mode === "annotated" ? "(annotated)" : "(copy)"}.pdf`;
  const path = await save({
    title: mode === "annotated" ? "Save PDF with annotations" : "Save a copy of the PDF",
    defaultPath: folder ? `${folder}\\${suggested}` : suggested,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  if (sameFile(path, doc.key)) return showIndicator("Choose another name: the original PDF is never changed");

  showIndicator("Saving…");
  try {
    const original = await pdf.getData();
    let bytes: Uint8Array = original;
    let imageNotes = 0;
    if (mode === "annotated") ({ bytes, imageNotes } = await withAnnotations(original));
    await writeFile(path, bytes);
    const name = path.split(/[\\/]/).pop();
    showIndicator(imageNotes ? `Saved ${name} (${imageNotes} comment${imageNotes > 1 ? "s" : ""} as images)` : `Saved ${name}`);
  } catch (e) {
    showIndicator(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sameFile(a: string, b: string) {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** Draw every page's annotations onto a copy of the PDF. */
async function withAnnotations(original: Uint8Array): Promise<{ bytes: Uint8Array; imageNotes: number }> {
  const out = await PDFDocument.load(original, { updateMetadata: false });
  const fonts: Record<FontKey, PDFFont> = {
    sans: await out.embedFont(StandardFonts.Helvetica),
    serif: await out.embedFont(StandardFonts.TimesRoman),
    mono: await out.embedFont(StandardFonts.Courier),
    hand: await out.embedFont(StandardFonts.HelveticaOblique),
  };
  const pages = out.getPages();
  let imageNotes = 0;

  for (const [key, list] of Object.entries(getAnnotations())) {
    const n = Number(key);
    const page = pages[n - 1];
    const source = getPdfPage(n);
    if (!page || !source || !list.length) continue;
    // PDF.js knows the page's crop box and rotation: it maps our page units to PDF points.
    const vp = source.getViewport({ scale: pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS });
    const pt = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];

    for (const a of list) {
      const color = hexColor(a.color);
      if (a.kind === "text") {
        imageNotes += await drawNote(out, page, a, pt, fonts);
      } else if (a.kind === "pen" || a.kind === "pencil" || a.kind === "highlighter") {
        const p = a.points;
        if (p.length < 2) continue;
        const coords: [number, number][] = [];
        for (let i = 0; i < p.length; i += 2) coords.push(pt(p[i], p[i + 1]));
        if (coords.length === 1) coords.push([coords[0][0] + 0.01, coords[0][1]]); // a dot
        stroke(page, coords, false, {
          width: a.width * CSS_TO_PT,
          color,
          opacity: a.kind === "highlighter" ? 0.5 : a.kind === "pencil" ? 0.9 : 1,
          multiply: true,
        });
      } else {
        const s = a as { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number };
        const corners: [number, number][] =
          s.kind === "rect"
            ? [pt(s.x, s.y), pt(s.x + s.w, s.y), pt(s.x + s.w, s.y + s.h), pt(s.x, s.y + s.h)]
            : Array.from({ length: 64 }, (_, i) => {
                const t = (i / 64) * Math.PI * 2;
                return pt(s.x + s.w / 2 + (Math.cos(t) * s.w) / 2, s.y + s.h / 2 + (Math.sin(t) * s.h) / 2);
              });
        stroke(page, corners, true, { width: a.width * CSS_TO_PT, color, opacity: 1, multiply: true });
      }
    }
  }
  return { bytes: await out.save(), imageNotes };
}

/** Stroke a polyline (or closed shape) given in PDF points. */
function stroke(
  page: PDFPage,
  coords: [number, number][],
  closed: boolean,
  o: { width: number; color: ReturnType<typeof rgb>; opacity: number; multiply: boolean },
) {
  // drawSvgPath flips y (SVG is y-down), so pass -y to land on the PDF point itself.
  const d = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(" ") + (closed ? " Z" : "");
  page.drawSvgPath(d, {
    x: 0,
    y: 0,
    borderColor: o.color,
    borderWidth: o.width,
    borderOpacity: o.opacity,
    borderLineCap: LineCapStyle.Round,
    blendMode: o.multiply ? BlendMode.Multiply : undefined,
  });
}

type NoteAnn = Extract<ReturnType<typeof getAnnotations>[number][number], { kind: "text" }>;

/**
 * A text comment: real, selectable text when the standard PDF fonts can show it; otherwise (Hindi,
 * Bengali, Arabic…) a sharp image of the text, drawn with the same font the app uses. Returns 1 for an image.
 */
async function drawNote(
  out: PDFDocument,
  page: PDFPage,
  note: NoteAnn,
  pt: (x: number, y: number) => [number, number],
  fonts: Record<FontKey, PDFFont>,
): Promise<number> {
  const font = fonts[note.font] ?? fonts.sans;
  const lines = note.text.split("\n");
  const size = note.size * CSS_TO_PT;
  const color = hexColor(note.color);
  const encodable = lines.every((line) => {
    try {
      font.encodeText(line);
      return true;
    } catch {
      return false;
    }
  });
  if (encodable) {
    lines.forEach((line, i) => {
      // The app draws comments from their top (hanging baseline); PDF text sits on its baseline.
      const [x, y] = pt(note.x, note.y + note.size * (i * LINE_HEIGHT + 0.8));
      page.drawText(line, { x, y, size, font, color });
    });
    return 0;
  }
  const png = await noteImage(note, lines);
  if (!png) return 0;
  const image = await out.embedPng(png.bytes);
  const [x0, y0] = pt(note.x, note.y);
  const [x1, y1] = pt(note.x + png.width, note.y + png.height);
  page.drawImage(image, { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) });
  return 1;
}

/** Render a comment's text to a transparent PNG (page units for its size), like it looks on the page. */
async function noteImage(note: NoteAnn, lines: string[]): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const family = FONTS[note.font]?.family ?? FONTS.sans.family;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `${note.size}px ${family}`;
  const width = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width), 1)) + 2;
  const height = Math.ceil(note.size * LINE_HEIGHT * lines.length);
  const canvas = document.createElement("canvas");
  canvas.width = width * IMAGE_SCALE;
  canvas.height = height * IMAGE_SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(IMAGE_SCALE, IMAGE_SCALE);
  ctx.font = `${note.size}px ${family}`;
  ctx.fillStyle = note.color;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, 0, i * note.size * LINE_HEIGHT));
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

function hexColor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}
