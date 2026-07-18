/** Apply all feature migrations (shifts + departments) */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAT = requireSupabasePat();
const REF = supabaseProjectRef();

const MIGRATIONS = [
  'drop_stale_functions.sql',
  'shift_attendance.sql',
  'shift_attendance_v2.sql',
  'shift_attendance_v2_fix.sql',
  'department_weightages.sql',
  'kpi_assign_manual_weight.sql',
  'department_kpi_indicators.sql',
  'employee_kpi_weight_100.sql',
  'ensure_departments_open.sql',
  'seed_new_department_kpis.sql',
  'multi_tenant_companies.sql',
  'drop_stale_functions_mid.sql',
  'company_registration_fields.sql',
  'drop_stale_functions_mid.sql',
  'manager_department_access.sql',
  'drop_stale_functions_mid.sql',
  'platform_delete_company.sql',
  'tenant_isolation_realtime.sql',
  'fix_live_deploy.sql',
  'admin_only_department_kpis.sql',
  'drop_stale_functions_mid.sql',
  'manager_team_kpi_assign.sql',
  'drop_stale_functions_mid.sql',
  'manager_create_department_kpis.sql',
  'manager_create_employee_kpi.sql',
  'ensure_department_kpi_functions.sql',
  'fix_manager_kpi_functions.sql',
  'assign_select_kpis.sql',
  'enforce_kpi_weight_100_cap.sql',
  'attendance_datetime_history.sql',
  'auto_save_sync.sql',
  'admin_department_crud.sql',
  'ensure_department_functions.sql',
  'delete_department_permanent.sql',
  'admin_rewards_company_scope.sql',
  'fix_live_tracking_role_ambiguous.sql',
  'manager_live_tracking_department_scope.sql',
  'office_radius_50m.sql',
  'fix_platform_owner_profile_access.sql',
  'fix_platform_owner_email.sql',
  'platform_owner_org_admin_access.sql',
  'restore_platform_rpcs_and_auth_trigger.sql',
  'auto_equal_department_weights.sql',
];

async function runMigration(filename) {
  const SQL = fs.readFileSync(path.join(__dirname, `../supabase/migrations/${filename}`), 'utf8');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${filename}: ${JSON.stringify(body).slice(0, 800)}`);
  console.log(`✅ ${filename}`);
}

console.log('Applying Scorr migrations (shifts, attendance, departments)…\n');

for (const file of MIGRATIONS) {
  const full = path.join(__dirname, `../supabase/migrations/${file}`);
  if (!fs.existsSync(full)) {
    console.warn(`⚠️  skip ${file} (not found)`);
    continue;
  }
  try {
    await runMigration(file);
  } catch (e) {
    console.warn(`⚠️  ${file}: ${e.message?.slice(0, 150)}`);
  }
}

console.log('\n✅ Migration pass complete');
