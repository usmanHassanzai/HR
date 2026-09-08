import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatKpiAssignmentChange, formatKpiEditTimestamp, Kpi, displayRoleLabel, type UserRole } from '../utils/kpiHelpers';
import KpiViewedBadge from './KpiViewedBadge';
import {
  calculateOverallKpiScore,
  formatKpiScore,
  kpiAssignedScore,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP, sumEmployeeKpiWeights } from '../utils/kpiWeightHelpers';
import { emailKpiAssignmentUpdated } from '../utils/kpiEmail';

interface EditAssignedKpiModalProps {
  kpi: Kpi;
  siblingKpis: Kpi[];
  employeeName: string;
  employeeEmail?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function statusLabel(status: string): string {
  if (status === 'on_track') return 'Going well';
  if (status === 'at_risk') return 'Needs attention';
  if (status === 'off_track') return 'Behind';
  return status;
}

function completionLabel(value: string): string {
  return value === 'completed' ? 'Complete' : 'Not finished';
}

export default function EditAssignedKpiModal({
  kpi,
  siblingKpis,
  employeeName,
  employeeEmail,
  onClose,
  onSaved,
}: EditAssignedKpiModalProps) {
  const [weight, setWeight] = useState(String(kpi.weight ?? ''));
  const [score, setScore] = useState(String(kpiAssignedScore(kpi)));
  const [endDate, setEndDate] = useState(kpi.end_date || '');
  const [status, setStatus] = useState(kpi.status);
  const [completion, setCompletion] = useState<'pending' | 'completed'>(kpi.completion_status === 'completed' ? 'completed' : 'pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ created_at: string; editor_name?: string; editor_role?: string; changes: Record<string, { from: unknown; to: unknown }> }[]>([]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('kpi_assignment_edits')
        .select('created_at, changes, editor_id, editor_name, editor_role')
        .eq('kpi_id', kpi.id)
        .order('created_at', { ascending: false })
        .limit(8);
      const rows = data || [];
      const missingIds = [...new Set(rows.filter((r) => !r.editor_name && r.editor_id).map((r) => r.editor_id))];
      let names = new Map<string, string>();
      if (missingIds.length) {
        const { data: users } = await supabase.from('users').select('id, full_name').in('id', missingIds);
        names = new Map((users || []).map((u) => [u.id, u.full_name]));
      }
      setHistory(rows.map((r) => ({
        created_at: r.created_at,
        editor_name: r.editor_name || names.get(r.editor_id),
        editor_role: r.editor_role,
        changes: (r.changes || {}) as Record<string, { from: unknown; to: unknown }>,
      })));
    };
    void load();
  }, [kpi.id]);

  const previewKpis = useMemo(() => {
    const nextWeight = Number(weight);
    const nextAssigned = Number(score);
    return siblingKpis.map((item) => {
      if (item.id !== kpi.id) return item;
      return {
        ...item,
        weight: Number.isFinite(nextWeight) ? nextWeight : item.weight,
        assigned_score: Number.isFinite(nextAssigned) ? nextAssigned : item.assigned_score,
        end_date: endDate || item.end_date,
        status,
        completion_status: completion,
      };
    });
  }, [siblingKpis, kpi.id, weight, score, endDate, status, completion]);

  const liveOverall = calculateOverallKpiScore(previewKpis);
  const pendingWeight = sumEmployeeKpiWeights(previewKpis);
  const weightNum = Number(weight);
  const scoreNum = Number(score);

  const buildChangeLines = (): string[] => {
    const lines: string[] = [];
    const prevScore = kpiAssignedScore(kpi);
    if (Math.abs(weightNum - Number(kpi.weight || 0)) > 0.001) {
      lines.push(`Weight: ${formatKpiWeight(kpi.weight)} → ${formatKpiWeight(weightNum)}`);
    }
    if (Math.abs(scoreNum - prevScore) > 0.001) {
      lines.push(`Score: ${formatKpiScore(prevScore)} → ${formatKpiScore(scoreNum)}`);
    }
    if ((endDate || '') !== (kpi.end_date || '')) {
      lines.push(`Due date: ${kpi.end_date || '—'} → ${endDate || '—'}`);
    }
    if (status !== kpi.status) {
      lines.push(`Status: ${statusLabel(kpi.status)} → ${statusLabel(status)}`);
    }
    const prevCompletion = kpi.completion_status === 'completed' ? 'completed' : 'pending';
    if (completion !== prevCompletion) {
      lines.push(`Completion: ${completionLabel(prevCompletion)} → ${completionLabel(completion)}`);
    }
    return lines;
  };

  const save = async () => {
    if (!Number.isFinite(weightNum) || weightNum < 1 || weightNum > 100) {
      setError('Weightage must be between 1% and 100%.');
      return;
    }
    if (!Number.isFinite(scoreNum) || scoreNum < 0) {
      setError('Score cannot be negative.');
      return;
    }
    if (!endDate) {
      setError('Choose a due date.');
      return;
    }

    const changeLines = buildChangeLines();
    const weightChanged = Math.abs(weightNum - Number(kpi.weight || 0)) > 0.001;
    if (weightChanged && !window.confirm(`Save weightage change from ${formatKpiWeight(kpi.weight)} to ${formatKpiWeight(weightNum)}? The employee’s overall KPI score will update immediately.`)) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('edit_assigned_kpi', {
        p_kpi_id: kpi.id,
        p_weight: weightNum,
        p_score_pct: scoreNum,
        p_end_date: endDate,
        p_status: status,
        p_completion_status: completion,
      });
      if (rpcError) throw rpcError;

      const updated = (data as { updated?: boolean } | null)?.updated !== false;
      if (!updated) {
        setError('No changes to save — update a field first.');
        return;
      }

      if (changeLines.length > 0) {
        try {
          const { data: authData } = await supabase.auth.getUser();
          const editorId = authData.user?.id;
          const [empRes, editorRes] = await Promise.all([
            employeeEmail
              ? Promise.resolve({ data: { email: employeeEmail } })
              : supabase.from('users').select('email').eq('id', kpi.user_id).maybeSingle(),
            editorId
              ? supabase.from('users').select('full_name, role').eq('id', editorId).maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          const to = empRes.data?.email || '';
          const editorRole = displayRoleLabel((editorRes.data?.role as UserRole) || 'manager');
          if (to) {
            await emailKpiAssignmentUpdated({
              employeeEmail: to,
              employeeName,
              kpiName: kpi.name,
              editorName: editorRes.data?.full_name || 'A supervisor',
              editorRole,
              changeLines,
            });
          }
        } catch (mailErr) {
          console.warn('KPI update email failed after save:', mailErr);
        }
      }

      onSaved();
    } catch (e) {
      const err = e as { message?: string; details?: string; hint?: string };
      setError(
        [err?.message, err?.details, err?.hint].filter(Boolean).join(' — ')
          || (e instanceof Error ? e.message : 'Could not save changes.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kpi-edit-overlay" onClick={onClose} role="presentation">
      <div
        className="kpi-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kpi-edit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="kpi-edit-dialog__head">
          <div>
            <p className="kpi-edit-dialog__kicker">Edit assignment</p>
            <h2 id="kpi-edit-title">{kpi.name}</h2>
            <p className="kpi-edit-dialog__person">{employeeName}</p>
          </div>
          <button type="button" className="kpi-edit-dialog__close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="kpi-edit-dialog__body">
          {formatKpiAssignmentChange(kpi) && (
            <p className="kpi-edit-last">{formatKpiAssignmentChange(kpi)}</p>
          )}
          <p className="kpi-edit-current-weight">
            Current weightage: <strong>{formatKpiWeight(kpi.weight)}</strong>
            {' · '}Score: <strong>{formatKpiScore(kpiAssignedScore(kpi))}</strong>
          </p>
          <div className="kpi-edit-viewed">
            <KpiViewedBadge kpi={kpi} />
          </div>
          <div className="kpi-edit-grid">
            <label className="kpi-edit-field">
              <span>Weightage</span>
              <input
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={weight}
                onChange={(e) => {
                  const next = e.target.value;
                  setWeight(next);
                  setScore((prev) => (prev === String(kpi.weight) || prev === weight ? next : prev));
                }}
              />
              <em>%</em>
            </label>
            <label className="kpi-edit-field">
              <span>Score</span>
              <input type="number" min={0} step={0.5} value={score} onChange={(e) => setScore(e.target.value)} />
            </label>
            <label className="kpi-edit-field">
              <span>Due date</span>
              <input type="date" value={endDate} min={kpi.start_date || undefined} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="kpi-edit-field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as Kpi['status'])}>
                <option value="on_track">Going well</option>
                <option value="at_risk">Needs attention</option>
                <option value="off_track">Behind</option>
              </select>
            </label>
            <label className="kpi-edit-field kpi-edit-field--wide">
              <span>Completion</span>
              <select value={completion} onChange={(e) => setCompletion(e.target.value as 'pending' | 'completed')}>
                <option value="pending">Not finished</option>
                <option value="completed">Complete</option>
              </select>
            </label>
          </div>
          <p className="studio-muted" style={{ marginTop: '0.35rem' }}>Score can be higher than weight. Points follow the task&apos;s scoring rule (shown on the card) when they mark Complete.</p>

          <div className="kpi-edit-score">
            <span>Updated overall score</span>
            <strong>{formatKpiScore(liveOverall)}</strong>
            {completion === 'pending' && (
              <p>Pending weight {formatKpiWeight(pendingWeight)} of {KPI_WEIGHT_CAP}%</p>
            )}
          </div>

          {error && <p className="kpi-edit-error">{error}</p>}

          {history.length > 0 && (
            <div className="kpi-edit-history">
              <h3>Change history</h3>
              <ul>
                {history.map((row, i) => (
                  <li key={`${row.created_at}-${i}`}>
                    <strong>{[row.editor_role, row.editor_name].filter(Boolean).join(' ') || 'Supervisor'}</strong>
                    <span>
                      {formatKpiEditTimestamp(row.created_at)}
                      {Object.keys(row.changes).length
                        ? ` · ${Object.entries(row.changes).map(([key, val]) => `${key}: ${String(val.from)} → ${String(val.to)}`).join('; ')}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="kpi-edit-dialog__foot">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 size={16} className="spin-icon" /> : null}
            Save changes
          </button>
        </footer>
      </div>
    </div>
  );
}
