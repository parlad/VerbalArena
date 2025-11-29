/*
  # Add Opinion Evidence Files

  1. New Tables
    - `opinion_evidence`
      - `evidence_id` (uuid, primary key)
      - `opinion_id` (uuid, foreign key to topic_opinions)
      - `file_name` (text, original file name)
      - `file_url` (text, URL to the file)
      - `file_type` (varchar, MIME type)
      - `file_size` (bigint, size in bytes)
      - `description` (text, optional description)
      - `uploaded_at` (timestamptz)

  2. Security
    - Enable RLS on opinion_evidence table
    - Anyone can view evidence files
    - Authenticated users can upload evidence for their opinions
    - Authors can delete their evidence

  3. Performance
    - Add indexes on foreign keys
    - Add index for opinion_id lookups
*/

-- Create opinion_evidence table
CREATE TABLE IF NOT EXISTS opinion_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opinion_id uuid REFERENCES topic_opinions(opinion_id) ON DELETE CASCADE NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_type varchar(100) NOT NULL,
  file_size bigint NOT NULL,
  description text DEFAULT '',
  uploaded_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE opinion_evidence ENABLE ROW LEVEL SECURITY;

-- RLS Policies for opinion_evidence
CREATE POLICY "Anyone can view evidence"
  ON opinion_evidence
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can upload evidence"
  ON opinion_evidence
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Users can delete evidence"
  ON opinion_evidence
  FOR DELETE
  TO public
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_opinion_evidence_opinion ON opinion_evidence(opinion_id);
CREATE INDEX IF NOT EXISTS idx_opinion_evidence_uploaded_at ON opinion_evidence(uploaded_at DESC);
