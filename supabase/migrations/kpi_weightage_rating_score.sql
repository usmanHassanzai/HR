-- KPI score = sum of (weightage × rating multiplier).
-- Achieved / Always on Time / Good / On Time → 100% of weight
-- Partially Achieved / Average / Behaves Well → 50% of weight
-- Not Achieved / Always Late / Behaves Not Good / Poor / Late → 0%

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

UPDATE public.kpis k
SET supervisor_score_pct = public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating),
    current_value = public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating),
    status = CASE
        WHEN public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating) >= 80 THEN 'on_track'::kpi_status_type
        WHEN public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating) >= 40 THEN 'at_risk'::kpi_status_type
        ELSE 'off_track'::kpi_status_type
    END
WHERE k.manager_rating IS NOT NULL
  AND public.kpi_rating_score(COALESCE(k.kpi_category, 'monthly_goal'), k.manager_rating) IS NOT NULL;

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total NUMERIC := 0;
    kpi_row public.kpis%ROWTYPE;
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
        IF emp_score IS NULL THEN
            CONTINUE;
        END IF;
        v_total := v_total + ROUND((emp_score / 100.0) * COALESCE(kpi_row.weight, 0), 2);
    END LOOP;
    RETURN ROUND(v_total, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.user_month_kpi_score(p_user_id UUID, p_month DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH bounds AS (
        SELECT date_trunc('month', p_month)::DATE AS m0,
               (date_trunc('month', p_month) + INTERVAL '1 month - 1 day')::DATE AS m1
    ),
    scored AS (
        SELECT
            COALESCE(k.weight, 0)::NUMERIC AS w,
            COALESCE(
                public.kpi_rating_score(k.kpi_category, k.manager_rating),
                k.supervisor_score_pct
            )::NUMERIC AS s
        FROM public.kpis k, bounds b
        WHERE k.user_id = p_user_id
          AND (k.start_date IS NULL OR k.start_date <= b.m1)
          AND (k.end_date IS NULL OR k.end_date >= b.m0)
          AND COALESCE(k.weight, 0) > 0
    )
    SELECT CASE
        WHEN COUNT(*) FILTER (WHERE s IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(SUM((COALESCE(s, 0) / 100.0) * w), 2)
    END
    FROM scored;
$$;

UPDATE public.users u
SET health_score = public.calculate_user_health_score(u.id),
    health_score_updated_at = timezone('utc'::text, now());

GRANT EXECUTE ON FUNCTION public.calculate_user_health_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_month_kpi_score(UUID, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
