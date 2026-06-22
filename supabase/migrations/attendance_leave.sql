-- Attendance & Leave module for Scorr
-- Run via: node scripts/attendance-leave-migration.mjs

DO $$ BEGIN
  CREATE TYPE public.attendance_status AS ENUM ('present', 'absent', 'late', 'half_day');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.leave_type AS ENUM ('annual', 'sick');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.leave_balances (
    user_id          UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    year             INTEGER NOT NULL,
    annual_allowance INTEGER NOT NULL DEFAULT 20,
    sick_allowance   INTEGER NOT NULL DEFAULT 10,
    annual_used      NUMERIC(5,1) NOT NULL DEFAULT 0,
    sick_used        NUMERIC(5,1) NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, year)
);

CREATE TABLE IF NOT EXISTS public.attendance_records (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    attendance_date  DATE NOT NULL,
    status           public.attendance_status NOT NULL DEFAULT 'present',
    approval_status  public.approval_status NOT NULL DEFAULT 'pending',
    notes            TEXT,
    marked_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (user_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS public.leave_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    leave_type    public.leave_type NOT NULL,
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    days_count    NUMERIC(5,1) NOT NULL,
    reason        TEXT,
    status        public.approval_status NOT NULL DEFAULT 'pending',
    reviewed_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    review_notes  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON public.attendance_records(user_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON public.leave_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON public.leave_requests(status);

-- Weekday count (Mon–Fri) inclusive
CREATE OR REPLACE FUNCTION public.count_weekdays(p_start DATE, p_end DATE)
RETURNS NUMERIC AS $$
DECLARE
    d DATE := p_start;
    n NUMERIC := 0;
BEGIN
    IF p_end < p_start THEN RETURN 0; END IF;
    WHILE d <= p_end LOOP
        IF EXTRACT(ISODOW FROM d) < 6 THEN n := n + 1; END IF;
        d := d + 1;
    END LOOP;
    RETURN n;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ensure_leave_balance(p_user_id UUID, p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER)
RETURNS VOID AS $$
DECLARE
    v_role public.user_role;
    v_annual INTEGER := 20;
    v_sick INTEGER := 10;
BEGIN
    SELECT role INTO v_role FROM public.users WHERE id = p_user_id;
    IF v_role IN ('manager'::public.user_role, 'admin'::public.user_role) THEN
        v_annual := 25;
        v_sick := 12;
    END IF;
    INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
    VALUES (p_user_id, p_year, v_annual, v_sick)
    ON CONFLICT (user_id, year) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_leave_balance(p_user_id UUID DEFAULT auth.uid())
RETURNS TABLE(
    year INTEGER,
    annual_allowance INTEGER,
    annual_used NUMERIC,
    annual_remaining NUMERIC,
    sick_allowance INTEGER,
    sick_used NUMERIC,
    sick_remaining NUMERIC
) AS $$
DECLARE
    v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid()
       AND NOT public.is_admin(auth.uid())
       AND NOT public.is_manager_of(auth.uid(), p_user_id) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    PERFORM public.ensure_leave_balance(p_user_id, v_year);
    RETURN QUERY
    SELECT
        lb.year,
        lb.annual_allowance,
        lb.annual_used,
        GREATEST(lb.annual_allowance - lb.annual_used, 0)::NUMERIC AS annual_remaining,
        lb.sick_allowance,
        lb.sick_used,
        GREATEST(lb.sick_allowance - lb.sick_used, 0)::NUMERIC AS sick_remaining
    FROM public.leave_balances lb
    WHERE lb.user_id = p_user_id AND lb.year = v_year;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_my_attendance_summary(p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER)
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
      AND EXTRACT(YEAR FROM ar.attendance_date) = p_year;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check in for a future date'; END IF;
    INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by)
    VALUES (auth.uid(), p_date, 'present', 'pending', auth.uid())
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present', approval_status = 'pending', marked_by = auth.uid(), reviewed_by = NULL, reviewed_at = NULL
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_approval public.approval_status := 'pending';
    v_role public.user_role;
BEGIN
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    IF public.is_admin(auth.uid()) THEN
        v_approval := 'approved';
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_approval := 'approved';
    ELSE
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, notes, marked_by, reviewed_by, reviewed_at)
    VALUES (p_user_id, p_date, p_status, v_approval, p_notes, auth.uid(),
            CASE WHEN v_approval = 'approved' THEN auth.uid() END,
            CASE WHEN v_approval = 'approved' THEN now() END)
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = EXCLUDED.approval_status,
        notes = EXCLUDED.notes,
        marked_by = auth.uid(),
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at
    RETURNING id INTO v_id;

    PERFORM public.create_system_notification(
        p_user_id,
        'Attendance Recorded',
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
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_record_id;

    PERFORM public.create_system_notification(
        rec.user_id,
        CASE WHEN p_approve THEN 'Attendance Approved' ELSE 'Attendance Rejected' END,
        'Your attendance for ' || rec.attendance_date::TEXT || ' was ' || CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_leave_type public.leave_type,
    p_start DATE,
    p_end DATE,
    p_reason TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_days NUMERIC;
    v_id UUID;
    v_year INTEGER := EXTRACT(YEAR FROM p_start)::INTEGER;
    v_bal public.leave_balances%ROWTYPE;
    v_mgr UUID;
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

    INSERT INTO public.leave_requests (user_id, leave_type, start_date, end_date, days_count, reason)
    VALUES (auth.uid(), p_leave_type, p_start, p_end, v_days, p_reason)
    RETURNING id INTO v_id;

    SELECT manager_id INTO v_mgr FROM public.users WHERE id = auth.uid();
    IF v_mgr IS NOT NULL THEN
        PERFORM public.create_system_notification(
            v_mgr,
            'Leave Request',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' requested ' || p_leave_type::TEXT || ' leave (' || v_days || ' days).',
            'info'::notification_type
        );
    END IF;
    -- Notify admins for manager leave requests
    IF EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'manager') THEN
        PERFORM public.create_system_notification(
            u.id,
            'Manager Leave Request',
            (SELECT full_name FROM public.users WHERE id = auth.uid()) || ' requested ' || p_leave_type::TEXT || ' leave.',
            'info'::notification_type
        )
        FROM public.users u WHERE u.role = 'admin';
    END IF;
    RETURN v_id;
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
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSE
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;
        -- Mark attendance as on leave for weekdays in range
        INSERT INTO public.attendance_records (user_id, attendance_date, status, approval_status, marked_by, reviewed_by, reviewed_at, notes)
        SELECT req.user_id, d::DATE, 'absent', 'approved', auth.uid(), auth.uid(), now(), 'Approved leave: ' || req.leave_type::TEXT
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
        'Your ' || req.leave_type::TEXT || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- RLS
ALTER TABLE public.leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leave_balances_select ON public.leave_balances;
CREATE POLICY leave_balances_select ON public.leave_balances FOR SELECT
USING (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id));

DROP POLICY IF EXISTS attendance_select ON public.attendance_records;
CREATE POLICY attendance_select ON public.attendance_records FOR SELECT
USING (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_manager_of(auth.uid(), user_id));

DROP POLICY IF EXISTS leave_requests_select ON public.leave_requests;
CREATE POLICY leave_requests_select ON public.leave_requests FOR SELECT
USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR public.is_manager_of(auth.uid(), user_id)
);

GRANT EXECUTE ON FUNCTION public.get_leave_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_summary(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_attendance(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(public.leave_type, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_leave_request(UUID, BOOLEAN, TEXT) TO authenticated;

-- Seed leave balances for existing users
INSERT INTO public.leave_balances (user_id, year, annual_allowance, sick_allowance)
SELECT u.id, EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
       CASE WHEN u.role IN ('manager', 'admin') THEN 25 ELSE 20 END,
       CASE WHEN u.role IN ('manager', 'admin') THEN 12 ELSE 10 END
FROM public.users u
WHERE u.role IN ('employee', 'manager', 'admin')
ON CONFLICT DO NOTHING;

-- Attendance KPI template for each active employee/manager (optional tracking KPI)
INSERT INTO public.kpis (user_id, name, description, target_value, current_value, direction, status, weight, category, department, completion_status)
SELECT u.id, 'Daily Attendance', 'Maintain approved daily attendance throughout the year', 100, 100, 'higher_better', 'on_track', 1.0, 'Attendance', 'HR', 'pending'
FROM public.users u
WHERE u.role IN ('employee', 'manager')
  AND NOT EXISTS (SELECT 1 FROM public.kpis k WHERE k.user_id = u.id AND k.category = 'Attendance');
