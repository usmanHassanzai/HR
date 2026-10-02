-- Allow HR to mark their own GPS attendance (same as employee/manager). Keep mid-shift checkout behavior.


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
    v_open_checkin BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees, managers, and HR only');
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

    v_rec := public.get_open_attendance_record(v_user_id);
    v_open_checkin := v_rec.id IS NOT NULL;

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

    IF v_intent = 'clock_out'
       AND NOT v_open_checkin
       AND NOT public.is_within_shift_exit_window(v_shift_start, v_shift_end, v_shift_days, v_now) THEN
        RETURN jsonb_build_object(
            'action', 'shift_not_started',
            'reason', 'Checkout is only available during your shift or up to 1 hour after it ends',
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

    v_has_rec := v_open_checkin;

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

NOTIFY pgrst, 'reload schema';

-- Hybrid remote-day self-mark for HR
CREATE OR REPLACE FUNCTION public.mark_hybrid_remote_day(
    p_date DATE DEFAULT CURRENT_DATE,
    p_status public.attendance_status DEFAULT 'present'
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_existing public.attendance_records%ROWTYPE;
    v_notes TEXT;
    v_start_time TIME;
    v_mins INTEGER := 8 * 60;
    v_shift_id UUID;
    v_clock_in TIMESTAMPTZ;
    v_clock_out TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot mark attendance for a future date'; END IF;
    IF p_status NOT IN ('present', 'absent') THEN RAISE EXCEPTION 'Status must be present or absent'; END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF COALESCE(v_me.work_mode, 'office') <> 'hybrid' THEN
        RAISE EXCEPTION 'Only hybrid workers can mark a remote day';
    END IF;
    IF v_me.role NOT IN ('employee', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT * INTO v_existing
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF FOUND AND v_existing.attendance_source = 'geo' AND v_existing.clock_in_at IS NOT NULL THEN
        RAISE EXCEPTION 'Already clocked in at the office for this date';
    END IF;

    SELECT shift_id, start_time, shift_minutes
    INTO v_shift_id, v_start_time, v_mins
    FROM public.user_shift_for_date(v_uid, p_date);
    IF FOUND THEN
        v_clock_in := (p_date + v_start_time) AT TIME ZONE 'UTC';
        v_clock_out := v_clock_in + (v_mins || ' minutes')::INTERVAL;
    ELSE
        v_mins := 8 * 60;
        v_clock_in := (p_date + TIME '09:00') AT TIME ZONE 'UTC';
        v_clock_out := v_clock_in + (v_mins || ' minutes')::INTERVAL;
    END IF;

    IF p_status = 'absent' THEN
        v_clock_in := NULL;
        v_clock_out := NULL;
        v_mins := NULL;
    END IF;

    v_notes := CASE
        WHEN p_status = 'absent' THEN 'Hybrid — marked absent (remote day)'
        ELSE 'Hybrid — worked remotely'
    END;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
        work_minutes, shift_id
    )
    VALUES (
        v_uid,
        p_date,
        p_status,
        'approved'::public.approval_status,
        v_notes,
        v_uid,
        v_uid,
        v_now,
        v_clock_in,
        v_clock_out,
        'manual',
        v_mins,
        v_shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = 'approved'::public.approval_status,
        notes = EXCLUDED.notes,
        marked_by = v_uid,
        reviewed_by = v_uid,
        reviewed_at = v_now,
        clock_in_at = EXCLUDED.clock_in_at,
        clock_out_at = EXCLUDED.clock_out_at,
        work_minutes = EXCLUDED.work_minutes,
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
        attendance_source = 'manual'
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.mark_hybrid_remote_day(DATE, public.attendance_status) TO authenticated;

-- Allow assigning Office GPS to HR
CREATE OR REPLACE FUNCTION public.assign_employee_work_site(
    p_user_id UUID,
    p_office_location_id UUID DEFAULT NULL,
    p_name TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL,
    p_radius_meters INTEGER DEFAULT 150,
    p_tracking_enabled BOOLEAN DEFAULT true
) RETURNS UUID AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_target_demo BOOLEAN;
    v_target_role public.user_role;
    v_lat DOUBLE PRECISION := p_latitude;
    v_lng DOUBLE PRECISION := p_longitude;
    v_name TEXT := NULLIF(trim(p_name), '');
    v_address TEXT := NULLIF(trim(p_address), '');
    v_radius INTEGER := COALESCE(p_radius_meters, 150);
    v_id UUID;
    v_office public.office_locations%ROWTYPE;
    v_company UUID;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee is required'; END IF;

    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign employee office locations';
    END IF;

    SELECT role, is_demo INTO v_target_role, v_target_demo
    FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    IF v_target_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
        RAISE EXCEPTION 'Office GPS can only be assigned to employees, managers, or HR';
    END IF;

    PERFORM public.enforce_demo_isolation(p_user_id);

    IF NOT public.is_demo_user(v_caller) THEN
        IF NOT public.same_company(p_user_id) THEN
            RAISE EXCEPTION 'User is not in your organization';
        END IF;
        v_company := public.current_company_id();
    END IF;

    IF p_office_location_id IS NOT NULL THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id
          AND (
              (public.is_demo_user(v_caller) AND is_demo = true)
              OR (NOT public.is_demo_user(v_caller) AND company_id = v_company)
          );
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;
        v_lat := v_office.latitude;
        v_lng := v_office.longitude;
        v_name := v_office.name;
        v_address := v_office.address;
        v_radius := v_office.radius_meters;
    END IF;

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL THEN
        RAISE EXCEPTION 'Location name and GPS coordinates are required';
    END IF;

    INSERT INTO public.employee_work_sites (
        user_id, office_location_id, name, address, latitude, longitude,
        radius_meters, tracking_enabled, assigned_by, is_demo
    ) VALUES (
        p_user_id, p_office_location_id, v_name, v_address, v_lat, v_lng,
        GREATEST(COALESCE(v_radius, 150), 50), COALESCE(p_tracking_enabled, true),
        v_caller, COALESCE(v_target_demo, false)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        office_location_id = EXCLUDED.office_location_id,
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        radius_meters = EXCLUDED.radius_meters,
        tracking_enabled = EXCLUDED.tracking_enabled,
        assigned_by = v_caller,
        is_demo = EXCLUDED.is_demo,
        updated_at = timezone('utc'::text, now())
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_employee_work_site(UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_office_to_all_employees(p_office_location_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_office public.office_locations%ROWTYPE;
    v_company UUID;
    v_count INTEGER := 0;
    r RECORD;
BEGIN
    IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_caller) THEN
        RAISE EXCEPTION 'Only admins can assign office locations';
    END IF;
    IF p_office_location_id IS NULL THEN RAISE EXCEPTION 'Office is required'; END IF;

    IF public.is_demo_user(v_caller) THEN
        SELECT * INTO v_office FROM public.office_locations
        WHERE id = p_office_location_id AND is_demo = true;
        IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

        FOR r IN
            SELECT id, role, is_demo FROM public.users
            WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role)
              AND is_demo = true
        LOOP
            PERFORM public.assign_employee_work_site(
                r.id, p_office_location_id, v_office.name, v_office.address,
                v_office.latitude, v_office.longitude, v_office.radius_meters, true
            );
            IF r.role = 'manager'::public.user_role THEN
                PERFORM public.assign_manager_work_site(
                    r.id, p_office_location_id, v_office.name, v_office.address,
                    v_office.latitude, v_office.longitude, v_office.radius_meters, true
                );
            END IF;
            v_count := v_count + 1;
        END LOOP;
        RETURN v_count;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'No organization found'; END IF;

    SELECT * INTO v_office FROM public.office_locations
    WHERE id = p_office_location_id AND company_id = v_company;
    IF NOT FOUND THEN RAISE EXCEPTION 'Office location not found'; END IF;

    FOR r IN
        SELECT id, role FROM public.users
        WHERE role IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role)
          AND company_id = v_company
          AND COALESCE(is_demo, false) = false
    LOOP
        PERFORM public.assign_employee_work_site(
            r.id, p_office_location_id, v_office.name, v_office.address,
            v_office.latitude, v_office.longitude, v_office.radius_meters, true
        );
        IF r.role = 'manager'::public.user_role THEN
            PERFORM public.assign_manager_work_site(
                r.id, p_office_location_id, v_office.name, v_office.address,
                v_office.latitude, v_office.longitude, v_office.radius_meters, true
            );
        END IF;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_office_to_all_employees(UUID) TO authenticated;

-- HR leave notifies all admins (same as manager leave); admin-only approval for HR leave
CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL,
    p_custom_type TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
    v_emp_name TEXT;
    v_role public.user_role;
    v_custom TEXT := NULLIF(btrim(COALESCE(p_custom_type, '')), '');
    v_label TEXT;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    IF p_leave_type = 'other' THEN
        IF v_custom IS NULL THEN
            RAISE EXCEPTION 'Please write the type of leave';
        END IF;
        IF char_length(v_custom) > 80 THEN
            RAISE EXCEPTION 'Leave type must be 80 characters or fewer';
        END IF;
    ELSE
        v_custom := NULL;
    END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    SELECT full_name, role, manager_id INTO v_emp_name, v_role, v_mgr FROM public.users WHERE id = auth.uid();

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason, leave_custom_type)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason, v_custom)
    RETURNING id INTO v_id;

    v_label := CASE
        WHEN p_leave_type = 'other' THEN v_custom
        ELSE p_leave_type::TEXT
    END;

    IF v_mgr IS NOT NULL THEN
        SELECT email, full_name INTO v_mgr_email, v_mgr_name FROM public.users WHERE id = v_mgr;
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            v_emp_name || ' requested ' || v_label || ' leave (' || v_days || ' days).',
            'info'::notification_type,
            jsonb_build_object('kind', 'leave', 'leaveId', v_id, 'userId', auth.uid(), 'search', COALESCE(v_emp_name, ''), 'adminTab', 'leave')
        );
    END IF;

    IF v_role IN ('manager'::public.user_role, 'hr'::public.user_role) THEN
        PERFORM public.create_system_notification(
            u.id,
            CASE WHEN v_role = 'hr'::public.user_role THEN 'HR Leave Request' ELSE 'Manager Leave Request' END,
            v_emp_name || ' requested ' || v_label || ' leave.',
            'info'::notification_type,
            jsonb_build_object('kind', 'leave', 'leaveId', v_id, 'userId', auth.uid(), 'search', COALESCE(v_emp_name, ''), 'adminTab', 'leave')
        )
        FROM public.users u WHERE u.role = 'admin'::public.user_role;
    END IF;

    RETURN jsonb_build_object(
        'request_id', v_id,
        'employee_name', v_emp_name,
        'leave_type', p_leave_type,
        'leave_custom_type', v_custom,
        'start_date', p_start,
        'end_date', p_end,
        'days_count', v_days,
        'reason', p_reason,
        'requester_role', v_role,
        'manager_email', v_mgr_email,
        'manager_name', v_mgr_name,
        'admin_recipients', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email, 'name', full_name)), '[]'::jsonb)
            FROM public.users WHERE role = 'admin'::public.user_role
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_leave_request(
    p_request_id UUID,
    p_approve BOOLEAN,
    p_notes TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
    v_label TEXT;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    IF to_regprocedure('public.enforce_demo_isolation(uuid)') IS NOT NULL THEN
        PERFORM public.enforce_demo_isolation(req.user_id);
    END IF;
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;

    IF req_role IN ('manager'::public.user_role, 'hr'::public.user_role) THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid() AND u.role = 'admin'::public.user_role
        ) THEN
            RAISE EXCEPTION 'Manager/HR leave must be approved by admin';
        END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;

    v_label := CASE
        WHEN req.leave_type = 'other' THEN COALESCE(NULLIF(btrim(req.leave_custom_type), ''), 'other')
        ELSE req.leave_type::TEXT
    END;

    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSIF req.leave_type = 'sick' THEN
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || v_label
        FROM generate_series(req.start_date, req.end_date, '1 day'::interval) d
        WHERE EXTRACT(ISODOW FROM d) < 6
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent', approval_status = 'approved', notes = EXCLUDED.notes, reviewed_by = auth.uid(), reviewed_at = now();
    END IF;

    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = p_notes
    WHERE id = p_request_id;

    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || v_label || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END,
        jsonb_build_object('kind', 'leave', 'leaveId', p_request_id, 'userId', req.user_id, 'adminTab', 'leave')
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.review_leave_request(UUID, BOOLEAN, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
