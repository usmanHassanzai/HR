-- Team points board: employees/managers can see their own points and teammates' balances.
-- Peers: same manager, or same department when no shared manager.
-- Managers: own points + direct reports.

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
    is_self BOOLEAN
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_month TEXT := to_char(timezone('utc'::text, now()), 'YYYY-MM');
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
        -- Self always included
        SELECT u.id
        FROM public.users u
        WHERE u.id = v_uid

        UNION

        -- Manager / admin: direct reports
        SELECT u.id
        FROM public.users u
        WHERE v_me.role IN ('manager'::public.user_role, 'admin'::public.user_role)
          AND u.manager_id = v_uid
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)

        UNION

        -- Employee (or anyone): colleagues with the same manager
        SELECT u.id
        FROM public.users u
        WHERE v_me.manager_id IS NOT NULL
          AND u.manager_id = v_me.manager_id
          AND u.id <> v_uid
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)

        UNION

        -- Same department peers (employees/managers in the same dept)
        SELECT u.id
        FROM public.users u
        WHERE v_me.department_id IS NOT NULL
          AND u.department_id = v_me.department_id
          AND u.id <> v_uid
          AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND (v_me.company_id IS NULL OR u.company_id = v_me.company_id)
          AND coalesce(u.is_demo, false) = coalesce(v_me.is_demo, false)
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
    month_row AS (
        SELECT
            pl.employee_id,
            COALESCE(SUM(pl.points_earned), 0)::NUMERIC AS pts,
            MAX(pl.kpi_score)::NUMERIC AS score
        FROM public.points_ledger pl
        WHERE pl.employee_id IN (SELECT id FROM teammates)
          AND left(pl.month::text, 7) = v_month
        GROUP BY pl.employee_id
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
        m.pts,
        m.score,
        (u.id = v_uid)
    FROM teammates t
    JOIN public.users u ON u.id = t.id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN earned e ON e.employee_id = u.id
    LEFT JOIN used x ON x.employee_id = u.id
    LEFT JOIN month_row m ON m.employee_id = u.id
    ORDER BY (u.id = v_uid) DESC, (COALESCE(e.total, 0) - COALESCE(x.total, 0)) DESC, u.full_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_team_points_board() TO authenticated;

NOTIFY pgrst, 'reload schema';
