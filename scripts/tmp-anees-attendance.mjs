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
  const text = await res.text();
  console.log(text);
  console.log('---');
  return text;
}

await q(`
select now() as utc_now,
  (now() at time zone 'Asia/Karachi')::text as karachi_now;
`);

await q(`
select ar.id, ar.attendance_date, ar.clock_in_at, ar.clock_out_at, ar.work_minutes,
       ar.status, ar.attendance_source, ar.shift_id, left(ar.notes, 200) as notes
from attendance_records ar
where ar.user_id = '${uid}'
  and ar.attendance_date >= '2026-10-06'
order by ar.attendance_date desc;
`);

await q(`
select vs.attendance_date, vs.visit_number, vs.clock_in_at, vs.clock_out_at, vs.work_minutes, left(vs.notes, 160) as notes
from attendance_visit_segments vs
where vs.user_id = '${uid}'
  and vs.attendance_date >= '2026-10-06'
order by vs.attendance_date desc, vs.visit_number;
`);

await q(`
select esa.shift_id, ws.name, ws.start_time, ws.end_time, ws.crosses_midnight, ws.timezone,
       esa.effective_from, esa.effective_to
from employee_shift_assignments esa
join work_shifts ws on ws.id = esa.shift_id
where esa.user_id = '${uid}'
order by esa.effective_from desc
limit 5;
`);

await q(`
select * from attendance_window_for_user('${uid}'::uuid, now());
`);

await q(`
select public.shift_end_timestamptz(
  '2026-10-07'::date,
  (select start_time from work_shifts ws
     join employee_shift_assignments esa on esa.shift_id = ws.id
    where esa.user_id = '${uid}' order by esa.effective_from desc limit 1),
  (select end_time from work_shifts ws
     join employee_shift_assignments esa on esa.shift_id = ws.id
    where esa.user_id = '${uid}' order by esa.effective_from desc limit 1),
  (select clock_in_at from attendance_records
    where user_id = '${uid}' and attendance_date = '2026-10-07' limit 1)
) as shift_end_oct7;
`, true);

await q(`select public.close_open_attendance_if_shift_ended('${uid}'::uuid, null, null) as closed_n;`, false);
await q(`select public.attendance_cron_tick() as cron;`, false);

await q(`
select ar.attendance_date, ar.clock_in_at, ar.clock_out_at, ar.work_minutes, left(ar.notes, 200) as notes
from attendance_records ar
where ar.user_id = '${uid}'
  and ar.attendance_date >= '2026-10-06'
order by ar.attendance_date desc;
`);
