-- assignment_driven_location_shift_2026-10-12.sql
-- Minimal workable paths from ASSIGNMENTS only (no PK/US/Karachi hardcoding):
--   1) Location presence: already in office_multi_locations_assign (assigned pins OR).
--   2) Shift window: restore get_my_location_window from assigned shift + equal timezone rows.
-- Attendance WRITES (check-in/out, auto Wi-Fi engine) stay paused (rules_not_configured).

-- ---------------------------------------------------------------------------
-- 1) Timezone columns + helpers (no Asia/Karachi invent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE public.work_shifts
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Stop forcing Karachi as DEFAULT for new rows (existing values left alone).
ALTER TABLE public.companies ALTER COLUMN timezone DROP DEFAULT;
ALTER TABLE public.work_shifts ALTER COLUMN timezone DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.assert_valid_iana_timezone(p_tz TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_tz IS NULL OR btrim(p_tz) = '' THEN
    RAISE EXCEPTION 'timezone is required';
  END IF;
  PERFORM now() AT TIME ZONE p_tz;
  RETURN p_tz;
EXCEPTION WHEN invalid_parameter_value OR undefined_object THEN
  RAISE EXCEPTION 'Invalid IANA timezone: %', p_tz;
END;
$$;

CREATE OR REPLACE FUNCTION public.company_timezone(p_company_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(btrim(c.timezone), '')
  FROM public.companies c
  WHERE c.id = p_company_id;
$$;

-- Prefer company TZ of the signed-in user; UTC only as last resort. Never invent a country.
CREATE OR REPLACE FUNCTION public.app_timezone()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT public.company_timezone(u.company_id) INTO v_tz
  FROM public.users u
  WHERE u.id = auth.uid();
  RETURN COALESCE(NULLIF(btrim(v_tz), ''), 'UTC');
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_local_date(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT (p_at AT TIME ZONE public.assert_valid_iana_timezone(p_tz))::DATE;
$$;

CREATE OR REPLACE FUNCTION public.attendance_tz_instant(
  p_local_date DATE,
  p_local_time TIME,
  p_tz TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT (p_local_date + p_local_time) AT TIME ZONE public.assert_valid_iana_timezone(p_tz);
$$;

CREATE OR REPLACE FUNCTION public.attendance_iso_dow(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT EXTRACT(ISODOW FROM (p_at AT TIME ZONE public.assert_valid_iana_timezone(p_tz)))::INTEGER;
$$;

GRANT EXECUTE ON FUNCTION public.assert_valid_iana_timezone(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_timezone(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_timezone() TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_local_date(TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_tz_instant(DATE, TIME, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_iso_dow(TIMESTAMPTZ, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) Equal multi-zone rows (table + list RPC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shift_display_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES public.work_shifts(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  entered_start_time TIME NOT NULL,
  entered_end_time TIME NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_shift_display_zones_shift ON public.shift_display_zones(shift_id);

ALTER TABLE public.shift_display_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shift_display_zones_select ON public.shift_display_zones;
CREATE POLICY shift_display_zones_select ON public.shift_display_zones
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.work_shifts ws
      JOIN public.users owner ON owner.id = ws.manager_id
      JOIN public.users me ON me.id = auth.uid()
      WHERE ws.id = shift_display_zones.shift_id
        AND (
          me.is_platform_owner
          OR (me.is_demo = true AND owner.is_demo = true)
          OR (me.is_demo = false AND owner.company_id IS NOT DISTINCT FROM me.company_id)
        )
    )
  );

DROP POLICY IF EXISTS shift_display_zones_write ON public.shift_display_zones;
CREATE POLICY shift_display_zones_write ON public.shift_display_zones
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.work_shifts ws
      JOIN public.users owner ON owner.id = ws.manager_id
      JOIN public.users me ON me.id = auth.uid()
      WHERE ws.id = shift_display_zones.shift_id
        AND me.role::text IN ('admin', 'hr', 'manager')
        AND (
          me.is_platform_owner
          OR ws.manager_id = me.id
          OR (me.is_demo = true AND owner.is_demo = true)
          OR (me.is_demo = false AND owner.company_id IS NOT DISTINCT FROM me.company_id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.work_shifts ws
      JOIN public.users owner ON owner.id = ws.manager_id
      JOIN public.users me ON me.id = auth.uid()
      WHERE ws.id = shift_display_zones.shift_id
        AND me.role::text IN ('admin', 'hr', 'manager')
        AND (
          me.is_platform_owner
          OR ws.manager_id = me.id
          OR (me.is_demo = true AND owner.is_demo = true)
          OR (me.is_demo = false AND owner.company_id IS NOT DISTINCT FROM me.company_id)
        )
    )
  );

COMMENT ON TABLE public.shift_display_zones IS
  'Extra timezone times for a shift. Each row is an equal attendance window alongside work_shifts.timezone; membership ORs across zones.';

CREATE OR REPLACE FUNCTION public.list_shift_display_zones(p_shift_id UUID)
RETURNS TABLE (
  timezone TEXT,
  entered_start_time TIME,
  entered_end_time TIME,
  sort_order INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT z.timezone, z.entered_start_time, z.entered_end_time, z.sort_order
  FROM public.shift_display_zones z
  WHERE z.shift_id = p_shift_id
  ORDER BY z.sort_order, z.timezone;
$$;

GRANT EXECUTE ON FUNCTION public.list_shift_display_zones(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Bounds for one clock (local wall times in one IANA zone)
-- ---------------------------------------------------------------------------
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

GRANT EXECUTE ON FUNCTION public.attendance_bounds_for_clock(TIMESTAMPTZ, TIME, TIME, INTEGER[], TEXT, BOOLEAN) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Window from ASSIGNED shift only (OR across equal timezone rows)
-- ---------------------------------------------------------------------------
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
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  -- Lookup date uses company TZ when set, else UTC — never invent a country zone.
  v_lookup_tz := COALESCE(NULLIF(btrim(v_company_tz), ''), 'UTC');

  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_lookup_tz)) s
  LIMIT 1;

  IF NOT FOUND OR v_shift_id IS NULL THEN
    -- No assigned / apply-to-all shift: empty window (do not invent company hours).
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
  v_overnight := COALESCE(v_overnight, (v_end <= v_start));

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

  -- Equal zones: OR across every saved timezone row for this shift.
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
    ELSIF COALESCE(v_main.has_shift, false) = false AND COALESCE(v_try.has_shift, false) THEN
      -- Prefer a zone that has a covering day even if not currently in window.
      IF NOT COALESCE(v_main.has_shift, false) THEN
        v_att_date := v_try.attendance_date;
        v_shift_start := v_try.shift_start_utc;
        v_shift_end := v_try.shift_end_utc;
        v_win_start := v_try.window_start_utc;
        v_win_end := v_try.window_end_utc;
        v_start := v_zone.entered_start_time;
        v_end := v_zone.entered_end_time;
        v_shift_tz := v_zone.timezone;
        v_overnight := COALESCE(v_try.crosses_midnight, false);
      END IF;
    END IF;
  END LOOP;

  has_shift := COALESCE(v_main.has_shift, false) OR v_best_in OR (v_shift_start IS NOT NULL);
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

GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) get_my_location_window — assigned shift times (+ timezone for clients)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_my_location_window() CASCADE;

CREATE OR REPLACE FUNCTION public.get_my_location_window()
RETURNS TABLE(
  source text,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  grace_minutes integer,
  days_of_week integer[],
  crosses_midnight boolean,
  in_window boolean,
  timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_win RECORD;
  v_grace INTEGER := 60;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(v_uid, timezone('utc'::text, now()))
  LIMIT 1;

  IF v_win.shift_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(ws.grace_minutes, 60) INTO v_grace
  FROM public.work_shifts ws
  WHERE ws.id = v_win.shift_id;

  RETURN QUERY SELECT
    'shift'::text,
    v_win.shift_name,
    v_win.start_time,
    v_win.end_time,
    v_grace,
    COALESCE(v_win.days_of_week, ARRAY[1, 2, 3, 4, 5]),
    COALESCE(v_win.crosses_midnight, false),
    COALESCE(v_win.in_window, false),
    v_win.shift_tz;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_location_window() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Assigned shift RPCs expose shift.timezone (no browser invent on server)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_user_assigned_shift(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_my_shift() CASCADE;

CREATE OR REPLACE FUNCTION public.get_user_assigned_shift(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    effective_from DATE,
    crosses_midnight BOOLEAN,
    timezone TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_date DATE := (timezone(public.app_timezone(), now()))::date;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_uid <> auth.uid()
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), v_uid)
       AND NOT public.can_access_user_data(v_uid) THEN
        RAISE EXCEPTION 'Not authorized to view this shift';
    END IF;

    RETURN QUERY
    SELECT
        s.shift_id,
        s.shift_name,
        s.start_time,
        s.end_time,
        s.grace_minutes,
        s.days_of_week,
        COALESCE(esa.effective_from, v_date),
        s.crosses_midnight,
        NULLIF(btrim(ws.timezone), '')
    FROM public.get_active_shift_for_user(v_uid, v_date) s
    LEFT JOIN public.work_shifts ws ON ws.id = s.shift_id
    LEFT JOIN public.employee_shift_assignments esa
        ON esa.user_id = v_uid
        AND esa.shift_id = s.shift_id
        AND esa.effective_from <= v_date
        AND (esa.effective_to IS NULL OR esa.effective_to >= v_date)
    ORDER BY esa.effective_from DESC NULLS LAST
    LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_shift()
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    effective_from DATE,
    crosses_midnight BOOLEAN,
    timezone TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.get_user_assigned_shift(auth.uid());
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_assigned_shift(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_shift() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7) Presence copy: assignment-driven (writes still paused)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_site RECORD;
  v_distance DOUBLE PRECISION;
  v_radius INTEGER;
  v_inside BOOLEAN := false;
  v_action TEXT := 'outside_office';
  v_any BOOLEAN := false;
  v_best_name TEXT;
  v_best_lat DOUBLE PRECISION;
  v_best_lng DOUBLE PRECISION;
  v_best_radius INTEGER;
  v_best_dist DOUBLE PRECISION;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'rules_not_configured',
      'action', 'skipped',
      'reason', 'Geo attendance is for employees, managers, and HR only',
      'message', 'Office radius checks apply to employees, managers, and HR. Attendance writes remain paused.'
    );
  END IF;

  FOR v_site IN
    SELECT * FROM public.get_work_sites_for_user(v_user_id)
  LOOP
    v_any := true;
    v_radius := GREATEST(COALESCE(v_site.radius_meters, 1), 1);
    v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
    IF v_distance IS NOT NULL AND v_distance <= v_radius THEN
      v_inside := true;
      v_best_name := v_site.site_name;
      v_best_lat := v_site.latitude;
      v_best_lng := v_site.longitude;
      v_best_radius := v_radius;
      v_best_dist := v_distance;
      EXIT;
    END IF;
    IF v_best_lat IS NULL OR (v_distance IS NOT NULL AND (v_best_dist IS NULL OR v_distance < v_best_dist)) THEN
      v_best_name := v_site.site_name;
      v_best_lat := v_site.latitude;
      v_best_lng := v_site.longitude;
      v_best_radius := v_radius;
      v_best_dist := v_distance;
    END IF;
  END LOOP;

  IF NOT v_any OR v_best_lat IS NULL OR v_best_lng IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'no_work_site',
      'action', 'outside_office',
      'reason', 'no_work_site',
      'inside_office', false,
      'message', 'No office location assigned. Ask admin: Office & Attendance → Assign people. Only assigned locations count for radius.'
    );
  END IF;

  v_radius := GREATEST(COALESCE(v_best_radius, 1), 1);
  v_distance := COALESCE(v_best_dist, public.haversine_meters(p_latitude, p_longitude, v_best_lat, v_best_lng));
  IF NOT v_inside THEN
    v_inside := v_distance IS NOT NULL AND v_distance <= v_radius;
  END IF;
  v_action := CASE WHEN v_inside THEN 'inside_office' ELSE 'outside_radius' END;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_action,
    'action', v_action,
    'reason', 'assignment_presence',
    'inside_office', v_inside,
    'office_name', v_best_name,
    'distance_meters', ROUND(v_distance)::integer,
    'radius_meters', v_radius,
    'effective_radius_meters', v_radius,
    'writes_paused', true,
    'message', CASE
      WHEN v_inside THEN
        'Inside assigned location radius (' || v_radius || 'm). Check-in/out writes are still paused while auto rules are rebuilt.'
      ELSE
        'Outside your assigned location(s) (' || v_radius || 'm). Other office locations do not apply. Check-in/out writes remain paused.'
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text,
  p_is_mock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'gps_unusable',
      'action', 'gps_unusable',
      'reason', 'gps_unusable',
      'inside_office', false,
      'writes_paused', true,
      'message', 'Mock location is not allowed for office radius checks. Attendance writes remain paused.'
    );
  END IF;
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) TO authenticated;

-- Prefer live office_locations.radius; do not invent a country-default radius.
CREATE OR REPLACE FUNCTION public.get_work_sites_for_user(p_user_id UUID)
RETURNS TABLE(
  site_id UUID,
  site_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER,
  tracking_enabled BOOLEAN,
  manager_id UUID,
  office_location_id UUID,
  office_id UUID,
  office_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_mgr UUID;
  v_personal_count INTEGER := 0;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_mgr := CASE
    WHEN v_user.role = 'manager'::public.user_role THEN v_user.id
    ELSE v_user.manager_id
  END;

  SELECT COUNT(*) INTO v_personal_count
  FROM public.employee_work_sites ews
  WHERE ews.user_id = p_user_id
    AND ews.tracking_enabled = true
    AND ews.is_demo = v_user.is_demo;

  IF v_personal_count > 0 THEN
    RETURN QUERY
    SELECT
      ews.id,
      COALESCE(o.name, ews.name),
      COALESCE(o.latitude, ews.latitude),
      COALESCE(o.longitude, ews.longitude),
      GREATEST(COALESCE(o.radius_meters, ews.radius_meters), 1),
      ews.tracking_enabled,
      v_mgr,
      ews.office_location_id,
      o.office_id,
      ofc.name
    FROM public.employee_work_sites ews
    LEFT JOIN public.office_locations o
      ON o.id = ews.office_location_id
     AND COALESCE(o.active, true) = true
     AND o.is_demo = v_user.is_demo
    LEFT JOIN public.offices ofc ON ofc.id = o.office_id
    WHERE ews.user_id = p_user_id
      AND ews.tracking_enabled = true
      AND ews.is_demo = v_user.is_demo
      AND COALESCE(o.latitude, ews.latitude) IS NOT NULL
      AND COALESCE(o.longitude, ews.longitude) IS NOT NULL
    ORDER BY COALESCE(ofc.name, ''), COALESCE(o.name, ews.name);
    RETURN;
  END IF;

  IF v_mgr IS NOT NULL THEN
    RETURN QUERY
    SELECT
      mws.id,
      COALESCE(o.name, mws.name),
      COALESCE(o.latitude, mws.latitude),
      COALESCE(o.longitude, mws.longitude),
      GREATEST(COALESCE(o.radius_meters, mws.radius_meters), 1),
      mws.tracking_enabled,
      mws.manager_id,
      mws.office_location_id,
      o.office_id,
      ofc.name
    FROM public.manager_work_sites mws
    LEFT JOIN public.office_locations o
      ON o.id = mws.office_location_id
     AND COALESCE(o.active, true) = true
     AND o.is_demo = v_user.is_demo
    LEFT JOIN public.offices ofc ON ofc.id = o.office_id
    WHERE mws.manager_id = v_mgr
      AND mws.tracking_enabled = true
      AND COALESCE(o.latitude, mws.latitude) IS NOT NULL
      AND COALESCE(o.longitude, mws.longitude) IS NOT NULL
    LIMIT 1;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_work_sites_for_user(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
