-- Admin may assign KPIs to any employee or manager in the company.
-- Managers may assign only to employees in their own department.

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
        RETURN v_them.role IN ('employee'::public.user_role, 'manager'::public.user_role);
    END IF;

    IF v_me.role = 'manager'::public.user_role THEN
        RETURN v_them.role = 'employee'::public.user_role
            AND v_me.department_id IS NOT NULL
            AND v_them.department_id IS NOT DISTINCT FROM v_me.department_id;
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_assignable_kpi_people()
RETURNS SETOF public.users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_me public.users%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    RETURN QUERY
        SELECT u.*
        FROM public.users u
        WHERE public.can_assign_kpi_to(u.id)
        ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_assign_kpi_to(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_assignable_kpi_people() TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal'
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_emp_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
    v_pending NUMERIC := 0;
    v_name TEXT;
    v_notes TEXT := nullif(btrim(COALESCE(p_notes, '')), '');
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
BEGIN
    IF NOT public.can_assign_kpi_to(p_employee_id) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this person';
    END IF;

    IF v_cat NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN
        RAISE EXCEPTION 'Choose one of the four KPI categories';
    END IF;

    v_name := trim(COALESCE(p_kpi_name, ''));
    IF v_name = '' THEN
        v_name := CASE v_cat
            WHEN 'monthly_goal' THEN 'Monthly Goal'
            WHEN 'quality' THEN 'Quality'
            WHEN 'punctuality_behaviour' THEN 'Punctuality & Behaviour'
            ELSE 'Urgent Tasks'
        END;
    END IF;

    v_weight := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
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
        start_date, end_date, target_value, current_value, weight, direction,
        status, completion_status, redo_count, assignment_notes
    ) VALUES (
        p_employee_id, v_name, NULLIF(trim(COALESCE(p_description, '')), ''),
        v_dept_name, v_dept_id, v_cat, v_cat,
        p_start_date, p_end_date, 100, 0, v_weight, 'higher_better',
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

GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_manager_kpi_rating(p_kpi_id UUID, p_rating TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_cat TEXT;
    v_score NUMERIC;
    v_rating TEXT := lower(trim(COALESCE(p_rating, '')));
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF NOT public.can_assign_kpi_to(v_kpi.user_id) THEN
        RAISE EXCEPTION 'Not authorized to rate this KPI';
    END IF;
    IF auth.uid() = v_kpi.user_id AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Managers cannot rate their own assigned KPI here';
    END IF;

    v_cat := COALESCE(v_kpi.kpi_category, 'monthly_goal');
    v_score := public.kpi_rating_score(v_cat, v_rating);
    IF v_score IS NULL THEN
        RAISE EXCEPTION 'That option is not valid for this KPI category';
    END IF;

    UPDATE public.kpis SET
        manager_rating = v_rating,
        supervisor_score_pct = v_score,
        current_value = v_score,
        status = CASE
            WHEN v_score >= 80 THEN 'on_track'::kpi_status_type
            WHEN v_score >= 40 THEN 'at_risk'::kpi_status_type
            ELSE 'off_track'::kpi_status_type
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id;

    PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    RETURN v_score;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_manager_kpi_rating(UUID, TEXT) TO authenticated;

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

    IF v_me.role = 'manager' AND NOT public.can_assign_kpi_to(v_emp.id) AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only edit tasks for employees in your department';
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

DROP POLICY IF EXISTS kpi_assignment_edits_select ON public.kpi_assignment_edits;
CREATE POLICY kpi_assignment_edits_select ON public.kpi_assignment_edits
    FOR SELECT TO authenticated
    USING (
        editor_id = auth.uid()
        OR employee_id = auth.uid()
        OR public.is_admin(auth.uid())
        OR public.can_assign_kpi_to(employee_id)
    );

NOTIFY pgrst, 'reload schema';
