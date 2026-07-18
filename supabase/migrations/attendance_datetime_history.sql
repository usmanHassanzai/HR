-- Attendance: save date+time on check-in/mark, department/team history, monthly reports.

-- Drop functions whose return types change (42P13 on CREATE OR REPLACE)
DROP FUNCTION IF EXISTS public.get_pending_attendance_for_manager() CASCADE;
DROP FUNCTION IF EXISTS public.get_team_attendance_history(INTEGER, INTEGER, UUID, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.get_team_attendance_history(INTEGER, INTEGER, UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_team_attendance_history(INTEGER, INTEGER, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_team_attendance_history(INTEGER, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.generate_monthly_attendance_report(INTEGER, INTEGER, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.get_monthly_attendance_reports(INTEGER) CASCADE;
DROP FUNCTION IF EXISTS public.get_monthly_attendance_reports() CASCADE;

-- ── Monthly report snapshots ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_monthly_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    department_id   UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    report_year     INTEGER NOT NULL CHECK (report_year >= 2000),
    report_month    INTEGER NOT NULL CHECK (report_month BETWEEN 1 AND 12),
    record_count    INTEGER NOT NULL DEFAULT 0,
    employee_count  INTEGER NOT NULL DEFAULT 0,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    generated_by    UUID REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_att_monthly_reports_company_month
    ON public.attendance_monthly_reports (company_id, report_year, report_month)
    WHERE department_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_att_monthly_reports_dept_month
    ON public.attendance_monthly_reports (company_id, department_id, report_year, report_month)
    WHERE department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_att_monthly_reports_lookup
    ON public.attendance_monthly_reports (company_id, report_year DESC, report_month DESC);

ALTER TABLE public.attendance_monthly_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_monthly_reports_select ON public.attendance_monthly_reports;
CREATE POLICY attendance_monthly_reports_select ON public.attendance_monthly_reports
    FOR SELECT TO authenticated
    USING (
        company_id = public.current_company_id()
        AND (
            public.is_admin(auth.uid())
            OR public.is_manager_role(auth.uid())
        )
    );

-- ── Manual check-in saves clock-in timestamp ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check in for a future date'; END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, attendance_source
    )
    VALUES (
        auth.uid(), p_date, 'present', 'pending', auth.uid(),
        timezone('utc'::text, now()), 'manual'
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        approval_status = 'pending',
        marked_by = auth.uid(),
        reviewed_by = NULL,
        reviewed_at = NULL,
        clock_in_at = COALESCE(attendance_records.clock_in_at, timezone('utc'::text, now())),
        attendance_source = COALESCE(attendance_records.attendance_source, 'manual')
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Manager/admin mark saves clock-in for present/late ───────────────────────
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
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(p_user_id);
    END IF;

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

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, attendance_source
    )
    VALUES (
        p_user_id, p_date, p_status, v_approval, p_notes, auth.uid(),
        CASE WHEN v_approval = 'approved' THEN auth.uid() END,
        CASE WHEN v_approval = 'approved' THEN v_now END,
        CASE WHEN p_status IN ('present', 'late', 'half_day') THEN v_now END,
        CASE WHEN p_status IN ('present', 'late', 'half_day') THEN 'manual' END
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = EXCLUDED.approval_status,
        notes = EXCLUDED.notes,
        marked_by = auth.uid(),
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        clock_in_at = CASE
            WHEN EXCLUDED.status IN ('present', 'late', 'half_day')
            THEN COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at)
            ELSE public.attendance_records.clock_in_at
        END,
        attendance_source = COALESCE(public.attendance_records.attendance_source, EXCLUDED.attendance_source, 'manual')
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

-- ── Approval backfills missing clock-in ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.review_attendance(p_record_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    rec public.attendance_records%ROWTYPE;
    rec_role public.user_role;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    SELECT * INTO rec FROM public.attendance_records WHERE id = p_record_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Record not found'; END IF;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(rec.user_id);
    END IF;

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
        reviewed_at = v_now,
        notes = COALESCE(p_notes, notes),
        clock_in_at = CASE
            WHEN p_approve AND rec.status IN ('present', 'late', 'half_day')
            THEN COALESCE(rec.clock_in_at, v_now)
            ELSE rec.clock_in_at
        END,
        attendance_source = COALESCE(rec.attendance_source, 'manual')
    WHERE id = p_record_id;

    PERFORM public.create_system_notification(
        rec.user_id,
        CASE WHEN p_approve THEN 'Attendance Approved' ELSE 'Attendance Rejected' END,
        'Your attendance for ' || rec.attendance_date::TEXT || ' was ' || CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Team / department attendance history ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_team_attendance_history(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_department_id UUID DEFAULT NULL,
    p_scope TEXT DEFAULT 'self'
)
RETURNS TABLE(
    id UUID,
    user_id UUID,
    employee_name TEXT,
    employee_role TEXT,
    department_name TEXT,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_source TEXT,
    work_minutes INTEGER,
    shift_name TEXT,
    notes TEXT
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_company UUID;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT u.role, u.company_id INTO v_role, v_company FROM public.users u WHERE u.id = v_uid;
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

    IF p_month IS NULL THEN
        v_start := make_date(p_year, 1, 1);
        v_end := make_date(p_year, 12, 31);
    ELSE
        v_start := make_date(p_year, p_month, 1);
        v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    RETURN QUERY
    SELECT
        ar.id,
        ar.user_id,
        u.full_name,
        u.role::TEXT,
        d.name,
        ar.attendance_date,
        ar.status,
        ar.approval_status,
        ar.clock_in_at,
        ar.clock_out_at,
        ar.attendance_source,
        ar.work_minutes,
        ws.name,
        ar.notes
    FROM public.attendance_records ar
    JOIN public.users u ON u.id = ar.user_id
    LEFT JOIN public.departments d ON d.id = u.department_id
    LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
    WHERE u.company_id = v_company
      AND ar.attendance_date BETWEEN v_start AND v_end
      AND (
          -- Single employee (self or authorized target)
          (p_scope = 'self' AND ar.user_id = COALESCE(p_user_id, v_uid))
          OR (
              p_scope = 'team'
              AND v_role = 'manager'::public.user_role
              AND (
                  ar.user_id = v_uid
                  OR u.manager_id = v_uid
              )
          )
          OR (
              p_scope = 'department'
              AND p_department_id IS NOT NULL
              AND u.department_id = p_department_id
              AND (
                  public.is_admin(v_uid)
                  OR (
                      v_role = 'manager'::public.user_role
                      AND u.department_id = public.user_department_id(v_uid)
                  )
              )
          )
          OR (
              p_scope = 'company'
              AND public.is_admin(v_uid)
              AND (p_department_id IS NULL OR u.department_id = p_department_id)
          )
      )
      AND (
          ar.user_id = v_uid
          OR public.is_admin(v_uid)
          OR (v_role = 'manager'::public.user_role AND (u.manager_id = v_uid OR u.id = v_uid))
          OR (v_role = 'manager'::public.user_role AND p_scope = 'department' AND u.department_id = public.user_department_id(v_uid))
      )
    ORDER BY ar.attendance_date DESC, u.full_name, ar.clock_in_at DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ── Generate / refresh monthly attendance report snapshot ────────────────────
CREATE OR REPLACE FUNCTION public.generate_monthly_attendance_report(
    p_year INTEGER,
    p_month INTEGER,
    p_department_id UUID DEFAULT NULL
)
RETURNS TABLE(
    report_id UUID,
    report_year INTEGER,
    report_month INTEGER,
    department_name TEXT,
    record_count INTEGER,
    employee_count INTEGER,
    generated_at TIMESTAMPTZ
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
    v_scope TEXT;
    v_dept_name TEXT;
    v_records INTEGER;
    v_employees INTEGER;
    v_report_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NOT public.is_admin(v_uid) AND NOT public.is_manager_role(v_uid) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT company_id INTO v_company FROM public.users WHERE id = v_uid;
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

    IF p_department_id IS NOT NULL THEN
        SELECT name INTO v_dept_name FROM public.departments
        WHERE id = p_department_id AND company_id = v_company;
        IF v_dept_name IS NULL THEN RAISE EXCEPTION 'Department not found'; END IF;
        IF public.is_manager_role(v_uid) AND NOT public.is_admin(v_uid)
           AND p_department_id <> public.user_department_id(v_uid) THEN
            RAISE EXCEPTION 'Not authorized for this department';
        END IF;
    END IF;

    v_scope := CASE
        WHEN public.is_admin(v_uid) AND p_department_id IS NULL THEN 'company'
        WHEN public.is_admin(v_uid) AND p_department_id IS NOT NULL THEN 'company'
        WHEN public.is_manager_role(v_uid) AND p_department_id IS NOT NULL THEN 'department'
        ELSE 'team'
    END;

    SELECT COUNT(*)::INTEGER, COUNT(DISTINCT h.user_id)::INTEGER
    INTO v_records, v_employees
    FROM public.get_team_attendance_history(p_year, p_month, NULL, p_department_id, v_scope) h;

    IF p_department_id IS NULL THEN
        DELETE FROM public.attendance_monthly_reports
        WHERE company_id = v_company AND report_year = p_year AND report_month = p_month AND department_id IS NULL;

        INSERT INTO public.attendance_monthly_reports (
            company_id, department_id, report_year, report_month,
            record_count, employee_count, generated_at, generated_by
        )
        VALUES (v_company, NULL, p_year, p_month, v_records, v_employees, v_now, v_uid)
        RETURNING id INTO v_report_id;
    ELSE
        DELETE FROM public.attendance_monthly_reports
        WHERE company_id = v_company AND report_year = p_year AND report_month = p_month AND department_id = p_department_id;

        INSERT INTO public.attendance_monthly_reports (
            company_id, department_id, report_year, report_month,
            record_count, employee_count, generated_at, generated_by
        )
        VALUES (v_company, p_department_id, p_year, p_month, v_records, v_employees, v_now, v_uid)
        RETURNING id INTO v_report_id;
    END IF;

    RETURN QUERY
    SELECT v_report_id, p_year, p_month, v_dept_name, v_records, v_employees, v_now;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_monthly_attendance_reports(p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER)
RETURNS TABLE(
    report_id UUID,
    report_year INTEGER,
    report_month INTEGER,
    department_id UUID,
    department_name TEXT,
    record_count INTEGER,
    employee_count INTEGER,
    generated_at TIMESTAMPTZ
) AS $$
DECLARE
    v_company UUID;
BEGIN
    v_company := public.current_company_id();
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;
    IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_role(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.report_year,
        r.report_month,
        r.department_id,
        d.name,
        r.record_count,
        r.employee_count,
        r.generated_at
    FROM public.attendance_monthly_reports r
    LEFT JOIN public.departments d ON d.id = r.department_id
    WHERE r.company_id = v_company
      AND r.report_year = p_year
      AND (
          public.is_admin(auth.uid())
          OR r.department_id IS NULL
          OR r.department_id = public.user_department_id(auth.uid())
      )
    ORDER BY r.report_month DESC, d.name NULLS FIRST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.get_team_attendance_history(INTEGER, INTEGER, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_monthly_attendance_report(INTEGER, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance_reports(INTEGER) TO authenticated;

-- Include clock-in time in pending attendance for managers
CREATE OR REPLACE FUNCTION public.get_pending_attendance_for_manager()
RETURNS TABLE(
    id UUID,
    user_id UUID,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    clock_in_at TIMESTAMPTZ,
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
        ar.clock_in_at, u.full_name, u.email
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

NOTIFY pgrst, 'reload schema';
