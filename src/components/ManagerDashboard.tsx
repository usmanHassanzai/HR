import { useState } from 'react';
import { Profile } from '../utils/kpiHelpers';
import Leaderboard from './Leaderboard';
import EmployeeDashboard from './EmployeeDashboard';
import { Users, BarChart3, ShieldAlert } from 'lucide-react';

interface ManagerDashboardProps {
  profile: Profile;
}

export default function ManagerDashboard({ profile }: ManagerDashboardProps) {
  const [selectedEmployee, setSelectedEmployee] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<'team' | 'personal'>('team');

  const handleSelectEmployee = (employeeProfile: Profile) => {
    setSelectedEmployee(employeeProfile);
  };

  const handleBackToLeaderboard = () => {
    setSelectedEmployee(null);
  };

  // If a manager clicks to drill down into an employee profile, load the EmployeeDashboard in Read-only view
  if (selectedEmployee) {
    return (
      <EmployeeDashboard 
        profile={profile} 
        readOnlyUser={selectedEmployee} 
        onBackToLeaderboard={handleBackToLeaderboard}
      />
    );
  }

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Tab Navigation for Team vs Personal KPIs */}
      <div style={{ display: 'flex', gap: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <button 
          className={`btn ${activeTab === 'team' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('team')}
          style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
        >
          <Users size={16} /> Team Performance
        </button>
        <button 
          className={`btn ${activeTab === 'personal' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('personal')}
          style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
        >
          <BarChart3 size={16} /> My Personal Dashboard
        </button>
      </div>

      {activeTab === 'team' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
          {/* Quick Metrics Panel */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-panel" style={{ borderLeft: '4px solid var(--accent-primary)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Direct Reports</span>
              <h3 style={{ fontSize: '1.8rem', fontFamily: 'var(--font-display)', margin: 0 }}>Team Overview</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>View rankings and performance metrics for employees in your organization.</p>
            </div>
            
            <div className="glass-panel" style={{ borderLeft: '4px solid var(--color-warning)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>System Alert Status</span>
              <h3 style={{ fontSize: '1.8rem', fontFamily: 'var(--font-display)', margin: 0, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ShieldAlert size={24} /> Alerts Active
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Off Track notifications will automatically trigger alerts in your menu header.</p>
            </div>
          </div>

          {/* Leaderboard Table showing team ranking */}
          <Leaderboard managerId={profile.id} onSelectEmployee={handleSelectEmployee} />
        </div>
      ) : (
        /* Personal Dashboard view (Managers are also employees who track their own KPIs) */
        <EmployeeDashboard profile={profile} />
      )}
    </div>
  );
}
