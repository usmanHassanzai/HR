import { formatKpiAssignmentChange, Kpi } from '../utils/kpiHelpers';
import KpiAssignmentEditNote from './KpiAssignmentEditNote';

interface KpiAssignmentDetailsProps {
  kpi?: Kpi;
  kpiId?: string;
  description?: string | null;
  assignmentNotes?: string | null;
  showLastEdit?: boolean;
  /** Collapse admin edit history so the card stays scannable. */
  compact?: boolean;
}

export default function KpiAssignmentDetails({
  kpi,
  description,
  assignmentNotes,
  showLastEdit = true,
  compact = false,
}: KpiAssignmentDetailsProps) {
  const library = description?.trim() || kpi?.description?.trim() || '';
  const notes = assignmentNotes?.trim() || kpi?.assignment_notes?.trim() || '';

  const hasEdit = Boolean(showLastEdit && kpi && formatKpiAssignmentChange(kpi));
  if (!library && !notes && !hasEdit) return null;

  return (
    <div className={`kpi-assignment-details${compact ? ' kpi-assignment-details--compact' : ''}`}>
      {hasEdit && kpi && (
        compact ? (
          <details className="kpi-history">
            <summary>Last update</summary>
            <KpiAssignmentEditNote kpi={kpi} />
          </details>
        ) : (
          <KpiAssignmentEditNote kpi={kpi} />
        )
      )}
      {library && library !== notes && (
        <p className="kpi-desc">{library}</p>
      )}
      {notes && (
        <div className="kpi-assign-note">
          <strong>Note</strong>
          <p>{notes}</p>
        </div>
      )}
    </div>
  );
}
