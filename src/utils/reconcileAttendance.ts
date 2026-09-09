import { supabase } from '../lib/supabase';

/** Close ended shifts so admin/manager dashboards do not keep showing "still working". */
export async function reconcileEndedShiftAttendance(): Promise<void> {
  try {
    await supabase.rpc('reconcile_ended_shift_attendance');
  } catch {
    /* offline / older schema */
  }
}
