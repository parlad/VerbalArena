# url-ingest worker

Drains the `url_ingest_jobs` queue. For each job: runs yt-dlp on the URL,
extracts audio (16kHz mono mp3, capped at 30 minutes), uploads to Supabase
Storage, then triggers the `verify-media` + `verify-media-finalize` pipeline
to fact-check the audio. Promotes the result into a feed `posts` row.

This is a separate process because Supabase Edge Functions (Deno isolates) can't
run yt-dlp (a Python binary). Recommended hosts: Fly.io, Railway, Render, or any
small VPS.

## Required env

| Variable | Description |
|---|---|
| `SUPABASE_URL` | `https://<your-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (NOT the anon key) — keep secret |
| `POLL_INTERVAL_MS` | (optional) defaults to 5000 |
| `MAX_DURATION_SECONDS` | (optional) per-clip cap, defaults to 1800 (30 min) |

## Local dev

```bash
cd worker/url-ingest
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm start
```

You'll need `yt-dlp` and `ffmpeg` installed locally
(`brew install yt-dlp ffmpeg` on macOS, `apt install ffmpeg && pip install yt-dlp`
on Ubuntu).

## Docker

```bash
docker build -t va-url-ingest worker/url-ingest
docker run --rm \
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  va-url-ingest
```

## Fly.io deploy (recommended)

```bash
cd worker/url-ingest
fly launch --no-deploy   # accept Dockerfile detection
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy
```

A single `shared-cpu-1x` machine handles dozens of jobs/hour. Scale up if
your queue depth grows. Run multiple instances safely — the SQL polling
uses `status='pending'` filtering so each row is claimed once (and a real
`SELECT … FOR UPDATE SKIP LOCKED` RPC, see `index.js` notes, is the
production-grade upgrade).

## Operational notes

- **Cost guardrail:** the `MAX_DURATION_SECONDS=1800` cap keeps Gemini bills
  predictable. Raise it deliberately.
- **Failure modes you should expect:**
  - YouTube changes its API/site every few weeks — keep yt-dlp current. The
    Dockerfile pulls latest at build time; rebuild monthly.
  - Some Spotify episodes are DRM-protected and yt-dlp can't extract them.
    The job will fail with a clear error_message; the user sees a "we
    couldn't extract this URL" toast.
  - Long YouTube livestreams: don't try, the duration filter blocks them.
- **Legal:** running yt-dlp against copyrighted content is a gray area in
  many jurisdictions. Consider rate-limits per user, and surface a user-
  facing notice that they're responsible for what they submit.
