import { Eye, EyeOff } from 'lucide-react';
import { formatKpiViewedAt, isKpiViewedByAssignee, Kpi } from '../utils/kpiHelpers';

/** Opened / not-opened badge for assignees. Hidden once approved — that status already means the work is done. */
export default function KpiViewedBadge({ kpi }: { kpi: Kpi }) {
  const approved = kpi.completion_status === 'completed';
  const awaitingReview = kpi.completion_status === 'pending_review';

  // Approved or submitted for review — don't show "Not opened yet" (misleading after award).
  if (approved || awaitingReview) {
    if (isKpiViewedByAssignee(kpi)) {
      return (
        <span className="kpi-view-badge kpi-view-badge--viewed" title={`Opened in Scorr ${formatKpiViewedAt(kpi.viewed_at)}`}>
          <Eye size={12} />
          Opened · {formatKpiViewedAt(kpi.viewed_at)}
        </span>
      );
    }
    return null;
  }

  if (isKpiViewedByAssignee(kpi)) {
    return (
      <span className="kpi-view-badge kpi-view-badge--viewed" title={`Opened in Scorr ${formatKpiViewedAt(kpi.viewed_at)}`}>
        <Eye size={12} />
        Opened · {formatKpiViewedAt(kpi.viewed_at)}
      </span>
    );
  }

  return (
    <span className="kpi-view-badge kpi-view-badge--unread" title="They have not opened this task in Scorr yet. An email does not start it.">
      <EyeOff size={12} />
      Not opened yet
    </span>
  );
}
