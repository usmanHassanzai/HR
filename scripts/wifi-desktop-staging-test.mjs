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
  resolve(root, 'supabase/migrations/wifi_windows11_variant_2026-10-21.sql'),
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

  -- Staging's current trigger still requires a public IP on every row.
  -- Each row gets a distinct documentation address that the tests do not send,
  -- so a match is still from the SSID or BSSID alone.
  INSERT INTO public.office_wifi_networks (office_location_id, company_id, label, ssids, wifi_bssids, public_ip_cidrs, active)
  VALUES
    (v_office, v_company, 'Quoted', ARRAY['"Office   WiFi"'], '{}', ARRAY['203.0.113.10/32'], true),
    (v_office, v_company, 'Router', '{}', ARRAY['AA-BB-CC-DD-EE-FF'], ARRAY['203.0.113.11/32'], true),
    (v_office, v_company, 'Guest', ARRAY['Guest'], '{}', ARRAY['203.0.113.12/32'], true),
    (v_office_b, v_company_b, 'Other', ARRAY['Office WiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.13/32'], true),
    (v_office_unassigned, v_company, 'Unassigned', ARRAY['Office WiFi'], '{}', ARRAY['203.0.113.14/32'], true);

  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'office wifi', NULL);
  PERFORM pg_temp.tassert('original matcher does not collapse spaces', NOT COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office, NULL, 'office wifi', NULL);
  PERFORM pg_temp.tassert('windows11 matcher collapses spaces and case', COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, NULL, 'AA-BB-CC-DD-EE-FF');
  PERFORM pg_temp.tassert('original matcher matches the stored dash BSSID after lowercasing', COALESCE(v_m.matched, false));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, NULL, 'aa:bb:cc:dd:ee:ff');
  PERFORM pg_temp.tassert('original matcher does not treat colon BSSID as the stored dash form', NOT COALESCE(v_m.matched, false));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office, NULL, NULL, 'AA-BB-CC-DD-EE-FF');
  PERFORM pg_temp.tassert('windows11 matcher accepts dash BSSID', COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office, NULL, NULL, 'aa:bb:cc:dd:ee:ff');
  PERFORM pg_temp.tassert('windows11 matcher accepts colon BSSID', COALESCE(v_m.matched, false), COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'Guest', NULL);
  PERFORM pg_temp.tassert('one network among several is enough', COALESCE(v_m.matched, false) AND v_m.network_label = 'Guest', COALESCE(v_m.network_label, ''));

  SELECT * INTO v_m FROM public.attendance_match_office_wifi(v_office, NULL, 'Cafe', NULL);
  PERFORM pg_temp.tassert('unknown network does not match', NOT COALESCE(v_m.matched, false));

  PERFORM set_config('request.jwt.claim.sub', v_emp::text, true);
  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office, NULL, 'Office WiFi', NULL);
  PERFORM pg_temp.tassert('windows11 assigned office matches for the employee', COALESCE(v_m.matched, false));
  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office_b, NULL, 'Office WiFi', 'aa:bb:cc:dd:ee:ff');
  PERFORM pg_temp.tassert('windows11 other company office does not match', NOT COALESCE(v_m.matched, false));
  SELECT * INTO v_m FROM public.attendance_match_office_wifi_windows11(v_office_unassigned, NULL, 'Office WiFi', NULL);
  PERFORM pg_temp.tassert('windows11 unassigned office does not match', NOT COALESCE(v_m.matched, false));
  PERFORM set_config('request.jwt.claim.sub', '', true);

  INSERT INTO public.attendance_records (user_id, attendance_date, status, attendance_source, clock_in_at, shift_id)
  VALUES (v_emp, (timezone('Asia/Karachi', now()))::date, 'present', 'auto_wifi', now() - interval '1 hour', v_shift);
  SELECT clock_out_at INTO v_open FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL;

  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'windows', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'windows without variant still checks out',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NOT NULL),
    v_out::text
  );

  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'windows', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL, 'windows11'
  );
  PERFORM pg_temp.tassert(
    'windows11 wifi drop does not close',
    v_out->>'reason' = 'desktop_checkout_only_at_shift_end'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL),
    v_out::text
  );
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'windows', 'exit', now(), now(), v_office, 1, 2, 10, NULL, NULL, NULL, 'windows11'
  );
  PERFORM pg_temp.tassert(
    'windows11 gps exit does not close',
    v_out->>'reason' = 'desktop_checkout_only_at_shift_end'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NULL),
    v_out::text
  );
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'linux', 'exit', now(), now(), v_office, 1, 2, 10, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'linux gps exit still checks out',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NOT NULL),
    v_out::text
  );
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND clock_out_at IS NOT NULL;
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'android', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'android wifi drop still closes',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NOT NULL),
    v_out::text
  );
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'ios', 'wifi_disconnected', now(), now(), v_office, NULL, NULL, NULL, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'ios wifi drop still closes',
    v_out->>'action' = 'clock_out'
      AND EXISTS (SELECT 1 FROM public.attendance_records WHERE user_id = v_emp AND clock_out_at IS NOT NULL),
    v_out::text
  );
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  v_out := public.attendance_device_early_checkout(
    v_emp, NULL, v_company, 'web', 'exit', now(), now(), v_office, 1, 2, 10, NULL, NULL, NULL
  );
  PERFORM pg_temp.tassert(
    'browser without variant still checks out',
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

  PERFORM pg_temp.tassert(
    'match and checkout stay security definer',
    (
      SELECT bool_and(p.prosecdef AND COALESCE(p.proconfig::text, '') ILIKE '%search_path=public%')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'attendance_match_office_wifi',
          'attendance_match_office_wifi_windows11',
          'attendance_device_early_checkout',
          'process_auto_attendance_event'
        )
    )
  );
  PERFORM pg_temp.tassert(
    'office wifi and internal attendance tables keep rls',
    (
      SELECT bool_and(c.relrowsecurity)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (
          c.relname = 'office_wifi_networks'
          OR c.relname LIKE 'attendance_auto_close_suppress%'
          OR c.relname = 'attendance_events_log_archive'
          OR c.relname LIKE 'employee_location_pings_archive%'
        )
    )
    AND EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'office_wifi_networks' AND c.relrowsecurity
    )
  );
  PERFORM pg_temp.tassert(
    'windows11 matcher is not executable by authenticated or anon',
    NOT has_function_privilege('authenticated', 'public.attendance_match_office_wifi_windows11(uuid,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.attendance_match_office_wifi_windows11(uuid,text,text,text)', 'EXECUTE')
    AND has_function_privilege(current_user, 'public.attendance_match_office_wifi_windows11(uuid,text,text,text)', 'EXECUTE')
  );
  PERFORM pg_temp.tassert(
    'office wifi policies still exist',
    (
      SELECT count(*) = 4
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'office_wifi_networks'
        AND policyname IN (
          'office_wifi_networks_select_company',
          'office_wifi_networks_insert_admin_hr',
          'office_wifi_networks_update_admin_hr',
          'office_wifi_networks_delete_admin_hr'
        )
    )
  );
  PERFORM pg_temp.tassert(
    'internal attendance tables still have no policies',
    NOT EXISTS (
      SELECT 1
      FROM pg_policies p
      JOIN pg_class c ON c.relname = p.tablename
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
      WHERE p.schemaname = 'public'
        AND (
          c.relname LIKE 'attendance_auto_close_suppress%'
          OR c.relname = 'attendance_events_log_archive'
          OR c.relname LIKE 'employee_location_pings_archive%'
        )
    )
  );
END;
$test$;

CREATE TEMP TABLE internal_rls_tables (relname text);
INSERT INTO internal_rls_tables
SELECT c.relname
FROM pg_class c
JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public'
  AND c.relkind = 'r'
  AND (
    c.relname LIKE 'attendance_auto_close_suppress%'
    OR c.relname = 'attendance_events_log_archive'
    OR c.relname LIKE 'employee_location_pings_archive%'
  );

INSERT INTO wifi_test_results
SELECT 'internal archive tables on staging',
  'PASS',
  COALESCE(NULLIF(string_agg(relname, ', '), ''), 'none on staging')
FROM internal_rls_tables;

DO $anon$
DECLARE
  n int := -1;
  seen int := 0;
  writes int := 0;
  blocked int := 0;
  v_role text := current_user;
  names text[] := '{}';
  rel text;
BEGIN
  SELECT COALESCE(array_agg(relname), '{}') INTO names FROM internal_rls_tables;
  PERFORM set_config('role', 'anon', true);
  SELECT count(*)::int INTO n FROM public.office_wifi_networks;
  FOREACH rel IN ARRAY names LOOP
    seen := seen + 1;
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM public.%I', rel) INTO writes;
      IF writes <> 0 THEN
        blocked := blocked - 100;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    BEGIN
      EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', rel);
      blocked := blocked - 100;
    EXCEPTION WHEN OTHERS THEN
      blocked := blocked + 1;
    END;
  END LOOP;
  PERFORM set_config('role', v_role, true);
  INSERT INTO wifi_test_results VALUES (
    'anon cannot read office wifi',
    CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(n::text, 'null')
  );
  IF seen > 0 THEN
    INSERT INTO wifi_test_results VALUES (
      'anon cannot read or write internal attendance tables',
      CASE WHEN blocked = seen THEN 'PASS' ELSE 'FAIL' END,
      'tables=' || seen || ' blocked=' || blocked
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM set_config('role', v_role, true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  INSERT INTO wifi_test_results VALUES ('anon rls check', 'FAIL', SQLERRM);
END;
$anon$;


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
