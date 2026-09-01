-- Remote employees: manager/admin mark present or absent; saved to attendance history.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS work_mode TEXT NOT NULL DEFAULT 'office';

ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS users_work_mode_check;

ALTER TABLE public.users
    ADD CONSTRAINT users_work_mode_check
    CHECK (work_mode IN ('office', 'remote'));

CREATE OR REPLACE FUNCTION public.set_user_work_mode(p_user_id UUID, p_work_mode TEXT)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_target public.users%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_work_mode IS NULL OR p_work_mode NOT IN ('office', 'remote') THEN
        RAISE EXCEPTION 'Work mode must be office or remote';
    END IF;

    SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

    IF public.is_admin(v_uid) THEN
        IF public.current_company_id() IS NOT NULL
           AND v_target.company_id IS DISTINCT FROM public.current_company_id() THEN
            RAISE EXCEPTION 'User is not in your company';
        END IF;
    ELSIF public.is_manager_of(v_uid, p_user_id) THEN
        NULL;
    ELSE
        RAISE EXCEPTION 'Only the employee''s manager or admin can set work mode';
    END IF;

    UPDATE public.users SET work_mode = p_work_mode WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.set_user_work_mode(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_allowed BOOLEAN := false;
    v_notes TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(p_user_id);
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    IF p_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Cannot mark attendance for a future date';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

    IF public.is_admin(auth.uid()) THEN
        v_allowed := true;
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_allowed := true;
    ELSIF v_me.role = 'manager'::public.user_role
          AND v_emp.role = 'employee'::public.user_role
          AND v_me.department_id IS NOT NULL
          AND v_emp.department_id = v_me.department_id
          AND (v_me.company_id IS NULL OR v_emp.company_id IS NOT DISTINCT FROM v_me.company_id) THEN
        v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    v_notes := COALESCE(NULLIF(trim(p_notes), ''),
        CASE WHEN v_emp.work_mode = 'remote' THEN 'Remote work — marked by manager' ELSE 'Marked by manager' END
    );

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source
    )
    VALUES (
        p_user_id,
        p_date,
        p_status,
        'approved'::public.approval_status,
        v_notes,
        auth.uid(),
        auth.uid(),
        v_now,
        CASE WHEN p_status IN ('present', 'late', 'half_day') THEN v_now END,
        NULL,
        'manual'
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status,
        approval_status = 'approved'::public.approval_status,
        notes = EXCLUDED.notes,
        marked_by = auth.uid(),
        reviewed_by = auth.uid(),
        reviewed_at = v_now,
        clock_in_at = CASE
            WHEN EXCLUDED.status = 'absent' THEN NULL
            WHEN EXCLUDED.status IN ('present', 'late', 'half_day')
                THEN COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at)
            ELSE public.attendance_records.clock_in_at
        END,
        clock_out_at = CASE
            WHEN EXCLUDED.status = 'absent' THEN NULL
            ELSE public.attendance_records.clock_out_at
        END,
        attendance_source = 'manual'
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

GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
