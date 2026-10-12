-- Always 1 hour before shift start for check-in, and 1 hour after end for manual checkout.
-- If Scorr is not in use (no recent presence), auto clock-out at shift end.
-- If the person is logged in, wait 1 hour after shift end, then auto clock-out.
-- Manual clock-in early / clock-out in that extra hour is counted in work minutes.

CREATE OR REPLACE FUNCTION public.shift_edge_minutes()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 60;
$$;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.touch_my_presence()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    UPDATE public.users
    SET last_seen_at = v_now
    WHERE id = v_uid;
    RETURN v_now;
END;
$$;

GRANT EXECUTE ON FUNCTION public.touch_my_presence() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_within_shift_window(
    p_start_time TIME,
    p_end_time TIME,
    p_grace_minutes INTEGER,
    p_days_of_week INTEGER[],
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
) RETURNS BOOLEAN AS $$
DECLARE
    v_tz TEXT := public.app_timezone();
    v_local TIME;
    v_dow INTEGER;
    v_prev_dow INTEGER;
    v_edge INTEGER := public.shift_edge_minutes();
    v_early TIME;
BEGIN
    v_local := (p_at AT TIME ZONE v_tz)::TIME;
    v_dow := EXTRACT(ISODOW FROM (p_at AT TIME ZONE v_tz)::DATE)::INTEGER;
    v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;
    v_early := (p_start_time - (v_edge || ' minutes')::INTERVAL)::TIME;

    IF NOT public.is_shift_overnight(p_start_time, p_end_time) THEN
        IF NOT (v_dow = ANY(p_days_of_week)) THEN RETURN FALSE; END IF;
        IF v_early <= p_start_time THEN
            RETURN v_local >= v_early AND v_local <= p_end_time;
        END IF;
        RETURN v_local >= v_early OR v_local <= p_end_time;
    END IF;

    IF v_local >= v_early THEN
        RETURN v_dow = ANY(p_days_of_week);
    ELSIF v_local <= p_end_time THEN
        RETURN v_prev_dow = ANY(p_days_of_week);
    END IF;
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.is_within_shift_exit_window(
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[],
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
) RETURNS BOOLEAN AS $$
DECLARE
    v_tz TEXT := public.app_timezone();
    v_local TIME;
    v_dow INTEGER;
    v_prev_dow INTEGER;
    v_edge INTEGER := public.shift_edge_minutes();
    v_early TIME;
    v_late TIME;
BEGIN
    v_local := (p_at AT TIME ZONE v_tz)::TIME;
    v_dow := EXTRACT(ISODOW FROM (p_at AT TIME ZONE v_tz)::DATE)::INTEGER;
    v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;
    v_early := (p_start_time - (v_edge || ' minutes')::INTERVAL)::TIME;
    v_late := (p_end_time + (v_edge || ' minutes')::INTERVAL)::TIME;

    IF NOT public.is_shift_overnight(p_start_time, p_end_time) AND v_late >= p_end_time THEN
        IF NOT (v_dow = ANY(p_days_of_week)) THEN RETURN FALSE; END IF;
        IF v_early <= p_start_time THEN
            RETURN v_local >= v_early AND v_local <= v_late;
        END IF;
        RETURN v_local >= v_early OR v_local <= v_late;
    END IF;

    -- Overnight shift, or daytime end that wraps past midnight after +1h.
    IF v_local >= v_early THEN
        RETURN v_dow = ANY(p_days_of_week);
    ELSIF v_local <= v_late THEN
        RETURN v_prev_dow = ANY(p_days_of_week);
    END IF;
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.is_within_shift_exit_window(TIME, TIME, INTEGER[], TIMESTAMPTZ) TO authenticated;

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
    v_grace_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_shift_id UUID;
    v_start TIME;
    v_end_t TIME;
    v_seen TIMESTAMPTZ;
    v_online BOOLEAN;
    n INTEGER := 0;
    v_total INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT u.last_seen_at INTO v_seen FROM public.users u WHERE u.id = p_user_id;
    v_online := v_seen IS NOT NULL AND v_seen > v_now - INTERVAL '8 minutes';

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

        v_end := ((r.attendance_date::timestamp + v_end_t) AT TIME ZONE public.app_timezone());
        IF public.is_shift_overnight(v_start, v_end_t) AND v_end <= r.clock_in_at THEN
            v_end := v_end + INTERVAL '1 day';
        END IF;
        v_grace_end := v_end + (public.shift_edge_minutes() || ' minutes')::INTERVAL;

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        -- Logged in: wait the extra hour so they can still check out (that time counts).
        IF v_online AND v_now < v_grace_end THEN
            CONTINUE;
        END IF;

        IF v_seen IS NULL OR v_seen < v_end THEN
            v_out := v_end;
        ELSIF v_now >= v_grace_end THEN
            v_out := v_grace_end;
        ELSE
            v_out := LEAST(v_grace_end, GREATEST(v_end, v_seen));
        END IF;
        v_out := GREATEST(r.clock_in_at, v_out);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE COALESCE(notes, '') || ' | Closed (shift ended)'
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
                ELSE COALESCE(notes, '') || ' | Auto clock-out (shift ended)'
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public.touch_my_presence();
    RETURN public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_all_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
    n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT DISTINCT ar.user_id
        FROM public.attendance_records ar
        WHERE ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        n := n + public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);
    END LOOP;
    RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_all_ended_shift_attendance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_all_ended_shift_attendance() TO service_role;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('scorr-close-ended-shifts');
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
        PERFORM cron.schedule(
            'scorr-close-ended-shifts',
            '* * * * *',
            'SELECT public.close_all_ended_shift_attendance()'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$outer$;

UPDATE public.work_shifts
SET grace_minutes = 60
WHERE grace_minutes IS DISTINCT FROM 60;

NOTIFY pgrst, 'reload schema';
