// supabase/functions/export_report.ts
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';

export default async function handler(req: Request) {
  const { format } = await req.json(); // "pdf" or "excel"
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const supabase = createClient(supabaseUrl, serviceKey);

  // Fetch all KPI data (simplified for demo)
  const { data: kpis, error } = await supabase.from('kpis').select('*');
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (format === 'pdf') {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4 size
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    let y = height - 50;
    page.drawText('KPI Report', { x: 50, y, size: 20, font, color: rgb(0, 0, 0) });
    y -= 30;
    kpis?.forEach((kpi: any) => {
      const line = `${kpi.name} – ${kpi.current_value}/${kpi.target_value} (${kpi.status})`;
      page.drawText(line, { x: 50, y, size: fontSize, font, color: rgb(0, 0, 0) });
      y -= 20;
    });
    const pdfBytes = await pdfDoc.save();
    // Upload to storage bucket "reports"
    const { error: uploadErr } = await supabase.storage
      .from('reports')
      .upload(`report_${Date.now()}.pdf`, pdfBytes, { contentType: 'application/pdf' });
    if (uploadErr) {
      return new Response(JSON.stringify({ error: uploadErr.message }), { status: 500 });
    }
    const { data: publicUrl } = supabase.storage.from('reports').getPublicUrl(`report_${Date.now()}.pdf`);
    return new Response(JSON.stringify({ url: publicUrl?.publicUrl }), { status: 200 });
  } else if (format === 'excel') {
    const ws = XLSX.utils.json_to_sheet(kpis || []);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'KPIs');
    const excelBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const { error: uploadErr } = await supabase.storage
      .from('reports')
      .upload(`report_${Date.now()}.xlsx`, excelBuffer, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (uploadErr) {
      return new Response(JSON.stringify({ error: uploadErr.message }), { status: 500 });
    }
    const { data: publicUrl } = supabase.storage.from('reports').getPublicUrl(`report_${Date.now()}.xlsx`);
    return new Response(JSON.stringify({ url: publicUrl?.publicUrl }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'Invalid format' }), { status: 400 });
}
