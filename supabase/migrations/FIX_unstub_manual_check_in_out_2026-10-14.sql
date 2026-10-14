-- Unstub legacy check_in_attendance / check_out_attendance left as RETURN NULL
-- after attendance_rules_reset. Manual UI uses process_geo_attendance_ping;
-- these wrappers keep older callers from silently no-oping.

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'Use Clock in with location. Check-in requires configured office Wi-Fi or being inside the assigned office radius.';
END;
$$;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_action text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_result := public.process_geo_attendance_ping(
    NULL::double precision,
    NULL::double precision,
    NULL::double precision,
    'clock_out',
    false,
    NULL::text,
    NULL::text
  );
  v_action := COALESCE(v_result->>'action', v_result->>'reason', 'none');

  IF v_action IN ('clock_out', 'clock_out_shift_end', 'already_clocked_out') THEN
    SELECT id INTO v_id
    FROM public.attendance_records
    WHERE user_id = auth.uid()
      AND attendance_date = COALESCE(p_date, (v_result->>'attendance_date')::date, CURRENT_DATE)
    ORDER BY clock_out_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
    RETURN v_id;
  END IF;

  IF v_action = 'no_open_visit' THEN
    RAISE EXCEPTION 'Check in first, then you can check out';
  END IF;

  RAISE EXCEPTION '%', COALESCE(v_result->>'message', v_action, 'Could not check out');
END;
$$;

CREATE OR REPLACE FUNCTION public.check_out_attendance(
  p_date date,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_is_mock boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_action text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Manual check-out: any place during [shift_start, shift_end). GPS optional.
  v_result := public.process_geo_attendance_ping(
    p_latitude,
    p_longitude,
    p_accuracy,
    'clock_out',
    COALESCE(p_is_mock, false),
    NULL::text,
    NULL::text
  );
  v_action := COALESCE(v_result->>'action', v_result->>'reason', 'none');

  IF v_action IN ('clock_out', 'clock_out_shift_end', 'already_clocked_out') THEN
    SELECT id INTO v_id
    FROM public.attendance_records
    WHERE user_id = auth.uid()
      AND attendance_date = COALESCE(p_date, (v_result->>'attendance_date')::date, CURRENT_DATE)
    ORDER BY clock_out_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
    RETURN v_id;
  END IF;

  IF v_action = 'no_open_visit' THEN
    RAISE EXCEPTION 'Check in first, then you can check out';
  END IF;

  RAISE EXCEPTION '%', COALESCE(v_result->>'message', v_action, 'Could not check out');
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(date, double precision, double precision, double precision, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
