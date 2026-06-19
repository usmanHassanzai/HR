/**
 * Phase 3 — Advanced Analytics
 *
 * Pure helpers for trend series, period-over-period comparison, status
 * distribution, and a lightweight predictive forecast (ordinary least
 * squares linear regression). No external charting/ML dependencies — the
 * UI renders inline SVG from these primitives.
 */
import { supabase } from '../lib/supabase';
import { Kpi, KpiSubmission, Profile, calculateHealthScore } from './kpiHelpers';

export interface AnalyticsData {
  users: Profile[];
  kpis: Kpi[];
  submissions: KpiSubmission[];
}

export async function fetchAnalyticsData(userId?: string): Promise<AnalyticsData> {
  const usersQuery = supabase.from('users').select('*');
  const kpisQuery = userId
    ? supabase.from('kpis').select('*').eq('user_id', userId)
    : supabase.from('kpis').select('*');
  const subsQuery = userId
    ? supabase.from('kpi_submissions').select('*').eq('user_id', userId)
    : supabase.from('kpi_submissions').select('*');

  const [usersRes, kpisRes, subsRes] = await Promise.all([usersQuery, kpisQuery, subsQuery]);
  if (usersRes.error) throw new Error(usersRes.error.message);
  if (kpisRes.error) throw new Error(kpisRes.error.message);
  if (subsRes.error) throw new Error(subsRes.error.message);

  return {
    users: (usersRes.data || []) as Profile[],
    kpis: (kpisRes.data || []) as Kpi[],
    submissions: (subsRes.data || []) as KpiSubmission[],
  };
}

export interface TimePoint {
  label: string; // e.g. "Jun"
  value: number;
}

/** Build a monthly average series for a set of submissions. */
export function monthlyTrend(submissions: KpiSubmission[], months = 6): TimePoint[] {
  const now = new Date();
  const buckets: { label: string; key: string; sum: number; count: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      label: d.toLocaleString('default', { month: 'short' }),
      key: `${d.getFullYear()}-${d.getMonth()}`,
      sum: 0,
      count: 0,
    });
  }
  for (const s of submissions) {
    const d = new Date(s.created_at);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const b = buckets.find((x) => x.key === key);
    if (b) {
      b.sum += Number(s.value);
      b.count += 1;
    }
  }
  return buckets.map((b) => ({ label: b.label, value: b.count ? b.sum / b.count : 0 }));
}

export interface Forecast {
  slope: number;
  nextValue: number;
  direction: 'up' | 'down' | 'flat';
  confidence: number; // 0-1 (R²)
}

/** Ordinary least squares regression over a numeric series → next-period projection. */
export function linearForecast(values: number[]): Forecast {
  const pts = values.map((y, x) => ({ x, y })).filter((p) => !Number.isNaN(p.y));
  const n = pts.length;
  if (n < 2) return { slope: 0, nextValue: values[values.length - 1] ?? 0, direction: 'flat', confidence: 0 };

  const sumX = pts.reduce((a, p) => a + p.x, 0);
  const sumY = pts.reduce((a, p) => a + p.y, 0);
  const sumXY = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = pts.reduce((a, p) => a + p.x * p.x, 0);
  const meanY = sumY / n;

  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const nextValue = slope * n + intercept;

  // R² for a rough confidence indicator.
  const ssTot = pts.reduce((a, p) => a + (p.y - meanY) ** 2, 0);
  const ssRes = pts.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  return {
    slope,
    nextValue,
    direction: Math.abs(slope) < 1e-9 ? 'flat' : slope > 0 ? 'up' : 'down',
    confidence: Math.min(1, r2),
  };
}

export interface StatusDistribution {
  onTrack: number;
  atRisk: number;
  offTrack: number;
  total: number;
}

export function statusDistribution(kpis: Kpi[]): StatusDistribution {
  const d = { onTrack: 0, atRisk: 0, offTrack: 0, total: kpis.length };
  for (const k of kpis) {
    if (k.status === 'on_track') d.onTrack++;
    else if (k.status === 'at_risk') d.atRisk++;
    else d.offTrack++;
  }
  return d;
}

export interface CategoryScore {
  category: string;
  current: number;
  target: number;
  attainment: number; // %
}

/** Average attainment (current/target capped) grouped by category. */
export function categoryAttainment(kpis: Kpi[]): CategoryScore[] {
  const map = new Map<string, { current: number; target: number; n: number }>();
  for (const k of kpis) {
    const cat = k.category || 'Uncategorized';
    const e = map.get(cat) || { current: 0, target: 0, n: 0 };
    const attain = k.target_value === 0 ? 1 : Number(k.current_value) / Number(k.target_value);
    const normalized = k.direction === 'lower_better' ? (attain === 0 ? 1 : 1 / attain) : attain;
    e.current += Math.min(1.5, Math.max(0, normalized));
    e.n += 1;
    map.set(cat, e);
  }
  return Array.from(map.entries()).map(([category, e]) => ({
    category,
    current: e.current,
    target: e.n,
    attainment: Math.round((e.current / e.n) * 100),
  }));
}

export interface PeriodComparison {
  label: string;
  current: number;
  previous: number;
  changePct: number;
}

/**
 * Period-over-period (proxy for year-over-year) comparison of average health
 * across users, using persisted current vs previous health scores.
 */
export function periodComparison(users: Profile[], kpis: Kpi[]): PeriodComparison {
  const withCurrent = users.filter((u) => u.health_score != null);
  const currentAvg = withCurrent.length
    ? withCurrent.reduce((a, u) => a + (u.health_score || 0), 0) / withCurrent.length
    : calculateHealthScore(kpis);

  const withPrev = users.filter((u) => u.previous_health_score != null);
  const prevAvg = withPrev.length
    ? withPrev.reduce((a, u) => a + (u.previous_health_score || 0), 0) / withPrev.length
    : currentAvg;

  const changePct = prevAvg === 0 ? 0 : ((currentAvg - prevAvg) / prevAvg) * 100;
  return {
    label: 'Org Health Index',
    current: Math.round(currentAvg),
    previous: Math.round(prevAvg),
    changePct: Math.round(changePct * 10) / 10,
  };
}
