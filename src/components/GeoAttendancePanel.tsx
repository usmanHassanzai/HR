import { useCallback, useEffect, useState } from 'react';
import { MapPin, Loader2, Radio, Navigation, History, LogIn, LogOut } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  formatClockTime,
  geoActionLabel,
  OfficeLocation,
  requestCurrentPosition,
  distanceMeters,
  GeoPingResult,
  AttendanceVisit,
  bootstrapAttendanceLocation,
  effectiveGeofenceRadius,
} from '../utils/geoAttendance';

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

export default function GeoAttendancePanel({ onClockUpdate }: GeoAttendancePanelProps) {
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [workSite, setWorkSite] = useState<WorkSite | null>(null);
  const [clockIn, setClockIn] = useState<string | null>(null);
  const [clockOut, setClockOut] = useState<string | null>(null);
  const [source, setSource] = useState<string>('manual');
  const [visits, setVisits] = useState<AttendanceVisit[]>([]);
  const [lastResult, setLastResult] = useState<GeoPingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [nearby, setNearby] = useState<{ name: string; dist: number; inside: boolean; radius: number } | null>(null);
  const [error, setError] = useState('');
  const [lastAccuracy, setLastAccuracy] = useState<number | null>(null);

  const loadToday = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const [{ data }, { data: visitRows }] = await Promise.all([
      supabase
        .from('attendance_records')
        .select('clock_in_at, clock_out_at, attendance_source')
        .eq('user_id', user.id)
        .eq('attendance_date', today)
        .maybeSingle(),
      supabase.rpc('get_my_attendance_visits', { p_date: today }),
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

  useEffect(() => {
    const onClock = () => {
      void loadToday();
      onClockUpdate?.();
    };
    window.addEventListener('scorr-geo-clock', onClock);
    return () => {
      window.removeEventListener('scorr-geo-clock', onClock);
    };
  }, [loadToday, onClockUpdate]);

  const updateNearby = (lat: number, lng: number, accuracy?: number | null) => {
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
  };

  const checkNow = async () => {
    setChecking(true);
    setError('');
    try {
      const pos = await requestCurrentPosition();
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy ?? null;
      updateNearby(lat, lng, accuracy);

      const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
        p_latitude: lat,
        p_longitude: lng,
        p_accuracy: accuracy,
      });
      if (rpcError) throw rpcError;
      const result = data as GeoPingResult;
      setLastResult(result);
      setError('');

      if (result.action === 'outside_office') {
        if (!workSite && offices.filter((o) => o.active).length === 0) {
          setError('No work location assigned. Ask admin: Office GPS → Assign people.');
        }
      }

      if (
        result.action === 'clock_in' ||
        result.action === 'clock_out' ||
        result.action === 'clock_out_shift_end' ||
        result.action === 'already_clocked_in' ||
        result.action === 'already_clocked_out'
      ) {
        await loadToday();
        onClockUpdate?.();
      }
    } catch (e: unknown) {
      setError(rpcErrorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const hasAnySite = !!workSite || offices.some((o) => o.active);
  const siteRadius = workSite?.radius_meters ?? offices.find((o) => o.active)?.radius_meters ?? 150;

  return (
    <div className="attendance-card geo-attendance-panel">
      <h3 className="attendance-card__title">
        <MapPin size={18} /> Auto location attendance
        <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>Always on</span>
      </h3>
      <p className="attendance-card__subtitle">
        Enter the office zone to clock in; leave to clock out. Each visit during your shift is saved in today&apos;s
        history until the shift ends. GPS accuracy is included so the same office is not marked as far away by mistake.
      </p>

      {workSite && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          <Radio size={14} /> Your team site: <strong>{workSite.site_name}</strong>
          {' '}({workSite.radius_meters}m zone
          {lastAccuracy != null ? ` + ~${Math.round(lastAccuracy)}m GPS buffer` : ''})
        </p>
      )}

      <div className="geo-clock-stats">
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">First clock in</span>
          <strong>{formatClockTime(clockIn)}</strong>
          {source === 'geo' && clockIn && <span className="geo-clock-stat__tag">GPS</span>}
        </div>
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Last clock out</span>
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
        <p className={`geo-last-action ${lastResult.action === 'outside_office' ? 'geo-last-action--warn' : ''}`}>
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
              Last sync: {geoActionLabel(lastResult.action)}
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
            <strong>Today&apos;s visits</strong>
            <span>{visits.length} session{visits.length === 1 ? '' : 's'}</span>
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
                <span className="geo-visit-history__dur">{formatDuration(v.work_minutes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="geo-error">{error}</p>}

      {!hasAnySite && !lastResult && (
        <p className="geo-hint">No work location assigned yet. Ask admin to assign an office under Office GPS → Assign people.</p>
      )}

      <button type="button" className="btn btn-secondary btn-sm" disabled={checking} onClick={() => void checkNow()}>
        {checking ? <Loader2 size={14} className="spin-icon" /> : <Navigation size={14} />}
        Check location now
      </button>
    </div>
  );
}
