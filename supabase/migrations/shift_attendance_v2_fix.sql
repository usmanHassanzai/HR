-- Fix plpgsql ambiguity: RETURNS TABLE(id) vs column id

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
