-- Points given to a team, taken from that department's team weight.
-- Blank keeps the department-average formula. A number is awarded to everyone
-- in the department and cannot exceed the team weight (50 when team is 50).

BEGIN;

ALTER TABLE public.department_score_weightage
  ADD COLUMN IF NOT EXISTS team_points_given NUMERIC;

ALTER TABLE public.department_score_weightage
  DROP CONSTRAINT IF EXISTS department_score_weightage_points_given;

ALTER TABLE public.department_score_weightage
  ADD CONSTRAINT department_score_weightage_points_given
  CHECK (
    team_points_given IS NULL
    OR (
      team_points_given >= 0
      AND team_points_given <= team_weight
      AND team_points_given = round(team_points_given, 1)
    )
  );

ALTER TABLE public.score_weightage_log
  ADD COLUMN IF NOT EXISTS old_team_points_given NUMERIC,
  ADD COLUMN IF NOT EXISTS new_team_points_given NUMERIC;

ALTER TABLE public.score_weightage_snapshot
  ADD COLUMN IF NOT EXISTS team_points_given NUMERIC;

-- Latest saved award for this month, otherwise the previous month's award.
-- A stored month with NULL stays NULL so the average formula still applies.
CREATE OR REPLACE FUNCTION public.department_team_points_given(
  p_company_id UUID,
  p_department_id UUID,
  p_month DATE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.team_points_given
  FROM public.department_score_weightage w
  WHERE w.company_id = p_company_id
    AND w.department_id = p_department_id
    AND w.month <= date_trunc('month', p_month)::date
  ORDER BY w.month DESC
  LIMIT 1;
$$;

DO $revoke_team_points_given$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.department_team_points_given(UUID, UUID, DATE) FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.department_team_points_given(UUID, UUID, DATE) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.department_team_points_given(UUID, UUID, DATE) FROM authenticated';
  END IF;
END
$revoke_team_points_given$;

CREATE OR REPLACE FUNCTION public.guard_weightage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_dept UUID;
  v_company UUID;
  v_status TEXT;
  admin_may_edit_score_weightage CONSTANT BOOLEAN := false;
BEGIN
  NEW.month := date_trunc('month', NEW.month)::date;

  IF NEW.company_id IS NULL THEN
    SELECT d.company_id INTO NEW.company_id
    FROM public.departments d
    WHERE d.id = NEW.department_id;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.individual_weight IS NOT DISTINCT FROM OLD.individual_weight
     AND NEW.team_weight IS NOT DISTINCT FROM OLD.team_weight
     AND NEW.team_points_given IS NOT DISTINCT FROM OLD.team_points_given
     AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.month IS NOT DISTINCT FROM OLD.month
     AND NEW.updated_by IS NULL
     AND OLD.updated_by IS DISTINCT FROM NEW.updated_by
  THEN
    RETURN NEW;
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = NEW.company_id
    AND s.month = NEW.month;

  IF v_status = 'approved' THEN
    RAISE EXCEPTION 'Month % is approved and locked', NEW.month;
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'Month % is closed and weightage cannot be changed', NEW.month;
  END IF;

  IF auth.uid() IS NULL AND current_user IN ('postgres', 'supabase_admin') THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  SELECT u.role::text, u.department_id, u.company_id
    INTO v_role, v_dept, v_company
  FROM public.users u
  WHERE u.id = auth.uid();

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Not allowed to change weightage for another company';
  END IF;

  IF NOT (
    v_role = 'hr'
    OR (v_role = 'manager' AND v_dept IS NOT NULL AND v_dept = NEW.department_id)
    OR (admin_may_edit_score_weightage AND v_role = 'admin')
  ) THEN
    RAISE EXCEPTION 'Not allowed to change weightage for this department';
  END IF;

  IF NEW.individual_weight + NEW.team_weight <> 100 THEN
    RAISE EXCEPTION 'Individual and team weights must total 100';
  END IF;

  IF NEW.team_points_given IS NOT NULL AND (
    NEW.team_points_given < 0
    OR NEW.team_points_given > NEW.team_weight
    OR NEW.team_points_given <> round(NEW.team_points_given, 1)
  ) THEN
    RAISE EXCEPTION 'Points given must be between 0 and the team weight, with at most one decimal place';
  END IF;

  NEW.updated_by := auth.uid();
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.department_score_weightage w
    WHERE w.company_id = NEW.company_id
      AND w.department_id = NEW.department_id
      AND w.month = NEW.month
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.score_weightage_log (
    company_id, department_id, month,
    old_individual, old_team, new_individual, new_team,
    old_team_points_given, new_team_points_given,
    changed_by, changed_by_role
  ) VALUES (
    NEW.company_id, NEW.department_id, NEW.month,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.individual_weight END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.team_weight END,
    NEW.individual_weight, NEW.team_weight,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.team_points_given END,
    NEW.team_points_given,
    auth.uid(), v_role
  );

  RETURN NEW;
END;
$$;

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
  v_ind_pts := ROUND(v_ind_kpi * v_ind_w / 100, 1);
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

DROP FUNCTION IF EXISTS public.list_department_score_weightages(DATE);

CREATE FUNCTION public.list_department_score_weightages(p_month DATE)
RETURNS TABLE (
  department_id UUID,
  department_name TEXT,
  month DATE,
  individual_weight NUMERIC,
  team_weight NUMERIC,
  team_points_given NUMERIC,
  source TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.name,
    v_month,
    r.individual_weight,
    r.team_weight,
    public.department_team_points_given(v_company, d.id, v_month),
    r.source,
    w.updated_by,
    w.updated_at
  FROM public.departments d
  CROSS JOIN LATERAL public.resolve_department_score_weights(v_company, d.id, v_month) r
  LEFT JOIN public.department_score_weightage w
    ON w.company_id = v_company
   AND w.department_id = d.id
   AND w.month = v_month
  WHERE d.active = true
    AND d.company_id = v_company
    AND (
      v_me.role IN ('hr'::public.user_role, 'admin'::public.user_role)
      OR (v_me.role = 'manager'::public.user_role AND d.id = v_me.department_id)
    )
  ORDER BY d.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_department_score_weightages(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_department_score_weightage(
  p_department_id UUID,
  p_month DATE,
  p_individual_weight NUMERIC,
  p_team_weight NUMERIC,
  p_team_points_given NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_dept_company UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  SELECT d.company_id INTO v_dept_company
  FROM public.departments d
  WHERE d.id = p_department_id AND d.active = true;
  IF v_dept_company IS NULL OR v_dept_company IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Department not found in your company';
  END IF;

  IF p_individual_weight + p_team_weight <> 100 THEN
    RAISE EXCEPTION 'Individual and team weights must total 100';
  END IF;
  IF p_individual_weight < 0 OR p_individual_weight > 100
     OR p_team_weight < 0 OR p_team_weight > 100
     OR p_individual_weight <> round(p_individual_weight, 1)
     OR p_team_weight <> round(p_team_weight, 1) THEN
    RAISE EXCEPTION 'Weights must be between 0 and 100 with at most one decimal place';
  END IF;
  IF p_team_points_given IS NOT NULL AND (
    p_team_points_given < 0
    OR p_team_points_given > p_team_weight
    OR p_team_points_given <> round(p_team_points_given, 1)
  ) THEN
    RAISE EXCEPTION 'Points given must be between 0 and the team weight, with at most one decimal place';
  END IF;

  INSERT INTO public.department_score_weightage (
    company_id, department_id, month, individual_weight, team_weight, team_points_given
  ) VALUES (
    v_company, p_department_id, v_month, p_individual_weight, p_team_weight, p_team_points_given
  )
  ON CONFLICT (company_id, department_id, month) DO UPDATE
    SET individual_weight = EXCLUDED.individual_weight,
        team_weight = EXCLUDED.team_weight,
        team_points_given = EXCLUDED.team_points_given;

  RETURN jsonb_build_object(
    'ok', true,
    'department_id', p_department_id,
    'month', v_month,
    'individual_weight', p_individual_weight,
    'team_weight', p_team_weight,
    'team_points_given', p_team_points_given
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_department_score_weightage(UUID, DATE, NUMERIC, NUMERIC, NUMERIC) TO authenticated;

-- Older clients omit the award. Keep the saved value instead of clearing it.
CREATE OR REPLACE FUNCTION public.upsert_department_score_weightage(
  p_department_id UUID,
  p_month DATE,
  p_individual_weight NUMERIC,
  p_team_weight NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_given NUMERIC;
BEGIN
  SELECT w.team_points_given INTO v_given
  FROM public.department_score_weightage w
  WHERE w.company_id = public.current_company_id()
    AND w.department_id = p_department_id
    AND w.month = date_trunc('month', p_month)::date;

  RETURN public.upsert_department_score_weightage(
    p_department_id,
    p_month,
    p_individual_weight,
    p_team_weight,
    v_given
  );
END;
$$;

DROP FUNCTION IF EXISTS public.list_score_weightage_log(DATE);

CREATE FUNCTION public.list_score_weightage_log(p_month DATE)
RETURNS TABLE (
  id BIGINT,
  department_id UUID,
  department_name TEXT,
  month DATE,
  old_individual NUMERIC,
  old_team NUMERIC,
  new_individual NUMERIC,
  new_team NUMERIC,
  old_team_points_given NUMERIC,
  new_team_points_given NUMERIC,
  old_status TEXT,
  new_status TEXT,
  changed_by UUID,
  changed_by_name TEXT,
  changed_by_role TEXT,
  changed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND OR v_me.role NOT IN ('hr'::public.user_role, 'admin'::public.user_role) THEN
    RAISE EXCEPTION 'Only HR and Admin can view the Score weightage audit log';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    l.department_id,
    d.name,
    l.month,
    l.old_individual,
    l.old_team,
    l.new_individual,
    l.new_team,
    l.old_team_points_given,
    l.new_team_points_given,
    l.old_status,
    l.new_status,
    l.changed_by,
    u.full_name,
    l.changed_by_role,
    l.changed_at
  FROM public.score_weightage_log l
  LEFT JOIN public.departments d ON d.id = l.department_id
  LEFT JOIN public.users u ON u.id = l.changed_by
  WHERE l.company_id = v_company
    AND l.month = v_month
  ORDER BY l.changed_at DESC, l.id DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_score_weightage_log(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_score_weightage(p_month DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', COALESCE(p_month, timezone('Asia/Karachi', now())::date))::date;
  v_status TEXT := 'open';
  v_snap public.score_weightage_snapshot%ROWTYPE;
  v_row RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;
  v_company := public.current_company_id();

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;
  v_status := COALESCE(v_status, 'open');

  IF v_status = 'approved' THEN
    SELECT * INTO v_snap
    FROM public.score_weightage_snapshot s
    WHERE s.company_id = v_company
      AND s.month = v_month
      AND s.user_id = v_uid;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'month', v_month,
        'status', v_status,
        'department_id', v_snap.department_id,
        'department_name', v_snap.department_name,
        'individual_kpi_pct', v_snap.individual_kpi_pct,
        'team_avg_kpi_pct', v_snap.team_avg_kpi_pct,
        'individual_weight', v_snap.individual_weight,
        'team_weight', v_snap.team_weight,
        'team_points_given', v_snap.team_points_given,
        'weight_source', 'snapshot',
        'individual_points', v_snap.individual_points,
        'team_points', v_snap.team_points,
        'score', v_snap.score,
        'bonus_pct', v_snap.bonus_pct
      );
    END IF;

    RETURN jsonb_build_object(
      'month', v_month,
      'status', v_status,
      'department_id', v_me.department_id,
      'department_name', NULL,
      'individual_kpi_pct', NULL,
      'team_avg_kpi_pct', NULL,
      'individual_weight', NULL,
      'team_weight', NULL,
      'team_points_given', NULL,
      'weight_source', NULL,
      'individual_points', NULL,
      'team_points', NULL,
      'score', NULL,
      'bonus_pct', NULL
    );
  END IF;

  SELECT * INTO v_row
  FROM public.score_weightage_live_row(v_company, v_uid, v_month) l;

  RETURN jsonb_build_object(
    'month', v_month,
    'status', v_status,
    'department_id', v_row.department_id,
    'department_name', v_row.department_name,
    'individual_kpi_pct', v_row.individual_kpi_pct,
    'team_avg_kpi_pct', v_row.team_avg_kpi_pct,
    'individual_weight', v_row.individual_weight,
    'team_weight', v_row.team_weight,
    'team_points_given', CASE
      WHEN v_row.department_id IS NULL THEN NULL
      ELSE public.department_team_points_given(v_company, v_row.department_id, v_month)
    END,
    'weight_source', v_row.weight_source,
    'individual_points', v_row.individual_points,
    'team_points', v_row.team_points,
    'score', v_row.score,
    'bonus_pct', v_row.bonus_pct
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_score_month(p_month DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_status TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND OR v_me.role IS DISTINCT FROM 'admin'::public.user_role THEN
    RAISE EXCEPTION 'Only Admin can approve a score month';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;

  IF v_status IS NULL OR v_status = 'open' THEN
    RAISE EXCEPTION 'Month % must be closed by HR before Admin approval', v_month;
  END IF;
  IF v_status = 'approved' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'approved', 'month', v_month);
  END IF;

  INSERT INTO public.score_weightage_snapshot (
    company_id, month, user_id, full_name, department_id, department_name,
    individual_weight, team_weight, individual_kpi_pct, team_avg_kpi_pct,
    individual_points, team_points, team_points_given, score, bonus_pct
  )
  SELECT
    v_company,
    v_month,
    l.user_id,
    l.full_name,
    l.department_id,
    l.department_name,
    l.individual_weight,
    l.team_weight,
    l.individual_kpi_pct,
    l.team_avg_kpi_pct,
    ROUND(l.individual_points, 1),
    ROUND(l.team_points, 1),
    public.department_team_points_given(v_company, l.department_id, v_month),
    ROUND(l.individual_points, 1) + ROUND(l.team_points, 1),
    public.bonus_pct(ROUND(l.individual_points, 1) + ROUND(l.team_points, 1))
  FROM public.users u
  JOIN public.departments d
    ON d.id = u.department_id
   AND d.company_id = v_company
   AND d.active = true
  CROSS JOIN LATERAL public.score_weightage_live_row(v_company, u.id, v_month) l
  WHERE u.company_id = v_company
    AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
    AND coalesce(u.is_demo, false) = false
    AND l.department_id IS NOT NULL
    AND l.department_name IS NOT NULL;

  UPDATE public.score_month_status
  SET status = 'approved',
      approved_by = v_uid,
      approved_at = now()
  WHERE company_id = v_company AND month = v_month;

  INSERT INTO public.score_weightage_log (
    company_id, month, old_status, new_status, changed_by, changed_by_role
  ) VALUES (
    v_company, v_month, 'closed', 'approved', v_uid, v_me.role::text
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'month', v_month);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
