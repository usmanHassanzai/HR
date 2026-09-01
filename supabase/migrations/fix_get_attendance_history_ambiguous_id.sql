-- Employee history RPC crashed: RETURNS TABLE(id ...) made `WHERE id = v_uid` ambiguous.

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
            COALESCE(ar.clock_in_at, vis.first_in) AS rin,
            COALESCE(ar.clock_out_at, vis.last_out) AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
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
            SELECT
                MIN(vs.clock_in_at) AS first_in,
                MAX(vs.clock_out_at) AS last_out
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

GRANT EXECUTE ON FUNCTION public.get_attendance_history(INTEGER, INTEGER, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
