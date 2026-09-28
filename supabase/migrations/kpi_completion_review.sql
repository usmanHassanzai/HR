-- KPI Complete → pending_review (no weightage/points) → manager/admin/HR awards final score.
-- Requires kpi_completion_review_enum.sql applied first.

-- Open weight budget includes pending + pending_review (everything not fully approved).
CREATE OR REPLACE FUNCTION public.sum_open_kpi_weight(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(weight), 0)
  FROM public.kpis
  WHERE user_id = p_user_id
    AND completion_status IS DISTINCT FROM 'completed';
$$;

-- Earned monthly weightage = sum of reviewer-awarded scores (assigned_score), not raw weight.
CREATE OR REPLACE FUNCTION public.kpi_award_month_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month DATE := date_trunc('month', p_month)::DATE;
    v_month_end DATE := (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE;
    v_total INTEGER := 0;
    v_weight NUMERIC := 0;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_total
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND COALESCE(k.start_date, k.created_at::DATE) <= v_month_end
      AND COALESCE(k.end_date, k.start_date, k.created_at::DATE) >= v_month;

    IF COALESCE(v_total, 0) <= 0 THEN
        RETURN NULL;
    END IF;

    SELECT LEAST(
        100,
        ROUND(COALESCE(SUM(GREATEST(COALESCE(k.assigned_score, k.weight, 0), 0)), 0), 2)
    )
    INTO v_weight
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND k.completion_status = 'completed'
      AND COALESCE(k.start_date, k.created_at::DATE) <= v_month_end
      AND COALESCE(k.end_date, k.start_date, k.created_at::DATE) >= v_month;

    RETURN COALESCE(v_weight, 0);
END;
$$;

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
    v_was_submitted BOOLEAN;
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
    IF v_kpi.completion_status = 'completed' THEN
        RAISE EXCEPTION 'This task is already approved. Weightage has been awarded.';
    END IF;
    IF v_progress IN ('in_progress', 'in progress') THEN
        v_progress := 'started';
    END IF;
    IF v_progress NOT IN ('started', 'completed') THEN
        RAISE EXCEPTION 'Choose In Progress or Complete';
    END IF;

    v_was_submitted := (v_kpi.completion_status = 'pending_review');

    UPDATE public.kpis SET
        employee_progress = v_progress,
        -- Complete only submits for review — weightage stays 0 until approved.
        completion_status = CASE
            WHEN v_progress = 'completed' THEN 'pending_review'::public.kpi_completion_status
            ELSE 'pending'::public.kpi_completion_status
        END,
        completed_at = CASE
            WHEN v_progress = 'completed' THEN COALESCE(completed_at, timezone('utc'::text, now()))
            ELSE NULL
        END,
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

    IF v_progress <> 'completed' OR v_was_submitted THEN
        RETURN;
    END IF;

    SELECT u.full_name, u.manager_id
    INTO v_emp_name, v_mgr_id
    FROM public.users u
    WHERE u.id = v_kpi.user_id;

    v_msg := COALESCE(v_emp_name, 'Someone') || ' submitted KPI for review: "' || v_kpi.name || '"';

    IF v_mgr_id IS NOT NULL AND v_mgr_id IS DISTINCT FROM v_kpi.user_id THEN
        SELECT u.email, u.full_name INTO v_mgr_email, v_mgr_name
        FROM public.users u WHERE u.id = v_mgr_id;

        PERFORM public.create_system_notification(
            v_mgr_id,
            'KPI ready for review',
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

    v_asg_id := v_kpi.assigned_by;
    IF v_asg_id IS NOT NULL
       AND v_asg_id IS DISTINCT FROM v_kpi.user_id
       AND v_asg_id IS DISTINCT FROM v_mgr_id THEN
        SELECT u.email, u.full_name INTO v_asg_email, v_asg_name
        FROM public.users u WHERE u.id = v_asg_id;

        PERFORM public.create_system_notification(
            v_asg_id,
            'KPI ready for review',
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
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_kpi_completion(
    p_kpi_id UUID,
    p_final_score NUMERIC,
    p_approve BOOLEAN DEFAULT true,
    p_note TEXT DEFAULT NULL
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
    v_score NUMERIC;
    v_note TEXT := nullif(btrim(COALESCE(p_note, '')), '');
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL OR v_me.role NOT IN ('admin', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Only admins, managers, and HR can review completed tasks';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
    END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = v_kpi.user_id;
    IF v_emp.id IS NULL THEN
        RAISE EXCEPTION 'Person not found';
    END IF;

    IF NOT public.is_admin(auth.uid()) AND NOT public.same_company(v_emp.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'manager'
       AND NOT public.is_manager_of(auth.uid(), v_emp.id)
       AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only review tasks for your team';
    END IF;

    IF v_kpi.completion_status IS DISTINCT FROM 'pending_review'
       AND NOT (v_kpi.employee_progress = 'completed' AND v_kpi.completion_status = 'pending') THEN
        RAISE EXCEPTION 'This task is not waiting for review';
    END IF;

    IF NOT COALESCE(p_approve, true) THEN
        UPDATE public.kpis SET
            employee_progress = 'started',
            completion_status = 'pending',
            completed_at = NULL,
            result_status = NULL,
            manager_rating = NULL,
            assignment_notes = CASE
                WHEN v_note IS NULL THEN assignment_notes
                ELSE trim(BOTH FROM COALESCE(assignment_notes || E'\n', '') || 'Review note: ' || v_note)
            END,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_kpi_id
        RETURNING * INTO v_kpi;

        PERFORM public.create_system_notification(
            v_emp.id,
            'KPI sent back',
            'Your task "' || v_kpi.name || '" was sent back for more work.'
                || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
            'alert'
        );

        BEGIN
            PERFORM public.sync_user_kpi_task_points(v_emp.id);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        RETURN jsonb_build_object(
            'ok', true,
            'approved', false,
            'kpi_id', v_kpi.id,
            'completion_status', v_kpi.completion_status
        );
    END IF;

    v_score := ROUND(COALESCE(p_final_score, v_kpi.assigned_score, v_kpi.weight, 0)::NUMERIC, 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;
    IF v_score > 100 THEN
        RAISE EXCEPTION 'Score cannot exceed 100';
    END IF;

    UPDATE public.kpis SET
        assigned_score = v_score,
        employee_progress = 'completed',
        completion_status = 'completed',
        completed_at = COALESCE(completed_at, timezone('utc'::text, now())),
        result_status = 'achieved',
        manager_rating = 'achieved',
        last_edited_by_name = v_me.full_name,
        last_edited_by_role = v_me.role::text,
        last_edited_at = timezone('utc'::text, now()),
        assignment_notes = CASE
            WHEN v_note IS NULL THEN assignment_notes
            ELSE trim(BOTH FROM COALESCE(assignment_notes || E'\n', '') || 'Review note: ' || v_note)
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    PERFORM public.create_system_notification(
        v_emp.id,
        'KPI approved',
        'Your task "' || v_kpi.name || '" was approved with '
            || trim(to_char(v_score, '999990.99')) || '% weightage.'
            || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
        'info'
    );

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_emp.id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'approved', true,
        'kpi_id', v_kpi.id,
        'assigned_score', v_kpi.assigned_score,
        'completion_status', v_kpi.completion_status
    );
END;
$$;

-- Keep edit_assigned_kpi able to set pending_review / complete with score.
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
            ELSE COALESCE(employee_progress, 'started')
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

GRANT EXECUTE ON FUNCTION public.sum_open_kpi_weight(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_award_month_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_kpi_completion(UUID, NUMERIC, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

-- Safety net: open weight includes pending_review even if older assign RPCs only sum 'pending'.
CREATE OR REPLACE FUNCTION public.trg_kpis_open_weight_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_open NUMERIC := 0;
BEGIN
    IF NEW.completion_status IS DISTINCT FROM 'completed' THEN
        SELECT COALESCE(SUM(weight), 0) INTO v_open
        FROM public.kpis
        WHERE user_id = NEW.user_id
          AND id IS DISTINCT FROM NEW.id
          AND completion_status IS DISTINCT FROM 'completed';
        IF v_open + COALESCE(NEW.weight, 0) > 100.05 THEN
            RAISE EXCEPTION 'This person''s open KPI weights cannot exceed 100%% (currently % + %).',
                round(v_open, 2), round(COALESCE(NEW.weight, 0), 2);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kpis_open_weight_cap ON public.kpis;
CREATE TRIGGER kpis_open_weight_cap
    BEFORE INSERT OR UPDATE OF weight, completion_status, user_id ON public.kpis
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_kpis_open_weight_cap();

NOTIFY pgrst, 'reload schema';
