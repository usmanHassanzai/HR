-- Edit / soft-remove person-scoped KPI templates (owner_user_id set).
-- Shared library updates stay on update_kpi_template (owner_user_id IS NULL).

CREATE OR REPLACE FUNCTION public.update_person_kpi_template(
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
    v_owner UUID;
    v_cat TEXT := lower(trim(COALESCE(p_category, 'monthly_goal')));
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_weight NUMERIC := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    v_ptype TEXT := lower(trim(COALESCE(p_late_penalty_type, 'percentage_cut')));
    v_pval NUMERIC := round(COALESCE(p_late_penalty_value, 50)::NUMERIC, 2);
    v_grace INTEGER := GREATEST(COALESCE(p_late_penalty_grace_days, 0), 0);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT t.owner_user_id INTO v_owner
    FROM public.kpi_templates t
    WHERE t.id = p_id
      AND t.owner_user_id IS NOT NULL
      AND (
          (public.is_demo_user(auth.uid()) AND t.is_demo = true)
          OR (
              NOT public.is_demo_user(auth.uid())
              AND t.company_id IS NOT DISTINCT FROM public.current_company_id()
              AND t.is_demo = false
          )
      );

    IF v_owner IS NULL THEN RAISE EXCEPTION 'Personal KPI not found'; END IF;
    IF NOT public.can_assign_kpi_to(v_owner) THEN
        RAISE EXCEPTION 'Not authorized to edit KPIs for this person';
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
      AND t.owner_user_id = v_owner
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Personal KPI not found'; END IF;
    RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_person_kpi_template(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN, TEXT, NUMERIC, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
