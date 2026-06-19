// supabase/functions/ai_narrative.ts
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: Request) {
  const { kpiId, recentSubmissions } = await req.json();
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'HF_API_KEY missing' }), { status: 500 });
  }
  const payload = {
    inputs: `Provide a concise one‑sentence insight for KPI ${kpiId} based on these recent submissions: ${JSON.stringify(recentSubmissions)}`,
  };
  const hfRes = await fetch('https://api-inference.huggingface.co/models/gpt-4o-mini', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = await hfRes.json();
  const narrative = result?.generated_text || 'No insight available.';
  return new Response(JSON.stringify({ narrative }), { status: 200 });
}
