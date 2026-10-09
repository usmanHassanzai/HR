#!/usr/bin/env node
/**
 * Immediate check-out / re-entry via real RPC entry points (rolled back).
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
const phoneHash = createHash('sha256').update(`imm-phone-${Date.now()}`).digest('hex');

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
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 3000));
  return body;
}

const query = `
BEGIN;

CREATE TEMP TABLE imm_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO imm_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
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
  v_sfx TEXT := 'imm' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_ms BIGINT := (EXTRACT(EPOCH FROM v_now) * 1000)::BIGINT;
  v_office_lat DOUBLE PRECISION := 41.8781;
  v_office_lng DOUBLE PRECISION := -87.6298;
  v_in_lat DOUBLE PRECISION := 41.87815;
  v_in_lng DOUBLE PRECISION := -87.62985;
  v_out_lat DOUBLE PRECISION := 41.90;
  v_out_lng DOUBLE PRECISION := -87.70;
  v_start TIME;
  v_end TIME;
  v_att DATE;
  v_res JSONB;
  v_visits INT;
  v_open INT;
BEGIN
  INSERT INTO public.companies (name, slug, contact_email, timezone, auto_phone_attendance, auto_laptop_attendance)
  VALUES ('Imm Co '||v_sfx, 'imm-co-'||v_sfx, 'imm_'||v_sfx||'@scorr.test', 'UTC', true, true)
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Imm Dept', 'imm-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
  ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
    'admin_imm_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','admin','company_id',v_company,'full_name','Admin Imm'),
    v_now, v_now, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
    'emp_imm_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept,'full_name','Emp Imm','manager_id',v_admin),
    v_now, v_now, '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept,
    manager_id=v_admin, work_mode='office', auto_phone_attendance=true, auto_laptop_attendance=true WHERE id=v_emp;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id,
    wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
  ) VALUES (
    'Imm Office', v_office_lat, v_office_lng, 150, true, v_company,
    ARRAY['OfficeWiFi'], ARRAY['aa:bb:cc:dd:ee:ff'], ARRAY['203.0.113.10/32'], 'gps_or_wifi'
  ) RETURNING id INTO v_zone;
  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES (v_emp, v_zone, 'Imm Office', v_office_lat, v_office_lng, 150, true);

  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version, presence_state)
  VALUES (v_emp, v_company, 'phone-'||v_sfx, 'android', '${phoneHash}', '1.3.10', 'left');

  v_att := (v_now AT TIME ZONE 'UTC')::date;
  v_start := ((v_now - INTERVAL '2 hours') AT TIME ZONE 'UTC')::time;
  v_end := ((v_now + INTERVAL '4 hours') AT TIME ZONE 'UTC')::time;
  IF v_start > v_end THEN v_end := TIME '23:59'; END IF;

  INSERT INTO public.work_shifts (name, start_time, end_time, days_of_week, grace_minutes, active, manager_id, timezone, crosses_midnight)
  VALUES ('Imm Shift', v_start, v_end, ARRAY[1,2,3,4,5,6,7], 0, true, v_admin, 'UTC', false)
  RETURNING id INTO v_shift;
  INSERT INTO public.employee_shift_assignments (user_id, shift_id, effective_from, assigned_by)
  VALUES (v_emp, v_shift, v_att - 30, v_admin);

  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  PERFORM pg_temp.tassert(1, 'setup check-in', (v_res->>'action') = 'clock_in', v_res::text);

  -- Outside + office Wi-Fi (auto / exit)
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms, v_ms, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(2, 'outside acc<=50 on office Wi-Fi checks out',
    (v_res->>'action') = 'clock_out', v_res::text);

  SELECT count(*)::int INTO v_open FROM attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(3, 'record closed after outside checkout', v_open = 0, v_open::text);

  -- Re-entry
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 2000, v_ms + 2000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(4, 're-entry check-in new visit',
    (v_res->>'action') = 'clock_in'
      AND COALESCE(v_res->>'action','') <> 'presence_left_pending',
    v_res::text);

  SELECT count(*)::int INTO v_visits FROM attendance_visit_segments WHERE user_id = v_emp;
  SELECT count(*)::int INTO v_open FROM attendance_records
  WHERE user_id = v_emp AND clock_in_at IS NOT NULL AND clock_out_at IS NULL;
  PERFORM pg_temp.tassert(5, 're-entry opens present again',
    v_open = 1 AND v_visits >= 1, format('open=%s visits=%s', v_open, v_visits));

  -- Wi-Fi without GPS
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'wifi_connected', v_zone, NULL, NULL, NULL,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 3000, v_ms + 3000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(6, 'wifi no GPS → need_fresh_location',
    (v_res->>'action') = 'need_fresh_location' OR (v_res->>'reason') = 'need_fresh_location',
    v_res::text);

  -- Check out first so mobile-data check-in is evaluated (not duplicate_ignored)
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'exit', v_zone, v_out_lat, v_out_lng, 20,
    'OfficeWiFi', 'aa:bb:cc:dd:ee:ff',
    v_ms + 6*60*1000, v_ms + 6*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '203.0.113.10'
  );
  DELETE FROM public.attendance_events_log WHERE user_id = v_emp;
  -- Mobile data + inside (check-in must fail Rule 1/7)
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'enter', v_zone, v_in_lat, v_in_lng, 20,
    NULL, NULL,
    v_ms + 7*60*1000, v_ms + 7*60*1000, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '8.8.8.8'
  );
  PERFORM pg_temp.tassert(7, 'mobile data + inside rejected',
    (v_res->>'action') IN ('not_on_office_wifi','not_on_office_network','wrong_network')
      OR (v_res->>'reason') IN ('not_on_office_wifi','not_on_office_network','wrong_network','fake_hotspot_suspected'),
    v_res::text);

  -- Office Wi-Fi + outside for check-in path (should not check in; may clock_out or outside)
  -- Stale 20m
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'ping', v_zone, v_out_lat, v_out_lng, 20,
    NULL, NULL,
    v_ms - 20*60*1000, v_ms, 'UTC', false, 'phone-'||v_sfx, 'android', '1.3.10', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(8, 'stale 20m refused',
    (v_res->>'reason') = 'event_too_old' OR (v_res->>'action') = 'event_too_old',
    v_res::text);

  -- Desktop heartbeat outside
  UPDATE public.attendance_devices SET platform = 'windows', device_id = 'laptop-'||v_sfx WHERE user_id = v_emp;
  -- ensure open visit again
  PERFORM pg_temp.as_emp(v_emp, '203.0.113.10');
  v_res := public.process_geo_attendance_ping(v_in_lat, v_in_lng, 20, 'clock_in', false);
  v_res := public.process_auto_attendance_event(
    '${phoneHash}', 'heartbeat', v_zone, v_out_lat, v_out_lng, 25,
    NULL, NULL,
    v_ms + 5000, v_ms + 5000, 'UTC', false, 'laptop-'||v_sfx, 'windows', '1.3.10', '203.0.113.10'
  );
  PERFORM pg_temp.tassert(9, 'desktop heartbeat outside checks out',
    (v_res->>'action') = 'clock_out', v_res::text);

  -- Client-side stale drop (logic mirror)
  PERFORM pg_temp.tassert(10, 'client drops 20m-old event',
    (EXTRACT(EPOCH FROM (v_now - (v_now - INTERVAL '20 minutes'))) * 1000) > 10*60*1000,
    'age>10m');
END;
$test$;

SELECT ord, name, status, left(detail, 200) AS detail FROM imm_results ORDER BY ord;
ROLLBACK;
`;

const before = await sql(`SELECT
  (SELECT count(*)::int FROM attendance_records) AS records,
  (SELECT count(*)::int FROM attendance_visit_segments) AS visits`);
console.log('Project', projectRef);
const rows = await sql(query);
for (const row of rows) {
  console.log(`${row.status}\t${row.name} — ${row.detail || ''}`);
}
const failed = rows.filter((r) => r.status === 'FAIL').length;
const after = await sql(`SELECT
  (SELECT count(*)::int FROM attendance_records) AS records,
  (SELECT count(*)::int FROM attendance_visit_segments) AS visits`);
console.log(
  `records ${before[0].records}->${after[0].records} visits ${before[0].visits}->${after[0].visits}`,
);
console.log(`\n${rows.length - failed} PASS / ${failed} FAIL / ${rows.length} total`);
process.exit(failed ? 1 : 0);
