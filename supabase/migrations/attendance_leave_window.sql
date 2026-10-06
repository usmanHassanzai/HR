-- attendance_leave_window.sql
-- R11: approved leave days allowed outside W; no clock times; write context = leave

CREATE OR REPLACE FUNCTION public.attendance_apply_leave_day(
  p_user_id UUID,
  p_date DATE,
  p_notes TEXT DEFAULT 'Approved leave'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_actor UUID := auth.uid();
BEGIN
  PERFORM public.attendance_set_write_context('leave');

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, notes, marked_by,
    reviewed_by, reviewed_at, clock_in_at, clock_out_at, work_minutes, attendance_source
  ) VALUES (
    p_user_id, p_date, 'absent', 'approved', p_notes, v_actor,
    v_actor, v_now, NULL, NULL, NULL, 'leave'
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE
  SET status = 'absent',
      approval_status = 'approved',
      notes = EXCLUDED.notes,
      clock_in_at = NULL,
      clock_out_at = NULL,
      work_minutes = NULL,
      attendance_source = 'leave',
      reviewed_by = v_actor,
      reviewed_at = v_now
  RETURNING id INTO v_id;

  PERFORM public.attendance_set_write_context('normal');
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_apply_leave_day(UUID, DATE, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_leave_request(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_notes TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
    v_label TEXT;
    v_day DATE;
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

        v_day := req.start_date;
        WHILE v_day <= req.end_date LOOP
          IF EXTRACT(ISODOW FROM v_day) < 6 THEN
            PERFORM public.attendance_apply_leave_day(
              req.user_id, v_day, 'Approved leave: ' || v_label
            );
          END IF;
          v_day := v_day + 1;
        END LOOP;
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

NOTIFY pgrst, 'reload schema';
