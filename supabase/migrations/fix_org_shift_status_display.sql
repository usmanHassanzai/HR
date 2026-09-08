-- Organization / team shift status: show resolved hours (assignment, team default, or company window).

CREATE OR REPLACE FUNCTION public.get_org_shift_assignments()
RETURNS TABLE(
    user_id UUID,
    full_name TEXT,
    email TEXT,
    employee_role TEXT,
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    effective_from DATE
) AS $$
#variable_conflict use_column
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_today DATE := (timezone(public.app_timezone(), now()))::date;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.can_manage_org_shifts(v_uid) THEN
        RAISE EXCEPTION 'Only admins and HR can view organization shift assignments';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT
            u.id,
            u.full_name,
            u.email,
            u.role::TEXT,
            s.shift_id,
            COALESCE(s.shift_name, 'Company hours'),
            COALESCE(s.start_time, '17:30'::TIME),
            COALESCE(s.end_time, '04:00'::TIME),
            esa.effective_from
        FROM public.users u
        LEFT JOIN LATERAL (
            SELECT *
            FROM public.get_active_shift_for_user(u.id, v_today)
            LIMIT 1
        ) s ON true
        LEFT JOIN LATERAL (
            SELECT esa2.effective_from
            FROM public.employee_shift_assignments esa2
            WHERE esa2.user_id = u.id
              AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
              AND esa2.effective_from <= v_today
              AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
            ORDER BY esa2.effective_from DESC
            LIMIT 1
        ) esa ON true
        WHERE u.is_demo = true
          AND u.role::text IN ('employee', 'manager', 'hr')
        ORDER BY u.role DESC, u.full_name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.full_name,
        u.email,
        u.role::TEXT,
        s.shift_id,
        CASE
            WHEN s.shift_id IS NOT NULL THEN s.shift_name
            ELSE 'Company hours'
        END,
        COALESCE(s.start_time, c.location_window_start, '17:30'::TIME),
        COALESCE(s.end_time, c.location_window_end, '04:00'::TIME),
        esa.effective_from
    FROM public.users u
    JOIN public.companies c ON c.id = u.company_id
    LEFT JOIN LATERAL (
        SELECT *
        FROM public.get_active_shift_for_user(u.id, v_today)
        LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
        SELECT esa2.effective_from
        FROM public.employee_shift_assignments esa2
        WHERE esa2.user_id = u.id
          AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
          AND esa2.effective_from <= v_today
          AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
        ORDER BY esa2.effective_from DESC
        LIMIT 1
    ) esa ON true
    WHERE u.company_id = v_company
      AND u.is_demo = false
      AND u.role::text IN ('employee', 'manager', 'hr')
    ORDER BY u.role DESC, u.full_name;
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
#variable_conflict use_column
DECLARE
    v_uid UUID := auth.uid();
    v_today DATE := (timezone(public.app_timezone(), now()))::date;
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT company_id INTO v_company FROM public.users WHERE id = v_uid;

    RETURN QUERY
    SELECT
        u.id,
        u.full_name,
        u.email,
        s.shift_id,
        CASE
            WHEN s.shift_id IS NOT NULL THEN s.shift_name
            ELSE 'Company hours'
        END,
        COALESCE(
            s.start_time,
            (SELECT c.location_window_start FROM public.companies c WHERE c.id = v_company),
            '17:30'::TIME
        ),
        COALESCE(
            s.end_time,
            (SELECT c.location_window_end FROM public.companies c WHERE c.id = v_company),
            '04:00'::TIME
        ),
        esa.effective_from
    FROM public.users u
    LEFT JOIN LATERAL (
        SELECT *
        FROM public.get_active_shift_for_user(u.id, v_today)
        LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
        SELECT esa2.effective_from
        FROM public.employee_shift_assignments esa2
        WHERE esa2.user_id = u.id
          AND (s.shift_id IS NULL OR esa2.shift_id = s.shift_id)
          AND esa2.effective_from <= v_today
          AND (esa2.effective_to IS NULL OR esa2.effective_to >= v_today)
        ORDER BY esa2.effective_from DESC
        LIMIT 1
    ) esa ON true
    WHERE u.manager_id = v_uid
      AND u.role = 'employee'::public.user_role
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_org_shift_assignments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_shift_assignments() TO authenticated;

NOTIFY pgrst, 'reload schema';
