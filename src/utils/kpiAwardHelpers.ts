export type KpiAwardRuleKey = 'movie_tickets' | 'dinner_voucher' | 'surprise_gift';

export interface KpiAwardConfig {
  company_id: string;
  movie_min_pct: number;
  movie_max_pct: number;
  movie_months: number;
  movie_reward_name: string;
  dinner_min_pct: number;
  dinner_max_pct: number;
  dinner_months: number;
  dinner_reward_name: string;
  gift_min_pct: number;
  gift_max_pct?: number;
  gift_months: number;
  gift_reward_name: string;
}

export interface KpiAwardProgress {
  rule_key: KpiAwardRuleKey;
  reward_name: string;
  min_pct: number;
  max_pct: number;
  required_months: number;
  current_months: number;
  months_to_go: number;
  /** Monthly weightage achieved (0–100), from get_kpi_award_progress. */
  latest_score: number | null;
  progress_pct: number;
  qualified: boolean;
  hint: string;
}

export interface KpiAwardPipelineRow {
  qualification_id: string | null;
  employee_id: string;
  full_name: string;
  email: string;
  rule_key: KpiAwardRuleKey;
  reward_name: string;
  bucket: 'eligible' | 'close';
  detail: string;
  current_months: number;
  required_months: number;
  latest_score: number | null;
  status: string | null;
  created_at: string | null;
}

/** Sentinel used in DB config for “no upper limit”. */
export const AWARD_OPEN_CEILING = 9999;

export function awardRuleLabel(key: string): string {
  if (key === 'movie_tickets') return 'Movie tickets';
  if (key === 'dinner_voucher') return 'Dinner voucher';
  if (key === 'surprise_gift') return 'Surprise gift';
  return key;
}

export function isOpenAwardCeiling(max: number | null | undefined): boolean {
  if (max == null || Number.isNaN(Number(max))) return false;
  return Number(max) >= AWARD_OPEN_CEILING;
}

/** Format a weightage value for display, e.g. "80%" or "87.5%". */
export function formatAwardWeightage(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}%`;
  return `${n.toFixed(1)}%`;
}

/** e.g. "95%+" or "85–90%" */
export function formatAwardWeightageBand(min: number, max: number | null | undefined): string {
  const lo = Number(min);
  const loLabel = Math.abs(lo - Math.round(lo)) < 0.05 ? String(Math.round(lo)) : lo.toFixed(1);
  if (isOpenAwardCeiling(max)) return `${loLabel}%+`;
  const hi = Number(max);
  const hiLabel = Math.abs(hi - Math.round(hi)) < 0.05 ? String(Math.round(hi)) : hi.toFixed(1);
  return `${loLabel}–${hiLabel}%`;
}

/** @deprecated alias — gifts use weightage */
export const formatAwardScore = formatAwardWeightage;
/** @deprecated alias — gifts use weightage */
export const formatAwardScoreBand = formatAwardWeightageBand;

/** Compact progress label for manager/admin gift tables. */
export function awardGiftLine(row: KpiAwardProgress | undefined, fallback: string): string {
  if (!row) return fallback;
  if (row.qualified) return 'Qualified';
  const current = Number(row.current_months || 0);
  const needed = Number(row.required_months || 0);
  if (needed <= 0) return fallback;
  const unit = needed === 1 ? 'month' : 'months';
  return `${current}/${needed} ${unit}`;
}

function weightageInBand(weightage: number, min: number, max: number): boolean {
  if (weightage < min) return false;
  if (isOpenAwardCeiling(max)) return true;
  return weightage <= max;
}

/** Professional status line for a gift rule. Prefers clean server hint when present. */
export function awardProgressHint(row: KpiAwardProgress | undefined, fallbackMonths: string): string {
  if (!row) return fallbackMonths;
  if (row.qualified) {
    return 'You qualified — waiting for your manager or admin to arrange this gift.';
  }
  const hint = row.hint?.trim();
  if (hint && !/Above the gift band/i.test(hint) && !/score points/i.test(hint)) {
    // Prefer server hints that already say weightage; rewrite legacy "score" phrasing.
    if (/weightage/i.test(hint)) return hint;
    if (!/score/i.test(hint)) return hint;
  }

  const min = Number(row.min_pct);
  const max = Number(row.max_pct);
  const band = formatAwardWeightageBand(min, max);
  const current = Number(row.current_months || 0);
  const needed = Number(row.required_months || 1);
  const weightage = row.latest_score == null ? null : Number(row.latest_score);

  if (row.rule_key === 'dinner_voucher') {
    if (weightage == null) return `Reach weightage of ${band} in any one month.`;
    if (weightageInBand(weightage, min, max)) {
      return `This month’s weightage is ${formatAwardWeightage(weightage)} — you meet the ${band} target.`;
    }
    if (weightage < min) {
      return `This month’s weightage is ${formatAwardWeightage(weightage)}. Reach ${band} to qualify.`;
    }
    return `This month’s weightage is ${formatAwardWeightage(weightage)}. This gift is for weightage ${band}.`;
  }

  if (current > 0) {
    return `${current} of ${needed} months at weightage ${band}.`;
  }
  if (weightage == null) {
    return `Need ${needed} months in a row at weightage ${band}.`;
  }
  if (weightageInBand(weightage, min, max)) {
    return `On track this month (${formatAwardWeightage(weightage)}). Keep weightage ${band} for ${needed} months in a row.`;
  }
  return `Need ${needed} months in a row at weightage ${band}. This month: ${formatAwardWeightage(weightage)}.`;
}

/** @deprecated use awardProgressHint */
export function awardDinnerHint(row: KpiAwardProgress | undefined, minDefault = 95, maxDefault = 100): string {
  if (!row) {
    return `Reach weightage of ${formatAwardWeightageBand(minDefault, maxDefault)} in any one month.`;
  }
  return awardProgressHint(row, 'Reach this month’s dinner weightage target.');
}
