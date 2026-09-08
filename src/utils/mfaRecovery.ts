import { supabase } from '../lib/supabase';

export type MfaRecoveryStatus = {
  remaining_codes: number;
  codes_generated: boolean;
  login_email?: string | null;
  recovery_email_verified: boolean;
  recovery_email: string | null;
  recovery_email_pending: string | null;
  low_codes: boolean;
  needs_codes: boolean;
  has_grant?: boolean;
};

async function invokeMfaRecovery<T>(payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('mfa_recovery', { body: payload });
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }
  if (error) {
    const ctx = error as { context?: Response };
    try {
      const body = ctx.context ? await ctx.context.json() : null;
      if (body?.error) throw new Error(String(body.error));
    } catch (parsed) {
      if (parsed instanceof Error && parsed.message !== error.message) throw parsed;
    }
    throw new Error(error.message || 'Could not reach MFA recovery.');
  }
  return data as T;
}

export async function fetchMfaRecoveryStatus(): Promise<MfaRecoveryStatus | null> {
  try {
    const { data, error } = await supabase.rpc('mfa_recovery_status');
    if (!error && data) return data as MfaRecoveryStatus;
  } catch {
    /* fall through */
  }
  try {
    return await invokeMfaRecovery<MfaRecoveryStatus>({ action: 'status' });
  } catch {
    return null;
  }
}

export async function hasMfaSessionGrant(): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_mfa_session_grant', { p_session_id: null });
  if (error) return false;
  return data === true;
}

export async function generateBackupCodes(password: string, totpCode?: string): Promise<string[]> {
  const res = await invokeMfaRecovery<{ codes?: string[] }>({
    action: 'generate_codes',
    password: password || undefined,
    totpCode: totpCode || undefined,
  });
  if (!res.codes?.length) throw new Error('No codes returned.');
  return res.codes;
}

export async function verifyBackupCode(code: string): Promise<{ remaining_codes: number }> {
  return invokeMfaRecovery({ action: 'verify_backup_code', code });
}

export async function setRecoveryEmail(email: string, password: string): Promise<void> {
  await invokeMfaRecovery({ action: 'set_recovery_email', email, password });
}

export async function requestEmailMfaRecovery(password: string): Promise<void> {
  await invokeMfaRecovery({ action: 'request_email_recovery', password });
}

export async function requestLoginEmailOtp(password: string): Promise<{
  emailed_to?: string | null;
  expires_minutes?: number;
}> {
  return invokeMfaRecovery({ action: 'request_login_email_otp', password });
}

export async function verifyLoginEmailOtp(password: string, code: string): Promise<{ must_enroll?: boolean }> {
  return invokeMfaRecovery({ action: 'verify_login_email_otp', password, code });
}

export async function confirmRecoveryEmailToken(token: string): Promise<void> {
  await invokeMfaRecovery({ action: 'confirm_recovery_email', token });
}

export async function completeEmailMfaRecovery(token: string): Promise<string> {
  const res = await invokeMfaRecovery<{ message?: string }>({ action: 'complete_email_recovery', token });
  return res.message || 'Authenticator cleared. Sign in and set up a new authenticator.';
}

export function downloadBackupCodesTxt(codes: string[], fullName?: string) {
  const lines = [
    'Scorr — 2FA backup codes',
    fullName ? `Account: ${fullName}` : '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each code works once. Store these somewhere safe.',
    'You will not be able to view them again.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, '0')}. ${c}`),
    '',
  ].filter(Boolean);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scorr-backup-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}

export async function copyBackupCodes(codes: string[]): Promise<void> {
  await navigator.clipboard.writeText(codes.join('\n'));
}
