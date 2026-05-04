/*
  # Storage bucket for verified media

  All audio/video/image uploads land in a single `verified-media` bucket.
  Folder layout: <user_id>/<post_or_truth_check_id>/<filename>.

  1. Storage
    - Bucket `verified-media` (public read so playback works in the feed
      without signing every URL).
    - Authenticated users can upload to their own folder.
    - Authors / masters can delete their own files.

  2. Notes
    - The browser uploads directly via Supabase Storage signed URLs; the
      edge function never proxies the bytes.
    - File size cap is enforced in the client; bucket has no hard limit so
      we can raise it later without a migration.
*/

-- Idempotent bucket creation (Supabase requires going through storage.buckets directly)
INSERT INTO storage.buckets (id, name, public)
VALUES ('verified-media', 'verified-media', true)
ON CONFLICT (id) DO NOTHING;

-- ─── Policies ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Public read of verified media" ON storage.objects;
CREATE POLICY "Public read of verified media"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'verified-media');

DROP POLICY IF EXISTS "Users can upload to their own folder" ON storage.objects;
CREATE POLICY "Users can upload to their own folder"
  ON storage.objects FOR INSERT
  TO public
  WITH CHECK (
    bucket_id = 'verified-media'
    AND (auth.uid()::text = (storage.foldername(name))[1])
  );

DROP POLICY IF EXISTS "Users can update their own files" ON storage.objects;
CREATE POLICY "Users can update their own files"
  ON storage.objects FOR UPDATE
  TO public
  USING (
    bucket_id = 'verified-media'
    AND (auth.uid()::text = (storage.foldername(name))[1])
  );

DROP POLICY IF EXISTS "Users and masters can delete media" ON storage.objects;
CREATE POLICY "Users and masters can delete media"
  ON storage.objects FOR DELETE
  TO public
  USING (
    bucket_id = 'verified-media'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR EXISTS (
        SELECT 1 FROM users u
        WHERE u.user_id = auth.uid() AND u.role = 'master'
      )
    )
  );
