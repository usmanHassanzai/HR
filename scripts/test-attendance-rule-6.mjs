#!/usr/bin/env node
/**
 * Rule 6: force-close at shift end + 1 hour; recorded out = shift end.
 * Usage: SUPABASE_PROJECT_REF=yvnbxweitelowucdhwpg node scripts/test-attendance-rule-6.mjs
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
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 2000));
  return body;
}

const query = `
BEGIN;

CREATE TEMP TABLE r6_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO r6_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_shift UUID;
  v_sfx TEXT := 'r6t' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_end_grace TIMESTAMPTZ;
  v_end_force TIMESTAMPTZ;
  v_end_zone TIMESTAMPTZ;
  v_att_date DATE;
  v_start_t TIME;
  v_end_t TIME;
  v_n INTEGER;
  v_out TIMESTAMPTZ;
  v_notes TEXT;
  v_presence TEXT;
  v_still BOOLEAN;
  v_rec UUID;
  v_latest TIMESTAMPTZ;
BEGIN
  v_end_grace := v_now - INTERVAL '30 minutes';
  v_end_force := v_now - INTERVAL '90 minutes';
  -- Later clock ended 20m ago → latest_end+1h is still ~40m ahead (stay open).
  v_end_zone := v_now - INTERVAL '20 minutes';

  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('R6 Co '||v_sfx, 'r6-co-'||v_sfx, 'r6_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('R6 Dept', 'r6-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_r6_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin R6'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_r6_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp R6','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept, manager_id=v_admin WHERE id=v_emp;

  --------------------------------------------------------------------------
  -- 1) Within shift-end + 1h grace → stay open
  --------------------------------------------------------------------------
  v_end_t := (v_end_grace AT TIME ZONE 'UTC')::time;
  v_start_t := ((v_end_grace - INTERVAL '3 hours') AT TIME ZONE 'UTC')::time;
  IF v_start_t > v_end_t THEN
    v_att_date := ((v_end_grace - INTERVAL '3 hours') AT TIME ZONE 'UTC')::date;
  ELSE
    v_att_date := (v_end_grace AT TIME ZONE 'UTC')::date;
  END IF;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'R6 Grace', v_start_t, v_end_t, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC',
    (v_start_t > v_end_t)
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att_date - 30, v_admin);

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_out_at,
    attendance_source, shift_id, work_minutes
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_end_grace - INTERVAL '2 hours', NULL,
    'geo', v_shift, NULL
  ) RETURNING id INTO v_rec;

  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at
  ) VALUES (v_emp, v_rec, v_att_date, 1, v_end_grace - INTERVAL '2 hours', NULL);

  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  SELECT clock_out_at INTO v_out FROM public.attendance_records WHERE id = v_rec;
  PERFORM pg_temp.tassert(
    'R6.1 grace: stay open until end+1h',
    v_n = 0 AND v_out IS NULL,
    format('n=%s out=%s end=%s now=%s', v_n, v_out, v_end_grace, v_now)
  );

  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- 2) Past end+1h → close at shift END, note "Shift ended"
  --------------------------------------------------------------------------
  v_end_t := (v_end_force AT TIME ZONE 'UTC')::time;
  v_start_t := ((v_end_force - INTERVAL '3 hours') AT TIME ZONE 'UTC')::time;
  IF v_start_t > v_end_t THEN
    v_att_date := ((v_end_force - INTERVAL '3 hours') AT TIME ZONE 'UTC')::date;
  ELSE
    v_att_date := (v_end_force AT TIME ZONE 'UTC')::date;
  END IF;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'R6 Force', v_start_t, v_end_t, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC',
    (v_start_t > v_end_t)
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att_date - 30, v_admin);

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_out_at,
    attendance_source, shift_id, work_minutes
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_end_force - INTERVAL '2 hours', NULL,
    'geo', v_shift, NULL
  ) RETURNING id INTO v_rec;

  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at
  ) VALUES (v_emp, v_rec, v_att_date, 1, v_end_force - INTERVAL '2 hours', NULL);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_presence_at)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', encode(sha256(('tok-'||v_sfx)::bytea), 'hex'), '1.3.9', 'present', v_now);

  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_records WHERE id = v_rec;
  SELECT presence_state INTO v_presence FROM public.attendance_devices WHERE user_id = v_emp LIMIT 1;

  v_latest := public.shift_latest_end_timestamptz(v_shift, v_att_date, v_start_t, v_end_t, v_end_force - INTERVAL '2 hours', 'UTC');

  PERFORM pg_temp.tassert(
    'R6.2 force-close at end+1h records shift END',
    v_n = 1
      AND v_out IS NOT NULL
      AND abs(EXTRACT(EPOCH FROM (v_out - v_latest))) < 2
      AND COALESCE(v_notes, '') ILIKE '%Shift ended%'
      AND v_presence = 'left',
    format('n=%s out=%s latest=%s notes=%s presence=%s', v_n, v_out, v_latest, v_notes, v_presence)
  );

  --------------------------------------------------------------------------
  -- 3) Idempotent second close
  --------------------------------------------------------------------------
  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  PERFORM pg_temp.tassert('R6.3 idempotent second close', v_n = 0, format('n=%s', v_n));

  v_still := public.attendance_history_still_open(v_emp, v_end_force - INTERVAL '2 hours', false);
  PERFORM pg_temp.tassert(
    'R6.4 history not still-working when visits closed',
    v_still IS FALSE,
    format('still=%s', v_still)
  );

  DELETE FROM public.attendance_devices WHERE user_id = v_emp;
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_emp;
  DELETE FROM public.attendance_records WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id = v_emp;
  DELETE FROM public.shift_display_zones WHERE shift_id = v_shift;
  DELETE FROM public.work_shifts WHERE id = v_shift;

  --------------------------------------------------------------------------
  -- 5) Two-clock: latest display-zone end drives force-close time
  --------------------------------------------------------------------------
  v_end_t := (v_end_force AT TIME ZONE 'UTC')::time;
  v_start_t := ((v_end_force - INTERVAL '3 hours') AT TIME ZONE 'UTC')::time;
  IF v_start_t > v_end_t THEN
    v_att_date := ((v_end_force - INTERVAL '3 hours') AT TIME ZONE 'UTC')::date;
  ELSE
    v_att_date := (v_end_force AT TIME ZONE 'UTC')::date;
  END IF;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'R6 Dual', v_start_t, v_end_t, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC',
    (v_start_t > v_end_t)
  ) RETURNING id INTO v_shift;

  INSERT INTO public.shift_display_zones (shift_id, timezone, entered_start_time, entered_end_time)
  VALUES (
    v_shift,
    'UTC',
    ((v_end_zone - INTERVAL '3 hours') AT TIME ZONE 'UTC')::time,
    (v_end_zone AT TIME ZONE 'UTC')::time
  );

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att_date - 30, v_admin);

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, clock_out_at,
    attendance_source, shift_id, work_minutes
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_end_force - INTERVAL '2 hours', NULL,
    'auto_laptop', v_shift, NULL
  ) RETURNING id INTO v_rec;

  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at
  ) VALUES (v_emp, v_rec, v_att_date, 1, v_end_force - INTERVAL '2 hours', NULL);

  v_latest := public.shift_latest_end_timestamptz(
    v_shift, v_att_date, v_start_t, v_end_t, v_end_force - INTERVAL '2 hours', 'UTC'
  );
  -- Zone end (70m ago) is later than main end (90m ago) → latest should be zone end.
  PERFORM pg_temp.tassert(
    'R6.5 two-clock latest end uses later zone',
    abs(EXTRACT(EPOCH FROM (v_latest - v_end_zone))) < 120,
    format('latest=%s zone=%s main=%s', v_latest, v_end_zone, v_end_force)
  );

  -- Zone end + 1h = now + ~10m → still inside grace → must stay open
  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  SELECT clock_out_at INTO v_out FROM public.attendance_records WHERE id = v_rec;
  PERFORM pg_temp.tassert(
    'R6.6 two-clock grace until latest_end+1h',
    v_n = 0 AND v_out IS NULL,
    format('n=%s out=%s latest=%s', v_n, v_out, v_latest)
  );

  -- Push zone end far enough into the past so force-close runs
  UPDATE public.shift_display_zones
  SET entered_end_time = ((v_now - INTERVAL '90 minutes') AT TIME ZONE 'UTC')::time,
      entered_start_time = ((v_now - INTERVAL '4 hours') AT TIME ZONE 'UTC')::time
  WHERE shift_id = v_shift;

  UPDATE public.work_shifts
  SET end_time = ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
      start_time = ((v_now - INTERVAL '5 hours') AT TIME ZONE 'UTC')::time,
      crosses_midnight = false
  WHERE id = v_shift;

  v_latest := public.shift_latest_end_timestamptz(
    v_shift, v_att_date,
    ((v_now - INTERVAL '5 hours') AT TIME ZONE 'UTC')::time,
    ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
    v_end_force - INTERVAL '2 hours', 'UTC'
  );

  v_n := public.close_open_attendance_if_shift_ended(v_emp, NULL, NULL);
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_records WHERE id = v_rec;
  PERFORM pg_temp.tassert(
    'R6.7 two-clock force-close at latest shift END',
    v_n = 1
      AND v_out IS NOT NULL
      AND abs(EXTRACT(EPOCH FROM (v_out - v_latest))) < 2
      AND COALESCE(v_notes, '') ILIKE '%Shift ended%',
    format('n=%s out=%s latest=%s notes=%s', v_n, v_out, v_latest, v_notes)
  );

  --------------------------------------------------------------------------
  -- 6) Cron path delegates to closer (no early close)
  --------------------------------------------------------------------------
  v_n := public.attendance_close_ended_windows();
  PERFORM pg_temp.tassert('R6.8 cron closer runs without error', v_n >= 0, format('n=%s', v_n));

END;
$test$;

SELECT name, status, detail FROM r6_results ORDER BY name;
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
