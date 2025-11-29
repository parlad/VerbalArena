/*
  # Add Role Column and Create Master User

  1. New Columns
    - `role` (varchar) - User role: 'user', 'moderator', 'master'
    - Default: 'user'

  2. Master User Creation
    - Create user 'iambot' with master role
    - Grant full permissions to manage all content

  3. Updated Security Policies
    - Master users can edit/delete any topic
    - Master users can edit/delete any debate
    - Master users can moderate any argument
    - Master users can update user roles

  4. Master Permissions Include
    - Edit/delete all topics
    - Edit/delete all debates
    - Edit/delete all arguments
    - Manage user accounts
    - Change user roles
*/

-- Add role column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS role varchar(20) DEFAULT 'user';

-- Add check constraint for valid roles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check 
    CHECK (role IN ('user', 'moderator', 'master'));
  END IF;
END $$;

-- Update existing users to have 'user' role
UPDATE users SET role = 'user' WHERE role IS NULL;

-- Drop and recreate policies for topics
DROP POLICY IF EXISTS "Topic creators can update their topics" ON topics;
DROP POLICY IF EXISTS "Topic creators can delete their topics" ON topics;

CREATE POLICY "Masters and creators can update topics"
  ON topics
  FOR UPDATE
  TO public
  USING (
    creator_user_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = creator_user_id 
         OR u.role = 'master'
    )
  )
  WITH CHECK (true);

CREATE POLICY "Masters and creators can delete topics"
  ON topics
  FOR DELETE
  TO public
  USING (
    creator_user_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = creator_user_id 
         OR u.role = 'master'
    )
  );

-- Drop and recreate policies for debates
DROP POLICY IF EXISTS "Debate creators can update their debates" ON debates;
DROP POLICY IF EXISTS "Debate creators can delete their debates" ON debates;

CREATE POLICY "Masters and creators can update debates"
  ON debates
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = debates.creator_user_id 
         OR u.role = 'master'
    )
  )
  WITH CHECK (true);

CREATE POLICY "Masters and creators can delete debates"
  ON debates
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = debates.creator_user_id 
         OR u.role = 'master'
    )
  );

-- Drop and recreate policies for arguments
DROP POLICY IF EXISTS "Argument authors can update their arguments" ON arguments;
DROP POLICY IF EXISTS "Argument authors can delete their arguments" ON arguments;

CREATE POLICY "Masters and authors can update arguments"
  ON arguments
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = arguments.user_id 
         OR u.role = 'master'
    )
  )
  WITH CHECK (true);

CREATE POLICY "Masters and authors can delete arguments"
  ON arguments
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = arguments.user_id 
         OR u.role = 'master'
    )
  );

-- Create index for role lookups
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Create master user 'iambot' with full permissions
INSERT INTO users (username, email, password_hash, role, reputation_score, account_status, topic_creation_points)
VALUES ('iambot', 'iambot@verbalarena.com', 'master_hash', 'master', 10000, 'active', 10000)
ON CONFLICT (username) 
DO UPDATE SET 
  role = 'master',
  reputation_score = GREATEST(users.reputation_score, 10000),
  topic_creation_points = GREATEST(users.topic_creation_points, 10000),
  account_status = 'active';
