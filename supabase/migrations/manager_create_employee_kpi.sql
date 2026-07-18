-- Manager creates individual KPI tasks for direct reports (no department board UI required).

CREATE OR REPLACE FUNCTION public.create_employee_kpi(
    p_employee_id UUID,
    p_kpi_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_name TEXT) AS $$
DECLARE
    v_dept_id UUID;
    v_dept_name TEXT;
    v_kpi_id UUID;
    v_email TEXT;
    v_emp_name TEXT;
    v_weight NUMERIC;
    v_kpi_name TEXT;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to create KPIs for this employee';
    END IF;

    v_kpi_name := trim(p_kpi_name);
    IF v_kpi_name IS NULL OR v_kpi_name = '' THEN
        RAISE EXCEPTION 'KPI task name is required';
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Start date and end date are required';
    END IF;

    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date must be on or after start date';
    END IF;

    IF public.is_admin(auth.uid()) THEN
        SELECT COALESCE(m.department_id, e.department_id) INTO v_dept_id
        FROM public.users e
        LEFT JOIN public.users m ON m.id = auth.uid()
        WHERE e.id = p_employee_id;
    ELSE
        SELECT department_id INTO v_dept_id FROM public.users WHERE id = auth.uid();
    END IF;

    IF v_dept_id IS NULL THEN
        RAISE EXCEPTION 'No department assigned. Ask admin to assign your department.';
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id AND active = true;
    IF v_dept_name IS NULL THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_emp_name FROM public.users u WHERE u.id = p_employee_id;

    v_weight := public.calculate_kpi_weight(p_employee_id, v_dept_id, p_start_date, p_end_date, NULL);

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category,
        start_date, end_date, target_value, current_value, weight, direction, status, completion_status, redo_count
    ) VALUES (
        p_employee_id, v_kpi_name, NULLIF(trim(p_description), ''), v_dept_name, v_dept_id, v_dept_name,
        p_start_date, p_end_date, 100, 0, v_weight, 'higher_better', 'on_track', 'pending', 0
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.rebalance_employee_kpi_weights(p_employee_id);

    UPDATE public.users SET department_id = v_dept_id
    WHERE id = p_employee_id AND department_id IS NULL;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI Task Assigned',
        'Your manager assigned: "' || v_kpi_name || '". Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    RETURN QUERY SELECT v_email, COALESCE(v_emp_name, 'Employee'), v_kpi_id, v_kpi_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_employee_kpi(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;
