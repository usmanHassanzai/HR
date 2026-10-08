/**
 * Apply FIX_shift_end_timezone_orphan_visits in safe chunks, then verify.
 */
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function loadEnv() {
  const out = {};
  for (const p of [join(homedir(), '.scorr', 'supabase.env'), join(process.cwd(), '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const env = { ...process.env, ...loadEnv() };
const PAT = env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_PAT || env.SCORR_SUPABASE_PAT;
if (!PAT) {
  console.error('Missing SUPABASE_ACCESS_TOKEN / PAT');
  process.exit(1);
}

const REF = 'yvnbxweitelowucdhwpg';
const uid = 'e6e0a783-6fdf-43fa-80b1-b23b04b6af3a';
const migPath = join(process.cwd(), 'supabase/migrations/FIX_shift_end_timezone_orphan_visits_2026-10-08.sql');
const fullSql = readFileSync(migPath, 'utf8');

/** Split on top-level statement boundaries used in this migration. */
function splitChunks(sql) {
  const markers = [
    '-- Prefer shift/company TZ',
    '-- Keep 4-arg signature',
    'CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(',
    '-- History: keep null while any visit is open',
    '-- History read path:',
    'GRANT EXECUTE ON FUNCTION public.app_timezone()',
    '-- Close everyone whose shift already ended',
  ];
  const idxs = [0];
  for (const m of markers) {
    const i = sql.indexOf(m);
    if (i > 0) idxs.push(i);
  }
  idxs.sort((a, b) => a - b);
  const uniq = [...new Set(idxs)];
  const chunks = [];
  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i];
    const end = i + 1 < uniq.length ? uniq[i + 1] : sql.length;
    const part = sql.slice(start, end).trim();
    if (part) chunks.push(part);
  }
  return chunks;
}

async function q(sql, readOnly = false, label = '') {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(`FAIL ${label || 'query'} HTTP ${res.status}:`, typeof body === 'string' ? body.slice(0, 1200) : JSON.stringify(body).slice(0, 1200));
    throw new Error(`${label || 'query'} failed`);
  }
  // Management API sometimes returns error objects with 200
  if (body && typeof body === 'object' && !Array.isArray(body) && (body.message || body.error)) {
    console.error(`FAIL ${label || 'query'}:`, JSON.stringify(body).slice(0, 1200));
    throw new Error(`${label || 'query'} failed`);
  }
  console.log(`OK ${label || 'query'}`);
  if (readOnly || label.startsWith('verify')) {
    console.log(JSON.stringify(body, null, 2));
  }
  return body;
}

const chunks = splitChunks(fullSql);
console.log(`Applying ${chunks.length} chunks…\n`);

for (let i = 0; i < chunks.length; i++) {
  const label = `chunk ${i + 1}/${chunks.length}`;
  const preview = chunks[i].slice(0, 80).replace(/\s+/g, ' ');
  console.log(`→ ${label}: ${preview}…`);
  try {
    await q(chunks[i], false, label);
  } catch (e) {
    // If chunking broke a statement, fall back to full file once.
    if (i === 0) throw e;
    console.warn(`Chunk failed; retrying remaining as one statement from chunk ${i + 1}…`);
    await q(chunks.slice(i).join('\n\n'), false, 'remainder');
    break;
  }
}

console.log('\n=== VERIFY ===\n');

await q(`SELECT public.app_timezone() AS tz;`, true, 'verify app_timezone');

await q(
  `
SELECT
  public.shift_end_timestamptz(
    '2026-10-07'::date, '18:00'::time, '03:00'::time,
    '2026-10-07 16:46:06.208774+00'::timestamptz
  ) AS computed_end,
  '2026-10-07 22:00:00+00'::timestamptz AS expected_end,
  public.shift_end_timestamptz(
    '2026-10-07'::date, '18:00'::time, '03:00'::time,
    '2026-10-07 16:46:06.208774+00'::timestamptz,
    'Asia/Karachi'
  ) AS computed_end_5arg;
`,
  true,
  'verify shift_end'
);

await q(
  `
SELECT ar.attendance_date, ar.clock_in_at, ar.clock_out_at, ar.work_minutes
FROM attendance_records ar
WHERE ar.user_id = '${uid}' AND ar.attendance_date = '2026-10-07';
`,
  true,
  'verify Anees day'
);

await q(
  `
SELECT vs.visit_number, vs.clock_in_at, vs.clock_out_at, vs.work_minutes,
       (vs.clock_out_at IS NULL) AS is_open
FROM attendance_visit_segments vs
WHERE vs.user_id = '${uid}' AND vs.attendance_date = '2026-10-07'
ORDER BY visit_number;
`,
  true,
  'verify Anees visits'
);

await q(
  `SELECT public.close_open_attendance_if_shift_ended('${uid}'::uuid, NULL, NULL) AS closed_n;`,
  false,
  'verify closer Anees'
);

await q(
  `
SELECT COUNT(*)::int AS open_orphans_global
FROM attendance_visit_segments vs
JOIN attendance_records ar
  ON ar.user_id = vs.user_id AND ar.attendance_date = vs.attendance_date
WHERE vs.clock_out_at IS NULL
  AND ar.status IS DISTINCT FROM 'absent';
`,
  true,
  'verify open orphans left'
);

console.log('\nDone.');
