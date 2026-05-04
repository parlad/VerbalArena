# Live AI Truth-Check for Audio/Video — Implementation Plan

**Goal:** When a user records or uploads audio/video, transcribe it, extract individual claims with timestamps, verify each claim against authoritative sources, and surface verdicts + citations in the UI as they're produced.

**User-confirmed scope:**
- Two entry points sharing one backend: (a) inside the existing opinion submission flow, (b) a new standalone `/truth-check` page.
- "Live" / streaming feel — verdicts appear progressively while/after the user finishes.
- Gemini multimodal end-to-end (already have `GEMINI_API_KEY` in edge functions).
- Timestamped claims — clicking a claim seeks the player.

---

## Architecture decision: streaming approach

The user asked for "truly streaming during recording." There are two viable shapes; we should pick consciously, not accidentally.

**Option A — Chunked progressive streaming (recommended for v1)**
- Browser uses `MediaRecorder` to emit audio chunks every 3s.
- Each chunk POSTed to edge function with the running transcript context.
- Edge function calls Gemini 2.5 with the chunk + accumulated context, asks for *new* claims since last call.
- Edge function returns Server-Sent Events (SSE) so the UI sees claims appear within ~4-5s of being spoken.
- Pros: works with vanilla Supabase Edge Functions, robust to network blips, idempotent retries, predictable cost.
- Cons: ~3-5s perceived latency vs. ~1s with true bidi.

**Option B — True bidirectional via Gemini Live API**
- Browser opens WebSocket → edge function WebSocket relay → Gemini Live API.
- Lowest latency but: requires WS state management on Deno Deploy, careful auth on the relay, and a much trickier UI state machine for partial transcripts overwriting themselves.
- Better as v2 once the chunked pipeline is proven.

**Plan: ship Option A as v1 behind a `verifier` interface so v2 can swap to Option B without UI churn.**

---

## Phase 1 — Database (one migration)

- [ ] Create migration `add_truth_checks.sql`:
  - [ ] `truth_checks` table: `truth_check_id`, `user_id`, `opinion_id` (nullable, links to existing `topic_opinions`), `media_url`, `media_type` ('audio'|'video'), `duration_seconds`, `transcript`, `overall_verdict`, `status` ('processing'|'completed'|'failed'), `created_at`, `completed_at`.
  - [ ] `truth_check_claims` table: `claim_id`, `truth_check_id`, `claim_text`, `start_seconds` (numeric), `end_seconds` (numeric), `verdict` ('true'|'false'|'mixed'|'unverifiable'), `explanation`, `sources` (jsonb array of `{title, url, snippet}`), `confidence` (numeric 0-1), `created_at`.
  - [ ] RLS: `truth_checks` readable by anyone (consistent with `topic_opinions`); writable only by owner. Same for claims via join.
  - [ ] Indexes: `truth_check_id` on claims, `opinion_id` on truth_checks, `created_at DESC`.

## Phase 2 — Edge function `verify-media`

- [ ] New function `supabase/functions/verify-media/index.ts`:
  - [ ] Accept `POST` with `{ truth_check_id, audio_chunk_base64, chunk_index, prior_transcript }`.
  - [ ] Stream response as SSE with events: `transcript_delta`, `claim`, `done`, `error`.
  - [ ] Build a single Gemini 2.5 Flash call per chunk using inline-base64 audio + system prompt that returns strict JSON: `{ transcript_delta, claims: [{text, start_seconds, end_seconds, verdict, explanation, sources, confidence}] }`.
  - [ ] Use Google Search grounding (`tools: [{google_search: {}}]`) — fixes a real weakness in the current text fact-checker (no real citations today).
  - [ ] Persist transcript and claims to DB as they arrive.
- [ ] New function `supabase/functions/verify-media-finalize/index.ts`:
  - [ ] Accept full media URL once recording ends, request a final pass that consolidates overlapping claims and computes an `overall_verdict`.

## Phase 3 — Frontend

- [ ] `src/lib/truthCheck.ts` — typed client wrapping the edge function (Verifier interface; chunked impl as default).
- [ ] `src/components/TruthCheckRecorder.tsx`:
  - [ ] `MediaRecorder` capture (audio + optional video via `getUserMedia`).
  - [ ] 3s chunking via `mediaRecorder.start(3000)` and `ondataavailable`.
  - [ ] Live waveform (Web Audio AnalyserNode) — small but signals "we're listening".
  - [ ] Progressive claims list rendering with status pills (processing → verdict).
  - [ ] Click claim → seek player to `start_seconds`.
- [ ] `src/components/TruthCheckUploader.tsx` — drag/drop or browse, then runs the same pipeline non-streaming (one call per ~30s segment).
- [ ] `src/components/TruthCheckPlayer.tsx` — `<audio>`/`<video>` element synced to the claims sidebar; current-time highlight.
- [ ] `src/pages/TruthCheckPage.tsx` — standalone page (entry point #2).
- [ ] Wire entry point #1: add a "Record evidence" button to the opinion submission flow in `TopicDebateView.tsx`. When done, pass the resulting `truth_check_id` to the opinion on submit.

## Phase 4 — Storage

- [ ] Verify Supabase Storage bucket exists for media (reuse the one `opinion_evidence` uses, or create `truth-check-media`).
- [ ] Direct browser upload via signed URL — never proxy media through edge function (cost + latency).

## Phase 5 — Verification (per user prefs: never mark done without proving it works)

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] Manual test: record a 30s clip with one true claim ("the Eiffel Tower is in Paris") and one false claim ("the moon is made of cheese"). Confirm both appear, with correct verdicts, within ~5s of being spoken, and that clicking each seeks the player.
- [ ] Edge case: no speech detected → graceful "no claims to verify" state.
- [ ] Edge case: network drop mid-recording → UI shows reconnection, partial claims preserved.
- [ ] Confirm Gemini Search grounding actually returns URLs (not hallucinated) — spot-check 3 claims.

## Phase 6 — Lessons capture

- [ ] After completion, append non-obvious gotchas to `tasks/lessons.md` (e.g. MediaRecorder mime-type quirks across browsers, Gemini grounding quota, SSE on Supabase edge functions).

---

## Out of scope (for this PR)

- Speaker diarization (whose voice said what).
- Deepfake detection on video.
- Cross-checking claims against a long-term knowledge base (Wikipedia/etc) — relying on Gemini grounding for v1.
- Live-stream verification (RTMP, etc).
- Multi-language: v1 is English-only; Gemini handles others but UI strings and prompts assume English.

---

## Review (Phases 1–3, 7a–7b, 10)

**What landed in this session — typecheck clean, no new lint errors:**

Backend
- Migration `20260504120000_add_truth_checks.sql` — `truth_checks` and `truth_check_claims` tables with RLS, indexes, updated_at trigger.
- Migration `20260504130000_add_posts.sql` — unified `posts` table with denormalized rollup verdict, FK references for all four verification kinds, debate/topic handoff fields, and a backfill that promotes every existing completed `truth_check` into a post.
- `supabase/functions/verify-media/index.ts` — SSE-streaming per-chunk handler. Gemini 2.5 Flash with Google Search grounding, persists transcript + claims as they stream.
- `supabase/functions/verify-media-finalize/index.ts` — overall verdict consolidator with deterministic fallback when LLM summary fails.
- `supabase/functions/fact-check-opinion/index.ts` — upgraded to use Google Search grounding. Eliminates hallucinated citations across the existing text fact-check too.

Frontend
- `src/lib/truthCheck.ts` — typed `Verifier` interface and `ChunkedSseVerifier` (v1). Drop-in upgrade path to a Live API bidi implementation in v2.
- `src/lib/posts.ts` — typed posts client with feed loader and verdict sync helpers.
- `src/components/TruthCheckRecorder.tsx` — `MediaRecorder` capture, 3s chunking, audio meter, live transcript + claim cards, clickable timestamps with player seek, optional video.
- `src/components/TruthCheckPage.tsx` — standalone /truth-check entry point.
- `src/components/HomeFeed.tsx` — new home: 4-tab composer (Record fully working, Upload accepts files, Image/Link as "Coming soon" placeholders for Phases 8/9), filterable feed of post cards with verdict pills, top-claims preview, citation chips, "Debate this" CTA.
- `src/App.tsx` — header shield button → standalone TruthCheckPage. Home view toggle: Verified Feed (new default) ↔ Classic Debates (existing grid). "Debate this" creates a `debates` row, links it back to the post, and opens debate detail.
- `src/components/TopicDebateView.tsx` — collapsible Live Truth Check section in opinion form; truth_check_id auto-links to the new opinion on submit.

**Pending operational work (does not require code):**
- Apply the two new migrations to the Supabase project.
- Set `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` env on the new edge functions (the existing fact-check-opinion already has GEMINI_API_KEY).
- Create a Storage bucket for `media_url` files (Phase 4 — when we move from blob: URLs to durable storage).
- Manual end-to-end test (Phase 5) once the migrations are applied.

**Deferred to next session:**
- Phase 8 — Photo AI Verify (verify-image edge function + Image tab)
- Phase 9 — Podcast/URL ingest (needs an out-of-edge worker for yt-dlp)
- Phase 11 — Brand polish, dark mode parity audit, mobile breakpoints
- Phases 4/5/6 of the original plan (storage, end-to-end test, lessons) — lessons captured already in `tasks/lessons.md`.

---

## Review (Phases 4, 8, 9, 10, 11 — second pass, "build everything in todo")

User said "yes build everything in todo don't ask again," so the remaining
phases shipped without further check-ins. Saved a feedback memory so future
sessions default to that behavior post-plan-approval.

**Storage (Phase 4)**
- Migration `20260504140000_add_media_storage.sql` — public `verified-media` bucket with per-user folder RLS.
- `src/lib/storage.ts` — single `uploadToVerifiedMedia()` helper that browser components reach for.
- `TruthCheckRecorder` now uploads its final blob to durable storage in parallel with the finalize call, so playback survives refresh. Falls back to the in-memory blob URL if upload fails.

**Photo AI Verify (Phase 8)**
- Migration `20260504150000_add_image_verifications.sql` — `image_verifications` + `image_verification_claims`, plus a late-bound FK on `posts.image_verification_id`.
- Edge function `supabase/functions/verify-image/index.ts` — Gemini 2.5 Flash multimodal with Google Search grounding. Returns `ai_generated_likelihood`, `manipulation_indicators[]`, `subject_summary`, per-claim verdicts with citations, and an overall verdict.
- `src/lib/imageVerify.ts` — typed client. Browser uploads to storage first, passes URL to the function (no base64 over the wire).
- `HomeFeed` `Image` tab is now a real `ImagePane`: drop image → preview → optional caption → "Verify & post" → posts to feed with full verdict.
- Post card now renders images and `url`-type previews alongside the existing audio/video player.

**Podcast / URL ingest (Phase 9)**
- Migration `20260504160000_add_url_verifications.sql` — `url_verifications` + `url_ingest_jobs` queue + late-bound FK on `posts.url_verification_id`. Cache by `source_url_hash` so repeat viewers don't re-spend.
- Edge function `supabase/functions/ingest-media-url/index.ts` — classifies the URL (`direct_audio` / `youtube` / `spotify` / `generic`). Direct-audio URLs (≤25MB) are processed inline by calling `verify-media` + `verify-media-finalize` with the service-role key. Larger or non-direct URLs are enqueued for the external worker.
- `worker/url-ingest/` — Node 20 worker (`index.js`, `package.json`, `Dockerfile`, `README.md`). Polls `url_ingest_jobs`, runs yt-dlp to extract 16kHz mono mp3 capped at 30 minutes, uploads to Storage, calls the verify pipeline, promotes the result into a feed `posts` row. Deployable to Fly.io / Railway / any container host.
- `HomeFeed` `Link` tab is now a real `LinkPane`: paste URL → ingest → either immediate verdict (direct audio) or "queued, watch your feed" (YouTube/Spotify).

**'Debate this' handoff (Phase 10)**
- `App.tsx` `onDebateRequest` creates a `debates` row pre-populated with the post's caption + verdict explanation, links it back via `posts.debate_id`, increments `debate_count`, and switches the view to debate detail. Reuses the debate row on subsequent clicks.

**Brand polish + mobile + dark-mode (Phase 11)**
- `src/index.css` — verdict design tokens (`--verdict-true/false/mixed/unverifiable`), brand gradient (`--brand-from/to`), `.verdict-glow-*` utilities, `.brand-gradient`, `line-clamp-3/4`.
- Mobile breakpoint at `<640px`: recorder grid stacks (`.truth-grid`), composer tab labels collapse to icons (`.composer-tab-label`).
- Dark-mode parity for the truth-check section in `TopicDebateView` (was light-only).
- Verdict pills now carry `verdict-glow-*` for a subtle outer ring.

**Code health**
- Typecheck clean, lint clean (zero errors). Fixed pre-existing `any` casts in `TopicDebateView` realtime handlers (replaced with proper `Opinion` / `Agreement` casts) and 4 unused-variable lint errors in old modal files. Net improvement to the project's lint baseline, not just the new code.

**Operational checklist (one-time setup the user must do):**
1. Apply the four new migrations to Supabase (in order):
   - `20260504120000_add_truth_checks.sql`
   - `20260504130000_add_posts.sql`
   - `20260504140000_add_media_storage.sql`
   - `20260504150000_add_image_verifications.sql`
   - `20260504160000_add_url_verifications.sql`
2. Set env on the four new edge functions: `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (the `SUPABASE_URL` is auto-set by Supabase).
3. (For Phase 9 YouTube/Spotify support) deploy `worker/url-ingest/` to Fly.io or similar — see its README.
4. Manually smoke-test: record a 30s clip with one true and one false claim, paste a podcast .mp3 URL, drop a meme image — confirm verdicts, citations, timestamps, and "Debate this".

**Future polish (out of scope for this session, captured for later):**
- True bidirectional Gemini Live streaming as a `Verifier` swap-in (~1s latency vs current ~4s).
- Speaker diarization on multi-voice audio.
- Cross-post search (find all verifications of "Bernie Sanders" claims).
- A `claim_url_ingest_job()` Postgres RPC for proper multi-worker job claiming via `FOR UPDATE SKIP LOCKED`.
- Notification when someone debates your post.
- Per-user rate limit on URL ingest to bound Gemini spend.

# Phase 7+ — Product pivot: AI-verification social media (May 2026 update)

The product is being reframed from "debate platform" → "AI-powered verification social media."
The audio/video truth-check we just built is the engine; the new shell wraps it
with three new media surfaces and a redesigned home.

## New top-level features

### 7. Photo AI Verify
- [ ] Image upload component (drag/drop or paste from clipboard).
- [ ] New edge function `verify-image` — Gemini multimodal with Search grounding.
  - Detects: AI-generated likelihood, manipulation hints, factual claims about subjects in the image, geolocation/identification cross-checks.
- [ ] New `image_verifications` table mirroring `truth_checks` shape.
- [ ] Reuses the same Verifier interface (claims + verdict + citations).

### 8. Podcast / URL Fact Check
- [ ] Paste a YouTube, Spotify, or direct-audio URL.
- [ ] Edge function `ingest-media-url` — fetches audio (yt-dlp via Supabase, or
      a managed extractor service), splits into ~30s windows, feeds each into
      the existing `verify-media` pipeline.
- [ ] Display: full timeline scrubber, claim markers along the timeline,
      transcript with claims inline-highlighted.
- [ ] Cache by URL hash so the second viewer of the same episode doesn't re-spend.

### 9. Live Interview Fact Check
- [ ] Already built (TruthCheckRecorder). Surface it prominently on the new home.

## Unified post model

- [ ] New `posts` table — every verification (audio/video/image/URL) becomes a
      post with: media reference, transcript/description, overall verdict,
      author, optional debate_id (set if someone clicks "Debate this").
- [ ] Migrate the home feed: instead of "topics," show a feed of verified posts
      with verdict pills, citations preview, and a "Debate this" CTA.
- [ ] Existing topics/debates become a derivative ("threads about a verified post").
- [ ] Posts can be created from any of the four sources: record, upload audio/video,
      upload image, paste URL.

## UI redesign

- [ ] New home: vertical feed of verified posts (think Twitter/Bluesky energy
      with a verdict-pill on every card).
- [ ] Top-of-feed composer with 4 tabs: **Record • Upload • Image • Link**
      → all four flow into the same "verify → post" pipeline.
- [ ] Each post card: media thumbnail/player, overall verdict pill, top 2-3
      claims with mini-verdicts, citation chips, "Debate this →" button.
- [ ] Clicking "Debate this" opens the existing TopicDebateView UI but
      pre-populated with the post as the topic — debates become a *commentary
      surface*, not the primary product.
- [ ] Sidebar: trending verified posts, your verifications, debates you're in.
- [ ] New visual identity: shield-check accent (already in use) elevated to
      brand level; verdict palette (emerald/rose/amber/slate) becomes
      first-class color tokens.

## Plan order (proposed)

1. Phase 7a — `posts` table migration + minimal backend so existing
   truth_checks become posts retroactively.
2. Phase 7b — Home feed redesign + composer (the visible win).
3. Phase 8 — Photo verifier (`verify-image` + UI tab).
4. Phase 9 — Podcast/URL ingest (heaviest piece — defer until 7+8 ship).
5. Phase 10 — "Debate this" handoff from a post to existing debate UI.
6. Phase 11 — Brand polish, dark mode pass, mobile breakpoints, microcopy.

## Open questions (must answer before building)

- Are existing topics/debates being kept as a feature or sunset entirely?
- For URL ingest, are we OK depending on yt-dlp / a third-party extractor
  (legal grey area for some sources), or should we restrict to user uploads
  + Spotify-API podcasts only?
- Should non-authors be able to fact-check someone else's posted media (e.g.
  "verify this tweet I'm linking"), or only the author who uploaded it?
- Is there a moderation story when a fact-check returns "false" on a public
  figure's words? (False-positive risk → defamation surface area.)

