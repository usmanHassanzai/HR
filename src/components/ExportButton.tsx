// src/components/ExportButton.tsx
import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import jsPDF from 'jspdf';
import * as XLSX from 'xlsx';
import { Kpi } from '../utils/kpiHelpers';

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
      const doc = new jsPDF();
      doc.setFontSize(18);
      doc.setTextColor(80, 80, 200);
      doc.text('Scorr — Quarterly Report', 14, 20);
      doc.setFontSize(11);
      doc.setTextColor(60, 60, 60);
      doc.text(`User: ${userName}`, 14, 30);
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 37);

      doc.setFontSize(10);
      let y = 50;
      const headers = ['Department', 'Status', 'Start', 'End', 'Complete'];
      doc.setFillColor(45, 212, 168);
      doc.rect(14, y - 5, 182, 8, 'F');
      doc.setTextColor(255, 255, 255);
      headers.forEach((h, i) => doc.text(h, 14 + i * 36, y));

      doc.setTextColor(40, 40, 40);
      kpis.forEach((kpi, idx) => {
        y += 10;
        if (y > 270) { doc.addPage(); y = 20; }
        const bg = idx % 2 === 0 ? [245, 245, 255] : [255, 255, 255];
        doc.setFillColor(bg[0], bg[1], bg[2]);
        doc.rect(14, y - 5, 182, 8, 'F');
        doc.text((kpi.department || kpi.name).substring(0, 16), 14, y);
        doc.text(kpi.status.replace('_', ' '), 50, y);
        doc.text(kpi.start_date || '—', 86, y);
        doc.text(kpi.end_date || '—', 122, y);
        doc.text(kpi.completion_status === 'completed' ? 'Yes' : 'No', 158, y);
      });

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
      const rows = kpis.map(k => ({
        'Department': k.department || k.category || k.name,
        'Description': k.description || '',
        'Start Date': k.start_date || '',
        'End Date': k.end_date || '',
        'Status': k.status.replace('_', ' '),
        'Completed': k.completion_status === 'completed' ? 'Yes' : 'No',
        'Redo Count': k.redo_count ?? 0,
        'Last Updated': new Date(k.updated_at).toLocaleDateString(),
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'KPI Report');
      XLSX.writeFile(wb, `KPI_Report_${Date.now()}.xlsx`);
    } catch (e) {
      console.error('Excel export error:', e);
    } finally {
      setLoadingExcel(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button
        className="btn btn-secondary"
        onClick={exportPDF}
        disabled={loadingPdf}
        title="Export as PDF"
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}
      >
        {loadingPdf
          ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          : <FileDown size={14} />}
        PDF
      </button>
      <button
        className="btn btn-secondary"
        onClick={exportExcel}
        disabled={loadingExcel}
        title="Export as Excel"
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}
      >
        {loadingExcel
          ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          : <FileDown size={14} />}
        Excel
      </button>
    </div>
  );
}
