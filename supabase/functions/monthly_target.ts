// supabase/functions/monthly_target.ts
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: Request) {
  const { kpiId } = await req.json();
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const supabase = createClient(supabaseUrl, serviceKey);

  // Get submissions for the KPI for the past 3 months
  const { data: submissions, error } = await supabase
    .from('kpi_submissions')
    .select('value, created_at')
    .eq('kpi_id', kpiId)
    .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!submissions || submissions.length < 2) {
    return new Response(JSON.stringify({ target: null }), { status: 200 });
  }

  // Simple linear regression (y = mx + b) where x is month index
  const xVals = submissions.map((_s, i) => i + 1);
  const yVals = submissions.map((s: any) => Number(s.value));
  const n = xVals.length;
  const sumX = xVals.reduce((a, b) => a + b, 0);
  const sumY = yVals.reduce((a, b) => a + b, 0);
  const sumXY = xVals.reduce((acc, x, i) => acc + x * yVals[i], 0);
  const sumXX = xVals.reduce((acc, x) => acc + x * x, 0);
  const m = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const b = (sumY - m * sumX) / n;
  const nextX = n + 1;
  const predicted = m * nextX + b;

  // Upsert into kpi_targets table
  const { error: upsertErr } = await supabase
    .from('kpi_targets')
    .upsert({ kpi_id: kpiId, target_value: predicted, generated_at: new Date().toISOString() });

  if (upsertErr) {
    return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500 });
  }
  return new Response(JSON.stringify({ target: predicted }), { status: 200 });
}
