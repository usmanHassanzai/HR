-- Strict per-organization isolation for users and related HR data.
-- Root leak: demo-era admin FOR ALL policies used same_demo_scope(), which
-- returns TRUE for every non-demo user — so Org A admins could SELECT/UPDATE Org B.

-- ─── Access helpers ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.can_access_user_data(p_target_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_target_user_id IS NULL THEN RETURN false; END IF;

    IF public.is_platform_owner(auth.uid()) THEN
        IF auth.uid() = p_target_user_id THEN RETURN true; END IF;
        IF public.current_company_id() IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = p_target_user_id
              AND u.company_id = public.current_company_id()
              AND u.is_demo = false
        );
    END IF;

    IF public.is_demo_user(auth.uid()) THEN
        RETURN public.is_demo_user(p_target_user_id);
    END IF;

    IF auth.uid() = p_target_user_id THEN RETURN true; END IF;
    IF NOT public.same_company(p_target_user_id) THEN RETURN false; END IF;
    IF public.is_admin(auth.uid()) THEN RETURN true; END IF;
    RETURN public.is_manager_of(auth.uid(), p_target_user_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_manager_of(p_manager_id UUID, p_employee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.users emp
        JOIN public.users mgr ON mgr.id = p_manager_id
        WHERE emp.id = p_employee_id
          AND emp.manager_id = p_manager_id
          AND (
              (mgr.is_demo = true AND emp.is_demo = true)
              OR (
                  mgr.company_id IS NOT NULL
                  AND emp.company_id IS NOT DISTINCT FROM mgr.company_id
              )
          )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.manager_can_access_department(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_department_id IS NULL THEN RETURN false; END IF;

    IF public.is_admin(auth.uid()) THEN
        IF public.is_demo_user(auth.uid()) THEN
            RETURN EXISTS (
                SELECT 1 FROM public.departments d
                WHERE d.id = p_department_id AND d.is_demo = true
            );
        END IF;
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id
              AND d.company_id = public.current_company_id()
        );
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid()
          AND u.role = 'manager'::public.user_role
          AND u.department_id = p_department_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ─── Users RLS (replace demo-era admin FOR ALL) ─────────────────────────────

DROP POLICY IF EXISTS "Admins have full write access on users" ON public.users;
DROP POLICY IF EXISTS "Admins manage users in own company" ON public.users;
DROP POLICY IF EXISTS users_select ON public.users;
DROP POLICY IF EXISTS "Users can view accessible profiles" ON public.users;
DROP POLICY IF EXISTS users_company_read ON public.users;

CREATE POLICY users_company_select ON public.users
FOR SELECT USING (public.can_access_user_data(id));

CREATE POLICY users_company_admin_write ON public.users
FOR ALL
USING (
    public.is_admin(auth.uid())
    AND public.can_access_user_data(id)
)
WITH CHECK (
    public.is_admin(auth.uid())
    AND (
        public.is_demo_user(auth.uid())
        OR (
            company_id IS NOT NULL
            AND company_id = public.current_company_id()
        )
    )
);

-- ─── KPIs / points / attendance / leave / daily reports ─────────────────────

DROP POLICY IF EXISTS "Admins can manage all KPIs" ON public.kpis;
CREATE POLICY "Admins can manage all KPIs" ON public.kpis
FOR ALL
USING (public.is_admin(auth.uid()) AND public.can_access_user_data(user_id))
WITH CHECK (public.is_admin(auth.uid()) AND public.can_access_user_data(user_id));

DROP POLICY IF EXISTS points_ledger_admin_all ON public.points_ledger;
CREATE POLICY points_ledger_admin_all ON public.points_ledger
FOR ALL
USING (public.is_admin(auth.uid()) AND public.can_access_user_data(employee_id))
WITH CHECK (public.is_admin(auth.uid()) AND public.can_access_user_data(employee_id));

DROP POLICY IF EXISTS attendance_select ON public.attendance_records;
CREATE POLICY attendance_select ON public.attendance_records
FOR SELECT USING (
    user_id = auth.uid()
    OR public.can_access_user_data(user_id)
);

DROP POLICY IF EXISTS leave_requests_select ON public.leave_requests;
CREATE POLICY leave_requests_select ON public.leave_requests
FOR SELECT USING (
    user_id = auth.uid()
    OR public.can_access_user_data(user_id)
);

DROP POLICY IF EXISTS leave_balances_select ON public.leave_balances;
CREATE POLICY leave_balances_select ON public.leave_balances
FOR SELECT USING (
    user_id = auth.uid()
    OR public.can_access_user_data(user_id)
);

DROP POLICY IF EXISTS "daily_work_reports_select" ON public.daily_work_reports;
CREATE POLICY "daily_work_reports_select" ON public.daily_work_reports
FOR SELECT TO authenticated
USING (
    user_id = auth.uid()
    OR (public.is_admin(auth.uid()) AND public.can_access_user_data(user_id))
);

-- ─── Admin user RPCs ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can list all users';
    END IF;

    IF public.is_demo_user(v_uid) THEN
        RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.is_demo = true
        ORDER BY u.full_name;
        RETURN;
    END IF;

    v_company := public.current_company_id();
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'Your account is not linked to a company';
    END IF;

    RETURN QUERY
    SELECT u.* FROM public.users u
    WHERE u.company_id = v_company
      AND u.is_demo = false
      AND u.is_platform_owner = false
    ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_user_admin(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can delete users';
    END IF;
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'You cannot delete your own account';
    END IF;
    IF NOT public.can_access_user_data(p_user_id) THEN
        RAISE EXCEPTION 'User is not in your organization';
    END IF;
    IF public.is_demo_user(p_user_id) AND NOT public.is_demo_user(auth.uid()) THEN
        RAISE EXCEPTION 'Production admins cannot delete demo sandbox accounts';
    END IF;
    DELETE FROM auth.users WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.reset_user_password_admin(p_user_id UUID, p_new_password TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can reset passwords';
    END IF;
    IF NOT public.can_access_user_data(p_user_id) THEN
        RAISE EXCEPTION 'User is not in your organization';
    END IF;
    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters';
    END IF;
    UPDATE auth.users
    SET encrypted_password = crypt(p_new_password, gen_salt('bf'))
    WHERE id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

-- ─── Leave / KPI indicator RPCs ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_pending_leave_requests()
RETURNS TABLE(
    id UUID,
    user_id UUID,
    leave_type public.leave_type,
    start_date DATE,
    end_date DATE,
    days_count NUMERIC,
    reason TEXT,
    status public.approval_status,
    created_at TIMESTAMPTZ,
    employee_name TEXT,
    employee_email TEXT,
    employee_role TEXT
) AS $$
DECLARE
    v_company UUID := public.current_company_id();
BEGIN
    IF public.is_admin(auth.uid()) THEN
        IF v_company IS NULL AND NOT public.is_demo_user(auth.uid()) THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role <> 'admin'::public.user_role
          AND (
              (public.is_demo_user(auth.uid()) AND u.is_demo = true)
              OR (
                  NOT public.is_demo_user(auth.uid())
                  AND u.company_id = v_company
                  AND u.is_demo = false
              )
          )
        ORDER BY lr.created_at DESC;

    ELSIF EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND role = 'manager'::public.user_role
    ) THEN
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role = 'employee'::public.user_role
          AND public.is_manager_of(auth.uid(), lr.user_id)
        ORDER BY lr.created_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_department_kpi_indicators(p_department_id UUID DEFAULT NULL)
RETURNS TABLE(
    id UUID,
    department_id UUID,
    department_name TEXT,
    name TEXT,
    description TEXT,
    weight_pct NUMERIC,
    sort_order INTEGER
) AS $$
DECLARE
    v_mgr_dept UUID;
    v_company UUID := public.current_company_id();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF p_department_id IS NOT NULL
       AND NOT public.is_admin(auth.uid())
       AND NOT public.manager_can_access_department(p_department_id) THEN
        RAISE EXCEPTION 'You do not have access to this department';
    END IF;

    IF public.is_admin(auth.uid())
       AND NOT public.is_demo_user(auth.uid())
       AND v_company IS NULL THEN
        RAISE EXCEPTION 'Account not linked to a company';
    END IF;

    v_mgr_dept := public.user_department_id();

    RETURN QUERY
    SELECT
        i.id, i.department_id, d.name AS department_name,
        i.name, i.description, i.weight_pct, i.sort_order
    FROM public.department_kpi_indicators i
    JOIN public.departments d ON d.id = i.department_id
    WHERE i.active = true AND d.active = true
      AND (p_department_id IS NULL OR i.department_id = p_department_id)
      AND (
          (public.is_demo_user(auth.uid()) AND d.is_demo = true)
          OR (NOT public.is_demo_user(auth.uid()) AND d.company_id = v_company)
      )
      AND (
          public.is_admin(auth.uid())
          OR NOT public.is_manager_role()
          OR v_mgr_dept IS NULL
          OR i.department_id = v_mgr_dept
      )
    ORDER BY d.name, i.sort_order, i.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ─── Signup: require valid company for employee/manager invites ─────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_company_name TEXT;
    v_company_id UUID;
    v_dept_id UUID;
    v_slug TEXT;
    v_role public.user_role;
    v_company_id_meta UUID;
    v_manager_id UUID;
    v_dept_id_meta UUID;
    v_sub public.subscription_plan;
    v_notify_msg TEXT;
BEGIN
    v_role := coalesce((NEW.raw_user_meta_data->>'role')::public.user_role, 'employee'::public.user_role);
    v_company_id_meta := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::UUID;
    v_manager_id := NULLIF(NEW.raw_user_meta_data->>'manager_id', '')::UUID;
    v_dept_id_meta := NULLIF(NEW.raw_user_meta_data->>'department_id', '')::UUID;

    IF NEW.raw_user_meta_data->>'registration_type' = 'company' THEN
        v_company_name := trim(coalesce(NEW.raw_user_meta_data->>'company_name', 'New Company'));
        v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'));
        v_slug := trim(both '-' from v_slug) || '-' || substr(replace(NEW.id::text, '-', ''), 1, 8);

        BEGIN
            v_sub := coalesce(
                NULLIF(trim(NEW.raw_user_meta_data->>'subscription_plan'), '')::public.subscription_plan,
                'trial'::public.subscription_plan
            );
        EXCEPTION WHEN OTHERS THEN
            v_sub := 'trial'::public.subscription_plan;
        END;

        INSERT INTO public.companies (
            name, slug, status, contact_email, contact_name, contact_phone,
            job_title, industry, employee_count, website,
            address_line, city, country, subscription_plan, registration_notes,
            owner_user_id
        )
        VALUES (
            v_company_name, v_slug, 'pending', NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'job_title'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'industry'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'employee_count'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'website'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'address_line'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'city'), ''),
            NULLIF(trim(NEW.raw_user_meta_data->>'country'), ''),
            v_sub,
            NULLIF(trim(NEW.raw_user_meta_data->>'notes'), ''),
            NULL
        )
        RETURNING id INTO v_company_id;

        INSERT INTO public.users (id, email, full_name, role, company_id, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email), 'admin', v_company_id, false);

        UPDATE public.companies SET owner_user_id = NEW.id WHERE id = v_company_id;

        v_notify_msg :=
            v_company_name || ' registered by ' || coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email)
            || E'\nEmail: ' || NEW.email
            || coalesce(E'\nPhone: ' || NULLIF(trim(NEW.raw_user_meta_data->>'phone'), ''), '')
            || E'\nPlan: ' || v_sub::text;

        INSERT INTO public.platform_owner_notifications (company_id, title, message)
        VALUES (v_company_id, 'New company registration — ' || v_company_name, v_notify_msg);

        INSERT INTO public.notifications (user_id, title, message, type)
        VALUES (
            NEW.id,
            'Registration submitted — awaiting approval',
            'Thank you for registering ' || v_company_name || '. Our admin will review your application shortly.',
            'info'
        );

        INSERT INTO public.departments (name, slug, org_weight_pct, company_id, active, is_demo)
        VALUES ('General', 'general-' || substr(replace(v_company_id::text, '-', ''), 1, 8), 100.00, v_company_id, true, false)
        RETURNING id INTO v_dept_id;

        IF EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'seed_default_department_kpis'
        ) THEN
            PERFORM public.seed_default_department_kpis(v_dept_id);
        END IF;

        RETURN NEW;
    END IF;

    IF lower(NEW.email) = lower(public.platform_owner_email()) THEN
        INSERT INTO public.users (id, email, full_name, role, is_platform_owner, is_demo)
        VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', 'Samiya Kayani'), 'admin', true, false);
        RETURN NEW;
    END IF;

    IF NEW.email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai')
       OR (NEW.raw_user_meta_data->>'is_demo')::boolean IS true THEN
        INSERT INTO public.users (id, email, full_name, role, is_demo, demo_expires_at)
        VALUES (
            NEW.id, NEW.email,
            coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
            v_role, true,
            timezone('utc'::text, now()) + interval '3 days'
        );
        RETURN NEW;
    END IF;

    IF v_company_id_meta IS NULL THEN
        RAISE EXCEPTION 'company_id is required for user signup';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.companies c
        WHERE c.id = v_company_id_meta
          AND c.status IN ('active', 'pending')
    ) THEN
        RAISE EXCEPTION 'Invalid or inactive company';
    END IF;

    IF v_dept_id_meta IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.departments d
        WHERE d.id = v_dept_id_meta AND d.company_id = v_company_id_meta
    ) THEN
        RAISE EXCEPTION 'Department does not belong to this organization';
    END IF;

    IF v_manager_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.users m
        WHERE m.id = v_manager_id AND m.company_id = v_company_id_meta
    ) THEN
        RAISE EXCEPTION 'Manager does not belong to this organization';
    END IF;

    INSERT INTO public.users (id, email, full_name, role, company_id, department_id, manager_id, is_demo)
    VALUES (
        NEW.id, NEW.email,
        coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email),
        v_role, v_company_id_meta,
        v_dept_id_meta,
        v_manager_id,
        false
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

GRANT EXECUTE ON FUNCTION public.can_access_user_data(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_manager_of(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manager_can_access_department(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_users_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_user_password_admin(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_leave_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_department_kpi_indicators(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
