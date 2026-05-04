// supabase/functions/verify-youtube/index.ts
//
// Worker-free YouTube fact-check.
// 1. Resolve video ID from URL.
// 2. Fetch the watch page, parse ytInitialPlayerResponse for the English
//    caption track.
// 3. Fetch the timed-text JSON, build a transcript with timestamps.
// 4. Send to Claude with web_search for fact-checking.
// 5. Persist truth_check + per-claim rows; mark the post as verified.
//
// Uses Claude for the fact-check call (migrated from Gemini 2026-05-04).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callClaude, extractJson } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  user_id: string;
  video_url: string;
  post_id?: string;
}

interface ExtractedClaim {
  text: string;
  start_seconds: number;
  end_seconds: number;
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  confidence: number;
}

interface Analysis {
  claims: ExtractedClaim[];
  overall_verdict: "true" | "false" | "mixed" | "unverifiable";
  overall_explanation: string;
}

const SYSTEM_PROMPT = `You are a meticulous fact-checker analyzing a YouTube video transcript.

You'll receive a list of transcript segments, each marked with [start_seconds].
Identify discrete FACTUAL CLAIMS (not opinions, jokes, or rhetorical questions).
Use the web_search tool to verify each one against authoritative sources.

Return STRICT JSON, no markdown:
{
  "claims": [
    {
      "text": "<verbatim claim>",
      "start_seconds": <number>,
      "end_seconds": <number>,
      "verdict": "true|false|mixed|unverifiable",
      "explanation": "<one sentence>",
      "sources": [{"title":"...","url":"https://...","snippet":"..."}],
      "confidence": 0.0-1.0
    }
  ],
  "overall_verdict": "true|false|mixed|unverifiable",
  "overall_explanation": "<2-3 sentences>"
}

Rules:
- Never invent URLs — only cite real ones from your search results.
- Skip filler like greetings, sponsor reads, hypotheticals.
- If the transcript has no factual claims, return claims: [] with verdict 'unverifiable'.
- Aim for 5-20 claims for a typical video; quality over quantity.`;

// ─── YouTube transcript fetching ──────────────────────────────────────────
function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/]+)/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string };
}

interface YtPlayerResponse {
  videoDetails?: { title?: string; lengthSeconds?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
}

async function fetchPlayerResponse(videoId: string): Promise<YtPlayerResponse> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const resp = await fetch(watchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`YouTube watch page ${resp.status}`);
  const html = await resp.text();
  const m = html.match(/var ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  if (!m) throw new Error("Could not find ytInitialPlayerResponse on page");
  return JSON.parse(m[1]) as YtPlayerResponse;
}

function pickEnglishTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks?.length) return null;
  const humanEn = tracks.find(t => t.languageCode === "en" && !t.kind);
  if (humanEn) return humanEn;
  const anyEn = tracks.find(t => t.languageCode === "en");
  if (anyEn) return anyEn;
  return tracks[0];
}

interface TranscriptSegment { start: number; duration: number; text: string; }

async function fetchTranscript(track: CaptionTrack): Promise<TranscriptSegment[]> {
  const url = track.baseUrl.includes("fmt=") ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Caption fetch ${resp.status}`);
  const ct = resp.headers.get("content-type") || "";

  if (ct.includes("json")) {
    const data = await resp.json();
    const events = (data.events || []) as Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
    return events
      .filter(e => Array.isArray(e.segs) && e.segs.some(s => (s.utf8 || "").trim()))
      .map(e => ({
        start: (e.tStartMs ?? 0) / 1000,
        duration: (e.dDurationMs ?? 0) / 1000,
        text: (e.segs || []).map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim(),
      }))
      .filter(seg => seg.text.length);
  }

  const xml = await resp.text();
  const segs: TranscriptSegment[] = [];
  const re = /<text[^>]*start="([^"]+)"[^>]*dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const text = m[3]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    segs.push({ start: parseFloat(m[1]), duration: parseFloat(m[2]), text });
  }
  return segs;
}

function formatTranscriptForPrompt(segs: TranscriptSegment[]): string {
  const lines: string[] = [];
  let bucket: string[] = [];
  let bucketStart = 0;
  for (const s of segs) {
    if (bucket.length === 0) bucketStart = s.start;
    bucket.push(s.text);
    if (s.start - bucketStart > 10) {
      lines.push(`[${bucketStart.toFixed(1)}s] ${bucket.join(" ")}`);
      bucket = [];
    }
  }
  if (bucket.length) lines.push(`[${bucketStart.toFixed(1)}s] ${bucket.join(" ")}`);
  return lines.join("\n");
}

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

// ─── Handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  let body: RequestBody;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!body.user_id || !body.video_url) return json({ error: "Missing user_id or video_url" }, 400);

  const videoId = extractVideoId(body.video_url);
  if (!videoId) return json({ error: "Couldn't parse a YouTube video ID from that URL" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server env not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  let player: YtPlayerResponse;
  try { player = await fetchPlayerResponse(videoId); }
  catch (err) { return json({ error: `YouTube fetch failed: ${err}` }, 502); }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickEnglishTrack(tracks);
  if (!track) {
    return json({
      error: "This video has no captions/transcript available. YouTube needs auto-captions or human-uploaded captions for verification.",
    }, 422);
  }

  let segs: TranscriptSegment[];
  try { segs = await fetchTranscript(track); }
  catch (err) { return json({ error: `Caption fetch failed: ${err}` }, 502); }
  if (!segs.length) return json({ error: "Empty transcript returned by YouTube" }, 422);

  const promptTranscript = formatTranscriptForPrompt(segs);
  const fullText = segs.map(s => s.text).join(" ");
  const totalDuration = segs.length ? segs[segs.length - 1].start + segs[segs.length - 1].duration : 0;
  const title = player.videoDetails?.title || "Untitled YouTube video";

  const { data: tc, error: tcErr } = await admin
    .from("truth_checks")
    .insert({
      user_id: body.user_id,
      media_url: `https://www.youtube.com/watch?v=${videoId}`,
      media_type: "video",
      mime_type: "video/youtube",
      duration_seconds: totalDuration,
      transcript: fullText,
      status: "processing",
    })
    .select()
    .single();
  if (tcErr || !tc) return json({ error: `truth_checks insert failed: ${tcErr?.message}` }, 500);
  const tcId = tc.truth_check_id as string;

  try {
    const userPrompt =
      `Video title: "${title}"\nDuration: ${totalDuration.toFixed(0)}s\n\n` +
      `Transcript (timestamps in seconds):\n${promptTranscript}`;

    const { text, citations } = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      webSearch: true,
      maxTokens: 8192, // longer videos can need more space for many claims
    });

    const parsed = extractJson<Analysis>(text);
    if (!parsed) {
      await admin.from("truth_checks").update({ status: "failed", error_message: "Unparseable JSON from Claude" }).eq("truth_check_id", tcId);
      return json({ error: "Could not parse model JSON", raw: text.slice(0, 400) }, 502);
    }

    if (Array.isArray(parsed.claims) && parsed.claims.length) {
      const claimRows = parsed.claims.map((c, idx) => {
        const sources = (Array.isArray(c.sources) && c.sources.length)
          ? c.sources
          : citations.slice(0, 3);
        return {
          truth_check_id: tcId,
          claim_text: c.text || "",
          start_seconds: typeof c.start_seconds === "number" ? c.start_seconds : 0,
          end_seconds: typeof c.end_seconds === "number" ? c.end_seconds : 0,
          verdict: ["true","false","mixed","unverifiable"].includes(c.verdict) ? c.verdict : "unverifiable",
          explanation: c.explanation || "",
          sources,
          confidence: clamp01(c.confidence ?? 0.5),
          chunk_index: idx,
        };
      });
      await admin.from("truth_check_claims").insert(claimRows);
    }

    await admin.from("truth_checks").update({
      status: "completed",
      overall_verdict: ["true","false","mixed","unverifiable"].includes(parsed.overall_verdict) ? parsed.overall_verdict : "unverifiable",
      overall_explanation: parsed.overall_explanation || "",
      completed_at: new Date().toISOString(),
    }).eq("truth_check_id", tcId);

    if (body.post_id) {
      await admin.from("posts").update({
        truth_check_id: tcId,
        overall_verdict: parsed.overall_verdict,
        overall_explanation: parsed.overall_explanation || "",
        verdict_at: new Date().toISOString(),
        status: "verified",
        caption: title,
        media_thumb_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      }).eq("post_id", body.post_id);
    }

    return json({
      ok: true,
      truth_check_id: tcId,
      video_id: videoId,
      title,
      duration_seconds: totalDuration,
      overall_verdict: parsed.overall_verdict,
      overall_explanation: parsed.overall_explanation || "",
      claims_count: (parsed.claims || []).length,
    });
  } catch (err) {
    console.error("verify-youtube fatal:", err);
    await admin.from("truth_checks").update({
      status: "failed",
      error_message: String(err).slice(0, 500),
    }).eq("truth_check_id", tcId);
    return json({ error: "Internal server error", detail: String(err) }, 500);
  }
});
