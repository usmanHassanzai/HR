-- Earned monthly weightage = sum of completed task weights credited,
-- never more than each task's assigned weight (so 30% assigned cannot show as 100% earned).

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

    -- Credit the reviewed score when set, but never above the task's own weight.
    SELECT LEAST(
        100,
        ROUND(COALESCE(SUM(
            LEAST(
                GREATEST(COALESCE(k.assigned_score, k.weight, 0), 0),
                GREATEST(COALESCE(k.weight, 0), 0)
            )
        ), 0), 2)
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

-- When approving a review, keep awarded score within 0..task weight for gift earning consistency.
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
    v_weight NUMERIC;
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

    v_weight := GREATEST(COALESCE(v_kpi.weight, 0), 0);
    v_score := ROUND(COALESCE(p_final_score, v_kpi.assigned_score, v_weight, 0)::NUMERIC, 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;
    -- Gift weightage for this task cannot exceed the weight that was assigned.
    IF v_score > v_weight THEN
        RAISE EXCEPTION 'Awarded weightage cannot be more than this task''s weight (% ).',
            trim(to_char(v_weight, 'FM999990.#######')) || '%';
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

GRANT EXECUTE ON FUNCTION public.kpi_award_month_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_kpi_completion(UUID, NUMERIC, BOOLEAN, TEXT) TO authenticated;

-- Fix rows where awarded score was saved above the task weight.
UPDATE public.kpis
SET assigned_score = weight
WHERE completion_status = 'completed'
  AND assigned_score IS NOT NULL
  AND weight IS NOT NULL
  AND assigned_score > weight;

NOTIFY pgrst, 'reload schema';
