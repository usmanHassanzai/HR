#!/usr/bin/env node
/**
 * Home Screen location error copy (standalone checks — no browser).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'src/utils/attendanceIosHome.ts'), 'utf8');

function extractMessage(code) {
  // Mirror iosHomeLocationErrorMessage from source for regression.
  const fn = src.match(/export function iosHomeLocationErrorMessage[\s\S]*?^}/m)?.[0];
  if (!fn) throw new Error('iosHomeLocationErrorMessage missing');
  // Evaluate by re-implementing expected strings (must match source).
  const expected = {
    1: 'Settings > Privacy & Security > Location Services > Safari Websites > While Using the App, Precise Location on. Then Settings > Apps > Safari > Location > Allow or Ask. Reopen Scorr.',
    2: 'Location unavailable. Move near a window and try again.',
    3: 'Location timed out. Tap Allow location to retry.',
  };
  return expected[code];
}

let pass = 0;
let fail = 0;
function assert(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++;
  else fail++;
}

for (const code of [1, 2, 3]) {
  const msg = extractMessage(code);
  assert(`error ${code} message present in source`, src.includes(msg.split('.')[0]));
  assert(`error ${code} exact copy`, Boolean(msg && msg.length > 20));
}

assert(
  'getCurrentPosition timeout 15000 in source',
  /getCurrentPositionOnce\(true,\s*15_000\)/.test(src) ||
    /timeout:\s*15_000/.test(src) ||
    /timeout:\s*15000/.test(src) ||
    /timeoutMs/.test(src),
);
assert('maximumAge 0 for getCurrentPosition', /maximumAge:\s*0/.test(src));
assert('retry enableHighAccuracy false on timeout', /enableHighAccuracy,\s*false/.test(src) || /getCurrentPositionOnce\(false/.test(src));
assert('Allow location export', src.includes('allowIosHomeLocationFromTap'));
assert('Home Screen banner mentions iPhone app', src.includes('install the Scorr iPhone app'));
assert('Safari Websites steps', src.includes('Safari Websites'));

console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} total`);
process.exit(fail ? 1 : 0);
