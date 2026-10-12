-- Shift end rules:
-- 1) ±1 hour is relaxation only (early arrival before start; late exit tracking until end+1h).
-- 2) No NEW check-in after the shift end time.
-- 3) At shift end, check out ALL open attendance (do not wait for the post-end grace hour).

CREATE OR REPLACE FUNCTION public.attendance_checkin_allowed(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, p_at) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) THEN
    RETURN false;
  END IF;
  -- Must be inside the ±1h attendance window…
  IF NOT COALESCE(v_win.in_window, false) THEN
    RETURN false;
  END IF;
  -- …but check-in stops at shift end (not end+1h).
  IF v_win.shift_end_utc IS NOT NULL AND p_at > v_win.shift_end_utc THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_checkin_allowed(UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- Manual check-in: reject after shift end
CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_shift_date DATE;
    v_rec public.attendance_records%ROWTYPE;
    v_id UUID;
    v_kept INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    -- Close ended shifts first so UI cannot re-open after end.
    PERFORM public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT public.attendance_checkin_allowed(v_uid, v_now) THEN
        RAISE EXCEPTION 'attendance_outside_window: check-in only from 1 hour before shift start until shift end';
    END IF;

    v_shift_date := COALESCE(p_date, v_win.attendance_date);
    IF v_shift_date IS DISTINCT FROM v_win.attendance_date THEN
        RAISE EXCEPTION 'attendance_outside_window: date does not match current shift window';
    END IF;

    PERFORM public.attendance_realign_shift_records(v_uid);

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

    IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
        PERFORM public.attendance_ensure_open_visit(v_uid, v_rec.id, v_shift_date, v_now, 'Check in');
        RETURN v_rec.id;
    END IF;

    IF FOUND AND v_rec.clock_out_at IS NOT NULL THEN
        PERFORM public.attendance_backfill_closed_visit(
            v_uid, v_rec.id, v_shift_date, v_rec.clock_in_at, v_rec.clock_out_at, v_rec.work_minutes
        );
        v_kept := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);
    ELSE
        v_kept := COALESCE(v_rec.work_minutes, 0);
    END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at, shift_id
    )
    VALUES (
        v_uid, v_shift_date, 'present', 'approved'::public.approval_status, v_uid,
        v_now, NULL, NULLIF(v_kept, 0), 'manual', v_uid, v_now, v_win.shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        approval_status = 'approved'::public.approval_status,
        marked_by = v_uid,
        reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_uid),
        reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        clock_out_at = NULL,
        clock_out_lat = NULL,
        clock_out_lng = NULL,
        work_minutes = COALESCE(
            NULLIF(EXCLUDED.work_minutes, 0),
            NULLIF(public.attendance_records.work_minutes, 0)
        ),
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual'),
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, v_shift_date, v_now, 'Check in');

    UPDATE public.attendance_records
    SET work_minutes = NULLIF(public.attendance_day_total_minutes(v_uid, v_shift_date, v_now), 0)
    WHERE id = v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Force checkout at shift end for everyone (no wait for post-end online grace).
CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
    p_user_id UUID,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_shift_id UUID;
    v_start TIME;
    v_end_t TIME;
    n INTEGER := 0;
    v_total INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR r IN
        SELECT *
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        SELECT s.shift_id, s.start_time, s.end_time
        INTO v_shift_id, v_start, v_end_t
        FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
        LIMIT 1;

        IF v_shift_id IS NULL THEN
            CONTINUE;
        END IF;

        v_end := public.shift_end_timestamptz(r.attendance_date, v_start, v_end_t, r.clock_in_at);

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        -- Always check out at shift end (not end+1h).
        v_out := GREATEST(r.clock_in_at, v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM public.attendance_visit_segments
            WHERE user_id = p_user_id AND attendance_date = r.attendance_date
        ) THEN
            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_out_at, work_minutes, notes
            ) VALUES (
                p_user_id, r.id, r.attendance_date, 1,
                r.clock_in_at, v_out,
                GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
                'Auto clock-out (shift ended)'
            );
        END IF;

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        UPDATE public.attendance_records SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    -- Orphan open visits after shift end
    FOR r IN
        SELECT DISTINCT ON (ar.id) ar.*
        FROM public.attendance_records ar
        JOIN public.attendance_visit_segments vs
          ON vs.user_id = ar.user_id
         AND vs.attendance_date = ar.attendance_date
         AND vs.clock_out_at IS NULL
        WHERE ar.user_id = p_user_id
          AND ar.status IS DISTINCT FROM 'absent'
        ORDER BY ar.id
    LOOP
        SELECT s.shift_id, s.start_time, s.end_time
        INTO v_shift_id, v_start, v_end_t
        FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
        LIMIT 1;

        IF v_shift_id IS NULL THEN
            CONTINUE;
        END IF;

        v_end := public.shift_end_timestamptz(
            r.attendance_date, v_start, v_end_t, COALESCE(r.clock_in_at, r.created_at)
        );
        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        v_out := GREATEST(COALESCE(r.clock_out_at, v_end), v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = GREATEST(clock_in_at, v_out),
            work_minutes = GREATEST(
                0,
                (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
            ),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF r.clock_out_at IS NULL THEN
            v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);
            UPDATE public.attendance_records SET
                clock_out_at = v_out,
                work_minutes = v_total,
                notes = CASE
                    WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                    ELSE trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
                END
            WHERE id = r.id;
        END IF;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

-- Cron: close at shift end (not end+1h window)
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
    -- Prefer direct per-user closer (uses assigned shift end).
    v_n := v_n + public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);

    -- Fallback if still open and window probe shows past shift end.
    SELECT clock_out_at INTO v_close_at FROM public.attendance_records WHERE id = r.id;
    IF v_close_at IS NOT NULL THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF v_win.shift_end_utc IS NULL OR COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date THEN
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

    IF v_win.shift_end_utc IS NOT NULL AND v_now > v_win.shift_end_utc THEN
      v_close_at := GREATEST(r.clock_in_at, v_win.shift_end_utc);

      UPDATE public.attendance_visit_segments SET
        clock_out_at = v_close_at,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_close_at - clock_in_at)) / 60)::INTEGER),
        notes = COALESCE(notes, '') || ' | Auto close at shift end'
      WHERE user_id = r.user_id
        AND attendance_date = r.attendance_date
        AND clock_out_at IS NULL;

      v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_close_at);

      UPDATE public.attendance_records SET
        clock_out_at = v_close_at,
        work_minutes = v_mins,
        notes = COALESCE(notes, '') || ' | Auto close at shift end'
      WHERE id = r.id
        AND clock_out_at IS NULL;

      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

-- Auto-attendance: after shift end, never open a new check-in; force leave/checkout instead.
CREATE OR REPLACE FUNCTION public.attendance_block_checkin_after_shift_end()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_at TIMESTAMPTZ;
  v_ctx TEXT;
BEGIN
  -- Admin/HR corrections may adjust historical times.
  BEGIN
    v_ctx := nullif(current_setting('attendance.write_context', true), '');
  EXCEPTION WHEN OTHERS THEN
    v_ctx := NULL;
  END;
  IF v_ctx IN ('admin_correction', 'system') THEN
    RETURN NEW;
  END IF;

  -- Unchanged open visit (heartbeat / presence refresh) — allow.
  IF TG_OP = 'UPDATE'
     AND OLD.clock_in_at IS NOT NULL
     AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
     AND NEW.clock_out_at IS NULL
     AND OLD.clock_out_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.clock_in_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- New check-in or re-open after a prior checkout.
  IF TG_OP = 'INSERT'
     OR OLD.clock_in_at IS NULL
     OR (OLD.clock_out_at IS NOT NULL AND NEW.clock_out_at IS NULL)
     OR (NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
    v_at := NEW.clock_in_at;
    SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
    IF v_win.shift_end_utc IS NOT NULL AND v_at > v_win.shift_end_utc THEN
      RAISE EXCEPTION 'attendance_outside_window: check-in not allowed after shift end';
    END IF;
    IF NOT public.attendance_checkin_allowed(NEW.user_id, v_at) THEN
      RAISE EXCEPTION 'attendance_outside_window: check-in only from 1 hour before shift start until shift end';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_block_checkin_after_shift_end ON public.attendance_records;
CREATE TRIGGER trg_attendance_block_checkin_after_shift_end
  BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at ON public.attendance_records
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_block_checkin_after_shift_end();

-- Keep cron frequent so everyone is checked out promptly at shift end.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('scorr-close-ended-shifts', 'scorr-attendance-cron');

    PERFORM cron.schedule(
      'scorr-attendance-cron',
      '*/2 * * * *',
      $cron$SELECT public.attendance_cron_tick();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_ended_windows() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
