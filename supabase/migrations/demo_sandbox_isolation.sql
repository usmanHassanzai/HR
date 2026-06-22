-- Demo sandbox: isolate demo accounts from production users

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

UPDATE public.users SET is_demo = true
WHERE email IN ('admin@walfia.ai', 'manager@walfia.ai', 'employee@walfia.ai');

CREATE OR REPLACE FUNCTION public.is_demo_user(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = p_user_id AND u.is_demo = true
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.enforce_demo_isolation(p_target_user_id UUID DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_demo_user(auth.uid()) THEN
        RETURN;
    END IF;
    IF p_target_user_id IS NOT NULL AND NOT public.is_demo_user(p_target_user_id) THEN
        RAISE EXCEPTION 'Demo accounts cannot view or modify production user data';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.is_demo_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_demo_isolation(UUID) TO authenticated;

-- Admin user list: demo admin sees demo users only
CREATE OR REPLACE FUNCTION public.get_all_users_admin()
RETURNS SETOF public.users AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY SELECT u.* FROM public.users u WHERE u.is_demo = true ORDER BY u.created_at DESC;
    ELSE
        RETURN QUERY SELECT u.* FROM public.users u ORDER BY u.created_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Direct reports: demo manager only sees demo employees
CREATE OR REPLACE FUNCTION public.get_direct_reports(p_manager_id UUID)
RETURNS SETOF public.users AS $$
BEGIN
    IF auth.uid() IS DISTINCT FROM p_manager_id
       AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_manager_id);
    RETURN QUERY
        SELECT u.* FROM public.users u
        WHERE u.manager_id = p_manager_id
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
        ORDER BY u.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_user_admin(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can delete users';
    END IF;
    PERFORM public.enforce_demo_isolation(p_user_id);
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'You cannot delete your own account';
    END IF;
    IF public.is_demo_user(p_user_id) AND NOT public.is_demo_user(auth.uid()) THEN
        RAISE EXCEPTION 'Production admins cannot delete demo sandbox accounts from this action';
    END IF;
    DELETE FROM auth.users WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.reset_user_password_admin(p_user_id UUID, p_new_password TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Unauthorized: only admins can reset passwords';
    END IF;
    PERFORM public.enforce_demo_isolation(p_user_id);
    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters';
    END IF;
    UPDATE auth.users
    SET encrypted_password = crypt(p_new_password, gen_salt('bf'))
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;

CREATE OR REPLACE FUNCTION public.assign_kpi_manager(
    p_employee_id UUID,
    p_department TEXT,
    p_description TEXT,
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE(employee_email TEXT, employee_name TEXT, kpi_id UUID) AS $$
DECLARE
    v_kpi_id UUID;
    v_email TEXT;
    v_name TEXT;
BEGIN
    PERFORM public.enforce_demo_isolation(p_employee_id);
    IF NOT public.is_manager_of(auth.uid(), p_employee_id) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized to assign KPIs to this employee';
    END IF;
    SELECT u.email, u.full_name INTO v_email, v_name FROM public.users u WHERE u.id = p_employee_id;
    INSERT INTO public.kpis (
        user_id, name, description, department, category,
        start_date, end_date, target_value, current_value, weight, direction, status, completion_status, redo_count
    ) VALUES (
        p_employee_id, p_department, p_description, p_department, p_department,
        p_start_date, p_end_date, 100, 0, 1, 'higher_better', 'at_risk', 'pending', 0
    ) RETURNING id INTO v_kpi_id;
    PERFORM public.create_system_notification(
        p_employee_id, 'New KPI Assigned',
        'Your manager assigned a KPI in ' || p_department || '. Due by ' || p_end_date::TEXT || '.',
        'info'
    );
    employee_email := v_email;
    employee_name := COALESCE(v_name, 'Employee');
    kpi_id := v_kpi_id;
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID, p_date DATE, p_status public.attendance_status, p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_approval public.approval_status := 'pending';
BEGIN
    PERFORM public.enforce_demo_isolation(p_user_id);
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;
    IF public.is_admin(auth.uid()) THEN v_approval := 'approved';
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN v_approval := 'approved';
    ELSE RAISE EXCEPTION 'Unauthorized';
    END IF;
    INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, notes, marked_by, reviewed_by, reviewed_at)
    VALUES (p_user_id, p_date, p_status, v_approval, p_notes, auth.uid(),
            CASE WHEN v_approval = 'approved' THEN auth.uid() END,
            CASE WHEN v_approval = 'approved' THEN now() END)
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status, approval_status = EXCLUDED.approval_status, notes = EXCLUDED.notes,
        marked_by = auth.uid(), reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at
    RETURNING id INTO v_id;
    PERFORM public.create_system_notification(
        p_user_id, 'Attendance Recorded',
        'Your attendance for ' || p_date::TEXT || ' was marked as ' || p_status::TEXT || '.',
        'info'::notification_type
    );
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_attendance(p_record_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    rec public.attendance_records%ROWTYPE;
    rec_role public.user_role;
BEGIN
    SELECT * INTO rec FROM public.attendance_records WHERE id = p_record_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;
    PERFORM public.enforce_demo_isolation(rec.user_id);
    SELECT role INTO rec_role FROM public.users WHERE id = rec.user_id;
    IF rec.user_id = auth.uid() AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Cannot approve your own attendance';
    END IF;
    IF rec_role = 'manager' AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Manager attendance must be approved by admin';
    END IF;
    IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), rec.user_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    UPDATE public.attendance_records SET
        approval_status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(), reviewed_at = now(), notes = COALESCE(p_notes, notes)
    WHERE id = p_record_id;
    PERFORM public.create_system_notification(
        rec.user_id,
        CASE WHEN p_approve THEN 'Attendance Approved' ELSE 'Attendance Rejected' END,
        'Your attendance for ' || rec.attendance_date::TEXT || ' was ' || CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.review_leave_request(p_request_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    PERFORM public.enforce_demo_isolation(req.user_id);
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;
    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;
    IF req_role = 'manager' THEN
        IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Manager leave must be approved by admin'; END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;
    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count WHERE user_id = req.user_id AND year = v_year;
        ELSE
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count WHERE user_id = req.user_id AND year = v_year;
        END IF;
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || req.leave_type::TEXT
        FROM generate_series(req.start_date, req.end_date, '1 day'::interval) d
        WHERE EXTRACT(ISODOW FROM d) < 6
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent', approval_status = 'approved', notes = EXCLUDED.notes, reviewed_by = auth.uid(), reviewed_at = now();
    END IF;
    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_notes
    WHERE id = p_request_id;
    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || req.leave_type::TEXT || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.get_pending_leave_requests();

CREATE OR REPLACE FUNCTION public.get_pending_leave_requests()
RETURNS TABLE(
    id UUID, user_id UUID, leave_type public.leave_type, start_date DATE, end_date DATE,
    days_count NUMERIC, reason TEXT, status public.approval_status, created_at TIMESTAMPTZ,
    employee_name TEXT, employee_email TEXT, employee_role TEXT
) AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN
        RETURN QUERY
        SELECT lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
               lr.days_count, lr.reason, lr.status, lr.created_at,
               u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role <> 'admin'::public.user_role
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
        ORDER BY lr.created_at DESC;
    ELSIF EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'manager'::public.user_role) THEN
        RETURN QUERY
        SELECT lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
               lr.days_count, lr.reason, lr.status, lr.created_at,
               u.full_name, u.email, u.role::TEXT
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role = 'employee'::public.user_role
          AND public.is_manager_of(auth.uid(), lr.user_id)
          AND u.is_demo = true
        ORDER BY lr.created_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_pending_leave_requests() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_points_leaderboard()
RETURNS TABLE(full_name TEXT, total_points BIGINT) AS $$
BEGIN
    IF public.is_demo_user(auth.uid()) THEN
        RETURN QUERY
        SELECT u.full_name, COALESCE(sum(pl.points_earned), 0)::BIGINT AS total_points
        FROM public.users u
        LEFT JOIN public.points_ledger pl ON pl.employee_id = u.id
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND u.is_demo = true
        GROUP BY u.id, u.full_name
        ORDER BY total_points DESC;
    ELSE
        RETURN QUERY
        SELECT u.full_name, COALESCE(sum(pl.points_earned), 0)::BIGINT AS total_points
        FROM public.users u
        LEFT JOIN public.points_ledger pl ON pl.employee_id = u.id
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
        GROUP BY u.id, u.full_name
        ORDER BY total_points DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.calculate_monthly_points(p_month DATE DEFAULT date_trunc('month', now())::DATE)
RETURNS TABLE(employee TEXT, score NUMERIC, points INTEGER) AS $$
DECLARE
    rec RECORD;
    v_score NUMERIC;
    v_points INTEGER;
    v_on  NUMERIC := 100;
    v_risk NUMERIC := 50;
    v_off  NUMERIC := 0;
BEGIN
    IF public.is_demo_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Demo accounts cannot run the monthly points job';
    END IF;

    FOR rec IN
        SELECT u.id, u.email, u.full_name
        FROM public.users u
        WHERE u.role IN ('employee'::public.user_role, 'manager'::public.user_role)
          AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
    LOOP
        SELECT CASE WHEN sum(k.weight) = 0 THEN 100
                    ELSE sum(CASE k.status WHEN 'on_track' THEN v_on * k.weight WHEN 'at_risk' THEN v_risk * k.weight ELSE v_off * k.weight END) / sum(k.weight)
               END INTO v_score FROM public.kpis k WHERE k.user_id = rec.id;
        v_score  := COALESCE(v_score, 0);
        v_points := public.monthly_points_for_score(v_score);
        INSERT INTO public.points_ledger (employee_id, month, kpi_score, points_earned)
        VALUES (rec.id, p_month, v_score, v_points)
        ON CONFLICT (employee_id, month) DO NOTHING;
        IF v_points > 0 THEN
            PERFORM public.create_system_notification(rec.id, 'Monthly Points Awarded',
                'You earned ' || v_points || ' points this month (score: ' || round(v_score) || '%).', 'info');
        END IF;
        employee := COALESCE(rec.full_name, rec.email);
        score := v_score;
        points := v_points;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_pending_attendance_for_manager()
RETURNS TABLE(
    id UUID, user_id UUID, attendance_date DATE, status public.attendance_status,
    approval_status public.approval_status, employee_name TEXT, employee_email TEXT
) AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('manager'::public.user_role, 'admin'::public.user_role)
    ) THEN RETURN; END IF;

    RETURN QUERY
    SELECT ar.id, ar.user_id, ar.attendance_date, ar.status, ar.approval_status, u.full_name, u.email
    FROM public.attendance_records ar
    JOIN public.users u ON u.id = ar.user_id
    WHERE ar.approval_status = 'pending'::public.approval_status
      AND ar.user_id <> auth.uid()
      AND (public.is_admin(auth.uid()) OR u.manager_id = auth.uid())
      AND (NOT public.is_demo_user(auth.uid()) OR u.is_demo = true)
    ORDER BY ar.attendance_date DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_leave_balance(p_user_id UUID DEFAULT auth.uid())
RETURNS TABLE(
    year INTEGER, annual_allowance INTEGER, annual_used NUMERIC, annual_remaining NUMERIC,
    sick_allowance INTEGER, sick_used NUMERIC, sick_remaining NUMERIC
) AS $$
DECLARE v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.enforce_demo_isolation(p_user_id);
    PERFORM public.ensure_leave_balance(p_user_id, v_year);
    RETURN QUERY
    SELECT lb.year, lb.annual_allowance, lb.annual_used,
           GREATEST(lb.annual_allowance - lb.annual_used, 0)::NUMERIC,
           lb.sick_allowance, lb.sick_used,
           GREATEST(lb.sick_allowance - lb.sick_used, 0)::NUMERIC
    FROM public.leave_balances lb
    WHERE lb.user_id = p_user_id AND lb.year = v_year;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
