-- Assigned shift for the signed-in person or a teammate a manager/admin can view.
-- Realtime so the employee dashboard updates when hours or working days change.

CREATE OR REPLACE FUNCTION public.get_user_assigned_shift(p_user_id UUID DEFAULT NULL)
RETURNS TABLE(
    shift_id UUID,
    shift_name TEXT,
    start_time TIME,
    end_time TIME,
    grace_minutes INTEGER,
    days_of_week INTEGER[],
    effective_from DATE,
    crosses_midnight BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_date DATE := (timezone(public.app_timezone(), now()))::date;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_uid <> auth.uid()
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), v_uid)
       AND NOT public.can_access_user_data(v_uid) THEN
        RAISE EXCEPTION 'Not authorized to view this shift';
    END IF;

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
$$;

GRANT EXECUTE ON FUNCTION public.get_user_assigned_shift(UUID) TO authenticated;

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
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.get_user_assigned_shift(auth.uid());
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_shift() TO authenticated;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['work_shifts', 'employee_shift_assignments']
    LOOP
        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
