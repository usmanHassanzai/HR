import { supabase } from '../lib/supabase';
import { Kpi, Profile, KpiSubmission } from './kpiHelpers';
import {
  calculateOverallKpiScore,
  kpiAchievedPct,
  kpiScoreContribution,
  performanceRatingForScore,
} from './kpiScoreHelpers';

export interface ReportData {
  generatedAt: string;
  periodLabel: string;
  users: Profile[];
  kpis: Kpi[];
  submissions: KpiSubmission[];
}

/** @deprecated Use ReportData */
export type QuarterlyReportData = ReportData;

export async function fetchQuarterlyReportData(): Promise<ReportData> {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const periodLabel = `Q${quarter} ${now.getFullYear()}`;
  const periodStart = new Date(now.getFullYear(), (quarter - 1) * 3, 1).toISOString();
  return fetchReportData(periodLabel, periodStart);
}

export async function fetchMonthlyReportData(): Promise<ReportData> {
  const now = new Date();
  const periodLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return fetchReportData(periodLabel, periodStart);
}

async function fetchReportData(periodLabel: string, periodStart: string): Promise<ReportData> {
  const now = new Date();
  const [usersRes, kpisRes, submissionsRes] = await Promise.all([
    supabase.rpc('get_all_users_admin'),
    supabase.from('kpis').select('*').order('name'),
    supabase
      .from('kpi_submissions')
      .select('*')
      .gte('created_at', periodStart)
      .order('created_at', { ascending: false }),
  ]);

  if (usersRes.error) throw new Error(usersRes.error.message);
  if (kpisRes.error) throw new Error(kpisRes.error.message);
  if (submissionsRes.error) throw new Error(submissionsRes.error.message);

  return {
    generatedAt: now.toISOString(),
    periodLabel,
    // keep old field for backward compat
    get quarterLabel() { return this.periodLabel; },
    users: usersRes.data || [],
    kpis: kpisRes.data || [],
    submissions: submissionsRes.data || [],
  } as ReportData & { quarterLabel: string };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function safeLabel(label: string) {
  return label.replace(/[^a-zA-Z0-9-_]/g, '-');
}

export function exportToCsv(data: ReportData) {
  const userMap = new Map(data.users.map((u) => [u.id, u]));
  const kpisByUser = new Map<string, Kpi[]>();
  for (const kpi of data.kpis) {
    const list = kpisByUser.get(kpi.user_id) || [];
    list.push(kpi);
    kpisByUser.set(kpi.user_id, list);
  }
  const header = 'Employee,Department,KPI,Weight,Employee Score,Weighted Score,Overall KPI Score,Performance Rating';
  const rows = data.kpis.map((kpi) => {
    const user = userMap.get(kpi.user_id);
    const userKpis = kpisByUser.get(kpi.user_id) || [];
    const overall = calculateOverallKpiScore(userKpis);
    const fields = [
      user?.full_name || 'Unknown',
      kpi.department || kpi.category || '',
      kpi.name,
      String(kpi.weight ?? ''),
      String(kpiAchievedPct(kpi)),
      String(kpiScoreContribution(kpi)),
      String(overall),
      performanceRatingForScore(overall),
    ];
    return fields.map((f) => `"${f}"`).join(',');
  });
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `hr-kpi-report-${safeLabel(data.periodLabel)}.csv`);
}

export async function exportToExcel(data: ReportData) {
  const XLSX = await import('xlsx');
  const userMap = new Map(data.users.map((u) => [u.id, u]));

  const kpiRows = data.kpis.map((kpi) => {
    const userKpis = data.kpis.filter((k) => k.user_id === kpi.user_id);
    const overall = calculateOverallKpiScore(userKpis);
    return {
      Employee: userMap.get(kpi.user_id)?.full_name || 'Unknown',
      Department: kpi.department || kpi.category || '',
      KPI: kpi.name,
      Weight: kpi.weight,
      'Employee Score': kpiAchievedPct(kpi),
      'Weighted Score': kpiScoreContribution(kpi),
      'Overall KPI Score': overall,
      'Performance Rating': performanceRatingForScore(overall),
    };
  });

  const submissionRows = data.submissions.map((s) => ({
    Employee: userMap.get(s.user_id)?.full_name || 'Unknown',
    KPI: data.kpis.find((k) => k.id === s.kpi_id)?.name || s.kpi_id,
    Value: s.value,
    Notes: s.notes || '',
    Date: new Date(s.created_at).toLocaleDateString(),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(kpiRows), 'KPI Summary');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(submissionRows), 'Submissions');
  XLSX.writeFile(workbook, `hr-kpi-report-${safeLabel(data.periodLabel)}.xlsx`);
}

export async function exportToPdf(data: ReportData) {
  const { jsPDF } = await import('jspdf');
  const userMap = new Map(data.users.map((u) => [u.id, u]));

  const doc = new jsPDF();
  let y = 20;

  doc.setFontSize(18);
  doc.text(`Scorr KPI Report — ${data.periodLabel}`, 14, y);
  y += 10;
  doc.setFontSize(11);
  doc.text(`Generated: ${new Date(data.generatedAt).toLocaleString()}`, 14, y);
  y += 8;
  doc.setFontSize(10);
  doc.text(`Total Employees: ${data.users.length}   |   Total KPIs: ${data.kpis.length}   |   Submissions this period: ${data.submissions.length}`, 14, y);
  y += 12;

  // Summary table header
  doc.setFontSize(13);
  doc.text('KPI Summary', 14, y);
  y += 8;
  doc.setFontSize(9);

  for (const kpi of data.kpis) {
    if (y > 270) { doc.addPage(); y = 20; }
    const employee = userMap.get(kpi.user_id)?.full_name || 'Unknown';
    const userKpis = data.kpis.filter((k) => k.user_id === kpi.user_id);
    const overall = calculateOverallKpiScore(userKpis);
    const line = `${employee} — ${kpi.name}: weight ${kpi.weight}%  score ${kpiAchievedPct(kpi)}%  weighted ${kpiScoreContribution(kpi)}  overall ${overall}% ${performanceRatingForScore(overall)}`;
    doc.text(line, 14, y);
    y += 5;
    if (kpi.ai_narrative) {
      const wrapped = doc.splitTextToSize(`  Insight: ${kpi.ai_narrative}`, 180);
      doc.text(wrapped, 14, y);
      y += wrapped.length * 5;
    }
    y += 3;
  }

  // Submissions section
  if (data.submissions.length > 0) {
    if (y > 240) { doc.addPage(); y = 20; }
    y += 6;
    doc.setFontSize(13);
    doc.text('Submissions This Period', 14, y);
    y += 8;
    doc.setFontSize(9);
    for (const s of data.submissions.slice(0, 60)) {
      if (y > 270) { doc.addPage(); y = 20; }
      const emp = userMap.get(s.user_id)?.full_name || 'Unknown';
      const kpiName = data.kpis.find((k) => k.id === s.kpi_id)?.name || '-';
      doc.text(`${new Date(s.created_at).toLocaleDateString()}  ${emp}  ${kpiName}: ${s.value}${s.notes ? '  (' + s.notes + ')' : ''}`, 14, y);
      y += 5;
    }
  }

  doc.save(`hr-kpi-report-${safeLabel(data.periodLabel)}.pdf`);
}
