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
  submitGeoClockEvent,
} from '../utils/geoAttendance';
import { LocationWindow, formatShiftTimeRange, isWithinShiftExitWindow, locationWindowToMyShift, shouldCaptureLocationNow } from '../utils/shiftHelpers';

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

function formatDuration(mins: number | null | undefined): string {
  if (mins == null || mins < 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function visitMinutes(v: AttendanceVisit): number {
  if (v.work_minutes != null && v.work_minutes >= 0 && v.clock_out_at) return v.work_minutes;
  if (v.work_minutes != null && v.work_minutes > 0) return v.work_minutes;
  if (v.clock_in_at && v.clock_out_at) {
    return Math.max(0, Math.round((Date.parse(v.clock_out_at) - Date.parse(v.clock_in_at)) / 60000));
  }
  if (v.clock_in_at && !v.clock_out_at) {
    return Math.max(0, Math.round((Date.now() - Date.parse(v.clock_in_at)) / 60000));
  }
  return 0;
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
  const [lastAccuracy, setLastAccuracy] = useState<number | null>(null);
  const [windowInfo, setWindowInfo] = useState<LocationWindow | null>(null);

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
    if (data) {
      setClockIn(data.clock_in_at);
      setClockOut(data.clock_out_at);
      setSource(data.attendance_source || 'manual');
    } else {
      setClockIn(null);
      setClockOut(null);
    }
    setVisits((visitRows as AttendanceVisit[]) || []);
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

  const updateNearby = useCallback((lat: number, lng: number, accuracy?: number | null) => {
    setLastAccuracy(accuracy ?? null);
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
      if (result.action === 'outside_office') {
        if (!workSite && offices.filter((o) => o.active).length === 0) {
          setError('No work location assigned. Ask admin: Office GPS → Assign people.');
        } else if (intent === 'clock_in') {
          setError('You must be inside the office zone to clock in.');
        } else {
          setError('Clock in first, then clock out.');
        }
      }
      if (result.action === 'shift_not_started') {
        setError('You can clock in from 1 hour before your shift starts.');
      }
      await loadToday();
      if (
        result.action === 'clock_in' ||
        result.action === 'clock_out' ||
        result.action === 'clock_out_shift_end' ||
        result.action === 'already_clocked_in' ||
        result.action === 'already_clocked_out'
      ) {
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
  const inExitWindow = windowInfo ? isWithinShiftExitWindow(locationWindowToMyShift(windowInfo)) : false;
  const openShift = Boolean(clockIn && !clockOut);

  return (
    <div className="attendance-card geo-attendance-panel">
      <h3 className="attendance-card__title">
        <MapPin size={18} /> Shift location
        <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
          Entry + exit
        </span>
      </h3>
      <p className="attendance-card__subtitle">
        You can clock in and out more than once during the shift. Each visit is saved and the minutes are added together (time away is not counted).
        Clock in from 1 hour before start. You can clock out anytime while checked in — including mid-shift for urgent leave.
        {windowInfo
          ? ` Hours: ${formatShiftTimeRange(windowInfo.start_time, windowInfo.end_time, windowInfo.crosses_midnight)}${windowInfo.source === 'shift' && windowInfo.shift_name ? ` · ${windowInfo.shift_name}` : ' · company window'}.`
          : ' Hours follow your assigned shift, or the company window.'}
      </p>

      {workSite && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          <Radio size={14} /> Your team site: <strong>{workSite.site_name}</strong>
          {' '}({workSite.radius_meters}m zone
          {lastAccuracy != null ? ` + ~${Math.round(lastAccuracy)}m GPS buffer` : ''})
        </p>
      )}

      {!inWindow && !openShift && windowInfo && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          Clock-in opens 1 hour before{' '}
          {formatShiftTimeRange(windowInfo.start_time, windowInfo.end_time, windowInfo.crosses_midnight)}.
        </p>
      )}
      {openShift && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          You are checked in. Use <strong>Clock out</strong> when you leave — even mid-shift if you need urgent leave, then submit a request under Request leave.
        </p>
      )}
      {openShift && !inWindow && inExitWindow && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          Shift has ended. You still have 1 hour to clock out — that extra time is counted.
        </p>
      )}

      <div className="geo-clock-stats">
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Clock in</span>
          <strong>{formatClockTime(clockIn)}</strong>
          {source === 'geo' && clockIn && <span className="geo-clock-stat__tag">GPS</span>}
        </div>
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Clock out</span>
          <strong>{formatClockTime(clockOut)}</strong>
        </div>
      </div>

      {nearby && (
        <p className={`geo-nearby ${nearby.inside ? '' : 'geo-nearby--out'}`}>
          <Radio size={14} />
          {nearby.inside
            ? `Inside ${nearby.name} · ${nearby.dist}m from center (zone ~${nearby.radius}m)`
            : `Outside ${nearby.name} · ${nearby.dist}m away (need within ~${nearby.radius}m)`}
        </p>
      )}

      {lastResult && (
        <p className={`geo-last-action ${lastResult.action === 'outside_office' || lastResult.action === 'shift_not_started' ? 'geo-last-action--warn' : ''}`}>
          {lastResult.action === 'outside_office' ? (
            <>
              Still outside the office zone
              {lastResult.office_name ? ` · ${lastResult.office_name}` : ''}
              {lastResult.distance_meters != null ? ` · ${Math.round(lastResult.distance_meters)}m away` : ''}
              {lastResult.effective_radius_meters != null
                ? ` · allowed up to ~${lastResult.effective_radius_meters}m`
                : ` · zone ${siteRadius}m + GPS buffer`}
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
              {formatDuration(visits.reduce((s, v) => s + visitMinutes(v), 0))} total
            </span>
          </div>
          <ul className="geo-visit-history__list">
            {visits.map((v) => (
              <li key={v.id} className={`geo-visit-history__item${!v.clock_out_at ? ' geo-visit-history__item--open' : ''}`}>
                <span className="geo-visit-history__num">#{v.visit_number}</span>
                <div className="geo-visit-history__times">
                  <span><LogIn size={12} /> In {formatClockTime(v.clock_in_at)}</span>
                  <span>
                    <LogOut size={12} />
                    {v.clock_out_at ? ` Out ${formatClockTime(v.clock_out_at)}` : ' On site now'}
                  </span>
                </div>
                <span className="geo-visit-history__dur">{formatDuration(visitMinutes(v))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="geo-error">{error}</p>}

      {!hasAnySite && !lastResult && (
        <p className="geo-hint">No work location assigned yet. Ask admin to assign an office under Office GPS → Assign people.</p>
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
