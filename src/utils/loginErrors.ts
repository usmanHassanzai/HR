import { supabase } from '../lib/supabase';

function isCredentialFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('invalid login') ||
    m.includes('invalid credentials') ||
    m.includes('invalid email or password') ||
    m.includes('email or password') ||
    m.includes('invalid_grant')
  );
}

async function emailIsRegistered(email: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('login_email_registered', { p_email: email.trim() });
  if (error) return false;
  return data === true;
}

/** Map auth failures to a clear email vs password message. */
export async function loginFailureMessage(authMessage: string, email: string): Promise<string> {
  if (!isCredentialFailure(authMessage)) {
    return authMessage;
  }

  const registered = await emailIsRegistered(email);
  if (registered) return 'Incorrect password.';
  return 'Incorrect email and password.';
}
