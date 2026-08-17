-- Assign any department KPI whose weight is 1–100% (e.g. a single 10% task).
-- Keep the assigned weight as-is. Do not scale pending tasks up to 100%.
-- Employee pending total still cannot exceed 100%.

CREATE OR REPLACE FUNCTION public.rebalance_employee_kpi_weights(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_total NUMERIC := 0;
BEGIN
    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_user_id AND completion_status = 'pending';

    RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_department_kpi_board(
    p_employee_id UUID,
    p_department_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL,
    p_indicator_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_count INTEGER, department_name TEXT) AS $$
DECLARE
    v_email TEXT;
    v_name TEXT;
    v_dept_name TEXT;
    v_count INTEGER := 0;
    v_new_weight NUMERIC := 0;
    v_other_pending NUMERIC := 0;
    rec RECORD;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    IF NOT public.manager_can_access_department(p_department_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You can only assign KPI boards from your own department';
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL THEN
        RAISE EXCEPTION 'Start date and end date are required';
    END IF;

    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'End date must be on or after start date';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    SELECT name INTO v_dept_name FROM public.departments
    WHERE id = p_department_id AND active = true;

    IF v_dept_name IS NULL THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    FOR rec IN
        SELECT i.id, i.name, i.description, i.weight_pct
        FROM public.department_kpi_indicators i
        WHERE i.department_id = p_department_id AND i.active = true
          AND (p_indicator_ids IS NULL OR i.id = ANY(p_indicator_ids))
        ORDER BY i.sort_order, i.name
    LOOP
        IF rec.weight_pct IS NULL OR rec.weight_pct < 1 OR rec.weight_pct > 100 THEN
            RAISE EXCEPTION 'KPI "%" weight must be between 1%% and 100%% (currently %).', rec.name, round(COALESCE(rec.weight_pct, 0), 2);
        END IF;
        v_new_weight := v_new_weight + rec.weight_pct;
        v_count := v_count + 1;
    END LOOP;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'Select at least one KPI to assign';
    END IF;

    IF v_new_weight > 100.05 THEN
        RAISE EXCEPTION 'Selected KPI weights cannot exceed 100%% (currently %).', round(v_new_weight, 2);
    END IF;

    -- Same-department pending tasks are replaced; other departments keep their weight.
    SELECT COALESCE(SUM(weight), 0) INTO v_other_pending
    FROM public.kpis
    WHERE user_id = p_employee_id
      AND completion_status = 'pending'
      AND (department_id IS DISTINCT FROM p_department_id);

    IF v_other_pending + v_new_weight > 100.05 THEN
        RAISE EXCEPTION 'Employee KPI weights cannot exceed 100%% (currently % + % = %). Assign a smaller weight or complete existing tasks.',
            round(v_other_pending, 2), round(v_new_weight, 2), round(v_other_pending + v_new_weight, 2);
    END IF;

    UPDATE public.users SET department_id = p_department_id WHERE id = p_employee_id;

    DELETE FROM public.kpis
    WHERE user_id = p_employee_id
      AND department_id = p_department_id
      AND completion_status = 'pending';

    v_count := 0;
    FOR rec IN
        SELECT i.id, i.name, i.description, i.weight_pct
        FROM public.department_kpi_indicators i
        WHERE i.department_id = p_department_id AND i.active = true
          AND (p_indicator_ids IS NULL OR i.id = ANY(p_indicator_ids))
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

    RETURN QUERY SELECT v_email, v_name, v_count, v_dept_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
    v_total NUMERIC;
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
        IF p_weight < 1 OR p_weight > 100 THEN
            RAISE EXCEPTION 'KPI weight must be between 1 and 100';
        END IF;
        v_weight := ROUND(p_weight, 2);
    ELSE
        v_weight := public.calculate_kpi_weight(p_employee_id, v_dept_id, p_start_date, p_end_date, NULL);
        IF v_weight < 1 THEN v_weight := 1; END IF;
        IF v_weight > 100 THEN v_weight := 100; END IF;
    END IF;

    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_employee_id AND completion_status = 'pending';

    IF v_total + v_weight > 100.05 THEN
        RAISE EXCEPTION 'Employee KPI weights cannot exceed 100%% (currently % + % = %).',
            round(v_total, 2), round(v_weight, 2), round(v_total + v_weight, 2);
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
        'Your manager assigned a KPI in ' || v_dept_name || '. Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_id := v_kpi_id;
    kpi_weight := v_weight;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Do not scale pending weights up or down. Assignment RPCs enforce the 100% cap.
CREATE OR REPLACE FUNCTION public.trg_kpis_auto_rebalance_weights()
RETURNS TRIGGER AS $$
BEGIN
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rebalance_employee_kpi_weights(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
