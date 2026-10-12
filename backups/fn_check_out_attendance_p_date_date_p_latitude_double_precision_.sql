CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date date DEFAULT NULL::date, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy double precision DEFAULT NULL::double precision, p_is_mock boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_win RECORD;
  v_shift_date DATE;
  v_rec public.attendance_records%ROWTYPE;
  v_total INTEGER := 0;
  v_id UUID;
  v_n INTEGER;
  v_chk_ok BOOLEAN := false;
  v_chk_reason TEXT := NULL;
  v_match_kind TEXT := NULL;
  v_note TEXT := NULL;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RAISE EXCEPTION 'attendance_outside_window: check-out only inside the attendance window';
  END IF;

    SELECT ok, reason, match_kind
  INTO v_chk_ok, v_chk_reason, v_match_kind
  FROM public.attendance_office_presence_check(
    v_uid, p_latitude, p_longitude, p_accuracy, COALESCE(p_is_mock, false), NULL, 'check_out'
  ) LIMIT 1;
  IF NOT FOUND THEN
    v_chk_ok := false;
    v_chk_reason := 'gps_unusable';
    v_match_kind := NULL;
  END IF;

  IF NOT COALESCE(v_chk_ok, false) THEN
    IF v_chk_reason = 'not_on_office_wifi' THEN
      RAISE EXCEPTION 'not_on_office_wifi: Connect to the office Wi-Fi';
    ELSIF v_chk_reason = 'gps_unusable' THEN
      RAISE EXCEPTION 'gps_unusable: Location unavailable, try again';
    ELSE
      RAISE EXCEPTION 'outside_radius: You are outside the office radius';
    END IF;
  END IF;

  IF COALESCE(v_match_kind, '') = 'wifi_no_gps' THEN
    v_note := 'Clocked out on office Wi-Fi, location unavailable';
  END IF;

  v_shift_date := COALESCE(p_date, v_win.attendance_date);

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_uid AND attendance_date = v_shift_date;

  IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
    RAISE EXCEPTION 'Check in first, then you can check out';
  END IF;
  IF v_rec.status = 'absent' THEN
    RAISE EXCEPTION 'Cannot check out on an absent day';
  END IF;
  IF v_rec.clock_out_at IS NOT NULL THEN
    RAISE EXCEPTION 'Already checked out';
  END IF;

  UPDATE public.attendance_visit_segments
  SET clock_out_at = v_now,
      clock_out_lat = COALESCE(p_latitude, clock_out_lat),
      clock_out_lng = COALESCE(p_longitude, clock_out_lng),
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER),
      notes = CASE
        WHEN v_note IS NOT NULL THEN
          CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v_note ELSE notes || ' | ' || v_note END
        ELSE notes
      END
  WHERE user_id = v_uid
    AND attendance_date = v_shift_date
    AND clock_out_at IS NULL;

  IF NOT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments
    WHERE user_id = v_uid AND attendance_date = v_shift_date
  ) THEN
    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
    FROM public.attendance_visit_segments
    WHERE user_id = v_uid AND attendance_date = v_shift_date;
    INSERT INTO public.attendance_visit_segments (
      user_id, attendance_record_id, attendance_date, visit_number,
      clock_in_at, clock_out_at, clock_out_lat, clock_out_lng, work_minutes, notes
    ) VALUES (
      v_uid, v_rec.id, v_shift_date, GREATEST(v_n, 1),
      v_rec.clock_in_at, v_now, p_latitude, p_longitude,
      GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
      COALESCE(v_note, 'Manual check-out')
    );
  END IF;

  v_total := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);

  UPDATE public.attendance_records
  SET clock_out_at = v_now,
      clock_out_lat = COALESCE(p_latitude, clock_out_lat),
      clock_out_lng = COALESCE(p_longitude, clock_out_lng),
      work_minutes = v_total,
      notes = CASE
        WHEN v_note IS NOT NULL THEN
          CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v_note ELSE notes || ' | ' || v_note END
        ELSE notes
      END,
      presence_method = CASE
        WHEN COALESCE(v_match_kind, '') = 'wifi_no_gps' THEN 'wifi'
        ELSE presence_method
      END
  WHERE id = v_rec.id
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
