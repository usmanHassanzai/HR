-- Enforce employee KPI pending weights never exceed 100% after any assign/change.
-- Replace same-department pending board on re-assign to avoid duplicate stacking.

CREATE OR REPLACE FUNCTION public.rebalance_employee_kpi_weights(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_total NUMERIC := 0;
    v_adjust UUID;
    v_diff NUMERIC;
BEGIN
    IF current_setting('app.kpi_rebalancing', true) = 'true' THEN
        SELECT COALESCE(SUM(weight), 0) INTO v_total
        FROM public.kpis
        WHERE user_id = p_user_id AND completion_status = 'pending';
        RETURN v_total;
    END IF;

    PERFORM set_config('app.kpi_rebalancing', 'true', true);

    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_user_id AND completion_status = 'pending';

    IF v_total <= 0 THEN
        PERFORM set_config('app.kpi_rebalancing', 'false', true);
        RETURN 0;
    END IF;

    IF abs(v_total - 100) <= 0.05 THEN
        PERFORM set_config('app.kpi_rebalancing', 'false', true);
        RETURN 100;
    END IF;

    UPDATE public.kpis SET
        weight = ROUND((weight / v_total) * 100, 2),
        updated_at = now()
    WHERE user_id = p_user_id AND completion_status = 'pending';

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

    PERFORM set_config('app.kpi_rebalancing', 'false', true);
    RETURN 100;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Replace pending same-dept board before assign; validate cap after rebalance.
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
    v_total NUMERIC;
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

    UPDATE public.users SET department_id = p_department_id WHERE id = p_employee_id;

    -- Remove existing pending KPIs for this department so re-assign does not stack past 100%.
    DELETE FROM public.kpis
    WHERE user_id = p_employee_id
      AND department_id = p_department_id
      AND completion_status = 'pending';

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

    IF v_count = 0 THEN
        RAISE EXCEPTION 'Select at least one KPI to assign';
    END IF;

    v_total := public.rebalance_employee_kpi_weights(p_employee_id);

    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_employee_id AND completion_status = 'pending';

    IF v_total > 100.05 THEN
        RAISE EXCEPTION 'Employee KPI weights cannot exceed 100%% (currently %). Remove tasks or reassign.', round(v_total, 2);
    END IF;

    RETURN QUERY SELECT v_email, v_name, v_count, v_dept_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Manual single KPI assign must rebalance to 100% cap
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
        IF p_weight < 0.25 OR p_weight > 100 THEN
            RAISE EXCEPTION 'KPI weight must be between 0.25 and 100';
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

    PERFORM public.rebalance_employee_kpi_weights(p_employee_id);

    SELECT COALESCE(SUM(weight), 0) INTO v_total
    FROM public.kpis
    WHERE user_id = p_employee_id AND completion_status = 'pending';

    IF v_total > 100.05 THEN
        RAISE EXCEPTION 'Employee KPI weights cannot exceed 100%% (currently %).', round(v_total, 2);
    END IF;

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

-- Auto-rebalance pending weights after any KPI change
CREATE OR REPLACE FUNCTION public.trg_kpis_auto_rebalance_weights()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.rebalance_employee_kpi_weights(OLD.user_id);
        RETURN OLD;
    END IF;

    IF NEW.completion_status = 'pending' OR (TG_OP = 'UPDATE' AND OLD.completion_status = 'pending') THEN
        PERFORM public.rebalance_employee_kpi_weights(NEW.user_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS kpis_auto_rebalance_weights ON public.kpis;
CREATE TRIGGER kpis_auto_rebalance_weights
    AFTER INSERT OR UPDATE OF weight, completion_status OR DELETE ON public.kpis
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_kpis_auto_rebalance_weights();

-- Fix any existing boards over 100%
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

GRANT EXECUTE ON FUNCTION public.assign_department_kpi_board(UUID, UUID, DATE, DATE, TEXT, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_kpi_manager(UUID, TEXT, TEXT, DATE, DATE, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
