// AI providers behind one call. Claude speaks the Anthropic Messages API; every other provider
// (Gemini, Groq, Hugging Face, OpenRouter, Ollama, or any OpenAI-compatible endpoint) speaks the
// OpenAI Chat Completions API. Conversations are kept in Anthropic's block format (text, tool_use,
// tool_result, thinking) and translated for each request. Requests go through Rust (ai.rs), which
// holds the keys; the webview never sees one after it's saved.
import { Channel, invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./settings";

export type Block = { type: string; [k: string]: unknown };
export type Message = { role: "user" | "assistant"; content: string | Block[] };
export type Reply = { content: Block[]; stopReason: string | null };
export type Run = { cancelled: boolean; requestId?: string };
export type Tool = { name: string; description: string; input_schema: { properties: Record<string, unknown>; [k: string]: unknown } };

export class AiError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Providers

export type ProviderId = "gemini" | "groq" | "huggingface" | "openrouter" | "ollama" | "anthropic" | "custom";

export type Provider = {
  id: ProviderId;
  label: string;
  protocol: "anthropic" | "openai";
  /** A starting point: model names change, so the settings can load the provider's live list. */
  defaultModel: string;
  keyHint: string;
  keyOptional?: boolean;
  /** Ollama and custom endpoints: the user can set the address. */
  baseUrl?: string;
  editableUrl?: boolean;
  /** Free tiers with small per-minute token limits: send less text per request. */
  small: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    id: "gemini",
    label: "Google AI Studio (Gemini)",
    protocol: "openai",
    defaultModel: "gemini-flash-latest",
    keyHint: "Free key: aistudio.google.com → Get API key.",
    small: false,
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    defaultModel: "openai/gpt-oss-120b",
    keyHint: "Free key: console.groq.com → API Keys.",
    small: true,
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    protocol: "openai",
    defaultModel: "openai/gpt-oss-120b",
    keyHint: "Free monthly credits: huggingface.co/settings/tokens → a token with “Make calls to Inference Providers”.",
    small: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    defaultModel: "openai/gpt-oss-120b:free",
    keyHint: "Key: openrouter.ai/keys. Models ending in “:free” cost nothing.",
    small: true,
  },
  {
    id: "ollama",
    label: "Ollama (offline, on this computer)",
    protocol: "openai",
    defaultModel: "llama3.2",
    keyHint: "No key needed. Install Ollama from ollama.com, then run “ollama pull llama3.2”.",
    keyOptional: true,
    baseUrl: "http://localhost:11434/v1",
    editableUrl: true,
    small: true,
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic",
    defaultModel: "claude-opus-5-5",
    keyHint: "Paid key: console.anthropic.com → API keys.",
    small: false,
  },
  {
    id: "custom",
    label: "Other (OpenAI-compatible)",
    protocol: "openai",
    defaultModel: "",
    keyHint: "Any service with an OpenAI-compatible /chat/completions endpoint. Enter its base URL, e.g. https://api.example.com/v1.",
    keyOptional: true,
    editableUrl: true,
    small: true,
  },
];

export function providerInfo(id: ProviderId): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export type AiConfig = { provider: ProviderId; model: string };
let config: AiConfig | null = null;
const keyCache = new Map<ProviderId, boolean>();

/** The provider and model in use. First run: Claude if a Claude key was saved earlier, else Gemini. */
export async function getAiConfig(): Promise<AiConfig> {
  if (!config) {
    const saved = await getSetting<AiConfig>("aiProvider");
    if (saved && PROVIDERS.some((p) => p.id === saved.provider)) config = saved;
    else {
      const id: ProviderId = (await hasKey("anthropic")) ? "anthropic" : "gemini";
      config = { provider: id, model: providerInfo(id).defaultModel };
    }
  }
  return config;
}

export async function setAiConfig(c: AiConfig) {
  config = c;
  await setSetting("aiProvider", c);
}

export async function hasKey(id: ProviderId): Promise<boolean> {
  if (!keyCache.has(id)) keyCache.set(id, await invoke<boolean>("ai_has_key", { providerId: id }));
  return keyCache.get(id)!;
}

export async function saveKey(id: ProviderId, key: string, baseUrl?: string) {
  keyCache.delete(id);
  await invoke("ai_set_key", { providerId: id, key, baseUrl: baseUrl || null }).catch(toAiError);
  keyCache.set(id, true);
}

export async function clearKey(id: ProviderId) {
  await invoke("ai_clear_key", { providerId: id }).catch(() => {});
  keyCache.set(id, false);
}

/** The provider's model list (its GET /models). */
export async function listModels(id: ProviderId): Promise<string[]> {
  return invoke<string[]>("ai_models", { providerId: id }).catch(toAiError);
}

function toAiError(e: unknown): never {
  const info = e as { kind?: string; message?: string };
  throw new AiError(info?.kind ?? "api", info?.message ?? String(e));
}

// ---------------------------------------------------------------------------
// Calling a model

export type ModelRequest = {
  system: Block[];
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
  effort: "low" | "medium";
};
export type Handlers = { onText?: (text: string) => void; onUpdate?: (text: string) => void };

/**
 * One streamed call to the configured provider (or `cfg`). `onText` gets the reply's text so far;
 * `onUpdate` gets progress notes between tool calls (Claude). Resolves with the complete content
 * blocks, ready to append to the conversation.
 */
export async function callModel(req: ModelRequest, run: Run, on: Handlers = {}, cfg?: AiConfig): Promise<Reply> {
  const c = cfg ?? (await getAiConfig());
  return providerInfo(c.provider).protocol === "anthropic" ? callAnthropic(c, req, run, on) : callOpenAI(c, req, run, on);
}

export function cancel(run: Run) {
  run.cancelled = true;
  if (run.requestId) void invoke("ai_cancel", { requestId: run.requestId });
}

export function textOf(blocks: Block[]) {
  return blocks
    .filter((b) => b?.type === "text")
    .map((b) => b.text as string)
    .join("");
}

let requestSeq = 0;

/** Stream one request through Rust, handing each event's JSON to `onEvent`. */
async function stream(provider: ProviderId, body: unknown, betas: string[], run: Run, onEvent: (ev: any) => void) {
  const requestId = `r${++requestSeq}`;
  run.requestId = requestId;
  let done = () => {};
  const finished = new Promise<void>((r) => (done = r));
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    if (data === "[DONE]") return done();
    try {
      onEvent(JSON.parse(data));
    } catch {
      // not JSON (keep-alive comments and the like)
    }
  };
  await invoke("ai_stream", { requestId, providerId: provider, body: JSON.stringify(body), betas, onEvent: channel }).catch(toAiError);
  await finished;
  if (run.cancelled) throw new AiError("cancelled", "Stopped.");
}

// ---------------------------------------------------------------------------
// Anthropic Messages

// Refusal fallbacks to another model, and short progress notes between tool calls.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const UPDATES_BETA = "thinking-display-updates-2026-08-18";

async function callAnthropic(c: AiConfig, req: ModelRequest, run: Run, on: Handlers): Promise<Reply> {
  const blocks: Block[] = [];
  const json = new Map<number, string>();
  let stopReason: string | null = null;
  let streamError: AiError | null = null;
  const body = {
    model: c.model,
    max_tokens: req.maxTokens,
    stream: true,
    system: req.system,
    // `invalid` marks tool input that didn't parse (for the agent to report); it isn't an API field.
    messages: req.messages.map((m) =>
      typeof m.content === "string" ? m : { ...m, content: m.content.map(({ invalid: _invalid, ...b }) => b as Block) },
    ),
    output_config: { effort: req.effort },
    fallbacks: "default",
    ...(req.tools
      ? {
          tools: req.tools.map((t) => ({ ...t, strict: true, eager_input_streaming: true })),
          thinking: { type: "adaptive", display: "updates" },
          cache_control: { type: "ephemeral" },
        }
      : {}),
  };
  await stream(c.provider, body, req.tools ? [FALLBACK_BETA, UPDATES_BETA] : [FALLBACK_BETA], run, (ev) => {
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
      if (b?.type === "tool_use") b.input = parseInput(json.get(ev.index), b);
    } else if (ev.type === "message_delta") {
      stopReason = ev.delta?.stop_reason ?? stopReason;
    } else if (ev.type === "error") {
      const kind = ev.error?.type === "overloaded_error" ? "overloaded" : "api";
      streamError = new AiError(kind, ev.error?.message ?? "Claude reported an error.");
    }
  });
  if (streamError) throw streamError;
  return { content: echoable(blocks.filter(Boolean)), stopReason };
}

/** Tool input arrives as JSON fragments and can be cut short, so parse defensively. */
function parseInput(raw: string | undefined, block: Block) {
  try {
    const v = JSON.parse(raw || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  block.invalid = true;
  return {};
}

/**
 * The assistant turn to send back next time. After a refusal fallback mid-reply, blocks before the
 * last `fallback` marker other than text belong to the declined model and must be left out.
 */
function echoable(content: Block[]): Block[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  return content.filter((b, i) => b.type !== "fallback" && !(i < last && ["thinking", "redacted_thinking", "tool_use"].includes(b.type)));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions

const OPENAI_MAX_TOKENS = 8192;

/** Our block-format conversation as Chat Completions messages. */
function toOpenAI(system: Block[], messages: Message[]) {
  const out: Record<string, unknown>[] = [];
  const sys = system.map((b) => b.text as string).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: textOf(m.content) || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content) });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

/** Tools as functions. Plain JSON Schema only: some providers reject `additionalProperties` or empty objects. */
function toFunctions(tools: Tool[]) {
  return tools.map((t) => {
    const props = t.input_schema.properties;
    const parameters = Object.keys(props).length ? { type: "object", properties: props, required: Object.keys(props) } : undefined;
    return { type: "function", function: { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) } };
  });
}

/** Reasoning models (DeepSeek-R1, Qwen…) may write their thinking inside <think> tags; keep it out of the answer. */
function stripThink(s: string) {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/<think>[\s\S]*$/, "");
}

async function callOpenAI(c: AiConfig, req: ModelRequest, run: Run, on: Handlers): Promise<Reply> {
  let raw = "";
  const calls: { id: string; name: string; args: string }[] = [];
  let finish: string | null = null;
  let streamError: AiError | null = null;
  const body = {
    model: c.model,
    stream: true,
    max_tokens: Math.min(req.maxTokens, OPENAI_MAX_TOKENS),
    messages: toOpenAI(req.system, req.messages),
    ...(req.tools ? { tools: toFunctions(req.tools) } : {}),
  };
  await stream(c.provider, body, [], run, (ev) => {
    if (ev.error) {
      streamError = new AiError("api", ev.error.message ?? "The AI provider reported an error.");
      return;
    }
    const choice = ev.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      raw += d.content;
      on.onText?.(stripThink(raw));
    }
    for (const tc of d.tool_calls ?? []) {
      // Calls stream in pieces keyed by `index`. Some providers (Gemini) leave `index` out: then an
      // id we haven't seen starts a new call, and a piece without an id continues the last one.
      let slot = typeof tc.index === "number" ? calls[tc.index] : tc.id ? calls.find((x) => x.id === tc.id) : calls[calls.length - 1];
      if (!slot) {
        slot = { id: tc.id ?? `call_${calls.length + 1}`, name: "", args: "" };
        if (typeof tc.index === "number") calls[tc.index] = slot;
        else calls.push(slot);
      }
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name && !slot.name) slot.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  });
  if (streamError) throw streamError;

  const content: Block[] = [];
  const text = stripThink(raw).trim();
  if (text) content.push({ type: "text", text });
  for (const call of calls.filter(Boolean)) {
    const block: Block = { type: "tool_use", id: call.id, name: call.name };
    block.input = parseInput(call.args, block);
    content.push(block);
  }
  // Some providers finish with "stop" even when they called a tool.
  const stopReason = calls.length ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn";
  return { content, stopReason };
}
