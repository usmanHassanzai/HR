-- Fix R51/R69: 15-min stale close only for enrolled-device auto visits.
-- Never close old-app geo/manual (or auto_* without attendance_devices) via stale rule;
-- those close only at W-end (R9 / attendance_close_ended_windows).

CREATE OR REPLACE FUNCTION public.attendance_close_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
  v_any_present BOOLEAN;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_source IN ('auto_gps', 'auto_wifi', 'auto_laptop')
      AND EXISTS (
        SELECT 1
        FROM public.attendance_devices d
        WHERE d.user_id = ar.user_id
          AND d.revoked_at IS NULL
      )
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE; -- ended-window job handles W end
    END IF;

    -- Any enrolled device still present within 15 min?
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = r.user_id
        AND d.revoked_at IS NULL
        AND d.presence_state = 'present'
        AND (
          (d.platform IN ('windows', 'linux') AND d.last_heartbeat_at > v_now - INTERVAL '15 minutes')
          OR (d.platform IN ('android', 'ios') AND d.last_presence_at > v_now - INTERVAL '15 minutes')
        )
    ) INTO v_any_present;

    IF v_any_present THEN
      CONTINUE;
    END IF;

    -- Device timestamps only — never fall back to clock_in (that zeroed old-app visits).
    SELECT GREATEST(
      (SELECT MAX(d.last_presence_at) FROM public.attendance_devices d
       WHERE d.user_id = r.user_id AND d.revoked_at IS NULL),
      (SELECT MAX(d.last_heartbeat_at) FROM public.attendance_devices d
       WHERE d.user_id = r.user_id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux'))
    ) INTO v_last;

    IF v_last IS NULL OR v_last > v_now - INTERVAL '15 minutes' THEN
      CONTINUE;
    END IF;

    v_last := LEAST(v_last, COALESCE(v_win.window_end_utc, v_last));

    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_last,
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_last - clock_in_at)) / 60)::INTEGER),
      notes = COALESCE(notes, '') || ' | Auto close: 15m no presence'
    WHERE user_id = r.user_id
      AND attendance_date = r.attendance_date
      AND clock_out_at IS NULL;

    v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_last);

    UPDATE public.attendance_records SET
      clock_out_at = v_last,
      work_minutes = v_mins,
      notes = COALESCE(notes, '') || ' | Auto close: 15m no presence'
    WHERE id = r.id;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;

NOTIFY pgrst, 'reload schema';
