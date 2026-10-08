-- Per-person shift hours: change one assigned user's start/end without
-- rewriting the shared shift for everyone. Attendance uses those hours.

ALTER TABLE public.employee_shift_assignments
  ADD COLUMN IF NOT EXISTS override_start_time TIME,
  ADD COLUMN IF NOT EXISTS override_end_time TIME,
  ADD COLUMN IF NOT EXISTS override_crosses_midnight BOOLEAN;

COMMENT ON COLUMN public.employee_shift_assignments.override_start_time IS
  'When set with override_end_time, this person uses these hours instead of the shared shift template.';

CREATE OR REPLACE FUNCTION public.get_active_shift_for_user(
  p_user_id uuid,
  p_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  shift_id uuid,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  grace_minutes integer,
  days_of_week integer[],
  manager_id uuid,
  crosses_midnight boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_manager_id UUID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.employee_shift_assignments esa
    JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
    WHERE esa.user_id = p_user_id
      AND esa.effective_from <= p_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
  ) THEN
    RETURN QUERY
    SELECT
      ws.id,
      ws.name,
      COALESCE(esa.override_start_time, ws.start_time),
      COALESCE(esa.override_end_time, ws.end_time),
      ws.grace_minutes,
      ws.days_of_week,
      ws.manager_id,
      COALESCE(
        esa.override_crosses_midnight,
        ws.crosses_midnight,
        (COALESCE(esa.override_end_time, ws.end_time)
          <= COALESCE(esa.override_start_time, ws.start_time))
      )
    FROM public.employee_shift_assignments esa
    JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
    WHERE esa.user_id = p_user_id
      AND esa.effective_from <= p_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
    ORDER BY (esa.effective_to IS NULL) DESC, esa.effective_from DESC, esa.created_at DESC
    LIMIT 1;
    RETURN;
  END IF;

  SELECT u.manager_id INTO v_manager_id FROM public.users u WHERE u.id = p_user_id;

  RETURN QUERY
  SELECT
    ws.id,
    ws.name,
    ws.start_time,
    ws.end_time,
    ws.grace_minutes,
    ws.days_of_week,
    ws.manager_id,
    ws.crosses_midnight
  FROM public.work_shifts ws
  WHERE ws.manager_id = v_manager_id
    AND ws.active = true
    AND ws.apply_to_all = true
  ORDER BY ws.updated_at DESC, ws.created_at DESC
  LIMIT 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attendance_user_has_custom_hours(
  p_user_id UUID,
  p_shift_id UUID,
  p_date DATE DEFAULT (timezone(public.app_timezone(), now()))::date
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.employee_shift_assignments esa
    WHERE esa.user_id = p_user_id
      AND esa.shift_id = p_shift_id
      AND esa.effective_from <= p_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
      AND esa.override_start_time IS NOT NULL
      AND esa.override_end_time IS NOT NULL
  );
$$;

-- Rebuild attendance_window_for_user: skip dual-zone expansion when this
-- person has custom hours (their override is the single source of truth).
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
  v_custom BOOLEAN := false;
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  v_company_tz := COALESCE(v_company_tz, 'Asia/Karachi');

  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_company_tz)) s
  LIMIT 1;

  IF NOT FOUND OR v_shift_id IS NULL THEN
    SELECT c.location_window_start, c.location_window_end
      INTO v_start, v_end
    FROM public.companies c
    WHERE c.id = v_company_id;

    v_start := COALESCE(v_start, '17:30'::TIME);
    v_end := COALESCE(v_end, '04:00'::TIME);
    v_days := ARRAY[1, 2, 3, 4, 5, 6, 7];
    v_overnight := (v_end <= v_start);
    v_shift_tz := v_company_tz;
    v_shift_name := 'Company hours';

    SELECT * INTO v_main
    FROM public.attendance_bounds_for_clock(
      p_at, v_start, v_end, v_days, v_shift_tz, v_overnight
    )
    LIMIT 1;

    has_shift := COALESCE(v_main.has_shift, true);
    in_window := COALESCE(v_main.in_window, false);
    shift_id := NULL;
    shift_name := v_shift_name;
    shift_tz := v_shift_tz;
    start_time := v_start;
    end_time := v_end;
    days_of_week := v_days;
    crosses_midnight := COALESCE(v_main.crosses_midnight, v_overnight);
    attendance_date := v_main.attendance_date;
    window_start_utc := v_main.window_start_utc;
    window_end_utc := v_main.window_end_utc;
    shift_start_utc := v_main.shift_start_utc;
    shift_end_utc := v_main.shift_end_utc;
    company_id := v_company_id;
    company_tz := v_company_tz;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(NULLIF(btrim(ws.timezone), ''), v_company_tz)
  INTO v_shift_tz
  FROM public.work_shifts ws
  WHERE ws.id = v_shift_id;

  v_shift_tz := public.assert_valid_iana_timezone(COALESCE(v_shift_tz, v_company_tz));
  v_days := COALESCE(v_days, ARRAY[1, 2, 3, 4, 5]);
  v_overnight := COALESCE(v_overnight, (v_end <= v_start));
  v_custom := public.attendance_user_has_custom_hours(
    p_user_id, v_shift_id, public.attendance_local_date(p_at, v_company_tz)
  );

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

  IF NOT v_custom THEN
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
        v_start := v_zone.entered_start_time;
        v_end := v_zone.entered_end_time;
        v_shift_tz := v_zone.timezone;
        v_overnight := COALESCE(v_try.crosses_midnight, false);
        v_att_date := v_try.attendance_date;
        v_shift_start := v_try.shift_start_utc;
        v_shift_end := v_try.shift_end_utc;
        v_win_start := v_try.window_start_utc;
        v_win_end := v_try.window_end_utc;
      END IF;
    END LOOP;
  END IF;

  has_shift := COALESCE(v_main.has_shift, false) OR v_best_in;
  in_window := v_best_in;
  shift_id := v_shift_id;
  shift_name := v_shift_name;
  shift_tz := v_shift_tz;
  start_time := v_start;
  end_time := v_end;
  days_of_week := v_days;
  crosses_midnight := COALESCE(v_overnight, false);
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

CREATE OR REPLACE FUNCTION public.admin_set_user_shift_hours(
  p_user_id UUID,
  p_start_time TIME DEFAULT NULL,
  p_end_time TIME DEFAULT NULL,
  p_crosses_midnight BOOLEAN DEFAULT NULL,
  p_clear BOOLEAN DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_today DATE := (timezone(public.app_timezone(), now()))::date;
  v_esa public.employee_shift_assignments%ROWTYPE;
  v_overnight BOOLEAN;
  v_target public.users%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Person is required'; END IF;

  SELECT role::text INTO v_role FROM public.users WHERE id = v_uid;
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person not found'; END IF;

  IF NOT (
    public.can_manage_org_shifts(v_uid)
    OR public.is_manager_of(v_uid, p_user_id)
    OR (v_role = 'manager' AND v_target.manager_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'Not allowed to change this person''s shift hours';
  END IF;

  SELECT * INTO v_esa
  FROM public.employee_shift_assignments esa
  WHERE esa.user_id = p_user_id
    AND esa.effective_from <= v_today
    AND (esa.effective_to IS NULL OR esa.effective_to >= v_today)
  ORDER BY (esa.effective_to IS NULL) DESC, esa.effective_from DESC, esa.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assign a shift to this person first, then set their hours';
  END IF;

  IF p_clear THEN
    UPDATE public.employee_shift_assignments SET
      override_start_time = NULL,
      override_end_time = NULL,
      override_crosses_midnight = NULL
    WHERE id = v_esa.id;

    RETURN jsonb_build_object(
      'ok', true,
      'cleared', true,
      'user_id', p_user_id,
      'shift_id', v_esa.shift_id
    );
  END IF;

  IF p_start_time IS NULL OR p_end_time IS NULL THEN
    RAISE EXCEPTION 'Start and end times are required';
  END IF;

  v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));
  IF NOT v_overnight AND p_end_time <= p_start_time THEN
    RAISE EXCEPTION 'End time must be after start time, or enable overnight';
  END IF;

  UPDATE public.employee_shift_assignments SET
    override_start_time = p_start_time,
    override_end_time = p_end_time,
    override_crosses_midnight = v_overnight
  WHERE id = v_esa.id;

  RETURN jsonb_build_object(
    'ok', true,
    'cleared', false,
    'user_id', p_user_id,
    'shift_id', v_esa.shift_id,
    'start_time', p_start_time,
    'end_time', p_end_time,
    'crosses_midnight', v_overnight
  );
END;
$$;

DROP FUNCTION IF EXISTS public.get_org_shift_assignments();
CREATE OR REPLACE FUNCTION public.get_org_shift_assignments()
RETURNS TABLE(
  user_id uuid,
  full_name text,
  email text,
  employee_role text,
  shift_id uuid,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  effective_from date,
  hours_custom boolean,
  crosses_midnight boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_today DATE := (timezone(public.app_timezone(), now()))::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.can_manage_org_shifts(v_uid) THEN
    RAISE EXCEPTION 'Only admins and HR can view organization shift assignments';
  END IF;

  IF public.is_demo_user(v_uid) THEN
    RETURN QUERY
    SELECT
      u.id,
      u.full_name,
      u.email,
      u.role::TEXT,
      s.shift_id,
      COALESCE(s.shift_name, 'Company hours'),
      COALESCE(s.start_time, '17:30'::TIME),
      COALESCE(s.end_time, '04:00'::TIME),
      esa.effective_from,
      COALESCE(esa.hours_custom, false),
      COALESCE(s.crosses_midnight, false)
    FROM public.users u
    LEFT JOIN LATERAL (
      SELECT * FROM public.get_active_shift_for_user(u.id, v_today) LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT
        esa2.effective_from,
        (esa2.override_start_time IS NOT NULL AND esa2.override_end_time IS NOT NULL) AS hours_custom
      FROM public.employee_shift_assignments esa2
      WHERE esa2.user_id = u.id
        AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
        AND esa2.effective_from <= v_today
        AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
      ORDER BY (esa2.effective_to IS NULL) DESC, esa2.effective_from DESC
      LIMIT 1
    ) esa ON true
    WHERE u.is_demo = true
      AND u.role::text IN ('employee', 'manager', 'hr')
    ORDER BY u.role DESC, u.full_name;
    RETURN;
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.full_name,
    u.email,
    u.role::TEXT,
    s.shift_id,
    CASE WHEN s.shift_id IS NOT NULL THEN s.shift_name ELSE 'Company hours' END,
    COALESCE(s.start_time, c.location_window_start, '17:30'::TIME),
    COALESCE(s.end_time, c.location_window_end, '04:00'::TIME),
    esa.effective_from,
    COALESCE(esa.hours_custom, false),
    COALESCE(s.crosses_midnight, false)
  FROM public.users u
  JOIN public.companies c ON c.id = u.company_id
  LEFT JOIN LATERAL (
    SELECT * FROM public.get_active_shift_for_user(u.id, v_today) LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT
      esa2.effective_from,
      (esa2.override_start_time IS NOT NULL AND esa2.override_end_time IS NOT NULL) AS hours_custom
    FROM public.employee_shift_assignments esa2
    WHERE esa2.user_id = u.id
      AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
      AND esa2.effective_from <= v_today
      AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
    ORDER BY (esa2.effective_to IS NULL) DESC, esa2.effective_from DESC
    LIMIT 1
  ) esa ON true
  WHERE u.company_id = v_company
    AND u.is_demo = false
    AND u.role::text IN ('employee', 'manager', 'hr')
  ORDER BY u.role DESC, u.full_name;
END;
$function$;

DROP FUNCTION IF EXISTS public.get_team_shift_assignments();
CREATE OR REPLACE FUNCTION public.get_team_shift_assignments()
RETURNS TABLE(
  user_id uuid,
  full_name text,
  email text,
  shift_id uuid,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  effective_from date,
  hours_custom boolean,
  crosses_midnight boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone(public.app_timezone(), now()))::date;
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT company_id INTO v_company FROM public.users WHERE id = v_uid;

  RETURN QUERY
  SELECT
    u.id,
    u.full_name,
    u.email,
    s.shift_id,
    CASE WHEN s.shift_id IS NOT NULL THEN s.shift_name ELSE 'Company hours' END,
    COALESCE(
      s.start_time,
      (SELECT c.location_window_start FROM public.companies c WHERE c.id = v_company),
      '17:30'::TIME
    ),
    COALESCE(
      s.end_time,
      (SELECT c.location_window_end FROM public.companies c WHERE c.id = v_company),
      '04:00'::TIME
    ),
    esa.effective_from,
    COALESCE(esa.hours_custom, false),
    COALESCE(s.crosses_midnight, false)
  FROM public.users u
  LEFT JOIN LATERAL (
    SELECT * FROM public.get_active_shift_for_user(u.id, v_today) LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT
      esa2.effective_from,
      (esa2.override_start_time IS NOT NULL AND esa2.override_end_time IS NOT NULL) AS hours_custom
    FROM public.employee_shift_assignments esa2
    WHERE esa2.user_id = u.id
      AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
      AND esa2.effective_from <= v_today
      AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
    ORDER BY (esa2.effective_to IS NULL) DESC, esa2.effective_from DESC
    LIMIT 1
  ) esa ON true
  WHERE u.manager_id = v_uid
    AND u.role = 'employee'::public.user_role
  ORDER BY u.full_name;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_active_shift_for_user(UUID, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_user_has_custom_hours(UUID, UUID, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_user_shift_hours(UUID, TIME, TIME, BOOLEAN, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_shift_assignments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_shift_assignments() TO authenticated;

NOTIFY pgrst, 'reload schema';
