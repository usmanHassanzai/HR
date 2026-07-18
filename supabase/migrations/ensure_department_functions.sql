-- Must run LAST: drop_stale_functions_mid removes get_departments without recreating it.

DROP FUNCTION IF EXISTS public.get_departments() CASCADE;

CREATE OR REPLACE FUNCTION public.get_departments()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    org_weight_pct NUMERIC,
    active BOOLEAN,
    kpi_count BIGINT,
    active_kpi_count BIGINT,
    indicator_count BIGINT
) AS $$
DECLARE
    v_company UUID;
    v_user_dept UUID;
    v_role public.user_role;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT u.role, u.department_id INTO v_role, v_user_dept
    FROM public.users u WHERE u.id = auth.uid();

    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY
        SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
               COUNT(DISTINCT k.id),
               COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
               COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
        FROM public.departments d
        LEFT JOIN public.kpis k ON k.department_id = d.id
        LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
        WHERE d.active = true AND d.is_demo = true
          AND (
              public.is_admin(auth.uid())
              OR (v_user_dept IS NOT NULL AND d.id = v_user_dept)
          )
        GROUP BY d.id
        ORDER BY d.name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

    RETURN QUERY
    SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
           COUNT(DISTINCT k.id),
           COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
           COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
    LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
    WHERE d.active = true
      AND d.company_id = v_company
      AND (
          public.is_admin(auth.uid())
          OR (v_user_dept IS NOT NULL AND d.id = v_user_dept)
      )
    GROUP BY d.id
    ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_departments() TO authenticated;

NOTIFY pgrst, 'reload schema';
