import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { DepartmentKpiIndicator, formatWeightPct } from '../utils/departmentHelpers';

interface KpiIndicatorSelectorProps {
  indicators: DepartmentKpiIndicator[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  loading?: boolean;
  emptyHint?: string;
}

export default function KpiIndicatorSelector({
  indicators,
  selectedIds,
  onToggle,
  onSelectAll,
  onClearAll,
  loading,
  emptyHint = 'Create KPI tasks under the Create KPIs tab first.',
}: KpiIndicatorSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const selected = indicators.filter((i) => selectedIds.includes(i.id));

  const orderedIndicators = [...indicators].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name),
  );

  const triggerLabel = () => {
    if (loading) return 'Loading KPI tasks…';
    if (indicators.length === 0) return 'No KPI tasks available';
    if (selectedIds.length === 0) return '— Select KPI tasks —';
    if (selectedIds.length === 1) return selected[0]?.name || '1 KPI selected';
    return `${selectedIds.length} KPI tasks selected`;
  };

  return (
    <div className="form-group kpi-multi-select" style={{ margin: 0 }} ref={rootRef}>
      <label>KPI Tasks to Assign</label>

      <button
        type="button"
        className="kpi-multi-select__trigger"
        onClick={() => !loading && indicators.length > 0 && setOpen((v) => !v)}
        disabled={loading || indicators.length === 0}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="kpi-multi-select__trigger-text">{triggerLabel()}</span>
        <ChevronDown size={18} className={`kpi-multi-select__chevron${open ? ' kpi-multi-select__chevron--open' : ''}`} />
      </button>

      {open && indicators.length > 0 && (
        <div className="kpi-multi-select__menu" role="listbox" aria-multiselectable="true">
          <div className="kpi-multi-select__menu-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onSelectAll}>
              Select all
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClearAll}>
              Clear all
            </button>
          </div>
          <div className="kpi-multi-select__options">
            {orderedIndicators.map((ind) => {
              const checked = selectedIds.includes(ind.id);
              return (
                <button
                  key={ind.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={`kpi-multi-select__option${checked ? ' kpi-multi-select__option--selected' : ''}`}
                  onClick={() => onToggle(ind.id)}
                >
                  <span className={`kpi-multi-select__check${checked ? ' kpi-multi-select__check--on' : ''}`}>
                    {checked && <Check size={14} strokeWidth={3} />}
                  </span>
                  <span className="kpi-multi-select__option-body">
                    <span className="kpi-multi-select__option-title">
                      <strong>{ind.name}</strong>
                      <span className="dept-weight-badge">{formatWeightPct(ind.weight_pct)}</span>
                    </span>
                    {ind.description && (
                      <span className="kpi-multi-select__option-desc">{ind.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selected.length > 0 && (
        <div className="kpi-multi-select__chips">
          {orderedIndicators.filter((i) => selectedIds.includes(i.id)).map((ind) => (
            <button
              key={ind.id}
              type="button"
              className="kpi-multi-select__chip"
              onClick={() => onToggle(ind.id)}
              title="Click to remove"
            >
              {ind.name}
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}

      {!loading && indicators.length === 0 && (
        <p className="kpi-multi-select__hint">{emptyHint}</p>
      )}

      {!loading && indicators.length > 0 && (
        <p className="kpi-multi-select__hint">
          {selectedIds.length} of {indicators.length} selected — open the dropdown to add or remove tasks.
        </p>
      )}
    </div>
  );
}
