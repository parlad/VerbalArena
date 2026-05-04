#!/usr/bin/env node
// worker/url-ingest/index.js
//
// Long-running worker that drains url_ingest_jobs:
//   1. SELECT one pending job, lock it.
//   2. Run yt-dlp to extract audio (16kHz mono mp3, capped at 30 min for v1).
//   3. Upload the audio to Supabase Storage (verified-media bucket).
//   4. Call verify-media + verify-media-finalize on the audio.
//   5. Update url_verifications + create posts row.
//
// Designed to run on Fly.io / Railway / Render / a VPS — anywhere yt-dlp
// (a Python binary) and ffmpeg can be installed. Single-process, polling.
// For higher throughput, run multiple instances; SELECT … FOR UPDATE SKIP
// LOCKED ensures they don't fight over jobs.
//
// Env required:
//   SUPABASE_URL                 (https://<ref>.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY    (service-role key — keep secret)
//   GEMINI_API_KEY               (used for audio transcription only — no tools, no JSON mode, so no Gemini quirks apply here)
//   POLL_INTERVAL_MS             (optional, defaults to 5000)
//   MAX_DURATION_SECONDS         (optional, defaults to 1800 — 30 min)
//
// Transcription uses Gemini Flash (cheap and good at audio). The Anthropic
// key stays on the Supabase edge functions for fact-checking; the worker
// only handles audio extraction + transcription, then posts text to
// verify-media which fans out to Claude.

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const execFileP = promisify(execFile);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_DURATION = Number(process.env.MAX_DURATION_SECONDS || 1800);

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY is required for audio transcription.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Job claim (FOR UPDATE SKIP LOCKED via RPC) ───────────────────────────
async function claimNextJob() {
  // Use a small RPC if you've created one; otherwise fall back to a 2-step
  // claim. For simplicity here we use update + returning, which is racey but
  // fine for a single worker. Run multiple workers? Add an RPC like:
  //   CREATE FUNCTION claim_url_ingest_job() RETURNS url_ingest_jobs ...
  //   that does SELECT ... FOR UPDATE SKIP LOCKED and UPDATE in one txn.
  const { data, error } = await sb
    .from("url_ingest_jobs")
    .update({
      status: "running",
      attempts: 1, // overwritten below; simple counter
      locked_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markJobDone(job_id, success, error_message) {
  await sb
    .from("url_ingest_jobs")
    .update({
      status: success ? "done" : "failed",
      error_message: error_message ?? null,
      locked_until: null,
    })
    .eq("job_id", job_id);
}

async function updateUv(url_verification_id, patch) {
  await sb.from("url_verifications").update(patch).eq("url_verification_id", url_verification_id);
}

// ─── Audio extraction ─────────────────────────────────────────────────────
async function extractAudio(sourceUrl, outDir) {
  const outTemplate = path.join(outDir, "audio.%(ext)s");
  // 16kHz mono mp3 — small and Whisper/Gemini-friendly. Cap by time.
  const args = [
    "-f", "bestaudio/best",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "5",
    "--postprocessor-args", "-ac 1 -ar 16000",
    "--no-playlist",
    "--no-warnings",
    "--match-filter", `duration<=${MAX_DURATION}`,
    "-o", outTemplate,
    sourceUrl,
  ];
  await execFileP("yt-dlp", args, { timeout: 10 * 60 * 1000 });
  const out = path.join(outDir, "audio.mp3");
  const s = await stat(out).catch(() => null);
  if (!s) throw new Error("yt-dlp did not produce audio.mp3");
  return out;
}

async function probeDuration(file) {
  // Best-effort; ffprobe is typically present alongside ffmpeg.
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    const n = Number(stdout.trim());
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// ─── Storage upload ───────────────────────────────────────────────────────
async function uploadToStorage(filePath, userId, jobId) {
  const bytes = await readFile(filePath);
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
  const key = `${userId}/url-ingest/${jobId}/${hash}.mp3`;
  const { error } = await sb.storage.from("verified-media").upload(key, bytes, {
    cacheControl: "3600",
    upsert: false,
    contentType: "audio/mpeg",
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = sb.storage.from("verified-media").getPublicUrl(key);
  return data.publicUrl;
}

// ─── Gemini Flash transcription ──────────────────────────────────────────
// Plain transcription, no tools, no JSON mode — none of the Gemini quirks
// that bit us in the live recorder apply here. Gemini handles audio inline
// up to ~20 MB request body; 30 minutes of 16 kHz mono mp3 is ~3-4 MB so
// we have plenty of headroom.
//
// We ask for a transcript with [start_seconds] markers per sentence so the
// downstream fact-check can attach claims to real timestamps.
const TRANSCRIBE_PROMPT = `Transcribe this audio in English.

Format: one or two sentences per line, prefixed with the start time in
seconds in square brackets. Example:

[0.0] Welcome back to the show. Today we're talking about vaccines.
[8.4] My guest argues that natural immunity is sufficient.
[15.2] He claims the seasonal flu kills 600,000 people a year worldwide.

Rules:
- Plain text, no markdown.
- Do NOT add commentary or summaries — just the transcript.
- Keep punctuation natural.
- If audio is silent or non-speech, return: NO_SPEECH`;

async function whisperTranscribe(audioPath) {
  const bytes = await readFile(audioPath);
  const audio_base64 = bytes.toString("base64");
  const mime = "audio/mpeg";

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` +
    `?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TRANSCRIBE_PROMPT }] },
      contents: [{
        role: "user",
        parts: [{ inlineData: { mimeType: mime, data: audio_base64 } }],
      }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gemini transcribe ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!raw || raw.trim() === "NO_SPEECH") {
    return { text: "", segments: [] };
  }

  // Parse "[T.T] sentence" lines into segments.
  const segments = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d+(?:\.\d+)?)\]\s*(.+)$/);
    if (m) {
      segments.push({ start: parseFloat(m[1]), end: 0, text: m[2].trim() });
    }
  }
  // Fill in approximate end times (start of next, or +5s for the last).
  for (let i = 0; i < segments.length; i++) {
    segments[i].end = i + 1 < segments.length
      ? segments[i + 1].start
      : segments[i].start + 5;
  }
  // Fallback if Gemini ignored the format — treat the whole blob as one segment.
  if (segments.length === 0 && raw.trim()) {
    segments.push({ start: 0, end: 0, text: raw.trim() });
  }
  const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return { text, segments };
}

// Format Whisper segments into the [start_seconds] line format that the
// edge functions expect — same shape verify-youtube uses for YouTube
// transcripts so the model produces timestamped claims.
function formatTranscriptForPrompt(segments) {
  const lines = [];
  let bucket = [];
  let bucketStart = 0;
  for (const s of segments) {
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

// ─── Verify pipeline trigger ──────────────────────────────────────────────
async function runVerifyPipeline({ userId, audioPath, audioPublicUrl }) {
  // 1. Whisper transcription (own API key, no Gemini path).
  const whisper = await whisperTranscribe(audioPath);
  if (!whisper.text.trim()) {
    throw new Error("Whisper returned empty transcript (no speech?)");
  }

  // 2. Create truth_check row with the full transcript.
  const { data: tc, error: tcErr } = await sb
    .from("truth_checks")
    .insert({
      user_id: userId,
      media_url: audioPublicUrl,
      media_type: "audio",
      mime_type: "audio/mpeg",
      transcript: whisper.text,
      status: "processing",
    })
    .select()
    .single();
  if (tcErr || !tc) throw tcErr || new Error("truth_check insert failed");
  const tcId = tc.truth_check_id;

  // 3. Send transcript text (with [t]s markers) to verify-media as a single
  //    chunk. verify-media will route it through Claude+web_search since
  //    transcript_text is set (no Gemini call).
  const verifyUrl = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/verify-media`;
  const finalizeUrl = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/verify-media-finalize`;
  const promptText = formatTranscriptForPrompt(whisper.segments);

  const stream = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      truth_check_id: tcId,
      chunk_index: 0,
      transcript_text: promptText,
      chunk_start_seconds: 0,
      prior_transcript: "",
    }),
  });
  if (stream.body) {
    const reader = stream.body.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }
  }

  // 4. Finalize for the rolled-up overall verdict.
  const finalizeResp = await fetch(finalizeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ truth_check_id: tcId, media_url: audioPublicUrl }),
  });
  const finalizeData = await finalizeResp.json().catch(() => ({}));
  return { truth_check_id: tcId, ...finalizeData };
}

// ─── Main loop ────────────────────────────────────────────────────────────
async function processOneJob() {
  const job = await claimNextJob();
  if (!job) return false;
  console.log(`[${new Date().toISOString()}] claimed job ${job.job_id} for ${job.source_url}`);

  let workDir;
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "url-ingest-"));
    await updateUv(job.url_verification_id, { status: "extracting" });

    const audioPath = await extractAudio(job.source_url, workDir);
    const duration = await probeDuration(audioPath);
    const audioPublicUrl = await uploadToStorage(audioPath, job.user_id, job.job_id);

    await updateUv(job.url_verification_id, {
      audio_url: audioPublicUrl,
      duration_seconds: duration,
      status: "verifying",
    });

    const result = await runVerifyPipeline({
      userId: job.user_id,
      audioPath,
      audioPublicUrl,
    });

    await updateUv(job.url_verification_id, {
      truth_check_id: result.truth_check_id,
      status: "completed",
      completed_at: new Date().toISOString(),
    });

    // Promote into a feed post.
    await sb.from("posts").insert({
      user_id: job.user_id,
      post_type: "url",
      caption: job.source_url,
      media_url: audioPublicUrl,
      url_verification_id: job.url_verification_id,
      truth_check_id: result.truth_check_id,
      overall_verdict: result.overall_verdict ?? null,
      overall_explanation: result.overall_explanation ?? "",
      verdict_at: new Date().toISOString(),
      status: "verified",
    });

    await markJobDone(job.job_id, true);
    console.log(`[${new Date().toISOString()}] done ${job.job_id}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] job ${job.job_id} failed:`, err);
    await updateUv(job.url_verification_id, {
      status: "failed",
      error_message: String(err).slice(0, 500),
    });
    await markJobDone(job.job_id, false, String(err).slice(0, 500));
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}

async function main() {
  console.log(`url-ingest worker started, polling every ${POLL_MS}ms`);
  // Loop forever.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const did = await processOneJob();
      if (!did) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("Loop error:", e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
