-- attendance_correction_rpc.sql
-- R15 / R11: Admin/HR clock-time correction (reason required) + supervisor day-status audit helper

CREATE OR REPLACE FUNCTION public.correct_attendance_times(
  p_attendance_record_id UUID,
  p_clock_in_at TIMESTAMPTZ DEFAULT NULL,
  p_clock_out_at TIMESTAMPTZ DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_clear_clock_out BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_rec public.attendance_records%ROWTYPE;
  v_target public.users%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Attendance correction requires a written reason';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_actor;
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Only Admin/HR can correct attendance times';
  END IF;

  SELECT * INTO v_rec FROM public.attendance_records WHERE id = p_attendance_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance record not found'; END IF;

  SELECT * INTO v_target FROM public.users WHERE id = v_rec.user_id;
  IF v_target.company_id IS DISTINCT FROM v_me.company_id THEN
    RAISE EXCEPTION 'Not authorized for this company';
  END IF;

  v_before := jsonb_build_object(
    'clock_in_at', v_rec.clock_in_at,
    'clock_out_at', v_rec.clock_out_at,
    'status', v_rec.status,
    'attendance_source', v_rec.attendance_source,
    'work_minutes', v_rec.work_minutes
  );

  PERFORM public.attendance_set_write_context('admin_correction');

  UPDATE public.attendance_records SET
    clock_in_at = COALESCE(p_clock_in_at, clock_in_at),
    clock_out_at = CASE
      WHEN p_clear_clock_out THEN NULL
      ELSE COALESCE(p_clock_out_at, clock_out_at)
    END,
    attendance_source = 'admin_correction',
    notes = COALESCE(notes, '') || ' | Correction: ' || btrim(p_reason),
    work_minutes = CASE
      WHEN COALESCE(p_clock_in_at, clock_in_at) IS NOT NULL
           AND CASE WHEN p_clear_clock_out THEN NULL ELSE COALESCE(p_clock_out_at, clock_out_at) END IS NOT NULL
      THEN GREATEST(
        0,
        (EXTRACT(EPOCH FROM (
          CASE WHEN p_clear_clock_out THEN NULL ELSE COALESCE(p_clock_out_at, clock_out_at) END
          - COALESCE(p_clock_in_at, clock_in_at)
        )) / 60)::INTEGER
      )
      ELSE work_minutes
    END
  WHERE id = v_rec.id
  RETURNING * INTO v_rec;

  -- Align open/closed visit segment loosely
  IF v_rec.clock_out_at IS NULL AND v_rec.clock_in_at IS NOT NULL THEN
    PERFORM public.attendance_ensure_open_visit(
      v_rec.user_id, v_rec.id, v_rec.attendance_date, v_rec.clock_in_at, 'Admin correction'
    );
  ELSIF v_rec.clock_out_at IS NOT NULL AND v_rec.clock_in_at IS NOT NULL THEN
    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_rec.clock_out_at,
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_rec.clock_out_at - clock_in_at)) / 60)::INTEGER)
    WHERE attendance_record_id = v_rec.id AND clock_out_at IS NULL;
  END IF;

  PERFORM public.attendance_set_write_context('normal');

  v_after := jsonb_build_object(
    'clock_in_at', v_rec.clock_in_at,
    'clock_out_at', v_rec.clock_out_at,
    'status', v_rec.status,
    'attendance_source', v_rec.attendance_source,
    'work_minutes', v_rec.work_minutes
  );

  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  ) VALUES (
    v_me.company_id, v_rec.id, v_rec.user_id, v_actor,
    btrim(p_reason), v_before, v_after, 'admin_correction'
  );

  RETURN jsonb_build_object('ok', true, 'record_id', v_rec.id, 'before', v_before, 'after', v_after);
END;
$$;

GRANT EXECUTE ON FUNCTION public.correct_attendance_times(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
