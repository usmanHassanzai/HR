import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Menu, X, ChevronRight, LayoutGrid } from 'lucide-react';

export interface DashboardTabItem {
  id: string;
  label: string;
  /** Shorter label shown in mobile drawer when different from label */
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
  /** menu = hamburger drawer on mobile; inline = compact tabs under header (nested views) */
  mobilePlacement?: 'bottom' | 'inline';
}

export default function DashboardTabNav({
  tabs,
  activeTab,
  onTabChange,
  actions = [],
  mobilePlacement = 'bottom',
}: DashboardTabNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileItemCount = tabs.length + actions.length;
  const navClass =
    mobilePlacement === 'inline'
      ? 'tab-bar tab-bar--inline-mobile'
      : `tab-bar tab-bar--desktop${mobileItemCount > 5 ? ' tab-bar--many' : ''}`;

  const activeTabItem = tabs.find((tab) => tab.id === activeTab);
  const activeLabel = activeTabItem?.label ?? 'Dashboard';

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openMenu = useCallback(() => setMenuOpen(true), []);

  useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    document.body.classList.add('mobile-dash-drawer-open');
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.classList.remove('mobile-dash-drawer-open');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, closeMenu]);

  const handleTabSelect = (id: string) => {
    onTabChange(id);
    closeMenu();
  };

  const handleAction = (action: DashboardTabAction) => {
    action.onClick();
    closeMenu();
  };

  return (
    <>
      {/* Laptop / desktop — unchanged */}
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

      {/* Mobile — sticky section bar + hamburger drawer */}
      {mobilePlacement === 'bottom' && (
        <>
          <div className="mobile-dash-nav">
            <button
              type="button"
              className="mobile-dash-nav__menu-btn"
              onClick={openMenu}
              aria-expanded={menuOpen}
              aria-controls="mobile-dash-drawer"
            >
              <Menu size={21} strokeWidth={2.25} />
              <span className="mobile-dash-nav__menu-text">Menu</span>
            </button>

            <div className="mobile-dash-nav__current">
              <span className="mobile-dash-nav__eyebrow">Current section</span>
              <span className="mobile-dash-nav__label">{activeLabel}</span>
            </div>

            <div className="mobile-dash-nav__active-icon" aria-hidden="true">
              {activeTabItem?.icon ?? <LayoutGrid size={18} />}
            </div>
          </div>

          <div
            className={`mobile-dash-drawer${menuOpen ? ' mobile-dash-drawer--open' : ''}`}
            id="mobile-dash-drawer"
            aria-hidden={!menuOpen}
          >
            <button
              type="button"
              className="mobile-dash-drawer__backdrop"
              onClick={closeMenu}
              aria-label="Close menu"
              tabIndex={menuOpen ? 0 : -1}
            />

            <aside
              className="mobile-dash-drawer__panel"
              role="dialog"
              aria-modal="true"
              aria-label="Dashboard navigation"
            >
              <header className="mobile-dash-drawer__header">
                <div className="mobile-dash-drawer__header-text">
                  <span className="mobile-dash-drawer__eyebrow">Scorr</span>
                  <h2 className="mobile-dash-drawer__title">Dashboard menu</h2>
                </div>
                <button
                  type="button"
                  className="mobile-dash-drawer__close"
                  onClick={closeMenu}
                  aria-label="Close menu"
                >
                  <X size={22} strokeWidth={2.25} />
                </button>
              </header>

              <nav className="mobile-dash-drawer__nav" aria-label="Dashboard sections">
                {tabs.map((tab, index) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`mobile-dash-drawer__item${activeTab === tab.id ? ' mobile-dash-drawer__item--active' : ''}`}
                    onClick={() => handleTabSelect(tab.id)}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                    style={{ animationDelay: `${index * 35}ms` }}
                  >
                    <span className="mobile-dash-drawer__item-icon">{tab.icon}</span>
                    <span className="mobile-dash-drawer__item-text">
                      <span className="mobile-dash-drawer__item-label">{tab.label}</span>
                      {tab.mobileLabel && tab.mobileLabel !== tab.label && (
                        <span className="mobile-dash-drawer__item-sub">{tab.mobileLabel}</span>
                      )}
                    </span>
                    {activeTab === tab.id ? (
                      <span className="mobile-dash-drawer__item-badge">Active</span>
                    ) : (
                      <ChevronRight size={17} className="mobile-dash-drawer__item-chevron" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </nav>

              {actions.length > 0 && (
                <footer className="mobile-dash-drawer__footer">
                  <span className="mobile-dash-drawer__footer-label">Account</span>
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className="mobile-dash-drawer__action"
                      onClick={() => handleAction(action)}
                    >
                      <span className="mobile-dash-drawer__action-icon">{action.icon}</span>
                      <span>{action.label}</span>
                    </button>
                  ))}
                </footer>
              )}
            </aside>
          </div>
        </>
      )}
    </>
  );
}
