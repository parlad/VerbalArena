// supabase/functions/fact-check-opinion/index.ts
//
// Fact-check a text opinion using Claude with the web_search tool.
// Migrated from Gemini on 2026-05-04 (Gemini blocked tool+JSON mix).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callClaude, extractJson } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  opinionText: string;
  topicTitle: string;
  topicDescription?: string;
}

interface FactCheckResult {
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources?: Array<string | { url: string; title?: string }>;
}

const SYSTEM_PROMPT = `You are a professional fact-checker.

Use the web_search tool to verify factual claims against authoritative sources.
NEVER invent URLs — only cite sources that come from your search results.

Return STRICT JSON, no markdown:
{
  "verdict": "true" | "false" | "mixed" | "unverifiable",
  "explanation": "<detailed explanation>",
  "sources": [{"url": "https://...", "title": "..."}]
}

Be objective and balanced. If a claim is partially true, return 'mixed' and
explain which parts hold. If you can't verify, return 'unverifiable'.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const { opinionText, topicTitle, topicDescription } = body;
  if (!opinionText || !topicTitle) return json({ error: "Missing required fields" }, 400);

  try {
    const userPrompt =
      `Topic: ${topicTitle}\n` +
      (topicDescription ? `Description: ${topicDescription}\n` : "") +
      `\nOpinion to fact-check:\n"""${opinionText}"""`;

    const { text, citations } = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      webSearch: true,
    });

    const parsed = extractJson<FactCheckResult>(text);
    let result: FactCheckResult;
    if (parsed) {
      result = parsed;
      // Normalize sources — accept both string URLs and {url, title} objects.
      const normalizedSources: string[] = [];
      for (const s of result.sources ?? []) {
        if (typeof s === "string") normalizedSources.push(s);
        else if (s && typeof s === "object" && "url" in s) normalizedSources.push(s.url);
      }
      // If the model didn't quote any sources but the search tool returned
      // some, fall back to those.
      if (normalizedSources.length === 0 && citations.length > 0) {
        for (const c of citations.slice(0, 5)) normalizedSources.push(c.url);
      }
      result.sources = normalizedSources;
    } else {
      result = { verdict: "unverifiable", explanation: text, sources: citations.map(c => c.url) };
    }

    return json(result);
  } catch (err) {
    console.error("fact-check-opinion error:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
