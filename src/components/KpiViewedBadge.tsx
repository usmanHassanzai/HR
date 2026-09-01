import { Eye, EyeOff } from 'lucide-react';
import { formatKpiViewedAt, isKpiViewedByAssignee, Kpi } from '../utils/kpiHelpers';

export default function KpiViewedBadge({ kpi }: { kpi: Kpi }) {
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
