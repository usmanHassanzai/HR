-- Points come from assigned Score, Weight, and due date — not Achieved / Not Achieved.
-- Complete on or before the due date → full Score. Complete after due date → half Score. Open → 0.

CREATE OR REPLACE FUNCTION public.kpi_is_late_completion(p_end_date DATE, p_completed_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT p_end_date IS NOT NULL
       AND p_completed_at IS NOT NULL
       AND ((p_completed_at AT TIME ZONE 'Asia/Karachi')::DATE > p_end_date);
$$;

CREATE OR REPLACE FUNCTION public.kpi_points_awarded(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_score NUMERIC;
BEGIN
    IF k.completion_status IS DISTINCT FROM 'completed' THEN
        RETURN 0;
    END IF;
    v_score := GREATEST(COALESCE(k.assigned_score, k.weight, 0), 0);
    IF public.kpi_is_late_completion(k.end_date, COALESCE(k.completed_at, k.updated_at)) THEN
        RETURN ROUND(v_score * 0.5, 2);
    END IF;
    RETURN ROUND(v_score, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_employee_score_pct(k public.kpis)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF k.completion_status IS DISTINCT FROM 'completed' THEN
        RETURN NULL;
    END IF;
    IF COALESCE(k.weight, 0) <= 0 THEN
        RETURN 0;
    END IF;
    RETURN ROUND((public.kpi_points_awarded(k) / k.weight) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_employee_kpi_progress(p_kpi_id UUID, p_progress TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_progress TEXT := lower(trim(COALESCE(p_progress, '')));
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF v_progress IN ('in_progress', 'in progress') THEN
        v_progress := 'started';
    END IF;
    IF v_progress NOT IN ('started', 'completed') THEN
        RAISE EXCEPTION 'Choose In Progress or Complete';
    END IF;

    UPDATE public.kpis SET
        employee_progress = v_progress,
        completion_status = CASE WHEN v_progress = 'completed' THEN 'completed'::public.kpi_completion_status ELSE 'pending'::public.kpi_completion_status END,
        completed_at = CASE WHEN v_progress = 'completed' THEN timezone('utc'::text, now()) ELSE NULL END,
        result_status = NULL,
        manager_rating = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id
    RETURNING * INTO v_kpi;

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
END;
$$;

-- Treat old Achieved marks as completed so existing scores are not wiped.
UPDATE public.kpis
SET
    completion_status = 'completed',
    completed_at = COALESCE(completed_at, updated_at, timezone('utc'::text, now())),
    employee_progress = 'completed'
WHERE result_status = 'achieved'
  AND completion_status IS DISTINCT FROM 'completed';

GRANT EXECUTE ON FUNCTION public.kpi_points_awarded(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_employee_score_pct(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_kpi_progress(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
