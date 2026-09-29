-- Person-scoped KPI templates: owner_user_id NULL = company shared library;
-- owner_user_id set = individual KPI belonging only to that employee/manager.
-- Assign Task lists person templates only; KPI's desk keeps the shared library.

ALTER TABLE public.kpi_templates
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_kpi_templates_owner
  ON public.kpi_templates(company_id, owner_user_id, active);

COMMENT ON COLUMN public.kpi_templates.owner_user_id IS
  'NULL = shared company library. Non-NULL = personal KPI template for that user only.';

-- Shared library list (KPI's desk): exclude person-owned templates.
CREATE OR REPLACE FUNCTION public.list_kpi_templates(p_include_inactive BOOLEAN DEFAULT false)
RETURNS SETOF public.kpi_templates
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    RETURN QUERY
        SELECT t.*
        FROM public.kpi_templates t
        WHERE t.owner_user_id IS NULL
          AND (
            (public.is_demo_user(auth.uid()) AND t.is_demo = true)
            OR (
                NOT public.is_demo_user(auth.uid())
                AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
                AND t.is_demo = false
            )
          )
          AND (p_include_inactive OR t.active = true)
        ORDER BY t.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_kpi_templates(BOOLEAN) TO authenticated;

-- Person-scoped templates for Assign Task dropdown.
CREATE OR REPLACE FUNCTION public.list_person_kpi_templates(
    p_owner_user_id UUID,
    p_include_inactive BOOLEAN DEFAULT false
)
RETURNS SETOF public.kpi_templates
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_owner_user_id IS NULL THEN RAISE EXCEPTION 'Person is required'; END IF;
    IF NOT public.can_assign_kpi_to(p_owner_user_id) THEN
        RAISE EXCEPTION 'Not authorized to view KPIs for this person';
    END IF;

    RETURN QUERY
        SELECT t.*
        FROM public.kpi_templates t
        WHERE t.owner_user_id = p_owner_user_id
          AND (
            (public.is_demo_user(auth.uid()) AND t.is_demo = true)
            OR (
                NOT public.is_demo_user(auth.uid())
                AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
                AND t.is_demo = false
            )
          )
          AND (p_include_inactive OR t.active = true)
        ORDER BY t.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_person_kpi_templates(UUID, BOOLEAN) TO authenticated;

-- Shared library create: always owner_user_id NULL.
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
        late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days,
        owner_user_id
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
        v_grace,
        NULL
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_kpi_template(TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;

-- Individual KPI for one person (Assign Task create flow).
CREATE OR REPLACE FUNCTION public.create_person_kpi_template(
    p_owner_user_id UUID,
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
    v_owner public.users%ROWTYPE;
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_weight NUMERIC := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
    v_row public.kpi_templates;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_owner_user_id IS NULL THEN RAISE EXCEPTION 'Person is required'; END IF;
    IF NOT public.can_assign_kpi_to(p_owner_user_id) THEN
        RAISE EXCEPTION 'Not authorized to create KPIs for this person';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_owner FROM public.users WHERE id = p_owner_user_id;
    IF v_owner.id IS NULL THEN RAISE EXCEPTION 'Person not found'; END IF;

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
        late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days,
        owner_user_id
    ) VALUES (
        COALESCE(v_owner.company_id, v_me.company_id),
        COALESCE(v_owner.is_demo, v_me.is_demo, false),
        v_name,
        NULLIF(trim(COALESCE(p_description, '')), ''),
        v_cat,
        v_weight,
        v_me.id,
        true,
        COALESCE(p_late_penalty_enabled, false),
        v_ptype,
        v_pval,
        v_grace,
        p_owner_user_id
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_person_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;

-- Shared-library updates only (owner_user_id IS NULL).
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
      AND t.owner_user_id IS NULL
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

GRANT EXECUTE ON FUNCTION public.update_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;

-- Assign from template: shared OK for anyone assignable; personal only to its owner.
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

    IF v_t.owner_user_id IS NOT NULL AND v_t.owner_user_id IS DISTINCT FROM p_employee_id THEN
        RAISE EXCEPTION 'This KPI belongs to another person';
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

GRANT EXECUTE ON FUNCTION public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT, NUMERIC, NUMERIC) TO authenticated;

-- Backfill personal templates from existing assigned KPI rows (one per person+name+category).
INSERT INTO public.kpi_templates (
    company_id, is_demo, name, description, kpi_category, weight, created_by, active,
    late_penalty_enabled, late_penalty_type, late_penalty_value, late_penalty_grace_days,
    owner_user_id
)
SELECT DISTINCT ON (
    k.user_id,
    lower(trim(k.name)),
    lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal'))
)
    u.company_id,
    COALESCE(u.is_demo, false),
    trim(k.name),
    NULLIF(trim(COALESCE(k.description, '')), ''),
    CASE
        WHEN lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal'))
             IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks')
            THEN lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal'))
        ELSE 'monthly_goal'
    END,
    GREATEST(1, LEAST(100, round(COALESCE(k.weight, 10)::NUMERIC, 2))),
    NULL,
    true,
    COALESCE(k.late_penalty_enabled, false),
    COALESCE(NULLIF(trim(k.late_penalty_type), ''), 'percentage_cut'),
    GREATEST(0, LEAST(100, round(COALESCE(k.late_penalty_value, 50)::NUMERIC, 2))),
    GREATEST(0, COALESCE(k.late_penalty_grace_days, 0)),
    k.user_id
FROM public.kpis k
JOIN public.users u ON u.id = k.user_id
WHERE trim(COALESCE(k.name, '')) <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM public.kpi_templates t
      WHERE t.owner_user_id = k.user_id
        AND lower(t.name) = lower(trim(k.name))
        AND t.kpi_category = CASE
            WHEN lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal'))
                 IN ('monthly_goal', 'quality', 'punctuality_behaviour', 'urgent_tasks')
                THEN lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal'))
            ELSE 'monthly_goal'
        END
  )
ORDER BY
    k.user_id,
    lower(trim(k.name)),
    lower(COALESCE(NULLIF(trim(k.kpi_category), ''), NULLIF(trim(k.category), ''), 'monthly_goal')),
    k.created_at DESC NULLS LAST;

NOTIFY pgrst, 'reload schema';
