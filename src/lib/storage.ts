// src/lib/storage.ts
//
// Tiny wrapper around Supabase Storage for the `verified-media` bucket.
// All uploads go directly from the browser; the edge functions never proxy bytes.

import { supabase } from "./supabase";

export const VERIFIED_MEDIA_BUCKET = "verified-media";

function safeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 120);
}

/** Upload a Blob/File and return its public URL. */
export async function uploadToVerifiedMedia(opts: {
  userId: string;
  ownerId: string;     // post_id, truth_check_id, etc — used as a folder bucket
  blob: Blob;
  filename: string;
}): Promise<string> {
  const path = `${opts.userId}/${opts.ownerId}/${Date.now()}_${safeFilename(opts.filename)}`;
  const { error } = await supabase.storage
    .from(VERIFIED_MEDIA_BUCKET)
    .upload(path, opts.blob, {
      cacheControl: "3600",
      upsert: false,
      contentType: opts.blob.type || undefined,
    });
  if (error) throw error;
  const { data } = supabase.storage.from(VERIFIED_MEDIA_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
