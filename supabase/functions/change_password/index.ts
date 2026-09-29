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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

async function verifyAccountPassword(
  url: string,
  anon: string,
  email: string,
  password: string,
): Promise<boolean> {
  const check = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await check.auth.signInWithPassword({ email, password });
  // Correct password returns AAL1 even when MFA is enrolled; wrong password errors.
  return !error;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!url || !serviceKey || !anon) {
      return json(req, { error: 'Server misconfigured.' }, 500);
    }

    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json(req, { error: 'Not signed in.' }, 401);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user?.id || !userData.user.email) {
      return json(req, { error: 'Not signed in.' }, 401);
    }
    const caller = userData.user;

    const body = await req.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');

    if (!currentPassword) {
      return json(req, { error: 'Enter your current password.' }, 400);
    }
    if (newPassword.length < 6) {
      return json(req, { error: 'New password must be at least 6 characters.' }, 400);
    }
    if (currentPassword === newPassword) {
      return json(req, { error: 'New password must be different from the current password.' }, 400);
    }

    const pwOk = await verifyAccountPassword(url, anon, caller.email, currentPassword);
    if (!pwOk) {
      return json(req, { error: 'Current password is incorrect.' }, 400);
    }

    // Admin API updates password without requiring an AAL2 (MFA) session.
    const { error: updateErr } = await admin.auth.admin.updateUserById(caller.id, {
      password: newPassword,
    });
    if (updateErr) {
      console.error('[change_password] update', updateErr.message);
      return json(req, { error: updateErr.message || 'Could not update password.' }, 500);
    }

    return json(req, { ok: true });
  } catch (e) {
    console.error('[change_password]', e);
    return json(req, { error: 'Could not update password. Try again.' }, 500);
  }
});
