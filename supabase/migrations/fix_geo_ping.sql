-- Fix process_geo_attendance_ping: avoid unassigned RECORD errors when no site/attendance row exists

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
    v_work_site_id UUID;
    v_demo BOOLEAN;
    v_site_lat DOUBLE PRECISION;
    v_site_lng DOUBLE PRECISION;
    v_office_id UUID;
    v_office_dist DOUBLE PRECISION;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    -- Manager team site (or employee inherits from manager)
    SELECT
        ws.site_id, ws.site_name, ws.latitude, ws.longitude, ws.radius_meters
    INTO v_work_site_id, v_site_name, v_site_lat, v_site_lng, v_radius
    FROM public.get_work_site_for_user(v_user_id) ws
    LIMIT 1;

    IF FOUND AND v_work_site_id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site_lat, v_site_lng);
        v_inside := v_distance <= v_radius;
    ELSE
        -- Fallback to global office zones
        SELECT w.office_id, w.office_name, w.distance_meters
        INTO v_office_id, v_site_name, v_office_dist
        FROM public.is_within_office(p_latitude, p_longitude) w
        LIMIT 1;

        IF FOUND AND v_office_id IS NOT NULL THEN
            SELECT o.radius_meters INTO v_radius FROM public.office_locations o WHERE o.id = v_office_id;
            v_distance := v_office_dist;
            v_inside := v_distance <= v_radius;
        END IF;
    END IF;

    INSERT INTO public.employee_location_pings (
        user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
        v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );

    SELECT * INTO v_rec FROM public.attendance_records
    WHERE user_id = v_user_id AND attendance_date = CURRENT_DATE;
    v_has_rec := FOUND;

    IF v_inside THEN
        IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, notes
            ) VALUES (
                v_user_id, CURRENT_DATE, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'geo',
                'Auto clock-in at ' || COALESCE(v_site_name, 'work site')
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_in_lat = COALESCE(public.attendance_records.clock_in_lat, EXCLUDED.clock_in_lat),
                clock_in_lng = COALESCE(public.attendance_records.clock_in_lng, EXCLUDED.clock_in_lng),
                status = CASE WHEN public.attendance_records.clock_out_at IS NULL THEN 'present' ELSE public.attendance_records.status END,
                approval_status = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'approved'::public.approval_status ELSE public.attendance_records.approval_status END,
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'geo' ELSE public.attendance_records.attendance_source END,
                notes = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.notes ELSE public.attendance_records.notes END,
                reviewed_by = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_user_id ELSE public.attendance_records.reviewed_by END,
                reviewed_at = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_now ELSE public.attendance_records.reviewed_at END
            RETURNING * INTO v_rec;
            v_has_rec := true;
            v_action := 'clock_in';
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            v_action := 'already_clocked_in';
        END IF;
    ELSE
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                notes = COALESCE(notes, '') || ' | Auto clock-out (left work site)'
            WHERE id = v_rec.id
            RETURNING * INTO v_rec;
            v_action := 'clock_out';
        ELSE
            v_action := 'outside_office';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'action', v_action,
        'inside_office', v_inside,
        'office_name', v_site_name,
        'distance_meters', v_distance,
        'clock_in_at', CASE WHEN v_has_rec THEN v_rec.clock_in_at ELSE NULL END,
        'clock_out_at', CASE WHEN v_has_rec THEN v_rec.clock_out_at ELSE NULL END,
        'record_id', CASE WHEN v_has_rec THEN v_rec.id ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Convenience RPC for the logged-in user's assigned work site
CREATE OR REPLACE FUNCTION public.get_my_work_site()
RETURNS TABLE(
    site_id UUID,
    site_name TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_meters INTEGER,
    tracking_enabled BOOLEAN,
    manager_id UUID
) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    RETURN QUERY SELECT * FROM public.get_work_site_for_user(auth.uid());
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_work_site() TO authenticated;
