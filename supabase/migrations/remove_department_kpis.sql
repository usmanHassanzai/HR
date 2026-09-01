-- Remove department-level KPI library, org weight scoring, and board assign.
-- Individual employee KPIs (public.kpis.user_id) stay intact.

DROP TRIGGER IF EXISTS departments_after_insert_seed_kpis ON public.departments;
DROP FUNCTION IF EXISTS public.departments_after_insert_seed_kpis() CASCADE;

DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT, UUID[]) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE) CASCADE;
DROP FUNCTION IF EXISTS public.get_department_kpi_indicators(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.save_department_kpi_indicators(UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.seed_default_department_kpis(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.seed_all_missing_department_kpis() CASCADE;
DROP FUNCTION IF EXISTS public.can_manage_department_kpis(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.save_department_org_weights(JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.save_department_weightages(JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.rebalance_company_department_weights(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.rebalance_demo_department_weights() CASCADE;
DROP FUNCTION IF EXISTS public.rebalance_department_org_weights() CASCADE;

ALTER TABLE public.kpis DROP COLUMN IF EXISTS indicator_id;

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
        SELECT d.id, d.name, d.slug, COALESCE(d.org_weight_pct, 0), d.active,
               COUNT(DISTINCT k.id),
               COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
               0::BIGINT
        FROM public.departments d
        LEFT JOIN public.kpis k ON k.department_id = d.id
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
    SELECT d.id, d.name, d.slug, COALESCE(d.org_weight_pct, 0), d.active,
           COUNT(DISTINCT k.id),
           COUNT(DISTINCT k.id) FILTER (WHERE k.completion_status = 'pending'),
           0::BIGINT
    FROM public.departments d
    LEFT JOIN public.kpis k ON k.department_id = d.id
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

DROP TABLE IF EXISTS public.department_kpi_indicators CASCADE;

CREATE OR REPLACE FUNCTION public.assign_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_weight NUMERIC DEFAULT 10,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_emp_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
    v_pending NUMERIC := 0;
    v_name TEXT;
    v_notes TEXT := nullif(btrim(COALESCE(p_notes, '')), '');
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this person';
    END IF;

    v_name := trim(COALESCE(p_kpi_name, ''));
    IF v_name = '' THEN
        RAISE EXCEPTION 'KPI name is required';
    END IF;

    v_weight := round(COALESCE(p_weight, 0)::NUMERIC, 2);
    IF v_weight < 1 OR v_weight > 100 THEN
        RAISE EXCEPTION 'Weight must be between 1%% and 100%%';
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Start date and end date are required';
    END IF;

    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date must be on or after start date';
    END IF;

    SELECT u.email, u.full_name, u.department_id
    INTO v_email, v_emp_name, v_dept_id
    FROM public.users u
    WHERE u.id = p_employee_id;

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Employee not found';
    END IF;

    IF v_dept_id IS NOT NULL THEN
        SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id;
    END IF;

    SELECT COALESCE(SUM(weight), 0) INTO v_pending
    FROM public.kpis
    WHERE user_id = p_employee_id
      AND completion_status = 'pending';

    IF v_pending + v_weight > 100.05 THEN
        RAISE EXCEPTION 'This person''s open KPI weights cannot exceed 100%% (currently % + %).',
            round(v_pending, 2), v_weight;
    END IF;

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category,
        start_date, end_date, target_value, current_value, weight, direction,
        status, completion_status, redo_count, assignment_notes
    ) VALUES (
        p_employee_id, v_name, NULLIF(trim(COALESCE(p_description, '')), ''),
        v_dept_name, v_dept_id, COALESCE(v_dept_name, 'Individual'),
        p_start_date, p_end_date, 100, 0, v_weight, 'higher_better',
        'on_track', 'pending', 0, v_notes
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI assigned',
        'You were assigned: "' || v_name || '". Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    RETURN QUERY SELECT v_email, COALESCE(v_emp_name, 'Employee'), v_kpi_id, v_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_employee_kpi(UUID, TEXT, TEXT, NUMERIC, DATE, DATE, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
