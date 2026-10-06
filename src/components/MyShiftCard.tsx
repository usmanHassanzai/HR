import { useCallback, useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import {
  DAY_LABELS,
  MyShift,
  formatShiftTimeRange,
  formatWorkingDays,
  isTodayWorkDay,
} from '../utils/shiftHelpers';
import { suggestBrowserTimeZone } from '../utils/ianaTimezones';
import {
  formatShiftZonesLine,
  todayYmdInZone,
  type ShiftOfficeTime,
} from '../utils/shiftMultiZone';

interface MyShiftCardProps {
  /** When set, load that person's shift (manager viewing an employee). */
  userId?: string;
  layout?: 'card' | 'banner';
}

export default function MyShiftCard({ userId, layout = 'card' }: MyShiftCardProps) {
  const [shift, setShift] = useState<MyShift | null>(null);
  const [displayZones, setDisplayZones] = useState<{ timezone: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selfId, setSelfId] = useState<string | null>(userId ?? null);

  useEffect(() => {
    if (userId) {
      setSelfId(userId);
      return;
    }
    void supabase.auth.getUser().then(({ data }) => setSelfId(data.user?.id ?? null));
  }, [userId]);

  const load = useCallback(async () => {
    const { data, error } = userId
      ? await supabase.rpc('get_user_assigned_shift', { p_user_id: userId })
      : await supabase.rpc('get_my_shift');
    if (error) {
      setShift(null);
      setDisplayZones([]);
    } else {
      const row = (data as MyShift[] | null)?.[0] ?? null;
      setShift(row);
      if (row?.shift_id) {
        const { data: zones } = await supabase.rpc('list_shift_display_zones', {
          p_shift_id: row.shift_id,
        });
        setDisplayZones(
          ((zones || []) as { timezone: string }[]).map((z) => ({ timezone: z.timezone })),
        );
      } else {
        setDisplayZones([]);
      }
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useSupabaseRealtime(
    `my-shift:${selfId || 'self'}`,
    [
      { table: 'employee_shift_assignments', filter: selfId ? `user_id=eq.${selfId}` : undefined },
    ],
    () => {
      void load();
    },
    Boolean(selfId),
  );

  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const days = shift?.days_of_week || [];
  let hours = 'Not assigned';
  if (shift) {
    const mainTz = shift.timezone || suggestBrowserTimeZone() || 'UTC';
    const main: ShiftOfficeTime = {
      timezone: mainTz,
      start: String(shift.start_time).slice(0, 5),
      end: String(shift.end_time).slice(0, 5),
    };
    if (displayZones.length > 0) {
      hours = formatShiftZonesLine(
        main,
        displayZones,
        todayYmdInZone(mainTz),
        suggestBrowserTimeZone(),
      );
    } else {
      const city = mainTz.split('/').pop()?.replace(/_/g, ' ') || '';
      hours = `${formatShiftTimeRange(shift.start_time, shift.end_time, shift.crosses_midnight)}${city ? ` ${city}` : ''}`;
    }
  }

  if (layout === 'banner') {
    return (
      <section className="dash-shift-banner" aria-live="polite">
        <div className="dash-shift-banner__icon" aria-hidden>
          <CalendarClock size={22} />
        </div>
        <div className="dash-shift-banner__main">
          <p className="dash-shift-banner__kicker">
            {shift ? 'Active shift' : 'Your assigned hours'}
          </p>
          {loading ? (
            <p className="dash-shift-banner__hours">Loading shift…</p>
          ) : (
            <>
              {shift?.shift_name ? (
                <p className="dash-shift-banner__name">
                  <span className="shift-active-pill">Active shift</span>
                  {shift.shift_name}
                </p>
              ) : null}
              <p className="dash-shift-banner__hours">{hours}</p>
              <p className="dash-shift-banner__days">
                Working days: <strong>{formatWorkingDays(days)}</strong>
                {shift ? (isTodayWorkDay(days) ? ' · Today is a work day' : ' · Not scheduled today') : ''}
              </p>
            </>
          )}
        </div>
        {shift && days.length > 0 && (
          <ul className="dash-shift-banner__chips" aria-label="Working days">
            {DAY_LABELS.map((label, idx) => {
              const on = days.includes(idx + 1);
              return (
                <li key={label} className={on ? 'is-on' : ''} title={on ? `${label} is a work day` : `${label} off`}>
                  {label}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  return (
    <div className="attendance-card shift-card">
      <h3 className="attendance-card__title">
        <CalendarClock size={18} /> {shift ? 'Active shift' : 'My shift'}
      </h3>
      {loading ? (
        <p className="attendance-card__subtitle">Loading your hours…</p>
      ) : !shift ? (
        <p className="attendance-card__subtitle">
          No shift assigned yet. Your manager will set your work days and hours — this card updates as soon as they do.
        </p>
      ) : (
        <>
          <div className="shift-card__hero">
            <span className="shift-active-pill">Active shift</span>
            <strong>{shift.shift_name}</strong>
            <span className="shift-card__time">{hours}</span>
          </div>
          <p className="attendance-card__subtitle">
            Working days: {formatWorkingDays(days)}
            {isTodayWorkDay(days) ? ' · Today is a work day' : ' · Not scheduled today'}
            . Clock in from 1 hour before start. Clock out until 1 hour after end.
          </p>
        </>
      )}
    </div>
  );
}
