import { useEffect, type ReactNode } from 'react';
import { LayoutDashboard, Shield, X } from 'lucide-react';

export interface AdminNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  description?: string;
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
  stats,
}: AdminSidebarNavProps) {
  useCloseOnEscape(navOpen, () => onNavOpenChange(false));

  useEffect(() => {
    if (!navOpen) return;
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

  return (
    <aside
      id="admin-sidebar"
      className={`admin-shell__sidebar ${navOpen ? 'admin-shell__sidebar--open' : ''}`}
      aria-label="Admin navigation"
    >
      <div className="admin-shell__sidebar-brand">
        <div className="admin-shell__sidebar-logo">
          <LayoutDashboard size={20} />
        </div>
        <div className="admin-shell__sidebar-brand-text">
          <strong>Scorr Admin</strong>
          <span>Control center</span>
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
            <p className="admin-shell__nav-group-label">{group.label}</p>
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
  );
}

export function getAdminNavMeta(id: string): { label: string; description: string } {
  const map: Record<string, { label: string; description: string }> = {
    companies: { label: 'Registered Companies', description: 'Review and approve new organization sign-ups.' },
    users: { label: 'Users', description: 'Manage accounts, roles, departments, and access.' },
    departments: { label: 'Departments', description: 'Configure departments and organizational weightages.' },
    kpis: { label: 'Assign Task', description: 'Assign and review KPI tasks across departments.' },
    export: { label: 'Reports', description: 'Export monthly and quarterly organization reports.' },
    analytics: { label: 'Analytics', description: 'KPI health, trends, forecasts, and attainment.' },
    branding: { label: 'Branding', description: 'Customize logo, colors, and company identity.' },
    rewards: { label: 'Rewards', description: 'Configure points, tiers, and redemption workflows.' },
    attendance: { label: 'Attendance', description: 'Leave requests, approvals, and attendance history.' },
    office: { label: 'Office GPS', description: 'Set office location and geofence for check-ins.' },
    tracking: { label: 'Live Tracking', description: 'Real-time team location and field activity.' },
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
