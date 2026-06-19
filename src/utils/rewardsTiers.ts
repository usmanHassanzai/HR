/** Monthly performance → points tiers (points never expire). */
export const REWARD_CATALOG_COST = 1000;

export const MONTHLY_POINTS_TIERS = [
  { minScore: 90, points: 1000, label: 'Excellent (≥90%)' },
  { minScore: 80, points: 500, label: 'Strong (80–89%)' },
  { minScore: 70, points: 250, label: 'Good (70–79%)' },
  { minScore: 0, points: 0, label: 'Below target (<70%)' },
] as const;

export function monthlyPointsForScore(score: number): number {
  if (score >= 90) return 1000;
  if (score >= 80) return 500;
  if (score >= 70) return 250;
  return 0;
}

export function tierColorForScore(score: number): string {
  if (score >= 90) return 'var(--color-success)';
  if (score >= 80) return 'var(--accent-primary)';
  if (score >= 70) return 'var(--color-warning)';
  return 'var(--text-muted)';
}
