/*
  # Seed/repair Tom user

  The deployed app showed "Invalid username or password" for Tom because no
  such user existed in the database. This migration ensures there's a user
  named exactly "Tom" (case-sensitive — matches the AuthModal sign-in form)
  with a known password the user can sign in with and change later.

  Pattern follows the existing `iambot` seed (20251012175611). Uses
  ON CONFLICT so re-running is safe and resets the password if Tom already
  exists with a forgotten one.

  Default credentials seeded here:
    username: Tom
    password: tom_password_123
    email:    tom@verbalarena.com
    role:     user (regular, not master)

  ⚠ Security note: passwords in this app are stored as plaintext in
  `password_hash` (this is a pre-existing design choice in the codebase;
  see AuthModal.tsx line 31 — `user.password_hash !== password`). Don't
  reuse this password anywhere else, and treat it as known-public until the
  app moves to a real hashing scheme (bcrypt / Supabase Auth).
*/

INSERT INTO users (
  username, email, password_hash, role,
  reputation_score, account_status, topic_creation_points
)
VALUES (
  'Tom', 'tom@verbalarena.com', 'tom_password_123', 'user',
  100, 'active', 100
)
ON CONFLICT (username)
DO UPDATE SET
  password_hash       = EXCLUDED.password_hash,
  account_status      = 'active',
  email               = COALESCE(NULLIF(users.email, ''), EXCLUDED.email);
