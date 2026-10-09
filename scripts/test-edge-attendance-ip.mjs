#!/usr/bin/env node
/**
 * Prove auto-attendance-event uses request headers for IP, ignores body fake IP.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, process.env.ENV_FILE || '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const pat = env.SUPABASE_PAT || env.SUPABASE_ACCESS_TOKEN || env.SCORR_SUPABASE_PAT;
const projectRef = process.env.SUPABASE_PROJECT_REF || 'yvnbxweitelowucdhwpg';
const url = env.VITE_SUPABASE_URL;
const anon = env.VITE_SUPABASE_ANON_KEY;
const tokenPlain = `edge-ip-${Date.now()}`;
const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  const body = JSON.parse(text);
  if (!r.ok) throw new Error(JSON.stringify(body).slice(0, 2000));
  return body;
}

async function main() {
  const sfx = randomUUID().slice(0, 8);
  const admin = randomUUID();
  const emp = randomUUID();

  // Setup disposable enrollment (committed briefly, cleaned at end)
  await sql(`
DO $$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_shift UUID;
  v_zone UUID;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att DATE := (v_now AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('EdgeIP ${sfx}', 'edge-ip-${sfx}', 'edge_${sfx}@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('EdgeIP', 'edge-ip-d-${sfx}', v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', '${admin}'::uuid, 'authenticated', 'authenticated',
    'admin_edge_${sfx}@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin Edge'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '${emp}'::uuid, 'authenticated', 'authenticated',
    'emp_edge_${sfx}@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp Edge','manager_id','${admin}'::uuid),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id='${admin}'::uuid;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept, manager_id='${admin}'::uuid,
    work_mode='office', auto_phone_attendance=true WHERE id='${emp}'::uuid;

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('EdgeIP Shift', ((v_now - interval '1 hour') at time zone 'UTC')::time,
          ((v_now + interval '6 hours') at time zone 'UTC')::time,
          ARRAY[1,2,3,4,5,6,7], 0, true, '${admin}'::uuid, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES ('${emp}'::uuid, v_shift, v_att - 7, '${admin}'::uuid);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'EdgeIP Office', 41.8781, -87.6298, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled)
  VALUES ('${emp}'::uuid, v_zone, 'EdgeIP Office', 41.8781, -87.6298, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES ('${emp}'::uuid, v_company, 'edge-phone-${sfx}', 'android', '${tokenHash}', '1.3.9');
END $$;
`);

  const now = Date.now();
  const body = {
    device_token: tokenPlain,
    event: 'ping',
    latitude: 41.87815,
    longitude: -87.62985,
    accuracy_m: 20,
    ssid: 'OfficeWiFi',
    bssid: 'aa:bb:cc:dd:ee:ff',
    occurred_at_utc_ms: now,
    device_now_utc_ms: now,
    device_timezone: 'UTC',
    is_mock: false,
    device_id: `edge-phone-${sfx}`,
    platform: 'android',
    app_version: '1.3.9',
    // Fake client body IP — must be ignored by edge
    client_ip: '198.51.100.9',
    p_client_ip: '198.51.100.9',
  };

  const resFakeHeader = await fetch(`${url}/functions/v1/auto-attendance-event`, {
    method: 'POST',
    headers: {
      apikey: anon,
      'Content-Type': 'application/json',
      'x-device-token': tokenPlain,
      // Spoofed body IP above; header says office Wi-Fi IP
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    },
    body: JSON.stringify(body),
  });
  const jsonHeader = await resFakeHeader.json().catch(() => ({}));

  const log = await sql(`
    SELECT client_ip, reason_code, accepted, event, payload
    FROM public.attendance_events_log
    WHERE user_id = '${emp}'::uuid
    ORDER BY created_at DESC
    LIMIT 3
  `);

  console.log('=== Edge HTTP status ===', resFakeHeader.status);
  console.log('=== Edge response action ===', jsonHeader.action || jsonHeader.reason || jsonHeader);
  console.log('=== Latest event log client_ip (must be header 203.0.113.10, not body 198.51.100.9) ===');
  console.log(JSON.stringify(log, null, 2));

  const ip = log?.[0]?.client_ip || null;
  // Platform may rewrite X-Forwarded-For; body fake IP must never be stored.
  const bodyIgnored = ip !== '198.51.100.9' && ip != null;
  console.log(
    bodyIgnored
      ? `PASS\tEdge ignored body fake IP (stored client_ip=${ip})`
      : `FAIL\tbody fake IP leaked or missing (client_ip=${ip})`,
  );

  // Cleanup (order matters for FKs / check constraints)
  await sql(`
    DELETE FROM public.attendance_events_log WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.attendance_visit_segments WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.attendance_records WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.attendance_devices WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.employee_work_sites WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.employee_shift_assignments WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.employee_location_pings WHERE user_id = '${emp}'::uuid;
    DELETE FROM public.work_shifts WHERE manager_id = '${admin}'::uuid;
    DELETE FROM public.office_locations WHERE company_id = (SELECT company_id FROM public.users WHERE id='${emp}'::uuid);
    UPDATE public.users SET department_id = NULL, manager_id = NULL, role = 'admin'::public.user_role WHERE id = '${emp}'::uuid;
    DELETE FROM public.departments WHERE company_id = (SELECT company_id FROM public.users WHERE id='${emp}'::uuid);
    DELETE FROM public.users WHERE id IN ('${emp}'::uuid, '${admin}'::uuid);
    DELETE FROM auth.users WHERE id IN ('${emp}'::uuid, '${admin}'::uuid);
    DELETE FROM public.companies WHERE slug = 'edge-ip-${sfx}';
  `);

  process.exit(bodyIgnored ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
