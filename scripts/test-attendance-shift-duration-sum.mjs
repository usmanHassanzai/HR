#!/usr/bin/env node
/**
 * Shift duration = sum of visits (overlap-merged). BEGIN…ROLLBACK only.
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

const sfx = 'sds' + randomBytes(4).toString('hex');

const query = `
BEGIN;

CREATE TEMP TABLE sds_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO sds_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
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
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_day DATE := (v_now AT TIME ZONE 'UTC')::date;
  v_rec UUID;
  v_total INTEGER;
  v_summ RECORD;
  v_left INTEGER;
BEGIN
  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance
  ) VALUES (
    'SDS Co '||v_sfx, 'sds-co-'||v_sfx, 'sds_'||v_sfx||'@scorr.test', 'UTC',
    true, true
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('SDS Dept', 'sds-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'SDS Office', 24.86, 67.00, 150, true)
  RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'SDS WiFi', ARRAY['203.0.113.90/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_sds_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin SDS'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_sds_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp SDS'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office' WHERE id=v_emp;

  -- Day shift 00:00-23:59 for simple span tests
  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'SDS Day', '00:00:00'::time, '23:59:59'::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_day - 2, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_office, 'SDS Office', 24.86, 67.00, 150, true);

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_out_at, attendance_source, shift_id, work_minutes, notes, presence_method
  ) VALUES (
    v_emp, v_day, 'present', 'approved', v_emp,
    v_day + TIME '08:00', v_day + TIME '12:00', 'auto_wifi', v_shift, 999, 'SDS seed', 'wifi'
  ) RETURNING id INTO v_rec;

  -- 3 visits: 10m, 13m, 30m → 53m
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number,
    clock_in_at, clock_out_at, work_minutes, notes
  ) VALUES
    (gen_random_uuid(), v_emp, v_rec, v_day, 1,
      v_day + TIME '08:00', v_day + TIME '08:10', 10, 'v1'),
    (gen_random_uuid(), v_emp, v_rec, v_day, 2,
      v_day + TIME '09:00', v_day + TIME '09:13', 13, 'v2'),
    (gen_random_uuid(), v_emp, v_rec, v_day, 3,
      v_day + TIME '10:00', v_day + TIME '10:30', 30, 'v3');

  v_total := public.attendance_shift_total_minutes(v_emp, v_day, v_now);
  PERFORM pg_temp.tassert('three_visits_53m', v_total = 53, format('got %s', v_total));

  SELECT * INTO v_summ FROM public.attendance_shift_day_summary(v_emp, v_day, v_now);
  PERFORM pg_temp.tassert(
    'summary_matches',
    v_summ.total_minutes = 53 AND v_summ.visit_count = 3 AND v_summ.still_present = false,
    format('total=%s visits=%s present=%s', v_summ.total_minutes, v_summ.visit_count, v_summ.still_present)
  );

  -- Clear and test overnight: 22:00-23:30 + 00:15-02:00 = 3h15m = 195m
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  UPDATE public.work_shifts SET
    start_time = '18:00:00'::time, end_time = '03:00:00'::time,
    crosses_midnight = true, timezone = 'UTC'
  WHERE id = v_shift;

  -- Shift date = calendar day of shift start
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number,
    clock_in_at, clock_out_at, notes
  ) VALUES
    (gen_random_uuid(), v_emp, v_rec, v_day, 1,
      (v_day + TIME '22:00')::timestamptz,
      (v_day + TIME '23:30')::timestamptz, 'eve'),
    (gen_random_uuid(), v_emp, v_rec, v_day, 2,
      ((v_day + 1) + TIME '00:15')::timestamptz,
      ((v_day + 1) + TIME '02:00')::timestamptz, 'night');

  v_total := public.attendance_shift_total_minutes(v_emp, v_day, v_now);
  PERFORM pg_temp.tassert('overnight_195m', v_total = 195, format('got %s', v_total));

  -- Open visit started 1 hour ago → 60m (cap not hit on day shift reopen)
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  UPDATE public.work_shifts SET
    start_time = '00:00:00'::time, end_time = '23:59:59'::time,
    crosses_midnight = false
  WHERE id = v_shift;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number,
    clock_in_at, clock_out_at, notes
  ) VALUES (
    gen_random_uuid(), v_emp, v_rec, v_day, 1,
    v_now - INTERVAL '1 hour', NULL, 'open'
  );
  v_total := public.attendance_shift_total_minutes(v_emp, v_day, v_now);
  PERFORM pg_temp.tassert(
    'open_1h',
    v_total BETWEEN 59 AND 61,
    format('got %s', v_total)
  );

  -- Overlap phone 10:00-11:00 + laptop 10:30-11:30 → 90m not 120m
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number,
    clock_in_at, clock_out_at, notes
  ) VALUES
    (gen_random_uuid(), v_emp, v_rec, v_day, 1,
      v_day + TIME '10:00', v_day + TIME '11:00', 'phone'),
    (gen_random_uuid(), v_emp, v_rec, v_day, 2,
      v_day + TIME '10:30', v_day + TIME '11:30', 'laptop');
  v_total := public.attendance_shift_total_minutes(v_emp, v_day, v_now);
  PERFORM pg_temp.tassert('overlap_90m', v_total = 90, format('got %s', v_total));

  -- history_work_minutes matches
  v_total := public.attendance_history_work_minutes(
    v_emp, v_day, v_day + TIME '10:00', v_day + TIME '11:30', 999, 'manual', NULL
  );
  PERFORM pg_temp.tassert('history_helper_90m', v_total = 90, format('got %s', v_total));

  SELECT count(*)::int INTO v_left FROM public.companies WHERE slug = 'sds-co-'||v_sfx;
  PERFORM pg_temp.tassert('seed_in_txn', v_left = 1, v_left::text);
END;
$test$;

SELECT * FROM sds_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
console.log(JSON.stringify(rows, null, 2));
const fails = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.error('FAILED', fails);
  process.exit(1);
}
const left = await sql(`SELECT count(*)::int AS n FROM public.companies WHERE slug = 'sds-co-${sfx}'`);
const n = Array.isArray(left) ? left[0]?.n : left?.n;
console.log('leftover after ROLLBACK:', n);
if (Number(n) !== 0) {
  console.error('TEST DATA LEFT');
  process.exit(1);
}
console.log('0 test rows left');
console.log('All shift-duration-sum tests passed.');
