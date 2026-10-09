#!/usr/bin/env node
/**
 * Rules 1+7 live RPC tests (rolled back).
 * Usage: SUPABASE_PROJECT_REF=yvnbxweitelowucdhwpg node scripts/test-attendance-rule-1-7.mjs
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
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 2500));
  return body;
}

const tokenPlain = `r17-token-${Date.now()}`;
const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE r17_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO r17_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
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

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID;
  v_zone UUID;
  v_dev UUID;
  v_sfx TEXT := 'r17' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE := (v_now AT TIME ZONE 'UTC')::date;
  v_start TIME := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end TIME := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  v_office_lat DOUBLE PRECISION := 41.8781;
  v_office_lng DOUBLE PRECISION := -87.6298;
  v_inside_lat DOUBLE PRECISION := 41.87815;
  v_inside_lng DOUBLE PRECISION := -87.62985;
  v_outside_lat DOUBLE PRECISION := 41.90;
  v_outside_lng DOUBLE PRECISION := -87.70;
  v_res JSONB;
  v_action TEXT;
  v_chk RECORD;
  v_n INTEGER;
  v_err TEXT;
  v_rec UUID;
  v_hash TEXT := '${tokenHash}';
BEGIN
  IF v_start > v_end THEN
    v_start := TIME '08:00';
    v_end := TIME '20:00';
  END IF;

  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('R17 Co '||v_sfx, 'r17-co-'||v_sfx, 'r17_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('R17 Dept', 'r17-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_r17_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin R17'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_r17_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp R17','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true WHERE id=v_emp;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'R17 Shift', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att_date - 30, v_admin);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'R17 Office', v_office_lat, v_office_lng, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_zone, 'R17 Office', v_office_lat, v_office_lng, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', v_hash, '1.3.9')
  RETURNING id INTO v_dev;

  --------------------------------------------------------------------------
  -- Shared check unit probes
  --------------------------------------------------------------------------
  PERFORM set_config('request.headers', '{"cf-connecting-ip":"203.0.113.10"}', true);
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_inside_lat, v_inside_lng, 20, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert('R17 shared: wifi+inside OK', COALESCE(v_chk.ok,false), v_chk::text);

  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_inside_lat, v_inside_lng, 20, false, '198.51.100.9', 'check_in'
  );
  PERFORM pg_temp.tassert('R17 shared: radius-only rejected',
    NOT COALESCE(v_chk.ok,true) AND v_chk.reason = 'not_on_office_wifi', v_chk::text);

  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, NULL, NULL, NULL, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert('R17 shared: wifi-only OK (no GPS)',
    COALESCE(v_chk.ok,false) AND v_chk.match_kind = 'wifi_no_gps', v_chk::text);

  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_inside_lat, v_inside_lng, 150, false, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert('R17 shared: accuracy 150 → wifi_no_gps',
    COALESCE(v_chk.ok,false) AND v_chk.match_kind = 'wifi_no_gps', v_chk::text);

  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_inside_lat, v_inside_lng, 20, true, '203.0.113.10', 'check_in'
  );
  PERFORM pg_temp.tassert('R17 shared: mock rejected',
    NOT COALESCE(v_chk.ok,true) AND v_chk.reason = 'gps_unusable', v_chk::text);

  --------------------------------------------------------------------------
  -- Manual geo check-in / check-out via real RPC
  --------------------------------------------------------------------------
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_inside_lat, v_inside_lng, 20, 'clock_in', false);
  v_action := v_res->>'action';
  PERFORM pg_temp.tassert('R17 manual: wifi+inside check-in OK', v_action = 'clock_in', v_res::text);

  -- Reset visit for more check-in rejects
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;

  PERFORM pg_temp.as_emp(v_emp, '198.51.100.9'); -- mobile data
  v_res := public.process_geo_attendance_ping(v_inside_lat, v_inside_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert('R17 manual: radius-only rejected',
    (v_res->>'action') = 'not_on_office_wifi', v_res::text);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_outside_lat, v_outside_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert('R17 manual: outside radius rejected',
    (v_res->>'action') = 'outside_radius', v_res::text);

  v_res := public.process_geo_attendance_ping(v_inside_lat, v_inside_lng, 150, 'clock_in', false);
  PERFORM pg_temp.tassert('R17 manual: accuracy 150 → clock_in (wifi_no_gps)',
    (v_res->>'action') = 'clock_in', v_res::text);
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;

  v_res := public.process_geo_attendance_ping(v_inside_lat, v_inside_lng, 20, 'clock_in', true);
  PERFORM pg_temp.tassert('R17 manual: mock rejected',
    (v_res->>'action') = 'gps_unusable', v_res::text);

  --------------------------------------------------------------------------
  -- Auto path via process_auto_attendance_event
  --------------------------------------------------------------------------
  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, v_inside_lat, v_inside_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now)*1000)::bigint, (EXTRACT(EPOCH FROM v_now)*1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.9', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R17 auto: wifi+inside check-in OK',
    (v_res->>'action') IN ('clock_in', 'already_checked_in'), v_res::text);

  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  UPDATE public.attendance_devices SET presence_state = NULL WHERE id = v_dev;

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, v_inside_lat, v_inside_lng, 20,
    NULL, NULL,
    (EXTRACT(EPOCH FROM v_now)*1000)::bigint, (EXTRACT(EPOCH FROM v_now)*1000)::bigint,
    'UTC', false, 'phone-'||v_sfx, 'android', '1.3.9', '198.51.100.9'
  );
  PERFORM pg_temp.tassert('R17 auto: mobile data rejected',
    (v_res->>'action') = 'not_on_office_wifi', v_res::text);

  UPDATE public.attendance_devices SET platform = 'windows', device_id = 'laptop-'||v_sfx WHERE id = v_dev;
  v_res := public.process_auto_attendance_event(
    v_hash, 'heartbeat', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now)*1000)::bigint, (EXTRACT(EPOCH FROM v_now)*1000)::bigint,
    'UTC', false, 'laptop-'||v_sfx, 'windows', '1.3.9', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R17 auto: laptop office IP no GPS → clock_in',
    (v_res->>'action') = 'clock_in',
    v_res::text);
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  UPDATE public.attendance_devices SET platform = 'android', device_id = 'phone-'||v_sfx, presence_state = NULL WHERE id = v_dev;

  v_res := public.process_auto_attendance_event(
    v_hash, 'enter', v_zone, v_inside_lat, v_inside_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    (EXTRACT(EPOCH FROM v_now)*1000)::bigint, (EXTRACT(EPOCH FROM v_now)*1000)::bigint,
    'UTC', true, 'phone-'||v_sfx, 'android', '1.3.9', '203.0.113.10'
  );
  PERFORM pg_temp.tassert('R17 auto: mock rejected',
    COALESCE(v_res->>'reason','') = 'mock_location' OR (v_res->>'action') = 'gps_unusable',
    v_res::text);

  --------------------------------------------------------------------------
  -- Manual clock-out rules
  --------------------------------------------------------------------------
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_inside_lat, v_inside_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert('R17 setup open visit for checkout', (v_res->>'action') = 'clock_in', v_res::text);

  BEGIN
    PERFORM public.check_out_attendance(NULL, v_inside_lat, v_inside_lng, 20, false);
    PERFORM pg_temp.tassert('R17 checkout: inside+wifi OK', true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert('R17 checkout: inside+wifi OK', false, SQLERRM);
  END;

  -- Re-open visit
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp;

  BEGIN
    PERFORM public.check_out_attendance(NULL, v_outside_lat, v_outside_lng, 20, false);
    PERFORM pg_temp.tassert('R17 checkout: outside radius OK', true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert('R17 checkout: outside radius OK', false, SQLERRM);
  END;

  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp;
  PERFORM pg_temp.as_emp(v_emp, '198.51.100.9');
  BEGIN
    PERFORM public.check_out_attendance(NULL, v_inside_lat, v_inside_lng, 20, false);
    PERFORM pg_temp.tassert('R17 checkout: inside on mobile data rejected', false, 'should have raised');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert('R17 checkout: inside on mobile data rejected',
      SQLERRM ILIKE '%not_on_office_wifi%', SQLERRM);
  END;

  --------------------------------------------------------------------------
  -- Direct insert Present without evidence rejected
  --------------------------------------------------------------------------
  BEGIN
    INSERT INTO public.attendance_records (
      user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
    ) VALUES (
      v_emp, v_att_date - 1, 'present', 'approved', v_now, 'manual'
    );
    PERFORM pg_temp.tassert('R17 direct Present insert rejected', false, 'insert succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert('R17 direct Present insert rejected',
      SQLERRM ILIKE '%attendance_present_requires_wifi_and_gps%', SQLERRM);
  END;

  --------------------------------------------------------------------------
  -- shift_end_close closer still works
  --------------------------------------------------------------------------
  PERFORM set_config('scorr.attendance_write_mode', 'shift_end_close', true);
  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  PERFORM pg_temp.tassert('R17 shift_end_close closer callable', v_n >= 0, format('n=%s', v_n));
  v_n := public.attendance_close_ended_windows();
  PERFORM pg_temp.tassert('R17 cron closer callable', v_n >= 0, format('n=%s', v_n));

END;
$test$;

SELECT name, status, detail FROM r17_results ORDER BY name;
ROLLBACK;
`;

async function main() {
  console.log('Project', projectRef);
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
    console.log(`${st}\t${name}${detail ? ' — ' + String(detail).slice(0, 180) : ''}`);
    if (st === 'FAIL') fail += 1;
  }
  console.log(`\n${rows.length - fail} PASS / ${fail} FAIL / ${rows.length} total`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
