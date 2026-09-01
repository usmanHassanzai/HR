DROP FUNCTION IF EXISTS public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT);

-- Four KPI categories, option-based manager ratings, employee Started/Completed on goals & tasks only.

CREATE TABLE IF NOT EXISTS public.kpi_rating_options (
    category TEXT NOT NULL,
    option_key TEXT NOT NULL,
    label TEXT NOT NULL,
    score_pct NUMERIC NOT NULL CHECK (score_pct >= 0 AND score_pct <= 100),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (category, option_key)
);

INSERT INTO public.kpi_rating_options (category, option_key, label, score_pct, sort_order) VALUES
    ('monthly_goal', 'achieved', 'Achieved', 100, 1),
    ('monthly_goal', 'partially_achieved', 'Partially Achieved', 50, 2),
    ('monthly_goal', 'not_achieved', 'Not Achieved', 0, 3),
    ('quality', 'good', 'Good', 100, 1),
    ('quality', 'average', 'Average', 50, 2),
    ('quality', 'poor', 'Poor', 0, 3),
    ('punctuality_behaviour', 'always_on_time', 'Always on Time', 100, 1),
    ('punctuality_behaviour', 'behaves_well', 'Behaves Well', 50, 2),
    ('punctuality_behaviour', 'always_late', 'Always Late', 0, 3),
    ('punctuality_behaviour', 'behaves_not_good', 'Behaves Not Good', 0, 4),
    ('urgent_tasks', 'on_time', 'On Time', 100, 1),
    ('urgent_tasks', 'late', 'Late', 0, 2)
ON CONFLICT (category, option_key) DO UPDATE
SET label = EXCLUDED.label, score_pct = EXCLUDED.score_pct, sort_order = EXCLUDED.sort_order;

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS kpi_category TEXT,
    ADD COLUMN IF NOT EXISTS employee_progress TEXT,
    ADD COLUMN IF NOT EXISTS manager_rating TEXT;

UPDATE public.kpis SET kpi_category = CASE
    WHEN kpi_category IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN kpi_category
    WHEN lower(COALESCE(category, name, '')) LIKE '%quality%' THEN 'quality'
    WHEN lower(COALESCE(category, name, '')) LIKE '%punctual%' OR lower(COALESCE(category, name, '')) LIKE '%behav%' THEN 'punctuality_behaviour'
    WHEN lower(COALESCE(category, name, '')) LIKE '%urgent%' OR lower(COALESCE(category, name, '')) LIKE '%task%' THEN 'urgent_tasks'
    ELSE 'monthly_goal'
END
WHERE kpi_category IS NULL OR kpi_category NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks');

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_kpi_category_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_kpi_category_check
    CHECK (kpi_category IS NULL OR kpi_category IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks'));

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_employee_progress_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_employee_progress_check
    CHECK (employee_progress IS NULL OR employee_progress IN ('started', 'completed'));

CREATE OR REPLACE FUNCTION public.kpi_rating_score(p_category TEXT, p_rating TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
    SELECT score_pct FROM public.kpi_rating_options
    WHERE category = p_category AND option_key = p_rating
$$;

CREATE OR REPLACE FUNCTION public.get_kpi_rating_options()
RETURNS TABLE (category TEXT, option_key TEXT, label TEXT, score_pct NUMERIC, sort_order INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT category, option_key, label, score_pct, sort_order
    FROM public.kpi_rating_options
    ORDER BY category, sort_order;
$$;

GRANT EXECUTE ON FUNCTION public.get_kpi_rating_options() TO anon, authenticated;
GRANT SELECT ON TABLE public.kpi_rating_options TO authenticated;

ALTER TABLE public.kpi_rating_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_rating_options_select ON public.kpi_rating_options;
CREATE POLICY kpi_rating_options_select ON public.kpi_rating_options
    FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.kpi_employee_score_pct(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v NUMERIC;
BEGIN
    IF k.manager_rating IS NOT NULL THEN
        v := public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating);
        IF v IS NOT NULL THEN
            RETURN ROUND(v, 2);
        END IF;
        IF k.supervisor_score_pct IS NOT NULL THEN
            RETURN LEAST(100, GREATEST(0, ROUND(k.supervisor_score_pct, 2)));
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_num NUMERIC := 0;
    v_den NUMERIC := 0;
    kpi_row RECORD;
    emp_score NUMERIC;
    month_start DATE := (timezone('Asia/Karachi', now()))::DATE;
BEGIN
    month_start := date_trunc('month', month_start)::DATE;
    FOR kpi_row IN
        SELECT *
        FROM public.kpis
        WHERE user_id = p_user_id
          AND COALESCE(start_date, created_at::DATE) <= (month_start + INTERVAL '1 month - 1 day')::DATE
          AND COALESCE(end_date, start_date, created_at::DATE) >= month_start
    LOOP
        emp_score := public.kpi_employee_score_pct(kpi_row);
        IF emp_score IS NULL THEN CONTINUE; END IF;
        v_num := v_num + emp_score * COALESCE(kpi_row.weight, 0);
        v_den := v_den + COALESCE(kpi_row.weight, 0);
    END LOOP;
    IF v_den <= 0 THEN RETURN 0; END IF;
    RETURN ROUND(v_num / v_den, 2);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
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
        RAISE EXCEPTION 'Employee not found';
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

GRANT EXECUTE ON FUNCTION public.kpi_employee_score_pct(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) TO authenticated;

-- Keep the previous 7-argument signature working until the new frontend is deployed.
CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.assign_employee_kpi(
        p_employee_id, p_kpi_name, p_description, p_weight, p_start_date, p_end_date, p_notes, 'monthly_goal'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT) TO authenticated;

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
    IF COALESCE(v_kpi.kpi_category, 'monthly_goal') NOT IN ('monthly_goal', 'urgent_tasks') THEN
        RAISE EXCEPTION 'You can only mark Started or Completed on Monthly Goal and Urgent Tasks';
    END IF;
    IF v_progress NOT IN ('started', 'completed') THEN
        RAISE EXCEPTION 'Choose Started or Completed';
    END IF;

    UPDATE public.kpis SET
        employee_progress = v_progress,
        completion_status = CASE WHEN v_progress = 'completed' THEN 'completed'::public.kpi_completion_status ELSE 'pending'::public.kpi_completion_status END,
        completed_at = CASE WHEN v_progress = 'completed' THEN timezone('utc'::text, now()) ELSE NULL END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;

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
    IF NOT public.is_manager_of(auth.uid(), v_kpi.user_id) AND NOT public.is_admin(auth.uid()) THEN
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

NOTIFY pgrst, 'reload schema';
