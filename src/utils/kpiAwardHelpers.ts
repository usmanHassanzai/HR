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

export function awardRuleLabel(key: string): string {
  if (key === 'movie_tickets') return 'Movie tickets';
  if (key === 'dinner_voucher') return 'Dinner voucher';
  if (key === 'surprise_gift') return 'Surprise gift';
  return key;
}
