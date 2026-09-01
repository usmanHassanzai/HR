import { Clock3 } from 'lucide-react';
import { formatKpiAssignmentChange, Kpi } from '../utils/kpiHelpers';

export default function KpiAssignmentEditNote({ kpi }: { kpi: Kpi }) {
  const text = formatKpiAssignmentChange(kpi);
  if (!text) return null;
  return (
    <p className="kpi-assignment-edit-note">
      <Clock3 size={14} strokeWidth={2.25} aria-hidden />
      {text}
    </p>
  );
}
