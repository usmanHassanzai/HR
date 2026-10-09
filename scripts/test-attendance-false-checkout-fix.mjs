#!/usr/bin/env node
/**
 * False-checkout fix tests (real RPC / cron entry points).
 * Cleans up after itself.
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

const sfx = 'fcf' + randomBytes(4).toString('hex');
const tokenLap = 'tok-lap-' + sfx;
const tokenPhone = 'tok-ph-' + sfx;
const tokenIos = 'tok-ios-' + sfx;
const tokenAnd = 'tok-and-' + sfx;
const hash = (t) => createHash('sha256').update(t).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE fcf_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO fcf_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_lap UUID := gen_random_uuid();
  v_phone UUID := gen_random_uuid();
  v_ios UUID := gen_random_uuid();
  v_and UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
  v_dev_lap UUID;
  v_dev_phone UUID;
  v_dev_ios UUID;
  v_dev_and UUID;
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE;
  v_rec UUID;
  v_visit UUID;
  v_n INTEGER;
  v_open INTEGER;
  v_total INTEGER;
  v_gaps INTEGER;
  v_audit INTEGER;
BEGIN
  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes, ios_office_signal_timeout
  ) VALUES (
    'FCF Co '||v_sfx, 'fcf-co-'||v_sfx, 'fcf_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3, 30
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('FCF Dept', 'fcf-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'FCF Office', 24.86, 67.00, 150, true)
  RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'FCF WiFi', ARRAY['203.0.113.10/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_fcf_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin FCF'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_lap, 'authenticated', 'authenticated',
    'lap_fcf_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Lap FCF'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_phone, 'authenticated', 'authenticated',
    'phone_fcf_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Phone FCF'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_ios, 'authenticated', 'authenticated',
    'ios_fcf_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','iOS FCF'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_and, 'authenticated', 'authenticated',
    'and_fcf_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','And FCF'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true
  WHERE id IN (v_lap, v_phone, v_ios, v_and);

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'FCF Shift',
    '00:00:00'::time,
    '23:59:59'::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES
    (v_lap, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin),
    (v_phone, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin),
    (v_ios, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin),
    (v_and, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_lap, v_company, 'lap-'||v_sfx, 'windows', '${hash(tokenLap)}', '1.3.17', 'present', v_now)
  RETURNING id INTO v_dev_lap;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_phone, v_company, 'ph-'||v_sfx, 'android', '${hash(tokenPhone)}', '1.3.17', 'left', v_now - INTERVAL '2 hours')
  RETURNING id INTO v_dev_phone;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_phone, v_company, 'lap2-'||v_sfx, 'windows', '${hash(tokenLap)}'||'a', '1.3.17', 'present', v_now);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_ios, v_company, 'ios-'||v_sfx, 'ios', '${hash(tokenIos)}', '1.3.17', 'present', v_now)
  RETURNING id INTO v_dev_ios;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES
    (v_and, v_company, 'and-'||v_sfx, 'android', '${hash(tokenAnd)}', '1.3.17', 'present', v_now)
  RETURNING id INTO v_dev_and;

  v_att_date := public.resolve_shift_attendance_date(v_lap, v_now);
  PERFORM set_config('attendance.write_context', 'admin_correction', true);
  PERFORM public.attendance_set_write_context('admin_correction');

  -- Helper: open visit + stamps
  -- ========== 1) Laptop heartbeats on office IP every 60s → never closed by 5b/5c ==========
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_lap, v_att_date, 'present', 'approved', v_now - INTERVAL '20 minutes', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    gen_random_uuid(), v_lap, v_rec, v_att_date, 1, v_now - INTERVAL '20 minutes', 'Visit 1 · Wi-Fi entry'
  );
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '45 seconds',
    last_any_signal_at = v_now - INTERVAL '45 seconds'
  WHERE id = v_lap;
  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, matched_method, occurred_at, payload, client_ip
  ) VALUES (
    v_company, v_lap, v_dev_lap, 'heartbeat', true, 'already_checked_in', 'laptop',
    v_now - INTERVAL '45 seconds', jsonb_build_object('wifi_ok', true, 'platform', 'windows'), '203.0.113.10'
  );
  v_n := public.attendance_apply_rule_5c();
  v_n := v_n + public.attendance_apply_rule_5b();
  SELECT COUNT(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_lap AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('laptop_office_heartbeat_stays_in', v_open = 1, 'open='||v_open);

  -- ========== 2) Phone silent, laptop sending on office IP → stays in ==========
  PERFORM public.attendance_set_write_context('admin_correction');
  v_att_date := public.resolve_shift_attendance_date(v_phone, v_now);
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_phone, v_att_date, 'present', 'approved', v_now - INTERVAL '25 minutes', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    gen_random_uuid(), v_phone, v_rec, v_att_date, 1, v_now - INTERVAL '25 minutes', 'Visit 1 · Wi-Fi entry'
  );
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '50 seconds',
    last_any_signal_at = v_now - INTERVAL '50 seconds'
  WHERE id = v_phone;
  v_n := public.attendance_apply_rule_5c();
  v_n := v_n + public.attendance_apply_rule_5b();
  SELECT COUNT(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_phone AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('phone_silent_laptop_office_stays_in', v_open = 1, 'open='||v_open);

  -- ========== 3) iOS-only silent 20 min inside office → stays in ==========
  PERFORM public.attendance_set_write_context('admin_correction');
  v_att_date := public.resolve_shift_attendance_date(v_ios, v_now);
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_ios, v_att_date, 'present', 'approved', v_now - INTERVAL '20 minutes', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    gen_random_uuid(), v_ios, v_rec, v_att_date, 1, v_now - INTERVAL '20 minutes', 'Visit 1 · Wi-Fi entry'
  );
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '20 minutes',
    last_any_signal_at = v_now - INTERVAL '20 minutes',
    last_inside_gps_at = v_now - INTERVAL '15 minutes'
  WHERE id = v_ios;
  v_n := public.attendance_apply_rule_5c();
  v_n := v_n + public.attendance_apply_rule_5b();
  SELECT COUNT(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_ios AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('ios_silent_20m_inside_stays_in', v_open = 1, 'open='||v_open);

  -- ========== 4) Closed by 5c, then office Wi-Fi event → new visit (simulate ensure) ==========
  -- Close android open visit via 5c with stale signals
  PERFORM public.attendance_set_write_context('admin_correction');
  v_att_date := public.resolve_shift_attendance_date(v_and, v_now);
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_and, v_att_date, 'present', 'approved', v_now - INTERVAL '10 minutes', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    id, user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (
    gen_random_uuid(), v_and, v_rec, v_att_date, 1, v_now - INTERVAL '10 minutes', 'Visit 1 · Wi-Fi entry'
  ) RETURNING id INTO v_visit;
  UPDATE public.users SET
    last_office_signal_at = v_now - INTERVAL '10 minutes',
    last_any_signal_at = v_now - INTERVAL '5 minutes',
    last_inside_gps_at = NULL
  WHERE id = v_and;
  -- Delete recent events so effective_* falls back to stamps
  DELETE FROM public.attendance_events_log WHERE user_id = v_and;
  v_n := public.attendance_apply_rule_5c();
  SELECT COUNT(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_and AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('android_4min_silence_closed_by_5c', v_open = 0 AND v_n >= 0,
    'open='||v_open||' closed_n='||v_n);

  -- Re-entry: office wifi present + left devices must not block new visit
  PERFORM public.attendance_touch_user_signals(v_and, v_now, true, false);
  UPDATE public.attendance_devices SET presence_state = 'left' WHERE user_id = v_and;
  UPDATE public.attendance_devices SET presence_state = 'present', last_presence_at = v_now
  WHERE user_id = v_and;
  PERFORM set_config('attendance.write_context', 'admin_correction', true);
  PERFORM public.attendance_set_write_context('admin_correction');
  UPDATE public.attendance_records SET
    clock_out_at = NULL,
    notes = COALESCE(notes,'') || ' | Wi-Fi re-entry'
  WHERE id = v_rec;
  PERFORM public.attendance_ensure_open_visit(
    v_and, v_rec, v_att_date, v_now, 'Auto entry wifi'
  );
  SELECT COUNT(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_and AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('reentry_after_5c_opens_new_visit', v_open = 1, 'open='||v_open);

  -- ========== 5) Usable outside GPS still checks out (Rule 5 path via close note style) ==========
  -- Keep as smoke: outside close note must NOT appear in gap list when outside GPS in gap
  -- (covered by gap filter test below)

  -- ========== 6) Shift with 3 visits → duration = sum ==========
  PERFORM public.attendance_set_write_context('admin_correction');
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_lap;
  DELETE FROM public.attendance_records WHERE user_id = v_lap;
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_lap, v_att_date, 'present', 'approved', v_now - INTERVAL '3 hours', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at, work_minutes, notes
  ) VALUES
    (v_lap, v_rec, v_att_date, 1, v_now - INTERVAL '3 hours', v_now - INTERVAL '2 hours 30 minutes', 30, 'V1'),
    (v_lap, v_rec, v_att_date, 2, v_now - INTERVAL '2 hours', v_now - INTERVAL '1 hour 40 minutes', 20, 'V2'),
    (v_lap, v_rec, v_att_date, 3, v_now - INTERVAL '1 hour', v_now - INTERVAL '50 minutes', 10, 'V3');
  v_total := public.attendance_shift_total_minutes(v_lap, v_att_date, v_now);
  PERFORM pg_temp.tassert('three_visits_sum_duration', v_total = 60, 'total='||v_total);

  -- ========== 7) Overnight visits same shift date ==========
  -- Use same attendance_date for 22:00 and 01:00 style visits
  PERFORM public.attendance_set_write_context('admin_correction');
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_phone;
  DELETE FROM public.attendance_records WHERE user_id = v_phone;
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, attendance_source
  ) VALUES (gen_random_uuid(), v_phone, v_att_date, 'present', 'approved', v_now - INTERVAL '5 hours', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at, work_minutes, notes
  ) VALUES
    (v_phone, v_rec, v_att_date, 1, v_now - INTERVAL '5 hours', v_now - INTERVAL '4 hours', 60, 'evening'),
    (v_phone, v_rec, v_att_date, 2, v_now - INTERVAL '2 hours', v_now - INTERVAL '1 hour', 60, 'after_midnight');
  v_total := public.attendance_shift_total_minutes(v_phone, v_att_date, v_now);
  PERFORM pg_temp.tassert('overnight_same_shift_sum', v_total = 120, 'total='||v_total);

  -- ========== 8) Open visit counted until now ==========
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, notes
  ) VALUES (v_phone, v_rec, v_att_date, 3, v_now - INTERVAL '30 minutes', 'open');
  v_total := public.attendance_shift_total_minutes(v_phone, v_att_date, v_now);
  PERFORM pg_temp.tassert('open_visit_counts_until_now', v_total >= 149 AND v_total <= 151, 'total='||v_total);

  -- ========== 9) Gap list excludes Rule 5 / manual / outside GPS ==========
  PERFORM public.attendance_set_write_context('admin_correction');
  DELETE FROM public.attendance_visit_segments WHERE user_id = v_ios;
  DELETE FROM public.attendance_records WHERE user_id = v_ios;
  INSERT INTO public.attendance_records (
    id, user_id, attendance_date, status, approval_status, clock_in_at, clock_out_at, attendance_source
  ) VALUES (gen_random_uuid(), v_ios, v_att_date, 'present', 'approved',
    v_now - INTERVAL '2 hours', v_now - INTERVAL '30 minutes', 'geo')
  RETURNING id INTO v_rec;
  INSERT INTO public.attendance_visit_segments (
    user_id, attendance_record_id, attendance_date, visit_number, clock_in_at, clock_out_at, work_minutes, notes
  ) VALUES
    (v_ios, v_rec, v_att_date, 1, v_now - INTERVAL '2 hours', v_now - INTERVAL '90 minutes', 30,
      'Visit 1 | Auto close: left the office radius'),
    (v_ios, v_rec, v_att_date, 2, v_now - INTERVAL '60 minutes', v_now - INTERVAL '30 minutes', 30, 'Visit 2');
  SELECT COUNT(*) INTO v_gaps
  FROM public.attendance_list_false_checkout_gaps(7) g
  WHERE g.gap_user_id = v_ios;
  PERFORM pg_temp.tassert('rule5_gap_not_listed', v_gaps = 0, 'gaps='||v_gaps);

  -- ========== 10) Audit table ready (repair not auto-run) ==========
  PERFORM pg_temp.tassert(
    'audit_table_ready',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='attendance_corrections_audit'
        AND column_name='corrected_by'
    ),
    'missing corrected_by'
  );

  -- Cleanup (ROLLBACK also undoes; explicit for clarity)
  DELETE FROM public.attendance_events_log WHERE user_id IN (v_lap, v_phone, v_ios, v_and, v_admin);
  DELETE FROM public.attendance_visit_segments WHERE user_id IN (v_lap, v_phone, v_ios, v_and);
  DELETE FROM public.attendance_records WHERE user_id IN (v_lap, v_phone, v_ios, v_and);
  DELETE FROM public.attendance_devices WHERE user_id IN (v_lap, v_phone, v_ios, v_and);
  DELETE FROM public.employee_shift_assignments WHERE user_id IN (v_lap, v_phone, v_ios, v_and);
  DELETE FROM public.work_shifts WHERE id = v_shift;
  DELETE FROM public.office_wifi_networks WHERE office_location_id = v_office;
  DELETE FROM public.office_locations WHERE id = v_office;
  DELETE FROM public.users WHERE id IN (v_lap, v_phone, v_ios, v_and, v_admin);
  DELETE FROM auth.users WHERE id IN (v_lap, v_phone, v_ios, v_and, v_admin);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;
END;
$test$;

SELECT * FROM fcf_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
console.log(JSON.stringify(rows, null, 2));
const fails = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.error('FAILED', fails);
  process.exit(1);
}
console.log('All false-checkout tests passed.');
