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
import '../styles/attendance.css';
import '../styles/admin-office.css';

const MapLocationPicker = lazy(() => import('./MapLocationPicker'));

type OfficeTab = 'create' | 'assign' | 'offices';

function isAlertError(message: string): boolean {
  return /fail|denied|required|please|error|must|cannot/i.test(message);
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
    radius_meters: '50',
    active: true,
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
    setForm({ id: null, name: '', address: '', latitude: '', longitude: '', radius_meters: '50', active: true });
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
    });
    setActiveTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const setCoords = (lat: string, lng: string) => {
    setForm((f) => ({ ...f, latitude: lat, longitude: lng }));
    showMsg('Live GPS captured — review coordinates and save the office zone.');
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
    const { error } = await supabase.rpc('upsert_office_location', {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: parseFloat(form.latitude),
      p_longitude: parseFloat(form.longitude),
      p_radius_meters: parseInt(form.radius_meters, 10) || 50,
      p_active: form.active,
    });
    setSaving(false);
    if (error) showMsg(error.message);
    else {
      showMsg(wasNew ? `"${savedName}" saved to Supabase. Assign it to a manager next.` : 'Office zone updated.');
      resetForm();
      await load();
      if (wasNew) {
        const { data: refreshed } = await supabase.rpc('get_office_locations');
        const list = (refreshed || []) as OfficeLocation[];
        const match = list.find((o) => o.name === savedName);
        if (match) startAssign(match.id);
      }
    }
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
        <span>Loading office GPS zones…</span>
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
            <h2 className="admin-office-header__title">Office GPS zones</h2>
            <p className="admin-office-header__subtitle">
              Define geofenced office locations for automatic attendance. Capture live GPS, save the zone, then assign
              each office to a manager — their entire team uses the same check-in area.
            </p>
          </div>
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
            <strong style={{ fontSize: '0.88rem' }}>Enabled</strong>
          </div>
        </div>
      </header>

      <div className="admin-office-steps">
        <span className={`admin-office-step ${activeTab === 'create' ? 'admin-office-step--active' : ''}`}>
          1 · Capture &amp; save zone
        </span>
        <span className={`admin-office-step ${activeTab === 'assign' ? 'admin-office-step--active' : ''}`}>
          2 · Assign to manager
        </span>
        <span className={`admin-office-step ${activeTab === 'offices' ? 'admin-office-step--active' : ''}`}>
          3 · Manage offices
        </span>
      </div>

      <div className="admin-office-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'create' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('create')}
        >
          <Navigation size={16} /> Create zone
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'assign' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('assign')}
        >
          <UserCheck size={16} /> Assign managers
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'offices' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('offices')}
        >
          <MapPin size={16} /> All offices ({offices.length})
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
            <Navigation size={18} /> {form.id ? 'Edit office zone' : 'Create office zone'}
          </h3>
          <p>Stand at the office entrance, capture live GPS, fine-tune on the map, then save to Supabase.</p>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 1 · Live GPS</p>
            <LiveGpsCapture latitude={form.latitude} longitude={form.longitude} onCapture={setCoords} />
          </div>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 2 · Map &amp; radius</p>
            <div className="admin-office-map-wrap">
              <Suspense
                fallback={
                  <div className="dash-loading" style={{ minHeight: 160 }}>
                    <Loader2 size={24} className="spin-icon" /> Loading map…
                  </div>
                }
              >
                <MapLocationPicker
                  latitude={form.latitude}
                  longitude={form.longitude}
                  radiusMeters={parseInt(form.radius_meters, 10) || 50}
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
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Active zone
                </label>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', gridColumn: '1 / -1' }}>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : form.id ? (
                    'Update office zone'
                  ) : (
                    <>
                      <Plus size={16} /> Save office zone
                    </>
                  )}
                </button>
                {form.id && (
                  <button type="button" className="btn btn-secondary" onClick={resetForm}>
                    Cancel edit
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      )}

      {activeTab === 'assign' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <UserCheck size={18} /> Assign office to manager
          </h3>
          <p>
            Each manager gets one GPS zone. All employees on their team automatically check in within that geofence.
          </p>
          <div className="admin-office-info">
            <Info size={16} />
            <span>Create at least one active office under <strong>Create zone</strong> before assigning managers.</span>
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
          <h3>
            <MapPin size={18} /> Saved office zones
          </h3>
          <p>All geofenced locations stored in Supabase. Edit coordinates, assign managers, or remove unused zones.</p>

          {offices.length === 0 ? (
            <div className="admin-office-empty">
              <MapPin size={40} strokeWidth={1.25} />
              <h4>No office zones yet</h4>
              <p>Go to <strong>Create zone</strong>, capture live GPS at your office, and save your first location.</p>
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
                      <Users size={12} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />
                      {assigned.length > 0
                        ? `${assigned.length} manager${assigned.length !== 1 ? 's' : ''} assigned`
                        : 'Not assigned to a manager yet'}
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
                        className="btn btn-secondary btn-sm"
                        onClick={() => void remove(o.id, o.name)}
                        style={{ color: 'var(--color-danger)' }}
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
