/**
 * Same-origin proxy for trusted-device MFA tokens.
 * Sets HttpOnly Secure SameSite=Strict cookie on scorr.walfia.ai.
 */
const COOKIE = 'scorr_td';

function loadEnv() {
  return {
    url: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
    anon: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function cookieHeader(token, maxAge) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge || 0))}`,
  ];
  return parts.join('; ');
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { url, anon } = loadEnv();
  if (!url || !anon) {
    return res.status(500).json({ error: 'Server misconfigured.' });
  }

  const auth = req.headers.authorization || '';
  if (!auth) return res.status(401).json({ error: 'Not signed in.' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};
  const action = String(body.action || '');

  if (action === 'clear_cookie') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  const cookies = parseCookies(req.headers.cookie || '');
  if ((action === 'verify' || action === 'issue') && !body.token && cookies[COOKIE]) {
    body.token = cookies[COOKIE];
  }

  try {
    const upstream = await fetch(`${url}/functions/v1/trusted_device`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        apikey: anon,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json().catch(() => ({}));

    if (data?.token && typeof data.token === 'string') {
      let maxAge = 7 * 86400;
      if (data.expires_at) {
        maxAge = Math.floor((new Date(data.expires_at).getTime() - Date.now()) / 1000);
      }
      res.setHeader('Set-Cookie', cookieHeader(data.token, maxAge));
      // Do not leak token to JS on web — cookie is the store.
      const { token: _t, ...safe } = data;
      return res.status(upstream.status).json(safe);
    }

    if (
      action === 'revoke'
      || action === 'revoke_all'
      || data?.reason === 'invalid'
      || data?.reason === 'expired'
      || data?.reason === 'always_ask'
      || data?.reason === 'missing_token'
    ) {
      res.setHeader('Set-Cookie', clearCookie());
    }

    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('[api/trusted-device]', e);
    return res.status(500).json({ error: 'Trusted device proxy failed.' });
  }
}
