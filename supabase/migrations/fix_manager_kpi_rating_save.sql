-- Rating save called sync_user_kpi_task_points → calculate_user_health_score,
-- which passed a RECORD into kpi_employee_score_pct(kpis) and aborted the update.

CREATE OR REPLACE FUNCTION public.calculate_user_health_score(p_user_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_num NUMERIC := 0;
    v_den NUMERIC := 0;
    kpi_row public.kpis%ROWTYPE;
    emp_score NUMERIC;
    month_start DATE := (timezone('Asia/Karachi', now()))::DATE;
BEGIN
    month_start := date_trunc('month', month_start)::DATE;
    FOR kpi_row IN
        SELECT *
        FROM public.kpis
        WHERE user_id = p_user_id
          AND COALESCE(start_date, created_at::DATE) <= (month_start + INTERVAL '1 month - 1 day')::DATE
          AND COALESCE(end_date, start_date, created_at::DATE) >= month_start
    LOOP
        emp_score := public.kpi_employee_score_pct(kpi_row);
        IF emp_score IS NULL THEN CONTINUE; END IF;
        v_num := v_num + emp_score * COALESCE(kpi_row.weight, 0);
        v_den := v_den + COALESCE(kpi_row.weight, 0);
    END LOOP;
    IF v_den <= 0 THEN RETURN 0; END IF;
    RETURN ROUND(v_num / v_den, 2);
END;
$$;

CREATE OR REPLACE FUNCTION public.can_rate_assigned_kpi(p_target_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_me public.users%ROWTYPE;
    v_them public.users%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_target_id IS NULL THEN
        RETURN false;
    END IF;
    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_them FROM public.users WHERE id = p_target_id;
    IF v_me.id IS NULL OR v_them.id IS NULL THEN
        RETURN false;
    END IF;
    IF COALESCE(v_me.is_demo, false) IS DISTINCT FROM COALESCE(v_them.is_demo, false) THEN
        RETURN false;
    END IF;
    IF NOT COALESCE(v_me.is_demo, false)
       AND v_me.company_id IS DISTINCT FROM v_them.company_id THEN
        RETURN false;
    END IF;
    IF public.is_platform_owner(auth.uid()) THEN
        RETURN true;
    END IF;
    IF public.is_admin(auth.uid()) THEN
        RETURN v_them.role IN (
            'employee'::public.user_role,
            'manager'::public.user_role,
            'hr'::public.user_role
        );
    END IF;
    IF v_me.role = 'manager'::public.user_role THEN
        IF public.is_manager_of(v_me.id, v_them.id) THEN
            RETURN true;
        END IF;
        IF v_them.role IN ('employee'::public.user_role, 'manager'::public.user_role)
           AND v_me.department_id IS NOT NULL
           AND v_them.department_id IS NOT DISTINCT FROM v_me.department_id THEN
            RETURN true;
        END IF;
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_manager_kpi_rating(p_kpi_id UUID, p_rating TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kpi public.kpis%ROWTYPE;
    v_cat TEXT;
    v_score NUMERIC;
    v_rating TEXT := lower(trim(COALESCE(p_rating, '')));
BEGIN
    SELECT * INTO v_kpi FROM public.kpis WHERE id = p_kpi_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'KPI not found'; END IF;
    IF NOT public.can_rate_assigned_kpi(v_kpi.user_id) THEN
        RAISE EXCEPTION 'Not authorized to rate this KPI';
    END IF;
    IF auth.uid() = v_kpi.user_id AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'You cannot rate your own assigned KPI here';
    END IF;

    v_cat := COALESCE(v_kpi.kpi_category, 'monthly_goal');
    v_score := public.kpi_rating_score(v_cat, v_rating);
    IF v_score IS NULL THEN
        RAISE EXCEPTION 'That option is not valid for this KPI category';
    END IF;

    UPDATE public.kpis SET
        manager_rating = v_rating,
        supervisor_score_pct = v_score,
        current_value = v_score,
        status = CASE
            WHEN v_score >= 80 THEN 'on_track'::kpi_status_type
            WHEN v_score >= 40 THEN 'at_risk'::kpi_status_type
            ELSE 'off_track'::kpi_status_type
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_kpi_id;

    BEGIN
        PERFORM public.sync_user_kpi_task_points(v_kpi.user_id);
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN v_score;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calculate_user_health_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_rate_assigned_kpi(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_manager_kpi_rating(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
