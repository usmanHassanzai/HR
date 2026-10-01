import { Capacitor } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from './supabaseConfig';

export { isSupabaseConfigured } from './supabaseConfig';

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase environment variables are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

const isNative = Capacitor.isNativePlatform();

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder',
  {
    auth: {
      // Native opens auth emails via ai.walfia.scorr:// — we exchange the code/tokens ourselves.
      flowType: isNative ? 'pkce' : 'implicit',
      detectSessionInUrl: !isNative,
      persistSession: true,
      autoRefreshToken: true,
    },
    realtime: { params: { eventsPerSecond: 4 } },
  },
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
  },
);
