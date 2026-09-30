import { useState } from 'react';
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { isKpiAwaitingReview, type Kpi } from '../utils/kpiHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { kpiAssignedScore } from '../utils/kpiScoreHelpers';
import { emailKpiWeightageAwarded } from '../utils/kpiEmail';

type ReviewResult = {
  ok?: boolean;
  approved?: boolean;
  kpi_name?: string;
  assigned_score?: number;
  assignee_email?: string | null;
  assignee_name?: string | null;
  assignee_role?: string | null;
  reviewer_name?: string | null;
  note?: string | null;
};

/** Manager / admin / HR: set final weightage for a task waiting on review. */
export default function ReviewKpiCompletionPanel({
  kpi,
  onUpdated,
}: {
  kpi: Kpi;
  onUpdated: () => void;
}) {
  const awaiting = isKpiAwaitingReview(kpi);
  const taskWeight = Math.max(0, Number(kpi.weight || 0));
  const defaultScore = Math.min(kpiAssignedScore(kpi) || taskWeight, taskWeight);
  const [score, setScore] = useState(String(defaultScore));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!awaiting) return null;

  const runReview = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const finalScore = Number(score);
      if (approve && (!Number.isFinite(finalScore) || finalScore < 0 || finalScore > taskWeight)) {
        throw new Error(`Enter a score between 0 and ${formatKpiWeight(taskWeight)} (this task's weight).`);
      }
      const { data, error: rpcErr } = await supabase.rpc('review_kpi_completion', {
        p_kpi_id: kpi.id,
        p_final_score: approve ? finalScore : defaultScore,
        p_approve: approve,
        p_note: note.trim() || null,
      });
      if (rpcErr) throw rpcErr;

      const result = (data && typeof data === 'object' ? data : {}) as ReviewResult;
      // Email ONLY the person who owns this KPI (employee or manager) — never the whole team.
      const ownerEmail = String(result.assignee_email || '').trim();
      if (ownerEmail) {
        void emailKpiWeightageAwarded({
          toEmail: ownerEmail,
          toName: String(result.assignee_name || ''),
          kpiName: String(result.kpi_name || kpi.name),
          weightLabel: formatKpiWeight(Number(result.assigned_score ?? finalScore)),
          reviewerName: result.reviewer_name || undefined,
          note: result.note || note.trim() || undefined,
          approved: Boolean(result.approved ?? approve),
        });
      }

      onUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save review.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kpi-review-panel">
      <div className="kpi-review-panel__head">
        <CheckCircle2 size={16} />
        <div>
          <strong>Review completion</strong>
          <p>
            They marked this complete. Award up to this task&apos;s weight ({formatKpiWeight(taskWeight)}).
            You can give less based on performance — not more than was assigned.
            The weightage email goes only to this person&apos;s inbox and dashboard.
          </p>
        </div>
      </div>

      <label className="kpi-review-panel__field">
        <span>Weightage to award (max {formatKpiWeight(taskWeight)})</span>
        <input
          type="number"
          min={0}
          max={taskWeight || 100}
          step={0.01}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          disabled={busy}
        />
      </label>

      <label className="kpi-review-panel__field">
        <span>Note (optional)</span>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Feedback for the person"
          disabled={busy}
        />
      </label>

      <div className="kpi-review-panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void runReview(true)}
        >
          {busy ? <Loader2 size={14} className="spin-icon" /> : <CheckCircle2 size={14} />}
          Approve &amp; award
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void runReview(false)}
        >
          <RotateCcw size={14} />
          Send back
        </button>
      </div>
      {error ? <p className="kpi-review-panel__err">{error}</p> : null}
    </div>
  );
}
