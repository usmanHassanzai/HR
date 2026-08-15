-- Each department defaults to 100% org weight (independent).
-- Manual per-department edits (0–100) remain allowed.
-- No longer require company-wide weights to sum to 100%.

CREATE OR REPLACE FUNCTION public.save_department_org_weights(p_items JSONB)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    rec JSONB;
    v_id UUID;
    v_pct NUMERIC;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can edit department weightages';
    END IF;

    v_company := public.current_company_id();

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

-- Set every active department in a company to 100%
CREATE OR REPLACE FUNCTION public.rebalance_company_department_weights(p_company_id UUID)
RETURNS VOID AS $$
BEGIN
    IF p_company_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.departments d
    SET org_weight_pct = 100,
        updated_at = timezone('utc'::text, now())
    WHERE d.active = true AND d.company_id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.rebalance_demo_department_weights()
RETURNS VOID AS $$
BEGIN
    UPDATE public.departments d
    SET org_weight_pct = 100,
        updated_at = timezone('utc'::text, now())
    WHERE d.active = true AND d.is_demo = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.create_department_admin(p_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_id UUID;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only company admin can add departments';
    END IF;

    IF trim(p_name) = '' THEN
        RAISE EXCEPTION 'Department name is required';
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL AND NOT public.is_demo_user(v_uid) THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.departments d
        WHERE d.active = true
          AND lower(d.name) = lower(trim(p_name))
          AND (
              (v_company IS NOT NULL AND d.company_id = v_company)
              OR (public.is_demo_user(v_uid) AND d.is_demo = true)
          )
    ) THEN
        RAISE EXCEPTION 'A department with this name already exists';
    END IF;

    -- New department always starts at 100% (other departments stay unchanged)
    v_id := public.upsert_department(trim(p_name), 100, NULL);

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_department_admin(p_department_id UUID)
RETURNS VOID AS $$
DECLARE
    v_company UUID;
    v_user_count INTEGER;
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Only company admin can delete departments';
    END IF;

    v_company := public.current_company_id();

    SELECT COUNT(*)::INTEGER INTO v_user_count
    FROM public.users u
    WHERE u.department_id = p_department_id
      AND (v_company IS NULL OR u.company_id = v_company);

    IF v_user_count > 0 THEN
        RAISE EXCEPTION 'Cannot delete: % user(s) still assigned to this department. Reassign them under Users first.', v_user_count;
    END IF;

    DELETE FROM public.departments d
    WHERE d.id = p_department_id
      AND (
          (v_company IS NOT NULL AND d.company_id = v_company)
          OR public.is_demo_user(auth.uid())
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department not found';
    END IF;
    -- Do not rebalance remaining departments — each keeps its own weight
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.save_department_org_weights(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_department_admin(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department_admin(UUID) TO authenticated;

-- One-time: set all existing active departments to 100%
UPDATE public.departments
SET org_weight_pct = 100,
    updated_at = timezone('utc'::text, now())
WHERE active = true
  AND coalesce(org_weight_pct, 0) <> 100;

NOTIFY pgrst, 'reload schema';
