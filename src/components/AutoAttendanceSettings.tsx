import { useCallback, useEffect, useState } from 'react';
import { Loader2, Smartphone, Laptop, MapPin, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  PHONE_OPT_IN_TEXT,
  LAPTOP_OPT_IN_TEXT,
  registerAttendanceDevice,
  disableAutoAttendanceOnDevice,
  getAttendanceDeviceToken,
  isAutoAttendanceClient,
} from '../utils/attendanceDevice';
import { isNativeApp, isDesktopApp } from '../utils/nativePlatform';

type DeviceRow = {
  id: string;
  user_id: string;
  platform: string;
  device_timezone: string | null;
  app_version: string | null;
  last_seen_at: string | null;
  last_clock_skew_ms: number | null;
  revoked_at: string | null;
  presence_state: string | null;
};

type Unenrolled = {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  has_phone_device: boolean;
  has_laptop_device: boolean;
  phone_enabled: boolean;
  laptop_enabled: boolean;
};

export default function AutoAttendanceSettings({ mode = 'admin' }: { mode?: 'admin' | 'self' }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [phoneOn, setPhoneOn] = useState(false);
  const [laptopOn, setLaptopOn] = useState(false);
  const [timezone, setTimezone] = useState('Asia/Karachi');
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [unenrolled, setUnenrolled] = useState<Unenrolled[]>([]);
  const [hasToken, setHasToken] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    if (mode === 'admin') {
      const { data: me } = await supabase.from('users').select('company_id').single();
      if (me?.company_id) {
        const { data: co } = await supabase
          .from('companies')
          .select('auto_phone_attendance, auto_laptop_attendance, timezone')
          .eq('id', me.company_id)
          .single();
        if (co) {
          setPhoneOn(Boolean(co.auto_phone_attendance));
          setLaptopOn(Boolean(co.auto_laptop_attendance));
          setTimezone(co.timezone || 'Asia/Karachi');
        }
      }
      const { data: devs } = await supabase.rpc('list_company_attendance_devices');
      setDevices((devs || []) as DeviceRow[]);
      const { data: missing } = await supabase.rpc('list_unenrolled_auto_attendance_users');
      setUnenrolled((missing || []) as Unenrolled[]);
    } else {
      const { data: me } = await supabase
        .from('users')
        .select('auto_phone_attendance, auto_laptop_attendance')
        .single();
      if (me) {
        setPhoneOn(Boolean(me.auto_phone_attendance));
        setLaptopOn(Boolean(me.auto_laptop_attendance));
      }
    }
    setHasToken(Boolean(await getAttendanceDeviceToken()));
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCompany = async () => {
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('update_company_auto_attendance', {
      p_auto_phone: phoneOn,
      p_auto_laptop: laptopOn,
      p_timezone: timezone,
    });
    setSaving(false);
    setMsg(error ? error.message : 'Saved automatic attendance settings.');
    void load();
  };

  const enroll = async () => {
    if (!isAutoAttendanceClient()) {
      setMsg('Automatic attendance needs the Android, iPhone or desktop app.');
      return;
    }
    setEnrolling(true);
    const res = await registerAttendanceDevice();
    setEnrolling(false);
    if (!res.ok) {
      setMsg(res.error || 'Enrollment failed');
      return;
    }
    setHasToken(true);
    setMsg('Automatic attendance enabled on this device.');
    void load();
  };

  const turnOff = async () => {
    setEnrolling(true);
    await disableAutoAttendanceOnDevice(isDesktopApp() ? 'laptop' : 'phone');
    setEnrolling(false);
    setHasToken(false);
    setMsg('Automatic attendance turned off on this device.');
    void load();
  };

  const revoke = async (id: string) => {
    if (!confirm('Revoke this device? It will stop automatic attendance until re-enrolled.')) return;
    const { error } = await supabase.rpc('revoke_attendance_device', { p_device_row_id: id });
    setMsg(error ? error.message : 'Device revoked.');
    void load();
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 className="spin-icon" size={28} />
      </div>
    );
  }

  return (
    <div className="glass-panel" style={{ padding: '1.25rem', display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <MapPin size={18} style={{ color: 'var(--accent-primary)' }} />
        <h3 style={{ margin: 0 }}>Automatic attendance</h3>
      </div>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
        Window rules are fixed: 1 hour before shift start through 1 hour after shift end (shift time zone). They are not
        configurable.
      </p>

      {mode === 'admin' && (
        <>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" checked={phoneOn} onChange={(e) => setPhoneOn(e.target.checked)} />
            <Smartphone size={16} /> Automatic phone attendance
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input type="checkbox" checked={laptopOn} onChange={(e) => setLaptopOn(e.target.checked)} />
            <Laptop size={16} /> Laptop attendance (on = present, off = absent)
          </label>
          <div className="form-group">
            <label>Company time zone (reports / defaults)</label>
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Karachi" />
          </div>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveCompany()}>
            {saving ? 'Saving…' : 'Save company settings'}
          </button>
        </>
      )}

      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
        <h4 style={{ marginTop: 0 }}>This device</h4>
        {!isAutoAttendanceClient() && (
          <p style={{ color: 'var(--color-warning)' }}>
            Automatic attendance needs the Android, iPhone or desktop app.
          </p>
        )}
        <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
          {isDesktopApp() ? LAPTOP_OPT_IN_TEXT : PHONE_OPT_IN_TEXT}
        </p>
        {hasToken ? (
          <button type="button" className="btn btn-secondary" disabled={enrolling} onClick={() => void turnOff()}>
            Turn off automatic attendance
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={enrolling || !isAutoAttendanceClient()} onClick={() => void enroll()}>
            {enrolling ? 'Enabling…' : 'Enable automatic attendance (one-time)'}
          </button>
        )}
        {isNativeApp() && (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Android: allow location all the time, notifications, and unrestricted battery. iOS: allow Location Always.
          </p>
        )}
      </div>

      {mode === 'admin' && (
        <>
          <div>
            <h4>Enrolled devices</h4>
            {devices.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No devices enrolled yet.</p>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
              {devices.map((d) => (
                <li
                  key={d.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    padding: '0.65rem 0.75rem',
                    background: 'var(--bg-elevated, rgba(0,0,0,0.04))',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ fontSize: '0.85rem' }}>
                    <strong>{d.platform}</strong>
                    {d.revoked_at ? ' · revoked' : d.presence_state ? ` · ${d.presence_state}` : ' · enrolled'}
                    <br />
                    TZ {d.device_timezone || '—'} · v{d.app_version || '?'}
                    {d.last_clock_skew_ms != null && Math.abs(d.last_clock_skew_ms) > 10 * 60 * 1000 && (
                      <span style={{ color: 'var(--color-warning)' }}>
                        {' '}
                        <ShieldAlert size={12} /> Device clock is wrong
                      </span>
                    )}
                  </div>
                  {!d.revoked_at && (
                    <button type="button" className="btn btn-secondary" onClick={() => void revoke(d.id)}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Not enrolled yet</h4>
            {unenrolled.length === 0 && <p style={{ color: 'var(--text-muted)' }}>Everyone who needs it is enrolled.</p>}
            <ul style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {unenrolled.slice(0, 40).map((u) => (
                <li key={u.user_id}>
                  {u.full_name || u.email} ({u.role})
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {msg && <p style={{ margin: 0, fontSize: '0.88rem' }}>{msg}</p>}
    </div>
  );
}
