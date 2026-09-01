-- Pause an assigned task. Calendar days paused (Asia/Karachi) are added to the due date on resume.

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pause_days INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS paused_by UUID;

CREATE OR REPLACE FUNCTION public.kpi_pause_calendar_days(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
    SELECT GREATEST(0, (
        (p_to AT TIME ZONE 'Asia/Karachi')::DATE
        - (p_from AT TIME ZONE 'Asia/Karachi')::DATE
    ));
$$;

CREATE OR REPLACE FUNCTION public.pause_assigned_kpi(p_kpi_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager') THEN
        RAISE EXCEPTION 'Only admins and managers can pause a task';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
    END IF;

    IF NOT public.can_assign_kpi_to(v_kpi.user_id) THEN
        RAISE EXCEPTION 'Not authorized to pause this task';
    END IF;

    IF v_kpi.completion_status = 'completed' THEN
        RAISE EXCEPTION 'Completed tasks cannot be paused';
    END IF;

    IF v_kpi.paused_at IS NOT NULL THEN
        RETURN jsonb_build_object('paused', true, 'already', true, 'end_date', v_kpi.end_date, 'pause_days', v_kpi.pause_days);
    END IF;

    UPDATE public.kpis SET
        paused_at = timezone('utc'::text, now()),
        paused_by = v_me.id,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    PERFORM public.create_system_notification(
        v_kpi.user_id,
        'Task paused',
        '"' || v_kpi.name || '" is paused. The due date will move forward by the paused days when it resumes.',
        'info'
    );

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
    v_days INTEGER := 0;
    v_end DATE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager') THEN
        RAISE EXCEPTION 'Only admins and managers can resume a task';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
    END IF;

    IF NOT public.can_assign_kpi_to(v_kpi.user_id) THEN
        RAISE EXCEPTION 'Not authorized to resume this task';
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

    PERFORM public.create_system_notification(
        v_kpi.user_id,
        'Task resumed',
        '"' || v_kpi.name || '" is active again'
            || CASE WHEN v_days > 0 THEN '. Due date moved forward by ' || v_days::TEXT || ' day(s).' ELSE '.' END,
        'info'
    );

    RETURN jsonb_build_object(
        'paused', false,
        'already', false,
        'end_date', v_kpi.end_date,
        'added_days', v_days,
        'pause_days', COALESCE(v_kpi.pause_days, 0)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_assigned_kpis(p_kpi_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_n INTEGER := 0;
BEGIN
    IF p_kpi_ids IS NULL THEN
        RETURN 0;
    END IF;
    FOREACH v_id IN ARRAY p_kpi_ids LOOP
        BEGIN
            PERFORM public.pause_assigned_kpi(v_id);
            v_n := v_n + 1;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
    RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_employee_kpi_progress(p_kpi_id UUID, p_progress TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_progress TEXT := lower(trim(COALESCE(p_progress, '')));
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
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_pause_calendar_days(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pause_assigned_kpi(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resume_assigned_kpi(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pause_assigned_kpis(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
