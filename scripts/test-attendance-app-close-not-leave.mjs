#!/usr/bin/env node
/**
 * App-close must not count as leaving (local-only via BEGIN…ROLLBACK).
 * Leaves 0 test rows (transaction rolled back).
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

const sfx = 'acl' + randomBytes(4).toString('hex');
const tokenWeb = 'tok-web-' + sfx;
const tokenAnd = 'tok-and-' + sfx;
const hash = (t) => createHash('sha256').update(t).digest('hex');

const query = `
BEGIN;

CREATE TEMP TABLE acl_results (name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO acl_results VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID;
  v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_web UUID := gen_random_uuid();
  v_and UUID := gen_random_uuid();
  v_shift UUID;
  v_office UUID;
  v_dev_web UUID;
  v_dev_and UUID;
  v_sfx TEXT := '${sfx}';
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_att_date DATE;
  v_res JSONB;
  v_open INTEGER;
  v_n INTEGER;
  v_note TEXT;
  v_out TIMESTAMPTZ;
  v_bg TIMESTAMPTZ;
  v_lat DOUBLE PRECISION := 24.8607;
  v_lng DOUBLE PRECISION := 67.0011;
  v_out_lat DOUBLE PRECISION := 24.8707;
  v_out_lng DOUBLE PRECISION := 67.0111;
  v_left INTEGER := 0;
BEGIN
  INSERT INTO public.companies (
    name, slug, contact_email, timezone,
    auto_phone_attendance, auto_laptop_attendance,
    attendance_no_office_wifi_minutes, attendance_offline_minutes,
    attendance_backgrounded_minutes
  ) VALUES (
    'ACL Co '||v_sfx, 'acl-co-'||v_sfx, 'acl_'||v_sfx||'@scorr.test', 'UTC',
    true, true, 10, 3, 60
  ) RETURNING id INTO v_company;

  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('ACL Dept', 'acl-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO public.office_locations (
    company_id, name, latitude, longitude, radius_meters, active
  ) VALUES (v_company, 'ACL Office', v_lat, v_lng, 150, true)
  RETURNING id INTO v_office;

  INSERT INTO public.office_wifi_networks (
    office_location_id, company_id, label, public_ip_cidrs, active
  ) VALUES (v_office, v_company, 'ACL WiFi', ARRAY['203.0.113.77/32'], true);

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_acl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin ACL'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_web, 'authenticated', 'authenticated',
    'web_acl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Web ACL'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_and, 'authenticated', 'authenticated',
    'and_acl_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','And ACL'),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true
  WHERE id IN (v_web, v_and);

  INSERT INTO public.work_shifts (
    name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight
  ) VALUES (
    'ACL Shift', '00:00:00'::time, '23:59:59'::time,
    ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false
  ) RETURNING id INTO v_shift;

  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES
    (v_web, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin),
    (v_and, v_shift, (v_now AT TIME ZONE 'UTC')::date - 1, v_admin);

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES
    (v_web, v_office, 'ACL Office', v_lat, v_lng, 150, true),
    (v_and, v_office, 'ACL Office', v_lat, v_lng, 150, true);

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES (
    v_web, v_company, 'web-'||v_sfx, 'web', '${hash(tokenWeb)}', '1.3.19', 'left', v_now
  ) RETURNING id INTO v_dev_web;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, token_hash, app_version, presence_state, last_seen_at
  ) VALUES (
    v_and, v_company, 'and-'||v_sfx, 'android', '${hash(tokenAnd)}', '1.3.19', 'left', v_now
  ) RETURNING id INTO v_dev_and;

  -- Open visit for web user (aged 10 min so silence rules can consider it)
  v_att_date := public.resolve_shift_attendance_date(v_web, v_now);
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, attendance_source, shift_id, notes, presence_method
  ) VALUES (
    v_web, v_att_date, 'present', 'approved', v_web,
    v_now - INTERVAL '10 minutes', 'auto_wifi', v_shift, 'ACL seed web', 'wifi'
  );
  PERFORM public.attendance_ensure_open_visit(
    v_web,
    (SELECT id FROM public.attendance_records WHERE user_id=v_web AND attendance_date=v_att_date),
    v_att_date, v_now - INTERVAL '10 minutes', 'ACL seed web'
  );
  UPDATE public.users SET
    last_any_signal_at = v_now - INTERVAL '10 minutes',
    last_office_signal_at = v_now - INTERVAL '10 minutes'
  WHERE id = v_web;

  -- app_backgrounded
  v_res := public.process_auto_attendance_event(
    '${hash(tokenWeb)}', 'app_backgrounded', NULL,
    NULL, NULL, NULL, NULL, NULL,
    (extract(epoch from (v_now - INTERVAL '9 minutes')) * 1000)::bigint,
    (extract(epoch from v_now) * 1000)::bigint,
    'UTC', false, 'web-'||v_sfx, 'web', '1.3.19', '203.0.113.77'
  );
  PERFORM pg_temp.tassert('app_backgrounded_ok', COALESCE((v_res->>'ok')::boolean, false), v_res::text);
  SELECT last_app_backgrounded_at INTO v_bg FROM public.users WHERE id = v_web;
  PERFORM pg_temp.tassert('bg_stamp_set', v_bg IS NOT NULL, coalesce(v_bg::text,'null'));

  -- Silent 30 min after background → still checked in (grace 60)
  UPDATE public.users SET last_app_backgrounded_at = v_now - INTERVAL '30 minutes' WHERE id = v_web;
  v_n := public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_web AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert('bg_30min_stays_in', v_open = 1, format('open=%s 5c=%s', v_open, v_n));

  -- Silent 61 min after background, no other device → checked out at last signal
  UPDATE public.users SET last_app_backgrounded_at = v_now - INTERVAL '61 minutes' WHERE id = v_web;
  v_n := public.attendance_apply_rule_5c();
  SELECT clock_out_at, notes INTO v_out, v_note
  FROM public.attendance_visit_segments
  WHERE user_id = v_web ORDER BY clock_in_at DESC LIMIT 1;
  PERFORM pg_temp.tassert(
    'bg_61min_checks_out',
    v_out IS NOT NULL AND v_note ILIKE '%No signal after app was closed%',
    format('out=%s note=%s 5c=%s', v_out, left(coalesce(v_note,''),80), v_n)
  );

  -- Reopen on office Wi-Fi with open visit → continue (already_checked_in)
  -- Seed a fresh open visit
  UPDATE public.attendance_visit_segments SET clock_out_at = NULL, notes = 'ACL reopen seed'
  WHERE user_id = v_web AND clock_out_at IS NOT NULL;
  -- If none open, create one
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_web AND clock_out_at IS NULL;
  IF v_open = 0 THEN
    PERFORM public.attendance_ensure_open_visit(
      v_web,
      (SELECT id FROM public.attendance_records WHERE user_id=v_web AND attendance_date=v_att_date),
      v_att_date, v_now - INTERVAL '5 minutes', 'ACL reopen seed'
    );
  END IF;
  UPDATE public.users SET last_app_backgrounded_at = NULL WHERE id = v_web;
  v_res := public.attendance_try_auto_checkin(
    v_web, v_now, v_lat, v_lng, 20, false, '203.0.113.77', 'web', 'ACL Office', NULL, 'ACL WiFi', 10
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_web AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'reopen_continues_visit',
    (v_res->>'action') = 'already_checked_in' AND v_open = 1,
    format('action=%s open=%s', v_res->>'action', v_open)
  );

  -- Fresh outside GPS still checks out immediately (Rule 5)
  UPDATE public.users SET last_app_backgrounded_at = NULL WHERE id = v_web;
  UPDATE public.attendance_visit_segments SET clock_out_at = v_now - INTERVAL '1 minute'
  WHERE user_id = v_web AND clock_out_at IS NULL;
  UPDATE public.attendance_records SET
    clock_out_at = NULL, clock_out_lat = NULL, clock_out_lng = NULL,
    clock_in_at = v_now - INTERVAL '3 minutes', status = 'present'
  WHERE user_id = v_web AND attendance_date = v_att_date;
  PERFORM public.attendance_ensure_open_visit(
    v_web,
    (SELECT id FROM public.attendance_records WHERE user_id=v_web AND attendance_date=v_att_date),
    v_att_date, v_now - INTERVAL '3 minutes', 'ACL outside seed'
  );
  v_res := public.process_auto_attendance_event(
    '${hash(tokenWeb)}', 'exit', NULL,
    v_out_lat, v_out_lng, 15, NULL, NULL,
    (extract(epoch from v_now) * 1000)::bigint,
    (extract(epoch from v_now) * 1000)::bigint,
    'UTC', false, 'web-'||v_sfx, 'web', '1.3.19', '198.51.100.1'
  );
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_web AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(
    'outside_gps_still_outs',
    v_open = 0 AND (v_res->>'action') IN ('clock_out', 'checked_out'),
    format('action=%s open=%s res=%s', v_res->>'action', v_open, left(v_res::text,160))
  );

  -- Android: no app_backgrounded, silent 4 min → 5c still applies
  v_att_date := public.resolve_shift_attendance_date(v_and, v_now);
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, attendance_source, shift_id, notes, presence_method
  ) VALUES (
    v_and, v_att_date, 'present', 'approved', v_and,
    v_now - INTERVAL '10 minutes', 'auto_wifi', v_shift, 'ACL seed and', 'wifi'
  );
  PERFORM public.attendance_ensure_open_visit(
    v_and,
    (SELECT id FROM public.attendance_records WHERE user_id=v_and AND attendance_date=v_att_date),
    v_att_date, v_now - INTERVAL '10 minutes', 'ACL seed and'
  );
  UPDATE public.users SET
    last_any_signal_at = v_now - INTERVAL '4 minutes',
    last_office_signal_at = v_now - INTERVAL '4 minutes',
    last_app_backgrounded_at = NULL,
    last_inside_gps_at = NULL
  WHERE id = v_and;
  v_n := public.attendance_apply_rule_5c();
  SELECT count(*) INTO v_open FROM public.attendance_visit_segments
  WHERE user_id = v_and AND clock_out_at IS NULL;
  SELECT notes INTO v_note FROM public.attendance_visit_segments
  WHERE user_id = v_and ORDER BY clock_in_at DESC LIMIT 1;
  PERFORM pg_temp.tassert(
    'android_4min_no_bg_5c',
    v_open = 0 AND coalesce(v_note,'') ILIKE '%Device offline%',
    format('open=%s note=%s 5c=%s', v_open, left(coalesce(v_note,''),80), v_n)
  );

  -- app_quit logged
  v_res := public.process_auto_attendance_event(
    '${hash(tokenAnd)}', 'app_quit', NULL,
    NULL, NULL, NULL, NULL, NULL,
    (extract(epoch from v_now) * 1000)::bigint,
    (extract(epoch from v_now) * 1000)::bigint,
    'UTC', false, 'and-'||v_sfx, 'android', '1.3.19', '203.0.113.77'
  );
  PERFORM pg_temp.tassert(
    'app_quit_ok',
    (v_res->>'action') = 'app_quit' OR (v_res->>'reason') = 'app_quit',
    v_res::text
  );

  -- Count leftover test rows by sfx (should be cleaned by ROLLBACK; assert zero after rollback outside)
  SELECT count(*)::int INTO v_left FROM public.companies WHERE slug = 'acl-co-'||v_sfx;
  PERFORM pg_temp.tassert('seed_company_present_in_txn', v_left = 1, v_left::text);
END;
$test$;

SELECT * FROM acl_results ORDER BY name;
ROLLBACK;
`;

const rows = await sql(query);
console.log(JSON.stringify(rows, null, 2));
const fails = (Array.isArray(rows) ? rows : []).filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.error('FAILED', fails);
  process.exit(1);
}

// Confirm 0 leftover companies from this sfx
const left = await sql(`SELECT count(*)::int AS n FROM public.companies WHERE slug = 'acl-co-${sfx}'`);
const n = Array.isArray(left) ? left[0]?.n : left?.n;
console.log('leftover companies after ROLLBACK:', n);
if (Number(n) !== 0) {
  console.error('TEST DATA LEFT');
  process.exit(1);
}
console.log('0 test rows left');
console.log('All app-close-not-leave tests passed.');
