-- attendance_window_core.sql
-- R6–R12 / R20–R23: shared attendance window W = [start-60m, end+60m] in shift TZ.

CREATE OR REPLACE FUNCTION public.attendance_local_date(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT (p_at AT TIME ZONE assert_valid_iana_timezone(p_tz))::DATE;
$$;

-- Build timestamptz for a local clock on a given local date in IANA zone
CREATE OR REPLACE FUNCTION public.attendance_tz_instant(
  p_local_date DATE,
  p_local_time TIME,
  p_tz TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT (p_local_date + p_local_time) AT TIME ZONE assert_valid_iana_timezone(p_tz);
$$;

CREATE OR REPLACE FUNCTION public.attendance_iso_dow(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT EXTRACT(ISODOW FROM (p_at AT TIME ZONE assert_valid_iana_timezone(p_tz)))::INTEGER;
$$;

/**
 * Shared window for a user at instant p_at (server timestamptz).
 * Returns NULL shift fields when no shift covers that local day (R12).
 */
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
  v_shift_id UUID;
  v_shift_name TEXT;
  v_shift_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_days INTEGER[];
  v_grace INTEGER;
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
  v_found BOOLEAN := false;
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  v_company_tz := COALESCE(v_company_tz, 'Asia/Karachi');

  -- Prefer assigned active shift
  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.grace_minutes, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_grace, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_company_tz)) s
  LIMIT 1;

  IF FOUND AND v_shift_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(ws.timezone), ''), v_company_tz)
    INTO v_shift_tz
    FROM public.work_shifts ws
    WHERE ws.id = v_shift_id;
    v_found := true;
  ELSE
    -- No personal shift: do not invent company hours for auto attendance (R12)
    has_shift := false;
    in_window := false;
    shift_id := NULL;
    shift_name := NULL;
    shift_tz := v_company_tz;
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

  v_shift_tz := assert_valid_iana_timezone(COALESCE(v_shift_tz, v_company_tz));
  v_days := COALESCE(v_days, ARRAY[1,2,3,4,5]);
  v_overnight := COALESCE(v_overnight, (v_end <= v_start));

  v_local_date := public.attendance_local_date(p_at, v_shift_tz);
  v_prev_date := v_local_date - 1;
  v_dow := public.attendance_iso_dow(p_at, v_shift_tz);
  v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;

  IF NOT v_overnight THEN
    IF v_dow = ANY (v_days) THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, v_end, v_shift_tz);
    ELSE
      has_shift := false;
      in_window := false;
      shift_id := v_shift_id;
      shift_name := v_shift_name;
      shift_tz := v_shift_tz;
      start_time := v_start;
      end_time := v_end;
      days_of_week := v_days;
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
  ELSE
    -- Overnight: before end clock belongs to previous local day's shift
    IF v_dow = ANY (v_days) AND (p_at AT TIME ZONE v_shift_tz)::TIME >= v_start THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date + 1, v_end, v_shift_tz);
    ELSIF v_prev_dow = ANY (v_days) AND (p_at AT TIME ZONE v_shift_tz)::TIME <= v_end THEN
      v_att_date := v_prev_date;
      v_shift_start := public.attendance_tz_instant(v_prev_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, v_end, v_shift_tz);
    ELSE
      has_shift := false;
      in_window := false;
      shift_id := v_shift_id;
      shift_name := v_shift_name;
      shift_tz := v_shift_tz;
      start_time := v_start;
      end_time := v_end;
      days_of_week := v_days;
      crosses_midnight := true;
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
  END IF;

  v_win_start := v_shift_start - INTERVAL '60 minutes';
  v_win_end := v_shift_end + INTERVAL '60 minutes';

  has_shift := true;
  in_window := (p_at >= v_win_start AND p_at <= v_win_end);
  shift_id := v_shift_id;
  shift_name := v_shift_name;
  shift_tz := v_shift_tz;
  start_time := v_start;
  end_time := v_end;
  days_of_week := v_days;
  crosses_midnight := v_overnight;
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

-- Skew correction (R25)
CREATE OR REPLACE FUNCTION public.attendance_correct_occurred_at(
  p_occurred_at_utc_ms BIGINT,
  p_device_now_utc_ms BIGINT,
  p_server_now TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS TABLE (
  occurred_at TIMESTAMPTZ,
  skew_ms BIGINT,
  clock_flagged BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_server_ms BIGINT := (EXTRACT(EPOCH FROM p_server_now) * 1000)::BIGINT;
  v_skew BIGINT;
  v_occurred BIGINT;
BEGIN
  IF p_occurred_at_utc_ms IS NULL THEN
    occurred_at := p_server_now;
    skew_ms := 0;
    clock_flagged := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_occurred := p_occurred_at_utc_ms;
  v_skew := 0;
  clock_flagged := false;

  IF p_device_now_utc_ms IS NOT NULL THEN
    v_skew := p_device_now_utc_ms - v_server_ms;
    IF ABS(v_skew) > 2 * 60 * 1000 THEN
      v_occurred := p_occurred_at_utc_ms - v_skew;
    END IF;
    IF ABS(v_skew) > 10 * 60 * 1000 THEN
      clock_flagged := true;
    END IF;
  END IF;

  occurred_at := to_timestamp(v_occurred / 1000.0);
  skew_ms := v_skew;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_local_date(TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_tz_instant(DATE, TIME, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_iso_dow(TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_correct_occurred_at(BIGINT, BIGINT, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
