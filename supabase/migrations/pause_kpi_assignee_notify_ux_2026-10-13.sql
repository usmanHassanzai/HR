-- Pause/resume: professional assignee notify (deep-link meta + assigner name).
-- In-app + desktop Notification via create_system_notification; never roll back on notify failure.

CREATE OR REPLACE FUNCTION public.pause_assigned_kpi(p_kpi_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_role_label TEXT;
    v_who TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, managers, and HR can pause a task';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
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
        RAISE EXCEPTION 'You can only pause tasks you assigned or for people you can assign to';
    END IF;

    IF v_kpi.completion_status = 'completed' THEN
        RAISE EXCEPTION 'Completed tasks cannot be paused';
    END IF;

    IF v_kpi.completion_status = 'pending_review' THEN
        RAISE EXCEPTION 'Tasks awaiting review cannot be paused';
    END IF;

    IF v_kpi.paused_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'paused', true,
            'already', true,
            'end_date', v_kpi.end_date,
            'pause_days', COALESCE(v_kpi.pause_days, 0)
        );
    END IF;

    UPDATE public.kpis SET
        paused_at = timezone('utc'::text, now()),
        paused_by = v_me.id,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    IF v_emp.id IS DISTINCT FROM auth.uid() THEN
        v_role_label := CASE v_me.role::TEXT
            WHEN 'admin' THEN 'Admin'
            WHEN 'hr' THEN 'HR'
            ELSE 'Manager'
        END;
        v_who := COALESCE(NULLIF(trim(v_me.full_name), ''), v_role_label);

        BEGIN
            PERFORM public.create_system_notification(
                v_kpi.user_id,
                'Task paused',
                v_who || ' (' || v_role_label || ') paused "' || v_kpi.name
                    || '". It is moved out of your active work until resumed. '
                    || 'The due date will move forward by the paused days when it resumes.',
                'info',
                jsonb_build_object(
                    'kind', 'kpi',
                    'kpiId', v_kpi.id,
                    'userId', v_kpi.user_id,
                    'search', v_kpi.name
                )
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    RETURN jsonb_build_object(
        'paused', true,
        'already', false,
        'end_date', v_kpi.end_date,
        'pause_days', COALESCE(v_kpi.pause_days, 0)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_assigned_kpi(p_kpi_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_days INTEGER := 0;
    v_end DATE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_role_label TEXT;
    v_who TEXT;
    v_msg TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, managers, and HR can resume a task';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
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
        RAISE EXCEPTION 'You can only resume tasks you assigned or for people you can assign to';
    END IF;

    IF v_kpi.paused_at IS NULL THEN
        RETURN jsonb_build_object(
            'paused', false,
            'already', true,
            'end_date', v_kpi.end_date,
            'added_days', 0,
            'pause_days', COALESCE(v_kpi.pause_days, 0)
        );
    END IF;

    v_days := public.kpi_pause_calendar_days(v_kpi.paused_at, v_now);
    v_end := v_kpi.end_date;
    IF v_end IS NOT NULL AND v_days > 0 THEN
        v_end := v_end + v_days;
    END IF;

    UPDATE public.kpis SET
        end_date = v_end,
        pause_days = COALESCE(pause_days, 0) + v_days,
        paused_at = NULL,
        paused_by = NULL,
        updated_at = v_now
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    IF v_emp.id IS DISTINCT FROM auth.uid() THEN
        v_role_label := CASE v_me.role::TEXT
            WHEN 'admin' THEN 'Admin'
            WHEN 'hr' THEN 'HR'
            ELSE 'Manager'
        END;
        v_who := COALESCE(NULLIF(trim(v_me.full_name), ''), v_role_label);
        v_msg := v_who || ' (' || v_role_label || ') resumed "' || v_kpi.name
            || '". It is active on your My KPIs list again'
            || CASE
                WHEN v_days > 0 THEN '. Due date moved forward by ' || v_days::TEXT || ' day(s).'
                ELSE '.'
            END;

        BEGIN
            PERFORM public.create_system_notification(
                v_kpi.user_id,
                'Task resumed',
                v_msg,
                'info',
                jsonb_build_object(
                    'kind', 'kpi',
                    'kpiId', v_kpi.id,
                    'userId', v_kpi.user_id,
                    'search', v_kpi.name
                )
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    RETURN jsonb_build_object(
        'paused', false,
        'already', false,
        'end_date', v_kpi.end_date,
        'added_days', v_days,
        'pause_days', COALESCE(v_kpi.pause_days, 0)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pause_assigned_kpi(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resume_assigned_kpi(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
