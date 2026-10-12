import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  MapPin,
  Loader2,
  Trash2,
  Plus,
  UserCheck,
  Navigation,
  AlertCircle,
  CheckCircle2,
  Radio,
  Users,
  Building2,
  Info,
} from 'lucide-react';
import { OfficeLocation } from '../utils/geoAttendance';
import AssignManagerLocationPanel, { ManagerSiteRow } from './AssignManagerLocationPanel';
import LiveGpsCapture from './LiveGpsCapture';
import TimeZonePicker from './TimeZonePicker';
import '../styles/attendance.css';
import '../styles/admin-office.css';

const MapLocationPicker = lazy(() => import('./MapLocationPicker'));

type OfficeTab = 'create' | 'assign' | 'offices';

function isAlertError(message: string): boolean {
  return /fail|denied|required|please|error|must|cannot|warn/i.test(message);
}

export default function OfficeLocationSettings() {
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [activeTab, setActiveTab] = useState<OfficeTab>('create');
  const [assignOfficeId, setAssignOfficeId] = useState('');
  const [assignKey, setAssignKey] = useState(0);
  const [form, setForm] = useState({
    id: '' as string | null,
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_meters: '150',
    active: true,
    default_timezone: '',
  });

  const showMsg = useCallback((text: string) => {
    setMsg(text);
    if (text && !isAlertError(text)) {
      setTimeout(() => setMsg(''), 6000);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [officesRes, sitesRes] = await Promise.all([
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
    ]);
    if (officesRes.error) showMsg(officesRes.error.message);
    else setOffices((officesRes.data || []) as OfficeLocation[]);
    if (!sitesRes.error) setAssignments((sitesRes.data || []) as ManagerSiteRow[]);
    setLoading(false);
  }, [showMsg]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setForm({
      id: null,
      name: '',
      address: '',
      latitude: '',
      longitude: '',
      radius_meters: '150',
      active: true,
      default_timezone: '',
    });
  };

  /** Clear the form and open the create tab so admins can add another office site. */
  const startAddLocation = () => {
    resetForm();
    setMsg('');
    setActiveTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const editOffice = (o: OfficeLocation) => {
    setForm({
      id: o.id,
      name: o.name,
      address: o.address || '',
      latitude: String(o.latitude),
      longitude: String(o.longitude),
      radius_meters: String(o.radius_meters),
      active: o.active,
      default_timezone: o.default_timezone || '',
    });
    setActiveTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const setCoords = (lat: string, lng: string, _accuracy?: number | null) => {
    setForm((f) => ({ ...f, latitude: lat, longitude: lng }));
    showMsg('Current location captured — this exact spot will be the office check-in center when you save.');
  };

  const startAssign = (officeId: string) => {
    setAssignOfficeId(officeId);
    setAssignKey((k) => k + 1);
    setActiveTab('assign');
    setTimeout(() => {
      document.getElementById('assign-manager-location')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      showMsg('Office name is required.');
      return;
    }
    if (!form.latitude || !form.longitude) {
      showMsg('Please capture live GPS first or enter latitude and longitude.');
      return;
    }
    setSaving(true);
    setMsg('');
    const savedName = form.name.trim();
    const wasNew = !form.id;
    const { data: officeId, error } = await supabase.rpc('upsert_office_location', {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: parseFloat(form.latitude),
      p_longitude: parseFloat(form.longitude),
      p_radius_meters: parseInt(form.radius_meters, 10) || 150,
      p_active: form.active,
      p_wifi_ssids: [],
      p_wifi_bssids: [],
      p_public_ip_cidrs: [],
      p_detection_mode: 'gps_or_wifi',
    });
    if (error) {
      setSaving(false);
      showMsg(error.message);
      return;
    }
    const resolvedId = (officeId as string) || form.id;
    setSaving(false);
    const { data: refreshed } = await supabase.rpc('get_office_locations');
    const list = (refreshed || []) as OfficeLocation[];
    const match =
      list.find((o) => (resolvedId ? o.id === resolvedId : o.name === savedName)) ||
      list.find((o) => o.name === savedName);
    if (match && form.default_timezone) {
      await supabase.rpc('update_office_default_timezones', {
        p_office_id: match.id,
        p_default_timezone: form.default_timezone,
        p_default_display_timezones: [],
      });
    }
    showMsg(
      wasNew
        ? `"${savedName}" saved. You can assign people now, or add another location anytime.`
        : `"${savedName}" updated.`,
    );
    resetForm();
    await load();
    if (wasNew && match) startAssign(match.id);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete office zone "${name}"? Managers assigned to it may lose their GPS attendance area.`)) return;
    const { error } = await supabase.rpc('delete_office_location', { p_id: id });
    if (error) showMsg(error.message);
    else {
      showMsg(`"${name}" deleted.`);
      void load();
    }
  };

  const activeOffices = offices.filter((o) => o.active);
  const assignedManagerCount = assignments.length;

  if (loading) {
    return (
      <div className="admin-office-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading office &amp; attendance settings…</span>
      </div>
    );
  }

  return (
    <div className="admin-office-page animate-fade-in">
      <header className="admin-office-header glass-panel">
        <div className="admin-office-header__main">
          <div className="admin-office-header__icon">
            <MapPin size={22} />
          </div>
          <div>
            <h2 className="admin-office-header__title">Office &amp; Attendance</h2>
            <p className="admin-office-header__subtitle">
              Add as many geofenced office locations as you need (HQ, branch, warehouse). Each site has its own GPS pin
              and radius. The same settings apply on web, desktop, and mobile.
            </p>
          </div>
          {offices.length > 0 && (
            <button type="button" className="btn btn-primary admin-office-header__add" onClick={startAddLocation}>
              <Plus size={16} /> Add location
            </button>
          )}
        </div>

        <div className="admin-office-stats">
          <div className="admin-office-stat">
            <Building2 size={16} />
            <span className="admin-office-stat__label">Active zones</span>
            <strong>{activeOffices.length}</strong>
          </div>
          <div className="admin-office-stat">
            <MapPin size={16} />
            <span className="admin-office-stat__label">Total offices</span>
            <strong>{offices.length}</strong>
          </div>
          <div className="admin-office-stat">
            <UserCheck size={16} />
            <span className="admin-office-stat__label">Managers assigned</span>
            <strong>{assignedManagerCount}</strong>
          </div>
          <div className="admin-office-stat">
            <Radio size={16} />
            <span className="admin-office-stat__label">GPS check-in</span>
            <strong className="admin-office-stat__value--sm">Enabled</strong>
          </div>
        </div>
      </header>

      <div className="admin-office-steps">
        <span className={`admin-office-step ${activeTab === 'create' ? 'admin-office-step--active' : ''}`}>
          1 · Add location
        </span>
        <span className={`admin-office-step ${activeTab === 'assign' ? 'admin-office-step--active' : ''}`}>
          2 · Assign people
        </span>
        <span className={`admin-office-step ${activeTab === 'offices' ? 'admin-office-step--active' : ''}`}>
          3 · All locations
        </span>
      </div>

      <div className="admin-office-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'create' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('create')}
        >
          <Plus size={16} /> {form.id ? 'Edit location' : 'Add location'}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'assign' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('assign')}
        >
          <UserCheck size={16} /> Assign people
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'offices' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('offices')}
        >
          <MapPin size={16} /> Locations ({offices.length})
        </button>
      </div>

      {msg && (
        <div
          className={`admin-office-alert ${isAlertError(msg) ? 'admin-office-alert--error' : 'admin-office-alert--success'}`}
          role="alert"
        >
          {isAlertError(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
          <button type="button" className="admin-office-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {activeTab === 'create' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <Navigation size={18} /> {form.id ? 'Edit office location' : 'Add office location'}
          </h3>
          <p>
            {form.id
              ? 'Update this site’s GPS pin, radius, or details. Changes apply to everyone already assigned here.'
              : 'Stand at the entrance, capture live GPS, fine-tune on the map, then save. Repeat to add another site.'}
          </p>

          {!form.id && offices.length > 0 && (
            <div className="admin-office-info">
              <Info size={16} />
              <span>
                You already have <strong>{offices.length}</strong> location{offices.length !== 1 ? 's' : ''}. Saving
                below adds a new one — it does not replace existing sites. Manage them under{' '}
                <button type="button" className="admin-office-inline-link" onClick={() => setActiveTab('offices')}>
                  Locations
                </button>
                .
              </span>
            </div>
          )}

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 1 · Stand at office &amp; capture live GPS</p>
            <p className="admin-office-form-help">
              The spot where you stand becomes the center of this location’s check-in zone.
              {form.id ? ' Saving updates everyone already assigned to this office.' : ''}
            </p>
            <LiveGpsCapture latitude={form.latitude} longitude={form.longitude} onCapture={setCoords} />
          </div>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 2 · Map &amp; radius</p>
            <div className="admin-office-map-wrap">
              <Suspense
                fallback={
                  <div className="dash-loading admin-office-map-fallback">
                    <Loader2 size={24} className="spin-icon" /> Loading map…
                  </div>
                }
              >
                <MapLocationPicker
                  latitude={form.latitude}
                  longitude={form.longitude}
                  radiusMeters={parseInt(form.radius_meters, 10) || 150}
                  onLocationChange={setCoords}
                />
              </Suspense>
            </div>
          </div>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 3 · Office details</p>
            <form onSubmit={save} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group">
                <label htmlFor="office-name">Office name *</label>
                <input
                  id="office-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Karachi HQ"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-address">Address (optional)</label>
                <input
                  id="office-address"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Street, city, country"
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-lat">Latitude *</label>
                <input
                  id="office-lat"
                  type="number"
                  step="any"
                  value={form.latitude}
                  onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                  placeholder="From live GPS"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-lng">Longitude *</label>
                <input
                  id="office-lng"
                  type="number"
                  step="any"
                  value={form.longitude}
                  onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                  placeholder="From live GPS"
                  required
                />
              </div>
              <div className="form-group admin-office-span-full">
                <label>Default shift time zone (pre-fill when creating shifts)</label>
                <TimeZonePicker
                  value={form.default_timezone}
                  onChange={(tz) => setForm({ ...form, default_timezone: tz })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-radius">Check-in radius (meters)</label>
                <input
                  id="office-radius"
                  type="number"
                  min={30}
                  max={2000}
                  value={form.radius_meters}
                  onChange={(e) => setForm({ ...form, radius_meters: e.target.value })}
                />
              </div>
              <div className="form-group admin-office-checkbox-end">
                <label>
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Active zone
                </label>
              </div>
              <div className="admin-office-form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : form.id ? (
                    'Update location'
                  ) : (
                    <>
                      <Plus size={16} /> Save location
                    </>
                  )}
                </button>
                {form.id ? (
                  <button type="button" className="btn btn-secondary" onClick={startAddLocation}>
                    Cancel · add another instead
                  </button>
                ) : (
                  offices.length > 0 && (
                    <button type="button" className="btn btn-secondary" onClick={() => setActiveTab('offices')}>
                      View all locations
                    </button>
                  )
                )}
              </div>
            </form>
          </div>
        </section>
      )}

      {activeTab === 'assign' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <UserCheck size={18} /> Assign office location
          </h3>
          <p>
            Assign a zone to every employee at once, to any individual, or to a manager so their team inherits it.
          </p>
          <div className="admin-office-info">
            <Info size={16} />
            <span>
              Add at least one active location under <strong>Add location</strong> before assigning people. You can
              assign different people to different sites.
            </span>
          </div>
          <AssignManagerLocationPanel
            key={assignKey}
            initialOfficeId={assignOfficeId}
            embedded
            onAssigned={() => void load()}
          />
        </section>
      )}

      {activeTab === 'offices' && (
        <section className="admin-office-card glass-panel">
          <div className="admin-office-card__toolbar">
            <div>
              <h3>
                <MapPin size={18} /> Office locations
              </h3>
              <p>
                Each card is a separate site with its own GPS pin and radius. Add another location anytime — there is no
                one-office limit.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={startAddLocation}>
              <Plus size={16} /> Add location
            </button>
          </div>

          {offices.length === 0 ? (
            <div className="admin-office-empty">
              <MapPin size={40} strokeWidth={1.25} />
              <h4>No office locations yet</h4>
              <p>Capture live GPS at your first office and save it. You can add more sites afterward.</p>
              <button type="button" className="btn btn-primary" onClick={startAddLocation}>
                <Plus size={16} /> Add first location
              </button>
            </div>
          ) : (
            <div className="admin-office-grid">
              {offices.map((o) => {
                const assigned = assignments.filter((a) => a.site_name === o.name || a.latitude === o.latitude);
                return (
                  <article
                    key={o.id}
                    className={`admin-office-item glass-panel ${o.active ? '' : 'admin-office-item--inactive'}`}
                  >
                    <div className="admin-office-item__head">
                      <h4>{o.name}</h4>
                      <span className={`admin-office-item__badge ${o.active ? '' : 'admin-office-item__badge--inactive'}`}>
                        {o.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {o.address && <p className="admin-office-item__meta">{o.address}</p>}
                    <div className="admin-office-item__coords">
                      {o.latitude.toFixed(5)}, {o.longitude.toFixed(5)} · {o.radius_meters}m radius
                    </div>
                    <p className="admin-office-item__meta">
                      <Users size={12} className="admin-office-item__meta-icon" />
                      {assigned.length > 0
                        ? `${assigned.length} manager${assigned.length !== 1 ? 's' : ''} (team zone)`
                        : 'No manager team zone yet'}
                    </p>
                    <div className="admin-office-item__actions">
                      {o.active && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => startAssign(o.id)}>
                          <UserCheck size={14} /> Assign
                        </button>
                      )}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => editOffice(o)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void remove(o.id, o.name)}
                        aria-label={`Delete ${o.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
