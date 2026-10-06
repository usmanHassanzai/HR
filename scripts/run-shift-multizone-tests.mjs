/**
 * R81 — Multi-zone shift tests with FIXED timestamps (no wall-clock now()).
 * Self-contained Intl math (mirrors src/utils/shiftMultiZone.ts).
 * Run: node scripts/run-shift-multizone-tests.mjs
 */

function parseHm(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || '').trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}
function formatHm(h, m) {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
}
function ymdInZone(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day') };
}
function hmInZone(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { h: get('hour'), m: get('minute'), s: get('second') };
}
function zonedWallTimeToUtc(onYmd, hm, timeZone) {
  const [ys, mos, ds] = onYmd.split('-').map(Number);
  const parsed = parseHm(hm);
  const wantedAsUtc = Date.UTC(ys, mos - 1, ds, parsed.h, parsed.m, 0);
  let guess = wantedAsUtc;
  for (let i = 0; i < 5; i++) {
    const got = ymdInZone(new Date(guess), timeZone);
    const gotHm = hmInZone(new Date(guess), timeZone);
    const gotAsUtc = Date.UTC(got.y, got.mo - 1, got.d, gotHm.h, gotHm.m, gotHm.s);
    const delta = gotAsUtc - guess;
    const next = wantedAsUtc - delta;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }
  const check = hmInZone(new Date(guess), timeZone);
  const checkYmd = ymdInZone(new Date(guess), timeZone);
  const sameWall =
    checkYmd.y === ys &&
    checkYmd.mo === mos &&
    checkYmd.d === ds &&
    check.h === parsed.h &&
    check.m === parsed.m;
  if (!sameWall) {
    for (let addMin = 1; addMin <= 180; addMin++) {
      const cand = new Date(guess + addMin * 60_000);
      const cY = ymdInZone(cand, timeZone);
      const cH = hmInZone(cand, timeZone);
      if (cY.y === ys && cY.mo === mos && cY.d === ds) {
        const mins = cH.h * 60 + cH.m;
        const want = parsed.h * 60 + parsed.m;
        if (mins >= want) return cand;
      }
    }
  }
  return new Date(guess);
}
function utcToZonedWall(utc, timeZone) {
  const { y, mo, d } = ymdInZone(utc, timeZone);
  const { h, m } = hmInZone(utc, timeZone);
  const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return {
    ymd,
    hm: formatHm(h, m),
    dayOffsetFrom(baseYmd) {
      return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${baseYmd}T00:00:00Z`)) / 86400000);
    },
  };
}
function isOvernightHm(start, end) {
  const a = parseHm(start);
  const b = parseHm(end);
  return b.h * 60 + b.m <= a.h * 60 + a.m;
}
function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function convertOfficeTime(from, toTimezone, onYmd) {
  const startUtc = zonedWallTimeToUtc(onYmd, from.start, from.timezone);
  const endUtc = zonedWallTimeToUtc(
    isOvernightHm(from.start, from.end) ? addDaysYmd(onYmd, 1) : onYmd,
    from.end,
    from.timezone,
  );
  return {
    timezone: toTimezone,
    start: utcToZonedWall(startUtc, toTimezone).hm,
    end: utcToZonedWall(endUtc, toTimezone).hm,
  };
}
function validateSameMoment(main, others, onYmd) {
  const mainStart = zonedWallTimeToUtc(onYmd, main.start, main.timezone);
  for (const o of others) {
    const expected = convertOfficeTime(main, o.timezone, onYmd);
    const oStart = zonedWallTimeToUtc(onYmd, o.start, o.timezone);
    if (Math.abs(oStart - mainStart) > 60_000) {
      return {
        ok: false,
        message: `${main.start} ${main.timezone} is ${expected.start} in ${o.timezone} today, not ${o.start}.`,
        expected,
      };
    }
  }
  return { ok: true };
}
function formatShiftZonesLine(main, displayZones, onYmd) {
  const startUtc = zonedWallTimeToUtc(onYmd, main.start, main.timezone);
  const endUtc = zonedWallTimeToUtc(
    isOvernightHm(main.start, main.end) ? addDaysYmd(onYmd, 1) : onYmd,
    main.end,
    main.timezone,
  );
  const zones = [main.timezone, ...displayZones.map((z) => z.timezone)];
  return zones
    .map((tz) => {
      const s = utcToZonedWall(startUtc, tz);
      const e = utcToZonedWall(endUtc, tz);
      const tag = (d) => (d > 0 ? ` (+${d} day)` : d < 0 ? ` (${d} day)` : '');
      const city = tz.split('/').pop().replace(/_/g, ' ');
      return `${s.hm}${tag(s.dayOffsetFrom(onYmd))} – ${e.hm}${tag(e.dayOffsetFrom(onYmd))} ${city}`;
    })
    .join(' · ');
}
function nextDisplayChangeDate(main, otherTz, fromYmd, horizonDays = 400) {
  const base = convertOfficeTime(main, otherTz, fromYmd);
  for (let i = 1; i <= horizonDays; i++) {
    const ymd = addDaysYmd(fromYmd, i);
    const next = convertOfficeTime(main, otherTz, ymd);
    if (next.start !== base.start || next.end !== base.end) {
      return { onYmd: ymd, newStart: next.start, newEnd: next.end };
    }
  }
  return null;
}

let failures = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`PASS\t${name}`);
  else {
    console.log(`FAIL\t${name}${detail ? ' — ' + detail : ''}`);
    failures += 1;
  }
}

const ymdOct = '2026-10-06';
const ymdNov = '2026-11-02';
const ymdRomeBefore = '2026-10-24';
const ymdRomeAfter = '2026-10-26';

for (const tz of ['Asia/Karachi', 'Asia/Dubai', 'Asia/Kuala_Lumpur', 'Europe/Rome', 'America/Toronto']) {
  const line = formatShiftZonesLine({ timezone: tz, start: '09:00', end: '18:00' }, [], ymdOct);
  assert(`R81 one-zone ${tz}`, /09:00/.test(line), line);
}

{
  const main = { timezone: 'America/Chicago', start: '08:00', end: '17:00' };
  const oct = convertOfficeTime(main, 'Asia/Karachi', ymdOct);
  const nov = convertOfficeTime(main, 'Asia/Karachi', ymdNov);
  assert('R81 Chicago→Karachi Oct converts', Boolean(oct.start), JSON.stringify(oct));
  assert(
    'R81 Chicago→Karachi changes after US DST (Nov)',
    oct.start !== nov.start || oct.end !== nov.end,
    `oct=${oct.start}-${oct.end} nov=${nov.start}-${nov.end}`,
  );
}

{
  const k = convertOfficeTime({ timezone: 'America/Toronto', start: '09:00', end: '17:00' }, 'Asia/Karachi', ymdOct);
  assert('R81 Toronto→Karachi', k.start.length === 5, JSON.stringify(k));
}

{
  const main = { timezone: 'Europe/Rome', start: '09:00', end: '18:00' };
  const before = convertOfficeTime(main, 'Asia/Dubai', ymdRomeBefore);
  const after = convertOfficeTime(main, 'Asia/Dubai', ymdRomeAfter);
  assert(
    'R81 Rome→Dubai changes across EU DST',
    before.start !== after.start || before.end !== after.end,
    `before=${before.start} after=${after.start}`,
  );
  const ch = nextDisplayChangeDate(main, 'Asia/Dubai', ymdRomeBefore, 10);
  assert('R81 nextDisplayChangeDate finds EU change without hardcoding', Boolean(ch), JSON.stringify(ch));
}

{
  const lon = convertOfficeTime({ timezone: 'Asia/Kuala_Lumpur', start: '09:00', end: '18:00' }, 'Europe/London', ymdOct);
  assert('R81 KL→London', lon.start.length === 5, JSON.stringify(lon));
}

{
  const ny = convertOfficeTime({ timezone: 'Asia/Kolkata', start: '09:30', end: '18:30' }, 'America/New_York', ymdOct);
  assert('R81 Kolkata(+5:30)→New_York', ny.start.length === 5, JSON.stringify(ny));
}

{
  const du = convertOfficeTime({ timezone: 'America/St_Johns', start: '09:00', end: '17:00' }, 'Asia/Dubai', ymdOct);
  assert('R81 St_Johns(−3:30)→Dubai', du.start.length === 5, JSON.stringify(du));
}

{
  const line = formatShiftZonesLine(
    { timezone: 'America/Chicago', start: '08:00', end: '17:00' },
    [{ timezone: 'Asia/Karachi' }, { timezone: 'Asia/Dubai' }],
    ymdOct,
  );
  assert('R81 three-zone display', line.includes('·') && /Chicago|Karachi|Dubai/.test(line), line);
}

{
  const main = { timezone: 'America/Toronto', start: '08:00', end: '17:00' };
  const expected = convertOfficeTime(main, 'Asia/Karachi', ymdOct);
  const bad = { timezone: 'Asia/Karachi', start: expected.start === '20:00' ? '21:00' : '00:00', end: expected.end };
  const v = validateSameMoment(main, [bad], ymdOct);
  assert('R81 mismatched entry rejected', v.ok === false, JSON.stringify(v));
  assert('R81 mismatch message includes conversion', /is .+ in/i.test(v.message), v.message);
}

{
  const chicago = { timezone: 'America/Chicago', start: '08:00', end: '17:00' };
  const asKarachi = convertOfficeTime(chicago, 'Asia/Karachi', ymdOct);
  const back = convertOfficeTime(
    { timezone: 'Asia/Karachi', start: asKarachi.start, end: asKarachi.end },
    'America/Chicago',
    ymdOct,
  );
  assert('R81 switching main preserves UTC moment', back.start === '08:00' && back.end === '17:00', JSON.stringify(back));
}

{
  const main = { timezone: 'Asia/Karachi', start: '18:00', end: '03:00' };
  assert('R81 overnight detected', isOvernightHm(main.start, main.end));
  const line = formatShiftZonesLine(main, [{ timezone: 'Asia/Dubai' }], ymdOct);
  assert('R81 overnight shows +1 day label', /\+1 day/i.test(line), line);
}

{
  const utc = zonedWallTimeToUtc('2026-03-08', '02:30', 'America/Chicago');
  const wall = utcToZonedWall(utc, 'America/Chicago');
  assert('R81 spring-forward snaps out of gap', wall.hm !== '02:30' && Number.isFinite(utc.getTime()), `hm=${wall.hm}`);
}

{
  const utc = zonedWallTimeToUtc('2026-11-01', '01:30', 'America/Chicago');
  assert('R81 fall-back returns finite instant', Number.isFinite(utc.getTime()), utc.toISOString());
}

{
  const ch = nextDisplayChangeDate({ timezone: 'Europe/Rome', start: '10:00', end: '19:00' }, 'Asia/Dubai', '2026-10-01', 60);
  assert('R81 DST change date auto-calculated', Boolean(ch?.onYmd), JSON.stringify(ch));
}

{
  const same = convertOfficeTime({ timezone: 'Asia/Dubai', start: '09:00', end: '18:00' }, 'Asia/Dubai', ymdOct);
  assert('R81 migrate identity same zone', same.start === '09:00' && same.end === '18:00');
}

const total = 5 + 2 + 1 + 2 + 1 + 1 + 1 + 1 + 2 + 1 + 2 + 1 + 1 + 1 + 1;
console.log(`\n${total - failures} PASS / ${failures} FAIL / ${total} total`);
process.exit(failures ? 1 : 0);
