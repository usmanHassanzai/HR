-- Auto equal org weight (100% split) on add/delete — no manual assignment needed.

CREATE OR REPLACE FUNCTION public.rebalance_company_department_weights(p_company_id UUID)
RETURNS VOID AS $$
DECLARE
    v_ids UUID[];
    v_count INTEGER;
    v_each NUMERIC;
    v_remainder NUMERIC := 100;
    v_i INTEGER;
BEGIN
    IF p_company_id IS NULL THEN
        RETURN;
    END IF;

    SELECT array_agg(d.id ORDER BY d.name, d.created_at)
    INTO v_ids
    FROM public.departments d
    WHERE d.active = true AND d.company_id = p_company_id;

    v_count := coalesce(array_length(v_ids, 1), 0);
    IF v_count = 0 THEN
        RETURN;
    END IF;

    v_each := trunc(10000.0 / v_count) / 100.0;

    FOR v_i IN 1..v_count LOOP
        IF v_i = v_count THEN
            UPDATE public.departments
            SET org_weight_pct = round(v_remainder, 2),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_ids[v_i];
        ELSE
            UPDATE public.departments
            SET org_weight_pct = v_each,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_ids[v_i];
            v_remainder := v_remainder - v_each;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.rebalance_demo_department_weights()
RETURNS VOID AS $$
DECLARE
    v_ids UUID[];
    v_count INTEGER;
    v_each NUMERIC;
    v_remainder NUMERIC := 100;
    v_i INTEGER;
BEGIN
    SELECT array_agg(d.id ORDER BY d.name, d.created_at)
    INTO v_ids
    FROM public.departments d
    WHERE d.active = true AND d.is_demo = true;

    v_count := coalesce(array_length(v_ids, 1), 0);
    IF v_count = 0 THEN
        RETURN;
    END IF;

    v_each := trunc(10000.0 / v_count) / 100.0;

    FOR v_i IN 1..v_count LOOP
        IF v_i = v_count THEN
            UPDATE public.departments
            SET org_weight_pct = round(v_remainder, 2),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_ids[v_i];
        ELSE
            UPDATE public.departments
            SET org_weight_pct = v_each,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_ids[v_i];
            v_remainder := v_remainder - v_each;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.rebalance_department_org_weights()
RETURNS VOID AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NOT NULL THEN
        PERFORM public.rebalance_company_department_weights(v_company);
    ELSIF public.is_demo_user(auth.uid()) THEN
        PERFORM public.rebalance_demo_department_weights();
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.rebalance_department_org_weights() TO authenticated;

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

    v_id := public.upsert_department(trim(p_name), 0, NULL);

    IF v_company IS NOT NULL THEN
        PERFORM public.rebalance_company_department_weights(v_company);
    ELSE
        PERFORM public.rebalance_demo_department_weights();
    END IF;

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

    IF v_company IS NOT NULL THEN
        PERFORM public.rebalance_company_department_weights(v_company);
    ELSE
        PERFORM public.rebalance_demo_department_weights();
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.deactivate_department(p_department_id UUID)
RETURNS VOID AS $$
BEGIN
    PERFORM public.delete_department_admin(p_department_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_department_admin(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_department(UUID) TO authenticated;

-- Rebalance every company once (fixes existing rows).
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT DISTINCT d.company_id AS id
        FROM public.departments d
        WHERE d.active = true AND d.company_id IS NOT NULL
    LOOP
        PERFORM public.rebalance_company_department_weights(c.id);
    END LOOP;
    PERFORM public.rebalance_demo_department_weights();
END $$;

NOTIFY pgrst, 'reload schema';
