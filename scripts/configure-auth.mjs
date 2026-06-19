/**
 * Configures Supabase Auth for admin-managed user creation:
 *  - Auto-confirms new users (no confirmation email) → avoids the built-in
 *    email rate limit ("email rate limit exceeded") when registering users.
 *
 * Run: node scripts/configure-auth.mjs
 */
import { requireSupabasePat, supabaseProjectRef } from './lib/require-pat.mjs';

const PAT = requireSupabasePat();
const PROJECT_REF = supabaseProjectRef();
const BASE = 'https://api.supabase.com/v1';
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

async function main() {
  console.log('\n🔧  Configuring Supabase Auth...');

  const res = await fetch(`${BASE}/projects/${PROJECT_REF}/config/auth`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({
      mailer_autoconfirm: true,        // auto-confirm emails (no email sent)
      mailer_secure_email_change_enabled: false,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('❌  Failed:', JSON.stringify(body).slice(0, 400));
    process.exit(1);
  }

  console.log('✅  Email auto-confirm enabled (mailer_autoconfirm =', body.mailer_autoconfirm, ')');
  console.log('✅  New users no longer trigger confirmation emails — rate limit avoided.\n');
}

main().catch((e) => { console.error('❌ ', e.message); process.exit(1); });
