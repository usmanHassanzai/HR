-- Auto-approve all employee/manager check-ins. No attendance approval workflow.
-- Leave requests still require manager/admin approval.

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT CURRENT_DATE)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Cannot check in for a future date'; END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, attendance_source, reviewed_by, reviewed_at
    )
    VALUES (
        auth.uid(), p_date, 'present', 'approved'::public.approval_status, auth.uid(),
        v_now, 'manual', auth.uid(), v_now
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        approval_status = 'approved'::public.approval_status,
        marked_by = auth.uid(),
        reviewed_by = COALESCE(public.attendance_records.reviewed_by, auth.uid()),
        reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual')
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;

-- Existing pending check-ins become approved (leave requests untouched)
UPDATE public.attendance_records
SET
    approval_status = 'approved'::public.approval_status,
    reviewed_by = COALESCE(reviewed_by, user_id),
    reviewed_at = COALESCE(reviewed_at, timezone('utc'::text, now()))
WHERE approval_status = 'pending'::public.approval_status;

ALTER TABLE public.attendance_records
  ALTER COLUMN approval_status SET DEFAULT 'approved'::public.approval_status;
