import { AlertTriangle } from 'lucide-react';

export default function DemoModeBanner() {
  return (
    <div className="demo-mode-banner" role="status">
      <AlertTriangle size={18} />
      <div>
        <strong>Demo sandbox mode</strong>
        <span>
          You are using a demo account. Changes only affect demo data and do not impact real production users or settings.
        </span>
      </div>
    </div>
  );
}
