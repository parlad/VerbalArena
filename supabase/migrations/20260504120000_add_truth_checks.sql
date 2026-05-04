/*
  # Add Live AI Truth-Check (audio/video verification)

  1. New Tables
    - `truth_checks`
      - `truth_check_id` (uuid, primary key)
      - `user_id` (uuid, foreign key to users — author of the recording)
      - `opinion_id` (uuid, nullable, foreign key to topic_opinions —
        set when the truth-check was created inside the opinion submission flow,
        NULL when created from the standalone /truth-check page)
      - `media_url` (text, signed/public URL to the uploaded audio or video)
      - `media_type` (varchar: 'audio' or 'video')
      - `mime_type` (varchar, e.g. 'audio/webm;codecs=opus')
      - `duration_seconds` (numeric)
      - `transcript` (text, accumulated full transcript)
      - `overall_verdict` (varchar: 'true' | 'false' | 'mixed' | 'unverifiable' | NULL while processing)
      - `overall_explanation` (text, post-finalize summary)
      - `status` (varchar: 'recording' | 'processing' | 'completed' | 'failed')
      - `error_message` (text, populated on failure)
      - `created_at` / `updated_at` / `completed_at`

    - `truth_check_claims` — one row per discrete factual claim extracted
      - `claim_id` (uuid, primary key)
      - `truth_check_id` (uuid, foreign key)
      - `claim_text` (text, the verbatim claim)
      - `start_seconds` / `end_seconds` (numeric, position in the recording)
      - `verdict` (varchar: 'true' | 'false' | 'mixed' | 'unverifiable')
      - `explanation` (text)
      - `sources` (jsonb, array of {title, url, snippet})
      - `confidence` (numeric, 0-1)
      - `chunk_index` (integer, which audio chunk produced this claim — for ordering)
      - `created_at`

  2. Security
    - Anyone can read truth_checks and claims (consistent with topic_opinions / opinion_evidence)
    - Authors create their own truth_checks; only authors or masters update / delete
    - Claim writes happen via the verify-media edge function (service-role bypasses RLS),
      so the policy below restricts client-side writes to the truth-check author

  3. Performance
    - Indexes on truth_check_id, opinion_id, user_id, status, created_at
*/

-- ─── truth_checks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS truth_checks (
  truth_check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  opinion_id uuid REFERENCES topic_opinions(opinion_id) ON DELETE SET NULL,
  media_url text NOT NULL,
  media_type varchar(10) NOT NULL CHECK (media_type IN ('audio', 'video')),
  mime_type varchar(100) NOT NULL DEFAULT 'audio/webm',
  duration_seconds numeric(10, 2) DEFAULT 0,
  transcript text DEFAULT '',
  overall_verdict varchar(20) CHECK (
    overall_verdict IS NULL
    OR overall_verdict IN ('true', 'false', 'mixed', 'unverifiable')
  ),
  overall_explanation text DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'processing', 'completed', 'failed')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE truth_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view truth checks"
  ON truth_checks
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can create their own truth checks"
  ON truth_checks
  FOR INSERT
  TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Authors and masters can update truth checks"
  ON truth_checks
  FOR UPDATE
  TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = (select auth.uid()) AND u.role = 'master'
    )
  )
  WITH CHECK (true);

CREATE POLICY "Authors and masters can delete truth checks"
  ON truth_checks
  FOR DELETE
  TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = (select auth.uid()) AND u.role = 'master'
    )
  );

-- ─── truth_check_claims ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS truth_check_claims (
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  truth_check_id uuid REFERENCES truth_checks(truth_check_id) ON DELETE CASCADE NOT NULL,
  claim_text text NOT NULL,
  start_seconds numeric(10, 2) NOT NULL DEFAULT 0,
  end_seconds numeric(10, 2) NOT NULL DEFAULT 0,
  verdict varchar(20) NOT NULL
    CHECK (verdict IN ('true', 'false', 'mixed', 'unverifiable')),
  explanation text DEFAULT '',
  sources jsonb DEFAULT '[]'::jsonb,
  confidence numeric(3, 2) DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  chunk_index integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE truth_check_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view truth check claims"
  ON truth_check_claims
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Truth check authors can insert claims"
  ON truth_check_claims
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM truth_checks tc
      WHERE tc.truth_check_id = truth_check_claims.truth_check_id
        AND tc.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Truth check authors and masters can delete claims"
  ON truth_check_claims
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM truth_checks tc
      WHERE tc.truth_check_id = truth_check_claims.truth_check_id
        AND (
          tc.user_id = (select auth.uid())
          OR EXISTS (
            SELECT 1 FROM users u
            WHERE u.user_id = (select auth.uid()) AND u.role = 'master'
          )
        )
    )
  );

-- ─── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_truth_checks_user ON truth_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_truth_checks_opinion ON truth_checks(opinion_id) WHERE opinion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_truth_checks_status ON truth_checks(status);
CREATE INDEX IF NOT EXISTS idx_truth_checks_created_at ON truth_checks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_truth_check_claims_truth_check
  ON truth_check_claims(truth_check_id);
CREATE INDEX IF NOT EXISTS idx_truth_check_claims_chunk
  ON truth_check_claims(truth_check_id, chunk_index, start_seconds);
CREATE INDEX IF NOT EXISTS idx_truth_check_claims_verdict
  ON truth_check_claims(verdict);

-- ─── updated_at trigger (reuses helper from earlier migrations) ────────────
CREATE TRIGGER update_truth_checks_updated_at
  BEFORE UPDATE ON truth_checks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
