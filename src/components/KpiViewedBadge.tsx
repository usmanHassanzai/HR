import { Eye, EyeOff } from 'lucide-react';
import { formatKpiViewedAt, isKpiViewedByAssignee, Kpi } from '../utils/kpiHelpers';

/** Viewed / not-viewed badge for assignees. Hidden once approved — that status already means the work is done. */
export default function KpiViewedBadge({ kpi }: { kpi: Kpi }) {
  const approved = kpi.completion_status === 'completed';
  const awaitingReview = kpi.completion_status === 'pending_review';

  // Approved or submitted for review — don't show "Not viewed yet" (misleading after award).
  if (approved || awaitingReview) {
    if (isKpiViewedByAssignee(kpi)) {
      return (
        <span className="kpi-view-badge kpi-view-badge--viewed" title={`Viewed by assignee ${formatKpiViewedAt(kpi.viewed_at)}`}>
          <Eye size={12} />
          Viewed · {formatKpiViewedAt(kpi.viewed_at)}
        </span>
      );
    }
    return null;
  }

  if (isKpiViewedByAssignee(kpi)) {
    return (
      <span className="kpi-view-badge kpi-view-badge--viewed" title={`Viewed by assignee ${formatKpiViewedAt(kpi.viewed_at)}`}>
        <Eye size={12} />
        Viewed · {formatKpiViewedAt(kpi.viewed_at)}
      </span>
    );
  }

  return (
    <span className="kpi-view-badge kpi-view-badge--unread" title="Assignee has not opened this task in Scorr yet. An email does not count as viewed.">
      <EyeOff size={12} />
      Not viewed yet
    </span>
  );
}
