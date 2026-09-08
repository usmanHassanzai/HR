-- Direct assigned Score + Achieved/Not Achieved (no category multipliers).
-- Backfill historical scores from old rating multipliers so monthly % stays the same.
-- Milestone awards: streak reset after grant, 85–89.99 movie band, employee notify, manager approve.

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS assigned_score NUMERIC,
    ADD COLUMN IF NOT EXISTS result_status TEXT;

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_result_status_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_result_status_check
    CHECK (result_status IS NULL OR result_status IN ('achieved', 'not_achieved'));

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_assigned_score_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_assigned_score_check
    CHECK (assigned_score IS NULL OR assigned_score >= 0);

-- Keep manager_rating for audit. Fill assigned_score from weight × old multiplier.
UPDATE public.kpis k
SET assigned_score = ROUND(
        COALESCE(k.weight, 0) * (
            COALESCE(
                public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating),
                k.supervisor_score_pct,
                100
            ) / 100.0
        ),
        2
    )
WHERE k.assigned_score IS NULL;

UPDATE public.kpis k
SET assigned_score = COALESCE(k.weight, 0)
WHERE k.assigned_score IS NULL;

UPDATE public.kpis k
SET result_status = CASE
        WHEN k.manager_rating IS NULL AND k.supervisor_score_pct IS NULL THEN NULL
        WHEN COALESCE(
            public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating),
            k.supervisor_score_pct,
            0
        ) <= 0 THEN 'not_achieved'
        ELSE 'achieved'
    END
WHERE k.result_status IS NULL
  AND (k.manager_rating IS NOT NULL OR k.supervisor_score_pct IS NOT NULL);

UPDATE public.kpis k
SET assigned_score = LEAST(COALESCE(k.assigned_score, 0), COALESCE(k.weight, 0))
WHERE k.assigned_score > COALESCE(k.weight, 0);

CREATE OR REPLACE FUNCTION public.kpi_points_awarded(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF k.result_status IS DISTINCT FROM 'achieved' THEN
        RETURN 0;
    END IF;
    RETURN ROUND(LEAST(COALESCE(k.assigned_score, 0), COALESCE(k.weight, 0)), 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_employee_score_pct(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF k.result_status IS NULL THEN
        RETURN NULL;
    END IF;
    IF COALESCE(k.weight, 0) <= 0 THEN
        RETURN 0;
    END IF;
    RETURN ROUND((public.kpi_points_awarded(k) / k.weight) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_points NUMERIC := 0;
    v_weight NUMERIC := 0;
    kpi_row public.kpis%ROWTYPE;
    month_start DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
BEGIN
    FOR kpi_row IN
        SELECT *
        FROM public.kpis
        WHERE user_id = p_user_id
          AND COALESCE(start_date, created_at::DATE) <= (month_start + INTERVAL '1 month - 1 day')::DATE
          AND COALESCE(end_date, start_date, created_at::DATE) >= month_start
    LOOP
        v_weight := v_weight + COALESCE(kpi_row.weight, 0);
        v_points := v_points + public.kpi_points_awarded(kpi_row);
    END LOOP;
    IF v_weight <= 0 THEN
        RETURN 0;
    END IF;
    RETURN ROUND((v_points / v_weight) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.user_month_kpi_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_points NUMERIC := 0;
    v_weight NUMERIC := 0;
    kpi_row public.kpis%ROWTYPE;
    month_start DATE := date_trunc('month', p_month)::DATE;
    month_end DATE := (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE;
BEGIN
    FOR kpi_row IN
        SELECT *
        FROM public.kpis
        WHERE user_id = p_user_id
          AND COALESCE(start_date, created_at::DATE) <= month_end
          AND COALESCE(end_date, start_date, created_at::DATE) >= month_start
    LOOP
        v_weight := v_weight + COALESCE(kpi_row.weight, 0);
        v_points := v_points + public.kpi_points_awarded(kpi_row);
    END LOOP;
    IF v_weight <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN ROUND((v_points / v_weight) * 100, 2);
END;
$$;

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
    v_decided INTEGER := 0;
BEGIN
    SELECT COUNT(*) INTO v_decided
    FROM public.kpis k
    WHERE k.user_id = p_user_id
      AND k.result_status IS NOT NULL
      AND COALESCE(k.start_date, k.created_at::DATE) <= v_month_end
      AND COALESCE(k.end_date, k.start_date, k.created_at::DATE) >= v_month;
    IF COALESCE(v_decided, 0) <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN public.user_month_kpi_score(p_user_id, v_month);
END;
$$;

DROP FUNCTION IF EXISTS public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT);

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
    IF v_score > v_weight THEN
        RAISE EXCEPTION 'Score cannot exceed Weight';
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

DROP FUNCTION IF EXISTS public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.assign_kpi_from_template(
    p_employee_id UUID,
    p_template_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT NULL,
    p_assigned_score NUMERIC DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t public.kpi_templates;
    v_weight NUMERIC;
BEGIN
    SELECT * INTO v_t
    FROM public.kpi_templates t
    WHERE t.id = p_template_id
      AND t.active = true
      AND (
          (public.is_demo_user(auth.uid()) AND t.is_demo = true)
          OR (
              NOT public.is_demo_user(auth.uid())
              AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
              AND t.is_demo = false
          )
      );
    IF v_t.id IS NULL THEN
        RAISE EXCEPTION 'KPI not found. Create it first, then assign.';
    END IF;

    v_weight := COALESCE(p_weight, v_t.weight);

    RETURN QUERY SELECT * FROM public.assign_employee_kpi(
        p_employee_id,
        v_t.name,
        v_t.description,
        v_weight,
        p_start_date,
        p_end_date,
        p_notes,
        v_t.kpi_category,
        COALESCE(p_assigned_score, v_weight)
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
                THEN ROUND((LEAST(COALESCE(assigned_score, 0), weight) / weight) * 100, 2)
            ELSE 0
        END,
        current_value = CASE
            WHEN v_result = 'achieved' AND COALESCE(weight, 0) > 0
                THEN ROUND((LEAST(COALESCE(assigned_score, 0), weight) / weight) * 100, 2)
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
    IF v_progress IN ('in_progress', 'in progress') THEN
        v_progress := 'started';
    END IF;
    IF v_progress NOT IN ('started', 'completed') THEN
        RAISE EXCEPTION 'Choose Started, In Progress, or Completed';
    END IF;

    UPDATE public.kpis SET
        employee_progress = v_progress,
        completion_status = CASE WHEN v_progress = 'completed' THEN 'completed'::public.kpi_completion_status ELSE 'pending'::public.kpi_completion_status END,
        completed_at = CASE WHEN v_progress = 'completed' THEN timezone('utc'::text, now()) ELSE NULL END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id;
END;
$$;

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
    IF v_score > p_weight THEN
        RAISE EXCEPTION 'Score cannot exceed Weight';
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
            WHEN result_status = 'achieved' AND p_weight > 0 THEN ROUND((LEAST(v_score, p_weight) / p_weight) * 100, 2)
            WHEN result_status = 'not_achieved' THEN 0
            ELSE supervisor_score_pct
        END,
        current_value = CASE
            WHEN result_status = 'achieved' AND p_weight > 0 THEN ROUND((LEAST(v_score, p_weight) / p_weight) * 100, 2)
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

-- Milestone config: movie band 85–89.99, gift max 100
ALTER TABLE public.kpi_award_config
    ADD COLUMN IF NOT EXISTS gift_max_pct NUMERIC NOT NULL DEFAULT 100;

UPDATE public.kpi_award_config
SET movie_max_pct = 89.99
WHERE movie_max_pct = 90;

ALTER TABLE public.kpi_award_qualifications DROP CONSTRAINT IF EXISTS kpi_award_qualifications_status_check;
ALTER TABLE public.kpi_award_qualifications ADD CONSTRAINT kpi_award_qualifications_status_check
    CHECK (status IN ('pending', 'pending_fulfillment', 'approved', 'issued', 'fulfilled', 'dismissed'));

UPDATE public.kpi_award_qualifications SET status = 'pending' WHERE status = 'pending_fulfillment';
UPDATE public.kpi_award_qualifications SET status = 'issued' WHERE status = 'fulfilled';

DROP FUNCTION IF EXISTS public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE);

CREATE OR REPLACE FUNCTION public.kpi_award_consecutive_months(
    p_user_id UUID,
    p_min NUMERIC,
    p_max NUMERIC,
    p_from DATE DEFAULT NULL,
    p_rule_key TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cursor DATE := date_trunc(
        'month',
        COALESCE(p_from, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_score NUMERIC;
    v_count INTEGER := 0;
    v_i INTEGER;
    v_last DATE;
BEGIN
    IF p_rule_key IS NOT NULL THEN
        SELECT MAX(period_end) INTO v_last
        FROM public.kpi_award_qualifications
        WHERE employee_id = p_user_id
          AND rule_key = p_rule_key
          AND status IS DISTINCT FROM 'dismissed';
    END IF;

    FOR v_i IN 1..24 LOOP
        IF v_last IS NOT NULL AND v_cursor <= v_last THEN
            EXIT;
        END IF;
        v_score := public.kpi_award_month_score(p_user_id, v_cursor);
        EXIT WHEN NOT public.kpi_award_in_band(v_score, p_min, p_max);
        v_count := v_count + 1;
        v_cursor := (v_cursor - INTERVAL '1 month')::DATE;
    END LOOP;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.evaluate_kpi_awards(p_company_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := COALESCE(p_company_id, public.current_company_id());
    v_cfg public.kpi_award_config;
    v_emp RECORD;
    v_cursor DATE;
    v_score NUMERIC;
    v_streak INTEGER;
    v_inserted INTEGER := 0;
    v_detail TEXT;
    v_id UUID;
    v_gift_max NUMERIC;
BEGIN
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;
    IF auth.uid() IS NOT NULL
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'manager'::public.user_role) THEN
        RAISE EXCEPTION 'Only admins, HR, and managers can run the KPI award check';
    END IF;

    v_cfg := public.ensure_kpi_award_config(v_company);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 100);
    v_cursor := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;

    FOR v_emp IN
        SELECT u.id, u.full_name
        FROM public.users u
        WHERE u.company_id = v_company
          AND u.is_demo = false
          AND COALESCE(u.is_platform_owner, false) = false
          AND u.role::text IN ('employee', 'manager')
    LOOP
        v_score := public.kpi_award_month_score(v_emp.id, v_cursor);

        IF public.kpi_award_in_band(v_score, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.dinner_reward_name
                || ' — ' || round(v_score, 2)::TEXT || '% in ' || to_char(v_cursor, 'Mon YYYY') || '.';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score, status
            )
            VALUES (
                v_company, v_emp.id, 'dinner_voucher', v_cfg.dinner_reward_name, v_detail,
                v_cursor, 1, v_score, 'pending'
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING
            RETURNING id INTO v_id;
            IF v_id IS NOT NULL THEN
                v_inserted := v_inserted + 1;
                PERFORM public.create_system_notification(
                    v_emp.id, '🎉 You''ve earned ' || v_cfg.dinner_reward_name || '!', v_detail, 'info'
                );
                PERFORM public.notify_company_award_staff(v_company, 'Milestone: ' || v_emp.full_name, v_detail);
            END IF;
            v_id := NULL;
        END IF;

        v_streak := public.kpi_award_consecutive_months(
            v_emp.id, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_cursor, 'movie_tickets'
        );
        IF v_streak >= v_cfg.movie_months THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.movie_reward_name
                || ' — ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT
                || '% for ' || v_cfg.movie_months::TEXT || ' consecutive months.';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score, status
            )
            VALUES (
                v_company, v_emp.id, 'movie_tickets', v_cfg.movie_reward_name, v_detail, v_cursor,
                v_streak, public.kpi_award_month_score(v_emp.id, v_cursor), 'pending'
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING
            RETURNING id INTO v_id;
            IF v_id IS NOT NULL THEN
                v_inserted := v_inserted + 1;
                PERFORM public.create_system_notification(
                    v_emp.id, '🎉 You''ve earned ' || v_cfg.movie_reward_name || '!', v_detail, 'info'
                );
                PERFORM public.notify_company_award_staff(v_company, 'Milestone: ' || v_emp.full_name, v_detail);
            END IF;
            v_id := NULL;
        END IF;

        v_streak := public.kpi_award_consecutive_months(
            v_emp.id, v_cfg.gift_min_pct, v_gift_max, v_cursor, 'surprise_gift'
        );
        IF v_streak >= v_cfg.gift_months THEN
            v_detail := v_emp.full_name || ' qualifies for: ' || v_cfg.gift_reward_name
                || ' — ' || v_cfg.gift_min_pct::TEXT || '–' || v_gift_max::TEXT
                || '% for ' || v_cfg.gift_months::TEXT || ' consecutive months.';
            INSERT INTO public.kpi_award_qualifications (
                company_id, employee_id, rule_key, reward_name, detail, period_end, months_met, latest_score, status
            )
            VALUES (
                v_company, v_emp.id, 'surprise_gift', v_cfg.gift_reward_name, v_detail, v_cursor,
                v_streak, public.kpi_award_month_score(v_emp.id, v_cursor), 'pending'
            )
            ON CONFLICT (employee_id, rule_key, period_end) DO NOTHING
            RETURNING id INTO v_id;
            IF v_id IS NOT NULL THEN
                v_inserted := v_inserted + 1;
                PERFORM public.create_system_notification(
                    v_emp.id, '🎉 You''ve earned ' || v_cfg.gift_reward_name || '!', v_detail, 'info'
                );
                PERFORM public.notify_company_award_staff(v_company, 'Milestone: ' || v_emp.full_name, v_detail);
            END IF;
            v_id := NULL;
        END IF;
    END LOOP;

    RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_kpi_award_config(
    p_movie_min NUMERIC,
    p_movie_max NUMERIC,
    p_movie_months INTEGER,
    p_movie_name TEXT,
    p_dinner_min NUMERIC,
    p_dinner_max NUMERIC,
    p_dinner_months INTEGER,
    p_dinner_name TEXT,
    p_gift_min NUMERIC,
    p_gift_months INTEGER,
    p_gift_name TEXT,
    p_gift_max NUMERIC DEFAULT 100
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := public.current_company_id();
BEGIN
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
    IF NOT public.can_manage_org_shifts(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only admins and HR can change award settings';
    END IF;
    IF p_movie_min > p_movie_max OR p_dinner_min > p_dinner_max OR p_gift_min > COALESCE(p_gift_max, 100) THEN
        RAISE EXCEPTION 'Minimum percent cannot be greater than maximum';
    END IF;
    PERFORM public.ensure_kpi_award_config(v_company);
    UPDATE public.kpi_award_config SET
        movie_min_pct = p_movie_min,
        movie_max_pct = p_movie_max,
        movie_months = p_movie_months,
        movie_reward_name = COALESCE(NULLIF(trim(p_movie_name), ''), movie_reward_name),
        dinner_min_pct = p_dinner_min,
        dinner_max_pct = p_dinner_max,
        dinner_months = GREATEST(1, p_dinner_months),
        dinner_reward_name = COALESCE(NULLIF(trim(p_dinner_name), ''), dinner_reward_name),
        gift_min_pct = p_gift_min,
        gift_max_pct = COALESCE(p_gift_max, 100),
        gift_months = p_gift_months,
        gift_reward_name = COALESCE(NULLIF(trim(p_gift_name), ''), gift_reward_name),
        updated_at = timezone('utc'::text, now()),
        updated_by = auth.uid()
    WHERE company_id = v_company;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_kpi_award_status(p_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.kpi_award_qualifications%ROWTYPE;
    v_status TEXT := lower(trim(COALESCE(p_status, '')));
    v_me public.users%ROWTYPE;
BEGIN
    IF v_status IN ('pending_fulfillment') THEN v_status := 'pending'; END IF;
    IF v_status IN ('fulfilled') THEN v_status := 'issued'; END IF;
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

    UPDATE public.kpi_award_qualifications
    SET status = v_status, decided_at = timezone('utc'::text, now()), decided_by = auth.uid()
    WHERE id = p_id;
    IF v_status IN ('approved', 'issued') THEN
        PERFORM public.create_system_notification(
            v_row.employee_id,
            CASE WHEN v_status = 'issued' THEN 'Milestone fulfilled' ELSE 'Milestone approved' END,
            'Your reward: ' || v_row.reward_name,
            'info'
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_award_progress(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (
    rule_key TEXT,
    reward_name TEXT,
    min_pct NUMERIC,
    max_pct NUMERIC,
    required_months INTEGER,
    current_months INTEGER,
    months_to_go INTEGER,
    latest_score NUMERIC,
    progress_pct NUMERIC,
    qualified BOOLEAN,
    hint TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := COALESCE(p_user_id, auth.uid());
    v_company UUID;
    v_cfg public.kpi_award_config;
    v_month DATE := date_trunc('month', (timezone('Asia/Karachi', now()))::DATE)::DATE;
    v_latest NUMERIC;
    v_movie INT;
    v_dinner INT;
    v_gift INT;
    v_gift_max NUMERIC;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;

    SELECT u.company_id INTO v_company FROM public.users u WHERE u.id = v_uid;
    IF v_company IS NULL THEN RETURN; END IF;
    v_cfg := public.ensure_kpi_award_config(v_company);
    v_gift_max := COALESCE(v_cfg.gift_max_pct, 100);
    v_latest := public.kpi_award_month_score(v_uid, v_month);

    v_movie := public.kpi_award_consecutive_months(v_uid, v_cfg.movie_min_pct, v_cfg.movie_max_pct, v_month, 'movie_tickets');
    v_dinner := CASE WHEN public.kpi_award_in_band(v_latest, v_cfg.dinner_min_pct, v_cfg.dinner_max_pct) THEN 1 ELSE 0 END;
    v_gift := public.kpi_award_consecutive_months(v_uid, v_cfg.gift_min_pct, v_gift_max, v_month, 'surprise_gift');

    rule_key := 'movie_tickets';
    reward_name := v_cfg.movie_reward_name;
    min_pct := v_cfg.movie_min_pct;
    max_pct := v_cfg.movie_max_pct;
    required_months := v_cfg.movie_months;
    current_months := LEAST(v_movie, v_cfg.movie_months);
    months_to_go := GREATEST(v_cfg.movie_months - v_movie, 0);
    latest_score := v_latest;
    progress_pct := LEAST(100, ROUND((v_movie::NUMERIC / NULLIF(v_cfg.movie_months, 0)) * 100, 1));
    qualified := v_movie >= v_cfg.movie_months;
    hint := CASE
        WHEN v_movie >= v_cfg.movie_months THEN 'Qualified — waiting for approval.'
        WHEN v_movie = 0 THEN v_cfg.movie_months::TEXT || ' consecutive months at ' || v_cfg.movie_min_pct::TEXT || '–' || v_cfg.movie_max_pct::TEXT || '%.'
        ELSE 'Consistent Good Performer: ' || v_movie::TEXT || '/' || v_cfg.movie_months::TEXT || ' months'
    END;
    RETURN NEXT;

    rule_key := 'dinner_voucher';
    reward_name := v_cfg.dinner_reward_name;
    min_pct := v_cfg.dinner_min_pct;
    max_pct := v_cfg.dinner_max_pct;
    required_months := 1;
    current_months := v_dinner;
    months_to_go := 1 - v_dinner;
    latest_score := v_latest;
    progress_pct := CASE WHEN v_dinner = 1 THEN 100 ELSE LEAST(100, ROUND(COALESCE(v_latest, 0) / NULLIF(v_cfg.dinner_min_pct, 0) * 100, 1)) END;
    qualified := v_dinner = 1;
    hint := CASE
        WHEN v_dinner = 1 THEN 'Outstanding Month — waiting for approval.'
        WHEN v_latest IS NULL THEN 'Score ' || v_cfg.dinner_min_pct::TEXT || '–' || v_cfg.dinner_max_pct::TEXT || '% in one month.'
        ELSE 'This month: ' || round(v_latest, 2)::TEXT || '% (need ' || v_cfg.dinner_min_pct::TEXT || '–' || v_cfg.dinner_max_pct::TEXT || '%).'
    END;
    RETURN NEXT;

    rule_key := 'surprise_gift';
    reward_name := v_cfg.gift_reward_name;
    min_pct := v_cfg.gift_min_pct;
    max_pct := v_gift_max;
    required_months := v_cfg.gift_months;
    current_months := LEAST(v_gift, v_cfg.gift_months);
    months_to_go := GREATEST(v_cfg.gift_months - v_gift, 0);
    latest_score := v_latest;
    progress_pct := LEAST(100, ROUND((v_gift::NUMERIC / NULLIF(v_cfg.gift_months, 0)) * 100, 1));
    qualified := v_gift >= v_cfg.gift_months;
    hint := CASE
        WHEN v_gift >= v_cfg.gift_months THEN 'Elite Consistency — waiting for approval.'
        WHEN v_gift = 0 THEN v_cfg.gift_months::TEXT || ' consecutive months at ' || v_cfg.gift_min_pct::TEXT || '–' || v_gift_max::TEXT || '%.'
        ELSE 'Elite Consistency: ' || v_gift::TEXT || '/' || v_cfg.gift_months::TEXT || ' months'
    END;
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_award_pipeline()
RETURNS TABLE (
    qualification_id UUID,
    employee_id UUID,
    full_name TEXT,
    email TEXT,
    rule_key TEXT,
    reward_name TEXT,
    bucket TEXT,
    detail TEXT,
    current_months INTEGER,
    required_months INTEGER,
    latest_score NUMERIC,
    status TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := public.current_company_id();
    v_me public.users%ROWTYPE;
    v_cfg public.kpi_award_config;
BEGIN
    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.can_manage_org_shifts(auth.uid())
       AND NOT public.is_admin(auth.uid())
       AND v_me.role IS DISTINCT FROM 'manager'::public.user_role THEN
        RAISE EXCEPTION 'Not allowed';
    END IF;
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
    v_cfg := public.ensure_kpi_award_config(v_company);

    RETURN QUERY
    SELECT
        q.id,
        q.employee_id,
        u.full_name,
        u.email,
        q.rule_key,
        q.reward_name,
        'eligible'::TEXT,
        q.detail,
        q.months_met,
        CASE q.rule_key
            WHEN 'movie_tickets' THEN v_cfg.movie_months
            WHEN 'surprise_gift' THEN v_cfg.gift_months
            ELSE 1
        END,
        q.latest_score,
        q.status,
        q.created_at
    FROM public.kpi_award_qualifications q
    JOIN public.users u ON u.id = q.employee_id
    WHERE q.company_id = v_company
      AND q.status IN ('pending', 'pending_fulfillment', 'approved')
      AND (
          public.is_admin(auth.uid())
          OR public.can_manage_org_shifts(auth.uid())
          OR public.is_manager_of(auth.uid(), q.employee_id)
      )
    ORDER BY q.created_at DESC;
END;
$$;

DROP FUNCTION IF EXISTS public.update_kpi_award_config(NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.calculate_monthly_points(p_month DATE DEFAULT date_trunc('month', timezone('Asia/Karachi', now()))::DATE)
RETURNS TABLE(employee TEXT, score NUMERIC, points INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    rec RECORD;
    v_score NUMERIC;
    v_points INTEGER;
    v_company UUID;
    v_month DATE := date_trunc('month', p_month)::DATE;
BEGIN
    IF public.is_demo_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Demo accounts cannot run the monthly points job';
    END IF;

    v_company := public.current_company_id();

    FOR rec IN
        SELECT u.id, u.email, u.full_name
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND u.is_platform_owner IS DISTINCT FROM true
          AND (
              (public.is_demo_user(auth.uid()) AND u.is_demo = true)
              OR (
                  NOT public.is_demo_user(auth.uid())
                  AND COALESCE(u.is_demo, false) = false
                  AND (v_company IS NULL OR u.company_id = v_company)
              )
          )
    LOOP
        v_score := COALESCE(public.user_month_kpi_score(rec.id, v_month), public.calculate_user_health_score(rec.id), 0);
        v_points := public.monthly_points_for_score(v_score);
        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, v_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO UPDATE
        SET kpi_score = EXCLUDED.kpi_score,
            points_earned = EXCLUDED.points_earned;
        IF v_points > 0 THEN
            PERFORM public.create_system_notification(
                rec.id,
                'Monthly Points Awarded',
                'You earned ' || v_points || ' reward points this month (KPI score: ' || round(v_score) || '%).',
                'info'
            );
        END IF;
        employee := COALESCE(rec.full_name, rec.email);
        score := v_score;
        points := v_points;
        RETURN NEXT;
    END LOOP;

    BEGIN
        PERFORM public.evaluate_kpi_awards(v_company);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_monthly_points(DATE) TO authenticated;

-- Recalc stored monthly scores after backfill
UPDATE public.users u
SET health_score = public.calculate_user_health_score(u.id),
    health_score_updated_at = timezone('utc'::text, now())
WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role);

UPDATE public.points_ledger pl
SET kpi_score = COALESCE(public.user_month_kpi_score(pl.employee_id, pl.month), pl.kpi_score),
    points_earned = public.monthly_points_for_score(
        COALESCE(public.user_month_kpi_score(pl.employee_id, pl.month), pl.kpi_score)
    );

GRANT EXECUTE ON FUNCTION public.kpi_points_awarded(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_employee_score_pct(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_user_health_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_month_kpi_score(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_manager_kpi_rating(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_kpi_awards(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_kpi_award_config(NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, NUMERIC, INTEGER, TEXT, NUMERIC, INTEGER, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_kpi_award_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kpi_award_pipeline() TO authenticated;

NOTIFY pgrst, 'reload schema';
