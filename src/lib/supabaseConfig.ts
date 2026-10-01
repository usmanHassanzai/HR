/** Env-only flags — safe to import from the marketing entry (no Supabase SDK). */

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('placeholder'),
);

export { supabaseUrl, supabaseAnonKey };
