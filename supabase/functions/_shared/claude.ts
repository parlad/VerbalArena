// supabase/functions/_shared/claude.ts
//
// Tiny wrapper around Anthropic's Messages API. Used by every fact-check
// edge function. Keeps the model strings, web-search-tool name, and JSON
// extraction logic in one place.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Latest Claude models (as of 2026-05-04). Sonnet for fact-checking work,
// Haiku for cheap classification.
export const MODEL_FACT_CHECK = "claude-sonnet-4-6";
export const MODEL_CLASSIFY = "claude-haiku-4-5-20251001";

// Server-side web-search tool — Claude calls it transparently and returns
// citations in the response. No tool_use/tool_result roundtripping needed.
export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
};

export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface CallClaudeOpts {
  model?: string;
  system: string;
  messages: ClaudeMessage[];
  /** Set true to give Claude the web_search tool. */
  webSearch?: boolean;
  maxTokens?: number;
  temperature?: number;
}

interface AnthropicResponse {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; id: string; input: unknown }
    | { type: "server_tool_use"; name: string; input: unknown }
    | { type: "web_search_tool_result"; content: unknown }
  >;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Call Claude. Returns the concatenated text from all text content blocks. */
export async function callClaude(opts: CallClaudeOpts): Promise<{
  text: string;
  citations: Array<{ title?: string; url: string; snippet?: string }>;
}> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const body: Record<string, unknown> = {
    model: opts.model ?? MODEL_FACT_CHECK,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.2,
    system: opts.system,
    messages: opts.messages,
  };
  if (opts.webSearch) body.tools = [WEB_SEARCH_TOOL];

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await resp.json()) as AnthropicResponse;
  let text = "";
  const citations: Array<{ title?: string; url: string; snippet?: string }> = [];

  for (const block of data.content ?? []) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "web_search_tool_result") {
      // Pull citations from the web_search results so callers can attach
      // them to claims even if the model doesn't quote them in the JSON.
      const items = (block.content as Array<{ url?: string; title?: string; snippet?: string }>) ?? [];
      for (const r of items) {
        if (r.url) citations.push({ url: r.url, title: r.title, snippet: r.snippet });
      }
    }
  }

  return { text, citations };
}

/** Pull the first {…} block out of model output and parse it. Tolerates
 *  ```json fences and prose around the JSON. */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}
