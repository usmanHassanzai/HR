-- Custom leave type (employee/manager write-in) plus RPCs

ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS leave_custom_type TEXT;

COMMENT ON COLUMN public.leave_requests.leave_custom_type IS 'Required when leave_type is other: the written leave name.';

DROP FUNCTION IF EXISTS public.submit_leave_request(public.leave_type, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.submit_leave_request(public.leave_type, DATE, DATE, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL,
    p_custom_type TEXT DEFAULT NULL
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
    v_custom TEXT := NULLIF(btrim(COALESCE(p_custom_type, '')), '');
    v_label TEXT;
BEGIN
    IF p_end < p_start THEN RAISE EXCEPTION 'End date must be on or after start date'; END IF;
    v_days := public.count_weekdays(p_start, p_end);
    IF v_days <= 0 THEN RAISE EXCEPTION 'Leave must include at least one weekday'; END IF;

    IF p_leave_type = 'other' THEN
        IF v_custom IS NULL THEN
            RAISE EXCEPTION 'Please write the type of leave';
        END IF;
        IF char_length(v_custom) > 80 THEN
            RAISE EXCEPTION 'Leave type must be 80 characters or fewer';
        END IF;
    ELSE
        v_custom := NULL;
    END IF;

    PERFORM public.ensure_leave_balance(auth.uid(), v_year);
    SELECT * INTO v_bal FROM public.leave_balances WHERE user_id = auth.uid() AND year = v_year FOR UPDATE;

    IF p_leave_type = 'annual' AND (v_bal.annual_allowance - v_bal.annual_used) < v_days THEN
        RAISE EXCEPTION 'Not enough annual leave (need %, have % remaining)', v_days, (v_bal.annual_allowance - v_bal.annual_used);
    END IF;
    IF p_leave_type = 'sick' AND (v_bal.sick_allowance - v_bal.sick_used) < v_days THEN
        RAISE EXCEPTION 'Not enough sick leave (need %, have % remaining)', v_days, (v_bal.sick_allowance - v_bal.sick_used);
    END IF;

    SELECT full_name, role, manager_id INTO v_emp_name, v_role, v_mgr FROM public.users WHERE id = auth.uid();

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason, leave_custom_type)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason, v_custom)
    RETURNING id INTO v_id;

    v_label := CASE
        WHEN p_leave_type = 'other' THEN v_custom
        ELSE p_leave_type::TEXT
    END;

    IF v_mgr IS NOT NULL THEN
        SELECT email, full_name INTO v_mgr_email, v_mgr_name FROM public.users WHERE id = v_mgr;
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            v_emp_name || ' requested ' || v_label || ' leave (' || v_days || ' days).',
            'info'::notification_type
        );
    END IF;

    IF v_role = 'manager' THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            v_emp_name || ' requested ' || v_label || ' leave.',
            'info'::notification_type
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;

    RETURN jsonb_build_object(
        'request_id', v_id,
        'employee_name', v_emp_name,
        'leave_type', p_leave_type,
        'leave_custom_type', v_custom,
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

GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
    v_label TEXT;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    IF to_regprocedure('public.enforce_demo_isolation(uuid)') IS NOT NULL THEN
        PERFORM public.enforce_demo_isolation(req.user_id);
    END IF;
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;

    IF req_role = 'manager' THEN
        IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Manager leave must be approved by admin'; END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;

    v_label := CASE
        WHEN req.leave_type = 'other' THEN COALESCE(NULLIF(btrim(req.leave_custom_type), ''), 'other')
        ELSE req.leave_type::TEXT
    END;

    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSIF req.leave_type = 'sick' THEN
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || v_label
        FROM generate_series(req.start_date, req.end_date, '1 day'::interval) d
        WHERE EXTRACT(ISODOW FROM d) < 6
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent', approval_status = 'approved', notes = EXCLUDED.notes, reviewed_by = auth.uid(), reviewed_at = now();
    END IF;

    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = p_notes
    WHERE id = p_request_id;

    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || v_label || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.review_leave_request(UUID, BOOLEAN, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.get_pending_leave_requests();

CREATE OR REPLACE FUNCTION public.get_pending_leave_requests()
RETURNS TABLE(
    id UUID,
    user_id UUID,
    leave_type public.leave_type,
    leave_custom_type TEXT,
    start_date DATE,
    end_date DATE,
    days_count NUMERIC,
    reason TEXT,
    status public.approval_status,
    created_at TIMESTAMPTZ,
    employee_name TEXT,
    employee_email TEXT,
    employee_role TEXT
) AS $$
DECLARE
    v_company UUID := public.current_company_id();
BEGIN
    IF public.is_admin(auth.uid()) THEN
        IF v_company IS NULL AND NOT public.is_demo_user(auth.uid()) THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.leave_custom_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role <> 'admin'::public.user_role
          AND (
              (public.is_demo_user(auth.uid()) AND u.is_demo = true)
              OR (
                  NOT public.is_demo_user(auth.uid())
                  AND u.company_id = v_company
                  AND u.is_demo = false
              )
          )
        ORDER BY lr.created_at DESC;

    ELSIF EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND role = 'manager'::public.user_role
    ) THEN
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.leave_custom_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role = 'employee'::public.user_role
          AND public.is_manager_of(auth.uid(), lr.user_id)
        ORDER BY lr.created_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_pending_leave_requests() TO authenticated;
