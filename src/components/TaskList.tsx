import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Task, TaskStatus } from '../utils/kpiHelpers';
import { Calendar, CheckCircle2, Circle, Clock, AlertTriangle, Loader2 } from 'lucide-react';

interface TaskListProps {
  userId: string;
}

export default function TaskList({ userId }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('user_id', userId)
        .order('due_date', { ascending: true });

      if (error) {
        console.error('Error fetching tasks:', error);
      } else {
        setTasks(data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();

    // Subscribe to task changes in real-time
    const subscription = supabase
      .channel(`public:tasks:user=${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
        },
        (payload) => {
          const newRow = payload.new as Task;
          const oldRow = payload.old as Task;

          if (payload.eventType === 'INSERT' && newRow.user_id === userId) {
            setTasks(prev => [...prev, newRow].sort((a, b) => {
              if (!a.due_date) return 1;
              if (!b.due_date) return -1;
              return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
            }));
          } else if (payload.eventType === 'UPDATE' && newRow.user_id === userId) {
            setTasks(prev => prev.map(t => t.id === newRow.id ? newRow : t));
          } else if (payload.eventType === 'DELETE') {
            setTasks(prev => prev.filter(t => t.id !== oldRow.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [userId]);

  const handleStatusChange = async (taskId: string, newStatus: TaskStatus) => {
    setUpdatingTaskId(taskId);
    try {
      const { error } = await supabase
        .from('tasks')
        .update({ status: newStatus })
        .eq('id', taskId);

      if (error) {
        console.error('Error updating task status:', error);
      } else {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUpdatingTaskId(null);
    }
  };

  const getTaskStatusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'done':
        return <CheckCircle2 size={18} style={{ color: 'var(--color-success)' }} />;
      case 'in_progress':
        return <Clock size={18} style={{ color: 'var(--color-warning)' }} />;
      default:
        return <Circle size={18} style={{ color: 'var(--text-muted)' }} />;
    }
  };

  const isOverdue = (task: Task) => {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date();
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem 0' }}>
        <Loader2 size={24} className="animate-spin" style={{ animation: 'spin 1s linear infinite', color: 'var(--accent-primary)' }} />
      </div>
    );
  }

  return (
    <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', margin: 0 }}>Action items & Tasks</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{tasks.filter(t => t.status !== 'done').length} remaining</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto', maxHeight: '320px', paddingRight: '4px' }}>
        {tasks.length === 0 ? (
          <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            No tasks assigned for this period.
          </div>
        ) : (
          tasks.map(task => {
            const taskOverdue = isOverdue(task);
            return (
              <div 
                key={task.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.85rem 1rem',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 'var(--border-radius-sm)',
                  border: `1px solid ${taskOverdue ? 'var(--color-danger-bg)' : 'var(--border-color)'}`,
                  gap: '1rem',
                  transition: 'var(--transition-smooth)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flex: 1 }}>
                  <div style={{ marginTop: '2px', display: 'flex', alignItems: 'center' }}>
                    {updatingTaskId === task.id ? (
                      <Loader2 size={18} className="animate-spin" style={{ animation: 'spin 1s linear infinite', color: 'var(--accent-primary)' }} />
                    ) : (
                      <button 
                        onClick={() => handleStatusChange(task.id, task.status === 'done' ? 'pending' : 'done')}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}
                        title={task.status === 'done' ? "Mark active" : "Mark completed"}
                      >
                        {getTaskStatusIcon(task.status)}
                      </button>
                    )}
                  </div>
                  <div>
                    <span style={{ 
                      fontSize: '0.9rem', 
                      fontWeight: 500, 
                      textDecoration: task.status === 'done' ? 'line-through' : 'none',
                      color: task.status === 'done' ? 'var(--text-muted)' : 'var(--text-primary)'
                    }}>
                      {task.title}
                    </span>
                    {task.description && (
                      <p style={{ 
                        fontSize: '0.75rem', 
                        color: 'var(--text-muted)', 
                        marginTop: '2px',
                        textDecoration: task.status === 'done' ? 'line-through' : 'none'
                      }}>
                        {task.description}
                      </p>
                    )}
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '6px' }}>
                      {task.due_date && (
                        <span style={{ 
                          fontSize: '0.7rem', 
                          color: taskOverdue ? 'var(--color-danger)' : 'var(--text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontWeight: taskOverdue ? 600 : 400
                        }}>
                          <Calendar size={10} /> Due {new Date(task.due_date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                      {taskOverdue && (
                        <span className="badge badge-off-track" style={{ fontSize: '0.6rem', padding: '1px 6px', display: 'flex', alignItems: 'center', gap: '2px' }}>
                          <AlertTriangle size={8} /> OVERDUE
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <select 
                    value={task.status} 
                    onChange={(e) => handleStatusChange(task.id, e.target.value as TaskStatus)}
                    style={{ 
                      background: 'rgba(0, 0, 0, 0.2)', 
                      border: '1px solid var(--border-color)', 
                      borderRadius: 'var(--border-radius-sm)', 
                      padding: '0.25rem 0.5rem', 
                      fontSize: '0.75rem',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer'
                    }}
                    disabled={updatingTaskId === task.id}
                  >
                    <option value="pending">Pending</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Completed</option>
                  </select>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
