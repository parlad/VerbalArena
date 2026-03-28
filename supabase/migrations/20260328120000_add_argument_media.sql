/*
  # Add Argument Media (Images & Videos)

  1. New Tables
    - `argument_media`
      - `media_id`     (uuid, primary key)
      - `argument_id`  (uuid, FK → arguments)
      - `file_url`     (text, public URL from Supabase Storage)
      - `file_name`    (text, original file name)
      - `file_type`    (varchar, MIME type e.g. "image/jpeg", "video/mp4")
      - `file_size`    (bigint, bytes)
      - `uploaded_at`  (timestamptz)

  2. Security
    - RLS enabled; public SELECT / INSERT / DELETE

  3. Storage
    - Requires a Supabase Storage bucket named "argument-media" (public, max 50 MB)
    - Create it in the Supabase Dashboard → Storage → New Bucket:
        Name: argument-media   Public: true   File size limit: 52428800
*/

CREATE TABLE IF NOT EXISTS argument_media (
  media_id    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  argument_id uuid          REFERENCES arguments(argument_id) ON DELETE CASCADE NOT NULL,
  file_url    text          NOT NULL,
  file_name   text          NOT NULL,
  file_type   varchar(100)  NOT NULL,
  file_size   bigint        NOT NULL,
  uploaded_at timestamptz   DEFAULT now()
);

ALTER TABLE argument_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view argument media"
  ON argument_media FOR SELECT TO public USING (true);

CREATE POLICY "Users can upload argument media"
  ON argument_media FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "Users can delete argument media"
  ON argument_media FOR DELETE TO public USING (true);

CREATE INDEX IF NOT EXISTS idx_argument_media_argument
  ON argument_media(argument_id);
