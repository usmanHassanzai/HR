import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface RealtimeTableWatch {
  table: string;
  event?: RealtimeEvent;
  filter?: string;
}

function watchesKey(watches: RealtimeTableWatch[]): string {
  return watches
    .map((w) => `${w.table}|${w.event ?? '*'}|${w.filter ?? ''}`)
    .join(';');
}

/**
 * Subscribe to Supabase Realtime postgres_changes and refetch when data changes.
 * Uses a unique channel instance each mount so React Strict Mode / HMR never
 * calls `.on()` on an already-subscribed channel.
 */
export function useSupabaseRealtime(
  channelName: string,
  watches: RealtimeTableWatch[],
  onChange: () => void,
  enabled = true,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const watchesSnapshot = watchesKey(watches);
  const watchesRef = useRef(watches);
  watchesRef.current = watches;

  useEffect(() => {
    if (!enabled || watchesRef.current.length === 0) return;

    const instanceName = `${channelName}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let channel = supabase.channel(instanceName);
    let subscribed = false;

    try {
      for (const w of watchesRef.current) {
        channel = channel.on(
          'postgres_changes',
          {
            event: w.event ?? '*',
            schema: 'public',
            table: w.table,
            ...(w.filter ? { filter: w.filter } : {}),
          },
          () => {
            try {
              onChangeRef.current();
            } catch (err) {
              console.warn('[realtime] onChange failed', channelName, err);
            }
          },
        );
      }
      channel.subscribe();
      subscribed = true;
    } catch (err) {
      console.warn('[realtime] subscribe skipped', channelName, err);
      void supabase.removeChannel(channel);
      return;
    }

    return () => {
      if (subscribed) {
        void supabase.removeChannel(channel);
      }
    };
  }, [channelName, enabled, watchesSnapshot]);
}
