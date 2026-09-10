import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const PLATFORM_OWNER_EMAIL = 'info@walfia.ai';

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const body = await req.json().catch(() => ({}));
    const companyName = String(body.companyName || '').trim();
    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const industry = String(body.industry || '').trim();
    const employeeCount = String(body.employeeCount || '').trim();

    if (!companyName || !fullName || !email || !email.includes('@')) {
      return json(req, { error: 'companyName, fullName, and email are required.' }, 400);
    }

    const lines = [
      `Company: ${companyName}`,
      `Contact: ${fullName}`,
      `Email: ${email}`,
      `Phone: ${phone || '—'}`,
      `Industry: ${industry || '—'}`,
      `Team size: ${employeeCount || '—'}`,
      '',
      'Status: Pending approval',
      'Approve or reject: https://scorr.walfia.ai/platform',
      '(Or open Admin → Registered Companies while signed in as info@walfia.ai)',
    ];
    const text = lines.join('\n');
    const subject = `New company registration: ${companyName}`;

    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';

    if (apiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [PLATFORM_OWNER_EMAIL],
          subject,
          html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>${text.replace(/\n/g, '<br>')}</p><hr><small>Scorr — scorr.walfia.ai</small></div>`,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error('[company_registration_notify] Resend', err);
        return json(req, { error: err, sent: false }, 502);
      }
      return json(req, { sent: true, provider: 'resend', to: PLATFORM_OWNER_EMAIL });
    }

    console.log(`[company_registration_notify] No RESEND_API_KEY — logged only\nTo: ${PLATFORM_OWNER_EMAIL}\nSubject: ${subject}\n${text}`);
    return json(req, { sent: true, provider: 'log', to: PLATFORM_OWNER_EMAIL });
  } catch (e) {
    return json(req, { error: String(e) }, 500);
  }
});
