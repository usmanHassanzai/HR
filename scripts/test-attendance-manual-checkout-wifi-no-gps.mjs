#!/usr/bin/env node
/**
 * Manual Clock out on office Wi-Fi when GPS off/unusable. Rolled back.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

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

const sfx = 'mco' + randomBytes(4).toString('hex');

const query = `
BEGIN;
CREATE TEMP TABLE mco_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO mco_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

CREATE OR REPLACE FUNCTION pg_temp.as_emp(p_uid uuid, p_ip text)
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', json_build_object(
    'x-forwarded-for', p_ip,
    'x-real-ip', p_ip
  )::text, true);
END;
$a$;

DO $test$
DECLARE
  v_company UUID; v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_office UUID; v_shift UUID;
  v_lat DOUBLE PRECISION := 41.8781;
  v_lng DOUBLE PRECISION := -87.6298;
  v_in_lat DOUBLE PRECISION := 41.87815;
  v_in_lng DOUBLE PRECISION := -87.62985;
  v_out_lat DOUBLE PRECISION := 41.90;
  v_out_lng DOUBLE PRECISION := -87.70;
  v_start TIME; v_end TIME; v_att DATE;
  v_res JSONB; v_chk RECORD; v_id UUID; v_open INT; v_notes TEXT;
  v_rec_before BIGINT; v_vis_before BIGINT; v_rec_after BIGINT; v_vis_after BIGINT;
BEGIN
  SELECT count(*) INTO v_rec_before FROM public.attendance_records;
  SELECT count(*) INTO v_vis_before FROM public.attendance_visit_segments;

  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance)
  VALUES ('Mco Co '||v_sfx, 'mco-co-'||v_sfx, 'mco_'||v_sfx||'@scorr.test', 'UTC', true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Mco Dept', 'mco-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_mco_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_mco_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office' WHERE id=v_emp;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Mco Office', v_lat, v_lng, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_office;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_office, 'Mco Office', v_lat, v_lng, 150, true);

  v_att := (v_now AT TIME ZONE 'UTC')::date;
  v_start := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;
  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('Mco Shift', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  -- Shared: office Wi-Fi + no GPS → wifi_no_gps checkout ok
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, NULL, NULL, NULL, false, '203.0.113.10', 'check_out'
  );
  PERFORM pg_temp.tassert(1, 'shared: office Wi-Fi no GPS → wifi_no_gps',
    v_chk.ok AND v_chk.match_kind = 'wifi_no_gps', row_to_json(v_chk)::text);

  -- Shared: mobile data + no GPS rejected
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, NULL, NULL, NULL, false, '8.8.8.8', 'check_out'
  );
  PERFORM pg_temp.tassert(2, 'shared: mobile data no GPS rejected',
    NOT v_chk.ok AND v_chk.reason = 'not_on_office_wifi', row_to_json(v_chk)::text);

  -- Shared: mock rejected
  SELECT * INTO v_chk FROM public.attendance_office_presence_check(
    v_emp, v_in_lat, v_in_lng, 20, true, '203.0.113.10', 'check_out'
  );
  PERFORM pg_temp.tassert(3, 'shared: mock rejected',
    NOT v_chk.ok, row_to_json(v_chk)::text);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');

  -- Seed open visit (wifi_no_gps check-in)
  v_res := public.process_geo_attendance_ping(NULL, NULL, NULL, 'clock_in', false);
  PERFORM pg_temp.tassert(4, 'setup check-in wifi_no_gps',
    (v_res->>'action') = 'clock_in', v_res::text);

  -- 1) Office Wi-Fi + location off → Clock out OK
  v_res := public.process_geo_attendance_ping(NULL, NULL, NULL, 'clock_out', false);
  SELECT count(*)::int INTO v_open FROM public.attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  SELECT notes INTO v_notes FROM public.attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(5, 'office Wi-Fi + no GPS → Clock out OK',
    (v_res->>'action') = 'clock_out' AND v_open = 0
      AND v_notes ILIKE '%Clocked out on office Wi-Fi, location unavailable%',
    format('open=%s notes=%s %s', v_open, v_notes, v_res::text));

  -- Re-open for next cases
  UPDATE public.attendance_records SET clock_out_at = NULL, notes = 'Checked in on office Wi-Fi, location unavailable'
  WHERE user_id = v_emp AND attendance_date = v_att;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL
  WHERE user_id = v_emp AND attendance_date = v_att;

  -- 2) Office Wi-Fi + GPS inside → Clock out OK
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_out', false);
  PERFORM pg_temp.tassert(6, 'office Wi-Fi + GPS inside → Clock out OK',
    (v_res->>'action') = 'clock_out', v_res::text);

  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = v_att;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL
  WHERE user_id = v_emp AND attendance_date = v_att;

  -- 3) GPS outside → Clock out OK
  v_res := public.process_geo_attendance_ping(v_out_lat, v_out_lng, 20, 'clock_out', false);
  PERFORM pg_temp.tassert(7, 'GPS outside → Clock out OK',
    (v_res->>'action') = 'clock_out', v_res::text);

  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = v_att;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL
  WHERE user_id = v_emp AND attendance_date = v_att;

  -- 4) Mobile data + location off → rejected
  PERFORM pg_temp.as_emp(v_emp, '8.8.8.8');
  v_res := public.process_geo_attendance_ping(NULL, NULL, NULL, 'clock_out', false);
  PERFORM pg_temp.tassert(8, 'mobile data + no GPS rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','not_on_office_network'),
    v_res::text);

  -- 5) Mobile data + GPS inside → rejected
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_out', false);
  PERFORM pg_temp.tassert(9, 'mobile data + GPS inside rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','not_on_office_network'),
    v_res::text);

  -- 6) Mock → rejected
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_out', true);
  PERFORM pg_temp.tassert(10, 'mock rejected',
    (v_res->>'action') IN ('gps_unusable') OR (v_res->>'reason') IN ('gps_unusable','mock_location'),
    v_res::text);

  -- Leave panel path: check_out_attendance wifi_no_gps
  v_id := public.check_out_attendance(NULL, NULL, NULL, NULL, false);
  SELECT count(*)::int INTO v_open FROM public.attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  SELECT notes INTO v_notes FROM public.attendance_records WHERE user_id = v_emp AND attendance_date = v_att;
  PERFORM pg_temp.tassert(11, 'check_out_attendance wifi_no_gps OK',
    v_id IS NOT NULL AND v_open = 0
      AND v_notes ILIKE '%Clocked out on office Wi-Fi, location unavailable%',
    format('id=%s open=%s notes=%s', v_id, v_open, v_notes));

  -- 7) After shift end + 1 hour → rejected
  UPDATE public.attendance_records SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = v_att;
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL WHERE user_id = v_emp AND attendance_date = v_att;
  UPDATE public.work_shifts
  SET start_time = ((v_now - INTERVAL '8 hours') AT TIME ZONE 'UTC')::time,
      end_time = ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time
  WHERE id = v_shift;
  BEGIN
    PERFORM public.check_out_attendance(NULL, NULL, NULL, NULL, false);
    PERFORM pg_temp.tassert(12, 'after shift end + 1h rejected', false, 'should have raised');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.tassert(12, 'after shift end + 1h rejected',
      SQLERRM ILIKE '%outside_window%' OR SQLERRM ILIKE '%window%', SQLERRM);
  END;

  -- cleanup test rows only
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.employee_location_pings WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.employee_work_sites WHERE user_id = v_emp;
  DELETE FROM public.office_wifi_networks WHERE office_location_id = v_office;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_admin, v_emp);
  DELETE FROM auth.users WHERE id IN (v_admin, v_emp);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;

  SELECT count(*) INTO v_rec_after FROM public.attendance_records;
  SELECT count(*) INTO v_vis_after FROM public.attendance_visit_segments;
  PERFORM pg_temp.tassert(13, 'counts unchanged',
    v_rec_after = v_rec_before AND v_vis_after = v_vis_before,
    format('records %s->%s visits %s->%s', v_rec_before, v_rec_after, v_vis_before, v_vis_after));
END;
$test$;

SELECT ord, name, status, left(detail, 220) AS detail FROM mco_results ORDER BY ord;
ROLLBACK;
`;

console.log('Project', projectRef);
const rows = await sql(query);
let fail = 0;
for (const r of Array.isArray(rows) ? rows : []) {
  if (r.status === 'FAIL') fail++;
  console.log(`${r.status}\t${r.name} — ${r.detail || ''}`.trim());
}
console.log(`\n${(Array.isArray(rows) ? rows.length : 0) - fail} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
