import { Check } from 'lucide-react';
import type { Kpi } from '../utils/kpiHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import KpiTaskBrief from './KpiTaskBrief';
import '../styles/kpi-scope-tasks.css';

function completedDateLabel(kpi: Kpi, isDone: boolean): string | null {
  const raw = kpi.completed_at || (isDone ? kpi.updated_at : null);
  if (!raw) return null;
  return new Date(raw).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function KpiScopedTasksList({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="kpi-scope-tasks">
      <div className="kpi-scope-tasks__table-wrap admin-rewards-table-wrap">
        <table className="admin-rewards-table kpi-scope-tasks__table">
          <thead>
            <tr>
              <th>Task / KPI Name</th>
              <th>Category</th>
              <th>Weightage</th>
              <th>Achieved</th>
              <th>Status &amp; Completion</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((kpi) => {
              const isDone = kpi.completion_status === 'completed';
              const weight = Number(kpi.weight) || 0;
              const cat = kpiCategoryMeta(kpi.kpi_category);
              const completedDateStr = completedDateLabel(kpi, isDone);

              return (
                <tr key={kpi.id}>
                  <td>
                    <KpiTaskBrief kpi={kpi} />
                  </td>
                  <td>
                    <span className="kpi-scope-tasks__cat">{cat.label}</span>
                  </td>
                  <td className="kpi-scope-tasks__num">{formatKpiWeight(weight)}</td>
                  <td>
                    <strong className={isDone ? 'kpi-scope-tasks__awarded' : 'kpi-scope-tasks__open'}>
                      {isDone ? formatKpiWeight(weight) : '0% (open)'}
                    </strong>
                  </td>
                  <td>
                    {isDone ? (
                      <div>
                        <span className="badge badge-on-track kpi-scope-tasks__badge">
                          <Check size={11} aria-hidden /> Completed
                        </span>
                        {completedDateStr && (
                          <span className="kpi-scope-tasks__done-date">{completedDateStr}</span>
                        )}
                      </div>
                    ) : (
                      <span className="kpi-scope-tasks__open">In progress</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="kpi-scope-tasks__cards" aria-label="Tasks in scope">
        {kpis.map((kpi) => {
          const isDone = kpi.completion_status === 'completed';
          const weight = Number(kpi.weight) || 0;
          const cat = kpiCategoryMeta(kpi.kpi_category);
          const completedDateStr = completedDateLabel(kpi, isDone);

          return (
            <li key={kpi.id} className="kpi-scope-tasks__card">
              <div className="kpi-scope-tasks__card-top">
                <div className="kpi-scope-tasks__card-title">
                  <span className="kpi-scope-tasks__card-cat">{cat.label}</span>
                  <strong>{kpi.name}</strong>
                </div>
                {isDone ? (
                  <span className="badge badge-on-track kpi-scope-tasks__badge">
                    <Check size={11} aria-hidden /> Done
                  </span>
                ) : (
                  <span className="kpi-scope-tasks__status-open">In progress</span>
                )}
              </div>

              <dl className="kpi-scope-tasks__card-grid">
                <div>
                  <dt>Weightage</dt>
                  <dd>{formatKpiWeight(weight)}</dd>
                </div>
                <div>
                  <dt>Achieved</dt>
                  <dd className={isDone ? 'kpi-scope-tasks__awarded' : 'kpi-scope-tasks__open'}>
                    {isDone ? formatKpiWeight(weight) : '0%'}
                  </dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>{completedDateStr || (isDone ? '—' : 'Open')}</dd>
                </div>
              </dl>

              <KpiTaskBrief kpi={kpi} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
