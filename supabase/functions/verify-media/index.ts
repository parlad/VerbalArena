// supabase/functions/verify-media/index.ts
//
// Live AI truth-check — per-chunk handler.
//
// Flow per request:
//   1. Browser POSTs an audio chunk (base64) plus the prior accumulated transcript
//      and the truth_check_id.
//   2. We send the chunk to Gemini 2.5 Flash with Google Search grounding enabled,
//      asking it to: (a) transcribe the new audio, (b) extract any new factual
//      claims, (c) verify each claim with citations.
//   3. We persist the transcript delta and any new claims to the database.
//   4. We stream results back as Server-Sent Events so the UI can render
//      claims as they're verified.
//
// Gemini grounding gives us real URLs (not hallucinations), which is the main
// upgrade over the existing fact-check-opinion edge function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── CORS ──────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Types ─────────────────────────────────────────────────────────────────
interface RequestBody {
  truth_check_id: string;
  chunk_index: number;
  // Base64 of the audio chunk (no data: prefix). Either the latest 3s slice
  // or, on the final call, the entire stitched recording.
  audio_base64: string;
  mime_type: string; // e.g. "audio/webm;codecs=opus"
  // Seconds elapsed in the recording at the start of this chunk. Used so claim
  // timestamps are relative to the full recording, not the chunk.
  chunk_start_seconds: number;
  // Best-effort accumulated transcript so far. Lets Gemini avoid re-extracting
  // claims it already returned.
  prior_transcript: string;
  // Topic context (optional) — sharpens fact-checking when the recording is
  // submitted as evidence inside an opinion flow.
  topic_title?: string;
  topic_description?: string;
}

interface Citation {
  title: string;
  url: string;
  snippet?: string;
}

interface ExtractedClaim {
  text: string;
  start_seconds: number;
  end_seconds: number;
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources: Citation[];
  confidence: number;
}

interface GeminiResponseShape {
  transcript_delta: string;
  claims: ExtractedClaim[];
}

// ─── Prompt ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a meticulous fact-checker analyzing a live audio recording.

You will receive:
  - An audio chunk
  - The accumulated transcript of everything spoken before this chunk
  - The chunk's start time relative to the full recording

Your job, in one response:
  1. Transcribe ONLY the new audio in this chunk. Do not re-transcribe prior content.
  2. Identify any discrete FACTUAL CLAIMS introduced in this chunk. Skip opinions,
     jokes, hypotheticals, or rhetorical questions. A factual claim is a
     verifiable assertion about reality.
  3. For each claim, verify it using your search tool. Return:
       - the verbatim claim text
       - start_seconds and end_seconds in the FULL recording (add chunk_start to
         chunk-local times)
       - a verdict from: "true" | "false" | "mixed" | "unverifiable"
       - a one-sentence explanation
       - citations (real URLs from your search results, never invented)
       - confidence between 0 and 1

Return STRICT JSON matching this schema, with no markdown or commentary:
{
  "transcript_delta": "<just the new spoken text from this chunk>",
  "claims": [
    {
      "text": "<verbatim claim>",
      "start_seconds": <number>,
      "end_seconds": <number>,
      "verdict": "true|false|mixed|unverifiable",
      "explanation": "<one sentence>",
      "sources": [{"title": "...", "url": "https://...", "snippet": "..."}],
      "confidence": 0.0-1.0
    }
  ]
}

If the chunk contains no new factual claims, return claims: [].`;

// ─── Helpers ───────────────────────────────────────────────────────────────
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function extractJsonBlock(text: string): GeminiResponseShape | null {
  // Gemini is usually obedient with response_mime_type: "application/json",
  // but defensively strip any code fences and find the outermost {...}.
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────
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

  const {
    truth_check_id,
    chunk_index,
    audio_base64,
    mime_type,
    chunk_start_seconds,
    prior_transcript,
    topic_title,
    topic_description,
  } = body;

  if (!truth_check_id || !audio_base64 || !mime_type) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Supabase env not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const admin = createClient(supabaseUrl, serviceKey);

  // ─── Stream response ─────────────────────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(sseEvent(event, data)));

      try {
        send("status", { state: "calling_model", chunk_index });

        const userPrompt =
          `Chunk index: ${chunk_index}\n` +
          `Chunk start time in full recording: ${chunk_start_seconds.toFixed(2)}s\n` +
          (topic_title ? `Debate topic: ${topic_title}\n` : "") +
          (topic_description ? `Topic context: ${topic_description}\n` : "") +
          `\nAccumulated transcript so far:\n"""${prior_transcript || "(none)"}"""`;

        const geminiUrl =
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" +
          `?key=${geminiApiKey}`;

        const geminiBody = {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            role: "user",
            parts: [
              { text: userPrompt },
              { inlineData: { mimeType: mime_type, data: audio_base64 } },
            ],
          }],
          // Enable Google Search grounding so citations are real URLs.
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
            response_mime_type: "application/json",
          },
        };

        const geminiResp = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiBody),
        });

        if (!geminiResp.ok) {
          const errText = await geminiResp.text();
          console.error("Gemini error:", geminiResp.status, errText);
          send("error", { message: `Gemini API ${geminiResp.status}`, detail: errText.slice(0, 500) });
          controller.close();
          return;
        }

        const geminiData = await geminiResp.json();
        const rawText: string | undefined =
          geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
          send("error", { message: "Empty Gemini response" });
          controller.close();
          return;
        }

        const parsed = extractJsonBlock(rawText);
        if (!parsed) {
          send("error", { message: "Could not parse Gemini JSON", raw: rawText.slice(0, 500) });
          controller.close();
          return;
        }

        // Stream transcript delta first.
        if (parsed.transcript_delta) {
          send("transcript_delta", { text: parsed.transcript_delta, chunk_index });
        }

        // Persist transcript: read-modify-write. Cheap because rows are tiny.
        const { data: existing } = await admin
          .from("truth_checks")
          .select("transcript, status")
          .eq("truth_check_id", truth_check_id)
          .maybeSingle();

        const newTranscript = (
          (existing?.transcript || "") +
          (parsed.transcript_delta ? " " + parsed.transcript_delta : "")
        ).trim();

        await admin
          .from("truth_checks")
          .update({
            transcript: newTranscript,
            status: existing?.status === "completed" ? "completed" : "processing",
          })
          .eq("truth_check_id", truth_check_id);

        // Persist + stream each claim.
        for (const c of (parsed.claims || [])) {
          const claimRow = {
            truth_check_id,
            claim_text: c.text || "",
            start_seconds: typeof c.start_seconds === "number" ? c.start_seconds : chunk_start_seconds,
            end_seconds: typeof c.end_seconds === "number" ? c.end_seconds : chunk_start_seconds,
            verdict: ["true", "false", "mixed", "unverifiable"].includes(c.verdict)
              ? c.verdict : "unverifiable",
            explanation: c.explanation || "",
            sources: Array.isArray(c.sources) ? c.sources : [],
            confidence: typeof c.confidence === "number"
              ? Math.max(0, Math.min(1, c.confidence))
              : 0.5,
            chunk_index,
          };

          const { data: inserted, error: insertErr } = await admin
            .from("truth_check_claims")
            .insert(claimRow)
            .select()
            .single();

          if (insertErr) {
            console.error("Claim insert error:", insertErr);
            send("error", { message: "Failed to persist claim", detail: insertErr.message });
            continue;
          }

          send("claim", inserted);
        }

        send("done", { chunk_index, total_claims: (parsed.claims || []).length });
        controller.close();
      } catch (err) {
        console.error("verify-media fatal:", err);
        try {
          send("error", { message: String(err) });
        } catch {
          /* swallow */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
