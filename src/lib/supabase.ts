import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type User = {
  user_id: string;
  username: string;
  email: string;
  password_hash: string;
  profile_picture_url?: string;
  bio?: string;
  reputation_score: number;
  account_status: 'active' | 'suspended' | 'deleted';
  role: 'user' | 'moderator' | 'master';
  topic_creation_points: number;
  created_at: string;
  updated_at: string;
};

export type Debate = {
  debate_id: string;
  creator_user_id: string;
  title: string;
  description: string;
  status: 'open' | 'closed' | 'archived';
  view_count: number;
  supporting_label: string;
  opposing_label: string;
  created_at: string;
  updated_at: string;
};

export type Argument = {
  argument_id: string;
  debate_id: string;
  user_id: string;
  parent_argument_id?: string;
  position: 'supporting' | 'opposing';
  content: string;
  upvotes: number;
  downvotes: number;
  is_edited: boolean;
  created_at: string;
  updated_at: string;
};

export type ArgumentWithUser = Argument & {
  users: Pick<User, 'username' | 'profile_picture_url' | 'reputation_score'>;
};
