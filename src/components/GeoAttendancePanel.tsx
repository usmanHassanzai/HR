import { useCallback, useEffect, useState } from 'react';
import { MapPin, Loader2, Radio, History, LogIn, LogOut } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  GEO_CLOCK_EVENT,
  GEO_PING_EVENT,
  GeoPingEventDetail,
  formatClockTime,
  geoActionLabel,
  OfficeLocation,
  distanceMeters,
  GeoPingResult,
  AttendanceVisit,
  bootstrapAttendanceLocation,
  effectiveGeofenceRadius,
  localYmd,
  attendanceActionMessage,
  isAttendanceSuccessAction,
  submitGeoClockEvent,
} from '../utils/geoAttendance';
import { LocationWindow, formatShiftTimeRange, hasAssignedShiftEnded, isWithinShiftExitWindow, locationWindowToMyShift, shouldCaptureLocationNow } from '../utils/shiftHelpers';

interface GeoAttendancePanelProps {
  onClockUpdate?: () => void;
}

interface WorkSite {
  site_id: string;
  site_name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

function rpcErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: string }).message);
  }
  if (err instanceof Error) return err.message;
  return 'Location check failed';
}

function formatClosedDuration(mins: number): string {
  if (mins < 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Live elapsed as mm:ss (or h:mm:ss). */
function formatLiveDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

function formatDurationMs(ms: number, live: boolean): string {
  if (live) return formatLiveDuration(ms);
  return formatClosedDuration(Math.round(ms / 60000));
}

/** Valid closed out, or null when open / inverted (out before in). */
function visitOutAt(v: AttendanceVisit): string | null {
  if (!v.clock_out_at || !v.clock_in_at) return null;
  if (Date.parse(v.clock_out_at) < Date.parse(v.clock_in_at)) return null;
  return v.clock_out_at;
}

/** Open visit: null out, or inverted out-before-in (stale close race). */
function isVisitOpen(v: AttendanceVisit): boolean {
  return Boolean(v.clock_in_at && !visitOutAt(v));
}

function visitDurationMs(v: AttendanceVisit, nowMs: number): number {
  const out = visitOutAt(v);
  if (out) {
    if (v.work_minutes != null && v.work_minutes >= 0) return v.work_minutes * 60000;
    return Math.max(0, Date.parse(out) - Date.parse(v.clock_in_at));
  }
  if (v.clock_in_at && isVisitOpen(v)) {
    return Math.max(0, nowMs - Date.parse(v.clock_in_at));
  }
  return 0;
}

function headerTimesFromVisits(
  visits: AttendanceVisit[],
  recordIn: string | null,
  recordOut: string | null,
): { clockIn: string | null; clockOut: string | null } {
  if (visits.length === 0) {
    if (recordIn && recordOut && Date.parse(recordOut) < Date.parse(recordIn)) {
      return { clockIn: recordIn, clockOut: null };
    }
    return { clockIn: recordIn, clockOut: recordOut };
  }
  const sorted = [...visits].sort(
    (a, b) => Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at) || a.visit_number - b.visit_number,
  );
  const clockIn = sorted[0]?.clock_in_at || recordIn;
  // Null out or inverted out-before-in keeps the shift open (CLOCK OUT blank).
  if (sorted.some(isVisitOpen)) {
    return { clockIn, clockOut: null };
  }
  let latestOut: string | null = null;
  for (const v of sorted) {
    const out = visitOutAt(v);
    if (out && (!latestOut || Date.parse(out) > Date.parse(latestOut))) latestOut = out;
  }
  // Prefer latest valid visit out over a stale parent-record out (e.g. R69 race).
  return { clockIn, clockOut: latestOut };
}

function timeSlice(t: string | null | undefined): string {
  return (t || '').toString().slice(0, 5);
}

export default function GeoAttendancePanel({ onClockUpdate }: GeoAttendancePanelProps) {
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [workSite, setWorkSite] = useState<WorkSite | null>(null);
  const [clockIn, setClockIn] = useState<string | null>(null);
  const [clockOut, setClockOut] = useState<string | null>(null);
  const [source, setSource] = useState<string>('manual');
  const [visits, setVisits] = useState<AttendanceVisit[]>([]);
  const [lastResult, setLastResult] = useState<GeoPingResult | null>(null);
  const [checking, setChecking] = useState<'clock_in' | 'clock_out' | null>(null);
  const [nearby, setNearby] = useState<{ name: string; dist: number; inside: boolean; radius: number } | null>(null);
  const [error, setError] = useState('');
  const [windowInfo, setWindowInfo] = useState<LocationWindow | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadToday = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: shiftDateRaw } = await supabase.rpc('get_my_shift_attendance_date');
    const shiftDate = typeof shiftDateRaw === 'string' ? shiftDateRaw.slice(0, 10) : localYmd();

    const [{ data }, { data: visitRows }, { data: winRows }] = await Promise.all([
      supabase
        .from('attendance_records')
        .select('clock_in_at, clock_out_at, attendance_source')
        .eq('user_id', user.id)
        .eq('attendance_date', shiftDate)
        .maybeSingle(),
      supabase.rpc('get_my_attendance_visits', { p_date: shiftDate }),
      supabase.rpc('get_my_location_window'),
    ]);
    const visitList = (visitRows as AttendanceVisit[]) || [];
    setVisits(visitList);
    if (data) {
      const derived = headerTimesFromVisits(visitList, data.clock_in_at, data.clock_out_at);
      setClockIn(derived.clockIn);
      setClockOut(derived.clockOut);
      setSource(data.attendance_source || 'manual');
    } else if (visitList.length > 0) {
      const derived = headerTimesFromVisits(visitList, null, null);
      setClockIn(derived.clockIn);
      setClockOut(derived.clockOut);
    } else {
      setClockIn(null);
      setClockOut(null);
    }
    const win = (winRows as LocationWindow[] | null)?.[0];
    if (win) {
      setWindowInfo({
        ...win,
        start_time: timeSlice(win.start_time),
        end_time: timeSlice(win.end_time),
      });
    }
  }, []);

  const loadSites = useCallback(async () => {
    const [{ data: officesData }, { data: siteData, error: siteErr }] = await Promise.all([
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_my_work_site'),
    ]);
    setOffices((officesData || []) as OfficeLocation[]);
    if (siteErr) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: legacy } = await supabase.rpc('get_work_site_for_user', { p_user_id: user.id });
        const row = (legacy as WorkSite[] | null)?.[0];
        setWorkSite(row?.site_id ? row : null);
      }
    } else {
      const row = (siteData as WorkSite[] | null)?.[0];
      setWorkSite(row?.site_id ? row : null);
    }
  }, []);

  useEffect(() => {
    void loadToday();
    void loadSites();
    void bootstrapAttendanceLocation();
  }, [loadToday, loadSites]);

  const openVisit = visits.some(isVisitOpen);
  const openShiftPreview = Boolean(openVisit || (clockIn && !clockOut));

  // Tick every second while checked in so session + shift totals count live.
  useEffect(() => {
    if (!openShiftPreview) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [openShiftPreview]);

  const updateNearby = useCallback((lat: number, lng: number, accuracy?: number | null) => {
    if (workSite) {
      const dist = distanceMeters(lat, lng, workSite.latitude, workSite.longitude);
      const radius = effectiveGeofenceRadius(workSite.radius_meters, accuracy);
      setNearby({
        name: workSite.site_name,
        dist: Math.round(dist),
        inside: dist <= radius,
        radius: Math.round(radius),
      });
      return;
    }
    const active = offices.filter((o) => o.active);
    if (active.length === 0) {
      setNearby(null);
      return;
    }
    let best = active[0];
    let bestDist = distanceMeters(lat, lng, best.latitude, best.longitude);
    for (const o of active.slice(1)) {
      const d = distanceMeters(lat, lng, o.latitude, o.longitude);
      if (d < bestDist) { best = o; bestDist = d; }
    }
    const radius = effectiveGeofenceRadius(best.radius_meters, accuracy);
    setNearby({
      name: best.name,
      dist: Math.round(bestDist),
      inside: bestDist <= radius,
      radius: Math.round(radius),
    });
  }, [offices, workSite]);

  useEffect(() => {
    const onPing = (e: Event) => {
      const detail = (e as CustomEvent<GeoPingEventDetail>).detail;
      if (!detail?.result) return;
      setLastResult(detail.result);
      if (detail.latitude != null && detail.longitude != null) {
        updateNearby(detail.latitude, detail.longitude, detail.accuracy);
      }
      void loadToday();
      if (
        detail.result.action === 'clock_in' ||
        detail.result.action === 'clock_out' ||
        detail.result.action === 'clock_out_shift_end'
      ) {
        onClockUpdate?.();
      }
    };
    const onClock = () => {
      void loadToday();
      onClockUpdate?.();
    };
    window.addEventListener(GEO_PING_EVENT, onPing);
    window.addEventListener(GEO_CLOCK_EVENT, onClock);
    return () => {
      window.removeEventListener(GEO_PING_EVENT, onPing);
      window.removeEventListener(GEO_CLOCK_EVENT, onClock);
    };
  }, [loadToday, onClockUpdate, updateNearby]);

  const runClock = async (intent: 'clock_in' | 'clock_out') => {
    if (intent === 'clock_in' && !shouldCaptureLocationNow(windowInfo)) {
      setError('You can clock in from 1 hour before your shift starts.');
      return;
    }
    if (
      intent === 'clock_out'
      && windowInfo
      && !openShift
      && !isWithinShiftExitWindow(locationWindowToMyShift(windowInfo))
    ) {
      setError('Checkout is allowed until 1 hour after the shift ends.');
      return;
    }
    setChecking(intent);
    setError('');
    try {
      const result = await submitGeoClockEvent(intent);
      setLastResult(result);
      if (!isAttendanceSuccessAction(result.action)) {
        if (result.action === 'outside_office' && !workSite && offices.filter((o) => o.active).length === 0) {
          setError('No work location assigned. Ask admin: Office & Attendance → Assign people.');
        } else if (result.action === 'no_open_visit') {
          setError('Clock in first, then clock out.');
        } else {
          setError(attendanceActionMessage(result.action || result.reason));
        }
      } else {
        setError('');
      }
      await loadToday();
      if (isAttendanceSuccessAction(result.action)) {
        onClockUpdate?.();
      }
    } catch (e: unknown) {
      setError(rpcErrorMessage(e));
    } finally {
      setChecking(null);
    }
  };

  const hasAnySite = !!workSite || offices.some((o) => o.active);
  const siteRadius = workSite?.radius_meters ?? offices.find((o) => o.active)?.radius_meters ?? 150;
  const inWindow = shouldCaptureLocationNow(windowInfo);
  const shiftEnded = windowInfo ? hasAssignedShiftEnded(locationWindowToMyShift(windowInfo)) : false;
  const inExitWindow = windowInfo ? isWithinShiftExitWindow(locationWindowToMyShift(windowInfo)) : false;
  const openShift = Boolean((clockIn && !clockOut) || openVisit);
  const openVisitRow = [...visits].filter(isVisitOpen).sort(
    (a, b) => Date.parse(b.clock_in_at) - Date.parse(a.clock_in_at),
  )[0];
  const sessionStartAt = openVisitRow?.clock_in_at || (openShift ? clockIn : null);
  const sessionMs = sessionStartAt ? Math.max(0, nowMs - Date.parse(sessionStartAt)) : 0;
  const closedVisitsMs = visits.reduce((s, v) => {
    if (isVisitOpen(v)) return s;
    return s + visitDurationMs(v, nowMs);
  }, 0);
  // No visit rows yet (legacy / race): count from header clock-in while open.
  const fallbackOpenMs = visits.length === 0 && openShift && clockIn
    ? Math.max(0, nowMs - Date.parse(clockIn))
    : 0;
  const totalShiftMs = closedVisitsMs
    + (openVisitRow ? visitDurationMs(openVisitRow, nowMs) : 0)
    + fallbackOpenMs;

  return (
    <div className="attendance-card geo-attendance-panel">
      <h3 className="attendance-card__title">
        <MapPin size={18} /> Shift location
        <span className="badge badge-on-track geo-attendance-panel__badge">Entry + exit</span>
      </h3>
      <p className="attendance-card__subtitle">
        Check-in needs both the office Wi-Fi and a GPS reading inside the office radius. Mobile data, home Wi-Fi, or a copied Wi-Fi name does not check you in. GPS inside the office without the office Wi-Fi does not check you in. Work-from-home days marked by Admin or HR are exempt.
        Manual Clock in / Clock out stay available as an override. Multiple visits in one shift are saved and minutes are added (time away is not counted).
        {windowInfo
          ? ` Hours: ${formatShiftTimeRange(windowInfo.start_time, windowInfo.end_time, windowInfo.crosses_midnight)}${windowInfo.source === 'shift' && windowInfo.shift_name ? ` · ${windowInfo.shift_name}` : ' · company window'}.`
          : ' Hours follow your assigned shift, or the company window.'}
      </p>

      {workSite && (
        <p className="geo-hint geo-hint--spaced">
          <Radio size={14} /> Your team site: <strong>{workSite.site_name}</strong>
          {' '}({workSite.radius_meters}m zone)
        </p>
      )}

      {!inWindow && !openShift && windowInfo && (
        <p className="geo-hint geo-hint--spaced">
          Clock-in opens 1 hour before{' '}
          {formatShiftTimeRange(windowInfo.start_time, windowInfo.end_time, windowInfo.crosses_midnight)}.
        </p>
      )}
      {openShift && (
        <p className="attendance-present-banner attendance-present-banner--spaced" role="status">
          You are still present in the office and working. Auto check-out runs when a GPS reading is outside the office radius; use Clock out only if you need to leave early.
        </p>
      )}
      {!openShift && clockIn && clockOut && inWindow && !shiftEnded && (
        <p className="attendance-present-banner attendance-present-banner--out attendance-present-banner--spaced" role="status">
          Checked out. Auto check-in runs if you return during the shift; Clock in is only needed as a backup.
        </p>
      )}
      {!openShift && clockIn && clockOut && shiftEnded && (
        <p className="attendance-present-banner attendance-present-banner--out attendance-present-banner--spaced" role="status">
          Checked out. Shift has ended — auto check-in will not run. Manual Clock in is blocked after shift end.
        </p>
      )}
      {openShift && !inWindow && inExitWindow && (
        <p className="geo-hint geo-hint--spaced">
          Shift has ended. You still have 1 hour to clock out — that extra time is counted.
        </p>
      )}

      <div className={`geo-clock-stats${openShift || totalShiftMs > 0 ? ' geo-clock-stats--with-duration' : ''}`}>
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Clock in</span>
          <strong>{formatClockTime(clockIn)}</strong>
          {source === 'geo' && clockIn && <span className="geo-clock-stat__tag">GPS</span>}
        </div>
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Clock out</span>
          <strong>{openShift ? '—' : formatClockTime(clockOut)}</strong>
        </div>
        {(openShift || totalShiftMs > 0) && (
          <div className="geo-clock-stat geo-clock-stat--duration">
            <span className="geo-clock-stat__label">{openShift ? 'On site now' : 'Shift total'}</span>
            <strong className={openShift ? 'geo-clock-stat__live' : undefined}>
              {formatDurationMs(openShift ? sessionMs : totalShiftMs, openShift)}
            </strong>
            {openShift && totalShiftMs > sessionMs && (
              <span className="geo-clock-stat__tag">
                {formatDurationMs(totalShiftMs, true)} shift
              </span>
            )}
          </div>
        )}
      </div>

      {nearby && (
        <p className={`geo-nearby ${nearby.inside ? '' : 'geo-nearby--out'}`}>
          <Radio size={14} />
          {nearby.inside
            ? `Inside ${nearby.name} · ${nearby.dist}m from center. Check-in also needs the office Wi-Fi.`
            : `Outside ${nearby.name} · ${nearby.dist}m away. Not inside the office radius.`}
        </p>
      )}

      {lastResult && (
        <p className={`geo-last-action ${lastResult.action === 'outside_office' || lastResult.action === 'outside_radius' || lastResult.action === 'need_fresh_location' || lastResult.action === 'not_on_office_network' || lastResult.action === 'not_on_office_wifi' || lastResult.action === 'shift_not_started' ? 'geo-last-action--warn' : ''}`}>
          {lastResult.action === 'outside_office' ? (
            <>
              Still outside the office zone
              {lastResult.office_name ? ` · ${lastResult.office_name}` : ''}
              {lastResult.distance_meters != null ? ` · ${Math.round(lastResult.distance_meters)}m away` : ''}
              {lastResult.effective_radius_meters != null
                ? ` · zone ${lastResult.effective_radius_meters}m`
                : ` · zone ${siteRadius}m`}
            </>
          ) : (
            <>
              Last action: {geoActionLabel(lastResult.action)}
              {lastResult.office_name ? ` · ${lastResult.office_name}` : ''}
              {lastResult.distance_meters != null ? ` · ${Math.round(lastResult.distance_meters)}m` : ''}
            </>
          )}
        </p>
      )}

      {visits.length > 0 && (
        <div className="geo-visit-history">
          <div className="geo-visit-history__head">
            <History size={15} />
            <strong>This shift&apos;s visits</strong>
            <span>
              {visits.length} session{visits.length === 1 ? '' : 's'}
              {' · '}
              {formatDurationMs(totalShiftMs, openShift)} total
            </span>
          </div>
          <ul className="geo-visit-history__list">
            {visits.map((v) => {
              const out = visitOutAt(v);
              const open = isVisitOpen(v);
              const inverted = Boolean(v.clock_out_at && !out);
              return (
              <li key={v.id} className={`geo-visit-history__item${open ? ' geo-visit-history__item--open' : ''}`}>
                <span className="geo-visit-history__num">#{v.visit_number}</span>
                <div className="geo-visit-history__times">
                  <span><LogIn size={12} /> In {formatClockTime(v.clock_in_at)}</span>
                  <span>
                    <LogOut size={12} />
                    {out
                      ? ` Out ${formatClockTime(out)}`
                      : inverted
                        ? ' Out —'
                        : ' On site now'}
                  </span>
                </div>
                <span className="geo-visit-history__dur">
                  {formatDurationMs(visitDurationMs(v, nowMs), open)}
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && <p className="geo-error">{error}</p>}

      {!hasAnySite && !lastResult && (
        <div className="geo-empty-assign">
          <MapPin size={28} strokeWidth={1.25} />
          <p>
            No work location assigned yet. Ask your admin to assign an office under{' '}
            <strong>Office &amp; Attendance → Assign people</strong>.
          </p>
        </div>
      )}

      <div className="geo-attendance-panel__actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={Boolean(checking) || !inWindow || openShift}
          onClick={() => void runClock('clock_in')}
        >
          {checking === 'clock_in' ? <Loader2 size={14} className="spin-icon" /> : <LogIn size={14} />}
          Clock in
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={Boolean(checking) || !openShift}
          onClick={() => void runClock('clock_out')}
        >
          {checking === 'clock_out' ? <Loader2 size={14} className="spin-icon" /> : <LogOut size={14} />}
          Clock out
        </button>
      </div>
    </div>
  );
}
