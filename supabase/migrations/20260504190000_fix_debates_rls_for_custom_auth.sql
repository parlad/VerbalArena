/*
  # Fix RLS on `debates` for custom auth

  The `debates` table was created with auth.uid()-based policies that block
  inserts/updates from the custom-auth flow (where auth.uid() is always
  NULL). This is the same class of bug that broke truth_checks earlier;
  the original `20251012181218_fix_rls_for_custom_auth.sql` only patched
  topic_opinions, not debates.

  Fix: drop strict policies, replace with the project's permissive pattern
  (frontend trusts user_id on insert).

  ## Symptom this fixes
  "Debate this" button creates no debate row → click does nothing.
*/

-- Drop any existing policies on debates that gate by auth.uid()...
DROP POLICY IF EXISTS "Authenticated users can create debates" ON debates;
DROP POLICY IF EXISTS "Users can create debates" ON debates;
DROP POLICY IF EXISTS "Debate creators can update their debates" ON debates;
DROP POLICY IF EXISTS "Debate creators can delete their debates" ON debates;
DROP POLICY IF EXISTS "Masters and creators can update debates" ON debates;
DROP POLICY IF EXISTS "Masters and creators can delete debates" ON debates;
-- ...and the new ones too, in case a previous partial run created them.
DROP POLICY IF EXISTS "Anyone can insert debates" ON debates;
DROP POLICY IF EXISTS "Anyone can update debates" ON debates;
DROP POLICY IF EXISTS "Anyone can delete debates" ON debates;

CREATE POLICY "Anyone can insert debates"
  ON debates FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update debates"
  ON debates FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete debates"
  ON debates FOR DELETE TO public USING (true);

-- Same fix for arguments.
DROP POLICY IF EXISTS "Authenticated users can create arguments" ON arguments;
DROP POLICY IF EXISTS "Users can create arguments" ON arguments;
DROP POLICY IF EXISTS "Argument authors can update their arguments" ON arguments;
DROP POLICY IF EXISTS "Argument authors can delete their arguments" ON arguments;
DROP POLICY IF EXISTS "Masters and authors can update arguments" ON arguments;
DROP POLICY IF EXISTS "Masters and authors can delete arguments" ON arguments;
DROP POLICY IF EXISTS "Anyone can insert arguments" ON arguments;
DROP POLICY IF EXISTS "Anyone can update arguments" ON arguments;
DROP POLICY IF EXISTS "Anyone can delete arguments" ON arguments;

CREATE POLICY "Anyone can insert arguments"
  ON arguments FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Anyone can update arguments"
  ON arguments FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can delete arguments"
  ON arguments FOR DELETE TO public USING (true);
