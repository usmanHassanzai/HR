import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { OfficeLocation } from '../utils/geoAttendance';
import { MapPin, Loader2, Trash2, UserCheck, Users } from 'lucide-react';
import LiveGpsCapture from './LiveGpsCapture';
import '../styles/attendance.css';

export interface ManagerSiteRow {
  site_id: string;
  manager_id: string;
  manager_name: string;
  manager_email: string;
  team_count: number;
  site_name: string;
  site_address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  tracking_enabled: boolean;
}

interface AssignManagerLocationPanelProps {
  /** Pre-select this office when opened from an office row */
  initialOfficeId?: string;
  onAssigned?: () => void;
}

export default function AssignManagerLocationPanel({
  initialOfficeId,
  onAssigned,
}: AssignManagerLocationPanelProps) {
  const [managers, setManagers] = useState<Profile[]>([]);
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [managerId, setManagerId] = useState('');
  const [officeId, setOfficeId] = useState(initialOfficeId || '');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [quickOffice, setQuickOffice] = useState({ name: '', latitude: '', longitude: '', radius_meters: '150' });
  const [quickSaving, setQuickSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, officesRes, sitesRes] = await Promise.all([
      supabase.rpc('get_all_users_admin'),
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
    ]);
    setManagers(((usersRes.data || []) as Profile[]).filter((u) => u.role === 'manager'));
    setOffices((officesRes.data || []) as OfficeLocation[]);
    if (sitesRes.error) setMsg(sitesRes.error.message);
    else setAssignments((sitesRes.data || []) as ManagerSiteRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (initialOfficeId) setOfficeId(initialOfficeId);
  }, [initialOfficeId]);

  const selectedOffice = offices.find((o) => o.id === officeId);

  const assign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managerId) {
      setMsg('Please select a manager.');
      return;
    }
    if (!selectedOffice) {
      setMsg('Please select an office location first. Add one above if the list is empty.');
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('assign_manager_work_site', {
      p_manager_id: managerId,
      p_office_location_id: selectedOffice.id,
      p_name: selectedOffice.name,
      p_address: selectedOffice.address || null,
      p_latitude: selectedOffice.latitude,
      p_longitude: selectedOffice.longitude,
      p_radius_meters: selectedOffice.radius_meters,
      p_tracking_enabled: true,
    });
    setSaving(false);
    if (error) {
      setMsg(error.message);
    } else {
      const mgr = managers.find((m) => m.id === managerId);
      setMsg(`Assigned "${selectedOffice.name}" to ${mgr?.full_name || 'manager'}. Their whole team will use this GPS zone.`);
      setManagerId('');
      await load();
      onAssigned?.();
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove work location for ${name}? Their team will no longer have a GPS zone.`)) return;
    const { error } = await supabase.rpc('remove_manager_work_site', { p_manager_id: id });
    if (error) setMsg(error.message);
    else {
      setMsg('Manager assignment removed.');
      load();
      onAssigned?.();
    }
  };

  const activeOffices = offices.filter((o) => o.active);

  const saveQuickOffice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickOffice.name.trim()) {
      setMsg('Office name is required.');
      return;
    }
    if (!quickOffice.latitude || !quickOffice.longitude) {
      setMsg('Tap “Add my live location now” above to capture GPS first.');
      return;
    }
    setQuickSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('upsert_office_location', {
      p_id: null,
      p_name: quickOffice.name.trim(),
      p_address: null,
      p_latitude: parseFloat(quickOffice.latitude),
      p_longitude: parseFloat(quickOffice.longitude),
      p_radius_meters: parseInt(quickOffice.radius_meters, 10) || 150,
      p_active: true,
    });
    setQuickSaving(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg('Office saved from live GPS! Select it below and assign to a manager.');
    setQuickOffice({ name: '', latitude: '', longitude: '', radius_meters: '150' });
    await load();
  };

  return (
    <div className="attendance-card geo-attendance-panel" id="assign-manager-location">
      <h3 className="attendance-card__title">
        <UserCheck size={18} /> Step 2 — Assign office to manager
      </h3>
      <p className="attendance-card__subtitle">
        Pick a <strong>manager</strong> and the <strong>office location</strong> you created above.
        Every employee under that manager will automatically use the same GPS zone for attendance.
      </p>

      {msg && (
        <div className={`rewards-toast ${msg.includes('Please') || msg.includes('fail') || msg.includes('Only') ? 'rewards-toast--error' : 'rewards-toast--success'}`} style={{ marginBottom: '1rem' }}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="dash-loading"><Loader2 size={24} className="spin-icon" /></div>
      ) : managers.length === 0 ? (
        <p className="attendance-empty">No managers found. Create a manager account first under Users.</p>
      ) : activeOffices.length === 0 ? (
        <div>
          <p className="attendance-empty" style={{ marginBottom: '1rem' }}>
            No office locations yet. Capture your live GPS below, name the office, and save — then assign it to a manager.
          </p>
          <LiveGpsCapture
            latitude={quickOffice.latitude}
            longitude={quickOffice.longitude}
            onCapture={(lat, lng) => setQuickOffice((o) => ({ ...o, latitude: lat, longitude: lng }))}
          />
          <form onSubmit={saveQuickOffice} className="attendance-form-grid attendance-form-grid--wide" style={{ marginTop: '1rem' }}>
            <div className="form-group">
              <label>Office name *</label>
              <input
                value={quickOffice.name}
                onChange={(e) => setQuickOffice({ ...quickOffice, name: e.target.value })}
                placeholder="e.g. Karachi HQ"
                required
              />
            </div>
            <div className="form-group">
              <label>Radius (meters)</label>
              <input
                type="number"
                min={30}
                max={2000}
                value={quickOffice.radius_meters}
                onChange={(e) => setQuickOffice({ ...quickOffice, radius_meters: e.target.value })}
              />
            </div>
            <div>
              <button type="submit" className="btn btn-primary" disabled={quickSaving || !quickOffice.latitude}>
                {quickSaving ? <Loader2 size={16} className="spin-icon" /> : <><MapPin size={16} /> Save office at live location</>}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <form onSubmit={assign} className="attendance-form-grid attendance-form-grid--wide">
          <div className="form-group">
            <label>Manager</label>
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} required>
              <option value="">— Select manager —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Office location</label>
            <select value={officeId} onChange={(e) => setOfficeId(e.target.value)} required>
              <option value="">— Select office —</option>
              {activeOffices.map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.radius_meters}m)</option>
              ))}
            </select>
          </div>
          {selectedOffice && (
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <div className="geo-assign-preview">
                <MapPin size={16} />
                <span>
                  <strong>{selectedOffice.name}</strong>
                  {' · '}{selectedOffice.latitude.toFixed(5)}, {selectedOffice.longitude.toFixed(5)}
                  {' · '}{selectedOffice.radius_meters}m radius
                  {selectedOffice.address && <> · {selectedOffice.address}</>}
                </span>
              </div>
            </div>
          )}
          <div>
            <button type="submit" className="btn btn-primary" disabled={saving || !managerId || !officeId}>
              {saving ? <Loader2 size={16} className="spin-icon" /> : <><UserCheck size={16} /> Assign to manager</>}
            </button>
          </div>
        </form>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <h4 className="attendance-card__title" style={{ fontSize: '0.95rem', marginBottom: '0.75rem' }}>
          <Users size={16} /> Current manager assignments ({assignments.length})
        </h4>
        {assignments.length === 0 ? (
          <p className="attendance-empty" style={{ margin: 0 }}>No managers assigned yet.</p>
        ) : (
          <div className="attendance-approval-list">
            {assignments.map((a) => (
              <div key={a.site_id} className="attendance-approval-item" style={{ borderLeftColor: 'var(--color-success)' }}>
                <div className="attendance-approval-item__main">
                  <span className="attendance-approval-item__name">
                    {a.manager_name}
                    <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>Assigned</span>
                  </span>
                  <span className="attendance-approval-item__meta">
                    Office: {a.site_name} · {a.team_count} employee{a.team_count !== 1 ? 's' : ''} on team
                  </span>
                  <span className="attendance-approval-item__reason">
                    {a.latitude.toFixed(5)}, {a.longitude.toFixed(5)} · {a.radius_meters}m
                  </span>
                </div>
                <div className="attendance-approval-item__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(a.manager_id, a.manager_name)} style={{ color: 'var(--color-danger)' }}>
                    <Trash2 size={14} /> Remove
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
