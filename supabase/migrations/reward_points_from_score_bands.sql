-- Reward balance uses monthly score-band points only (1000 / 500 / 250 / 0).
-- KPI score % and performance points stay for tracking and must not fill the ledger.

CREATE OR REPLACE FUNCTION public.monthly_points_for_score(p_score NUMERIC)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    RETURN CASE
        WHEN COALESCE(p_score, 0) >= 90 THEN 1000
        WHEN COALESCE(p_score, 0) >= 80 THEN 500
        WHEN COALESCE(p_score, 0) >= 70 THEN 250
        ELSE 0
    END;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_user_kpi_task_points(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_score NUMERIC;
    v_points INTEGER;
    v_month DATE := date_trunc('month', timezone('Asia/Karachi', now()))::DATE;
    v_old NUMERIC;
BEGIN
    v_score := COALESCE(public.calculate_user_health_score(p_user_id), 0);
    v_points := public.monthly_points_for_score(v_score);

    SELECT health_score INTO v_old FROM public.users WHERE id = p_user_id;
    UPDATE public.users
    SET previous_health_score = v_old,
        health_score = v_score,
        health_score_updated_at = timezone('utc'::text, now())
    WHERE id = p_user_id;

    INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
    VALUES (p_user_id, v_month, v_score, v_points)
    ON CONFLICT (employee_id, month) DO UPDATE
    SET kpi_score = EXCLUDED.kpi_score,
        points_earned = EXCLUDED.points_earned;

    RETURN v_score;
END;
$$;

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
END;
$$;

UPDATE public.points_ledger
SET points_earned = public.monthly_points_for_score(kpi_score)
WHERE points_earned >= 0;

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
        SELECT u.id, u.full_name, u.email, u.role, u.department_id, u.health_score
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
            ROUND(COALESCE(SUM(
                (COALESCE(public.kpi_employee_score_pct(k), 0) / 100.0) * COALESCE(k.weight, 0)
            ), 0), 2)::NUMERIC AS kpi_points,
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
        COALESCE(s.health_score, 0)::NUMERIC,
        COALESCE(ks.total_kpis, 0),
        COALESCE(ks.completed_kpis, 0),
        COALESCE(ks.pending_kpis, 0),
        COALESCE(ks.kpi_points, 0),
        COALESCE(e.total, 0),
        COALESCE(x.total, 0),
        COALESCE(e.total, 0) - COALESCE(x.total, 0),
        COALESCE(ml.points_earned, 0)::NUMERIC,
        COALESCE(ml.kpi_score, s.health_score, 0),
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

DROP FUNCTION IF EXISTS public.get_team_points_board();

CREATE OR REPLACE FUNCTION public.get_team_points_board()
RETURNS TABLE (
    user_id UUID,
    full_name TEXT,
    email TEXT,
    role TEXT,
    department_id UUID,
    department_name TEXT,
    total_earned NUMERIC,
    used_points NUMERIC,
    balance NUMERIC,
    this_month_points NUMERIC,
    this_month_score NUMERIC,
    is_self BOOLEAN,
    kpi_period_start DATE,
    kpi_period_end DATE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
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

    RETURN QUERY
    WITH teammates AS (
        SELECT u.id
        FROM public.users u
        WHERE u.id = v_uid

        UNION

        SELECT u.id
        FROM public.users u
        WHERE v_me.role IN ('manager'::public.user_role, 'admin'::public.user_role)
          AND u.manager_id = v_uid
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)

        UNION

        SELECT u.id
        FROM public.users u
        WHERE v_me.role IN ('manager'::public.user_role, 'admin'::public.user_role)
          AND v_me.department_id IS NOT NULL
          AND u.department_id = v_me.department_id
          AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)
    ),
    kpi_dates AS (
        SELECT
            k.user_id,
            MIN(k.start_date) AS kpi_period_start,
            MAX(k.end_date) AS kpi_period_end
        FROM public.kpis k
        WHERE k.user_id IN (SELECT id FROM teammates)
          AND (k.start_date IS NULL OR k.start_date <= v_month_end)
          AND (k.end_date IS NULL OR k.end_date >= v_month_start)
        GROUP BY k.user_id
    ),
    earned AS (
        SELECT pl.employee_id, COALESCE(SUM(pl.points_earned), 0)::NUMERIC AS total
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT id FROM teammates)
        GROUP BY pl.employee_id
    ),
    used AS (
        SELECT rr.employee_id, COALESCE(SUM(rr.points_used), 0)::NUMERIC AS total
        FROM public.reward_redemptions rr
        WHERE rr.employee_id IN (SELECT id FROM teammates)
        GROUP BY rr.employee_id
    ),
    month_ledger AS (
        SELECT pl.employee_id, pl.points_earned, pl.kpi_score
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT id FROM teammates)
          AND pl.month = v_month_start
    )
    SELECT
        u.id,
        u.full_name::TEXT,
        u.email::TEXT,
        u.role::TEXT,
        u.department_id,
        d.name::TEXT,
        COALESCE(e.total, 0),
        COALESCE(x.total, 0),
        COALESCE(e.total, 0) - COALESCE(x.total, 0),
        COALESCE(ml.points_earned, 0)::NUMERIC,
        COALESCE(ml.kpi_score, u.health_score, 0),
        (u.id = v_uid),
        kd.kpi_period_start,
        kd.kpi_period_end
    FROM teammates t
    JOIN public.users u ON u.id = t.id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN kpi_dates kd ON kd.user_id = u.id
    LEFT JOIN earned e ON e.employee_id = u.id
    LEFT JOIN used x ON x.employee_id = u.id
    LEFT JOIN month_ledger ml ON ml.employee_id = u.id
    ORDER BY (u.id = v_uid) DESC,
             (COALESCE(e.total, 0) - COALESCE(x.total, 0)) DESC,
             u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.monthly_points_for_score(NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_user_kpi_task_points(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_monthly_points(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_kpi_points_board() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_points_board() TO authenticated;

NOTIFY pgrst, 'reload schema';
