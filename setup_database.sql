-- Database setup for Chef Compadre
-- Run this in your Supabase SQL editor

-- Create recipes table for storing user interactions
CREATE TABLE IF NOT EXISTS recipes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  user_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create user_preferences table for storing user preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  preference_key VARCHAR(255) NOT NULL,
  preference_value JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, preference_key)
);

-- Create conversation_history table for persistent conversation storage
CREATE TABLE IF NOT EXISTS conversation_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  message_type VARCHAR(50) NOT NULL, -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_recipes_user_id ON recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_created_at ON recipes(created_at);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_history_user_id ON conversation_history(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_history_created_at ON conversation_history(created_at);

-- Create storage bucket for user media
INSERT INTO storage.buckets (id, name, public) 
VALUES ('user-media', 'user-media', false)
ON CONFLICT (id) DO NOTHING;

-- Set up RLS (Row Level Security) policies
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;

-- Allow users to access their own data
CREATE POLICY "Users can access their own recipes" ON recipes
  FOR ALL USING (auth.uid()::text = user_id);

CREATE POLICY "Users can access their own preferences" ON user_preferences
  FOR ALL USING (auth.uid()::text = user_id);

CREATE POLICY "Users can access their own conversation history" ON conversation_history
  FOR ALL USING (auth.uid()::text = user_id);

-- Allow service role to access all data (for API operations)
CREATE POLICY "Service role can access all data" ON recipes
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all preferences" ON user_preferences
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all conversation history" ON conversation_history
  FOR ALL USING (auth.role() = 'service_role');
