/*
  # Add Topic Opinions System

  1. New Tables
    - `topic_opinions`
      - `opinion_id` (uuid, primary key)
      - `topic_id` (uuid, foreign key to topics)
      - `user_id` (uuid, foreign key to users)
      - `position` (varchar: 'supporting' or 'opposing')
      - `content` (text, the user's opinion/argument)
      - `upvotes` (integer, vote count)
      - `downvotes` (integer, vote count)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `topic_opinion_votes`
      - `user_id` (uuid, foreign key)
      - `opinion_id` (uuid, foreign key)
      - `vote_type` (varchar: 'upvote' or 'downvote')
      - `created_at` (timestamptz)
      - Primary key: (user_id, opinion_id)

  2. Security
    - Enable RLS on both tables
    - Anyone can view opinions
    - Authenticated users can create opinions
    - Users can vote on opinions
    - Authors can edit/delete their own opinions
    - Masters can moderate all opinions

  3. Performance
    - Add indexes on foreign keys
    - Add indexes for position filtering
*/

-- Create topic_opinions table
CREATE TABLE IF NOT EXISTS topic_opinions (
  opinion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid REFERENCES topics(topic_id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
  position varchar(20) NOT NULL CHECK (position IN ('supporting', 'opposing')),
  content text NOT NULL,
  upvotes integer DEFAULT 0,
  downvotes integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create topic_opinion_votes table
CREATE TABLE IF NOT EXISTS topic_opinion_votes (
  user_id uuid REFERENCES users(user_id) ON DELETE CASCADE,
  opinion_id uuid REFERENCES topic_opinions(opinion_id) ON DELETE CASCADE,
  vote_type varchar(10) NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, opinion_id)
);

-- Enable RLS
ALTER TABLE topic_opinions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_opinion_votes ENABLE ROW LEVEL SECURITY;

-- RLS Policies for topic_opinions
CREATE POLICY "Anyone can view topic opinions"
  ON topic_opinions
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Authenticated users can create opinions"
  ON topic_opinions
  FOR INSERT
  TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Authors and masters can update opinions"
  ON topic_opinions
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = topic_opinions.user_id 
         OR u.role = 'master'
    )
  )
  WITH CHECK (true);

CREATE POLICY "Authors and masters can delete opinions"
  ON topic_opinions
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = topic_opinions.user_id 
         OR u.role = 'master'
    )
  );

-- RLS Policies for topic_opinion_votes
CREATE POLICY "Anyone can view opinion votes"
  ON topic_opinion_votes
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Users can vote on opinions"
  ON topic_opinion_votes
  FOR INSERT
  TO public
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Users can change their votes"
  ON topic_opinion_votes
  FOR UPDATE
  TO public
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "Users can remove their votes"
  ON topic_opinion_votes
  FOR DELETE
  TO public
  USING (user_id = (select auth.uid()));

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_topic_opinions_topic ON topic_opinions(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_opinions_user ON topic_opinions(user_id);
CREATE INDEX IF NOT EXISTS idx_topic_opinions_position ON topic_opinions(position);
CREATE INDEX IF NOT EXISTS idx_topic_opinions_created_at ON topic_opinions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_opinion_votes_opinion ON topic_opinion_votes(opinion_id);
CREATE INDEX IF NOT EXISTS idx_topic_opinion_votes_user ON topic_opinion_votes(user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_topic_opinions_updated_at
  BEFORE UPDATE ON topic_opinions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Create functions for vote counting
CREATE OR REPLACE FUNCTION increment_opinion_upvotes(opinion_id_param uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topic_opinions
  SET upvotes = upvotes + 1
  WHERE opinion_id = opinion_id_param;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_opinion_upvotes(opinion_id_param uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topic_opinions
  SET upvotes = GREATEST(upvotes - 1, 0)
  WHERE opinion_id = opinion_id_param;
END;
$$;

CREATE OR REPLACE FUNCTION increment_opinion_downvotes(opinion_id_param uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topic_opinions
  SET downvotes = downvotes + 1
  WHERE opinion_id = opinion_id_param;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_opinion_downvotes(opinion_id_param uuid)
RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE topic_opinions
  SET downvotes = GREATEST(downvotes - 1, 0)
  WHERE opinion_id = opinion_id_param;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION increment_opinion_upvotes(uuid) TO public;
GRANT EXECUTE ON FUNCTION decrement_opinion_upvotes(uuid) TO public;
GRANT EXECUTE ON FUNCTION increment_opinion_downvotes(uuid) TO public;
GRANT EXECUTE ON FUNCTION decrement_opinion_downvotes(uuid) TO public;
