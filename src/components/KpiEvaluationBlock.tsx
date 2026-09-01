import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Kpi, isKpiPaused, kpiPauseLabel } from '../utils/kpiHelpers';
import {
  EMPLOYEE_PROGRESS_OPTIONS,
  kpiCategoryMeta,
} from '../utils/kpiCategories';
import { formatKpiScore, kpiScoreContribution, isKpiLateCompletion } from '../utils/kpiScoreHelpers';
import { PauseCircle } from 'lucide-react';
import KpiOptionPicker from './KpiOptionPicker';

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
  const awarded = kpiScoreContribution(kpi);
  const complete = kpi.completion_status === 'completed';
  const paused = isKpiPaused(kpi);
  const pauseText = kpiPauseLabel(kpi);

  const setProgress = async (id: string) => {
    if (paused) {
      setError('This task is currently paused. Resume it to update progress.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: rpcErr } = await supabase.rpc('set_employee_kpi_progress', {
        p_kpi_id: kpi.id,
        p_progress: id,
      });
      if (rpcErr) throw rpcErr;
      onUpdated?.({
        employee_progress: id === 'completed' ? 'completed' : 'started',
        completion_status: id === 'completed' ? 'completed' : 'pending',
        completed_at: id === 'completed' ? new Date().toISOString() : null,
      });
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
      ? (pauseText ? `${pauseText} · Points when marked Complete` : 'Points when marked Complete')
      : isKpiLateCompletion(kpi)
        ? `Awarded ${formatKpiScore(awarded)} pts (half — after due date)`
        : `Awarded ${formatKpiScore(awarded)} pts (on time)`;

  return (
    <div className={`kpi-eval${compact ? ' kpi-eval--compact' : ''}`}>
      {!compact && <p className="kpi-eval__cat">{meta.label}</p>}
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
