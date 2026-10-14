-- Same-day shifts (end > start) must not be flagged overnight.
-- Saleem Day 14:05–17:00 was crosses_midnight=true, which pushed shift_end to the next day
-- and caused early auto clock-out / wrong windows.

UPDATE public.work_shifts
SET crosses_midnight = (end_time <= start_time)
WHERE crosses_midnight IS DISTINCT FROM (end_time <= start_time);
