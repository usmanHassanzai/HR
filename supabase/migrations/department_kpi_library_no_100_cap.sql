-- Department KPI library: any number of KPIs; total weight may exceed 100%.
-- Each indicator weight stays 0–100. The 100% cap applies only when assigning to one employee.

CREATE OR REPLACE FUNCTION public.save_department_kpi_indicators(
    p_department_id UUID,
    p_indicators JSONB
)
RETURNS VOID AS $$
DECLARE
    v_item JSONB;
    v_id UUID;
    v_id_text TEXT;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
    v_sort INTEGER;
    v_kept UUID[] := ARRAY[]::UUID[];
    v_named INTEGER := 0;
BEGIN
    IF NOT public.can_manage_department_kpis(p_department_id) THEN
        RAISE EXCEPTION 'Not authorized to manage KPIs for this department';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_name := trim(COALESCE(v_item->>'name', ''));
        IF v_name IS NULL OR v_name = '' THEN
            CONTINUE;
        END IF;
        v_named := v_named + 1;
        v_pct := COALESCE((v_item->>'weight_pct')::NUMERIC, 0);
        IF v_pct < 1 OR v_pct > 100 THEN
            RAISE EXCEPTION 'KPI "%" weight must be between 1%% and 100%% (currently %).', v_name, round(v_pct, 2);
        END IF;
    END LOOP;

    IF v_named = 0 THEN
        RAISE EXCEPTION 'Each KPI needs a name';
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

GRANT EXECUTE ON FUNCTION public.save_department_kpi_indicators(UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
