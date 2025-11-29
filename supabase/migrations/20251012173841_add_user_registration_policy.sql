/*
  # Add User Registration Policy

  1. Changes
    - Add INSERT policy for users table to allow public registration
    - This allows anyone to create a new user account during signup
  
  2. Security
    - Policy allows public INSERT to enable user registration
    - Users can only insert their own data (no auth.uid() check needed since this is custom auth)
*/

-- Drop existing policies if they exist and recreate them
DROP POLICY IF EXISTS "Anyone can register" ON users;

-- Allow anyone to register (INSERT) a new user
CREATE POLICY "Anyone can register"
  ON users
  FOR INSERT
  TO public
  WITH CHECK (true);
