#!/usr/bin/env node
/**
 * Item 1: office radius/pin is single source of truth for assignments + GPS checks.
 * Rolled back afterwards. Does not delete production attendance rows.
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

const sfx = 'ors' + randomBytes(4).toString('hex');

const query = `
BEGIN;
CREATE TEMP TABLE ors_results (ord int, name text, status text, detail text);
CREATE OR REPLACE FUNCTION pg_temp.tassert(p_ord int, p_name text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $a$
BEGIN
  INSERT INTO ors_results VALUES (p_ord, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, COALESCE(p_detail,''));
END;
$a$;

DO $test$
DECLARE
  v_company UUID; v_dept UUID;
  v_admin UUID := gen_random_uuid();
  v_emp UUID := gen_random_uuid();
  v_other UUID := gen_random_uuid();
  v_sfx TEXT := '${sfx}';
  v_office UUID; v_other_office UUID;
  v_lat DOUBLE PRECISION := 41.8781;
  v_lng DOUBLE PRECISION := -87.6298;
  v_r150 INT; v_r300 INT; v_r150b INT;
  v_inside200 BOOLEAN; v_inside200_after BOOLEAN; v_inside200_back BOOLEAN;
  v_pin_lat DOUBLE PRECISION; v_list_r INT; v_win_r INT; v_ver1 BIGINT; v_ver2 BIGINT;
  v_other_r INT;
  v_rec_before BIGINT; v_vis_before BIGINT; v_rec_after BIGINT; v_vis_after BIGINT;
BEGIN
  SELECT count(*) INTO v_rec_before FROM public.attendance_records;
  SELECT count(*) INTO v_vis_before FROM public.attendance_visit_segments;

  INSERT INTO public.companies (name, slug, contact_email, timezone)
  VALUES ('Ors Co '||v_sfx, 'ors-co-'||v_sfx, 'ors_'||v_sfx||'@scorr.test', 'UTC')
  RETURNING id INTO v_company;
  INSERT INTO public.departments (name, slug, company_id, active)
  VALUES ('Ors Dept', 'ors-dept-'||v_sfx, v_company, true) RETURNING id INTO v_dept;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
     'admin_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('role','admin','company_id',v_company),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_emp, 'authenticated', 'authenticated',
     'emp_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept),
     now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_other, 'authenticated', 'authenticated',
     'other_'||v_sfx||'@scorr.test', crypt('x', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('role','employee','company_id',v_company,'department_id',v_dept),
     now(), now(), '', '', '', '');

  UPDATE public.users SET role='admin'::public.user_role, company_id=v_company, department_id=v_dept, work_mode='office' WHERE id=v_admin;
  UPDATE public.users SET role='employee'::public.user_role, company_id=v_company, department_id=v_dept, work_mode='office' WHERE id IN (v_emp, v_other);

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, detection_mode
  ) VALUES (
    'Ors Office '||v_sfx, v_lat, v_lng, 150, true, v_company, 'gps_or_wifi'
  ) RETURNING id INTO v_office;

  INSERT INTO public.office_locations (
    name, latitude, longitude, radius_meters, active, company_id, detection_mode
  ) VALUES (
    'Ors Other '||v_sfx, v_lat + 0.05, v_lng + 0.05, 150, true, v_company, 'gps_or_wifi'
  ) RETURNING id INTO v_other_office;

  INSERT INTO public.employee_work_sites (
    user_id, office_location_id, name, latitude, longitude, radius_meters, tracking_enabled
  ) VALUES
    (v_emp, v_office, 'Ors Office', v_lat, v_lng, 150, true),
    (v_other, v_other_office, 'Ors Other', v_lat + 0.05, v_lng + 0.05, 150, true);

  -- 200 m north ≈ 0.0018 deg — outside at 150
  v_inside200 := public.attendance_gps_inside_assigned_office(
    v_emp, v_lat + 0.0018, v_lng, 20
  );
  PERFORM pg_temp.tassert(1, '200m reading outside at radius 150', v_inside200 = false, 'inside='||v_inside200);

  -- Force stale copy on purpose (simulates old bug), then bump office → trigger syncs.
  UPDATE public.employee_work_sites SET radius_meters = 99 WHERE user_id = v_emp;
  SELECT office_version INTO v_ver1 FROM public.office_locations WHERE id = v_office;

  UPDATE public.office_locations SET radius_meters = 300 WHERE id = v_office;
  SELECT office_version, radius_meters INTO v_ver2, v_r300
  FROM public.office_locations WHERE id = v_office;
  PERFORM pg_temp.tassert(2, 'office radius saved 300', v_r300 = 300, 'r='||v_r300);
  PERFORM pg_temp.tassert(3, 'office_version bumped', v_ver2 > v_ver1, format('%s->%s', v_ver1, v_ver2));

  SELECT radius_meters INTO v_list_r FROM public.employee_work_sites WHERE user_id = v_emp;
  PERFORM pg_temp.tassert(4, 'assignment copy synced to 300', v_list_r = 300, 'ews_r='||v_list_r);

  -- List RPC as admin (live COALESCE)
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SELECT radius_meters INTO v_list_r
  FROM public.get_employee_work_sites() WHERE user_id = v_emp LIMIT 1;
  PERFORM pg_temp.tassert(5, 'get_employee_work_sites shows 300', v_list_r = 300, 'list_r='||v_list_r);

  PERFORM set_config('request.jwt.claim.sub', v_emp::text, true);
  SELECT radius_meters INTO v_win_r FROM public.get_my_location_window() LIMIT 1;
  PERFORM pg_temp.tassert(6, 'get_my_location_window shows 300', v_win_r = 300, 'win_r='||COALESCE(v_win_r::text,'null'));

  SELECT radius_meters INTO v_win_r FROM public.get_my_work_site() LIMIT 1;
  PERFORM pg_temp.tassert(7, 'get_my_work_site / profile shows 300', v_win_r = 300, 'site_r='||v_win_r);

  v_inside200_after := public.attendance_gps_inside_assigned_office(
    v_emp, v_lat + 0.0018, v_lng, 20
  );
  PERFORM pg_temp.tassert(8, '200m reading inside after 300', v_inside200_after = true, 'inside='||v_inside200_after);

  UPDATE public.office_locations SET radius_meters = 150 WHERE id = v_office;
  v_inside200_back := public.attendance_gps_inside_assigned_office(
    v_emp, v_lat + 0.0018, v_lng, 20
  );
  PERFORM pg_temp.tassert(9, '200m reading outside after back to 150', v_inside200_back = false, 'inside='||v_inside200_back);

  -- Pin change picked up
  UPDATE public.office_locations SET latitude = v_lat + 0.01, longitude = v_lng + 0.01 WHERE id = v_office;
  SELECT latitude INTO v_pin_lat FROM public.get_work_site_for_user(v_emp) LIMIT 1;
  PERFORM pg_temp.tassert(10, 'pin change reaches get_work_site_for_user',
    abs(v_pin_lat - (v_lat + 0.01)) < 0.00001, 'lat='||v_pin_lat);

  SELECT radius_meters INTO v_other_r FROM public.employee_work_sites WHERE user_id = v_other;
  PERFORM pg_temp.tassert(11, 'other office assignment unaffected', v_other_r = 150, 'other_r='||v_other_r);

  SELECT (attendance_schedule_for_user(v_emp)->'zones'->0->>'radius_meters')::int,
         (attendance_schedule_for_user(v_emp)->>'office_version')::bigint
  INTO v_list_r, v_ver2;
  PERFORM pg_temp.tassert(12, 'schedule zones use office radius', v_list_r = 150, 'sched_r='||v_list_r);
  PERFORM pg_temp.tassert(13, 'schedule includes office_version', v_ver2 IS NOT NULL AND v_ver2 > 0, 'ver='||v_ver2);

  SELECT count(*) INTO v_rec_after FROM public.attendance_records;
  SELECT count(*) INTO v_vis_after FROM public.attendance_visit_segments;
  PERFORM pg_temp.tassert(14, 'attendance counts unchanged',
    v_rec_after = v_rec_before AND v_vis_after = v_vis_before,
    format('records %s->%s visits %s->%s', v_rec_before, v_rec_after, v_vis_before, v_vis_after));

  -- cleanup test tenants only
  DELETE FROM public.employee_work_sites WHERE user_id IN (v_emp, v_other);
  DELETE FROM public.office_locations WHERE id IN (v_office, v_other_office);
  DELETE FROM public.users WHERE id IN (v_admin, v_emp, v_other);
  DELETE FROM auth.users WHERE id IN (v_admin, v_emp, v_other);
  DELETE FROM public.departments WHERE id = v_dept;
  DELETE FROM public.companies WHERE id = v_company;
END;
$test$;

SELECT ord, name, status, detail FROM ors_results ORDER BY ord;
ROLLBACK;
`;

console.log('Project', projectRef);
const rows = await sql(query);
const list = Array.isArray(rows) ? rows : [];
let fail = 0;
for (const r of list) {
  if (r.status === 'FAIL') fail++;
  console.log(`${r.status}\t${r.name} — ${r.detail || ''}`.trim());
}
console.log(`\n${list.length - fail} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
