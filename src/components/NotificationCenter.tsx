import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Notification } from '../utils/kpiHelpers';
import { Bell, AlertCircle, Info, Calendar, Flame, Check } from 'lucide-react';

interface NotificationCenterProps {
  userId: string;
}

export default function NotificationCenter({ userId }: NotificationCenterProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching notifications:', error);
      } else {
        setNotifications(data || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchNotifications();

    // Subscribe to new notifications in real-time
    const subscription = supabase
      .channel(`public:notifications:user=${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
        },
        (payload) => {
          // If the changed/inserted row belongs to the current user, update state
          const newRow = payload.new as Notification;
          const oldRow = payload.old as Notification;

          if (payload.eventType === 'INSERT' && newRow.user_id === userId) {
            setNotifications(prev => [newRow, ...prev]);
            // Play a soft notification chime or trigger browser alert if supported
            if ('Notification' in window && window.Notification.permission === 'granted') {
              new window.Notification(newRow.title, { body: newRow.message });
            }
          } else if (payload.eventType === 'UPDATE' && newRow.user_id === userId) {
            setNotifications(prev => prev.map(n => n.id === newRow.id ? newRow : n));
          } else if (payload.eventType === 'DELETE') {
            setNotifications(prev => prev.filter(n => n.id !== oldRow.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [userId]);

  const handleMarkAsRead = async (notificationId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId);

      if (error) {
        console.error('Error marking notification read:', error);
      } else {
        setNotifications(prev => prev.map(n => n.id === notificationId ? { ...n, is_read: true } : n));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
      if (unreadIds.length === 0) return;

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .in('id', unreadIds);

      if (error) {
        console.error('Error marking all notifications read:', error);
      } else {
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'alert':
        return <AlertCircle size={16} style={{ color: 'var(--color-danger)' }} />;
      case 'reminder':
        return <Calendar size={16} style={{ color: 'var(--color-warning)' }} />;
      case 'escalation':
        return <Flame size={16} style={{ color: 'var(--accent-secondary)' }} />;
      default:
        return <Info size={16} style={{ color: 'var(--accent-primary)' }} />;
    }
  };

  return (
    <div className="notification-center-container" ref={dropdownRef} style={{ position: 'relative' }}>
      <button 
        className="btn btn-secondary" 
        style={{ 
          padding: '0.65rem', 
          borderRadius: '50%', 
          position: 'relative',
          width: '40px',
          height: '40px'
        }}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Notifications"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute',
            top: '-4px',
            right: '-4px',
            background: 'var(--color-danger)',
            color: 'white',
            borderRadius: '50%',
            width: '18px',
            height: '18px',
            fontSize: '0.65rem',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 8px var(--color-danger)'
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="glass-panel" style={{
          position: 'absolute',
          top: '50px',
          right: 0,
          width: '320px',
          maxHeight: '400px',
          overflowY: 'auto',
          zIndex: 100,
          padding: '1rem',
          borderRadius: 'var(--border-radius-sm)',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          textAlign: 'left'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
            <h4 style={{ fontSize: '0.95rem', margin: 0 }}>Notifications</h4>
            {unreadCount > 0 && (
              <button 
                onClick={handleMarkAllRead} 
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  color: 'var(--accent-primary)', 
                  fontSize: '0.75rem', 
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No notifications yet.
              </div>
            ) : (
              notifications.map(n => (
                <div 
                  key={n.id} 
                  style={{
                    padding: '0.75rem',
                    borderRadius: 'var(--border-radius-sm)',
                    background: n.is_read ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.05)',
                    borderLeft: `3px solid ${n.is_read ? 'transparent' : 'var(--accent-primary)'}`,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5rem',
                    position: 'relative'
                  }}
                >
                  <div style={{ marginTop: '2px' }}>{getNotificationIcon(n.type)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ 
                      fontSize: '0.85rem', 
                      fontWeight: n.is_read ? 500 : 700, 
                      color: n.is_read ? 'var(--text-secondary)' : 'var(--text-primary)' 
                    }}>
                      {n.title}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {n.message}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  {!n.is_read && (
                    <button 
                      onClick={(e) => handleMarkAsRead(n.id, e)} 
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-success)',
                        cursor: 'pointer',
                        padding: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      title="Mark as read"
                    >
                      <Check size={14} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
