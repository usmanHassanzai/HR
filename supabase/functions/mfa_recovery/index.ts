import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ALLOWED_ORIGINS = new Set([
  'https://scorr.walfia.ai',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'https://localhost',
]);

const APP_URL = Deno.env.get('SCORR_APP_URL') || 'https://scorr.walfia.ai';
const PEPPER = Deno.env.get('MFA_CODE_PEPPER') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'scorr-mfa-pepper';
const CODE_COUNT = 10;
const CODE_TTL_SESSION_HOURS = 12;
const EMAIL_TOKEN_MINUTES = 20;
const RECOVERY_MAX_PER_HOUR = 3;

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://scorr.walfia.ai';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-forwarded-for, x-real-ip',
    Vary: 'Origin',
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || ''
  );
}

function tokenAal(jwt: string): string {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1] || ''));
    return String(payload.aal || 'aal1');
  } catch {
    return 'aal1';
  }
}

function sessionIdFromJwt(jwt: string): string | null {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1] || ''));
    return payload.session_id ? String(payload.session_id) : null;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeBackupCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function generateBackupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateLoginOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, '0');
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.replace(/(^.).*(@.*$)/, '$1***$2');
}

async function hashCode(userId: string, code: string): Promise<string> {
  return sha256Hex(`${PEPPER}:${userId}:${normalizeBackupCode(code)}`);
}

async function hashToken(token: string): Promise<string> {
  return sha256Hex(`${PEPPER}:token:${token}`);
}

async function hashLoginOtp(userId: string, otp: string): Promise<string> {
  return sha256Hex(`${PEPPER}:login_otp:${userId}:${otp.trim()}`);
}

async function verifyAccountPassword(
  url: string,
  anon: string,
  email: string,
  password: string,
): Promise<boolean> {
  const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await check.auth.signInWithPassword({ email, password });
  return !error;
}

async function sendEmail(to: string, subject: string, body: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';
  if (!apiKey) {
    console.log(`[mfa_recovery] email skipped\nTo: ${to}\n${subject}\n${body}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>${body.replace(/\n/g, '<br>')}</p><hr><small>Scorr — scorr.walfia.ai</small></div>`,
    }),
  });
  if (!res.ok) console.error('[mfa_recovery] Resend', await res.text());
}

async function audit(
  admin: ReturnType<typeof createClient>,
  userId: string,
  method: string,
  success: boolean,
  ip: string,
  detail?: string,
) {
  await admin.from('recovery_audit_log').insert({
    user_id: userId,
    method,
    success,
    ip_address: ip || null,
    detail: detail || null,
  });
}

async function createSessionGrant(
  admin: ReturnType<typeof createClient>,
  userId: string,
  sessionId: string | null,
  method: string,
) {
  const sid = sessionId || `fallback-${userId}`;
  const expires = new Date(Date.now() + CODE_TTL_SESSION_HOURS * 3600 * 1000).toISOString();
  await admin.from('mfa_session_grants').upsert({
    user_id: userId,
    session_id: sid,
    method,
    expires_at: expires,
  }, { onConflict: 'user_id,session_id' });
}

async function deleteMfaFactors(admin: ReturnType<typeof createClient>, userId: string) {
  const listed = await admin.auth.admin.mfa.listFactors({ userId });
  if (listed.error) throw new Error(listed.error.message);
  const raw = listed.data as { factors?: { id: string }[]; totp?: { id: string }[] } | null;
  const factors = raw?.factors?.length ? raw.factors : (raw?.totp || []);
  for (const factor of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (error) throw new Error(error.message);
  }
  return factors.length;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!url || !serviceKey) return json(req, { error: 'Server misconfigured.' }, 500);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const ip = clientIp(req);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Public token completions (email links) — no user JWT required for confirm/complete with token.
    if (action === 'confirm_recovery_email' || action === 'complete_email_recovery') {
      const token = String(body.token || '').trim();
      if (!token) return json(req, { error: 'Missing recovery token.' }, 400);
      const tokenHash = await hashToken(token);
      const purpose = action === 'confirm_recovery_email' ? 'email_verify' : 'mfa_reset';
      const { data: row } = await admin
        .from('mfa_recovery_tokens')
        .select('id, user_id, expires_at, used_at')
        .eq('token_hash', tokenHash)
        .eq('purpose', purpose)
        .maybeSingle();
      if (!row || row.used_at) {
        return json(req, { error: 'This link is invalid or already used.' }, 400);
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json(req, { error: 'This link has expired. Request a new one.' }, 400);
      }

      if (action === 'confirm_recovery_email') {
        const { data: user } = await admin
          .from('users')
          .select('id, recovery_email_pending')
          .eq('id', row.user_id)
          .maybeSingle();
        if (!user?.recovery_email_pending) {
          return json(req, { error: 'No pending recovery email to confirm.' }, 400);
        }
        await admin.from('users').update({
          recovery_email: user.recovery_email_pending,
          recovery_email_verified: true,
          recovery_email_pending: null,
        }).eq('id', user.id);
        await admin.from('mfa_recovery_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id);
        await audit(admin, user.id, 'set_recovery_email', true, ip, 'Recovery email verified');
        return json(req, { ok: true, verified: true });
      }

      // complete_email_recovery — wipe MFA so they can re-enroll
      const removed = await deleteMfaFactors(admin, row.user_id);
      await admin.from('mfa_session_grants').delete().eq('user_id', row.user_id);
      await admin.from('mfa_recovery_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id);
      await admin.from('mfa_reset_requests').update({
        resolved_at: new Date().toISOString(),
      }).eq('user_id', row.user_id).is('resolved_at', null);
      await audit(admin, row.user_id, 'recovery_email', true, ip, `MFA factors removed: ${removed}`);
      return json(req, {
        ok: true,
        reset: true,
        message: 'Authenticator cleared. Sign in with your password and set up a new authenticator app.',
      });
    }

    if (!jwt) return json(req, { error: 'Not authenticated.' }, 401);

    const { data: authData, error: authErr } = await admin.auth.getUser(jwt);
    const callerId = authData?.user?.id;
    if (authErr || !callerId) return json(req, { error: 'Not authenticated.' }, 401);

    const { data: caller } = await admin
      .from('users')
      .select('id, email, full_name, role, company_id, recovery_email, recovery_email_verified, recovery_email_pending, backup_codes_generated_at')
      .eq('id', callerId)
      .maybeSingle();
    if (!caller) return json(req, { error: 'Not authenticated.' }, 401);

    const aal = tokenAal(jwt);
    const sid = sessionIdFromJwt(jwt);

    if (action === 'status') {
      const { count } = await admin
        .from('backup_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', callerId)
        .eq('used', false);
      const remaining = count || 0;
      return json(req, {
        remaining_codes: remaining,
        codes_generated: Boolean(caller.backup_codes_generated_at),
        login_email: maskEmail(caller.email),
        recovery_email_verified: Boolean(caller.recovery_email_verified && caller.recovery_email),
        recovery_email: caller.recovery_email_verified && caller.recovery_email
          ? maskEmail(caller.recovery_email)
          : null,
        recovery_email_pending: caller.recovery_email_pending
          ? maskEmail(caller.recovery_email_pending)
          : null,
        low_codes: remaining > 0 && remaining <= 3,
        needs_codes: remaining === 0,
        has_grant: Boolean(sid) && (await admin.from('mfa_session_grants')
          .select('id')
          .eq('user_id', callerId)
          .eq('session_id', sid)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle()).data != null,
      });
    }

    if (action === 'generate_codes') {
      const password = String(body.password || '');
      const totpCode = String(body.totpCode || '').replace(/\s/g, '');
      if (aal !== 'aal2' && !totpCode) {
        return json(req, { error: 'Verify your authenticator before regenerating backup codes.' }, 403);
      }
      // Password required when not yet AAL2. After a fresh TOTP verify (AAL2),
      // password is optional so first-time enroll can always show backup codes.
      if (aal !== 'aal2') {
        if (!password) {
          return json(req, { error: 'Enter your password to regenerate backup codes.' }, 400);
        }
      }
      if (password) {
        if (!anon) return json(req, { error: 'Server misconfigured.' }, 500);
        const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error: pwErr } = await check.auth.signInWithPassword({
          email: caller.email,
          password,
        });
        if (pwErr) {
          await audit(admin, callerId, 'generate_codes', false, ip, 'Bad password');
          return json(req, { error: 'Password incorrect.' }, 403);
        }
      }

      // Invalidate previous codes
      await admin.from('backup_codes').delete().eq('user_id', callerId);

      const plaintext: string[] = [];
      const rows: { user_id: string; code_hash: string }[] = [];
      for (let i = 0; i < CODE_COUNT; i++) {
        const code = generateBackupCode();
        plaintext.push(code);
        rows.push({ user_id: callerId, code_hash: await hashCode(callerId, code) });
      }
      const { error: insErr } = await admin.from('backup_codes').insert(rows);
      if (insErr) {
        console.error('[mfa_recovery] insert codes', insErr.message);
        return json(req, { error: 'Could not save backup codes.' }, 500);
      }
      await admin.from('users').update({
        backup_codes_generated_at: new Date().toISOString(),
      }).eq('id', callerId);
      await audit(admin, callerId, 'generate_codes', true, ip, `Generated ${CODE_COUNT} codes`);
      return json(req, { ok: true, codes: plaintext });
    }

    if (action === 'verify_backup_code') {
      const raw = String(body.code || '');
      const normalized = normalizeBackupCode(raw);
      if (normalized.length < 8) {
        return json(req, { error: 'Enter a valid backup code.' }, 400);
      }
      const { data: unused } = await admin
        .from('backup_codes')
        .select('id, code_hash')
        .eq('user_id', callerId)
        .eq('used', false);
      let matched: { id: string } | null = null;
      for (const row of unused || []) {
        const h = await hashCode(callerId, normalized);
        if (h === row.code_hash) {
          matched = row;
          break;
        }
      }
      if (!matched) {
        await audit(admin, callerId, 'backup_code', false, ip, 'Invalid or used code');
        return json(req, { error: 'That backup code is invalid or already used.' }, 400);
      }
      await admin.from('backup_codes').update({
        used: true,
        used_at: new Date().toISOString(),
      }).eq('id', matched.id);
      await createSessionGrant(admin, callerId, sid, 'backup_code');
      await audit(admin, callerId, 'backup_code', true, ip, 'Login with backup code');
      const { count } = await admin
        .from('backup_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', callerId)
        .eq('used', false);
      return json(req, { ok: true, remaining_codes: count || 0 });
    }

    if (action === 'set_recovery_email') {
      if (aal !== 'aal2') {
        return json(req, { error: 'Verify your authenticator before changing recovery email.' }, 403);
      }
      const password = String(body.password || '');
      const email = String(body.email || '').trim().toLowerCase();
      if (!password) return json(req, { error: 'Enter your password.' }, 400);
      if (!email.includes('@') || email === String(caller.email || '').toLowerCase()) {
        return json(req, { error: 'Use a different email address than your login email.' }, 400);
      }
      if (!anon) return json(req, { error: 'Server misconfigured.' }, 500);
      const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: pwErr } = await check.auth.signInWithPassword({ email: caller.email, password });
      if (pwErr) {
        await audit(admin, callerId, 'set_recovery_email', false, ip, 'Bad password');
        return json(req, { error: 'Password incorrect.' }, 403);
      }

      const token = generateToken();
      const tokenHash = await hashToken(token);
      const expires = new Date(Date.now() + EMAIL_TOKEN_MINUTES * 60 * 1000).toISOString();
      await admin.from('mfa_recovery_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', callerId)
        .eq('purpose', 'email_verify')
        .is('used_at', null);
      await admin.from('mfa_recovery_tokens').insert({
        user_id: callerId,
        purpose: 'email_verify',
        token_hash: tokenHash,
        expires_at: expires,
      });
      await admin.from('users').update({
        recovery_email_pending: email,
        recovery_email_verified: false,
      }).eq('id', callerId);

      const link = `${APP_URL}/?mfa_action=confirm_email&token=${token}`;
      await sendEmail(
        email,
        'Confirm your Scorr recovery email',
        [
          `Dear ${caller.full_name || 'there'},`,
          '',
          'Confirm this address as your Scorr 2FA recovery email.',
          '',
          `Open this link within ${EMAIL_TOKEN_MINUTES} minutes:`,
          link,
          '',
          'If you did not request this, ignore this email.',
          '',
          'Kind regards,',
          'The Scorr Team',
        ].join('\n'),
      );
      await audit(admin, callerId, 'set_recovery_email', true, ip, `Pending verify ${email}`);
      return json(req, { ok: true, pending: true });
    }

    if (action === 'request_email_recovery') {
      const password = String(body.password || '');
      if (!password) return json(req, { error: 'Enter your account password to send a recovery email.' }, 400);
      if (!caller.recovery_email_verified || !caller.recovery_email) {
        return json(req, { error: 'No verified recovery email on this account. Ask an admin to reset your authenticator, or set a recovery email while signed in.' }, 400);
      }

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recent } = await admin
        .from('recovery_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', callerId)
        .eq('method', 'recovery_email')
        .gte('created_at', since);
      if ((recent || 0) >= RECOVERY_MAX_PER_HOUR) {
        return json(req, { error: 'Too many recovery requests. Try again in an hour.' }, 429);
      }

      if (!anon) return json(req, { error: 'Server misconfigured.' }, 500);
      const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: pwErr } = await check.auth.signInWithPassword({ email: caller.email, password });
      if (pwErr) {
        await audit(admin, callerId, 'recovery_email', false, ip, 'Bad password on request');
        return json(req, { error: 'Password incorrect.' }, 403);
      }

      const token = generateToken();
      const tokenHash = await hashToken(token);
      const expires = new Date(Date.now() + EMAIL_TOKEN_MINUTES * 60 * 1000).toISOString();
      await admin.from('mfa_recovery_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', callerId)
        .eq('purpose', 'mfa_reset')
        .is('used_at', null);
      await admin.from('mfa_recovery_tokens').insert({
        user_id: callerId,
        purpose: 'mfa_reset',
        token_hash: tokenHash,
        expires_at: expires,
      });

      const link = `${APP_URL}/?mfa_action=reset_2fa&token=${token}`;
      await sendEmail(
        caller.recovery_email,
        'Reset your Scorr authenticator',
        [
          `Dear ${caller.full_name || 'there'},`,
          '',
          'You asked to reset two-factor authentication on Scorr because you cannot use your authenticator or backup codes.',
          '',
          `Open this link within ${EMAIL_TOKEN_MINUTES} minutes to clear your authenticator:`,
          link,
          '',
          'After that, sign in with your password and set up a new authenticator app.',
          '',
          'If you did not request this, contact your administrator immediately.',
          '',
          'Kind regards,',
          'The Scorr Team',
        ].join('\n'),
      );
      await audit(admin, callerId, 'recovery_email', true, ip, 'Reset link sent');
      return json(req, { ok: true, sent: true });
    }

    // Last-resort login when authenticator and backup codes are unavailable:
    // send a one-time code to the account (login) email, then wipe MFA so they re-enroll.
    if (action === 'request_login_email_otp') {
      const password = String(body.password || '');
      if (!password) return json(req, { error: 'Enter your account password to send a verification code.' }, 400);
      if (!caller.email) return json(req, { error: 'This account has no login email on file.' }, 400);
      if (!anon) return json(req, { error: 'Server misconfigured.' }, 500);

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recent } = await admin
        .from('recovery_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', callerId)
        .eq('method', 'login_email_otp')
        .eq('success', true)
        .gte('created_at', since);
      if ((recent || 0) >= RECOVERY_MAX_PER_HOUR) {
        return json(req, { error: 'Too many email verification requests. Try again in an hour.' }, 429);
      }

      const pwOk = await verifyAccountPassword(url, anon, caller.email, password);
      if (!pwOk) {
        await audit(admin, callerId, 'login_email_otp', false, ip, 'Bad password on OTP request');
        return json(req, { error: 'Password incorrect.' }, 403);
      }

      const otp = generateLoginOtp();
      const tokenHash = await hashLoginOtp(callerId, otp);
      const expires = new Date(Date.now() + EMAIL_TOKEN_MINUTES * 60 * 1000).toISOString();
      await admin.from('mfa_recovery_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', callerId)
        .eq('purpose', 'login_otp')
        .is('used_at', null);
      await admin.from('mfa_recovery_tokens').insert({
        user_id: callerId,
        purpose: 'login_otp',
        token_hash: tokenHash,
        expires_at: expires,
      });

      const mailBody = [
        `Dear ${caller.full_name || 'there'},`,
        '',
        'Use this verification code to continue signing in to Scorr without your authenticator or backup codes:',
        '',
        otp,
        '',
        `This code expires in ${EMAIL_TOKEN_MINUTES} minutes.`,
        'After you enter it, you must set up a new authenticator app and save new backup codes.',
        '',
        'If you did not request this, change your password and contact your administrator.',
        '',
        'Kind regards,',
        'The Scorr Team',
      ].join('\n');

      await sendEmail(caller.email, 'Your Scorr login verification code', mailBody);
      const recovery = caller.recovery_email_verified && caller.recovery_email
        && caller.recovery_email.toLowerCase() !== caller.email.toLowerCase()
        ? caller.recovery_email
        : null;
      if (recovery) {
        await sendEmail(recovery, 'Your Scorr login verification code', mailBody);
      }

      await audit(admin, callerId, 'login_email_otp', true, ip, 'OTP sent');
      return json(req, {
        ok: true,
        sent: true,
        emailed_to: maskEmail(caller.email),
        also_sent_to_recovery: Boolean(recovery),
        expires_minutes: EMAIL_TOKEN_MINUTES,
      });
    }

    if (action === 'verify_login_email_otp') {
      const password = String(body.password || '');
      const otp = String(body.code || body.otp || '').replace(/\D/g, '');
      if (!password) return json(req, { error: 'Enter your account password.' }, 400);
      if (otp.length !== 6) return json(req, { error: 'Enter the 6-digit code from your email.' }, 400);
      if (!caller.email) return json(req, { error: 'This account has no login email on file.' }, 400);
      if (!anon) return json(req, { error: 'Server misconfigured.' }, 500);

      const pwOk = await verifyAccountPassword(url, anon, caller.email, password);
      if (!pwOk) {
        await audit(admin, callerId, 'login_email_otp', false, ip, 'Bad password on OTP verify');
        return json(req, { error: 'Password incorrect.' }, 403);
      }

      const tokenHash = await hashLoginOtp(callerId, otp);
      const { data: row } = await admin
        .from('mfa_recovery_tokens')
        .select('id, expires_at, used_at')
        .eq('user_id', callerId)
        .eq('purpose', 'login_otp')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (!row || row.used_at) {
        await audit(admin, callerId, 'login_email_otp', false, ip, 'Invalid OTP');
        return json(req, { error: 'Invalid or already used verification code.' }, 400);
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await audit(admin, callerId, 'login_email_otp', false, ip, 'Expired OTP');
        return json(req, { error: 'This code has expired. Request a new one.' }, 400);
      }

      const removed = await deleteMfaFactors(admin, callerId);
      await admin.from('mfa_session_grants').delete().eq('user_id', callerId);
      await admin.from('backup_codes').delete().eq('user_id', callerId);
      await admin.from('users').update({ backup_codes_generated_at: null }).eq('id', callerId);
      await admin.from('mfa_recovery_tokens').update({ used_at: new Date().toISOString() }).eq('id', row.id);
      await admin.from('mfa_recovery_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', callerId)
        .eq('purpose', 'login_otp')
        .is('used_at', null);
      await admin.from('mfa_reset_requests').update({
        resolved_at: new Date().toISOString(),
      }).eq('user_id', callerId).is('resolved_at', null);

      await audit(admin, callerId, 'login_email_otp', true, ip, `OTP verified; MFA cleared (${removed} factors)`);
      return json(req, {
        ok: true,
        must_enroll: true,
        message: 'Email verified. Set up a new authenticator app and save your backup codes.',
      });
    }

    return json(req, { error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('[mfa_recovery]', e);
    return json(req, { error: 'Could not process this request.' }, 500);
  }
});
