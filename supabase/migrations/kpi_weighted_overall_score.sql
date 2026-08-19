-- Overall KPI Score = SUM((employee_score / 100) * weight). Two decimal places.
-- Employee score matches the app: completed=100, else current/target, else status.

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    total_weighted NUMERIC := 0;
    kpi_row RECORD;
    emp_score NUMERIC;
BEGIN
    FOR kpi_row IN
        SELECT completion_status, current_value, target_value, status, weight
        FROM public.kpis
        WHERE user_id = p_user_id
    LOOP
        IF kpi_row.completion_status = 'completed' THEN
            emp_score := 100;
        ELSIF kpi_row.target_value IS NOT NULL AND kpi_row.target_value > 0 THEN
            emp_score := LEAST(100, GREATEST(0, ROUND((kpi_row.current_value / kpi_row.target_value) * 100)));
        ELSIF kpi_row.status = 'on_track'::kpi_status_type THEN
            emp_score := 100;
        ELSIF kpi_row.status = 'at_risk'::kpi_status_type THEN
            emp_score := 50;
        ELSE
            emp_score := 0;
        END IF;

        total_weighted := total_weighted + ROUND((emp_score / 100.0) * COALESCE(kpi_row.weight, 0), 2);
    END LOOP;

    RETURN ROUND(COALESCE(total_weighted, 0), 2);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

NOTIFY pgrst, 'reload schema';
