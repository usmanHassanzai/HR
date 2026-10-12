CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(p_latitude double precision, p_longitude double precision, p_accuracy double precision DEFAULT NULL::double precision, p_intent text DEFAULT 'auto'::text, p_is_mock boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_inside BOOLEAN := false;
  v_rec public.attendance_records%ROWTYPE;
  v_has_rec BOOLEAN := false;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_action TEXT := 'none';
  v_site_name TEXT;
  v_distance DOUBLE PRECISION;
  v_radius INTEGER;
  v_effective_radius DOUBLE PRECISION;
  v_work_site_id UUID;
  v_demo BOOLEAN;
  v_site_lat DOUBLE PRECISION;
  v_site_lng DOUBLE PRECISION;
  v_office_id UUID;
  v_office_dist DOUBLE PRECISION;
  v_win RECORD;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_has_visit BOOLEAN := false;
  v_seg_mins INTEGER;
  v_total_mins INTEGER;
  v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
  v_open_checkin BOOLEAN := false;
  v_prev_inside BOOLEAN;
  v_left_site BOOLEAN := false;
  v_attendance_date DATE;
  v_enrolled BOOLEAN := false;
  v_chk RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object('action', 'gps_unusable', 'reason', 'gps_unusable');
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees, managers, and HR only');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = v_user_id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
  ) INTO v_enrolled;

  UPDATE public.users SET last_seen_at = v_now WHERE id = v_user_id;

  IF v_intent NOT IN ('clock_in', 'clock_out', 'auto') THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'unknown_intent');
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_user_id, v_now) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RETURN jsonb_build_object(
      'action', 'outside_window',
      'reason', 'outside_window',
      'window_start_utc', v_win.window_start_utc,
      'window_end_utc', v_win.window_end_utc
    );
  END IF;

  v_attendance_date := COALESCE(v_win.attendance_date, (v_now AT TIME ZONE COALESCE(v_win.shift_tz, v_win.company_tz, 'UTC'))::date);

  -- Nearest assigned office for distance / Rule 5 outside (unchanged thresholds).
  SELECT
    ews.office_location_id,
    o.name,
    o.latitude,
    o.longitude,
    COALESCE(o.radius_meters, 150),
    public.haversine_meters(p_latitude, p_longitude, o.latitude, o.longitude),
    COALESCE(o.is_demo, false)
  INTO v_office_id, v_site_name, v_site_lat, v_site_lng, v_radius, v_distance, v_demo
  FROM public.employee_work_sites ews
  JOIN public.office_locations o ON o.id = ews.office_location_id
  WHERE ews.user_id = v_user_id
    AND COALESCE(ews.tracking_enabled, true)
    AND COALESCE(o.active, true)
  ORDER BY public.haversine_meters(p_latitude, p_longitude, o.latitude, o.longitude) ASC
  LIMIT 1;

  v_work_site_id := v_office_id;
  v_effective_radius := COALESCE(v_radius, 150)::double precision;
  v_inside := v_distance IS NOT NULL AND v_distance <= v_effective_radius;

  SELECT inside_site INTO v_prev_inside
  FROM public.employee_location_pings
  WHERE user_id = v_user_id
  ORDER BY recorded_at DESC NULLS LAST
  LIMIT 1;

  v_left_site := p_accuracy IS NOT NULL
    AND p_accuracy <= 50
    AND v_distance IS NOT NULL
    AND v_distance > v_effective_radius
    AND public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_user_id AND attendance_date = v_attendance_date
  LIMIT 1;
  v_open_checkin := v_rec.id IS NOT NULL;
  v_has_rec := v_open_checkin;

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = v_user_id
    AND vs.attendance_date = v_attendance_date
    AND vs.clock_out_at IS NULL
  ORDER BY vs.clock_in_at DESC
  LIMIT 1;
  v_has_visit := FOUND;

  INSERT INTO public.employee_location_pings (
    user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
  ) VALUES (
    v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
  );

  IF v_intent = 'clock_in' THEN
    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_clocked_in';
    ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSE
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, marked_by,
          clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
          reviewed_by, reviewed_at, presence_method
        ) VALUES (
          v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
          v_now, p_latitude, p_longitude, 'manual', v_win.shift_id,
          public.attendance_checkin_note(v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date),
          v_user_id, v_now, 'wifi'
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
          clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
          clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
          clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
          clock_out_at = NULL,
          status = 'present',
          approval_status = 'approved',
          attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'manual' ELSE public.attendance_records.attendance_source END,
          presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now, 'GPS entry'
        );
        v_action := 'clock_in';
      END IF;
    END IF;

  ELSIF v_intent = 'clock_out' THEN
    IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
      v_action := 'no_open_visit';
    ELSIF v_rec.clock_out_at IS NOT NULL THEN
      v_action := 'already_clocked_out';
    ELSE
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_out'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
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
          work_minutes = v_total_mins
        WHERE id = v_rec.id;
        UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0,
        last_presence_at = v_now
      WHERE user_id = v_user_id
        AND revoked_at IS NULL;
      v_action := 'clock_out';
      END IF;
    END IF;

  ELSIF v_intent = 'auto' THEN
    -- Rule 5: usable outside reading → immediate check-out (unchanged).
    IF v_left_site
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
          work_minutes = v_seg_mins,
          notes = COALESCE(notes, '') || ' | Auto leave (outside office radius)'
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
      WHERE user_id = v_user_id AND revoked_at IS NULL;
      v_action := 'clock_out';
    ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
       AND public.attendance_checkin_allowed(v_user_id, v_now) THEN
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, false, NULL, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, marked_by,
          clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
          reviewed_by, reviewed_at, presence_method
        ) VALUES (
          v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
          v_now, p_latitude, p_longitude, 'auto_wifi', v_win.shift_id,
          public.attendance_checkin_note(
            v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date
          ),
          v_user_id, v_now, 'wifi'
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
          clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
          clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
          clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
          clock_out_at = NULL,
          status = 'present',
          approval_status = 'approved',
          attendance_source = CASE
            WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
            THEN 'auto_wifi' ELSE public.attendance_records.attendance_source END,
          presence_method = 'wifi',
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto GPS entry'
        );
        v_action := 'clock_in';
      END IF;
    ELSIF v_inside AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_clocked_in';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'action', v_action,
    'reason', v_action,
    'inside_office', v_inside,
    'office_name', v_site_name,
    'distance_meters', v_distance,
    'radius_meters', v_radius,
    'effective_radius_meters', v_effective_radius,
    'accuracy_meters', p_accuracy,
    'window_start_utc', v_win.window_start_utc,
    'window_end_utc', v_win.window_end_utc,
    'shift_name', v_win.shift_name,
    'record_id', v_rec.id
  );
END;
$function$
