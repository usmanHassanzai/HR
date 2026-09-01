import { useState, type ReactNode } from 'react';

export interface KpiWorkspacePane {
  id: string;
  label: string;
  hint?: string;
  content: ReactNode;
}

export default function KpiWorkspace({
  panes,
  defaultPane,
}: {
  panes: KpiWorkspacePane[];
  defaultPane?: string;
}) {
  const [active, setActive] = useState(defaultPane || panes[0]?.id);
  const current = panes.find((p) => p.id === active) || panes[0];

  return (
    <div className="kpi-workbench">
      <div className="kpi-workbench__switch" role="tablist" aria-label="KPI workspace">
        {panes.map((pane) => (
          <button
            key={pane.id}
            type="button"
            role="tab"
            aria-selected={pane.id === current.id}
            className={`kpi-workbench__tab${pane.id === current.id ? ' kpi-workbench__tab--active' : ''}`}
            onClick={() => setActive(pane.id)}
          >
            {pane.label}
          </button>
        ))}
      </div>
      {current?.hint && <p className="kpi-workbench__hint">{current.hint}</p>}
      <div className="kpi-workbench__body">{current?.content}</div>
    </div>
  );
}
