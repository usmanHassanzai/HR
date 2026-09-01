-- Manual check-out after check-in.
-- Manager/admin (and hybrid WFH) present marks count as a completed assigned shift (8h/9h).

CREATE OR REPLACE FUNCTION public.shift_duration_minutes(
    p_start TIME,
    p_end TIME,
    p_overnight BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_start INTEGER;
    v_end INTEGER;
    v_mins INTEGER;
BEGIN
    IF p_start IS NULL OR p_end IS NULL THEN
        RETURN 8 * 60;
    END IF;
    v_start := EXTRACT(HOUR FROM p_start)::INTEGER * 60 + EXTRACT(MINUTE FROM p_start)::INTEGER;
    v_end := EXTRACT(HOUR FROM p_end)::INTEGER * 60 + EXTRACT(MINUTE FROM p_end)::INTEGER;
    v_mins := v_end - v_start;
    IF COALESCE(p_overnight, false) OR v_end <= v_start THEN
        v_mins := v_mins + 24 * 60;
    END IF;
    RETURN GREATEST(1, v_mins);
END;
$$;

CREATE OR REPLACE FUNCTION public.user_shift_for_date(p_user_id UUID, p_date DATE)
RETURNS TABLE(
    shift_id UUID,
    start_time TIME,
    end_time TIME,
    crosses_midnight BOOLEAN,
    shift_minutes INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ws.id,
        ws.start_time,
        ws.end_time,
        COALESCE(ws.crosses_midnight, false),
        public.shift_duration_minutes(ws.start_time, ws.end_time, COALESCE(ws.crosses_midnight, false))
    FROM public.employee_shift_assignments esa
    JOIN public.work_shifts ws ON ws.id = esa.shift_id
    WHERE esa.user_id = p_user_id
      AND esa.effective_from <= p_date
      AND (esa.effective_to IS NULL OR esa.effective_to >= p_date)
    ORDER BY esa.effective_from DESC
    LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.shift_duration_minutes(TIME, TIME, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_shift_for_date(UUID, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check out for a future date'; END IF;

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
        RAISE EXCEPTION 'Check in first, then you can check out';
    END IF;
    IF v_rec.status = 'absent' THEN
        RAISE EXCEPTION 'Cannot check out on an absent day';
    END IF;
    IF v_rec.clock_out_at IS NOT NULL THEN
        RAISE EXCEPTION 'Already checked out';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'attendance_visit_segments'
    ) THEN
        UPDATE public.attendance_visit_segments
        SET clock_out_at = v_now,
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
        WHERE user_id = v_uid
          AND attendance_date = p_date
          AND clock_out_at IS NULL;

        SELECT COALESCE(SUM(work_minutes), 0)::INTEGER INTO v_total
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = p_date;
    END IF;

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = GREATEST(
            v_total,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER)
        )
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.check_out_attendance(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_allowed BOOLEAN := false;
    v_notes TEXT;
    v_start_time TIME;
    v_mins INTEGER := 8 * 60;
    v_shift_id UUID;
    v_clock_in TIMESTAMPTZ;
    v_clock_out TIMESTAMPTZ;
    v_existing public.attendance_records%ROWTYPE;
    v_keep_geo BOOLEAN := false;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(p_user_id);
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    IF p_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Cannot mark attendance for a future date';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

    IF public.is_admin(auth.uid()) THEN
        v_allowed := true;
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_allowed := true;
    ELSIF v_me.role = 'manager'::public.user_role
          AND v_emp.role = 'employee'::public.user_role
          AND v_me.department_id IS NOT NULL
          AND v_emp.department_id = v_me.department_id
          AND (v_me.company_id IS NULL OR v_emp.company_id IS NOT DISTINCT FROM v_me.company_id) THEN
        v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT shift_id, start_time, shift_minutes
    INTO v_shift_id, v_start_time, v_mins
    FROM public.user_shift_for_date(p_user_id, p_date);
    IF FOUND THEN
        v_clock_in := (p_date + v_start_time) AT TIME ZONE 'UTC';
        v_clock_out := v_clock_in + (v_mins || ' minutes')::INTERVAL;
    ELSE
        v_mins := 8 * 60;
        v_clock_in := (p_date + TIME '09:00') AT TIME ZONE 'UTC';
        v_clock_out := v_clock_in + (v_mins || ' minutes')::INTERVAL;
    END IF;

    IF p_status = 'half_day' THEN
        v_mins := GREATEST(1, v_mins / 2);
        v_clock_out := v_clock_in + (v_mins || ' minutes')::INTERVAL;
    END IF;

    IF p_status NOT IN ('present', 'late', 'half_day') THEN
        v_clock_in := NULL;
        v_clock_out := NULL;
        v_mins := NULL;
    END IF;

    SELECT * INTO v_existing
    FROM public.attendance_records
    WHERE user_id = p_user_id AND attendance_date = p_date;
    v_keep_geo := FOUND
        AND v_existing.attendance_source = 'geo'
        AND v_existing.clock_in_at IS NOT NULL
        AND p_status IN ('present', 'late', 'half_day');

    v_notes := COALESCE(NULLIF(trim(p_notes), ''),
        CASE
            WHEN v_emp.work_mode = 'remote' THEN 'Remote work — marked by manager'
            WHEN v_emp.work_mode = 'hybrid' THEN 'Hybrid remote day — marked by manager'
            ELSE 'Marked by manager'
        END
    );

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
        work_minutes, shift_id
    )
    VALUES (
        p_user_id,
        p_date,
        p_status,
        'approved'::public.approval_status,
        v_notes,
        auth.uid(),
        auth.uid(),
        v_now,
        CASE WHEN v_keep_geo THEN v_existing.clock_in_at ELSE v_clock_in END,
        CASE WHEN v_keep_geo THEN v_existing.clock_out_at ELSE v_clock_out END,
        CASE WHEN v_keep_geo THEN 'geo' ELSE 'manual' END,
        CASE WHEN v_keep_geo THEN v_existing.work_minutes ELSE v_mins END,
        COALESCE(v_existing.shift_id, v_shift_id)
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = 'approved'::public.approval_status,
        notes = EXCLUDED.notes,
        marked_by = auth.uid(),
        reviewed_by = auth.uid(),
        reviewed_at = v_now,
        clock_in_at = EXCLUDED.clock_in_at,
        clock_out_at = EXCLUDED.clock_out_at,
        work_minutes = EXCLUDED.work_minutes,
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
        attendance_source = CASE
            WHEN v_keep_geo THEN public.attendance_records.attendance_source
            ELSE 'manual'
        END
    RETURNING id INTO v_id;

    PERFORM public.create_system_notification(
        p_user_id,
        'Attendance Recorded',
        'Your attendance for ' || p_date::TEXT || ' was marked as ' || p_status::TEXT || '.',
        'info'::notification_type
    );
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;

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
    IF v_me.role NOT IN ('employee', 'manager') THEN
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

NOTIFY pgrst, 'reload schema';
