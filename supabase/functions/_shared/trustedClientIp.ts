/**
 * R73 — trusted client IP for Supabase Edge Functions.
 *
 * Proven on production (project yvnbxweitelowucdhwpg) via temporary
 * `debug-ip-echo` (2026-10-06), known public IP 111.92.141.22:
 *
 * - `cf-connecting-ip`: Cloudflare overwrites to the real client IP.
 *   Forging it returns Cloudflare error 1000 / HTTP 403. SAFE to trust.
 * - `x-real-ip`: always null; forged values are stripped. NOT set by the
 *   platform → do not trust (removed).
 * - `true-client-ip` / `x-client-ip`: pass through from the client UNCHANGED
 *   → NEVER trust.
 * - `x-forwarded-for`: platform REWRITES the entire header. Forged values
 *   never appear. Observed form: `<client>,<client>, <aws-hop>`.
 *   Leftmost hop = client; rightmost = internal AWS hop. Use LEFTMOST only.
 *
 * Never read IP from the request body.
 */

export function trustedClientIp(req: {
  headers: { get(name: string): string | null };
}): string | null {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;

  const xff = req.headers.get('x-forwarded-for') || req.headers.get('X-Forwarded-For');
  if (!xff) return null;

  const hops = xff
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return null;

  // Leftmost = client IP after Cloudflare rewrite (rightmost is AWS hop).
  return hops[0] ?? null;
}
