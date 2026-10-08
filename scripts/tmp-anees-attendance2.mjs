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
const REF = 'yvnbxweitelowucdhwpg';
const uid = 'e6e0a783-6fdf-43fa-80b1-b23b04b6af3a';

async function q(sql, readOnly = true) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
  });
  console.log(await res.text());
  console.log('---');
}

await q(`select public.app_timezone() as tz;`);
await q(`
select
  (('2026-10-07'::timestamp + '03:00'::time) at time zone 'Asia/Karachi') as end_local_as_tstz,
  public.shift_end_timestamptz(
    '2026-10-07'::date, '18:00'::time, '03:00'::time,
    '2026-10-07 16:46:06.208774+00'::timestamptz
  ) as computed_end,
  pg_get_functiondef('public.shift_end_timestamptz(date,time,time,timestamptz)'::regprocedure) as def;
`);

await q(`
select s.* from get_active_shift_for_user('${uid}'::uuid, '2026-10-07'::date) s;
`);

// Force-close open visits at correct Karachi shift end (2026-10-07 22:00 UTC = 03:00 PKT Oct 8)
await q(`
UPDATE attendance_visit_segments
SET
  clock_out_at = '2026-10-07 22:00:00+00'::timestamptz,
  work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM ('2026-10-07 22:00:00+00'::timestamptz - clock_in_at)) / 60)::integer),
  notes = trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
WHERE user_id = '${uid}'
  AND attendance_date = '2026-10-07'
  AND clock_out_at IS NULL;

UPDATE attendance_records
SET
  clock_out_at = (
    SELECT MAX(clock_out_at) FROM attendance_visit_segments
    WHERE user_id = '${uid}' AND attendance_date = '2026-10-07'
  ),
  work_minutes = public.attendance_day_total_minutes('${uid}'::uuid, '2026-10-07'::date, '2026-10-07 22:00:00+00'::timestamptz),
  notes = trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
WHERE user_id = '${uid}' AND attendance_date = '2026-10-07';

SELECT vs.visit_number, vs.clock_in_at, vs.clock_out_at, vs.work_minutes
FROM attendance_visit_segments vs
WHERE user_id = '${uid}' AND attendance_date = '2026-10-07'
ORDER BY visit_number;

SELECT clock_in_at, clock_out_at, work_minutes FROM attendance_records
WHERE user_id = '${uid}' AND attendance_date = '2026-10-07';
`, false);
