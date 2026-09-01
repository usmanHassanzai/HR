-- Default KPI library for every new department (matches the Designing & video editing board).

CREATE OR REPLACE FUNCTION public.seed_default_department_kpis(p_department_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    IF auth.uid() IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'can_manage_department_kpis'
       )
       AND NOT public.can_manage_department_kpis(p_department_id)
    THEN
        RAISE EXCEPTION 'Not authorized to seed KPIs for this department';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    IF v_count > 0 THEN
        RETURN v_count;
    END IF;

    INSERT INTO public.department_kpi_indicators (department_id, name, description, weight_pct, sort_order, active)
    VALUES
        (
            p_department_id,
            'Monthly Goal Achievement',
            'Measures the employee''s success in achieving assigned monthly targets.',
            55.00, 1, true
        ),
        (
            p_department_id,
            'Daily Task Completion',
            'Measures timely and consistent completion of assigned daily tasks.',
            15.00, 2, true
        ),
        (
            p_department_id,
            'Quality of Work',
            'Evaluates the accuracy, completeness, professionalism, and overall quality of work.',
            10.00, 3, true
        ),
        (
            p_department_id,
            'Attendance',
            'Measures regular attendance, punctuality, and adherence to work hours.',
            10.00, 4, true
        ),
        (
            p_department_id,
            'Professional Conduct',
            'Represents the employee''s professional behaviour and combined monthly performance.',
            10.00, 5, true
        )
    ON CONFLICT (department_id, name) DO NOTHING;

    SELECT COUNT(*) INTO v_count
    FROM public.department_kpi_indicators
    WHERE department_id = p_department_id AND active = true;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.seed_default_department_kpis(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.seed_all_missing_department_kpis()
RETURNS TABLE(department_name TEXT, indicators_added INTEGER) AS $$
DECLARE
    rec RECORD;
    v_count INTEGER;
BEGIN
    FOR rec IN
        SELECT d.id, d.name
        FROM public.departments d
        WHERE d.active = true
          AND NOT EXISTS (
              SELECT 1 FROM public.department_kpi_indicators i
              WHERE i.department_id = d.id AND i.active = true
          )
    LOOP
        v_count := public.seed_default_department_kpis(rec.id);
        department_name := rec.name;
        indicators_added := v_count;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.seed_all_missing_department_kpis() TO authenticated;

CREATE OR REPLACE FUNCTION public.departments_after_insert_seed_kpis()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM public.seed_default_department_kpis(NEW.id);
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS departments_after_insert_seed_kpis ON public.departments;
CREATE TRIGGER departments_after_insert_seed_kpis
    AFTER INSERT ON public.departments
    FOR EACH ROW
    EXECUTE FUNCTION public.departments_after_insert_seed_kpis();

SELECT public.seed_all_missing_department_kpis();

NOTIFY pgrst, 'reload schema';
