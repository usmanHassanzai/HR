import { supabase } from '../lib/supabase';

const HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes — enough for presence without hammering DB

/** Tell the server this person is using Scorr, and close the shift if the extra hour is over. */
export function startPresenceHeartbeat(): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      await supabase.rpc('touch_my_presence');
      await supabase.rpc('close_my_ended_shift_attendance');
    } catch {
      /* offline / session ended */
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const id = window.setInterval(() => { void tick(); }, HEARTBEAT_MS);
  const onFocus = () => { void tick(); };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void tick();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    window.clearInterval(id);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
