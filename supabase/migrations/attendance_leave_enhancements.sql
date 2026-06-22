-- Attendance & leave enhancements: email payload RPC, monthly summaries

DROP FUNCTION IF EXISTS public.submit_leave_request(public.leave_type, DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
    v_mgr_email TEXT;
    v_mgr_name TEXT;
    v_emp_name TEXT;
    v_role public.user_role;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    SELECT full_name, role, manager_id INTO v_emp_name, v_role, v_mgr FROM public.users WHERE id = auth.uid();

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason)
    RETURNING id INTO v_id;

    IF v_mgr IS NOT NULL THEN
        SELECT email, full_name INTO v_mgr_email, v_mgr_name FROM public.users WHERE id = v_mgr;
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            v_emp_name || ' requested ' || p_leave_type::TEXT || ' leave (' || v_days || ' days).',
            'info'::notification_type
        );
    END IF;

    IF v_role = 'manager' THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            v_emp_name || ' requested ' || p_leave_type::TEXT || ' leave.',
            'info'::notification_type
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;

    RETURN jsonb_build_object(
        'request_id', v_id,
        'employee_name', v_emp_name,
        'leave_type', p_leave_type,
        'start_date', p_start,
        'end_date', p_end,
        'days_count', v_days,
        'reason', p_reason,
        'requester_role', v_role,
        'manager_email', v_mgr_email,
        'manager_name', v_mgr_name,
        'admin_recipients', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('email', email, 'name', full_name)), '[]'::jsonb)
            FROM public.users WHERE role = 'admin'
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_attendance_summary(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL
)
RETURNS TABLE(
    total_records BIGINT,
    present_approved BIGINT,
    absent BIGINT,
    late BIGINT,
    pending BIGINT,
    attendance_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'half_day', 'late'))::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'absent' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.status = 'late' AND ar.approval_status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE ar.approval_status = 'pending')::BIGINT,
        CASE WHEN COUNT(*) FILTER (WHERE ar.approval_status = 'approved') = 0 THEN 100
             ELSE ROUND(
               100.0 * COUNT(*) FILTER (WHERE ar.approval_status = 'approved' AND ar.status IN ('present', 'late', 'half_day'))
               / NULLIF(COUNT(*) FILTER (WHERE ar.approval_status = 'approved'), 0), 1)
        END
    FROM public.attendance_records ar
    WHERE ar.user_id = auth.uid()
      AND EXTRACT(YEAR FROM ar.attendance_date) = p_year
      AND (p_month IS NULL OR EXTRACT(MONTH FROM ar.attendance_date) = p_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_summary(INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_leave_summary(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL
)
RETURNS TABLE(
    annual_days_taken NUMERIC,
    sick_days_taken NUMERIC,
    approved_requests BIGINT,
    pending_requests BIGINT,
    total_days_taken NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.leave_type = 'annual' AND lr.status = 'approved'), 0)::NUMERIC,
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.leave_type = 'sick' AND lr.status = 'approved'), 0)::NUMERIC,
        COUNT(*) FILTER (WHERE lr.status = 'approved')::BIGINT,
        COUNT(*) FILTER (WHERE lr.status = 'pending')::BIGINT,
        COALESCE(SUM(lr.days_count) FILTER (WHERE lr.status = 'approved'), 0)::NUMERIC
    FROM public.leave_requests lr
    WHERE lr.user_id = auth.uid()
      AND EXTRACT(YEAR FROM lr.start_date) = p_year
      AND (p_month IS NULL OR EXTRACT(MONTH FROM lr.start_date) = p_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_my_leave_summary(INTEGER, INTEGER) TO authenticated;
