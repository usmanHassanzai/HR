-- Admin department add/delete with company_id scoping (syncs on all devices).

DROP FUNCTION IF EXISTS public.create_department_admin(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.delete_department_admin(UUID) CASCADE;

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
    v_company UUID;
    v_suffix TEXT;
BEGIN
    IF NOT public.can_manage_departments() THEN
        RAISE EXCEPTION 'Only admin can manage departments';
    END IF;

    IF p_weight_pct < 0 OR p_weight_pct > 100 THEN
        RAISE EXCEPTION 'Weight must be between 0 and 100';
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL AND NOT public.is_demo_user(v_uid) THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;

    v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);
    v_suffix := substr(replace(coalesce(v_company, v_uid)::text, '-', ''), 1, 8);
    v_slug := v_slug || '-' || v_suffix;

    IF p_department_id IS NULL THEN
        INSERT INTO public.departments (name, slug, org_weight_pct, company_id, created_by, is_demo, active)
        VALUES (
            trim(p_name),
            v_slug,
            p_weight_pct,
            v_company,
            v_uid,
            public.is_demo_user(v_uid),
            true
        )
        RETURNING id INTO v_id;

        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'seed_default_department_kpis'
        ) THEN
            PERFORM public.seed_default_department_kpis(v_id);
        END IF;
    ELSE
        UPDATE public.departments SET
            name = trim(p_name),
            org_weight_pct = p_weight_pct,
            active = true,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_department_id
          AND (company_id = v_company OR public.is_demo_user(v_uid))
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Department not found'; END IF;

        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'seed_default_department_kpis'
        ) THEN
            PERFORM public.seed_default_department_kpis(v_id);
        END IF;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create department immediately and rebalance org weights evenly
CREATE OR REPLACE FUNCTION public.create_department_admin(p_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_id UUID;
    v_count INTEGER;
    v_each NUMERIC;
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

    SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.departments d
    WHERE d.active = true
      AND (
          (v_company IS NOT NULL AND d.company_id = v_company)
          OR (public.is_demo_user(v_uid) AND d.is_demo = true)
      );

    IF v_count > 0 THEN
        v_each := round(100.0 / v_count, 2);
        UPDATE public.departments d
        SET org_weight_pct = v_each,
            updated_at = timezone('utc'::text, now())
        WHERE d.active = true
          AND (
              (v_company IS NOT NULL AND d.company_id = v_company)
              OR (public.is_demo_user(v_uid) AND d.is_demo = true)
          );
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Delete (deactivate) department — admin only
CREATE OR REPLACE FUNCTION public.delete_department_admin(p_department_id UUID)
RETURNS VOID AS $$
DECLARE
    v_company UUID;
    v_count INTEGER;
    v_each NUMERIC;
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

    UPDATE public.departments d
    SET active = false,
        updated_at = timezone('utc'::text, now())
    WHERE d.id = p_department_id
      AND d.active = true
      AND (
          (v_company IS NOT NULL AND d.company_id = v_company)
          OR public.is_demo_user(auth.uid())
      );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.departments d
    WHERE d.active = true
      AND (
          (v_company IS NOT NULL AND d.company_id = v_company)
          OR (public.is_demo_user(auth.uid()) AND d.is_demo = true)
      );

    IF v_count > 0 THEN
        v_each := round(100.0 / v_count, 2);
        UPDATE public.departments d
        SET org_weight_pct = v_each,
            updated_at = timezone('utc'::text, now())
        WHERE d.active = true
          AND (
              (v_company IS NOT NULL AND d.company_id = v_company)
              OR (public.is_demo_user(auth.uid()) AND d.is_demo = true)
          );
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

NOTIFY pgrst, 'reload schema';
