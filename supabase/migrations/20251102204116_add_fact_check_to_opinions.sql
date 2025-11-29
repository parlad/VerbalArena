/*
  # Add Fact Check Support to Opinions

  1. Changes
    - Add `fact_check_result` column to `topic_opinions` table
      - Stores JSON with fact check analysis from AI
      - Includes: verdict (true/false/mixed/unverifiable), explanation, sources
    - Add `fact_checked_at` timestamp column
    - Add index on `fact_checked_at` for filtering fact-checked opinions

  2. Security
    - No RLS changes needed (inherits existing policies)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'topic_opinions' AND column_name = 'fact_check_result'
  ) THEN
    ALTER TABLE topic_opinions ADD COLUMN fact_check_result jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'topic_opinions' AND column_name = 'fact_checked_at'
  ) THEN
    ALTER TABLE topic_opinions ADD COLUMN fact_checked_at timestamptz;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_topic_opinions_fact_checked 
  ON topic_opinions(fact_checked_at) 
  WHERE fact_checked_at IS NOT NULL;