-- On dashboard open: clock in when inside the office radius. Do not wait for shift start; still skip after the shift has ended.

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION DEFAULT NULL
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
    v_shift_grace INTEGER;
    v_shift_days INTEGER[];
    v_shift_overnight BOOLEAN := false;
    v_has_shift BOOLEAN := false;
    v_shift_active BOOLEAN := true;
    v_shift_ended BOOLEAN := false;
    v_attendance_date DATE := (timezone(public.app_timezone(), v_now))::date;
    v_visit public.attendance_visit_segments%ROWTYPE;
    v_has_visit BOOLEAN := false;
    v_visit_n INTEGER := 1;
    v_seg_mins INTEGER;
    v_total_mins INTEGER;
    v_prev_inside BOOLEAN;
    v_left_site BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    SELECT
        s.shift_id, s.shift_name, s.start_time, s.end_time, s.grace_minutes, s.days_of_week, s.crosses_midnight
    INTO v_shift_id, v_shift_name, v_shift_start, v_shift_end, v_shift_grace, v_shift_days, v_shift_overnight
    FROM public.get_active_shift_for_user(v_user_id, v_attendance_date) s
    LIMIT 1;
    v_has_shift := FOUND AND v_shift_id IS NOT NULL;

    IF v_has_shift THEN
        v_shift_active := public.is_within_shift_window(v_shift_start, v_shift_end, v_shift_grace, v_shift_days, v_now);
        v_shift_ended := public.has_shift_ended(v_shift_start, v_shift_end, v_shift_days, v_now);
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

    -- GPS buffer: radius + accuracy (min 40m, max +120m); floor radius at 150 for geo check
    v_radius := GREATEST(COALESCE(v_radius, 150), 150);
    v_effective_radius := v_radius
      + LEAST(120::DOUBLE PRECISION, GREATEST(40::DOUBLE PRECISION, COALESCE(p_accuracy, 40::DOUBLE PRECISION)));
    v_inside := (v_distance IS NOT NULL AND v_distance <= v_effective_radius);

    SELECT p.inside_site INTO v_prev_inside
    FROM public.employee_location_pings p
    WHERE p.user_id = v_user_id
    ORDER BY p.recorded_at DESC
    LIMIT 1;

    INSERT INTO public.employee_location_pings (
        user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
        v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );

    v_left_site := public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);

    v_rec := public.get_open_attendance_record(v_user_id);
    v_has_rec := v_rec.id IS NOT NULL;
    IF NOT v_has_rec THEN
        SELECT * INTO v_rec
        FROM public.attendance_records ar
        WHERE ar.user_id = v_user_id
          AND ar.attendance_date = v_attendance_date
        LIMIT 1;
        v_has_rec := FOUND;
    END IF;
    IF v_has_rec THEN
        v_attendance_date := v_rec.attendance_date;
    END IF;

    SELECT * INTO v_visit
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_user_id
      AND vs.attendance_date = v_attendance_date
      AND vs.clock_out_at IS NULL
    ORDER BY vs.clock_in_at DESC
    LIMIT 1;
    v_has_visit := FOUND;

    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL
       AND v_has_shift AND v_shift_ended AND v_left_site THEN
        IF v_has_visit THEN
            v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
            UPDATE public.attendance_visit_segments SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_seg_mins,
                notes = COALESCE(notes, '') || ' | Closed (shift ended)'
            WHERE id = v_visit.id;
        END IF;

        SELECT COALESCE(SUM(work_minutes), 0)::INTEGER INTO v_total_mins
        FROM public.attendance_visit_segments
        WHERE user_id = v_user_id AND attendance_date = v_attendance_date;

        UPDATE public.attendance_records SET
            clock_out_at = v_now,
            clock_out_lat = p_latitude,
            clock_out_lng = p_longitude,
            work_minutes = GREATEST(v_total_mins, GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at))::INTEGER / 60)),
            notes = COALESCE(notes, '') || ' | Auto clock-out (shift ended)'
        WHERE id = v_rec.id
        RETURNING * INTO v_rec;
        v_action := 'clock_out_shift_end';

    ELSIF v_inside THEN
        IF v_has_shift AND v_shift_ended AND NOT v_has_rec THEN
            v_action := 'shift_not_started';
        ELSIF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'geo', v_shift_id,
                'Auto clock-in at ' || COALESCE(v_site_name, 'work site')
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
                work_minutes = NULL,
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

            SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_visit_n
            FROM public.attendance_visit_segments
            WHERE user_id = v_user_id AND attendance_date = v_attendance_date;

            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_in_lat, clock_in_lng, site_name, work_site_id, notes
            ) VALUES (
                v_user_id, v_rec.id, v_attendance_date, v_visit_n,
                v_now, p_latitude, p_longitude, v_site_name, v_work_site_id,
                'Visit ' || v_visit_n || ' · entered ' || COALESCE(v_site_name, 'work site')
            );
            v_action := 'clock_in';

        ELSIF v_has_rec AND v_rec.clock_out_at IS NOT NULL THEN
            -- Re-enter until shift ends (local time). Do not block on UTC "not active".
            IF v_has_shift AND v_shift_ended THEN
                v_action := 'already_clocked_out';
            ELSE
                UPDATE public.attendance_records SET
                    clock_out_at = NULL,
                    clock_out_lat = NULL,
                    clock_out_lng = NULL,
                    work_minutes = NULL,
                    status = 'present',
                    notes = COALESCE(notes, '') || ' | Re-entered ' || COALESCE(v_site_name, 'work site')
                WHERE id = v_rec.id
                RETURNING * INTO v_rec;

                SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_visit_n
                FROM public.attendance_visit_segments
                WHERE user_id = v_user_id AND attendance_date = v_attendance_date;

                INSERT INTO public.attendance_visit_segments (
                    user_id, attendance_record_id, attendance_date, visit_number,
                    clock_in_at, clock_in_lat, clock_in_lng, site_name, work_site_id, notes
                ) VALUES (
                    v_user_id, v_rec.id, v_attendance_date, v_visit_n,
                    v_now, p_latitude, p_longitude, v_site_name, v_work_site_id,
                    'Visit ' || v_visit_n || ' · re-entered ' || COALESCE(v_site_name, 'work site')
                );
                v_action := 'clock_in';
            END IF;
        ELSE
            IF NOT v_has_visit THEN
                SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_visit_n
                FROM public.attendance_visit_segments
                WHERE user_id = v_user_id AND attendance_date = v_attendance_date;

                INSERT INTO public.attendance_visit_segments (
                    user_id, attendance_record_id, attendance_date, visit_number,
                    clock_in_at, clock_in_lat, clock_in_lng, site_name, work_site_id, notes
                ) VALUES (
                    v_user_id, v_rec.id, v_attendance_date, v_visit_n,
                    COALESCE(v_rec.clock_in_at, v_now), p_latitude, p_longitude, v_site_name, v_work_site_id,
                    'Visit ' || v_visit_n || ' · on site'
                );
            END IF;
            v_action := 'already_clocked_in';
        END IF;

    ELSE
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL AND v_left_site THEN
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins,
                    notes = COALESCE(notes, '') || ' | Left work site'
                WHERE id = v_visit.id;
            END IF;

            SELECT COALESCE(SUM(work_minutes), 0)::INTEGER INTO v_total_mins
            FROM public.attendance_visit_segments
            WHERE user_id = v_user_id AND attendance_date = v_attendance_date AND clock_out_at IS NOT NULL;

            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins,
                notes = COALESCE(notes, '') || ' | Auto clock-out (left work site)'
            WHERE id = v_rec.id
            RETURNING * INTO v_rec;
            v_action := 'clock_out';
        ELSIF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'already_clocked_in';
        ELSE
            v_action := 'outside_office';
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
        'work_minutes', CASE WHEN v_has_rec THEN v_rec.work_minutes ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.geo_confirm_left_site(DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

NOTIFY pgrst, 'reload schema';
