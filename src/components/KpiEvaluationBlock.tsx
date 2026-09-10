import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Kpi, isKpiPaused, kpiPauseLabel } from '../utils/kpiHelpers';
import {
  EMPLOYEE_PROGRESS_OPTIONS,
  kpiCategoryMeta,
} from '../utils/kpiCategories';
import { isKpiLatePenaltyApplied } from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { formatLatePenaltyLabel, kpiScoringRule } from '../utils/kpiScoringRules';
import { emailKpiCompleted } from '../utils/kpiEmail';
import { PauseCircle } from 'lucide-react';
import KpiOptionPicker from './KpiOptionPicker';

type CompletionNotifyRow = {
  recipient_email?: string | null;
  recipient_name?: string | null;
  recipient_kind?: string | null;
  kpi_name?: string | null;
  employee_name?: string | null;
  due_date?: string | null;
};

export default function KpiEvaluationBlock({
  kpi,
  mode,
  onUpdated,
  compact,
}: {
  kpi: Kpi;
  mode: 'employee' | 'manager';
  onUpdated?: (patch: Partial<Kpi>) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const meta = kpiCategoryMeta(kpi.kpi_category);
  const scoring = kpiScoringRule(kpi);
  const penaltyLabel = formatLatePenaltyLabel(scoring);
  const complete = kpi.completion_status === 'completed';
  const paused = isKpiPaused(kpi);
  const pauseText = kpiPauseLabel(kpi);
  const latePenalized = isKpiLatePenaltyApplied(kpi);

  const setProgress = async (id: string) => {
    if (paused) {
      setError('This task is currently paused. Resume it to update progress.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data, error: rpcErr } = await supabase.rpc('set_employee_kpi_progress', {
        p_kpi_id: kpi.id,
        p_progress: id,
      });
      if (rpcErr) throw rpcErr;
      onUpdated?.({
        employee_progress: id === 'completed' ? 'completed' : 'started',
        completion_status: id === 'completed' ? 'completed' : 'pending',
        completed_at: id === 'completed' ? new Date().toISOString() : null,
      });

      if (id === 'completed') {
        const rows = (Array.isArray(data) ? data : data ? [data] : []) as CompletionNotifyRow[];
        await Promise.all(
          rows
            .filter((r) => r.recipient_email)
            .map((r) =>
              emailKpiCompleted({
                toEmail: String(r.recipient_email),
                toName: String(r.recipient_name || ''),
                employeeName: String(r.employee_name || 'Teammate'),
                kpiName: String(r.kpi_name || kpi.name),
                dueDate: r.due_date || kpi.end_date || undefined,
                recipientKind: r.recipient_kind === 'assigner' ? 'assigner' : 'manager',
              }),
            ),
        );
      }
    } catch (e) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : '';
      setError(msg || (e instanceof Error ? e.message : 'Could not save status.'));
    } finally {
      setBusy(false);
    }
  };

  const timing = paused
    ? (pauseText || 'Paused — due date will extend on resume')
    : !complete
      ? (pauseText ? `${pauseText} · Weightage when marked Complete` : 'Weightage when marked Complete')
      : latePenalized
        ? `Achieved ${formatKpiWeight(kpi.weight)} (late)`
        : `Achieved ${formatKpiWeight(kpi.weight)} (on time)`;

  return (
    <div className={`kpi-eval${compact ? ' kpi-eval--compact' : ''}`}>
      {!compact && <p className="kpi-eval__cat">{meta.label}</p>}
      {penaltyLabel && <p className="kpi-eval__rule">{penaltyLabel}</p>}
      {paused && (
        <div className="kpi-paused-banner" role="status">
          <PauseCircle size={14} />
          <span>Paused for an urgent task. Due date will extend by the paused days when resumed.</span>
        </div>
      )}
      {mode === 'employee' && (
        <KpiOptionPicker
          legend={compact ? 'Status' : 'Your status'}
          name={`emp-${kpi.id}`}
          options={EMPLOYEE_PROGRESS_OPTIONS}
          value={kpi.employee_progress === 'completed' ? 'completed' : kpi.employee_progress ? 'started' : ''}
          onChange={(id) => void setProgress(id)}
          disabled={busy || paused}
        />
      )}
      <p className="kpi-eval__hint">{timing}</p>
      {error && <p className="kpi-eval__err">{error}</p>}
    </div>
  );
}
