// Edge: auto-attendance-event
// R55 / R73 — device-token attendance events. Client IP from trusted proxy headers only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { trustedClientIp } from '../_shared/trustedClientIp.ts';

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
      'authorization, x-client-info, apikey, content-type, x-device-token',
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

async function sha256Hex(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'POST required' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !serviceKey) return json(req, { error: 'Server misconfigured' }, 500);

    const body = await req.json().catch(() => ({}));
    const token =
      String(body.device_token || '').trim() ||
      (req.headers.get('x-device-token') || '').trim();
    if (!token) return json(req, { ok: false, reason: 'missing_token', stop_tracking: true }, 401);

    const tokenHash = await sha256Hex(token);
    const clientIp = trustedClientIp(req);

    const platform = String(body.platform || '').toLowerCase();
    const isIos = platform === 'ios' || platform === 'iphone' || platform === 'ipad';
    let lat = body.lat ?? body.latitude ?? null;
    let lng = body.lng ?? body.longitude ?? null;
    let accuracy = body.accuracy_m ?? body.accuracy ?? null;
    let preciseLocationRequired = false;
    // iOS only: ignore cached / imprecise fixes for check-out (Rule 5).
    if (isIos && lat != null && lng != null) {
      const occurred = Number(body.occurred_at_utc_ms);
      const locTs = Number(body.location_fix_utc_ms);
      const precise = body.precise_location;
      const acc = accuracy == null ? null : Number(accuracy);
      const stale =
        Number.isFinite(occurred) &&
        Number.isFinite(locTs) &&
        locTs > 0 &&
        occurred - locTs > 60_000;
      const imprecise = acc != null && Number.isFinite(acc) && acc > 50;
      const reduced = precise === false || precise === 'false' || precise === 0;
      if (stale || imprecise || reduced) {
        if (reduced) preciseLocationRequired = true;
        lat = null;
        lng = null;
        accuracy = null;
      }
    }

    const admin = createClient(url, serviceKey);
    const { data, error } = await admin.rpc('process_auto_attendance_event', {
      p_token_hash: tokenHash,
      p_event: String(body.event || ''),
      p_zone_id: body.zone_id || null,
      p_latitude: lat,
      p_longitude: lng,
      p_accuracy_m: accuracy,
      p_ssid: body.ssid ?? null,
      p_bssid: body.bssid ?? null,
      p_occurred_at_utc_ms: body.occurred_at_utc_ms ?? null,
      p_device_now_utc_ms: body.device_now_utc_ms ?? null,
      p_device_timezone: body.device_timezone ?? null,
      p_is_mock: Boolean(body.is_mock),
      p_device_id: body.device_id ?? null,
      p_platform: body.platform ?? null,
      p_app_version: body.app_version ?? null,
      p_client_ip: clientIp,
    });

    if (error) return json(req, { ok: false, reason: error.message }, 400);
    const out =
      data && typeof data === 'object'
        ? { ...(data as Record<string, unknown>) }
        : { ok: true };
    if (preciseLocationRequired) {
      out.precise_location_required = true;
      out.notify_message =
        out.notify_message ||
        'Turn on Precise Location for Scorr (Settings → Scorr → Location → Precise Location) so office check-out works correctly.';
    }
    return json(req, out);
  } catch (e) {
    return json(req, { ok: false, reason: String(e) }, 500);
  }
});
