// src/components/TruthCheckRecorder.tsx
//
// Live truth-check recorder.
// - Captures mic (and optionally webcam) via getUserMedia + MediaRecorder.
// - Uses the browser's Web Speech API (SpeechRecognition) for LIVE
//   TRANSCRIPTION — runs in the browser, free, no API key, no rate limit.
// - Whenever a "final" speech result arrives (~every sentence), we POST the
//   text to verify-media. The edge function calls Claude with web_search to
//   extract + verify any factual claims, streams them back over SSE, and we
//   render them in the claims sidebar.
// - On stop, calls verify-media-finalize for the rolled-up overall verdict.
// - All claims are clickable and seek the recorded media player.
//
// Web Speech API support: Chrome / Edge / Safari (limited) ✓.  Firefox ✗.
// On unsupported browsers we fall back to the upload path (recording still
// happens; user gets a clear message at the end).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic, Square, Video, VideoOff, AlertTriangle, CheckCircle2,
  XCircle, HelpCircle, Loader2, ExternalLink, Play, Pause,
} from "lucide-react";
import {
  verifier,
  createTruthCheck,
  type TruthCheckClaim,
  type Verdict,
  type Citation,
} from "../lib/truthCheck";
import { uploadToVerifiedMedia } from "../lib/storage";
import { supabase } from "../lib/supabase";

const CHUNK_MS = 3000; // 3-second chunks → ~4-5s perceived latency

type Props = {
  userId: string;
  opinionId?: string | null;
  topicTitle?: string;
  topicDescription?: string;
  onCompleted?: (truthCheckId: string) => void;
  onClaim?: (claim: TruthCheckClaim) => void;
};

type Phase = "idle" | "requesting-permission" | "recording" | "stopping" | "done" | "error";

const VERDICT_STYLES: Record<Verdict, { icon: JSX.Element; pill: string; label: string }> = {
  true: {
    icon: <CheckCircle2 className="w-4 h-4" />,
    pill: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    label: "True",
  },
  false: {
    icon: <XCircle className="w-4 h-4" />,
    pill: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
    label: "False",
  },
  mixed: {
    icon: <AlertTriangle className="w-4 h-4" />,
    pill: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    label: "Mixed",
  },
  unverifiable: {
    icon: <HelpCircle className="w-4 h-4" />,
    pill: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    label: "Unverifiable",
  },
};

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function TruthCheckRecorder({
  userId,
  opinionId,
  topicTitle,
  topicDescription,
  onCompleted,
  onClaim,
}: Props) {
  // ── UI state ─────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [includeVideo, setIncludeVideo] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [claims, setClaims] = useState<TruthCheckClaim[]>([]);
  const [overall, setOverall] = useState<{ verdict: Verdict; explanation: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // ── Recording refs ───────────────────────────────────────────────────────
  const truthCheckIdRef = useRef<string | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIndexRef = useRef(0);
  const startTimeRef = useRef(0);
  const transcriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const recordedBlobsRef = useRef<Blob[]>([]);
  const elapsedTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const mimeTypeRef = useRef<string>("audio/webm");
  const playbackUrlRef = useRef<string | null>(null);
  const playerRef = useRef<HTMLMediaElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  // SpeechRecognition (browser-native, no API key, no Gemini)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const speechRecognitionAvailable = typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAllResources();
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    };
  }, []);

  function stopAllResources() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* noop */ }
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (elapsedTimerRef.current) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
  }

  // ── Pick a MediaRecorder mimeType the browser actually supports ─────────
  function pickMimeType(): string {
    const candidates = includeVideo
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const c of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
    }
    return includeVideo ? "video/webm" : "audio/webm";
  }

  // ── Audio meter loop ─────────────────────────────────────────────────────
  function startMeter(stream: MediaStream) {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        setAudioLevel(Math.min(1, Math.sqrt(sum / buf.length) * 2.5));
        levelRafRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      console.warn("Audio meter unavailable:", e);
    }
  }

  // ── Process a transcript chunk through the verifier ─────────────────────
  // Called every time SpeechRecognition emits a "final" result. We send only
  // the new text — the edge function uses Claude+web_search to extract and
  // verify any factual claims, then streams them back.
  async function processTextChunk(text: string, chunkStart: number) {
    const tcId = truthCheckIdRef.current;
    if (!tcId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const chunkIdx = chunkIndexRef.current++;
    try {
      const events = verifier.verifyChunk({
        truth_check_id: tcId,
        chunk_index: chunkIdx,
        transcript_text: trimmed,
        chunk_start_seconds: chunkStart,
        prior_transcript: transcriptRef.current,
        topic_title: topicTitle,
        topic_description: topicDescription,
      });
      // Update transcript right away so UI feels live (don't wait for SSE).
      transcriptRef.current = (transcriptRef.current + " " + trimmed).trim();
      setTranscript(transcriptRef.current);

      for await (const ev of events) {
        if (ev.type === "claim") {
          setClaims((prev) => [...prev, ev.claim]);
          onClaim?.(ev.claim);
        } else if (ev.type === "error") {
          console.warn("Chunk error:", ev.message, ev.detail);
        }
      }
    } catch (err) {
      console.error("processTextChunk failed:", err);
    }
  }

  // ── Wire up Web Speech API ────────────────────────────────────────────
  function startSpeechRecognition() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return false;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript as string;
        if (result.isFinal) {
          // Final result — fire it through Claude.
          const elapsed = (performance.now() - startTimeRef.current) / 1000;
          processTextChunk(text, Math.max(0, elapsed - text.split(/\s+/).length * 0.4));
        } else {
          interim += text;
        }
      }
      // Show interim as a faint preview so the user sees we're catching what they say.
      interimTranscriptRef.current = interim;
      setTranscript((transcriptRef.current + (interim ? " " + interim : "")).trim());
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      // Common errors: 'no-speech', 'aborted', 'not-allowed'. We silently ignore
      // 'no-speech' / 'aborted' since recognition auto-recovers.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        console.error("SpeechRecognition error:", e.error);
      }
    };
    rec.onend = () => {
      // Browsers stop recognition after silence; restart while we're recording.
      if (recorderRef.current?.state === "recording") {
        try { rec.start(); } catch { /* may fail if already started */ }
      }
    };
    try { rec.start(); } catch (err) { console.warn("Failed to start SpeechRecognition:", err); return false; }
    recognitionRef.current = rec;
    return true;
  }

  // ── Start recording ──────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setErrorMsg("");
    setTranscript("");
    setClaims([]);
    setOverall(null);
    setElapsed(0);
    setActiveClaimId(null);
    transcriptRef.current = "";
    interimTranscriptRef.current = "";
    chunkIndexRef.current = 0;
    recordedBlobsRef.current = [];
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }

    setPhase("requesting-permission");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: includeVideo,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || "Microphone permission denied.");
      setPhase("error");
      return;
    }
    mediaStreamRef.current = stream;
    if (includeVideo && videoElRef.current) {
      videoElRef.current.srcObject = stream;
      videoElRef.current.muted = true;
      videoElRef.current.play().catch(() => undefined);
    }

    let truthCheck;
    try {
      truthCheck = await createTruthCheck({
        user_id: userId,
        opinion_id: opinionId ?? null,
        media_type: includeVideo ? "video" : "audio",
        mime_type: pickMimeType(),
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to create truth-check: ${msg}`);
      setPhase("error");
      return;
    }
    truthCheckIdRef.current = truthCheck.truth_check_id;

    const mime = pickMimeType();
    mimeTypeRef.current = mime;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      recorder = new MediaRecorder(stream); // fall back to browser default
    }
    recorderRef.current = recorder;

    startTimeRef.current = performance.now();
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsed((performance.now() - startTimeRef.current) / 1000);
    }, 250);
    startMeter(stream);

    // We still record audio chunks for playback, but we DON'T send them to
    // the server anymore — fact-checking is driven by SpeechRecognition text.
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      recordedBlobsRef.current.push(ev.data);
    };

    // Kick off browser-side speech recognition for live transcription.
    if (speechRecognitionAvailable) {
      startSpeechRecognition();
    } else {
      console.warn(
        "SpeechRecognition not supported in this browser — transcript will be empty until upload-time fallback (which needs GEMINI_API_KEY).",
      );
    }

    recorder.onstop = async () => {
      stopAllResources();
      const finalBlob = new Blob(recordedBlobsRef.current, { type: mime });
      const localUrl = URL.createObjectURL(finalBlob);
      playbackUrlRef.current = localUrl;
      setPhase("stopping");

      const finalElapsed = (performance.now() - startTimeRef.current) / 1000;
      const tcId = truthCheckIdRef.current!;

      // Upload to durable storage in parallel with finalize so the post has
      // a permanent media_url even after refresh. Best-effort: if upload
      // fails (e.g. bucket missing), keep the in-memory blob URL.
      let durableUrl: string | undefined;
      try {
        durableUrl = await uploadToVerifiedMedia({
          userId,
          ownerId: tcId,
          blob: finalBlob,
          filename: `${tcId}.${includeVideo ? "webm" : "webm"}`,
        });
        await supabase
          .from("truth_checks")
          .update({ media_url: durableUrl, duration_seconds: finalElapsed })
          .eq("truth_check_id", tcId);
      } catch (e) {
        console.warn("Storage upload failed, keeping local blob URL:", e);
      }

      try {
        const result = await verifier.finalize({
          truth_check_id: tcId,
          duration_seconds: finalElapsed,
          media_url: durableUrl,
        });
        setOverall({ verdict: result.overall_verdict, explanation: result.overall_explanation });
        setPhase("done");
        onCompleted?.(tcId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`Finalize failed: ${msg}`);
        setPhase("error");
      }
    };

    recorder.start(CHUNK_MS);
    setPhase("recording");
  }, [userId, opinionId, includeVideo, topicTitle, topicDescription]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  // ── Player sync ──────────────────────────────────────────────────────────
  function attachPlayerRef(el: HTMLMediaElement | null) {
    playerRef.current = el;
  }
  function onPlayerTimeUpdate() {
    const t = playerRef.current?.currentTime ?? 0;
    setPlaybackTime(t);
    const active = claims.find((c) => t >= c.start_seconds && t <= c.end_seconds + 0.5);
    setActiveClaimId(active?.claim_id ?? null);
  }
  function seekTo(seconds: number) {
    if (!playerRef.current) return;
    playerRef.current.currentTime = seconds;
    playerRef.current.play().catch(() => undefined);
  }
  function togglePlay() {
    const el = playerRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined); else el.pause();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const isRecording = phase === "recording";
  const isBusy = phase === "requesting-permission" || phase === "stopping";

  return (
    <div className="space-y-4">
      {/* Browser support warning */}
      {!speechRecognitionAvailable && (phase === "idle" || phase === "error") && (
        <div className="rounded-xl px-3 py-2 text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 inline-flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            This browser doesn't support live speech recognition. Recording will work,
            but live transcription/fact-checking won't — try Chrome or Edge for the
            full experience.
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        {phase === "idle" || phase === "done" || phase === "error" ? (
          <>
            <button
              onClick={start}
              disabled={isBusy}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-semibold shadow-sm transition"
            >
              <Mic className="w-5 h-5" />
              {phase === "done" ? "Record again" : "Start recording"}
            </button>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeVideo}
                onChange={(e) => setIncludeVideo(e.target.checked)}
                className="rounded"
              />
              {includeVideo ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
              Include camera
            </label>
          </>
        ) : (
          <>
            <button
              onClick={stop}
              disabled={!isRecording}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white font-semibold shadow-sm transition"
            >
              <Square className="w-5 h-5" />
              Stop
            </button>
            {isBusy && (
              <span className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                {phase === "requesting-permission" ? "Asking for mic access…" : "Finalizing verdict…"}
              </span>
            )}
            {isRecording && (
              <>
                <span className="inline-flex items-center gap-2 text-sm font-medium text-rose-600">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500"></span>
                  </span>
                  Recording — {fmtTime(elapsed)}
                </span>
                {/* Audio level */}
                <div className="flex-1 min-w-[120px] h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-75"
                    style={{ width: `${Math.round(audioLevel * 100)}%` }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Live preview (video) */}
      {includeVideo && (phase === "recording" || phase === "requesting-permission") && (
        <div className="rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-black">
          <video ref={videoElRef} className="w-full max-h-72" playsInline muted />
        </div>
      )}

      {/* Player after recording */}
      {phase === "done" && playbackUrlRef.current && (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-3">
          {includeVideo ? (
            <video
              ref={(el) => attachPlayerRef(el)}
              src={playbackUrlRef.current}
              controls
              onTimeUpdate={onPlayerTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              className="w-full rounded-xl bg-black"
            />
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="p-2 rounded-full bg-slate-800 text-white hover:bg-slate-900"
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <span className="text-sm text-slate-600 dark:text-slate-400 tabular-nums">
                {fmtTime(playbackTime)} / {fmtTime(elapsed)}
              </span>
              <audio
                ref={(el) => attachPlayerRef(el)}
                src={playbackUrlRef.current}
                onTimeUpdate={onPlayerTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                className="hidden"
              />
            </div>
          )}
        </div>
      )}

      {/* Overall verdict */}
      {overall && (
        <div className={`rounded-2xl p-4 border ${
          overall.verdict === "true"
            ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20"
            : overall.verdict === "false"
            ? "border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20"
            : overall.verdict === "mixed"
            ? "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20"
            : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
        }`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${VERDICT_STYLES[overall.verdict].pill}`}>
              {VERDICT_STYLES[overall.verdict].icon}
              {VERDICT_STYLES[overall.verdict].label}
            </span>
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Overall verdict</span>
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-300">{overall.explanation}</p>
        </div>
      )}

      {/* Error */}
      {phase === "error" && errorMsg && (
        <div className="rounded-2xl p-4 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-rose-700 dark:text-rose-300">{errorMsg}</p>
        </div>
      )}

      {/* Transcript + claims */}
      <div className="truth-grid grid md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
            Transcript
          </h3>
          {transcript ? (
            <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
              {transcript}
            </p>
          ) : (
            <p className="text-sm text-slate-400 italic">
              {isRecording ? "Listening…" : "No speech yet."}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
            Claims ({claims.length})
          </h3>
          {claims.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              {isRecording ? "Verifying claims as you speak…" : "No factual claims detected."}
            </p>
          ) : (
            <ul className="space-y-3">
              {claims.map((c) => (
                <ClaimCard
                  key={c.claim_id}
                  claim={c}
                  active={activeClaimId === c.claim_id}
                  onSeek={() => seekTo(c.start_seconds)}
                  seekable={phase === "done"}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Claim sub-component ─────────────────────────────────────────────────────
function ClaimCard({
  claim, active, onSeek, seekable,
}: {
  claim: TruthCheckClaim;
  active: boolean;
  onSeek: () => void;
  seekable: boolean;
}) {
  const v = VERDICT_STYLES[claim.verdict];
  const sources: Citation[] = Array.isArray(claim.sources) ? claim.sources : [];
  return (
    <li
      className={`rounded-xl border p-3 transition ${
        active
          ? "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-900/20"
          : "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${v.pill}`}>
          {v.icon}
          {v.label}
        </span>
        <button
          onClick={onSeek}
          disabled={!seekable}
          className="text-xs font-mono text-slate-500 hover:text-blue-600 disabled:hover:text-slate-500 disabled:cursor-default tabular-nums"
          title={seekable ? "Jump to this moment" : "Available after recording stops"}
        >
          {fmtTime(claim.start_seconds)}
        </button>
      </div>
      <p className="text-sm text-slate-800 dark:text-slate-200 mb-1.5">{claim.claim_text}</p>
      {claim.explanation && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">{claim.explanation}</p>
      )}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.slice(0, 4).map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:border-blue-400 hover:text-blue-600 transition"
              title={s.snippet || s.url}
            >
              <ExternalLink className="w-3 h-3" />
              {s.title || new URL(s.url).hostname.replace(/^www\./, "")}
            </a>
          ))}
        </div>
      )}
    </li>
  );
}
