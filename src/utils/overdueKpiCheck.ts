import { supabase } from '../lib/supabase';

const OVERDUE_KEY = 'scorr-overdue-kpi-check';
const OVERDUE_TTL_MS = 30 * 60 * 1000; // once per 30 minutes per browser tab session

/**
 * Org-wide overdue KPI scan. Must not run on every dashboard mount —
 * that stamps every concurrent login against the same rows.
 */
export function runOverdueKpiCheckOnce(): void {
  try {
    const raw = sessionStorage.getItem(OVERDUE_KEY);
    const last = raw ? Number(raw) : 0;
    if (Number.isFinite(last) && Date.now() - last < OVERDUE_TTL_MS) return;
    sessionStorage.setItem(OVERDUE_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
  void supabase.rpc('check_overdue_kpis').then(() => undefined, () => undefined);
}
