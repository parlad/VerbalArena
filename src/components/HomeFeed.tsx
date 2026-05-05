// src/components/HomeFeed.tsx
//
// New home page — vertical feed of verified posts.
//
// Composition:
//   <PostComposer />       — 4-tab composer (Record / Upload / Image / Link).
//                             Record fully wired; Upload accepts any audio/video
//                             file and runs it through the same verifier;
//                             Image and Link tabs render "Coming soon" until
//                             Phases 8 and 9 ship.
//   <FeedFilters />        — All / Verified true / Mixed / False
//   <PostCard />[]         — One per post, with verdict pill, top claims,
//                             citation chips, and a "Debate this →" CTA.
//
// "Debate this" creates a new debate row pre-populated with the post and
// switches the parent App into debate-detail mode (handled via onDebateRequest).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ShieldCheck, Mic, Upload, Image as ImageIcon, Link as LinkIcon,
  CheckCircle2, XCircle, AlertTriangle, HelpCircle, MessageSquare,
  ExternalLink, Clock, Sparkles, Loader2, Camera, Bot,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import {
  loadFeed,
  createPostFromTruthCheck,
  syncPostVerdictFromTruthCheck,
  createPostFromImageVerification,
  createPostFromUrlVerification,
  createPlaceholderUrlPost,
  markPostFailed,
  incrementDebateCount,
  type PostWithAuthor,
} from "../lib/posts";
import {
  verifier,
  createTruthCheck,
  type Verdict,
  type TruthCheckClaim,
} from "../lib/truthCheck";
import { verifyImage } from "../lib/imageVerify";
import { TruthCheckRecorder } from "./TruthCheckRecorder";

type Props = {
  userId?: string;
  username?: string;
  onSignInRequest: () => void;
  /** Called when the user clicks "Debate this" on a post. Parent should open
   *  the debate detail view for the resulting debate id. */
  onDebateRequest: (post: PostWithAuthor) => void;
};

const VERDICT_PILLS: Record<Verdict, { icon: JSX.Element; cls: string; label: string }> = {
  true: { icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", label: "Verified true" },
  false: { icon: <XCircle className="w-3.5 h-3.5" />, cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300", label: "False" },
  mixed: { icon: <AlertTriangle className="w-3.5 h-3.5" />, cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", label: "Mixed" },
  unverifiable: { icon: <HelpCircle className="w-3.5 h-3.5" />, cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", label: "Unverifiable" },
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function HomeFeed({ userId, onSignInRequest, onDebateRequest }: Props) {
  const [posts, setPosts] = useState<PostWithAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "verified" | "false" | "mixed">("all");

  // ─── Feed load + realtime ────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await loadFeed({ filter });
      setPosts(feed);
    } catch (err) {
      console.error("Failed to load feed:", err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const ch = supabase
      .channel("posts-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, async (payload) => {
        const newId = (payload.new as { post_id: string }).post_id;
        const { data } = await supabase
          .from("posts")
          .select(`*, users:user_id (username, reputation_score, profile_picture_url)`)
          .eq("post_id", newId)
          .single();
        if (data) setPosts((prev) => [data as PostWithAuthor, ...prev.filter((p) => p.post_id !== newId)]);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "posts" }, (payload) => {
        const updated = payload.new as PostWithAuthor;
        setPosts((prev) => prev.map((p) => (p.post_id === updated.post_id ? { ...p, ...updated } : p)));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // ─── "Debate this" handler ───────────────────────────────────────────────
  async function handleDebateThis(post: PostWithAuthor) {
    if (!userId) { onSignInRequest(); return; }
    try {
      await incrementDebateCount(post.post_id);
      onDebateRequest(post);
    } catch (err) {
      console.error("Failed to start debate:", err);
    }
  }

  return (
    <div className="space-y-6">
      {/* Brand stripe */}
      <div className="flex items-center gap-3 px-1">
        <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 leading-tight">VerbalArena</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">AI-verified social media — every claim, checked.</p>
        </div>
      </div>

      {/* Composer */}
      {userId
        ? <PostComposer userId={userId} onPosted={refresh} />
        : <SignInPrompt onSignInRequest={onSignInRequest} />}

      {/* Filters */}
      <FeedFilters value={filter} onChange={setFilter} />

      {/* Feed */}
      {loading ? (
        <FeedSkeleton />
      ) : posts.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ul className="space-y-4">
          {posts.map((p) => (
            <PostCard key={p.post_id} post={p} onDebateThis={() => handleDebateThis(p)} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Composer ──────────────────────────────────────────────────────────────
type ComposerTab = "record" | "upload" | "image" | "link";

function PostComposer({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  const [tab, setTab] = useState<ComposerTab>("record");

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="flex border-b border-slate-200 dark:border-slate-700">
        <ComposerTabBtn active={tab === "record"} onClick={() => setTab("record")} icon={<Mic className="w-4 h-4" />} label="Record" />
        <ComposerTabBtn active={tab === "upload"} onClick={() => setTab("upload")} icon={<Upload className="w-4 h-4" />} label="Upload" />
        <ComposerTabBtn active={tab === "image"} onClick={() => setTab("image")} icon={<ImageIcon className="w-4 h-4" />} label="Image" />
        <ComposerTabBtn active={tab === "link"} onClick={() => setTab("link")} icon={<LinkIcon className="w-4 h-4" />} label="Link" />
      </div>
      <div className="p-4">
        {tab === "record" && <RecordPane userId={userId} onPosted={onPosted} />}
        {tab === "upload" && <UploadPane userId={userId} onPosted={onPosted} />}
        {tab === "image" && <ImagePane userId={userId} onPosted={onPosted} />}
        {tab === "link" && <LinkPane userId={userId} onPosted={onPosted} />}
      </div>
    </div>
  );
}

function ComposerTabBtn({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: JSX.Element; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/10"
          : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50"
      }`}
    >
      {icon}
      <span className="composer-tab-label">{label}</span>
    </button>
  );
}

function RecordPane({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  const [pendingPostId, setPendingPostId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        Record yourself. Each claim is transcribed, timestamped, and verified live with citations.
      </p>
      <TruthCheckRecorder
        userId={userId}
        onCompleted={async (truthCheckId) => {
          // Promote the truth-check into a feed post so others see it.
          try {
            const post = await createPostFromTruthCheck({
              user_id: userId,
              truth_check_id: truthCheckId,
              caption: "",
              post_type: "audio",
            });
            await syncPostVerdictFromTruthCheck(post.post_id, truthCheckId);
            setPendingPostId(post.post_id);
            onPosted();
          } catch (err) {
            console.error("Failed to publish post:", err);
          }
        }}
      />
      {pendingPostId && (
        <p className="text-xs text-emerald-600 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Posted to your feed.
        </p>
      )}
    </div>
  );
}

function UploadPane({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  // For v1, upload uses the same pipeline by feeding the file as a single chunk.
  // Production should chunk-upload large files, but for MVP this is fine for ≤25MB.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const isVideo = file.type.startsWith("video/");
      const tc = await createTruthCheck({
        user_id: userId,
        media_type: isVideo ? "video" : "audio",
        mime_type: file.type || (isVideo ? "video/webm" : "audio/webm"),
      });

      // Promote to a post immediately so it appears in the feed as "verifying".
      const post = await createPostFromTruthCheck({
        user_id: userId,
        truth_check_id: tc.truth_check_id,
        caption: file.name,
        post_type: isVideo ? "video" : "audio",
      });

      // Single-shot verify: send the whole file as chunk 0.
      const events = verifier.verifyChunk({
        truth_check_id: tc.truth_check_id,
        chunk_index: 0,
        audio_blob: file,
        mime_type: file.type || "audio/webm",
        chunk_start_seconds: 0,
        prior_transcript: "",
      });
      // Drain events (claims persist server-side as they arrive; UI updates via posts realtime).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of events) { /* no-op */ }

      // Finalize + sync rollup verdict back to the post.
      await verifier.finalize({ truth_check_id: tc.truth_check_id, duration_seconds: 0 });
      await syncPostVerdictFromTruthCheck(post.post_id, tc.truth_check_id);
      onPosted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Upload failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className={`flex flex-col items-center justify-center gap-2 px-4 py-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
        busy
          ? "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/30"
          : "border-slate-300 hover:border-blue-400 hover:bg-blue-50/30 dark:border-slate-600 dark:hover:border-blue-500 dark:hover:bg-blue-900/10"
      }`}>
        <input
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {busy ? (
          <>
            <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
            <span className="text-sm text-slate-600 dark:text-slate-400">Verifying…</span>
          </>
        ) : (
          <>
            <Upload className="w-6 h-6 text-slate-400" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Drop audio or video, or click to browse</span>
            <span className="text-xs text-slate-500 dark:text-slate-500">Up to ~25MB for v1</span>
          </>
        )}
      </label>
      {error && (
        <p className="mt-2 text-xs text-rose-600 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

function ImagePane({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError("");
    setPendingFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  }

  async function submit() {
    if (!pendingFile) return;
    setBusy(true);
    setError("");
    try {
      const result = await verifyImage({ userId, file: pendingFile, caption: caption.trim() || undefined });
      // Pull the durable image_url back from the verification row.
      const { data: iv } = await supabase
        .from("image_verifications")
        .select("image_url")
        .eq("image_verification_id", result.image_verification_id)
        .single();
      await createPostFromImageVerification({
        user_id: userId,
        image_verification_id: result.image_verification_id,
        image_url: iv?.image_url || previewUrl,
        caption: caption.trim() || result.subject_summary,
        overall_verdict: result.overall_verdict,
        overall_explanation: result.overall_explanation,
      });
      // Reset.
      setPendingFile(null);
      setCaption("");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
      onPosted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Image verification failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!pendingFile ? (
        <label className="flex flex-col items-center justify-center gap-2 px-4 py-8 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 dark:border-slate-600 dark:hover:border-blue-500 dark:hover:bg-blue-900/10 transition-colors">
          <input type="file" accept="image/*" className="hidden" onChange={handlePick} />
          <ImageIcon className="w-6 h-6 text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Drop an image, or click to browse
          </span>
          <span className="text-xs text-slate-500">JPEG, PNG, WebP</span>
        </label>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-black flex items-center justify-center">
            <img src={previewUrl} alt="preview" className="max-h-72 object-contain" />
          </div>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Optional caption — what is this image, or what claim does it make?"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none resize-none"
            disabled={busy}
          />
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {busy ? "Verifying…" : "Verify & post"}
            </button>
            <button
              onClick={() => {
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                setPendingFile(null);
                setPreviewUrl("");
                setCaption("");
              }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-700 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium transition"
            >
              Choose different
            </button>
          </div>
          {error && (
            <p className="text-xs text-rose-600 inline-flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Returns the 11-char YouTube video ID for any standard YouTube URL form,
// or null for non-YouTube URLs.
export function extractYouTubeId(input: string): string | null {
  try {
    const u = new URL(input);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/]+)/);
      if (m) return m[1];
    }
  } catch { /* not a valid URL */ }
  return null;
}

function LinkPane({ userId, onPosted }: { userId: string; onPosted: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const trimmed = url.trim();
  const ytId = trimmed ? extractYouTubeId(trimmed) : null;

  // YouTube verification is currently disabled — the InnerTube path is
  // rate-limited from server-side IPs and the worker isn't deployed.
  // Keeping verify-youtube edge function in place so this can be re-enabled
  // by restoring this function and the verify buttons.

  async function submitGeneric() {
    setError("");
    setInfo("");
    if (!trimmed) { setError("Paste a URL first."); return; }
    let parsed: URL;
    try { parsed = new URL(trimmed); }
    catch { setError("That doesn't look like a valid URL."); return; }

    setBusy(true);
    let placeholderPostId: string | null = null;
    try {
      const placeholder = await createPlaceholderUrlPost({
        user_id: userId,
        source_url: parsed.toString(),
      });
      placeholderPostId = placeholder.post_id;
      onPosted();

      const base = import.meta.env.VITE_SUPABASE_URL as string;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
      const resp = await fetch(`${base.replace(/\/$/, "")}/functions/v1/ingest-media-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${anon}`,
          apikey: anon,
        },
        body: JSON.stringify({ user_id: userId, source_url: parsed.toString() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      if (data.status === "completed" && data.truth_check_id) {
        // Direct-audio URL: edge function returned a verdict — patch the placeholder.
        await createPostFromUrlVerification({
          user_id: userId,
          url_verification_id: data.url_verification_id,
          source_url: parsed.toString(),
          caption: parsed.toString(),
          overall_verdict: data.overall_verdict ?? null,
          overall_explanation: data.overall_explanation ?? "",
        });
        // Drop the placeholder we made above (the createPostFromUrlVerification
        // above creates a separate row with the actual verdict).
        if (placeholderPostId) await markPostFailed(placeholderPostId, "(superseded)").catch(() => undefined);
        setInfo("Verified and posted.");
      } else if (data.status === "queued") {
        setInfo("Queued — needs the URL-ingest worker (see worker/url-ingest/README.md). Your post is in the feed as 'Verifying' for now.");
      } else if (data.cached) {
        setInfo("Already in the feed.");
      }
      setUrl("");
      onPosted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Verification failed: ${msg}`);
      if (placeholderPostId) {
        await markPostFailed(placeholderPostId, msg).catch(() => undefined);
        onPosted();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <LinkIcon className="w-3 h-3" />
        Paste a podcast or direct audio URL (.mp3, .wav, .m4a). Each factual claim is timestamped and verified with citations.
      </p>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/podcast.mp3"
        disabled={busy}
        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
      />

      {/* YouTube URL: disabled with explanation */}
      {ytId && (
        <div className="rounded-lg p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 inline-flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold mb-0.5">YouTube verification is temporarily unavailable.</p>
            <p>YouTube rate-limits server-side transcript fetches, so this needs the URL-ingest worker (yt-dlp + Gemini) which isn't deployed yet. For now: <strong>Record</strong> yourself, <strong>Upload</strong> an audio/video file, or paste a direct podcast .mp3 link from an RSS feed.</p>
          </div>
        </div>
      )}

      {/* Generic / direct-audio URL: single Verify button */}
      {!ytId && (
        <button
          onClick={submitGeneric}
          disabled={busy || !trimmed}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {busy ? "Ingesting…" : "Verify"}
        </button>
      )}

      {info && (
        <p className="text-xs text-emerald-600 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {info}
        </p>
      )}
      {error && (
        <p className="text-xs text-rose-600 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

function SignInPrompt({ onSignInRequest }: { onSignInRequest: () => void }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 p-6 text-center">
      <ShieldCheck className="w-8 h-8 mx-auto text-blue-600 mb-2" />
      <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Sign in to verify and post</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 mb-4">
        Record yourself, upload a clip, or paste a link — we'll verify the facts and post it for the world to debate.
      </p>
      <button
        onClick={onSignInRequest}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition"
      >
        Sign in
      </button>
    </div>
  );
}

// ─── Filters ───────────────────────────────────────────────────────────────
function FeedFilters({
  value, onChange,
}: {
  value: "all" | "verified" | "false" | "mixed";
  onChange: (v: "all" | "verified" | "false" | "mixed") => void;
}) {
  const opts: Array<{ v: typeof value; label: string }> = [
    { v: "all", label: "All" },
    { v: "verified", label: "Verified" },
    { v: "mixed", label: "Mixed" },
    { v: "false", label: "False claims" },
  ];
  return (
    <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition ${
            value === o.v
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Post card ─────────────────────────────────────────────────────────────
function PostCard({ post, onDebateThis }: { post: PostWithAuthor; onDebateThis: () => void }) {
  const [claims, setClaims] = useState<TruthCheckClaim[] | null>(null);
  const [showAllClaims, setShowAllClaims] = useState(false);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  // Reserved for future use (currently set by YouTubeEmbed callback so the
  // playback indicator could be added later to the claim list).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_playbackTime, setPlaybackTime] = useState(0);
  // AI-vs-real classification, lazy-loaded for image posts only.
  const [imageAuth, setImageAuth] = useState<{
    ai_generated_likelihood: number | null;
    manipulation_indicators: string[];
  } | null>(null);
  const verdict = post.overall_verdict;

  // Lazy-load top claims for cards that have a truth_check_id.
  useEffect(() => {
    if (!post.truth_check_id || claims !== null) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("truth_check_claims")
        .select("*")
        .eq("truth_check_id", post.truth_check_id)
        .order("chunk_index", { ascending: true })
        .order("start_seconds", { ascending: true });
      if (!cancelled) setClaims((data ?? []) as TruthCheckClaim[]);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.truth_check_id]);

  // Lazy-load AI-vs-real classification for image posts.
  useEffect(() => {
    if (post.post_type !== "image" || !post.image_verification_id || imageAuth !== null) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("image_verifications")
        .select("ai_generated_likelihood, manipulation_indicators")
        .eq("image_verification_id", post.image_verification_id)
        .maybeSingle();
      if (!cancelled && data) {
        setImageAuth({
          ai_generated_likelihood: typeof data.ai_generated_likelihood === "number"
            ? data.ai_generated_likelihood : null,
          manipulation_indicators: Array.isArray(data.manipulation_indicators)
            ? data.manipulation_indicators : [],
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.image_verification_id, post.post_type]);

  const visibleClaims = useMemo(() => {
    if (!claims) return [];
    return showAllClaims ? claims : claims.slice(0, 3);
  }, [claims, showAllClaims]);

  return (
    <li className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden hover:shadow-md transition-shadow">
      {/* Author row */}
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 dark:from-slate-600 dark:to-slate-700 flex items-center justify-center text-white text-xs font-bold">
            {post.users?.username?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              @{post.users?.username ?? "unknown"}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {timeAgo(post.created_at)} ago · {post.post_type}
            </div>
          </div>
        </div>
        {verdict && (
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold verdict-glow-${verdict} ${VERDICT_PILLS[verdict].cls}`}>
            {VERDICT_PILLS[verdict].icon}
            {VERDICT_PILLS[verdict].label}
          </span>
        )}
        {!verdict && post.status === "verifying" && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
            <Loader2 className="w-3 h-3 animate-spin" />
            Verifying
          </span>
        )}
        {post.status === "failed" && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
            <AlertTriangle className="w-3 h-3" />
            Failed
          </span>
        )}
      </div>

      {/* Caption / transcript preview */}
      {post.caption && (
        <div className="px-4 pt-3">
          <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed line-clamp-4">
            {post.caption}
          </p>
        </div>
      )}

      {/* Media player */}
      {post.media_url && (post.post_type === "audio" || post.post_type === "video") && (
        <div className="px-4 pt-3">
          {post.post_type === "video"
            ? <video src={post.media_url} controls className="w-full rounded-xl bg-black" />
            : <audio src={post.media_url} controls className="w-full" />}
        </div>
      )}
      {post.media_url && post.post_type === "image" && (
        <div className="px-4 pt-3 space-y-2">
          {imageAuth && <ImageAuthBadge auth={imageAuth} />}
          <div className="rounded-xl overflow-hidden bg-black flex items-center justify-center">
            <img src={post.media_url} alt={post.caption || "verified image"} className="max-h-96 object-contain" />
          </div>
        </div>
      )}
      {post.media_url && post.post_type === "url" && (() => {
        const ytId = extractYouTubeId(post.media_url);
        if (ytId) {
          return (
            <div className="px-4 pt-3">
              <YouTubeEmbed
                videoId={ytId}
                onTimeUpdate={(t) => {
                  setPlaybackTime(t);
                  const active = (claims ?? []).find(
                    (c) => t >= c.start_seconds && t <= c.end_seconds + 0.5,
                  );
                  setActiveClaimId(active?.claim_id ?? null);
                }}
              />
            </div>
          );
        }
        return (
          <div className="px-4 pt-3">
            <a
              href={post.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline break-all"
            >
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
              {post.media_url}
            </a>
          </div>
        );
      })()}

      {/* Overall explanation */}
      {post.overall_explanation && (
        <div className="px-4 pt-3">
          <p className="text-xs text-slate-600 dark:text-slate-400 italic">
            {post.overall_explanation}
          </p>
        </div>
      )}

      {/* Top claims */}
      {visibleClaims.length > 0 && (
        <div className="px-4 pt-3 space-y-2">
          {visibleClaims.map((c) => (
            <div
              key={c.claim_id}
              className={`flex items-start gap-2 text-xs rounded-md px-2 py-1.5 transition-colors ${
                activeClaimId === c.claim_id
                  ? "bg-blue-50 dark:bg-blue-900/30 ring-1 ring-blue-200 dark:ring-blue-700"
                  : ""
              }`}
            >
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${VERDICT_PILLS[c.verdict].cls}`}>
                {VERDICT_PILLS[c.verdict].icon}
              </span>
              <div className="flex-1">
                <p className="text-slate-700 dark:text-slate-300">
                  {c.start_seconds > 0 && (
                    <span className="text-[10px] tabular-nums text-slate-400 mr-1.5">{fmtSeconds(c.start_seconds)}</span>
                  )}
                  {c.claim_text}
                </p>
                {Array.isArray(c.sources) && c.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {c.sources.slice(0, 2).map((s, i) => (
                      <a
                        key={i}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 hover:underline"
                      >
                        <ExternalLink className="w-2.5 h-2.5" />
                        {s.title || (() => { try { return new URL(s.url).hostname.replace(/^www\./, ""); } catch { return s.url; } })()}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {claims && claims.length > 3 && (
            <button
              onClick={() => setShowAllClaims((v) => !v)}
              className="text-xs text-slate-500 hover:text-blue-600 font-medium"
            >
              {showAllClaims ? "Show less" : `Show all ${claims.length} claims`}
            </button>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="px-4 py-3 mt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <button
          onClick={onDebateThis}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 dark:bg-violet-900/20 dark:hover:bg-violet-900/40 dark:text-violet-300 text-sm font-semibold transition"
        >
          <MessageSquare className="w-4 h-4" />
          Debate this
          {post.debate_count > 0 && <span className="text-xs font-normal opacity-70">({post.debate_count})</span>}
        </button>
        <div className="text-xs text-slate-400">
          {post.view_count > 0 && `${post.view_count} views`}
        </div>
      </div>
    </li>
  );
}

// ─── Image authenticity badge (Real vs AI-generated) ─────────────────────
//
// Bands: <0.20 Real photo · 0.20-0.50 Likely real · 0.50-0.80 Possibly AI
// · ≥0.80 Likely AI-generated. Manipulation indicators always show inline
// when present, regardless of band.
function ImageAuthBadge({
  auth,
}: {
  auth: { ai_generated_likelihood: number | null; manipulation_indicators: string[] };
}) {
  const p = auth.ai_generated_likelihood;
  const indicators = auth.manipulation_indicators ?? [];

  // Resolve label, tone, icon, and percentage display.
  let label: string;
  let cls: string;
  let icon: JSX.Element;
  if (p === null) {
    label = "Authenticity not assessed";
    cls = "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
    icon = <HelpCircle className="w-4 h-4" />;
  } else if (p < 0.2) {
    label = "Real photo";
    cls = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    icon = <Camera className="w-4 h-4" />;
  } else if (p < 0.5) {
    label = "Likely real";
    cls = "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300";
    icon = <Camera className="w-4 h-4" />;
  } else if (p < 0.8) {
    label = "Possibly AI-generated";
    cls = "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    icon = <Bot className="w-4 h-4" />;
  } else {
    label = "Likely AI-generated";
    cls = "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
    icon = <Bot className="w-4 h-4" />;
  }

  return (
    <div className="space-y-1.5">
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${cls}`}>
        {icon}
        {label}
        {p !== null && (
          <span className="font-normal opacity-75 tabular-nums">
            · {Math.round(p * 100)}% AI signal
          </span>
        )}
      </div>
      {indicators.length > 0 && (
        <div className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5">
          <span className="font-semibold">Notes:</span>
          <ul className="list-disc list-inside ml-1">
            {indicators.slice(0, 4).map((ind, i) => (
              <li key={i}>{ind}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Skeletons / empty ────────────────────────────────────────────────────
function FeedSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 animate-pulse">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700" />
            <div className="space-y-1.5">
              <div className="h-3 w-24 bg-slate-200 dark:bg-slate-700 rounded" />
              <div className="h-2.5 w-16 bg-slate-200 dark:bg-slate-700 rounded" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-full" />
            <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-4/5" />
            <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── YouTube embed with playback time updates ─────────────────────────────
//
// Uses the YouTube IFrame Player API via postMessage so we can read currentTime
// without pulling in the full youtube-iframe-api script. Polls every 250ms
// while the video is playing — cheap and accurate enough for claim sync.
function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function YouTubeEmbed({
  videoId, onTimeUpdate,
}: {
  videoId: string;
  onTimeUpdate: (t: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const intervalRef = useRef<number | null>(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;

  useEffect(() => {
    // Tell the iframe we want events (this is the IFrame API handshake).
    function listening(e: MessageEvent) {
      if (typeof e.data !== "string") return;
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.event === "infoDelivery" && typeof parsed.info?.currentTime === "number") {
          onTimeUpdateRef.current(parsed.info.currentTime);
        }
      } catch { /* ignore non-JSON messages */ }
    }
    window.addEventListener("message", listening);

    // Start polling currentTime once the iframe loads. We send a getCurrentTime
    // command and the iframe replies via postMessage.
    function startPolling() {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = window.setInterval(() => {
        const w = iframeRef.current?.contentWindow;
        if (!w) return;
        w.postMessage(JSON.stringify({ event: "command", func: "getCurrentTime", args: [] }), "*");
      }, 250);
    }
    const onLoad = () => startPolling();
    iframeRef.current?.addEventListener("load", onLoad);

    return () => {
      window.removeEventListener("message", listening);
      iframeRef.current?.removeEventListener("load", onLoad);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [videoId]);

  // enablejsapi=1 + origin lets us send commands; rel=0 hides related videos.
  const src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&origin=${encodeURIComponent(window.location.origin)}`;
  return (
    <div className="aspect-video w-full rounded-xl overflow-hidden bg-black">
      <iframe
        ref={iframeRef}
        src={src}
        title={`YouTube video ${videoId}`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="w-full h-full"
      />
    </div>
  );
}

function EmptyState({ filter }: { filter: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 p-10 text-center">
      <ShieldCheck className="w-10 h-10 mx-auto text-slate-300 mb-3" />
      <h3 className="text-base font-semibold text-slate-700 dark:text-slate-200">
        {filter === "all" ? "No posts yet" : `No ${filter === "false" ? "false-claim" : filter} posts`}
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
        Be the first — record a clip and let AI verify your claims.
      </p>
    </div>
  );
}
