import { useMemo, useState } from 'react';
import { Trash2, Building2, ChevronDown, ChevronRight, User, Calendar } from 'lucide-react';
import { Kpi } from '../utils/kpiHelpers';
import { formatWeightPct } from '../utils/departmentHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { DepartmentAssignmentSection } from '../utils/assignTaskHelpers';

type Props = {
  sections: DepartmentAssignmentSection[];
  onDelete: (kpiId: string) => void;
  fmt: (d?: string | null) => string;
  /** Show employees even when they have zero tasks (admin dept view). */
  showEmptyEmployees?: boolean;
  defaultExpanded?: boolean;
};

function statusBadgeClass(kpi: Kpi): string {
  return kpi.completion_status === 'completed' ? 'on-track' : kpi.status.replace('_', '-');
}

function statusLabel(kpi: Kpi): string {
  return kpi.completion_status === 'completed' ? 'completed' : kpi.status.replace('_', ' ');
}

export default function DepartmentAssignmentsOverview({
  sections,
  onDelete,
  fmt,
  showEmptyEmployees = false,
  defaultExpanded = true,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((s) => [s.deptId, defaultExpanded])),
  );

  const toggle = (deptId: string) => {
    setExpanded((prev) => ({ ...prev, [deptId]: !prev[deptId] }));
  };

  const visibleSections = useMemo(() => {
    if (!showEmptyEmployees) return sections.filter((s) => s.taskCount > 0);
    return sections;
  }, [sections, showEmptyEmployees]);

  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <div className="assign-dept-tree">
      {visibleSections.map((section) => {
        const isOpen = expanded[section.deptId] ?? defaultExpanded;
        const pending = section.employees.reduce(
          (n, g) => n + g.tasks.filter((t) => t.completion_status !== 'completed').length,
          0,
        );
        const completed = section.taskCount - pending;
        const employeeCount = section.employees.length;
        const withTasks = section.employees.filter((g) => g.tasks.length > 0).length;

        return (
          <section key={section.deptId} className="assign-dept-tree__section">
            <header className="assign-dept-tree__head">
              <button
                type="button"
                className="assign-dept-tree__toggle"
                onClick={() => toggle(section.deptId)}
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                <div className="assign-dept-tree__head-icon">
                  <Building2 size={18} />
                </div>
                <div className="assign-dept-tree__head-text">
                  <h4>{section.deptName}</h4>
                  <p>
                    {employeeCount} employee{employeeCount !== 1 ? 's' : ''}
                    {withTasks !== employeeCount && showEmptyEmployees && (
                      <> · {withTasks} with tasks</>
                    )}
                    {' · '}
                    {section.taskCount} task{section.taskCount !== 1 ? 's' : ''}
                    {section.orgWeight != null && (
                      <> · {formatWeightPct(section.orgWeight)} org weight</>
                    )}
                  </p>
                </div>
              </button>
              <div className="assign-dept-tree__chips">
                {pending > 0 && (
                  <span className="assign-dept-tree__chip assign-dept-tree__chip--pending">
                    {pending} active
                  </span>
                )}
                {completed > 0 && (
                  <span className="assign-dept-tree__chip assign-dept-tree__chip--done">
                    {completed} done
                  </span>
                )}
                {section.taskCount === 0 && (
                  <span className="assign-dept-tree__chip assign-dept-tree__chip--muted">
                    No tasks
                  </span>
                )}
              </div>
            </header>

            {isOpen && (
              <div className="assign-dept-tree__employees">
                {section.employees.length === 0 ? (
                  <div className="assign-dept-tree__empty-dept">
                    No employees in this department yet.
                  </div>
                ) : (
                  section.employees.map(({ employee, tasks }) => (
                    <article key={employee.id} className="assign-dept-tree__employee">
                      <div className="assign-dept-tree__employee-head">
                        <div className="assign-dept-tree__employee-id">
                          <User size={15} />
                          <strong>{employee.full_name}</strong>
                        </div>
                        <span>
                          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                        </span>
                      </div>

                      {tasks.length === 0 ? (
                        <div className="assign-dept-tree__no-tasks">
                          No KPI tasks assigned yet.
                        </div>
                      ) : (
                        <div className="assign-dept-tree__tasks">
                          {tasks.map((kpi) => (
                            <div key={kpi.id} className="assign-dept-tree__task">
                              <div className="assign-dept-tree__task-main">
                                <div>
                                  <strong>{kpi.name}</strong>
                                  <div className="assign-dept-tree__task-badges">
                                    <span className={`badge badge-${statusBadgeClass(kpi)}`}>
                                      {statusLabel(kpi)}
                                    </span>
                                    <span className="assign-dept-tree__weight">
                                      {formatKpiWeight(kpi.weight)}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm assign-dept-tree__delete"
                                  onClick={() => onDelete(kpi.id)}
                                  title="Remove assignment"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                              {kpi.description && (
                                <p className="assign-dept-tree__task-desc">
                                  {kpi.description.length > 140
                                    ? `${kpi.description.slice(0, 140)}…`
                                    : kpi.description}
                                </p>
                              )}
                              <div className="assign-dept-tree__task-meta">
                                <Calendar size={12} />
                                {fmt(kpi.start_date)} → {fmt(kpi.end_date)}
                                {(kpi.redo_count ?? 0) > 0 && (
                                  <> · Redos: {kpi.redo_count}/3</>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  ))
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
