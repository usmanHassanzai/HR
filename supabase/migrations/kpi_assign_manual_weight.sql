-- Allow admin/manager to set KPI weight when assigning to an employee

DROP FUNCTION IF EXISTS public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE);
DROP FUNCTION IF EXISTS public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC);

CREATE OR REPLACE FUNCTION public.assign_kpi_manager(
    p_employee_id UUID,
    p_department TEXT,
    p_description TEXT,
    p_start_date DATE,
    p_end_date DATE,
    p_weight NUMERIC DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID, kpi_weight NUMERIC) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_name TEXT;
    v_dept_id UUID;
    v_dept_name TEXT;
    v_weight NUMERIC;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    v_dept_id := public.resolve_department_id(p_department);

    IF v_dept_id IS NULL THEN
        RAISE EXCEPTION 'Unknown department. Select from configured departments list.';
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = v_dept_id;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    IF p_weight IS NOT NULL THEN
        IF p_weight < 0.25 OR p_weight > 10 THEN
            RAISE EXCEPTION 'KPI weight must be between 0.25 and 10';
        END IF;
        v_weight := ROUND(p_weight, 2);
    ELSE
        v_weight := public.calculate_kpi_weight(p_employee_id, v_dept_id, p_start_date, p_end_date, NULL);
    END IF;

    INSERT INTO public.kpis (
        user_id, name, description, department, department_id, category,
        start_date, end_date, target_value, current_value, weight, direction, status, completion_status, redo_count
    ) VALUES (
        p_employee_id, v_dept_name, p_description, v_dept_name, v_dept_id, v_dept_name,
        p_start_date, p_end_date, 100, 0, v_weight, 'higher_better', 'at_risk', 'pending', 0
    ) RETURNING id INTO v_kpi_id;

    PERFORM public.create_system_notification(
        p_employee_id,
        'New KPI Assigned',
        'Your manager assigned a KPI in ' || v_dept_name || '. Due by ' || p_end_date::TEXT
            || '. Weight: ' || v_weight::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_id := v_kpi_id;
    kpi_weight := v_weight;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC) TO authenticated;
