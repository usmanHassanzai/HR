/**
 * Staging smoke tests for trusted_device MFA skip.
 * Usage:
 *   ENV_FILE=.env.staging SUPABASE_PROJECT_REF=utxylrrrzsjetncrajxj \
 *     TEST_EMAIL=... TEST_PASSWORD=... node scripts/test-trusted-device.mjs
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env.staging'));
loadEnvFile(path.join(ROOT, '.env'));

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const REF = process.env.SUPABASE_PROJECT_REF || 'utxylrrrzsjetncrajxj';

if (!URL || !ANON || !SERVICE) {
  console.error('Missing URL/ANON/SERVICE');
  process.exit(1);
}

const PEPPER = SERVICE;
async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashToken(token) {
  return sha256Hex(`${PEPPER}:trusted_device:${token}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function invoke(jwt, body) {
  const res = await fetch(`${URL}/functions/v1/trusted_device`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: ANON,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log('trusted_device tests →', REF, URL);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const userClient = createClient(URL, ANON, { auth: { persistSession: false } });

  if (!EMAIL || !PASSWORD) {
    console.log('No TEST_EMAIL/TEST_PASSWORD — checking schema + can_trust only via service role.');
    const { error: tErr } = await admin.from('trusted_devices').select('id').limit(1);
    assert(!tErr, `trusted_devices table: ${tErr?.message}`);
    console.log('✅ trusted_devices table reachable');
    const { data: cols } = await admin.rpc('get_company_mfa_trust_policy').catch(() => ({ data: null }));
    console.log('policy rpc (unauth may fail):', cols);
    console.log('SKIP full flow (provide TEST_EMAIL + TEST_PASSWORD for end-to-end)');
    return;
  }

  const { data: signIn, error: signErr } = await userClient.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  assert(!signErr && signIn.session, `sign-in failed: ${signErr?.message}`);
  let jwt = signIn.session.access_token;
  const userId = signIn.session.user.id;
  const deviceId = `test-${crypto.randomUUID()}`;

  // Ensure we have MFA satisfaction: create a synthetic grant as service role for issue test
  // (user may be AAL1 after password-only login)
  await admin.from('mfa_session_grants').upsert({
    user_id: userId,
    session_id: signIn.session.user?.id ? (JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).session_id || `fallback-${userId}`) : `fallback-${userId}`,
    method: 'test_setup',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }, { onConflict: 'user_id,session_id' });

  // 1) Issue trust
  let r = await invoke(jwt, {
    action: 'issue',
    device_id: deviceId,
    platform: 'web',
    user_agent: 'trusted-device-test',
  });
  assert(r.status === 200 && r.data.ok && r.data.token, `issue failed: ${JSON.stringify(r.data)}`);
  const token1 = r.data.token;
  console.log('✅ issue token');

  // Fresh password session (AAL1) + verify with token → grant
  await userClient.auth.signOut();
  const { data: sign2, error: e2 } = await userClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  assert(!e2 && sign2.session, 're-login failed');
  jwt = sign2.session.access_token;

  r = await invoke(jwt, {
    action: 'verify',
    device_id: deviceId,
    token: token1,
    platform: 'web',
  });
  assert(r.data.ok && r.data.token && r.data.token !== token1, `verify/rotate failed: ${JSON.stringify(r.data)}`);
  const token2 = r.data.token;
  console.log('✅ verify same device (rotated)');

  // 2) Old token rejected (rotation)
  r = await invoke(jwt, {
    action: 'verify',
    device_id: deviceId,
    token: token1,
  });
  assert(!r.data.ok, 'old token should be rejected after rotation');
  console.log('✅ rotated old token rejected');

  // 3) Forged token other device
  r = await invoke(jwt, {
    action: 'verify',
    device_id: 'other-device',
    token: token2,
  });
  assert(!r.data.ok, 'token+wrong device_id should fail when bound');
  console.log('✅ wrong device_id rejected');

  // Re-verify with correct device to get fresh token
  r = await invoke(jwt, { action: 'verify', device_id: deviceId, token: token2 });
  // may fail if previous wrong-device attempt didn't revoke — token2 still valid if device_id filter missed
  let token3 = r.data.ok ? r.data.token : token2;
  if (!r.data.ok) {
    // re-issue
    await admin.from('mfa_session_grants').upsert({
      user_id: userId,
      session_id: `fallback-${userId}`,
      method: 'test_setup',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }, { onConflict: 'user_id,session_id' });
    r = await invoke(jwt, { action: 'issue', device_id: deviceId, platform: 'web' });
    token3 = r.data.token;
  }

  // 4) Revoke → code required
  r = await invoke(jwt, { action: 'revoke_all' });
  assert(r.data.ok, `revoke_all failed: ${JSON.stringify(r.data)}`);
  r = await invoke(jwt, { action: 'verify', device_id: deviceId, token: token3 });
  assert(!r.data.ok, 'revoked token should fail');
  console.log('✅ revoked → rejected');

  // 5) Re-issue after revoke (same device_id) + expiry simulation
  // revoke_all removes trusted_device session grants — restore MFA satisfaction for issue.
  await admin.from('mfa_session_grants').delete().eq('user_id', userId).eq('method', 'test_setup');
  const { error: grantErr } = await admin.from('mfa_session_grants').insert({
    user_id: userId,
    session_id: `fallback-${userId}`,
    method: 'test_setup',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert(!grantErr, `grant restore failed: ${grantErr?.message}`);
  r = await invoke(jwt, { action: 'issue', device_id: deviceId, platform: 'web' });
  assert(r.data.ok && r.data.token, `re-issue failed: status=${r.status} ${JSON.stringify(r.data)}`);
  console.log('✅ re-issue after revoke');
  const tokenExp = r.data.token;
  const { error: expErr } = await admin.from('trusted_devices').update({
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }).eq('user_id', userId).eq('device_id', deviceId).is('revoked_at', null);
  assert(!expErr, `expiry update failed: ${expErr?.message}`);
  r = await invoke(jwt, { action: 'verify', device_id: deviceId, token: tokenExp });
  assert(!r.data.ok && r.data.reason === 'expired', `expiry check: ${JSON.stringify(r.data)}`);
  console.log('✅ expired → rejected');

  // 6) Always-ask policy blocks issue
  const { data: me } = await admin.from('users').select('company_id, role').eq('id', userId).maybeSingle();
  if (me?.company_id) {
    const { data: before } = await admin
      .from('companies')
      .select('mfa_trust_staff_days, mfa_trust_admin_days')
      .eq('id', me.company_id)
      .maybeSingle();
    await admin.from('companies').update({
      mfa_trust_staff_days: 0,
      mfa_trust_admin_days: 0,
    }).eq('id', me.company_id);
    await admin.from('mfa_session_grants').upsert({
      user_id: userId,
      session_id: `fallback-${userId}`,
      method: 'test_setup',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }, { onConflict: 'user_id,session_id' });
    r = await invoke(jwt, { action: 'issue', device_id: deviceId + '-ask', platform: 'web' });
    assert(r.status === 403 || r.data.allowed === false || !r.data.ok, `always ask should block: ${JSON.stringify(r.data)}`);
    console.log('✅ admin always ask → no trust');
    // restore
    await admin.from('companies').update({
      mfa_trust_staff_days: before?.mfa_trust_staff_days ?? 7,
      mfa_trust_admin_days: before?.mfa_trust_admin_days ?? 7,
    }).eq('id', me.company_id);
  }

  // Cleanup
  await admin.rpc('revoke_trusted_devices_for_user', { p_user_id: userId, p_reason: 'test_cleanup' });
  await admin.from('mfa_session_grants').delete().eq('user_id', userId).eq('method', 'test_setup');
  console.log('✅ all trusted_device staging checks passed');
}

main().catch((e) => {
  console.error('❌', e.message || e);
  process.exit(1);
});
