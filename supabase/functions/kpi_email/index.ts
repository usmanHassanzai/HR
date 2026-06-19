import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { to, subject, body } = await req.json();
    if (!to || !subject || !body) {
      return new Response(JSON.stringify({ error: 'to, subject, body required' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';

    if (apiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>${body.replace(/\n/g, '<br>')}</p><hr><small>Scorr — scorr.walfia.ai</small></div>` }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error('Resend error:', err);
        return new Response(JSON.stringify({ error: err, sent: false }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ sent: true, provider: 'resend' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    console.log(`[kpi_email] No RESEND_API_KEY — logged only\nTo: ${to}\nSubject: ${subject}\n${body}`);
    return new Response(JSON.stringify({ sent: true, provider: 'log' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
