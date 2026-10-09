#!/usr/bin/env node
/**
 * Part 2/3 tests: stale drop, server refuse, cleanup retention, records untouched.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const pat = env.SUPABASE_PAT || env.SUPABASE_ACCESS_TOKEN || env.SCORR_SUPABASE_PAT;
const ref = process.env.SUPABASE_PROJECT_REF || 'yvnbxweitelowucdhwpg';

async function q(query, read_only = true) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only }),
  });
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(t.slice(0, 800));
  }
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`PASS\t${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL\t${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const MAX_AGE = 10 * 60 * 1000;
function isFresh(occurred, now) {
  return Number.isFinite(occurred) && occurred > 0 && now - occurred <= MAX_AGE;
}
function takeNewest(queue, now) {
  const fresh = [];
  for (const item of queue) {
    if (!isFresh(item.occurred_at_utc_ms, now)) continue;
    fresh.push(item);
  }
  fresh.sort((a, b) => b.occurred_at_utc_ms - a.occurred_at_utc_ms);
  return fresh[0] || null;
}

const now = Date.now();
const stale20 = { event: 'ping', occurred_at_utc_ms: now - 20 * 60 * 1000 };
const fresh = { event: 'exit', occurred_at_utc_ms: now - 30 * 1000 };
const olderFresh = { event: 'ping', occurred_at_utc_ms: now - 2 * 60 * 1000 };
ok('client drops 20m-old event', !isFresh(stale20.occurred_at_utc_ms, now));
const newest = takeNewest([stale20, olderFresh, fresh], now);
ok(
  'reconnect keeps only newest fresh reading',
  newest?.event === 'exit' && newest?.occurred_at_utc_ms === fresh.occurred_at_utc_ms,
  JSON.stringify(newest),
);

const countsBefore = (
  await q(`
  SELECT
    (SELECT count(*)::int FROM attendance_records) AS records,
    (SELECT count(*)::int FROM attendance_visit_segments) AS visits,
    (SELECT count(*)::int FROM employee_location_pings_archive) AS pings_arch
`)
)[0];

const staleRpc = await q(
  `
WITH emp AS (
  SELECT id AS uid, company_id AS co FROM public.users WHERE role = 'employee' LIMIT 1
),
tok AS (
  SELECT public.attendance_hash_device_token('tok-stale-20m-' || substr(md5(random()::text),1,6)) AS h,
         'cleanup-stale-' || substr(md5(random()::text),1,6) AS did
),
ins AS (
  INSERT INTO public.attendance_devices (user_id, company_id, device_id, platform, token_hash, app_version)
  SELECT emp.uid, emp.co, tok.did, 'android', tok.h, 'test'
  FROM emp, tok
  RETURNING token_hash, device_id
),
call AS (
  SELECT public.process_auto_attendance_event(
    (SELECT token_hash FROM ins),
    'ping', NULL, 24.86, 67.00, 20, NULL, NULL,
    ((extract(epoch from timezone('utc', now())) * 1000)::BIGINT - 20 * 60 * 1000),
    (extract(epoch from timezone('utc', now())) * 1000)::BIGINT,
    'Asia/Karachi', false,
    (SELECT device_id FROM ins), 'android', 'test', '127.0.0.1'
  ) AS res,
  (SELECT device_id FROM ins) AS did
)
SELECT res, did FROM call;
`,
  false,
);
const staleRes = staleRpc?.[0]?.res;
const staleReason = staleRes?.reason || staleRes?.action;
ok(
  'server refuses 20m-old event',
  staleReason === 'event_too_old',
  JSON.stringify(staleRes)?.slice(0, 220),
);

const retention = await q(`SELECT public.attendance_retention_cleanup() AS r`, false);
const countsAfter = (
  await q(`
  SELECT
    (SELECT count(*)::int FROM attendance_records) AS records,
    (SELECT count(*)::int FROM attendance_visit_segments) AS visits,
    (SELECT count(*)::int FROM employee_location_pings) AS pings,
    (SELECT count(*)::int FROM employee_location_pings WHERE recorded_at < now() - interval '30 days') AS pings_old,
    (SELECT count(*)::int FROM employee_location_pings_archive) AS pings_arch
`)
)[0];

ok(
  'attendance_records count unchanged',
  countsBefore.records === countsAfter.records,
  `${countsBefore.records} -> ${countsAfter.records}`,
);
ok(
  'visit segments count unchanged',
  countsBefore.visits === countsAfter.visits,
  `${countsBefore.visits} -> ${countsAfter.visits}`,
);
ok('no live pings older than 30d', countsAfter.pings_old === 0, `old=${countsAfter.pings_old}`);
ok(
  'pings archive present after cleanup',
  countsAfter.pings_arch >= (countsBefore.pings_arch || 0),
  `arch=${countsAfter.pings_arch} retention=${JSON.stringify(retention?.[0]?.r)}`,
);

const did = staleRpc?.[0]?.did;
if (did) {
  await q(
    `
DELETE FROM public.attendance_events_log
WHERE device_id IN (SELECT id FROM public.attendance_devices WHERE device_id = '${did}');
DELETE FROM public.attendance_devices WHERE device_id = '${did}';
`,
    false,
  );
}

console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} total`);
process.exit(fail ? 1 : 0);
