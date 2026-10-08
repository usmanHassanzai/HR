import { supabase } from '../lib/supabase';

/** Same clock the attendance page uses for check-in and check-out. */
function viewerClockTime(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Approval notices must not show awarded weightage until month-end.
 * Strip legacy "approved with X% weightage" wording from older rows.
 */
export function notificationMessageWithoutDeferredWeightage(
  message: string,
  title?: string | null,
): string {
  if (
    title === 'KPI approved'
    || /\bwas approved with\s+[\d.]+%\s+weightage\b/i.test(message)
  ) {
    return message
      .replace(/\s+with\s+[\d.]+%\s+weightage\.?/i, '.')
      .replace(/\.\s*\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return message;
}

/**
 * Checkout notices are saved in whichever device timezone sent them.
 * Rewrite that time into the viewer's clock so it matches the visit list.
 */
export function notificationMessageInViewerTime(
  message: string,
  meta?: Record<string, unknown> | null,
  title?: string | null,
): string {
  const cleaned = notificationMessageWithoutDeferredWeightage(message, title);
  const raw = meta && typeof meta.occurred_at === 'string' ? meta.occurred_at : '';
  if (!raw) return cleaned;
  const clock = viewerClockTime(raw);
  if (!clock) return cleaned;
  if (!/\bat\s+\d{1,2}:\d{2}\s*[AP]M\b/i.test(cleaned)) return cleaned;
  return cleaned.replace(/\bat\s+\d{1,2}:\d{2}\s*[AP]M\b/i, `at ${clock}`);
}

/** Persist read state so a notification never alerts again after the user opens or marks it. */
export async function markNotificationsRead(ids?: string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;

  const { data, error } = await supabase.rpc('mark_notifications_read', {
    p_ids: ids?.length ? ids : null,
  });

  if (!error && typeof data === 'number') {
    window.dispatchEvent(new CustomEvent('scorr-notifications-read', { detail: { ids: ids ?? null } }));
    return data;
  }

  // Fallback if RPC not applied yet
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  let q = supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', user.id)
    .eq('is_read', false);
  if (ids?.length) q = q.in('id', ids);

  const { data: updated, error: updErr } = await q.select('id');
  if (updErr) {
    console.warn('[notifications] mark read failed', updErr.message);
    return 0;
  }
  window.dispatchEvent(new CustomEvent('scorr-notifications-read', { detail: { ids: ids ?? null } }));
  return updated?.length ?? 0;
}
