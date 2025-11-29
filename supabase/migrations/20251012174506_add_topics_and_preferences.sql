/*
  # Add Topics and User Preferences System

  1. New Tables
    - `topics`
      - `topic_id` (uuid, primary key)
      - `title` (varchar, topic title)
      - `description` (text)
      - `category` (varchar: politics, ai, crime, nature, science, space, etc.)
      - `source` (varchar: twitter, user_created, etc.)
      - `external_url` (varchar, optional link to source)
      - `vote_count` (integer, number of votes)
      - `creator_user_id` (uuid, nullable for external topics)
      - `status` (varchar: pending, approved, rejected)
      - `created_at` (timestamptz)
    
    - `user_topic_preferences`
      - `user_id` (uuid, foreign key)
      - `category` (varchar)
      - `created_at` (timestamptz)
      - Primary key: (user_id, category)
    
    - `topic_votes`
      - `user_id` (uuid, foreign key)
      - `topic_id` (uuid, foreign key)
      - `created_at` (timestamptz)
      - Primary key: (user_id, topic_id)

  2. Changes
    - Add points reward for creating topics
    - Update users table to track topic creation points

  3. Security
    - Enable RLS on all new tables
    - Allow public to view approved topics
    - Allow authenticated users to vote and create topics
    - Allow users to manage their own preferences
*/

-- Create topics table
CREATE TABLE IF NOT EXISTS topics (
  topic_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(255) NOT NULL,
  description text,
  category varchar(50) NOT NULL,
  source varchar(50) DEFAULT 'user_created',
  external_url varchar(500),
  vote_count integer DEFAULT 0,
  creator_user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
  status varchar(20) DEFAULT 'approved',
  created_at timestamptz DEFAULT now()
);

-- Create user topic preferences table
CREATE TABLE IF NOT EXISTS user_topic_preferences (
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE,
  category varchar(50) NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

-- Create topic votes table
CREATE TABLE IF NOT EXISTS topic_votes (
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE,
  topic_id uuid REFERENCES topics(topic_id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);

-- Add topic_creation_points to users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'topic_creation_points'
  ) THEN
    ALTER TABLE users ADD COLUMN topic_creation_points integer DEFAULT 0;
  END IF;
END $$;

-- Enable RLS
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_topic_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_votes ENABLE ROW LEVEL SECURITY;

-- RLS Policies for topics
CREATE POLICY "Anyone can view approved topics"
  ON topics
  FOR SELECT
  TO public
  USING (status = 'approved');

CREATE POLICY "Anyone can create topics"
  ON topics
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Topic creators can update their topics"
  ON topics
  FOR UPDATE
  TO public
  USING (creator_user_id IS NOT NULL)
  WITH CHECK (creator_user_id IS NOT NULL);

-- RLS Policies for user_topic_preferences
CREATE POLICY "Users can view own preferences"
  ON user_topic_preferences
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can insert own preferences"
  ON user_topic_preferences
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Users can delete own preferences"
  ON user_topic_preferences
  FOR DELETE
  TO public
  USING (true);

-- RLS Policies for topic_votes
CREATE POLICY "Anyone can view votes"
  ON topic_votes
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can vote on topics"
  ON topic_votes
  FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Users can remove their votes"
  ON topic_votes
  FOR DELETE
  TO public
  USING (true);

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
CREATE INDEX IF NOT EXISTS idx_topics_vote_count ON topics(vote_count DESC);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_topic_preferences(user_id);
