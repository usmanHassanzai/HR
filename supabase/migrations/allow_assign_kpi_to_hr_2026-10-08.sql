-- Allow org admins (and HR via is_admin) to assign KPI tasks to HR users,
-- so HR can receive and work their own assigned tasks like managers/employees.

CREATE OR REPLACE FUNCTION public.can_assign_kpi_to(p_target_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_me public.users%ROWTYPE;
    v_them public.users%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_target_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_them FROM public.users WHERE id = p_target_id;
    IF v_me.id IS NULL OR v_them.id IS NULL THEN
        RETURN false;
    END IF;
    IF COALESCE(v_me.is_demo, false) IS DISTINCT FROM COALESCE(v_them.is_demo, false) THEN
        RETURN false;
    END IF;
    IF NOT COALESCE(v_me.is_demo, false)
       AND v_me.company_id IS DISTINCT FROM v_them.company_id THEN
        RETURN false;
    END IF;

    IF public.is_admin(auth.uid()) THEN
        RETURN v_them.role IN (
            'employee'::public.user_role,
            'manager'::public.user_role,
            'hr'::public.user_role
        );
    END IF;

    IF v_me.role = 'manager'::public.user_role THEN
        RETURN v_them.role = 'employee'::public.user_role
            AND v_me.department_id IS NOT NULL
            AND v_them.department_id IS NOT DISTINCT FROM v_me.department_id;
    END IF;

    RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_assign_kpi_to(UUID) TO authenticated;
