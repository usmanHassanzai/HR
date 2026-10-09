#!/usr/bin/env node
/**
 * Wi-Fi-only check-in when GPS off/unusable. Rolled back.
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
const rawToken = `wng-${randomBytes(12).toString('hex')}`;
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
CREATE TEMP TABLE wng_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO wng_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID; v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID; v_zone UUID;
  v_sfx TEXT := 'wng' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_ms BIGINT := (EXTRACT(EPOCH FROM v_now) * 1000)::BIGINT;
  v_office_lat DOUBLE PRECISION := 41.8781;
  v_office_lng DOUBLE PRECISION := -87.6298;
  v_in_lat DOUBLE PRECISION := 41.87815;
  v_in_lng DOUBLE PRECISION := -87.62985;
  v_out_lat DOUBLE PRECISION := 41.90;
  v_out_lng DOUBLE PRECISION := -87.70;
  v_start TIME; v_end TIME; v_att DATE;
  v_res JSONB; v_chk RECORD; v_src TEXT; v_n INT;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('Wng Co '||v_sfx, 'wng-co-'||v_sfx, 'wng_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Wng Dept', 'wng-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_wng_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_wng_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true WHERE id=v_emp;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Wng Office', v_office_lat, v_office_lng, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_zone, 'Wng Office', v_office_lat, v_office_lng, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', '${tokenHash}', '1.3.12', 'left');

  v_att := (v_now AT TIME ZONE 'UTC')::date;
  v_start := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('Wng Shift', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  -- Shared check: office IP + no GPS → ok wifi_no_gps
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, NULL, NULL, NULL, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert(1, 'shared: office IP no GPS → wifi_no_gps',
    v_chk.ok AND v_chk.match_kind = 'wifi_no_gps', row_to_json(v_chk)::text);

  -- Shared: office IP + GPS inside → wifi_gps
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_in_lat, v_in_lng, 20, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert(2, 'shared: office IP + inside GPS → wifi_gps',
    v_chk.ok AND v_chk.match_kind = 'wifi_gps', row_to_json(v_chk)::text);

  -- Shared: office IP + usable GPS outside → reject
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_out_lat, v_out_lng, 20, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert(3, 'shared: office IP + outside GPS → outside_radius',
    NOT v_chk.ok AND v_chk.reason = 'outside_radius', row_to_json(v_chk)::text);

  -- Shared: mobile data + no GPS
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, NULL, NULL, NULL, false, '8.8.8.8', 'check_in'
  );
  PERFORM pg_temp.tassert(4, 'shared: mobile data no GPS rejected',
    NOT v_chk.ok AND v_chk.reason = 'not_on_office_wifi', row_to_json(v_chk)::text);

  -- Shared: accuracy 150 + office IP → wifi_no_gps
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_in_lat, v_in_lng, 150, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert(5, 'shared: accuracy 150 → wifi_no_gps',
    v_chk.ok AND v_chk.match_kind = 'wifi_no_gps', row_to_json(v_chk)::text);

  -- Shared: mock rejected
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_in_lat, v_in_lng, 20, true, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert(6, 'shared: mock rejected',
    NOT v_chk.ok, row_to_json(v_chk)::text);

  -- Auto: office IP + location off → clock_in auto_wifi_no_gps
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms, v_ms, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  SELECT attendance_source INTO v_src FROM attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(7, 'auto: office IP no GPS → auto_wifi_no_gps',
    (v_res->>'action') = 'clock_in' AND v_src = 'auto_wifi_no_gps',
    format('src=%s %s', v_src, v_res::text));

  -- Checkout via outside GPS
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 6*60*1000, v_ms + 6*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(8, 'outside GPS check-out still works',
    (v_res->>'action') = 'clock_out', v_res::text);
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;

  -- Auto: office IP + GPS inside
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 7*60*1000, v_ms + 7*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  SELECT attendance_source INTO v_src FROM attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(9, 'auto: office IP + inside GPS → auto_wifi',
    (v_res->>'action') = 'clock_in' AND v_src = 'auto_wifi',
    format('src=%s %s', v_src, v_res::text));

  -- Checkout again
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    NULL, NULL,
    v_ms + 8*60*1000, v_ms + 8*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;

  -- Auto: office IP + outside GPS rejected
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 9*60*1000, v_ms + 9*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(10, 'auto: office IP + outside GPS rejected',
    (v_res->>'action') IN ('outside_radius','no_open_visit')
      OR (v_res->>'reason') = 'outside_radius',
    v_res::text);

  -- Mobile data + location off
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, NULL, NULL, NULL,
    NULL, NULL,
    v_ms + 10*60*1000, v_ms + 10*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '8.8.8.8'
  );
  PERFORM pg_temp.tassert(11, 'mobile data + no GPS rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','wrong_network'),
    v_res::text);

  -- Mobile data + inside GPS (clear dup window)
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    NULL, NULL,
    v_ms + 17*60*1000, v_ms + 17*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '8.8.8.8'
  );
  PERFORM pg_temp.tassert(12, 'mobile data + inside GPS rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','wrong_network'),
    v_res::text);

  -- Mock
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 12*60*1000, v_ms + 12*60*1000, 'UTC', true, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(13, 'mock rejected',
    (v_res->>'ok') = 'false' AND ((v_res->>'reason') ILIKE '%mock%' OR (v_res->>'flagged') = 'true'),
    v_res::text);

  -- Accuracy 150 + office IP → no_gps check-in
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, v_in_lat, v_in_lng, 150,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 13*60*1000, v_ms + 13*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  SELECT attendance_source INTO v_src FROM attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(14, 'accuracy 150 → auto_wifi_no_gps',
    (v_res->>'action') = 'clock_in' AND v_src = 'auto_wifi_no_gps',
    format('src=%s %s', v_src, v_res::text));

  -- Laptop no GPS
  UPDATE public.attendance_records SET clock_out_at = v_now WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE public.attendance_visit_segments SET clock_out_at = v_now WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE public.attendance_devices SET platform = 'windows', device_id = 'laptop-'||v_sfx WHERE user_id = v_emp;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'power_on', v_zone, NULL, NULL, NULL,
    NULL, NULL,
    v_ms + 14*60*1000, v_ms + 14*60*1000, 'UTC', false, 'laptop-'||v_sfx, 'windows', '1.3.12', '203.0.113.10'
  );
  SELECT attendance_source INTO v_src FROM attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(15, 'laptop office IP no GPS → checked in',
    (v_res->>'action') = 'clock_in' AND v_src = 'auto_wifi_no_gps',
    format('src=%s %s', v_src, v_res::text));

  -- After shift end rejected
  UPDATE public.attendance_records SET clock_out_at = v_now WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE public.attendance_visit_segments SET clock_out_at = v_now WHERE user_id = v_emp AND clock_out_at IS NULL;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  UPDATE public.work_shifts
  SET start_time = ((v_now - INTERVAL '6 hours') AT TIME ZONE 'UTC')::time,
      end_time = ((v_now - INTERVAL '1 hour') AT TIME ZONE 'UTC')::time
  WHERE id = v_shift;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_zone, NULL, NULL, NULL,
    NULL, NULL,
    v_ms + 15*60*1000, v_ms + 15*60*1000, 'UTC', false, 'laptop-'||v_sfx, 'windows', '1.3.12', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(16, 'after shift end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended','outside_window')
      OR (v_res->>'reason') IN ('checkin_blocked_shift_ended','outside_window'),
    v_res::text);

  -- Wi-Fi-only stays present (re-open, no further events) — cron closer callable
  UPDATE public.work_shifts
  SET start_time = ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
      end_time = ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time
  WHERE id = v_shift;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  UPDATE public.attendance_devices SET platform = 'android', device_id = 'phone-'||v_sfx WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 16*60*1000, v_ms + 16*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.12', '203.0.113.10'
  );
  SELECT count(*)::int INTO v_n FROM attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(17, 'wifi-only stays present without further events',
    v_n = 1 AND (v_res->>'action') = 'clock_in', format('open=%s %s', v_n, v_res::text));

  -- Rule 6 closer still callable
  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  PERFORM pg_temp.tassert(18, 'Rule 6 cron closer callable', true, 'n='||COALESCE(v_n,0));
END;
$test$;

SELECT ord, name, status, left(detail, 220) AS detail FROM wng_results ORDER BY ord;
ROLLBACK;
`;

const before = await sql(
  `SELECT (SELECT count(*)::int FROM attendance_records) AS records,
          (SELECT count(*)::int FROM attendance_visit_segments) AS visits`,
  true,
);
console.log('Project', projectRef);
const rows = await sql(query);
for (const row of rows) {
  console.log(`${row.status}\t${row.name} — ${row.detail || ''}`);
}
const failed = rows.filter((r) => r.status === 'FAIL').length;
const after = await sql(
  `SELECT (SELECT count(*)::int FROM attendance_records) AS records,
          (SELECT count(*)::int FROM attendance_visit_segments) AS visits`,
  true,
);
console.log(
  `records ${before[0].records}->${after[0].records} visits ${before[0].visits}->${after[0].visits}`,
);
const countsOk = before[0].records === after[0].records && before[0].visits === after[0].visits;
console.log(`${countsOk ? 'PASS' : 'FAIL'}\tcounts unchanged`);
console.log(`\n${rows.length + 1 - failed - (countsOk ? 0 : 1)} PASS / ${failed + (countsOk ? 0 : 1)} FAIL`);
process.exit(failed || !countsOk ? 1 : 0);
