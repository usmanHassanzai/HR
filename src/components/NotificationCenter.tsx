import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { Notification } from '../utils/kpiHelpers';
import { Bell, AlertCircle, Info, Calendar, Flame, Check } from 'lucide-react';

interface NotificationCenterProps {
  userId: string;
}

export default function NotificationCenter({ userId }: NotificationCenterProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Re-position whenever it opens
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        // check if click is inside the portal dropdown
        const portal = document.getElementById('notification-portal');
        if (portal && !portal.contains(e.target as Node)) {
          setIsOpen(false);
        }
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Fetch notifications
  const fetchNotifications = async () => {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    setNotifications(data || []);
  };

  useEffect(() => {
    fetchNotifications();
    const sub = supabase
      .channel(`notifications:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (payload) => {
        const newRow = payload.new as Notification;
        const oldRow = payload.old as Notification;
        if (payload.eventType === 'INSERT' && newRow.user_id === userId) {
          setNotifications((prev) => [newRow, ...prev]);
          if ('Notification' in window && window.Notification.permission === 'granted') {
            new window.Notification(newRow.title, { body: newRow.message });
          }
        } else if (payload.eventType === 'UPDATE' && newRow.user_id === userId) {
          setNotifications((prev) => prev.map((n) => (n.id === newRow.id ? newRow : n)));
        } else if (payload.eventType === 'DELETE') {
          setNotifications((prev) => prev.filter((n) => n.id !== oldRow.id));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [userId]);

  const markRead = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
  };

  const markAllRead = async () => {
    const ids = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (!ids.length) return;
    await supabase.from('notifications').update({ is_read: true }).in('id', ids);
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'alert':      return <AlertCircle size={16} style={{ color: 'var(--color-danger)' }} />;
      case 'reminder':   return <Calendar size={16} style={{ color: 'var(--color-warning)' }} />;
      case 'escalation': return <Flame size={16} style={{ color: 'var(--accent-secondary)' }} />;
      default:           return <Info size={16} style={{ color: 'var(--accent-primary)' }} />;
    }
  };

  const unread = notifications.filter((n) => !n.is_read).length;

  const dropdown = isOpen ? (
    <div
      id="notification-portal"
      style={{
        position: 'fixed',
        top: dropdownPos.top,
        right: dropdownPos.right,
        width: 340,
        maxHeight: 480,
        overflowY: 'auto',
        zIndex: 99999,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-hover)',
        borderRadius: 'var(--border-radius-sm)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        padding: '1rem',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Notifications {unread > 0 && <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary)' }}>({unread} unread)</span>}</h4>
        {unread > 0 && (
          <button onClick={markAllRead} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}>
            Mark all read
          </button>
        )}
      </div>

      {/* Items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {notifications.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '1.5rem 0' }}>No notifications yet.</p>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              style={{
                padding: '0.75rem',
                borderRadius: 'var(--border-radius-sm)',
                background: n.is_read ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.06)',
                borderLeft: `3px solid ${n.is_read ? 'transparent' : 'var(--accent-primary)'}`,
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.5rem',
              }}
            >
              <div style={{ marginTop: 2 }}>{getIcon(n.type)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: n.is_read ? 500 : 700, color: n.is_read ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                  {n.title}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>{n.message}</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  {new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              {!n.is_read && (
                <button onClick={(e) => markRead(n.id, e)} title="Mark as read" style={{ background: 'none', border: 'none', color: 'var(--color-success)', cursor: 'pointer', padding: 2 }}>
                  <Check size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        className="btn btn-secondary"
        style={{ padding: '0.65rem', borderRadius: '50%', position: 'relative', width: 40, height: 40 }}
        onClick={() => setIsOpen((v) => !v)}
        aria-label="Notifications"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4,
            background: 'var(--color-danger)', color: 'white',
            borderRadius: '50%', width: 18, height: 18,
            fontSize: '0.65rem', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 8px var(--color-danger)',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Render dropdown at root DOM level so it always escapes any stacking context */}
      {createPortal(dropdown, document.body)}
    </>
  );
}
