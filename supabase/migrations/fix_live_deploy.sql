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
          AND (public.is_admin(auth.uid()) OR v_mgr_dept IS NULL OR u.department_id IS NULL OR u.department_id = v_mgr_dept)
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

CREATE OR REPLACE FUNCTION public.get_department_kpi_indicators(p_department_id UUID DEFAULT NULL)
RETURNS TABLE(
    id UUID, department_id UUID, department_name TEXT,
    name TEXT, description TEXT, weight_pct NUMERIC, sort_order INTEGER
) AS $$
DECLARE v_mgr_dept UUID;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_department_id IS NOT NULL AND NOT public.manager_can_access_department(p_department_id)
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You do not have access to this department';
    END IF;
    v_mgr_dept := public.user_department_id();
    RETURN QUERY
    SELECT i.id, i.department_id, d.name, i.name, i.description, i.weight_pct, i.sort_order
    FROM public.department_kpi_indicators i
    JOIN public.departments d ON d.id = i.department_id
    WHERE i.active = true AND d.active = true
      AND (p_department_id IS NULL OR i.department_id = p_department_id)
      AND (public.is_admin(auth.uid()) OR NOT public.is_manager_role() OR v_mgr_dept IS NULL OR i.department_id = v_mgr_dept)
    ORDER BY d.name, i.sort_order, i.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_departments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_direct_reports(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_department_kpi_indicators(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_delete_company(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS TABLE(
    id UUID,
    name TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_phone TEXT,
    subscription_plan public.subscription_plan,
    trial_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RETURN; END IF;
    RETURN QUERY
        SELECT c.id, c.name, c.status, c.contact_email, c.contact_phone,
               c.subscription_plan, c.trial_ends_at, c.created_at
        FROM public.companies c WHERE c.id = v_company;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_get_companies()
RETURNS TABLE(
    id UUID,
    name TEXT,
    slug TEXT,
    status public.company_status,
    contact_email TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    job_title TEXT,
    industry TEXT,
    employee_count TEXT,
    website TEXT,
    address_line TEXT,
    city TEXT,
    country TEXT,
    subscription_plan public.subscription_plan,
    registration_notes TEXT,
    owner_email TEXT,
    owner_name TEXT,
    created_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    user_count BIGINT
) AS $$
BEGIN
    IF NOT public.is_platform_owner(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: platform owner only';
    END IF;
    RETURN QUERY
        SELECT
            c.id, c.name, c.slug, c.status, c.contact_email, c.contact_name,
            c.contact_phone, c.job_title, c.industry, c.employee_count, c.website,
            c.address_line, c.city, c.country, c.subscription_plan, c.registration_notes,
            u.email, u.full_name, c.created_at, c.approved_at,
            (SELECT COUNT(*) FROM public.users u2 WHERE u2.company_id = c.id AND u2.is_demo = false)
        FROM public.companies c
        LEFT JOIN public.users u ON u.id = c.owner_user_id
        ORDER BY
            CASE c.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
            c.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_company() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_companies() TO authenticated;

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
