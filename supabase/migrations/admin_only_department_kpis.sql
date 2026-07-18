-- Only company admins may edit department KPI boards; managers use admin-assigned department.

CREATE OR REPLACE FUNCTION public.save_department_kpi_indicators(
    p_department_id UUID,
    p_indicators JSONB
)
RETURNS VOID AS $$
DECLARE
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only company admins can edit department KPI boards';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_total := v_total + (v_item->>'weight_pct')::NUMERIC;
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department KPI weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_id := (v_item->>'id')::UUID;
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');
        v_desc := NULLIF(trim(v_item->>'description'), '');

        IF v_id IS NOT NULL THEN
            UPDATE public.department_kpi_indicators SET
                weight_pct = v_pct,
                name = COALESCE(NULLIF(v_name, ''), name),
                description = COALESCE(v_desc, description),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id AND department_id = p_department_id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
