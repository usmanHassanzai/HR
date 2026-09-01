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

const LOGIN_URL = 'https://scorr.walfia.ai';

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function generateTempPassword(length = 10): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length];
  return out;
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Administrator';
  if (role === 'manager') return 'Manager';
  return 'Employee';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const { email } = await req.json().catch(() => ({ email: '' }));
    const address = String(email || '').trim().toLowerCase();

    // Always look successful so this cannot be used to probe who has an account.
    const ok = { sent: true };

    if (!address || !address.includes('@')) {
      return json(req, ok);
    }

    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !serviceKey) {
      console.error('[forgot_password] Missing service role');
      return json(req, ok);
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: limited } = await admin.rpc('forgot_is_rate_limited', { p_email: address });
    if (limited === true) {
      return json(req, ok);
    }

    const { data: rows, error: lookupErr } = await admin
      .from('users')
      .select('id, email, full_name, role')
      .ilike('email', address)
      .in('role', ['employee', 'manager', 'admin'])
      .limit(1);

    if (lookupErr) {
      console.error('[forgot_password] lookup', lookupErr.message);
      return json(req, ok);
    }
    const person = rows?.[0];
    if (!person?.id || !person.email) {
      return json(req, ok);
    }

    const password = generateTempPassword();
    const { error: updateErr } = await admin.auth.admin.updateUserById(person.id, { password });
    if (updateErr) {
      console.error('[forgot_password] update', updateErr.message);
      return json(req, { error: 'Could not reset password. Try again or ask your admin.' }, 500);
    }

    const name = (person.full_name || 'there').trim();
    const body = [
      `Dear ${name},`,
      '',
      'You asked to recover your Scorr password. A new temporary password is below.',
      '',
      `Login URL: ${LOGIN_URL}`,
      `Email: ${person.email}`,
      `Temporary password: ${password}`,
      `Role: ${roleLabel(String(person.role || ''))}`,
      '',
      'Sign in with this password, then change it from your profile if you wish.',
      '',
      'If you did not request this, contact your company administrator.',
      '',
      'Kind regards,',
      'The Scorr Team',
      LOGIN_URL,
    ].join('\n');

    const subject = 'Your Scorr password';
    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';

    if (apiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [person.email],
          subject,
          html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>${body.replace(/\n/g, '<br>')}</p><hr><small>Scorr — scorr.walfia.ai</small></div>`,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error('[forgot_password] Resend', err);
        return json(req, { error: 'Password was reset but the email could not be sent. Ask your admin.' }, 502);
      }
    } else {
      console.log(`[forgot_password] No RESEND_API_KEY — logged only\nTo: ${person.email}\n${body}`);
    }

    return json(req, ok);
  } catch (e) {
    console.error('[forgot_password]', e);
    return json(req, { error: 'Could not process this request.' }, 500);
  }
});
