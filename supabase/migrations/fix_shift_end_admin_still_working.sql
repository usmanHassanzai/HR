-- After shift end, admin/live views must not keep showing "still working".
-- Fixes: orphan open visits, records left open when visits already closed,
-- overnight live tracking, and admin ability to reconcile ended shifts.

CREATE OR REPLACE FUNCTION public.shift_end_timestamptz(
    p_attendance_date DATE,
    p_start_time TIME,
    p_end_time TIME,
    p_clock_in TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_end TIMESTAMPTZ;
BEGIN
    v_end := ((p_attendance_date::timestamp + p_end_time) AT TIME ZONE public.app_timezone());
    IF public.is_shift_overnight(p_start_time, p_end_time) THEN
        -- Night shift dated on the start day ends after midnight.
        IF v_end <= COALESCE(p_clock_in, v_end - INTERVAL '1 day') THEN
            v_end := v_end + INTERVAL '1 day';
        END IF;
    END IF;
    RETURN v_end;
END;
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
    v_grace_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_shift_id UUID;
    v_start TIME;
    v_end_t TIME;
    v_seen TIMESTAMPTZ;
    v_online BOOLEAN;
    n INTEGER := 0;
    v_total INTEGER;
    v_last_out TIMESTAMPTZ;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT u.last_seen_at INTO v_seen FROM public.users u WHERE u.id = p_user_id;
    v_online := v_seen IS NOT NULL AND v_seen > v_now - INTERVAL '8 minutes';

    -- 1) Close open day records whose shift has ended.
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
        v_grace_end := v_end + (public.shift_edge_minutes() || ' minutes')::INTERVAL;

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        -- Still using Scorr during the post-shift grace window: wait.
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

    -- 2) Orphan open visits after shift end (record may already show clock_out).
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

        v_out := COALESCE(r.clock_out_at, v_end);
        IF v_out < v_end THEN
            v_out := v_end;
        END IF;

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

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        SELECT MAX(vs.clock_out_at)
        INTO v_last_out
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = r.attendance_date;

        UPDATE public.attendance_records SET
            clock_out_at = COALESCE(clock_out_at, v_last_out, v_out),
            work_minutes = v_total
        WHERE id = r.id
          AND (
              clock_out_at IS NULL
              OR work_minutes IS DISTINCT FROM v_total
          );

        n := n + 1;
    END LOOP;

    -- 3) Visits all closed but day record still open → sync clock_out from visits.
    FOR r IN
        SELECT ar.*
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
          AND EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id AND vs.attendance_date = ar.attendance_date
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id
                AND vs.attendance_date = ar.attendance_date
                AND vs.clock_out_at IS NULL
          )
    LOOP
        SELECT MAX(vs.clock_out_at), public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_now)
        INTO v_last_out, v_total
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = r.attendance_date;

        IF v_last_out IS NULL THEN
            CONTINUE;
        END IF;

        UPDATE public.attendance_records SET
            clock_out_at = v_last_out,
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Synced clock-out from visits')
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
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
        SELECT DISTINCT x.user_id
        FROM (
            SELECT ar.user_id
            FROM public.attendance_records ar
            WHERE ar.clock_in_at IS NOT NULL
              AND ar.clock_out_at IS NULL
              AND ar.status IS DISTINCT FROM 'absent'
            UNION
            SELECT vs.user_id
            FROM public.attendance_visit_segments vs
            WHERE vs.clock_out_at IS NULL
        ) x
    LOOP
        n := n + public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);
    END LOOP;
    RETURN n;
END;
$$;

-- Managers/admins can reconcile ended shifts when opening attendance dashboards.
CREATE OR REPLACE FUNCTION public.reconcile_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF NOT (
        public.is_admin(v_uid)
        OR v_role IN ('manager'::public.user_role, 'hr'::public.user_role)
    ) THEN
        -- Employees may only close their own.
        RETURN public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);
    END IF;

    RETURN public.close_all_ended_shift_attendance();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_team_location_tracking()
RETURNS TABLE(
    user_id UUID,
    full_name TEXT,
    email TEXT,
    role public.user_role,
    manager_id UUID,
    manager_name TEXT,
    site_id UUID,
    site_name TEXT,
    site_address TEXT,
    site_latitude DOUBLE PRECISION,
    site_longitude DOUBLE PRECISION,
    site_radius_meters INTEGER,
    tracking_enabled BOOLEAN,
    last_ping_at TIMESTAMPTZ,
    last_latitude DOUBLE PRECISION,
    last_longitude DOUBLE PRECISION,
    inside_site BOOLEAN,
    distance_meters DOUBLE PRECISION,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_status public.attendance_status,
    attendance_source TEXT
) AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_caller_role public.user_role;
    v_caller_dept UUID;
    v_company UUID;
    v_today DATE := (timezone('Asia/Karachi', now()))::date;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT u.role, u.department_id INTO v_caller_role, v_caller_dept
    FROM public.users u
    WHERE u.id = v_caller;

    IF NOT public.is_admin(v_caller) AND v_caller_role <> 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Only managers and admins can view live tracking';
    END IF;

    IF NOT public.is_demo_user(v_caller) THEN
        v_company := public.current_company_id();
    END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        COALESCE(u.manager_id, dept_mgr.id, CASE WHEN u.role = 'manager'::public.user_role THEN u.id END),
        COALESCE(mgr.full_name, dept_mgr.full_name),
        COALESCE(own_site.id, dept_site.id, co_site.id, office.id),
        COALESCE(own_site.name, dept_site.name, co_site.name, office.name),
        COALESCE(own_site.address, dept_site.address, co_site.address, office.address),
        COALESCE(own_site.latitude, dept_site.latitude, co_site.latitude, office.latitude),
        COALESCE(own_site.longitude, dept_site.longitude, co_site.longitude, office.longitude),
        COALESCE(own_site.radius_meters, dept_site.radius_meters, co_site.radius_meters, office.radius_meters),
        COALESCE(own_site.tracking_enabled, dept_site.tracking_enabled, co_site.tracking_enabled, office.active, false),
        COALESCE(lp.recorded_at, ar.clock_in_at, ar.clock_out_at),
        lp.latitude,
        lp.longitude,
        COALESCE(lp.inside_site, false),
        lp.distance_meters,
        ar.clock_in_at,
        ar.clock_out_at,
        ar.status,
        ar.attendance_source
    FROM public.users u
    LEFT JOIN public.users mgr ON mgr.id = CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END
    LEFT JOIN LATERAL (
        SELECT m.id, m.full_name
        FROM public.users m
        WHERE m.role = 'manager'::public.user_role
          AND m.is_demo = u.is_demo
          AND u.department_id IS NOT NULL
          AND m.department_id = u.department_id
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY CASE WHEN m.id = u.manager_id THEN 0 ELSE 1 END, m.full_name
        LIMIT 1
    ) dept_mgr ON true
    LEFT JOIN public.manager_work_sites own_site ON own_site.manager_id = CASE
        WHEN u.role = 'manager'::public.user_role THEN u.id
        ELSE u.manager_id
    END AND own_site.tracking_enabled = true
    LEFT JOIN LATERAL (
        SELECT mws.*
        FROM public.manager_work_sites mws
        JOIN public.users m ON m.id = mws.manager_id
        WHERE mws.tracking_enabled = true
          AND m.role = 'manager'::public.user_role
          AND m.is_demo = u.is_demo
          AND u.department_id IS NOT NULL
          AND m.department_id = u.department_id
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY mws.updated_at DESC
        LIMIT 1
    ) dept_site ON true
    LEFT JOIN LATERAL (
        SELECT mws.*
        FROM public.manager_work_sites mws
        JOIN public.users m ON m.id = mws.manager_id
        WHERE mws.tracking_enabled = true
          AND m.is_demo = u.is_demo
          AND (u.company_id IS NULL OR m.company_id IS NOT DISTINCT FROM u.company_id)
        ORDER BY mws.updated_at DESC
        LIMIT 1
    ) co_site ON true
    LEFT JOIN LATERAL (
        SELECT o.id, o.name, o.address, o.latitude, o.longitude, o.radius_meters, o.active
        FROM public.office_locations o
        WHERE o.active = true AND o.is_demo = u.is_demo
        ORDER BY o.name
        LIMIT 1
    ) office ON true
    LEFT JOIN LATERAL (
        SELECT p.*
        FROM public.employee_location_pings p
        WHERE p.user_id = u.id
        ORDER BY p.recorded_at DESC
        LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
        -- Prefer currently open attendance (including overnight from yesterday).
        SELECT a.clock_in_at, a.clock_out_at, a.status, a.attendance_source
        FROM public.attendance_records a
        WHERE a.user_id = u.id
          AND a.attendance_date BETWEEN (v_today - 1) AND v_today
          AND a.clock_in_at IS NOT NULL
        ORDER BY
            CASE WHEN a.clock_out_at IS NULL THEN 0 ELSE 1 END,
            a.attendance_date DESC,
            a.clock_in_at DESC NULLS LAST
        LIMIT 1
    ) ar ON true
    WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
      AND (
          public.is_admin(v_caller)
          OR (
              v_caller_role = 'manager'::public.user_role
              AND v_caller_dept IS NOT NULL
              AND u.department_id = v_caller_dept
          )
      )
      AND (
          (public.is_demo_user(v_caller) AND u.is_demo = true)
          OR (
              NOT public.is_demo_user(v_caller)
              AND u.is_demo = false
              AND (v_company IS NULL OR u.company_id = v_company)
          )
      )
    ORDER BY u.role DESC, u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_all_ended_shift_attendance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_all_ended_shift_attendance() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_team_location_tracking() TO authenticated;

-- One-shot repair for currently stuck open days/visits.
SELECT public.close_all_ended_shift_attendance();

NOTIFY pgrst, 'reload schema';
