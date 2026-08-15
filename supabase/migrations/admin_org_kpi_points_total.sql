-- Add live KPI contribution points (sum of achieved% × weight) to org points board.

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
    this_month_score NUMERIC
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_month TEXT := to_char(timezone('utc'::text, now()), 'YYYY-MM');
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
            ), 0), 2)::NUMERIC AS kpi_points
        FROM public.kpis k
        WHERE k.user_id IN (SELECT s.id FROM staff s)
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
    month_row AS (
        SELECT
            pl.employee_id,
            COALESCE(SUM(pl.points_earned), 0)::NUMERIC AS pts,
            MAX(pl.kpi_score)::NUMERIC AS score
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT s.id FROM staff s)
          AND left(pl.month::text, 7) = v_month
        GROUP BY pl.employee_id
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
        m.pts,
        m.score
    FROM staff s
    LEFT JOIN public.departments d ON d.id = s.department_id
    LEFT JOIN kpi_stats ks ON ks.user_id = s.id
    LEFT JOIN earned e ON e.employee_id = s.id
    LEFT JOIN used x ON x.employee_id = s.id
    LEFT JOIN month_row m ON m.employee_id = s.id
    ORDER BY d.name NULLS LAST, s.role, s.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_org_kpi_points_board() TO authenticated;

NOTIFY pgrst, 'reload schema';
