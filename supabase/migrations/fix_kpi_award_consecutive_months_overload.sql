-- Fix: kpi_award_consecutive_months 4-arg vs 5-arg overload ambiguity.
-- Calls with (uuid, numeric, numeric, date) matched both overloads.

DROP FUNCTION IF EXISTS public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE);
DROP FUNCTION IF EXISTS public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.kpi_award_consecutive_months(
    p_user_id UUID,
    p_min NUMERIC,
    p_max NUMERIC,
    p_from DATE DEFAULT NULL,
    p_rule_key TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cursor DATE := date_trunc(
        'month',
        COALESCE(p_from, (timezone('Asia/Karachi', now()))::DATE)
    )::DATE;
    v_score NUMERIC;
    v_count INTEGER := 0;
    v_i INTEGER;
    v_last DATE;
BEGIN
    IF p_rule_key IS NOT NULL THEN
        SELECT MAX(period_end) INTO v_last
        FROM public.kpi_award_qualifications
        WHERE employee_id = p_user_id
          AND rule_key = p_rule_key
          AND status IS DISTINCT FROM 'dismissed';
    END IF;

    FOR v_i IN 1..24 LOOP
        IF v_last IS NOT NULL AND v_cursor <= v_last THEN
            EXIT;
        END IF;
        v_score := public.kpi_award_month_score(p_user_id, v_cursor);
        EXIT WHEN NOT public.kpi_award_in_band(v_score, p_min, p_max);
        v_count := v_count + 1;
        v_cursor := (v_cursor - INTERVAL '1 month')::DATE;
    END LOOP;
    RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kpi_award_consecutive_months(UUID, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
