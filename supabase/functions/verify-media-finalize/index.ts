// supabase/functions/verify-media-finalize/index.ts
//
// Called after the user stops recording (or finishes uploading). Reads the
// per-chunk claims accumulated by verify-media, asks Claude to consolidate
// duplicates and produce an overall verdict + explanation, then updates the
// truth_checks row.
//
// Migrated to Claude on 2026-05-04. No web_search needed here — claims are
// already verified individually upstream.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callClaude, extractJson } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  truth_check_id: string;
  duration_seconds?: number;
  media_url?: string;
}

interface SummaryShape {
  overall_verdict: "true" | "false" | "mixed" | "unverifiable";
  overall_explanation: string;
}

const SUMMARY_PROMPT = `You are summarizing a fact-check session.

Given the full transcript and the list of individual claims that were verified,
produce a single overall verdict for the recording as a whole and a short
explanation (2-3 sentences).

Overall verdict rules:
  - "true" only if every verified claim is true.
  - "false" if any concrete factual claim is false and dominates the message.
  - "mixed" if claims include a meaningful mix of true and false / unverifiable.
  - "unverifiable" if there are no factual claims, or all are unverifiable.

Return STRICT JSON, no markdown:
{ "overall_verdict": "true|false|mixed|unverifiable", "overall_explanation": "..." }`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!body.truth_check_id) return json({ error: "Missing truth_check_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server env not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { data: tc, error: tcErr } = await admin
      .from("truth_checks")
      .select("transcript")
      .eq("truth_check_id", body.truth_check_id)
      .single();
    if (tcErr) throw tcErr;

    const { data: claims, error: claimsErr } = await admin
      .from("truth_check_claims")
      .select("claim_text, verdict, explanation, confidence")
      .eq("truth_check_id", body.truth_check_id)
      .order("chunk_index", { ascending: true })
      .order("start_seconds", { ascending: true });
    if (claimsErr) throw claimsErr;

    let overall: SummaryShape;

    if (!claims || claims.length === 0) {
      overall = {
        overall_verdict: "unverifiable",
        overall_explanation: "No verifiable factual claims were detected in this recording.",
      };
    } else {
      const userPrompt =
        `Transcript:\n"""${tc?.transcript || ""}"""\n\n` +
        `Verified claims:\n` +
        claims.map((c, i) =>
          `${i + 1}. [${c.verdict}] ${c.claim_text} — ${c.explanation} (confidence ${c.confidence})`
        ).join("\n");

      try {
        const { text } = await callClaude({
          system: SUMMARY_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          temperature: 0.1,
          maxTokens: 512,
        });
        const parsed = extractJson<SummaryShape>(text);
        overall = parsed ?? deterministicRollup(claims);
      } catch (err) {
        console.error("Claude summary error:", err);
        overall = deterministicRollup(claims);
      }
    }

    const updates: Record<string, unknown> = {
      status: "completed",
      overall_verdict: overall.overall_verdict,
      overall_explanation: overall.overall_explanation,
      completed_at: new Date().toISOString(),
    };
    if (typeof body.duration_seconds === "number") updates.duration_seconds = body.duration_seconds;
    if (body.media_url) updates.media_url = body.media_url;

    const { error: updErr } = await admin
      .from("truth_checks")
      .update(updates)
      .eq("truth_check_id", body.truth_check_id);
    if (updErr) throw updErr;

    return json({ ok: true, ...overall });
  } catch (err) {
    console.error("verify-media-finalize fatal:", err);
    await admin
      .from("truth_checks")
      .update({ status: "failed", error_message: String(err) })
      .eq("truth_check_id", body.truth_check_id);
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
});

function deterministicRollup(claims: Array<{ verdict: string }>): SummaryShape {
  const verdicts = claims.map((c) => c.verdict);
  const hasFalse = verdicts.includes("false");
  const hasTrue = verdicts.includes("true");
  return {
    overall_verdict:
      hasFalse && hasTrue ? "mixed"
      : hasFalse ? "false"
      : hasTrue ? "true"
      : "unverifiable",
    overall_explanation: "Automatic rollup (LLM summary unavailable).",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
