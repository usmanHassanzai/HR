// src/components/ExportButton.tsx
import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { Kpi } from '../utils/kpiHelpers';
import { employeeKpiBoardBreakdown, kpiScoreRows } from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { displayedAwardedWeightage } from '../utils/weightageReveal';

interface ExportButtonProps {
  kpis: Kpi[];
  userName: string;
  /** Hide awarded/achieved until month-end unlock (employee self export). */
  deferAwardedUntilMonthEnd?: boolean;
}

export default function ExportButton({
  kpis,
  userName,
  deferAwardedUntilMonthEnd = false,
}: ExportButtonProps) {
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [loadingExcel, setLoadingExcel] = useState(false);

  const exportPDF = async () => {
    setLoadingPdf(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const summary = employeeKpiBoardBreakdown(kpis, {
        deferAchievedUntilMonthEnd: deferAwardedUntilMonthEnd,
      });
      const rows = kpiScoreRows(kpis);
      const anyAwardedVisible = rows.some(
        (row) => displayedAwardedWeightage(row.kpi, {
          deferUntilMonthEnd: deferAwardedUntilMonthEnd,
        }) != null,
      );
      const showAwarded = !deferAwardedUntilMonthEnd || anyAwardedVisible || !summary.weightageDeferred;
      doc.setFontSize(18);
      doc.text('Scorr — KPI Weightage Report', 14, 20);
      doc.setFontSize(11);
      doc.text(`Employee: ${userName}`, 14, 30);
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 37);
      doc.text(
        showAwarded
          ? `Awarded weightage: ${formatKpiWeight(summary.weightAchieved)}   Assigned: ${formatKpiWeight(summary.weightAssigned)}`
          : `Assigned weightage: ${formatKpiWeight(summary.weightAssigned)} (awarded posts at month end)`,
        14,
        44,
      );

      let y = 56;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('KPI', 14, y);
      doc.text('Weightage', 90, y);
      if (showAwarded) doc.text('Awarded', 140, y);
      doc.setFont('helvetica', 'normal');
      rows.forEach((row) => {
        y += 8;
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(row.name.substring(0, 40), 14, y);
        doc.text(`${row.weight}%`, 90, y);
        if (showAwarded) {
          const awarded = displayedAwardedWeightage(row.kpi, {
            deferUntilMonthEnd: deferAwardedUntilMonthEnd,
          });
          doc.text(awarded != null ? `${awarded}%` : '—', 140, y);
        }
      });
      y += 10;
      doc.setFont('helvetica', 'bold');
      if (showAwarded) {
        doc.text(`Awarded weightage ${formatKpiWeight(summary.weightAchieved)}`, 14, y);
      } else {
        doc.text(`Assigned weightage ${formatKpiWeight(summary.weightAssigned)}`, 14, y);
      }

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
      const summary = employeeKpiBoardBreakdown(kpis, {
        deferAchievedUntilMonthEnd: deferAwardedUntilMonthEnd,
      });
      const scored = kpiScoreRows(kpis);
      const anyAwardedVisible = scored.some(
        (row) => displayedAwardedWeightage(row.kpi, {
          deferUntilMonthEnd: deferAwardedUntilMonthEnd,
        }) != null,
      );
      const showAwarded = !deferAwardedUntilMonthEnd || anyAwardedVisible || !summary.weightageDeferred;
      const rows = scored.map((row) => {
        const base: Record<string, string | number> = {
          KPI: row.name,
          Weightage: row.weight,
        };
        if (showAwarded) {
          const awarded = displayedAwardedWeightage(row.kpi, {
            deferUntilMonthEnd: deferAwardedUntilMonthEnd,
          });
          base.Awarded = awarded != null ? awarded : '—';
        }
        return base;
      });
      const total: Record<string, string | number> = {
        KPI: 'TOTAL',
        Weightage: summary.weightAssigned,
      };
      if (showAwarded) total.Awarded = summary.weightAchieved;
      rows.push(total);
      const sheet = XLSX.utils.json_to_sheet(rows);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'KPI Weightage');
      XLSX.writeFile(book, `KPI_Report_${Date.now()}.xlsx`);
    } catch (e) {
      console.error('Excel export error:', e);
    } finally {
      setLoadingExcel(false);
    }
  };

  return (
    <div className="export-btn-row">
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
