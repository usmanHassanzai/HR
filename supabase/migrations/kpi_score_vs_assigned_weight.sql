-- Overall KPI % is points earned ÷ assigned weight, not raw points out of 100.
-- Example: one 15% task rated Achieved → 15/15 = 100% (Outstanding), not 15% (Unsatisfactory).

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
        v_weight := v_weight + COALESCE(kpi_row.weight, 0);
        emp_score := public.kpi_employee_score_pct(kpi_row);
        IF emp_score IS NOT NULL THEN
            v_points := v_points + ROUND((emp_score / 100.0) * COALESCE(kpi_row.weight, 0), 2);
        END IF;
    END LOOP;
    IF v_weight <= 0 THEN
        RETURN 0;
    END IF;
    RETURN ROUND((v_points / v_weight) * 100, 2);
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
        WHEN COALESCE(SUM(w), 0) <= 0 THEN NULL
        WHEN COUNT(*) FILTER (WHERE s IS NOT NULL) = 0 THEN NULL
        ELSE ROUND(SUM((COALESCE(s, 0) / 100.0) * w) / SUM(w) * 100, 2)
    END
    FROM scored;
$$;

UPDATE public.users u
SET health_score = public.calculate_user_health_score(u.id),
    health_score_updated_at = timezone('utc'::text, now());

GRANT EXECUTE ON FUNCTION public.calculate_user_health_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_month_kpi_score(UUID, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
