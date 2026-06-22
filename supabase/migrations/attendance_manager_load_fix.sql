-- Fix manager attendance load: remove ambiguous RPC overloads, add pending attendance RPC

DROP FUNCTION IF EXISTS public.get_my_attendance_summary(INTEGER);

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

CREATE OR REPLACE FUNCTION public.get_pending_attendance_for_manager()
RETURNS TABLE(
    id UUID,
    user_id UUID,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    employee_name TEXT,
    employee_email TEXT
) AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND role IN ('manager'::public.user_role, 'admin'::public.user_role)
    ) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        ar.id, ar.user_id, ar.attendance_date, ar.status, ar.approval_status,
        u.full_name, u.email
    FROM public.attendance_records ar
    JOIN public.users u ON u.id = ar.user_id
    WHERE ar.approval_status = 'pending'::public.approval_status
      AND ar.user_id <> auth.uid()
      AND (
        public.is_admin(auth.uid())
        OR u.manager_id = auth.uid()
      )
    ORDER BY ar.attendance_date DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_pending_attendance_for_manager() TO authenticated;
