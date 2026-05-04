// src/lib/imageVerify.ts
//
// Client for the verify-image edge function. The browser uploads the image to
// the verified-media bucket first and passes the URL to the function — never
// shoves base64 through the request body.

import { supabase } from "./supabase";
import { uploadToVerifiedMedia } from "./storage";
import type { Verdict, Citation } from "./truthCheck";

export type ImageVerification = {
  image_verification_id: string;
  user_id: string;
  image_url: string;
  mime_type: string;
  ai_generated_likelihood: number | null;
  manipulation_indicators: string[];
  subject_summary: string;
  overall_verdict: Verdict | null;
  overall_explanation: string;
  status: "processing" | "completed" | "failed";
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ImageClaim = {
  claim_id: string;
  image_verification_id: string;
  claim_text: string;
  verdict: Verdict;
  explanation: string;
  sources: Citation[];
  confidence: number;
  created_at: string;
};

export type VerifyImageResult = {
  ok: true;
  image_verification_id: string;
  ai_generated_likelihood: number;
  manipulation_indicators: string[];
  subject_summary: string;
  overall_verdict: Verdict;
  overall_explanation: string;
  claims: Array<Omit<ImageClaim, "claim_id" | "image_verification_id" | "created_at">>;
};

function getEdgeFunctionUrl(name: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  if (!base) throw new Error("VITE_SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/functions/v1/${name}`;
}

export async function verifyImage(opts: {
  userId: string;
  file: File;
  caption?: string;
}): Promise<VerifyImageResult> {
  // 1) Upload image to durable storage.
  const image_url = await uploadToVerifiedMedia({
    userId: opts.userId,
    ownerId: "image", // pseudo-folder; verify-image will overwrite with the real id
    blob: opts.file,
    filename: opts.file.name,
  });

  // 2) Call the edge function.
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const resp = await fetch(getEdgeFunctionUrl("verify-image"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
    },
    body: JSON.stringify({
      user_id: opts.userId,
      image_url,
      mime_type: opts.file.type || "image/jpeg",
      caption: opts.caption,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`verify-image HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }
  return resp.json();
}

export async function loadImageVerificationWithClaims(id: string) {
  const [iv, claims] = await Promise.all([
    supabase.from("image_verifications").select("*").eq("image_verification_id", id).single(),
    supabase.from("image_verification_claims").select("*").eq("image_verification_id", id).order("created_at", { ascending: true }),
  ]);
  if (iv.error) throw iv.error;
  return {
    verification: iv.data as ImageVerification,
    claims: (claims.data ?? []) as ImageClaim[],
  };
}
