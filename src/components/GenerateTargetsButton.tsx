// src/components/GenerateTargetsButton.tsx
import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { TrendingUp, Loader2, CheckCircle } from 'lucide-react';
import { Kpi } from '../utils/kpiHelpers';

interface GenerateTargetsButtonProps {
  kpis: Kpi[];
  onTargetsGenerated: () => void;
}

/** Runs simple linear regression on a list of y values and returns predicted next value */
function linearRegression(values: number[]): number {
  const n = values.length;
  if (n < 2) return values[values.length - 1] ?? 0;
  const x = values.map((_, i) => i + 1);
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * values[i], 0);
  const sumXX = x.reduce((acc, xi) => acc + xi * xi, 0);
  const m = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const b = (sumY - m * sumX) / n;
  return Math.round((m * (n + 1) + b) * 100) / 100;
}

export default function GenerateTargetsButton({ kpis, onTargetsGenerated }: GenerateTargetsButtonProps) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    setDone(false);
    try {
      for (const kpi of kpis) {
        // Fetch last 3 months of submissions for this KPI
        const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const { data: submissions } = await supabase
          .from('kpi_submissions')
          .select('value, created_at')
          .eq('kpi_id', kpi.id)
          .gte('created_at', threeMonthsAgo)
          .order('created_at', { ascending: true });

        const history = (submissions || []).map((s: any) => Number(s.value)).filter(v => !isNaN(v));
        // If no submissions, use current_value as single point
        const points = history.length > 0 ? history : [kpi.current_value];
        const suggested = linearRegression(points);

        // Update kpi record with suggested_target
        await supabase
          .from('kpis')
          .update({ suggested_target: suggested })
          .eq('id', kpi.id);
      }
      setDone(true);
      onTargetsGenerated();
      setTimeout(() => setDone(false), 3000);
    } catch (e) {
      console.error('Target generation error:', e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className="btn btn-secondary"
      onClick={handleGenerate}
      disabled={loading}
      title="Generate monthly targets using linear regression"
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}
    >
      {loading ? (
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
      ) : done ? (
        <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />
      ) : (
        <TrendingUp size={14} />
      )}
      {loading ? 'Generating…' : done ? 'Targets Updated!' : 'Generate Monthly Targets'}
    </button>
  );
}
