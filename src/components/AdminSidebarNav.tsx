import { useEffect, type ReactNode } from 'react';
import { LayoutDashboard, Shield, X } from 'lucide-react';

export interface AdminNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  description?: string;
  badge?: number;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

interface AdminSidebarNavProps {
  groups: AdminNavGroup[];
  activeTab: string;
  onTabChange: (id: string) => void;
  navOpen: boolean;
  onNavOpenChange: (open: boolean) => void;
  platformOwner?: boolean;
  organizationName?: string | null;
  brandTitle?: string;
  brandSubtitle?: string;
  ariaLabel?: string;
  sidebarId?: string;
  stats?: { users: number; departments: number; managers: number };
}

function useCloseOnEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export default function AdminSidebarNav({
  groups,
  activeTab,
  onTabChange,
  navOpen,
  onNavOpenChange,
  platformOwner,
  organizationName,
  brandTitle,
  brandSubtitle,
  ariaLabel = 'Admin navigation',
  sidebarId = 'admin-sidebar',
  stats,
}: AdminSidebarNavProps) {
  useCloseOnEscape(navOpen, () => onNavOpenChange(false));

  useEffect(() => {
    if (!navOpen) return;
    const mq = window.matchMedia('(max-width: 899px)');
    if (!mq.matches) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  const handleSelect = (id: string) => {
    onTabChange(id);
    onNavOpenChange(false);
  };

  const flatItems = groups.flatMap((group) => group.items);

  return (
    <>
    <aside
      id={sidebarId}
      className={`admin-shell__sidebar ${navOpen ? 'admin-shell__sidebar--open' : ''}`}
      aria-label={ariaLabel}
    >
      <div className="admin-shell__sidebar-brand">
        <div className="admin-shell__sidebar-logo">
          <LayoutDashboard size={20} />
        </div>
        <div className="admin-shell__sidebar-brand-text">
          <strong>{brandTitle || organizationName?.trim() || 'Scorr Admin'}</strong>
          <span>{brandSubtitle || (organizationName?.trim() ? 'Workspace' : 'Workspace')}</span>
        </div>
        <button
          type="button"
          className="admin-shell__sidebar-close"
          onClick={() => onNavOpenChange(false)}
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="admin-shell__nav">
        {groups.map((group) => (
          <div key={group.label} className="admin-shell__nav-group">
            {group.label !== 'Menu' && (
              <p className="admin-shell__nav-group-label">{group.label}</p>
            )}
            <ul className="admin-shell__nav-list">
              {group.items.map((item) => {
                const active = activeTab === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`admin-shell__nav-item ${active ? 'admin-shell__nav-item--active' : ''}`}
                      onClick={() => handleSelect(item.id)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="admin-shell__nav-icon">{item.icon}</span>
                      <span className="admin-shell__nav-label">{item.label}</span>
                      {item.badge != null && item.badge > 0 && (
                        <span className="admin-shell__nav-badge" aria-label={`${item.badge} new`}>
                          {item.badge > 9 ? '9+' : item.badge}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="admin-shell__sidebar-footer">
        {platformOwner && (
          <span className="admin-shell__owner-pill">
            <Shield size={12} /> Platform owner
          </span>
        )}
        {stats && (
          <div className="admin-shell__sidebar-stats">
            <div>
              <strong>{stats.users}</strong>
              <span>Users</span>
            </div>
            <div>
              <strong>{stats.departments}</strong>
              <span>Depts</span>
            </div>
            <div>
              <strong>{stats.managers}</strong>
              <span>Managers</span>
            </div>
          </div>
        )}
      </div>
    </aside>

    <nav className="app-bottom-nav" aria-label={ariaLabel}>
      {flatItems.map((item) => {
        const active = activeTab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`app-bottom-nav__item ${active ? 'app-bottom-nav__item--active' : ''}`}
            onClick={() => handleSelect(item.id)}
            aria-current={active ? 'page' : undefined}
          >
            <span className="app-bottom-nav__icon">{item.icon}</span>
            <span className="app-bottom-nav__label">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="app-bottom-nav__badge">{item.badge > 9 ? '9+' : item.badge}</span>
            )}
          </button>
        );
      })}
    </nav>
    </>
  );
}

export function getAdminNavMeta(id: string): { label: string; description: string } {
  const map: Record<string, { label: string; description: string }> = {
    home: { label: 'Today', description: '' },
    employees: { label: 'Employees', description: 'Accounts, roles, and departments.' },
    users: { label: 'People', description: 'Add teammates, set roles, and manage logins.' },
    kpis: { label: 'Assign Task', description: 'Create KPIs, assign them, and review or edit assigned tasks.' },
    dailyReports: { label: 'Daily Reports', description: 'Staff daily work logs.' },
    kpiPoints: { label: 'KPI & Rewards', description: "Each person's KPI score, performance points, and reward points." },
    analytics: { label: 'Analytics', description: 'Trends and attainment.' },
    attendance: { label: 'Attendance', description: 'Leave, check-ins, and live map.' },
    office: { label: 'Office GPS', description: 'Geofence and check-ins.' },
    tracking: { label: 'Live Tracking', description: 'Field team locations.' },
    departments: { label: 'Departments', description: 'Org structure.' },
    rewards: { label: 'Rewards', description: 'Catalog, points, and redemptions.' },
    export: { label: 'Export', description: 'Monthly and quarterly exports.' },
    settings: { label: 'Settings', description: 'Logo and company theme.' },
    companies: { label: 'Registered Companies', description: 'Approve new company sign-ups.' },
    kpiManagement: { label: 'KPIs', description: 'Individual assignments and points.' },
    branding: { label: 'Settings', description: 'Logo and company theme.' },
  };
  return map[id] ?? { label: 'Admin', description: 'Organization administration.' };
}

export function findAdminNavIcon(groups: AdminNavGroup[], id: string): ReactNode | null {
  for (const group of groups) {
    const item = group.items.find((i) => i.id === id);
    if (item) return item.icon;
  }
  return null;
}
