-- Decouple late-penalty scoring from KPI category.
-- Category stays a display/grouping label; scoring rules are explicit fields.

ALTER TABLE public.kpis
  ADD COLUMN IF NOT EXISTS late_penalty_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_penalty_type TEXT NOT NULL DEFAULT 'percentage_cut',
  ADD COLUMN IF NOT EXISTS late_penalty_value NUMERIC NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS late_penalty_grace_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.kpi_templates
  ADD COLUMN IF NOT EXISTS late_penalty_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_penalty_type TEXT NOT NULL DEFAULT 'percentage_cut',
  ADD COLUMN IF NOT EXISTS late_penalty_value NUMERIC NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS late_penalty_grace_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_late_penalty_type_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_late_penalty_type_check
  CHECK (late_penalty_type IN ('percentage_cut'));

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_late_penalty_value_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_late_penalty_value_check
  CHECK (late_penalty_value >= 0 AND late_penalty_value <= 100);

ALTER TABLE public.kpis DROP CONSTRAINT IF EXISTS kpis_late_penalty_grace_days_check;
ALTER TABLE public.kpis ADD CONSTRAINT kpis_late_penalty_grace_days_check
  CHECK (late_penalty_grace_days >= 0);

ALTER TABLE public.kpi_templates DROP CONSTRAINT IF EXISTS kpi_templates_late_penalty_type_check;
ALTER TABLE public.kpi_templates ADD CONSTRAINT kpi_templates_late_penalty_type_check
  CHECK (late_penalty_type IN ('percentage_cut'));

ALTER TABLE public.kpi_templates DROP CONSTRAINT IF EXISTS kpi_templates_late_penalty_value_check;
ALTER TABLE public.kpi_templates ADD CONSTRAINT kpi_templates_late_penalty_value_check
  CHECK (late_penalty_value >= 0 AND late_penalty_value <= 100);

ALTER TABLE public.kpi_templates DROP CONSTRAINT IF EXISTS kpi_templates_late_penalty_grace_days_check;
ALTER TABLE public.kpi_templates ADD CONSTRAINT kpi_templates_late_penalty_grace_days_check
  CHECK (late_penalty_grace_days >= 0);

-- Preserve prior behavior: late completion used to cut score in half for all KPIs.
UPDATE public.kpis SET
  late_penalty_enabled = true,
  late_penalty_type = 'percentage_cut',
  late_penalty_value = 50,
  late_penalty_grace_days = 0
WHERE late_penalty_enabled = false;

-- Urgent Tasks templates keep the explicit late rule; other templates default off for new assigns.
UPDATE public.kpi_templates SET
  late_penalty_enabled = true,
  late_penalty_type = 'percentage_cut',
  late_penalty_value = 50,
  late_penalty_grace_days = 0
WHERE kpi_category = 'urgent_tasks';

UPDATE public.kpi_templates SET
  late_penalty_enabled = false
WHERE kpi_category IS DISTINCT FROM 'urgent_tasks';

DROP FUNCTION IF EXISTS public.kpi_is_late_completion(DATE, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.kpi_is_late_completion(
    p_end_date DATE,
    p_completed_at TIMESTAMPTZ,
    p_grace_days INTEGER DEFAULT 0
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT p_end_date IS NOT NULL
       AND p_completed_at IS NOT NULL
       AND (
         (p_completed_at AT TIME ZONE 'Asia/Karachi')::DATE
         > (p_end_date + GREATEST(COALESCE(p_grace_days, 0), 0))
       );
$$;

CREATE OR REPLACE FUNCTION public.kpi_points_awarded(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_score NUMERIC;
    v_keep NUMERIC;
BEGIN
    IF k.completion_status IS DISTINCT FROM 'completed' THEN
        RETURN 0;
    END IF;
    v_score := GREATEST(COALESCE(k.assigned_score, k.weight, 0), 0);
    IF NOT COALESCE(k.late_penalty_enabled, false) THEN
        RETURN ROUND(v_score, 2);
    END IF;
    IF NOT public.kpi_is_late_completion(
        k.end_date,
        COALESCE(k.completed_at, k.updated_at),
        COALESCE(k.late_penalty_grace_days, 0)
    ) THEN
        RETURN ROUND(v_score, 2);
    END IF;
    -- percentage_cut: value 50 means award 50% of score (half).
    IF COALESCE(k.late_penalty_type, 'percentage_cut') = 'percentage_cut' THEN
        v_keep := GREATEST(0, LEAST(100, COALESCE(k.late_penalty_value, 50))) / 100.0;
        RETURN ROUND(v_score * v_keep, 2);
    END IF;
    RETURN ROUND(v_score, 2);
END;
$$;

DROP FUNCTION IF EXISTS public.create_kpi_template(TEXT, TEXT, TEXT, NUMERIC);
CREATE OR REPLACE FUNCTION public.create_kpi_template(
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_weight NUMERIC DEFAULT 10,
    p_late_penalty_enabled BOOLEAN DEFAULT false,
    p_late_penalty_type TEXT DEFAULT 'percentage_cut',
    p_late_penalty_value NUMERIC DEFAULT 50,
    p_late_penalty_grace_days INTEGER DEFAULT 0
)
RETURNS public.kpi_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_me public.users%ROWTYPE;
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_weight NUMERIC := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
    v_row public.kpi_templates;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.can_manage_kpi_templates() THEN
        RAISE EXCEPTION 'Only admins and managers can create KPIs';
    END IF;
    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_name = '' THEN RAISE EXCEPTION 'KPI name is required'; END IF;
    IF v_cat NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN
        RAISE EXCEPTION 'Choose one of the four KPI categories';
    END IF;
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
    END IF;
    IF v_ptype <> 'percentage_cut' THEN
        RAISE EXCEPTION 'Unsupported late penalty type';
    END IF;
    IF v_pval < 0 OR v_pval > 100 THEN
        RAISE EXCEPTION 'Late penalty value must be between 0 and 100';
    END IF;

    INSERT INTO public.kpi_templates (
        company_id, is_demo, name, description, kpi_category, weight, created_by, active,
        late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days
    ) VALUES (
        v_me.company_id,
        COALESCE(v_me.is_demo, false),
        v_name,
        NULLIF(trim(COALESCE(p_description, '')), ''),
        v_cat,
        v_weight,
        v_me.id,
        true,
        COALESCE(p_late_penalty_enabled, false),
        v_ptype,
        v_pval,
        v_grace
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.update_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN);
CREATE OR REPLACE FUNCTION public.update_kpi_template(
    p_id UUID,
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_weight NUMERIC DEFAULT 10,
    p_active BOOLEAN DEFAULT true,
    p_late_penalty_enabled BOOLEAN DEFAULT false,
    p_late_penalty_type TEXT DEFAULT 'percentage_cut',
    p_late_penalty_value NUMERIC DEFAULT 50,
    p_late_penalty_grace_days INTEGER DEFAULT 0
)
RETURNS public.kpi_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.kpi_templates;
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_weight NUMERIC := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
BEGIN
    IF NOT public.can_manage_kpi_templates() THEN
        RAISE EXCEPTION 'Only admins and managers can edit KPIs';
    END IF;
    IF v_name = '' THEN RAISE EXCEPTION 'KPI name is required'; END IF;
    IF v_cat NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN
        RAISE EXCEPTION 'Choose one of the four KPI categories';
    END IF;
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
    END IF;
    IF v_ptype <> 'percentage_cut' THEN
        RAISE EXCEPTION 'Unsupported late penalty type';
    END IF;
    IF v_pval < 0 OR v_pval > 100 THEN
        RAISE EXCEPTION 'Late penalty value must be between 0 and 100';
    END IF;

    UPDATE public.kpi_templates t SET
        name = v_name,
        description = NULLIF(trim(COALESCE(p_description, '')), ''),
        kpi_category = v_cat,
        weight = v_weight,
        active = COALESCE(p_active, true),
        late_penalty_enabled = COALESCE(p_late_penalty_enabled, false),
        late_penalty_type = v_ptype,
        late_penalty_value = v_pval,
        late_penalty_grace_days = v_grace,
        updated_at = timezone('utc'::text, now())
    WHERE t.id = p_id
      AND (
          (public.is_demo_user(auth.uid()) AND t.is_demo = true)
          OR (
              NOT public.is_demo_user(auth.uid())
              AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
              AND t.is_demo = false
          )
      )
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN RAISE EXCEPTION 'KPI not found'; END IF;
    RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, NUMERIC);
CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_assigned_score NUMERIC DEFAULT NULL,
    p_late_penalty_enabled BOOLEAN DEFAULT false,
    p_late_penalty_type TEXT DEFAULT 'percentage_cut',
    p_late_penalty_value NUMERIC DEFAULT 50,
    p_late_penalty_grace_days INTEGER DEFAULT 0
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_emp_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
    v_score NUMERIC;
    v_pending NUMERIC := 0;
    v_name TEXT;
    v_notes TEXT := nullif(btrim(COALESCE(p_notes, '')), '');
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
BEGIN
    IF NOT public.can_assign_kpi_to(p_employee_id) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this person';
    END IF;

    IF v_cat NOT IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks') THEN
        v_cat := 'monthly_goal';
    END IF;

    v_name := trim(COALESCE(p_kpi_name, ''));
    IF v_name = '' THEN
        RAISE EXCEPTION 'KPI name is required';
    END IF;

    v_weight := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
    END IF;

    v_score := round(COALESCE(p_assigned_score, v_weight)::NUMERIC, 2);
    IF v_score < 0 THEN
        RAISE EXCEPTION 'Score cannot be negative';
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Start date and end date are required';
    END IF;
    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date must be on or after start date';
    END IF;
    IF v_ptype <> 'percentage_cut' THEN
        RAISE EXCEPTION 'Unsupported late penalty type';
    END IF;
    IF v_pval < 0 OR v_pval > 100 THEN
        RAISE EXCEPTION 'Late penalty value must be between 0 and 100';
    END IF;

    SELECT u.email, u.full_name, u.department_id
    INTO v_email, v_emp_name, v_dept_id
    FROM public.users u
    WHERE u.id = p_employee_id;

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Person not found';
    END IF;

    IF v_dept_id IS NOT NULL THEN
        SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id;
    END IF;

    SELECT COALESCE(SUM(weight), 0) INTO v_pending
    FROM public.kpis
    WHERE user_id = p_employee_id
      AND completion_status = 'pending';

    IF v_pending + v_weight > 100.05 THEN
        RAISE EXCEPTION 'This person''s open KPI weights cannot exceed 100%% (currently % + %).',
            round(v_pending, 2), v_weight;
    END IF;

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category, kpi_category,
        start_date, end_date, target_value, current_value, weight, assigned_score, direction,
        status, completion_status, redo_count, assignment_notes,
        late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days
    ) VALUES (
        p_employee_id, v_name, NULLIF(trim(COALESCE(p_description, '')), ''),
        v_dept_name, v_dept_id, v_cat, v_cat,
        p_start_date, p_end_date, 100, 0, v_weight, v_score, 'higher_better',
        'on_track', 'pending', 0, v_notes,
        COALESCE(p_late_penalty_enabled, false), v_ptype, v_pval, v_grace
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI assigned',
        'You were assigned: "' || v_name || '". Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    RETURN QUERY SELECT v_email, COALESCE(v_emp_name, 'Employee'), v_kpi_id, v_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT, NUMERIC, NUMERIC);
CREATE OR REPLACE FUNCTION public.assign_kpi_from_template(
    p_employee_id UUID,
    p_template_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT NULL,
    p_assigned_score NUMERIC DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t public.kpi_templates;
    v_weight NUMERIC;
BEGIN
    SELECT * INTO v_t
    FROM public.kpi_templates t
    WHERE t.id = p_template_id
      AND t.active = true
      AND (
          (public.is_demo_user(auth.uid()) AND t.is_demo = true)
          OR (
              NOT public.is_demo_user(auth.uid())
              AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
              AND t.is_demo = false
          )
      );
    IF v_t.id IS NULL THEN
        RAISE EXCEPTION 'KPI not found. Create it first, then assign.';
    END IF;

    v_weight := COALESCE(p_weight, v_t.weight);

    RETURN QUERY SELECT * FROM public.assign_employee_kpi(
        p_employee_id,
        v_t.name,
        v_t.description,
        v_weight,
        p_start_date,
        p_end_date,
        p_notes,
        v_t.kpi_category,
        COALESCE(p_assigned_score, v_weight),
        COALESCE(v_t.late_penalty_enabled, false),
        COALESCE(v_t.late_penalty_type, 'percentage_cut'),
        COALESCE(v_t.late_penalty_value, 50),
        COALESCE(v_t.late_penalty_grace_days, 0)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_is_late_completion(DATE, TIMESTAMPTZ, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_points_awarded(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_kpi_template(TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT, NUMERIC, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
