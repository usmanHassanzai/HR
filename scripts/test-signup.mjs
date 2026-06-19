/**
 * Diagnostic: reproduce the admin "register new user" flow to capture the real error.
 * Cleans up the created auth user afterwards. Run: node scripts/test-signup.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp(`${k}=(.*)`)) || [])[1]?.trim();
const URL = get('VITE_SUPABASE_URL');
const ANON = get('VITE_SUPABASE_ANON_KEY');
const SERVICE = get('SUPABASE_SERVICE_ROLE_KEY');

const testEmail = `testuser_${Date.now()}@walfia.ai`;

console.log(`\nAttempting signUp for ${testEmail} ...`);
const res = await fetch(`${URL}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: testEmail,
    password: 'test123456',
    data: { full_name: 'Test User', role: 'employee' },
  }),
});
const body = await res.json();
console.log(`HTTP ${res.status}`);
console.log('Response:', JSON.stringify(body, null, 2));

// Cleanup if created
if (SERVICE && body?.id) {
  await fetch(`${URL}/auth/v1/admin/users/${body.id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  console.log('Cleaned up test user.');
}
