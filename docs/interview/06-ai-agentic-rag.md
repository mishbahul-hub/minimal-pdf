# 06 · AI assistant and agentic RAG

Source: `src/ai.ts` (features, agent loop, tools), `src/llm.ts` (providers, protocols, streaming),
`src-tauri/src/ai.rs` (keys, HTTP, SSE).

## Features

| Feature | How it works |
|---|---|
| Explain / Simplify / Define selected text | One LLM call with the selection and the text of its whole page as context; the answer appears in a card next to the text |
| Chat with the PDF (`c`) | Agentic RAG loop with tools; streamed answer with `[p. N]` citations |
| Summaries (page, section, document) | The same loop with a summary instruction; cached per file |
| Follow-up | "Ask follow-up" on a card moves the conversation into the chat |

## What is RAG?

**Retrieval-Augmented Generation:** before (or while) answering, the system *retrieves* relevant
text from a knowledge source and gives it to the LLM, so the answer is grounded in that text instead
of the model's memory. It reduces hallucination and lets the model work on documents it never saw.

### Classic RAG

Split the document into chunks → turn each chunk into an **embedding** vector → store in a **vector
database** → embed the question → retrieve the top-k most similar chunks → send them with the
question.

### What this project does instead: agentic RAG

The model gets **tools** and decides itself what to look up, repeatedly, like a person using a
book's index:

| Tool | Returns | Implemented with |
|---|---|---|
| `search_document(query)` | best pages + snippets | `searchText` in `search.ts` |
| `read_pages(first, last)` | full text of a few pages | `pageText` in `search.ts` |
| `get_outline()` | table of contents with page numbers | `getOutlineItems` in `outline.ts` |
| `get_annotations(first, last)` | the user's highlights (with the text under them), drawings, comments | `annotationList` in `annotate.ts` + `textBoxes` |

**Retrieval scoring** (`search_document`): for each page, whole phrase match ×10 + each matched
keyword ×3 + number of hits ×0.2 (capped); stopwords ("the", "which"…) ignored. Returns top pages
with a snippet.

### Why no embeddings / vector DB? (very likely interview question)

1. **No extra infrastructure or cost:** no embedding model to download or call, no database; the
   index is built instantly from text PDF.js already extracted.
2. **Works offline** with a local model (Ollama).
3. **Exact citations:** whole pages are read, so the answer can quote exactly and cite exact pages;
   chunking often splits context and loses page boundaries.
4. **The agent compensates for keyword search's weakness** (synonyms): if a search finds nothing,
   the model tries other words.

**Trade-offs (be honest):** more LLM round-trips (latency, tokens) than one-shot retrieval; depends
on the model being good at tool use; synonyms rely on the model rephrasing; very large documents
can't be read whole, so document summaries lean on the outline. **Would I add embeddings?** For a
multi-document library or semantic queries ("find where the author contradicts herself"), yes: a
hybrid (BM25 + embeddings) as an extra tool.

## The agent loop (in `ask()` in ai.ts)

```
history += user question (+ "I'm on page N")
loop up to 12 times (24 for whole-document summaries):
    reply = callModel(system prompt, history, tools)        # streamed
    history += reply
    if stop_reason == "refusal": show message, stop
    if stop_reason == "max_tokens" and reply has tool calls: error "answer cut off"
    if no tool calls: render the answer, done
    show any text before the tool calls as a "step"
    results = run all tool calls in parallel (Promise.all)
    history += tool results
on error: remove this question from history (keep the conversation valid), show a friendly message
```

Details worth mentioning:
- **Visible steps:** each tool call appears in the chat ("Searching 'dropout'", "Reading pp. 40–42"),
  so users can see where the answer came from (transparency builds trust).
- **Budgets:** large-context providers (Claude, Gemini) read up to 8 pages / 40k chars per call and
  short documents (≤ 60k chars) are put in the prompt whole; free tiers (Groq, HF, OpenRouter,
  Ollama) get 3 pages / 12k chars to stay under per-minute token limits.
- **Grounding prompt:** answer only from text that was read; cite as `[p. 41]` / `[pp. 40–42]`; say
  so if the document doesn't cover it.
- **Citations → links:** the answer's Markdown is rendered by a small custom renderer that escapes
  HTML first (no injection from model output), then `[p. N]` becomes a button that scrolls to the
  page and flashes it.
- **Stale answers:** if the user opens another PDF mid-answer, the result is discarded
  (`getDoc() !== doc`).
- **Cancel:** a Stop button sets a flag; Rust checks it between stream chunks.

### Simple-RAG fallback

Some models (small or local ones) reject requests that include tools (HTTP 400/404/422 mentioning
tools/functions). On that error at the first step, the app switches to **simple RAG** for that
provider: it runs the keyword search itself, takes the top 4 pages, and sends them with the question
for that request only (not kept in history, so the conversation doesn't grow by whole pages).

## Multi-provider design (llm.ts)

Two wire protocols cover everything:

| Protocol | Providers |
|---|---|
| Anthropic Messages API | Claude |
| OpenAI-compatible Chat Completions | Gemini, Groq, Hugging Face, OpenRouter, Ollama, any custom base URL |

**One internal format:** the conversation is always stored in Anthropic's block format (`text`,
`tool_use`, `tool_result`, `thinking` blocks) and translated per request:

| Internal (Anthropic blocks) | OpenAI format |
|---|---|
| assistant `tool_use` blocks | `tool_calls: [{ id, type: "function", function: { name, arguments } }]` |
| user `tool_result` blocks | separate `role: "tool"` messages with `tool_call_id` |
| `thinking` blocks | dropped |
| tool `input_schema` | `{ type: "function", function: { name, description, parameters } }`, plain JSON Schema (Gemini rejects `additionalProperties` and empty `parameters`) |

This is the **adapter pattern**: the agent loop never knows which provider it's talking to.
Changing provider resets the chat, so formats never mix.

### Streaming

- Rust sends the HTTPS request (`reqwest`), reads the response as **server-sent events** (blocks
  separated by a blank line, JSON on `data:` lines), and forwards each event to the UI over a Tauri
  **Channel** (an ordered stream from Rust to JS), then `[DONE]`.
- `llm.ts` parses each provider's events:
  - Anthropic: `content_block_start/delta/stop` with `text_delta`, `input_json_delta` (tool
    arguments arrive as JSON fragments), `thinking_delta`, `signature_delta`.
  - OpenAI: `choices[0].delta.content` and `delta.tool_calls[]`, accumulated by `index`; Gemini
    omits `index`, so calls are matched by `id` or continue the last one. Any tool call means
    "tool_use" even if `finish_reason` says `stop` (some providers do that).
- `<think>…</think>` sections from reasoning models (DeepSeek-R1, Qwen) are stripped.

### Provider quirks handled (great "debugging" stories)

- **Gemini 3 thought signatures:** Gemini 3 attaches `extra_content.google.thought_signature` to each
  tool call and rejects the next request with 400 "Function call is missing a thought_signature"
  unless it's sent back. The chat failed after its first search. Fix: keep it on the `tool_use` block
  and echo it in `tool_calls`. Found while taking README screenshots; fixed in v0.2.1.
- **Model names change:** "Load models" calls `GET {base}/models` so users pick from current models.
- **Free-tier limits:** 429 → "too many requests, wait a minute"; 503/529 → "busy right now".

### Claude specifics

Model `claude-opus-5-5`, with adaptive thinking always on (so the app never sends a thinking budget);
effort `low` for quick actions, `medium` for chat. Uses **prompt caching** (`cache_control:
ephemeral`) on the system prompt / inlined document, so follow-up questions are cheaper. Thinking
blocks are sent back unchanged (with their signatures), as the API requires. Beta headers enable a
server-side model fallback and short progress notes between tool calls (shown as steps).

## Where the keys live (security)

- Keys are saved by Rust into **Windows Credential Manager** (`keyring` crate), one entry per
  provider. The WebView can ask "is there a key?" but can never read one back.
- Every provider request goes through Rust, which adds the key header. A key saved with a custom
  address (Ollama, custom) is only ever sent to that address.
- So even if the web layer were compromised (e.g. by a malicious PDF exploiting PDF.js), it couldn't
  read the keys.

## Cost and privacy

Nothing is sent until the user asks. Only the question, the selection and the pages the AI reads go
to the chosen provider; the PDF file is never uploaded. With Ollama, nothing leaves the computer.
Summaries are cached per file, so reopening one is free.
