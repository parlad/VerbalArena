/*
  # Create Debates Platform Schema

  1. New Tables
    - `debates`
      - `id` (uuid, primary key) - Unique identifier for each debate
      - `topic` (text) - The debate topic/idea being discussed
      - `created_at` (timestamptz) - When the debate was created
      - `updated_at` (timestamptz) - Last activity timestamp
    
    - `messages`
      - `id` (uuid, primary key) - Unique identifier for each message
      - `debate_id` (uuid, foreign key) - Links to the debate
      - `author_name` (text) - Name of the person posting
      - `content` (text) - The message content
      - `side` (text) - Which side they're on ('pro' or 'con')
      - `created_at` (timestamptz) - When the message was posted

  2. Security
    - Enable RLS on both tables
    - Add policies for public read access (anyone can view debates)
    - Add policies for public write access (anyone can post messages)
    
  3. Indexes
    - Index on debate_id in messages table for faster queries
    - Index on created_at for chronological ordering
*/

-- Create debates table
CREATE TABLE IF NOT EXISTS debates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debate_id uuid NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  author_name text NOT NULL DEFAULT 'Anonymous',
  content text NOT NULL,
  side text NOT NULL CHECK (side IN ('pro', 'con')),
  created_at timestamptz DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS messages_debate_id_idx ON messages(debate_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);

-- Enable RLS
ALTER TABLE debates ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Policies for debates table
CREATE POLICY "Anyone can view debates"
  ON debates FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create debates"
  ON debates FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update debates"
  ON debates FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Policies for messages table
CREATE POLICY "Anyone can view messages"
  ON messages FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create messages"
  ON messages FOR INSERT
  WITH CHECK (true);

-- Insert a sample debate to get started
INSERT INTO debates (topic) 
VALUES ('Should artificial intelligence be regulated by governments?')
ON CONFLICT DO NOTHING;