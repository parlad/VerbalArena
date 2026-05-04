# Lessons learned — VerbalArena

A running log of non-obvious patterns and gotchas. Each entry: what happened →
why it bit us → what to do differently.

## 2026-05-04 — Live AI truth-check + product pivot

### Gemini grounding gives real URLs; default fact-check did not
- The original `fact-check-opinion` edge function asked Gemini for "sources"
  without enabling the `google_search` tool. Gemini happily made up URLs.
- Always pass `tools: [{ google_search: {} }]` when you ask Gemini for
  citations. Verify with a spot check that the URLs resolve before shipping.

### MediaRecorder mime types are browser-specific
- `audio/webm;codecs=opus` works in Chrome/Edge/Firefox; Safari prefers
  `audio/mp4`. Always probe with `MediaRecorder.isTypeSupported(...)` and fall
  back through a candidate list rather than hardcoding.

### Supabase Edge Functions support SSE but not stateful WebSockets well
- We chose chunked SSE over a true Gemini Live bidi WebSocket relay because
  Deno Deploy isolates make stateful WS relays painful. The `Verifier`
  interface in `src/lib/truthCheck.ts` keeps the upgrade path open.

### yt-dlp can't run inside Edge Functions
- Phase 9 (URL ingest) requires a separate worker (Fly.io / Railway /
  Cloudflare Worker + R2). Edge functions are Deno isolates with no Python
  binary and no shell access. Plan a downloader worker that uploads extracted
  audio to Supabase Storage, then enqueues into `verify-media`.

### eslint `@typescript-eslint/no-unused-vars` doesn't honor `_` prefix in this config
- Underscore-prefixed unused vars still error. Either remove them or add an
  inline `// eslint-disable-next-line @typescript-eslint/no-unused-vars` comment.

### Read-modify-write is fine on small Supabase rows but isn't atomic
- The transcript accumulation in `verify-media` reads, concatenates, writes.
  Two parallel chunks could race and lose a delta. For v1 this is acceptable
  (users notice missing words, not wrong verdicts); for v2 either move to a
  Postgres function (`UPDATE ... SET transcript = transcript || $1`) or use
  optimistic concurrency.

### Existing TopicDebateView opinions form has light-mode-only styling
- The truth-check section we added there inherits the same constraint. When
  Phase 11 does the dark-mode pass, audit `TopicDebateView` for missing
  `dark:` classes — there are several, all pre-existing. (Phase 11 fixed the
  truth-check sub-section; the rest of TopicDebateView still light-only.)

### Polymorphic FK to a not-yet-created table → late-bind in a later migration
- `posts` references `image_verifications` and `url_verifications`, but those
  tables didn't exist when the posts migration shipped. We declared the
  columns as plain `uuid` in the posts migration, then added the FK
  constraints in the later migrations via `IF NOT EXISTS` guards. This keeps
  each migration runnable in isolation and lets the product roll out feature
  by feature.

### Direct-audio URLs are a free win on the URL-ingest path
- Many podcasts publish `.mp3` URLs in their RSS feed. The `ingest-media-url`
  edge function checks the extension and processes them inline (no worker
  needed). Only YouTube/Spotify/generic-page URLs get queued for the
  external worker. Cuts infra cost and latency for the most common case.

### Worker-job queue with `SELECT … FOR UPDATE SKIP LOCKED` belongs in an RPC
- The url-ingest worker uses an UPDATE … RETURNING pattern that's race-prone
  with multiple workers. For production at >1 instance, add a Postgres RPC
  `claim_url_ingest_job()` that does `SELECT … FOR UPDATE SKIP LOCKED` then
  UPDATE in a single transaction. The worker README notes this.

### Deno Edge Functions can call each other via the same `/functions/v1/` URL
- `ingest-media-url` for direct-audio fans out to `verify-media` and
  `verify-media-finalize` with the service-role key. Same pattern works for
  the external worker. Simpler than introducing a job queue between edge
  functions for synchronous orchestration.

### Verdict color tokens belong in CSS, not duplicated across components
- `index.css` now defines `--verdict-true / --verdict-false / --verdict-mixed
  / --verdict-unverifiable` plus `verdict-glow-*` utilities. New components
  can reach for these instead of redefining the palette. Same pattern for
  the `brand-gradient` class.

### Mobile breakpoints: stack the recorder grid, hide composer tab labels
- Added `truth-grid` (1-column on `<640px`) and `composer-tab-label`
  (display:none on `<640px`) classes in `index.css`. Keeps the Tailwind
  templates uncluttered while making the new feed actually usable on phones.
