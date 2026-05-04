// supabase/functions/verify-media-finalize/index.ts
//
// Called once when the user stops recording (or finishes uploading). Reads the
// per-chunk claims accumulated by verify-media, asks Gemini to consolidate
// duplicates / near-duplicates and produce an overall verdict + summary, then
// updates the truth_checks row.
//
// We deliberately keep verify-media chunk handling as the source of truth for
// individual claims; this function only adds a holistic layer.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
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

Return STRICT JSON:
{ "overall_verdict": "true|false|mixed|unverifiable", "overall_explanation": "..." }`;

function pickSummary(text: string): SummaryShape | null {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const { truth_check_id, duration_seconds, media_url } = body;
  if (!truth_check_id) {
    return new Response(
      JSON.stringify({ error: "Missing truth_check_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!geminiApiKey || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Server env not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { data: tc, error: tcErr } = await admin
      .from("truth_checks")
      .select("transcript")
      .eq("truth_check_id", truth_check_id)
      .single();
    if (tcErr) throw tcErr;

    const { data: claims, error: claimsErr } = await admin
      .from("truth_check_claims")
      .select("claim_text, verdict, explanation, confidence")
      .eq("truth_check_id", truth_check_id)
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

      const geminiUrl =
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" +
        `?key=${geminiApiKey}`;
      const geminiResp = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SUMMARY_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            response_mime_type: "application/json",
          },
        }),
      });

      if (!geminiResp.ok) {
        const errText = await geminiResp.text();
        console.error("Gemini summary error:", geminiResp.status, errText);
        // Fall back to a deterministic rollup so we don't leave the row stuck.
        const verdicts = claims.map((c) => c.verdict);
        const hasFalse = verdicts.includes("false");
        const hasTrue = verdicts.includes("true");
        overall = {
          overall_verdict: hasFalse && hasTrue
            ? "mixed"
            : hasFalse ? "false" : hasTrue ? "true" : "unverifiable",
          overall_explanation: "Automatic rollup (LLM summary unavailable).",
        };
      } else {
        const data = await geminiResp.json();
        const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = text ? pickSummary(text) : null;
        overall = parsed ?? {
          overall_verdict: "unverifiable",
          overall_explanation: "Summary could not be parsed.",
        };
      }
    }

    const updates: Record<string, unknown> = {
      status: "completed",
      overall_verdict: overall.overall_verdict,
      overall_explanation: overall.overall_explanation,
      completed_at: new Date().toISOString(),
    };
    if (typeof duration_seconds === "number") updates.duration_seconds = duration_seconds;
    if (media_url) updates.media_url = media_url;

    const { error: updErr } = await admin
      .from("truth_checks")
      .update(updates)
      .eq("truth_check_id", truth_check_id);
    if (updErr) throw updErr;

    return new Response(
      JSON.stringify({ ok: true, ...overall }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("verify-media-finalize fatal:", err);
    await admin
      .from("truth_checks")
      .update({ status: "failed", error_message: String(err) })
      .eq("truth_check_id", truth_check_id);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
