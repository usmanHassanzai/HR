// src/components/ExportButton.tsx
import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { Kpi } from '../utils/kpiHelpers';
import {
  employeeKpiScoreSummary,
  formatKpiScore,
  kpiScoreRows,
} from '../utils/kpiScoreHelpers';

interface ExportButtonProps {
  kpis: Kpi[];
  userName: string;
}

export default function ExportButton({ kpis, userName }: ExportButtonProps) {
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [loadingExcel, setLoadingExcel] = useState(false);

  const exportPDF = async () => {
    setLoadingPdf(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const summary = employeeKpiScoreSummary(kpis);
      const rows = kpiScoreRows(kpis);
      doc.setFontSize(18);
      doc.text('Scorr — KPI Score Report', 14, 20);
      doc.setFontSize(11);
      doc.text(`Employee: ${userName}`, 14, 30);
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 37);
      doc.text(
        `Overall KPI Score: ${formatKpiScore(summary.overallScore)}%   Performance: ${summary.performanceRating}`,
        14,
        44,
      );

      let y = 56;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('KPI', 14, y);
      doc.text('Weight', 90, y);
      doc.text('Employee Score', 118, y);
      doc.text('Weighted Score', 160, y);
      doc.setFont('helvetica', 'normal');
      rows.forEach((row) => {
        y += 8;
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(row.name.substring(0, 40), 14, y);
        doc.text(`${row.weight}%`, 90, y);
        doc.text(`${row.employeeScore}%`, 118, y);
        doc.text(formatKpiScore(row.weightedScore), 160, y);
      });
      y += 10;
      doc.setFont('helvetica', 'bold');
      doc.text(`Overall KPI Score ${formatKpiScore(summary.overallScore)}%`, 14, y);

      doc.save(`KPI_Report_${Date.now()}.pdf`);
    } catch (e) {
      console.error('PDF export error:', e);
    } finally {
      setLoadingPdf(false);
    }
  };

  const exportExcel = async () => {
    setLoadingExcel(true);
    try {
      const XLSX = await import('xlsx');
      const summary = employeeKpiScoreSummary(kpis);
      const rows = kpiScoreRows(kpis).map((row) => ({
        Employee: userName,
        KPI: row.name,
        Weight: row.weight,
        'Employee Score': row.employeeScore,
        'Weighted Score': row.weightedScore,
        'Overall KPI Score': summary.overallScore,
        'Performance Rating': summary.performanceRating,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'KPI Score');
      XLSX.writeFile(wb, `KPI_Report_${Date.now()}.xlsx`);
    } catch (e) {
      console.error('Excel export error:', e);
    } finally {
      setLoadingExcel(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button className="btn btn-secondary btn-sm" onClick={() => void exportPDF()} disabled={loadingPdf || kpis.length === 0}>
        {loadingPdf ? <Loader2 size={14} className="spin-icon" /> : <FileDown size={14} />}
        PDF
      </button>
      <button className="btn btn-secondary btn-sm" onClick={() => void exportExcel()} disabled={loadingExcel || kpis.length === 0}>
        {loadingExcel ? <Loader2 size={14} className="spin-icon" /> : <FileDown size={14} />}
        Excel
      </button>
    </div>
  );
}
