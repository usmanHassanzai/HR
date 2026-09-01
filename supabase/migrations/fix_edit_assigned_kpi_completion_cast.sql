-- completion_status is kpi_completion_status, not text. Cast so weight edits save.

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
    v_health NUMERIC;
    v_role_label TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager') THEN
        RAISE EXCEPTION 'Only admins and managers can edit assigned tasks';
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

    IF p_score_pct IS NULL OR p_score_pct < 0 OR p_score_pct > 100 THEN
        RAISE EXCEPTION 'KPI score must be between 0%% and 100%%';
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

    IF p_completion_status NOT IN ('pending', 'completed') THEN
        RAISE EXCEPTION 'Invalid completion status';
    END IF;

    v_new_status := p_status::public.kpi_status_type;
    v_new_completion := p_completion_status;
    v_score := ROUND(p_score_pct, 2);
    v_role_label := CASE WHEN v_me.role = 'admin' THEN 'Admin' ELSE 'Manager' END;

    IF v_new_completion = 'pending' THEN
        SELECT COALESCE(SUM(weight), 0) INTO v_other_pending
        FROM public.kpis
        WHERE user_id = v_kpi.user_id
          AND id IS DISTINCT FROM v_kpi.id
          AND completion_status::TEXT IS DISTINCT FROM 'completed';

        IF v_other_pending + p_weight > 100.05 THEN
            RAISE EXCEPTION 'This employee''s pending KPI weights cannot exceed 100%% (other tasks % + this %).',
                ROUND(v_other_pending, 2), ROUND(p_weight, 2);
        END IF;
    END IF;

    IF ROUND(COALESCE(v_kpi.weight, 0), 2) IS DISTINCT FROM ROUND(p_weight, 2) THEN
        v_changes := v_changes || jsonb_build_object('weight', jsonb_build_object('from', v_kpi.weight, 'to', p_weight));
    END IF;
    IF ROUND(COALESCE(v_kpi.supervisor_score_pct, public.kpi_employee_score_pct(v_kpi)), 2) IS DISTINCT FROM v_score THEN
        v_changes := v_changes || jsonb_build_object(
            'score_pct',
            jsonb_build_object('from', public.kpi_employee_score_pct(v_kpi), 'to', v_score)
        );
    END IF;
    IF v_kpi.end_date IS DISTINCT FROM p_end_date THEN
        v_changes := v_changes || jsonb_build_object('end_date', jsonb_build_object('from', v_kpi.end_date, 'to', p_end_date));
    END IF;
    IF v_kpi.status::TEXT IS DISTINCT FROM p_status THEN
        v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', v_kpi.status, 'to', p_status));
    END IF;
    IF COALESCE(v_kpi.completion_status::TEXT, 'pending') IS DISTINCT FROM v_new_completion THEN
        v_changes := v_changes || jsonb_build_object(
            'completion_status',
            jsonb_build_object('from', COALESCE(v_kpi.completion_status::TEXT, 'pending'), 'to', v_new_completion)
        );
    END IF;

    IF v_changes = '{}'::jsonb THEN
        RETURN jsonb_build_object(
            'updated', false,
            'weight', v_kpi.weight,
            'overall_score', public.calculate_user_health_score(v_kpi.user_id)
        );
    END IF;

    UPDATE public.kpis SET
        weight = p_weight,
        supervisor_score_pct = v_score,
        current_value = v_score,
        target_value = 100,
        end_date = p_end_date,
        status = v_new_status,
        completion_status = v_new_completion::public.kpi_completion_status,
        completed_at = CASE
            WHEN v_new_completion = 'completed' THEN COALESCE(completed_at, timezone('utc'::text, now()))
            ELSE NULL
        END,
        last_edited_by_name = v_me.full_name,
        last_edited_by_role = v_role_label,
        last_edited_at = timezone('utc'::text, now()),
        viewed_at = NULL,
        viewed_by = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_kpi.id;

    INSERT INTO public.kpi_assignment_edits (
        kpi_id, employee_id, editor_id, company_id, changes, editor_name, editor_role
    ) VALUES (
        v_kpi.id, v_kpi.user_id, auth.uid(), v_emp.company_id, v_changes, v_me.full_name, v_role_label
    );

    v_health := public.calculate_user_health_score(v_kpi.user_id);

    UPDATE public.users SET
        previous_health_score = health_score,
        health_score = v_health,
        health_score_updated_at = timezone('utc'::text, now())
    WHERE id = v_kpi.user_id;

    RETURN jsonb_build_object(
        'updated', true,
        'weight', p_weight,
        'overall_score', v_health,
        'editor_name', v_me.full_name,
        'editor_role', v_role_label,
        'edited_at', timezone('utc'::text, now()),
        'changes', v_changes
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
