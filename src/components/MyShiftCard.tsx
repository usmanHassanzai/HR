import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  MyShift,
  formatShiftDays,
  formatShiftTimeRange,
  isTodayWorkDay,
} from '../utils/shiftHelpers';

export default function MyShiftCard() {
  const [shift, setShift] = useState<MyShift | null>(null);
  const [loading, setLoading] = useState(true);
  const [missingMigration, setMissingMigration] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_my_shift');
    if (error) {
      if (/function.*does not exist/i.test(error.message)) {
        setMissingMigration(true);
      }
      setShift(null);
    } else {
      setShift((data as MyShift[] | null)?.[0] ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="attendance-card attendance-card--compact">
        <Loader2 size={18} className="spin-icon" />
      </div>
    );
  }

  if (missingMigration) return null;

  return (
    <div className="attendance-card shift-card">
      <h3 className="attendance-card__title">
        <CalendarClock size={18} /> My shift
      </h3>
      {!shift ? (
        <p className="attendance-card__subtitle">
          No shift assigned yet. Your manager will set your work shift — attendance will auto-start when you enter the office during shift hours.
        </p>
      ) : (
        <>
          <div className="shift-card__hero">
            <strong>{shift.shift_name}</strong>
            <span className="shift-card__time">
              {formatShiftTimeRange(shift.start_time, shift.end_time, shift.crosses_midnight)}
            </span>
          </div>
          <p className="attendance-card__subtitle">
            {formatShiftDays(shift.days_of_week)}
            {isTodayWorkDay(shift.days_of_week) ? ' · Today is a work day' : ' · Not scheduled today'}
            {' · '}{shift.grace_minutes} min early check-in allowed
          </p>
        </>
      )}
    </div>
  );
}
