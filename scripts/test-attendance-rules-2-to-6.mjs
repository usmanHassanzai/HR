#!/usr/bin/env node
/**
 * Rules 2–6 verification via real RPC entry points (rolled back).
 * Usage: SUPABASE_PROJECT_REF=yvnbxweitelowucdhwpg node scripts/test-attendance-rules-2-to-6.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
const phoneHash = createHash('sha256').update(`r256-phone-${Date.now()}`).digest('hex');
const laptopHash = createHash('sha256').update(`r256-laptop-${Date.now()}`).digest('hex');

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query }),
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

CREATE TEMP TABLE r256_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO r256_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

CREATE OR REPLACE FUNCTION pg_temp.as_emp(p_uid uuid, p_ip text DEFAULT '203.0.113.10')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.headers', json_build_object('cf-connecting-ip', p_ip)::text, true);
END;
$a$;

CREATE OR REPLACE FUNCTION pg_temp.reset_day(p_uid uuid)
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  DELETE FROM public.attendance_events_log WHERE user_id = p_uid;
  DELETE FROM public.attendance_visit_segments WHERE user_id = p_uid;
  DELETE FROM public.attendance_records WHERE user_id = p_uid;
  UPDATE public.attendance_devices SET presence_state = 'left', gps_outside_streak = 0 WHERE user_id = p_uid;
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
  v_dev_phone UUID;
  v_dev_laptop UUID;
  v_sfx TEXT := 'r256' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
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
  v_out TIMESTAMPTZ;
  v_notes TEXT;
  v_n INTEGER;
  v_presence TEXT;
  v_end_ts TIMESTAMPTZ;
  v_ok BOOLEAN;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('R256 Co '||v_sfx, 'r256-co-'||v_sfx, 'r256_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('R256 Dept', 'r256-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_r256_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin R256'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_r256_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp R256','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true WHERE id=v_emp;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'R256 Office', v_office_lat, v_office_lng, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_zone, 'R256 Office', v_office_lat, v_office_lng, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', '${phoneHash}', '1.3.9', 'left')
  RETURNING id INTO v_dev_phone;
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state)
  VALUES (v_emp, v_company, 'laptop-'||v_sfx, 'windows', '${laptopHash}', '1.3.9', 'left')
  RETURNING id INTO v_dev_laptop;

  --------------------------------------------------------------------------
  -- Rule 2: 59 min before start OK; 61 min before rejected; checkout in early hour OK
  --------------------------------------------------------------------------
  v_end_ts := v_now + INTERVAL '59 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_start := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_end := ((v_end_ts + INTERVAL '8 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Early', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(1, 'R2 check-in 59m before start OK',
    (v_res->>'action') = 'clock_in', v_res::text);

  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_out', false);
  PERFORM pg_temp.tassert(2, 'R2 check-out in pre-start hour OK',
    (v_res->>'action') = 'clock_out', v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  v_end_ts := v_now + INTERVAL '61 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_start := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_end := ((v_end_ts + INTERVAL '8 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 TooEarly', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(3, 'R2 check-in 61m before start rejected',
    (v_res->>'action') = 'outside_window', v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Rule 3: check-in at shift end + 1 min rejected on every path
  --------------------------------------------------------------------------
  v_end_ts := v_now - INTERVAL '1 minute';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := ((v_end_ts - INTERVAL '8 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN
    v_att := ((v_end_ts - INTERVAL '8 hours') AT TIME ZONE 'UTC')::date;
  END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Ended', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', (v_start > v_end))
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(4, 'R3 geo check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff', v_ms, v_ms, 'UTC', false,
    'phone-'||v_sfx, 'android', '1.3.9', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(5, 'R3 auto phone check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${laptopHash}', 'ping', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff', v_ms, v_ms, 'UTC', false,
    'laptop-'||v_sfx, 'windows', '1.3.9', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(6, 'R3 auto laptop check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

  -- manual Leave-panel path uses process_geo clock_in (same as geo)
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(7, 'R3 manual check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Rule 4: checkout end+59 OK; end+61 rejected
  --------------------------------------------------------------------------
  -- Open a mid-shift visit first with a shift that ends 59m ago
  v_end_ts := v_now - INTERVAL '59 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := ((v_end_ts - INTERVAL '6 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_att := ((v_end_ts - INTERVAL '6 hours') AT TIME ZONE 'UTC')::date; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Out59', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', (v_start > v_end))
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  -- Seed open visit (system write mode) so we test check-out window only
  PERFORM set_config('scorr.attendance_write_mode', 'admin_correction', true);
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_in_lat, clock_in_lng,
    attendance_source, shift_id, presence_method
  ) VALUES (
    v_emp, v_att, 'present', 'approved', v_end_ts - INTERVAL '3 hours', v_in_lat, v_in_lng,
    'manual', v_shift, 'wifi'
  );
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_date, visit_number, clock_in_at, clock_in_lat, clock_in_lng
  ) VALUES (v_emp, v_att, 1, v_end_ts - INTERVAL '3 hours', v_in_lat, v_in_lng);
  PERFORM set_config('scorr.attendance_write_mode', 'normal', true);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  BEGIN
    PERFORM public.check_out_attendance(NULL, v_in_lat, v_in_lng, 20, false);
    PERFORM pg_temp.tassert(8, 'R4 manual checkout at end+59 OK', true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert(8, 'R4 manual checkout at end+59 OK', false, SQLERRM);
  END;

  -- Re-seed for auto path
  PERFORM set_config('scorr.attendance_write_mode', 'admin_correction', true);
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp;
  UPDATE public.attendance_devices SET presence_state = 'present' WHERE id = v_dev_phone;
  PERFORM set_config('scorr.attendance_write_mode', 'normal', true);

  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff', v_ms, v_ms, 'UTC', false,
    'phone-'||v_sfx, 'android', '1.3.9', '203.0.113.10'
  );
  -- At end+59, outside reading should still be allowed (checkout window)
  PERFORM pg_temp.tassert(9, 'R4 auto checkout at end+59 OK',
    (v_res->>'action') IN ('clock_out', 'already_checked_out')
    OR EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND clock_out_at IS NOT NULL),
    v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  -- end + 61: outside window
  v_end_ts := v_now - INTERVAL '61 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := ((v_end_ts - INTERVAL '6 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_att := ((v_end_ts - INTERVAL '6 hours') AT TIME ZONE 'UTC')::date; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Out61', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', (v_start > v_end))
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM set_config('scorr.attendance_write_mode', 'admin_correction', true);
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_in_lat, clock_in_lng,
    attendance_source, shift_id, presence_method
  ) VALUES (
    v_emp, v_att, 'present', 'approved', v_end_ts - INTERVAL '3 hours', v_in_lat, v_in_lng,
    'manual', v_shift, 'wifi'
  );
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_date, visit_number, clock_in_at
  ) VALUES (v_emp, v_att, 1, v_end_ts - INTERVAL '3 hours');
  PERFORM set_config('scorr.attendance_write_mode', 'normal', true);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  BEGIN
    PERFORM public.check_out_attendance(NULL, v_in_lat, v_in_lng, 20, false);
    PERFORM pg_temp.tassert(10, 'R4 manual checkout at end+61 rejected', false, 'should reject');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert(10, 'R4 manual checkout at end+61 rejected',
      SQLERRM ILIKE '%outside_window%', SQLERRM);
  END;

  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_out', false);
  PERFORM pg_temp.tassert(11, 'R4 geo checkout at end+61 rejected',
    (v_res->>'action') = 'outside_window', v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Rule 5: outside on office Wi-Fi → immediate checkout (geo + auto)
  --------------------------------------------------------------------------
  v_att := (v_now AT TIME ZONE 'UTC')::date;
  v_start := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_start := TIME '00:00'; v_end := TIME '23:30'; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 R5', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(12, 'R5 setup check-in', (v_res->>'action') = 'clock_in', v_res::text);

  -- inside reading stays checked in
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'auto', false);
  PERFORM pg_temp.tassert(13, 'R5 inside reading stays checked in',
    (v_res->>'action') IN ('already_clocked_in', 'none', 'clock_in'),
    v_res::text);
  PERFORM pg_temp.tassert(14, 'R5 still open after inside ping',
    EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND clock_out_at IS NULL), '');

  -- accuracy 150 outside ignored (no checkout)
  v_res := public.process_geo_attendance_ping(v_out_lat, v_out_lng, 150, 'auto', false);
  PERFORM pg_temp.tassert(15, 'R5 accuracy 150 outside ignored',
    EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND clock_out_at IS NULL),
    v_res::text);

  -- usable outside on office wifi → checkout
  UPDATE public.attendance_devices SET presence_state = 'present' WHERE user_id = v_emp;
  v_res := public.process_geo_attendance_ping(v_out_lat, v_out_lng, 20, 'auto', false);
  SELECT clock_out_at, notes INTO v_out, v_notes FROM attendance_records WHERE user_id = v_emp;
  SELECT string_agg(DISTINCT presence_state, ',') INTO v_presence FROM attendance_devices WHERE user_id = v_emp;
  PERFORM pg_temp.tassert(16, 'R5 geo outside on Wi-Fi checks out',
    (v_res->>'action') = 'clock_out' AND v_out IS NOT NULL, v_res::text);
  PERFORM pg_temp.tassert(17, 'R5 geo checkout note Left the office radius',
    COALESCE(v_notes,'') ILIKE '%Left the office radius%' OR COALESCE(v_notes,'') ILIKE '%outside office radius%',
    COALESCE(v_notes,''));
  PERFORM pg_temp.tassert(18, 'R5 geo devices not present',
    v_presence IS NULL OR v_presence NOT ILIKE '%present%', COALESCE(v_presence,''));

  -- auto path
  PERFORM pg_temp.reset_day(v_emp);
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  UPDATE public.attendance_devices SET presence_state = 'present' WHERE user_id = v_emp;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'exit', v_zone, v_out_lat, v_out_lng, 25,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff', v_ms, v_ms, 'UTC', false,
    'phone-'||v_sfx, 'android', '1.3.9', '203.0.113.10'
  );
  SELECT clock_out_at, notes INTO v_out, v_notes FROM attendance_records WHERE user_id = v_emp;
  SELECT string_agg(DISTINCT presence_state, ',') INTO v_presence FROM attendance_devices WHERE user_id = v_emp;
  PERFORM pg_temp.tassert(19, 'R5 auto outside on Wi-Fi checks out',
    (v_res->>'action') = 'clock_out' AND v_out IS NOT NULL, v_res::text);
  PERFORM pg_temp.tassert(20, 'R5 auto checkout note',
    COALESCE(v_notes,'') ILIKE '%Left the office radius%' OR COALESCE(v_notes,'') ILIKE '%outside office radius%',
    COALESCE(v_notes,''));
  PERFORM pg_temp.tassert(21, 'R5 auto devices not present',
    v_presence IS NULL OR v_presence NOT ILIKE '%present%', COALESCE(v_presence,''));

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Rule 6: real close at end+1h, out = shift END, note Shift ended
  --------------------------------------------------------------------------
  v_end_ts := v_now - INTERVAL '90 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := ((v_end_ts - INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_att := ((v_end_ts - INTERVAL '4 hours') AT TIME ZONE 'UTC')::date; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 R6', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', (v_start > v_end))
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM set_config('scorr.attendance_write_mode', 'admin_correction', true);
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_in_lat, clock_in_lng,
    attendance_source, shift_id, presence_method
  ) VALUES (
    v_emp, v_att, 'present', 'approved', v_end_ts - INTERVAL '2 hours', v_in_lat, v_in_lng,
    'manual', v_shift, 'wifi'
  );
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_date, visit_number, clock_in_at
  ) VALUES (v_emp, v_att, 1, v_end_ts - INTERVAL '2 hours');
  UPDATE public.attendance_devices SET presence_state = 'present' WHERE user_id = v_emp;
  PERFORM set_config('scorr.attendance_write_mode', 'normal', true);

  v_n := public.attendance_close_ended_windows();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM attendance_records WHERE user_id = v_emp;
  PERFORM pg_temp.tassert(22, 'R6 cron closer closes visit',
    v_n >= 1 AND v_out IS NOT NULL AND abs(EXTRACT(EPOCH FROM (v_out - v_end_ts))) < 120
    AND COALESCE(v_notes,'') ILIKE '%Shift ended%',
    format('n=%s out=%s end=%s notes=%s', v_n, v_out, v_end_ts, v_notes));

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.shift_display_zones WHERE shift_id = v_shift;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Overnight: Rule 2 (59 before) + Rule 3 (after end)
  --------------------------------------------------------------------------
  -- Overnight shift: start = now+59m wall, end morning next day — use start in evening
  -- Simpler overnight: start 22:00 end 06:00, probe with frozen relative ends
  -- Use shift that started yesterday evening and ends now-1m (overnight ended)
  v_end_ts := v_now - INTERVAL '1 minute';
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := TIME '22:00';
  v_att := ((v_end_ts - INTERVAL '1 day') AT TIME ZONE 'UTC')::date;
  -- If end time is after 22:00 same day, adjust
  IF v_end > TIME '12:00' THEN
    -- daytime end; build classic overnight: start yesterday 22:00, end today end_ts time
    NULL;
  END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Overnight', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', true)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(23, 'Overnight R3 check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  -- Overnight Rule 2: 59m before overnight start
  v_end_ts := v_now + INTERVAL '59 minutes';
  v_start := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_end := TIME '06:00';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 ON Early', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', true)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(24, 'Overnight R2 check-in 59m before start OK',
    (v_res->>'action') = 'clock_in', v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- Two-clock: Rule 2 + Rule 3 using display zone later end
  --------------------------------------------------------------------------
  v_end_ts := v_now + INTERVAL '59 minutes';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_start := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_end := ((v_end_ts + INTERVAL '6 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 Dual', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.shift_display_zones (shift_id, timezone, entered_start_time, entered_end_time)
  VALUES (v_shift, 'UTC', v_start, v_end);
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(25, 'Two-clock R2 check-in 59m before OK',
    (v_res->>'action') = 'clock_in', v_res::text);

  PERFORM pg_temp.reset_day(v_emp);
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.shift_display_zones WHERE shift_id = v_shift;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  -- Two-clock after latest end
  v_end_ts := v_now - INTERVAL '1 minute';
  v_att := (v_end_ts AT TIME ZONE 'UTC')::date;
  v_end := (v_end_ts AT TIME ZONE 'UTC')::time;
  v_start := ((v_end_ts - INTERVAL '5 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_att := ((v_end_ts - INTERVAL '5 hours') AT TIME ZONE 'UTC')::date; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('R256 DualEnd', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', (v_start > v_end))
  RETURNING id INTO v_shift;
  INSERT INTO public.shift_display_zones (shift_id, timezone, entered_start_time, entered_end_time)
  VALUES (
    v_shift, 'UTC',
    ((v_end_ts - INTERVAL '5 hours') AT TIME ZONE 'UTC')::time,
    (v_end_ts AT TIME ZONE 'UTC')::time
  );
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(26, 'Two-clock R3 check-in after end rejected',
    (v_res->>'action') IN ('checkin_blocked_shift_ended', 'outside_window'), v_res::text);

END;
$test$;

SELECT ord, name, status, detail FROM r256_results ORDER BY ord;
ROLLBACK;
`;

async function main() {
  console.log('Project', projectRef);
  const result = await sql(query);
  const rows = Array.isArray(result) ? result : [];
  if (!rows.length) {
    console.log('RAW', JSON.stringify(result, null, 2).slice(0, 5000));
    process.exit(2);
  }
  let fail = 0;
  for (const row of rows) {
    const st = row.status || row.STATUS;
    const name = row.name || row.NAME;
    const detail = row.detail || row.DETAIL || '';
    console.log(`${st}\t${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
    if (st === 'FAIL') fail += 1;
  }
  console.log(`\n${rows.length - fail} PASS / ${fail} FAIL / ${rows.length} total`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
