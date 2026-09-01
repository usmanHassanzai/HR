-- Save every check-in / check-out as a visit. Duration = sum of sessions that day.

CREATE OR REPLACE FUNCTION public.attendance_day_total_minutes(
    p_user_id UUID,
    p_date DATE,
    p_now TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(SUM(
        CASE
            WHEN vs.clock_out_at IS NOT NULL THEN COALESCE(
                vs.work_minutes,
                GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::INTEGER)
            )
            ELSE GREATEST(0, (EXTRACT(EPOCH FROM (p_now - vs.clock_in_at)) / 60)::INTEGER)
        END
    ), 0)::INTEGER
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.attendance_date = p_date;
$$;

CREATE OR REPLACE FUNCTION public.attendance_history_work_minutes(
    p_user_id UUID,
    p_date DATE,
    p_clock_in TIMESTAMPTZ,
    p_clock_out TIMESTAMPTZ,
    p_stored INTEGER,
    p_source TEXT,
    p_shift_mins INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_seg INTEGER;
    v_has_visits BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = p_date
    ) INTO v_has_visits;

    v_seg := public.attendance_day_total_minutes(p_user_id, p_date);
    IF v_has_visits AND v_seg > 0 THEN
        RETURN v_seg;
    END IF;
    IF p_stored IS NOT NULL AND p_stored > 0 THEN
        RETURN p_stored;
    END IF;
    IF NOT v_has_visits AND p_clock_in IS NOT NULL AND p_clock_out IS NOT NULL THEN
        RETURN GREATEST(0, (EXTRACT(EPOCH FROM (p_clock_out - p_clock_in)) / 60)::INTEGER);
    END IF;
    IF p_source IS DISTINCT FROM 'geo' AND p_shift_mins IS NOT NULL AND p_shift_mins > 0 THEN
        RETURN p_shift_mins;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_backfill_closed_visit(
    p_user_id UUID,
    p_record_id UUID,
    p_date DATE,
    p_in TIMESTAMPTZ,
    p_out TIMESTAMPTZ,
    p_minutes INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INTEGER;
    v_mins INTEGER;
BEGIN
    IF p_in IS NULL OR p_out IS NULL THEN
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id AND vs.attendance_date = p_date
    ) THEN
        RETURN;
    END IF;
    v_mins := COALESCE(
        NULLIF(p_minutes, 0),
        GREATEST(0, (EXTRACT(EPOCH FROM (p_out - p_in)) / 60)::INTEGER)
    );
    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id AND attendance_date = p_date;

    INSERT INTO public.attendance_visit_segments (
        user_id, attendance_record_id, attendance_date, visit_number,
        clock_in_at, clock_out_at, work_minutes, notes
    ) VALUES (
        p_user_id, p_record_id, p_date, v_n,
        p_in, p_out, v_mins, 'Visit ' || v_n || ' · saved session'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_ensure_open_visit(
    p_user_id UUID,
    p_record_id UUID,
    p_date DATE,
    p_at TIMESTAMPTZ,
    p_note TEXT DEFAULT 'Check in'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = p_date
          AND vs.clock_out_at IS NULL
    ) THEN
        RETURN;
    END IF;

    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id AND attendance_date = p_date;

    INSERT INTO public.attendance_visit_segments (
        user_id, attendance_record_id, attendance_date, visit_number,
        clock_in_at, notes
    ) VALUES (
        p_user_id, p_record_id, p_date, v_n,
        p_at, 'Visit ' || v_n || ' · ' || COALESCE(p_note, 'Check in')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_rec public.attendance_records%ROWTYPE;
    v_id UUID;
    v_kept INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check in for a future date'; END IF;

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
        PERFORM public.attendance_ensure_open_visit(v_uid, v_rec.id, p_date, v_now, 'Check in');
        RETURN v_rec.id;
    END IF;

    IF FOUND AND v_rec.clock_out_at IS NOT NULL THEN
        PERFORM public.attendance_backfill_closed_visit(
            v_uid, v_rec.id, p_date, v_rec.clock_in_at, v_rec.clock_out_at, v_rec.work_minutes
        );
        v_kept := public.attendance_day_total_minutes(v_uid, p_date, v_now);
    ELSE
        v_kept := COALESCE(v_rec.work_minutes, 0);
    END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at
    )
    VALUES (
        v_uid, p_date, 'present', 'approved'::public.approval_status, v_uid,
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
        work_minutes = COALESCE(
            NULLIF(EXCLUDED.work_minutes, 0),
            NULLIF(public.attendance_records.work_minutes, 0)
        ),
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual')
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, p_date, v_now, 'Check in');

    UPDATE public.attendance_records
    SET work_minutes = NULLIF(public.attendance_day_total_minutes(v_uid, p_date, v_now), 0)
    WHERE id = v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
    v_n INTEGER;
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

    UPDATE public.attendance_visit_segments
    SET clock_out_at = v_now,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
    WHERE user_id = v_uid
      AND attendance_date = p_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = p_date
    ) THEN
        SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = p_date;
        INSERT INTO public.attendance_visit_segments (
            user_id, attendance_record_id, attendance_date, visit_number,
            clock_in_at, clock_out_at, work_minutes, notes
        ) VALUES (
            v_uid, v_rec.id, p_date, COALESCE(v_n, 1),
            v_rec.clock_in_at, v_now,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
            'Visit 1 · saved session'
        );
    END IF;

    v_total := public.attendance_day_total_minutes(v_uid, p_date, v_now);

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = v_total
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.attendance_day_total_minutes(UUID, DATE, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(DATE) TO authenticated;

-- Prefer summed visit time over first-in → last-out (which includes breaks).
CREATE OR REPLACE FUNCTION public.get_my_attendance_visits(p_date DATE DEFAULT CURRENT_DATE)
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
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    RETURN QUERY
    SELECT
        vs.id,
        vs.visit_number,
        vs.clock_in_at,
        vs.clock_out_at,
        CASE
            WHEN vs.clock_out_at IS NOT NULL THEN COALESCE(
                vs.work_minutes,
                GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::INTEGER)
            )
            ELSE GREATEST(0, (EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - vs.clock_in_at)) / 60)::INTEGER)
        END,
        vs.site_name,
        vs.notes
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = auth.uid()
      AND vs.attendance_date = p_date
    ORDER BY vs.visit_number ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_visits(DATE) TO authenticated;

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
    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;

    v_target := COALESCE(p_user_id, v_uid);

    IF v_target <> v_uid THEN
        IF v_role = 'manager'::public.user_role THEN
            IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_target AND u.manager_id = v_uid) THEN
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
            ar.clock_in_at AS rin,
            COALESCE(ar.clock_out_at, vis.last_out) AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                ar.clock_in_at,
                COALESCE(ar.clock_out_at, vis.last_out),
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
            SELECT MAX(vs.clock_out_at) AS last_out
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE ar.user_id = v_target
          AND ar.attendance_date BETWEEN v_start AND v_end
    ) q
    ORDER BY q.rdate DESC, q.rin DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_team_attendance_history(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_department_id UUID DEFAULT NULL,
    p_scope TEXT DEFAULT 'self'
)
RETURNS TABLE(
    id UUID,
    user_id UUID,
    employee_name TEXT,
    employee_role TEXT,
    department_name TEXT,
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
    v_role public.user_role;
    v_company UUID;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT u.role, u.company_id INTO v_role, v_company FROM public.users u WHERE u.id = v_uid;
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

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
        q.ruser,
        q.rname,
        q.rrole,
        q.rdept,
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
            ar.user_id AS ruser,
            u.full_name AS rname,
            u.role::TEXT AS rrole,
            d.name AS rdept,
            ar.attendance_date AS rdate,
            ar.status AS rstatus,
            ar.approval_status AS rapproval,
            ar.clock_in_at AS rin,
            COALESCE(ar.clock_out_at, vis.last_out) AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                ar.clock_in_at,
                COALESCE(ar.clock_out_at, vis.last_out),
                ar.work_minutes,
                ar.attendance_source,
                asg.shift_mins
            ) AS rmins,
            COALESCE(ws.name, asg.shift_name) AS rshift,
            ar.notes AS rnotes
        FROM public.attendance_records ar
        JOIN public.users u ON u.id = ar.user_id
        LEFT JOIN public.departments d ON d.id = u.department_id
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
            SELECT MAX(vs.clock_out_at) AS last_out
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE u.company_id = v_company
          AND ar.attendance_date BETWEEN v_start AND v_end
          AND (
              (p_scope = 'self' AND ar.user_id = COALESCE(p_user_id, v_uid))
              OR (
                  p_scope = 'team'
                  AND v_role = 'manager'::public.user_role
                  AND (ar.user_id = v_uid OR u.manager_id = v_uid)
              )
              OR (
                  p_scope = 'department'
                  AND p_department_id IS NOT NULL
                  AND u.department_id = p_department_id
                  AND (
                      public.is_admin(v_uid)
                      OR (
                          v_role = 'manager'::public.user_role
                          AND u.department_id = public.user_department_id(v_uid)
                      )
                  )
              )
              OR (
                  p_scope = 'company'
                  AND public.is_admin(v_uid)
                  AND (p_department_id IS NULL OR u.department_id = p_department_id)
              )
          )
          AND (
              ar.user_id = v_uid
              OR public.is_admin(v_uid)
              OR (v_role = 'manager'::public.user_role AND (u.manager_id = v_uid OR u.id = v_uid))
              OR (v_role = 'manager'::public.user_role AND p_scope = 'department' AND u.department_id = public.user_department_id(v_uid))
          )
    ) q
    ORDER BY q.rdate DESC, q.rname, q.rin DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_attendance_history(INTEGER, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_attendance_history(INTEGER, INTEGER, UUID, UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.trg_attendance_use_session_minutes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_seg INTEGER;
BEGIN
    v_seg := public.attendance_day_total_minutes(NEW.user_id, NEW.attendance_date);
    IF v_seg > 0 THEN
        NEW.work_minutes := v_seg;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_use_session_minutes ON public.attendance_records;
CREATE TRIGGER trg_attendance_use_session_minutes
BEFORE INSERT OR UPDATE OF work_minutes, clock_out_at, clock_in_at ON public.attendance_records
FOR EACH ROW
EXECUTE PROCEDURE public.trg_attendance_use_session_minutes();

NOTIFY pgrst, 'reload schema';
