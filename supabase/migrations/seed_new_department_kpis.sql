-- Auto-seed default KPI board for any new department (same structure: 4 metrics = 100%)

CREATE OR REPLACE FUNCTION public.seed_default_department_kpis(p_department_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
    v_dept_name TEXT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    IF v_count > 0 THEN
        RETURN v_count;
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = p_department_id;

    INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order, active)
    VALUES
        (
            p_department_id,
            'Performance Target / Volume',
            'Actual results versus monthly quota or target for ' || COALESCE(v_dept_name, 'the department') || '.',
            30.00, 1, true
        ),
        (
            p_department_id,
            'Quality & Accuracy',
            'Percentage of work, products, or services passing quality checks.',
            30.00, 2, true
        ),
        (
            p_department_id,
            'Timeliness / Delivery',
            'Tasks or deliverables completed within the promised time frame.',
            20.00, 3, true
        ),
        (
            p_department_id,
            'Efficiency & Productivity',
            'Average time to complete core department requests or processes.',
            20.00, 4, true
        )
    ON CONFLICT (department_id, name) DO NOTHING;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Seed KPIs for all active departments missing indicators
CREATE OR REPLACE FUNCTION public.seed_all_missing_department_kpis()
RETURNS TABLE(department_name TEXT, indicators_added INTEGER) AS $$
DECLARE
    rec RECORD;
    v_count INTEGER;
BEGIN
    FOR rec IN
        SELECT d.id, d.name
        FROM public.departments d
        WHERE d.active = true
          AND NOT EXISTS (
              SELECT 1 FROM public.department_kpi_indicators i
              WHERE i.department_id = d.id AND i.active = true
          )
    LOOP
        v_count := public.seed_default_department_kpis(rec.id);
        department_name := rec.name;
        indicators_added := v_count;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Hook into upsert_department: new departments always get default KPI board
CREATE OR REPLACE FUNCTION public.upsert_department(
    p_name TEXT,
    p_weight_pct NUMERIC,
    p_department_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_slug TEXT;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can manage departments';
    END IF;

    IF p_weight_pct < 0 OR p_weight_pct > 100 THEN
        RAISE EXCEPTION 'Weight must be between 0 and 100';
    END IF;

    v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);

    IF p_department_id IS NULL THEN
        INSERT INTO public.departments (name, slug, org_weight_pct, created_by, is_demo, active)
        VALUES (
            trim(p_name),
            v_slug,
            p_weight_pct,
            v_uid,
            public.is_demo_user(v_uid),
            true
        )
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            org_weight_pct = EXCLUDED.org_weight_pct,
            active = true,
            updated_at = timezone('utc'::text, now())
        RETURNING id INTO v_id;

        -- Seed default KPIs if this department has none
        PERFORM public.seed_default_department_kpis(v_id);
    ELSE
        UPDATE public.departments SET
            name = trim(p_name),
            org_weight_pct = p_weight_pct,
            active = true,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_department_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Department not found'; END IF;
        PERFORM public.seed_default_department_kpis(v_id);
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- After saving org weightages, ensure every department has KPI board
CREATE OR REPLACE FUNCTION public.save_department_weightages(
    p_weights JSONB
)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_pct NUMERIC;
    v_name TEXT;
    v_new_id UUID;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin and manager can set department weightages';
    END IF;

    IF p_weights IS NULL OR jsonb_array_length(p_weights) = 0 THEN
        RAISE EXCEPTION 'No department weights provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_weights)
    LOOP
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_total := v_total + v_pct;
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_weights)
    LOOP
        v_id := NULLIF(v_item->>'id', '')::UUID;
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');

        IF v_id IS NOT NULL THEN
            UPDATE public.departments SET
                org_weight_pct = v_pct,
                name = COALESCE(NULLIF(v_name, ''), name),
                active = true,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id;
            PERFORM public.seed_default_department_kpis(v_id);
        ELSIF v_name <> '' THEN
            v_new_id := public.upsert_department(v_name, v_pct, NULL);
            PERFORM public.seed_default_department_kpis(v_new_id);
        END IF;
    END LOOP;

    PERFORM public.rebalance_all_kpi_weights();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill any existing departments without KPIs
SELECT public.seed_all_missing_department_kpis();

GRANT EXECUTE ON FUNCTION public.seed_default_department_kpis(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_all_missing_department_kpis() TO authenticated;
