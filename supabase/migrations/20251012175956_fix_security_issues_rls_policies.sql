/*
  # Fix Security Issues - Part 2: Optimize RLS Policies

  1. RLS Policy Optimization
    - Replace auth.uid() with (select auth.uid()) to prevent re-evaluation per row
    - This significantly improves query performance at scale
    - Update all policies that use auth functions

  2. Affected Tables
    - users
    - debates
    - arguments
    - argumentvotes
    - debatetags
    - argumentflags

  3. Performance Impact
    - Auth functions are now evaluated once per query instead of per row
    - Reduces computational overhead
    - Improves response times for large datasets
*/

-- Fix users table policies
DROP POLICY IF EXISTS "Users can update own profile" ON users;

CREATE POLICY "Users can update own profile"
  ON users
  FOR UPDATE
  TO public
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- Fix debates table policies
DROP POLICY IF EXISTS "Authenticated users can create debates" ON debates;

CREATE POLICY "Authenticated users can create debates"
  ON debates
  FOR INSERT
  TO public
  WITH CHECK (creator_user_id = (select auth.uid()));

-- Fix arguments table policies
DROP POLICY IF EXISTS "Authenticated users can create arguments" ON arguments;

CREATE POLICY "Authenticated users can create arguments"
  ON arguments
  FOR INSERT
  TO public
  WITH CHECK (user_id = (select auth.uid()));

-- Fix argumentvotes table policies
DROP POLICY IF EXISTS "Authenticated users can vote" ON argumentvotes;
DROP POLICY IF EXISTS "Users can update their votes" ON argumentvotes;
DROP POLICY IF EXISTS "Users can delete their votes" ON argumentvotes;

CREATE POLICY "Authenticated users can vote"
  ON argumentvotes
  FOR INSERT
  TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Users can update their votes"
  ON argumentvotes
  FOR UPDATE
  TO public
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Users can delete their votes"
  ON argumentvotes
  FOR DELETE
  TO public
  USING (user_id = (select auth.uid()));

-- Fix debatetags table policies
DROP POLICY IF EXISTS "Debate creators can manage their debate tags" ON debatetags;

CREATE POLICY "Debate creators can manage their debate tags"
  ON debatetags
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM debates 
      WHERE debates.debate_id = debatetags.debate_id 
      AND debates.creator_user_id = (select auth.uid())
    )
  );

-- Fix argumentflags table policies
DROP POLICY IF EXISTS "Users can view their own flags" ON argumentflags;
DROP POLICY IF EXISTS "Authenticated users can create flags" ON argumentflags;

CREATE POLICY "Users can view their own flags"
  ON argumentflags
  FOR SELECT
  TO public
  USING (reporter_user_id = (select auth.uid()));

CREATE POLICY "Authenticated users can create flags"
  ON argumentflags
  FOR INSERT
  TO public
  WITH CHECK (reporter_user_id = (select auth.uid()));
