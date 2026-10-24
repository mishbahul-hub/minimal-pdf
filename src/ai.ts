// AI features: ask about selected text, chat with the PDF and summaries, with any provider (llm.ts).
// Chat is agentic RAG: the model gets tools that search and read this document (search_document,
// read_pages, get_outline, get_annotations), decides what to look up, and cites the pages it read as
// [p. N]. Models without tool calling get simple RAG: the app searches first and sends the best pages.
// Requests go through Rust (ai.rs), which holds the API keys; nothing is sent until the user asks.
import { events, getCurrentPage, getDoc, getPageCount, getPageElement, getPageSize, goToPage, showIndicator } from "./viewer";
import { registerOverlay, unregisterOverlay } from "./overlays";
import { pageText, searchText, textBoxes } from "./search";
import { getOutlineItems, sectionAt } from "./outline";
import { addComment, annotationList, getDocData, setDocData } from "./annotate";
import { getSetting, setSetting } from "./settings";
import { AiError, aiEvents, callModel, cancel, friendly, getAiConfig, providerInfo, textOf, type Block, type Message, type Run, type Tool } from "./llm";
import { openKeySetup, withHfToken, withKey } from "./aisettings";
import { LANGS, langInfo, MIN_SUMMARY_CHARS, summarize, translate, type LangId } from "./hf";

export { openKeySetup };

const MAX_STEPS = 12; // tool rounds per question (summaries get more)
const SIMPLE_RAG_PAGES = 4; // pages sent to models without tool calling

/** How much text one request may carry. Free tiers have small per-minute token limits. */
type Budget = { readPages: number; readChars: number; inlineChars: number; inlinePages: number };
const LARGE: Budget = { readPages: 8, readChars: 40_000, inlineChars: 60_000, inlinePages: 60 };
const SMALL: Budget = { readPages: 3, readChars: 12_000, inlineChars: 12_000, inlinePages: 12 };

async function budget(): Promise<Budget> {
  return providerInfo((await getAiConfig()).provider).small ? SMALL : LARGE;
}

/** Errors that mean "fix the provider settings". */
function needsSetup(e: unknown) {
  return e instanceof AiError && (e.kind === "auth" || e.kind === "no_key");
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
// Ask about selected text (right-click a selection → Explain / Simplify / Define with the chat AI;
// Translate / Summarize with Hugging Face models, hf.ts)

export type Selected = { text: string; n: number; x: number; y: number; bottom: number };
export type QuickAction = "explain" | "simplify" | "define" | "translate" | "summarize";
export const QUICK_ACTIONS: { id: QuickAction; label: string }[] = [
  { id: "explain", label: "Explain" },
  { id: "simplify", label: "Simplify" },
  { id: "define", label: "Define" },
  { id: "translate", label: "Translate" },
  { id: "summarize", label: "Summarize" },
];
const HF_ACTIONS: QuickAction[] = ["translate", "summarize"];

/** The language Translate / Summarize use ("en" = summary in English only). */
async function hfLanguage(): Promise<LangId | "en"> {
  const saved = await getSetting<string>("hfLanguage");
  return saved === "en" || LANGS.some((l) => l.id === saved) ? (saved as LangId | "en") : "hi";
}

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
      return `Translate the selected passage into ${lang}.`;
    case "summarize":
      return `Summarize the selected passage${lang === "English" ? "" : ` and translate the summary into ${lang}`}.`;
  }
}

type Card = { el: HTMLElement; run: Run; sel: Selected; action: QuickAction; answer: string };
let card: Card | null = null;

export function askAboutSelection(action: QuickAction, sel: Selected) {
  const show = () => void showCard(action, sel);
  void (HF_ACTIONS.includes(action) ? withHfToken(show) : withKey(show));
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
  // Keep the card inside the page, however narrow the page is.
  el.style.left = `max(0px, min(${(sel.x / size.width) * 100}%, 100% - 340px))`;
  if (sel.bottom / size.height < 0.62) el.style.top = `calc(${(sel.bottom / size.height) * 100}% + 6px)`;
  else el.style.bottom = `calc(${(1 - sel.y / size.height) * 100}% + 6px)`;
  page.append(el);

  const c: Card = { el, run: { cancelled: false }, sel, action, answer: "" };
  card = c;
  registerOverlay(el, closeCard);

  const hf = HF_ACTIONS.includes(action);
  const lang = await hfLanguage();
  const langSel = el.querySelector<HTMLSelectElement>(".ai-lang")!;
  if (hf) {
    langSel.hidden = false;
    if (action === "summarize") langSel.append(new Option("English only", "en", false, lang === "en"));
    for (const l of LANGS) langSel.append(new Option(`${l.name} · ${l.native}`, l.id, false, l.id === lang));
    if (action === "translate" && lang === "en") langSel.value = "hi";
    langSel.addEventListener("change", () => {
      void setSetting("hfLanguage", langSel.value);
      void showCard(action, sel);
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
  if (hf) return runHfCard(c, body, langSel.value as LangId | "en");
  const render = renderer(body);
  try {
    const context = await pageText(sel.n);
    const doc = getDoc();
    const reply = await callModel(
      {
        maxTokens: 16000,
        effort: "low",
        system: [
          {
            type: "text",
            text: "You help someone understand a passage in a PDF they are reading. Answer in Markdown, briefly: a short paragraph or a few bullets, with no preamble.",
          },
        ],
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
    );
    if (reply.stopReason === "refusal") throw new AiError("refusal", "The AI declined to answer this.");
    c.answer = textOf(reply.content);
    if (card === c) render(c.answer);
  } catch (e) {
    if (card === c && !(e instanceof AiError && e.kind === "cancelled")) {
      body.innerHTML = `<p class="ai-error"></p>`;
      body.firstElementChild!.textContent = friendly(e);
      if (needsSetup(e)) void openKeySetup(() => void showCard(action, sel));
    }
  }
}

/**
 * Translate, or summarize then translate, with Hugging Face models. The card shows each step, then
 * the English summary and/or the translation (right-to-left for Arabic).
 */
async function runHfCard(c: Card, body: HTMLElement, lang: LangId | "en") {
  const wait = body.querySelector<HTMLElement>(".ai-wait")!;
  const step = (text: string) => card === c && (wait.textContent = text);
  const section = (title: string, text: string, l?: LangId) => {
    const h = document.createElement("h4");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    if (l) {
      p.lang = l;
      p.dir = langInfo(l).rtl ? "rtl" : "ltr";
      p.className = "ai-translation";
    }
    return [h, p];
  };
  try {
    const parts: HTMLElement[] = [];
    const plainParts: string[] = [];
    let source = c.sel.text;
    if (c.action === "summarize") {
      if (source.length < MIN_SUMMARY_CHARS) {
        parts.push(...section("Summary (English)", "This passage is already short, so it isn't summarized."));
      } else {
        source = await summarize(source, step);
        parts.push(...section("Summary (English)", source));
        plainParts.push(`Summary: ${source}`);
      }
    }
    if (lang !== "en") {
      const l = langInfo(lang);
      const translated = await translate(source, lang, step);
      parts.push(...section(`${l.name} · ${l.native}`, translated, lang));
      plainParts.push(c.action === "summarize" ? `${l.name}: ${translated}` : translated);
    }
    if (card !== c) return;
    c.answer = plainParts.join("\n\n");
    body.replaceChildren(...parts);
  } catch (e) {
    if (card !== c) return;
    body.innerHTML = `<p class="ai-error"></p>`;
    body.firstElementChild!.textContent = friendly(e);
    if (needsSetup(e)) void openKeySetup(() => void showCard(c.action, c.sel), "hf");
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

/** The document tools offered to the model; how much read_pages returns depends on the provider. */
const toolsFor = (b: Budget): Tool[] => [
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
    description: `Read the full text of pages first_page to last_page (at most ${b.readPages} pages per call). Pages are numbered from 1.`,
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
];

const SYSTEM = `You are the reading assistant inside Minimal PDF, a desktop PDF reader. Answer questions about the document the user has open.

Use the tools to look things up: search_document to find where a topic appears, read_pages to read pages, get_outline for the structure, get_annotations for the reader's own highlights and comments. Base your answers on text you have actually read, not on what you remember about the document or its authors.

Cite the pages you used after each claim, as [p. 12] or [pp. 12–14]. Citations become links in the app, so use exactly that form.

If the document doesn't cover the question, say so plainly. You may then add general knowledge, clearly labelled as not from the document.

Keep answers concise: short paragraphs or bullet lists, bold for key terms, no headings unless the answer is long.`;

/** For models without tool calling: the app has already searched, and the best pages come with the question. */
const SIMPLE_SYSTEM = `You are the reading assistant inside Minimal PDF, a desktop PDF reader. Answer questions about the document the user has open.

With each question you get the pages of the document that best match it, found by a keyword search. Base your answers on those pages. Cite the pages you used after each claim, as [p. 12] or [pp. 12–14]; citations become links in the app, so use exactly that form.

If the pages don't answer the question, say so plainly. You may then add general knowledge, clearly labelled as not from the document.

Keep answers concise: short paragraphs or bullet lists, bold for key terms.`;

type Turn = { el: HTMLElement; steps: HTMLElement; answer: HTMLElement };
let history: Message[] = [];
let system: Promise<Block[]> | null = null;
let running: Run | null = null;
let noTools = false; // the model can't call tools: use simple RAG (until the provider changes)

/**
 * The system prompt. Short documents also get their full text (cached on Claude), so most questions
 * need no tools. Models without tool calling get the simple-RAG prompt.
 */
function systemFor(b: Budget): Promise<Block[]> {
  system ??= (async () => {
    const doc = getDoc()!;
    const about = `\n\nThe open document is "${doc.name}" (${doc.pageCount} pages).`;
    const blocks: Block[] = [{ type: "text", text: (noTools ? SIMPLE_SYSTEM : SYSTEM) + about }];
    if (doc.pageCount <= b.inlinePages) {
      let all = "";
      for (let n = 1; n <= doc.pageCount && all.length <= b.inlineChars; n++) all += `--- Page ${n} ---\n${await pageText(n)}\n`;
      if (all.length <= b.inlineChars && all.replace(/--- Page \d+ ---/g, "").trim()) {
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
  <p class="ai-note"><span class="ai-privacy"></span> <span class="ai-keylink" role="button" tabindex="0">Change provider</span></p>`;
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

async function openChat() {
  const p = providerInfo((await getAiConfig()).provider);
  chatEl.querySelector(".ai-privacy")!.textContent =
    p.id === "ollama" ? "Answers come from Ollama on this computer; nothing leaves it." : `Your questions and the pages the AI reads are sent to ${p.label}.`;
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

type AskOptions = {
  shown?: string; // what the log displays (defaults to the question)
  steps?: number; // tool rounds allowed
  pages?: [number, number]; // pages the question is about (summaries), for simple RAG
  onDone?: (answer: string) => void;
};

/** Ask a question in the chat: the agent loop, or simple RAG for models without tool calling. */
async function ask(question: string, opts: AskOptions = {}) {
  if (running || !getDoc()) return;
  const doc = getDoc();
  const turn = addTurn(opts.shown ?? question);
  const run: Run = { cancelled: false };
  setRunning(run);
  const mark = history.length;
  const userText = `${question}\n\n(I'm on page ${getCurrentPage()}.)`;
  history.push({ role: "user", content: userText });
  const render = renderer(turn.answer);
  turn.answer.innerHTML = `<p class="ai-wait">Thinking…</p>`;
  let update: HTMLLIElement | null = null;
  try {
    const b = await budget();
    const sys = await systemFor(b);
    if (noTools) {
      // Simple RAG: search first, then send the best pages with the question (only for this request,
      // so the conversation doesn't grow by whole pages every turn).
      const context = await retrieve(question, turn, b, opts.pages);
      const messages: Message[] = [...history.slice(0, mark), { role: "user", content: `${userText}\n\n${context}` }];
      const reply = await callModel({ system: sys, messages, maxTokens: 64000, effort: "medium" }, run, { onText: (t) => render(t) });
      if (getDoc() !== doc) return;
      if (reply.stopReason === "refusal") throw new AiError("refusal", "The AI declined to answer this.");
      const answer = textOf(reply.content);
      history.push({ role: "assistant", content: answer || "(no answer)" });
      render(answer || "_No answer._");
      opts.onDone?.(answer);
      return;
    }
    for (let step = 0; ; step++) {
      if (step >= (opts.steps ?? MAX_STEPS)) throw new AiError("api", "Stopped after too many steps. Try a narrower question.");
      update = null;
      let reply;
      try {
        reply = await callModel({ system: sys, messages: history, tools: toolsFor(b), maxTokens: 64000, effort: "medium" }, run, {
          onText: (t) => render(t),
          // Progress notes between tool calls show as steps.
          onUpdate: (t) => {
            update ??= addStep(turn, "");
            update.textContent = t.trim();
            update.classList.add("note");
          },
        });
      } catch (e) {
        if (step > 0 || !toolsUnsupported(e)) throw e;
        // This model can't call tools: switch to simple RAG and ask again.
        noTools = true;
        announceNoTools = true;
        system = null;
        history.length = mark;
        turn.el.remove();
        setRunning(null);
        return ask(question, opts);
      }
      if (getDoc() !== doc) return;
      const content = reply.content;
      history.push({ role: "assistant", content });
      if (reply.stopReason === "refusal") throw new AiError("refusal", "The AI declined to answer this.");
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
      const results = await Promise.all(uses.map((u) => runTool(u, turn, b)));
      if (run.cancelled) throw new AiError("cancelled", "Stopped.");
      history.push({ role: "user", content: results });
    }
  } catch (e) {
    history.length = mark; // forget the failed question so the conversation stays valid
    if (getDoc() !== doc) return;
    turn.answer.innerHTML = `<p class="ai-error"></p>`;
    turn.answer.firstElementChild!.textContent = friendly(e);
    if (needsSetup(e)) void openKeySetup();
  } finally {
    if (running === run) setRunning(null);
  }
}

let announceNoTools = false;

/** A request with tools was refused because the model can't call them. */
function toolsUnsupported(e: unknown) {
  return e instanceof AiError && e.kind === "api" && /error (400|404|422)\b/.test(e.message) && /tool|function/i.test(e.message);
}

/**
 * Simple RAG: the keyword search picks the best pages (or the given range), and their text is
 * returned for the prompt, within the provider's budget.
 */
async function retrieve(question: string, turn: Turn, b: Budget, range?: [number, number]): Promise<string> {
  if (announceNoTools) {
    addStep(turn, "This model can't use tools, so the app searches the PDF and sends it the best pages.").classList.add("note");
    announceNoTools = false;
  }
  let pages: number[];
  if (range) {
    pages = [];
    for (let n = range[0]; n <= range[1]; n++) pages.push(n);
  } else {
    addStep(turn, `Searching “${question.length > 60 ? question.slice(0, 60) + "…" : question}”`);
    pages = (await searchText(question, SIMPLE_RAG_PAGES)).map((h) => h.page);
    if (!pages.length) pages = [getCurrentPage()];
  }
  let out = "";
  const read: number[] = [];
  for (const n of pages) {
    const chunk = `--- Page ${n} ---\n${(await pageText(n)) || "(no text on this page)"}\n`;
    if (out && out.length + chunk.length > b.readChars) break;
    out += chunk;
    read.push(n);
  }
  addStep(turn, `Reading ${read.map((n) => `p. ${n}`).join(", ")}`);
  return `<pages>\n${out}</pages>`;
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

async function runTool(use: Block, turn: Turn, b: Budget): Promise<Block> {
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
        const to = Math.min(r[1], from + b.readPages - 1);
        addStep(turn, `Reading ${range(from, to)}`);
        let out = "";
        for (let n = from; n <= to; n++) {
          const chunk = `--- Page ${n} ---\n${(await pageText(n)) || "(no text on this page; it may be a scanned image)"}\n`;
          if (out && out.length + chunk.length > b.readChars) {
            out += `--- Stopped before page ${n} (read limit); read it in another call ---\n`;
            break;
          }
          out += chunk;
        }
        if (to < r[1]) out += `--- Only ${b.readPages} pages per call; read pages ${to + 1}–${r[1]} in another call ---\n`;
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
    pages: [from, to],
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
  const question = `${quickPrompt(c.action, c.el.querySelector<HTMLSelectElement>(".ai-lang")?.selectedOptions[0]?.textContent ?? "English")}\n\nPassage from p. ${c.sel.n}:\n"${c.sel.text}"`;
  const turn = addTurn(`${label}: “${c.sel.text.length > 120 ? c.sel.text.slice(0, 120) + "…" : c.sel.text}”`);
  turn.answer.innerHTML = markdown(c.answer);
  history.push({ role: "user", content: question }, { role: "assistant", content: c.answer });
  void openChat();
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

aiEvents.addEventListener("change", () => resetChat());

/** Start the conversation over (a new document, or a different provider or model). */
function resetChat() {
  if (running) cancel(running);
  setRunning(null);
  history = [];
  system = null;
  noTools = false;
  logEl.replaceChildren();
}

events.addEventListener("close", () => {
  closeCard();
  closeChat();
  resetChat();
});
