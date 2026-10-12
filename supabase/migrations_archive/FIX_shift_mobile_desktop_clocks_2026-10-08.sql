-- One shift, two clocks: phone (for example Asia/Karachi 18:00–03:00)
-- and laptop (for example America/Chicago 08:00–17:00).
-- The shift stays open while EITHER clock is in progress.
-- A laptop Test now / heartbeat that is not on office Wi-Fi must not
-- check out a visit that was opened on the phone.

CREATE OR REPLACE FUNCTION public.attendance_bounds_for_clock(
  p_at TIMESTAMPTZ,
  p_start TIME,
  p_end TIME,
  p_days INTEGER[],
  p_tz TEXT,
  p_overnight BOOLEAN DEFAULT NULL
) RETURNS TABLE (
  has_shift BOOLEAN,
  in_window BOOLEAN,
  crosses_midnight BOOLEAN,
  attendance_date DATE,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  shift_start_utc TIMESTAMPTZ,
  shift_end_utc TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz TEXT;
  v_days INTEGER[];
  v_overnight BOOLEAN;
  v_local_date DATE;
  v_prev_date DATE;
  v_dow INTEGER;
  v_prev_dow INTEGER;
  v_att_date DATE;
  v_shift_start TIMESTAMPTZ;
  v_shift_end TIMESTAMPTZ;
  v_win_start TIMESTAMPTZ;
  v_win_end TIMESTAMPTZ;
BEGIN
  v_tz := public.assert_valid_iana_timezone(p_tz);
  v_days := COALESCE(p_days, ARRAY[1, 2, 3, 4, 5]);
  v_overnight := COALESCE(p_overnight, (p_end <= p_start));

  v_local_date := public.attendance_local_date(p_at, v_tz);
  v_prev_date := v_local_date - 1;
  v_dow := public.attendance_iso_dow(p_at, v_tz);
  v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;

  IF NOT v_overnight THEN
    IF v_dow = ANY (v_days) THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, p_end, v_tz);
    ELSE
      has_shift := false;
      in_window := false;
      crosses_midnight := false;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    IF v_dow = ANY (v_days) AND (p_at AT TIME ZONE v_tz)::TIME >= p_start THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date + 1, p_end, v_tz);
    ELSIF v_prev_dow = ANY (v_days) AND (p_at AT TIME ZONE v_tz)::TIME <= p_end THEN
      v_att_date := v_prev_date;
      v_shift_start := public.attendance_tz_instant(v_prev_date, p_start, v_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, p_end, v_tz);
    ELSE
      has_shift := false;
      in_window := false;
      crosses_midnight := true;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_win_start := v_shift_start - INTERVAL '60 minutes';
  v_win_end := v_shift_end + INTERVAL '60 minutes';

  has_shift := true;
  in_window := (p_at >= v_win_start AND p_at <= v_win_end);
  crosses_midnight := v_overnight;
  attendance_date := v_att_date;
  window_start_utc := v_win_start;
  window_end_utc := v_win_end;
  shift_start_utc := v_shift_start;
  shift_end_utc := v_shift_end;
  RETURN NEXT;
END;
$$;

-- Later of the phone clock and every saved laptop/display clock for this visit.
CREATE OR REPLACE FUNCTION public.shift_latest_end_timestamptz(
  p_shift_id UUID,
  p_attendance_date DATE,
  p_start_time TIME,
  p_end_time TIME,
  p_clock_in TIMESTAMPTZ,
  p_timezone TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_end TIMESTAMPTZ;
  v_zone RECORD;
  v_zone_end TIMESTAMPTZ;
BEGIN
  v_end := public.shift_end_timestamptz(
    p_attendance_date, p_start_time, p_end_time, p_clock_in, p_timezone
  );
  IF p_shift_id IS NULL THEN
    RETURN v_end;
  END IF;

  FOR v_zone IN
    SELECT z.timezone, z.entered_start_time, z.entered_end_time
    FROM public.shift_display_zones z
    WHERE z.shift_id = p_shift_id
  LOOP
    BEGIN
      v_zone_end := public.shift_end_timestamptz(
        p_attendance_date,
        v_zone.entered_start_time,
        v_zone.entered_end_time,
        p_clock_in,
        v_zone.timezone
      );
    EXCEPTION WHEN OTHERS THEN
      v_zone_end := NULL;
    END;
    IF v_zone_end IS NOT NULL AND (v_end IS NULL OR v_zone_end > v_end) THEN
      v_end := v_zone_end;
    END IF;
  END LOOP;

  RETURN v_end;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_window_for_user(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS TABLE (
  has_shift BOOLEAN,
  in_window BOOLEAN,
  shift_id UUID,
  shift_name TEXT,
  shift_tz TEXT,
  start_time TIME,
  end_time TIME,
  days_of_week INTEGER[],
  crosses_midnight BOOLEAN,
  attendance_date DATE,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  shift_start_utc TIMESTAMPTZ,
  shift_end_utc TIMESTAMPTZ,
  company_id UUID,
  company_tz TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id UUID;
  v_company_tz TEXT;
  v_shift_id UUID;
  v_shift_name TEXT;
  v_shift_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_days INTEGER[];
  v_overnight BOOLEAN;
  v_main RECORD;
  v_try RECORD;
  v_zone RECORD;
  v_best_in BOOLEAN := false;
  v_best_end TIMESTAMPTZ;
  v_att_date DATE;
  v_shift_start TIMESTAMPTZ;
  v_shift_end TIMESTAMPTZ;
  v_win_start TIMESTAMPTZ;
  v_win_end TIMESTAMPTZ;
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  v_company_tz := COALESCE(v_company_tz, 'Asia/Karachi');

  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_company_tz)) s
  LIMIT 1;

  IF NOT FOUND OR v_shift_id IS NULL THEN
    has_shift := false;
    in_window := false;
    shift_id := NULL;
    shift_name := NULL;
    shift_tz := v_company_tz;
    start_time := NULL;
    end_time := NULL;
    days_of_week := NULL;
    crosses_midnight := false;
    attendance_date := NULL;
    window_start_utc := NULL;
    window_end_utc := NULL;
    shift_start_utc := NULL;
    shift_end_utc := NULL;
    company_id := v_company_id;
    company_tz := v_company_tz;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(NULLIF(btrim(ws.timezone), ''), v_company_tz)
  INTO v_shift_tz
  FROM public.work_shifts ws
  WHERE ws.id = v_shift_id;

  v_shift_tz := public.assert_valid_iana_timezone(COALESCE(v_shift_tz, v_company_tz));
  v_days := COALESCE(v_days, ARRAY[1, 2, 3, 4, 5]);
  v_overnight := COALESCE(v_overnight, (v_end <= v_start));

  SELECT * INTO v_main
  FROM public.attendance_bounds_for_clock(p_at, v_start, v_end, v_days, v_shift_tz, v_overnight)
  LIMIT 1;

  v_best_in := COALESCE(v_main.in_window, false);
  v_best_end := v_main.shift_end_utc;
  v_att_date := v_main.attendance_date;
  v_shift_start := v_main.shift_start_utc;
  v_shift_end := v_main.shift_end_utc;
  v_win_start := v_main.window_start_utc;
  v_win_end := v_main.window_end_utc;

  FOR v_zone IN
    SELECT z.timezone, z.entered_start_time, z.entered_end_time
    FROM public.shift_display_zones z
    WHERE z.shift_id = v_shift_id
      AND NULLIF(btrim(z.timezone), '') IS NOT NULL
      AND z.timezone IS DISTINCT FROM v_shift_tz
    ORDER BY z.sort_order, z.created_at
  LOOP
    BEGIN
      SELECT * INTO v_try
      FROM public.attendance_bounds_for_clock(
        p_at,
        v_zone.entered_start_time,
        v_zone.entered_end_time,
        v_days,
        v_zone.timezone,
        NULL
      )
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    IF COALESCE(v_try.in_window, false) AND (
      NOT v_best_in
      OR v_best_end IS NULL
      OR v_try.shift_end_utc > v_best_end
    ) THEN
      v_best_in := true;
      v_best_end := v_try.shift_end_utc;
      v_start := v_zone.entered_start_time;
      v_end := v_zone.entered_end_time;
      v_shift_tz := v_zone.timezone;
      v_overnight := COALESCE(v_try.crosses_midnight, false);
      v_att_date := v_try.attendance_date;
      v_shift_start := v_try.shift_start_utc;
      v_shift_end := v_try.shift_end_utc;
      v_win_start := v_try.window_start_utc;
      v_win_end := v_try.window_end_utc;
    END IF;
  END LOOP;

  has_shift := COALESCE(v_main.has_shift, false) OR v_best_in;
  in_window := v_best_in;
  shift_id := v_shift_id;
  shift_name := v_shift_name;
  shift_tz := v_shift_tz;
  start_time := v_start;
  end_time := v_end;
  days_of_week := v_days;
  crosses_midnight := COALESCE(v_overnight, false);
  attendance_date := v_att_date;
  window_start_utc := v_win_start;
  window_end_utc := v_win_end;
  shift_start_utc := v_shift_start;
  shift_end_utc := v_shift_end;
  company_id := v_company_id;
  company_tz := v_company_tz;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_bounds_for_clock(TIMESTAMPTZ, TIME, TIME, INTEGER[], TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_latest_end_timestamptz(UUID, DATE, TIME, TIME, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
    p_user_id UUID,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_shift_id UUID;
    v_start TIME;
    v_end_t TIME;
    v_shift_tz TEXT;
    n INTEGER := 0;
    v_total INTEGER;
    v_open_visits INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR r IN
        SELECT ar.*
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.status IS DISTINCT FROM 'absent'
          AND (
            ar.clock_out_at IS NULL
            OR EXISTS (
              SELECT 1 FROM public.attendance_visit_segments vs
              WHERE vs.user_id = ar.user_id
                AND vs.attendance_date = ar.attendance_date
                AND vs.clock_out_at IS NULL
            )
          )
    LOOP
        SELECT s.shift_id, s.start_time, s.end_time
        INTO v_shift_id, v_start, v_end_t
        FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
        LIMIT 1;

        IF v_shift_id IS NULL THEN
            CONTINUE;
        END IF;

        -- Prefer work_shifts.timezone; fall back to company / app TZ.
        SELECT COALESCE(
            NULLIF(btrim(ws.timezone), ''),
            public.company_timezone(u.company_id),
            public.app_timezone()
        )
        INTO v_shift_tz
        FROM public.users u
        LEFT JOIN public.work_shifts ws ON ws.id = v_shift_id
        WHERE u.id = p_user_id;

        v_end := public.shift_latest_end_timestamptz(
            v_shift_id, r.attendance_date, v_start, v_end_t, r.clock_in_at, v_shift_tz
        );

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        v_out := GREATEST(r.clock_in_at, v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = GREATEST(clock_in_at, v_out),
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(
                0,
                (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
            ),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        SELECT COUNT(*)::INTEGER INTO v_open_visits
        FROM public.attendance_visit_segments
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF v_open_visits > 0 THEN
            CONTINUE;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.attendance_visit_segments
            WHERE user_id = p_user_id AND attendance_date = r.attendance_date
        ) THEN
            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_out_at, work_minutes, notes
            ) VALUES (
                p_user_id, r.id, r.attendance_date, 1,
                r.clock_in_at, v_out,
                GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
                'Auto clock-out (shift ended)'
            );
        END IF;

        SELECT MAX(vs.clock_out_at) INTO v_out
        FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = r.attendance_date
          AND vs.clock_out_at IS NOT NULL
          AND vs.clock_out_at > vs.clock_in_at;

        v_out := COALESCE(v_out, GREATEST(r.clock_in_at, v_end));
        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        UPDATE public.attendance_records SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(p_token_hash text, p_event text, p_zone_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_ssid text DEFAULT NULL::text, p_bssid text DEFAULT NULL::text, p_occurred_at_utc_ms bigint DEFAULT NULL::bigint, p_device_now_utc_ms bigint DEFAULT NULL::bigint, p_device_timezone text DEFAULT NULL::text, p_is_mock boolean DEFAULT false, p_device_id text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text, p_client_ip text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now TIMESTAMPTZ := public.attendance_now();
  v_corr RECORD;
  v_win RECORD;
  v_event TEXT := lower(trim(COALESCE(p_event, '')));
  v_zone public.office_locations%ROWTYPE;
  v_dist DOUBLE PRECISION;
  v_eff_radius DOUBLE PRECISION;
  v_exit_radius DOUBLE PRECISION;
  v_gps_ok BOOLEAN := false;
  v_gps_has_fix BOOLEAN := false;
  v_gps_usable BOOLEAN := false;
  v_gps_inside BOOLEAN := false;
  v_gps_outside BOOLEAN := false;
  v_wifi_ok BOOLEAN := false;
  v_wifi_ssid_only BOOLEAN := false;
  v_wifi_network_id UUID;
  v_wifi_network_label TEXT;
  v_wifi_match RECORD;
  v_laptop_ok BOOLEAN := false;
  v_present BOOLEAN := false;
  v_left BOOLEAN := false;
  v_leave_mode TEXT := NULL; -- immediate | grace
  v_outside_streak INTEGER := 0;
  v_method TEXT;
  v_source TEXT;
  v_action TEXT := 'none';
  v_rec public.attendance_records%ROWTYPE;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_has_visit BOOLEAN := false;
  v_att_date DATE;
  v_seg_mins INTEGER;
  v_total INTEGER;
  v_dup BOOLEAN := false;
  v_other_present BOOLEAN := false;
  v_work_mode TEXT;
  v_phone_on BOOLEAN;
  v_laptop_on BOOLEAN;
  v_log_id UUID;
  v_notify_msg TEXT;
  v_local_time TEXT;
  v_tz TEXT;
BEGIN
  IF p_token_hash IS NULL OR btrim(p_token_hash) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_token', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_dev
  FROM public.attendance_devices d
  WHERE d.token_hash = p_token_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token', 'stop_tracking', true);
  END IF;

  IF v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'revoked_token', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_dev.user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_gone', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = v_dev.company_id;

  SELECT * INTO v_corr
  FROM public.attendance_correct_occurred_at(p_occurred_at_utc_ms, p_device_now_utc_ms, v_now)
  LIMIT 1;

  UPDATE public.attendance_devices SET
    last_seen_at = v_now,
    last_clock_skew_ms = v_corr.skew_ms,
    device_timezone = COALESCE(NULLIF(btrim(p_device_timezone), ''), device_timezone),
    app_version = COALESCE(NULLIF(btrim(p_app_version), ''), app_version),
    last_heartbeat_at = CASE
      WHEN v_event IN ('heartbeat', 'ping', 'enter', 'wifi_connected', 'power_on') THEN v_now
      ELSE last_heartbeat_at
    END
  WHERE id = v_dev.id;

  IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;

  v_work_mode := COALESCE(v_user.work_mode, 'office');
  v_phone_on := COALESCE(v_company.auto_phone_attendance, false)
            AND COALESCE(v_user.auto_phone_attendance, false);
  v_laptop_on := COALESCE(v_company.auto_laptop_attendance, false)
             AND COALESCE(v_user.auto_laptop_attendance, false);

  IF v_dev.platform IN ('android', 'ios') AND NOT v_phone_on THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'feature_off', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_off', 'stop_tracking', true);
  END IF;

  IF v_dev.platform IN ('windows', 'linux') AND NOT v_laptop_on THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'feature_off', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_off', 'stop_tracking', true);
  END IF;

  IF v_work_mode = 'remote' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_mode_remote', 'stop_tracking', true);
  END IF;

  IF COALESCE(p_is_mock, false) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, zone_id, latitude, longitude, accuracy_m, occurred_at, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'mock_location', p_client_ip,
      v_corr.skew_ms, true, p_zone_id, p_latitude, p_longitude, p_accuracy_m, v_corr.occurred_at,
      jsonb_build_object('flag', 'mock_location')
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'mock_location', 'flagged', true);
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_corr.occurred_at) LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'outside_window', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'outside_window',
      'stop_tracking', true,
      'window_start_utc', v_win.window_start_utc,
      'window_end_utc', v_win.window_end_utc,
      'server_now_utc', v_now
    );
  END IF;

  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes' THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'event_too_old', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'event_too_old');
  END IF;

  v_att_date := v_win.attendance_date;

  IF p_zone_id IS NOT NULL THEN
    SELECT * INTO v_zone FROM public.office_locations
    WHERE id = p_zone_id
      AND (company_id IS NULL OR company_id = v_dev.company_id)
      AND COALESCE(active, true);
  END IF;

  IF v_zone.id IS NULL THEN
    SELECT o.* INTO v_zone
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = v_dev.user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
    ORDER BY ews.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_zone.id IS NULL THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'no_zone', p_client_ip, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'no_zone', 'stop_tracking', true);
  END IF;

  -- GPS presence / exit use exact configured radius (no accuracy pad, no +50m exit buffer).
  -- Accuracy still gates usability (reject fixes worse than 100 m) but does not enlarge the zone.
  v_gps_has_fix := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
     AND v_zone.latitude IS NOT NULL AND v_zone.longitude IS NOT NULL;
  v_gps_usable := v_gps_has_fix AND (p_accuracy_m IS NULL OR p_accuracy_m <= 100);

  IF v_gps_has_fix THEN
    v_dist := public.haversine_meters(p_latitude, p_longitude, v_zone.latitude, v_zone.longitude);
    v_eff_radius := COALESCE(v_zone.radius_meters, 150)::DOUBLE PRECISION;
    v_exit_radius := v_eff_radius;
    v_gps_ok := v_gps_usable AND v_dist <= v_eff_radius;
    v_gps_inside := v_gps_usable AND v_dist <= v_exit_radius;
    v_gps_outside := v_gps_usable AND v_dist > v_exit_radius;
  END IF;

  -- Geofence EXIT without a usable fix still counts as GPS-confirmed leave attempt
  IF v_event = 'exit' AND NOT v_gps_usable THEN
    v_gps_outside := true;
  END IF;

  SELECT * INTO v_wifi_match
  FROM public.attendance_match_office_wifi(v_zone.id, p_client_ip, p_ssid, p_bssid);
  v_wifi_ok := COALESCE(v_wifi_match.matched, false);
  v_wifi_ssid_only := COALESCE(v_wifi_match.ssid_only_suspected, false);
  v_wifi_network_id := v_wifi_match.network_id;
  v_wifi_network_label := v_wifi_match.network_label;

  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;

  IF v_zone.detection_mode = 'gps_only' THEN
    v_present := v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat');
    v_left := (NOT v_gps_ok) AND v_event IN ('exit', 'ping');
    IF v_left AND v_gps_outside THEN
      v_leave_mode := 'immediate';
    ELSIF v_left AND NOT v_gps_usable THEN
      v_leave_mode := 'grace';
    END IF;
  ELSIF v_zone.detection_mode = 'wifi_only' THEN
    v_present := v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter');
    v_left := (NOT v_wifi_ok) AND v_event IN ('wifi_disconnected', 'power_off', 'exit');
    IF v_left THEN
      v_leave_mode := CASE WHEN v_event = 'power_off' THEN 'immediate' ELSE 'grace' END;
    END IF;
  ELSE
    -- gps_or_wifi (default)
    v_present := (
      (v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat'))
      OR (v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter'))
      OR (v_laptop_ok)
    );
    v_left := false;

    IF v_dev.platform IN ('android', 'ios') THEN
      -- Outside streak: geofence EXIT confirms immediately; else need 2 consecutive usable outside readings
      IF v_event = 'exit' OR v_gps_outside THEN
        IF v_event = 'exit' THEN
          v_outside_streak := 2;
        ELSE
          v_outside_streak := LEAST(COALESCE(v_dev.gps_outside_streak, 0) + 1, 10);
        END IF;
      ELSIF v_gps_inside OR v_gps_ok THEN
        v_outside_streak := 0;
      ELSE
        v_outside_streak := COALESCE(v_dev.gps_outside_streak, 0);
      END IF;

      IF v_wifi_ok THEN
        -- GPS outside but still on office Wi-Fi → stay checked in (GPS drift)
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
        IF v_gps_outside THEN
          v_outside_streak := 0; -- wifi presence resets leave confirm
        END IF;
      ELSIF v_gps_inside THEN
        -- Office Wi-Fi disconnected / sleep but GPS still inside → stay checked in
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSIF (
          v_event = 'exit'
          OR (v_event = 'wifi_disconnected' AND v_gps_outside)
          OR (v_outside_streak >= 2 AND v_gps_outside)
          OR (v_event = 'ping' AND v_gps_outside AND v_outside_streak >= 2)
        ) AND NOT v_wifi_ok THEN
        -- Outside exact office radius (exit / 2 usable outside pings) while not on office Wi-Fi → immediate check-out
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
        v_outside_streak := GREATEST(v_outside_streak, 2);
      ELSIF v_event = 'wifi_disconnected' AND NOT v_gps_usable THEN
        -- Wi-Fi lost and GPS off / unavailable / poor accuracy → 15-min grace
        v_present := false;
        v_left := true;
        v_leave_mode := 'grace';
      ELSIF (NOT v_gps_ok) AND (NOT v_wifi_ok) AND v_event = 'ping' AND NOT v_gps_usable THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'grace';
      ELSIF v_gps_outside AND v_outside_streak < 2 AND NOT v_wifi_ok AND v_event IS DISTINCT FROM 'wifi_disconnected' THEN
        -- First outside ping (without wifi_disconnect) — wait for confirmation
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
    ELSE
      -- Laptop / desktop. Phone (Pakistan) and laptop (US) are one shift.
      -- Test now / heartbeat while this laptop is not on office Wi-Fi must not
      -- check out a visit opened on the phone. Check out only if THIS laptop
      -- was already present on the office network and has now left it.
      IF v_event IN ('heartbeat', 'power_on', 'ping')
         AND NOT v_wifi_ok AND NOT v_gps_ok AND NOT v_laptop_ok THEN
        v_present := false;
        IF COALESCE(v_dev.presence_state, '') = 'present'
           AND COALESCE(v_dev.last_matched_method, '') IN ('laptop', 'wifi') THEN
          v_left := true;
          v_leave_mode := 'immediate';
        ELSE
          v_left := false;
          v_leave_mode := NULL;
        END IF;
      ELSE
        v_left := (
          v_event IN ('exit', 'wifi_disconnected', 'power_off')
          OR ((NOT v_gps_ok) AND (NOT v_wifi_ok) AND v_event = 'ping')
        );
        IF v_event = 'power_off' THEN
          v_leave_mode := 'immediate';
        ELSIF v_left AND NOT v_wifi_ok AND (v_gps_outside OR v_event = 'exit') THEN
          v_leave_mode := 'immediate';
        ELSIF v_left THEN
          v_leave_mode := 'grace';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_event = 'power_off' THEN
    v_left := true;
    v_present := false;
    v_leave_mode := 'immediate';
  END IF;

  -- Ignore SSID-only fake-hotspot on disconnect (clients may echo last SSID while IP already changed)
  IF v_wifi_ssid_only AND v_event IS DISTINCT FROM 'wifi_disconnected' THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      ssid, bssid, skew_ms, clock_flagged, zone_id, occurred_at, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'fake_hotspot_suspected', p_client_ip,
      p_ssid, p_bssid, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, v_corr.occurred_at,
      jsonb_build_object('flag', 'ssid_matched_ip_or_bssid_failed', 'wifi_network_id', v_wifi_network_id, 'wifi_network_label', v_wifi_network_label)
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_network', 'flagged', true, 'flag', 'fake_hotspot_suspected');
  END IF;

  IF v_gps_ok THEN v_method := 'gps';
  ELSIF v_wifi_ok AND v_dev.platform IN ('windows', 'linux') THEN v_method := 'laptop';
  ELSIF v_wifi_ok THEN v_method := 'wifi';
  ELSE v_method := NULL;
  END IF;

  v_source := CASE v_method
    WHEN 'gps' THEN 'auto_gps'
    WHEN 'wifi' THEN 'auto_wifi'
    WHEN 'laptop' THEN 'auto_laptop'
    ELSE 'auto_gps'
  END;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_events_log e
    WHERE e.user_id = v_dev.user_id
      AND e.zone_id IS NOT DISTINCT FROM v_zone.id
      AND e.event = v_event
      AND e.accepted = true
      AND e.created_at > v_now - INTERVAL '5 minutes'
  ) INTO v_dup;

  IF v_dup AND v_event NOT IN ('heartbeat') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
    RETURN jsonb_build_object('ok', true, 'action', 'duplicate_ignored', 'reason', 'duplicate_within_5m');
  END IF;

  -- Update this device presence + outside streak
  IF v_present THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_zone_id = v_zone.id,
      last_matched_method = v_method,
      last_heartbeat_at = v_now,
      gps_outside_streak = 0
    WHERE id = v_dev.id;
  ELSIF v_left OR v_event IN ('exit', 'wifi_disconnected', 'power_off') THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id,
      gps_outside_streak = CASE
        WHEN v_dev.platform IN ('android', 'ios') THEN v_outside_streak
        ELSE gps_outside_streak
      END
    WHERE id = v_dev.id;
  ELSE
    UPDATE public.attendance_devices SET
      gps_outside_streak = CASE
        WHEN v_dev.platform IN ('android', 'ios') THEN v_outside_streak
        ELSE gps_outside_streak
      END
    WHERE id = v_dev.id;
  END IF;

  IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_heartbeat_at = v_now,
      last_matched_method = COALESCE(v_method, last_matched_method),
      gps_outside_streak = 0
    WHERE id = v_dev.id;
    v_present := true;
  END IF;

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_dev.user_id
    AND attendance_date = v_att_date
  LIMIT 1;

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = v_dev.user_id
    AND vs.attendance_date = v_att_date
    AND vs.clock_out_at IS NULL
  ORDER BY vs.clock_in_at DESC
  LIMIT 1;
  v_has_visit := FOUND;

  --------------------------------------------------------------------------
  -- PRESENT → check-in / new visit
  --------------------------------------------------------------------------
  IF v_present THEN
    IF v_rec.id IS NOT NULL AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL AND v_has_visit THEN
      v_action := 'already_checked_in';
    ELSIF NOT public.attendance_checkin_allowed(v_dev.user_id, v_corr.occurred_at) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSE
      INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
        reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
      ) VALUES (
        v_dev.user_id, v_att_date, 'present', 'approved', v_dev.user_id,
        v_corr.occurred_at, p_latitude, p_longitude, v_source, v_win.shift_id,
        'Auto check-in (' || COALESCE(v_method, 'auto') || ') at ' || COALESCE(v_zone.name, 'office')
          || CASE WHEN v_wifi_network_label IS NOT NULL THEN ' [' || v_wifi_network_label || ']' ELSE '' END,
        v_dev.user_id, v_now, v_method, v_wifi_network_id, v_wifi_network_label
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE SET
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
        clock_out_at = NULL,
        clock_out_lat = NULL,
        clock_out_lng = NULL,
        status = 'present',
        approval_status = 'approved',
        attendance_source = CASE
          WHEN public.attendance_records.clock_in_at IS NULL OR public.attendance_records.clock_out_at IS NOT NULL
          THEN EXCLUDED.attendance_source
          ELSE public.attendance_records.attendance_source
        END,
        presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
        wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
        wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
        notes = CASE
          WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
          THEN EXCLUDED.notes ELSE public.attendance_records.notes
        END
      RETURNING * INTO v_rec;

      PERFORM public.attendance_ensure_open_visit(
        v_dev.user_id, v_rec.id, v_att_date, v_corr.occurred_at,
        'Auto entry ' || COALESCE(v_method, '')
      );
      UPDATE public.attendance_visit_segments SET
        clock_in_lat = COALESCE(clock_in_lat, p_latitude),
        clock_in_lng = COALESCE(clock_in_lng, p_longitude),
        site_name = COALESCE(site_name, v_zone.name),
        wifi_network_id = COALESCE(v_wifi_network_id, wifi_network_id),
        wifi_network_label = COALESCE(v_wifi_network_label, wifi_network_label)
      WHERE user_id = v_dev.user_id
        AND attendance_date = v_att_date
        AND clock_out_at IS NULL;
      v_action := 'clock_in';
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out
  -- R69 immediate when GPS leave confirmed + not on office Wi-Fi
  -- Laptop power_off immediate; grace otherwise → cron after 15 min
  -- R54: check out only when ALL enrolled devices confirm left
  --------------------------------------------------------------------------
  ELSIF v_left AND v_leave_mode = 'immediate' THEN
    -- Only real office presence (last_presence_at) blocks check-out — never laptop
    -- heartbeats off Wi-Fi, which used to refresh last_heartbeat_at and stuck R54.
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_dev.user_id
        AND d.revoked_at IS NULL
        AND d.id <> v_dev.id
        AND d.presence_state = 'present'
        AND d.last_presence_at IS NOT NULL
        AND d.last_presence_at > v_now - INTERVAL '15 minutes'
    ) INTO v_other_present;

    IF NOT v_other_present
       AND v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN
        v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_corr.occurred_at - v_visit.clock_in_at))::INTEGER / 60);
        UPDATE public.attendance_visit_segments SET
          clock_out_at = v_corr.occurred_at,
          clock_out_lat = p_latitude,
          clock_out_lng = p_longitude,
          work_minutes = v_seg_mins,
          notes = COALESCE(notes, '') || CASE
            WHEN v_event = 'power_off' THEN ' | Auto laptop power-off'
            ELSE ' | Auto leave (outside office radius)'
          END
        WHERE id = v_visit.id;
      END IF;
      v_total := public.attendance_day_total_minutes(v_dev.user_id, v_att_date, v_corr.occurred_at);
      UPDATE public.attendance_records SET
        clock_out_at = v_corr.occurred_at,
        clock_out_lat = p_latitude,
        clock_out_lng = p_longitude,
        work_minutes = v_total,
        notes = COALESCE(notes, '') || CASE
          WHEN v_event = 'power_off' THEN ' | Auto laptop power-off'
          ELSE ' | Auto leave (outside office radius)'
        END
      WHERE id = v_rec.id;
      v_action := 'clock_out';

      v_tz := COALESCE(NULLIF(btrim(p_device_timezone), ''), v_dev.device_timezone, v_company.timezone, 'UTC');
      BEGIN
        v_local_time := trim(to_char(v_corr.occurred_at AT TIME ZONE v_tz, 'FMHH12:MI AM'));
      EXCEPTION WHEN OTHERS THEN
        v_local_time := trim(to_char(v_corr.occurred_at AT TIME ZONE 'UTC', 'FMHH12:MI AM'));
      END;
      v_notify_msg := 'Checked out at ' || COALESCE(v_local_time, '') || ' — you left the office.';
      PERFORM public.create_system_notification(
        v_dev.user_id,
        'Checked out',
        v_notify_msg,
        'info'::public.notification_type,
        jsonb_build_object('kind', 'auto_checkout', 'occurred_at', v_corr.occurred_at)
      );
    ELSE
      v_action := CASE WHEN v_other_present THEN 'device_left_others_present' ELSE 'no_open_visit' END;
    END IF;

  ELSIF v_left AND COALESCE(v_leave_mode, 'grace') = 'grace' THEN
    -- Mark left; actual checkout deferred to cron after 15 min no presence (R69 grace)
    v_action := 'presence_left_pending';
  ELSIF v_dev.platform IN ('windows', 'linux')
     AND v_event IN ('ping', 'heartbeat', 'power_on') THEN
    -- Laptop is inside the shift clocks but not on office Wi-Fi.
    -- Keep an open phone check-in. Do not clock out.
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_checked_in';
    ELSE
      v_action := 'not_on_office_network';
    END IF;
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    matched_method, skew_ms, clock_flagged, zone_id, latitude, longitude, accuracy_m,
    ssid, bssid, occurred_at, payload, wifi_network_id, wifi_network_label
  ) VALUES (
    v_dev.company_id, v_dev.user_id, v_dev.id, v_event, true, v_action, p_client_ip,
    v_method, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, p_latitude, p_longitude, p_accuracy_m,
    p_ssid, p_bssid, v_corr.occurred_at,
    jsonb_build_object(
      'app_version', p_app_version,
      'platform', p_platform,
      'clock_flagged', v_corr.clock_flagged,
      'wifi_network_id', v_wifi_network_id,
      'wifi_network_label', v_wifi_network_label,
      'leave_mode', v_leave_mode,
      'gps_outside_streak', v_outside_streak,
      'gps_outside', v_gps_outside,
      'wifi_ok', v_wifi_ok
    ),
    v_wifi_network_id,
    v_wifi_network_label
  ) RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'matched_method', v_method,
    'attendance_date', v_att_date,
    'occurred_at', v_corr.occurred_at,
    'skew_ms', v_corr.skew_ms,
    'clock_flagged', v_corr.clock_flagged,
    'window_start_utc', v_win.window_start_utc,
    'window_end_utc', v_win.window_end_utc,
    'server_now_utc', v_now,
    'stop_tracking', false,
    'event_log_id', v_log_id,
    'wifi_network_id', v_wifi_network_id,
    'wifi_network_label', v_wifi_network_label,
    'leave_mode', v_leave_mode,
    'notify_message', v_notify_msg,
    'local_time', v_local_time
  );
END;
$$;


GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  text, text, uuid, double precision, double precision, double precision,
  text, text, bigint, bigint, text, boolean, text, text, text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
