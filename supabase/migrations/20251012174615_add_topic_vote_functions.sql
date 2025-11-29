/*
  # Add Topic Vote Functions

  1. New Functions
    - `increment_topic_votes` - Safely increments vote count on a topic
    - `decrement_topic_votes` - Safely decrements vote count on a topic
  
  2. Purpose
    - These functions ensure atomic updates to vote counts
    - Prevent race conditions when multiple users vote simultaneously
*/

-- Function to increment topic votes
CREATE OR REPLACE FUNCTION increment_topic_votes(topic_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE topics
  SET vote_count = vote_count + 1
  WHERE topics.topic_id = increment_topic_votes.topic_id;
END;
$$ LANGUAGE plpgsql;

-- Function to decrement topic votes
CREATE OR REPLACE FUNCTION decrement_topic_votes(topic_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE topics
  SET vote_count = GREATEST(vote_count - 1, 0)
  WHERE topics.topic_id = decrement_topic_votes.topic_id;
END;
$$ LANGUAGE plpgsql;
