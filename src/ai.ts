// AI features with Claude: ask about selected text, chat with the PDF and summaries.
// Chat is agentic RAG: Claude gets tools that search and read this document (search_document, read_pages,
// get_outline, get_annotations), decides what to look up, and cites the pages it read as [p. N].
// Requests go through Rust (ai.rs), which holds the API key; nothing is sent until the user asks.
import { Channel, invoke } from "@tauri-apps/api/core";
import { events, getCurrentPage, getDoc, getPageCount, getPageElement, getPageSize, goToPage, showIndicator } from "./viewer";
import { registerOverlay, unregisterOverlay } from "./overlays";
import { pageText, searchText, textBoxes } from "./search";
import { getOutlineItems, sectionAt } from "./outline";
import { addComment, annotationList, getDocData, setDocData } from "./annotate";
import { getSetting, setSetting } from "./settings";

const MODEL = "claude-opus-5-5";
// Refusal fallbacks to another model, and short progress notes between tool calls.
const BETAS = ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"];
const MAX_STEPS = 12; // tool rounds per question (summaries get more)
const READ_LIMIT = 40_000; // characters returned by one read_pages call
const READ_PAGES = 8; // pages returned by one read_pages call
const INLINE_LIMIT = 60_000; // documents shorter than this go into the prompt whole
const INLINE_MAX_PAGES = 60;
const LANGUAGES = ["English", "Bengali", "Hindi", "Urdu", "Arabic", "Spanish", "French", "German", "Chinese", "Japanese"];

// ---------------------------------------------------------------------------
// Claude API (streamed through Rust)

type Block = { type: string; [k: string]: unknown };
type Message = { role: "user" | "assistant"; content: string | Block[] };
type Reply = { content: Block[]; stopReason: string | null };
type Run = { cancelled: boolean; requestId?: string };

export class AiError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
  }
}

let requestSeq = 0;

/**
 * One streamed Messages API call. `onText` gets the reply's text so far; `onUpdate` gets the
 * progress notes Claude writes between tool calls. Resolves with the complete content blocks.
 */
async function callClaude(
  body: Record<string, unknown>,
  run: Run,
  on: { onText?: (text: string) => void; onUpdate?: (text: string) => void } = {},
  betas = BETAS,
): Promise<Reply> {
  const requestId = `r${++requestSeq}`;
  run.requestId = requestId;
  const blocks: Block[] = [];
  const json = new Map<number, string>();
  let stopReason: string | null = null;
  let streamError: AiError | null = null;
  let done = () => {};
  const finished = new Promise<void>((r) => (done = r));

  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    if (data === "[DONE]") return done();
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "content_block_start") {
      blocks[ev.index] = { ...ev.content_block };
      if (ev.content_block.type === "tool_use") json.set(ev.index, "");
    } else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index];
      const d = ev.delta;
      if (!b) return;
      if (d.type === "text_delta") {
        b.text = ((b.text as string) ?? "") + d.text;
        on.onText?.(textOf(blocks));
      } else if (d.type === "thinking_delta") {
        b.thinking = ((b.thinking as string) ?? "") + d.thinking;
        if ((b.thinking as string).trim()) on.onUpdate?.(b.thinking as string);
      } else if (d.type === "signature_delta") {
        b.signature = ((b.signature as string) ?? "") + d.signature;
      } else if (d.type === "input_json_delta") {
        json.set(ev.index, (json.get(ev.index) ?? "") + d.partial_json);
      }
    } else if (ev.type === "content_block_stop") {
      const b = blocks[ev.index];
      if (b?.type === "tool_use") {
        // Tool input streams as JSON fragments; it can be cut short, so parse defensively.
        try {
          b.input = JSON.parse(json.get(ev.index) || "{}");
        } catch {
          b.input = {};
          b.invalid = true;
        }
      }
    } else if (ev.type === "message_delta") {
      stopReason = ev.delta?.stop_reason ?? stopReason;
    } else if (ev.type === "error") {
      const kind = ev.error?.type === "overloaded_error" ? "overloaded" : "api";
      streamError = new AiError(kind, ev.error?.message ?? "Claude reported an error.");
    }
  };

  try {
    await invoke("ai_stream", { requestId, body: JSON.stringify(body), betas, onEvent: channel });
  } catch (e) {
    const info = e as { kind?: string; message?: string };
    throw new AiError(info.kind ?? "api", info.message ?? String(e));
  }
  await finished;
  if (streamError) throw streamError;
  if (run.cancelled) throw new AiError("cancelled", "Stopped.");
  return { content: blocks.filter(Boolean), stopReason };
}

function cancel(run: Run) {
  run.cancelled = true;
  if (run.requestId) void invoke("ai_cancel", { requestId: run.requestId });
}

function textOf(blocks: Block[]) {
  return blocks
    .filter((b) => b?.type === "text")
    .map((b) => b.text as string)
    .join("");
}

/**
 * The assistant turn to send back next time. After a refusal fallback mid-reply, blocks before the
 * last `fallback` marker other than text belong to the declined model and must be left out.
 */
function echoable(content: Block[]): Block[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  return content
    .filter((b, i) => b.type !== "fallback" && !(i < last && ["thinking", "redacted_thinking", "tool_use"].includes(b.type)))
    .map(({ invalid: _invalid, ...b }) => b as Block);
}

// ---------------------------------------------------------------------------
// API key

let keyKnown: boolean | null = null;

async function hasKey() {
  keyKnown ??= await invoke<boolean>("ai_has_key");
  return keyKnown;
}

const keyEl = document.createElement("div");
keyEl.id = "ai-key";
keyEl.hidden = true;
keyEl.innerHTML = `
  <form class="panel">
    <h2>Connect Claude</h2>
    <p>AI features use your own Claude API key. Create one at <b>console.anthropic.com</b> → API keys, then paste it here.
    It is kept in Windows Credential Manager, not in the app's files.</p>
    <input type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false" />
    <div class="row">
      <button type="submit" class="primary">Save key</button>
      <button type="button" class="remove">Remove key</button>
      <span class="status" aria-live="polite"></span>
    </div>
  </form>`;
document.body.append(keyEl);
const keyForm = keyEl.querySelector("form")!;
const keyInput = keyEl.querySelector("input")!;
const keyStatus = keyEl.querySelector<HTMLElement>(".status")!;
let afterKey: (() => void) | null = null;

/** Show the key setup (Ctrl+,). `then` runs once a working key is saved. */
export function openKeySetup(then?: () => void) {
  afterKey = then ?? null;
  keyInput.value = "";
  keyStatus.textContent = keyKnown ? "A key is saved. Paste a new one to replace it." : "";
  if (keyEl.hidden) {
    keyEl.hidden = false;
    registerOverlay(keyEl, closeKeySetup);
  }
  keyInput.focus();
}

function closeKeySetup() {
  if (keyEl.hidden) return;
  keyEl.hidden = true;
  unregisterOverlay(keyEl);
  afterKey = null;
}

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  keyStatus.textContent = "Checking…";
  try {
    await invoke("ai_set_key", { key });
    keyKnown = true;
    // A tiny request proves the key works before the user relies on it.
    await callClaude(
      { model: MODEL, max_tokens: 256, stream: true, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with OK." }] },
      { cancelled: false },
      {},
      [],
    );
    const then = afterKey;
    closeKeySetup();
    showIndicator("Claude connected");
    then?.();
  } catch (err) {
    const e = err as AiError;
    if (e.kind === "auth") {
      await invoke("ai_clear_key").catch(() => {});
      keyKnown = false;
    }
    keyStatus.textContent = e.message;
  }
});

keyEl.querySelector(".remove")!.addEventListener("click", async () => {
  await invoke("ai_clear_key").catch(() => {});
  keyKnown = false;
  keyStatus.textContent = "Key removed.";
});

keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeKeySetup();
  }
});

keyEl.addEventListener("click", (e) => {
  if (e.target === keyEl) closeKeySetup();
});

/** Run `fn` now if a key is saved, otherwise after the user adds one. */
async function withKey(fn: () => void) {
  if (await hasKey()) fn();
  else openKeySetup(fn);
}

function friendly(e: unknown): string {
  if (e instanceof AiError) return e.message;
  return `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------------------
// Markdown (just what answers use): paragraphs, lists, headings, code, bold, italics, [p. N] citations

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[(?:pp?\.|pages?)\s*(\d+)(?:\s*[–-]\s*(\d+))?\]/gi, (_m, a: string, b?: string) =>
      `<button type="button" class="cite" data-page="${a}">${b ? `pp. ${a}–${b}` : `p. ${a}`}</button>`,
    );
}

function markdown(src: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list = null as { tag: "ul" | "ol"; items: string[] } | null;
  let code = null as string[] | null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of src.split("\n")) {
    if (code) {
      if (line.trimStart().startsWith("```")) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = /^#{1,6}\s+(.*)/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  if (code) out.push(`<pre><code>${esc((code as string[]).join("\n"))}</code></pre>`);
  flushPara();
  flushList();
  return out.join("");
}

/** Plain text for comments and the clipboard: markdown markers removed, long lines wrapped. */
function plain(src: string, width = 70): string {
  return src
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .split("\n")
    .flatMap((line) => {
      const lines: string[] = [];
      let cur = "";
      for (const word of line.split(" ")) {
        if (cur && (cur + " " + word).length > width) {
          lines.push(cur);
          cur = word;
        } else cur = cur ? `${cur} ${word}` : word;
      }
      lines.push(cur);
      return lines;
    })
    .join("\n")
    .trim();
}

/** Re-render streamed markdown at most once per frame. */
function renderer(el: HTMLElement) {
  let pending = "";
  let frame = 0;
  return (text: string) => {
    pending = text;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        el.innerHTML = markdown(pending);
      });
  };
}

// Citations jump to the page and flash it.
document.addEventListener("click", (e) => {
  const cite = (e.target as Element).closest<HTMLElement>(".cite");
  if (!cite) return;
  const n = Number(cite.dataset.page);
  if (!n || n > getPageCount()) return;
  goToPage(n);
  const page = getPageElement(n);
  page?.classList.remove("ai-flash");
  void page?.offsetWidth; // restart the animation
  page?.classList.add("ai-flash");
});

// ---------------------------------------------------------------------------
// Ask about selected text (right-click a selection → Explain / Simplify / Define / Translate)

export type Selected = { text: string; n: number; x: number; y: number; bottom: number };
export type QuickAction = "explain" | "simplify" | "define" | "translate";
export const QUICK_ACTIONS: { id: QuickAction; label: string }[] = [
  { id: "explain", label: "Explain" },
  { id: "simplify", label: "Simplify" },
  { id: "define", label: "Define" },
  { id: "translate", label: "Translate" },
];

/** The text selected on a page, with its position in page units. Null if nothing is selected. */
export function currentSelection(): Selected | null {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const text = s.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const range = s.getRangeAt(0);
  const node = range.startContainer;
  const pageEl = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".page");
  if (!pageEl) return null;
  const n = Number(pageEl.dataset.index) + 1;
  const size = getPageSize(n);
  if (!size) return null;
  const pr = pageEl.getBoundingClientRect();
  const rr = range.getBoundingClientRect();
  const k = size.width / pr.width;
  return { text: text.slice(0, 4000), n, x: (rr.left - pr.left) * k, y: (rr.top - pr.top) * k, bottom: (rr.bottom - pr.top) * k };
}

function quickPrompt(action: QuickAction, lang: string) {
  switch (action) {
    case "explain":
      return "Explain the selected passage clearly, using the surrounding page for context. Define any jargon it relies on.";
    case "simplify":
      return "Rewrite the selected passage in plain, simple language a beginner would understand, keeping its meaning.";
    case "define":
      return "Define the selected term or phrase as it is used here, in one or two sentences, then give a short example if it helps.";
    case "translate":
      return `Translate the selected passage into ${lang}. Reply with only the translation. If it is already in ${lang}, translate it into English instead.`;
  }
}

type Card = { el: HTMLElement; run: Run; sel: Selected; action: QuickAction; answer: string };
let card: Card | null = null;

export function askAboutSelection(action: QuickAction, sel: Selected) {
  void withKey(() => void showCard(action, sel));
}

async function showCard(action: QuickAction, sel: Selected) {
  closeCard();
  const page = getPageElement(sel.n);
  const size = getPageSize(sel.n);
  if (!page || !size) return;

  const el = document.createElement("div");
  el.className = "ai-card panel";
  el.innerHTML = `
    <header><span class="ai-title"></span><select class="ai-lang" title="Language" hidden></select>
      <button type="button" class="ai-x" title="Close (Esc)" aria-label="Close">×</button></header>
    <div class="ai-body md"><p class="ai-wait">Thinking…</p></div>
    <footer>
      <button type="button" data-act="copy">Copy</button>
      <button type="button" data-act="comment">Save as comment</button>
      <button type="button" data-act="chat">Ask follow-up</button>
    </footer>`;
  el.querySelector(".ai-title")!.textContent = QUICK_ACTIONS.find((a) => a.id === action)!.label;
  // Below the selection, or above it when it's near the bottom of the page.
  el.style.left = `${Math.min(Math.max(0, sel.x / size.width), 0.55) * 100}%`;
  if (sel.bottom / size.height < 0.62) el.style.top = `calc(${(sel.bottom / size.height) * 100}% + 6px)`;
  else el.style.bottom = `calc(${(1 - sel.y / size.height) * 100}% + 6px)`;
  page.append(el);

  const c: Card = { el, run: { cancelled: false }, sel, action, answer: "" };
  card = c;
  registerOverlay(el, closeCard);

  const lang = (await getSetting<string>("aiLanguage")) ?? "English";
  const langSel = el.querySelector<HTMLSelectElement>(".ai-lang")!;
  if (action === "translate") {
    langSel.hidden = false;
    for (const l of LANGUAGES) langSel.append(new Option(l, l, false, l === lang));
    langSel.addEventListener("change", () => {
      void setSetting("aiLanguage", langSel.value);
      void showCard("translate", sel);
    });
  }
  el.querySelector(".ai-x")!.addEventListener("click", closeCard);
  el.querySelector("footer")!.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
    if (!act || !c.answer) return;
    if (act === "copy") {
      void navigator.clipboard.writeText(plain(c.answer, 10_000));
      showIndicator("Copied");
    } else if (act === "comment") {
      addComment(sel.n, sel.x, sel.bottom + 4, plain(c.answer));
      closeCard();
      showIndicator("Saved as a comment");
    } else if (act === "chat") {
      closeCard();
      followUp(c);
    }
  });

  const body = el.querySelector<HTMLElement>(".ai-body")!;
  const render = renderer(body);
  try {
    const context = await pageText(sel.n);
    const doc = getDoc();
    const reply = await callClaude(
      {
        model: MODEL,
        max_tokens: 16000,
        stream: true,
        output_config: { effort: "low" },
        fallbacks: "default",
        system:
          "You help someone understand a passage in a PDF they are reading. Answer in Markdown, briefly: a short paragraph or a few bullets, with no preamble.",
        messages: [
          {
            role: "user",
            content:
              `Document: "${doc?.name ?? "PDF"}", page ${sel.n}.\n\n<page>\n${context}\n</page>\n\n` +
              `<selection>\n${sel.text}\n</selection>\n\n${quickPrompt(action, lang)}`,
          },
        ],
      },
      c.run,
      { onText: (t) => card === c && render((c.answer = t)) },
      BETAS.slice(0, 1),
    );
    if (reply.stopReason === "refusal") throw new AiError("refusal", "Claude declined to answer this.");
    c.answer = textOf(reply.content);
    if (card === c) render(c.answer);
  } catch (e) {
    if (card === c && !(e instanceof AiError && e.kind === "cancelled")) {
      body.innerHTML = `<p class="ai-error"></p>`;
      body.firstElementChild!.textContent = friendly(e);
      if (e instanceof AiError && (e.kind === "auth" || e.kind === "no_key")) openKeySetup(() => void showCard(action, sel));
    }
  }
}

function closeCard() {
  const c = card;
  if (!c) return;
  card = null;
  cancel(c.run);
  c.el.remove();
  unregisterOverlay(c.el);
}

// ---------------------------------------------------------------------------
// Chat with the PDF: agentic RAG over the document's own text

const strict = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const int = (description: string) => ({ type: "integer", description });

const TOOLS = [
  {
    name: "search_document",
    description:
      "Search the open PDF's text. Returns the best-matching pages, best first, each with its number of hits and a short snippet. " +
      "Matches the whole phrase and each keyword (case-insensitive), so use the words the document itself would use. " +
      "Use it to find where something is discussed, then read those pages.",
    input_schema: strict({
      query: { type: "string", description: "Words or a short phrase, e.g. 'learning rate' or 'mel spectrogram'." },
      max_results: int("How many pages to return, 1 to 20."),
    }),
  },
  {
    name: "read_pages",
    description: `Read the full text of pages first_page to last_page (at most ${READ_PAGES} pages per call). Pages are numbered from 1.`,
    input_schema: strict({ first_page: int("First page to read."), last_page: int("Last page to read.") }),
  },
  {
    name: "get_outline",
    description: "Get the document's table of contents (bookmarks) with the page each entry starts on. Useful for structure and for summaries.",
    input_schema: strict({}),
  },
  {
    name: "get_annotations",
    description:
      "Get the reader's own highlights (with the text under them), drawings and comments on pages first_page to last_page. " +
      "Use it when they ask about what they marked or noted.",
    input_schema: strict({ first_page: int("First page."), last_page: int("Last page.") }),
  },
].map((t) => ({ ...t, strict: true, eager_input_streaming: true }));

const SYSTEM = `You are the reading assistant inside Minimal PDF, a desktop PDF reader. Answer questions about the document the user has open.

Use the tools to look things up: search_document to find where a topic appears, read_pages to read pages, get_outline for the structure, get_annotations for the reader's own highlights and comments. Base your answers on text you have actually read, not on what you remember about the document or its authors.

Cite the pages you used after each claim, as [p. 12] or [pp. 12–14]. Citations become links in the app, so use exactly that form.

If the document doesn't cover the question, say so plainly. You may then add general knowledge, clearly labelled as not from the document.

Keep answers concise: short paragraphs or bullet lists, bold for key terms, no headings unless the answer is long.`;

type Turn = { el: HTMLElement; steps: HTMLElement; answer: HTMLElement };
let history: Message[] = [];
let system: Promise<Block[]> | null = null;
let running: Run | null = null;

/** The system prompt; short documents also get their full text, cached, so most questions need no tools. */
function systemFor(): Promise<Block[]> {
  system ??= (async () => {
    const doc = getDoc()!;
    const blocks: Block[] = [{ type: "text", text: `${SYSTEM}\n\nThe open document is "${doc.name}" (${doc.pageCount} pages).` }];
    if (doc.pageCount <= INLINE_MAX_PAGES) {
      let all = "";
      for (let n = 1; n <= doc.pageCount && all.length <= INLINE_LIMIT; n++) all += `--- Page ${n} ---\n${await pageText(n)}\n`;
      if (all.length <= INLINE_LIMIT && all.replace(/--- Page \d+ ---/g, "").trim()) {
        blocks.push({
          type: "text",
          text: `The document is short, so its full text is included here. You can answer from it directly and use the tools only if needed.\n\n<document>\n${all}</document>`,
          cache_control: { type: "ephemeral" },
        });
      }
    }
    return blocks;
  })();
  return system;
}

const chatEl = document.createElement("aside");
chatEl.id = "ai-chat";
chatEl.className = "panel";
chatEl.hidden = true;
chatEl.setAttribute("aria-label", "Ask this PDF");
chatEl.innerHTML = `
  <header>
    <h2>Ask this PDF</h2>
    <button type="button" class="ai-x" title="Close (Esc)" aria-label="Close">×</button>
  </header>
  <div class="ai-chips">
    <button type="button" data-sum="page">Summarise page</button>
    <button type="button" data-sum="section">Summarise section</button>
    <button type="button" data-sum="doc">Summarise document</button>
  </div>
  <div class="ai-log" aria-live="polite"></div>
  <form class="ai-ask">
    <textarea rows="1" placeholder="Ask about this PDF…" spellcheck="true"></textarea>
    <button type="submit" class="ai-send" title="Send (Enter)">Ask</button>
  </form>
  <p class="ai-note">Your questions and the pages Claude reads are sent to Anthropic. <span class="ai-keylink" role="button" tabindex="0">API key</span></p>`;
document.body.append(chatEl);
const logEl = chatEl.querySelector<HTMLElement>(".ai-log")!;
const askForm = chatEl.querySelector<HTMLFormElement>(".ai-ask")!;
const askInput = chatEl.querySelector("textarea")!;
const sendBtn = chatEl.querySelector<HTMLButtonElement>(".ai-send")!;

export function toggleChat() {
  if (!chatEl.hidden) return closeChat();
  if (!getPageCount()) return;
  void withKey(openChat);
}

function openChat() {
  if (chatEl.hidden) {
    chatEl.hidden = false;
    registerOverlay(chatEl, closeChat);
  }
  askInput.focus();
}

function closeChat() {
  if (chatEl.hidden) return;
  chatEl.hidden = true;
  unregisterOverlay(chatEl);
  askInput.blur();
}

function addTurn(question: string): Turn {
  const el = document.createElement("div");
  el.className = "ai-turn";
  const q = document.createElement("div");
  q.className = "ai-q";
  q.textContent = question;
  const steps = document.createElement("ul");
  steps.className = "ai-steps";
  const answer = document.createElement("div");
  answer.className = "ai-a md";
  el.append(q, steps, answer);
  logEl.append(el);
  logEl.scrollTop = logEl.scrollHeight;
  return { el, steps, answer };
}

function addStep(turn: Turn, text: string) {
  const li = document.createElement("li");
  li.textContent = text;
  turn.steps.append(li);
  logEl.scrollTop = logEl.scrollHeight;
  return li;
}

function setRunning(run: Run | null) {
  running = run;
  sendBtn.textContent = run ? "Stop" : "Ask";
  sendBtn.title = run ? "Stop" : "Send (Enter)";
  chatEl.classList.toggle("busy", !!run);
}

/** Ask a question in the chat. `shown` is what the log displays (defaults to the question). */
async function ask(question: string, opts: { shown?: string; steps?: number; onDone?: (answer: string) => void } = {}) {
  if (running || !getDoc()) return;
  const doc = getDoc();
  const turn = addTurn(opts.shown ?? question);
  const run: Run = { cancelled: false };
  setRunning(run);
  const mark = history.length;
  history.push({ role: "user", content: `${question}\n\n(I'm on page ${getCurrentPage()}.)` });
  const render = renderer(turn.answer);
  turn.answer.innerHTML = `<p class="ai-wait">Thinking…</p>`;
  let update: HTMLLIElement | null = null;
  try {
    const sys = await systemFor();
    for (let step = 0; ; step++) {
      if (step >= (opts.steps ?? MAX_STEPS)) throw new AiError("api", "Stopped after too many steps. Try a narrower question.");
      update = null;
      const reply = await callClaude(
        {
          model: MODEL,
          max_tokens: 64000,
          stream: true,
          system: sys,
          tools: TOOLS,
          messages: history,
          thinking: { type: "adaptive", display: "updates" },
          output_config: { effort: "medium" },
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
        },
        run,
        {
          onText: (t) => render(t),
          // Progress notes between tool calls show as steps.
          onUpdate: (t) => {
            update ??= addStep(turn, "");
            update.textContent = t.trim();
            update.classList.add("note");
          },
        },
      );
      if (getDoc() !== doc) return;
      const content = echoable(reply.content);
      history.push({ role: "assistant", content });
      if (reply.stopReason === "refusal") throw new AiError("refusal", "Claude declined to answer this.");
      const uses = content.filter((b) => b.type === "tool_use");
      if (reply.stopReason === "max_tokens" && uses.length) throw new AiError("api", "The answer was cut off. Try a narrower question.");
      if (reply.stopReason !== "tool_use" || !uses.length) {
        const answer = textOf(content);
        render(answer || "_No answer._");
        opts.onDone?.(answer);
        break;
      }
      // Text written before the tool calls ("Let me check the methods section") becomes a step.
      const said = textOf(content).trim();
      if (said) addStep(turn, said).classList.add("note");
      render("");
      turn.answer.innerHTML = `<p class="ai-wait">Reading…</p>`;
      const results = await Promise.all(uses.map((u) => runTool(u, turn)));
      if (run.cancelled) throw new AiError("cancelled", "Stopped.");
      history.push({ role: "user", content: results });
    }
  } catch (e) {
    history.length = mark; // forget the failed question so the conversation stays valid
    if (getDoc() !== doc) return;
    turn.answer.innerHTML = `<p class="ai-error"></p>`;
    turn.answer.firstElementChild!.textContent = friendly(e);
    if (e instanceof AiError && (e.kind === "auth" || e.kind === "no_key")) openKeySetup();
  } finally {
    if (running === run) setRunning(null);
  }
}

function pagesArg(input: Record<string, unknown>): [number, number] | string {
  const total = getPageCount();
  const a = input.first_page;
  const b = input.last_page;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return "first_page and last_page must be whole numbers.";
  const from = Math.max(1, Math.min(a as number, total));
  const to = Math.max(from, Math.min(b as number, total));
  return [from, to];
}

async function runTool(use: Block, turn: Turn): Promise<Block> {
  const result = (content: string, isError = false): Block => ({
    type: "tool_result",
    tool_use_id: use.id as string,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  if (use.invalid) return result("The tool input was not valid JSON. Try again.", true);
  const input = (use.input ?? {}) as Record<string, unknown>;
  const range = (from: number, to: number) => (from === to ? `p. ${from}` : `pp. ${from}–${to}`);
  try {
    switch (use.name) {
      case "search_document": {
        const q = input.query;
        const max = input.max_results;
        if (typeof q !== "string" || !q.trim()) return result("query must be a non-empty string.", true);
        addStep(turn, `Searching “${q}”`);
        const hits = await searchText(q, Number.isInteger(max) ? Math.min(Math.max(max as number, 1), 20) : 8);
        if (!hits.length) return result("No matches. Try other words, or get_outline to find the right section.");
        return result(hits.map((h) => `p. ${h.page} (${h.hits} hits): ${h.snippet}`).join("\n"));
      }
      case "read_pages": {
        const r = pagesArg(input);
        if (typeof r === "string") return result(r, true);
        const [from] = r;
        const to = Math.min(r[1], from + READ_PAGES - 1);
        addStep(turn, `Reading ${range(from, to)}`);
        let out = "";
        for (let n = from; n <= to; n++) {
          const chunk = `--- Page ${n} ---\n${(await pageText(n)) || "(no text on this page; it may be a scanned image)"}\n`;
          if (out && out.length + chunk.length > READ_LIMIT) {
            out += `--- Stopped before page ${n} (read limit); read it in another call ---\n`;
            break;
          }
          out += chunk;
        }
        if (to < r[1]) out += `--- Only ${READ_PAGES} pages per call; read pages ${to + 1}–${r[1]} in another call ---\n`;
        return result(out);
      }
      case "get_outline": {
        addStep(turn, "Reading the table of contents");
        const items = await getOutlineItems();
        if (!items.length) return result(`This PDF has no table of contents. It has ${getPageCount()} pages.`);
        return result(items.map((i) => `${"  ".repeat(i.level)}${i.title} (p. ${i.page})`).join("\n"));
      }
      case "get_annotations": {
        const r = pagesArg(input);
        if (typeof r === "string") return result(r, true);
        addStep(turn, "Looking at your highlights and comments");
        const list = annotationList(r[0], r[1]);
        if (!list.length) return result(`No highlights, drawings or comments on ${range(r[0], r[1])}.`);
        const lines: string[] = [];
        for (const a of list) {
          if (a.kind === "comment") lines.push(`p. ${a.page} comment: ${a.text}`);
          else if (a.kind === "highlight") lines.push(`p. ${a.page} highlighted: "${await textUnder(a.page, a.box)}"`);
          else lines.push(`p. ${a.page} ${a.kind === "rect" ? "box" : a.kind === "ellipse" ? "circle" : `${a.kind} mark`} around: "${await textUnder(a.page, a.box)}"`);
        }
        return result(lines.join("\n"));
      }
    }
    return result(`Unknown tool ${String(use.name)}.`, true);
  } catch (e) {
    return result(`The tool failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/** The text whose lines sit inside a box on page n (for highlights and drawn marks). */
async function textUnder(n: number, box: { x: number; y: number; w: number; h: number }) {
  const words: string[] = [];
  for (const t of await textBoxes(n)) {
    const cy = t.y + t.h / 2;
    const overlap = Math.min(t.x + t.w, box.x + box.w) - Math.max(t.x, box.x);
    if (cy >= box.y && cy <= box.y + box.h && overlap > Math.min(t.w, box.w) * 0.3) words.push(t.str);
  }
  return words.join(" ").replace(/\s+/g, " ").trim().slice(0, 600) || "(no text under it)";
}

// ---------------------------------------------------------------------------
// Summaries (saved per file, so reopening one is instant and free)

type SummaryKind = "page" | "section" | "doc";

async function summarise(kind: SummaryKind) {
  if (running) return;
  const n = getCurrentPage();
  let from = n;
  let to = n;
  let label = `page ${n}`;
  if (kind === "section") {
    const s = await sectionAt(n);
    if (s) {
      from = s.from;
      to = s.to;
      label = `the section “${s.title}” (${from === to ? `p. ${from}` : `pp. ${from}–${to}`})`;
    }
  } else if (kind === "doc") {
    from = 1;
    to = getPageCount();
    label = "the whole document";
  }
  const key = `${kind}:${from}-${to}`;
  const saved = (await getDocData<Record<string, string>>("aiSummaries")) ?? {};
  const shown = `Summarise ${label}`;
  const question =
    kind === "doc"
      ? "Summarise the whole document. Start from the table of contents (or the first pages if there is none), read the parts that carry the main ideas, then give a short overview followed by the key points as bullets, with page citations."
      : `Summarise ${label}. Read pages ${from}–${to}, then give a short overview followed by the key points as bullets, with page citations.`;

  if (saved[key]) {
    const turn = addTurn(shown);
    turn.answer.innerHTML = markdown(saved[key]);
    const again = addStep(turn, "Saved summary · ");
    const redo = document.createElement("button");
    redo.type = "button";
    redo.className = "ai-link";
    redo.textContent = "Summarise again";
    redo.addEventListener("click", () => {
      delete saved[key];
      void setDocData("aiSummaries", saved).then(() => summarise(kind));
    });
    again.append(redo);
    history.push({ role: "user", content: question }, { role: "assistant", content: saved[key] });
    return;
  }
  await ask(question, {
    shown,
    steps: kind === "doc" ? 24 : MAX_STEPS,
    onDone: (answer) => {
      if (!answer) return;
      void getDocData<Record<string, string>>("aiSummaries").then((s) => setDocData("aiSummaries", { ...(s ?? {}), [key]: answer }));
    },
  });
}

/** Continue a quick answer in the chat: the passage and the answer become the start of the conversation. */
function followUp(c: Card) {
  const label = QUICK_ACTIONS.find((a) => a.id === c.action)!.label;
  const question = `${quickPrompt(c.action, "English")}\n\nPassage from p. ${c.sel.n}:\n"${c.sel.text}"`;
  const turn = addTurn(`${label}: “${c.sel.text.length > 120 ? c.sel.text.slice(0, 120) + "…" : c.sel.text}”`);
  turn.answer.innerHTML = markdown(c.answer);
  history.push({ role: "user", content: question }, { role: "assistant", content: c.answer });
  openChat();
}

askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (running) return cancel(running);
  const q = askInput.value.trim();
  if (!q) return;
  askInput.value = "";
  sizeInput();
  void ask(q);
});

function sizeInput() {
  askInput.style.height = "auto";
  askInput.style.height = `${Math.min(askInput.scrollHeight, 160)}px`;
}

askInput.addEventListener("input", sizeInput);
askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    askForm.requestSubmit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeChat();
  }
});

chatEl.querySelector(".ai-x")!.addEventListener("click", closeChat);
chatEl.querySelector(".ai-chips")!.addEventListener("click", (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.sum as SummaryKind | undefined;
  if (kind) void summarise(kind);
});
const keyLink = chatEl.querySelector<HTMLElement>(".ai-keylink")!;
keyLink.addEventListener("click", () => openKeySetup());
keyLink.addEventListener("keydown", (e) => {
  if (e.key === "Enter") openKeySetup();
});

// A new document starts a new conversation.
events.addEventListener("close", () => {
  closeCard();
  closeChat();
  if (running) cancel(running);
  setRunning(null);
  history = [];
  system = null;
  logEl.replaceChildren();
});
