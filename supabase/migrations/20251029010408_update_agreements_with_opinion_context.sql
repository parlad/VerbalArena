/*
  # Update Agreements to Link to Specific Opinions

  1. Changes
    - Add `supporting_opinion_id` column to link to supporting side opinion
    - Add `opposing_opinion_id` column to link to opposing side opinion
    - Add `display_position` to determine where in the timeline to show the agreement
    - These columns are optional to support standalone agreements

  2. Indexes
    - Add indexes for opinion lookups
*/

-- Add columns to link agreements to specific opinions
ALTER TABLE topic_agreements
  ADD COLUMN IF NOT EXISTS supporting_opinion_id uuid REFERENCES topic_opinions(opinion_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS opposing_opinion_id uuid REFERENCES topic_opinions(opinion_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_position integer DEFAULT 0;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_topic_agreements_supporting_opinion ON topic_agreements(supporting_opinion_id);
CREATE INDEX IF NOT EXISTS idx_topic_agreements_opposing_opinion ON topic_agreements(opposing_opinion_id);
CREATE INDEX IF NOT EXISTS idx_topic_agreements_display_position ON topic_agreements(display_position);
