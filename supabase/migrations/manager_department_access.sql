-- Managers see/handle only their own department; admins see all departments in the company

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_department_id ON public.users(department_id);

CREATE OR REPLACE FUNCTION public.user_department_id(p_user_id UUID DEFAULT auth.uid())
RETURNS UUID AS $$
    SELECT u.department_id FROM public.users u WHERE u.id = p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_manager_role(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_user_id AND u.role = 'manager'::public.user_role
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Admin: all departments. Manager: own department only.
CREATE OR REPLACE FUNCTION public.manager_can_access_department(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN RETURN true; END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid()
          AND u.role = 'manager'::public.user_role
          AND u.department_id = p_department_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_manage_org_departments()
RETURNS BOOLEAN AS $$
    SELECT public.is_admin(auth.uid());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Org-level department CRUD: admin only (replaces open manager access)
CREATE OR REPLACE FUNCTION public.can_manage_departments()
RETURNS BOOLEAN AS $$
    SELECT public.can_manage_org_departments();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Manager must share department with employee (direct report)
CREATE OR REPLACE FUNCTION public.is_manager_of(p_manager_id UUID, p_employee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users mgr
        JOIN public.users emp ON emp.id = p_employee_id
        WHERE mgr.id = p_manager_id
          AND emp.manager_id = p_manager_id
          AND (
              mgr.role = 'admin'::public.user_role
              OR mgr.department_id IS NULL
              OR emp.department_id IS NULL
              OR mgr.department_id = emp.department_id
          )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
DECLARE
    v_mgr_dept UUID;
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_manager_id);
    IF NOT public.is_demo_user(auth.uid()) AND NOT public.same_company(p_manager_id) THEN
        RAISE EXCEPTION 'Cannot view users from another company';
    END IF;

    SELECT department_id INTO v_mgr_dept FROM public.users WHERE id = p_manager_id;

    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id
          AND u.role = 'employee'::public.user_role
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
          AND (public.is_demo_user(auth.uid()) OR u.company_id = public.current_company_id())
          AND (
              public.is_admin(auth.uid())
              OR v_mgr_dept IS NULL
              OR u.department_id = v_mgr_dept
          )
        ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
    v_mgr_dept UUID;
    v_role public.user_role;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT u.role, u.department_id INTO v_role, v_mgr_dept
    FROM public.users u WHERE u.id = auth.uid();

    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY
        SELECT d.id, d.name, d.slug, d.org_weight_pct, d.active,
               COUNT(DISTINCT k.id), COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
               COUNT(DISTINCT i.id) FILTER (WHERE i.active = true)
        FROM public.departments d
        LEFT JOIN public.kpis k ON k.department_id = d.id
        LEFT JOIN public.department_kpi_indicators i ON i.department_id = d.id
        WHERE d.active = true AND d.is_demo = true
          AND (
              public.is_admin(auth.uid())
              OR (v_role = 'manager'::public.user_role AND v_mgr_dept IS NOT NULL AND d.id = v_mgr_dept)
              OR (v_role = 'employee'::public.user_role AND v_mgr_dept IS NOT NULL AND d.id = v_mgr_dept)
              OR (v_role NOT IN ('manager'::public.user_role, 'employee'::public.user_role))
          )
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
      AND (
          public.is_admin(auth.uid())
          OR (v_role IN ('manager'::public.user_role, 'employee'::public.user_role) AND v_mgr_dept IS NOT NULL AND d.id = v_mgr_dept)
      )
    GROUP BY d.id ORDER BY d.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF p_department_id IS NOT NULL AND NOT public.manager_can_access_department(p_department_id) THEN
        RAISE EXCEPTION 'You do not have access to this department';
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
          public.is_admin(auth.uid())
          OR NOT public.is_manager_role()
          OR v_mgr_dept IS NULL
          OR i.department_id = v_mgr_dept
      )
    ORDER BY d.name, i.sort_order, i.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.save_department_kpi_indicators(
    p_department_id UUID,
    p_indicators JSONB
)
RETURNS VOID AS $$
DECLARE
    v_total NUMERIC := 0;
    v_item JSONB;
    v_id UUID;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
BEGIN
    IF NOT public.manager_can_access_department(p_department_id) THEN
        RAISE EXCEPTION 'You can only edit KPIs for your own department';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_total := v_total + (v_item->>'weight_pct')::NUMERIC;
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department KPI weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_id := (v_item->>'id')::UUID;
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');
        v_desc := NULLIF(trim(v_item->>'description'), '');

        IF v_id IS NOT NULL THEN
            UPDATE public.department_kpi_indicators SET
                weight_pct = v_pct,
                name = COALESCE(NULLIF(v_name, ''), name),
                description = COALESCE(v_desc, description),
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id AND department_id = p_department_id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_department_kpi_board(
    p_employee_id UUID,
    p_department_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_count INTEGER, department_name TEXT) AS $$
DECLARE
    v_email TEXT;
    v_name TEXT;
    v_dept_name TEXT;
    v_count INTEGER := 0;
    v_emp_dept UUID;
    rec RECORD;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    IF NOT public.manager_can_access_department(p_department_id) THEN
        RAISE EXCEPTION 'You can only assign KPI boards from your own department';
    END IF;

    SELECT department_id INTO v_emp_dept FROM public.users WHERE id = p_employee_id;
    IF v_emp_dept IS NOT NULL AND v_emp_dept <> p_department_id THEN
        RAISE EXCEPTION 'Employee belongs to a different department';
    END IF;

    SELECT name INTO v_dept_name FROM public.departments
    WHERE id = p_department_id AND active = true;

    IF v_dept_name IS NULL THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    FOR rec IN
        SELECT i.id, i.name, i.description, i.weight_pct
        FROM public.department_kpi_indicators i
        WHERE i.department_id = p_department_id AND i.active = true
        ORDER BY i.sort_order, i.name
    LOOP
        INSERT INTO public.kpis (
            user_id, name, description, department, department_id, category,
            indicator_id, start_date, end_date, target_value, current_value,
            weight, direction, status, completion_status, redo_count
        ) VALUES (
            p_employee_id, rec.name,
            coalesce(p_notes, rec.description),
            v_dept_name, p_department_id, v_dept_name,
            rec.id, p_start_date, p_end_date,
            100, 0, rec.weight_pct, 'higher_better', 'on_track', 'pending', 0
        );
        v_count := v_count + 1;
    END LOOP;

    PERFORM public.rebalance_employee_kpi_weights(p_employee_id);

    RETURN QUERY SELECT v_email, v_name, v_count, v_dept_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Assign demo users to a demo department for manager isolation testing
DO $$
DECLARE
    v_demo_dept UUID;
BEGIN
    SELECT id INTO v_demo_dept FROM public.departments WHERE is_demo = true AND active = true ORDER BY name LIMIT 1;
    IF v_demo_dept IS NOT NULL THEN
        UPDATE public.users SET department_id = v_demo_dept
        WHERE is_demo = true AND department_id IS NULL
          AND role IN ('manager'::public.user_role, 'employee'::public.user_role);
    END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.user_department_id(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manager_can_access_department(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_org_departments() TO authenticated;
