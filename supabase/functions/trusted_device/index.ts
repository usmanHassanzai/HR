import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ALLOWED_ORIGINS = new Set([
  'https://scorr.walfia.ai',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'https://localhost',
]);

const PEPPER = Deno.env.get('MFA_CODE_PEPPER') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'scorr-mfa-pepper';
const COOKIE_NAME = 'scorr_td';
const GRANT_HOURS = 12;

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://scorr.walfia.ai';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-forwarded-for, x-real-ip, cookie, x-trusted-device-token',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'set-cookie',
    Vary: 'Origin',
  };
}

function json(req: Request, data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', ...extraHeaders },
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

async function hashToken(token: string): Promise<string> {
  return sha256Hex(`${PEPPER}:trusted_device:${token}`);
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return null;
}

function setCookieHeader(token: string, maxAgeSec: number): string {
  // SameSite=Strict on the edge host only helps same-site callers; web uses
  // same-origin /api/trusted-device proxy which sets Strict on scorr.walfia.ai.
  // Edge still sets a scoped cookie for credentialed same-host clients.
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/functions/v1/trusted_device',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  return parts.join('; ');
}

function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/functions/v1/trusted_device; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
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
  const expires = new Date(Date.now() + GRANT_HOURS * 3600 * 1000).toISOString();
  await admin.from('mfa_session_grants').upsert({
    user_id: userId,
    session_id: sid,
    method,
    expires_at: expires,
  }, { onConflict: 'user_id,session_id' });
}

async function hasSessionGrant(
  admin: ReturnType<typeof createClient>,
  userId: string,
  _sessionId: string | null,
): Promise<boolean> {
  // Match has_mfa_session_grant(null): any unexpired grant for this user.
  const { data } = await admin
    .from('mfa_session_grants')
    .select('id')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/** AAL2 JWT or active mfa_session_grant (backup / trusted device). */
async function mfaSatisfied(
  admin: ReturnType<typeof createClient>,
  jwt: string,
  userId: string,
): Promise<boolean> {
  if (tokenAal(jwt) === 'aal2') return true;
  return hasSessionGrant(admin, userId, sessionIdFromJwt(jwt));
}

function trustDaysForRole(
  role: string,
  isPlatformOwner: boolean,
  staffDays: number,
  adminDays: number,
): number {
  if (isPlatformOwner) return 0;
  if (role === 'admin' || role === 'hr') return adminDays;
  return staffDays;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!url || !serviceKey) return json(req, { error: 'Server misconfigured.' }, 500);
    if (!jwt) return json(req, { error: 'Not authenticated.' }, 401);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authErr } = await admin.auth.getUser(jwt);
    const callerId = authData?.user?.id;
    if (authErr || !callerId) return json(req, { error: 'Not authenticated.' }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const ip = clientIp(req);

    const { data: caller } = await admin
      .from('users')
      .select('id, email, full_name, role, company_id, is_platform_owner, is_demo')
      .eq('id', callerId)
      .maybeSingle();
    if (!caller) return json(req, { error: 'Not authenticated.' }, 401);

    const sid = sessionIdFromJwt(jwt);

    // ── issue (after successful MFA) ──────────────────────────────────────
    if (action === 'issue') {
      if (!(await mfaSatisfied(admin, jwt, callerId))) {
        return json(req, { error: 'Verify your authenticator before trusting this device.' }, 403);
      }

      let staffDays = 7;
      let adminDays = 7;
      if (caller.company_id) {
        const { data: co } = await admin
          .from('companies')
          .select('mfa_trust_staff_days, mfa_trust_admin_days')
          .eq('id', caller.company_id)
          .maybeSingle();
        staffDays = co?.mfa_trust_staff_days ?? 7;
        adminDays = co?.mfa_trust_admin_days ?? 7;
      }
      const days = trustDaysForRole(
        String(caller.role || ''),
        Boolean(caller.is_platform_owner),
        staffDays,
        adminDays,
      );
      if (days <= 0) {
        return json(req, { error: 'Trusted devices are disabled for this account.', allowed: false }, 403);
      }

      const deviceId = String(body.device_id || '').trim() || crypto.randomUUID();
      const platform = String(body.platform || 'web').slice(0, 32);
      const userAgent = String(body.user_agent || req.headers.get('user-agent') || '').slice(0, 512);
      const label = String(body.label || '').slice(0, 120) || null;

      const rawToken = generateToken();
      const tokenHash = await hashToken(rawToken);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + days * 86400 * 1000).toISOString();

      // Re-trust same device: update any prior row (active or revoked) for this device_id.
      // Partial unique index allows multiple revoked rows historically; keep one live row.
      const { data: existing } = await admin
        .from('trusted_devices')
        .select('id')
        .eq('user_id', callerId)
        .eq('device_id', deviceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let writeErr: { message: string } | null = null;
      if (existing?.id) {
        // Soft-revoke sibling active rows for this device (should be none)
        await admin
          .from('trusted_devices')
          .update({ revoked_at: now.toISOString() })
          .eq('user_id', callerId)
          .eq('device_id', deviceId)
          .neq('id', existing.id)
          .is('revoked_at', null);
        const { error } = await admin.from('trusted_devices').update({
          company_id: caller.company_id,
          token_hash: tokenHash,
          platform,
          user_agent: userAgent,
          label,
          expires_at: expiresAt,
          last_used_at: now.toISOString(),
          revoked_at: null,
          created_at: now.toISOString(),
        }).eq('id', existing.id);
        writeErr = error;
      } else {
        const { error } = await admin.from('trusted_devices').insert({
          user_id: callerId,
          company_id: caller.company_id,
          device_id: deviceId,
          token_hash: tokenHash,
          platform,
          user_agent: userAgent,
          label,
          expires_at: expiresAt,
          last_used_at: now.toISOString(),
        });
        writeErr = error;
      }
      if (writeErr) {
        console.error('[trusted_device] upsert', writeErr.message);
        return json(req, { error: 'Could not trust this device.', detail: writeErr.message }, 500);
      }

      await createSessionGrant(admin, callerId, sid, 'trusted_device');
      await audit(admin, callerId, 'trust_created', true, ip, `${platform} ${days}d`);

      const maxAge = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      return json(
        req,
        {
          ok: true,
          token: rawToken,
          device_id: deviceId,
          expires_at: expiresAt,
          days,
        },
        200,
        { 'Set-Cookie': setCookieHeader(rawToken, maxAge) },
      );
    }

    // ── verify (after password login) ─────────────────────────────────────
    if (action === 'verify') {
      const fromBody = String(body.token || '').trim();
      const fromHeader = String(req.headers.get('x-trusted-device-token') || '').trim();
      const fromCookie = parseCookie(req, COOKIE_NAME) || '';
      const rawToken = fromBody || fromHeader || fromCookie;
      const deviceId = String(body.device_id || '').trim();

      if (!rawToken) {
        return json(req, { ok: false, reason: 'missing_token' }, 200, {
          'Set-Cookie': clearCookieHeader(),
        });
      }

      // Platform owners never skip MFA
      if (caller.is_platform_owner) {
        await audit(admin, callerId, 'trust_used', false, ip, 'platform_owner');
        return json(req, { ok: false, reason: 'always_ask' }, 200, {
          'Set-Cookie': clearCookieHeader(),
        });
      }

      let staffDays = 7;
      let adminDays = 7;
      if (caller.company_id) {
        const { data: co } = await admin
          .from('companies')
          .select('mfa_trust_staff_days, mfa_trust_admin_days')
          .eq('id', caller.company_id)
          .maybeSingle();
        staffDays = co?.mfa_trust_staff_days ?? 7;
        adminDays = co?.mfa_trust_admin_days ?? 7;
      }
      const allowedDays = trustDaysForRole(
        String(caller.role || ''),
        Boolean(caller.is_platform_owner),
        staffDays,
        adminDays,
      );
      if (allowedDays <= 0) {
        return json(req, { ok: false, reason: 'always_ask' }, 200, {
          'Set-Cookie': clearCookieHeader(),
        });
      }

      const tokenHash = await hashToken(rawToken);
      let q = admin
        .from('trusted_devices')
        .select('id, user_id, device_id, expires_at, revoked_at')
        .eq('token_hash', tokenHash)
        .eq('user_id', callerId)
        .is('revoked_at', null)
        .limit(1);
      if (deviceId) q = q.eq('device_id', deviceId);
      const { data: row } = await q.maybeSingle();

      if (!row) {
        await audit(admin, callerId, 'trust_used', false, ip, 'invalid_or_foreign');
        return json(req, { ok: false, reason: 'invalid' }, 200, {
          'Set-Cookie': clearCookieHeader(),
        });
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await admin.from('trusted_devices').update({ revoked_at: new Date().toISOString() }).eq('id', row.id);
        await audit(admin, callerId, 'trust_used', false, ip, 'expired');
        return json(req, { ok: false, reason: 'expired' }, 200, {
          'Set-Cookie': clearCookieHeader(),
        });
      }

      // Rotate token; keep original expires_at (no sliding forever)
      const newRaw = generateToken();
      const newHash = await hashToken(newRaw);
      const { error: rotErr } = await admin
        .from('trusted_devices')
        .update({
          token_hash: newHash,
          last_used_at: new Date().toISOString(),
          user_agent: String(body.user_agent || req.headers.get('user-agent') || '').slice(0, 512) || null,
        })
        .eq('id', row.id);
      if (rotErr) {
        console.error('[trusted_device] rotate', rotErr.message);
        return json(req, { error: 'Could not refresh trusted device.' }, 500);
      }

      await createSessionGrant(admin, callerId, sid, 'trusted_device');
      await audit(admin, callerId, 'trust_used', true, ip, row.device_id);

      const maxAge = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
      return json(
        req,
        {
          ok: true,
          token: newRaw,
          device_id: row.device_id,
          expires_at: row.expires_at,
        },
        200,
        { 'Set-Cookie': setCookieHeader(newRaw, maxAge) },
      );
    }

    // ── list ──────────────────────────────────────────────────────────────
    if (action === 'list') {
      const { data } = await admin
        .from('trusted_devices')
        .select('id, device_id, platform, label, user_agent, created_at, expires_at, last_used_at')
        .eq('user_id', callerId)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('last_used_at', { ascending: false, nullsFirst: false });
      return json(req, { ok: true, devices: data || [] });
    }

    // ── revoke one / all (self) ───────────────────────────────────────────
    if (action === 'revoke') {
      const deviceRowId = String(body.id || '').trim();
      if (!deviceRowId) return json(req, { error: 'Missing device id.' }, 400);
      const { data: updated } = await admin
        .from('trusted_devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', deviceRowId)
        .eq('user_id', callerId)
        .is('revoked_at', null)
        .select('id, device_id')
        .maybeSingle();
      if (updated) {
        await audit(admin, callerId, 'trust_revoked', true, ip, `self ${updated.device_id}`);
      }
      return json(req, { ok: true, revoked: Boolean(updated) }, 200, {
        'Set-Cookie': clearCookieHeader(),
      });
    }

    if (action === 'revoke_all') {
      const { data: rows } = await admin
        .from('trusted_devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', callerId)
        .is('revoked_at', null)
        .select('id');
      const n = rows?.length || 0;
      if (n > 0) {
        await audit(admin, callerId, 'trust_revoked', true, ip, `self_all (${n})`);
      }
      await admin.from('mfa_session_grants').delete().eq('user_id', callerId).eq('method', 'trusted_device');
      return json(req, { ok: true, revoked: n }, 200, { 'Set-Cookie': clearCookieHeader() });
    }

    // ── admin revoke all for a person ─────────────────────────────────────
    if (action === 'admin_revoke_all') {
      if (!(await mfaSatisfied(admin, jwt, callerId))) {
        return json(req, { error: 'Verify your authenticator before managing trusted devices.' }, 403);
      }
      const targetId = String(body.user_id || '').trim();
      if (!targetId) return json(req, { error: 'Select a person.' }, 400);

      const isOwner = caller.is_platform_owner === true;
      const isAdmin =
        (caller.role === 'admin' || caller.role === 'hr') && caller.is_demo !== true;
      if (!isOwner && !isAdmin) {
        return json(req, { error: 'Only a company admin or HR can revoke trusted devices.' }, 403);
      }

      const { data: target } = await admin
        .from('users')
        .select('id, company_id, full_name, is_platform_owner, is_demo')
        .eq('id', targetId)
        .maybeSingle();
      if (!target) return json(req, { error: 'Person not found.' }, 404);
      if (!isOwner) {
        if (caller.company_id !== target.company_id) {
          return json(req, { error: 'Person not found.' }, 404);
        }
        if (Boolean(caller.is_demo) !== Boolean(target.is_demo)) {
          return json(req, { error: 'Person not found.' }, 404);
        }
      }

      const { data: rows } = await admin
        .from('trusted_devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', targetId)
        .is('revoked_at', null)
        .select('id');
      const n = rows?.length || 0;
      await admin.from('mfa_session_grants').delete().eq('user_id', targetId).eq('method', 'trusted_device');
      await audit(
        admin,
        targetId,
        'trust_revoked',
        true,
        ip,
        `admin:${callerId} ${caller.full_name || ''} (${n})`,
      );
      return json(req, { ok: true, revoked: n });
    }

    // ── policy (read via RPC preferred; write here for MFA gate) ──────────
    if (action === 'policy') {
      const { data } = await admin.rpc('get_company_mfa_trust_policy');
      return json(req, { ok: true, ...(data || {}) });
    }

    if (action === 'set_policy') {
      if (!(await mfaSatisfied(admin, jwt, callerId))) {
        return json(req, { error: 'Verify your authenticator before changing trust policy.' }, 403);
      }
      const staff = Number(body.mfa_trust_staff_days);
      const adminD = Number(body.mfa_trust_admin_days);
      const { data, error } = await admin.rpc('set_company_mfa_trust_policy', {
        p_staff_days: staff,
        p_admin_days: adminD,
      });
      if (error) return json(req, { error: error.message }, 400);
      return json(req, { ok: true, ...(data as object) });
    }

    // ── can_trust (UI default / eligibility) ──────────────────────────────
    if (action === 'can_trust') {
      let staffDays = 7;
      let adminDays = 7;
      if (caller.company_id) {
        const { data: co } = await admin
          .from('companies')
          .select('mfa_trust_staff_days, mfa_trust_admin_days')
          .eq('id', caller.company_id)
          .maybeSingle();
        staffDays = co?.mfa_trust_staff_days ?? 7;
        adminDays = co?.mfa_trust_admin_days ?? 7;
      }
      const days = trustDaysForRole(
        String(caller.role || ''),
        Boolean(caller.is_platform_owner),
        staffDays,
        adminDays,
      );
      return json(req, { ok: true, allowed: days > 0, days });
    }

    return json(req, { error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('[trusted_device]', e);
    return json(req, { error: 'Could not process trusted device request.' }, 500);
  }
});
