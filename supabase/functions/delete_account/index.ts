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
    const action = String(body.action || 'delete');
    const password = String(body.password || '');
    const confirmText = String(body.confirmText || '').trim().toUpperCase();
    const deleteCompany = Boolean(body.deleteCompany);

    // Preview ownership / company impact (no password required)
    if (action === 'preview') {
      const userClient = createClient(url, anon, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await userClient.rpc('account_deletion_info');
      if (error) {
        return json(req, { error: error.message || 'Could not load account info.' }, 400);
      }
      return json(req, { ok: true, info: data });
    }

    if (!password) {
      return json(req, { error: 'Enter your account password to confirm deletion.' }, 400);
    }
    if (confirmText !== 'DELETE') {
      return json(req, { error: 'Type DELETE to confirm permanent account deletion.' }, 400);
    }

    const pwOk = await verifyAccountPassword(url, anon, caller.email, password);
    if (!pwOk) {
      return json(req, { error: 'Password is incorrect.' }, 400);
    }

    // Run as the signed-in user so auth.uid() matches inside SECURITY DEFINER RPCs.
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await userClient.rpc('delete_own_account', {
      p_delete_company: deleteCompany,
    });

    if (error) {
      console.error('[delete_account] rpc', error.message);
      return json(req, { error: error.message || 'Could not delete account.' }, 400);
    }

    // Ensure Auth user is gone even if public.users cascade already removed it.
    try {
      await admin.auth.admin.deleteUser(caller.id);
    } catch (e) {
      // Already deleted via SQL DELETE FROM auth.users — fine.
      console.warn('[delete_account] admin.deleteUser', e);
    }

    return json(req, { ok: true, result: data });
  } catch (e) {
    console.error('[delete_account]', e);
    return json(req, { error: 'Could not delete account. Try again.' }, 500);
  }
});
