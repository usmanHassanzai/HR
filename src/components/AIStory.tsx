// src/components/AIStory.tsx
import { useEffect, useState } from 'react';
import { callEdgeFunction } from '../utils/edgeFunctionClient';
import { Sparkles } from 'lucide-react';

interface AIStoryProps {
  kpiId: string;
}

export default function AIStory({ kpiId }: AIStoryProps) {
  const [narrative, setNarrative] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    async function fetchNarrative() {
      setLoading(true);
      try {
        const { narrative: result } = await callEdgeFunction<{ narrative: string }>('ai_narrative', { kpiId });
        setNarrative(result);
      } catch (e) {
        console.error('AI narrative fetch error', e);
      } finally {
        setLoading(false);
      }
    }
    fetchNarrative();
  }, [kpiId]);

  if (loading) return null;
  if (!narrative) return null;
  return (
    <p style={{
      fontSize: '0.75rem',
      color: 'var(--accent-primary)',
      marginBottom: '1rem',
      display: 'flex',
      gap: '0.35rem',
      alignItems: 'flex-start',
      lineHeight: 1.4,
    }}>
      <Sparkles size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
      <span>{narrative}</span>
    </p>
  );
}
