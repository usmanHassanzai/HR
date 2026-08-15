import { supabase } from '../lib/supabase';

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
