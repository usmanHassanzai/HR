-- Managers assign KPI tasks to their direct reports (own team).
-- Team = employees with manager_id set; department match when both sides have one.

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
              OR u.department_id IS NULL
              OR u.department_id = v_mgr_dept
          )
        ORDER BY u.full_name;
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

    IF NOT public.manager_can_access_department(p_department_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You can only assign KPI boards from your own department';
    END IF;

    SELECT department_id INTO v_emp_dept FROM public.users WHERE id = p_employee_id;
    IF v_emp_dept IS NOT NULL AND v_emp_dept <> p_department_id THEN
        RAISE EXCEPTION 'Employee belongs to a different department';
    END IF;

    -- Link employee to department on first assignment when admin has not set one yet
    IF v_emp_dept IS NULL THEN
        UPDATE public.users SET department_id = p_department_id WHERE id = p_employee_id;
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
