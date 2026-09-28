-- Fix: deleting an assigned KPI must actually remove its weight everywhere.
--
-- Root cause: the "Remove" button in ManagerKpiConfig ran a raw client-side
-- `supabase.from('kpis').delete()`. That is subject to RLS ("Managers can manage
-- team KPIs" USING is_manager_of(auth.uid(), user_id)). But KPIs are assigned via
-- assign_employee_kpi()/assign_kpi_from_template(), which authorize with the
-- broader public.can_assign_kpi_to() (same-department managers, not just direct
-- reports) and run SECURITY DEFINER, bypassing RLS. So a manager could assign a
-- KPI to a same-department employee who is not their direct report, but the raw
-- client DELETE would then match zero rows under RLS — PostgREST returns success
-- with no error, the UI happily refetches, and the "deleted" KPI (and its weight)
-- kept counting in every "assigned weightage" total on the employee/manager
-- dashboards (all of which are computed live from the kpis table).
--
-- Fix: move deletion behind an authorized RPC (same pattern as edit_assigned_kpi),
-- so authorization is consistent and any failure raises a real, visible error
-- instead of silently no-op'ing. After a successful delete we also refresh the
-- cached health score / points_ledger snapshot — but only when the removed task
-- was still pending. Completed/approved tasks already ratcheted their reward
-- weightage into points_ledger; we must not claw that back just because the task
-- row is later deleted, so we skip the resync in that case.

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
        -- Already gone (double click / stale UI) — no-op success, not an error.
        RETURN jsonb_build_object('deleted', false, 'reason', 'not_found');
    END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = v_kpi.user_id;
    IF v_emp.id IS NULL THEN
        RAISE EXCEPTION 'Employee not found';
    END IF;

    IF NOT public.is_admin(auth.uid()) AND NOT public.same_company(v_emp.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    -- Authorization must match assignment: managers who can assign to this person
    -- (same department / can_assign_kpi_to) may also remove the mistaken assignment.
    -- Also allow the original assigner. Admins and HR may remove any task in-company.
    IF v_me.role = 'manager'
       AND NOT public.can_assign_kpi_to(v_emp.id)
       AND v_kpi.assigned_by IS DISTINCT FROM auth.uid()
       AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only remove tasks you assigned or for people you can assign to';
    END IF;

    DELETE FROM public.kpis WHERE id = v_kpi.id;

    -- Pending / pending_review tasks never awarded weightage — refresh cached
    -- score snapshot so dashboards drop this assignment immediately.
    -- Completed/approved tasks already wrote reward weightage into points_ledger;
    -- do not claw that back just because the row was removed later.
    IF COALESCE(v_kpi.completion_status, 'pending') IS DISTINCT FROM 'completed' THEN
        BEGIN
            PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    v_health := public.calculate_user_health_score(v_kpi.user_id);

    RETURN jsonb_build_object(
        'deleted', true,
        'kpi_id', v_kpi.id,
        'employee_id', v_kpi.user_id,
        'weight', v_kpi.weight,
        'completion_status', v_kpi.completion_status,
        'overall_score', v_health
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_assigned_kpi(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
