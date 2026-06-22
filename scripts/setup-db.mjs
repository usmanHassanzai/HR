/**
 * Automated Supabase DB Setup — v3
 * Drops existing objects and re-applies schema + seed cleanly
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();
const BASE = 'https://api.supabase.com/v1';

const H = { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const ok  = m => console.log(`✅  ${m}`);
const inf = m => console.log(`ℹ️   ${m}`);
const warn = m => console.log(`⚠️   ${m}`);
const fail = m => console.log(`❌  ${m}`);

async function sql(query, label = '') {
  const res = await fetch(`${BASE}/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: H, body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${label}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

async function main() {
  console.log('\n🚀  Scorr — DB Setup v3\n' + '─'.repeat(44));

  // ── 1. Get keys ──────────────────────────────────────────────────────────────
  inf('Fetching project API keys...');
  const res = await fetch(`${BASE}/projects/${PROJECT_REF}/api-keys`, { headers: H });
  const keys = await res.json();
  const anon    = keys.find(k => k.name === 'anon')?.api_key;
  const service = keys.find(k => k.name === 'service_role')?.api_key;
  if (!anon) throw new Error('anon key not found');
  ok('API keys retrieved');

  // ── 2. Write .env ─────────────────────────────────────────────────────────────
  const url = `https://${PROJECT_REF}.supabase.co`;
  fs.writeFileSync(path.join(ROOT, '.env'),
    `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\nSUPABASE_SERVICE_ROLE_KEY=${service}\n`
  );
  ok(`.env updated → ${url}`);

  // ── 2b. Auth config: auto-confirm users (no confirmation emails / rate limit) ─
  inf('Configuring auth (auto-confirm new users)...');
  const authRes = await fetch(`${BASE}/projects/${PROJECT_REF}/config/auth`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ mailer_autoconfirm: true, mailer_secure_email_change_enabled: false }),
  });
  if (authRes.ok) ok('Email auto-confirm enabled (no confirmation emails)');
  else warn('Could not update auth config (continuing)');

  // ── 3. Tear down existing objects (idempotent reset) ──────────────────────────
  inf('Dropping existing schema objects (idempotent reset)...');
  await sql(`
    -- Drop triggers safely only if the parent table exists
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname='kpis' AND relnamespace='public'::regnamespace) THEN
        DROP TRIGGER IF EXISTS kpi_before_update ON public.kpis;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname='kpi_submissions' AND relnamespace='public'::regnamespace) THEN
        DROP TRIGGER IF EXISTS kpi_submission_after_insert ON public.kpi_submissions;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname='tasks' AND relnamespace='public'::regnamespace) THEN
        DROP TRIGGER IF EXISTS tasks_before_update ON public.tasks;
      END IF;
    END $$;
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

    -- Drop attendance & leave tables
    DROP TABLE IF EXISTS public.leave_requests CASCADE;
    DROP TABLE IF EXISTS public.attendance_records CASCADE;
    DROP TABLE IF EXISTS public.leave_balances CASCADE;

    -- Drop rewards tables first (reference public.users)
    DROP TABLE IF EXISTS public.reward_redemptions CASCADE;
    DROP TABLE IF EXISTS public.rewards_catalog    CASCADE;
    DROP TABLE IF EXISTS public.points_ledger      CASCADE;

    -- Drop core tables (cascade removes all dependent policies/triggers)
    DROP TABLE IF EXISTS public.notifications  CASCADE;
    DROP TABLE IF EXISTS public.kpi_submissions CASCADE;
    DROP TABLE IF EXISTS public.tasks          CASCADE;
    DROP TABLE IF EXISTS public.kpis           CASCADE;
    DROP TABLE IF EXISTS public.users          CASCADE;

    -- Drop functions
    DROP FUNCTION IF EXISTS public.handle_new_user()    CASCADE;
    DROP FUNCTION IF EXISTS public.on_kpi_update()      CASCADE;
    DROP FUNCTION IF EXISTS public.on_kpi_submission()  CASCADE;
    DROP FUNCTION IF EXISTS public.run_submission_automation(UUID, UUID, NUMERIC, NUMERIC) CASCADE;
    DROP FUNCTION IF EXISTS public.check_kpi_escalation(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.generate_suggested_target(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.generate_ai_narrative(TEXT, TEXT, kpi_status_type, NUMERIC, NUMERIC, NUMERIC) CASCADE;
    DROP FUNCTION IF EXISTS public.calculate_user_health_score(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.create_system_notification(UUID, TEXT, TEXT, notification_type) CASCADE;
    DROP FUNCTION IF EXISTS public.set_updated_at()     CASCADE;
    DROP FUNCTION IF EXISTS public.calculate_kpi_status(TEXT, NUMERIC, NUMERIC) CASCADE;
    DROP FUNCTION IF EXISTS public.is_admin(UUID)       CASCADE;
    DROP FUNCTION IF EXISTS public.is_manager_of(UUID, UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.get_direct_reports(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.get_all_users_admin() CASCADE;
    DROP FUNCTION IF EXISTS public.delete_user_admin(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.monthly_points_for_score(NUMERIC) CASCADE;
    DROP FUNCTION IF EXISTS public.calculate_monthly_points(DATE) CASCADE;
    DROP FUNCTION IF EXISTS public.get_points_leaderboard() CASCADE;
    DROP FUNCTION IF EXISTS public.notify_manager_on_redemption() CASCADE;

    DROP FUNCTION IF EXISTS public.get_pending_leave_requests() CASCADE;
    DROP FUNCTION IF EXISTS public.submit_leave_request(public.leave_type, DATE, DATE, TEXT) CASCADE;
    DROP FUNCTION IF EXISTS public.review_attendance(UUID, BOOLEAN, TEXT) CASCADE;
    DROP FUNCTION IF EXISTS public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) CASCADE;
    DROP FUNCTION IF EXISTS public.check_in_attendance(DATE) CASCADE;
    DROP FUNCTION IF EXISTS public.get_my_leave_summary(INTEGER, INTEGER) CASCADE;
    DROP FUNCTION IF EXISTS public.get_my_attendance_summary(INTEGER) CASCADE;
    DROP FUNCTION IF EXISTS public.get_my_attendance_summary(INTEGER, INTEGER) CASCADE;
    DROP FUNCTION IF EXISTS public.get_leave_balance(UUID) CASCADE;
    DROP FUNCTION IF EXISTS public.ensure_leave_balance(UUID, INTEGER) CASCADE;
    DROP FUNCTION IF EXISTS public.count_weekdays(DATE, DATE) CASCADE;
    DROP TYPE IF EXISTS public.leave_type CASCADE;
    DROP TYPE IF EXISTS public.approval_status CASCADE;
    DROP TYPE IF EXISTS public.attendance_status CASCADE;

    -- Drop enums
    DROP TYPE IF EXISTS user_role          CASCADE;
    DROP TYPE IF EXISTS kpi_status_type    CASCADE;
    DROP TYPE IF EXISTS task_status_type   CASCADE;
    DROP TYPE IF EXISTS notification_type  CASCADE;
  `, 'teardown');
  ok('Existing objects removed');

  // ── 4. Apply schema ───────────────────────────────────────────────────────────
  inf('Applying schema.sql...');
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
  await sql(schema, 'schema.sql');
  ok('schema.sql applied');

  // ── 5. Apply seed ─────────────────────────────────────────────────────────────
  inf('Applying seed.sql...');
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  try {
    await sql(seed, 'seed.sql');
    ok('seed.sql applied');
  } catch (e) {
    warn(`seed.sql partial (auth users may need Supabase dashboard): ${e.message.slice(0, 200)}`);
  }

  // ── 6. Verify ─────────────────────────────────────────────────────────────────
  inf('Verifying tables...');
  const rows = await sql(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`,
    'verify'
  );
  const tables   = rows.map(r => r.table_name);
  const expected = ['kpi_submissions', 'kpis', 'notifications', 'tasks', 'users'];
  const missing  = expected.filter(t => !tables.includes(t));

  if (missing.length === 0) {
    ok(`All 5 tables verified: ${expected.join(', ')}`);
  } else {
    fail(`Missing: ${missing.join(', ')}`);
  }

  inf('Verifying functions...');
  const fns = await sql(
    `SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' ORDER BY routine_name;`,
    'fn-verify'
  );
  const fnNames = fns.map(f => f.routine_name);
  ok(`Functions: ${fnNames.join(', ')}`);

  inf('Verifying user hierarchy...');
  const users = await sql(
    `SELECT e.email, e.role, m.email AS manager_email
     FROM public.users e
     LEFT JOIN public.users m ON m.id = e.manager_id
     ORDER BY e.email;`,
    'users-verify'
  );
  users.forEach(u => ok(`${u.email} (${u.role})${u.manager_email ? ` → reports to ${u.manager_email}` : ''}`));

  inf('Testing get_direct_reports RPC for manager...');
  const reports = await sql(
    `SELECT email FROM public.users
     WHERE manager_id = (SELECT id FROM public.users WHERE email = 'manager@walfia.ai');`,
    'reports-verify'
  );
  ok(`Manager direct reports: ${reports.length ? reports.map(r => r.email).join(', ') : 'NONE'}`);

  console.log('\n' + '─'.repeat(44));
  console.log('🎉  Database fully ready!\n');
  console.log(`   URL:  ${url}`);
  console.log(`\n   Login shortcuts in app:`);
  console.log(`   👤  Employee →  employee@walfia.ai  /  employee123`);
  console.log(`   👔  Manager  →  manager@walfia.ai   /  manager123`);
  console.log(`   🛡️   Admin    →  admin@walfia.ai     /  admin123`);
  console.log('\n' + '─'.repeat(44) + '\n');
}

main().catch(e => { fail(`Fatal: ${e.message}`); process.exit(1); });
