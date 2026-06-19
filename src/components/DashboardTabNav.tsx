import type { ReactNode } from 'react';

export interface DashboardTabItem {
  id: string;
  label: string;
  /** Shorter label for mobile bottom nav */
  mobileLabel?: string;
  icon: ReactNode;
}

export interface DashboardTabAction {
  id: string;
  label: string;
  mobileLabel?: string;
  icon: ReactNode;
  onClick: () => void;
}

interface DashboardTabNavProps {
  tabs: DashboardTabItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  actions?: DashboardTabAction[];
  /** bottom = fixed nav bar on mobile; inline = compact tabs under header (nested views) */
  mobilePlacement?: 'bottom' | 'inline';
}

export default function DashboardTabNav({
  tabs,
  activeTab,
  onTabChange,
  actions = [],
  mobilePlacement = 'bottom',
}: DashboardTabNavProps) {
  const navClass = mobilePlacement === 'inline' ? 'tab-bar tab-bar--inline-mobile' : 'tab-bar tab-bar--desktop';

  return (
    <>
      {/* Laptop / desktop — unchanged layout */}
      <div className={navClass}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-btn ${activeTab === tab.id ? 'tab-btn--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="tab-btn tab-btn--utility"
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>

      {/* Mobile — fixed bottom navbar (one screen at a time) */}
      {mobilePlacement === 'bottom' && (
        <nav className="mobile-bottom-nav" aria-label="Dashboard navigation">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`mobile-bottom-nav__item ${activeTab === tab.id ? 'mobile-bottom-nav__item--active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              <span className="mobile-bottom-nav__icon">{tab.icon}</span>
              <span className="mobile-bottom-nav__label">{tab.mobileLabel ?? tab.label}</span>
            </button>
          ))}
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="mobile-bottom-nav__item mobile-bottom-nav__item--action"
              onClick={action.onClick}
            >
              <span className="mobile-bottom-nav__icon">{action.icon}</span>
              <span className="mobile-bottom-nav__label">{action.mobileLabel ?? action.label}</span>
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
