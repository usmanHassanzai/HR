-- FIX_auto_every_shift_window_2026-10-14.sql
-- Auto attendance must work for EVERY assigned shift the same way:
--   check-in window = [shift_start − 1h, shift_end]
-- Never trust a stale crosses_midnight flag; always derive overnight from start/end.

-- 1) Repair all rows
UPDATE public.work_shifts
SET crosses_midnight = (end_time <= start_time)
WHERE crosses_midnight IS DISTINCT FROM (end_time <= start_time);

-- 2) Keep flag correct on every write
CREATE OR REPLACE FUNCTION public.work_shifts_sync_overnight()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.crosses_midnight := (NEW.end_time <= NEW.start_time);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_shifts_sync_overnight ON public.work_shifts;
CREATE TRIGGER trg_work_shifts_sync_overnight
  BEFORE INSERT OR UPDATE OF start_time, end_time, crosses_midnight
  ON public.work_shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.work_shifts_sync_overnight();

-- 3) Bounds: overnight ONLY from wall-clock times (ignore bad p_overnight)
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
  -- Always derive from times. p_overnight is ignored when it conflicts.
  v_overnight := (p_end <= p_start);

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
    IF v_dow = ANY (v_days) THEN
      v_shift_start := public.attendance_tz_instant(v_local_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date + 1, p_end, v_tz);
      IF v_local_time >= p_start
         OR (p_at >= v_shift_start - INTERVAL '60 minutes' AND p_at < v_shift_start) THEN
        v_att_date := v_local_date;
      END IF;
    END IF;

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

  -- Grace window for presence UI (+/− 1h). Auto check-in uses shift_start−1h … shift_end in process_auto.
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

-- 4) Window for user: primary shift clock for labels; OR equal zones for UTC coverage only
CREATE OR REPLACE FUNCTION public.attendance_window_for_user(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS TABLE (
  has_shift BOOLEAN,
  in_window BOOLEAN,
  shift_id UUID,
  shift_name TEXT,
  shift_tz TEXT,
  start_time TIME,
  end_time TIME,
  days_of_week INTEGER[],
  crosses_midnight BOOLEAN,
  attendance_date DATE,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  shift_start_utc TIMESTAMPTZ,
  shift_end_utc TIMESTAMPTZ,
  company_id UUID,
  company_tz TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id UUID;
  v_company_tz TEXT;
  v_lookup_tz TEXT;
  v_shift_id UUID;
  v_shift_name TEXT;
  v_shift_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_days INTEGER[];
  v_overnight BOOLEAN;
  v_main RECORD;
  v_try RECORD;
  v_zone RECORD;
  v_best_in BOOLEAN := false;
  v_best_end TIMESTAMPTZ;
  v_att_date DATE;
  v_shift_start TIMESTAMPTZ;
  v_shift_end TIMESTAMPTZ;
  v_win_start TIMESTAMPTZ;
  v_win_end TIMESTAMPTZ;
  v_primary_start TIME;
  v_primary_end TIME;
  v_primary_tz TEXT;
  v_primary_overnight BOOLEAN;
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  v_lookup_tz := COALESCE(NULLIF(btrim(v_company_tz), ''), 'UTC');

  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_lookup_tz)) s
  LIMIT 1;

  IF NOT FOUND OR v_shift_id IS NULL THEN
    has_shift := false;
    in_window := false;
    shift_id := NULL;
    shift_name := NULL;
    shift_tz := v_lookup_tz;
    start_time := NULL;
    end_time := NULL;
    days_of_week := NULL;
    crosses_midnight := false;
    attendance_date := NULL;
    window_start_utc := NULL;
    window_end_utc := NULL;
    shift_start_utc := NULL;
    shift_end_utc := NULL;
    company_id := v_company_id;
    company_tz := v_company_tz;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT NULLIF(btrim(ws.timezone), '')
  INTO v_shift_tz
  FROM public.work_shifts ws
  WHERE ws.id = v_shift_id;

  v_shift_tz := COALESCE(v_shift_tz, v_lookup_tz);
  BEGIN
    v_shift_tz := public.assert_valid_iana_timezone(v_shift_tz);
  EXCEPTION WHEN OTHERS THEN
    v_shift_tz := 'UTC';
  END;

  v_days := COALESCE(v_days, ARRAY[1, 2, 3, 4, 5]);
  -- Primary clock: always derive overnight from times (every shift, same rule).
  v_overnight := (v_end <= v_start);
  v_primary_start := v_start;
  v_primary_end := v_end;
  v_primary_tz := v_shift_tz;
  v_primary_overnight := v_overnight;

  SELECT * INTO v_main
  FROM public.attendance_bounds_for_clock(p_at, v_start, v_end, v_days, v_shift_tz, v_overnight)
  LIMIT 1;

  v_best_in := COALESCE(v_main.in_window, false);
  v_best_end := v_main.shift_end_utc;
  v_att_date := v_main.attendance_date;
  v_shift_start := v_main.shift_start_utc;
  v_shift_end := v_main.shift_end_utc;
  v_win_start := v_main.window_start_utc;
  v_win_end := v_main.window_end_utc;

  -- Equal zones: OR UTC coverage only — keep primary start/end/tz labels.
  FOR v_zone IN
    SELECT z.timezone, z.entered_start_time, z.entered_end_time
    FROM public.shift_display_zones z
    WHERE z.shift_id = v_shift_id
      AND NULLIF(btrim(z.timezone), '') IS NOT NULL
      AND z.timezone IS DISTINCT FROM v_shift_tz
    ORDER BY z.sort_order, z.created_at
  LOOP
    BEGIN
      SELECT * INTO v_try
      FROM public.attendance_bounds_for_clock(
        p_at,
        v_zone.entered_start_time,
        v_zone.entered_end_time,
        v_days,
        v_zone.timezone,
        NULL
      )
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    IF COALESCE(v_try.in_window, false) AND (
      NOT v_best_in
      OR v_best_end IS NULL
      OR v_try.shift_end_utc > v_best_end
    ) THEN
      v_best_in := true;
      v_best_end := v_try.shift_end_utc;
      v_att_date := v_try.attendance_date;
      -- Expand UTC coverage; do not replace primary clock labels.
      IF v_shift_start IS NULL OR v_try.shift_start_utc < v_shift_start THEN
        v_shift_start := v_try.shift_start_utc;
      END IF;
      IF v_shift_end IS NULL OR v_try.shift_end_utc > v_shift_end THEN
        v_shift_end := v_try.shift_end_utc;
      END IF;
      IF v_win_start IS NULL OR v_try.window_start_utc < v_win_start THEN
        v_win_start := v_try.window_start_utc;
      END IF;
      IF v_win_end IS NULL OR v_try.window_end_utc > v_win_end THEN
        v_win_end := v_try.window_end_utc;
      END IF;
    ELSIF COALESCE(v_main.has_shift, false) = false AND COALESCE(v_try.has_shift, false) THEN
      v_att_date := v_try.attendance_date;
      v_shift_start := v_try.shift_start_utc;
      v_shift_end := v_try.shift_end_utc;
      v_win_start := v_try.window_start_utc;
      v_win_end := v_try.window_end_utc;
    END IF;
  END LOOP;

  has_shift := COALESCE(v_main.has_shift, false) OR v_best_in OR (v_shift_start IS NOT NULL);
  in_window := v_best_in;
  shift_id := v_shift_id;
  shift_name := v_shift_name;
  shift_tz := v_primary_tz;
  start_time := v_primary_start;
  end_time := v_primary_end;
  days_of_week := v_days;
  crosses_midnight := v_primary_overnight;
  attendance_date := v_att_date;
  window_start_utc := v_win_start;
  window_end_utc := v_win_end;
  shift_start_utc := v_shift_start;
  shift_end_utc := v_shift_end;
  company_id := v_company_id;
  company_tz := v_company_tz;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_bounds_for_clock(TIMESTAMPTZ, TIME, TIME, INTEGER[], TEXT, BOOLEAN)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) IS
  'Active assigned shift window for any user. Overnight derived from start/end. Auto check-in uses [shift_start-1h, shift_end] in process_auto.';
