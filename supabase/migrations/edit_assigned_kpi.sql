-- Supervisors can re-edit assigned KPI weight, score, due date, and status at any time.
-- Each change is written to kpi_assignment_edits.

CREATE OR REPLACE FUNCTION public.kpi_is_late_completion(p_end_date DATE, p_completed_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT p_end_date IS NOT NULL
       AND p_completed_at IS NOT NULL
       AND (p_completed_at AT TIME ZONE 'utc')::DATE > p_end_date;
$$;

ALTER TABLE public.kpis
    ADD COLUMN IF NOT EXISTS supervisor_score_pct NUMERIC;

ALTER TABLE public.kpis
    DROP CONSTRAINT IF EXISTS kpis_supervisor_score_pct_check;

ALTER TABLE public.kpis
    ADD CONSTRAINT kpis_supervisor_score_pct_check
    CHECK (supervisor_score_pct IS NULL OR (supervisor_score_pct >= 0 AND supervisor_score_pct <= 100));

-- Manual weight edits must not be overwritten by the old auto-rebalance trigger.
DROP TRIGGER IF EXISTS kpis_auto_rebalance_weights ON public.kpis;

CREATE TABLE IF NOT EXISTS public.kpi_assignment_edits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kpi_id UUID NOT NULL REFERENCES public.kpis(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    editor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    company_id UUID,
    changes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_kpi_assignment_edits_kpi ON public.kpi_assignment_edits(kpi_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_assignment_edits_employee ON public.kpi_assignment_edits(employee_id, created_at DESC);

ALTER TABLE public.kpi_assignment_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kpi_assignment_edits_select ON public.kpi_assignment_edits;
CREATE POLICY kpi_assignment_edits_select ON public.kpi_assignment_edits
    FOR SELECT TO authenticated
    USING (
        editor_id = auth.uid()
        OR employee_id = auth.uid()
        OR public.is_admin(auth.uid())
        OR public.is_manager_of(auth.uid(), employee_id)
    );

REVOKE ALL ON public.kpi_assignment_edits FROM anon, public;
GRANT SELECT ON public.kpi_assignment_edits TO authenticated;

CREATE OR REPLACE FUNCTION public.kpi_employee_score_pct(k public.kpis)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN k.supervisor_score_pct IS NOT NULL THEN
            LEAST(100::NUMERIC, GREATEST(0::NUMERIC, ROUND(k.supervisor_score_pct, 2)))
        WHEN k.completion_status = 'completed' THEN
            CASE
                WHEN public.kpi_is_late_completion(k.end_date, COALESCE(k.completed_at, k.updated_at))
                THEN 50::NUMERIC
                ELSE 100::NUMERIC
            END
        WHEN COALESCE(k.target_value, 0) > 0 THEN
            LEAST(100::NUMERIC, GREATEST(0::NUMERIC,
                ROUND((COALESCE(k.current_value, 0) / NULLIF(k.target_value, 0)) * 100)
            ))
        WHEN k.status = 'on_track' THEN 100::NUMERIC
        WHEN k.status = 'at_risk' THEN 50::NUMERIC
        ELSE 0::NUMERIC
    END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    total_weighted NUMERIC := 0;
    kpi_row public.kpis%ROWTYPE;
BEGIN
    FOR kpi_row IN
        SELECT * FROM public.kpis WHERE user_id = p_user_id
    LOOP
        total_weighted := total_weighted
            + ROUND((public.kpi_employee_score_pct(kpi_row) / 100.0) * COALESCE(kpi_row.weight, 0), 2);
    END LOOP;

    RETURN ROUND(COALESCE(total_weighted, 0), 2);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.edit_assigned_kpi(
    p_kpi_id UUID,
    p_weight NUMERIC,
    p_score_pct NUMERIC,
    p_end_date DATE,
    p_status TEXT,
    p_completion_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_other_pending NUMERIC := 0;
    v_changes JSONB := '{}'::jsonb;
    v_new_status public.kpi_status_type;
    v_new_completion TEXT;
    v_score NUMERIC;
    v_health NUMERIC;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF v_me.role NOT IN ('admin', 'manager') THEN
        RAISE EXCEPTION 'Only admins and managers can edit assigned tasks';
    END IF;

    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF v_kpi.id IS NULL THEN
        RAISE EXCEPTION 'Task not found';
    END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = v_kpi.user_id;
    IF v_emp.id IS NULL THEN
        RAISE EXCEPTION 'Employee not found';
    END IF;

    IF NOT public.same_company(v_emp.id) THEN
        RAISE EXCEPTION 'Not authorized for this organization';
    END IF;

    IF v_me.role = 'manager' AND NOT public.is_manager_of(auth.uid(), v_emp.id) AND v_emp.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'You can only edit tasks for your team';
    END IF;

    IF p_weight IS NULL OR p_weight < 1 OR p_weight > 100 THEN
        RAISE EXCEPTION 'Weightage must be between 1%% and 100%%';
    END IF;

    IF p_score_pct IS NULL OR p_score_pct < 0 OR p_score_pct > 100 THEN
        RAISE EXCEPTION 'KPI score must be between 0%% and 100%%';
    END IF;

    IF p_end_date IS NULL THEN
        RAISE EXCEPTION 'Due date is required';
    END IF;

    IF v_kpi.start_date IS NOT NULL AND p_end_date < v_kpi.start_date THEN
        RAISE EXCEPTION 'Due date must be on or after the start date';
    END IF;

    IF p_status NOT IN ('on_track', 'at_risk', 'off_track') THEN
        RAISE EXCEPTION 'Invalid task status';
    END IF;

    IF p_completion_status NOT IN ('pending', 'completed') THEN
        RAISE EXCEPTION 'Invalid completion status';
    END IF;

    v_new_status := p_status::public.kpi_status_type;
    v_new_completion := p_completion_status;
    v_score := ROUND(p_score_pct, 2);

    IF v_new_completion = 'pending' THEN
        SELECT COALESCE(SUM(weight), 0) INTO v_other_pending
        FROM public.kpis
        WHERE user_id = v_kpi.user_id
          AND id IS DISTINCT FROM v_kpi.id
          AND completion_status::TEXT IS DISTINCT FROM 'completed';

        IF v_other_pending + p_weight > 100.05 THEN
            RAISE EXCEPTION 'This employee''s pending KPI weights cannot exceed 100%% (other tasks % + this %).',
                ROUND(v_other_pending, 2), ROUND(p_weight, 2);
        END IF;
    END IF;

    IF ROUND(COALESCE(v_kpi.weight, 0), 2) IS DISTINCT FROM ROUND(p_weight, 2) THEN
        v_changes := v_changes || jsonb_build_object('weight', jsonb_build_object('from', v_kpi.weight, 'to', p_weight));
    END IF;
    IF ROUND(COALESCE(v_kpi.supervisor_score_pct, public.kpi_employee_score_pct(v_kpi)), 2) IS DISTINCT FROM v_score THEN
        v_changes := v_changes || jsonb_build_object(
            'score_pct',
            jsonb_build_object('from', public.kpi_employee_score_pct(v_kpi), 'to', v_score)
        );
    END IF;
    IF v_kpi.end_date IS DISTINCT FROM p_end_date THEN
        v_changes := v_changes || jsonb_build_object('end_date', jsonb_build_object('from', v_kpi.end_date, 'to', p_end_date));
    END IF;
    IF v_kpi.status::TEXT IS DISTINCT FROM p_status THEN
        v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', v_kpi.status, 'to', p_status));
    END IF;
    IF COALESCE(v_kpi.completion_status::TEXT, 'pending') IS DISTINCT FROM v_new_completion THEN
        v_changes := v_changes || jsonb_build_object(
            'completion_status',
            jsonb_build_object('from', COALESCE(v_kpi.completion_status::TEXT, 'pending'), 'to', v_new_completion)
        );
    END IF;

    IF v_changes = '{}'::jsonb THEN
        RETURN jsonb_build_object(
            'updated', false,
            'overall_score', public.calculate_user_health_score(v_kpi.user_id)
        );
    END IF;

    UPDATE public.kpis SET
        weight = p_weight,
        supervisor_score_pct = v_score,
        current_value = v_score,
        target_value = 100,
        end_date = p_end_date,
        status = v_new_status,
        completion_status = v_new_completion::public.kpi_completion_status,
        completed_at = CASE
            WHEN v_new_completion = 'completed' THEN COALESCE(completed_at, timezone('utc'::text, now()))
            ELSE NULL
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_kpi.id;

    INSERT INTO public.kpi_assignment_edits (kpi_id, employee_id, editor_id, company_id, changes)
    VALUES (v_kpi.id, v_kpi.user_id, auth.uid(), v_emp.company_id, v_changes);

    v_health := public.calculate_user_health_score(v_kpi.user_id);

    UPDATE public.users SET
        previous_health_score = health_score,
        health_score = v_health,
        health_score_updated_at = timezone('utc'::text, now())
    WHERE id = v_kpi.user_id;

    RETURN jsonb_build_object(
        'updated', true,
        'overall_score', v_health,
        'changes', v_changes
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_assigned_kpi(UUID, NUMERIC, NUMERIC, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kpi_employee_score_pct(public.kpis) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_user_health_score(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
