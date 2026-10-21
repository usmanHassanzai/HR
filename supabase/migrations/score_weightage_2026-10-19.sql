-- Score weightage: department individual/team mix, live scores, bonus % only (no salary).
-- Admin approves a closed month. There is no separate ceo role.
-- Monthly individual KPI % is public.score_weightage_month_kpi_pct.
-- This file does not create or replace public.kpi_award_month_score or any rewards-wallet function.

BEGIN;

-- ---------------------------------------------------------------------------
-- Bonus %
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bonus_pct(score NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN score IS NULL OR score < 90 THEN 0
    ELSE LEAST(20, 10 + (score - 90))
  END
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.score_month_status (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'approved')),
  closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  PRIMARY KEY (company_id, month)
);

CREATE TABLE IF NOT EXISTS public.department_score_weightage (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  individual_weight NUMERIC NOT NULL,
  team_weight NUMERIC NOT NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, department_id, month),
  CONSTRAINT department_score_weightage_individual_range
    CHECK (individual_weight >= 0 AND individual_weight <= 100),
  CONSTRAINT department_score_weightage_team_range
    CHECK (team_weight >= 0 AND team_weight <= 100),
  CONSTRAINT department_score_weightage_one_decimal
    CHECK (
      individual_weight = round(individual_weight, 1)
      AND team_weight = round(team_weight, 1)
    ),
  CONSTRAINT department_score_weightage_total_100
    CHECK (individual_weight + team_weight = 100)
);

CREATE TABLE IF NOT EXISTS public.score_weightage_log (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  department_id UUID,
  month DATE NOT NULL,
  old_individual NUMERIC,
  old_team NUMERIC,
  new_individual NUMERIC,
  new_team NUMERIC,
  old_status TEXT,
  new_status TEXT,
  changed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  changed_by_role TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_score_weightage_log_dept_month
  ON public.score_weightage_log (department_id, month, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_department_score_weightage_month
  ON public.department_score_weightage (company_id, month);

-- Frozen scores written when Admin approves a month. Open and closed months stay live.
CREATE TABLE IF NOT EXISTS public.score_weightage_snapshot (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (month = date_trunc('month', month)::date),
  -- Plain UUID on purpose. No foreign key, so deleting a user does not touch an approved snapshot.
  user_id UUID NOT NULL,
  full_name TEXT NOT NULL,
  department_id UUID NOT NULL,
  department_name TEXT NOT NULL,
  individual_weight NUMERIC NOT NULL,
  team_weight NUMERIC NOT NULL,
  individual_kpi_pct NUMERIC,
  team_avg_kpi_pct NUMERIC,
  individual_points NUMERIC,
  team_points NUMERIC,
  score NUMERIC,
  bonus_pct NUMERIC NOT NULL,
  PRIMARY KEY (company_id, month, user_id)
);

CREATE INDEX IF NOT EXISTS idx_score_weightage_snapshot_dept
  ON public.score_weightage_snapshot (company_id, month, department_id);

-- ---------------------------------------------------------------------------
-- Permission + month-lock + audit
-- ---------------------------------------------------------------------------
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
  -- Single switch. Admin cannot edit Score weightage while this is false.
  admin_may_edit_score_weightage CONSTANT BOOLEAN := false;
BEGIN
  NEW.month := date_trunc('month', NEW.month)::date;

  IF NEW.company_id IS NULL THEN
    SELECT d.company_id INTO NEW.company_id
    FROM public.departments d
    WHERE d.id = NEW.department_id;
  END IF;

  -- Company wipe functions null updated_by before deleting users. That must not
  -- count as a weight edit, including on an approved month. A real edit changes
  -- a weight, so the locks below still apply.
  IF TG_OP = 'UPDATE'
     AND NEW.individual_weight IS NOT DISTINCT FROM OLD.individual_weight
     AND NEW.team_weight IS NOT DISTINCT FROM OLD.team_weight
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

  -- Migrations / service role. The approved and closed locks above still apply.
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

  NEW.updated_by := auth.uid();
  NEW.updated_at := now();

  -- INSERT ... ON CONFLICT DO UPDATE fires this trigger twice.
  -- Skip the audit on the speculative insert; the UPDATE writes the one row.
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
    changed_by, changed_by_role
  ) VALUES (
    NEW.company_id, NEW.department_id, NEW.month,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.individual_weight END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.team_weight END,
    NEW.individual_weight, NEW.team_weight,
    auth.uid(), v_role
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_weightage ON public.department_score_weightage;
CREATE TRIGGER trg_guard_weightage
  BEFORE INSERT OR UPDATE ON public.department_score_weightage
  FOR EACH ROW EXECUTE FUNCTION public.guard_weightage();

CREATE OR REPLACE FUNCTION public.guard_score_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Company wipe functions are SECURITY DEFINER, so current_user is their owner
  -- (postgres, supabase_admin, or service_role). The companies FK cascade runs
  -- as that same user. A direct DELETE from authenticated or anon stays blocked.
  IF TG_OP = 'DELETE' AND current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Approved score snapshots cannot be changed';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_score_snapshot ON public.score_weightage_snapshot;
CREATE TRIGGER trg_guard_score_snapshot
  BEFORE UPDATE OR DELETE ON public.score_weightage_snapshot
  FOR EACH ROW EXECUTE FUNCTION public.guard_score_snapshot();

-- ---------------------------------------------------------------------------
-- Weight resolution: stored month, else the latest saved row from any earlier
-- month (source previous), else 80/20 (source default).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_department_score_weights(
  p_company_id UUID,
  p_department_id UUID,
  p_month DATE
)
RETURNS TABLE (
  individual_weight NUMERIC,
  team_weight NUMERIC,
  source TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::date;
  v_ind NUMERIC;
  v_team NUMERIC;
BEGIN
  SELECT w.individual_weight, w.team_weight
    INTO v_ind, v_team
  FROM public.department_score_weightage w
  WHERE w.company_id = p_company_id
    AND w.department_id = p_department_id
    AND w.month = v_month;

  IF FOUND THEN
    individual_weight := v_ind;
    team_weight := v_team;
    source := 'stored';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT w.individual_weight, w.team_weight
    INTO v_ind, v_team
  FROM public.department_score_weightage w
  WHERE w.company_id = p_company_id
    AND w.department_id = p_department_id
    AND w.month < v_month
  ORDER BY w.month DESC
  LIMIT 1;

  IF FOUND THEN
    individual_weight := v_ind;
    team_weight := v_team;
    source := 'previous';
    RETURN NEXT;
    RETURN;
  END IF;

  individual_weight := 80;
  team_weight := 20;
  source := 'default';
  RETURN NEXT;
END;
$$;

-- Individual KPI % for Score weightage only.
-- Each completed task counts once, in the Asia/Karachi calendar month of completed_at.
-- Start and end dates are ignored. Awarded value is kpis.assigned_score only.
-- NULL assigned_score counts as 0. No completed task in that month returns NULL.
-- Does not call or replace public.kpi_award_month_score.
CREATE OR REPLACE FUNCTION public.score_weightage_month_kpi_pct(
  p_user_id UUID,
  p_month DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month DATE := date_trunc('month', p_month)::date;
  v_count INTEGER := 0;
  v_sum NUMERIC := 0;
BEGIN
  SELECT
    COUNT(*)::INTEGER,
    ROUND(COALESCE(SUM(GREATEST(COALESCE(k.assigned_score, 0), 0)), 0), 2)
  INTO v_count, v_sum
  FROM public.kpis k
  WHERE k.user_id = p_user_id
    AND k.completion_status = 'completed'
    AND k.completed_at IS NOT NULL
    AND date_trunc('month', (timezone('Asia/Karachi', k.completed_at))::date)::date = v_month;

  IF COALESCE(v_count, 0) = 0 THEN
    RETURN NULL;
  END IF;

  RETURN LEAST(100, v_sum);
END;
$$;

-- Team average of every employee and manager. No completed task counts as 0%, not as a gap.
-- HR and Admin are not included.
CREATE OR REPLACE FUNCTION public.department_team_avg_kpi_pct(
  p_department_id UUID,
  p_month DATE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ROUND(AVG(COALESCE(s.kpi_pct, 0)), 2)
  FROM (
    SELECT public.score_weightage_month_kpi_pct(u.id, date_trunc('month', p_month)::date) AS kpi_pct
    FROM public.users u
    WHERE u.department_id = p_department_id
      AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
      AND coalesce(u.is_demo, false) = false
  ) s
$$;

-- One live score row. Open and closed months use this. Approved months use the snapshot.
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
  END IF;

  -- No completed task counts as 0% KPI. Individual points are 0, team points still apply.
  v_ind_kpi := COALESCE(v_ind_kpi, 0);
  v_ind_pts := ROUND(v_ind_kpi * v_ind_w / 100, 1);
  v_team_pts := ROUND(COALESCE(v_team_avg, 0) * v_team_w / 100, 1);
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

-- Internal helpers. Score RPCs are security definer and call these.
-- Not granted to authenticated, so an employee cannot pass another user's id.
DO $revoke_score_internal$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.bonus_pct(NUMERIC)',
    'public.resolve_department_score_weights(UUID, UUID, DATE)',
    'public.score_weightage_month_kpi_pct(UUID, DATE)',
    'public.department_team_avg_kpi_pct(UUID, DATE)',
    'public.score_weightage_live_row(UUID, UUID, DATE)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
  END LOOP;
END
$revoke_score_internal$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.score_month_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_score_weightage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_weightage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_weightage_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS score_month_status_select_company ON public.score_month_status;
CREATE POLICY score_month_status_select_company ON public.score_month_status
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS department_score_weightage_select_company ON public.department_score_weightage;
DROP POLICY IF EXISTS department_score_weightage_select_scope ON public.department_score_weightage;
CREATE POLICY department_score_weightage_select_scope ON public.department_score_weightage
  FOR SELECT TO authenticated
  USING (
    company_id = public.current_company_id()
    AND EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND (
          me.role IN ('hr'::public.user_role, 'admin'::public.user_role)
          OR me.department_id = department_score_weightage.department_id
        )
    )
  );

DROP POLICY IF EXISTS department_score_weightage_write_auth ON public.department_score_weightage;

DROP POLICY IF EXISTS score_weightage_log_select_company ON public.score_weightage_log;
DROP POLICY IF EXISTS score_weightage_log_select_hr_admin ON public.score_weightage_log;
CREATE POLICY score_weightage_log_select_hr_admin ON public.score_weightage_log
  FOR SELECT TO authenticated
  USING (
    company_id = public.current_company_id()
    AND EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND me.role IN ('hr'::public.user_role, 'admin'::public.user_role)
    )
  );

DROP POLICY IF EXISTS score_weightage_snapshot_select ON public.score_weightage_snapshot;
CREATE POLICY score_weightage_snapshot_select ON public.score_weightage_snapshot
  FOR SELECT TO authenticated
  USING (
    company_id = public.current_company_id()
    AND EXISTS (
      SELECT 1 FROM public.users me
      WHERE me.id = auth.uid()
        AND (
          score_weightage_snapshot.user_id = me.id
          OR me.role IN ('hr'::public.user_role, 'admin'::public.user_role)
          OR (me.role = 'manager'::public.user_role AND me.department_id = score_weightage_snapshot.department_id)
        )
    )
  );

DO $revoke_score_writes$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.department_score_weightage FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_weightage_log FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_weightage_snapshot FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_month_status FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.department_score_weightage FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_weightage_log FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_weightage_snapshot FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.score_month_status FROM authenticated';
  END IF;
END
$revoke_score_writes$;

-- ---------------------------------------------------------------------------
-- Month status RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_score_month_status(p_month DATE)
RETURNS TABLE (
  company_id UUID,
  month DATE,
  status TEXT,
  closed_by UUID,
  closed_at TIMESTAMPTZ,
  approved_by UUID,
  approved_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.score_month_status s
    WHERE s.company_id = v_company AND s.month = v_month
  ) THEN
    RETURN QUERY
    SELECT s.company_id, s.month, s.status, s.closed_by, s.closed_at, s.approved_by, s.approved_at
    FROM public.score_month_status s
    WHERE s.company_id = v_company AND s.month = v_month;
  ELSE
    RETURN QUERY
    SELECT v_company, v_month, 'open'::text, NULL::uuid, NULL::timestamptz, NULL::uuid, NULL::timestamptz;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_score_month_status(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_score_month(p_month DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_status TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_hr(v_uid) THEN
    RAISE EXCEPTION 'Only HR can close a score month';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;
  SELECT u.role::text INTO v_role FROM public.users u WHERE u.id = v_uid;

  IF v_month > date_trunc('month', (timezone('Asia/Karachi', now()))::date)::date THEN
    RAISE EXCEPTION 'Cannot close a future month';
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;

  IF v_status = 'approved' THEN
    RAISE EXCEPTION 'Month % is already approved', v_month;
  END IF;
  IF v_status = 'closed' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'closed', 'month', v_month);
  END IF;

  INSERT INTO public.score_month_status (company_id, month, status, closed_by, closed_at)
  VALUES (v_company, v_month, 'closed', v_uid, now())
  ON CONFLICT (company_id, month) DO UPDATE
    SET status = 'closed',
        closed_by = v_uid,
        closed_at = now();

  INSERT INTO public.score_weightage_log (
    company_id, month, old_status, new_status, changed_by, changed_by_role
  ) VALUES (
    v_company, v_month, COALESCE(v_status, 'open'), 'closed', v_uid, v_role
  );

  RETURN jsonb_build_object('ok', true, 'status', 'closed', 'month', v_month);
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_score_month(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_score_month(p_month DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_status TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;
  v_status := COALESCE(v_status, 'open');

  IF v_status = 'approved' THEN
    RAISE EXCEPTION 'An approved month cannot be reopened';
  END IF;
  IF NOT public.is_hr(v_uid) THEN
    RAISE EXCEPTION 'Only HR can reopen a score month';
  END IF;
  IF v_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'Only a closed month can be reopened';
  END IF;

  SELECT u.role::text INTO v_role FROM public.users u WHERE u.id = v_uid;

  UPDATE public.score_month_status
  SET status = 'open',
      closed_by = NULL,
      closed_at = NULL
  WHERE company_id = v_company AND month = v_month;

  INSERT INTO public.score_weightage_log (
    company_id, month, old_status, new_status, changed_by, changed_by_role
  ) VALUES (
    v_company, v_month, 'closed', 'open', v_uid, v_role
  );

  RETURN jsonb_build_object('ok', true, 'status', 'open', 'month', v_month);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_score_month(DATE) TO authenticated;

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

  -- Snapshot while the month is still closed. Points are already rounded to 1 decimal.
  -- Score is their sum, and bonus % is calculated from that score.
  INSERT INTO public.score_weightage_snapshot (
    company_id, month, user_id, full_name, department_id, department_name,
    individual_weight, team_weight, individual_kpi_pct, team_avg_kpi_pct,
    individual_points, team_points, score, bonus_pct
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

GRANT EXECUTE ON FUNCTION public.approve_score_month(DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- Weightage list / upsert / audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_department_score_weightages(p_month DATE)
RETURNS TABLE (
  department_id UUID,
  department_name TEXT,
  month DATE,
  individual_weight NUMERIC,
  team_weight NUMERIC,
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
  p_team_weight NUMERIC
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

  INSERT INTO public.department_score_weightage (
    company_id, department_id, month, individual_weight, team_weight
  ) VALUES (
    v_company, p_department_id, v_month, p_individual_weight, p_team_weight
  )
  ON CONFLICT (company_id, department_id, month) DO UPDATE
    SET individual_weight = EXCLUDED.individual_weight,
        team_weight = EXCLUDED.team_weight;

  RETURN jsonb_build_object(
    'ok', true,
    'department_id', p_department_id,
    'month', v_month,
    'individual_weight', p_individual_weight,
    'team_weight', p_team_weight
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_department_score_weightage(UUID, DATE, NUMERIC, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_score_weightage_log(p_month DATE)
RETURNS TABLE (
  id BIGINT,
  department_id UUID,
  department_name TEXT,
  month DATE,
  old_individual NUMERIC,
  old_team NUMERIC,
  new_individual NUMERIC,
  new_team NUMERIC,
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

-- ---------------------------------------------------------------------------
-- Scores: live while open or closed; snapshot after approval
-- ---------------------------------------------------------------------------
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
    'weight_source', v_row.weight_source,
    'individual_points', v_row.individual_points,
    'team_points', v_row.team_points,
    'score', v_row.score,
    'bonus_pct', v_row.bonus_pct
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_score_weightage(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_department_score_results(
  p_department_id UUID,
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
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_dept_name TEXT;
  v_dept_company UUID;
  v_status TEXT := 'open';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;
  v_company := public.current_company_id();

  SELECT d.name, d.company_id INTO v_dept_name, v_dept_company
  FROM public.departments d
  WHERE d.id = p_department_id AND d.active = true;

  IF v_dept_company IS NULL OR v_dept_company IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Department not found';
  END IF;

  IF NOT (
    v_me.role IN ('hr'::public.user_role, 'admin'::public.user_role)
    OR (v_me.role = 'manager'::public.user_role AND v_me.department_id = p_department_id)
  ) THEN
    RAISE EXCEPTION 'Not allowed to view department scores';
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;
  v_status := COALESCE(v_status, 'open');

  IF v_status = 'approved' THEN
    RETURN QUERY
    SELECT
      s.user_id,
      s.full_name,
      s.department_id,
      s.department_name,
      s.individual_kpi_pct,
      s.team_avg_kpi_pct,
      s.individual_weight,
      s.team_weight,
      s.individual_points,
      s.team_points,
      s.score,
      s.bonus_pct
    FROM public.score_weightage_snapshot s
    WHERE s.company_id = v_company
      AND s.month = v_month
      AND s.department_id = p_department_id
    ORDER BY s.full_name;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    l.user_id,
    l.full_name,
    l.department_id,
    COALESCE(l.department_name, v_dept_name),
    l.individual_kpi_pct,
    l.team_avg_kpi_pct,
    l.individual_weight,
    l.team_weight,
    l.individual_points,
    l.team_points,
    l.score,
    l.bonus_pct
  FROM public.users u
  CROSS JOIN LATERAL public.score_weightage_live_row(v_company, u.id, v_month) l
  WHERE u.department_id = p_department_id
    AND u.company_id = v_company
    AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
    AND coalesce(u.is_demo, false) = false
  ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_department_score_results(UUID, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_org_score_bonus(p_month DATE)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  department_id UUID,
  department_name TEXT,
  individual_kpi_pct NUMERIC,
  team_avg_kpi_pct NUMERIC,
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
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_company UUID;
  v_month DATE := date_trunc('month', p_month)::date;
  v_status TEXT := 'open';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT * INTO v_me FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND OR v_me.role NOT IN ('hr'::public.user_role, 'admin'::public.user_role) THEN
    RAISE EXCEPTION 'Only HR and Admin can view the organization bonus list';
  END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'No company context';
  END IF;

  SELECT s.status INTO v_status
  FROM public.score_month_status s
  WHERE s.company_id = v_company AND s.month = v_month;
  v_status := COALESCE(v_status, 'open');

  IF v_status = 'approved' THEN
    RETURN QUERY
    SELECT
      s.user_id,
      s.full_name,
      s.department_id,
      s.department_name,
      s.individual_kpi_pct,
      s.team_avg_kpi_pct,
      s.individual_points,
      s.team_points,
      s.score,
      s.bonus_pct
    FROM public.score_weightage_snapshot s
    WHERE s.company_id = v_company
      AND s.month = v_month
    ORDER BY s.department_name, s.full_name;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    l.user_id,
    l.full_name,
    l.department_id,
    l.department_name,
    l.individual_kpi_pct,
    l.team_avg_kpi_pct,
    l.individual_points,
    l.team_points,
    l.score,
    l.bonus_pct
  FROM public.users u
  JOIN public.departments d
    ON d.id = u.department_id
   AND d.company_id = v_company
   AND d.active = true
  CROSS JOIN LATERAL public.score_weightage_live_row(v_company, u.id, v_month) l
  WHERE u.company_id = v_company
    AND u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
    AND coalesce(u.is_demo, false) = false
  ORDER BY d.name, u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_org_score_bonus(DATE) TO authenticated;

GRANT SELECT ON public.score_month_status TO authenticated;
GRANT SELECT ON public.department_score_weightage TO authenticated;
GRANT SELECT ON public.score_weightage_log TO authenticated;
GRANT SELECT ON public.score_weightage_snapshot TO authenticated;

-- ---------------------------------------------------------------------------
-- Seed October 2026: open month + 80/20 for every active department
-- ---------------------------------------------------------------------------
INSERT INTO public.score_month_status (company_id, month, status)
SELECT DISTINCT d.company_id, DATE '2026-10-01', 'open'
FROM public.departments d
WHERE d.active = true
  AND d.company_id IS NOT NULL
ON CONFLICT (company_id, month) DO NOTHING;

-- First apply only. A later run must not store 80/20 over a department that is
-- still using an earlier month or the default.
INSERT INTO public.department_score_weightage (
  company_id, department_id, month, individual_weight, team_weight
)
SELECT d.company_id, d.id, DATE '2026-10-01', 80, 20
FROM public.departments d
WHERE d.active = true
  AND d.company_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.department_score_weightage w
    WHERE w.company_id = d.company_id
      AND w.month = DATE '2026-10-01'
  )
ON CONFLICT (company_id, department_id, month) DO NOTHING;

COMMIT;
