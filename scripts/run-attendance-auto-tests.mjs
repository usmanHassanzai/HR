#!/usr/bin/env node
/**
 * Runs attendance auto tests with a FROZEN "now" inside one rolled-back transaction.
 * Does not persist schema or data changes (ROLLBACK at end).
 *
 * Usage: node scripts/run-attendance-auto-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const url = env.VITE_SUPABASE_URL;
const pat = env.SUPABASE_PAT;
const projectRef = new URL(url).hostname.split('.')[0];

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
  return body;
}

const FROZEN = '2026-10-06 15:00:00+00';

const setup = `
BEGIN;

CREATE OR REPLACE FUNCTION public.attendance_now()
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $f$
DECLARE v TEXT := nullif(current_setting('attendance.test_now', true), '');
BEGIN
  IF v IS NOT NULL THEN RETURN v::TIMESTAMPTZ; END IF;
  RETURN timezone('utc', now());
END;
$f$;

SELECT set_config('attendance.test_now', '${FROZEN}', true);
`;

async function patchAutoRpc() {
  const rows = await sql(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'process_auto_attendance_event'
    LIMIT 1
  `);
  let def = rows[0]?.def;
  if (!def) throw new Error('process_auto_attendance_event not found');
  // Normalize common now() patterns used in the live function
  def = def
    .replace(/timezone\('utc',\s*now\(\)\)/gi, 'public.attendance_now()')
    .replace(/timezone\('UTC',\s*now\(\)\)/gi, 'public.attendance_now()');
  if (!def.includes('attendance_now()')) {
    throw new Error('Could not patch process_auto_attendance_event to use attendance_now()');
  }
  return def;
}

const testBody = `
CREATE TEMP TABLE attendance_test_results (name text, status text, detail text);

CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO attendance_test_results VALUES (
    p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,'')
  );
END;
$a$;

DO $test$
DECLARE
  v_company_a UUID;
  v_company_b UUID;
  v_dept UUID;
  v_admin_a UUID := gen_random_uuid();
  v_hr UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_emp2 UUID := gen_random_uuid();
  v_shift UUID;
  v_zone UUID;
  v_win RECORD;
  v_corr RECORD;
  v_hash TEXT;
  v_hash2 TEXT;
  v_token TEXT := 'test-token-fixed-001';
  v_token2 TEXT := 'test-token-fixed-002';
  v_dev UUID;
  v_dev2 UUID;
  v_res JSONB;
  v_rec UUID;
  v_bal_before NUMERIC;
  v_bal_after NUMERIC;
  v_leave UUID;
  v_frozen TIMESTAMPTZ := '${FROZEN}'::TIMESTAMPTZ;
  v_ms BIGINT := (EXTRACT(EPOCH FROM '${FROZEN}'::TIMESTAMPTZ) * 1000)::BIGINT;
  v_early_ms BIGINT := (EXTRACT(EPOCH FROM '2026-10-06 11:50:00+00'::TIMESTAMPTZ) * 1000)::BIGINT;
  v_late_ms BIGINT := (EXTRACT(EPOCH FROM '2026-10-06 14:30:00+00'::TIMESTAMPTZ) * 1000)::BIGINT;
  v_ok BOOLEAN;
  v_err TEXT;
  v_sfx TEXT := 'fixtest1';
  v_hist_date DATE := '2026-09-01';
  v_hist_in TIMESTAMPTZ := '2026-09-01 14:00:00+00';
  v_hist_out TIMESTAMPTZ := '2026-09-01 18:00:00+00';
BEGIN
  PERFORM set_config('attendance.test_now', '${FROZEN}', true);

  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('SCORR_TEST_A_' || v_sfx, 'scorr-test-a-' || v_sfx, 'a_' || v_sfx || '@scorr.test', 'Asia/Karachi', true, true)
  RETURNING id INTO v_company_a;
  INSERT INTO public.companies (name, slug, contact_email, timezone)
  VALUES ('SCORR_TEST_B_' || v_sfx, 'scorr-test-b-' || v_sfx, 'b_' || v_sfx || '@scorr.test', 'Asia/Karachi')
  RETURNING id INTO v_company_b;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Test Dept ' || v_sfx, 'test-dept-' || v_sfx, v_company_a, true)
  RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin_a, 'authenticated', 'authenticated',
    'admin_a_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company_a,'full_name','Admin A'),
    v_frozen, v_frozen, '', '', '', '');

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_hr, 'authenticated', 'authenticated',
    'hr_a_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','hr','company_id',v_company_a,'full_name','HR A','manager_id',v_admin_a),
    v_frozen, v_frozen, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company_a,'department_id',v_dept,'full_name','Emp A','manager_id',v_admin_a),
    v_frozen, v_frozen, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp2, 'authenticated', 'authenticated',
    'emp2_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company_a,'department_id',v_dept,'full_name','Emp B','manager_id',v_admin_a),
    v_frozen, v_frozen, '', '', '', '');

  UPDATE public.users SET auto_phone_attendance = true, auto_laptop_attendance = true, work_mode = 'office',
    role = 'admin'::public.user_role, company_id = v_company_a WHERE id = v_admin_a;
  UPDATE public.users SET auto_phone_attendance = true, auto_laptop_attendance = true, work_mode = 'office',
    role = 'hr'::public.user_role, company_id = v_company_a, manager_id = v_admin_a WHERE id = v_hr;
  UPDATE public.users SET auto_phone_attendance = true, auto_laptop_attendance = true, work_mode = 'office',
    role = 'employee'::public.user_role, company_id = v_company_a, department_id = v_dept, manager_id = v_admin_a
    WHERE id IN (v_emp, v_emp2);

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight, is_demo)
  VALUES ('CT Test 8-5', '08:00', '17:00', ARRAY[1,2,3,4,5], 0, true, v_admin_a, 'America/Chicago', false, false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by, is_demo)
  VALUES (v_emp, v_shift, '2026-01-01', v_admin_a, false), (v_emp2, v_shift, '2026-01-01', v_admin_a, false);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Test Office ' || v_sfx, 41.8781, -87.6298, 150, true, v_company_a, false,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled, is_demo
  ) VALUES
    (v_emp, v_zone, 'Test Office', 41.8781, -87.6298, 150, true, false),
    (v_emp2, v_zone, 'Test Office', 41.8781, -87.6298, 150, true, false);

  v_hash := public.attendance_hash_device_token(v_token);
  v_hash2 := public.attendance_hash_device_token(v_token2);
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company_a, 'dev-a-' || v_sfx, 'android', v_hash, '1.4.0')
  RETURNING id INTO v_dev;
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company_a, 'dev-b-' || v_sfx, 'windows', v_hash2, '1.4.0')
  RETURNING id INTO v_dev2;

  -- Historical row (must stay untouched by later ops)
  INSERT INTO public.attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, clock_out_at, shift_id)
  VALUES (v_emp, v_hist_date, 'present', 'manual', v_hist_in, v_hist_out, v_shift);

  -- ========== R60 ==========
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 12:00:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R60 window open at start-60m', COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 11:59:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R60 window closed 61m early', NOT COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 23:00:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R60 window open at end+60m', COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 23:01:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R60 window closed after end+60m', NOT COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-10 15:00:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R60 Saturday closed', NOT COALESCE(v_win.in_window,false));

  -- ========== R61 ==========
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 12:10:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R61 Oct inside after open', COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-10-06 11:55:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R61 Oct still closed before open', NOT COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-11-02 12:30:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R61 Nov CST closed at 12:30Z', NOT COALESCE(v_win.in_window,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2026-11-02 13:10:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R61 Nov CST open at 13:10Z', COALESCE(v_win.in_window,false));
  SELECT * INTO v_corr FROM public.attendance_correct_occurred_at(v_ms, v_ms + 30*60*1000, v_frozen);
  PERFORM pg_temp.tassert('R61 skew >10m flagged', COALESCE(v_corr.clock_flagged,false));
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_emp, '2027-03-15 12:10:00+00'::TIMESTAMPTZ);
  PERFORM pg_temp.tassert('R61 Mar2027 DST open', COALESCE(v_win.in_window,false));

  -- ========== R62 ==========
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 enter clocks in', COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'action') = 'clock_in', v_res::text);

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 enter while checked in (no duplicate open)',
    COALESCE((v_res->>'ok')::boolean,false)
    AND (v_res->>'action') IN ('still_inside','already_in','heartbeat','noop','clock_in','duplicate_ignored'),
    v_res::text);

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms + 60*1000, v_ms + 60*1000, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 duplicate within 5 min ignored/no second visit',
    COALESCE((v_res->>'ok')::boolean,true),
    v_res::text);
  PERFORM pg_temp.tassert('R62 still one open visit after duplicate',
    (SELECT count(*) FROM attendance_visit_segments WHERE user_id=v_emp AND clock_out_at IS NULL) = 1);

  -- Late queued: occurred 30m before frozen now but still in W → event_too_old (>15m)
  v_res := public.process_auto_attendance_event(
    v_hash, 'ping', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_late_ms - 20*60*1000, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 late queued event (>15m) rejected',
    (v_res->>'reason') = 'event_too_old', v_res::text);

  -- Exit with no open visit (close first)
  UPDATE attendance_visit_segments SET clock_out_at = v_frozen, work_minutes = 1 WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE attendance_records SET clock_out_at = v_frozen WHERE user_id = v_emp AND attendance_date = '2026-10-06' AND clock_out_at IS NULL;
  UPDATE attendance_devices SET presence_state = 'left' WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    v_hash, 'exit', v_zone, 41.9, -87.7, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 exit with no open visit',
    (v_res->>'action') IN ('already_out','noop','still_outside','clock_out','presence_left_pending')
    OR NOT COALESCE((v_res->>'ok')::boolean,true),
    v_res::text);

  -- Re-enter then heartbeat timeout path via attendance_close_stale_presence if exists
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  UPDATE attendance_devices SET last_heartbeat_at = v_frozen - interval '20 minutes', last_presence_at = v_frozen - interval '20 minutes',
    presence_state = 'present' WHERE id = v_dev;
  BEGIN
    PERFORM public.attendance_set_write_context('cron');
    PERFORM public.attendance_close_stale_presence();
    v_ok := NOT EXISTS (
      SELECT 1 FROM attendance_visit_segments WHERE user_id = v_emp AND clock_out_at IS NULL
    );
    PERFORM pg_temp.tassert('R62 heartbeat timeout auto-closes', v_ok);
  EXCEPTION WHEN undefined_function THEN
    PERFORM pg_temp.tassert('R62 heartbeat timeout auto-closes', false, 'attendance_close_stale_presence missing');
  END;

  -- Auto close at W end
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  BEGIN
    PERFORM public.attendance_set_write_context('cron');
    PERFORM set_config('attendance.test_now', '2026-10-06 23:05:00+00', true);
    PERFORM public.attendance_close_ended_windows();
    PERFORM set_config('attendance.test_now', '${FROZEN}', true);
    v_ok := NOT EXISTS (
      SELECT 1 FROM attendance_visit_segments WHERE user_id = v_emp AND clock_out_at IS NULL
    );
    PERFORM pg_temp.tassert('R62 auto close at W end', v_ok);
  EXCEPTION WHEN undefined_function THEN
    PERFORM set_config('attendance.test_now', '${FROZEN}', true);
    PERFORM pg_temp.tassert('R62 auto close at W end', false, 'attendance_close_ended_windows missing');
  END;

  -- Multi-device check-out (clear event log so created_at-based 5m dedupe does not collide)
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  UPDATE attendance_visit_segments SET clock_out_at = COALESCE(clock_out_at, '${FROZEN}'::TIMESTAMPTZ)
    WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE attendance_records SET clock_out_at = COALESCE(clock_out_at, '${FROZEN}'::TIMESTAMPTZ)
    WHERE user_id = v_emp AND attendance_date = '2026-10-06' AND clock_out_at IS NULL;
  UPDATE attendance_devices SET presence_state = 'left' WHERE id IN (v_dev, v_dev2);
  PERFORM set_config('attendance.test_now', '2026-10-06 15:10:00+00', true);
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    (EXTRACT(EPOCH FROM '2026-10-06 15:10:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    (EXTRACT(EPOCH FROM '2026-10-06 15:10:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  -- Phone left; laptop power_off performs immediate multi-device check-out
  UPDATE attendance_devices SET presence_state = 'left' WHERE id = v_dev;
  DELETE FROM attendance_events_log WHERE user_id = v_emp AND event IN ('exit', 'power_off');
  PERFORM set_config('attendance.test_now', '2026-10-06 15:12:00+00', true);
  v_res := public.process_auto_attendance_event(
    v_hash2, 'power_off', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM '2026-10-06 15:12:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    (EXTRACT(EPOCH FROM '2026-10-06 15:12:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    'America/Chicago', false, 'dev-b-' || v_sfx, 'windows', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 multi-device check-out',
    (v_res->>'action') = 'clock_out'
    OR NOT EXISTS (SELECT 1 FROM attendance_visit_segments WHERE user_id = v_emp AND clock_out_at IS NULL),
    v_res::text);
  PERFORM set_config('attendance.test_now', '${FROZEN}', true);

  -- Wrong IP (wifi path) — ensure not blocked by 5m duplicate
  PERFORM set_config('attendance.test_now', '2026-10-06 15:20:00+00', true);
  v_res := public.process_auto_attendance_event(
    v_hash, 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM '2026-10-06 15:20:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    (EXTRACT(EPOCH FROM '2026-10-06 15:20:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R62 wrong IP rejected',
    NOT COALESCE((v_res->>'ok')::boolean,true)
    AND (v_res->>'reason') IN ('wrong_network','fake_hotspot_suspected','not_present'),
    v_res::text);

  -- Outside radius
  PERFORM set_config('attendance.test_now', '2026-10-06 15:25:00+00', true);
  UPDATE attendance_visit_segments SET clock_out_at = COALESCE(clock_out_at, '2026-10-06 15:24:00+00'::TIMESTAMPTZ)
    WHERE user_id = v_emp AND clock_out_at IS NULL;
  UPDATE attendance_records SET clock_out_at = COALESCE(clock_out_at, '2026-10-06 15:24:00+00'::TIMESTAMPTZ)
    WHERE user_id = v_emp AND attendance_date = '2026-10-06' AND clock_out_at IS NULL;
  UPDATE attendance_devices SET presence_state = 'left' WHERE id IN (v_dev, v_dev2);
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 42.5, -88.5, 10, NULL, NULL,
    (EXTRACT(EPOCH FROM '2026-10-06 15:25:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    (EXTRACT(EPOCH FROM '2026-10-06 15:25:00+00'::TIMESTAMPTZ)*1000)::BIGINT,
    'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R62 outside radius rejected',
    (v_res->>'action') IS DISTINCT FROM 'clock_in'
    AND (
      NOT COALESCE((v_res->>'ok')::boolean,true)
      OR (v_res->>'action') IN ('still_outside','outside_radius','noop','presence_left_pending','none','duplicate_ignored')
    ),
    v_res::text);
  PERFORM set_config('attendance.test_now', '${FROZEN}', true);

  UPDATE attendance_devices SET revoked_at = v_frozen WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    v_hash, 'ping', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 revoked token', (v_res->>'reason') = 'revoked_token', v_res::text);
  UPDATE attendance_devices SET revoked_at = NULL WHERE id = v_dev;

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', true, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R62 mock location', (v_res->>'reason') = 'mock_location', v_res::text);

  -- ========== R63 ==========
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_emp::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    SET LOCAL row_security = on;
    INSERT INTO public.attendance_records (user_id, attendance_date, status)
    VALUES (v_emp, '2026-10-08', 'present');
    RESET ROLE;
    PERFORM pg_temp.tassert('R63 direct insert as normal user denied', false, 'insert succeeded');
  EXCEPTION WHEN insufficient_privilege OR check_violation OR OTHERS THEN
    RESET ROLE;
    PERFORM pg_temp.tassert('R63 direct insert as normal user denied',
      SQLERRM ILIKE '%policy%' OR SQLERRM ILIKE '%permission%' OR SQLERRM ILIKE '%denied%' OR SQLSTATE = '42501',
      SQLERRM);
  END;

  -- correction without reason
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_hr::text, true);
    SELECT id INTO v_rec FROM attendance_records WHERE user_id = v_emp AND attendance_date = '2026-10-06' LIMIT 1;
    IF v_rec IS NULL THEN
      INSERT INTO attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, shift_id)
      VALUES (v_emp, '2026-10-06', 'present', 'manual', v_frozen - interval '1 hour', v_shift)
      RETURNING id INTO v_rec;
    END IF;
    v_ok := false;
    BEGIN
      PERFORM public.correct_attendance_times(v_rec, v_frozen - interval '2 hours', v_frozen, '', false);
      v_ok := false;
    EXCEPTION WHEN OTHERS THEN
      v_ok := (SQLERRM ILIKE '%reason%' OR SQLERRM ILIKE '%required%');
      v_err := SQLERRM;
    END;
    PERFORM pg_temp.tassert('R63 correction without reason denied', v_ok, COALESCE(v_err,''));
  END;

  -- supervisor day-status outside W allowed + audited
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_hr::text, true);
    PERFORM set_config('attendance.test_now', '2026-10-06 03:00:00+00', true); -- outside W
    BEGIN
      PERFORM public.mark_attendance(v_emp2, '2026-10-06', 'present');
      v_ok := true;
      v_err := '';
    EXCEPTION WHEN OTHERS THEN
      v_ok := false;
      v_err := SQLERRM;
    END;
    PERFORM set_config('attendance.test_now', '${FROZEN}', true);
    PERFORM pg_temp.tassert('R63 supervisor day-status outside W allowed', v_ok, v_err);
    PERFORM pg_temp.tassert('R63 supervisor day-status audited',
      EXISTS (SELECT 1 FROM attendance_corrections_audit WHERE target_user_id = v_emp2)
      OR EXISTS (SELECT 1 FROM attendance_records WHERE user_id = v_emp2 AND attendance_date = '2026-10-06' AND marked_by = v_hr),
      'marked_by/audit check');
  END;

  -- leave day → no clock times
  BEGIN
    PERFORM public.attendance_set_write_context('leave');
    PERFORM public.attendance_apply_leave_day(v_emp2, '2026-10-07', 'annual leave');
    SELECT clock_in_at IS NULL AND clock_out_at IS NULL
    INTO v_ok
    FROM attendance_records WHERE user_id = v_emp2 AND attendance_date = '2026-10-07';
    PERFORM pg_temp.tassert('R63 leave day no clock times', COALESCE(v_ok,false));
  EXCEPTION WHEN undefined_function THEN
    PERFORM pg_temp.tassert('R63 leave day no clock times', false, 'attendance_apply_leave_day missing');
  WHEN OTHERS THEN
    PERFORM pg_temp.tassert('R63 leave day no clock times', false, SQLERRM);
  END;

  -- historical untouched
  SELECT clock_in_at = v_hist_in AND clock_out_at = v_hist_out INTO v_ok
  FROM attendance_records WHERE user_id = v_emp AND attendance_date = v_hist_date;
  PERFORM pg_temp.tassert('R63 historical rows untouched', COALESCE(v_ok,false));

  -- Leave-review regression (balances preserved)
  BEGIN
    INSERT INTO leave_balances (user_id, year, annual_allowance, annual_used, sick_allowance, sick_used)
    VALUES (v_emp, 2026, 14, 2, 7, 0)
    ON CONFLICT (user_id, year) DO UPDATE SET annual_used = 2;
    SELECT annual_used INTO v_bal_before FROM leave_balances WHERE user_id = v_emp AND year = 2026;
    INSERT INTO leave_requests (id, user_id, start_date, end_date, status, leave_type, days_count, reason)
    VALUES (gen_random_uuid(), v_emp, '2026-10-20', '2026-10-20', 'pending', 'annual', 1, 'test')
    RETURNING id INTO v_leave;
    v_err := '';
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', v_hr::text, true);
      PERFORM public.review_leave_request(v_leave, false, 'not needed');
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    SELECT annual_used INTO v_bal_after FROM leave_balances WHERE user_id = v_emp AND year = 2026;
    PERFORM pg_temp.tassert('Leave-review balances preserved',
      v_bal_after IS NOT DISTINCT FROM v_bal_before AND v_err = '',
      format('before=%s after=%s err=%s', v_bal_before, v_bal_after, v_err));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert('Leave-review balances preserved', false, SQLERRM);
  END;

  -- R73 SQL: wrong client IP cannot satisfy office CIDR
  PERFORM pg_temp.tassert('R73 forged office IP value must not match when real IP differs',
    public.attendance_ip_in_cidrs('203.0.113.10', ARRAY['203.0.113.10/32'])
    AND NOT public.attendance_ip_in_cidrs('198.51.100.50', ARRAY['203.0.113.10/32']));

  -- R75 early wifi: device clock synced to frozen now; event occurred early
  PERFORM set_config('attendance.test_now', '${FROZEN}', true);
  UPDATE attendance_devices SET revoked_at = NULL WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    v_hash, 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_early_ms, v_ms, 'America/Chicago', false, 'dev-a-' || v_sfx, 'android', '1.4.0', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R75 wifi 61m early rejected',
    (v_res->>'reason') IN ('outside_window','event_too_old'), v_res::text);

END;
$test$;

SELECT name, status, detail FROM attendance_test_results ORDER BY name;

ROLLBACK;
`;

async function main() {
  console.log('Frozen now =', FROZEN);
  console.log('Fetching/patching process_auto_attendance_event in rolled-back txn…');
  const patched = await patchAutoRpc();

  // Management API may not allow multi-statement with BEGIN easily returning mid results.
  // Run as one query; capture SELECT results after DO.
  const query = `${setup}\n${patched};\n${testBody}`;
  try {
    const result = await sql(query);
    const rows = Array.isArray(result) ? result : [];
    if (!rows.length) {
      console.log('RAW', JSON.stringify(result, null, 2).slice(0, 4000));
      process.exit(2);
    }
    let fail = 0;
    for (const row of rows) {
      const st = row.status || row.STATUS;
      const name = row.name || row.NAME;
      const detail = row.detail || row.DETAIL || '';
      console.log(`${st}\t${name}${detail ? ' — ' + detail : ''}`);
      if (st === 'FAIL') fail += 1;
    }
    console.log(`\n${rows.length - fail} PASS / ${fail} FAIL / ${rows.length} total`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('TEST RUN ERROR:', e.message || e);
    process.exit(2);
  }
}

main();
