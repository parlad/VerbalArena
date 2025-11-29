/*
  # Fix Security Issues - Part 4: Fix Function Search Path Mutability

  1. Function Search Path Issues
    - Functions with role mutable search_path can be vulnerable to attacks
    - Must set explicit search_path to prevent schema-based attacks
    
  2. Affected Functions
    - decrement_topic_votes
    - increment_topic_votes
    - update_updated_at_column

  3. Solution
    - Add SECURITY DEFINER and explicit search_path to functions
    - This ensures functions run with predictable schema resolution
    - Prevents search_path manipulation attacks
*/

-- Fix decrement_topic_votes function
CREATE OR REPLACE FUNCTION decrement_topic_votes(topic_id uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topics
  SET vote_count = GREATEST(vote_count - 1, 0)
  WHERE topics.topic_id = decrement_topic_votes.topic_id;
END;
$$;

-- Fix increment_topic_votes function
CREATE OR REPLACE FUNCTION increment_topic_votes(topic_id uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topics
  SET vote_count = vote_count + 1
  WHERE topics.topic_id = increment_topic_votes.topic_id;
END;
$$;

-- Fix update_updated_at_column function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Grant execute permissions to public for topic vote functions
GRANT EXECUTE ON FUNCTION decrement_topic_votes(uuid) TO public;
GRANT EXECUTE ON FUNCTION increment_topic_votes(uuid) TO public;
