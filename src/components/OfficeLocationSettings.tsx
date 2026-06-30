import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { MapPin, Loader2, Trash2, Plus, Navigation } from 'lucide-react';
import { OfficeLocation, requestCurrentPosition } from '../utils/geoAttendance';

export default function OfficeLocationSettings() {
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({
    id: '' as string | null,
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_meters: '150',
    active: true,
  });

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_office_locations');
    if (error) setMsg(error.message);
    else setOffices((data || []) as OfficeLocation[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setForm({ id: null, name: '', address: '', latitude: '', longitude: '', radius_meters: '150', active: true });
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
  };

  const useMyLocation = async () => {
    setMsg('');
    try {
      const pos = await requestCurrentPosition();
      setForm((f) => ({
        ...f,
        latitude: pos.coords.latitude.toFixed(6),
        longitude: pos.coords.longitude.toFixed(6),
      }));
      setMsg('Current location captured.');
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Could not get location');
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.latitude || !form.longitude) {
      setMsg('Name and GPS coordinates are required.');
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('upsert_office_location', {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: parseFloat(form.latitude),
      p_longitude: parseFloat(form.longitude),
      p_radius_meters: parseInt(form.radius_meters, 10) || 150,
      p_active: form.active,
    });
    setSaving(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Office location saved.');
      resetForm();
      load();
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this office location?')) return;
    const { error } = await supabase.rpc('delete_office_location', { p_id: id });
    if (error) setMsg(error.message);
    else load();
  };

  return (
    <div className="attendance-page">
      {msg && (
        <div className={`rewards-toast ${msg.includes('fail') || msg.includes('denied') || msg.includes('required') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title"><MapPin size={18} /> Office GPS zones</h3>
        <p className="attendance-card__subtitle">
          Set your office coordinates and radius. When employees enter this area with location enabled, they are automatically marked present with clock-in time. Leaving the zone clocks them out.
        </p>

        <form onSubmit={save} className="attendance-form-grid attendance-form-grid--wide">
          <div className="form-group">
            <label>Office name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Karachi HQ" required />
          </div>
          <div className="form-group">
            <label>Address (optional)</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street, city" />
          </div>
          <div className="form-group">
            <label>Latitude</label>
            <input type="number" step="any" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} required />
          </div>
          <div className="form-group">
            <label>Longitude</label>
            <input type="number" step="any" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} required />
          </div>
          <div className="form-group">
            <label>Radius (meters)</label>
            <input type="number" min={30} max={2000} value={form.radius_meters} onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} />
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={useMyLocation}>
              <Navigation size={16} /> Use my location
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <Loader2 size={16} className="spin-icon" /> : form.id ? 'Update office' : <><Plus size={16} /> Add office</>}
            </button>
            {form.id && (
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            )}
          </div>
        </form>
      </div>

      <div className="attendance-card">
        <h3 className="attendance-card__title">Configured offices ({offices.length})</h3>
        {loading ? (
          <div className="dash-loading"><Loader2 size={24} className="spin-icon" /></div>
        ) : offices.length === 0 ? (
          <p className="attendance-empty">No office zones yet. Add one above so geo attendance can work.</p>
        ) : (
          <div className="attendance-approval-list">
            {offices.map((o) => (
              <div key={o.id} className="attendance-approval-item" style={{ borderLeftColor: o.active ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                <div className="attendance-approval-item__main">
                  <span className="attendance-approval-item__name">
                    {o.name}
                    {!o.active && <span className="attendance-role-tag">inactive</span>}
                  </span>
                  <span className="attendance-approval-item__meta">
                    {o.latitude.toFixed(5)}, {o.longitude.toFixed(5)} · {o.radius_meters}m radius
                  </span>
                  {o.address && <span className="attendance-approval-item__reason">{o.address}</span>}
                </div>
                <div className="attendance-approval-item__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => editOffice(o)}>Edit</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(o.id)} style={{ color: 'var(--color-danger)' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
