-- Fix pending leave visibility for managers and admins

CREATE OR REPLACE FUNCTION public.get_pending_leave_requests()
RETURNS TABLE(
    id UUID,
    user_id UUID,
    leave_type public.leave_type,
    start_date DATE,
    end_date DATE,
    days_count NUMERIC,
    reason TEXT,
    status public.approval_status,
    created_at TIMESTAMPTZ,
    employee_name TEXT,
    employee_email TEXT,
    employee_role public.user_role
) AS $$
BEGIN
    IF public.is_admin(auth.uid()) THEN
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.role <> 'admin'::public.user_role
        ORDER BY lr.created_at DESC;

    ELSIF EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND role = 'manager'::public.user_role
    ) THEN
        RETURN QUERY
        SELECT
            lr.id, lr.user_id, lr.leave_type, lr.start_date, lr.end_date,
            lr.days_count, lr.reason, lr.status, lr.created_at,
            u.full_name, u.email, u.role
        FROM public.leave_requests lr
        JOIN public.users u ON u.id = lr.user_id
        WHERE lr.status = 'pending'::public.approval_status
          AND u.manager_id = auth.uid()
        ORDER BY lr.created_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_pending_leave_requests() TO authenticated;
