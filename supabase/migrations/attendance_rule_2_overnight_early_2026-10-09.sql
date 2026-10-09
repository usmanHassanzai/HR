-- Rule 2 for overnight shifts: allow check-in from 1 hour BEFORE overnight
-- start (previously only matched once local time >= start, or still past midnight).

CREATE OR REPLACE FUNCTION public.attendance_bounds_for_clock(
  p_at TIMESTAMPTZ,
  p_start TIME,
  p_end TIME,
  p_days INTEGER[],
  p_tz TEXT,
  p_overnight BOOLEAN DEFAULT NULL
)
RETURNS TABLE (
  has_shift BOOLEAN,
  in_window BOOLEAN,
  crosses_midnight BOOLEAN,
  attendance_date DATE,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  shift_start_utc TIMESTAMPTZ,
  shift_end_utc TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_tz TEXT;
  v_days INTEGER[];
  v_overnight BOOLEAN;
  v_local_date DATE;
  v_prev_date DATE;
  v_dow INTEGER;
  v_prev_dow INTEGER;
  v_att_date DATE;
  v_shift_start TIMESTAMPTZ;
  v_shift_end TIMESTAMPTZ;
  v_win_start TIMESTAMPTZ;
  v_win_end TIMESTAMPTZ;
  v_local_time TIME;
BEGIN
  v_tz := public.assert_valid_iana_timezone(p_tz);
  v_days := COALESCE(p_days, ARRAY[1, 2, 3, 4, 5]);
  v_overnight := COALESCE(p_overnight, (p_end <= p_start));

  v_local_date := public.attendance_local_date(p_at, v_tz);
  v_prev_date := v_local_date - 1;
  v_dow := public.attendance_iso_dow(p_at, v_tz);
  v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;
  v_local_time := (p_at AT TIME ZONE v_tz)::TIME;

  IF NOT v_overnight THEN
    IF v_dow = ANY (v_days) THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, p_end, v_tz);
    ELSE
      has_shift := false;
      in_window := false;
      crosses_midnight := false;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    -- Tonight's overnight: already started, or within the 1h early window.
    IF v_dow = ANY (v_days) THEN
      v_shift_start := public.attendance_tz_instant(v_local_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date + 1, p_end, v_tz);
      IF v_local_time >= p_start
         OR (p_at >= v_shift_start - INTERVAL '60 minutes' AND p_at < v_shift_start) THEN
        v_att_date := v_local_date;
      END IF;
    END IF;

    -- Still inside yesterday's overnight (after midnight, before end).
    IF v_att_date IS NULL
       AND v_prev_dow = ANY (v_days)
       AND v_local_time <= p_end THEN
      v_att_date := v_prev_date;
      v_shift_start := public.attendance_tz_instant(v_prev_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, p_end, v_tz);
    END IF;

    IF v_att_date IS NULL THEN
      has_shift := false;
      in_window := false;
      crosses_midnight := true;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_win_start := v_shift_start - INTERVAL '60 minutes';
  v_win_end := v_shift_end + INTERVAL '60 minutes';

  has_shift := true;
  in_window := (p_at >= v_win_start AND p_at <= v_win_end);
  crosses_midnight := v_overnight;
  attendance_date := v_att_date;
  window_start_utc := v_win_start;
  window_end_utc := v_win_end;
  shift_start_utc := v_shift_start;
  shift_end_utc := v_shift_end;
  RETURN NEXT;
END;
$$;
