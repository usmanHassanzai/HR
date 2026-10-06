// Edge: register-attendance-device
// R29 — JWT once → random device token (plaintext returned once; hash stored via RPC)

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'POST required' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!url || !anon || !jwt) return json(req, { error: 'Not authenticated' }, 401);

    const body = await req.json().catch(() => ({}));
    const deviceId = String(body.device_id || '').trim();
    const platform = String(body.platform || '').trim();
    const deviceTimezone = body.device_timezone ? String(body.device_timezone) : null;
    const appVersion = body.app_version ? String(body.app_version) : null;

    if (!deviceId || !platform) {
      return json(req, { error: 'device_id and platform required' }, 400);
    }

    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data, error } = await userClient.rpc('register_attendance_device', {
      p_device_id: deviceId,
      p_platform: platform,
      p_device_timezone: deviceTimezone,
      p_app_version: appVersion,
      p_token_plaintext: null,
    });

    if (error) return json(req, { error: error.message }, 400);
    return json(req, data);
  } catch (e) {
    return json(req, { error: String(e) }, 500);
  }
});
