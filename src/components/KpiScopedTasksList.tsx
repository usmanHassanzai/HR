import { Check } from 'lucide-react';
import type { Kpi } from '../utils/kpiHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { isKpiLateCompletion, kpiAssignedScore, kpiScoreContribution } from '../utils/kpiScoreHelpers';
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
              <th>Score</th>
              <th>Awarded</th>
              <th>Status &amp; Completion</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((kpi) => {
              const isDone = kpi.completion_status === 'completed';
              const isLate = isKpiLateCompletion(kpi);
              const awarded = kpiScoreContribution(kpi);
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
                  <td className="kpi-scope-tasks__num">{kpi.weight || 0}%</td>
                  <td className="kpi-scope-tasks__num">{kpiAssignedScore(kpi)}</td>
                  <td>
                    <strong className={isDone ? (isLate ? 'kpi-scope-tasks__late' : 'kpi-scope-tasks__awarded') : 'kpi-scope-tasks__open'}>
                      {isDone ? String(awarded) : '0 (open)'}
                    </strong>
                    {isDone && isLate && (
                      <span className="kpi-scope-tasks__late-note">50% late deduction</span>
                    )}
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
          const isLate = isKpiLateCompletion(kpi);
          const awarded = kpiScoreContribution(kpi);
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
                  <dd>{kpi.weight || 0}%</dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd>{kpiAssignedScore(kpi)}</dd>
                </div>
                <div>
                  <dt>Awarded</dt>
                  <dd className={isDone ? (isLate ? 'kpi-scope-tasks__late' : 'kpi-scope-tasks__awarded') : 'kpi-scope-tasks__open'}>
                    {isDone ? String(awarded) : '0'}
                  </dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>{completedDateStr || (isDone ? '—' : 'Open')}</dd>
                </div>
              </dl>

              {isDone && isLate && (
                <p className="kpi-scope-tasks__late-note">50% late deduction applied</p>
              )}

              {kpi.description?.trim() ? (
                <div className="kpi-scope-tasks__card-actions">
                  <KpiTaskBrief kpi={kpi} hideName />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
