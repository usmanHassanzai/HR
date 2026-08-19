import { Loader2 } from 'lucide-react';

export default function TabFallback() {
  return (
    <div className="dash-loading" style={{ minHeight: '12rem' }}>
      <Loader2 size={28} className="animate-spin" style={{ animation: 'spin 1.5s linear infinite' }} />
    </div>
  );
}
