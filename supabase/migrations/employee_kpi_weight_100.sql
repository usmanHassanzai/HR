-- Each employee's pending KPIs must sum to 100% (independent per employee)

CREATE OR REPLACE FUNCTION public.rebalance_employee_kpi_weights(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_total NUMERIC := 0;
    v_adjust UUID;
    v_diff NUMERIC;
BEGIN
    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_user_id AND completion_status = 'pending';

    IF v_total <= 0 THEN
        RETURN 0;
    END IF;

    -- Already 100% (within tolerance)
    IF abs(v_total - 100) <= 0.05 THEN
        RETURN 100;
    END IF;

    UPDATE public.kpis SET
        weight = ROUND((weight / v_total) * 100, 2),
        updated_at = now()
    WHERE user_id = p_user_id AND completion_status = 'pending';

    -- Fix rounding drift on largest weight
    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_user_id AND completion_status = 'pending';

    v_diff := 100 - v_total;
    IF abs(v_diff) > 0.001 THEN
        SELECT id INTO v_adjust
        FROM public.kpis
        WHERE user_id = p_user_id AND completion_status = 'pending'
        ORDER BY weight DESC
        LIMIT 1;

        IF v_adjust IS NOT NULL THEN
            UPDATE public.kpis SET
                weight = weight + v_diff,
                updated_at = now()
            WHERE id = v_adjust;
        END IF;
    END IF;

    RETURN 100;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Employee KPI board total (pending KPIs only)
CREATE OR REPLACE FUNCTION public.get_employee_kpi_weight_total(p_user_id UUID)
RETURNS TABLE(total_weight NUMERIC, kpi_count BIGINT) AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    -- Employees see only self; managers see direct reports; admin sees all
    IF auth.uid() <> p_user_id
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT
        COALESCE(SUM(k.weight), 0)::NUMERIC AS total_weight,
        COUNT(*)::BIGINT AS kpi_count
    FROM public.kpis k
    WHERE k.user_id = p_user_id AND k.completion_status = 'pending';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Assign department board: each employee gets their own 100% KPI set
DROP FUNCTION IF EXISTS public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.assign_department_kpi_board(
    p_employee_id UUID,
    p_department_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_count INTEGER, department_name TEXT, total_weight NUMERIC) AS $$
DECLARE
    v_email TEXT;
    v_name TEXT;
    v_dept_name TEXT;
    v_count INTEGER := 0;
    v_total NUMERIC;
    rec RECORD;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
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
            COALESCE(rec.description, '') || CASE WHEN p_notes IS NOT NULL AND trim(p_notes) <> '' THEN E'\n\nNotes: ' || p_notes ELSE '' END,
            v_dept_name, p_department_id, v_dept_name,
            rec.id, p_start_date, p_end_date, 100, 0,
            rec.weight_pct, 'higher_better', 'at_risk', 'pending', 0
        );

        v_count := v_count + 1;
    END LOOP;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'No KPI indicators configured for this department';
    END IF;

    -- Normalize this employee's pending KPIs to exactly 100%
    v_total := public.rebalance_employee_kpi_weights(p_employee_id);

    PERFORM public.create_system_notification(
        p_employee_id,
        'Department KPI Board Assigned',
        'Your manager assigned the ' || v_dept_name || ' KPI board (' || v_count || ' metrics, total 100%). Due by ' || p_end_date::TEXT || '.',
        'info'
    );

    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_count := v_count;
    department_name := v_dept_name;
    total_weight := v_total;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Rebalance all employees with pending KPIs (one-time fix)
DO $$
DECLARE
    v_user UUID;
BEGIN
    FOR v_user IN
        SELECT DISTINCT user_id FROM public.kpis WHERE completion_status = 'pending'
    LOOP
        PERFORM public.rebalance_employee_kpi_weights(v_user);
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.rebalance_employee_kpi_weights(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_kpi_weight_total(UUID) TO authenticated;
