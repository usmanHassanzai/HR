import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import '../styles/score-weightage.css';

export function SwLoading() {
  return (
    <div className="sw-loading" aria-busy="true">
      <Loader2 className="spin-icon" size={20} />
      <span>Loading scores</span>
    </div>
  );
}

export function SwNotice({ tone, children }: { tone: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return (
    <p className={`sw-notice sw-notice--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export function SwMix({ individual, team, large }: { individual: number; team: number; large?: boolean }) {
  const safeInd = Number.isFinite(individual) ? Math.max(0, Math.min(100, individual)) : 0;
  const safeTeam = Number.isFinite(team) ? Math.max(0, Math.min(100, team)) : 0;
  const scale = safeInd + safeTeam > 0 ? 100 / (safeInd + safeTeam) : 0;
  return (
    <div className={large ? 'sw-mix sw-mix--lg' : 'sw-mix'} aria-hidden="true">
      <span className="sw-mix__ind" style={{ width: `${safeInd * scale}%` }} />
      <span className="sw-mix__team" style={{ width: `${safeTeam * scale}%` }} />
    </div>
  );
}

export function sourceLabel(source: string | null | undefined): string {
  if (source === 'stored') return 'Saved';
  if (source === 'previous') return 'Earlier month';
  if (source === 'default') return 'Default 80/20';
  if (source === 'snapshot') return 'Approved';
  return '—';
}

export function SwSection({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sw-card">
      <header className="sw-card__head">
        <div>
          <h3>{title}</h3>
          {hint ? <p>{hint}</p> : null}
        </div>
        {actions ? <div className="sw-card__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
