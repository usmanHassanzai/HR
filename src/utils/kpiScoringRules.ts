/**
 * Explicit KPI scoring rules (independent of category grouping).
 * Category answers "where does this show on the dashboard?"
 * Scoring rule answers "how do we calculate the score?"
 */

export type LatePenaltyType = 'percentage_cut';

export interface KpiScoringRule {
  penaltyEnabled: boolean;
  penaltyType: LatePenaltyType;
  /** For percentage_cut: share of score kept when late (50 = half score). */
  penaltyValue: number;
  gracePeriodDays: number;
}

export type KpiScoringFields = {
  late_penalty_enabled?: boolean | null;
  late_penalty_type?: string | null;
  late_penalty_value?: number | null;
  late_penalty_grace_days?: number | null;
};

export const DEFAULT_KPI_SCORING_RULE: KpiScoringRule = {
  penaltyEnabled: false,
  penaltyType: 'percentage_cut',
  penaltyValue: 50,
  gracePeriodDays: 0,
};

export function kpiScoringRule(kpi: KpiScoringFields | null | undefined): KpiScoringRule {
  const type = (kpi?.late_penalty_type || 'percentage_cut').toLowerCase();
  return {
    penaltyEnabled: Boolean(kpi?.late_penalty_enabled),
    penaltyType: type === 'percentage_cut' ? 'percentage_cut' : 'percentage_cut',
    penaltyValue: Math.min(100, Math.max(0, Number(kpi?.late_penalty_value ?? 50))),
    gracePeriodDays: Math.max(0, Math.floor(Number(kpi?.late_penalty_grace_days ?? 0))),
  };
}

/** Badge / card copy when a late penalty is configured. */
export function formatLatePenaltyLabel(rule: KpiScoringRule): string | null {
  if (!rule.penaltyEnabled) return null;
  const cut = Math.round(100 - rule.penaltyValue);
  const grace =
    rule.gracePeriodDays > 0
      ? ` after ${rule.gracePeriodDays} day${rule.gracePeriodDays === 1 ? '' : 's'} grace`
      : ' after due date';
  if (rule.penaltyType === 'percentage_cut') {
    return `Late penalty: −${cut}%${grace}`;
  }
  return `Late penalty${grace}`;
}

export function scoringRuleToDbParams(rule: KpiScoringRule) {
  return {
    p_late_penalty_enabled: rule.penaltyEnabled,
    p_late_penalty_type: rule.penaltyType,
    p_late_penalty_value: rule.penaltyValue,
    p_late_penalty_grace_days: rule.gracePeriodDays,
  };
}
