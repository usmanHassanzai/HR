import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured =
  Boolean(supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('placeholder'));

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase environment variables are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

// Avoid crashing the bundle when env vars are missing (e.g. Vercel build without secrets).
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder'
);

/**
 * Secondary client used ONLY for admin-initiated user registration.
 * It does not persist or auto-refresh its session, so calling signUp here
 * never overwrites the currently logged-in admin's session in localStorage.
 */
export const supabaseSignup = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder',
  {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storageKey: 'walfia-signup-only',
  },
});
