/** Department types and helpers */

export interface Department {
  id: string;
  name: string;
  slug: string;
  org_weight_pct: number;
  active: boolean;
  kpi_count?: number;
  active_kpi_count?: number;
}

export const DEFAULT_DEPARTMENTS = [
  'Graphics',
  'IT',
  'Marketing',
  'SEO',
  'Operations',
  'HR',
  'Business Development',
] as const;

export function formatWeightPct(pct: number): string {
  return `${Number(pct).toFixed(1)}%`;
}

export function sumWeights(depts: { org_weight_pct: number }[]): number {
  return depts.reduce((s, d) => s + Number(d.org_weight_pct || 0), 0);
}

export function weightsValid(depts: { org_weight_pct: number }[]): boolean {
  return Math.abs(sumWeights(depts) - 100) <= 0.05;
}
