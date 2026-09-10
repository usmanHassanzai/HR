import { useMemo, useState, lazy, Suspense } from 'react';
import { CalendarClock, Gift, KeyRound, Settings } from 'lucide-react';
import { Profile } from '../utils/kpiHelpers';
import TabFallback from './TabFallback';
import ChangePasswordModal from './ChangePasswordModal';
import AdminSidebarNav, { findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import '../styles/admin-dashboard.css';
import '../styles/admin-attendance.css';
import '../styles/hr-dashboard.css';

const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const MyShiftCard = lazy(() => import('./MyShiftCard'));
const AdminRewards = lazy(() => import('./AdminRewards'));
const AccountSecurityPanel = lazy(() => import('./AccountSecurityPanel'));
const BackupCodesLowBanner = lazy(() => import('./BackupCodesLowBanner'));

type HrTab = 'attendance' | 'rewards' | 'settings';

interface HrDashboardProps {
  profile: Profile;
  organizationName?: string | null;
}

function getHrNavMeta(id: string): { label: string; description: string } {
  const map: Record<string, { label: string; description: string }> = {
    attendance: {
      label: 'Attendance',
      description: 'Browse every employee’s attendance and manage company shifts.',
    },
    rewards: {
      label: 'Rewards',
      description: 'Catalog gifts, KPI awards, and redemption approvals.',
    },
    settings: {
      label: 'Settings',
      description: 'Password and account security.',
    },
  };
  return map[id] ?? { label: 'HR', description: 'People operations workspace.' };
}

export default function HrDashboard({ profile, organizationName }: HrDashboardProps) {
  const [activeTab, setActiveTab] = useState<HrTab>('attendance');
  const [navOpen, setNavOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const navGroups = useMemo<AdminNavGroup[]>(
    () => [
      {
        label: 'Workspace',
        items: [
          { id: 'attendance', label: 'Attendance', icon: <CalendarClock size={16} /> },
          { id: 'rewards', label: 'Rewards', icon: <Gift size={16} /> },
          { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
        ],
      },
    ],
    [],
  );

  const pageMeta = getHrNavMeta(activeTab);
  const pageIcon = findAdminNavIcon(navGroups, activeTab);
  const orgLabel = organizationName?.trim() || 'Your organization';

  return (
    <div className="admin-shell hr-dash">
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      <AdminSidebarNav
        groups={navGroups}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as HrTab)}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        organizationName={organizationName}
        brandTitle={orgLabel}
        brandSubtitle="HR workspace"
        ariaLabel="HR navigation"
        sidebarId="hr-sidebar"
      />

      {navOpen && (
        <div
          className="admin-shell__backdrop admin-shell__backdrop--visible"
          onClick={() => setNavOpen(false)}
          aria-hidden={false}
        />
      )}

      <div className="admin-shell__main">
        <header className="admin-shell__topbar">
          <AdminHamburgerButton
            open={navOpen}
            onClick={() => setNavOpen(!navOpen)}
            controlsId="hr-sidebar"
          />
          <div className="admin-shell__page-head">
            {pageIcon && <div className="admin-shell__page-icon">{pageIcon}</div>}
            <div>
              <p className="admin-shell__page-eyebrow">HR console</p>
              <h1 className="admin-shell__page-title">{pageMeta.label}</h1>
              <p className="admin-shell__page-desc">{pageMeta.description}</p>
            </div>
          </div>
        </header>

        <div className="admin-shell__content">
          <div className="admin-shell__panel">
            <Suspense fallback={<TabFallback />}>
              {activeTab === 'attendance' ? (
                <div className="hr-page-stack">
                  <section className="hr-intro glass-panel">
                    <div className="hr-intro__copy">
                      <p className="hr-intro__kicker">{orgLabel}</p>
                      <h2>Attendance &amp; shifts</h2>
                      <p>
                        View every employee’s check-in history by department, and assign working hours.
                        Changes to shifts apply immediately.
                      </p>
                    </div>
                    <div className="hr-intro__aside">
                      <MyShiftCard userId={profile.id} layout="banner" />
                    </div>
                  </section>
                  <AttendanceLeavePanel profile={profile} mode="hr" initialAdminTab="history" />
                </div>
              ) : activeTab === 'rewards' ? (
                <AdminRewards />
              ) : (
                <div className="app-settings-stack">
                  <BackupCodesLowBanner onOpenSettings={() => setActiveTab('settings')} />
                  <div className="app-settings-block">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowChangePassword(true)}
                    >
                      <KeyRound size={16} /> Change password
                    </button>
                  </div>
                  <details className="app-settings-block" open>
                    <summary>Account security (2FA recovery)</summary>
                    <AccountSecurityPanel fullName={profile.full_name} />
                  </details>
                </div>
              )}
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
