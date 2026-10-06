#!/usr/bin/env node
/**
 * R69 immediate check-out tests (fixed timestamps, rolled back).
 * Usage:
 *   SUPABASE_PROJECT_REF=utxylrrrzsjetncrajxj node scripts/test-r69-immediate-checkout.mjs
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
const pat = env.SUPABASE_PAT;
const projectRef = process.env.SUPABASE_PROJECT_REF || 'utxylrrrzsjetncrajxj';

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
const EXIT_AT = '2026-10-06 15:20:00+00';
const GRACE_AT = '2026-10-06 15:36:00+00';

const query = `
BEGIN;

CREATE TEMP TABLE r69_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO r69_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
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
  v_hash TEXT;
  v_hash_laptop TEXT;
  v_token TEXT := 'r69-phone-token';
  v_token_l TEXT := 'r69-laptop-token';
  v_dev UUID;
  v_dev_l UUID;
  v_res JSONB;
  v_out TIMESTAMPTZ;
  v_ms BIGINT;
  v_exit_ms BIGINT;
  v_sfx TEXT := 'r69t';
  v_frozen TIMESTAMPTZ := '${FROZEN}'::TIMESTAMPTZ;
BEGIN
  PERFORM set_config('attendance.test_now', '${FROZEN}', true);
  v_ms := (EXTRACT(EPOCH FROM v_frozen) * 1000)::BIGINT;
  v_exit_ms := (EXTRACT(EPOCH FROM '${EXIT_AT}'::TIMESTAMPTZ) * 1000)::BIGINT;

  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('R69 Co '||v_sfx, 'r69-co-'||v_sfx, 'r69_'||v_sfx||'@scorr.test', 'America/Chicago', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('R69 Dept', 'r69-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_r69_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin R69'),
    v_frozen, v_frozen, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_r69_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_frozen,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp R69','manager_id',v_admin),
    v_frozen, v_frozen, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company,
    auto_phone_attendance=true, auto_laptop_attendance=true, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, auto_phone_attendance=true, auto_laptop_attendance=true, work_mode='office' WHERE id=v_emp;

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight, is_demo)
  VALUES ('R69 Shift', '08:00', '17:00', ARRAY[1,2,3,4,5], 0, true, v_admin, 'America/Chicago', false, false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by, is_demo)
  VALUES (v_emp, v_shift, '2026-01-01', v_admin, false);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'R69 Office', 41.8781, -87.6298, 150, true, v_company, false,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled, is_demo
  ) VALUES (v_emp, v_zone, 'R69 Office', 41.8781, -87.6298, 150, true, false);

  v_hash := public.attendance_hash_device_token(v_token);
  v_hash_laptop := public.attendance_hash_device_token(v_token_l);
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', v_hash, '1.3.7')
  RETURNING id INTO v_dev;
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company, 'laptop-'||v_sfx, 'windows', v_hash_laptop, '1.3.7')
  RETURNING id INTO v_dev_l;

  -- Check in on phone
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, 41.8781, -87.6298, 10, NULL, NULL,
    v_ms, v_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('setup clock_in', (v_res->>'action') = 'clock_in', v_res::text);

  --------------------------------------------------------------------------
  -- 1) GPS exit + Wi-Fi off → immediate check-out at exit time
  --------------------------------------------------------------------------
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  PERFORM set_config('attendance.test_now', '${EXIT_AT}', true);
  -- Mark laptop left so R54 does not block
  UPDATE attendance_devices SET presence_state = 'left', last_presence_at = v_frozen - interval '1 hour' WHERE id = v_dev_l;
  v_res := public.process_auto_attendance_event(
    v_hash, 'exit', v_zone, 41.90, -87.70, 15, NULL, NULL,
    v_exit_ms, v_exit_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '198.51.100.9'
  );
  SELECT clock_out_at INTO v_out FROM attendance_records WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  PERFORM pg_temp.tassert('R69 GPS exit + Wi-Fi off → immediate clock_out',
    (v_res->>'action') = 'clock_out' AND v_out = '${EXIT_AT}'::TIMESTAMPTZ,
    format('action=%s out=%s res=%s', v_res->>'action', v_out, v_res::text));

  --------------------------------------------------------------------------
  -- 2) Wi-Fi off + GPS inside → still checked in
  --------------------------------------------------------------------------
  UPDATE attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  UPDATE attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  UPDATE attendance_devices SET presence_state = 'present', last_presence_at = '${EXIT_AT}'::TIMESTAMPTZ, gps_outside_streak = 0 WHERE id = v_dev;
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    v_hash, 'wifi_disconnected', v_zone, 41.8781, -87.6298, 12, NULL, NULL,
    v_exit_ms, v_exit_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R69 Wi-Fi off + GPS inside → still checked in',
    (v_res->>'action') IN ('already_checked_in', 'clock_in')
    AND EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND attendance_date='2026-10-06' AND clock_out_at IS NULL),
    v_res::text);

  --------------------------------------------------------------------------
  -- 3) Wi-Fi off + no GPS → grace; after 15 min close at last presence
  --------------------------------------------------------------------------
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  UPDATE attendance_devices SET
    presence_state = 'present',
    last_presence_at = '${EXIT_AT}'::TIMESTAMPTZ,
    last_heartbeat_at = '${EXIT_AT}'::TIMESTAMPTZ,
    gps_outside_streak = 0
  WHERE id = v_dev;
  UPDATE attendance_devices SET presence_state = 'left', last_presence_at = '${EXIT_AT}'::TIMESTAMPTZ - interval '1 hour' WHERE id = v_dev_l;
  v_res := public.process_auto_attendance_event(
    v_hash, 'wifi_disconnected', v_zone, NULL, NULL, NULL, NULL, NULL,
    v_exit_ms, v_exit_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R69 Wi-Fi off + no GPS → presence_left_pending',
    (v_res->>'action') = 'presence_left_pending'
    AND EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND attendance_date='2026-10-06' AND clock_out_at IS NULL),
    v_res::text);

  PERFORM set_config('attendance.test_now', '${GRACE_AT}', true);
  PERFORM public.attendance_set_write_context('cron');
  PERFORM public.attendance_close_stale_presence();
  SELECT clock_out_at INTO v_out FROM attendance_records WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  PERFORM pg_temp.tassert('R69 grace closes at last presence after 15m',
    v_out = '${EXIT_AT}'::TIMESTAMPTZ,
    format('out=%s', v_out));

  --------------------------------------------------------------------------
  -- 4) GPS outside + office Wi-Fi still connected → stay checked in
  --------------------------------------------------------------------------
  UPDATE attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  UPDATE attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = '2026-10-06';
  UPDATE attendance_devices SET presence_state = 'present', last_presence_at = '${EXIT_AT}'::TIMESTAMPTZ, gps_outside_streak = 0 WHERE id = v_dev;
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  PERFORM set_config('attendance.test_now', '${EXIT_AT}', true);
  v_res := public.process_auto_attendance_event(
    v_hash, 'exit', v_zone, 41.90, -87.70, 15, 'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_exit_ms, v_exit_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R69 GPS outside + office Wi-Fi → still checked in',
    (v_res->>'action') IN ('already_checked_in', 'clock_in')
    AND EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND attendance_date='2026-10-06' AND clock_out_at IS NULL),
    v_res::text);

  --------------------------------------------------------------------------
  -- 5) phone left but laptop still on office network → still checked in
  --------------------------------------------------------------------------
  UPDATE attendance_devices SET
    presence_state = 'present',
    last_presence_at = '${EXIT_AT}'::TIMESTAMPTZ,
    last_heartbeat_at = '${EXIT_AT}'::TIMESTAMPTZ
  WHERE id = v_dev_l;
  DELETE FROM attendance_events_log WHERE user_id = v_emp;
  v_res := public.process_auto_attendance_event(
    v_hash, 'exit', v_zone, 41.90, -87.70, 15, NULL, NULL,
    v_exit_ms, v_exit_ms, 'America/Chicago', false, 'phone-'||v_sfx, 'android', '1.3.7', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R69 phone left + laptop present → no check-out',
    (v_res->>'action') = 'device_left_others_present'
    AND EXISTS (SELECT 1 FROM attendance_records WHERE user_id=v_emp AND attendance_date='2026-10-06' AND clock_out_at IS NULL),
    v_res::text);

END;
$test$;

SELECT name, status, detail FROM r69_results ORDER BY name;
ROLLBACK;
`;

async function main() {
  console.log('Project', projectRef, 'Frozen', FROZEN);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
