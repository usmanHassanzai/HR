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

function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = (bytes[0]! * 0x1000000 + bytes[1]! * 0x10000 + bytes[2]! * 0x100 + bytes[3]!) % 1000000;
  return String(n).padStart(6, '0');
}

async function hashCode(email: string, code: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${email}:${code}:${pepper}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').toLowerCase();
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\s/g, '');

    if (!email || !email.includes('@')) {
      return json(req, { error: 'Enter a valid email address.' }, 400);
    }

    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!url || !serviceKey) {
      return json(req, { error: 'Verification is not configured.' }, 500);
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === 'send') {
      const otp = generateCode();
      const codeHash = await hashCode(email, otp, serviceKey);
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const { error: upErr } = await admin.from('signup_email_otps').upsert({
        email,
        code_hash: codeHash,
        expires_at: expires,
        attempts: 0,
      });
      if (upErr) {
        console.error('[signup_otp] store', upErr.message);
        return json(req, { error: 'Could not send the code. Try again.' }, 500);
      }

      const apiKey = Deno.env.get('RESEND_API_KEY');
      const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';
      const subject = 'Your Scorr verification code';
      const text = `Your Scorr verification code is ${otp}. It expires in 15 minutes. If you did not register a company, ignore this email.`;

      if (apiKey) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [email],
            subject,
            html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>Your verification code is:</p><p style="font-size:28px;letter-spacing:0.2em;font-weight:700">${otp}</p><p>It expires in 15 minutes.</p><hr><small>Scorr — scorr.walfia.ai</small></div>`,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          console.error('[signup_otp] Resend', err);
          return json(req, { error: 'Could not send the email. Try again in a moment.' }, 502);
        }
      } else {
        console.log(`[signup_otp] No RESEND_API_KEY — code for ${email}: ${otp}`);
      }

      return json(req, { sent: true });
    }

    if (action === 'verify') {
      if (!/^\d{6}$/.test(code)) {
        return json(req, { error: 'Enter the 6-digit code from your email.' }, 400);
      }
      const { data: row, error: readErr } = await admin
        .from('signup_email_otps')
        .select('code_hash, expires_at, attempts')
        .eq('email', email)
        .maybeSingle();
      if (readErr || !row) {
        return json(req, { error: 'That code is not valid. Request a new one.' }, 400);
      }
      if (Number(row.attempts) >= 8) {
        return json(req, { error: 'Too many attempts. Request a new code.' }, 429);
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json(req, { error: 'That code has expired. Request a new one.' }, 400);
      }
      const expected = await hashCode(email, code, serviceKey);
      if (expected !== row.code_hash) {
        await admin.from('signup_email_otps').update({ attempts: Number(row.attempts) + 1 }).eq('email', email);
        return json(req, { error: 'That code does not match. Try again.' }, 400);
      }

      const { data: people } = await admin.from('users').select('id').ilike('email', email).limit(1);
      const userId = people?.[0]?.id;
      if (userId) {
        await admin.auth.admin.updateUserById(userId, { email_confirm: true });
      }
      await admin.from('signup_email_otps').delete().eq('email', email);
      return json(req, { ok: true });
    }

    return json(req, { error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('[signup_otp]', e);
    return json(req, { error: 'Could not process this request.' }, 500);
  }
});
