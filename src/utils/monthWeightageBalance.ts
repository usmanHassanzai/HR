import { supabase } from '../lib/supabase';

export interface MonthWeightageBalance {
  earned: number | null;
  deducted: number;
  available: number | null;
  banked: number;
}

export function emptyMonthWeightageBalance(): MonthWeightageBalance {
  return { earned: null, deducted: 0, available: null, banked: 0 };
}

export function parseMonthWeightageBalance(row: unknown): MonthWeightageBalance {
  if (!row || typeof row !== 'object') return emptyMonthWeightageBalance();
  const r = row as {
    earned?: unknown;
    deducted?: unknown;
    available?: unknown;
    banked?: unknown;
  };
  return {
    earned: r.earned == null ? null : Number(r.earned),
    deducted: Number(r.deducted) || 0,
    available: r.available == null ? null : Number(r.available),
    banked: Number(r.banked) || 0,
  };
}

/** Current month reward balance for one user (earned / used / available / banked). */
export async function fetchMonthWeightageBalance(
  userId: string,
): Promise<MonthWeightageBalance> {
  const { data, error } = await supabase.rpc('get_month_weightage_balance', {
    p_user_id: userId,
  });
  if (error) return emptyMonthWeightageBalance();
  const row = Array.isArray(data) ? data[0] : data;
  return parseMonthWeightageBalance(row);
}

/** Batch current-month balances keyed by user id. */
export async function fetchMonthWeightageBalances(
  userIds: string[],
): Promise<Record<string, MonthWeightageBalance>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out: Record<string, MonthWeightageBalance> = {};
  await Promise.all(
    unique.map(async (id) => {
      out[id] = await fetchMonthWeightageBalance(id);
    }),
  );
  return out;
}

export function formatWeightagePct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}%`;
  return `${n.toFixed(1)}%`;
}
