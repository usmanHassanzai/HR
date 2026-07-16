-- Live deploy fix: DROP + recreate functions that changed return types

DO $$ BEGIN
    CREATE TYPE public.subscription_plan AS ENUM ('starter', 'professional', 'enterprise', 'trial');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;

ALTER TABLE public.departments
    ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE;

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS contact_phone TEXT,
    ADD COLUMN IF NOT EXISTS job_title TEXT,
    ADD COLUMN IF NOT EXISTS industry TEXT,
    ADD COLUMN IF NOT EXISTS employee_count TEXT,
    ADD COLUMN IF NOT EXISTS website TEXT,
    ADD COLUMN IF NOT EXISTS address_line TEXT,
    ADD COLUMN IF NOT EXISTS city TEXT,
    ADD COLUMN IF NOT EXISTS country TEXT,
    ADD COLUMN IF NOT EXISTS subscription_plan public.subscription_plan DEFAULT 'trial',
    ADD COLUMN IF NOT EXISTS registration_notes TEXT,
    ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

DROP FUNCTION IF EXISTS public.get_departments();
DROP FUNCTION IF EXISTS public.get_direct_reports(UUID);
DROP FUNCTION IF EXISTS public.get_department_kpi_indicators(UUID);
DROP FUNCTION IF EXISTS public.platform_get_companies();
DROP FUNCTION IF EXISTS public.get_my_company();
DROP FUNCTION IF EXISTS public.platform_delete_company(UUID);

-- Include fixed get_departments (managers ONLY see assigned department)
CREATE OR REPLACE FUNCTION public.get_departments()
RETURNS TABLE(
    id UUID, name TEXT, slug TEXT, org_weight_pct NUMERIC, active BOOLEAN,
    kpi_count BIGINT, active_kpi_count BIGINT, indicator_count BIGINT
) AS $$
DECLARE
    v_company UUID;
    v_user_dept UUID;
    v_role public.user_role;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role, u.department_id INTO v_role, v_user_dept FROM public.users u WHERE u.id = auth.uid();

    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY
        SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
               COUNT(DISTINCT k.id), COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
               COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
        FROM public.departments d
        LEFT JOIN public.kpis k ON k.department_id = d.id
        LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
        WHERE d.active = true AND d.is_demo = true
          AND (public.is_admin(auth.uid()) OR (v_user_dept IS NOT NULL AND d.id = v_user_dept))
        GROUP BY d.id ORDER BY d.name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;

    RETURN QUERY
    SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
           COUNT(DISTINCT k.id), COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
           COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
    LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
    WHERE d.active = true AND d.company_id = v_company
      AND (public.is_admin(auth.uid()) OR (v_user_dept IS NOT NULL AND d.id = v_user_dept))
    GROUP BY d.id ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
DECLARE v_mgr_dept UUID;
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_manager_id);
    SELECT department_id INTO v_mgr_dept FROM public.users WHERE id = p_manager_id;
    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id AND u.role = 'employee'::public.user_role
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
          AND (public.is_demo_user(auth.uid()) OR u.company_id = public.current_company_id())
          AND (public.is_admin(auth.uid()) OR v_mgr_dept IS NULL OR u.department_id = v_mgr_dept)
        ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_delete_company(p_company_id UUID)
RETURNS VOID AS $$
DECLARE rec RECORD;
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN RAISE EXCEPTION 'Unauthorized'; END IF;
    FOR rec IN SELECT u.id FROM public.users u WHERE u.company_id = p_company_id AND NOT u.is_demo AND NOT u.is_platform_owner
    LOOP DELETE FROM auth.users WHERE id = rec.id; END LOOP;
    DELETE FROM public.users WHERE company_id = p_company_id AND NOT is_demo AND NOT is_platform_owner;
    DELETE FROM public.companies WHERE id = p_company_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

GRANT EXECUTE ON FUNCTION public.get_departments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_direct_reports(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_delete_company(UUID) TO authenticated;

-- Assign managers without a department to Finance (first functional dept) so they see one dept
UPDATE public.users u SET department_id = (
    SELECT d.id FROM public.departments d
    WHERE d.active = true AND d.name ILIKE '%finance%'
      AND (d.company_id = u.company_id OR (u.company_id IS NULL AND d.is_demo = u.is_demo))
    ORDER BY d.created_at LIMIT 1
)
WHERE u.role = 'manager'::public.user_role AND u.department_id IS NULL AND NOT u.is_demo;

UPDATE public.users u SET department_id = (
    SELECT d.id FROM public.departments d
    WHERE d.active = true AND d.company_id = u.company_id ORDER BY d.name LIMIT 1
)
WHERE u.role IN ('manager'::public.user_role, 'employee'::public.user_role)
  AND u.department_id IS NULL AND NOT u.is_demo AND u.company_id IS NOT NULL;
