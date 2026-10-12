-- attendance_geo_window.sql
-- N2: JWT process_geo_attendance_ping keeps working until device enrollment,
-- but enforces W + server time immediately; returns stop_tracking outside W.

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
    v_win RECORD;
    v_visit public.attendance_visit_segments%ROWTYPE;
    v_has_visit BOOLEAN := false;
    v_seg_mins INTEGER;
    v_total_mins INTEGER;
    v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
    v_open_checkin BOOLEAN := false;
    v_prev_inside BOOLEAN;
    v_left_site BOOLEAN := false;
    v_attendance_date DATE;
    v_enrolled BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees, managers, and HR only');
    END IF;

    -- After device enrollment, prefer device-token path (N2)
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_user_id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
    ) INTO v_enrolled;

    UPDATE public.users SET last_seen_at = v_now WHERE id = v_user_id;

    IF v_intent NOT IN ('clock_in', 'clock_out', 'auto') THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Unknown attendance intent');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_user_id, v_now) LIMIT 1;

    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RETURN jsonb_build_object(
            'action', 'outside_window',
            'reason', 'outside_window',
            'stop_tracking', true,
            'window_start_utc', v_win.window_start_utc,
            'window_end_utc', v_win.window_end_utc,
            'server_now_utc', v_now,
            'enrolled_device', v_enrolled
        );
    END IF;

    v_attendance_date := v_win.attendance_date;

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
            v_work_site_id := v_office_id;
        END IF;
    END IF;

    v_radius := GREATEST(COALESCE(v_radius, 150), 150);
    v_effective_radius := v_radius::DOUBLE PRECISION
      + LEAST(COALESCE(p_accuracy, 0)::DOUBLE PRECISION, 100::DOUBLE PRECISION);
    v_inside := (v_distance IS NOT NULL AND v_distance <= v_effective_radius);

    SELECT p.inside_site INTO v_prev_inside
    FROM public.employee_location_pings p
    WHERE p.user_id = v_user_id
    ORDER BY p.recorded_at DESC
    LIMIT 1;

    v_left_site := public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);

    v_rec := public.get_open_attendance_record(v_user_id);
    v_open_checkin := v_rec.id IS NOT NULL;
    v_has_rec := v_open_checkin;

    IF NOT v_has_rec THEN
        SELECT * INTO v_rec
        FROM public.attendance_records ar
        WHERE ar.user_id = v_user_id AND ar.attendance_date = v_attendance_date
        LIMIT 1;
        v_has_rec := FOUND;
    ELSE
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

    -- Only store pings inside W (N3) — trigger also enforces
    INSERT INTO public.employee_location_pings (
        user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
        v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );

    IF v_intent = 'clock_in' THEN
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'already_clocked_in';
        ELSIF NOT v_inside THEN
            v_action := 'outside_office';
        ELSE
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'manual', v_win.shift_id,
                'GPS clock-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'manual' ELSE public.attendance_records.attendance_source END,
                presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'GPS entry'
            );
            v_action := 'clock_in';
        END IF;

    ELSIF v_intent = 'clock_out' THEN
        IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            v_action := 'no_open_visit';
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins
                WHERE id = v_visit.id;
            END IF;
            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins
            WHERE id = v_rec.id;
            v_action := 'clock_out';
        END IF;

    ELSIF v_intent = 'auto' THEN
        IF v_enrolled THEN
            RETURN jsonb_build_object(
              'action', 'use_device_token',
              'reason', 'enrolled_device_use_auto_path',
              'stop_tracking', false,
              'enrolled_device', true
            );
        END IF;

        IF v_inside AND (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL) THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'auto_gps', v_win.shift_id,
                'Auto GPS check-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE
                  WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
                  THEN 'auto_gps' ELSE public.attendance_records.attendance_source END,
                presence_method = 'gps',
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto GPS entry'
            );
            v_action := 'clock_in';
        ELSIF v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins
                WHERE id = v_visit.id;
            END IF;
            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins,
                notes = COALESCE(notes, '') || ' | Auto GPS check-out'
            WHERE id = v_rec.id;
            v_action := 'clock_out';
        ELSIF v_inside AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'still_inside';
        ELSE
            v_action := 'none';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'action', v_action,
        'inside', v_inside,
        'distance_m', v_distance,
        'attendance_date', v_attendance_date,
        'window_start_utc', v_win.window_start_utc,
        'window_end_utc', v_win.window_end_utc,
        'server_now_utc', v_now,
        'stop_tracking', false,
        'enrolled_device', v_enrolled,
        'shift_tz', v_win.shift_tz
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
