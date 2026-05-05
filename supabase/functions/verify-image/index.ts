// supabase/functions/verify-image/index.ts
//
// Photo AI Verify — Claude analyzes the image with web_search for citations.
// Migrated from Gemini on 2026-05-04. Claude handles images + tools + JSON
// in a single call without the Gemini "tool + response_mime_type" 400 error.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { callClaude, extractJson, type ClaudeContentBlock } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  user_id: string;
  image_base64?: string;
  image_url?: string;
  mime_type?: string;
  caption?: string;
}

interface ImageClaim {
  text: string;
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources: Array<{ title?: string; url: string; snippet?: string }>;
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
  - manipulation_indicators: short strings naming specific suspicious tells.
    Empty array if nothing suspicious.
  - subject_summary: one or two sentences describing what the image shows.
  - claims: factual claims you can make or check from the image (e.g.
    "this is the Eiffel Tower", "the senator pictured is Bernie Sanders").
    USE the web_search tool to verify each one. Cite real URLs from search
    results — never invent URLs.
  - overall_verdict: 'true' if the image and any caption check out;
    'false' if there's clear deception; 'mixed' if some hold and some don't;
    'unverifiable' if there's nothing factual to check.
  - overall_explanation: 2-3 sentences.

Return STRICT JSON, no markdown:
{
  "ai_generated_likelihood": 0.0-1.0,
  "manipulation_indicators": ["..."],
  "subject_summary": "...",
  "claims": [{"text":"...","verdict":"...","explanation":"...","sources":[{"url":"...","title":"..."}],"confidence":0.0-1.0}],
  "overall_verdict": "...",
  "overall_explanation": "..."
}`;

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server env not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  // Normalize mime to one Claude supports.
  const mimeType = body.mime_type || "image/jpeg";
  const supportedMime: "image/jpeg" | "image/png" | "image/gif" | "image/webp" =
    mimeType.includes("png") ? "image/png"
    : mimeType.includes("gif") ? "image/gif"
    : mimeType.includes("webp") ? "image/webp"
    : "image/jpeg";

  // Create the verification row up-front so claims can FK back to it.
  const { data: ivRow, error: ivErr } = await admin
    .from("image_verifications")
    .insert({
      user_id: body.user_id,
      image_url: body.image_url ?? "",
      mime_type: supportedMime,
      status: "processing",
    })
    .select()
    .single();
  if (ivErr || !ivRow) return json({ error: `Insert failed: ${ivErr?.message}` }, 500);
  const ivId = ivRow.image_verification_id as string;

  try {
    // Build the image source: prefer URL (Claude fetches it, zero memory
    // pressure on this edge function) and fall back to base64 only when no
    // URL was provided. The base64 path uses Deno's std encoder, which is
    // O(n) memory instead of the byte-by-byte string-concat that blew the
    // 256 MB worker limit on larger photos.
    let imageSource: ClaudeContentBlock;
    if (body.image_url) {
      imageSource = { type: "image", source: { type: "url", url: body.image_url } };
    } else {
      let dataB64 = body.image_base64!;
      // If somehow we got binary instead of base64, encode it.
      if (typeof dataB64 !== "string") {
        dataB64 = encodeBase64(new Uint8Array(dataB64 as unknown as ArrayBufferLike));
      }
      imageSource = {
        type: "image",
        source: { type: "base64", media_type: supportedMime, data: dataB64 },
      };
    }

    const userContent: ClaudeContentBlock[] = [
      {
        type: "text",
        text: body.caption
          ? `Caption supplied by uploader: "${body.caption}"\n\nAnalyze the image and the caption together.`
          : "Analyze the image.",
      },
      imageSource,
    ];

    const { text, citations } = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      webSearch: true,
      maxTokens: 4096,
    });

    const parsed = extractJson<AnalysisShape>(text);
    if (!parsed) {
      await admin.from("image_verifications").update({
        status: "failed",
        error_message: "Unparseable JSON from Claude",
      }).eq("image_verification_id", ivId);
      return json({ error: "Could not parse model JSON", raw: text.slice(0, 400) }, 502);
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
      const claimRows = parsed.claims.map((c) => {
        // Backfill sources from web_search results if the model didn't quote any.
        const sources = (Array.isArray(c.sources) && c.sources.length)
          ? c.sources
          : citations.slice(0, 3);
        return {
          image_verification_id: ivId,
          claim_text: c.text || "",
          verdict: ["true","false","mixed","unverifiable"].includes(c.verdict) ? c.verdict : "unverifiable",
          explanation: c.explanation || "",
          sources,
          confidence: clamp01(c.confidence ?? 0.5),
        };
      });
      await admin.from("image_verification_claims").insert(claimRows);
    }

    return json({ ok: true, image_verification_id: ivId, ...parsed });
  } catch (err) {
    console.error("verify-image fatal:", err);
    await admin.from("image_verifications").update({
      status: "failed",
      error_message: String(err).slice(0, 500),
    }).eq("image_verification_id", ivId);
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
});
