-- Changed shift / company hours must drive attendance, not only the UI.
-- 1) Drop the old upsert overload that updated times but left dual-zone clocks stale.
-- 2) When main hours change, keep laptop/display zones on the same UTC moment.
-- 3) People with no assigned shift use the company location window for real check-in.
-- 4) get_my_location_window matches attendance_window_for_user (same in_window / hours).

DROP FUNCTION IF EXISTS public.upsert_work_shift(
  text, time, time, integer[], integer, uuid, boolean, boolean
);

CREATE OR REPLACE FUNCTION public.shift_sync_display_zones_to_main(p_shift_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start TIME;
  v_end TIME;
  v_tz TEXT;
  v_overnight BOOLEAN;
  v_ref DATE;
  v_start_utc TIMESTAMPTZ;
  v_end_utc TIMESTAMPTZ;
  z RECORD;
BEGIN
  SELECT ws.start_time, ws.end_time,
         public.assert_valid_iana_timezone(
           COALESCE(NULLIF(btrim(ws.timezone), ''), 'Asia/Karachi')
         ),
         COALESCE(ws.crosses_midnight, ws.end_time <= ws.start_time)
    INTO v_start, v_end, v_tz, v_overnight
  FROM public.work_shifts ws
  WHERE ws.id = p_shift_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_ref := (timezone(v_tz, now()))::date;
  v_start_utc := public.attendance_tz_instant(v_ref, v_start, v_tz);
  IF v_overnight THEN
    v_end_utc := public.attendance_tz_instant(v_ref + 1, v_end, v_tz);
  ELSE
    v_end_utc := public.attendance_tz_instant(v_ref, v_end, v_tz);
  END IF;

  FOR z IN
    SELECT id, timezone
    FROM public.shift_display_zones
    WHERE shift_id = p_shift_id
      AND NULLIF(btrim(timezone), '') IS NOT NULL
      AND timezone IS DISTINCT FROM v_tz
  LOOP
    BEGIN
      PERFORM public.assert_valid_iana_timezone(z.timezone);
      UPDATE public.shift_display_zones SET
        entered_start_time = (v_start_utc AT TIME ZONE z.timezone)::time,
        entered_end_time = (v_end_utc AT TIME ZONE z.timezone)::time
      WHERE id = z.id;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_work_shift(
  p_name text,
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_days_of_week integer[] DEFAULT ARRAY[1, 2, 3, 4, 5],
  p_grace_minutes integer DEFAULT 30,
  p_shift_id uuid DEFAULT NULL::uuid,
  p_crosses_midnight boolean DEFAULT NULL::boolean,
  p_apply_to_all boolean DEFAULT true,
  p_timezone text DEFAULT NULL::text,
  p_display_zones jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_role_txt TEXT;
  v_id UUID;
  v_demo BOOLEAN;
  v_overnight BOOLEAN;
  v_company UUID;
  v_org BOOLEAN;
  v_tz TEXT;
  v_item JSONB;
  v_ord INT := 0;
  v_replace_zones BOOLEAN := (p_display_zones IS NOT NULL);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT role::text INTO v_role_txt FROM public.users WHERE id = v_uid;
  IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
    RAISE EXCEPTION 'Only managers, HR, and admins can manage shifts';
  END IF;

  v_org := public.can_manage_org_shifts(v_uid);
  v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

  IF NOT v_overnight AND p_end_time <= p_start_time THEN
    RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
  END IF;

  v_tz := NULLIF(btrim(COALESCE(p_timezone, '')), '');
  IF v_tz IS NOT NULL THEN
    PERFORM public.assert_valid_iana_timezone(v_tz);
  END IF;

  v_demo := public.is_demo_user(v_uid);
  PERFORM public.enforce_demo_isolation(v_uid);

  IF v_org AND NOT v_demo THEN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN
      RAISE EXCEPTION 'Account not linked to a company';
    END IF;
  END IF;

  IF p_shift_id IS NULL THEN
    IF v_tz IS NULL THEN
      SELECT public.company_timezone(u.company_id) INTO v_tz
      FROM public.users u WHERE u.id = v_uid;
    END IF;
    IF v_tz IS NULL THEN
      RAISE EXCEPTION 'Shift timezone is required (set company timezone or pass p_timezone)';
    END IF;
    PERFORM public.assert_valid_iana_timezone(v_tz);

    INSERT INTO public.work_shifts (
      manager_id, name, start_time, end_time, days_of_week, grace_minutes,
      crosses_midnight, apply_to_all, is_demo, timezone
    ) VALUES (
      v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes,
      v_overnight, p_apply_to_all, v_demo, v_tz
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.work_shifts ws SET
      name = trim(p_name),
      start_time = p_start_time,
      end_time = p_end_time,
      days_of_week = p_days_of_week,
      grace_minutes = p_grace_minutes,
      crosses_midnight = v_overnight,
      apply_to_all = p_apply_to_all,
      timezone = COALESCE(v_tz, timezone),
      updated_at = timezone('utc'::text, now())
    WHERE ws.id = p_shift_id
      AND (
        ws.manager_id = v_uid
        OR (
          v_org
          AND EXISTS (
            SELECT 1 FROM public.users owner
            WHERE owner.id = ws.manager_id
              AND (
                (v_demo AND owner.is_demo = true)
                OR (NOT v_demo AND owner.company_id = v_company)
              )
          )
        )
      )
    RETURNING ws.id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    SELECT timezone INTO v_tz FROM public.work_shifts WHERE id = v_id;
  END IF;

  IF v_replace_zones THEN
    DELETE FROM public.shift_display_zones WHERE shift_id = v_id;
    IF jsonb_typeof(p_display_zones) = 'array' THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(p_display_zones)
      LOOP
        IF NULLIF(btrim(v_item->>'timezone'), '') IS NULL THEN CONTINUE; END IF;
        IF NULLIF(btrim(v_item->>'timezone'), '') IS NOT DISTINCT FROM v_tz THEN CONTINUE; END IF;
        PERFORM public.assert_valid_iana_timezone(v_item->>'timezone');
        INSERT INTO public.shift_display_zones (
          shift_id, timezone, entered_start_time, entered_end_time, sort_order
        ) VALUES (
          v_id,
          v_item->>'timezone',
          (v_item->>'start')::TIME,
          (v_item->>'end')::TIME,
          COALESCE((v_item->>'sort_order')::INT, v_ord)
        );
        v_ord := v_ord + 1;
      END LOOP;
    END IF;
  ELSE
    -- Hours changed without a zone payload: keep zone rows, retarget clocks.
    PERFORM public.shift_sync_display_zones_to_main(v_id);
  END IF;

  IF p_apply_to_all AND v_role_txt = 'manager' THEN
    BEGIN
      PERFORM public.assign_shift_to_all_team(v_id, CURRENT_DATE);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_work_shift(
  text, time, time, integer[], integer, uuid, boolean, boolean, text, jsonb
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_sync_display_zones_to_main(UUID) TO authenticated, service_role;

-- Retarget existing dual-zone shifts so laptop hours match current main hours.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT shift_id
    FROM public.shift_display_zones
  LOOP
    PERFORM public.shift_sync_display_zones_to_main(r.shift_id);
  END LOOP;
END $$;

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
    -- No assigned shift: company location window is the real attendance window.
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

CREATE OR REPLACE FUNCTION public.get_my_location_window()
RETURNS TABLE(
  source text,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  grace_minutes integer,
  days_of_week integer[],
  crosses_midnight boolean,
  in_window boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_win RECORD;
  v_grace INTEGER := 60;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(v_uid, timezone('utc'::text, now()))
  LIMIT 1;

  IF v_win.shift_id IS NOT NULL THEN
    SELECT COALESCE(ws.grace_minutes, 60) INTO v_grace
    FROM public.work_shifts ws
    WHERE ws.id = v_win.shift_id;
  ELSE
    v_grace := 60;
  END IF;

  RETURN QUERY SELECT
    CASE WHEN v_win.shift_id IS NOT NULL THEN 'shift'::text ELSE 'company'::text END,
    v_win.shift_name,
    v_win.start_time,
    v_win.end_time,
    v_grace,
    COALESCE(v_win.days_of_week, ARRAY[1, 2, 3, 4, 5, 6, 7]),
    COALESCE(v_win.crosses_midnight, false),
    COALESCE(v_win.in_window, false);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_location_window() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
