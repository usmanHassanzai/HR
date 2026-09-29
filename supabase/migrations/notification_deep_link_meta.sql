-- Notification deep-link meta: store entity hints and pass them from key creators.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.notifications.meta IS
  'Deep-link payload: kind, kpiId, userId, leaveId, awardId, redemptionId, reportId, search, desk, adminTab, rewardsTab';

DROP FUNCTION IF EXISTS public.create_system_notification(UUID, TEXT, TEXT, public.notification_type);

CREATE OR REPLACE FUNCTION public.create_system_notification(
    p_user_id UUID,
    p_title TEXT,
    p_message TEXT,
    p_type public.notification_type DEFAULT 'info'::public.notification_type,
    p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, meta)
    VALUES (
        p_user_id,
        p_title,
        p_message,
        COALESCE(p_type, 'info'::public.notification_type),
        COALESCE(p_meta, '{}'::jsonb)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_system_notification(UUID, TEXT, TEXT, public.notification_type, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_system_notification(UUID, TEXT, TEXT, public.notification_type, JSONB) TO service_role;

DROP FUNCTION IF EXISTS public.notify_company_award_staff(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.notify_company_award_staff(
    p_company_id UUID,
    p_title TEXT,
    p_message TEXT,
    p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID;
BEGIN
    FOR v_uid IN
        SELECT u.id
        FROM public.users u
        WHERE u.company_id = p_company_id
          AND u.is_demo = false
          AND COALESCE(u.is_platform_owner, false) = false
          AND u.role::text IN ('admin', 'hr')
    LOOP
        PERFORM public.create_system_notification(
            v_uid, p_title, p_message, 'alert', COALESCE(p_meta, '{}'::jsonb)
        );
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_company_award_staff(UUID, TEXT, TEXT, JSONB) TO authenticated;


CREATE OR REPLACE FUNCTION public.assign_employee_kpi(p_employee_id uuid, p_kpi_name text, p_description text DEFAULT NULL::text, p_weight numeric DEFAULT 10, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_category text DEFAULT 'monthly_goal'::text, p_assigned_score numeric DEFAULT NULL::numeric, p_late_penalty_enabled boolean DEFAULT false, p_late_penalty_type text DEFAULT 'percentage_cut'::text, p_late_penalty_value numeric DEFAULT 50, p_late_penalty_grace_days integer DEFAULT 0)
 RETURNS TABLE(employee_email text, employee_name text, kpi_id uuid, kpi_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'info',
        jsonb_build_object('kind', 'kpi', 'kpiId', v_kpi_id, 'userId', p_employee_id)
    );

    RETURN QUERY SELECT v_email, COALESCE(v_emp_name, 'Employee'), v_kpi_id, v_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_employee_kpi_progress(p_kpi_id uuid, p_progress text)
 RETURNS TABLE(recipient_email text, recipient_name text, recipient_kind text, kpi_name text, employee_name text, due_date text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'info',
            jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_kpi.user_id, 'search', COALESCE(v_emp_name, ''), 'desk', 'board')
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
            'info',
            jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_kpi.user_id, 'search', COALESCE(v_emp_name, ''), 'desk', 'board')
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
$function$;

CREATE OR REPLACE FUNCTION public.review_kpi_completion(p_kpi_id uuid, p_final_score numeric, p_approve boolean DEFAULT true, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'alert',
            jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_emp.id)
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
        'info',
        jsonb_build_object('kind', 'kpi', 'kpiId', p_kpi_id, 'userId', v_emp.id)
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_leave_request(p_leave_type leave_type, p_start date, p_end date, p_reason text DEFAULT NULL::text, p_custom_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
    v_emp_name TEXT;
    v_role public.user_role;
    v_custom TEXT := NULLIF(btrim(COALESCE(p_custom_type, '')), '');
    v_label TEXT;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    IF p_leave_type = 'other' THEN
        IF v_custom IS NULL THEN
            RAISE EXCEPTION 'Please write the type of leave';
        END IF;
        IF char_length(v_custom) > 80 THEN
            RAISE EXCEPTION 'Leave type must be 80 characters or fewer';
        END IF;
    ELSE
        v_custom := NULL;
    END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    SELECT full_name, role, manager_id INTO v_emp_name, v_role, v_mgr FROM public.users WHERE id = auth.uid();

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason, leave_custom_type)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason, v_custom)
    RETURNING id INTO v_id;

    v_label := CASE
        WHEN p_leave_type = 'other' THEN v_custom
        ELSE p_leave_type::TEXT
    END;

    IF v_mgr IS NOT NULL THEN
        SELECT email, full_name INTO v_mgr_email, v_mgr_name FROM public.users WHERE id = v_mgr;
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            v_emp_name || ' requested ' || v_label || ' leave (' || v_days || ' days).',
            'info'::notification_type,
            jsonb_build_object('kind', 'leave', 'leaveId', v_id, 'userId', auth.uid(), 'search', COALESCE(v_emp_name, ''), 'adminTab', 'leave')
        );
    END IF;

    IF v_role = 'manager' THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            v_emp_name || ' requested ' || v_label || ' leave.',
            'info'::notification_type,
            jsonb_build_object('kind', 'leave', 'leaveId', v_id, 'userId', auth.uid(), 'search', COALESCE(v_emp_name, ''), 'adminTab', 'leave')
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;

    RETURN jsonb_build_object(
        'request_id', v_id,
        'employee_name', v_emp_name,
        'leave_type', p_leave_type,
        'leave_custom_type', v_custom,
        'start_date', p_start,
        'end_date', p_end,
        'days_count', v_days,
        'reason', p_reason,
        'requester_role', v_role,
        'manager_email', v_mgr_email,
        'manager_name', v_mgr_name,
        'admin_recipients', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email, 'name', full_name)), '[]'::jsonb)
            FROM public.users WHERE role = 'admin'
        )
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id uuid, p_approve boolean, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
    v_label TEXT;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    IF to_regprocedure('public.enforce_demo_isolation(uuid)') IS NOT NULL THEN
        PERFORM public.enforce_demo_isolation(req.user_id);
    END IF;
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;

    IF req_role = 'manager' THEN
        IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Manager leave must be approved by admin'; END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;

    v_label := CASE
        WHEN req.leave_type = 'other' THEN COALESCE(NULLIF(btrim(req.leave_custom_type), ''), 'other')
        ELSE req.leave_type::TEXT
    END;

    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSIF req.leave_type = 'sick' THEN
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || v_label
        FROM generate_series(req.start_date, req.end_date, '1 day'::interval) d
        WHERE EXTRACT(ISODOW FROM d) < 6
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent', approval_status = 'approved', notes = EXCLUDED.notes, reviewed_by = auth.uid(), reviewed_at = now();
    END IF;

    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = p_notes
    WHERE id = p_request_id;

    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || v_label || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END,
        jsonb_build_object('kind', 'leave', 'leaveId', p_request_id, 'userId', req.user_id, 'adminTab', 'leave')
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_daily_work_report(p_content text, p_report_date date DEFAULT NULL::date)
 RETURNS daily_work_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_role public.user_role;
  v_date DATE := COALESCE(p_report_date, (timezone('utc', now()))::date);
  v_trimmed TEXT := trim(COALESCE(p_content, ''));
  v_row public.daily_work_reports;
  v_existed BOOLEAN := false;
  v_company_id UUID;
  v_name TEXT;
  v_role_label TEXT;
  v_title TEXT;
  v_message TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, company_id, full_name
  INTO v_role, v_company_id, v_name
  FROM public.users
  WHERE id = v_uid;

  IF v_role IS NULL OR v_role = 'admin'::public.user_role THEN
    RAISE EXCEPTION 'Only employees and managers can submit daily work reports';
  END IF;

  IF char_length(v_trimmed) < 20 THEN
    RAISE EXCEPTION 'Please write at least 20 characters describing your work today';
  END IF;

  IF char_length(v_trimmed) > 8000 THEN
    RAISE EXCEPTION 'Report is too long (max 8000 characters)';
  END IF;

  IF v_date > (timezone('utc', now()))::date THEN
    RAISE EXCEPTION 'Cannot submit a report for a future date';
  END IF;

  IF v_date < (timezone('utc', now()))::date - 7 THEN
    RAISE EXCEPTION 'Reports can only be submitted or updated for the last 7 days';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.daily_work_reports r
    WHERE r.user_id = v_uid
      AND r.report_date = v_date
  ) INTO v_existed;

  INSERT INTO public.daily_work_reports (user_id, report_date, content, submitted_at, updated_at)
  VALUES (v_uid, v_date, v_trimmed, timezone('utc', now()), timezone('utc', now()))
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET content = EXCLUDED.content,
        updated_at = timezone('utc', now())
  RETURNING * INTO v_row;

  v_role_label := CASE
    WHEN v_role = 'manager'::public.user_role THEN 'Manager'
    ELSE 'Employee'
  END;

  IF v_existed THEN
    v_title := 'Daily report updated';
    v_message := COALESCE(v_name, 'A team member') || ' (' || v_role_label || ') updated their daily report for '
      || to_char(v_date, 'Mon DD, YYYY')
      || '. Open Daily Reports to review.';
  ELSE
    v_title := 'New daily report';
    v_message := COALESCE(v_name, 'A team member') || ' (' || v_role_label || ') submitted a daily report for '
      || to_char(v_date, 'Mon DD, YYYY')
      || '. Open Daily Reports to review.';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, meta)
  SELECT a.id, v_title, v_message, 'info'::public.notification_type,
    jsonb_build_object('kind', 'daily_report', 'reportId', v_row.id, 'userId', v_uid, 'search', COALESCE(v_name, ''))
  FROM public.users a
  WHERE a.role = 'admin'::public.user_role
    AND a.company_id IS NOT DISTINCT FROM v_company_id
    AND a.id <> v_uid;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_my_kpi_award(p_rule_key text, p_use_banked boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_key TEXT := lower(trim(COALESCE(p_rule_key, '')));
    v_earned NUMERIC;
    v_available NUMERIC;
    v_bank NUMERIC;
    v_streak INTEGER;
    v_gift_max NUMERIC;
    v_name TEXT;
    v_detail TEXT;
    v_months INTEGER;
    v_cost NUMERIC;
    v_id UUID;
    v_existing UUID;
    v_leftover NUMERIC := 0;
    v_use_bank BOOLEAN := COALESCE(p_use_banked, false);
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF v_key NOT IN ('movie_tickets', 'dinner_voucher', 'surprise_gift') THEN
        RAISE EXCEPTION 'Unknown reward';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND OR v_me.company_id IS NULL THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    IF v_me.role::text NOT IN ('employee', 'manager') THEN
        RAISE EXCEPTION 'Only employees and managers can redeem company gifts';
    END IF;

    v_cfg := public.ensure_kpi_award_config(v_me.company_id);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 95);
    v_earned := public.kpi_award_month_score(v_uid, v_month);
    v_available := public.get_available_weightage(v_uid, v_month);
    v_bank := public.get_banked_weightage(v_uid);

    -- Only block a duplicate open request; finished claims do not lock the month.
    SELECT q.id INTO v_existing
    FROM public.kpi_award_qualifications q
    WHERE q.employee_id = v_uid
      AND q.rule_key = v_key
      AND q.period_end = v_month
      AND q.status IN ('pending', 'approved', 'pending_fulfillment')
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    IF v_key = 'dinner_voucher' THEN
        -- No one-monthly-gift lock — weightage balance is the only gate.
        v_cost := v_cfg.dinner_min_pct;
        v_name := v_cfg.dinner_reward_name;
        v_months := 1;

        IF v_use_bank THEN
            IF v_bank < v_cost THEN
                RAISE EXCEPTION 'Need at least % banked weightage (you have % banked)',
                    trim(to_char(v_cost, 'FM999990.#######')) || '%',
                    trim(to_char(v_bank, 'FM999990.#######')) || '%';
            END IF;
            v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
                || ' — paid ' || round(v_cost, 2)::TEXT || '% from banked weightage.';
        ELSE
            IF NOT public.kpi_award_in_band(v_available, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
                RAISE EXCEPTION 'You need %–% available weightage this month (you have % available). Or redeem with banked if you have enough.',
                    trim(to_char(v_cfg.dinner_min_pct, 'FM999990.#######')),
                    trim(to_char(v_cfg.dinner_max_pct, 'FM999990.#######')),
                    trim(to_char(COALESCE(v_available, 0), 'FM999990.#######')) || '%';
            END IF;
            v_leftover := GREATEST(0, ROUND(COALESCE(v_available, 0) - v_cost, 2));
            v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
                || ' — used ' || round(COALESCE(v_cost, 0), 2)::TEXT || '% weightage in '
                || to_char(v_month, 'Mon YYYY')
                || CASE
                    WHEN v_leftover > 0 THEN
                        '; ' || round(v_leftover, 2)::TEXT || '% moved to banked.'
                    ELSE '.'
                END;
        END IF;
    ELSIF v_key = 'movie_tickets' THEN
        IF v_use_bank THEN
            RAISE EXCEPTION 'Streak gifts do not use banked weightage';
        END IF;
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets'
        );
        IF v_streak < v_cfg.movie_months THEN
            RAISE EXCEPTION 'Keep earned weightage at %–% for % months in a row first',
                trim(to_char(v_cfg.movie_min_pct, 'FM999990.#######')),
                trim(to_char(v_cfg.movie_max_pct, 'FM999990.#######')),
                v_cfg.movie_months;
        END IF;
        v_name := v_cfg.movie_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
            || '% weightage for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
    ELSE
        IF v_use_bank THEN
            RAISE EXCEPTION 'Streak gifts do not use banked weightage';
        END IF;
        IF public.has_month_streak_gift_claim(v_uid, v_month) THEN
            RAISE EXCEPTION 'You already redeemed a 3-month or 6-month gift this month';
        END IF;
        v_streak := public.kpi_award_consecutive_months(
            v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift'
        );
        IF v_streak < v_cfg.gift_months THEN
            RAISE EXCEPTION 'Keep earned weightage at %–% for % months in a row first',
                trim(to_char(v_cfg.gift_min_pct, 'FM999990.#######')),
                trim(to_char(v_gift_max, 'FM999990.#######')),
                v_cfg.gift_months;
        END IF;
        v_name := v_cfg.gift_reward_name;
        v_months := v_streak;
        v_cost := 0;
        v_detail := COALESCE(v_me.full_name, 'Employee') || ' requested: ' || v_name
            || ' — ' || v_cfg.gift_min_pct::TEXT || '–' || v_gift_max::TEXT
            || '% weightage for ' || v_cfg.gift_months::TEXT || ' consecutive months.';
    END IF;

    INSERT INTO public.kpi_award_qualifications (
        company_id, employee_id, rule_key, reward_name, detail, period_end,
        months_met, latest_score, weightage_cost, status
    )
    VALUES (
        v_me.company_id, v_uid, v_key, v_name, v_detail, v_month,
        v_months,
        CASE
            WHEN v_key = 'dinner_voucher' AND v_use_bank THEN v_bank
            ELSE COALESCE(v_available, v_earned)
        END,
        v_cost,
        'pending'
    )
    RETURNING id INTO v_id;

    IF v_key = 'dinner_voucher' AND COALESCE(v_cost, 0) > 0 THEN
        IF v_use_bank THEN
            PERFORM public.bank_spend(
                v_uid,
                v_me.company_id,
                v_cost,
                'kpi_award',
                v_id,
                'Redeemed from bank: ' || v_name
            );
        ELSE
            PERFORM public.pay_monthly_gift_weightage(
                v_uid,
                v_me.company_id,
                v_month,
                COALESCE(v_available, 0),
                v_cost,
                'kpi_award',
                v_id,
                'Redeemed: ' || v_name
            );
        END IF;
    END IF;

    PERFORM public.create_system_notification(
        v_uid,
        'Gift request submitted',
        'Your request for ' || v_name || ' was sent for approval.'
            || CASE
                WHEN v_key = 'dinner_voucher' AND v_use_bank THEN
                    ' Paid from banked weightage.'
                WHEN v_key = 'dinner_voucher' AND COALESCE(v_leftover, 0) > 0 THEN
                    ' ' || trim(to_char(v_leftover, 'FM999990.#######'))
                    || '% leftover was moved to your banked weightage.'
                WHEN v_key = 'dinner_voucher' THEN
                    ' Gift cost deducted from this month.'
                ELSE ''
            END,
        'info',
        jsonb_build_object('kind', 'award', 'awardId', v_id, 'userId', v_uid, 'rewardsTab', 'awards')
    );

    PERFORM public.notify_company_award_staff(
        v_me.company_id,
        'Gift request: ' || COALESCE(v_me.full_name, 'Employee'),
        COALESCE(v_detail, 'A gift request was submitted.'),
        jsonb_build_object('kind', 'award', 'awardId', v_id, 'userId', v_uid, 'search', COALESCE(v_me.full_name, ''), 'rewardsTab', 'awards')
    );

    RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_kpi_award_status(p_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_row public.kpi_award_qualifications%ROWTYPE;
    v_status TEXT := lower(trim(COALESCE(p_status, '')));
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
    v_cost NUMERIC;
    v_prev TEXT;
    v_refunded NUMERIC := 0;
BEGIN
    IF v_status IN ('pending_fulfillment') THEN v_status := 'pending'; END IF;
    IF v_status IN ('fulfilled') THEN v_status := 'issued'; END IF;
    IF v_status IN ('rejected', 'reject') THEN v_status := 'dismissed'; END IF;
    IF v_status NOT IN ('pending', 'approved', 'issued', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid status';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.kpi_award_qualifications WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Award not found'; END IF;
    IF v_row.company_id IS DISTINCT FROM public.current_company_id() THEN
        RAISE EXCEPTION 'Award is not in your company';
    END IF;

    IF NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT (
            v_me.role = 'manager'::public.user_role
            AND public.is_manager_of(auth.uid(), v_row.employee_id)
       ) THEN
        RAISE EXCEPTION 'Not authorized to update this milestone';
    END IF;

    v_prev := v_row.status;

    IF v_status = 'dismissed' AND v_prev IN ('issued', 'fulfilled') THEN
        RAISE EXCEPTION 'Cannot reject a gift that was already delivered';
    END IF;

    UPDATE public.kpi_award_qualifications
    SET status = v_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;

    IF v_status = 'dismissed' AND v_prev IS DISTINCT FROM 'dismissed' THEN
        v_refunded := public.refund_weightage_deduction('kpi_award', v_row.id);
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Gift request rejected',
            'Your request for ' || v_row.reward_name || ' was rejected.'
                || CASE
                    WHEN v_refunded > 0 THEN
                        ' ' || trim(to_char(v_refunded, 'FM999990.#######'))
                        || '% weightage was returned.'
                    ELSE ''
                END,
            'warning',
            jsonb_build_object('kind', 'award', 'awardId', p_id, 'userId', v_row.employee_id, 'rewardsTab', 'awards')
        );
        RETURN;
    END IF;

    IF v_status = 'issued' AND v_prev IS DISTINCT FROM 'issued' THEN
        v_cfg := public.ensure_kpi_award_config(v_row.company_id);
        v_cost := COALESCE(
            v_row.weightage_cost,
            CASE v_row.rule_key
                WHEN 'dinner_voucher' THEN v_cfg.dinner_min_pct
                WHEN 'movie_tickets' THEN v_cfg.movie_min_pct
                WHEN 'surprise_gift' THEN v_cfg.gift_min_pct
                ELSE NULL
            END
        );
        IF v_row.rule_key = 'dinner_voucher'
           AND COALESCE(v_cost, 0) > 0
           AND NOT public.gift_weightage_already_paid('kpi_award', v_row.id) THEN
            PERFORM public.record_weightage_deduction(
                v_row.employee_id,
                v_row.company_id,
                v_row.period_end,
                v_cost,
                'kpi_award',
                v_row.id,
                'Fulfilled: ' || v_row.reward_name
            );
        END IF;
        UPDATE public.kpi_award_qualifications
        SET weightage_cost = COALESCE(weightage_cost, v_cost)
        WHERE id = p_id;
    END IF;

    IF v_status IN ('approved', 'issued') THEN
        PERFORM public.create_system_notification(
            v_row.employee_id,
            CASE WHEN v_status = 'issued' THEN 'Milestone fulfilled' ELSE 'Milestone approved' END,
            CASE
                WHEN v_status = 'issued' THEN
                    'Your reward: ' || v_row.reward_name || ' was delivered.'
                ELSE 'Your reward: ' || v_row.reward_name || ' was approved.'
            END,
            'info',
            jsonb_build_object('kind', 'award', 'awardId', p_id, 'userId', v_row.employee_id, 'rewardsTab', 'awards')
        );
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_catalog_redemption_status(p_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_row public.reward_redemptions%ROWTYPE;
    v_item public.rewards_catalog%ROWTYPE;
    v_status TEXT := lower(trim(COALESCE(p_status, '')));
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_cost NUMERIC;
    v_prev TEXT;
    v_month DATE;
    v_refunded NUMERIC := 0;
BEGIN
    IF v_status IN ('dismissed', 'reject') THEN v_status := 'rejected'; END IF;
    IF v_status NOT IN ('pending', 'approved', 'fulfilled', 'rejected') THEN
        RAISE EXCEPTION 'Invalid status';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.reward_redemptions WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Redemption not found'; END IF;
    SELECT * INTO v_emp FROM public.users WHERE id = v_row.employee_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
    IF v_emp.company_id IS DISTINCT FROM public.current_company_id() THEN
        RAISE EXCEPTION 'Redemption is not in your company';
    END IF;

    IF NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT (
            v_me.role = 'manager'::public.user_role
            AND public.is_manager_of(auth.uid(), v_row.employee_id)
       ) THEN
        RAISE EXCEPTION 'Not authorized to update this redemption';
    END IF;

    v_prev := v_row.status;

    IF v_status = 'rejected' AND v_prev = 'fulfilled' THEN
        RAISE EXCEPTION 'Cannot reject a gift that was already delivered';
    END IF;

    UPDATE public.reward_redemptions
    SET status = v_status
    WHERE id = p_id;

    IF v_status = 'rejected' AND v_prev IS DISTINCT FROM 'rejected' THEN
        v_refunded := public.refund_weightage_deduction('catalog', v_row.id);
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward rejected',
            'Your request for ' || COALESCE(v_item.name, 'a catalog reward') || ' was rejected.'
                || CASE
                    WHEN v_refunded > 0 THEN
                        ' ' || trim(to_char(v_refunded, 'FM999990.#######'))
                        || '% weightage was returned.'
                    ELSE ''
                END,
            'warning',
            jsonb_build_object('kind', 'redemption', 'redemptionId', p_id, 'userId', v_row.employee_id, 'rewardsTab', 'redemptions')
        );
        RETURN;
    END IF;

    IF v_status = 'fulfilled' AND v_prev IS DISTINCT FROM 'fulfilled' THEN
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        v_cost := COALESCE(v_row.weightage_cost, v_item.weightage_required, 0);
        v_month := date_trunc('month', (timezone('Asia/Karachi', v_row.redeemed_at))::DATE)::DATE;
        IF COALESCE(v_cost, 0) > 0
           AND NOT public.gift_weightage_already_paid('catalog', v_row.id) THEN
            PERFORM public.record_weightage_deduction(
                v_row.employee_id,
                v_emp.company_id,
                v_month,
                v_cost,
                'catalog',
                v_row.id,
                'Fulfilled catalog: ' || COALESCE(v_item.name, 'reward')
            );
        END IF;
        UPDATE public.reward_redemptions
        SET weightage_cost = COALESCE(weightage_cost, v_cost)
        WHERE id = p_id;

        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward fulfilled',
            'Your reward was delivered.',
            'info',
            jsonb_build_object('kind', 'redemption', 'redemptionId', p_id, 'userId', v_row.employee_id, 'rewardsTab', 'redemptions')
        );
    ELSIF v_status = 'approved' AND v_prev IS DISTINCT FROM 'approved' THEN
        SELECT * INTO v_item FROM public.rewards_catalog WHERE id = v_row.reward_id;
        PERFORM public.create_system_notification(
            v_row.employee_id,
            'Catalog reward approved',
            'Your request for ' || COALESCE(v_item.name, 'a catalog reward') || ' was approved.',
            'info',
            jsonb_build_object('kind', 'redemption', 'redemptionId', p_id, 'userId', v_row.employee_id, 'rewardsTab', 'redemptions')
        );
    END IF;
END;
$function$;

NOTIFY pgrst, 'reload schema';
