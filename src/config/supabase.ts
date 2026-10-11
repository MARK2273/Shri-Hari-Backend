import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

if (!isSupabaseConfigured) {
  console.warn('\x1b[33m%s\x1b[0m', '⚠️  [CONFIG] SUPABASE_URL or SUPABASE_ANON_KEY is not configured in .env yet.');
}

// Client for regular operations (prefers service role key if available for backend operations, fallback to anon key)
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseKey)
  : (null as any);

// Privileged admin client for atomic transactions and background sync
export const supabaseAdmin = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseServiceKey)
  : (null as any);
