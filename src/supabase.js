// Shared Supabase client. The URL and anon key are public by design:
// Row Level Security in the database decides who may write (see supabase/setup.sql).
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && key);
export const supabase = isConfigured ? createClient(url, key) : null;

// Server-side limits live in setup.sql; these mirror them for friendly client-side errors.
export const MAX_UPLOAD_MB = 50;
export const MODELS_BUCKET = 'models';
export const REELS_BUCKET = 'reels';

export function publicUrl(bucket, path) {
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
