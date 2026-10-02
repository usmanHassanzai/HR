import { useMemo, useState, lazy, Suspense } from 'react';
import { FileText, Users } from 'lucide-react';
import { Profile } from '../utils/kpiHelpers';
import TabFallback from './TabFallback';
import { useHistorySyncedTab } from '../utils/useHistoryNavigation';
import '../styles/daily-work-reports.css';

const DailyWorkReportPanel = lazy(() => import('./DailyWorkReportPanel'));
const AdminDailyWorkReports = lazy(() => import('./AdminDailyWorkReports'));

type HrDwrTab = 'mine' | 'organization';

interface HrDailyReportsWorkspaceProps {
  profile: Profile;
  initialSearch?: string;
  initialDeptId?: string;
}

export default function HrDailyReportsWorkspace({
  profile,
  initialSearch = '',
  initialDeptId = 'all',
}: HrDailyReportsWorkspaceProps) {
  const defaultTab: HrDwrTab = initialSearch || (initialDeptId && initialDeptId !== 'all')
    ? 'organization'
    : 'mine';
  const [tab, setTab] = useState<HrDwrTab>(defaultTab);

  useHistorySyncedTab(tab, setTab, {
    key: 'scorr-hr-dwr-tab',
    trapAtRoot: false,
  });

  const meta = useMemo(() => {
    if (tab === 'mine') {
      return {
        title: 'My daily report',
        description: 'Submit your work summary to company admin. Only admins can read what you send.',
      };
    }
    return {
      title: 'Organization reports',
      description: 'Review manager and employee daily reports by date and department across the company.',
    };
  }, [tab]);

  return (
    <div className="dwr-hr-workspace animate-fade-in">
      <header className="dwr-hr-workspace__hero glass-panel">
        <div className="dwr-hr-workspace__hero-icon" aria-hidden>
          <FileText size={22} />
        </div>
        <div className="dwr-hr-workspace__hero-copy">
          <span className="dash-eyebrow">HR workspace</span>
          <h2>{meta.title}</h2>
          <p>{meta.description}</p>
        </div>
      </header>

      <div
        className="dwr-hr-workspace__tabs tab-bar tab-bar--inline-mobile"
        role="tablist"
        aria-label="Daily report sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mine'}
          className={`tab-btn ${tab === 'mine' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('mine')}
        >
          <FileText size={16} />
          <span>My report</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'organization'}
          className={`tab-btn ${tab === 'organization' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('organization')}
        >
          <Users size={16} />
          <span>Organization</span>
        </button>
      </div>

      <Suspense fallback={<TabFallback />}>
        {tab === 'mine' ? (
          <DailyWorkReportPanel profile={profile} compact />
        ) : (
          <AdminDailyWorkReports
            variant="hr"
            initialSearch={initialSearch}
            initialDeptId={initialDeptId}
          />
        )}
      </Suspense>
    </div>
  );
}
