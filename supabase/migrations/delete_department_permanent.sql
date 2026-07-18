-- Permanently remove departments from the database (hard DELETE, not soft-deactivate).

DROP FUNCTION IF EXISTS public.delete_department_admin(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.deactivate_department(UUID) CASCADE;

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

    -- Hard delete: cascades to department_kpi_indicators; nulls kpis/users/report FKs
    DELETE FROM public.departments d
    WHERE d.id = p_department_id
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

GRANT EXECUTE ON FUNCTION public.delete_department_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_department(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
