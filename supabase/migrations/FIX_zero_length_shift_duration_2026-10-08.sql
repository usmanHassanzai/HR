-- A checkout stamped at the same minute as check-in (work_minutes 0) was treated as
-- closed, so later shift-end repair skipped it. History then hid that clock-out and
-- the screen kept counting "still working" (26h, 50h) past the real shift end.
-- Re-open those zero-length rows once the shift has ended and close them at the
-- later of the phone clock and the laptop clock.

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
    v_shift_tz TEXT;
    n INTEGER := 0;
    v_total INTEGER;
    v_open_visits INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

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
              SELECT 1 FROM public.attendance_visit_segments vs
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

        IF v_end IS NULL OR v_now < v_end THEN
            CONTINUE;
        END IF;

        v_out := GREATEST(r.clock_in_at, v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = GREATEST(clock_in_at, v_out),
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
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
          AND (
            clock_out_at IS NULL
            OR (
              clock_out_at <= clock_in_at + INTERVAL '1 minute'
              AND COALESCE(work_minutes, 0) <= 1
            )
          );

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
                'Auto clock-out (shift ended)'
            );
        END IF;

        SELECT MAX(vs.clock_out_at) INTO v_out
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = r.attendance_date
          AND vs.clock_out_at IS NOT NULL
          AND vs.clock_out_at > vs.clock_in_at;

        v_out := COALESCE(v_out, GREATEST(r.clock_in_at, v_end));
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
        WHERE id = r.id
          AND (
            clock_out_at IS NULL
            OR clock_out_at <= clock_in_at + INTERVAL '1 minute'
            OR COALESCE(work_minutes, 0) <= 1
          );

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;

-- Repair days already stuck with a zero-length checkout.
DO $$
DECLARE
    v_user UUID;
    v_n INTEGER;
BEGIN
    FOR v_user IN
        SELECT DISTINCT ar.user_id
        FROM public.attendance_records ar
        WHERE ar.clock_in_at IS NOT NULL
          AND (
            ar.clock_out_at IS NULL
            OR (
              ar.clock_out_at <= ar.clock_in_at + INTERVAL '1 minute'
              AND COALESCE(ar.work_minutes, 0) <= 1
            )
          )
    LOOP
        v_n := public.close_open_attendance_if_shift_ended(v_user, NULL, NULL);
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
