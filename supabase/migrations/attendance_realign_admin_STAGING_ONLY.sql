-- STAGING ONLY — draft for review. Do NOT apply on production until explicit "apply".
-- attendance_realign_shift_records_admin(p_user_id)
-- Restores the historical realign body, gated to admin_correction write context.
-- Never called from check_in / check_out / geo / auto paths.
-- Each successful run writes attendance_corrections_audit.

CREATE OR REPLACE FUNCTION public.attendance_realign_shift_records_admin(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
  v_grp RECORD;
  v_rec_id UUID;
  v_total INTEGER;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_before JSONB;
  v_dates_touched INT := 0;
  v_visits_touched INT := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_actor;
  IF NOT FOUND OR (
    v_me.role NOT IN ('admin', 'hr')
    AND NOT COALESCE(v_me.is_platform_owner, false)
  ) THEN
    RAISE EXCEPTION 'Only Admin/HR (or platform owner) can run attendance realign';
  END IF;

  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;
  IF NOT COALESCE(v_me.is_platform_owner, false)
     AND v_target.company_id IS DISTINCT FROM v_me.company_id THEN
    RAISE EXCEPTION 'Not authorized for this company';
  END IF;

  -- Snapshot visit dates before rewrite
  SELECT jsonb_agg(jsonb_build_object(
    'visit_id', vs.id,
    'attendance_date', vs.attendance_date,
    'clock_in_at', vs.clock_in_at,
    'clock_out_at', vs.clock_out_at
  ) ORDER BY vs.clock_in_at) INTO v_before
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = p_user_id;

  PERFORM public.attendance_set_write_context('admin_correction');

  UPDATE public.attendance_visit_segments vs
  SET attendance_date = public.resolve_shift_attendance_date(vs.user_id, vs.clock_in_at)
  WHERE vs.user_id = p_user_id
    AND vs.clock_in_at IS NOT NULL
    AND vs.attendance_date IS DISTINCT FROM public.resolve_shift_attendance_date(vs.user_id, vs.clock_in_at);
  GET DIAGNOSTICS v_visits_touched = ROW_COUNT;

  FOR v_grp IN
    SELECT
      vs.attendance_date AS adate,
      MIN(vs.clock_in_at) AS first_in,
      MAX(vs.clock_out_at) FILTER (WHERE vs.clock_out_at IS NOT NULL) AS last_out,
      BOOL_OR(vs.clock_out_at IS NULL) AS any_open
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
    GROUP BY vs.attendance_date
  LOOP
    v_total := public.attendance_day_total_minutes(p_user_id, v_grp.adate, v_now);

    INSERT INTO public.attendance_records (
      user_id, attendance_date, status, approval_status,
      clock_in_at, clock_out_at, work_minutes, attendance_source,
      marked_by, reviewed_by, reviewed_at
    )
    VALUES (
      p_user_id, v_grp.adate, 'present', 'approved',
      v_grp.first_in,
      CASE WHEN v_grp.any_open THEN NULL ELSE v_grp.last_out END,
      NULLIF(v_total, 0),
      'admin_correction',
      v_actor, v_actor, v_now
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE SET
      clock_in_at = LEAST(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
      clock_out_at = CASE
        WHEN EXCLUDED.clock_out_at IS NULL THEN NULL
        WHEN public.attendance_records.clock_out_at IS NULL THEN EXCLUDED.clock_out_at
        ELSE GREATEST(public.attendance_records.clock_out_at, EXCLUDED.clock_out_at)
      END,
      work_minutes = EXCLUDED.work_minutes,
      status = 'present',
      approval_status = 'approved'::public.approval_status,
      attendance_source = 'admin_correction'
    RETURNING id INTO v_rec_id;

    UPDATE public.attendance_visit_segments
    SET attendance_record_id = v_rec_id
    WHERE user_id = p_user_id AND attendance_date = v_grp.adate;

    v_dates_touched := v_dates_touched + 1;
  END LOOP;

  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  ) VALUES (
    v_target.company_id,
    NULL,
    p_user_id,
    v_actor,
    'attendance_realign_shift_records_admin',
    COALESCE(v_before, '[]'::jsonb),
    jsonb_build_object(
      'visits_date_rewrites', v_visits_touched,
      'attendance_dates_touched', v_dates_touched
    ),
    'admin_realign'
  );

  PERFORM public.attendance_set_write_context('normal');

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'visits_date_rewrites', v_visits_touched,
    'attendance_dates_touched', v_dates_touched
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_realign_shift_records_admin(UUID) TO authenticated;

COMMENT ON FUNCTION public.attendance_realign_shift_records_admin(UUID) IS
  'Admin-only historical visit/record realign. Requires admin_correction context (set internally). Never call from live check-in/out/auto.';
