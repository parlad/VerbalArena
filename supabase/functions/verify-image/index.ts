// supabase/functions/verify-image/index.ts
//
// Photo AI Verify — single-call image analysis.
// Input: image (base64 or URL).
// Output:
//   - ai_generated_likelihood (0-1)
//   - manipulation_indicators (list of suspicious editing tells)
//   - subject_summary (what the image is of)
//   - claims[] (factual claims detectable from the image, each verified with citations)
//   - overall_verdict + explanation
//
// Single Gemini 2.5 Flash call with Google Search grounding so citations are real.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  user_id: string;
  // Either provide image_base64 + mime_type OR image_url. Prefer image_url so
  // the function isn't pushing big payloads through; base64 is the upload-first
  // fallback when storage hasn't accepted the file yet.
  image_base64?: string;
  image_url?: string;
  mime_type?: string;
  caption?: string;
}

interface ImageClaim {
  text: string;
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  confidence: number;
}

interface AnalysisShape {
  ai_generated_likelihood: number;
  manipulation_indicators: string[];
  subject_summary: string;
  claims: ImageClaim[];
  overall_verdict: "true" | "false" | "mixed" | "unverifiable";
  overall_explanation: string;
}

const SYSTEM_PROMPT = `You are an image forensics analyst and fact-checker.

Given an image (and optionally a caption), produce a JSON analysis with:

  - ai_generated_likelihood: 0.0 to 1.0. Look for telltale AI signs (impossible
    fingers, warped text, inconsistent lighting, oversmooth skin, illegible
    background details, repeated textures). Be calibrated, not cynical.
  - manipulation_indicators: short strings naming specific suspicious tells you
    found (e.g. "shadow direction inconsistent on subject vs background"). Empty
    array if nothing suspicious.
  - subject_summary: one or two sentences describing what the image shows.
  - claims: factual claims that can be made or checked from the image (e.g.
    "this is the Eiffel Tower", "the Senator pictured is Bernie Sanders").
    For each, USE THE SEARCH TOOL to verify against authoritative sources and
    cite real URLs. Skip if the image is purely decorative or has no factual
    content.
  - overall_verdict: 'true' if the image and any caption check out,
    'false' if there's clear deception, 'mixed' if some claims hold and some
    don't, 'unverifiable' if there's nothing factual to check.
  - overall_explanation: 2-3 sentences.

Return STRICT JSON, no markdown. Never invent URLs.`;

function pickJson(text: string): AnalysisShape | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  if (!body.user_id || (!body.image_base64 && !body.image_url)) {
    return json({ error: "Need user_id and either image_base64 or image_url" }, 400);
  }

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!geminiApiKey || !supabaseUrl || !serviceKey) {
    return json({ error: "Server env not configured" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  // Resolve image bytes — fetch the URL if given.
  let imageBase64 = body.image_base64;
  let mimeType = body.mime_type || "image/jpeg";
  if (!imageBase64 && body.image_url) {
    const r = await fetch(body.image_url);
    if (!r.ok) return json({ error: `Failed to fetch image_url: ${r.status}` }, 400);
    mimeType = r.headers.get("content-type") || mimeType;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    imageBase64 = btoa(bin);
  }

  // Create the verification row up-front so claims can FK back to it.
  const { data: ivRow, error: ivErr } = await admin
    .from("image_verifications")
    .insert({
      user_id: body.user_id,
      image_url: body.image_url ?? "",
      mime_type: mimeType,
      status: "processing",
    })
    .select()
    .single();
  if (ivErr || !ivRow) return json({ error: `Insert failed: ${ivErr?.message}` }, 500);
  const ivId = ivRow.image_verification_id as string;

  try {
    const userPrompt = body.caption
      ? `Caption supplied by uploader: "${body.caption}"\n\nAnalyze the image and the caption together.`
      : `Analyze the image.`;

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            role: "user",
            parts: [
              { text: userPrompt },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, response_mime_type: "application/json" },
        }),
      },
    );

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      await admin.from("image_verifications").update({
        status: "failed",
        error_message: `Gemini ${geminiResp.status}: ${errText.slice(0, 300)}`,
      }).eq("image_verification_id", ivId);
      return json({ error: "Gemini API failed", detail: errText.slice(0, 300) }, 502);
    }

    const data = await geminiResp.json();
    const raw: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      await admin.from("image_verifications").update({ status: "failed", error_message: "Empty model response" }).eq("image_verification_id", ivId);
      return json({ error: "Empty model response" }, 502);
    }
    const parsed = pickJson(raw);
    if (!parsed) {
      await admin.from("image_verifications").update({ status: "failed", error_message: "Unparseable JSON" }).eq("image_verification_id", ivId);
      return json({ error: "Could not parse Gemini JSON", raw: raw.slice(0, 400) }, 502);
    }

    // Persist analysis.
    await admin.from("image_verifications").update({
      ai_generated_likelihood: clamp01(parsed.ai_generated_likelihood),
      manipulation_indicators: Array.isArray(parsed.manipulation_indicators) ? parsed.manipulation_indicators : [],
      subject_summary: parsed.subject_summary || "",
      overall_verdict: ["true","false","mixed","unverifiable"].includes(parsed.overall_verdict) ? parsed.overall_verdict : "unverifiable",
      overall_explanation: parsed.overall_explanation || "",
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("image_verification_id", ivId);

    if (Array.isArray(parsed.claims) && parsed.claims.length) {
      const claimRows = parsed.claims.map((c) => ({
        image_verification_id: ivId,
        claim_text: c.text || "",
        verdict: ["true","false","mixed","unverifiable"].includes(c.verdict) ? c.verdict : "unverifiable",
        explanation: c.explanation || "",
        sources: Array.isArray(c.sources) ? c.sources : [],
        confidence: clamp01(c.confidence ?? 0.5),
      }));
      await admin.from("image_verification_claims").insert(claimRows);
    }

    return json({ ok: true, image_verification_id: ivId, ...parsed });
  } catch (err) {
    console.error("verify-image fatal:", err);
    await admin.from("image_verifications").update({
      status: "failed",
      error_message: String(err),
    }).eq("image_verification_id", ivId);
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
});

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
