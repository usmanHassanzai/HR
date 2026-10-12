CREATE OR REPLACE FUNCTION public.get_my_location_window()
 RETURNS TABLE(source text, shift_name text, start_time time without time zone, end_time time without time zone, grace_minutes integer, days_of_week integer[], crosses_midnight boolean, in_window boolean)
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
$function$
