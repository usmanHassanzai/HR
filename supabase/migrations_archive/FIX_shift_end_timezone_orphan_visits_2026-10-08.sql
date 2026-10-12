-- Production bug: app_timezone() returned UTC, so overnight shift_end was +5h late.
-- Also: day record could be closed while a later visit stayed open → UI "still present"
-- and history hid the real final clock-out (any_open → rout NULL).
--
-- Note: 5-arg shift_end_timestamptz has NO DEFAULT on p_timezone so 4-arg calls
-- are not ambiguous with the 4-arg wrapper overload.

CREATE OR REPLACE FUNCTION public.app_timezone()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT 'Asia/Karachi'::TEXT;
$$;

-- Prefer shift/company TZ when available; fall back to app_timezone.
CREATE OR REPLACE FUNCTION public.shift_end_timestamptz(
    p_attendance_date DATE,
    p_start_time TIME,
    p_end_time TIME,
    p_clock_in TIMESTAMPTZ,
    p_timezone TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_tz TEXT := COALESCE(NULLIF(btrim(p_timezone), ''), public.app_timezone(), 'Asia/Karachi');
    v_end TIMESTAMPTZ;
BEGIN
    v_tz := public.assert_valid_iana_timezone(v_tz);
    -- Interpret wall-clock end on the attendance_date in shift TZ.
    v_end := ((p_attendance_date::timestamp + p_end_time) AT TIME ZONE v_tz);
    IF public.is_shift_overnight(p_start_time, p_end_time) THEN
        IF v_end <= COALESCE(p_clock_in, v_end - INTERVAL '1 day') THEN
            v_end := v_end + INTERVAL '1 day';
        END IF;
    END IF;
    RETURN v_end;
END;
$$;

-- Keep 4-arg signature (existing callers).
CREATE OR REPLACE FUNCTION public.shift_end_timestamptz(
    p_attendance_date DATE,
    p_start_time TIME,
    p_end_time TIME,
    p_clock_in TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.shift_end_timestamptz(p_attendance_date, p_start_time, p_end_time, p_clock_in, NULL::TEXT);
$$;

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
            OR EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id
                AND vs.attendance_date = ar.attendance_date
                AND vs.clock_out_at IS NULL
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

        -- Prefer work_shifts.timezone; fall back to company / app TZ.
        SELECT COALESCE(
            NULLIF(btrim(ws.timezone), ''),
            public.company_timezone(u.company_id),
            public.app_timezone()
        )
        INTO v_shift_tz
        FROM public.users u
        LEFT JOIN public.work_shifts ws ON ws.id = v_shift_id
        WHERE u.id = p_user_id;

        v_end := public.shift_end_timestamptz(
            r.attendance_date, v_start, v_end_t, r.clock_in_at, v_shift_tz
        );

        IF v_now < v_end THEN
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
          AND clock_out_at IS NULL;

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
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

-- History: keep null while any visit is open (mid-shift "still present").
-- Orphans after shift end are closed by close_open_attendance_if_shift_ended
-- (repair pass below + check-in/cron paths) so any_open becomes false.
CREATE OR REPLACE FUNCTION public.attendance_resolve_history_clock_out(
    p_clock_in TIMESTAMPTZ,
    p_clock_out TIMESTAMPTZ,
    p_visit_last_out TIMESTAMPTZ,
    p_work_minutes INTEGER,
    p_any_open BOOLEAN DEFAULT false,
    p_visit_count INTEGER DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
    -- Mid-shift open visit → still present (no day-level clock-out).
    IF COALESCE(p_any_open, false) THEN
        RETURN NULL;
    END IF;

    IF p_clock_out IS NULL
       AND p_clock_in IS NOT NULL
       AND COALESCE(p_visit_count, 0) = 0
       AND p_visit_last_out IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_clock_in IS NOT NULL AND p_clock_out IS NOT NULL AND p_clock_out > p_clock_in THEN
        RETURN p_clock_out;
    END IF;

    IF p_clock_in IS NOT NULL AND p_visit_last_out IS NOT NULL AND p_visit_last_out > p_clock_in THEN
        RETURN p_visit_last_out;
    END IF;
    IF p_clock_in IS NULL AND p_visit_last_out IS NOT NULL THEN
        RETURN p_visit_last_out;
    END IF;

    IF p_clock_in IS NOT NULL AND COALESCE(p_work_minutes, 0) > 0 THEN
        RETURN p_clock_in + (p_work_minutes || ' minutes')::INTERVAL;
    END IF;

    IF p_clock_out IS NOT NULL AND p_clock_in IS NOT NULL AND p_clock_out <= p_clock_in THEN
        RETURN NULL;
    END IF;

    RETURN p_clock_out;
END;
$$;

-- History read path: close ended orphans for the target before resolving outs.
-- Mid-shift open visits remain open (closer no-ops when now < shift_end).
CREATE OR REPLACE FUNCTION public.get_attendance_history(
    p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    p_month integer DEFAULT NULL::integer,
    p_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
    id uuid,
    attendance_date date,
    status attendance_status,
    approval_status approval_status,
    clock_in_at timestamp with time zone,
    clock_out_at timestamp with time zone,
    attendance_source text,
    work_minutes integer,
    shift_name text,
    notes text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_uid UUID := auth.uid();
    v_target UUID;
    v_role public.user_role;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;

    v_target := COALESCE(p_user_id, v_uid);

    IF v_target <> v_uid THEN
        IF v_role = 'manager'::public.user_role THEN
            IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_target AND u.manager_id = v_uid) THEN
                RAISE EXCEPTION 'Not authorized';
            END IF;
        ELSIF v_role NOT IN ('admin'::public.user_role, 'hr'::public.user_role) THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
    END IF;

    PERFORM public.close_open_attendance_if_shift_ended(v_target, NULL, NULL);

    IF p_month IS NULL THEN
        v_start := make_date(p_year, 1, 1);
        v_end := make_date(p_year, 12, 31);
    ELSE
        v_start := make_date(p_year, p_month, 1);
        v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    RETURN QUERY
    SELECT
        q.rid,
        q.rdate,
        q.rstatus,
        q.rapproval,
        q.rin,
        q.rout,
        q.rsource,
        q.rmins,
        q.rshift,
        q.rnotes
    FROM (
        SELECT
            ar.id AS rid,
            ar.attendance_date AS rdate,
            ar.status AS rstatus,
            ar.approval_status AS rapproval,
            COALESCE(ar.clock_in_at, vis.first_in) AS rin,
            public.attendance_resolve_history_clock_out(
                COALESCE(ar.clock_in_at, vis.first_in),
                ar.clock_out_at,
                vis.last_out,
                ar.work_minutes,
                COALESCE(vis.any_open, false),
                COALESCE(vis.visit_count, 0)
            ) AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
                public.attendance_resolve_history_clock_out(
                    COALESCE(ar.clock_in_at, vis.first_in),
                    ar.clock_out_at,
                    vis.last_out,
                    ar.work_minutes,
                    COALESCE(vis.any_open, false),
                    COALESCE(vis.visit_count, 0)
                ),
                ar.work_minutes,
                ar.attendance_source,
                asg.shift_mins
            ) AS rmins,
            COALESCE(ws.name, asg.shift_name) AS rshift,
            ar.notes AS rnotes
        FROM public.attendance_records ar
        LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
        LEFT JOIN LATERAL (
            SELECT
                ws2.name AS shift_name,
                GREATEST(
                    1,
                    (
                        (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                        - (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                        + CASE
                            WHEN COALESCE(ws2.crosses_midnight, false)
                              OR (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                                 <= (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                            THEN 24 * 60
                            ELSE 0
                          END
                    )
                ) AS shift_mins
            FROM public.employee_shift_assignments esa
            JOIN public.work_shifts ws2 ON ws2.id = esa.shift_id
            WHERE esa.user_id = ar.user_id
              AND esa.effective_from <= ar.attendance_date
              AND (esa.effective_to IS NULL OR esa.effective_to >= ar.attendance_date)
            ORDER BY esa.effective_from DESC
            LIMIT 1
        ) asg ON true
        LEFT JOIN LATERAL (
            SELECT
                MIN(vs.clock_in_at) AS first_in,
                MAX(vs.clock_out_at) FILTER (
                    WHERE vs.clock_out_at IS NOT NULL AND vs.clock_out_at > vs.clock_in_at
                ) AS last_out,
                BOOL_OR(vs.clock_out_at IS NULL) AS any_open,
                COUNT(*)::INTEGER AS visit_count
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE ar.user_id = v_target
          AND ar.attendance_date BETWEEN v_start AND v_end
    ) q
    ORDER BY q.rdate DESC, q.rin DESC NULLS LAST;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.app_timezone() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_end_timestamptz(DATE, TIME, TIME, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_end_timestamptz(DATE, TIME, TIME, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_attendance_history(INTEGER, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_resolve_history_clock_out(
    TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, BOOLEAN, INTEGER
) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Close everyone whose shift already ended (repair pass; run after functions exist).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ar.user_id
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.status IS DISTINCT FROM 'absent'
      AND (
        ar.clock_out_at IS NULL
        OR EXISTS (
          SELECT 1 FROM public.attendance_visit_segments vs
          WHERE vs.user_id = ar.user_id
            AND vs.attendance_date = ar.attendance_date
            AND vs.clock_out_at IS NULL
        )
      )
  LOOP
    PERFORM public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);
  END LOOP;
END;
$$;
