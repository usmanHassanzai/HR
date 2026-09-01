import { supabase } from '../lib/supabase';

const RATE_LIMIT_MSG = 'Too many sign-in attempts. Wait 15 minutes and try again.';
const FORGOT_LIMIT_MSG = 'Too many password reset requests. Try again later.';

export async function assertLoginAllowed(email: string): Promise<void> {
  const { data, error } = await supabase.rpc('login_is_rate_limited', {
    p_email: email.trim().toLowerCase(),
  });
  if (error) return;
  if (data === true) throw new Error(RATE_LIMIT_MSG);
}

export async function assertForgotAllowed(email: string): Promise<void> {
  const { data, error } = await supabase.rpc('forgot_is_rate_limited', {
    p_email: email.trim().toLowerCase(),
  });
  if (error) return;
  if (data === true) throw new Error(FORGOT_LIMIT_MSG);
}

export async function recordLoginAttempt(opts: {
  email: string;
  success: boolean;
  event?: 'login' | 'forgot';
  acceptedPolicy?: boolean;
}): Promise<void> {
  try {
    await supabase.rpc('record_login_attempt', {
      p_email: opts.email.trim().toLowerCase(),
      p_success: opts.success,
      p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 400) : null,
      p_event: opts.event || 'login',
      p_accepted_policy: opts.acceptedPolicy ?? null,
    });
  } catch {
    /* audit must not block sign-in after a successful auth */
  }
}
