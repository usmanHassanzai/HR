import { useCallback, useEffect, useState } from 'react';
import { MapPin, Loader2, Radio, Navigation } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  formatClockTime,
  geoActionLabel,
  isGeoAttendanceEnabled,
  OfficeLocation,
  requestCurrentPosition,
  setGeoAttendanceEnabled,
  distanceMeters,
  GeoPingResult,
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

export default function GeoAttendancePanel({ onClockUpdate }: GeoAttendancePanelProps) {
  const [enabled, setEnabled] = useState(() => isGeoAttendanceEnabled());
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [workSite, setWorkSite] = useState<WorkSite | null>(null);
  const [clockIn, setClockIn] = useState<string | null>(null);
  const [clockOut, setClockOut] = useState<string | null>(null);
  const [source, setSource] = useState<string>('manual');
  const [lastResult, setLastResult] = useState<GeoPingResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [nearby, setNearby] = useState<{ name: string; dist: number; inside: boolean } | null>(null);
  const [error, setError] = useState('');

  const loadToday = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('attendance_records')
      .select('clock_in_at, clock_out_at, attendance_source')
      .eq('user_id', user.id)
      .eq('attendance_date', today)
      .maybeSingle();
    if (data) {
      setClockIn(data.clock_in_at);
      setClockOut(data.clock_out_at);
      setSource(data.attendance_source || 'manual');
    } else {
      setClockIn(null);
      setClockOut(null);
    }
  }, []);

  const loadSites = useCallback(async () => {
    const [{ data: officesData }, { data: siteData, error: siteErr }] = await Promise.all([
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_my_work_site'),
    ]);
    setOffices((officesData || []) as OfficeLocation[]);
    if (siteErr) {
      // Fallback if migration not applied yet
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
    loadToday();
    loadSites();
  }, [loadToday, loadSites]);

  const updateNearby = (lat: number, lng: number) => {
    if (workSite) {
      const dist = distanceMeters(lat, lng, workSite.latitude, workSite.longitude);
      setNearby({
        name: workSite.site_name,
        dist: Math.round(dist),
        inside: dist <= workSite.radius_meters,
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
    setNearby({ name: best.name, dist: Math.round(bestDist), inside: bestDist <= best.radius_meters });
  };

  const checkNow = async () => {
    setChecking(true);
    setError('');
    try {
      const pos = await requestCurrentPosition();
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      updateNearby(lat, lng);

      const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
        p_latitude: lat,
        p_longitude: lng,
        p_accuracy: pos.coords.accuracy ?? null,
      });
      if (rpcError) throw rpcError;
      const result = data as GeoPingResult;
      setLastResult(result);
      setError('');

      if (result.action === 'outside_office') {
        if (!workSite && offices.filter((o) => o.active).length === 0) {
          setError('No work location assigned. Ask admin: Office GPS → Step 2 → Assign to your manager.');
        } else if (result.distance_meters != null && result.office_name) {
          setError('');
        }
      }

      if (result.action === 'clock_in' || result.action === 'clock_out' || result.action === 'clock_out_shift_end' ||
          result.action === 'already_clocked_in' || result.action === 'already_clocked_out') {
        await loadToday();
        onClockUpdate?.();
      }
    } catch (e: unknown) {
      setError(rpcErrorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const toggleEnabled = (on: boolean) => {
    setGeoAttendanceEnabled(on);
    setEnabled(on);
    if (on) checkNow();
  };

  const hasAnySite = !!workSite || offices.some((o) => o.active);

  return (
    <div className="attendance-card geo-attendance-panel">
      <h3 className="attendance-card__title">
        <MapPin size={18} /> Auto location attendance
        {enabled && <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>Active</span>}
      </h3>
      <p className="attendance-card__subtitle">
        When you enter your team&apos;s GPS zone during your shift, attendance starts automatically with exact clock-in time.
        You are clocked out when you leave the zone or when your shift ends. On mobile, enable location and allow background access for best results.
      </p>

      {workSite && (
        <p className="geo-hint" style={{ marginBottom: '0.75rem' }}>
          <Radio size={14} /> Your team site: <strong>{workSite.site_name}</strong> ({workSite.radius_meters}m radius)
        </p>
      )}

      <label className="geo-toggle-row">
        <input type="checkbox" checked={enabled} onChange={(e) => toggleEnabled(e.target.checked)} />
        <span>Enable automatic office check-in / check-out</span>
      </label>

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
        <p className="geo-nearby">
          <Radio size={14} />
          {nearby.inside
            ? `Inside ${nearby.name} (${nearby.dist}m from center)`
            : `Outside office — nearest: ${nearby.name} (${nearby.dist}m away)`}
        </p>
      )}

      {lastResult && (
        <p className={`geo-last-action ${lastResult.action === 'outside_office' ? 'geo-last-action--warn' : ''}`}>
          {lastResult.action === 'outside_office' ? (
            <>
              Outside work site
              {lastResult.office_name ? ` · nearest zone: ${lastResult.office_name}` : ''}
              {lastResult.distance_meters != null ? ` · ${Math.round(lastResult.distance_meters)}m away` : ''}
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

      {error && <p className="geo-error">{error}</p>}

      {!hasAnySite && !lastResult && (
        <p className="geo-hint">No work location assigned yet. Ask admin to assign an office to your manager under Office GPS.</p>
      )}

      <button type="button" className="btn btn-secondary btn-sm" disabled={checking || !enabled} onClick={checkNow}>
        {checking ? <Loader2 size={14} className="spin-icon" /> : <Navigation size={14} />}
        Check location now
      </button>
    </div>
  );
}
