import { Shield, Briefcase, User, ArrowRight } from 'lucide-react';

interface RewardsWorkflowBannerProps {
  variant?: 'admin' | 'manager' | 'employee';
}

export default function RewardsWorkflowBanner({ variant = 'employee' }: RewardsWorkflowBannerProps) {
  const steps = [
    {
      icon: <User size={18} />,
      role: 'Employee',
      color: 'var(--color-success)',
      tasks: ['Earn up to +1,000 pts/month by KPI score', 'Points never expire — redeem anytime', 'Track balance & leaderboard'],
    },
    {
      icon: <Briefcase size={18} />,
      role: 'Manager',
      color: 'var(--color-warning)',
      tasks: ['Approve & fulfill team redemptions', 'View team points & who qualified', 'Earn own points via Personal Dashboard'],
      highlight: variant === 'manager',
    },
    {
      icon: <Shield size={18} />,
      role: 'Admin',
      color: 'var(--accent-primary)',
      tasks: ['Manage reward catalog & point costs', 'Run monthly points calculation', 'Fulfill any redemption org-wide'],
      highlight: variant === 'admin',
    },
  ];

  return (
    <div className="rewards-workflow-banner">
      <div className="rewards-workflow-header">
        <span className="rewards-workflow-label">How Rewards Are Managed</span>
        <p className="rewards-workflow-sub">
          {variant === 'admin' && 'You control the catalog, monthly job, and org-wide fulfillment.'}
          {variant === 'manager' && 'You action redemptions for your direct reports. Admins manage the catalog & monthly points.'}
          {variant === 'employee' && 'Points are automatic. Your manager fulfills redemptions; admins manage the catalog.'}
        </p>
      </div>
      <div className="rewards-workflow-grid">
        {steps.map((s, i) => (
          <div key={s.role} className={`rewards-workflow-step ${s.highlight ? 'rewards-workflow-step--active' : ''}`}>
            <div className="rewards-workflow-step-head" style={{ color: s.color }}>
              {s.icon}
              <strong>{s.role}</strong>
              {i < steps.length - 1 && <ArrowRight size={14} className="rewards-workflow-arrow" />}
            </div>
            <ul>
              {s.tasks.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
