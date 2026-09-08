import { supabase } from '../lib/supabase';
import { Profile } from './kpiHelpers';
import { isDemoProfile } from './demoMode';

export function roleRequiresMfa(profile: Profile | null): boolean {
  if (!profile) return false;
  if (isDemoProfile(profile)) return false;
  return (
    profile.role === 'admin'
    || profile.role === 'manager'
    || profile.role === 'hr'
    || profile.role === 'employee'
    || Boolean(profile.is_platform_owner)
  );
}

export async function currentMfaLevel(): Promise<'aal1' | 'aal2' | null> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return null;
  const level = data?.currentLevel;
  if (level === 'aal2') return 'aal2';
  if (level === 'aal1') return 'aal1';
  return null;
}

export async function hasVerifiedTotpFactor(): Promise<boolean> {
  return Boolean(await getVerifiedTotpFactorId());
}

/** Remove unfinished enrollments that block re-setup with the same name. */
export async function clearUnverifiedTotpFactors(): Promise<void> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return;
  const candidates = [
    ...(data.totp || []),
    ...((data as { all?: { id: string; status: string; factor_type?: string }[] }).all || []),
  ];
  const seen = new Set<string>();
  for (const factor of candidates) {
    if (!factor?.id || seen.has(factor.id)) continue;
    seen.add(factor.id);
    const type = (factor as { factor_type?: string }).factor_type;
    if (type && type !== 'totp') continue;
    if (factor.status === 'verified') continue;
    await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
}

export async function getVerifiedTotpFactorId(): Promise<string | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return null;
  const totp = (data.totp || []).find((f) => f.status === 'verified');
  if (totp) return totp.id;
  const fromAll = ((data as { all?: { id: string; status: string; factor_type?: string }[] }).all || [])
    .find((f) => f.status === 'verified' && (!f.factor_type || f.factor_type === 'totp'));
  return fromAll?.id || null;
}

async function invokeAuthenticator(payload: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('reset_authenticator', { body: payload });
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String(data.error));
  }
  if (error) {
    const ctx = error as { context?: Response };
    try {
      const body = ctx.context ? await ctx.context.json() : null;
      if (body?.error) throw new Error(String(body.error));
    } catch (parsed) {
      if (parsed instanceof Error && parsed.message !== error.message) throw parsed;
    }
    throw new Error(error.message || 'Could not reach authenticator recovery.');
  }
  return data;
}

/** Company admin (AAL2) or platform owner: remove MFA factors so the person can enroll again. */
export async function resetAuthenticatorForUser(userId: string) {
  return invokeAuthenticator({ userId });
}

/** Signed-in person who lost their app: notify company admins. */
export async function requestAuthenticatorReset() {
  return invokeAuthenticator({ requestReset: true });
}
