-- Each company's data is isolated in Supabase (like a private database per company).
-- Departments + department KPI indicators are dedicated tables with company-scoped RLS.
-- Enable Realtime so KPI/department/user changes sync instantly on every device.

CREATE OR REPLACE FUNCTION public.can_access_user_data(p_target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_target_user_id IS NULL THEN RETURN false; END IF;
    IF public.is_platform_owner(auth.uid()) THEN RETURN false; END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN public.is_demo_user(p_target_user_id);
    END IF;

    IF auth.uid() = p_target_user_id THEN RETURN true; END IF;

    IF NOT public.same_company(p_target_user_id) THEN RETURN false; END IF;

    IF public.is_admin(auth.uid()) THEN RETURN true; END IF;

    RETURN public.is_manager_of(auth.uid(), p_target_user_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_access_department(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_department_id IS NULL THEN RETURN false; END IF;
    IF public.is_platform_owner(auth.uid()) THEN RETURN false; END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id AND d.is_demo = true
        );
    END IF;

    IF public.is_admin(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id AND d.company_id = public.current_company_id()
        );
    END IF;

    RETURN public.manager_can_access_department(p_department_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Company-scoped RLS on users (tenant isolation)
DROP POLICY IF EXISTS "Users view own profile, managers view team, admins view all" ON public.users;
CREATE POLICY "Users view own profile, managers view team, admins view all"
    ON public.users FOR SELECT
    USING (public.can_access_user_data(id));

-- Company-scoped KPI access
DROP POLICY IF EXISTS "Users view own KPIs, managers view team KPIs, admins view all" ON public.kpis;
CREATE POLICY "Users view own KPIs, managers view team KPIs, admins view all"
    ON public.kpis FOR SELECT
    USING (public.can_access_user_data(user_id));

DROP POLICY IF EXISTS "Managers can manage team KPIs" ON public.kpis;
CREATE POLICY "Managers can manage team KPIs"
    ON public.kpis FOR ALL
    USING (public.is_manager_of(auth.uid(), user_id) AND public.can_access_user_data(user_id))
    WITH CHECK (public.is_manager_of(auth.uid(), user_id) AND public.can_access_user_data(user_id));

DROP POLICY IF EXISTS "Admins can manage all KPIs" ON public.kpis;
CREATE POLICY "Admins can manage all KPIs"
    ON public.kpis FOR ALL
    USING (public.is_admin(auth.uid()) AND public.can_access_user_data(user_id))
    WITH CHECK (public.is_admin(auth.uid()) AND public.can_access_user_data(user_id));

-- Departments: each company only sees its own department rows
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS departments_company_read ON public.departments;
CREATE POLICY departments_company_read ON public.departments
    FOR SELECT USING (public.can_access_department(id));

DROP POLICY IF EXISTS departments_admin_write ON public.departments;
CREATE POLICY departments_admin_write ON public.departments
    FOR ALL USING (
        public.is_admin(auth.uid())
        AND (
            public.is_demo_user(auth.uid())
            OR company_id = public.current_company_id()
        )
    )
    WITH CHECK (
        public.is_admin(auth.uid())
        AND (
            public.is_demo_user(auth.uid())
            OR company_id = public.current_company_id()
        )
    );

-- Department KPI indicators: linked to department table (one board per department)
ALTER TABLE public.department_kpi_indicators ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dept_kpi_indicators_read ON public.department_kpi_indicators;
CREATE POLICY dept_kpi_indicators_read ON public.department_kpi_indicators
    FOR SELECT USING (public.can_access_department(department_id));

DROP POLICY IF EXISTS dept_kpi_indicators_write ON public.department_kpi_indicators;
CREATE POLICY dept_kpi_indicators_write ON public.department_kpi_indicators
    FOR ALL USING (public.can_access_department(department_id))
    WITH CHECK (public.can_access_department(department_id));

-- Per-company settings stored in Supabase (accessible on any device)
ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Realtime: instant sync when KPIs, departments, users, or companies change
ALTER TABLE public.kpis REPLICA IDENTITY FULL;
ALTER TABLE public.departments REPLICA IDENTITY FULL;
ALTER TABLE public.department_kpi_indicators REPLICA IDENTITY FULL;
ALTER TABLE public.users REPLICA IDENTITY FULL;
ALTER TABLE public.companies REPLICA IDENTITY FULL;
ALTER TABLE public.notifications REPLICA IDENTITY FULL;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'kpis',
        'departments',
        'department_kpi_indicators',
        'users',
        'companies',
        'notifications',
        'kpi_submissions',
        'tasks',
        'points_ledger'
    ]
    LOOP
        BEGIN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        EXCEPTION WHEN duplicate_object THEN
            NULL;
        END;
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.can_access_user_data(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_department(UUID) TO authenticated;
