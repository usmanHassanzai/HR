-- People board: expose Weightage (assigned + achieved) alongside Score.

DROP FUNCTION IF EXISTS public.get_org_kpi_points_board();

CREATE OR REPLACE FUNCTION public.get_org_kpi_points_board()
RETURNS TABLE (
    user_id UUID,
    full_name TEXT,
    email TEXT,
    role TEXT,
    department_id UUID,
    department_name TEXT,
    health_score NUMERIC,
    total_kpis BIGINT,
    completed_kpis BIGINT,
    pending_kpis BIGINT,
    kpi_points NUMERIC,
    weight_assigned NUMERIC,
    weight_achieved NUMERIC,
    total_earned NUMERIC,
    used_points NUMERIC,
    balance NUMERIC,
    this_month_points NUMERIC,
    this_month_score NUMERIC,
    kpi_period_start DATE,
    kpi_period_end DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_company UUID;
    v_month_start DATE := date_trunc('month', timezone('Asia/Karachi', now()))::DATE;
    v_month_end DATE := (date_trunc('month', timezone('Asia/Karachi', now())) + INTERVAL '1 month - 1 day')::DATE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;

    IF NOT (
        public.is_admin(v_uid)
        OR v_me.role = 'manager'::public.user_role
    ) THEN
        RAISE EXCEPTION 'Only managers and admins can view team KPI points';
    END IF;

    v_company := public.current_company_id();

    RETURN QUERY
    WITH staff AS (
        SELECT u.id, u.full_name, u.email, u.role, u.department_id
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role, 'admin'::public.user_role)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)
          AND (
              (v_company IS NOT NULL AND u.company_id = v_company)
              OR (v_company IS NULL AND public.is_demo_user(v_uid) AND coalesce(u.is_demo, false) = true)
              OR (v_company IS NULL AND u.company_id IS NULL AND NOT coalesce(u.is_demo, false))
          )
          AND (
              (v_me.role = 'admin'::public.user_role AND public.is_admin(v_uid))
              OR (
                  v_me.role = 'manager'::public.user_role
                  AND (
                      u.id = v_uid
                      OR u.manager_id = v_uid
                      OR (
                          v_me.department_id IS NOT NULL
                          AND u.department_id = v_me.department_id
                          AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
                      )
                  )
              )
          )
    ),
    kpi_stats AS (
        SELECT
            k.user_id,
            COUNT(*)::BIGINT AS total_kpis,
            COUNT(*) FILTER (WHERE k.completion_status = 'completed')::BIGINT AS completed_kpis,
            COUNT(*) FILTER (WHERE k.completion_status IS DISTINCT FROM 'completed')::BIGINT AS pending_kpis,
            ROUND(COALESCE(SUM(public.kpi_points_awarded(k)), 0), 2)::NUMERIC AS kpi_points,
            LEAST(100, ROUND(COALESCE(SUM(COALESCE(k.weight, 0)), 0), 2))::NUMERIC AS weight_assigned,
            LEAST(
              100,
              ROUND(
                COALESCE(SUM(COALESCE(k.weight, 0)) FILTER (WHERE k.completion_status = 'completed'), 0),
                2
              )
            )::NUMERIC AS weight_achieved,
            MIN(k.start_date) AS kpi_period_start,
            MAX(k.end_date) AS kpi_period_end
        FROM public.kpis k
        WHERE k.user_id IN (SELECT s.id FROM staff s)
        GROUP BY k.user_id
    ),
    month_kpis AS (
        SELECT
            k.user_id,
            MIN(k.start_date) AS month_start,
            MAX(k.end_date) AS month_end
        FROM public.kpis k
        WHERE k.user_id IN (SELECT s.id FROM staff s)
          AND (k.start_date IS NULL OR k.start_date <= v_month_end)
          AND (k.end_date IS NULL OR k.end_date >= v_month_start)
        GROUP BY k.user_id
    ),
    earned AS (
        SELECT pl.employee_id, COALESCE(SUM(pl.points_earned), 0)::NUMERIC AS total
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT s.id FROM staff s)
        GROUP BY pl.employee_id
    ),
    used AS (
        SELECT rr.employee_id, COALESCE(SUM(rr.points_used), 0)::NUMERIC AS total
        FROM public.reward_redemptions rr
        WHERE rr.employee_id IN (SELECT s.id FROM staff s)
        GROUP BY rr.employee_id
    ),
    month_ledger AS (
        SELECT pl.employee_id, pl.points_earned, pl.kpi_score
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT s.id FROM staff s)
          AND pl.month = v_month_start
    )
    SELECT
        s.id,
        s.full_name::TEXT,
        s.email::TEXT,
        s.role::TEXT,
        s.department_id,
        d.name::TEXT,
        COALESCE(public.user_overall_kpi_score(s.id), 0)::NUMERIC,
        COALESCE(ks.total_kpis, 0),
        COALESCE(ks.completed_kpis, 0),
        COALESCE(ks.pending_kpis, 0),
        COALESCE(ks.kpi_points, 0),
        COALESCE(ks.weight_assigned, 0),
        COALESCE(ks.weight_achieved, 0),
        COALESCE(e.total, 0),
        COALESCE(x.total, 0),
        COALESCE(e.total, 0) - COALESCE(x.total, 0),
        COALESCE(ml.points_earned, 0)::NUMERIC,
        COALESCE(ml.kpi_score, public.user_month_kpi_score(s.id, v_month_start)),
        COALESCE(mk.month_start, ks.kpi_period_start),
        COALESCE(mk.month_end, ks.kpi_period_end)
    FROM staff s
    LEFT JOIN public.departments d ON d.id = s.department_id
    LEFT JOIN kpi_stats ks ON ks.user_id = s.id
    LEFT JOIN month_kpis mk ON mk.user_id = s.id
    LEFT JOIN earned e ON e.employee_id = s.id
    LEFT JOIN used x ON x.employee_id = s.id
    LEFT JOIN month_ledger ml ON ml.employee_id = s.id
    ORDER BY d.name NULLS LAST, s.role, s.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_kpi_points_board() TO authenticated;

NOTIFY pgrst, 'reload schema';
