-- Track who assigned each KPI; notify manager + assigner by email/in-app when completed.

ALTER TABLE public.kpis
  ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kpis_assigned_by ON public.kpis(assigned_by);

CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_assigned_score NUMERIC DEFAULT NULL,
    p_late_penalty_enabled BOOLEAN DEFAULT false,
    p_late_penalty_type TEXT DEFAULT 'percentage_cut',
    p_late_penalty_value NUMERIC DEFAULT 50,
    p_late_penalty_grace_days INTEGER DEFAULT 0
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
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
    v_assigner UUID := auth.uid();
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
    IF v_ptype <> 'percentage_cut' THEN
        RAISE EXCEPTION 'Unsupported late penalty type';
    END IF;
    IF v_pval < 0 OR v_pval > 100 THEN
        RAISE EXCEPTION 'Late penalty value must be between 0 and 100';
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
        status, completion_status, redo_count, assignment_notes, assigned_by,
        late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days
    ) VALUES (
        p_employee_id, v_name, NULLIF(trim(COALESCE(p_description, '')), ''),
        v_dept_name, v_dept_id, v_cat, v_cat,
        p_start_date, p_end_date, 100, 0, v_weight, v_score, 'higher_better',
        'on_track', 'pending', 0, v_notes, v_assigner,
        COALESCE(p_late_penalty_enabled, false), v_ptype, v_pval, v_grace
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

DROP FUNCTION IF EXISTS public.set_employee_kpi_progress(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.set_employee_kpi_progress(p_kpi_id UUID, p_progress TEXT)
RETURNS TABLE(
    recipient_email TEXT,
    recipient_name TEXT,
    recipient_kind TEXT,
    kpi_name TEXT,
    employee_name TEXT,
    due_date TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_progress TEXT := lower(trim(COALESCE(p_progress, '')));
    v_was_complete BOOLEAN;
    v_emp_name TEXT;
    v_mgr_id UUID;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
    v_asg_id UUID;
    v_asg_email TEXT;
    v_asg_name TEXT;
    v_msg TEXT;
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF v_kpi.paused_at IS NOT NULL THEN
        RAISE EXCEPTION 'This task is paused. You can continue after it is resumed.';
    END IF;
    IF v_progress IN ('in_progress', 'in progress') THEN
        v_progress := 'started';
    END IF;
    IF v_progress NOT IN ('started', 'completed') THEN
        RAISE EXCEPTION 'Choose In Progress or Complete';
    END IF;

    v_was_complete := (v_kpi.completion_status = 'completed');

    UPDATE public.kpis SET
        employee_progress = v_progress,
        completion_status = CASE WHEN v_progress = 'completed' THEN 'completed'::public.kpi_completion_status ELSE 'pending'::public.kpi_completion_status END,
        completed_at = CASE WHEN v_progress = 'completed' THEN timezone('utc'::text, now()) ELSE NULL END,
        result_status = NULL,
        manager_rating = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Only notify when newly marked complete (not when reopening or already complete).
    IF v_progress <> 'completed' OR v_was_complete THEN
        RETURN;
    END IF;

    SELECT u.full_name, u.manager_id
    INTO v_emp_name, v_mgr_id
    FROM public.users u
    WHERE u.id = v_kpi.user_id;

    v_msg := COALESCE(v_emp_name, 'Someone') || ' completed KPI: "' || v_kpi.name || '"';

    -- Reporting manager
    IF v_mgr_id IS NOT NULL AND v_mgr_id IS DISTINCT FROM v_kpi.user_id THEN
        SELECT u.email, u.full_name INTO v_mgr_email, v_mgr_name
        FROM public.users u WHERE u.id = v_mgr_id;

        PERFORM public.create_system_notification(
            v_mgr_id,
            'KPI completed',
            v_msg,
            'info'
        );

        IF NULLIF(trim(COALESCE(v_mgr_email, '')), '') IS NOT NULL THEN
            recipient_email := v_mgr_email;
            recipient_name := COALESCE(v_mgr_name, 'Manager');
            recipient_kind := 'manager';
            kpi_name := v_kpi.name;
            employee_name := COALESCE(v_emp_name, 'Employee');
            due_date := COALESCE(v_kpi.end_date::TEXT, '');
            RETURN NEXT;
        END IF;
    END IF;

    -- Person who assigned the KPI (may be admin or manager)
    v_asg_id := v_kpi.assigned_by;
    IF v_asg_id IS NOT NULL
       AND v_asg_id IS DISTINCT FROM v_kpi.user_id
       AND v_asg_id IS DISTINCT FROM v_mgr_id THEN
        SELECT u.email, u.full_name INTO v_asg_email, v_asg_name
        FROM public.users u WHERE u.id = v_asg_id;

        PERFORM public.create_system_notification(
            v_asg_id,
            'KPI completed',
            v_msg || ' (you assigned this task)',
            'info'
        );

        IF NULLIF(trim(COALESCE(v_asg_email, '')), '') IS NOT NULL THEN
            recipient_email := v_asg_email;
            recipient_name := COALESCE(v_asg_name, 'Assigner');
            recipient_kind := 'assigner';
            kpi_name := v_kpi.name;
            employee_name := COALESCE(v_emp_name, 'Employee');
            due_date := COALESCE(v_kpi.end_date::TEXT, '');
            RETURN NEXT;
        END IF;
    ELSIF v_asg_id IS NOT NULL AND v_asg_id IS NOT DISTINCT FROM v_mgr_id THEN
        -- Same person is manager and assigner — already emailed; still tag notify as both in message.
        NULL;
    ELSIF v_asg_id IS NULL AND v_mgr_id IS NULL THEN
        -- Fallback: company admins if no manager/assigner (optional skip — avoid spam)
        NULL;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
