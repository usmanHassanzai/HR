-- Shift v2: overnight shifts, auto-apply to all team, improved attendance lookup

-- Drop functions whose signatures or return types changed (required before CREATE)
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.get_active_shift_for_user(UUID, DATE);
DROP FUNCTION IF EXISTS public.is_within_shift_window(TIME, TIME, INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.has_shift_ended(TIME, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID);
DROP FUNCTION IF EXISTS public.get_manager_shifts();
DROP FUNCTION IF EXISTS public.get_my_shift();

ALTER TABLE public.work_shifts
    DROP CONSTRAINT IF EXISTS work_shifts_check;

ALTER TABLE public.work_shifts
    ADD COLUMN IF NOT EXISTS crosses_midnight BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS apply_to_all BOOLEAN NOT NULL DEFAULT true;

-- Backfill overnight flag for existing rows
UPDATE public.work_shifts SET crosses_midnight = (end_time <= start_time) WHERE crosses_midnight = false AND end_time <= start_time;

CREATE OR REPLACE FUNCTION public.is_shift_overnight(p_start TIME, p_end TIME)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN p_end <= p_start;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.is_within_shift_window(
    p_start_time TIME,
    p_end_time TIME,
    p_grace_minutes INTEGER,
    p_days_of_week INTEGER[],
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
) RETURNS BOOLEAN AS $$
DECLARE
    v_local TIME;
    v_dow INTEGER;
    v_prev_dow INTEGER;
    v_grace_start TIME;
BEGIN
    v_local := (p_at AT TIME ZONE 'UTC')::TIME;
    v_dow := EXTRACT(ISODOW FROM (p_at AT TIME ZONE 'UTC')::DATE)::INTEGER;
    v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;
    v_grace_start := (p_start_time - (p_grace_minutes || ' minutes')::INTERVAL)::TIME;

    IF NOT public.is_shift_overnight(p_start_time, p_end_time) THEN
        IF NOT (v_dow = ANY(p_days_of_week)) THEN RETURN FALSE; END IF;
        RETURN v_local >= v_grace_start AND v_local <= p_end_time;
    END IF;

    IF v_local >= v_grace_start THEN
        RETURN v_dow = ANY(p_days_of_week);
    ELSIF v_local <= p_end_time THEN
        RETURN v_prev_dow = ANY(p_days_of_week);
    END IF;
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION public.has_shift_ended(
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[],
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
) RETURNS BOOLEAN AS $$
DECLARE
    v_local TIME;
    v_dow INTEGER;
BEGIN
    v_local := (p_at AT TIME ZONE 'UTC')::TIME;
    v_dow := EXTRACT(ISODOW FROM (p_at AT TIME ZONE 'UTC')::DATE)::INTEGER;

    IF NOT public.is_shift_overnight(p_start_time, p_end_time) THEN
        IF NOT (v_dow = ANY(p_days_of_week)) THEN RETURN TRUE; END IF;
        RETURN v_local > p_end_time;
    END IF;

    IF v_local > p_end_time AND v_local < p_start_time THEN
        RETURN TRUE;
    END IF;
    IF v_local >= p_start_time OR v_local <= p_end_time THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

-- Active shift: individual assignment, else manager team default (apply_to_all)
CREATE OR REPLACE FUNCTION public.get_active_shift_for_user(
    p_user_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    manager_id UUID,
    crosses_midnight BOOLEAN
) AS $$
DECLARE
    v_manager_id UUID;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.employee_shift_assignments esa
        JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
        WHERE esa.user_id = p_user_id
          AND esa.effective_from <= p_date
          AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
    ) THEN
        RETURN QUERY
        SELECT
            ws.id,
            ws.name,
            ws.start_time,
            ws.end_time,
            ws.grace_minutes,
            ws.days_of_week,
            ws.manager_id,
            ws.crosses_midnight
        FROM public.employee_shift_assignments esa
        JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
        WHERE esa.user_id = p_user_id
          AND esa.effective_from <= p_date
          AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
        ORDER BY esa.effective_from DESC, esa.created_at DESC
        LIMIT 1;
        RETURN;
    END IF;

    SELECT u.manager_id INTO v_manager_id FROM public.users u WHERE u.id = p_user_id;

    RETURN QUERY
    SELECT
        ws.id,
        ws.name,
        ws.start_time,
        ws.end_time,
        ws.grace_minutes,
        ws.days_of_week,
        ws.manager_id,
        ws.crosses_midnight
    FROM public.work_shifts ws
    WHERE ws.manager_id = v_manager_id
      AND ws.active = true
      AND ws.apply_to_all = true
    ORDER BY ws.updated_at DESC, ws.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_shift_to_all_team(
    p_shift_id UUID,
    p_effective_from DATE DEFAULT CURRENT_DATE
)
RETURNS INTEGER AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_shift_manager UUID;
    v_count INTEGER := 0;
    v_emp RECORD;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT manager_id INTO v_shift_manager
    FROM public.work_shifts
    WHERE id = p_shift_id AND active = true;

    IF v_shift_manager IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    IF v_shift_manager <> v_uid THEN RAISE EXCEPTION 'You can only assign your own shifts'; END IF;

    PERFORM public.enforce_demo_isolation(v_uid);

    FOR v_emp IN
        SELECT u.id
        FROM public.users u
        WHERE u.manager_id = v_uid AND u.role = 'employee'::public.user_role
    LOOP
        UPDATE public.employee_shift_assignments
        SET effective_to = p_effective_from - 1
        WHERE user_id = v_emp.id
          AND effective_to IS NULL
          AND shift_id <> p_shift_id;

        IF NOT EXISTS (
            SELECT 1 FROM public.employee_shift_assignments
            WHERE user_id = v_emp.id AND shift_id = p_shift_id AND effective_to IS NULL
        ) THEN
            INSERT INTO public.employee_shift_assignments (user_id, shift_id, assigned_by, effective_from, is_demo)
            VALUES (v_emp.id, p_shift_id, v_uid, p_effective_from, public.is_demo_user(v_uid));
        END IF;

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID);

CREATE OR REPLACE FUNCTION public.upsert_work_shift(
    p_name TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[] DEFAULT ARRAY[1,2,3,4,5],
    p_grace_minutes INTEGER DEFAULT 30,
    p_shift_id UUID DEFAULT NULL,
    p_crosses_midnight BOOLEAN DEFAULT NULL,
    p_apply_to_all BOOLEAN DEFAULT true
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_id UUID;
    v_demo BOOLEAN;
    v_overnight BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF v_role <> 'manager'::public.user_role THEN RAISE EXCEPTION 'Managers only'; END IF;

    v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

    IF NOT v_overnight AND p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
    END IF;

    v_demo := public.is_demo_user(v_uid);
    PERFORM public.enforce_demo_isolation(v_uid);

    IF p_shift_id IS NULL THEN
        INSERT INTO public.work_shifts (
            manager_id, name, start_time, end_time, days_of_week, grace_minutes,
            crosses_midnight, apply_to_all, is_demo
        ) VALUES (
            v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes,
            v_overnight, p_apply_to_all, v_demo
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.work_shifts SET
            name = trim(p_name),
            start_time = p_start_time,
            end_time = p_end_time,
            days_of_week = p_days_of_week,
            grace_minutes = p_grace_minutes,
            crosses_midnight = v_overnight,
            apply_to_all = p_apply_to_all,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_shift_id AND manager_id = v_uid
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    END IF;

    IF p_apply_to_all THEN
        BEGIN
            PERFORM public.assign_shift_to_all_team(v_id, CURRENT_DATE);
        EXCEPTION WHEN OTHERS THEN
            -- Shift is saved even if team assignment fails (e.g. no employees yet)
            NULL;
        END;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.get_manager_shifts();

CREATE OR REPLACE FUNCTION public.get_manager_shifts()
RETURNS TABLE(
    id UUID,
    name TEXT,
    start_time TIME,
    end_time TIME,
    days_of_week INTEGER[],
    grace_minutes INTEGER,
    active BOOLEAN,
    crosses_midnight BOOLEAN,
    apply_to_all BOOLEAN,
    assigned_count BIGINT
) AS $$
#variable_conflict use_column
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
    IF v_role NOT IN ('manager'::public.user_role, 'admin'::public.user_role) THEN
        RAISE EXCEPTION 'Managers only';
    END IF;

    RETURN QUERY
    SELECT
        ws.id,
        ws.name,
        ws.start_time,
        ws.end_time,
        ws.days_of_week,
        ws.grace_minutes,
        ws.active,
        ws.crosses_midnight,
        ws.apply_to_all,
        (
            SELECT COUNT(*)::BIGINT
            FROM public.employee_shift_assignments esa
            WHERE esa.shift_id = ws.id AND esa.effective_to IS NULL
        ) AS assigned_count
    FROM public.work_shifts ws
    WHERE ws.manager_id = v_uid OR v_role = 'admin'::public.user_role
    ORDER BY ws.start_time;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.get_my_shift();

CREATE OR REPLACE FUNCTION public.get_my_shift()
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    effective_from DATE,
    crosses_midnight BOOLEAN
) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    RETURN QUERY
    SELECT
        s.shift_id,
        s.shift_name,
        s.start_time,
        s.end_time,
        s.grace_minutes,
        s.days_of_week,
        COALESCE(esa.effective_from, CURRENT_DATE),
        s.crosses_midnight
    FROM public.get_active_shift_for_user(auth.uid(), CURRENT_DATE) s
    LEFT JOIN public.employee_shift_assignments esa
        ON esa.user_id = auth.uid()
        AND esa.shift_id = s.shift_id
        AND esa.effective_from <= CURRENT_DATE
        AND (esa.effective_to IS NULL OR esa.effective_to >= CURRENT_DATE)
    ORDER BY esa.effective_from DESC NULLS LAST
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Open attendance record (supports overnight shifts spanning midnight)
CREATE OR REPLACE FUNCTION public.get_open_attendance_record(p_user_id UUID)
RETURNS public.attendance_records AS $$
DECLARE
    v_rec public.attendance_records%ROWTYPE;
BEGIN
    SELECT * INTO v_rec
    FROM public.attendance_records ar
    WHERE ar.user_id = p_user_id
      AND ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_date >= CURRENT_DATE - 1
    ORDER BY ar.attendance_date DESC, ar.clock_in_at DESC
    LIMIT 1;

    RETURN v_rec;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
    v_work_mins INTEGER;
    v_attendance_date DATE := CURRENT_DATE;
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
    FROM public.get_active_shift_for_user(v_user_id, CURRENT_DATE) s
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
        v_inside := v_distance <= v_radius;
    ELSE
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

    v_rec := public.get_open_attendance_record(v_user_id);
    v_has_rec := v_rec.id IS NOT NULL;
    IF v_has_rec THEN
        v_attendance_date := v_rec.attendance_date;
    END IF;

    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL
       AND v_has_shift AND v_shift_ended THEN
        v_work_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at))::INTEGER / 60);
        UPDATE public.attendance_records SET
            clock_out_at = v_now,
            clock_out_lat = p_latitude,
            clock_out_lng = p_longitude,
            work_minutes = v_work_mins,
            notes = COALESCE(notes, '') || ' | Auto clock-out (shift ended)'
        WHERE id = v_rec.id
        RETURNING * INTO v_rec;
        v_action := 'clock_out_shift_end';
    ELSIF v_inside THEN
        IF v_has_shift AND NOT v_shift_active AND NOT v_has_rec THEN
            v_action := 'shift_not_started';
        ELSIF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'geo', v_shift_id,
                'Auto clock-in at ' || COALESCE(v_site_name, 'work site')
                    || CASE WHEN v_shift_name IS NOT NULL THEN ' · ' || v_shift_name ELSE '' END
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_in_lat = COALESCE(public.attendance_records.clock_in_lat, EXCLUDED.clock_in_lat),
                clock_in_lng = COALESCE(public.attendance_records.clock_in_lng, EXCLUDED.clock_in_lng),
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
                status = CASE WHEN public.attendance_records.clock_out_at IS NULL THEN 'present' ELSE public.attendance_records.status END,
                approval_status = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'approved'::public.approval_status ELSE public.attendance_records.approval_status END,
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'geo' ELSE public.attendance_records.attendance_source END,
                notes = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.notes ELSE public.attendance_records.notes END,
                reviewed_by = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_user_id ELSE public.attendance_records.reviewed_by END,
                reviewed_at = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN v_now ELSE public.attendance_records.reviewed_at END
            RETURNING * INTO v_rec;
            v_has_rec := true;
            v_action := 'clock_in';
        ELSIF v_has_rec AND v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            v_action := 'already_clocked_in';
        END IF;
    ELSE
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_work_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at))::INTEGER / 60);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_work_mins,
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
        'record_id', CASE WHEN v_has_rec THEN v_rec.id ELSE NULL END,
        'shift_name', v_shift_name,
        'shift_start', v_shift_start,
        'shift_end', v_shift_end,
        'crosses_midnight', v_shift_overnight,
        'work_minutes', CASE WHEN v_has_rec THEN v_rec.work_minutes ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.is_shift_overnight(TIME, TIME) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_within_shift_window(TIME, TIME, INTEGER, INTEGER[], TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_shift_ended(TIME, TIME, INTEGER[], TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_shift_to_all_team(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_open_attendance_record(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID, BOOLEAN, BOOLEAN) TO authenticated;
