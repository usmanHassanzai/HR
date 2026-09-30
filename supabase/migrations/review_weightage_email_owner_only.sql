-- Weightage review: notify ONLY the task owner (employee or manager who owns the KPI).
-- Return their contact so the client can email them — never broadcast to other employees.

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
    v_owner public.users%ROWTYPE;
    v_score NUMERIC;
    v_note TEXT := nullif(btrim(COALESCE(p_note, '')), '');
    v_weight NUMERIC;
    v_score_label TEXT;
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

    -- Owner of the KPI (employee OR manager) — weightage belongs only to them.
    SELECT * INTO v_owner FROM public.users WHERE id = v_kpi.user_id;
    IF v_owner.id IS NULL THEN
        RAISE EXCEPTION 'Person not found';
    END IF;

    IF NOT public.is_admin(auth.uid()) AND NOT public.same_company(v_owner.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'manager'
       AND NOT public.is_manager_of(auth.uid(), v_owner.id)
       AND v_owner.id IS DISTINCT FROM auth.uid() THEN
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

        -- In-app notice only for the owner — never to unrelated employees.
        PERFORM public.create_system_notification(
            v_owner.id,
            'KPI sent back',
            'Your task "' || v_kpi.name || '" was sent back for more work.'
                || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
            'alert',
            jsonb_build_object(
                'kind', 'kpi',
                'kpiId', p_kpi_id,
                'userId', v_owner.id,
                'ownerRole', v_owner.role::text
            )
        );

        BEGIN
            PERFORM public.sync_user_kpi_task_points(v_owner.id);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        RETURN jsonb_build_object(
            'ok', true,
            'approved', false,
            'kpi_id', v_kpi.id,
            'kpi_name', v_kpi.name,
            'completion_status', v_kpi.completion_status,
            'assignee_id', v_owner.id,
            'assignee_email', v_owner.email,
            'assignee_name', v_owner.full_name,
            'assignee_role', v_owner.role::text,
            'reviewer_name', v_me.full_name,
            'note', v_note
        );
    END IF;

    v_weight := GREATEST(COALESCE(v_kpi.weight, 0), 0);
    v_score := ROUND(COALESCE(p_final_score, v_kpi.assigned_score, v_weight, 0)::NUMERIC, 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;
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

    v_score_label := trim(to_char(v_score, 'FM999990.99')) || '%';

    -- Weightage notification goes only to the person who owns this KPI
    -- (employee or manager). Do not notify other people on the team.
    PERFORM public.create_system_notification(
        v_owner.id,
        'Weightage awarded',
        'Your task "' || v_kpi.name || '" was approved with '
            || v_score_label || ' weightage.'
            || CASE WHEN v_note IS NULL THEN '' ELSE ' Note: ' || v_note END,
        'info',
        jsonb_build_object(
            'kind', 'kpi',
            'kpiId', p_kpi_id,
            'userId', v_owner.id,
            'ownerRole', v_owner.role::text
        )
    );

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_owner.id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'approved', true,
        'kpi_id', v_kpi.id,
        'kpi_name', v_kpi.name,
        'assigned_score', v_kpi.assigned_score,
        'completion_status', v_kpi.completion_status,
        'assignee_id', v_owner.id,
        'assignee_email', v_owner.email,
        'assignee_name', v_owner.full_name,
        'assignee_role', v_owner.role::text,
        'reviewer_name', v_me.full_name,
        'note', v_note
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.review_kpi_completion(UUID, NUMERIC, BOOLEAN, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
