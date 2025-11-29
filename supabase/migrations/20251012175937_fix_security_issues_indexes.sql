/*
  # Fix Security Issues - Part 1: Add Missing Foreign Key Indexes

  1. Foreign Key Indexes
    - Add index on argumentflags.moderator_user_id
    - Add index on argumentflags.reporter_user_id
    - Add index on debatetags.tag_id
    - Add index on topic_votes.topic_id
    - Add index on topics.creator_user_id

  2. Purpose
    - Improve query performance for foreign key lookups
    - Optimize JOIN operations
    - Prevent suboptimal query execution plans
*/

-- Add missing foreign key indexes
CREATE INDEX IF NOT EXISTS idx_argumentflags_moderator_user 
  ON argumentflags(moderator_user_id);

CREATE INDEX IF NOT EXISTS idx_argumentflags_reporter_user 
  ON argumentflags(reporter_user_id);

CREATE INDEX IF NOT EXISTS idx_debatetags_tag 
  ON debatetags(tag_id);

CREATE INDEX IF NOT EXISTS idx_topic_votes_topic 
  ON topic_votes(topic_id);

CREATE INDEX IF NOT EXISTS idx_topics_creator_user 
  ON topics(creator_user_id);
