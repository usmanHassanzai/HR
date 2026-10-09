#!/usr/bin/env node
/**
 * Zero-minute visit loop fix tests (device-token / shared RPC, cleaned up).
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
const pat = env.SUPABASE_PAT || env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF || 'yvnbxweitelowucdhwpg';

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
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 2000));
  return body;
}

const sfx = 'zl' + randomBytes(4).toString('hex');
const token = 'tok-zl-' + sfx;
const tokenHash = createHash('sha256').update(token).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE zl_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO zl_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_lap UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE;
  v_rec UUID;
  v_res JSONB;
  v_open INTEGER;
  v_n INTEGER;
  v_mins NUMERIC;
  v_any TIMESTAMPTZ;
  v_office_sig TIMESTAMPTZ;
  v_inside TIMESTAMPTZ;
  v_counts_before RECORD;
  v_counts_after RECORD;
  v_lat DOUBLE PRECISION := 24.8607;
  v_lng DOUBLE PRECISION := 67.0011;
  v_out_lat DOUBLE PRECISION := 24.8707;
  v_out_lng DOUBLE PRECISION := 67.0111;
  i INTEGER;
BEGIN
  SELECT count(*)::int AS records,
    (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_before FROM public.attendance_records;

  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes
  ) VALUES (
    'ZL Co '||v_sfx, 'zl-co-'||v_sfx, 'zl_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('ZL Dept', 'zl-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'ZL Office', v_lat, v_lng, 150, true)
  RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'ZL WiFi', ARRAY['203.0.113.50/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_zl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin ZL'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_zl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp ZL'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_lap, 'authenticated', 'authenticated',
    'lap_zl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Lap ZL'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true,
    last_any_signal_at = v_now - INTERVAL '2 hours',
    last_office_signal_at = v_now - INTERVAL '2 hours'
  WHERE id = v_emp;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true
  WHERE id = v_lap;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'ZL Shift', '00:00:00'::time, '23:59:59'::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES
    (v_emp, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin),
    (v_lap, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES
    (v_emp, v_office, 'ZL Office', v_lat, v_lng, 150, true),
    (v_lap, v_office, 'ZL Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES (
    v_emp, v_company, 'phone-'||v_sfx, 'android', '${tokenHash}', '1.3.18', 'left', v_now - INTERVAL '2 hours'
  );

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES (
    v_lap, v_company, 'lap-'||v_sfx, 'windows', encode(sha256(('lap-'||v_sfx)::bytea), 'hex'), '1.3.18', 'present', v_now
  );

  v_att_date := public.resolve_shift_attendance_date(v_emp, v_now);
  PERFORM public.attendance_set_write_context('admin_correction');

  -- 1) Re-entry after long silence → cron 5c immediately → visit stays open
  v_res := public.attendance_try_auto_checkin(
    v_emp, v_now, v_lat, v_lng, 20, false, '203.0.113.50', 'android',
    'ZL Office', NULL, 'ZL WiFi', 10
  );
  v_n := public.attendance_apply_rule_5c();
  v_n := v_n + public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'reentry_cron_keeps_open',
    COALESCE(v_res->>'action','') = 'clock_in' AND v_open = 1 AND v_n = 0,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open||' closed='||v_n
  );

  SELECT last_any_signal_at, last_office_signal_at, last_inside_gps_at
  INTO v_any, v_office_sig, v_inside
  FROM public.users WHERE id = v_emp;
  PERFORM pg_temp.tassert(
    'checkin_updates_signal_stamps',
    v_any >= v_now - INTERVAL '5 seconds'
      AND v_office_sig >= v_now - INTERVAL '5 seconds'
      AND v_inside IS NOT NULL,
    format('any=%s office=%s inside=%s', v_any, v_office_sig, v_inside)
  );

  -- 2) Queued outside reading older than check-in → ignored
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_office,
    v_out_lat, v_out_lng, 25::double precision,
    NULL, NULL,
    ((EXTRACT(EPOCH FROM (v_now - INTERVAL '10 minutes')) * 1000))::bigint,
    ((EXTRACT(EPOCH FROM (v_now - INTERVAL '10 minutes')) * 1000))::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '198.51.100.10'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'stale_outside_ignored',
    COALESCE(v_res->>'action','') IN ('ignored_stale_outside', 'none', 'already_checked_in')
      AND v_open = 1,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- 3) Fresh outside reading → Rule 5 check-out
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'exit', v_office,
    v_out_lat, v_out_lng, 25::double precision,
    NULL, NULL,
    ((EXTRACT(EPOCH FROM (v_now + INTERVAL '1 second')) * 1000))::bigint,
    ((EXTRACT(EPOCH FROM (v_now + INTERVAL '1 second')) * 1000))::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '198.51.100.10'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'fresh_outside_checks_out',
    COALESCE(v_res->>'action','') = 'clock_out' AND v_open = 0,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- 4) 5b still closes after 11 min no office signal
  UPDATE public.users SET
    last_any_signal_at = v_now,
    last_office_signal_at = v_now - INTERVAL '11 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_emp;
  PERFORM public.attendance_set_write_context('admin_correction');
  v_res := public.attendance_try_auto_checkin(
    v_emp, v_now - INTERVAL '11 minutes', v_lat, v_lng, 20, false, '203.0.113.50', 'android',
    'ZL Office', NULL, 'ZL WiFi', 10
  );
  -- Force silence start in the past: stamp office old, any recent enough to fail 5c but not 5b
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '11 minutes',
    last_any_signal_at = v_now - INTERVAL '1 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_emp;
  UPDATE public.attendance_visit_segments SET clock_in_at = v_now - INTERVAL '11 minutes'
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  v_n := public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'rule_5b_still_closes_after_11m',
    v_n >= 1 AND v_open = 0,
    'n='||v_n||' open='||v_open
  );

  -- 5) 5c still closes after 4 min offline (seed aged visit directly)
  PERFORM public.attendance_set_write_context('admin_correction');
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, attendance_source, presence_method
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_now - INTERVAL '4 minutes', 'auto_wifi', 'wifi'
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_emp, v_rec, v_att_date, 1, v_now - INTERVAL '4 minutes', 'Visit 1 · aged for 5c'
  );
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '4 minutes',
    last_any_signal_at = v_now - INTERVAL '4 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_emp;
  v_n := public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  SELECT COALESCE(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/60.0, -1)
  INTO v_mins
  FROM public.attendance_visit_segments
  WHERE user_id = v_emp
  ORDER BY clock_in_at DESC LIMIT 1;
  PERFORM pg_temp.tassert(
    'rule_5c_still_closes_after_4m',
    v_n >= 1 AND v_open = 0 AND v_mins >= 2,
    'n='||v_n||' open='||v_open||' mins='||v_mins
  );

  -- 6) 1-hour simulation: quiet phone + laptop office heartbeat → no 0-min visits
  PERFORM public.attendance_set_write_context('admin_correction');
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_lap;
  DELETE FROM public.attendance_records WHERE user_id = v_lap;
  DELETE FROM public.attendance_events_log WHERE user_id = v_lap;
  v_res := public.attendance_try_auto_checkin(
    v_lap, v_now - INTERVAL '60 minutes', v_lat, v_lng, 30, false, '203.0.113.50', 'windows',
    'ZL Office', NULL, 'ZL WiFi', 10
  );
  UPDATE public.attendance_visit_segments SET clock_in_at = v_now - INTERVAL '60 minutes'
  WHERE user_id = v_lap AND clock_out_at IS NULL;
  -- Seed continuous office heartbeats for the whole hour first, then run silence cron.
  FOR i IN 0..59 LOOP
    PERFORM public.attendance_touch_user_signals(
      v_lap, v_now - INTERVAL '60 minutes' + make_interval(mins => i), true, false
    );
    INSERT INTO public.attendance_events_log (
      company_id, user_id, event, accepted, reason_code, matched_method, occurred_at, client_ip, payload
    ) VALUES (
      v_company, v_lap, 'heartbeat', true, 'already_checked_in', 'laptop',
      v_now - INTERVAL '60 minutes' + make_interval(mins => i),
      '203.0.113.50',
      jsonb_build_object('wifi_ok', true, 'platform', 'windows')
    );
  END LOOP;
  FOR i IN 0..11 LOOP
    PERFORM public.attendance_apply_rule_5c();
    PERFORM public.attendance_apply_rule_5b();
  END LOOP;
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_lap AND clock_out_at IS NULL;
  SELECT count(*) INTO v_n FROM public.attendance_visit_segments
  WHERE user_id = v_lap
    AND clock_out_at IS NOT NULL
    AND clock_out_at < clock_in_at + INTERVAL '2 minutes';
  PERFORM pg_temp.tassert(
    'hour_sim_no_zero_min_visits',
    v_open = 1 AND v_n = 0,
    'open='||v_open||' zeroish='||v_n
  );

  PERFORM pg_temp.tassert(
    'cron_tick_calls_5b_5c',
    (
      SELECT prosrc LIKE '%attendance_apply_rule_5c%'
         AND prosrc LIKE '%attendance_apply_rule_5b%'
      FROM pg_proc WHERE proname = 'attendance_cron_tick' LIMIT 1
    ),
    'cron_tick wiring'
  );

  -- Cleanup
  DELETE FROM public.attendance_auto_close_suppressed WHERE user_id IN (v_emp, v_lap, v_admin);
  DELETE FROM public.attendance_events_log WHERE user_id IN (v_emp, v_lap, v_admin);
  DELETE FROM public.attendance_visit_segments WHERE user_id IN (v_emp, v_lap);
  DELETE FROM public.attendance_records WHERE user_id IN (v_emp, v_lap);
  DELETE FROM public.attendance_devices WHERE user_id IN (v_emp, v_lap);
  DELETE FROM public.employee_shift_assignments WHERE user_id IN (v_emp, v_lap);
  DELETE FROM public.employee_work_sites WHERE user_id IN (v_emp, v_lap);
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE office_location_id = v_office;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_emp, v_lap, v_admin);
  DELETE FROM auth.users WHERE id IN (v_emp, v_lap, v_admin);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;

  SELECT count(*)::int AS records,
    (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_after FROM public.attendance_records;
  PERFORM pg_temp.tassert(
    'counts_unchanged',
    v_counts_before.records = v_counts_after.records
      AND v_counts_before.visits = v_counts_after.visits,
    format('records %s->%s visits %s->%s',
      v_counts_before.records, v_counts_after.records,
      v_counts_before.visits, v_counts_after.visits)
  );
END;
$test$;

SELECT * FROM zl_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
console.log(JSON.stringify(rows, null, 2));
const fails = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.error('FAILED', fails);
  process.exit(1);
}
console.log('All zero-minute loop tests passed.');
