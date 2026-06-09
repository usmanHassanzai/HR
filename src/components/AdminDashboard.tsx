import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import { Users, Settings, Plus, UserPlus, Trash2, Edit2, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

interface AdminDashboardProps {
  profile: Profile;
}

export default function AdminDashboard({ profile }: AdminDashboardProps) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [managers, setManagers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'users' | 'kpis'>('users');

  // User Form States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'employee' | 'manager' | 'admin'>('employee');
  const [managerId, setManagerId] = useState('');
  const [userFormLoading, setUserFormLoading] = useState(false);
  const [userFormMsg, setUserFormMsg] = useState({ type: '', text: '' });

  // KPI Config States
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userKpis, setUserKpis] = useState<Kpi[]>([]);
  const [kpiLoading, setKpiLoading] = useState(false);
  
  // New KPI Form States
  const [newKpiName, setNewKpiName] = useState('');
  const [newKpiDesc, setNewKpiDesc] = useState('');
  const [newKpiTarget, setNewKpiTarget] = useState('');
  const [newKpiWeight, setNewKpiWeight] = useState('1.0');
  const [newKpiCategory, setNewKpiCategory] = useState('');
  const [newKpiDirection, setNewKpiDirection] = useState<'higher_better' | 'lower_better'>('higher_better');
  const [kpiFormLoading, setKpiFormLoading] = useState(false);
  const [kpiFormError, setKpiFormError] = useState('');

  // Editing KPI states
  const [editingKpiId, setEditingKpiId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState('');
  const [editWeight, setEditWeight] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: allUsers, error: usersError } = await supabase
        .from('users')
        .select('*')
        .order('created_at', { ascending: false });

      if (usersError) console.error('Error fetching users:', usersError);
      else {
        setUsers(allUsers || []);
        setManagers((allUsers || []).filter(u => u.role === 'manager' || u.role === 'admin'));
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

  const fetchUserKpis = async (userId: string) => {
    if (!userId) {
      setUserKpis([]);
      return;
    }
    setKpiLoading(true);
    try {
      const { data, error } = await supabase
        .from('kpis')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (error) console.error('Error fetching user KPIs:', error);
      else setUserKpis(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setKpiLoading(false);
    }
  };

  useEffect(() => {
    fetchUserKpis(selectedUserId);
  }, [selectedUserId]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !fullName) {
      setUserFormMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }

    setUserFormLoading(true);
    setUserFormMsg({ type: '', text: '' });

    try {
      // 1. Sign up new auth user (triggers handle_new_user public trigger)
      const { data: signupData, error: signupError } = await supabase.auth.signUp({
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
        // 2. Since the trigger syncs role/fullname, now update manager_id if selected
        if (managerId && role !== 'admin') {
          const { error: updateError } = await supabase
            .from('users')
            .update({ manager_id: managerId })
            .eq('id', signupData.user.id);
          
          if (updateError) {
            console.error('Error setting user manager:', updateError.message);
          }
        }

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

  const handleCreateKpi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    if (!newKpiName || !newKpiTarget) {
      setKpiFormError('KPI Name and Target are required.');
      return;
    }

    setKpiFormLoading(true);
    setKpiFormError('');

    try {
      const { error } = await supabase
        .from('kpis')
        .insert({
          user_id: selectedUserId,
          name: newKpiName,
          description: newKpiDesc.trim() || null,
          target_value: parseFloat(newKpiTarget),
          weight: parseFloat(newKpiWeight),
          category: newKpiCategory.trim() || null,
          direction: newKpiDirection
        });

      if (error) {
        setKpiFormError(error.message);
      } else {
        setNewKpiName('');
        setNewKpiDesc('');
        setNewKpiTarget('');
        setNewKpiWeight('1.0');
        setNewKpiCategory('');
        setNewKpiDirection('higher_better');
        fetchUserKpis(selectedUserId);
      }
    } catch (err: any) {
      setKpiFormError(err.message || 'Submission error.');
    } finally {
      setKpiFormLoading(false);
    }
  };

  const handleUpdateKpiConfig = async (kpiId: string) => {
    if (!editTarget || isNaN(Number(editTarget))) return;

    try {
      const { error } = await supabase
        .from('kpis')
        .update({
          target_value: parseFloat(editTarget),
          weight: parseFloat(editWeight) || 1.0
        })
        .eq('id', kpiId);

      if (error) {
        console.error('Error updating KPI config:', error);
      } else {
        setEditingKpiId(null);
        fetchUserKpis(selectedUserId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (userId === profile.id) {
      alert("Cannot delete your own administrator profile.");
      return;
    }

    if (!confirm("Are you sure you want to remove this user profile? All associated KPIs and submissions will be permanently deleted.")) {
      return;
    }

    try {
      // Deleting public user cascade deletes from database tables (kpis, tasks, notifications, submissions)
      const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

      if (error) {
        alert(`Error: ${error.message}`);
      } else {
        fetchData();
        if (selectedUserId === userId) setSelectedUserId('');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Admin Tab System */}
      <div style={{ display: 'flex', gap: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <button 
          className={`btn ${activeTab === 'users' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('users')}
          style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
        >
          <Users size={16} /> User Profiles Management
        </button>
        <button 
          className={`btn ${activeTab === 'kpis' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setActiveTab('kpis')}
          style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
        >
          <Settings size={16} /> KPI Target configurations
        </button>
      </div>

      {activeTab === 'users' ? (
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
      ) : (
        /* KPI Configurations Tab */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '2rem' }}>
          
          {/* Selected User's KPIs Config List */}
          <div className="glass-panel" style={{ flex: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', margin: 0 }}>KPI Targets Settings</h3>
              
              <select 
                value={selectedUserId} 
                onChange={(e) => setSelectedUserId(e.target.value)}
                style={{ width: 'auto', padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
              >
                <option value="">-- Select Employee --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>
                ))}
              </select>
            </div>

            {!selectedUserId ? (
              <div style={{ padding: '4rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                Please select an employee from the dropdown list to configure their KPI targets.
              </div>
            ) : kpiLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
                <Loader2 className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '500px', overflowY: 'auto', paddingRight: '4px' }}>
                {userKpis.length === 0 ? (
                  <div style={{ padding: '3rem 1rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                    No KPIs currently configured for this employee.
                  </div>
                ) : (
                  userKpis.map(kpi => (
                    <div 
                      key={kpi.id}
                      style={{
                        padding: '1rem',
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--border-radius-sm)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <strong style={{ fontSize: '0.95rem' }}>{kpi.name}</strong>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', marginTop: '2px' }}>
                            {kpi.category} &bull; {kpi.direction.replace('_', ' ')}
                          </span>
                        </div>

                        {editingKpiId !== kpi.id ? (
                          <button 
                            className="btn btn-secondary"
                            onClick={() => {
                              setEditingKpiId(kpi.id);
                              setEditTarget(String(kpi.target_value));
                              setEditWeight(String(kpi.weight));
                            }}
                            style={{ padding: '0.45rem', borderRadius: '50%', borderColor: 'transparent' }}
                            title="Edit Targets"
                          >
                            <Edit2 size={14} />
                          </button>
                        ) : (
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button 
                              className="btn btn-primary" 
                              onClick={() => handleUpdateKpiConfig(kpi.id)}
                              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            >
                              Save
                            </button>
                            <button 
                              className="btn btn-secondary" 
                              onClick={() => setEditingKpiId(null)}
                              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>

                      {editingKpiId === kpi.id ? (
                        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                          <div className="form-group" style={{ margin: 0, flex: 1 }}>
                            <label style={{ fontSize: '0.75rem' }}>Target Value</label>
                            <input 
                              type="number" 
                              step="any"
                              value={editTarget}
                              onChange={(e) => setEditTarget(e.target.value)}
                              style={{ padding: '0.4rem' }}
                            />
                          </div>
                          <div className="form-group" style={{ margin: 0, flex: 1 }}>
                            <label style={{ fontSize: '0.75rem' }}>Weight Multipier</label>
                            <input 
                              type="number" 
                              step="any"
                              value={editWeight}
                              onChange={(e) => setEditWeight(e.target.value)}
                              style={{ padding: '0.4rem' }}
                            />
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                          <div>Target: <strong>{kpi.target_value}</strong></div>
                          <div>Current: <strong>{kpi.current_value}</strong></div>
                          <div>Weight: <strong>{kpi.weight}x</strong></div>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Add KPI form */}
          <div className="glass-panel" style={{ flex: 1, height: 'fit-content' }}>
            <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={20} /> Add KPI Indicator
            </h3>

            {kpiFormError && (
              <div style={{ 
                background: 'var(--color-danger-bg)', 
                color: 'var(--color-danger)', 
                padding: '0.75rem 1rem', 
                borderRadius: 'var(--border-radius-sm)', 
                fontSize: '0.85rem', 
                marginBottom: '1rem' 
              }}>
                {kpiFormError}
              </div>
            )}

            <form onSubmit={handleCreateKpi} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>KPI Name</label>
                <input 
                  type="text" 
                  placeholder="e.g. Absenteeism Rate"
                  value={newKpiName}
                  onChange={(e) => setNewKpiName(e.target.value)}
                  disabled={!selectedUserId}
                  required 
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Category Group</label>
                <input 
                  type="text" 
                  placeholder="e.g. Culture & Retention"
                  value={newKpiCategory}
                  onChange={(e) => setNewKpiCategory(e.target.value)}
                  disabled={!selectedUserId}
                />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Description</label>
                <textarea 
                  placeholder="Explain KPI metrics..."
                  rows={2}
                  value={newKpiDesc}
                  onChange={(e) => setNewKpiDesc(e.target.value)}
                  disabled={!selectedUserId}
                />
              </div>

              <div style={{ display: 'flex', gap: '1rem' }}>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label>Target Value</label>
                  <input 
                    type="number" 
                    step="any"
                    placeholder="e.g. 5"
                    value={newKpiTarget}
                    onChange={(e) => setNewKpiTarget(e.target.value)}
                    disabled={!selectedUserId}
                    required 
                  />
                </div>

                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label>Weight</label>
                  <input 
                    type="number" 
                    step="any"
                    value={newKpiWeight}
                    onChange={(e) => setNewKpiWeight(e.target.value)}
                    disabled={!selectedUserId}
                    required 
                  />
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label>Optimization Direction</label>
                <select 
                  value={newKpiDirection} 
                  onChange={(e) => setNewKpiDirection(e.target.value as any)}
                  disabled={!selectedUserId}
                >
                  <option value="higher_better">Higher is Better</option>
                  <option value="lower_better">Lower is Better</option>
                </select>
              </div>

              <button 
                type="submit" 
                className="btn btn-primary" 
                style={{ width: '100%', marginTop: '0.5rem' }} 
                disabled={kpiFormLoading || !selectedUserId}
              >
                {kpiFormLoading ? <Loader2 size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> : 'Add KPI Card'}
              </button>
            </form>
          </div>

        </div>
      )}

    </div>
  );
}
