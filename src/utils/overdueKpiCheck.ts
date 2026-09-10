import { supabase } from '../lib/supabase';

const OVERDUE_KEY = 'scorr-overdue-kpi-check';
const OVERDUE_TTL_MS = 30 * 60 * 1000; // once per 30 minutes per browser tab

type OverdueRow = {
  emp_email?: string;
  emp_name?: string;
  department?: string;
  end_date?: string;
  redo_count?: number;
};

/**
 * Org-wide overdue KPI scan. Must not run on every dashboard mount —
 * that stamps every concurrent login against the same rows.
 */
export function runOverdueKpiCheckOnce(
  onRows?: (rows: OverdueRow[]) => void,
): void {
  let skip = false;
  try {
    const raw = sessionStorage.getItem(OVERDUE_KEY);
    const last = raw ? Number(raw) : 0;
    if (Number.isFinite(last) && Date.now() - last < OVERDUE_TTL_MS) skip = true;
    else sessionStorage.setItem(OVERDUE_KEY, String(Date.now()));
  } catch {
    /* private mode — still run once this mount path */
  }
  if (skip) return;

  void supabase.rpc('check_overdue_kpis').then(({ data }) => {
    onRows?.(((data as OverdueRow[]) || []));
  }, () => undefined);
}
