/*
  # Fix RLS for new tables (truth_checks, posts, image/url verifications, storage)

  ## Problem
  All the May 2026 migrations used `user_id = (select auth.uid())` in their RLS
  policies, but VerbalArena uses **custom authentication** (plain SELECT
  against the `users` table — see AuthModal.tsx). `auth.uid()` is always NULL
  in this project, so every INSERT/UPDATE/DELETE on the new tables fails with
  "new row violates row-level security policy".

  Same issue, same fix applied in `20251012181218_fix_rls_for_custom_auth.sql`
  for the original tables.

  ## Fix
  Drop the auth.uid()-based policies on the new tables and replace with the
  permissive `WITH CHECK (true)` / `USING (true)` pattern. The frontend is
  responsible for validating user_id before sending writes.

  Same fix applied to the verified-media storage bucket so uploads work.

  ## Security note
  This is the same trust model the rest of the app already uses. When this
  project moves to Supabase Auth, all of these policies should be tightened
  to compare against `auth.uid()` again.
*/

-- ─── truth_checks ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create their own truth checks" ON truth_checks;
DROP POLICY IF EXISTS "Authors and masters can update truth checks" ON truth_checks;
DROP POLICY IF EXISTS "Authors and masters can delete truth checks" ON truth_checks;

CREATE POLICY "Anyone can insert truth checks"
  ON truth_checks FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update truth checks"
  ON truth_checks FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete truth checks"
  ON truth_checks FOR DELETE TO public USING (true);

-- ─── truth_check_claims ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Truth check authors can insert claims" ON truth_check_claims;
DROP POLICY IF EXISTS "Truth check authors and masters can delete claims" ON truth_check_claims;

CREATE POLICY "Anyone can insert claims"
  ON truth_check_claims FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update claims"
  ON truth_check_claims FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete claims"
  ON truth_check_claims FOR DELETE TO public USING (true);

-- ─── posts ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create their own posts" ON posts;
DROP POLICY IF EXISTS "Authors and masters can update posts" ON posts;
DROP POLICY IF EXISTS "Authors and masters can delete posts" ON posts;

CREATE POLICY "Anyone can insert posts"
  ON posts FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update posts"
  ON posts FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete posts"
  ON posts FOR DELETE TO public USING (true);

-- ─── image_verifications + claims ──────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create their own image verifications" ON image_verifications;
DROP POLICY IF EXISTS "Authors and masters can update image verifications" ON image_verifications;
DROP POLICY IF EXISTS "Authors and masters can delete image verifications" ON image_verifications;

CREATE POLICY "Anyone can insert image verifications"
  ON image_verifications FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update image verifications"
  ON image_verifications FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete image verifications"
  ON image_verifications FOR DELETE TO public USING (true);

DROP POLICY IF EXISTS "Image owners can insert claims" ON image_verification_claims;

CREATE POLICY "Anyone can insert image claims"
  ON image_verification_claims FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update image claims"
  ON image_verification_claims FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete image claims"
  ON image_verification_claims FOR DELETE TO public USING (true);

-- ─── url_verifications + jobs ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can create their own url verifications" ON url_verifications;
DROP POLICY IF EXISTS "Authors and masters can update url verifications" ON url_verifications;
DROP POLICY IF EXISTS "Owners can read their own ingest jobs" ON url_ingest_jobs;

CREATE POLICY "Anyone can insert url verifications"
  ON url_verifications FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update url verifications"
  ON url_verifications FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete url verifications"
  ON url_verifications FOR DELETE TO public USING (true);

CREATE POLICY "Anyone can read ingest jobs"
  ON url_ingest_jobs FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can insert ingest jobs"
  ON url_ingest_jobs FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update ingest jobs"
  ON url_ingest_jobs FOR UPDATE TO public USING (true) WITH CHECK (true);

-- ─── Storage bucket: verified-media ───────────────────────────────────────
-- The original storage policies gated INSERT/UPDATE/DELETE on auth.uid() too —
-- which means uploads from the browser fail. Loosen them to match the rest of
-- the project's trust model.
DROP POLICY IF EXISTS "Users can upload to their own folder" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own files" ON storage.objects;
DROP POLICY IF EXISTS "Users and masters can delete media" ON storage.objects;

CREATE POLICY "Anyone can upload to verified-media"
  ON storage.objects FOR INSERT TO public
  WITH CHECK (bucket_id = 'verified-media');
CREATE POLICY "Anyone can update verified-media"
  ON storage.objects FOR UPDATE TO public
  USING (bucket_id = 'verified-media')
  WITH CHECK (bucket_id = 'verified-media');
CREATE POLICY "Anyone can delete verified-media"
  ON storage.objects FOR DELETE TO public
  USING (bucket_id = 'verified-media');
