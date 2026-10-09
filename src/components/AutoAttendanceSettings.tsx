import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Laptop,
  Loader2,
  MapPin,
  Smartphone,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import TimeZonePicker from './TimeZonePicker';
import AutoAttendanceSetupWizard from './AutoAttendanceSetupWizard';
import {
  androidInstallHref,
  DESKTOP_LINUX_DEB_PATH,
  DESKTOP_WIN_PATH,
  iosInstallHref,
} from '../utils/appStoreLinks';
import { getAttendanceDeviceToken, isAutoAttendanceClient } from '../utils/attendanceDevice';
import { fetchVersionManifest, isNewerVersion, packageVersion } from '../utils/appUpdate';
import { isDesktopApp } from '../utils/nativePlatform';
import '../styles/auto-attendance-setup.css';

type DeviceRow = {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string;
  role: string;
  platform: string;
  device_id: string | null;
  app_version: string | null;
  device_timezone: string | null;
  last_seen_at: string | null;
  last_clock_skew_ms: number | null;
  revoked_at: string | null;
  presence_state: string | null;
  last_matched_method: string | null;
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

type FlaggedEvent = {
  id: string;
  created_at: string;
  event: string;
  reason_code: string | null;
  matched_method: string | null;
  client_ip: string | null;
  user_id: string | null;
  clock_flagged: boolean;
};

const FLAG_REASONS = new Set([
  'mock_location',
  'outside_radius',
  'outside_window',
  'wrong_network',
  'fake_hotspot_suspected',
  'event_too_old',
]);

const QR_URL =
  'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' +
  encodeURIComponent('https://scorr.walfia.ai/#download-app');

function deviceStatus(d: DeviceRow): { label: string; kind: 'ok' | 'warn' | 'bad' | 'muted' | 'outdated' } {
  if (d.revoked_at) return { label: 'Revoked', kind: 'muted' };
  if (d.last_clock_skew_ms != null && Math.abs(d.last_clock_skew_ms) > 10 * 60 * 1000) {
    return { label: 'Clock wrong', kind: 'bad' };
  }
  if (!d.last_seen_at) return { label: 'Permission missing', kind: 'warn' };
  const age = Date.now() - new Date(d.last_seen_at).getTime();
  if (age > 24 * 60 * 60 * 1000) return { label: 'Offline', kind: 'warn' };
  if (d.presence_state === 'present') return { label: 'Active', kind: 'ok' };
  return { label: 'Active', kind: 'ok' };
}

function isDeviceOutdated(appVersion: string | null, latest: string): boolean {
  if (!appVersion || !latest) return false;
  return isNewerVersion(latest, appVersion);
}

export default function AutoAttendanceSettings({
  mode = 'admin',
  embedded = false,
}: {
  mode?: 'admin' | 'self';
  /** When true (Office & Attendance page), skip nested glass on the intro panel. */
  embedded?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [phoneOn, setPhoneOn] = useState(false);
  const [laptopOn, setLaptopOn] = useState(false);
  const [timezone, setTimezone] = useState('');
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [unenrolled, setUnenrolled] = useState<Unenrolled[]>([]);
  const [flagged, setFlagged] = useState<FlaggedEvent[]>([]);
  const [hasToken, setHasToken] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [flagDate, setFlagDate] = useState('');
  const [flagReason, setFlagReason] = useState('');
  const [reminding, setReminding] = useState<string | null>(null);
  const [latestAppVersion, setLatestAppVersion] = useState(packageVersion());

  const webBrowser = !isAutoAttendanceClient();

  useEffect(() => {
    void fetchVersionManifest().then((m) => {
      const v =
        m?.android?.versionName ||
        m?.android?.version ||
        m?.windows?.version ||
        m?.ios?.version ||
        packageVersion();
      if (v) setLatestAppVersion(v);
    });
  }, []);

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
          setTimezone(co.timezone || '');
        }
      }
      const { data: detailed } = await supabase.rpc('list_company_attendance_devices_detailed');
      if (detailed) {
        setDevices(detailed as DeviceRow[]);
      } else {
        const { data: devs } = await supabase.rpc('list_company_attendance_devices');
        setDevices((devs || []) as DeviceRow[]);
      }
      const { data: missing } = await supabase.rpc('list_unenrolled_auto_attendance_users');
      setUnenrolled((missing || []) as Unenrolled[]);
      const { data: events } = await supabase
        .from('attendance_events_log')
        .select('id, created_at, event, reason_code, matched_method, client_ip, user_id, clock_flagged')
        .or('accepted.eq.false,clock_flagged.eq.true')
        .order('created_at', { ascending: false })
        .limit(120);
      setFlagged(
        ((events || []) as FlaggedEvent[]).filter(
          (e) =>
            e.clock_flagged ||
            (e.reason_code &&
              (FLAG_REASONS.has(e.reason_code) ||
                e.reason_code.includes('clock') ||
                e.reason_code.includes('radius') ||
                e.reason_code.includes('network'))),
        ),
      );
    } else {
      const { data: me } = await supabase
        .from('users')
        .select('auto_phone_attendance, auto_laptop_attendance')
        .single();
      if (me) {
        setPhoneOn(Boolean(me.auto_phone_attendance));
        setLaptopOn(Boolean(me.auto_laptop_attendance));
      }
      const { data: myDevs } = await supabase
        .from('attendance_devices')
        .select(
          'id, user_id, platform, device_id, app_version, device_timezone, last_seen_at, last_clock_skew_ms, revoked_at, presence_state, last_matched_method',
        )
        .is('revoked_at', null)
        .order('last_seen_at', { ascending: false });
      setDevices(
        ((myDevs || []) as DeviceRow[]).map((d) => ({
          ...d,
          full_name: null,
          email: '',
          role: '',
        })),
      );
    }
    setHasToken(Boolean(await getAttendanceDeviceToken()));
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const tiles = useMemo(() => {
    const enrolled = devices.filter((d) => !d.revoked_at);
    const activeNow = enrolled.filter((d) => d.presence_state === 'present').length;
    const flaggedToday = flagged.filter((e) => {
      const d = new Date(e.created_at);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length;
    return {
      enrolled: enrolled.length,
      notEnrolled: unenrolled.length,
      activeNow,
      flaggedToday,
    };
  }, [devices, flagged, unenrolled.length]);

  const filteredFlagged = useMemo(() => {
    return flagged.filter((e) => {
      if (flagDate) {
        const day = e.created_at.slice(0, 10);
        if (day !== flagDate) return false;
      }
      if (flagReason) {
        const r = e.reason_code || (e.clock_flagged ? 'device_clock_wrong' : e.event);
        if (!r.includes(flagReason)) return false;
      }
      return true;
    });
  }, [flagDate, flagReason, flagged]);

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

  const revoke = async (id: string) => {
    if (!confirm('Revoke this device? It will stop automatic attendance until re-enrolled.')) return;
    const { error } = await supabase.rpc('revoke_attendance_device', { p_device_row_id: id });
    setMsg(error ? error.message : 'Device revoked.');
    void load();
  };

  const remind = async (userId: string) => {
    setReminding(userId);
    const { error } = await supabase.rpc('send_auto_attendance_setup_reminder', { p_user_id: userId });
    setReminding(null);
    setMsg(error ? error.message : 'Reminder sent.');
  };

  const remindAll = async () => {
    setReminding('all');
    for (const u of unenrolled) {
      await supabase.rpc('send_auto_attendance_setup_reminder', { p_user_id: u.user_id });
    }
    setReminding(null);
    setMsg(`Reminders sent to ${unenrolled.length} people.`);
  };

  if (loading) {
    return (
      <div className="aas-loading">
        <Loader2 className="spin-icon" size={28} />
        <span>Loading automatic attendance…</span>
      </div>
    );
  }

  if (showWizard && isAutoAttendanceClient()) {
    return (
      <AutoAttendanceSetupWizard
        onClose={() => {
          setShowWizard(false);
          void load();
        }}
        onFinished={() => {
          setHasToken(true);
          void load();
        }}
      />
    );
  }

  const msgLooksError = /fail|error|denied|cannot|must|please/i.test(msg);

  return (
    <div className="aas-root">
      <div className={`${embedded ? 'admin-office-card glass-panel' : 'glass-panel'} aas-panel`}>
        <div className="aas-panel__head">
          <div className="aas-panel__icon">
            <MapPin size={18} />
          </div>
          <div>
            <h3 className="aas-panel__title">Automatic attendance</h3>
            <p className="aas-panel__subtitle">
              {mode === 'admin'
                ? 'Company toggles, enrolled devices, and flagged events — same controls on web, desktop, and mobile. Device enrollment uses the Android, iPhone, or desktop app. Window: 1 hour before shift start through 1 hour after shift end.'
                : 'Window rules are fixed: 1 hour before shift start through 1 hour after shift end (shift time zone).'}
            </p>
          </div>
        </div>

        {mode === 'admin' && (
          <>
            <div className="aas-toggles">
              <label className="aas-toggle">
                <input type="checkbox" checked={phoneOn} onChange={(e) => setPhoneOn(e.target.checked)} />
                <Smartphone size={16} /> Automatic phone attendance
              </label>
              <label className="aas-toggle">
                <input type="checkbox" checked={laptopOn} onChange={(e) => setLaptopOn(e.target.checked)} />
                <Laptop size={16} /> Laptop attendance (on = present, off = absent)
              </label>
            </div>
            <div className="form-group">
              <label>Company time zone (reports / defaults)</label>
              <TimeZonePicker value={timezone} onChange={setTimezone} />
            </div>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void saveCompany()}>
              {saving ? 'Saving…' : 'Save company settings'}
            </button>
          </>
        )}

        <div className="aas-device-block">
          <h4>This device</h4>
          {webBrowser ? (
            <div className="aas-web-card">
              <h4>Set up automatic attendance on your phone or laptop</h4>
              <div className="aas-web-card__grid">
                <div className="aas-web-card__body">
                  <div className="aas-web-card__downloads">
                    <a className="btn btn-primary" href={androidInstallHref()} download="scorr.apk">
                      Android APK
                    </a>
                    <a className="btn btn-secondary" href={DESKTOP_WIN_PATH}>
                      Windows
                    </a>
                    <a className="btn btn-secondary" href={DESKTOP_LINUX_DEB_PATH}>
                      Linux
                    </a>
                    <a className="btn btn-secondary" href={iosInstallHref()}>
                      iPhone
                    </a>
                  </div>
                  <ol className="aas-web-card__steps">
                    <li>Install the Scorr app for your phone or laptop</li>
                    <li>Sign in with your work account</li>
                    <li>Open Automatic attendance and follow the setup steps</li>
                  </ol>
                </div>
                <img className="aas-web-card__qr" src={QR_URL} alt="QR code to download Scorr" width={132} height={132} />
              </div>
              {devices.length > 0 && (
                <>
                  <h4 className="aas-web-card__devices-title">Your enrolled devices</h4>
                  <ul className="aas-web-devices">
                    {devices.map((d) => {
                      const st = deviceStatus(d);
                      const outdated = isDeviceOutdated(d.app_version, latestAppVersion);
                      return (
                        <li key={d.id}>
                          <strong>{d.platform}</strong> · v{d.app_version || '?'} ·{' '}
                          <span className={`aas-badge aas-badge--${st.kind}`}>{st.label}</span>
                          {outdated && (
                            <span className="aas-badge aas-badge--outdated"> Outdated</span>
                          )}
                          {d.last_seen_at ? ` · last seen ${new Date(d.last_seen_at).toLocaleString()}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          ) : hasToken ? (
            <AutoAttendanceSetupWizard onFinished={() => void load()} />
          ) : (
            <>
              <p className="aas-device-block__lead">
                {isDesktopApp()
                  ? 'Follow a short setup to register this laptop for automatic attendance.'
                  : 'Follow a short setup for location, notifications, and device registration.'}
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setShowWizard(true)}>
                Set up automatic attendance
              </button>
            </>
          )}
        </div>

        {msg && (
          <p className={`aas-msg ${msgLooksError ? 'aas-msg--err' : 'aas-msg--ok'}`} role="status">
            {msg}
          </p>
        )}
      </div>

      {mode === 'admin' && (
        <div className="aas-admin aas-admin-panel glass-panel">
          <div className="aas-tiles">
            <div className="aas-tile">
              <span className="aas-tile__value">{tiles.enrolled}</span>
              <span className="aas-tile__label">Enrolled devices</span>
            </div>
            <div className="aas-tile">
              <span className="aas-tile__value">{tiles.notEnrolled}</span>
              <span className="aas-tile__label">Not enrolled</span>
            </div>
            <div className="aas-tile">
              <span className="aas-tile__value">{tiles.activeNow}</span>
              <span className="aas-tile__label">Active now</span>
            </div>
            <div className="aas-tile">
              <span className="aas-tile__value">{tiles.flaggedToday}</span>
              <span className="aas-tile__label">Flagged today</span>
            </div>
          </div>

          <section className="aas-section">
            <div className="aas-section__head">
              <h4>Enrolled devices</h4>
            </div>
            {devices.filter((d) => !d.revoked_at).length === 0 ? (
              <div className="aas-empty">
                <Users size={32} strokeWidth={1.25} />
                <p>No devices enrolled yet. People set up automatic attendance in the Android, iPhone, or desktop app under Settings.</p>
              </div>
            ) : (
              <>
                <div className="aas-table-wrap">
                  <table className="aas-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Role</th>
                        <th>Device</th>
                        <th>Platform</th>
                        <th>App</th>
                        <th>Status</th>
                        <th>Last seen</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {devices
                        .filter((d) => !d.revoked_at)
                        .map((d) => {
                          const st = deviceStatus(d);
                          const outdated = isDeviceOutdated(d.app_version, latestAppVersion);
                          return (
                            <tr key={d.id}>
                              <td>{d.full_name || d.email || d.user_id.slice(0, 8)}</td>
                              <td>{d.role || '—'}</td>
                              <td>{d.device_id ? d.device_id.slice(0, 12) : '—'}</td>
                              <td>{d.platform}</td>
                              <td>
                                v{d.app_version || '?'}
                                {outdated && (
                                  <>
                                    {' '}
                                    <span className="aas-badge aas-badge--outdated">Outdated</span>
                                  </>
                                )}
                              </td>
                              <td>
                                <span className={`aas-badge aas-badge--${st.kind}`}>{st.label}</span>
                              </td>
                              <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : '—'}</td>
                              <td>
                                <button type="button" className="btn btn-danger btn-sm" onClick={() => void revoke(d.id)}>
                                  Revoke
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="aas-mobile-cards">
                  {devices
                    .filter((d) => !d.revoked_at)
                    .map((d) => {
                      const st = deviceStatus(d);
                      const outdated = isDeviceOutdated(d.app_version, latestAppVersion);
                      return (
                        <div key={d.id} className="aas-mobile-card">
                          <strong>{d.full_name || d.email || 'Device'}</strong>
                          <span>
                            {d.platform} · v{d.app_version || '?'} ·{' '}
                            <span className={`aas-badge aas-badge--${st.kind}`}>{st.label}</span>
                            {outdated && (
                              <span className="aas-badge aas-badge--outdated"> Outdated</span>
                            )}
                          </span>
                          <div className="aas-mobile-card__actions">
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => void revoke(d.id)}>
                              Revoke
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </>
            )}
          </section>

          <section className="aas-section">
            <div className="aas-section__head">
              <h4>Not enrolled yet</h4>
              {unenrolled.length > 0 && (
                <button type="button" className="btn btn-secondary" disabled={reminding === 'all'} onClick={() => void remindAll()}>
                  <Bell size={14} /> Remind all
                </button>
              )}
            </div>
            {unenrolled.length === 0 ? (
              <div className="aas-empty">
                <Smartphone size={32} strokeWidth={1.25} />
                <p>Everyone who needs automatic attendance is enrolled.</p>
              </div>
            ) : (
              <>
                <div className="aas-table-wrap">
                  <table className="aas-table">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Role</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {unenrolled.map((u) => (
                        <tr key={u.user_id}>
                          <td>{u.full_name || u.email}</td>
                          <td>{u.role}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={reminding === u.user_id}
                              onClick={() => void remind(u.user_id)}
                            >
                              Send reminder
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="aas-mobile-cards">
                  {unenrolled.map((u) => (
                    <div key={u.user_id} className="aas-mobile-card">
                      <strong>{u.full_name || u.email}</strong>
                      <span>{u.role}</span>
                      <div className="aas-mobile-card__actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={reminding === u.user_id}
                          onClick={() => void remind(u.user_id)}
                        >
                          Send reminder
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="aas-section">
            <div className="aas-section__head">
              <h4>Flagged attendance</h4>
              <div className="aas-filters">
                <label>
                  Date
                  <input type="date" value={flagDate} onChange={(e) => setFlagDate(e.target.value)} />
                </label>
                <label>
                  Reason
                  <select value={flagReason} onChange={(e) => setFlagReason(e.target.value)}>
                    <option value="">All</option>
                    <option value="mock">Mock location</option>
                    <option value="radius">Outside radius</option>
                    <option value="window">Outside window</option>
                    <option value="network">Wrong network</option>
                    <option value="clock">Clock wrong</option>
                  </select>
                </label>
              </div>
            </div>
            {filteredFlagged.length === 0 ? (
              <div className="aas-empty">
                <AlertTriangle size={32} strokeWidth={1.25} />
                <p>
                  {flagDate || flagReason
                    ? 'No flagged events match this filter. Clear the date or reason to see more.'
                    : 'No flagged attendance events yet. Suspicious check-ins will appear here.'}
                </p>
              </div>
            ) : (
              <>
                <div className="aas-table-wrap">
                  <table className="aas-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Person</th>
                        <th>Reason</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredFlagged.slice(0, 60).map((e) => (
                        <tr key={e.id}>
                          <td>{new Date(e.created_at).toLocaleString()}</td>
                          <td>{e.user_id ? e.user_id.slice(0, 8) : '—'}</td>
                          <td>{e.reason_code || (e.clock_flagged ? 'device_clock_wrong' : e.event)}</td>
                          <td>
                            {e.matched_method || '—'}
                            {e.client_ip ? ` · IP ${e.client_ip}` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="aas-mobile-cards">
                  {filteredFlagged.slice(0, 40).map((e) => (
                    <div key={e.id} className="aas-mobile-card">
                      <strong>{e.reason_code || e.event}</strong>
                      <span>{new Date(e.created_at).toLocaleString()}</span>
                      <span>
                        {e.matched_method || '—'}
                        {e.client_ip ? ` · IP ${e.client_ip}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
