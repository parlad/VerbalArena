// supabase/functions/ingest-media-url/index.ts
//
// Receives a URL the user wants fact-checked. Two paths:
//   - Direct-audio URLs (.mp3 / .wav / .m4a / .ogg / etc) — fetched here,
//     passed straight into verify-media (and verify-media-finalize).
//   - YouTube / Spotify / generic URLs — enqueued in url_ingest_jobs for the
//     external worker to handle (see worker/url-ingest/).
//
// Returns: { url_verification_id, kind, queued | processed }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  user_id: string;
  source_url: string;
  topic_title?: string;
  topic_description?: string;
}

const DIRECT_AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|aac|opus|webm)(\?|$)/i;

function classifyUrl(url: string): "direct_audio" | "youtube" | "spotify" | "generic" {
  const lower = url.toLowerCase();
  if (DIRECT_AUDIO_EXT.test(lower)) return "direct_audio";
  if (/(?:youtube\.com|youtu\.be)/i.test(lower)) return "youtube";
  if (/(?:spotify\.com|open\.spotify\.com)/i.test(lower)) return "spotify";
  return "generic";
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  if (!body.user_id || !body.source_url) return json({ error: "Missing user_id or source_url" }, 400);

  let parsedUrl: URL;
  try { parsedUrl = new URL(body.source_url); }
  catch { return json({ error: "Invalid URL" }, 400); }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server env not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  const kind = classifyUrl(parsedUrl.toString());
  const url_hash = await sha256Hex(parsedUrl.toString());

  // Cache hit? Return existing verification.
  const { data: existing } = await admin
    .from("url_verifications")
    .select("*")
    .eq("source_url_hash", url_hash)
    .maybeSingle();
  if (existing) {
    return json({
      url_verification_id: existing.url_verification_id,
      kind: existing.source_kind,
      status: existing.status,
      cached: true,
    });
  }

  // Insert fresh row.
  const { data: uv, error: uvErr } = await admin
    .from("url_verifications")
    .insert({
      user_id: body.user_id,
      source_url: parsedUrl.toString(),
      source_kind: kind,
      source_url_hash: url_hash,
      status: kind === "direct_audio" ? "extracting" : "queued",
    })
    .select()
    .single();
  if (uvErr || !uv) return json({ error: `Insert failed: ${uvErr?.message}` }, 500);
  const uvId = uv.url_verification_id as string;

  if (kind === "direct_audio") {
    // Fetch audio inline and process via verify-media + verify-media-finalize.
    try {
      const audioResp = await fetch(parsedUrl.toString());
      if (!audioResp.ok) throw new Error(`Audio fetch ${audioResp.status}`);
      const mime = audioResp.headers.get("content-type") || "audio/mpeg";
      const buf = new Uint8Array(await audioResp.arrayBuffer());
      // Cap at ~25MB to keep this synchronous path responsive. Anything larger
      // should go through the worker even if it's a direct URL.
      if (buf.byteLength > 25 * 1024 * 1024) {
        await admin.from("url_verifications").update({
          status: "queued",
          source_kind: "generic",
          error_message: "File >25MB, deferred to worker",
        }).eq("url_verification_id", uvId);
        await admin.from("url_ingest_jobs").insert({
          url_verification_id: uvId,
          user_id: body.user_id,
          source_url: parsedUrl.toString(),
        });
        return json({ url_verification_id: uvId, kind: "generic", status: "queued" });
      }

      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const audio_base64 = btoa(bin);

      // Create a truth_check to host the claims, link it to the url_verification.
      const { data: tc } = await admin
        .from("truth_checks")
        .insert({
          user_id: body.user_id,
          media_url: parsedUrl.toString(),
          media_type: "audio",
          mime_type: mime,
          status: "processing",
        })
        .select()
        .single();
      if (!tc) throw new Error("truth_checks insert failed");
      const tcId = tc.truth_check_id as string;

      await admin.from("url_verifications")
        .update({ truth_check_id: tcId, status: "verifying", audio_url: parsedUrl.toString() })
        .eq("url_verification_id", uvId);

      // Single chunk for v1 — same shape verify-media expects.
      const verifyUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/verify-media`;
      const finalizeUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/verify-media-finalize`;
      const stream = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          truth_check_id: tcId,
          chunk_index: 0,
          audio_base64,
          mime_type: mime,
          chunk_start_seconds: 0,
          prior_transcript: "",
          topic_title: body.topic_title,
          topic_description: body.topic_description,
        }),
      });
      // Drain SSE so the function actually executes server-side.
      if (stream.body) {
        const reader = stream.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) { const { done } = await reader.read(); if (done) break; }
      }

      const finalizeResp = await fetch(finalizeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({ truth_check_id: tcId }),
      });
      const finalizeData = await finalizeResp.json().catch(() => ({}));

      await admin.from("url_verifications").update({
        status: "completed",
        completed_at: new Date().toISOString(),
      }).eq("url_verification_id", uvId);

      return json({
        url_verification_id: uvId,
        kind,
        status: "completed",
        truth_check_id: tcId,
        overall_verdict: finalizeData?.overall_verdict ?? null,
        overall_explanation: finalizeData?.overall_explanation ?? "",
      });
    } catch (err) {
      console.error("Direct-audio ingest failed:", err);
      await admin.from("url_verifications").update({
        status: "failed",
        error_message: String(err),
      }).eq("url_verification_id", uvId);
      return json({ error: "Direct-audio ingest failed", detail: String(err) }, 502);
    }
  }

  // Non-direct: enqueue for the worker.
  await admin.from("url_ingest_jobs").insert({
    url_verification_id: uvId,
    user_id: body.user_id,
    source_url: parsedUrl.toString(),
  });

  return json({
    url_verification_id: uvId,
    kind,
    status: "queued",
    note: "Worker will pick this up; poll url_verifications.status for progress.",
  });
});
