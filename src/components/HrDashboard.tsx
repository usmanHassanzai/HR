import { useState } from 'react';
import { CalendarClock, Gift } from 'lucide-react';
import { Profile } from '../utils/kpiHelpers';
import AttendanceLeavePanel from './AttendanceLeavePanel';
import MyShiftCard from './MyShiftCard';
import AdminRewards from './AdminRewards';
import '../styles/admin-dashboard.css';
import '../styles/admin-attendance.css';
import '../styles/admin-rewards.css';

interface HrDashboardProps {
  profile: Profile;
  organizationName?: string | null;
}

export default function HrDashboard({ profile, organizationName }: HrDashboardProps) {
  const [tab, setTab] = useState<'shifts' | 'rewards'>('shifts');

  return (
    <div className="admin-simple">
      <div className="attendance-section-tabs admin-attendance-tabs tab-bar tab-bar--inline-mobile" role="tablist" aria-label="HR sections">
        <button type="button" className={`tab-btn ${tab === 'shifts' ? 'tab-btn--active' : ''}`} onClick={() => setTab('shifts')}>
          <CalendarClock size={16} /> Shifts
        </button>
        <button type="button" className={`tab-btn ${tab === 'rewards' ? 'tab-btn--active' : ''}`} onClick={() => setTab('rewards')}>
          <Gift size={16} /> Rewards
        </button>
      </div>

      {tab === 'shifts' ? (
        <>
          <header className="admin-attendance-header glass-panel" style={{ marginBottom: '1rem' }}>
            <div className="admin-attendance-header__main">
              <div className="admin-attendance-header__icon">
                <CalendarClock size={22} />
              </div>
              <div>
                <h2 className="admin-attendance-header__title">HR — company shifts</h2>
                <p className="admin-attendance-header__subtitle">
                  {organizationName ? `${organizationName}: ` : ''}
                  Assign and edit start/end times and working days for every employee. Changes apply immediately — no admin approval.
                </p>
              </div>
            </div>
          </header>
          <MyShiftCard userId={profile.id} />
          <AttendanceLeavePanel profile={profile} mode="hr" />
        </>
      ) : (
        <AdminRewards />
      )}
    </div>
  );
}
