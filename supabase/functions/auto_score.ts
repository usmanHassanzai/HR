// supabase/functions/auto_score.ts
import { createClient } from '@supabase/supabase-js';

// Edge Function entry point
export default async function handler(req: Request) {
  // Expect JSON body with { userId }
  const { userId } = await req.json();
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Missing userId' }), { status: 400 });
  }
  // Initialize Supabase client (use anon key, but edge functions have service_role env variables)
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Fetch all KPI submissions for the user
  const { data: submissions, error } = await supabase
    .from('kpi_submissions')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Simple auto‑score: average of numeric values (assuming column "value")
  const numericValues = submissions?.map((s: any) => Number(s.value)).filter((v) => !isNaN(v)) ?? [];
  const avg = numericValues.length ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : 0;

  // Store the calculated score in a separate table (auto_scores)
  const { error: upsertError } = await supabase.from('auto_scores').upsert({
    user_id: userId,
    score: avg,
    calculated_at: new Date().toISOString()
  });

  if (upsertError) {
    return new Response(JSON.stringify({ error: upsertError.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ score: avg }), { status: 200 });
}
