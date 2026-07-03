-- Shift management + shift-aware automated geo attendance

CREATE TABLE IF NOT EXISTS public.work_shifts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manager_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    days_of_week    INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
    grace_minutes   INTEGER NOT NULL DEFAULT 30 CHECK (grace_minutes >= 0 AND grace_minutes <= 120),
    active          BOOLEAN NOT NULL DEFAULT true,
    is_demo         BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CHECK (end_time > start_time),
    CHECK (cardinality(days_of_week) > 0)
);

CREATE INDEX IF NOT EXISTS idx_work_shifts_manager ON public.work_shifts(manager_id) WHERE active = true;

CREATE TABLE IF NOT EXISTS public.employee_shift_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    shift_id        UUID NOT NULL REFERENCES public.work_shifts(id) ON DELETE CASCADE,
    assigned_by     UUID NOT NULL REFERENCES public.users(id),
    effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_employee_shift_user ON public.employee_shift_assignments(user_id, effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_shift_active
    ON public.employee_shift_assignments(user_id)
    WHERE effective_to IS NULL;

ALTER TABLE public.employee_shift_assignments
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.attendance_records
    ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES public.work_shifts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS work_minutes INTEGER;

-- Active shift for a user on a given date (most recent open assignment)
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
    manager_id UUID
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ws.id,
        ws.name,
        ws.start_time,
        ws.end_time,
        ws.grace_minutes,
        ws.days_of_week,
        ws.manager_id
    FROM public.employee_shift_assignments esa
    JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
    WHERE esa.user_id = p_user_id
      AND esa.effective_from <= p_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
    ORDER BY esa.effective_from DESC, esa.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Is current local time within shift window (with grace before start)?
CREATE OR REPLACE FUNCTION public.is_within_shift_window(
    p_start_time TIME,
    p_end_time TIME,
    p_grace_minutes INTEGER,
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
)
RETURNS BOOLEAN AS $$
DECLARE
    v_local TIME;
BEGIN
    v_local := (p_at AT TIME ZONE 'UTC')::TIME;
    IF p_grace_minutes > 0 THEN
        RETURN v_local >= (p_start_time - (p_grace_minutes || ' minutes')::INTERVAL)::TIME
           AND v_local <= p_end_time;
    END IF;
    RETURN v_local >= p_start_time AND v_local <= p_end_time;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.has_shift_ended(
    p_end_time TIME,
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (p_at AT TIME ZONE 'UTC')::TIME > p_end_time;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Manager: list shifts
CREATE OR REPLACE FUNCTION public.get_manager_shifts()
RETURNS TABLE(
    id UUID,
    name TEXT,
    start_time TIME,
    end_time TIME,
    days_of_week INTEGER[],
    grace_minutes INTEGER,
    active BOOLEAN,
    assigned_count BIGINT
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
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
        COUNT(esa.id) FILTER (WHERE esa.effective_to IS NULL)
    FROM public.work_shifts ws
    LEFT JOIN public.employee_shift_assignments esa ON esa.shift_id = ws.id
    WHERE ws.manager_id = v_uid OR v_role = 'admin'::public.user_role
    GROUP BY ws.id
    ORDER BY ws.start_time;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_work_shift(
    p_name TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[] DEFAULT ARRAY[1,2,3,4,5],
    p_grace_minutes INTEGER DEFAULT 30,
    p_shift_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_id UUID;
    v_demo BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;
    IF v_role <> 'manager'::public.user_role THEN RAISE EXCEPTION 'Managers only'; END IF;
    IF p_end_time <= p_start_time THEN RAISE EXCEPTION 'End time must be after start time'; END IF;

    v_demo := public.is_demo_user(v_uid);
    PERFORM public.enforce_demo_isolation(v_uid);

    IF p_shift_id IS NULL THEN
        INSERT INTO public.work_shifts (manager_id, name, start_time, end_time, days_of_week, grace_minutes, is_demo)
        VALUES (v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes, v_demo)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.work_shifts SET
            name = trim(p_name),
            start_time = p_start_time,
            end_time = p_end_time,
            days_of_week = p_days_of_week,
            grace_minutes = p_grace_minutes,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_shift_id AND manager_id = v_uid
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_work_shift(p_shift_id UUID)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    DELETE FROM public.work_shifts WHERE id = p_shift_id AND manager_id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_employee_shift(
    p_user_id UUID,
    p_shift_id UUID,
    p_effective_from DATE DEFAULT CURRENT_DATE
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_shift_manager UUID;
    v_assignment_id UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT manager_id INTO v_shift_manager FROM public.work_shifts WHERE id = p_shift_id AND active = true;
    IF v_shift_manager IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    IF v_shift_manager <> v_uid THEN RAISE EXCEPTION 'You can only assign your own shifts'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_user_id AND u.manager_id = v_uid AND u.role = 'employee'::public.user_role
    ) THEN
        RAISE EXCEPTION 'User is not on your team';
    END IF;

    PERFORM public.enforce_demo_isolation(v_uid);

    UPDATE public.employee_shift_assignments
    SET effective_to = p_effective_from - 1
    WHERE user_id = p_user_id AND effective_to IS NULL AND effective_from < p_effective_from;

    INSERT INTO public.employee_shift_assignments (user_id, shift_id, assigned_by, effective_from, is_demo)
    VALUES (p_user_id, p_shift_id, v_uid, p_effective_from, public.is_demo_user(v_uid))
    RETURNING id INTO v_assignment_id;

    RETURN v_assignment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_shift()
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    effective_from DATE
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
        esa.effective_from
    FROM public.get_active_shift_for_user(auth.uid(), CURRENT_DATE) s
    JOIN public.employee_shift_assignments esa
        ON esa.user_id = auth.uid()
        AND esa.shift_id = s.shift_id
        AND esa.effective_from <= CURRENT_DATE
        AND (esa.effective_to IS NULL OR esa.effective_to >= CURRENT_DATE)
    ORDER BY esa.effective_from DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_team_shift_assignments()
RETURNS TABLE(
    user_id UUID,
    full_name TEXT,
    email TEXT,
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    effective_from DATE
) AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    RETURN QUERY
    SELECT
        u.id,
        u.full_name,
        u.email,
        ws.id,
        ws.name,
        ws.start_time,
        ws.end_time,
        esa.effective_from
    FROM public.users u
    LEFT JOIN LATERAL (
        SELECT esa2.*
        FROM public.employee_shift_assignments esa2
        WHERE esa2.user_id = u.id
          AND esa2.effective_from <= CURRENT_DATE
          AND (esa2.effective_to IS NULL OR esa2.effective_to >= CURRENT_DATE)
        ORDER BY esa2.effective_from DESC
        LIMIT 1
    ) esa ON true
    LEFT JOIN public.work_shifts ws ON ws.id = esa.shift_id AND ws.active = true
    WHERE u.manager_id = v_uid AND u.role = 'employee'::public.user_role
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_attendance_history(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE(
    id UUID,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_source TEXT,
    work_minutes INTEGER,
    shift_name TEXT,
    notes TEXT
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_target UUID;
    v_role public.user_role;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = v_uid;

    v_target := COALESCE(p_user_id, v_uid);

    IF v_target <> v_uid THEN
        IF v_role = 'manager'::public.user_role THEN
            IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_target AND manager_id = v_uid) THEN
                RAISE EXCEPTION 'Not authorized';
            END IF;
        ELSIF v_role <> 'admin'::public.user_role THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
    END IF;

    IF p_month IS NULL THEN
        v_start := make_date(p_year, 1, 1);
        v_end := make_date(p_year, 12, 31);
    ELSE
        v_start := make_date(p_year, p_month, 1);
        v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    RETURN QUERY
    SELECT
        ar.id,
        ar.attendance_date,
        ar.status,
        ar.approval_status,
        ar.clock_in_at,
        ar.clock_out_at,
        ar.attendance_source,
        ar.work_minutes,
        ws.name,
        ar.notes
    FROM public.attendance_records ar
    LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
    WHERE ar.user_id = v_target
      AND ar.attendance_date BETWEEN v_start AND v_end
    ORDER BY ar.attendance_date DESC, ar.clock_in_at DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Shift-aware geo attendance ping
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
    v_has_shift BOOLEAN := false;
    v_is_work_day BOOLEAN := true;
    v_shift_active BOOLEAN := true;
    v_shift_ended BOOLEAN := false;
    v_work_mins INTEGER;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees and managers only');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    SELECT
        s.shift_id, s.shift_name, s.start_time, s.end_time, s.grace_minutes, s.days_of_week
    INTO v_shift_id, v_shift_name, v_shift_start, v_shift_end, v_shift_grace, v_shift_days
    FROM public.get_active_shift_for_user(v_user_id, CURRENT_DATE) s
    LIMIT 1;
    v_has_shift := FOUND AND v_shift_id IS NOT NULL;

    IF v_has_shift THEN
        v_is_work_day := EXTRACT(ISODOW FROM CURRENT_DATE)::INTEGER = ANY(v_shift_days);
        v_shift_active := public.is_within_shift_window(v_shift_start, v_shift_end, v_shift_grace, v_now);
        v_shift_ended := public.has_shift_ended(v_shift_end, v_now);
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

    SELECT * INTO v_rec FROM public.attendance_records
    WHERE user_id = v_user_id AND attendance_date = CURRENT_DATE;
    v_has_rec := FOUND;

    -- Auto clock-out when shift ended (even if still inside radius)
    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL
       AND v_has_shift AND (v_shift_ended OR NOT v_is_work_day) THEN
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
        IF v_has_shift AND NOT v_is_work_day THEN
            v_action := 'not_work_day';
        ELSIF v_has_shift AND NOT v_shift_active AND (NOT v_has_rec OR v_rec.clock_in_at IS NULL) THEN
            v_action := 'shift_not_started';
        ELSIF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes
            ) VALUES (
                v_user_id, CURRENT_DATE, 'present', 'approved', v_user_id,
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
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
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
        'work_minutes', CASE WHEN v_has_rec THEN v_rec.work_minutes ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Demo seed: morning shift for demo manager team
INSERT INTO public.work_shifts (manager_id, name, start_time, end_time, days_of_week, grace_minutes, is_demo)
SELECT u.id, 'Morning Shift', '09:00'::TIME, '18:00'::TIME, ARRAY[1,2,3,4,5], 30, true
FROM public.users u
WHERE u.email = 'manager@walfia.ai'
  AND NOT EXISTS (SELECT 1 FROM public.work_shifts ws WHERE ws.manager_id = u.id AND ws.name = 'Morning Shift')
LIMIT 1;

INSERT INTO public.employee_shift_assignments (user_id, shift_id, assigned_by, effective_from, is_demo)
SELECT emp.id, ws.id, mgr.id, CURRENT_DATE, true
FROM public.users emp
JOIN public.users mgr ON mgr.email = 'manager@walfia.ai'
JOIN public.work_shifts ws ON ws.manager_id = mgr.id AND ws.name = 'Morning Shift'
WHERE emp.email = 'employee@walfia.ai'
  AND NOT EXISTS (
      SELECT 1 FROM public.employee_shift_assignments esa
      WHERE esa.user_id = emp.id AND esa.effective_to IS NULL
  );

GRANT EXECUTE ON FUNCTION public.get_active_shift_for_user(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_manager_shifts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_work_shift(TEXT, TIME, TIME, INTEGER[], INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_work_shift(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_shift(UUID, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_shift() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_shift_assignments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_attendance_history(INTEGER, INTEGER, UUID) TO authenticated;
