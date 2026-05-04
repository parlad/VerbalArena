/*
  # Photo AI Verify

  Image-side mirror of truth_checks.

  1. New tables
    - `image_verifications`
      - id, user_id, image_url, mime_type
      - ai_generated_likelihood (numeric 0-1)
      - manipulation_indicators (text[])
      - subject_summary (text — what the image is *of*)
      - overall_verdict, overall_explanation, status, error_message
      - created_at / completed_at

    - `image_verification_claims` — discrete factual claims about the image
      (e.g. "this is the Eiffel Tower at sunset"), each verified with citations.

  2. Security: same shape as truth_checks (anyone reads, owner writes).

  3. Wires the existing posts.image_verification_id FK now that the table exists.
*/

CREATE TABLE IF NOT EXISTS image_verifications (
  image_verification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  image_url text NOT NULL,
  mime_type varchar(100) NOT NULL DEFAULT 'image/jpeg',
  width integer,
  height integer,

  ai_generated_likelihood numeric(3, 2) CHECK (
    ai_generated_likelihood IS NULL
    OR (ai_generated_likelihood >= 0 AND ai_generated_likelihood <= 1)
  ),
  manipulation_indicators jsonb DEFAULT '[]'::jsonb,
  subject_summary text DEFAULT '',

  overall_verdict varchar(20) CHECK (
    overall_verdict IS NULL
    OR overall_verdict IN ('true', 'false', 'mixed', 'unverifiable')
  ),
  overall_explanation text DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,

  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE image_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view image verifications"
  ON image_verifications FOR SELECT TO public USING (true);

CREATE POLICY "Users can create their own image verifications"
  ON image_verifications FOR INSERT TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Authors and masters can update image verifications"
  ON image_verifications FOR UPDATE TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = (select auth.uid()) AND u.role = 'master')
  )
  WITH CHECK (true);

CREATE POLICY "Authors and masters can delete image verifications"
  ON image_verifications FOR DELETE TO public
  USING (
    user_id = (select auth.uid())
    OR EXISTS (SELECT 1 FROM users u WHERE u.user_id = (select auth.uid()) AND u.role = 'master')
  );

-- ─── Per-claim table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS image_verification_claims (
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_verification_id uuid REFERENCES image_verifications(image_verification_id) ON DELETE CASCADE NOT NULL,
  claim_text text NOT NULL,
  verdict varchar(20) NOT NULL CHECK (verdict IN ('true', 'false', 'mixed', 'unverifiable')),
  explanation text DEFAULT '',
  sources jsonb DEFAULT '[]'::jsonb,
  confidence numeric(3, 2) DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE image_verification_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view image claims"
  ON image_verification_claims FOR SELECT TO public USING (true);

CREATE POLICY "Image owners can insert claims"
  ON image_verification_claims FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM image_verifications iv
      WHERE iv.image_verification_id = image_verification_claims.image_verification_id
        AND iv.user_id = (select auth.uid())
    )
  );

CREATE INDEX IF NOT EXISTS idx_image_verifications_user ON image_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_image_verifications_status ON image_verifications(status);
CREATE INDEX IF NOT EXISTS idx_image_verifications_created_at ON image_verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_verification_claims_iv ON image_verification_claims(image_verification_id);

-- Late-bind the FK on posts now that the target table exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'posts_image_verification_id_fkey'
  ) THEN
    ALTER TABLE posts
      ADD CONSTRAINT posts_image_verification_id_fkey
      FOREIGN KEY (image_verification_id)
      REFERENCES image_verifications(image_verification_id)
      ON DELETE SET NULL;
  END IF;
END $$;
