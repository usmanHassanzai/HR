import { DepartmentKpiIndicator, formatWeightPct } from '../utils/departmentHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';

interface DepartmentKpiBoardPreviewProps {
  departmentName: string;
  indicators: DepartmentKpiIndicator[];
  loading?: boolean;
}

export default function DepartmentKpiBoardPreview({ departmentName, indicators, loading }: DepartmentKpiBoardPreviewProps) {
  if (loading) {
    return <p className="dept-board-preview__loading">Loading KPI board…</p>;
  }

  if (indicators.length === 0) {
    return (
      <p className="dept-board-preview__empty">
        No KPI indicators configured for this department.
      </p>
    );
  }

  const total = indicators.reduce((s, i) => s + Number(i.weight_pct), 0);

  return (
    <div className="dept-board-preview">
      <h4>{departmentName} — Monthly KPI Board</h4>
      <p className="dept-board-preview__hint">
        Assigning uses each KPI&apos;s own weight. Combined assigned weight for this employee cannot exceed 100%. The department library total ({formatWeightPct(total)}) is not capped.
      </p>
      <ul className="dept-board-preview__list">
        {indicators.map((ind) => (
          <li key={ind.id}>
            <div className="dept-board-preview__metric">
              <strong>{ind.name}</strong>
              <span className="dept-weight-badge">{formatWeightPct(ind.weight_pct)}</span>
            </div>
            {ind.description && <p>{ind.description}</p>}
            <span className="dept-board-preview__weight">Employee weight share: {formatKpiWeight(ind.weight_pct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
