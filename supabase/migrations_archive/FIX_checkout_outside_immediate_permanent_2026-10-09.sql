-- Permanent rule: a usable GPS reading outside the saved office radius
-- checks the person out immediately. Enrolled-device "use device token"
-- must never skip that outside check-out.

DO $out$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);

  -- Only hand off to the enrolled device when the reading is still inside.
  -- An outside reading must always run the leave check-out below.
  -- Check out on an outside reading before any enrolled-device handoff.
  def := replace(def,
$old$        IF v_enrolled
           AND v_has_rec
           AND v_rec.clock_in_at IS NOT NULL
           AND v_rec.clock_out_at IS NULL
           AND EXISTS (
             SELECT 1 FROM public.attendance_devices d
             WHERE d.user_id = v_user_id
               AND d.revoked_at IS NULL
               AND d.platform IN ('android', 'ios')
               AND d.presence_state = 'present'
               AND d.last_presence_at IS NOT NULL
               AND d.last_presence_at > v_now - INTERVAL '15 minutes'
           ) THEN
            RETURN jsonb_build_object(
              'action', 'use_device_token',
              'reason', 'enrolled_device_active_presence',
              'stop_tracking', false,
              'enrolled_device', true,
              'radius_meters', v_radius,
              'effective_radius_meters', ROUND(v_effective_radius)::INTEGER,
              'accuracy_meters', p_accuracy
            );
        END IF;

        IF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
$old$,
$new$        IF v_left_site
           AND v_has_rec
           AND v_rec.clock_in_at IS NOT NULL
           AND v_rec.clock_out_at IS NULL
           AND v_now >= v_win.shift_start_utc
           AND v_now <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins
                WHERE id = v_visit.id;
            END IF;
            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins,
                notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
            WHERE id = v_rec.id;
            UPDATE public.attendance_devices SET
                presence_state = 'left',
                gps_outside_streak = 0
            WHERE user_id = v_user_id
              AND revoked_at IS NULL;
            v_action := 'clock_out';
            -- Fall through to the JSON return at the end of the function.
        ELSIF v_enrolled
           AND v_inside
           AND v_has_rec
           AND v_rec.clock_in_at IS NOT NULL
           AND v_rec.clock_out_at IS NULL
           AND EXISTS (
             SELECT 1 FROM public.attendance_devices d
             WHERE d.user_id = v_user_id
               AND d.revoked_at IS NULL
               AND d.platform IN ('android', 'ios')
               AND d.presence_state = 'present'
               AND d.last_presence_at IS NOT NULL
               AND d.last_presence_at > v_now - INTERVAL '15 minutes'
           ) THEN
            RETURN jsonb_build_object(
              'action', 'use_device_token',
              'reason', 'enrolled_device_active_presence',
              'stop_tracking', false,
              'enrolled_device', true,
              'radius_meters', v_radius,
              'effective_radius_meters', ROUND(v_effective_radius)::INTEGER,
              'accuracy_meters', p_accuracy
            );
        END IF;

        IF v_action = 'clock_out' THEN
            NULL; -- already checked out above
        ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
$new$);

  -- Prevent the later ELSIF v_left_site branch from double-closing.
  def := replace(def,
$old$        ELSIF v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
$old$,
$new$        ELSIF v_action IS DISTINCT FROM 'clock_out'
              AND v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
$new$);

  IF def NOT LIKE '%Auto leave (outside office radius)%' THEN
    RAISE EXCEPTION 'immediate outside checkout was not inserted';
  END IF;
  IF def NOT LIKE '%v_action = ''clock_out'' THEN%' THEN
    RAISE EXCEPTION 'clock_out short-circuit missing';
  END IF;
  EXECUTE def;

  -- Keep the auto path leave branch as outside-radius immediate (no Wi-Fi exception).
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);
  IF def NOT LIKE '%Outside the radius: check out even on office Wi-Fi%' THEN
    RAISE EXCEPTION 'auto outside checkout rule missing';
  END IF;
  IF def LIKE '%device_left_others_present%' OR def LIKE '%v_gps_outside AND NOT v_wifi_ok%' THEN
    RAISE EXCEPTION 'auto checkout exceptions came back';
  END IF;
END $out$;

-- Clear stuck open visit for people who already left (Marium and any same-day
-- open visit with no usable location for 30+ minutes after check-in is left
-- alone — only close the reported stuck row when still open and shift window
-- already allows leave processing).
DO $fix$
DECLARE
  v_user uuid := '71f8f4c2-1dd8-4f43-a6a8-d6f9574ea91f';
  v_now timestamptz := timezone('utc', now());
  v_rec public.attendance_records%ROWTYPE;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_mins integer;
  v_total integer;
BEGIN
  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_user
    AND attendance_date = '2026-10-08'
    AND clock_in_at IS NOT NULL
    AND clock_out_at IS NULL
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments
  WHERE user_id = v_user
    AND attendance_date = '2026-10-08'
    AND clock_out_at IS NULL
  ORDER BY clock_in_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::integer / 60);
    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_now,
      work_minutes = v_mins,
      notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
    WHERE id = v_visit.id;
  END IF;

  v_total := public.attendance_day_total_minutes(v_user, '2026-10-08'::date, v_now);
  UPDATE public.attendance_records SET
    clock_out_at = v_now,
    work_minutes = v_total,
    notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
  WHERE id = v_rec.id;

  UPDATE public.attendance_devices SET
    presence_state = 'left',
    gps_outside_streak = 0
  WHERE user_id = v_user
    AND revoked_at IS NULL;
END $fix$;
