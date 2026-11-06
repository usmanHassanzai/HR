-- Own points must be the Month Scoreboard awarded total.
-- score_weightage_month_kpi_pct already sums assigned_score (the Awarded figure).
-- Multiplying by individual_weight / 100 weighted that total a second time:
-- 44.5 awarded with a 50 individual weight became 22.3.
-- Team points are unchanged: points given stay as entered, and the
-- department-average fallback still uses the team weight.

CREATE OR REPLACE FUNCTION public.score_weightage_live_row(
  p_company_id UUID,
  p_user_id UUID,
  p_month DATE
)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  department_id UUID,
  department_name TEXT,
  individual_kpi_pct NUMERIC,
  team_avg_kpi_pct NUMERIC,
  individual_weight NUMERIC,
  team_weight NUMERIC,
  weight_source TEXT,
  individual_points NUMERIC,
  team_points NUMERIC,
  score NUMERIC,
  bonus_pct NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_month DATE := date_trunc('month', p_month)::date;
  v_dept_name TEXT;
  v_ind_kpi NUMERIC;
  v_team_avg NUMERIC;
  v_ind_w NUMERIC := 80;
  v_team_w NUMERIC := 20;
  v_source TEXT := 'default';
  v_given NUMERIC;
  v_ind_pts NUMERIC := 0;
  v_team_pts NUMERIC := 0;
  v_score NUMERIC := 0;
BEGIN
  SELECT * INTO v_user FROM public.users u WHERE u.id = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_ind_kpi := public.score_weightage_month_kpi_pct(v_user.id, v_month);

  IF v_user.department_id IS NOT NULL THEN
    SELECT d.name INTO v_dept_name
    FROM public.departments d
    WHERE d.id = v_user.department_id;

    SELECT r.individual_weight, r.team_weight, r.source
      INTO v_ind_w, v_team_w, v_source
    FROM public.resolve_department_score_weights(p_company_id, v_user.department_id, v_month) r;

    v_team_avg := public.department_team_avg_kpi_pct(v_user.department_id, v_month);
    v_given := public.department_team_points_given(p_company_id, v_user.department_id, v_month);
  END IF;

  v_ind_kpi := COALESCE(v_ind_kpi, 0);
  v_ind_pts := ROUND(v_ind_kpi, 1);
  IF v_given IS NOT NULL THEN
    v_team_pts := ROUND(LEAST(GREATEST(v_given, 0), v_team_w), 1);
  ELSE
    v_team_pts := ROUND(COALESCE(v_team_avg, 0) * v_team_w / 100, 1);
  END IF;
  v_score := v_ind_pts + v_team_pts;

  RETURN QUERY
  SELECT
    v_user.id,
    v_user.full_name,
    v_user.department_id,
    v_dept_name,
    v_ind_kpi,
    v_team_avg,
    v_ind_w,
    v_team_w,
    v_source,
    v_ind_pts,
    v_team_pts,
    v_score,
    public.bonus_pct(v_score);
END;
$$;

-- Same month result the scores page uses, for the person whose KPIs are on screen.
-- Self, HR, and Admin can read it. A manager can read people in their department.
CREATE OR REPLACE FUNCTION public.get_user_month_score(
  p_user_id UUID,
  p_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
  v_company UUID;
  v_month DATE;
  v_status TEXT := 'open';
  v_snap public.score_weightage_snapshot%ROWTYPE;
  v_row RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_caller FROM public.users u WHERE u.id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  SELECT * INTO v_target FROM public.users u WHERE u.id = COALESCE(p_user_id, auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  v_company := public.current_company_id();
  IF v_company IS NULL OR v_target.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Not allowed to view this score';
  END IF;

  IF v_target.id IS DISTINCT FROM v_caller.id THEN
    IF v_caller.role::text IN ('hr', 'admin') THEN
      NULL;
    ELSIF v_caller.role::text = 'manager'
      AND v_caller.department_id IS NOT NULL
      AND v_caller.department_id = v_target.department_id THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Not allowed to view this score';
    END IF;
  END IF;

  v_month := date_trunc('month', COALESCE(p_month, timezone('Asia/Karachi', now())::date))::date;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;
  v_status := COALESCE(v_status, 'open');

  IF v_status = 'approved' THEN
    SELECT * INTO v_snap
    FROM public.score_weightage_snapshot s
    WHERE s.company_id = v_company
      AND s.month = v_month
      AND s.user_id = v_target.id;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'month', v_month,
        'status', v_status,
        'department_id', v_snap.department_id,
        'department_name', v_snap.department_name,
        'individual_weight', v_snap.individual_weight,
        'team_weight', v_snap.team_weight,
        'individual_points', v_snap.individual_points,
        'team_points', v_snap.team_points,
        'score', v_snap.score,
        'bonus_pct', v_snap.bonus_pct
      );
    END IF;

    RETURN jsonb_build_object(
      'month', v_month,
      'status', v_status,
      'department_id', v_target.department_id,
      'department_name', NULL,
      'individual_weight', NULL,
      'team_weight', NULL,
      'individual_points', NULL,
      'team_points', NULL,
      'score', NULL,
      'bonus_pct', NULL
    );
  END IF;

  SELECT * INTO v_row
  FROM public.score_weightage_live_row(v_company, v_target.id, v_month) l;

  RETURN jsonb_build_object(
    'month', v_month,
    'status', v_status,
    'department_id', v_row.department_id,
    'department_name', v_row.department_name,
    'individual_weight', v_row.individual_weight,
    'team_weight', v_row.team_weight,
    'individual_points', v_row.individual_points,
    'team_points', v_row.team_points,
    'score', v_row.score,
    'bonus_pct', v_row.bonus_pct
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_month_score(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_month_score(UUID, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
