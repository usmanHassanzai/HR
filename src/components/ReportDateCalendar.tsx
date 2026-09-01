import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addDaysIso,
  calendarMonthLabel,
  formatReportDate,
  monthGridDays,
  parseIsoDate,
  toIsoDate,
  todayIsoDate,
} from '../utils/dailyWorkReportHelpers';

interface ReportDateCalendarProps {
  selectedDate: string;
  maxDate?: string;
  reportCountsByDate?: Map<string, number>;
  onSelectDate: (iso: string) => void;
}

export default function ReportDateCalendar({
  selectedDate,
  maxDate = todayIsoDate(),
  reportCountsByDate,
  onSelectDate,
}: ReportDateCalendarProps) {
  const selected = parseIsoDate(selectedDate);
  const viewYear = selected.getFullYear();
  const viewMonth = selected.getMonth();

  const grid = useMemo(
    () => monthGridDays(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    const base = new Date(2024, 0, 7); // Sunday
    return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(base, i)));
  }, []);

  const shiftMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const day = Math.min(selected.getDate(), lastDay);
    const next = toIsoDate(d.getFullYear(), d.getMonth(), day);
    if (next <= maxDate) onSelectDate(next);
    else onSelectDate(toIsoDate(d.getFullYear(), d.getMonth(), lastDay));
  };

  const shiftDay = (delta: number) => {
    const next = addDaysIso(selectedDate, delta);
    if (next > maxDate) return;
    onSelectDate(next);
  };

  const canGoNextDay = selectedDate < maxDate;
  const canGoNextMonth = toIsoDate(viewYear, viewMonth + 1, 1) <= maxDate
    || toIsoDate(viewYear, viewMonth, 1) < maxDate;

  return (
    <div className="dwr-cal">
      <div className="dwr-cal__selected">
        <button
          type="button"
          className="dwr-cal__nav"
          aria-label="Previous day"
          onClick={() => shiftDay(-1)}
        >
          <ChevronLeft size={18} />
        </button>
        <div className="dwr-cal__selected-copy">
          <strong>{formatReportDate(selectedDate)}</strong>
          <span>{selectedDate === maxDate ? 'Today' : 'Selected report day'}</span>
        </div>
        <button
          type="button"
          className="dwr-cal__nav"
          aria-label="Next day"
          disabled={!canGoNextDay}
          onClick={() => shiftDay(1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="dwr-cal__month-bar">
        <button type="button" className="dwr-cal__nav" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          <ChevronLeft size={18} />
        </button>
        <span className="dwr-cal__month-label">{calendarMonthLabel(viewYear, viewMonth)}</span>
        <button
          type="button"
          className="dwr-cal__nav"
          aria-label="Next month"
          disabled={!canGoNextMonth}
          onClick={() => shiftMonth(1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="dwr-cal__weekdays" aria-hidden="true">
        {weekdayLabels.map((label) => (
          <span key={label} className="dwr-cal__weekday">{label}</span>
        ))}
      </div>

      <div className="dwr-cal__grid" role="grid" aria-label="Choose a report date">
        {grid.map((cell) => {
          const iso = cell.iso;
          const isFuture = iso > maxDate;
          const isSelected = iso === selectedDate;
          const isToday = iso === maxDate;
          const count = reportCountsByDate?.get(iso) ?? 0;
          const disabled = isFuture;

          return (
            <button
              key={iso + String(cell.inMonth)}
              type="button"
              role="gridcell"
              className={[
                'dwr-cal__day',
                !cell.inMonth ? 'dwr-cal__day--muted' : '',
                isSelected ? 'dwr-cal__day--selected' : '',
                isToday ? 'dwr-cal__day--today' : '',
                count > 0 && cell.inMonth ? 'dwr-cal__day--has-reports' : '',
              ].filter(Boolean).join(' ')}
              disabled={disabled}
              aria-label={`${formatReportDate(iso)}${count ? `, ${count} reports` : ''}`}
              aria-selected={isSelected}
              onClick={() => onSelectDate(iso)}
            >
              <span className="dwr-cal__day-num">{cell.day}</span>
              {count > 0 && (
                <span className="dwr-cal__day-dot" aria-hidden="true">{count > 9 ? '9+' : count}</span>
              )}
            </button>
          );
        })}
      </div>

      <p className="dwr-cal__hint">
        Tap any day to view that day&apos;s reports. Days with a number had submissions saved.
      </p>
    </div>
  );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
