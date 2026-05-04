/*
  # Podcast / URL ingest

  When a user pastes a YouTube / Spotify / direct-audio URL, we create a
  `url_verifications` row. Direct-audio URLs (.mp3 / .wav / .m4a / .ogg) are
  fetched and processed by the verify-media pipeline immediately. Other URLs
  (YouTube, Spotify, generic web pages) are enqueued for the external
  ingest-worker (see `worker/url-ingest/`) which runs yt-dlp, uploads the
  extracted audio to Storage, then triggers the same verify-media pipeline.

  1. New tables
    - `url_verifications` — one row per ingest request with status machine
    - `url_ingest_jobs` — work queue read by the external worker

  2. Wires the existing posts.url_verification_id FK.
*/

CREATE TABLE IF NOT EXISTS url_verifications (
  url_verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  source_url text NOT NULL,
  source_kind varchar(20) NOT NULL DEFAULT 'unknown'
    CHECK (source_kind IN ('direct_audio', 'youtube', 'spotify', 'generic', 'unknown')),
  source_url_hash text,                    -- sha256(lower(trimmed url)) for caching
  title text,
  duration_seconds numeric(10, 2),
  audio_url text,                          -- populated once worker uploads extracted audio
  truth_check_id uuid REFERENCES truth_checks(truth_check_id) ON DELETE SET NULL,

  status varchar(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'extracting', 'verifying', 'completed', 'failed')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE url_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view url verifications"
  ON url_verifications FOR SELECT TO public USING (true);
CREATE POLICY "Users can create their own url verifications"
  ON url_verifications FOR INSERT TO public
  WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "Authors and masters can update url verifications"
  ON url_verifications FOR UPDATE TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = (select auth.uid()) AND u.role = 'master')
  )
  WITH CHECK (true);

-- Cache key — same URL never re-extracts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_url_verifications_hash
  ON url_verifications(source_url_hash) WHERE source_url_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_url_verifications_user ON url_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_url_verifications_status ON url_verifications(status);

-- ─── Worker job queue ─────────────────────────────────────────────────────
-- The ingest-worker polls url_ingest_jobs WHERE status='pending' AND
-- locked_until IS NULL OR locked_until < now(). It SELECT … FOR UPDATE SKIP
-- LOCKED to claim a job, sets locked_until = now() + interval '10 minutes',
-- runs yt-dlp, uploads the audio, then calls verify-media.
CREATE TABLE IF NOT EXISTS url_ingest_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url_verification_id uuid REFERENCES url_verifications(url_verification_id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  source_url text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE url_ingest_jobs ENABLE ROW LEVEL SECURITY;
-- Workers use the service-role key, which bypasses RLS. Browser shouldn't
-- read this table.
CREATE POLICY "Owners can read their own ingest jobs"
  ON url_ingest_jobs FOR SELECT TO public
  USING (user_id = (select auth.uid()));

CREATE INDEX IF NOT EXISTS idx_url_ingest_jobs_pending
  ON url_ingest_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_url_ingest_jobs_uv ON url_ingest_jobs(url_verification_id);

CREATE TRIGGER update_url_ingest_jobs_updated_at
  BEFORE UPDATE ON url_ingest_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Late-bind the FK on posts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'posts_url_verification_id_fkey'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_url_verification_id_fkey
      FOREIGN KEY (url_verification_id)
      REFERENCES url_verifications(url_verification_id)
      ON DELETE SET NULL;
  END IF;
END $$;
