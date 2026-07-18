-- Managers create/edit KPI boards for their assigned department; admins for all.

CREATE OR REPLACE FUNCTION public.can_manage_department_kpis(p_department_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN
        RETURN EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = p_department_id
              AND (
                  public.is_demo_user(auth.uid())
                  OR d.company_id = public.current_company_id()
                  OR (d.is_demo = true AND public.is_demo_user(auth.uid()))
              )
        );
    END IF;
    RETURN public.manager_can_access_department(p_department_id);
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
    v_id_text TEXT;
    v_pct NUMERIC;
    v_name TEXT;
    v_desc TEXT;
    v_sort INTEGER;
    v_kept UUID[] := ARRAY[]::UUID[];
BEGIN
    IF NOT public.can_manage_department_kpis(p_department_id) THEN
        RAISE EXCEPTION 'Not authorized to manage KPIs for this department';
    END IF;

    IF p_indicators IS NULL OR jsonb_array_length(p_indicators) = 0 THEN
        RAISE EXCEPTION 'No KPI indicators provided';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_total := v_total + COALESCE((v_item->>'weight_pct')::NUMERIC, 0);
    END LOOP;

    IF abs(v_total - 100) > 0.05 THEN
        RAISE EXCEPTION 'Department KPI weightages must sum to 100%% (currently %)', round(v_total, 2);
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_indicators)
    LOOP
        v_id_text := NULLIF(trim(v_item->>'id'), '');
        v_pct := (v_item->>'weight_pct')::NUMERIC;
        v_name := trim(v_item->>'name');
        v_desc := NULLIF(trim(v_item->>'description'), '');
        v_sort := COALESCE((v_item->>'sort_order')::INTEGER, 0);
        v_id := NULL;

        IF v_name IS NULL OR v_name = '' THEN
            CONTINUE;
        END IF;

        IF v_id_text IS NOT NULL AND v_id_text !~ '^new-' THEN
            BEGIN
                v_id := v_id_text::UUID;
            EXCEPTION WHEN invalid_text_representation THEN
                v_id := NULL;
            END;
        END IF;

        IF v_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.department_kpi_indicators
            WHERE id = v_id AND department_id = p_department_id
        ) THEN
            UPDATE public.department_kpi_indicators SET
                weight_pct = v_pct,
                name = v_name,
                description = COALESCE(v_desc, description),
                sort_order = v_sort,
                active = true,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_id AND department_id = p_department_id;
            v_kept := array_append(v_kept, v_id);
        ELSE
            INSERT INTO public.department_kpi_indicators (
                department_id, name, description, weight_pct, sort_order, active
            ) VALUES (
                p_department_id, v_name, v_desc, v_pct, v_sort, true
            )
            ON CONFLICT (department_id, name) DO UPDATE SET
                description = EXCLUDED.description,
                weight_pct = EXCLUDED.weight_pct,
                sort_order = EXCLUDED.sort_order,
                active = true,
                updated_at = timezone('utc'::text, now())
            RETURNING id INTO v_id;
            v_kept := array_append(v_kept, v_id);
        END IF;
    END LOOP;

    UPDATE public.department_kpi_indicators SET
        active = false,
        updated_at = timezone('utc'::text, now())
    WHERE department_id = p_department_id
      AND active = true
      AND NOT (id = ANY(v_kept));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.seed_default_department_kpis(p_department_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
    v_dept_name TEXT;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.can_manage_department_kpis(p_department_id) THEN
        RAISE EXCEPTION 'Not authorized to seed KPIs for this department';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    IF v_count > 0 THEN
        RETURN v_count;
    END IF;

    SELECT name INTO v_dept_name FROM public.departments WHERE id = p_department_id;

    INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order, active)
    VALUES
        (p_department_id, 'Performance Target / Volume',
         'Actual results versus monthly quota or target for ' || COALESCE(v_dept_name, 'the department') || '.',
         30.00, 1, true),
        (p_department_id, 'Quality & Accuracy',
         'Percentage of work passing quality checks.', 30.00, 2, true),
        (p_department_id, 'Timeliness / Delivery',
         'Tasks completed within the promised time frame.', 20.00, 3, true),
        (p_department_id, 'Efficiency & Productivity',
         'Average time to complete core department processes.', 20.00, 4, true)
    ON CONFLICT (department_id, name) DO NOTHING;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.can_manage_department_kpis(UUID) TO authenticated;

-- Team = direct reports (manager_id). Department only scopes KPI board creation.
CREATE OR REPLACE FUNCTION public.is_manager_of(p_manager_id UUID, p_employee_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users emp
        WHERE emp.id = p_employee_id
          AND emp.manager_id = p_manager_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_manager_id);
    IF NOT public.is_demo_user(auth.uid()) AND NOT public.same_company(p_manager_id) THEN
        RAISE EXCEPTION 'Cannot view users from another company';
    END IF;

    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id
          AND u.role = 'employee'::public.user_role
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
          AND (public.is_demo_user(auth.uid()) OR u.company_id = public.current_company_id())
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
    rec RECORD;
BEGIN
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;

    IF NOT public.manager_can_access_department(p_department_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You can only assign KPI boards from your own department';
    END IF;

    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;

    SELECT name INTO v_dept_name FROM public.departments
    WHERE id = p_department_id AND active = true;

    IF v_dept_name IS NULL THEN
        RAISE EXCEPTION 'Department not found';
    END IF;

    UPDATE public.users SET department_id = p_department_id WHERE id = p_employee_id;

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
