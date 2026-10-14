// Edge: attendance-schedule
// Device-token schedule (UTC check-in windows + assigned Wi-Fi zones)
// Also: mass auto check-out at shift end when invoked as cron (no pg_cron hosts).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ALLOWED_ORIGINS = new Set([
  'https://scorr.walfia.ai',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'https://localhost',
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://scorr.walfia.ai';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-device-token, x-cron-secret',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isServiceRole(req: Request, serviceKey: string): boolean {
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return !!serviceKey && auth === serviceKey;
}

function isCronAuthorized(req: Request, serviceKey: string): boolean {
  if (isServiceRole(req, serviceKey)) return true;
  const cronSecret = (Deno.env.get('ATTENDANCE_CRON_SECRET') || '').trim();
  if (!cronSecret) return false;
  const header = (req.headers.get('x-cron-secret') || '').trim();
  return header === cronSecret;
}

/** supabase-js rpc() returns a thenable builder — not always a Promise with .catch(). */
async function rpcIgnore(client: ReturnType<typeof createClient>, fn: string, args?: Record<string, unknown>) {
  try {
    await client.rpc(fn, args ?? {});
  } catch {
    /* opportunistic helpers must never fail the schedule response */
  }
}

/** True only for a signed-in user JWT — never anon/service keys (even if env anon differs). */
function isUserAccessToken(jwt: string, anon: string, serviceKey: string): boolean {
  if (!jwt) return false;
  if (jwt === anon || jwt === serviceKey) return false;
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return false;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(pad)) as { role?: string; sub?: string };
    if (payload.role === 'anon' || payload.role === 'service_role') return false;
    return payload.role === 'authenticated' || Boolean(payload.sub);
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!url || !serviceKey) return json(req, { error: 'Server misconfigured' }, 500);

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const action = String((body as { action?: string }).action || '').trim();

    // Mass auto check-out at shift end (prefer DB pg_cron; this is the fallback)
    if (action === 'close_ended_shifts') {
      if (!isCronAuthorized(req, serviceKey)) {
        return json(req, { ok: false, reason: 'unauthorized' }, 401);
      }
      const admin = createClient(url, serviceKey);
      const { data, error } = await admin.rpc('close_all_ended_shift_attendance');
      if (error) return json(req, { ok: false, reason: error.message }, 400);
      return json(req, {
        ok: true,
        action: 'close_ended_shifts',
        closed: data ?? 0,
        message: 'Closed open attendance sessions whose shift end has passed.',
      });
    }

    const token =
      String((body as { device_token?: string }).device_token || '').trim() ||
      (req.headers.get('x-device-token') || '').trim();

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    // Android/desktop send apikey (+ device token). Some clients also send Authorization: Bearer <anon>.
    // Only treat a real user access token as the JWT schedule path.
    if (!token && isUserAccessToken(jwt, anon, serviceKey)) {
      const userClient = createClient(url, anon || serviceKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      await rpcIgnore(userClient, 'close_my_ended_shift_attendance');
      const { data, error } = await userClient.rpc('get_my_attendance_schedule');
      if (error) return json(req, { ok: false, reason: error.message }, 400);
      return json(req, data);
    }

    if (!token) return json(req, { ok: false, reason: 'missing_token', stop_tracking: true }, 401);

    const tokenHash = await sha256Hex(token);
    const admin = createClient(url, serviceKey);
    const { data, error } = await admin.rpc('attendance_schedule_by_token', {
      p_token_hash: tokenHash,
    });
    if (error) return json(req, { ok: false, reason: error.message }, 400);

    // Opportunistic: if schedule identifies a user, close their ended shift
    const userId = (data as { user_id?: string } | null)?.user_id;
    if (userId) {
      await rpcIgnore(admin, 'close_open_attendance_if_shift_ended', { p_user_id: userId });
    }

    return json(req, data);
  } catch (e) {
    return json(req, { ok: false, reason: String(e) }, 500);
  }
});
