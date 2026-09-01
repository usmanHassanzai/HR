import { supabase } from '../lib/supabase';

const HEARTBEAT_MS = 45 * 1000;

/** Tell the server this person is using Scorr, and close the shift if the extra hour is over. */
export function startPresenceHeartbeat(): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await supabase.rpc('touch_my_presence');
      await supabase.rpc('close_my_ended_shift_attendance');
    } catch {
      /* offline / session ended */
    }
  };

  void tick();
  const id = window.setInterval(() => { void tick(); }, HEARTBEAT_MS);
  const onFocus = () => { void tick(); };
  window.addEventListener('focus', onFocus);

  return () => {
    stopped = true;
    window.clearInterval(id);
    window.removeEventListener('focus', onFocus);
  };
}
