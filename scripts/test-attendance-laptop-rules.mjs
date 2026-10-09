#!/usr/bin/env node
/**
 * Laptop-only rules L1–L7 (sleep / wake / off-office / shutdown).
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

const sfx = 'lap' + randomBytes(4).toString('hex');
const tokLap = createHash('sha256').update('tok-lap-' + sfx).digest('hex');
const tokAnd = createHash('sha256').update('tok-and-' + sfx).digest('hex');
const tokPhone = createHash('sha256').update('tok-ph-' + sfx).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE lap_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO lap_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_lap UUID := gen_random_uuid();
  v_both UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
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
  v_res jsonb;
  v_sleep TIMESTAMPTZ;
  v_col boolean;
BEGIN
  SELECT count(*)::int AS records, (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_before FROM public.attendance_records;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='companies' AND column_name='attendance_laptop_sleep_minutes'
  ) INTO v_col;
  PERFORM pg_temp.tassert('schema: attendance_laptop_sleep_minutes', v_col, '');

  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes,
    ios_office_signal_timeout, attendance_laptop_sleep_minutes
  ) VALUES (
    'LAP Co '||v_sfx, 'lap-co-'||v_sfx, 'lap_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3, 30, 30
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('LAP Dept', 'lap-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'LAP Office', v_lat, v_lng, 150, true) RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'LAP WiFi', ARRAY['203.0.113.77/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_lap_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin LAP'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_lap, 'authenticated', 'authenticated',
    'lap_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Laptop Only'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_both, 'authenticated', 'authenticated',
    'both_lap_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Laptop+Android'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true
  WHERE id IN (v_lap, v_both);

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'LAP Shift',
    ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
    ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_lap, v_shift, v_att_date - 1, v_admin), (v_both, v_shift, v_att_date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES
    (v_lap, v_office, 'LAP Office', v_lat, v_lng, 150, true),
    (v_both, v_office, 'LAP Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_lap, v_company, 'win-'||v_sfx, 'windows', '${tokLap}', '1.3.15', 'present', v_now),
    (v_both, v_company, 'win2-'||v_sfx, 'windows', '${tokAnd}', '1.3.15', 'present', v_now - INTERVAL '30 minutes'),
    (v_both, v_company, 'ph-'||v_sfx, 'android', '${tokPhone}', '1.3.15', 'present', v_now - INTERVAL '30 seconds');

  --------------------------------------------------------------------------
  -- Open visit for laptop-only
  --------------------------------------------------------------------------
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
  ) VALUES (
    v_lap, v_att_date, 'present', 'approved', v_now - INTERVAL '40 minutes', 'Checked in', 'geo', v_shift
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_lap, v_rec, v_att_date, 1, v_now - INTERVAL '40 minutes', 'Checked in'
  ) RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);

  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '5 minutes',
    last_any_signal_at = v_now - INTERVAL '5 minutes',
    laptop_sleep_at = NULL,
    laptop_off_office_count = 0,
    laptop_off_office_since = NULL
  WHERE id = v_lap;

  PERFORM pg_temp.tassert(
    'laptop-only mode',
    public.attendance_user_uses_laptop_only_rules(v_lap) = true, ''
  );

  -- L2: sleep 20 min, wake on office → same visit
  v_sleep := v_now - INTERVAL '20 minutes';
  v_res := public.attendance_handle_device_sleep(
    v_lap, v_company, (SELECT id FROM public.attendance_devices WHERE token_hash='${tokLap}'),
    'device_sleep', v_sleep, 0, false, '203.0.113.77', 'windows', '1.3.15', 'office'
  );
  PERFORM public.attendance_apply_rule_5c();
  PERFORM public.attendance_apply_rule_5b();
  PERFORM public.attendance_apply_laptop_rules();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('L1/L2: sleep 20m still open before wake', v_open = 1, 'open='||v_open);

  v_res := public.attendance_handle_device_wake(
    v_lap, v_company, (SELECT id FROM public.attendance_devices WHERE token_hash='${tokLap}'),
    'device_wake', v_now, 0, false, '203.0.113.77', 'windows', '1.3.15', 'office', true
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'L2: sleep 20m wake office same visit',
    v_open = 1 AND COALESCE(v_res->>'action','') IN ('already_checked_in','device_wake'),
    'open='||v_open||' action='||COALESCE(v_res->>'action','')
  );
  PERFORM pg_temp.tassert(
    'L2: sleep cleared',
    (SELECT laptop_sleep_at IS NULL FROM public.users WHERE id = v_lap),
    ''
  );

  -- L3: sleep 35 min → out at sleep
  UPDATE public.users SET laptop_sleep_at = v_now - INTERVAL '35 minutes' WHERE id = v_lap;
  v_n := public.attendance_apply_laptop_rules();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'L3: sleep 35m checks out',
    v_n = 1 AND v_out IS NOT NULL AND v_notes ILIKE '%Laptop asleep for more than 30 minutes%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );
  PERFORM pg_temp.tassert(
    'L3: out = sleep time',
    abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '35 minutes')))) < 2,
    'out='||COALESCE(v_out::text,'null')
  );

  -- Re-open for L4
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  v_sleep := v_now - INTERVAL '10 minutes';
  UPDATE public.users SET laptop_sleep_at = v_sleep, laptop_off_office_count = 0 WHERE id = v_lap;
  v_res := public.attendance_handle_device_wake(
    v_lap, v_company, (SELECT id FROM public.attendance_devices WHERE token_hash='${tokLap}'),
    'device_wake', v_now, 0, false, '198.51.100.9', 'windows', '1.3.15', 'office', false
  );
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'L4: wake home network outs at sleep',
    COALESCE(v_res->>'action','') = 'clock_out'
      AND v_notes ILIKE '%Laptop woke outside the office network%'
      AND abs(EXTRACT(EPOCH FROM (v_out - v_sleep))) < 2,
    'action='||COALESCE(v_res->>'action','')||' notes='||COALESCE(v_notes,'')
  );

  -- Re-open for L5
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET laptop_sleep_at = NULL, laptop_off_office_count = 0, laptop_off_office_since = NULL WHERE id = v_lap;

  v_res := public.attendance_laptop_track_off_office(v_lap, v_company, v_now - INTERVAL '2 minutes', false);
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('L5: first off-office stays in', v_open = 1 AND v_res IS NULL, 'open='||v_open);

  v_res := public.attendance_laptop_track_off_office(v_lap, v_company, v_now - INTERVAL '1 minute', false);
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'L5: second off-office checks out at first',
    COALESCE(v_res->>'action','') = 'clock_out'
      AND v_notes ILIKE '%Laptop left the office network%'
      AND abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '2 minutes')))) < 2,
    'action='||COALESCE(v_res->>'action','')||' notes='||COALESCE(v_notes,'')
  );

  -- L5b: one off then office → stays
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET laptop_sleep_at = NULL, laptop_off_office_count = 0, laptop_off_office_since = NULL WHERE id = v_lap;
  PERFORM public.attendance_laptop_track_off_office(v_lap, v_company, v_now - INTERVAL '1 minute', false);
  PERFORM public.attendance_laptop_track_off_office(v_lap, v_company, v_now, true);
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('L5: one off then office stays in', v_open = 1, 'open='||v_open);
  PERFORM pg_temp.tassert(
    'L5: streak reset',
    (SELECT laptop_off_office_count FROM public.users WHERE id = v_lap) = 0, ''
  );

  -- L6 shutdown
  v_res := public.attendance_handle_device_shutdown(
    v_lap, v_company, (SELECT id FROM public.attendance_devices WHERE token_hash='${tokLap}'),
    'device_shutdown', v_now - INTERVAL '30 seconds', 0, false, '203.0.113.77', 'windows', '1.3.15', 'office'
  );
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'L6: shutdown checks out',
    COALESCE(v_res->>'action','') = 'clock_out' AND v_notes ILIKE '%Laptop shut down%',
    'action='||COALESCE(v_res->>'action','')||' notes='||COALESCE(v_notes,'')
  );

  -- L7: awake offline 4 min → 5c
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET
    laptop_sleep_at = NULL,
    last_any_signal_at = v_now - INTERVAL '4 minutes',
    last_office_signal_at = v_now - INTERVAL '20 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_lap;
  v_n := public.attendance_apply_rule_5c();
  SELECT notes INTO v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'L7: awake offline 4m → 5c',
    v_n = 1 AND v_notes ILIKE '%Device offline%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );

  -- Late device_sleep 40 min: accepted, close only
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET laptop_sleep_at = NULL WHERE id = v_lap;
  v_sleep := v_now - INTERVAL '40 minutes';
  v_res := public.attendance_handle_device_sleep(
    v_lap, v_company, (SELECT id FROM public.attendance_devices WHERE token_hash='${tokLap}'),
    'device_sleep', v_sleep, 0, false, '203.0.113.77', 'windows', '1.3.15', 'office'
  );
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'late sleep 40m: close only at sleep',
    COALESCE(v_res->>'action','') = 'clock_out'
      AND v_notes ILIKE '%Laptop asleep%'
      AND abs(EXTRACT(EPOCH FROM (v_out - v_sleep))) < 2
      AND COALESCE(v_res->>'action','') IS DISTINCT FROM 'clock_in',
    'action='||COALESCE(v_res->>'action','')||' notes='||COALESCE(v_notes,'')
  );

  -- After laptop checkout, office wake path does not invent a check-in on sleep event
  PERFORM pg_temp.tassert(
    'late sleep never check-in',
    COALESCE(v_res->>'action','') <> 'clock_in', ''
  );

  -- New visit after checkout on office (simulate ensure via process_auto heartbeat)
  v_res := public.process_auto_attendance_event(
    '${tokLap}', 'heartbeat', NULL,
    NULL, NULL, NULL,
    NULL, NULL,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'win-'||v_sfx, 'windows', '1.3.15', '203.0.113.77'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_lap AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'after out: office heartbeat opens new visit',
    COALESCE(v_res->>'action','') = 'clock_in' AND v_open = 1,
    'action='||COALESCE(v_res->>'action','')||' open='||v_open
  );

  -- Laptop + Android: laptop asleep, phone sending → stays in (not laptop-only)
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
  ) VALUES (
    v_both, v_att_date, 'present', 'approved', v_now - INTERVAL '40 minutes', 'Checked in', 'geo', v_shift
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_both, v_rec, v_att_date, 1, v_now - INTERVAL '40 minutes', 'Checked in'
  ) RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);

  PERFORM pg_temp.tassert(
    'laptop+android: not laptop-only',
    public.attendance_user_uses_laptop_only_rules(v_both) = false, ''
  );
  UPDATE public.users SET
    laptop_sleep_at = v_now - INTERVAL '40 minutes',
    last_any_signal_at = v_now - INTERVAL '30 seconds',
    last_office_signal_at = v_now - INTERVAL '30 seconds'
  WHERE id = v_both;
  PERFORM public.attendance_apply_laptop_rules();
  PERFORM public.attendance_apply_rule_5c();
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('laptop+android: phone signal stays in', v_open = 1, 'open='||v_open);

  -- Cleanup
  DELETE FROM public.attendance_events_log WHERE user_id IN (v_lap, v_both, v_admin);
  DELETE FROM public.attendance_visit_segments WHERE user_id IN (v_lap, v_both);
  DELETE FROM public.attendance_records WHERE user_id IN (v_lap, v_both);
  DELETE FROM public.attendance_devices WHERE company_id = v_company;
  DELETE FROM public.employee_work_sites WHERE user_id IN (v_lap, v_both);
  DELETE FROM public.employee_shift_assignments WHERE user_id IN (v_lap, v_both);
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE company_id = v_company;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_lap, v_both, v_admin);
  DELETE FROM auth.users WHERE id IN (v_lap, v_both, v_admin);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;

  SELECT count(*)::int AS records, (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_after FROM public.attendance_records;
  PERFORM pg_temp.tassert(
    'counts unchanged',
    v_counts_before.records = v_counts_after.records AND v_counts_before.visits = v_counts_after.visits,
    format('records %s->%s visits %s->%s', v_counts_before.records, v_counts_after.records, v_counts_before.visits, v_counts_after.visits)
  );
END;
$test$;

SELECT name, status, detail FROM lap_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
const list = Array.isArray(rows) ? rows : [];
let pass = 0;
let fail = 0;
for (const row of list) {
  console.log(`${row.status}\t${row.name} — ${row.detail || ''}`);
  if (row.status === 'PASS') pass++;
  else fail++;
}
console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} total`);
process.exit(fail ? 1 : 0);
