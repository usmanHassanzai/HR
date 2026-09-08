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

function tokenAal(jwt: string): string {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1] || ''));
    return String(payload.aal || 'aal1');
  } catch {
    return 'aal1';
  }
}

function roleLabel(role: string | null | undefined): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  if (role === 'employee') return 'Employee';
  return role || 'User';
}

async function sendEmail(to: string[], subject: string, body: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('KPI_EMAIL_FROM') || 'Scorr <noreply@scorr.walfia.ai>';
  if (!apiKey || !to.length) {
    console.log(`[reset_authenticator] email skipped\nTo: ${to.join(', ')}\n${subject}\n${body}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject,
      html: `<div style="font-family:sans-serif;line-height:1.5"><h2>${subject}</h2><p>${body.replace(/\n/g, '<br>')}</p><hr><small>Scorr — scorr.walfia.ai</small></div>`,
    }),
  });
  if (!res.ok) {
    console.error('[reset_authenticator] Resend', await res.text());
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  try {
    const url = Deno.env.get('SUPABASE_URL') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!url || !serviceKey || !jwt) {
      return json(req, { error: 'Not authenticated.' }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const requestReset = body.requestReset === true;
    const targetId = String(body.userId || '').trim();

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authErr } = await admin.auth.getUser(jwt);
    const callerId = authData?.user?.id;
    if (authErr || !callerId) {
      return json(req, { error: 'Not authenticated. Sign out and sign in again, then request a reset.' }, 401);
    }

    const { data: caller, error: callerErr } = await admin
      .from('users')
      .select('id, email, full_name, role, company_id, is_demo, is_platform_owner')
      .eq('id', callerId)
      .maybeSingle();
    if (callerErr || !caller) {
      return json(req, { error: 'Not authenticated.' }, 401);
    }

    if (requestReset) {
      const target = caller;
      const who = `${roleLabel(target.role)} ${target.full_name} (${target.email})`;
      const msg = [
        `${who} cannot open their authenticator app and requested a reset.`,
        'In Scorr go to People → open their profile → Reset Authenticator.',
        'They will scan a new QR the next time they sign in.',
      ].join('\n');

      const nowIso = new Date().toISOString();
      const { data: existingReq } = await admin
        .from('mfa_reset_requests')
        .select('id')
        .eq('user_id', target.id)
        .is('resolved_at', null)
        .maybeSingle();

      if (existingReq?.id) {
        const { error: updErr } = await admin
          .from('mfa_reset_requests')
          .update({
            created_at: nowIso,
            company_id: target.company_id,
            requester_role: target.role,
            requester_name: target.full_name,
            requester_email: target.email,
            message: msg,
          })
          .eq('id', existingReq.id);
        if (updErr) console.error('[reset_authenticator] request update', updErr.message);
      } else {
        const { error: insertErr } = await admin.from('mfa_reset_requests').insert({
          user_id: target.id,
          company_id: target.company_id,
          requester_role: target.role,
          requester_name: target.full_name,
          requester_email: target.email,
          message: msg,
        });
        if (insertErr) console.error('[reset_authenticator] request insert', insertErr.message);
      }

      const { data: admins } = target.company_id
        ? await admin
            .from('users')
            .select('id, email, full_name')
            .eq('company_id', target.company_id)
            .eq('role', 'admin')
            .eq('is_demo', false)
        : { data: [] as { id: string; email: string | null; full_name: string | null }[] };

      const peerAdmins = (admins || []).filter((a) => a.id !== target.id && a.email);
      const adminEmails = peerAdmins.map((a) => a.email as string);

      if (adminEmails.length) {
        await sendEmail(
          adminEmails,
          `Authenticator reset needed: ${target.full_name}`,
          `Dear administrator,\n\n${msg}\n\nKind regards,\nThe Scorr Team`,
        );
        for (const a of admins || []) {
          if (a.id === target.id) continue;
          await admin.rpc('create_system_notification', {
            p_user_id: a.id,
            p_title: 'Authenticator reset requested',
            p_message: msg,
            p_type: 'alert',
          });
        }
      }

      // Sole admin / no peer admins — escalate to platform owner inbox.
      if ((!adminEmails.length || target.role === 'admin') && target.company_id) {
        await admin.from('platform_owner_notifications').insert({
          company_id: target.company_id,
          title: 'Authenticator reset requested',
          message: msg,
        });
      }

      return json(req, {
        ok: true,
        requested: true,
        notifiedAdmins: adminEmails.length,
        escalatedToPlatform: !adminEmails.length || target.role === 'admin',
      });
    }

    if (!targetId) {
      return json(req, { error: 'Select a person.' }, 400);
    }
    if (tokenAal(jwt) !== 'aal2') {
      return json(req, { error: 'Verify your authenticator before resetting someone else’s.' }, 403);
    }

    const isOwner = caller.is_platform_owner === true;
    const isAdmin = caller.role === 'admin' && caller.is_demo !== true;
    if (!isOwner && !isAdmin) {
      return json(req, { error: 'Only a company admin can reset an authenticator.' }, 403);
    }

    const { data: target, error: targetErr } = await admin
      .from('users')
      .select('id, email, full_name, role, company_id, is_demo, is_platform_owner')
      .eq('id', targetId)
      .maybeSingle();
    if (targetErr || !target) {
      return json(req, { error: 'Person not found.' }, 404);
    }
    if (target.is_platform_owner && !isOwner) {
      return json(req, { error: 'This account cannot be reset from here.' }, 403);
    }
    if (!isOwner) {
      if (caller.company_id !== target.company_id) {
        return json(req, { error: 'Person not found.' }, 404);
      }
      if (Boolean(caller.is_demo) !== Boolean(target.is_demo)) {
        return json(req, { error: 'Person not found.' }, 404);
      }
    }

    const listed = await admin.auth.admin.mfa.listFactors({ userId: target.id });
    if (listed.error) {
      console.error('[reset_authenticator] list', listed.error.message);
      return json(req, { error: 'Could not read authenticator factors.' }, 500);
    }
    const raw = listed.data as { factors?: { id: string }[]; totp?: { id: string }[] } | null;
    const factors = raw?.factors?.length ? raw.factors : (raw?.totp || []);
    for (const factor of factors) {
      const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({
        id: factor.id,
        userId: target.id,
      });
      if (delErr) {
        console.error('[reset_authenticator] delete', delErr.message);
        return json(req, { error: 'Could not remove the old authenticator.' }, 500);
      }
    }

    await admin
      .from('mfa_reset_requests')
      .update({ resolved_at: new Date().toISOString(), resolved_by: caller.id })
      .eq('user_id', target.id)
      .is('resolved_at', null);

    await admin.rpc('create_system_notification', {
      p_user_id: target.id,
      p_title: 'Authenticator reset',
      p_message: `${caller.full_name} reset your authenticator. Sign in and scan the new QR code in Google Authenticator or Authy.`,
      p_type: 'alert',
    });

    if (target.email) {
      await sendEmail(
        [target.email],
        'Your Scorr authenticator was reset',
        [
          `Dear ${target.full_name || 'there'},`,
          '',
          `${caller.full_name} reset your Scorr authenticator because the previous app could not be used.`,
          '',
          'Sign in at https://scorr.walfia.ai with your password. You will see a new QR code. Add it in Google Authenticator or Authy, then enter the 6-digit code.',
          '',
          'If you did not expect this, contact your administrator.',
          '',
          'Kind regards,',
          'The Scorr Team',
        ].join('\n'),
      );
    }

    return json(req, { ok: true, removed: factors.length });
  } catch (e) {
    console.error('[reset_authenticator]', e);
    return json(req, { error: 'Could not process this request.' }, 500);
  }
});
