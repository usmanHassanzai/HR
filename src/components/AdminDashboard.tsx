import React, { useState, useEffect } from 'react';
import { supabase, supabaseSignup } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Users, UserPlus, Trash2, Loader2, AlertCircle, CheckCircle, Download, FileSpreadsheet, FileText, BarChart3, Palette, Trophy, KeyRound } from 'lucide-react';
import { fetchQuarterlyReportData, fetchMonthlyReportData, exportToCsv, exportToExcel, exportToPdf } from '../utils/exportReport';
import Analytics from './Analytics';
import BrandingSettings from './BrandingSettings';
import AdminRewards from './AdminRewards';
import AdminResetPasswordModal from './AdminResetPasswordModal';

interface AdminDashboardProps {
  profile: Profile;
}

export default function AdminDashboard({ profile }: AdminDashboardProps) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [managers, setManagers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'users' | 'export' | 'analytics' | 'branding' | 'rewards'>('users');

  // User Form States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'employee' | 'manager' | 'admin'>('employee');
  const [managerId, setManagerId] = useState('');
  const [userFormLoading, setUserFormLoading] = useState(false);
  const [userFormMsg, setUserFormMsg] = useState({ type: '', text: '' });

  // Password reset modal state
  const [resetPasswordUser, setResetPasswordUser] = useState<{ id: string; name: string } | null>(null);

  // Export states
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: allUsers, error: usersError } = await supabase
        .rpc('get_all_users_admin');

      if (usersError) console.error('Error fetching users:', usersError);
      else {
        const usersList = (allUsers || []) as Profile[];
        setUsers(usersList);
        setManagers(usersList.filter((u) => u.role === 'manager' || u.role === 'admin'));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleExport = async (format: 'csv' | 'excel' | 'pdf', period: 'quarterly' | 'monthly' = 'quarterly') => {
    setExportLoading(true);
    setExportMsg('');
    try {
      const data = period === 'monthly' ? await fetchMonthlyReportData() : await fetchQuarterlyReportData();
      if (format === 'csv') exportToCsv(data);
      else if (format === 'excel') await exportToExcel(data);
      else await exportToPdf(data);
      setExportMsg(`${period === 'monthly' ? 'Monthly' : 'Quarterly'} report exported as ${format.toUpperCase()}.`);
    } catch (err: any) {
      setExportMsg(err.message || 'Export failed.');
    } finally {
      setExportLoading(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !fullName) {
      setUserFormMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }

    setUserFormLoading(true);
    setUserFormMsg({ type: '', text: '' });

    try {
      // 1. Create the auth user via a non-persisting client so the admin's
      //    own session is never replaced (signUp would otherwise log the
      //    admin in as the new user). The handle_new_user trigger syncs the
      //    public.users profile (full_name + role) automatically.
      const { data: signupData, error: signupError } = await supabaseSignup.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role: role
          }
        }
      });

      if (signupError) {
        setUserFormMsg({ type: 'error', text: signupError.message });
        setUserFormLoading(false);
        return;
      }

      if (signupData.user) {
        // 2. Assign manager (runs on the main admin-authenticated client).
        if (managerId && role !== 'admin') {
          const { error: updateError } = await supabase
            .from('users')
            .update({ manager_id: managerId })
            .eq('id', signupData.user.id);
          
          if (updateError) {
            console.error('Error setting user manager:', updateError.message);
          }
        }

        // Clear the throwaway signup client's in-memory session.
        await supabaseSignup.auth.signOut();

        setUserFormMsg({ type: 'success', text: `Successfully registered user profile for ${fullName}.` });
        setEmail('');
        setPassword('');
        setFullName('');
        setRole('employee');
        setManagerId('');
        
        // Refresh users list
        fetchData();
      }
    } catch (err: any) {
      setUserFormMsg({ type: 'error', text: err.message || 'An error occurred.' });
    } finally {
      setUserFormLoading(false);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (userId === profile.id) {
      alert("Cannot delete your own administrator profile.");
      return;
    }

    if (!confirm("Are you sure you want to permanently delete this user? Their login account and all associated KPIs, tasks, and submissions will be permanently removed.")) {
      return;
    }

    try {
      // Deletes the auth.users record server-side (SECURITY DEFINER), which
      // cascades to public.users and all related tables.
      const { error } = await supabase.rpc('delete_user_admin', { p_user_id: userId });

      if (error) {
        alert(`Error: ${error.message}`);
      } else {
        fetchData();
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

      {resetPasswordUser && (
        <AdminResetPasswordModal
          userId={resetPasswordUser.id}
          userName={resetPasswordUser.name}
          onClose={() => setResetPasswordUser(null)}
        />
      )}

      {/* Admin Tab System */}
      <div className="tab-bar">
        <button 
          className={`tab-btn ${activeTab === 'users' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          <Users size={16} /> Users
        </button>
        <button 
          className={`tab-btn ${activeTab === 'export' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('export')}
        >
          <Download size={16} /> Reports
        </button>
        <button 
          className={`tab-btn ${activeTab === 'analytics' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('analytics')}
        >
          <BarChart3 size={16} /> Analytics
        </button>
        <button 
          className={`tab-btn ${activeTab === 'branding' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('branding')}
        >
          <Palette size={16} /> Branding
        </button>
        <button 
          className={`tab-btn ${activeTab === 'rewards' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('rewards')}
        >
          <Trophy size={16} /> Rewards
        </button>
      </div>

      {activeTab === 'export' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '680px' }}>

          {exportMsg && (
            <div style={{
              background: exportMsg.includes('failed') ? 'var(--color-danger-bg)' : 'var(--color-success-bg)',
              color: exportMsg.includes('failed') ? 'var(--color-danger)' : 'var(--color-success)',
              padding: '0.75rem 1rem', borderRadius: 'var(--border-radius-sm)', fontSize: '0.85rem',
            }}>
              {exportMsg}
            </div>
          )}

          {/* Monthly report */}
          <div className="glass-panel" style={{ borderLeft: '4px solid var(--accent-primary)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: 'var(--font-display)', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Download size={16} style={{ color: 'var(--accent-primary)' }} />
              Monthly Report
            </h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              KPI snapshot, submission log, and AI insights for the <strong>current calendar month</strong>.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              <button className="btn btn-primary" onClick={() => handleExport('excel', 'monthly')} disabled={exportLoading}>
                {exportLoading ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <FileSpreadsheet size={15} />}
                Excel
              </button>
              <button className="btn btn-secondary" onClick={() => handleExport('pdf', 'monthly')} disabled={exportLoading}>
                <FileText size={15} /> PDF
              </button>
              <button className="btn btn-secondary" onClick={() => handleExport('csv', 'monthly')} disabled={exportLoading}>
                <Download size={15} /> CSV
              </button>
            </div>
          </div>

          {/* Quarterly report */}
          <div className="glass-panel">
            <h3 style={{ fontSize: '1.1rem', fontFamily: 'var(--font-display)', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Download size={16} />
              Quarterly Report
            </h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              Full organizational KPI report including AI insights, suggested targets, and submission history for the <strong>current quarter</strong>.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              <button className="btn btn-primary" onClick={() => handleExport('excel', 'quarterly')} disabled={exportLoading}>
                {exportLoading ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <FileSpreadsheet size={15} />}
                Excel
              </button>
              <button className="btn btn-secondary" onClick={() => handleExport('pdf', 'quarterly')} disabled={exportLoading}>
                <FileText size={15} /> PDF
              </button>
              <button className="btn btn-secondary" onClick={() => handleExport('csv', 'quarterly')} disabled={exportLoading}>
                <Download size={15} /> CSV
              </button>
            </div>
          </div>
        </div>
      ) : activeTab === 'analytics' ? (
        <Analytics title="Organization-Wide Analytics" />
      ) : activeTab === 'branding' ? (
        <BrandingSettings />
      ) : activeTab === 'rewards' ? (
        <AdminRewards />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '2rem' }}>
          
          {/* User Directory List */}
          <div className="glass-panel" style={{ flex: 2 }}>
            <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
              User Directory ({users.length})
            </h3>
            
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                <Loader2 className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '500px', overflowY: 'auto', paddingRight: '4px' }}>
                {users.map(u => {
                  const userManager = users.find(m => m.id === u.manager_id);
                  return (
                    <div 
                      key={u.id}
                      style={{
                        padding: '0.85rem 1rem',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--border-radius-sm)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '1rem'
                      }}
                    >
                      <div>
                        <strong style={{ display: 'block', fontSize: '0.9rem' }}>{u.full_name}</strong>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{u.email}</span>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '4px', alignItems: 'center' }}>
                          <span className="badge badge-on-track" style={{ fontSize: '0.6rem', padding: '1px 6px' }}>{u.role}</span>
                          {userManager && (
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              Reports to: {userManager.full_name}
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        className="btn btn-secondary"
                        onClick={() => setResetPasswordUser({ id: u.id, name: u.full_name })}
                        style={{ padding: '0.45rem', borderRadius: '50%', borderColor: 'transparent' }}
                        title="Reset Password"
                      >
                        <KeyRound size={14} />
                      </button>
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => handleDeleteUser(u.id)}
                        style={{ padding: '0.45rem', borderRadius: '50%', color: 'var(--color-danger)', borderColor: 'transparent' }}
                        title="Delete User"
                        disabled={u.id === profile.id}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add User Form */}
          <div className="glass-panel" style={{ flex: 1, height: 'fit-content' }}>
            <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <UserPlus size={20} /> Add New User
            </h3>

            {userFormMsg.text && (
              <div style={{
                background: userFormMsg.type === 'success' ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                color: userFormMsg.type === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
                padding: '0.75rem 1rem',
                borderRadius: 'var(--border-radius-sm)',
                fontSize: '0.85rem',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                {userFormMsg.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                <span>{userFormMsg.text}</span>
              </div>
            )}

            <form onSubmit={handleCreateUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Full Name</label>
                <input 
                  type="text" 
                  placeholder="e.g. John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required 
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Email Address</label>
                <input 
                  type="email" 
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required 
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Password</label>
                <input 
                  type="password" 
                  placeholder="Min 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required 
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>System Role</label>
                <select value={role} onChange={(e) => setRole(e.target.value as any)}>
                  <option value="employee">Employee</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {role !== 'admin' && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Assign Manager</label>
                  <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                    <option value="">-- None --</option>
                    {managers.map(m => (
                      <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>
                    ))}
                  </select>
                </div>
              )}

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={userFormLoading}>
                {userFormLoading ? <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> : 'Register User'}
              </button>
            </form>
          </div>

        </div>
      )}

    </div>
  );
}
