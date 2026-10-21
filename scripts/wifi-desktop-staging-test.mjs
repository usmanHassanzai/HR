/**
 * Applies the Wi-Fi migration on scorr-staging inside one transaction, runs
 * checks, then ROLLBACK. Refuses the production project.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGING = 'utxylrrrzsjetncrajxj';
const PRODUCTION = 'yvnbxweitelowucdhwpg';
if (STAGING === PRODUCTION) process.exit(1);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const envRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
if (envRef === PRODUCTION) {
  console.log('env_points_at_production=true; this script still uses staging only');
}
const pat = env.SUPABASE_PAT || env.SUPABASE_ACCESS_TOKEN;
if (!pat) {
  console.error('NO_PAT');
  process.exit(1);
}

const migration = readFileSync(
  resolve(root, 'supabase/migrations/wifi_match_any_saved_network_2026-10-21.sql'),
  'utf8',
);

const testSql = `
CREATE TEMP TABLE wifi_test_results (name text, status text, detail text);

CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO wifi_test_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail, ''));
END;
$a$;

DO $test$
DECLARE
  v_sfx text := 'wifi2146';
  v_company uuid;
  v_company_b uuid;
  v_dept uuid;
  v_admin uuid := gen_random_uuid();
  v_emp uuid := gen_random_uuid();
  v_emp_shift uuid := gen_random_uuid();
  v_emp_manual uuid := gen_random_uuid();
  v_shift uuid;
  v_shift_ended uuid;
  v_office uuid;
  v_office_b uuid;
  v_office_unassigned uuid;
  v_m record;
  v_out jsonb;
  v_open timestamptz;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('SCORR_WIFI_TEST_' || v_sfx, 'scorr-wifi-' || v_sfx, 'wifi_' || v_sfx || '@scorr.test', 'Asia/Karachi', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.companies (name, slug, contact_email, timezone)
  VALUES ('SCORR_WIFI_OTHER_' || v_sfx, 'scorr-wifi-b-' || v_sfx, 'wifib_' || v_sfx || '@scorr.test', 'Asia/Karachi')
  RETURNING id INTO v_company_b;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Wifi Dept ' || v_sfx, 'wifi-dept-' || v_sfx, v_company, true)
  RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'wifiadmin_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Wifi Admin'),
    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'wifiemp_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Wifi Emp','manager_id',v_admin),
    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp_shift, 'authenticated', 'authenticated',
    'wifishift_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Wifi Shift','manager_id',v_admin),
    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp_manual, 'authenticated', 'authenticated',
    'wifimanual_' || v_sfx || '@scorr.test', crypt('x', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Wifi Manual','manager_id',v_admin),
    now(), now(), '', '', '', '');

  UPDATE public.users SET role = 'admin'::public.user_role, company_id = v_company, work_mode = 'office'
  WHERE id = v_admin;
  UPDATE public.users SET role = 'employee'::public.user_role, company_id = v_company, department_id = v_dept,
    manager_id = v_admin, work_mode = 'office'
  WHERE id IN (v_emp, v_emp_shift, v_emp_manual);

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight, is_demo)
  VALUES ('Wifi open', '00:00', '23:59', ARRAY[0,1,2,3,4,5,6], 0, true, v_admin, 'Asia/Karachi', false, false)
  RETURNING id INTO v_shift;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight, is_demo)
  VALUES ('Wifi ended', '00:00', '12:00', ARRAY[0,1,2,3,4,5,6], 0, true, v_admin, public.app_timezone(), false, false)
  RETURNING id INTO v_shift_ended;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by, is_demo)
  VALUES
    (v_emp, v_shift, '2026-01-01', v_admin, false),
    (v_emp_manual, v_shift, '2026-01-01', v_admin, false),
    (v_emp_shift, v_shift_ended, '2026-01-01', v_admin, false);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo, detection_mode
  ) VALUES
    ('Wifi Office', 24.86, 67.01, 100, true, v_company, false, 'gps_or_wifi')
  RETURNING id INTO v_office;
  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo, detection_mode
  ) VALUES
    ('Other Office', 25.00, 67.10, 100, true, v_company_b, false, 'gps_or_wifi')
  RETURNING id INTO v_office_b;
  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, is_demo, detection_mode
  ) VALUES
    ('Unassigned Office', 24.90, 67.05, 100, true, v_company, false, 'gps_or_wifi')
  RETURNING id INTO v_office_unassigned;

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled, is_demo
  ) VALUES
    (v_emp, v_office, 'Wifi Office', 24.86, 67.01, 100, true, false),
    (v_emp_shift, v_office, 'Wifi Office', 24.86, 67.01, 100, true, false),
    (v_emp_manual, v_office, 'Wifi Office', 24.86, 67.01, 100, true, false);

  INSERT INTO public.office_wifi_networks (office_location_id, company_id, label, ssids, wifi_bssids, public_ip_cidrs, active)
  VALUES
    (v_office, v_company, 'Quoted', ARRAY['"Office   WiFi"'], '{}', '{}', true),
    (v_office, v_company, 'Router', '{}', ARRAY['AA-BB-CC-DD-EE-FF'], '{}', true),
    (v_office, v_company, 'Guest', ARRAY['Guest'], '{}', '{}', true),
    (v_office_b, v_company_b, 'Other', ARRAY['Office WiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], '{}', true),
    (v_office_unassigned, v_company, 'Unassigned', ARRAY['Office WiFi'], '{}', '{}', true);

  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'office wifi', NULL);
  PERFORM pg_temp.tassert('saved ssid matches with spaces and case', COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, NULL, 'aa:bb:cc:dd:ee:ff');
  PERFORM pg_temp.tassert('saved bssid matches colon form', COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'Guest', NULL);
  PERFORM pg_temp.tassert('one network among several is enough', COALESCE(v_m.matched, false) AND v_m.network_label = 'Guest', COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'Cafe', NULL);
  PERFORM pg_temp.tassert('unknown network does not match', NOT COALESCE(v_m.matched, false));

  PERFORM set_config('request.jwt.claim.sub', v_emp::text, true);
  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'Office WiFi', NULL);
  PERFORM pg_temp.tassert('assigned office matches for the employee', COALESCE(v_m.matched, false));
  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office_b, NULL, 'Office WiFi', 'aa:bb:cc:dd:ee:ff');
  PERFORM pg_temp.tassert('other company office does not match', NOT COALESCE(v_m.matched, false));
  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office_unassigned, NULL, 'Office WiFi', NULL);
  PERFORM pg_temp.tassert('unassigned office does not match', NOT COALESCE(v_m.matched, false));
  PERFORM set_config('request.jwt.claim.sub', '', true);

  INSERT INTO public.attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, shift_id)
  VALUES (v_emp, (timezone('Asia/Karachi', now()))::date, 'present', 'auto_wifi', now() - interval '1 hour', v_shift);
  SELECT clock_out_at INTO v_open FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL;

  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'windows', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'windows wifi drop does not close',
    v_out->>'reason' = 'desktop_checkout_only_at_shift_end'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL),
    v_out::text
  );
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'linux', 'exit', now(), now(), v_office, 1, 2, 10, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'linux gps exit does not close',
    v_out->>'reason' = 'desktop_checkout_only_at_shift_end'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL),
    v_out::text
  );
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'android', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'android wifi drop still closes',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NOT NULL),
    v_out::text
  );

  INSERT INTO public.attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, shift_id)
  VALUES (
    v_emp_shift,
    (timezone(public.app_timezone(), now()))::date - 1,
    'present',
    'auto_wifi',
    ((((timezone(public.app_timezone(), now()))::date - 1) + time '01:00') AT TIME ZONE public.app_timezone()),
    v_shift_ended
  );
  PERFORM public.close_open_attendance_if_shift_ended(v_emp_shift, NULL, NULL);
  PERFORM pg_temp.tassert(
    'shift end closes the session',
    EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp_shift AND clock_out_at IS NOT NULL)
  );

  INSERT INTO public.attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, shift_id)
  VALUES (v_emp_manual, (timezone('Asia/Karachi', now()))::date, 'present', 'auto_wifi', now() - interval '30 minute', v_shift);
  PERFORM set_config('request.jwt.claim.sub', v_emp_manual::text, true);
  v_out := public.process_geo_attendance_ping(24.86::double precision, 67.01::double precision, 10::double precision, 'clock_out');
  PERFORM pg_temp.tassert(
    'clock out closes the session',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp_manual AND clock_out_at IS NOT NULL),
    v_out::text
  );
END;
$test$;

SELECT name, status, detail FROM wifi_test_results ORDER BY name;
`;

async function query(sqlText) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sqlText }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 2000)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const wrapped = `BEGIN;\n${migration}\n${testSql}\nROLLBACK;`;
try {
  const rows = await query(wrapped);
  console.log(JSON.stringify(rows, null, 2));
  const failed = Array.isArray(rows) && rows.some((r) => r.status === 'FAIL');
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error(String(err.message || err).slice(0, 2000));
  process.exitCode = 1;
}

const leftover = await query(`SELECT count(*)::int AS n FROM public.companies WHERE name LIKE 'SCORR_WIFI_%'`);
console.log('LEFTOVER_COMPANIES', JSON.stringify(leftover));
