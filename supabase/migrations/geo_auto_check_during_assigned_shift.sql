-- Resolve the person's shift on the company calendar (Asia/Karachi), not UTC CURRENT_DATE.
-- New shifts assigned to employees/managers are picked up automatically.

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
DECLARE
    v_uid UUID := auth.uid();
    v_date DATE := (timezone(public.app_timezone(), now()))::date;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    RETURN QUERY
    SELECT
        s.shift_id,
        s.shift_name,
        s.start_time,
        s.end_time,
        s.grace_minutes,
        s.days_of_week,
        COALESCE(esa.effective_from, v_date),
        s.crosses_midnight
    FROM public.get_active_shift_for_user(v_uid, v_date) s
    LEFT JOIN public.employee_shift_assignments esa
        ON esa.user_id = v_uid
        AND esa.shift_id = s.shift_id
        AND esa.effective_from <= v_date
        AND (esa.effective_to IS NULL OR esa.effective_to >= v_date)
    ORDER BY esa.effective_from DESC NULLS LAST
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_shift() TO authenticated;

NOTIFY pgrst, 'reload schema';
