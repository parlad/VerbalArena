// supabase/functions/detect-opinion-position/index.ts
//
// Classify whether an opinion supports or opposes a debate topic.
// Migrated to Claude on 2026-05-04. Uses Haiku (cheap, fast) since this is
// a binary classification — no web search needed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callClaude, MODEL_CLASSIFY } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  topicTitle: string;
  topicDescription: string;
  opinionText: string;
}

const SYSTEM_PROMPT = `You classify opinions about debate topics as either supporting or opposing.

Read the opinion and decide whether the speaker is in favor of the topic
(supporting) or against it (opposing).

Reply with EXACTLY one word: supporting OR opposing. No other text.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { topicTitle, topicDescription, opinionText }: RequestBody = await req.json();
    if (!topicTitle || !opinionText) return json({ error: "Missing required fields" }, 400);

    const userPrompt =
      `Topic: ${topicTitle}\n` +
      (topicDescription ? `Description: ${topicDescription}\n` : "") +
      `\nOpinion: ${opinionText}`;

    const { text } = await callClaude({
      model: MODEL_CLASSIFY,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0,
      maxTokens: 10,
    });
    const lowered = text.toLowerCase().trim();
    const position: "supporting" | "opposing" = lowered.includes("opposing") ? "opposing" : "supporting";
    return json({ position });
  } catch (err) {
    console.error("detect-opinion-position error:", err);
    // Fall back to "supporting" so the upstream UI doesn't break.
    return json({ error: String(err), position: "supporting" });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
