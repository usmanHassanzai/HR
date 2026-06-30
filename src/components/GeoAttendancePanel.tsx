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

export default function GeoAttendancePanel({ onClockUpdate }: GeoAttendancePanelProps) {
  const [enabled, setEnabled] = useState(() => isGeoAttendanceEnabled());
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
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

  const loadOffices = useCallback(async () => {
    const { data } = await supabase.rpc('get_office_locations');
    setOffices((data || []) as OfficeLocation[]);
  }, []);

  useEffect(() => {
    loadToday();
    loadOffices();
  }, [loadToday, loadOffices]);

  const checkNow = async () => {
    setChecking(true);
    setError('');
    try {
      const pos = await requestCurrentPosition();
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      const active = offices.filter((o) => o.active);
      if (active.length > 0) {
        let best = active[0];
        let bestDist = distanceMeters(lat, lng, best.latitude, best.longitude);
        for (const o of active.slice(1)) {
          const d = distanceMeters(lat, lng, o.latitude, o.longitude);
          if (d < bestDist) { best = o; bestDist = d; }
        }
        setNearby({ name: best.name, dist: Math.round(bestDist), inside: bestDist <= best.radius_meters });
      }

      const { data, error: rpcError } = await supabase.rpc('process_geo_attendance_ping', {
        p_latitude: lat,
        p_longitude: lng,
        p_accuracy: pos.coords.accuracy ?? null,
      });
      if (rpcError) throw rpcError;
      const result = data as GeoPingResult;
      setLastResult(result);
      if (result.action === 'clock_in' || result.action === 'clock_out') {
        await loadToday();
        onClockUpdate?.();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Location check failed');
    } finally {
      setChecking(false);
    }
  };

  const toggleEnabled = (on: boolean) => {
    setGeoAttendanceEnabled(on);
    setEnabled(on);
    if (on) checkNow();
  };

  return (
    <div className="attendance-card geo-attendance-panel">
      <h3 className="attendance-card__title">
        <MapPin size={18} /> Auto location attendance
        {enabled && <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>Active</span>}
      </h3>
      <p className="attendance-card__subtitle">
        When you enter the office GPS zone, you are automatically marked <strong>present</strong> with clock-in time.
        When you leave, you are automatically clocked out. Keep this app open and allow location access.
      </p>

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
        <p className="geo-last-action">
          Last sync: {geoActionLabel(lastResult.action)}
          {lastResult.office_name ? ` · ${lastResult.office_name}` : ''}
        </p>
      )}

      {error && <p className="geo-error">{error}</p>}

      {offices.length === 0 && (
        <p className="geo-hint">No office zone configured yet. Ask your admin to set up Office GPS.</p>
      )}

      <button type="button" className="btn btn-secondary btn-sm" disabled={checking || !enabled} onClick={checkNow}>
        {checking ? <Loader2 size={14} className="spin-icon" /> : <Navigation size={14} />}
        Check location now
      </button>
    </div>
  );
}
