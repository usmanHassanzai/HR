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

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function ReportDateCalendar({
  selectedDate,
  maxDate = todayIsoDate(),
  reportCountsByDate,
  onSelectDate,
}: ReportDateCalendarProps) {
  const selected = parseIsoDate(selectedDate);
  const viewYear = selected.getFullYear();
  const viewMonth = selected.getMonth();
  const selectedCount = reportCountsByDate?.get(selectedDate) ?? 0;
  const isToday = selectedDate === maxDate;

  const grid = useMemo(
    () => monthGridDays(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  const monthSubmissionTotal = useMemo(() => {
    let total = 0;
    for (const [iso, count] of reportCountsByDate || []) {
      const d = parseIsoDate(iso);
      if (d.getFullYear() === viewYear && d.getMonth() === viewMonth) {
        total += count;
      }
    }
    return total;
  }, [reportCountsByDate, viewYear, viewMonth]);

  const shiftMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const day = Math.min(selected.getDate(), lastDay);
    let next = toIsoDate(d.getFullYear(), d.getMonth(), day);
    if (next > maxDate) {
      next = toIsoDate(d.getFullYear(), d.getMonth(), Math.min(lastDay, parseIsoDate(maxDate).getDate()));
      if (next > maxDate) next = maxDate;
    }
    onSelectDate(next);
  };

  const shiftDay = (delta: number) => {
    const next = addDaysIso(selectedDate, delta);
    if (next > maxDate) return;
    onSelectDate(next);
  };

  const canGoNextDay = selectedDate < maxDate;
  const maxD = parseIsoDate(maxDate);
  const canGoNextMonth = viewYear < maxD.getFullYear()
    || (viewYear === maxD.getFullYear() && viewMonth < maxD.getMonth());

  const weekdayLong = selected.toLocaleDateString(undefined, { weekday: 'long' });
  const dayNum = selected.getDate();
  const monthShort = selected.toLocaleDateString(undefined, { month: 'short' });

  return (
    <div className="dwr-cal">
      <div className="dwr-cal__hero">
        <div className="dwr-cal__hero-nav">
          <button type="button" className="dwr-cal__icon-btn" aria-label="Previous day" onClick={() => shiftDay(-1)}>
            <ChevronLeft size={18} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="dwr-cal__icon-btn"
            aria-label="Next day"
            disabled={!canGoNextDay}
            onClick={() => shiftDay(1)}
          >
            <ChevronRight size={18} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>

        <p className="dwr-cal__dow">{weekdayLong}</p>
        <p className="dwr-cal__date-large">
          <span className="dwr-cal__date-num">{dayNum}</span>
          <span className="dwr-cal__date-month">{monthShort}</span>
        </p>
        <p className="dwr-cal__date-full">{formatReportDate(selectedDate)}</p>

        <div className="dwr-cal__meta">
          <span className={`dwr-cal__chip${isToday ? ' dwr-cal__chip--today' : ''}`}>
            {isToday ? 'Today' : 'Selected'}
          </span>
          <span className="dwr-cal__chip dwr-cal__chip--soft">
            {selectedCount > 0
              ? `${selectedCount} report${selectedCount === 1 ? '' : 's'}`
              : 'None yet'}
          </span>
          {!isToday && (
            <button type="button" className="dwr-cal__today-link" onClick={() => onSelectDate(maxDate)}>
              Today
            </button>
          )}
        </div>
      </div>

      <div className="dwr-cal__body">
        <div className="dwr-cal__month-bar">
          <button type="button" className="dwr-cal__icon-btn" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
            <ChevronLeft size={16} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <div className="dwr-cal__month-copy">
            <strong>{calendarMonthLabel(viewYear, viewMonth)}</strong>
            <span>
              {monthSubmissionTotal === 0
                ? 'No submissions'
                : `${monthSubmissionTotal} this month`}
            </span>
          </div>
          <button
            type="button"
            className="dwr-cal__icon-btn"
            aria-label="Next month"
            disabled={!canGoNextMonth}
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>

        <div className="dwr-cal__weekdays" aria-hidden="true">
          {WEEKDAYS.map((label, i) => (
            <span key={`${label}-${i}`} className="dwr-cal__weekday">{label}</span>
          ))}
        </div>

        <div className="dwr-cal__grid" role="grid" aria-label="Choose a report date">
          {grid.map((cell) => {
            const iso = cell.iso;
            const future = iso > maxDate;
            const selectedDay = iso === selectedDate;
            const todayCell = iso === maxDate;
            const count = reportCountsByDate?.get(iso) ?? 0;

            return (
              <button
                key={`${iso}-${cell.inMonth}`}
                type="button"
                role="gridcell"
                className={[
                  'dwr-cal__day',
                  !cell.inMonth ? 'dwr-cal__day--out' : '',
                  selectedDay ? 'dwr-cal__day--selected' : '',
                  todayCell && !selectedDay ? 'dwr-cal__day--today' : '',
                  count > 0 ? 'dwr-cal__day--has' : '',
                ].filter(Boolean).join(' ')}
                disabled={future}
                aria-label={`${formatReportDate(iso)}${count ? `, ${count} reports` : ''}`}
                aria-selected={selectedDay}
                onClick={() => onSelectDate(iso)}
              >
                <span className="dwr-cal__day-num">{cell.day}</span>
                {count > 0 && <span className="dwr-cal__day-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        <div className="dwr-cal__legend">
          <span><i className="dwr-cal__legend-swatch dwr-cal__legend-swatch--dot" /> Submitted</span>
          <span><i className="dwr-cal__legend-swatch dwr-cal__legend-swatch--ring" /> Today</span>
          <span><i className="dwr-cal__legend-swatch dwr-cal__legend-swatch--sel" /> Selected</span>
        </div>
      </div>
    </div>
  );
}
