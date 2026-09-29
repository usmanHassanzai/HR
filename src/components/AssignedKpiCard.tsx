import { useState } from 'react';
import { Pencil, Trash2, Pause, Play, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Kpi, kpiHealthLabel, kpiProgressBadge, kpiWorkStage, isKpiPaused, kpiPauseLabel, isKpiAwaitingReview } from '../utils/kpiHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { isKpiLatePenaltyApplied, kpiAssignedScore } from '../utils/kpiScoreHelpers';
import { formatLatePenaltyLabel, kpiScoringRule } from '../utils/kpiScoringRules';
import KpiAssignmentEditNote from './KpiAssignmentEditNote';
import KpiViewedBadge from './KpiViewedBadge';
import KpiTaskBrief from './KpiTaskBrief';
import ReviewKpiCompletionPanel from './ReviewKpiCompletionPanel';

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function AssignedKpiCard({
  kpi,
  onEdit,
  onRemove,
  onUpdated,
}: {
  kpi: Kpi;
  employeeName: string;
  onEdit: () => void;
  onRemove: () => void;
  onUpdated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pauseErr, setPauseErr] = useState('');
  const category = kpiCategoryMeta(kpi.kpi_category);
  const scoring = kpiScoringRule(kpi);
  const penaltyLabel = formatLatePenaltyLabel(scoring);
  const description = kpi.description?.trim() || '';
  const notes = kpi.assignment_notes?.trim() || '';
  const stage = kpiWorkStage(kpi);
  const progressLabel = kpiProgressBadge(kpi).label;
  const healthLabel = kpiHealthLabel(kpi.status);
  const paused = isKpiPaused(kpi);
  const pauseInfo = kpiPauseLabel(kpi);
  const isCompleted = kpi.completion_status === 'completed';
  const awaitingReview = isKpiAwaitingReview(kpi);
  const latePenalized = isKpiLatePenaltyApplied(kpi);

  const progress = isCompleted
    ? (latePenalized
      ? `Approved after the due date — late penalty applied (${scoring.penaltyValue}% of score)`
      : `Approved — awarded ${formatKpiWeight(kpiAssignedScore(kpi))}`)
    : awaitingReview
      ? 'They marked Complete — set the final weightage below to approve'
      : paused
        ? (pauseInfo || 'Paused — due date will move forward when resumed')
        : stage === 'in_progress'
          ? 'They opened this in Scorr — in progress'
          : 'Not started yet (email does not start it)';

  const handleTogglePause = async () => {
    setBusy(true);
    setPauseErr('');
    try {
      if (paused) {
        const { error } = await supabase.rpc('resume_assigned_kpi', { p_kpi_id: kpi.id });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc('pause_assigned_kpi', { p_kpi_id: kpi.id });
        if (error) throw error;
      }
      onUpdated();
    } catch (err: unknown) {
      setPauseErr(err instanceof Error ? err.message : 'Could not change task state.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-nav-id={kpi.id}
      className={`assigned-kpi-card${paused ? ' assigned-kpi-card--paused' : ''}${awaitingReview ? ' assigned-kpi-card--review' : ''}`}
    >
      <header className="assigned-kpi-card__head">
        <div>
          <div className="assigned-kpi-card__tags">
            <span className="studio-tag">{category.label}</span>
            {awaitingReview ? <span className="studio-tag studio-tag--warn">Needs review</span> : null}
            {penaltyLabel ? <span className="studio-tag studio-tag--warn">{penaltyLabel}</span> : null}
          </div>
          <h3>{kpi.name}</h3>
        </div>
        <div className="studio-kpi__actions">
          {!isCompleted && !awaitingReview && (
            <button
              type="button"
              className={`studio-action${paused ? ' studio-action--resume' : ''}`}
              onClick={() => void handleTogglePause()}
              disabled={busy}
              title={paused ? 'Resume task and move due date forward' : 'Pause task while they work on an urgent task'}
            >
              {busy ? (
                <Loader2 size={14} className="spin-icon" />
              ) : paused ? (
                <Play size={14} strokeWidth={2.25} />
              ) : (
                <Pause size={14} strokeWidth={2.25} />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button type="button" className="studio-action" onClick={onEdit}>
            <Pencil size={14} strokeWidth={2.25} />
            Edit
          </button>
          {!isCompleted && !awaitingReview ? (
            <button type="button" className="studio-action studio-action--danger" onClick={onRemove}>
              <Trash2 size={14} strokeWidth={2.25} />
              Remove
            </button>
          ) : null}
        </div>
      </header>

      {pauseErr && <p className="assigned-kpi-card__error">{pauseErr}</p>}

      <dl className="assigned-kpi-card__facts">
        <div>
          <dt>Weight</dt>
          <dd>{formatKpiWeight(Number(kpi.weight || 0))}</dd>
        </div>
        <div>
          <dt>Start</dt>
          <dd>{fmtDate(kpi.start_date)}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{fmtDate(kpi.end_date)}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd>{progressLabel}</dd>
        </div>
        <div>
          <dt>Health</dt>
          <dd>{healthLabel}</dd>
        </div>
        <div>
          <dt>Achieved</dt>
          <dd>
            {isCompleted
              ? formatKpiWeight(kpiAssignedScore(kpi))
              : awaitingReview
                ? 'Awaiting review'
                : 'Open'}
          </dd>
        </div>
      </dl>

      {description ? (
        <div className="assigned-kpi-card__block">
          <h4>What this task is</h4>
          <KpiTaskBrief kpi={kpi} compact={false} hideName />
        </div>
      ) : (
        <div className="assigned-kpi-card__block assigned-kpi-card__block--muted">
          <h4>What this task is</h4>
          <p>No description was added when this KPI was created.</p>
        </div>
      )}

      {notes ? (
        <div className="assigned-kpi-card__block">
          <h4>Assignment details</h4>
          <p>{notes}</p>
        </div>
      ) : null}

      <p className="assigned-kpi-card__progress">{progress}</p>
      <ReviewKpiCompletionPanel kpi={kpi} onUpdated={onUpdated} />
      <KpiViewedBadge kpi={kpi} />
      <KpiAssignmentEditNote kpi={kpi} />
    </article>
  );
}
