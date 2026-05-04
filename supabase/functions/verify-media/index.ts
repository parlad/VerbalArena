// supabase/functions/verify-media/index.ts
//
// Live AI truth-check — per-chunk handler.
//
// Flow per request:
//   1. Browser POSTs an audio chunk (base64) + the prior accumulated transcript.
//   2. Gemini Flash transcribes the chunk (no tools, no JSON mode — this is
//      the only feature combination Gemini handles cleanly, and it's also
//      the one Gemini does best for audio).
//   3. We hand the new transcript text to Claude Sonnet with the web_search
//      tool, asking it to extract NEW factual claims and verify each with
//      real citations.
//   4. Persist transcript and claims to the DB as they arrive.
//   5. Stream results back as Server-Sent Events.
//
// Claude can't ingest audio directly, so the two-model split is the simplest
// path that gives us both reliable transcription AND grounded fact-checking
// without hitting Gemini's "tool + response_mime_type" 400.

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
  chunk_index: number;
  /** Provide ONE of these. If transcript_text is provided we skip Gemini and
   *  go straight to Claude (preferred path — used by the live recorder via
   *  browser SpeechRecognition). audio_base64 is the upload path that needs
   *  server-side transcription. */
  audio_base64?: string;
  mime_type?: string;
  transcript_text?: string;

  chunk_start_seconds: number;
  prior_transcript: string;
  topic_title?: string;
  topic_description?: string;
}

interface Citation { title?: string; url: string; snippet?: string; }

interface ExtractedClaim {
  text: string;
  start_seconds: number;
  end_seconds: number;
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources: Citation[];
  confidence: number;
}

interface ClaudeAnalysis {
  claims: ExtractedClaim[];
}

const TRANSCRIBE_PROMPT = `You will receive an audio chunk plus the transcript of everything spoken before this chunk.

Transcribe ONLY the new audio in this chunk. Do not repeat prior content.
If the chunk contains no speech, reply with: NO_SPEECH

Output rules:
- Plain text, no markdown, no quote marks.
- Single paragraph.
- Punctuated normally.`;

const FACTCHECK_PROMPT = `You are a fact-checker analyzing a live recording.

You receive new transcribed text along with its start time in the recording
(in seconds). Identify discrete FACTUAL CLAIMS in the new text — skip
opinions, jokes, hypotheticals, and rhetorical questions.

Use the web_search tool to verify each claim against authoritative sources.
Never invent URLs.

Return STRICT JSON, no markdown:
{
  "claims": [
    {
      "text": "<verbatim claim>",
      "start_seconds": <number — best estimate within the chunk>,
      "end_seconds": <number>,
      "verdict": "true|false|mixed|unverifiable",
      "explanation": "<one sentence>",
      "sources": [{"title":"...","url":"https://...","snippet":"..."}],
      "confidence": 0.0-1.0
    }
  ]
}

If there are no factual claims in the new text, return claims: [].`;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Gemini transcription (audio in, plain text out) ─────────────────────
async function geminiTranscribe(opts: {
  audioBase64: string;
  mimeType: string;
  priorTranscript: string;
}): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured (still needed for audio transcription)");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const userPrompt = `Accumulated transcript so far:\n"""${opts.priorTranscript || "(none)"}"""`;
  const body = {
    systemInstruction: { parts: [{ text: TRANSCRIBE_PROMPT }] },
    contents: [{
      role: "user",
      parts: [
        { text: userPrompt },
        { inlineData: { mimeType: opts.mimeType, data: opts.audioBase64 } },
      ],
    }],
    generationConfig: { temperature: 0 },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini transcribe ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const trimmed = text.trim();
  if (trimmed === "NO_SPEECH") return "";
  return trimmed;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { truth_check_id, chunk_index, audio_base64, mime_type, transcript_text,
          chunk_start_seconds, prior_transcript,
          topic_title, topic_description } = body;
  if (!truth_check_id || (!audio_base64 && !transcript_text)) {
    return new Response(JSON.stringify({
      error: "Need truth_check_id and either audio_base64 (with mime_type) or transcript_text",
    }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (audio_base64 && !mime_type) {
    return new Response(JSON.stringify({ error: "audio_base64 requires mime_type" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Supabase env not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const admin = createClient(supabaseUrl, serviceKey);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(sseEvent(event, data)));

      try {
        // 1. Get the transcript delta — either provided by the browser (live
        //    recorder uses Web Speech API) or transcribe via Gemini (used by
        //    the upload path since browser speech recognition needs live mic).
        let transcriptDelta: string;
        if (transcript_text) {
          transcriptDelta = transcript_text.trim();
        } else {
          send("status", { state: "transcribing", chunk_index });
          transcriptDelta = await geminiTranscribe({
            audioBase64: audio_base64!,
            mimeType: mime_type!,
            priorTranscript: prior_transcript,
          });
        }
        if (transcriptDelta) {
          send("transcript_delta", { text: transcriptDelta, chunk_index });
        }

        // Persist transcript update.
        const { data: existing } = await admin
          .from("truth_checks")
          .select("transcript, status")
          .eq("truth_check_id", truth_check_id)
          .maybeSingle();
        const newTranscript = ((existing?.transcript || "") +
          (transcriptDelta ? " " + transcriptDelta : "")).trim();
        await admin.from("truth_checks").update({
          transcript: newTranscript,
          status: existing?.status === "completed" ? "completed" : "processing",
        }).eq("truth_check_id", truth_check_id);

        // 2. If we got new text, fact-check with Claude + web_search.
        if (transcriptDelta) {
          send("status", { state: "fact_checking", chunk_index });

          const userPrompt =
            `Chunk start time in full recording: ${chunk_start_seconds.toFixed(2)}s\n` +
            (topic_title ? `Debate topic: ${topic_title}\n` : "") +
            (topic_description ? `Topic context: ${topic_description}\n` : "") +
            `\nNew transcribed text from this chunk:\n"""${transcriptDelta}"""\n\n` +
            `Prior transcript (for context — do not re-extract claims from this):\n"""${prior_transcript || "(none)"}"""`;

          let claudeResult;
          try {
            claudeResult = await callClaude({
              system: FACTCHECK_PROMPT,
              messages: [{ role: "user", content: userPrompt }],
              webSearch: true,
              maxTokens: 2048,
            });
          } catch (err) {
            send("error", { message: "Claude fact-check failed", detail: String(err) });
            send("done", { chunk_index, total_claims: 0 });
            controller.close();
            return;
          }

          const parsed = extractJson<ClaudeAnalysis>(claudeResult.text);
          const claims = parsed?.claims ?? [];

          for (const c of claims) {
            const sources = (Array.isArray(c.sources) && c.sources.length)
              ? c.sources
              : claudeResult.citations.slice(0, 3);
            const claimRow = {
              truth_check_id,
              claim_text: c.text || "",
              start_seconds: typeof c.start_seconds === "number"
                ? chunk_start_seconds + c.start_seconds
                : chunk_start_seconds,
              end_seconds: typeof c.end_seconds === "number"
                ? chunk_start_seconds + c.end_seconds
                : chunk_start_seconds,
              verdict: ["true", "false", "mixed", "unverifiable"].includes(c.verdict)
                ? c.verdict : "unverifiable",
              explanation: c.explanation || "",
              sources,
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

          send("done", { chunk_index, total_claims: claims.length });
        } else {
          send("done", { chunk_index, total_claims: 0 });
        }

        controller.close();
      } catch (err) {
        console.error("verify-media fatal:", err);
        try { send("error", { message: String(err) }); } catch { /* swallow */ }
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
