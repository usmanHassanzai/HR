-- Restore KPI indicator RPCs dropped by fix_live_deploy.sql (fixes PostgREST schema cache error).

CREATE OR REPLACE FUNCTION public.can_manage_department_kpis(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id
              AND (
                  public.is_demo_user(auth.uid())
                  OR d.company_id = public.current_company_id()
                  OR (d.is_demo = true AND public.is_demo_user(auth.uid()))
              )
        );
    END IF;
    RETURN public.manager_can_access_department(p_department_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_department_kpi_indicators(p_department_id UUID DEFAULT NULL)
RETURNS TABLE(
    id UUID,
    department_id UUID,
    department_name TEXT,
    name TEXT,
    description TEXT,
    weight_pct NUMERIC,
    sort_order INTEGER
) AS $$
DECLARE
    v_mgr_dept UUID;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF p_department_id IS NOT NULL AND NOT public.can_manage_department_kpis(p_department_id)
       AND NOT public.is_admin(auth.uid()) THEN
        IF NOT public.manager_can_access_department(p_department_id) THEN
            RAISE EXCEPTION 'You do not have access to this department';
        END IF;
    END IF;

    v_mgr_dept := public.user_department_id();

    RETURN QUERY
    SELECT
        i.id, i.department_id, d.name AS department_name,
        i.name, i.description, i.weight_pct, i.sort_order
    FROM public.department_kpi_indicators i
    JOIN public.departments d ON d.id = i.department_id
    WHERE i.active = true AND d.active = true
      AND (p_department_id IS NULL OR i.department_id = p_department_id)
      AND (
          public.is_admin(auth.uid())
          OR NOT public.is_manager_role()
          OR v_mgr_dept IS NULL
          OR i.department_id = v_mgr_dept
      )
    ORDER BY d.name, i.sort_order, i.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.save_department_kpi_indicators(
    p_department_id UUID,
    p_indicators JSONB
)
RETURNS VOID AS $$
DECLARE
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_id_text TEXT;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
    v_sort INTEGER;
    v_kept UUID[] := ARRAY[]::UUID[];
BEGIN
    IF NOT public.can_manage_department_kpis(p_department_id) THEN
        RAISE EXCEPTION 'Not authorized to manage KPIs for this department';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_total := v_total + COALESCE((v_item->>'weight_pct')::NUMERIC, 0);
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department KPI weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_id_text := NULLIF(trim(v_item->>'id'), '');
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');
        v_desc := NULLIF(trim(v_item->>'description'), '');
        v_sort := COALESCE((v_item->>'sort_order')::INTEGER, 0);
        v_id := NULL;

        IF v_name IS NULL OR v_name = '' THEN
            CONTINUE;
        END IF;

        IF v_id_text IS NOT NULL AND v_id_text !~ '^new-' THEN
            BEGIN
                v_id := v_id_text::UUID;
            EXCEPTION WHEN invalid_text_representation THEN
                v_id := NULL;
            END;
        END IF;

        IF v_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.department_kpi_indicators
            WHERE id = v_id AND department_id = p_department_id
        ) THEN
            UPDATE public.department_kpi_indicators SET
                weight_pct = v_pct,
                name = v_name,
                description = COALESCE(v_desc, description),
                sort_order = v_sort,
                active = true,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id AND department_id = p_department_id;
            v_kept := array_append(v_kept, v_id);
        ELSE
            INSERT INTO public.department_kpi_indicators (
                department_id, name, description, weight_pct, sort_order, active
            ) VALUES (
                p_department_id, v_name, v_desc, v_pct, v_sort, true
            )
            ON CONFLICT (department_id, name) DO UPDATE SET
                description = EXCLUDED.description,
                weight_pct = EXCLUDED.weight_pct,
                sort_order = EXCLUDED.sort_order,
                active = true,
                updated_at = timezone('utc'::text, now())
            RETURNING id INTO v_id;
            v_kept := array_append(v_kept, v_id);
        END IF;
    END LOOP;

    UPDATE public.department_kpi_indicators SET
        active = false,
        updated_at = timezone('utc'::text, now())
    WHERE department_id = p_department_id
      AND active = true
      AND NOT (id = ANY(v_kept));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.can_manage_department_kpis(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_department_kpi_indicators(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_department_kpi_indicators(UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
