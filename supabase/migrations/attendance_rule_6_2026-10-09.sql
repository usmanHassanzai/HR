-- Rule 6: At shift end + 1 hour, close every still-open visit.
-- Clock-out time recorded = shift END. Note includes "Shift ended".
-- Overnight / two-clock shifts use each clock's own timezone via
-- shift_latest_end_timestamptz. Idempotent. History must not keep
-- "still working" after the close.
-- Force-close writes use write-mode 'shift_end_close' so the window
-- guard does not block recording clock_out_at = shift END after W ends.

CREATE OR REPLACE FUNCTION public.attendance_guard_clock_times()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mode TEXT := public.attendance_write_mode();
  v_win RECORD;
  v_at TIMESTAMPTZ;
BEGIN
  -- Allow audited correction, leave day-status, day_status marks, and Rule 6 closer
  IF v_mode IN ('admin_correction', 'leave', 'day_status', 'shift_end_close') THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'attendance_records' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_in_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_out_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'attendance_visit_segments' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_in_at % not inside W', v_at;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_out_at % not inside W', v_at;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
  p_user_id uuid,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.attendance_records%ROWTYPE;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_end TIMESTAMPTZ;
  v_out TIMESTAMPTZ;
  v_shift_id UUID;
  v_start TIME;
  v_end_t TIME;
  v_shift_tz TEXT;
  n INTEGER := 0;
  v_total INTEGER;
  v_open_visits INTEGER;
  v_closed_this BOOLEAN;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Local to this call: allow writing clock_out_at = shift END after W has ended.
  PERFORM set_config('scorr.attendance_write_mode', 'shift_end_close', true);

  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.user_id = p_user_id
      AND ar.clock_in_at IS NOT NULL
      AND ar.status IS DISTINCT FROM 'absent'
      AND (
        ar.clock_out_at IS NULL
        OR (
          ar.clock_out_at <= ar.clock_in_at + INTERVAL '1 minute'
          AND COALESCE(ar.work_minutes, 0) <= 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.attendance_visit_segments vs
          WHERE vs.user_id = ar.user_id
            AND vs.attendance_date = ar.attendance_date
            AND (
              vs.clock_out_at IS NULL
              OR (
                vs.clock_out_at <= vs.clock_in_at + INTERVAL '1 minute'
                AND COALESCE(vs.work_minutes, 0) <= 1
              )
            )
        )
      )
  LOOP
    SELECT s.shift_id, s.start_time, s.end_time
    INTO v_shift_id, v_start, v_end_t
    FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
    LIMIT 1;

    IF v_shift_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(
      NULLIF(btrim(ws.timezone), ''),
      public.company_timezone(u.company_id),
      public.app_timezone()
    )
    INTO v_shift_tz
    FROM public.users u
    LEFT JOIN public.work_shifts ws ON ws.id = v_shift_id
    WHERE u.id = p_user_id;

    v_end := public.shift_latest_end_timestamptz(
      v_shift_id, r.attendance_date, v_start, v_end_t, r.clock_in_at, v_shift_tz
    );

    -- Stay open until shift end + 1 hour (check-out grace). Then force-close.
    IF v_end IS NULL OR v_now < (v_end + INTERVAL '1 hour') THEN
      CONTINUE;
    END IF;

    -- Recorded clock-out is the shift END, not the grace deadline.
    v_out := GREATEST(r.clock_in_at, v_end);
    v_closed_this := false;

    UPDATE public.attendance_visit_segments SET
      clock_out_at = GREATEST(clock_in_at, v_out),
      clock_out_lat = COALESCE(p_lat, clock_out_lat),
      clock_out_lng = COALESCE(p_lng, clock_out_lng),
      work_minutes = GREATEST(
        0,
        (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
      ),
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Shift ended%' THEN notes
        ELSE trim(both ' |' from COALESCE(notes, '') || ' | Shift ended')
      END
    WHERE user_id = p_user_id
      AND attendance_date = r.attendance_date
      AND (
        clock_out_at IS NULL
        OR (
          clock_out_at <= clock_in_at + INTERVAL '1 minute'
          AND COALESCE(work_minutes, 0) <= 1
        )
      );

    IF FOUND THEN
      v_closed_this := true;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_open_visits
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id
      AND attendance_date = r.attendance_date
      AND clock_out_at IS NULL;

    IF v_open_visits > 0 THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.attendance_visit_segments
      WHERE user_id = p_user_id AND attendance_date = r.attendance_date
    ) THEN
      INSERT INTO public.attendance_visit_segments (
        user_id, attendance_record_id, attendance_date, visit_number,
        clock_in_at, clock_out_at, work_minutes, notes
      ) VALUES (
        p_user_id, r.id, r.attendance_date, 1,
        r.clock_in_at, v_out,
        GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
        'Shift ended'
      );
      v_closed_this := true;
    END IF;

    SELECT MAX(vs.clock_out_at) INTO v_out
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.attendance_date = r.attendance_date
      AND vs.clock_out_at IS NOT NULL
      AND vs.clock_out_at > vs.clock_in_at;

    -- Prefer the computed shift-end out for the day record.
    v_out := GREATEST(r.clock_in_at, v_end);
    v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

    UPDATE public.attendance_records SET
      clock_out_at = v_out,
      clock_out_lat = COALESCE(p_lat, clock_out_lat),
      clock_out_lng = COALESCE(p_lng, clock_out_lng),
      work_minutes = v_total,
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Shift ended%' THEN notes
        ELSE trim(both ' |' from COALESCE(notes, '') || ' | Shift ended')
      END
    WHERE id = r.id
      AND (
        clock_out_at IS NULL
        OR clock_out_at <= clock_in_at + INTERVAL '1 minute'
        OR COALESCE(work_minutes, 0) <= 1
      );

    IF FOUND THEN
      v_closed_this := true;
    END IF;

    IF v_closed_this THEN
      -- Stop history/device presence from keeping "still working".
      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = p_user_id
        AND revoked_at IS NULL
        AND presence_state IS DISTINCT FROM 'left';

      n := n + 1;
    END IF;
  END LOOP;

  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_close_ended_windows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
  v_n INTEGER := 0;
  v_seen UUID[] := ARRAY[]::UUID[];
BEGIN
  -- One closer path only: wait until shift end + 1 hour, record out at shift end.
  FOR r IN
    SELECT DISTINCT ar.user_id
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.status IS DISTINCT FROM 'absent'
      AND (
        ar.clock_out_at IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.attendance_visit_segments vs
          WHERE vs.user_id = ar.user_id
            AND vs.attendance_date = ar.attendance_date
            AND vs.clock_out_at IS NULL
        )
      )
  LOOP
    IF r.user_id = ANY (v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := array_append(v_seen, r.user_id);
    v_n := v_n + public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);
  END LOOP;

  RETURN v_n;
END;
$$;

-- History: "still working" only when a visit is actually open.
-- Stale device presence_state='present' must not hide a closed day.
CREATE OR REPLACE FUNCTION public.attendance_history_still_open(
  p_user_id uuid,
  p_clock_in timestamp with time zone,
  p_any_open boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(p_any_open, false);
$$;

GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(uuid, double precision, double precision)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_ended_windows() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_history_still_open(uuid, timestamptz, boolean)
  TO authenticated, service_role;
