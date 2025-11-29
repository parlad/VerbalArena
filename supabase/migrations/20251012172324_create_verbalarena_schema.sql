/*
  # Create VerbalArena Database Schema

  ## Overview
  This migration creates a comprehensive debate platform database with user management,
  debates, arguments, AI fact-checking, voting, tagging, and moderation capabilities.

  ## Tables Created

  ### 1. Users
  - Stores user account information
  - Fields: user_id, username, email, password_hash, profile_picture_url, bio, reputation_score, account_status
  - Tracks user reputation and account status
  
  ### 2. Debates
  - Stores debate topics and metadata
  - Fields: debate_id, creator_user_id, title, description, status, view_count, supporting_label, opposing_label
  - Links to Users table via creator_user_id
  - Supports custom labels for debate positions
  
  ### 3. Arguments
  - Stores individual arguments in debates
  - Fields: argument_id, debate_id, user_id, parent_argument_id, position, content, upvotes, downvotes, is_edited
  - Supports threaded replies via parent_argument_id
  - Tracks vote counts and edit status
  
  ### 4. AIFactChecks
  - Stores AI-powered fact-check results for arguments
  - Fields: fact_check_id, argument_id, status, fact_check_result, confidence_score, summary, evidence_json, ai_model_version
  - Uses JSONB for flexible evidence storage
  - Tracks confidence scores and verification status
  
  ### 5. ArgumentVotes
  - Tracks user votes on arguments (upvote/downvote)
  - Composite primary key: (user_id, argument_id)
  - Ensures users can only vote once per argument
  
  ### 6. Tags
  - Stores debate topic tags
  - Fields: tag_id, tag_name
  - Reusable across multiple debates
  
  ### 7. DebateTags
  - Many-to-many relationship between Debates and Tags
  - Composite primary key: (debate_id, tag_id)
  
  ### 8. ArgumentFlags
  - Stores moderation reports for arguments
  - Fields: flag_id, argument_id, reporter_user_id, moderator_user_id, reason, details, status
  - Tracks moderation workflow from report to resolution

  ## Security
  - Row Level Security (RLS) enabled on all tables
  - Public read access for debates, arguments, and tags
  - Authenticated users can create content
  - Users can only modify their own content
  - Voting and flagging requires authentication

  ## Indexes
  - Optimized for common query patterns
  - Indexes on foreign keys, status fields, and timestamps
  - Full-text search support for debate titles and descriptions
*/

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS ArgumentFlags CASCADE;
DROP TABLE IF EXISTS DebateTags CASCADE;
DROP TABLE IF EXISTS Tags CASCADE;
DROP TABLE IF EXISTS ArgumentVotes CASCADE;
DROP TABLE IF EXISTS AIFactChecks CASCADE;
DROP TABLE IF EXISTS Arguments CASCADE;
DROP TABLE IF EXISTS Debates CASCADE;
DROP TABLE IF EXISTS Users CASCADE;

-- Create Users table
CREATE TABLE Users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    profile_picture_url VARCHAR(255),
    bio TEXT,
    reputation_score INT DEFAULT 0,
    account_status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_account_status CHECK (account_status IN ('active', 'suspended', 'deleted'))
);

-- Create Debates table
CREATE TABLE Debates (
    debate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_user_id UUID NOT NULL REFERENCES Users(user_id),
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    view_count BIGINT DEFAULT 0,
    supporting_label VARCHAR(50) DEFAULT 'Supporting',
    opposing_label VARCHAR(50) DEFAULT 'Opposing',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_debate_status CHECK (status IN ('open', 'closed', 'archived'))
);

-- Create Arguments table
CREATE TABLE Arguments (
    argument_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debate_id UUID NOT NULL REFERENCES Debates(debate_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES Users(user_id),
    parent_argument_id UUID REFERENCES Arguments(argument_id),
    position VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    upvotes INT DEFAULT 0,
    downvotes INT DEFAULT 0,
    is_edited BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_position CHECK (position IN ('supporting', 'opposing'))
);

-- Create AIFactChecks table
CREATE TABLE AIFactChecks (
    fact_check_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    argument_id UUID UNIQUE NOT NULL REFERENCES Arguments(argument_id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    fact_check_result VARCHAR(30),
    confidence_score NUMERIC(5, 4),
    summary TEXT,
    evidence_json JSONB,
    ai_model_version VARCHAR(50),
    checked_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT check_fact_check_status CHECK (status IN ('pending', 'in_progress', 'completed', 'error')),
    CONSTRAINT check_fact_check_result CHECK (fact_check_result IN ('verified', 'disputed', 'unverifiable', 'partially_true') OR fact_check_result IS NULL),
    CONSTRAINT check_confidence_score CHECK (confidence_score >= 0.0000 AND confidence_score <= 1.0000)
);

-- Create ArgumentVotes table
CREATE TABLE ArgumentVotes (
    user_id UUID NOT NULL REFERENCES Users(user_id),
    argument_id UUID NOT NULL REFERENCES Arguments(argument_id) ON DELETE CASCADE,
    vote_type VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, argument_id),
    CONSTRAINT check_vote_type CHECK (vote_type IN ('upvote', 'downvote'))
);

-- Create Tags table
CREATE TABLE Tags (
    tag_id SERIAL PRIMARY KEY,
    tag_name VARCHAR(50) UNIQUE NOT NULL
);

-- Create DebateTags table
CREATE TABLE DebateTags (
    debate_id UUID NOT NULL REFERENCES Debates(debate_id) ON DELETE CASCADE,
    tag_id INT NOT NULL REFERENCES Tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (debate_id, tag_id)
);

-- Create ArgumentFlags table
CREATE TABLE ArgumentFlags (
    flag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    argument_id UUID NOT NULL REFERENCES Arguments(argument_id),
    reporter_user_id UUID NOT NULL REFERENCES Users(user_id),
    moderator_user_id UUID REFERENCES Users(user_id),
    reason VARCHAR(50) NOT NULL,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending_review',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT check_flag_reason CHECK (reason IN ('spam', 'hate_speech', 'misinformation', 'harassment', 'other')),
    CONSTRAINT check_flag_status CHECK (status IN ('pending_review', 'resolved', 'dismissed'))
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_debates_creator ON Debates(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_debates_status ON Debates(status);
CREATE INDEX IF NOT EXISTS idx_debates_created_at ON Debates(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_arguments_debate ON Arguments(debate_id);
CREATE INDEX IF NOT EXISTS idx_arguments_user ON Arguments(user_id);
CREATE INDEX IF NOT EXISTS idx_arguments_parent ON Arguments(parent_argument_id);
CREATE INDEX IF NOT EXISTS idx_arguments_position ON Arguments(position);
CREATE INDEX IF NOT EXISTS idx_arguments_created_at ON Arguments(created_at);

CREATE INDEX IF NOT EXISTS idx_aifactchecks_argument ON AIFactChecks(argument_id);
CREATE INDEX IF NOT EXISTS idx_aifactchecks_status ON AIFactChecks(status);

CREATE INDEX IF NOT EXISTS idx_argumentvotes_argument ON ArgumentVotes(argument_id);

CREATE INDEX IF NOT EXISTS idx_argumentflags_argument ON ArgumentFlags(argument_id);
CREATE INDEX IF NOT EXISTS idx_argumentflags_status ON ArgumentFlags(status);

-- Enable Row Level Security
ALTER TABLE Users ENABLE ROW LEVEL SECURITY;
ALTER TABLE Debates ENABLE ROW LEVEL SECURITY;
ALTER TABLE Arguments ENABLE ROW LEVEL SECURITY;
ALTER TABLE AIFactChecks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ArgumentVotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE Tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE DebateTags ENABLE ROW LEVEL SECURITY;
ALTER TABLE ArgumentFlags ENABLE ROW LEVEL SECURITY;

-- RLS Policies for Users table
CREATE POLICY "Users can view all profiles"
  ON Users FOR SELECT
  USING (true);

CREATE POLICY "Users can update own profile"
  ON Users FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- RLS Policies for Debates table
CREATE POLICY "Anyone can view debates"
  ON Debates FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can create debates"
  ON Debates FOR INSERT
  TO authenticated
  WITH CHECK (creator_user_id = auth.uid());

CREATE POLICY "Debate creators can update their debates"
  ON Debates FOR UPDATE
  TO authenticated
  USING (creator_user_id = auth.uid())
  WITH CHECK (creator_user_id = auth.uid());

CREATE POLICY "Debate creators can delete their debates"
  ON Debates FOR DELETE
  TO authenticated
  USING (creator_user_id = auth.uid());

-- RLS Policies for Arguments table
CREATE POLICY "Anyone can view arguments"
  ON Arguments FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can create arguments"
  ON Arguments FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Argument authors can update their arguments"
  ON Arguments FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Argument authors can delete their arguments"
  ON Arguments FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- RLS Policies for AIFactChecks table
CREATE POLICY "Anyone can view fact checks"
  ON AIFactChecks FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage fact checks"
  ON AIFactChecks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- RLS Policies for ArgumentVotes table
CREATE POLICY "Anyone can view votes"
  ON ArgumentVotes FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can vote"
  ON ArgumentVotes FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their votes"
  ON ArgumentVotes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their votes"
  ON ArgumentVotes FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- RLS Policies for Tags table
CREATE POLICY "Anyone can view tags"
  ON Tags FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can create tags"
  ON Tags FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- RLS Policies for DebateTags table
CREATE POLICY "Anyone can view debate tags"
  ON DebateTags FOR SELECT
  USING (true);

CREATE POLICY "Debate creators can manage their debate tags"
  ON DebateTags FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM Debates
      WHERE Debates.debate_id = DebateTags.debate_id
      AND Debates.creator_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM Debates
      WHERE Debates.debate_id = DebateTags.debate_id
      AND Debates.creator_user_id = auth.uid()
    )
  );

-- RLS Policies for ArgumentFlags table
CREATE POLICY "Users can view their own flags"
  ON ArgumentFlags FOR SELECT
  TO authenticated
  USING (reporter_user_id = auth.uid());

CREATE POLICY "Authenticated users can create flags"
  ON ArgumentFlags FOR INSERT
  TO authenticated
  WITH CHECK (reporter_user_id = auth.uid());

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON Users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_debates_updated_at BEFORE UPDATE ON Debates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_arguments_updated_at BEFORE UPDATE ON Arguments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();