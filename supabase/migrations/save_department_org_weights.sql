-- Admin can set organization weight % per department (must total 100%).

CREATE OR REPLACE FUNCTION public.save_department_org_weights(p_items JSONB)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_total NUMERIC;
    rec JSONB;
    v_id UUID;
    v_pct NUMERIC;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can edit department weightages';
    END IF;

    v_company := public.current_company_id();

    SELECT COALESCE(SUM((item->>'org_weight_pct')::NUMERIC), 0) INTO v_total
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Organization weightages must total 100%% (currently %)', round(v_total, 1);
    END IF;

    FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
    LOOP
        v_id := NULLIF(rec->>'id', '')::UUID;
        v_pct := (rec->>'org_weight_pct')::NUMERIC;
        IF v_id IS NULL THEN CONTINUE; END IF;
        IF v_pct < 0 OR v_pct > 100 THEN
            RAISE EXCEPTION 'Weight must be between 0 and 100';
        END IF;

        UPDATE public.departments d
        SET org_weight_pct = round(v_pct, 2),
            updated_at = timezone('utc'::text, now())
        WHERE d.id = v_id
          AND d.active = true
          AND (
              (v_company IS NOT NULL AND d.company_id = v_company)
              OR public.is_demo_user(v_uid)
          );

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Department not found or not in your company';
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.save_department_org_weights(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
