-- Company KPI library: create KPIs first, then assign them to people.

CREATE TABLE IF NOT EXISTS public.kpi_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    name TEXT NOT NULL,
    description TEXT,
    kpi_category TEXT NOT NULL DEFAULT 'monthly_goal',
    weight NUMERIC NOT NULL CHECK (weight >= 1 AND weight <= 100),
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_kpi_templates_company ON public.kpi_templates(company_id, active);
CREATE INDEX IF NOT EXISTS idx_kpi_templates_demo ON public.kpi_templates(is_demo, active);

ALTER TABLE public.kpi_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kpi_templates_select ON public.kpi_templates;
CREATE POLICY kpi_templates_select ON public.kpi_templates
    FOR SELECT TO authenticated
    USING (
        (public.is_demo_user(auth.uid()) AND is_demo = true)
        OR (
            NOT public.is_demo_user(auth.uid())
            AND company_id IS NOT DISTINCT FROM public.current_company_id()
            AND is_demo = false
        )
    );

REVOKE ALL ON public.kpi_templates FROM anon, public;
GRANT SELECT ON public.kpi_templates TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_kpi_templates()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role public.user_role;
BEGIN
    IF auth.uid() IS NULL THEN RETURN false; END IF;
    IF public.is_admin(auth.uid()) THEN RETURN true; END IF;
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
    RETURN v_role = 'manager'::public.user_role;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_kpi_templates() TO authenticated;

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
        WHERE (
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

CREATE OR REPLACE FUNCTION public.create_kpi_template(
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_weight NUMERIC DEFAULT 10
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

    INSERT INTO public.kpi_templates (
        company_id, is_demo, name, description, kpi_category, weight, created_by, active
    ) VALUES (
        v_me.company_id,
        COALESCE(v_me.is_demo, false),
        v_name,
        NULLIF(trim(COALESCE(p_description, '')), ''),
        v_cat,
        v_weight,
        v_me.id,
        true
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_kpi_template(TEXT, TEXT, TEXT, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_kpi_template(
    p_id UUID,
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_category TEXT DEFAULT 'monthly_goal',
    p_weight NUMERIC DEFAULT 10,
    p_active BOOLEAN DEFAULT true
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

    UPDATE public.kpi_templates t SET
        name = v_name,
        description = NULLIF(trim(COALESCE(p_description, '')), ''),
        kpi_category = v_cat,
        weight = v_weight,
        active = COALESCE(p_active, true),
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

GRANT EXECUTE ON FUNCTION public.update_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_kpi_from_template(
    p_employee_id UUID,
    p_template_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t public.kpi_templates;
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

    RETURN QUERY SELECT * FROM public.assign_employee_kpi(
        p_employee_id,
        v_t.name,
        v_t.description,
        v_t.weight,
        p_start_date,
        p_end_date,
        p_notes,
        v_t.kpi_category
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_kpi_from_template(UUID, UUID, DATE, DATE, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
