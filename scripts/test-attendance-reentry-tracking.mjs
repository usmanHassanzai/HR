#!/usr/bin/env node
/**
 * Re-entry check-in tests via device-token RPC (no JWT). Cleans up after.
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

const sfx = 're' + randomBytes(4).toString('hex');
const token = 'tok-re-' + sfx;
const tokenHash = createHash('sha256').update(token).digest('hex');
const tokenRev = 'tok-rev-' + sfx;
const tokenRevHash = createHash('sha256').update(tokenRev).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE re_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO re_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
  v_dev UUID;
  v_dev_rev UUID;
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE;
  v_rec UUID;
  v_res JSONB;
  v_open INTEGER;
  v_counts_before RECORD;
  v_counts_after RECORD;
  v_lat DOUBLE PRECISION := 24.8607;
  v_lng DOUBLE PRECISION := 67.0011;
BEGIN
  SELECT count(*)::int AS records,
    (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_before FROM public.attendance_records;

  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes
  ) VALUES (
    'RE Co '||v_sfx, 're-co-'||v_sfx, 're_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('RE Dept', 're-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'RE Office', v_lat, v_lng, 150, true)
  RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'RE WiFi', ARRAY['203.0.113.50/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_re_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin RE'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_re_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp RE'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true WHERE id=v_emp;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'RE Shift', '00:00:00'::time, '23:59:59'::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_office, 'RE Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES (
    v_emp, v_company, 'phone-'||v_sfx, 'android', '${tokenHash}', '1.3.18', 'left', v_now
  ) RETURNING id INTO v_dev;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, revoked_at
  ) VALUES (
    v_emp, v_company, 'rev-'||v_sfx, 'android', '${tokenRevHash}', '1.3.18', 'left', v_now
  ) RETURNING id INTO v_dev_rev;

  v_att_date := public.resolve_shift_attendance_date(v_emp, v_now);
  PERFORM set_config('attendance.write_context', 'admin_correction', true);
  PERFORM public.attendance_set_write_context('admin_correction');

  -- Open visit then close by Rule 5 (outside GPS)
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, attendance_source, shift_id
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_now - INTERVAL '2 hours', 'geo', v_shift
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_emp, v_rec, v_att_date, 1, v_now - INTERVAL '2 hours', 'Visit 1 · Wi-Fi entry'
  );
  PERFORM public.attendance_close_visit_with_note(
    v_emp, v_now - INTERVAL '30 minutes', 'Auto close: left the office radius', false
  );
  UPDATE public.attendance_devices SET presence_state = 'left' WHERE id = v_dev;

  -- 1) Device-token: office Wi-Fi + inside GPS → new visit (no JWT)
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_office,
    v_lat, v_lng, 20::double precision,
    'RE-WiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '203.0.113.50'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'android_wifi_gps_reentry',
    COALESCE(v_res->>'action','') = 'clock_in' AND v_open = 1,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open||' notify='||COALESCE(v_res->>'notify_message','')
  );
  PERFORM pg_temp.tassert(
    'reentry_notify_again',
    COALESCE(v_res->>'notify_message','') ILIKE 'Checked in again%',
    COALESCE(v_res->>'notify_message','')
  );
  PERFORM pg_temp.tassert(
    'stop_tracking_false_on_clock_in',
    COALESCE((v_res->>'stop_tracking')::boolean, true) = false,
    v_res->>'stop_tracking'
  );

  -- Close again for wifi-only test
  PERFORM public.attendance_close_visit_with_note(
    v_emp, v_now - INTERVAL '5 minutes', 'Auto close: left the office radius', false
  );
  UPDATE public.attendance_devices SET presence_state = 'left' WHERE id = v_dev;

  -- 2) Office Wi-Fi + location off → new visit
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'ping', v_office,
    NULL::double precision, NULL::double precision, NULL::double precision,
    'RE-WiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '203.0.113.50'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'android_wifi_no_gps_reentry',
    COALESCE(v_res->>'action','') = 'clock_in' AND v_open = 1,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- 3) Inside radius on mobile data (no office IP) → rejected
  PERFORM public.attendance_close_visit_with_note(
    v_emp, v_now - INTERVAL '1 minutes', 'Auto close: left the office radius', false
  );
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'enter', v_office,
    v_lat, v_lng, 15::double precision,
    NULL, NULL,
    ((EXTRACT(EPOCH FROM v_now) + 10) * 1000)::bigint,
    ((EXTRACT(EPOCH FROM v_now) + 10) * 1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '198.51.100.10'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'mobile_data_inside_rejected',
    COALESCE(v_res->>'action','') IN ('not_on_office_wifi', 'outside_radius', 'not_on_office_network')
      AND v_open = 0,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- Then office Wi-Fi connects → check-in
  v_res := public.process_auto_attendance_event(
    '${tokenHash}', 'wifi_connected', v_office,
    v_lat, v_lng, 15::double precision,
    'RE-WiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '203.0.113.50'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_emp AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'wifi_connect_after_reject_checks_in',
    COALESCE(v_res->>'action','') = 'clock_in' AND v_open = 1,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- 4) After shift end → rejected (narrow past shift; company hours must not apply)
  PERFORM public.attendance_close_visit_with_note(
    v_emp, v_now, 'Auto close: left the office radius', false
  );
  UPDATE public.work_shifts
  SET start_time = '00:00:00'::time, end_time = '00:01:00'::time
  WHERE id = v_shift;
  v_res := public.attendance_try_auto_checkin(
    v_emp, v_now,
    v_lat, v_lng, 20, false, '203.0.113.50', 'android',
    'RE Office', NULL, NULL, 10
  );
  PERFORM pg_temp.tassert(
    'after_shift_end_rejected',
    COALESCE(v_res->>'action','') IN ('checkin_blocked_shift_ended')
      OR COALESCE(v_res->>'reason','') IN ('outside_window', 'checkin_blocked_shift_ended'),
    'action='||COALESCE(v_res->>'action','')||' reason='||COALESCE(v_res->>'reason','')
  );
  UPDATE public.work_shifts
  SET start_time = '00:00:00'::time, end_time = '23:59:59'::time
  WHERE id = v_shift;

  -- 5) Device-token vs shared helper same result when already checked in
  PERFORM public.attendance_try_auto_checkin(
    v_emp, v_now, v_lat, v_lng, 20, false, '203.0.113.50', 'android',
    'RE Office', NULL, NULL, 5
  );
  v_res := public.attendance_try_auto_checkin(
    v_emp, v_now, v_lat, v_lng, 20, false, '203.0.113.50', 'android',
    'RE Office', NULL, NULL, 5
  );
  DECLARE
    v_tok JSONB;
  BEGIN
    v_tok := public.process_auto_attendance_event(
      '${tokenHash}', 'ping', v_office,
      v_lat, v_lng, 20::double precision,
      'RE-WiFi', 'aa:bb:cc:dd:ee:ff',
      ((EXTRACT(EPOCH FROM v_now) + 20) * 1000)::bigint,
      ((EXTRACT(EPOCH FROM v_now) + 20) * 1000)::bigint,
      'UTC', false, 'phone-'||v_sfx, 'android', '1.3.18', '203.0.113.50'
    );
    PERFORM pg_temp.tassert(
      'shared_and_token_already_in',
      COALESCE(v_res->>'action','') = 'already_checked_in'
        AND COALESCE(v_tok->>'action','') IN ('already_checked_in', 'none'),
      'shared='||COALESCE(v_res->>'action','')||' token='||COALESCE(v_tok->>'action','')
    );
  END;

  -- 6) Revoked token → rejected
  v_res := public.process_auto_attendance_event(
    '${tokenRevHash}', 'ping', v_office,
    v_lat, v_lng, 20::double precision,
    'RE-WiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'rev-'||v_sfx, 'android', '1.3.18', '203.0.113.50'
  );
  PERFORM pg_temp.tassert(
    'revoked_token_rejected',
    COALESCE(v_res->>'reason','') = 'revoked_token'
      AND COALESCE((v_res->>'stop_tracking')::boolean, false) = true,
    COALESCE(v_res->>'reason','')
  );

  -- 7) outside_window response must not request hard stop
  PERFORM pg_temp.tassert(
    'outside_window_stop_tracking_false',
    (
      SELECT pg_get_functiondef(oid) LIKE '%''reason'', ''outside_window''%'
        AND pg_get_functiondef(oid) LIKE '%''stop_tracking'', false%'
      FROM pg_proc WHERE proname = 'process_auto_attendance_event' LIMIT 1
    ),
    'live function flag'
  );

  -- Cleanup
  DELETE FROM public.attendance_events_log WHERE user_id IN (v_emp, v_admin);
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.attendance_devices WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE office_location_id = v_office;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_emp, v_admin);
  DELETE FROM auth.users WHERE id IN (v_emp, v_admin);
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

SELECT * FROM re_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
console.log(JSON.stringify(rows, null, 2));
const fails = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.error('FAILED', fails);
  process.exit(1);
}
console.log('All re-entry tracking tests passed.');
