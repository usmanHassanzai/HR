import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye } from 'lucide-react';
import type { Kpi } from '../utils/kpiHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import '../styles/kpi-task-brief.css';

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

interface KpiTaskBriefProps {
  kpi: Pick<Kpi, 'name' | 'description' | 'kpi_category' | 'weight' | 'start_date' | 'end_date'>;
  /** Compact table cell: name + View button only. */
  compact?: boolean;
  /** When name is already shown outside (e.g. card title). */
  hideName?: boolean;
}

/**
 * Shows KPI name cleanly; long descriptions open in a professional modal
 * instead of wrapping awkwardly in narrow table columns.
 */
export default function KpiTaskBrief({ kpi, compact = true, hideName = false }: KpiTaskBriefProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const description = kpi.description?.trim() || '';
  const hasDescription = description.length > 0;
  const category = kpiCategoryMeta(kpi.kpi_category);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const dialog = open
    ? createPortal(
        <div
          className="kpi-task-brief__overlay"
          role="presentation"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="kpi-task-brief__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="kpi-task-brief__dialog-head">
              <div className="kpi-task-brief__dialog-titles">
                <span className="kpi-task-brief__eyebrow">{category.label}</span>
                <h2 id={titleId}>{kpi.name}</h2>
              </div>
              <button
                type="button"
                className="scorr-dialog-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            </header>

            <dl className="kpi-task-brief__meta">
              <div>
                <dt>Weightage</dt>
                <dd>{formatKpiWeight(Number(kpi.weight || 0))}</dd>
              </div>
              <div>
                <dt>Dates</dt>
                <dd>{fmtDate(kpi.start_date)} – {fmtDate(kpi.end_date)}</dd>
              </div>
            </dl>

            <section className="kpi-task-brief__body">
              <h3>Task details</h3>
              <p>{description}</p>
            </section>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`kpi-task-brief${compact ? ' kpi-task-brief--compact' : ''}`}>
      {!hideName && (
        <strong className="kpi-task-brief__name" title={kpi.name}>{kpi.name}</strong>
      )}
      {hasDescription ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm kpi-task-brief__btn"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <Eye size={13} />
          View task
        </button>
      ) : (
        !hideName && <span className="kpi-task-brief__none">No description</span>
      )}
      {dialog}
    </div>
  );
}
