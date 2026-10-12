-- When someone checks out then checks in again during the same shift,
-- history must show clock_out as NULL ("Still present") — not the previous visit's out time.
-- Bug: COALESCE(ar.clock_out_at, vis.last_out) filled in the last closed visit while any visit was open.

CREATE OR REPLACE FUNCTION public.get_attendance_history(
    p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    p_month integer DEFAULT NULL::integer,
    p_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
    id uuid,
    attendance_date date,
    status attendance_status,
    approval_status approval_status,
    clock_in_at timestamp with time zone,
    clock_out_at timestamp with time zone,
    attendance_source text,
    work_minutes integer,
    shift_name text,
    notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
            CASE
                WHEN COALESCE(vis.any_open, false) THEN NULL
                WHEN ar.clock_out_at IS NULL
                     AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                     AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                ELSE COALESCE(ar.clock_out_at, vis.last_out)
            END AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
                CASE
                    WHEN COALESCE(vis.any_open, false) THEN NULL
                    WHEN ar.clock_out_at IS NULL
                         AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                         AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                    ELSE COALESCE(ar.clock_out_at, vis.last_out)
                END,
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
                MAX(vs.clock_out_at) FILTER (WHERE vs.clock_out_at IS NOT NULL) AS last_out,
                BOOL_OR(vs.clock_out_at IS NULL) AS any_open,
                COUNT(*)::INTEGER AS visit_count
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE ar.user_id = v_target
          AND ar.attendance_date BETWEEN v_start AND v_end
    ) q
    ORDER BY q.rdate DESC, q.rin DESC NULLS LAST;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_attendance_history(
    p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    p_month integer DEFAULT NULL::integer,
    p_user_id uuid DEFAULT NULL::uuid,
    p_department_id uuid DEFAULT NULL::uuid,
    p_scope text DEFAULT 'self'::text
)
RETURNS TABLE(
    id uuid,
    user_id uuid,
    employee_name text,
    employee_role text,
    department_name text,
    attendance_date date,
    status attendance_status,
    approval_status approval_status,
    clock_in_at timestamp with time zone,
    clock_out_at timestamp with time zone,
    attendance_source text,
    work_minutes integer,
    shift_name text,
    notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
            COALESCE(ar.clock_in_at, vis.first_in) AS rin,
            CASE
                WHEN COALESCE(vis.any_open, false) THEN NULL
                WHEN ar.clock_out_at IS NULL
                     AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                     AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                ELSE COALESCE(ar.clock_out_at, vis.last_out)
            END AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
                CASE
                    WHEN COALESCE(vis.any_open, false) THEN NULL
                    WHEN ar.clock_out_at IS NULL
                         AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                         AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                    ELSE COALESCE(ar.clock_out_at, vis.last_out)
                END,
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
            SELECT
                MIN(vs.clock_in_at) AS first_in,
                MAX(vs.clock_out_at) FILTER (WHERE vs.clock_out_at IS NOT NULL) AS last_out,
                BOOL_OR(vs.clock_out_at IS NULL) AS any_open,
                COUNT(*)::INTEGER AS visit_count
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_attendance_history(INTEGER, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_attendance_history(INTEGER, INTEGER, UUID, UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
