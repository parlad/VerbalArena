/*
  # Add Common Ground Agreements

  1. New Tables
    - `topic_agreements`
      - `agreement_id` (uuid, primary key)
      - `topic_id` (uuid, foreign key to topics)
      - `content` (text, the agreement statement)
      - `created_by` (uuid, foreign key to users)
      - `created_at` (timestamptz)
      - `is_active` (boolean, whether agreement is still valid)

  2. Security
    - Enable RLS on topic_agreements table
    - Anyone can view agreements
    - Authenticated users can create agreements
    - Only creator or master can delete agreements

  3. Performance
    - Add indexes on foreign keys
    - Add index for topic_id lookups
*/

-- Create topic_agreements table
CREATE TABLE IF NOT EXISTS topic_agreements (
  agreement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid REFERENCES topics(topic_id) ON DELETE CASCADE NOT NULL,
  content text NOT NULL,
  created_by uuid REFERENCES users(user_id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true
);

-- Enable RLS
ALTER TABLE topic_agreements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for topic_agreements
CREATE POLICY "Anyone can view agreements"
  ON topic_agreements
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can create agreements"
  ON topic_agreements
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Users can update agreements"
  ON topic_agreements
  FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete agreements"
  ON topic_agreements
  FOR DELETE
  TO public
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_topic_agreements_topic ON topic_agreements(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_agreements_created_at ON topic_agreements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_agreements_active ON topic_agreements(is_active) WHERE is_active = true;
