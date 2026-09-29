-- Incomplete assigned KPIs can be removed by admin / manager / HR.
-- Their weightage is dropped from the assignee's open budget & dashboards.
-- Fully approved (completed) KPIs stay permanently for history.

CREATE OR REPLACE FUNCTION public.delete_assigned_kpi(p_kpi_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_health NUMERIC;
    v_status TEXT;
    v_weight NUMERIC;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, managers, and HR can remove assigned tasks';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RETURN jsonb_build_object('deleted', false, 'reason', 'not_found');
    END IF;

    v_status := COALESCE(v_kpi.completion_status::TEXT, 'pending');
    IF v_status = 'completed' THEN
        RAISE EXCEPTION
            'Approved tasks cannot be deleted. They stay in history with awarded weightage.';
    END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = v_kpi.user_id;
    IF v_emp.id IS NULL THEN
        RAISE EXCEPTION 'Employee not found';
    END IF;

    IF NOT public.is_admin(auth.uid())
       AND v_me.role IS DISTINCT FROM 'hr'
       AND NOT public.same_company(v_emp.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'hr' AND NOT public.same_company(v_emp.id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'manager'
       AND NOT public.can_assign_kpi_to(v_emp.id)
       AND v_kpi.assigned_by IS DISTINCT FROM auth.uid()
       AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only remove tasks you assigned or for people you can assign to';
    END IF;

    v_weight := COALESCE(v_kpi.weight, 0);

    DELETE FROM public.kpis WHERE id = v_kpi.id;

    -- Recalculate open weight / points so dashboards drop this assignment immediately.
    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    v_health := public.calculate_user_health_score(v_kpi.user_id);

    RETURN jsonb_build_object(
        'deleted', true,
        'kpi_id', v_kpi.id,
        'employee_id', v_kpi.user_id,
        'weight', v_weight,
        'completion_status', v_status,
        'overall_score', v_health
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_assigned_kpi(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
