/**
 * Generates raw sample data files (Excel + PDF) for testing the HR KPI Board.
 * Output: test-data/sample-kpi-data.xlsx and test-data/sample-kpi-report.pdf
 *
 * Run with: node scripts/generate-test-data.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-data');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Raw sample dataset (mirrors the app's quarterly report shape) ──────────────
const quarterLabel = 'Q2 2026';

const employees = [
  { name: 'Jim Halpert', email: 'employee@walfia.ai', role: 'employee', manager: 'Michael Scott', healthScore: 56 },
  { name: 'Pam Beesly', email: 'pam@walfia.ai', role: 'employee', manager: 'Michael Scott', healthScore: 88 },
  { name: 'Dwight Schrute', email: 'dwight@walfia.ai', role: 'employee', manager: 'Michael Scott', healthScore: 72 },
];

const kpiRows = [
  { Employee: 'Jim Halpert', KPI: 'Recruitment Cycle Time', Category: 'Talent Acquisition', Status: 'at_risk', Current: 28, Target: 25, 'Suggested Target': 26.6, 'Health Score': 56, 'AI Insight': 'Recruitment Cycle Time is At Risk at 28 vs target 25 — monitor closely this period.' },
  { Employee: 'Jim Halpert', KPI: 'Offer Acceptance Rate', Category: 'Talent Acquisition', Status: 'at_risk', Current: 80, Target: 85, 'Suggested Target': 85, 'Health Score': 56, 'AI Insight': 'Offer Acceptance Rate is At Risk at 80 vs target 85 — monitor closely this period.' },
  { Employee: 'Jim Halpert', KPI: 'Employee Satisfaction Score', Category: 'Culture & Retention', Status: 'on_track', Current: 4.5, Target: 4.2, 'Suggested Target': 4.7, 'Health Score': 56, 'AI Insight': 'Employee Satisfaction Score remains On Track at 4.5 against target 4.2.' },
  { Employee: 'Jim Halpert', KPI: 'Training Completion Rate', Category: 'Development', Status: 'at_risk', Current: 90, Target: 95, 'Suggested Target': 95, 'Health Score': 56, 'AI Insight': 'Training Completion Rate is At Risk at 90 vs target 95 — monitor closely this period.' },
  { Employee: 'Jim Halpert', KPI: 'Absenteeism Rate', Category: 'Culture & Retention', Status: 'on_track', Current: 2.5, Target: 3, 'Suggested Target': 2.4, 'Health Score': 56, 'AI Insight': 'Absenteeism Rate remains On Track at 2.5 against target 3.' },
  { Employee: 'Jim Halpert', KPI: 'Performance Review Completion', Category: 'Performance Management', Status: 'at_risk', Current: 95, Target: 100, 'Suggested Target': 100, 'Health Score': 56, 'AI Insight': 'Performance Review Completion is At Risk at 95 vs target 100 — monitor closely this period.' },
  { Employee: 'Jim Halpert', KPI: 'Turnover Rate', Category: 'Culture & Retention', Status: 'off_track', Current: 12, Target: 10, 'Suggested Target': 11.4, 'Health Score': 56, 'AI Insight': 'Turnover Rate is Off Track at 12 (target 10) — flagged for review.' },
  { Employee: 'Pam Beesly', KPI: 'Recruitment Cycle Time', Category: 'Talent Acquisition', Status: 'on_track', Current: 22, Target: 25, 'Suggested Target': 21, 'Health Score': 88, 'AI Insight': 'Recruitment Cycle Time remains On Track at 22 against target 25.' },
  { Employee: 'Pam Beesly', KPI: 'Offer Acceptance Rate', Category: 'Talent Acquisition', Status: 'on_track', Current: 92, Target: 85, 'Suggested Target': 96.6, 'Health Score': 88, 'AI Insight': 'Offer Acceptance Rate rose 8.2% to 92 — trending positively.' },
  { Employee: 'Dwight Schrute', KPI: 'Turnover Rate', Category: 'Culture & Retention', Status: 'at_risk', Current: 11, Target: 10, 'Suggested Target': 10.4, 'Health Score': 72, 'AI Insight': 'Turnover Rate is At Risk at 11 vs target 10 — monitor closely this period.' },
  { Employee: 'Dwight Schrute', KPI: 'Training Completion Rate', Category: 'Development', Status: 'on_track', Current: 98, Target: 95, 'Suggested Target': 100, 'Health Score': 72, 'AI Insight': 'Training Completion Rate remains On Track at 98 against target 95.' },
];

const submissionRows = [
  { Employee: 'Jim Halpert', KPI: 'Recruitment Cycle Time', Value: 30, Notes: 'Delayed background checks for new engineering roles.', Date: '2026-06-03' },
  { Employee: 'Jim Halpert', KPI: 'Recruitment Cycle Time', Value: 28, Notes: 'Cleared pipeline backlog; average time dropped.', Date: '2026-06-10' },
  { Employee: 'Jim Halpert', KPI: 'Employee Satisfaction Score', Value: 4.5, Notes: 'Feedback from post-onboarding survey is highly positive.', Date: '2026-06-10' },
  { Employee: 'Pam Beesly', KPI: 'Offer Acceptance Rate', Value: 92, Notes: 'Improved compensation packages boosted acceptances.', Date: '2026-06-08' },
  { Employee: 'Dwight Schrute', KPI: 'Training Completion Rate', Value: 98, Notes: 'Mandatory safety training completed ahead of schedule.', Date: '2026-06-09' },
];

// ── 1. Excel workbook ──────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(employees), 'Employees');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiRows), 'KPI Summary');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(submissionRows), 'Submissions');
const xlsxPath = path.join(OUT_DIR, 'sample-kpi-data.xlsx');
XLSX.writeFile(wb, xlsxPath);
console.log(`✅  Excel written → ${path.relative(ROOT, xlsxPath)}`);

// ── 2. CSV (handy plain-text raw data) ──────────────────────────────────────────
const csvHeader = Object.keys(kpiRows[0]).join(',');
const csvBody = kpiRows
  .map((r) => Object.values(r).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  .join('\n');
const csvPath = path.join(OUT_DIR, 'sample-kpi-data.csv');
fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}\n`);
console.log(`✅  CSV written   → ${path.relative(ROOT, csvPath)}`);

// ── 3. PDF report ────────────────────────────────────────────────────────────────
const doc = new jsPDF();
let y = 20;

doc.setFontSize(18);
doc.setTextColor(80, 80, 200);
doc.text('HR KPI Board — Sample Quarterly Report', 14, y);
y += 9;
doc.setFontSize(11);
doc.setTextColor(60, 60, 60);
doc.text(`${quarterLabel}  •  Generated ${new Date().toLocaleString()}`, 14, y);
y += 6;
doc.text('Raw test data for verifying dashboards, exports, and automation.', 14, y);
y += 12;

doc.setFontSize(13);
doc.setTextColor(20, 20, 20);
doc.text('KPI Summary', 14, y);
y += 8;

doc.setFontSize(9);
const headers = ['Employee', 'KPI', 'Cur', 'Tgt', 'Status'];
const colX = [14, 52, 120, 138, 156];
doc.setFillColor(80, 80, 200);
doc.rect(12, y - 5, 184, 8, 'F');
doc.setTextColor(255, 255, 255);
headers.forEach((h, i) => doc.text(h, colX[i], y));
y += 9;

doc.setTextColor(40, 40, 40);
kpiRows.forEach((r, idx) => {
  if (y > 275) { doc.addPage(); y = 20; }
  if (idx % 2 === 0) {
    doc.setFillColor(245, 245, 255);
    doc.rect(12, y - 5, 184, 8, 'F');
  }
  doc.text(String(r.Employee), colX[0], y);
  doc.text(String(r.KPI).substring(0, 30), colX[1], y);
  doc.text(String(r.Current), colX[2], y);
  doc.text(String(r.Target), colX[3], y);
  doc.text(String(r.Status).replace('_', ' '), colX[4], y);
  y += 8;
});

y += 6;
if (y > 250) { doc.addPage(); y = 20; }
doc.setFontSize(13);
doc.setTextColor(20, 20, 20);
doc.text('AI Insights', 14, y);
y += 8;
doc.setFontSize(8);
doc.setTextColor(60, 60, 60);
kpiRows.forEach((r) => {
  if (y > 280) { doc.addPage(); y = 20; }
  const wrapped = doc.splitTextToSize(`• ${r['AI Insight']}`, 182);
  doc.text(wrapped, 14, y);
  y += wrapped.length * 4.5;
});

const pdfPath = path.join(OUT_DIR, 'sample-kpi-report.pdf');
fs.writeFileSync(pdfPath, Buffer.from(doc.output('arraybuffer')));
console.log(`✅  PDF written   → ${path.relative(ROOT, pdfPath)}`);

console.log('\n🎉  Test data generated in test-data/');
