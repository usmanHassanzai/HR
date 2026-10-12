-- Assignee open/view tracking:
-- 1) mark_assigned_kpis_viewed works for any role (employee / manager / HR) when they are kpi.user_id
-- 2) Supervisor edits must not fake "started" / wipe viewed state

CREATE OR REPLACE FUNCTION public.mark_assigned_kpis_viewed(p_kpi_ids UUID[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Any authenticated assignee (employee, manager, HR) may mark their own tasks viewed.
    UPDATE public.kpis
    SET
        viewed_at = CASE
            WHEN viewed_by IS DISTINCT FROM auth.uid() THEN timezone('utc'::text, now())
            ELSE viewed_at
        END,
        viewed_by = auth.uid(),
        employee_progress = CASE
            WHEN COALESCE(employee_progress, '') = 'completed'
              OR completion_status = 'completed' THEN COALESCE(employee_progress, 'completed')
            ELSE 'started'
        END
    WHERE user_id = auth.uid()
      AND (p_kpi_ids IS NULL OR id = ANY(p_kpi_ids))
      AND (
        viewed_by IS DISTINCT FROM auth.uid()
        OR (
          COALESCE(employee_progress, '') NOT IN ('started', 'completed')
          AND completion_status IS DISTINCT FROM 'completed'
        )
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_assigned_kpis_viewed(UUID[]) TO authenticated;

-- Do not coerce employee_progress to 'started' on supervisor edit (that mimicked an open).
CREATE OR REPLACE FUNCTION public.edit_assigned_kpi(
    p_kpi_id UUID,
    p_weight NUMERIC,
    p_score_pct NUMERIC,
    p_end_date DATE,
    p_status TEXT,
    p_completion_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_other_pending NUMERIC := 0;
    v_changes JSONB := '{}'::jsonb;
    v_new_status public.kpi_status_type;
    v_new_completion TEXT;
    v_score NUMERIC;
    v_role_label TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, managers, and HR can edit assigned tasks';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
    END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = v_kpi.user_id;
    IF v_emp.id IS NULL THEN
        RAISE EXCEPTION 'Employee not found';
    END IF;

    IF NOT public.is_admin(auth.uid()) AND NOT public.same_company(v_emp.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'manager' AND NOT public.is_manager_of(auth.uid(), v_emp.id) AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only edit tasks for your team';
    END IF;

    IF p_weight IS NULL OR p_weight < 1 OR p_weight > 100 THEN
        RAISE EXCEPTION 'Weightage must be between 1%% and 100%%';
    END IF;

    v_score := ROUND(COALESCE(p_score_pct, p_weight), 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;
    IF v_score > 100 THEN
        RAISE EXCEPTION 'Score cannot exceed 100';
    END IF;

    IF p_end_date IS NULL THEN
        RAISE EXCEPTION 'Due date is required';
    END IF;

    IF v_kpi.start_date IS NOT NULL AND p_end_date < v_kpi.start_date THEN
        RAISE EXCEPTION 'Due date must be on or after the start date';
    END IF;

    IF p_status NOT IN ('on_track', 'at_risk', 'off_track') THEN
        RAISE EXCEPTION 'Invalid task status';
    END IF;

    v_new_completion := lower(trim(COALESCE(p_completion_status, 'pending')));
    IF v_new_completion NOT IN ('pending', 'pending_review', 'completed') THEN
        RAISE EXCEPTION 'Invalid completion status';
    END IF;

    SELECT COALESCE(SUM(weight), 0) INTO v_other_pending
    FROM public.kpis
    WHERE user_id = v_emp.id
      AND id IS DISTINCT FROM p_kpi_id
      AND completion_status IS DISTINCT FROM 'completed';

    IF v_new_completion IS DISTINCT FROM 'completed' AND v_other_pending + p_weight > 100.05 THEN
        RAISE EXCEPTION 'Open KPI weights cannot exceed 100%%';
    END IF;

    v_new_status := p_status::public.kpi_status_type;

    IF v_kpi.weight IS DISTINCT FROM p_weight THEN
        v_changes := v_changes || jsonb_build_object('weight', jsonb_build_object('from', v_kpi.weight, 'to', p_weight));
    END IF;
    IF COALESCE(v_kpi.assigned_score, v_kpi.weight) IS DISTINCT FROM v_score THEN
        v_changes := v_changes || jsonb_build_object('assigned_score', jsonb_build_object('from', v_kpi.assigned_score, 'to', v_score));
    END IF;
    IF v_kpi.end_date IS DISTINCT FROM p_end_date THEN
        v_changes := v_changes || jsonb_build_object('end_date', jsonb_build_object('from', v_kpi.end_date, 'to', p_end_date));
    END IF;
    IF v_kpi.status::text IS DISTINCT FROM p_status THEN
        v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', v_kpi.status, 'to', p_status));
    END IF;
    IF v_kpi.completion_status::text IS DISTINCT FROM v_new_completion THEN
        v_changes := v_changes || jsonb_build_object('completion_status', jsonb_build_object('from', v_kpi.completion_status, 'to', v_new_completion));
    END IF;

    UPDATE public.kpis SET
        weight = p_weight,
        assigned_score = v_score,
        end_date = p_end_date,
        status = v_new_status,
        completion_status = v_new_completion::public.kpi_completion_status,
        employee_progress = CASE
            WHEN v_new_completion = 'completed' THEN 'completed'
            WHEN v_new_completion = 'pending_review' THEN 'completed'
            ELSE employee_progress
        END,
        completed_at = CASE
            WHEN v_new_completion IN ('completed', 'pending_review') THEN COALESCE(completed_at, timezone('utc'::text, now()))
            ELSE NULL
        END,
        last_edited_by_name = v_me.full_name,
        last_edited_by_role = v_me.role::text,
        last_edited_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    v_role_label := CASE
        WHEN v_me.role = 'admin' THEN 'Admin'
        WHEN v_me.role = 'hr' THEN 'HR'
        ELSE 'Manager'
    END;

    IF v_changes <> '{}'::jsonb THEN
        INSERT INTO public.kpi_assignment_edits (kpi_id, employee_id, editor_id, editor_name, editor_role, changes)
        VALUES (v_kpi.id, v_emp.id, v_me.id, v_me.full_name, v_role_label, v_changes);
    END IF;

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_emp.id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object('ok', true, 'kpi_id', v_kpi.id, 'changes', v_changes);
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
