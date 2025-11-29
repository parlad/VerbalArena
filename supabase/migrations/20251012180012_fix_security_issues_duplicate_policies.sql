/*
  # Fix Security Issues - Part 3: Remove Duplicate RLS Policies

  1. Duplicate Policy Issue
    - Table debatetags has multiple permissive SELECT policies
    - "Anyone can view debate tags"
    - "Debate creators can manage their debate tags"
    
  2. Solution
    - Keep only the public viewing policy for SELECT
    - The debate creators policy should handle INSERT/UPDATE/DELETE only
    - This prevents policy conflicts and improves performance

  3. Impact
    - Eliminates redundant policy evaluation
    - Clearer security model
    - Better query performance
*/

-- Drop the duplicate policy for debatetags
DROP POLICY IF EXISTS "Debate creators can manage their debate tags" ON debatetags;

-- Create separate policies for different operations
CREATE POLICY "Debate creators can insert tags"
  ON debatetags
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM debates 
      WHERE debates.debate_id = debatetags.debate_id 
      AND debates.creator_user_id = (select auth.uid())
    )
  );

CREATE POLICY "Debate creators can delete tags"
  ON debatetags
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM debates 
      WHERE debates.debate_id = debatetags.debate_id 
      AND debates.creator_user_id = (select auth.uid())
    )
  );
