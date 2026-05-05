// src/lib/imageVerify.ts
//
// Client for the verify-image edge function. The browser uploads the image to
// the verified-media bucket first and passes the URL to the function — never
// shoves base64 through the request body.

import { supabase } from "./supabase";
import { uploadToVerifiedMedia } from "./storage";
import type { Verdict, Citation } from "./truthCheck";

// Anthropic's image input limit: 8000 px on either side. Their docs
// recommend ≤1568 px for best quality. We cap at 2048 to keep some headroom
// while staying well under the limit. Anything below this just passes through.
const MAX_IMAGE_DIMENSION = 2048;

/** Resize the image client-side via Canvas if either dimension exceeds the
 *  cap. Returns the original File if no resize needed. */
async function shrinkImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // SVGs and animated GIFs can't safely be re-rasterized — skip.
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not decode image"));
      el.src = url;
    });

    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= MAX_IMAGE_DIMENSION) return file;

    const scale = MAX_IMAGE_DIMENSION / longest;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);

    // Encode as JPEG at q=0.9 — small enough, plenty of quality for fact-checking.
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.9);
    });
    if (!blob) return file;
    const renamed = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], renamed, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  // 0) Resize so we never exceed Claude's 8000-px-per-side hard limit.
  const fileToUpload = await shrinkImageIfNeeded(opts.file);

  // 1) Upload image to durable storage.
  const image_url = await uploadToVerifiedMedia({
    userId: opts.userId,
    ownerId: "image", // pseudo-folder; verify-image will overwrite with the real id
    blob: fileToUpload,
    filename: fileToUpload.name,
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
