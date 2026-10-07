#!/usr/bin/env node
/**
 * Regression: register_attendance_device must resolve pgcrypto (extensions schema).
 * Mirrors app RPC args from src/utils/autoAttendanceSetup.ts (registerDeviceViaRpc).
 *
 * Usage:
 *   ENV_FILE=.env.staging SUPABASE_PROJECT_REF=utxylrrrzsjetncrajxj node scripts/test-register-attendance-device.mjs
 *   ENV_FILE=.env SUPABASE_PROJECT_REF=yvnbxweitelowucdhwpg node scripts/test-register-attendance-device.mjs
 *
 * Optional: QA_EMAIL=... to verify as that user (otherwise creates a temp user, rolls back).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.ENV_FILE || '.env';
const env = Object.fromEntries(
  readFileSync(resolve(root, envFile), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const pat = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
const projectRef =
  process.env.SUPABASE_PROJECT_REF ||
  env.SUPABASE_PROJECT_REF ||
  new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const supabaseUrl = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!pat) {
  console.error('SUPABASE_PAT required');
  process.exit(1);
}

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
  if (!r.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
  return body;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function checkPgcrypto() {
  const rows = await sql(`
    SELECT e.extname, n.nspname AS schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto'
  `);
  assert(Array.isArray(rows) && rows.length > 0, 'pgcrypto extension missing');
  console.log(`✅ pgcrypto in schema: ${rows[0].schema}`);

  const defs = await sql(`
    SELECT p.proname,
      coalesce((SELECT string_agg(c, ', ') FROM unnest(p.proconfig) c), '') AS config,
      pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('register_attendance_device', 'attendance_hash_device_token')
  `);
  for (const row of defs) {
    const hasExt =
      (row.config || '').includes('extensions') ||
      (row.def || '').includes('extensions.gen_random_bytes') ||
      (row.def || '').includes('extensions.digest');
    assert(hasExt, `${row.proname} missing extensions schema qualification/search_path`);
    console.log(`✅ ${row.proname} uses extensions (config=${row.config || '(none)'})`);
  }
}

/** SQL-level call as authenticated user — same args pattern as the app RPC. */
async function testRegisterAsUser(userId) {
  const deviceId = `qa-regtest-${Date.now()}`;
  // Single statement so set_config persists for register + revoke (same as run-attendance-auto-tests.mjs)
  const rows = await sql(`
    DO $body$
    DECLARE
      v_res JSONB;
      v_row_id UUID;
      v_active BOOLEAN;
      v_revoked BOOLEAN;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', '${userId}', true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      PERFORM set_config('role', 'authenticated', true);

      v_res := public.register_attendance_device(
        '${deviceId}',
        'android',
        'Asia/Karachi',
        '1.3.7',
        NULL
      );

      IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'register failed: %', v_res;
      END IF;
      IF length(COALESCE(v_res->>'device_token', '')) < 32 THEN
        RAISE EXCEPTION 'missing device_token: %', v_res;
      END IF;

      v_row_id := (v_res->>'device_row_id')::uuid;
      SELECT revoked_at IS NULL INTO v_active
      FROM public.attendance_devices WHERE id = v_row_id;
      IF v_active IS NOT TRUE THEN
        RAISE EXCEPTION 'device row not active after register';
      END IF;

      PERFORM public.revoke_attendance_device(v_row_id);
      SELECT revoked_at IS NOT NULL INTO v_revoked
      FROM public.attendance_devices WHERE id = v_row_id;
      IF v_revoked IS NOT TRUE THEN
        RAISE EXCEPTION 'revoke failed';
      END IF;

      RAISE NOTICE 'register_ok row=% token_len=%', v_row_id, length(v_res->>'device_token');
    END;
    $body$;
    SELECT '${deviceId}' AS device_id;
  `);
  assert(Array.isArray(rows), `unexpected response: ${JSON.stringify(rows)}`);
  console.log(`✅ register→row→revoke OK (device_id=${deviceId})`);
  return { ok: true, device_id: deviceId };
}

/** App-identical JWT RPC via supabase-js (same arg names as autoAttendanceSetup.ts). */
async function testRegisterViaRpcClient(email, password) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr) throw new Error(`signIn failed: ${signErr.message}`);

  const deviceId = crypto.randomUUID();
  const { data, error } = await client.rpc('register_attendance_device', {
    p_device_id: deviceId,
    p_platform: 'android',
    p_device_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    p_app_version: '1.3.7',
    p_token_plaintext: null,
  });
  if (error) throw new Error(`RPC register_attendance_device: ${error.message}`);
  assert(data?.ok === true, `RPC returned not ok: ${JSON.stringify(data)}`);
  assert(data?.device_token, 'RPC missing device_token');

  const rowId = data.device_row_id;
  const { error: revErr } = await client.rpc('revoke_attendance_device', {
    p_device_row_id: rowId,
  });
  if (revErr) throw new Error(`revoke: ${revErr.message}`);
  await client.auth.signOut();
  console.log(`✅ client RPC register→revoke OK as ${email} (row=${rowId})`);
}

async function findQaUser() {
  if (process.env.QA_EMAIL) {
    const rows = await sql(`
      SELECT id, email, full_name FROM public.users
      WHERE email = '${process.env.QA_EMAIL.replace(/'/g, "''")}' LIMIT 1
    `);
    return rows[0] || null;
  }
  const rows = await sql(`
    SELECT id, email, full_name FROM public.users
    WHERE full_name ILIKE '%Scorr%QA%'
       OR full_name ILIKE 'Scorr QA%'
       OR email ILIKE '%qa%@%'
    ORDER BY
      CASE WHEN full_name ILIKE '%Scorr%QA%' THEN 0 ELSE 1 END,
      created_at DESC NULLS LAST
    LIMIT 5
  `);
  return rows[0] || null;
}

async function withTempUser(fn) {
  const email = `regtest_${Date.now()}@scorr.test`;
  const password = `RegTest_${Date.now()}!`;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Reg Test', role: 'employee' },
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  const userId = created.user.id;
  try {
    // Ensure public.users row has a company (trigger may leave null on staging)
    await sql(`
      UPDATE public.users u
      SET company_id = COALESCE(
        u.company_id,
        (SELECT id FROM public.companies ORDER BY created_at NULLS LAST LIMIT 1)
      ),
      role = COALESCE(u.role, 'employee'::public.user_role),
      work_mode = COALESCE(u.work_mode, 'office'),
      auto_phone_attendance = true
      WHERE u.id = '${userId}'::uuid
    `);
    await fn(userId, email, password);
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
}

async function main() {
  console.log(`Project: ${projectRef} (env ${envFile})\n`);
  await checkPgcrypto();

  const qa = await findQaUser();
  if (qa) {
    console.log(`QA user: ${qa.full_name || qa.email} (${qa.id})`);
    await testRegisterAsUser(qa.id);
    if (process.env.QA_PASSWORD) {
      await testRegisterViaRpcClient(qa.email, process.env.QA_PASSWORD);
    } else {
      console.log('ℹ️  Set QA_PASSWORD to also exercise JWT supabase.rpc path');
    }
  } else {
    console.log('No Scorr QA user found — using temp user');
    await withTempUser(async (userId, email, password) => {
      await testRegisterAsUser(userId);
      await testRegisterViaRpcClient(email, password);
    });
  }

  console.log('\nALL PASS — register_attendance_device is healthy');
}

main().catch((e) => {
  console.error('\nFAIL:', e.message || e);
  process.exit(1);
});
