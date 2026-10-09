#!/usr/bin/env node
/**
 * Background auto check-in via device token (no JWT). Rolled back.
 * Covers: valid token + office Wi-Fi + GPS in window → clock_in;
 * revoked/invalid token; fake body IP ignored; mobile data; outside radius;
 * second office network; after shift end; counts unchanged.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

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
const supabaseUrl = env.VITE_SUPABASE_URL || `https://${projectRef}.supabase.co`;
const anon = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';
const rawToken = `bg-tok-${randomBytes(16).toString('hex')}`;
const tokenHash = createHash('sha256').update(rawToken).digest('hex');

async function sql(query, readOnly = false) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 3000));
  return body;
}

const query = `
BEGIN;

CREATE TEMP TABLE bg_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO bg_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID;
  v_zone UUID;
  v_zone2 UUID;
  v_dev UUID;
  v_sfx TEXT := 'bg' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_ms BIGINT := (EXTRACT(EPOCH FROM v_now) * 1000)::BIGINT;
  v_office_lat DOUBLE PRECISION := 41.8781;
  v_office_lng DOUBLE PRECISION := -87.6298;
  v_in_lat DOUBLE PRECISION := 41.87815;
  v_in_lng DOUBLE PRECISION := -87.62985;
  v_out_lat DOUBLE PRECISION := 41.90;
  v_out_lng DOUBLE PRECISION := -87.70;
  v_start TIME;
  v_end TIME;
  v_att DATE;
  v_res JSONB;
  v_open INT;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('Bg Co '||v_sfx, 'bg-co-'||v_sfx, 'bg_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Bg Dept', 'bg-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_bg_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin Bg'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_bg_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp Bg','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true WHERE id=v_emp;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Bg Office', v_office_lat, v_office_lng, 150, true, v_company,
    ARRAY['OfficeWiFi','OfficeWiFi2'], ARRAY['aa:bb:cc:dd:ee:ff','11:22:33:44:55:66'],
    ARRAY['203.0.113.10/32','203.0.113.20/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_zone, 'Bg Office', v_office_lat, v_office_lng, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', '${tokenHash}', '1.3.11', 'left')
  RETURNING id INTO v_dev;

  v_att := (v_now AT TIME ZONE 'UTC')::date;
  v_start := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('Bg Shift', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  -- 1) No JWT: device token + office Wi-Fi public IP + GPS inside → clock_in
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms, v_ms, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(1, 'device token no JWT → clock_in',
    (v_res->>'action') = 'clock_in', v_res::text);

  -- 2) Still works after "logout" (token unchanged, second ping already_checked_in)
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 1000, v_ms + 1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(2, 'after logout token still accepted',
    (v_res->>'action') IN ('already_checked_in','already_clocked_in','clock_in'),
    v_res::text);

  -- 3) Revoked token
  UPDATE public.attendance_devices SET revoked_at = v_now WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 2000, v_ms + 2000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(3, 'revoked token rejected',
    (v_res->>'ok') = 'false'
      AND ((v_res->>'reason') ILIKE '%revok%' OR (v_res->>'reason') ILIKE '%token%' OR (v_res->>'stop_tracking') = 'true'),
    v_res::text);
  UPDATE public.attendance_devices SET revoked_at = NULL WHERE id = v_dev;

  -- 4) Invalid token hash
  v_res := public.process_auto_attendance_event(
    repeat('ab', 32), 'ping', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 3000, v_ms + 3000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(4, 'invalid token rejected',
    (v_res->>'ok') = 'false', v_res::text);

  -- checkout so further check-in tests apply
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 4000, v_ms + 4000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;

  -- 5) Fake body IP ignored: client_ip from trusted header param wins (mobile IP → reject)
  --    Even if SSID claims office Wi-Fi, public IP 8.8.8.8 is not office.
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 5000, v_ms + 5000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '8.8.8.8'
  );
  PERFORM pg_temp.tassert(5, 'fake/non-office public IP rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network','wrong_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','not_on_office_network','wrong_network','fake_hotspot_suspected'),
    v_res::text);

  -- 6) Mobile data (no wifi identity + non-office IP)
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    NULL, NULL,
    v_ms + 6000, v_ms + 6000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '8.8.8.8'
  );
  PERFORM pg_temp.tassert(6, 'mobile data rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network','wrong_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','not_on_office_network','wrong_network','fake_hotspot_suspected'),
    v_res::text);

  -- 7) Office Wi-Fi + outside radius → no check-in (use ping = presence check)
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 6*60*1000, v_ms + 6*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  SELECT count(*)::int INTO v_open FROM attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(7, 'office Wi-Fi outside radius rejected',
    v_open = 0
      AND (v_res->>'action') IS DISTINCT FROM 'clock_in'
      AND (
        (v_res->>'action') IN ('outside_radius','outside_office','no_open_visit')
        OR (v_res->>'reason') IN ('outside_radius','outside_office')
      ),
    format('open=%s %s', v_open, v_res::text));

  -- 8) Second office network IP OK (past 5m duplicate window)
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi2', '11:22:33:44:55:66',
    v_ms + 12*60*1000, v_ms + 12*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.20'
  );
  PERFORM pg_temp.tassert(8, 'second office network OK',
    (v_res->>'action') = 'clock_in', v_res::text);

  -- checkout for shift-end test
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi2', '11:22:33:44:55:66',
    v_ms + 13*60*1000, v_ms + 13*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.20'
  );
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;

  -- 9) After shift end → rejected
  UPDATE public.work_shifts
  SET start_time = ((v_now - INTERVAL '6 hours') AT TIME ZONE 'UTC')::time,
      end_time = ((v_now - INTERVAL '1 hour') AT TIME ZONE 'UTC')::time
  WHERE id = v_shift;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 14*60*1000, v_ms + 14*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.11', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(9, 'after shift end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended','outside_window')
      OR (v_res->>'reason') IN ('checkin_blocked_shift_ended','outside_window'),
    v_res::text);

  SELECT count(*)::int INTO v_open FROM attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(10, 'no open record after shift-end reject', v_open = 0, v_open::text);

  -- Restore an in-window shift, then refuse a 20-minute-old queued event.
  UPDATE public.work_shifts
  SET start_time = ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
      end_time = ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time
  WHERE id = v_shift;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms - 20*60*1000, v_ms, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(11, 'stale 20m event refused',
    (v_res->>'reason') = 'event_too_old' OR (v_res->>'action') = 'event_too_old',
    v_res::text);
END;
$test$;

SELECT ord, name, status, left(detail, 220) AS detail FROM bg_results ORDER BY ord;
ROLLBACK;
`;

const before = await sql(
  `SELECT
  (SELECT count(*)::int FROM attendance_records) AS records,
  (SELECT count(*)::int FROM attendance_visit_segments) AS visits`,
  true,
);
console.log('Project', projectRef);

// Apply realtime migration (idempotent)
const mig = readFileSync(
  resolve(root, 'supabase/migrations/attendance_device_signal_realtime_2026-10-09.sql'),
  'utf8',
);
await sql(mig);

const rows = await sql(query);
for (const row of rows) {
  console.log(`${row.status}\t${row.name} — ${row.detail || ''}`);
}
const failed = rows.filter((r) => r.status === 'FAIL').length;

// Edge: device token only (no Authorization JWT) — live HTTP against production function.
let edgeOk = false;
let edgeDetail = '';
if (anon) {
  try {
    // Use a throwaway invalid token — expect 401 missing/invalid without needing a live fixture.
    const res = await fetch(`${supabaseUrl}/functions/v1/auto-attendance-event`, {
      method: 'POST',
      headers: {
        apikey: anon,
        'Content-Type': 'application/json',
        'x-device-token': 'definitely-not-a-valid-device-token',
      },
      body: JSON.stringify({
        device_token: 'definitely-not-a-valid-device-token',
        event: 'ping',
        // body IP must be ignored by edge (trusted headers only)
        client_ip: '203.0.113.10',
        public_ip: '203.0.113.10',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    edgeOk = res.status === 401 || json?.ok === false || json?.stop_tracking === true || json?.reason;
    edgeDetail = `HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`;
  } catch (e) {
    edgeDetail = String(e);
  }
} else {
  edgeDetail = 'no anon key — skipped';
  edgeOk = true;
}
console.log(`${edgeOk ? 'PASS' : 'FAIL'}\tedge no-JWT accepts device-token auth path — ${edgeDetail}`);

const after = await sql(
  `SELECT
  (SELECT count(*)::int FROM attendance_records) AS records,
  (SELECT count(*)::int FROM attendance_visit_segments) AS visits`,
  true,
);
console.log(
  `records ${before[0].records}->${after[0].records} visits ${before[0].visits}->${after[0].visits}`,
);
const countsOk = before[0].records === after[0].records && before[0].visits === after[0].visits;
console.log(`${countsOk ? 'PASS' : 'FAIL'}\tattendance_records/visit_segments counts unchanged`);

const totalFail = failed + (edgeOk ? 0 : 1) + (countsOk ? 0 : 1);
const total = rows.length + 2;
console.log(`\n${total - totalFail} PASS / ${totalFail} FAIL / ${total} total`);
process.exit(totalFail ? 1 : 0);
