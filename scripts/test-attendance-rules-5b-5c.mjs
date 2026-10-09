#!/usr/bin/env node
/**
 * Rules 5b (no office Wi-Fi timeout) and 5c (device offline timeout).
 * Also verifies connection_lost late adjust + existing Rule 5 outside checkout.
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

const sfx = 'r5bc' + randomBytes(4).toString('hex');
const token = 'tok-' + sfx;
const tokenHash = createHash('sha256').update(token).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE r5_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO r5_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_remote UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
  v_dev UUID;
  v_laptop UUID;
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE := (v_now AT TIME ZONE 'UTC')::date;
  v_rec UUID;
  v_visit UUID;
  v_n INTEGER;
  v_out TIMESTAMPTZ;
  v_notes TEXT;
  v_open INTEGER;
  v_counts_before RECORD;
  v_counts_after RECORD;
  v_lat DOUBLE PRECISION := 31.5204;
  v_lng DOUBLE PRECISION := 74.3587;
BEGIN
  SELECT count(*)::int AS records, (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_before
  FROM public.attendance_records;

  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes
  ) VALUES (
    'R5BC Co '||v_sfx, 'r5bc-co-'||v_sfx, 'r5bc_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('R5BC Dept', 'r5bc-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (
    v_company, 'R5BC Office', v_lat, v_lng, 150, true
  ) RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (
    v_office, v_company, 'R5BC WiFi', ARRAY['203.0.113.10/32'], true
  );

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_r5bc_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin R5BC'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_r5bc_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp R5BC','manager_id',v_admin),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_remote, 'authenticated', 'authenticated',
    'remote_r5bc_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Remote R5BC','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true WHERE id=v_emp;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='remote' WHERE id=v_remote;

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'R5BC Shift',
    ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
    ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att_date - 1, v_admin), (v_remote, v_shift, v_att_date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_office, 'R5BC Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state
  ) VALUES (
    v_emp, v_company, 'phone-'||v_sfx, 'android', '${tokenHash}', '1.3.13', 'left'
  ) RETURNING id INTO v_dev;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state
  ) VALUES (
    v_emp, v_company, 'laptop-'||v_sfx, 'windows', encode(digest('lap-'||v_sfx, 'sha256'), 'hex'), '1.3.13', 'left'
  ) RETURNING id INTO v_laptop;

  --------------------------------------------------------------------------
  -- Helper: open a visit for emp
  --------------------------------------------------------------------------
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
  ) VALUES (
    v_emp, v_att_date, 'present', 'approved', v_now - INTERVAL '30 minutes', 'Checked in on office Wi-Fi', 'geo', v_shift
  ) RETURNING id INTO v_rec;

  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_emp, v_rec, v_att_date, 1, v_now - INTERVAL '30 minutes', 'Checked in on office Wi-Fi'
  ) RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);

  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '1 minute',
    last_any_signal_at = v_now - INTERVAL '1 minute',
    last_inside_gps_at = NULL
  WHERE id = v_emp;

  -- 5b: office signals every minute → stay in
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('5b: recent office signal stays in', v_open = 1, 'open='||v_open);

  -- 5b: last office 9 min ago → stay in
  UPDATE public.users SET last_office_signal_at = v_now - INTERVAL '9 minutes', last_any_signal_at = v_now - INTERVAL '1 minute' WHERE id = v_emp;
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('5b: 9 min ago stays in', v_open = 1, 'open='||v_open);

  -- 5b: last office 11 min ago BUT inside GPS 3 min ago → stay in
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '11 minutes',
    last_any_signal_at = v_now - INTERVAL '1 minute',
    last_inside_gps_at = v_now - INTERVAL '3 minutes'
  WHERE id = v_emp;
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('5b: inside GPS exception stays in', v_open = 1, 'open='||v_open);

  -- 5b: last office 11 min ago, no inside GPS, other events on mobile → check out
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '11 minutes',
    last_any_signal_at = v_now - INTERVAL '30 seconds',
    last_inside_gps_at = NULL
  WHERE id = v_emp;
  v_n := public.attendance_apply_rule_5b();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    '5b: 11 min no office Wi-Fi checks out',
    v_n = 1 AND v_out IS NOT NULL AND v_notes ILIKE '%No office Wi-Fi for 10 minutes%',
    'n='||v_n||' out='||COALESCE(v_out::text,'null')||' notes='||COALESCE(v_notes,'')
  );
  PERFORM pg_temp.tassert(
    '5b: out time = last office signal',
    abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '11 minutes')))) < 2,
    'out='||COALESCE(v_out::text,'null')
  );

  -- Re-open for 5c tests
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.attendance_devices SET presence_state = 'present' WHERE user_id = v_emp;

  -- 5c: no event for 2 min → stay in
  UPDATE public.users SET last_any_signal_at = v_now - INTERVAL '2 minutes', last_office_signal_at = v_now - INTERVAL '2 minutes', last_inside_gps_at = NULL WHERE id = v_emp;
  PERFORM public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('5c: 2 min stays in', v_open = 1, 'open='||v_open);

  -- 5c: phone offline but laptop sending (any signal fresh) → stay in
  UPDATE public.users SET last_any_signal_at = v_now - INTERVAL '20 seconds', last_office_signal_at = v_now - INTERVAL '20 seconds' WHERE id = v_emp;
  PERFORM public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('5c: laptop signal keeps present', v_open = 1, 'open='||v_open);

  -- 5c: no event for 4 min → check out
  UPDATE public.users SET last_any_signal_at = v_now - INTERVAL '4 minutes', last_office_signal_at = v_now - INTERVAL '20 minutes', last_inside_gps_at = NULL WHERE id = v_emp;
  v_n := public.attendance_apply_rule_5c();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    '5c: 4 min offline checks out',
    v_n = 1 AND v_out IS NOT NULL AND v_notes ILIKE '%Device offline%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );
  PERFORM pg_temp.tassert(
    '5c: out time = last signal',
    abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '4 minutes')))) < 2,
    'out='||COALESCE(v_out::text,'null')
  );

  -- connection_lost 20 min late moves out earlier (visit already closed by 5c)
  v_n := public.attendance_close_visit_with_note(
    v_emp, v_now - INTERVAL '5 minutes', 'Device offline (no Wi-Fi or mobile data)', true
  );
  SELECT clock_out_at INTO v_out FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'connection_lost moves out earlier',
    v_n = 1 AND abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '5 minutes')))) < 2,
    'n='||v_n||' out='||COALESCE(v_out::text,'null')
  );

  -- connection_lost never creates check-in (handler on closed visit with later time → no reopen)
  v_n := public.attendance_close_visit_with_note(
    v_emp, v_now - INTERVAL '1 minute', 'Device offline (no Wi-Fi or mobile data)', true
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('connection_lost never reopens / never later', v_open = 0 AND v_n = 0, 'open='||v_open||' n='||v_n);

  -- Remote user exempt from 5b/5c
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, attendance_source, shift_id
  ) VALUES (v_remote, v_att_date, 'present', 'approved', v_now - INTERVAL '40 minutes', 'manual', v_shift)
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at
  ) VALUES (v_remote, v_rec, v_att_date, 1, v_now - INTERVAL '40 minutes') RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET last_office_signal_at = v_now - INTERVAL '30 minutes', last_any_signal_at = v_now - INTERVAL '30 minutes' WHERE id = v_remote;
  PERFORM public.attendance_apply_rule_5c();
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('remote exempt from 5b/5c', v_open = 1, 'open='||v_open);

  -- Cleanup test rows (keep global counts stable for assertion below)
  DELETE FROM public.attendance_visit_segments WHERE user_id IN (v_emp, v_remote);
  DELETE FROM public.attendance_records WHERE user_id IN (v_emp, v_remote);
  DELETE FROM public.attendance_devices WHERE company_id = v_company;
  DELETE FROM public.employee_work_sites WHERE user_id = v_emp;
  DELETE FROM public.employee_shift_assignments WHERE user_id IN (v_emp, v_remote);
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE company_id = v_company;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_emp, v_remote, v_admin);
  DELETE FROM auth.users WHERE id IN (v_emp, v_remote, v_admin);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;

  SELECT count(*)::int AS records, (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_after
  FROM public.attendance_records;

  PERFORM pg_temp.tassert(
    'counts unchanged',
    v_counts_before.records = v_counts_after.records AND v_counts_before.visits = v_counts_after.visits,
    format('records %s->%s visits %s->%s', v_counts_before.records, v_counts_after.records, v_counts_before.visits, v_counts_after.visits)
  );
END;
$test$;

SELECT name, status, detail FROM r5_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
const list = Array.isArray(rows) ? rows : [];
let pass = 0;
let fail = 0;
for (const row of list) {
  const line = `${row.status}\t${row.name} — ${row.detail || ''}`;
  console.log(line);
  if (row.status === 'PASS') pass++;
  else fail++;
}
console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} total`);
process.exit(fail ? 1 : 0);
