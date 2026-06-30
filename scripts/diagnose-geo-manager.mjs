/** Diagnose manager geo attendance */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef, loadLocalEnv } from './lib/require-pat.mjs';

loadLocalEnv();
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();
const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;

async function dbQuery(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 500));
  return body;
}

async function login(email, password) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.msg || JSON.stringify(body));
  return body.access_token;
}

async function rpc(token, fn, args) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

console.log('--- DB state ---');
const managers = await dbQuery(`
  SELECT u.id, u.email, u.full_name, u.role, u.is_demo,
         mws.id AS site_id, mws.name AS site_name, mws.is_demo AS site_is_demo, mws.tracking_enabled
  FROM public.users u
  LEFT JOIN public.manager_work_sites mws ON mws.manager_id = u.id
  WHERE u.role = 'manager'
  ORDER BY u.email;
`);
console.log(JSON.stringify(managers, null, 2));

const offices = await dbQuery(`SELECT id, name, is_demo, active, latitude, longitude FROM public.office_locations ORDER BY name;`);
console.log('Offices:', JSON.stringify(offices, null, 2));

console.log('\n--- Login manager@walfia.ai ---');
let token;
try {
  token = await login('manager@walfia.ai', 'manager123');
  console.log('Login OK');
} catch (e) {
  console.error('Login failed:', e.message);
  process.exit(1);
}

console.log('\n--- get_my_work_site ---');
console.log(await rpc(token, 'get_my_work_site', {}));

console.log('\n--- process_geo_attendance_ping (office coords) ---');
console.log(await rpc(token, 'process_geo_attendance_ping', {
  p_latitude: 25.0255035,
  p_longitude: 67.3043054,
  p_accuracy: 10,
}));

console.log('\n--- process_geo_attendance_ping (outside) ---');
console.log(await rpc(token, 'process_geo_attendance_ping', {
  p_latitude: 24.86,
  p_longitude: 67.00,
  p_accuracy: 10,
}));
