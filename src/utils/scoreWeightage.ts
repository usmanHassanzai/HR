/**
 * Must match the SQL constant admin_may_edit_score_weightage in guard_weightage().
 * Admin has no Score weightage edit control while this is false.
 */
export const ADMIN_MAY_EDIT_SCORE_WEIGHTAGE = false;

export type ScoreMonthStatus = 'open' | 'closed' | 'approved';
export type WeightSource = 'stored' | 'previous' | 'default' | 'snapshot';

export interface ScoreMonthStatusRow {
  company_id: string;
  month: string;
  status: ScoreMonthStatus;
  closed_by: string | null;
  closed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export interface DepartmentWeightageRow {
  department_id: string;
  department_name: string;
  month: string;
  individual_weight: number;
  team_weight: number;
  source: WeightSource;
  updated_by: string | null;
  updated_at: string | null;
}

export interface MyScoreWeightage {
  month: string;
  status: ScoreMonthStatus;
  department_id: string | null;
  department_name: string | null;
  individual_kpi_pct: number | null;
  team_avg_kpi_pct: number | null;
  individual_weight: number | null;
  team_weight: number | null;
  weight_source: WeightSource | null;
  individual_points: number | null;
  team_points: number | null;
  score: number | null;
  bonus_pct: number | null;
}

export interface ScoreResultRow {
  user_id: string;
  full_name: string;
  department_id: string;
  department_name: string;
  individual_kpi_pct: number | null;
  team_avg_kpi_pct: number | null;
  individual_weight: number;
  team_weight: number;
  individual_points: number | null;
  team_points: number | null;
  score: number | null;
  bonus_pct: number;
}

export interface ScoreWeightageLogRow {
  id: number;
  department_id: string;
  department_name: string | null;
  month: string;
  old_individual: number | null;
  old_team: number | null;
  new_individual: number | null;
  new_team: number | null;
  old_status: string | null;
  new_status: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_by_role: string | null;
  changed_at: string;
}

export interface OrgBonusRow {
  user_id: string;
  full_name: string;
  department_id: string;
  department_name: string;
  individual_kpi_pct: number | null;
  team_avg_kpi_pct: number | null;
  individual_points: number | null;
  team_points: number | null;
  score: number | null;
  bonus_pct: number;
}

/** Bonus %: below 90 → 0; 90 → 10; +1% per point; 100 → 20 max; linear between whole points. */
export function bonusPct(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score) || score < 90) return 0;
  return Math.min(20, 10 + (score - 90));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Round each side to 1 decimal, then add. The shown points always equal the score. */
export function calcFinalScore(
  individualKpiPct: number,
  teamAvgKpiPct: number,
  individualWeight: number,
  teamWeight: number,
): number {
  return calcIndividualPoints(individualKpiPct, individualWeight)
    + calcTeamPoints(teamAvgKpiPct, teamWeight);
}

export function calcIndividualPoints(individualKpiPct: number, individualWeight: number): number {
  return round1((individualKpiPct * individualWeight) / 100);
}

export function calcTeamPoints(teamAvgKpiPct: number, teamWeight: number): number {
  return round1((teamAvgKpiPct * teamWeight) / 100);
}

/** First day of month as YYYY-MM-01 for RPC month args. */
export function monthStartIso(year: number, monthIndex0: number): string {
  const m = String(monthIndex0 + 1).padStart(2, '0');
  return `${year}-${m}-01`;
}

export function formatScoreMonthLabel(monthIso: string): string {
  const d = new Date(`${monthIso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return monthIso;
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Plain points, for example 35.0 or 19.5. Bonus stays a percentage. */
export function formatPoints(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function oneDecimal(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;
}

/** 0 to 100 inclusive, at most one decimal place. */
export function weightValueOk(value: number): boolean {
  return oneDecimal(value) && value >= 0 && value <= 100;
}

export function weightsTotalOk(individual: number, team: number): boolean {
  return weightValueOk(individual)
    && weightValueOk(team)
    && Math.abs(Math.round((individual + team) * 10) - 1000) < 1e-6;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getSupabase() {
  const { supabase } = await import('../lib/supabase');
  return supabase;
}

export async function fetchScoreMonthStatus(monthIso: string): Promise<ScoreMonthStatusRow> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('get_score_month_status', { p_month: monthIso });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    company_id: String(row?.company_id ?? ''),
    month: String(row?.month ?? monthIso).slice(0, 10),
    status: (row?.status as ScoreMonthStatus) || 'open',
    closed_by: row?.closed_by ?? null,
    closed_at: row?.closed_at ?? null,
    approved_by: row?.approved_by ?? null,
    approved_at: row?.approved_at ?? null,
  };
}

export async function fetchDepartmentWeightages(monthIso: string): Promise<DepartmentWeightageRow[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('list_department_score_weightages', { p_month: monthIso });
  if (error) throw error;
  return ((data as DepartmentWeightageRow[]) || []).map((r) => ({
    ...r,
    month: String(r.month).slice(0, 10),
    individual_weight: num(r.individual_weight),
    team_weight: num(r.team_weight),
    source: (r.source as WeightSource) || 'default',
  }));
}

export async function upsertDepartmentWeightage(
  departmentId: string,
  monthIso: string,
  individualWeight: number,
  teamWeight: number,
): Promise<void> {
  if (!weightsTotalOk(individualWeight, teamWeight)) {
    throw new Error('Weights must be between 0 and 100, with at most one decimal place, and total 100');
  }
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('upsert_department_score_weightage', {
    p_department_id: departmentId,
    p_month: monthIso,
    p_individual_weight: individualWeight,
    p_team_weight: teamWeight,
  });
  if (error) throw error;
}

export async function closeScoreMonth(monthIso: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('close_score_month', { p_month: monthIso });
  if (error) throw error;
}

export async function reopenScoreMonth(monthIso: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('reopen_score_month', { p_month: monthIso });
  if (error) throw error;
}

export async function approveScoreMonth(monthIso: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('approve_score_month', { p_month: monthIso });
  if (error) throw error;
}

export async function fetchMyScoreWeightage(monthIso: string): Promise<MyScoreWeightage> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('get_my_score_weightage', { p_month: monthIso });
  if (error) throw error;
  const row = (data || {}) as Record<string, unknown>;
  return {
    month: String(row.month ?? monthIso).slice(0, 10),
    status: (row.status as ScoreMonthStatus) || 'open',
    department_id: (row.department_id as string) || null,
    department_name: (row.department_name as string) || null,
    individual_kpi_pct: numOrNull(row.individual_kpi_pct),
    team_avg_kpi_pct: numOrNull(row.team_avg_kpi_pct),
    individual_weight: numOrNull(row.individual_weight),
    team_weight: numOrNull(row.team_weight),
    weight_source: (row.weight_source as WeightSource) || null,
    individual_points: numOrNull(row.individual_points),
    team_points: numOrNull(row.team_points),
    score: numOrNull(row.score),
    bonus_pct: numOrNull(row.bonus_pct),
  };
}

export async function fetchDepartmentScoreResults(
  departmentId: string,
  monthIso: string,
): Promise<ScoreResultRow[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('list_department_score_results', {
    p_department_id: departmentId,
    p_month: monthIso,
  });
  if (error) throw error;
  return ((data as ScoreResultRow[]) || []).map((r) => ({
    ...r,
    individual_kpi_pct: numOrNull(r.individual_kpi_pct),
    team_avg_kpi_pct: numOrNull(r.team_avg_kpi_pct),
    individual_weight: num(r.individual_weight),
    team_weight: num(r.team_weight),
    individual_points: numOrNull(r.individual_points),
    team_points: numOrNull(r.team_points),
    score: numOrNull(r.score),
    bonus_pct: num(r.bonus_pct, bonusPct(numOrNull(r.score))),
  }));
}

export async function fetchScoreWeightageLog(monthIso: string): Promise<ScoreWeightageLogRow[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('list_score_weightage_log', { p_month: monthIso });
  if (error) throw error;
  return ((data as ScoreWeightageLogRow[]) || []).map((r) => ({
    ...r,
    id: num(r.id),
    month: String(r.month).slice(0, 10),
    old_individual: numOrNull(r.old_individual),
    old_team: numOrNull(r.old_team),
    new_individual: numOrNull(r.new_individual),
    new_team: numOrNull(r.new_team),
    old_status: r.old_status ?? null,
    new_status: r.new_status ?? null,
  }));
}

export async function fetchOrgBonusList(monthIso: string): Promise<OrgBonusRow[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('list_org_score_bonus', { p_month: monthIso });
  if (error) throw error;
  return ((data as OrgBonusRow[]) || []).map((r) => ({
    ...r,
    individual_kpi_pct: numOrNull(r.individual_kpi_pct),
    team_avg_kpi_pct: numOrNull(r.team_avg_kpi_pct),
    individual_points: numOrNull(r.individual_points),
    team_points: numOrNull(r.team_points),
    score: numOrNull(r.score),
    bonus_pct: num(r.bonus_pct, bonusPct(numOrNull(r.score))),
  }));
}

export function bonusListToCsv(rows: OrgBonusRow[]): string {
  const header = [
    'Employee',
    'Department',
    'Individual points',
    'Team points',
    'Score',
    'Bonus %',
  ];
  const lines = rows.map((r) =>
    [
      csvEscape(r.full_name),
      csvEscape(r.department_name),
      r.individual_points == null ? '' : String(r.individual_points),
      r.team_points == null ? '' : String(r.team_points),
      r.score == null ? '' : String(r.score),
      String(r.bonus_pct),
    ].join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadBonusCsv(rows: OrgBonusRow[], monthIso: string): void {
  const blob = new Blob([bonusListToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `score-bonus-${monthIso.slice(0, 7)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
