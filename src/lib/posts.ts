// src/lib/posts.ts
//
// Typed client for the unified `posts` table. The home feed reads from here.
// A post wraps any verified piece of media (audio/video/image/URL/text) with
// a denormalized rollup verdict so the feed query stays a single SELECT.

import { supabase } from "./supabase";
import type { Verdict, TruthCheckClaim } from "./truthCheck";

export type PostType = "audio" | "video" | "image" | "url" | "text";
export type PostStatus = "pending" | "verifying" | "verified" | "failed";

export type Post = {
  post_id: string;
  user_id: string;
  post_type: PostType;
  caption: string;
  media_url: string | null;
  media_thumb_url: string | null;
  truth_check_id: string | null;
  image_verification_id: string | null;
  url_verification_id: string | null;
  debate_id: string | null;
  topic_id: string | null;
  overall_verdict: Verdict | null;
  overall_explanation: string;
  verdict_at: string | null;
  status: PostStatus;
  view_count: number;
  debate_count: number;
  created_at: string;
  updated_at: string;
};

export type PostWithAuthor = Post & {
  users: { username: string; reputation_score: number; profile_picture_url?: string };
};

export type PostWithClaims = PostWithAuthor & {
  truth_check_claims?: TruthCheckClaim[];
};

// ─── Reads ─────────────────────────────────────────────────────────────────
export async function loadFeed(opts: {
  limit?: number;
  before?: string;
  filter?: "all" | "verified" | "false" | "mixed";
} = {}): Promise<PostWithAuthor[]> {
  const limit = opts.limit ?? 30;
  let q = supabase
    .from("posts")
    .select(`
      *,
      users:user_id (username, reputation_score, profile_picture_url)
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts.before) q = q.lt("created_at", opts.before);
  if (opts.filter === "verified") q = q.eq("status", "verified");
  if (opts.filter === "false") q = q.eq("overall_verdict", "false");
  if (opts.filter === "mixed") q = q.eq("overall_verdict", "mixed");

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PostWithAuthor[];
}

export async function loadPostWithClaims(post_id: string): Promise<PostWithClaims | null> {
  const { data: post, error } = await supabase
    .from("posts")
    .select(`*, users:user_id (username, reputation_score, profile_picture_url)`)
    .eq("post_id", post_id)
    .maybeSingle();
  if (error) throw error;
  if (!post) return null;

  let claims: TruthCheckClaim[] = [];
  if (post.truth_check_id) {
    const { data: claimRows } = await supabase
      .from("truth_check_claims")
      .select("*")
      .eq("truth_check_id", post.truth_check_id)
      .order("chunk_index", { ascending: true })
      .order("start_seconds", { ascending: true });
    claims = (claimRows ?? []) as TruthCheckClaim[];
  }
  return { ...(post as PostWithAuthor), truth_check_claims: claims };
}

// ─── Writes ────────────────────────────────────────────────────────────────
export async function createPostFromTruthCheck(input: {
  user_id: string;
  truth_check_id: string;
  caption: string;
  post_type: "audio" | "video";
  media_url?: string;
}): Promise<Post> {
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: input.user_id,
      post_type: input.post_type,
      caption: input.caption,
      truth_check_id: input.truth_check_id,
      media_url: input.media_url ?? null,
      status: "verifying",
    })
    .select()
    .single();
  if (error) throw error;
  return data as Post;
}

export async function syncPostVerdictFromTruthCheck(post_id: string, truth_check_id: string): Promise<void> {
  const { data: tc } = await supabase
    .from("truth_checks")
    .select("overall_verdict, overall_explanation, completed_at, status, transcript")
    .eq("truth_check_id", truth_check_id)
    .maybeSingle();
  if (!tc) return;
  await supabase
    .from("posts")
    .update({
      overall_verdict: tc.overall_verdict,
      overall_explanation: tc.overall_explanation,
      verdict_at: tc.completed_at,
      status: tc.status === "completed" ? "verified" : tc.status === "failed" ? "failed" : "verifying",
      caption: tc.transcript || undefined,
    })
    .eq("post_id", post_id);
}

export async function createPostFromImageVerification(input: {
  user_id: string;
  image_verification_id: string;
  image_url: string;
  caption: string;
  overall_verdict: Verdict;
  overall_explanation: string;
}): Promise<Post> {
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: input.user_id,
      post_type: "image",
      caption: input.caption,
      media_url: input.image_url,
      media_thumb_url: input.image_url,
      image_verification_id: input.image_verification_id,
      overall_verdict: input.overall_verdict,
      overall_explanation: input.overall_explanation,
      verdict_at: new Date().toISOString(),
      status: "verified",
    })
    .select()
    .single();
  if (error) throw error;
  return data as Post;
}

export async function createPostFromUrlVerification(input: {
  user_id: string;
  url_verification_id: string;
  source_url: string;
  caption: string;
  overall_verdict: Verdict | null;
  overall_explanation: string;
}): Promise<Post> {
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: input.user_id,
      post_type: "url",
      caption: input.caption,
      media_url: input.source_url,
      url_verification_id: input.url_verification_id,
      overall_verdict: input.overall_verdict,
      overall_explanation: input.overall_explanation,
      verdict_at: input.overall_verdict ? new Date().toISOString() : null,
      status: input.overall_verdict ? "verified" : "verifying",
    })
    .select()
    .single();
  if (error) throw error;
  return data as Post;
}

/** Create a placeholder post immediately so the user sees "Verifying..." in
 *  the feed while the edge function works. The verify-youtube edge function
 *  fills in the verdict + transcript when it finishes. */
export async function createPlaceholderUrlPost(input: {
  user_id: string;
  source_url: string;
  caption?: string;
  thumb_url?: string;
}): Promise<Post> {
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: input.user_id,
      post_type: "url",
      caption: input.caption ?? input.source_url,
      media_url: input.source_url,
      media_thumb_url: input.thumb_url ?? null,
      status: "verifying",
    })
    .select()
    .single();
  if (error) throw error;
  return data as Post;
}

/** Mark a placeholder post failed so the feed shows it didn't go through. */
export async function markPostFailed(post_id: string, message: string): Promise<void> {
  await supabase
    .from("posts")
    .update({
      status: "failed",
      overall_explanation: message,
    })
    .eq("post_id", post_id);
}

export async function createTextPost(input: {
  user_id: string;
  caption: string;
}): Promise<Post> {
  const { data, error } = await supabase
    .from("posts")
    .insert({
      user_id: input.user_id,
      post_type: "text",
      caption: input.caption,
      status: "verified", // text posts skip verification for v1
      overall_verdict: "unverifiable",
      overall_explanation: "Text post — no factual claims auto-verified.",
    })
    .select()
    .single();
  if (error) throw error;
  return data as Post;
}

export async function incrementDebateCount(post_id: string): Promise<void> {
  // Best-effort optimistic increment. Concurrent writers race but exact count is fine for a counter.
  const { data: row } = await supabase
    .from("posts")
    .select("debate_count")
    .eq("post_id", post_id)
    .single();
  if (!row) return;
  await supabase.from("posts").update({ debate_count: (row.debate_count ?? 0) + 1 }).eq("post_id", post_id);
}
