/*
  # Unified Posts (verification-first social feed)

  Reframes the product: every piece of content posted to VerbalArena is a "post"
  that wraps some verified media (audio/video/image/URL/text). The home feed
  iterates over `posts`. Existing topics and opinions stay queryable but are no
  longer the primary surface — debate becomes a "Debate this" CTA on a post
  rather than the entry point.

  1. New tables
    - `posts`
      - `post_id` (uuid PK)
      - `user_id` (FK users) — the author
      - `post_type` ('audio' | 'video' | 'image' | 'url' | 'text')
      - `caption` (text — the human-written context the user adds)
      - `media_url` (text, nullable — playable URL or thumbnail target)
      - `media_thumb_url` (text, nullable — preview image for cards)
      - `truth_check_id` (uuid, nullable, FK truth_checks — if audio/video)
      - `image_verification_id` (uuid, nullable — for Phase 8)
      - `url_verification_id` (uuid, nullable — for Phase 9)
      - `debate_id` (uuid, nullable, FK debates — set when someone clicks
        "Debate this" so the discussion has a concrete debate row to live in)
      - `topic_id` (uuid, nullable, FK topics — same idea for the topics surface)
      - `overall_verdict` (varchar, nullable — denormalized rollup verdict for
        the feed; source of truth lives in the verification tables)
      - `overall_explanation` (text)
      - `verdict_at` (timestamptz — when the rollup was computed)
      - `status` ('pending' | 'verifying' | 'verified' | 'failed')
      - `view_count`, `debate_count` (int)
      - `created_at`, `updated_at`

  2. Security
    - Anyone can read posts (public feed)
    - Authors create their own posts; only authors or masters update / delete

  3. Performance
    - Indexes on user_id, post_type, status, created_at DESC, debate_id, topic_id
    - Partial indexes on (status='verified', created_at DESC) for the feed
*/

CREATE TABLE IF NOT EXISTS posts (
  post_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  post_type varchar(10) NOT NULL CHECK (post_type IN ('audio', 'video', 'image', 'url', 'text')),
  caption text DEFAULT '',
  media_url text,
  media_thumb_url text,

  -- Verification references (only one of these is set; the rest are NULL)
  truth_check_id uuid REFERENCES truth_checks(truth_check_id) ON DELETE SET NULL,
  image_verification_id uuid,    -- FK added in Phase 8 migration
  url_verification_id uuid,      -- FK added in Phase 9 migration

  -- Debate / discussion handoff (set when someone hits "Debate this")
  debate_id uuid REFERENCES debates(debate_id) ON DELETE SET NULL,
  topic_id uuid REFERENCES topics(topic_id) ON DELETE SET NULL,

  -- Denormalized rollup so the feed query stays a single SELECT
  overall_verdict varchar(20) CHECK (
    overall_verdict IS NULL
    OR overall_verdict IN ('true', 'false', 'mixed', 'unverifiable')
  ),
  overall_explanation text DEFAULT '',
  verdict_at timestamptz,

  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verifying', 'verified', 'failed')),
  view_count integer NOT NULL DEFAULT 0,
  debate_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view posts"
  ON posts FOR SELECT TO public USING (true);

CREATE POLICY "Users can create their own posts"
  ON posts FOR INSERT TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Authors and masters can update posts"
  ON posts FOR UPDATE TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = (select auth.uid()) AND u.role = 'master')
  )
  WITH CHECK (true);

CREATE POLICY "Authors and masters can delete posts"
  ON posts FOR DELETE TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = (select auth.uid()) AND u.role = 'master')
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_post_type ON posts(post_type);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_debate ON posts(debate_id) WHERE debate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id) WHERE topic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_truth_check ON posts(truth_check_id) WHERE truth_check_id IS NOT NULL;
-- Hot path: home feed of verified posts ordered by recency
CREATE INDEX IF NOT EXISTS idx_posts_feed
  ON posts(status, created_at DESC)
  WHERE status = 'verified';

-- updated_at trigger (reuses helper)
CREATE TRIGGER update_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─── Backfill: every existing completed truth_check becomes a post ─────────
-- Idempotent: only inserts when no post yet exists for that truth_check.
INSERT INTO posts (user_id, post_type, caption, media_url, truth_check_id,
                   overall_verdict, overall_explanation, verdict_at, status, created_at)
SELECT
  tc.user_id,
  tc.media_type,
  COALESCE(tc.transcript, '') AS caption,
  tc.media_url,
  tc.truth_check_id,
  tc.overall_verdict,
  tc.overall_explanation,
  tc.completed_at,
  CASE
    WHEN tc.status = 'completed' THEN 'verified'
    WHEN tc.status = 'failed'    THEN 'failed'
    ELSE 'verifying'
  END AS status,
  tc.created_at
FROM truth_checks tc
WHERE NOT EXISTS (
  SELECT 1 FROM posts p WHERE p.truth_check_id = tc.truth_check_id
);
