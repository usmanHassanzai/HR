import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface RealtimeTableWatch {
  table: string;
  event?: RealtimeEvent;
  filter?: string;
}

/**
 * Subscribe to Supabase Realtime postgres_changes and refetch when data changes.
 * Works across web, mobile APK, and iOS — same cloud database, any network.
 */
export function useSupabaseRealtime(
  channelName: string,
  watches: RealtimeTableWatch[],
  onChange: () => void,
  enabled = true,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const watchesRef = useRef(watches);
  watchesRef.current = watches;

  useEffect(() => {
    if (!enabled) return;

    let channel = supabase.channel(channelName);
    for (const w of watchesRef.current) {
      channel = channel.on(
        'postgres_changes',
        {
          event: w.event ?? '*',
          schema: 'public',
          table: w.table,
          ...(w.filter ? { filter: w.filter } : {}),
        },
        () => onChangeRef.current(),
      );
    }
    channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [channelName, enabled]);
}
