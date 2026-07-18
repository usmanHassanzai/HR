/**
 * Create platform owner account (Samiya Kayani) if missing.
 * Run once: node scripts/setup-platform-owner.mjs
 */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const REF = supabaseProjectRef();
const BASE = 'https://api.supabase.com/v1';
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const EMAIL = process.env.PLATFORM_OWNER_EMAIL || 'info@walfia.ai';
const PASSWORD = process.env.PLATFORM_OWNER_PASSWORD || 'SamiyaOwner2026!';
const NAME = process.env.PLATFORM_OWNER_NAME || 'Samiya Kayani';

async function sql(query) {
  const res = await fetch(`${BASE}/projects/${REF}/database/query`, {
    method: 'POST', headers: H, body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body).slice(0, 400));
  return body;
}

const keys = await fetch(`${BASE}/projects/${REF}/api-keys`, { headers: H }).then((r) => r.json());
const service = keys.find((k) => k.name === 'service_role')?.api_key;
if (!service) throw new Error('service_role key not found');

const { createClient } = await import('@supabase/supabase-js');
const admin = createClient(`https://${REF}.supabase.co`, service, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const existing = await sql(`SELECT id FROM auth.users WHERE lower(email) = lower('${EMAIL.replace(/'/g, "''")}');`);
if (existing.length > 0) {
  await sql(`UPDATE public.users SET is_platform_owner = true WHERE lower(email) = lower('${EMAIL.replace(/'/g, "''")}');`);
  console.log(`✅ Platform owner already exists: ${EMAIL}`);
  console.log('   Sign in at: https://scorr.walfia.ai/platform');
  process.exit(0);
}

const { data, error } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
  user_metadata: { full_name: NAME },
});

if (error) throw error;

await sql(`UPDATE public.users SET is_platform_owner = true WHERE id = '${data.user.id}';`);

console.log('✅ Platform owner created');
console.log(`   Email:    ${EMAIL}`);
console.log(`   Password: ${PASSWORD}`);
console.log('   Console:  https://scorr.walfia.ai/platform');
console.log('   Change password after first login.');
