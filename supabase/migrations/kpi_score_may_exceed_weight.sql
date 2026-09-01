-- Score may be higher than weight. Manager/admin decide the score.

CREATE OR REPLACE FUNCTION public.kpi_points_awarded(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF k.result_status IS DISTINCT FROM 'achieved' THEN
        RETURN 0;
    END IF;
    RETURN ROUND(GREATEST(COALESCE(k.assigned_score, 0), 0), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_assigned_score NUMERIC DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_emp_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
    v_score NUMERIC;
    v_pending NUMERIC := 0;
    v_name TEXT;
    v_notes TEXT := nullif(btrim(COALESCE(p_notes, '')), '');
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
BEGIN
    IF NOT public.can_assign_kpi_to(p_employee_id) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this person';
    END IF;

    IF v_cat NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN
        v_cat := 'monthly_goal';
    END IF;

    v_name := trim(COALESCE(p_kpi_name, ''));
    IF v_name = '' THEN
        RAISE EXCEPTION 'KPI name is required';
    END IF;

    v_weight := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
    END IF;

    v_score := round(COALESCE(p_assigned_score, v_weight)::NUMERIC, 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Start date and end date are required';
    END IF;
    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date must be on or after start date';
    END IF;

    SELECT u.email, u.full_name, u.department_id
    INTO v_email, v_emp_name, v_dept_id
    FROM public.users u
    WHERE u.id = p_employee_id;

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Person not found';
    END IF;

    IF v_dept_id IS NOT NULL THEN
        SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id;
    END IF;

    SELECT COALESCE(SUM(weight), 0) INTO v_pending
    FROM public.kpis
    WHERE user_id = p_employee_id
      AND completion_status = 'pending';

    IF v_pending + v_weight > 100.05 THEN
        RAISE EXCEPTION 'This person''s open KPI weights cannot exceed 100%% (currently % + %).',
            round(v_pending, 2), v_weight;
    END IF;

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category, kpi_category,
        start_date, end_date, target_value, current_value, weight, assigned_score, direction,
        status, completion_status, redo_count, assignment_notes
    ) VALUES (
        p_employee_id, v_name, NULLIF(trim(COALESCE(p_description, '')), ''),
        v_dept_name, v_dept_id, v_cat, v_cat,
        p_start_date, p_end_date, 100, 0, v_weight, v_score, 'higher_better',
        'on_track', 'pending', 0, v_notes
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI assigned',
        'You were assigned: "' || v_name || '". Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    RETURN QUERY SELECT v_email, COALESCE(v_emp_name, 'Employee'), v_kpi_id, v_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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

    v_score := ROUND(COALESCE(p_score_pct, p_weight), 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
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
    IF ROUND(COALESCE(v_kpi.assigned_score, 0), 2) IS DISTINCT FROM v_score THEN
        v_changes := v_changes || jsonb_build_object('score', jsonb_build_object('from', v_kpi.assigned_score, 'to', v_score));
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
        assigned_score = v_score,
        supervisor_score_pct = CASE
            WHEN result_status = 'achieved' AND p_weight > 0 THEN ROUND((v_score / p_weight) * 100, 2)
            WHEN result_status = 'not_achieved' THEN 0
            ELSE supervisor_score_pct
        END,
        current_value = CASE
            WHEN result_status = 'achieved' AND p_weight > 0 THEN ROUND((v_score / p_weight) * 100, 2)
            WHEN result_status = 'not_achieved' THEN 0
            ELSE current_value
        END,
        end_date = p_end_date,
        status = v_new_status,
        completion_status = v_new_completion::public.kpi_completion_status,
        last_edited_by_name = v_me.full_name,
        last_edited_by_role = v_role_label,
        last_edited_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id;

    INSERT INTO public.kpi_assignment_edits (kpi_id, editor_id, editor_name, editor_role, changes)
    VALUES (p_kpi_id, v_me.id, v_me.full_name, v_role_label, v_changes);

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    v_health := public.calculate_user_health_score(v_kpi.user_id);
    RETURN jsonb_build_object(
        'updated', true,
        'weight', p_weight,
        'assigned_score', v_score,
        'overall_score', v_health,
        'changes', v_changes
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_manager_kpi_rating(p_kpi_id UUID, p_rating TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_rating TEXT := lower(trim(COALESCE(p_rating, '')));
    v_result TEXT;
    v_pct NUMERIC;
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF NOT public.can_rate_assigned_kpi(v_kpi.user_id) THEN
        RAISE EXCEPTION 'Not authorized to rate this KPI';
    END IF;
    IF auth.uid() = v_kpi.user_id AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You cannot mark your own assigned KPI here';
    END IF;

    IF v_rating IN ('achieved', 'good', 'always_on_time', 'on_time', 'partially_achieved', 'average', 'behaves_well') THEN
        v_result := 'achieved';
    ELSIF v_rating IN ('not_achieved', 'poor', 'always_late', 'behaves_not_good', 'late') THEN
        v_result := 'not_achieved';
    ELSE
        RAISE EXCEPTION 'Choose Achieved or Not Achieved';
    END IF;

    UPDATE public.kpis SET
        result_status = v_result,
        manager_rating = v_result,
        supervisor_score_pct = CASE
            WHEN v_result = 'achieved' AND COALESCE(weight, 0) > 0
                THEN ROUND((GREATEST(COALESCE(assigned_score, 0), 0) / weight) * 100, 2)
            ELSE 0
        END,
        current_value = CASE
            WHEN v_result = 'achieved' AND COALESCE(weight, 0) > 0
                THEN ROUND((GREATEST(COALESCE(assigned_score, 0), 0) / weight) * 100, 2)
            ELSE 0
        END,
        status = CASE
            WHEN v_result = 'achieved' THEN 'on_track'::kpi_status_type
            ELSE 'off_track'::kpi_status_type
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    v_pct := public.kpi_employee_score_pct(v_kpi);
    RETURN COALESCE(v_pct, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_points_awarded(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_manager_kpi_rating(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
