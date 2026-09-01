-- Overnight shifts (e.g. 5 PM → 4 AM): attendance_date = shift start day, not calendar midnight.
-- Prevents merging yesterday's tail sessions with today's new shift check-in.

CREATE OR REPLACE FUNCTION public.resolve_shift_attendance_date(
    p_user_id UUID,
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tz TEXT := public.app_timezone();
    v_local_date DATE;
    v_local_time TIME;
    v_shift_start TIME;
    v_shift_end TIME;
    v_shift_days INTEGER[] := ARRAY[1, 2, 3, 4, 5, 6, 7];
    v_overnight BOOLEAN := false;
    v_edge INTEGER;
    v_early TIME;
    v_late TIME;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN (p_at AT TIME ZONE v_tz)::DATE;
    END IF;

    v_local_date := (p_at AT TIME ZONE v_tz)::DATE;
    v_local_time := (p_at AT TIME ZONE v_tz)::TIME;
    v_edge := public.shift_edge_minutes();

    SELECT s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
    INTO v_shift_start, v_shift_end, v_shift_days, v_overnight
    FROM public.get_active_shift_for_user(p_user_id, v_local_date) s
    LIMIT 1;

    IF NOT FOUND OR v_shift_start IS NULL THEN
        SELECT
            COALESCE(c.location_window_start, '17:00'::TIME),
            COALESCE(c.location_window_end, '04:00'::TIME)
        INTO v_shift_start, v_shift_end
        FROM public.users u
        JOIN public.companies c ON c.id = u.company_id
        WHERE u.id = p_user_id;

        v_shift_start := COALESCE(v_shift_start, '17:00'::TIME);
        v_shift_end := COALESCE(v_shift_end, '04:00'::TIME);
        v_shift_days := ARRAY[1, 2, 3, 4, 5, 6, 7];
        v_overnight := v_shift_end <= v_shift_start;
    ELSE
        v_overnight := COALESCE(v_overnight, public.is_shift_overnight(v_shift_start, v_shift_end));
    END IF;

    IF NOT v_overnight THEN
        RETURN v_local_date;
    END IF;

    v_early := (v_shift_start - (v_edge || ' minutes')::INTERVAL)::TIME;
    v_late := (v_shift_end + (v_edge || ' minutes')::INTERVAL)::TIME;

    -- After midnight but still in yesterday's shift (through end + checkout hour)
    IF v_local_time <= v_late THEN
        RETURN v_local_date - 1;
    END IF;

    -- Evening portion of today's shift
    IF v_local_time >= v_early THEN
        RETURN v_local_date;
    END IF;

    RETURN v_local_date;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_shift_attendance_date(UUID, TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_shift_attendance_date()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.resolve_shift_attendance_date(auth.uid(), timezone('utc'::text, now()));
$$;

GRANT EXECUTE ON FUNCTION public.get_my_shift_attendance_date() TO authenticated;

CREATE OR REPLACE FUNCTION public.attendance_realign_shift_records(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_grp RECORD;
    v_rec_id UUID;
    v_total INTEGER;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    UPDATE public.attendance_visit_segments vs
    SET attendance_date = public.resolve_shift_attendance_date(vs.user_id, vs.clock_in_at)
    WHERE vs.user_id = p_user_id
      AND vs.clock_in_at IS NOT NULL
      AND vs.attendance_date IS DISTINCT FROM public.resolve_shift_attendance_date(vs.user_id, vs.clock_in_at);

    FOR v_grp IN
        SELECT
            vs.attendance_date AS adate,
            MIN(vs.clock_in_at) AS first_in,
            MAX(vs.clock_out_at) FILTER (WHERE vs.clock_out_at IS NOT NULL) AS last_out,
            BOOL_OR(vs.clock_out_at IS NULL) AS any_open
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id
        GROUP BY vs.attendance_date
    LOOP
        v_total := public.attendance_day_total_minutes(p_user_id, v_grp.adate, v_now);

        INSERT INTO public.attendance_records (
            user_id, attendance_date, status, approval_status,
            clock_in_at, clock_out_at, work_minutes, attendance_source,
            marked_by, reviewed_by, reviewed_at
        )
        VALUES (
            p_user_id, v_grp.adate, 'present', 'approved',
            v_grp.first_in,
            CASE WHEN v_grp.any_open THEN NULL ELSE v_grp.last_out END,
            NULLIF(v_total, 0),
            'geo',
            p_user_id, p_user_id, v_now
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
            clock_in_at = LEAST(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
            clock_out_at = CASE
                WHEN EXCLUDED.clock_out_at IS NULL THEN NULL
                WHEN public.attendance_records.clock_out_at IS NULL THEN EXCLUDED.clock_out_at
                ELSE GREATEST(public.attendance_records.clock_out_at, EXCLUDED.clock_out_at)
            END,
            work_minutes = EXCLUDED.work_minutes,
            status = 'present',
            approval_status = 'approved'::public.approval_status
        RETURNING id INTO v_rec_id;

        UPDATE public.attendance_visit_segments
        SET attendance_record_id = v_rec_id
        WHERE user_id = p_user_id AND attendance_date = v_grp.adate;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_open_attendance_record(p_user_id UUID)
RETURNS public.attendance_records AS $$
DECLARE
    v_rec public.attendance_records%ROWTYPE;
    v_shift_date DATE;
BEGIN
    v_shift_date := public.resolve_shift_attendance_date(
        p_user_id,
        timezone('utc'::text, now())
    );

    SELECT * INTO v_rec
    FROM public.attendance_records ar
    WHERE ar.user_id = p_user_id
      AND ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_date = v_shift_date
    ORDER BY ar.clock_in_at DESC
    LIMIT 1;

    RETURN v_rec;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_attendance_visits(p_date DATE DEFAULT NULL)
RETURNS TABLE (
    id UUID,
    visit_number INTEGER,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    work_minutes INTEGER,
    site_name TEXT,
    notes TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_shift_date DATE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    v_shift_date := COALESCE(p_date, public.resolve_shift_attendance_date(v_uid, v_now));

    RETURN QUERY
    SELECT
        vs.id,
        ROW_NUMBER() OVER (ORDER BY vs.clock_in_at ASC)::INTEGER AS visit_number,
        vs.clock_in_at,
        vs.clock_out_at,
        CASE
            WHEN vs.clock_out_at IS NOT NULL THEN COALESCE(
                vs.work_minutes,
                GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::INTEGER)
            )
            ELSE GREATEST(0, (EXTRACT(EPOCH FROM (v_now - vs.clock_in_at)) / 60)::INTEGER)
        END,
        vs.site_name,
        vs.notes
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_uid
      AND public.resolve_shift_attendance_date(v_uid, vs.clock_in_at) = v_shift_date
    ORDER BY vs.clock_in_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_visits(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_shift_date DATE := COALESCE(p_date, public.resolve_shift_attendance_date(v_uid, v_now));
    v_rec public.attendance_records%ROWTYPE;
    v_id UUID;
    v_kept INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_shift_date > (timezone(public.app_timezone(), v_now))::DATE + 1 THEN
        RAISE EXCEPTION 'Cannot check in for a future date';
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
        clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at
    )
    VALUES (
        v_uid, v_shift_date, 'present', 'approved'::public.approval_status, v_uid,
        v_now, NULL, NULLIF(v_kept, 0), 'manual', v_uid, v_now
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
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual')
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, v_shift_date, v_now, 'Check in');

    UPDATE public.attendance_records
    SET work_minutes = NULLIF(public.attendance_day_total_minutes(v_uid, v_shift_date, v_now), 0)
    WHERE id = v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_shift_date DATE := COALESCE(p_date, public.resolve_shift_attendance_date(v_uid, v_now));
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
    v_n INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

    IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
        RAISE EXCEPTION 'Check in first, then you can check out';
    END IF;
    IF v_rec.status = 'absent' THEN
        RAISE EXCEPTION 'Cannot check out on an absent day';
    END IF;
    IF v_rec.clock_out_at IS NOT NULL THEN
        RAISE EXCEPTION 'Already checked out';
    END IF;

    UPDATE public.attendance_visit_segments
    SET clock_out_at = v_now,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
    WHERE user_id = v_uid
      AND attendance_date = v_shift_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date
    ) THEN
        SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date;
        INSERT INTO public.attendance_visit_segments (
            user_id, attendance_record_id, attendance_date, visit_number,
            clock_in_at, clock_out_at, work_minutes, notes
        ) VALUES (
            v_uid, v_rec.id, v_shift_date, COALESCE(v_n, 1),
            v_rec.clock_in_at, v_now,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
            'Visit 1 · saved session'
        );
    END IF;

    v_total := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = v_total
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION DEFAULT NULL,
    p_intent TEXT DEFAULT 'auto'
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_role public.user_role;
    v_inside BOOLEAN := false;
    v_rec public.attendance_records%ROWTYPE;
    v_has_rec BOOLEAN := false;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_action TEXT := 'none';
    v_site_name TEXT;
    v_distance DOUBLE PRECISION;
    v_radius INTEGER;
    v_effective_radius DOUBLE PRECISION;
    v_work_site_id UUID;
    v_demo BOOLEAN;
    v_site_lat DOUBLE PRECISION;
    v_site_lng DOUBLE PRECISION;
    v_office_id UUID;
    v_office_dist DOUBLE PRECISION;
    v_shift_id UUID;
    v_shift_name TEXT;
    v_shift_start TIME;
    v_shift_end TIME;
    v_shift_grace INTEGER := 0;
    v_shift_days INTEGER[] := ARRAY[1, 2, 3, 4, 5, 6, 7];
    v_shift_overnight BOOLEAN := false;
    v_has_shift BOOLEAN := false;
    v_in_window BOOLEAN := false;
    v_attendance_date DATE;
    v_visit public.attendance_visit_segments%ROWTYPE;
    v_has_visit BOOLEAN := false;
    v_seg_mins INTEGER;
    v_total_mins INTEGER;
    v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
    v_win RECORD;
    v_last_shift DATE;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    UPDATE public.users SET last_seen_at = v_now WHERE id = v_user_id;

    IF v_intent IS DISTINCT FROM 'clock_in' AND v_intent IS DISTINCT FROM 'clock_out' THEN
        RETURN jsonb_build_object(
            'action', 'skipped',
            'reason', 'Location is only captured at clock-in and clock-out'
        );
    END IF;

    v_demo := public.is_demo_user(v_user_id);
    v_attendance_date := public.resolve_shift_attendance_date(v_user_id, v_now);

    SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.grace_minutes, s.days_of_week, s.crosses_midnight
    INTO v_shift_id, v_shift_name, v_shift_start, v_shift_end, v_shift_grace, v_shift_days, v_shift_overnight
    FROM public.get_active_shift_for_user(v_user_id, v_attendance_date) s
    LIMIT 1;
    v_has_shift := FOUND AND v_shift_id IS NOT NULL;

    IF v_has_shift THEN
        v_in_window := public.is_within_shift_window(
            v_shift_start, v_shift_end, COALESCE(v_shift_grace, 0), COALESCE(v_shift_days, ARRAY[1,2,3,4,5,6,7]), v_now
        );
    ELSE
        SELECT * INTO v_win FROM public.get_company_location_window() LIMIT 1;
        v_shift_start := COALESCE(v_win.start_time, '17:30'::TIME);
        v_shift_end := COALESCE(v_win.end_time, '04:00'::TIME);
        v_shift_name := COALESCE(v_shift_name, 'Company hours');
        v_shift_grace := 0;
        v_shift_days := ARRAY[1, 2, 3, 4, 5, 6, 7];
        v_shift_overnight := v_shift_end <= v_shift_start;
        v_in_window := public.is_within_shift_window(
            v_shift_start, v_shift_end, 0, ARRAY[1, 2, 3, 4, 5, 6, 7], v_now
        );
    END IF;

    IF NOT v_in_window AND v_intent = 'clock_in' THEN
        RETURN jsonb_build_object(
            'action', 'shift_not_started',
            'reason', 'You can clock in from 1 hour before your shift starts',
            'shift_name', v_shift_name,
            'shift_start', v_shift_start,
            'shift_end', v_shift_end,
            'crosses_midnight', v_shift_overnight
        );
    END IF;

    SELECT
        ws.site_id, ws.site_name, ws.latitude, ws.longitude, ws.radius_meters
    INTO v_work_site_id, v_site_name, v_site_lat, v_site_lng, v_radius
    FROM public.get_work_site_for_user(v_user_id) ws
    LIMIT 1;

    IF FOUND AND v_work_site_id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site_lat, v_site_lng);
    ELSE
        SELECT w.office_id, w.office_name, w.distance_meters
        INTO v_office_id, v_site_name, v_office_dist
        FROM public.is_within_office(p_latitude, p_longitude) w
        LIMIT 1;

        IF FOUND AND v_office_id IS NOT NULL THEN
            SELECT o.radius_meters INTO v_radius FROM public.office_locations o WHERE o.id = v_office_id;
            v_distance := v_office_dist;
        END IF;
    END IF;

    v_radius := GREATEST(COALESCE(v_radius, 150), 150);
    v_effective_radius := v_radius
      + LEAST(120::DOUBLE PRECISION, GREATEST(40::DOUBLE PRECISION, COALESCE(p_accuracy, 40::DOUBLE PRECISION)));
    v_inside := (v_distance IS NOT NULL AND v_distance <= v_effective_radius);

    v_rec := public.get_open_attendance_record(v_user_id);
    v_has_rec := v_rec.id IS NOT NULL;

    IF NOT v_has_rec THEN
        SELECT * INTO v_rec
        FROM public.attendance_records ar
        WHERE ar.user_id = v_user_id
          AND ar.attendance_date = v_attendance_date
        LIMIT 1;
        v_has_rec := FOUND;

        IF v_has_rec AND v_rec.clock_out_at IS NOT NULL THEN
            v_last_shift := public.resolve_shift_attendance_date(
                v_user_id,
                COALESCE(v_rec.clock_out_at, v_rec.clock_in_at)
            );
            IF v_last_shift IS DISTINCT FROM v_attendance_date THEN
                PERFORM public.attendance_realign_shift_records(v_user_id);
                v_has_rec := false;
                v_rec := NULL;
                SELECT * INTO v_rec
                FROM public.attendance_records ar
                WHERE ar.user_id = v_user_id
                  AND ar.attendance_date = v_attendance_date
                LIMIT 1;
                v_has_rec := FOUND;
            END IF;
        END IF;
    END IF;

    IF v_has_rec THEN
        v_attendance_date := v_rec.attendance_date;
    END IF;

    SELECT * INTO v_visit
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_user_id
      AND public.resolve_shift_attendance_date(v_user_id, vs.clock_in_at) = v_attendance_date
      AND vs.clock_out_at IS NULL
    ORDER BY vs.clock_in_at DESC
    LIMIT 1;
    v_has_visit := FOUND;

    IF v_intent = 'clock_in' THEN
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'already_clocked_in';
        ELSIF NOT v_inside THEN
            v_action := 'outside_office';
        ELSE
            INSERT INTO public.employee_location_pings (
                user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
            ) VALUES (
                v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
            );

            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'geo', v_shift_id,
                'GPS clock-in at ' || COALESCE(v_site_name, 'work site')
                    || CASE WHEN v_shift_name IS NOT NULL THEN ' · ' || v_shift_name ELSE '' END,
                v_user_id, v_now
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_in_lat = COALESCE(public.attendance_records.clock_in_lat, EXCLUDED.clock_in_lat),
                clock_in_lng = COALESCE(public.attendance_records.clock_in_lng, EXCLUDED.clock_in_lng),
                clock_out_at = NULL,
                clock_out_lat = NULL,
                clock_out_lng = NULL,
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
                status = 'present',
                approval_status = 'approved'::public.approval_status,
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'geo' ELSE public.attendance_records.attendance_source END,
                notes = CASE
                    WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.notes
                    ELSE public.attendance_records.notes
                END,
                reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_user_id),
                reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now)
            RETURNING * INTO v_rec;
            v_has_rec := true;

            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now,
                'GPS entry ' || COALESCE(v_site_name, 'work site')
            );
            UPDATE public.attendance_visit_segments SET
                clock_in_lat = COALESCE(clock_in_lat, p_latitude),
                clock_in_lng = COALESCE(clock_in_lng, p_longitude),
                site_name = COALESCE(site_name, v_site_name),
                work_site_id = COALESCE(work_site_id, v_work_site_id)
            WHERE user_id = v_user_id
              AND attendance_date = v_attendance_date
              AND clock_out_at IS NULL;
            v_action := 'clock_in';
        END IF;

    ELSIF v_intent = 'clock_out' THEN
        IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            v_action := 'outside_office';
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            INSERT INTO public.employee_location_pings (
                user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
            ) VALUES (
                v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
            );

            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins,
                    notes = COALESCE(notes, '') || ' | GPS clock-out'
                WHERE id = v_visit.id;
            ELSE
                PERFORM public.attendance_backfill_closed_visit(
                    v_user_id, v_rec.id, v_attendance_date, v_rec.clock_in_at, v_now, NULL
                );
            END IF;

            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);

            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins,
                notes = COALESCE(notes, '') || ' | GPS clock-out'
            WHERE id = v_rec.id
            RETURNING * INTO v_rec;
            v_action := 'clock_out';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'action', v_action,
        'inside_office', v_inside,
        'office_name', v_site_name,
        'distance_meters', v_distance,
        'radius_meters', v_radius,
        'effective_radius_meters', ROUND(v_effective_radius)::INTEGER,
        'accuracy_meters', p_accuracy,
        'clock_in_at', CASE WHEN v_has_rec THEN v_rec.clock_in_at ELSE NULL END,
        'clock_out_at', CASE WHEN v_has_rec THEN v_rec.clock_out_at ELSE NULL END,
        'record_id', CASE WHEN v_has_rec THEN v_rec.id ELSE NULL END,
        'shift_name', v_shift_name,
        'shift_start', v_shift_start,
        'shift_end', v_shift_end,
        'crosses_midnight', v_shift_overnight,
        'work_minutes', CASE WHEN v_has_rec THEN v_rec.work_minutes ELSE NULL END,
        'attendance_date', v_attendance_date
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;

-- Backfill existing visit rows grouped under the wrong calendar date
DO $$
DECLARE
    v_uid UUID;
BEGIN
    FOR v_uid IN SELECT DISTINCT user_id FROM public.attendance_visit_segments
    LOOP
        PERFORM public.attendance_realign_shift_records(v_uid);
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
