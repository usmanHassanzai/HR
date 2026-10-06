/**
 * R73 unit tests — run with:
 *   deno test supabase/functions/_shared/trustedClientIp_test.ts
 *
 * Platform proof (prod debug-ip-echo, 2026-10-06): Cloudflare rewrites XFF so
 * leftmost = client and rightmost = AWS hop; cf-connecting-ip is platform-set;
 * x-real-ip is stripped; true-client-ip / x-client-ip pass through (untrusted).
 */
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import { trustedClientIp } from './trustedClientIp.ts';

function req(headers: Record<string, string>) {
  return new Request('https://example.supabase.co/functions/v1/auto-attendance-event', {
    headers,
  });
}

Deno.test('R73: XFF leftmost (client after CF rewrite) wins; rightmost AWS hop ignored', () => {
  // Observed prod form: <client>,<client>, <aws-hop>
  const client = '111.92.141.22';
  const awsHop = '13.248.117.75';
  const ip = trustedClientIp(req({ 'x-forwarded-for': `${client},${client}, ${awsHop}` }));
  assertEquals(ip, client);
  assertEquals(ip === awsHop, false);
});

Deno.test('R73: single-hop XFF uses that hop', () => {
  assertEquals(trustedClientIp(req({ 'x-forwarded-for': '203.0.113.10' })), '203.0.113.10');
});

Deno.test('R73: cf-connecting-ip preferred over XFF', () => {
  assertEquals(
    trustedClientIp(
      req({
        'x-forwarded-for': '203.0.113.10, 13.248.117.75',
        'cf-connecting-ip': '198.51.100.99',
      }),
    ),
    '198.51.100.99',
  );
});

Deno.test('R73: x-real-ip is ignored (not platform-set on Supabase Edge)', () => {
  assertEquals(
    trustedClientIp(
      req({
        'x-forwarded-for': '203.0.113.10, 13.248.117.75',
        'x-real-ip': '198.51.100.77',
      }),
    ),
    '203.0.113.10',
  );
});

Deno.test('R73: missing headers → null', () => {
  assertEquals(trustedClientIp(req({})), null);
});
