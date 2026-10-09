#!/usr/bin/env node
/**
 * iOS-only silence rules (5b/5c) + Rule 5 stale/imprecise guards.
 * Does not change Android / desktop / web expectations.
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

const sfx = 'ios' + randomBytes(4).toString('hex');
const tokenIos = 'tok-ios-' + sfx;
const tokenHashIos = createHash('sha256').update(tokenIos).digest('hex');
const tokenAnd = 'tok-and-' + sfx;
const tokenHashAnd = createHash('sha256').update(tokenAnd).digest('hex');
const tokenWin = 'tok-win-' + sfx;
const tokenHashWin = createHash('sha256').update(tokenWin).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE ios_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO ios_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_ios UUID := gen_random_uuid();
  v_and UUID := gen_random_uuid();
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
  v_col_ok boolean;
BEGIN
  SELECT count(*)::int AS records, (SELECT count(*)::int FROM public.attendance_visit_segments) AS visits
  INTO v_counts_before
  FROM public.attendance_records;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='companies' AND column_name='ios_office_signal_timeout'
  ) INTO v_col_ok;
  PERFORM pg_temp.tassert('schema: ios_office_signal_timeout', v_col_ok, '');

  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes, ios_office_signal_timeout
  ) VALUES (
    'IOS Co '||v_sfx, 'ios-co-'||v_sfx, 'ios_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3, 30
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('IOS Dept', 'ios-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'IOS Office', v_lat, v_lng, 150, true) RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'IOS WiFi', ARRAY['203.0.113.50/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_ios_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin IOS'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_ios, 'authenticated', 'authenticated',
    'ios_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','iPhone Only'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_and, 'authenticated', 'authenticated',
    'and_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Android Only'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_both, 'authenticated', 'authenticated',
    'both_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','iPhone+Windows'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true WHERE id IN (v_ios, v_and, v_both);

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'IOS Shift',
    ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time,
    ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_ios, v_shift, v_att_date - 1, v_admin),
         (v_and, v_shift, v_att_date - 1, v_admin),
         (v_both, v_shift, v_att_date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES
    (v_ios, v_office, 'IOS Office', v_lat, v_lng, 150, true),
    (v_and, v_office, 'IOS Office', v_lat, v_lng, 150, true),
    (v_both, v_office, 'IOS Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_ios, v_company, 'iphone-'||v_sfx, 'ios', '${tokenHashIos}', '1.3.14', 'present', v_now - INTERVAL '25 minutes'),
    (v_and, v_company, 'phone-'||v_sfx, 'android', '${tokenHashAnd}', '1.3.14', 'present', v_now - INTERVAL '15 minutes'),
    (v_both, v_company, 'iphone2-'||v_sfx, 'ios', encode(digest('ios2-'||v_sfx, 'sha256'), 'hex'), '1.3.14', 'present', v_now - INTERVAL '25 minutes'),
    (v_both, v_company, 'laptop-'||v_sfx, 'windows', '${tokenHashWin}', '1.3.14', 'present', v_now - INTERVAL '30 seconds');

  --------------------------------------------------------------------------
  -- Helper: open visit
  --------------------------------------------------------------------------
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
  ) VALUES (
    v_ios, v_att_date, 'present', 'approved', v_now - INTERVAL '40 minutes', 'Checked in', 'geo', v_shift
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_ios, v_rec, v_att_date, 1, v_now - INTERVAL '40 minutes', 'Checked in'
  ) RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);

  -- iOS-only silent 20 min inside office → stays in (5b is 30 for iOS)
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '20 minutes',
    last_any_signal_at = v_now - INTERVAL '20 minutes',
    last_inside_gps_at = v_now - INTERVAL '25 minutes'
  WHERE id = v_ios;
  PERFORM public.attendance_apply_rule_5c();
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('ios: silent 20m stays in', v_open = 1, 'open='||v_open);

  -- iOS-only silent 31 min, last GPS inside (uncontradicted) → stays in
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '31 minutes',
    last_any_signal_at = v_now - INTERVAL '31 minutes',
    last_inside_gps_at = v_now - INTERVAL '28 minutes'
  WHERE id = v_ios;
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('ios: silent 31m last GPS inside stays in', v_open = 1, 'open='||v_open);

  -- iOS-only silent 31 min, no inside GPS → 5b checkout
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '31 minutes',
    last_any_signal_at = v_now - INTERVAL '31 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_ios;
  v_n := public.attendance_apply_rule_5b();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'ios: silent 31m no inside GPS checks out 5b',
    v_n = 1 AND v_out IS NOT NULL AND v_notes ILIKE '%No office Wi-Fi for 30 minutes (iOS)%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );
  PERFORM pg_temp.tassert(
    'ios: 5b out = last office signal',
    abs(EXTRACT(EPOCH FROM (v_out - (v_now - INTERVAL '31 minutes')))) < 2,
    'out='||COALESCE(v_out::text,'null')
  );

  -- Re-open for 5c off test
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);

  -- iOS-only offline 5 min → NOT checked out (5c off)
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '5 minutes',
    last_any_signal_at = v_now - INTERVAL '5 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_ios;
  PERFORM public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('ios: offline 5m NOT checked out (5c off)', v_open = 1, 'open='||v_open);

  -- iPhone + Windows laptop on office IP recently → stays in (normal rules / laptop counts)
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

  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '30 seconds',
    last_any_signal_at = v_now - INTERVAL '30 seconds',
    last_inside_gps_at = NULL
  WHERE id = v_both;
  -- iPhone silent 25m but Windows fresh → not ios silence mode; 5b uses 10m and office signal fresh → stay
  PERFORM public.attendance_apply_rule_5c();
  PERFORM public.attendance_apply_rule_5b();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE id = v_visit AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('ios+windows: laptop signal stays in', v_open = 1, 'open='||v_open);
  PERFORM pg_temp.tassert(
    'ios+windows: not ios silence mode',
    public.attendance_user_uses_ios_silence_rules(v_both) = false,
    ''
  );
  PERFORM pg_temp.tassert(
    'ios-only: is ios silence mode',
    public.attendance_user_uses_ios_silence_rules(v_ios) = true,
    ''
  );

  -- Android: 5b at 10 min and 5c at 3 min still work
  PERFORM public.attendance_set_write_context('admin_correction');
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
  ) VALUES (
    v_and, v_att_date, 'present', 'approved', v_now - INTERVAL '40 minutes', 'Checked in', 'geo', v_shift
  ) RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    v_and, v_rec, v_att_date, 1, v_now - INTERVAL '40 minutes', 'Checked in'
  ) RETURNING id INTO v_visit;
  PERFORM public.attendance_set_write_context(NULL);

  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '11 minutes',
    last_any_signal_at = v_now - INTERVAL '30 seconds',
    last_inside_gps_at = NULL
  WHERE id = v_and;
  v_n := public.attendance_apply_rule_5b();
  SELECT clock_out_at, notes INTO v_out, v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'android: 5b at 10 min still works',
    v_n = 1 AND v_notes ILIKE '%No office Wi-Fi for 10 minutes%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );

  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_visit;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in' WHERE id = v_rec;
  PERFORM public.attendance_set_write_context(NULL);
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '20 minutes',
    last_any_signal_at = v_now - INTERVAL '4 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_and;
  v_n := public.attendance_apply_rule_5c();
  SELECT notes INTO v_notes FROM public.attendance_visit_segments WHERE id = v_visit;
  PERFORM pg_temp.tassert(
    'android: 5c at 3 min still works',
    v_n = 1 AND v_notes ILIKE '%Device offline%',
    'n='||v_n||' notes='||COALESCE(v_notes,'')
  );

  -- Rule 5 via process_auto: iOS reduced accuracy outside ignored (no coords effectively)
  -- Call process_auto with accuracy 80 → should not clock out
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in'
  WHERE user_id = v_ios AND clock_out_at IS NOT NULL;
  UPDATE public.attendance_records SET clock_out_at = NULL, work_minutes = NULL, notes = 'Checked in'
  WHERE user_id = v_ios AND clock_out_at IS NOT NULL;
  -- ensure open visit
  IF NOT EXISTS (SELECT 1 FROM public.attendance_visit_segments WHERE user_id = v_ios AND clock_out_at IS NULL) THEN
    INSERT INTO public.attendance_records (
      user_id, attendance_date, status, approval_status, clock_in_at, notes, attendance_source, shift_id
    ) VALUES (
      v_ios, v_att_date, 'present', 'approved', v_now - INTERVAL '10 minutes', 'Checked in', 'geo', v_shift
    ) RETURNING id INTO v_rec;
    INSERT INTO public.attendance_visit_segments (
      user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
    ) VALUES (
      v_ios, v_rec, v_att_date, 2, v_now - INTERVAL '10 minutes', 'Checked in'
    );
  END IF;
  PERFORM public.attendance_set_write_context(NULL);

  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '1 minute',
    last_any_signal_at = v_now - INTERVAL '1 minute'
  WHERE id = v_ios;

  v_res := public.process_auto_attendance_event(
    '${tokenHashIos}', 'ping', NULL,
    v_lat + 0.01, v_lng + 0.01, 80::double precision,
    NULL, NULL,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'iphone-'||v_sfx, 'ios', '1.3.14', '203.0.113.50'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE user_id = v_ios AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'ios: reduced accuracy outside ignored',
    v_open >= 1 AND COALESCE(v_res->>'action','') IS DISTINCT FROM 'clock_out',
    'open='||v_open||' action='||COALESCE(v_res->>'action','')
  );

  -- Fresh precise outside (<=50) → checked out
  v_res := public.process_auto_attendance_event(
    '${tokenHashIos}', 'ping', NULL,
    v_lat + 0.02, v_lng + 0.02, 25::double precision,
    NULL, NULL,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    'UTC', false, 'iphone-'||v_sfx, 'ios', '1.3.14', '198.51.100.1'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments WHERE user_id = v_ios AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'ios: fresh precise outside checks out',
    COALESCE(v_res->>'action','') = 'clock_out' OR v_open = 0,
    'open='||v_open||' action='||COALESCE(v_res->>'action','')||' res='||COALESCE(v_res::text,'')
  );

  -- Cleanup
  DELETE FROM public.attendance_events_log WHERE user_id IN (v_ios, v_and, v_both, v_admin);
  DELETE FROM public.attendance_visit_segments WHERE user_id IN (v_ios, v_and, v_both);
  DELETE FROM public.attendance_records WHERE user_id IN (v_ios, v_and, v_both);
  DELETE FROM public.attendance_devices WHERE company_id = v_company;
  DELETE FROM public.employee_work_sites WHERE user_id IN (v_ios, v_and, v_both);
  DELETE FROM public.employee_shift_assignments WHERE user_id IN (v_ios, v_and, v_both);
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE company_id = v_company;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_ios, v_and, v_both, v_admin);
  DELETE FROM auth.users WHERE id IN (v_ios, v_and, v_both, v_admin);
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

SELECT name, status, detail FROM ios_results ORDER BY name;
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
