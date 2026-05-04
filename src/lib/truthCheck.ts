// src/lib/truthCheck.ts
//
// Typed client for the live truth-check pipeline. Provider-agnostic Verifier
// interface so v2 (Gemini Live bidi WebSocket) can drop in without UI churn.
// v1 implementation: chunked SSE against the verify-media edge function.

import { supabase } from "./supabase";

// ─── Types ─────────────────────────────────────────────────────────────────
export type Verdict = "true" | "false" | "mixed" | "unverifiable";

export type Citation = {
  title: string;
  url: string;
  snippet?: string;
};

export type TruthCheckClaim = {
  claim_id: string;
  truth_check_id: string;
  claim_text: string;
  start_seconds: number;
  end_seconds: number;
  verdict: Verdict;
  explanation: string;
  sources: Citation[];
  confidence: number;
  chunk_index: number;
  created_at: string;
};

export type TruthCheck = {
  truth_check_id: string;
  user_id: string;
  opinion_id: string | null;
  media_url: string;
  media_type: "audio" | "video";
  mime_type: string;
  duration_seconds: number;
  transcript: string;
  overall_verdict: Verdict | null;
  overall_explanation: string;
  status: "recording" | "processing" | "completed" | "failed";
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type VerifierEvent =
  | { type: "status"; state: string; chunk_index?: number }
  | { type: "transcript_delta"; text: string; chunk_index: number }
  | { type: "claim"; claim: TruthCheckClaim }
  | { type: "done"; chunk_index: number; total_claims: number }
  | { type: "error"; message: string; detail?: string };

export type VerifyChunkParams = {
  truth_check_id: string;
  chunk_index: number;
  audio_blob: Blob;
  mime_type: string;
  chunk_start_seconds: number;
  prior_transcript: string;
  topic_title?: string;
  topic_description?: string;
  signal?: AbortSignal;
};

export interface Verifier {
  /** Run one chunk through the pipeline; iterate over events as they arrive. */
  verifyChunk(params: VerifyChunkParams): AsyncIterable<VerifierEvent>;
  /** Called once when recording stops; returns the overall verdict. */
  finalize(params: {
    truth_check_id: string;
    duration_seconds: number;
    media_url?: string;
  }): Promise<{ overall_verdict: Verdict; overall_explanation: string }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function blobToBase64(blob: Blob): Promise<string> {
  // FileReader.readAsDataURL → strip the "data:...;base64," prefix.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Parse one Server-Sent Event frame ("event: ...\ndata: ...\n\n") into a typed event. */
function parseSseFrame(frame: string): VerifierEvent | null {
  const lines = frame.split("\n");
  let event = "message";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  let data: Record<string, unknown>;
  try { data = JSON.parse(dataStr) as Record<string, unknown>; } catch { return null; }
  switch (event) {
    case "status": return { type: "status", ...(data as { state: string; chunk_index?: number }) };
    case "transcript_delta": return { type: "transcript_delta", ...(data as { text: string; chunk_index: number }) };
    case "claim": return { type: "claim", claim: data as unknown as TruthCheckClaim };
    case "done": return { type: "done", ...(data as { chunk_index: number; total_claims: number }) };
    case "error": return { type: "error", ...(data as { message: string; detail?: string }) };
    default: return null;
  }
}

function getEdgeFunctionUrl(name: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  if (!base) throw new Error("VITE_SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/functions/v1/${name}`;
}

// ─── Chunked SSE implementation (v1) ───────────────────────────────────────
class ChunkedSseVerifier implements Verifier {
  async *verifyChunk(p: VerifyChunkParams): AsyncIterable<VerifierEvent> {
    const audio_base64 = await blobToBase64(p.audio_blob);
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

    const resp = await fetch(getEdgeFunctionUrl("verify-media"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify({
        truth_check_id: p.truth_check_id,
        chunk_index: p.chunk_index,
        audio_base64,
        mime_type: p.mime_type,
        chunk_start_seconds: p.chunk_start_seconds,
        prior_transcript: p.prior_transcript,
        topic_title: p.topic_title,
        topic_description: p.topic_description,
      }),
      signal: p.signal,
    });

    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      yield { type: "error", message: `verify-media HTTP ${resp.status}`, detail };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE frames are separated by a blank line.
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseFrame(frame);
        if (ev) yield ev;
      }
    }
    // Flush any tail.
    if (buffer.trim()) {
      const ev = parseSseFrame(buffer);
      if (ev) yield ev;
    }
  }

  async finalize(params: {
    truth_check_id: string;
    duration_seconds: number;
    media_url?: string;
  }): Promise<{ overall_verdict: Verdict; overall_explanation: string }> {
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    const resp = await fetch(getEdgeFunctionUrl("verify-media-finalize"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`verify-media-finalize HTTP ${resp.status}: ${detail}`);
    }
    return resp.json();
  }
}

export const verifier: Verifier = new ChunkedSseVerifier();

// ─── DB helpers ────────────────────────────────────────────────────────────
export async function createTruthCheck(input: {
  user_id: string;
  opinion_id?: string | null;
  media_type: "audio" | "video";
  mime_type: string;
  media_url?: string;
}): Promise<TruthCheck> {
  const { data, error } = await supabase
    .from("truth_checks")
    .insert({
      user_id: input.user_id,
      opinion_id: input.opinion_id ?? null,
      media_type: input.media_type,
      mime_type: input.mime_type,
      media_url: input.media_url ?? "",
      status: "recording",
    })
    .select()
    .single();
  if (error) throw error;
  return data as TruthCheck;
}

export async function loadTruthCheckWithClaims(truth_check_id: string): Promise<{
  truthCheck: TruthCheck;
  claims: TruthCheckClaim[];
}> {
  const [tcResp, claimsResp] = await Promise.all([
    supabase
      .from("truth_checks")
      .select("*")
      .eq("truth_check_id", truth_check_id)
      .single(),
    supabase
      .from("truth_check_claims")
      .select("*")
      .eq("truth_check_id", truth_check_id)
      .order("chunk_index", { ascending: true })
      .order("start_seconds", { ascending: true }),
  ]);
  if (tcResp.error) throw tcResp.error;
  if (claimsResp.error) throw claimsResp.error;
  return {
    truthCheck: tcResp.data as TruthCheck,
    claims: (claimsResp.data ?? []) as TruthCheckClaim[],
  };
}
