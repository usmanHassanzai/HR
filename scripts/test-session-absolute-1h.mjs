#!/usr/bin/env node
/**
 * Verifies absolute 1h session helper logic without shortening production timeout.
 * Simulates a past deadline via localStorage-style timestamps (Node).
 *
 * Usage: node scripts/test-session-absolute-1h.mjs
 */
const PORTAL_SESSION_MAX_MS = 60 * 60 * 1000;
const SESSION_STARTED_KEY = 'scorr-session-started-at';

const store = new Map();

function markPortalSessionStart(reset = false, now = Date.now()) {
  if (!reset && store.has(SESSION_STARTED_KEY)) return;
  store.set(SESSION_STARTED_KEY, String(now));
}

function readStarted() {
  const n = Number(store.get(SESSION_STARTED_KEY));
  return Number.isFinite(n) ? n : null;
}

function isExpired(now = Date.now()) {
  const started = readStarted();
  if (started == null) return false;
  return now - started >= PORTAL_SESSION_MAX_MS;
}

function remaining(now = Date.now()) {
  const started = readStarted();
  if (started == null) return PORTAL_SESSION_MAX_MS;
  return Math.max(0, PORTAL_SESSION_MAX_MS - (now - started));
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg);
    failed += 1;
  } else {
    console.log('PASS', msg);
  }
}

const t0 = 1_700_000_000_000;
markPortalSessionStart(true, t0);
assert(readStarted() === t0, 'session start recorded');
assert(!isExpired(t0 + 30 * 60 * 1000), 'not expired at 30m');
assert(remaining(t0 + 30 * 60 * 1000) === 30 * 60 * 1000, '30m remaining at 30m');
assert(isExpired(t0 + PORTAL_SESSION_MAX_MS), 'expired at exactly 1h');
assert(isExpired(t0 + PORTAL_SESSION_MAX_MS + 1), 'expired after 1h');
assert(remaining(t0 + PORTAL_SESSION_MAX_MS + 5_000) === 0, 'remaining is 0 after expiry');

// Refresh must not extend absolute window
markPortalSessionStart(false, t0 + 90 * 60 * 1000);
assert(readStarted() === t0, 'non-reset mark does not slide start');
assert(isExpired(t0 + 90 * 60 * 1000), 'still expired after fake refresh');

// Fresh login resets
markPortalSessionStart(true, t0 + 2 * 60 * 60 * 1000);
assert(readStarted() === t0 + 2 * 60 * 60 * 1000, 'SIGNED_IN reset works');
assert(!isExpired(t0 + 2 * 60 * 60 * 1000 + 1_000), 'fresh hour after reset');

assert(PORTAL_SESSION_MAX_MS === 3_600_000, 'production constant is 1 hour (not a short test timeout)');

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll absolute session checks passed.');
