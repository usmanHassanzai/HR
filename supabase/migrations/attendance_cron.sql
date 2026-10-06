-- attendance_cron.sql
-- R56 / R9 / R51 / R69: close ended windows, laptop heartbeat gaps, Wi-Fi/GPS 15m absence
-- N3: delete location pings older than 90 days

CREATE OR REPLACE FUNCTION public.attendance_close_ended_windows()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_close_at TIMESTAMPTZ;
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.status = 'present'
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;

    -- Also try close using the record's attendance_date mid-shift probe
    IF v_win.window_end_utc IS NULL OR COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(
        r.user_id,
        (r.attendance_date + TIME '12:00') AT TIME ZONE COALESCE(
          (SELECT timezone FROM public.work_shifts WHERE id = r.shift_id),
          public.company_timezone((SELECT company_id FROM public.users WHERE id = r.user_id))
        )
      )
      LIMIT 1;
    END IF;

    IF v_win.window_end_utc IS NOT NULL AND v_now > v_win.window_end_utc THEN
      SELECT COALESCE(MAX(d.last_presence_at), MAX(vs.clock_in_at), r.clock_in_at)
      INTO v_last
      FROM public.attendance_visit_segments vs
      FULL OUTER JOIN public.attendance_devices d ON d.user_id = r.user_id AND d.revoked_at IS NULL
      WHERE vs.user_id = r.user_id AND vs.attendance_date = r.attendance_date AND vs.clock_out_at IS NULL;

      v_close_at := LEAST(COALESCE(v_last, v_win.window_end_utc), v_win.window_end_utc);

      UPDATE public.attendance_visit_segments SET
        clock_out_at = v_close_at,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_close_at - clock_in_at)) / 60)::INTEGER),
        notes = COALESCE(notes, '') || ' | Auto close at window end'
      WHERE user_id = r.user_id
        AND attendance_date = r.attendance_date
        AND clock_out_at IS NULL;

      v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_close_at);

      UPDATE public.attendance_records SET
        clock_out_at = v_close_at,
        work_minutes = v_mins,
        notes = COALESCE(notes, '') || ' | Auto close at window end'
      WHERE id = r.id;

      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

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
      AND ar.attendance_source IN ('auto_gps', 'auto_wifi', 'auto_laptop', 'geo')
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

    SELECT GREATEST(
      COALESCE((
        SELECT MAX(d.last_presence_at) FROM public.attendance_devices d
        WHERE d.user_id = r.user_id AND d.revoked_at IS NULL
      ), r.clock_in_at),
      COALESCE((
        SELECT MAX(d.last_heartbeat_at) FROM public.attendance_devices d
        WHERE d.user_id = r.user_id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
      ), r.clock_in_at)
    ) INTO v_last;

    IF v_last IS NULL OR v_last > v_now - INTERVAL '15 minutes' THEN
      CONTINUE;
    END IF;

    -- Cap inside window
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

CREATE OR REPLACE FUNCTION public.attendance_cron_tick()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ended INTEGER;
  v_stale INTEGER;
  v_pings INTEGER;
BEGIN
  v_ended := public.attendance_close_ended_windows();
  v_stale := public.attendance_close_stale_presence();

  DELETE FROM public.employee_location_pings
  WHERE recorded_at < timezone('utc', now()) - INTERVAL '90 days';
  GET DIAGNOSTICS v_pings = ROW_COUNT;

  RETURN jsonb_build_object(
    'closed_ended', v_ended,
    'closed_stale', v_stale,
    'pings_deleted', v_pings,
    'ran_at', timezone('utc', now())
  );
END;
$$;

-- Align/replace scorr-close-ended-shifts cron if pg_cron available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('scorr-close-ended-shifts', 'scorr-attendance-cron');

    PERFORM cron.schedule(
      'scorr-attendance-cron',
      '*/5 * * * *',
      $cron$SELECT public.attendance_cron_tick();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_close_ended_windows() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_cron_tick() TO service_role;

NOTIFY pgrst, 'reload schema';
