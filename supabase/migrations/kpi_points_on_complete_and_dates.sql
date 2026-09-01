-- Credit live KPI points to earned/balance when a task is completed,
-- and expose KPI date ranges on the org / team points boards.

CREATE OR REPLACE FUNCTION public.sync_user_kpi_task_points(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_score NUMERIC;
    v_month DATE := date_trunc('month', timezone('utc'::text, now()))::DATE;
    v_old NUMERIC;
BEGIN
    v_score := COALESCE(public.calculate_user_health_score(p_user_id), 0);

    SELECT health_score INTO v_old FROM public.users WHERE id = p_user_id;
    UPDATE public.users
    SET previous_health_score = v_old,
        health_score = v_score,
        health_score_updated_at = timezone('utc'::text, now())
    WHERE id = p_user_id;

    INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
    VALUES (p_user_id, v_month, v_score, ROUND(v_score)::INTEGER)
    ON CONFLICT (employee_id, month) DO UPDATE
    SET kpi_score = EXCLUDED.kpi_score,
        points_earned = GREATEST(public.points_ledger.points_earned, EXCLUDED.points_earned);

    RETURN v_score;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.sync_user_kpi_task_points(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_kpi_employee(p_kpi_id UUID)
RETURNS TABLE(manager_email TEXT, manager_name TEXT, department TEXT) AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF v_kpi.completion_status = 'completed' THEN RAISE EXCEPTION 'Already completed'; END IF;

    UPDATE public.kpis SET
        completion_status = 'completed',
        status = 'on_track'::kpi_status_type,
        current_value = 100,
        updated_at = now()
    WHERE id = p_kpi_id;

    PERFORM public.sync_user_kpi_task_points(auth.uid());

    SELECT u.email, u.full_name INTO v_mgr_email, v_mgr_name
    FROM public.users emp
    JOIN public.users u ON u.id = emp.manager_id
    WHERE emp.id = auth.uid();

    IF (SELECT manager_id FROM public.users WHERE id = auth.uid()) IS NOT NULL THEN
        PERFORM public.create_system_notification(
            (SELECT manager_id FROM public.users WHERE id = auth.uid()),
            'KPI Completed',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' completed KPI: ' || COALESCE(v_kpi.department, v_kpi.name),
            'info'
        );
    END IF;

    manager_email := v_mgr_email;
    manager_name := COALESCE(v_mgr_name, 'Manager');
    department := COALESCE(v_kpi.department, v_kpi.name);
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.complete_kpi_employee(UUID) TO authenticated;

-- Backfill ledger so already-completed tasks show earned/balance now
INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
SELECT
    scored.id,
    date_trunc('month', timezone('utc'::text, now()))::DATE,
    scored.score,
    ROUND(scored.score)::INTEGER
FROM (
    SELECT u.id, public.calculate_user_health_score(u.id) AS score
    FROM public.users u
    WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
      AND coalesce(u.is_demo, false) = false
      AND u.is_platform_owner IS DISTINCT FROM true
) scored
WHERE scored.score > 0
ON CONFLICT (employee_id, month) DO UPDATE
SET kpi_score = EXCLUDED.kpi_score,
    points_earned = GREATEST(public.points_ledger.points_earned, EXCLUDED.points_earned);

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
    total_earned NUMERIC,
    used_points NUMERIC,
    balance NUMERIC,
    this_month_points NUMERIC,
    this_month_score NUMERIC,
    kpi_period_start DATE,
    kpi_period_end DATE
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_month_start DATE := date_trunc('month', timezone('utc'::text, now()))::DATE;
    v_month_end DATE := (date_trunc('month', timezone('utc'::text, now())) + INTERVAL '1 month - 1 day')::DATE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can view the organization KPI points board';
    END IF;

    v_company := public.current_company_id();

    RETURN QUERY
    WITH staff AS (
        SELECT u.id, u.full_name, u.email, u.role, u.department_id, u.health_score
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role, 'admin'::public.user_role)
          AND coalesce(u.is_demo, false) = false
          AND (
              (v_company IS NOT NULL AND u.company_id = v_company)
              OR (v_company IS NULL AND public.is_demo_user(v_uid) AND coalesce(u.is_demo, false) = true)
              OR (v_company IS NULL AND u.company_id IS NULL AND NOT coalesce(u.is_demo, false))
          )
    ),
    kpi_stats AS (
        SELECT
            k.user_id,
            COUNT(*)::BIGINT AS total_kpis,
            COUNT(*) FILTER (WHERE k.completion_status = 'completed')::BIGINT AS completed_kpis,
            COUNT(*) FILTER (WHERE k.completion_status IS DISTINCT FROM 'completed')::BIGINT AS pending_kpis,
            ROUND(COALESCE(SUM(
                CASE
                    WHEN k.completion_status = 'completed' THEN COALESCE(k.weight, 0)
                    WHEN COALESCE(k.target_value, 0) > 0 THEN
                        LEAST(100::NUMERIC, GREATEST(0::NUMERIC,
                            (COALESCE(k.current_value, 0) / NULLIF(k.target_value, 0)) * 100
                        )) / 100.0 * COALESCE(k.weight, 0)
                    WHEN k.status = 'on_track' THEN COALESCE(k.weight, 0)
                    WHEN k.status = 'at_risk' THEN COALESCE(k.weight, 0) * 0.5
                    ELSE 0
                END
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
            ROUND(COALESCE(SUM(
                CASE
                    WHEN k.completion_status = 'completed' THEN COALESCE(k.weight, 0)
                    WHEN COALESCE(k.target_value, 0) > 0 THEN
                        LEAST(100::NUMERIC, GREATEST(0::NUMERIC,
                            (COALESCE(k.current_value, 0) / NULLIF(k.target_value, 0)) * 100
                        )) / 100.0 * COALESCE(k.weight, 0)
                    WHEN k.status = 'on_track' THEN COALESCE(k.weight, 0)
                    WHEN k.status = 'at_risk' THEN COALESCE(k.weight, 0) * 0.5
                    ELSE 0
                END
            ), 0), 2)::NUMERIC AS month_points,
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
    )
    SELECT
        s.id,
        s.full_name::TEXT,
        s.email::TEXT,
        s.role::TEXT,
        s.department_id,
        d.name::TEXT,
        COALESCE(ks.kpi_points, s.health_score, 0)::NUMERIC,
        COALESCE(ks.total_kpis, 0),
        COALESCE(ks.completed_kpis, 0),
        COALESCE(ks.pending_kpis, 0),
        COALESCE(ks.kpi_points, 0),
        GREATEST(COALESCE(e.total, 0), COALESCE(ks.kpi_points, 0)),
        COALESCE(x.total, 0),
        GREATEST(COALESCE(e.total, 0), COALESCE(ks.kpi_points, 0)) - COALESCE(x.total, 0),
        COALESCE(mk.month_points, ks.kpi_points, 0),
        COALESCE(ks.kpi_points, 0),
        COALESCE(mk.month_start, ks.kpi_period_start),
        COALESCE(mk.month_end, ks.kpi_period_end)
    FROM staff s
    LEFT JOIN public.departments d ON d.id = s.department_id
    LEFT JOIN kpi_stats ks ON ks.user_id = s.id
    LEFT JOIN month_kpis mk ON mk.user_id = s.id
    LEFT JOIN earned e ON e.employee_id = s.id
    LEFT JOIN used x ON x.employee_id = s.id
    ORDER BY d.name NULLS LAST, s.role, s.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_org_kpi_points_board() TO authenticated;

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
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_month_start DATE := date_trunc('month', timezone('utc'::text, now()))::DATE;
    v_month_end DATE := (date_trunc('month', timezone('utc'::text, now())) + INTERVAL '1 month - 1 day')::DATE;
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
        WHERE v_me.manager_id IS NOT NULL
          AND u.manager_id = v_me.manager_id
          AND u.id <> v_uid
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)

        UNION

        SELECT u.id
        FROM public.users u
        WHERE v_me.department_id IS NOT NULL
          AND u.department_id = v_me.department_id
          AND u.id <> v_uid
          AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)
    ),
    kpi_pts AS (
        SELECT
            k.user_id,
            ROUND(COALESCE(SUM(
                CASE
                    WHEN k.completion_status = 'completed' THEN COALESCE(k.weight, 0)
                    WHEN COALESCE(k.target_value, 0) > 0 THEN
                        LEAST(100::NUMERIC, GREATEST(0::NUMERIC,
                            (COALESCE(k.current_value, 0) / NULLIF(k.target_value, 0)) * 100
                        )) / 100.0 * COALESCE(k.weight, 0)
                    WHEN k.status = 'on_track' THEN COALESCE(k.weight, 0)
                    WHEN k.status = 'at_risk' THEN COALESCE(k.weight, 0) * 0.5
                    ELSE 0
                END
            ), 0), 2)::NUMERIC AS kpi_points,
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
    )
    SELECT
        u.id,
        u.full_name::TEXT,
        u.email::TEXT,
        u.role::TEXT,
        u.department_id,
        d.name::TEXT,
        GREATEST(COALESCE(e.total, 0), COALESCE(kp.kpi_points, 0)),
        COALESCE(x.total, 0),
        GREATEST(COALESCE(e.total, 0), COALESCE(kp.kpi_points, 0)) - COALESCE(x.total, 0),
        COALESCE(kp.kpi_points, 0),
        COALESCE(kp.kpi_points, 0),
        (u.id = v_uid),
        kp.kpi_period_start,
        kp.kpi_period_end
    FROM teammates t
    JOIN public.users u ON u.id = t.id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN kpi_pts kp ON kp.user_id = u.id
    LEFT JOIN earned e ON e.employee_id = u.id
    LEFT JOIN used x ON x.employee_id = u.id
    ORDER BY (u.id = v_uid) DESC,
             (GREATEST(COALESCE(e.total, 0), COALESCE(kp.kpi_points, 0)) - COALESCE(x.total, 0)) DESC,
             u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_team_points_board() TO authenticated;

NOTIFY pgrst, 'reload schema';
