import { useEffect, useRef, useState } from 'react';
import { ClipboardList, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Notification } from '../utils/kpiHelpers';
import { markNotificationsRead } from '../utils/notificationHelpers';

export interface DailyReportToast {
  id: string;
  title: string;
  message: string;
}

interface AdminDailyReportAlertProps {
  userId: string;
  onOpenReports: () => void;
  onUnreadChange?: (count: number) => void;
}

function isDailyReportNotification(n: Pick<Notification, 'title'>): boolean {
  const t = (n.title || '').toLowerCase();
  return t.includes('daily report');
}

export default function AdminDailyReportAlert({
  userId,
  onOpenReports,
  onUnreadChange,
}: AdminDailyReportAlertProps) {
  const [toast, setToast] = useState<DailyReportToast | null>(null);
  const toastedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const refreshUnread = async () => {
      const { data } = await supabase
        .from('notifications')
        .select('id, title, is_read')
        .eq('user_id', userId)
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      const count = (data || []).filter((n) => isDailyReportNotification(n)).length;
      onUnreadChange?.(count);
    };

    void refreshUnread();

    const channel = supabase
      .channel(`admin-daily-report-alerts:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications' },
        (payload) => {
          const row = payload.new as Notification | undefined;
          if (
            payload.eventType === 'INSERT' &&
            row?.user_id === userId &&
            isDailyReportNotification(row) &&
            !row.is_read &&
            !toastedIds.current.has(row.id)
          ) {
            toastedIds.current.add(row.id);
            setToast({ id: row.id, title: row.title, message: row.message });
            void refreshUnread();
            if ('Notification' in window && window.Notification.permission === 'granted') {
              try {
                new window.Notification(row.title, { body: row.message, tag: row.id });
              } catch {
                /* ignore */
              }
            }
            return;
          }
          if (payload.eventType === 'UPDATE' && row?.user_id === userId && row.is_read) {
            toastedIds.current.add(row.id);
            setToast((prev) => (prev?.id === row.id ? null : prev));
            void refreshUnread();
            return;
          }
          if (payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
            void refreshUnread();
          }
        },
      )
      .subscribe();

    const onMarked = (e: Event) => {
      const detail = (e as CustomEvent<{ ids?: string[] | null }>).detail;
      if (detail?.ids) detail.ids.forEach((id) => toastedIds.current.add(id));
      setToast((prev) => {
        if (!prev) return null;
        if (!detail?.ids || detail.ids.includes(prev.id)) return null;
        return prev;
      });
      void refreshUnread();
    };
    window.addEventListener('scorr-notifications-read', onMarked);

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
      window.removeEventListener('scorr-notifications-read', onMarked);
    };
  }, [userId, onUnreadChange]);

  const dismiss = async (openReports: boolean) => {
    if (toast) {
      toastedIds.current.add(toast.id);
      await markNotificationsRead([toast.id]);
    }
    setToast(null);
    if (openReports) onOpenReports();
  };

  if (!toast) return null;

  return (
    <div className="admin-dwr-toast" role="status" aria-live="polite">
      <div className="admin-dwr-toast__icon">
        <ClipboardList size={18} />
      </div>
      <div className="admin-dwr-toast__body">
        <strong>{toast.title}</strong>
        <p>{toast.message}</p>
        <button
          type="button"
          className="admin-dwr-toast__cta"
          onClick={() => void dismiss(true)}
        >
          View daily reports
        </button>
      </div>
      <button
        type="button"
        className="admin-dwr-toast__close"
        aria-label="Dismiss"
        onClick={() => void dismiss(false)}
      >
        <X size={16} />
      </button>
    </div>
  );
}
