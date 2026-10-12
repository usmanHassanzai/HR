-- auto_checkout_shift_end_2026-10-13.sql
-- 1) One auto check-in per attendance day/shift while already in (already_in; never reopen).
-- 2) Mass auto check-out at shift end (checkout_at = shift_end_utc).
-- Uses attendance_window_for_user (shift TZ + display zones). Prefers pg_cron;
-- edge attendance-schedule also exposes close_ended_shifts for hosts without pg_cron.

-- ---------------------------------------------------------------------------
-- 0) Helpers restored after attendance_rules_reset (needed by auto check-in)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_ensure_open_visit(
    p_user_id UUID,
    p_record_id UUID,
    p_date DATE,
    p_at TIMESTAMPTZ,
    p_note TEXT DEFAULT 'Check in'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.attendance_visit_segments vs
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = p_date
          AND vs.clock_out_at IS NULL
    ) THEN
        RETURN;
    END IF;

    SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id AND attendance_date = p_date;

    INSERT INTO public.attendance_visit_segments (
        user_id, attendance_record_id, attendance_date, visit_number,
        clock_in_at, notes
    ) VALUES (
        p_user_id, p_record_id, p_date, v_n,
        p_at, 'Visit ' || v_n || ' · ' || COALESCE(p_note, 'Check in')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.shift_end_timestamptz(
    p_attendance_date DATE,
    p_start_time TIME,
    p_end_time TIME,
    p_clock_in TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    v_end TIMESTAMPTZ;
BEGIN
    v_end := ((p_attendance_date::timestamp + p_end_time) AT TIME ZONE public.app_timezone());
    IF public.is_shift_overnight(p_start_time, p_end_time) THEN
        IF v_end <= COALESCE(p_clock_in, v_end - INTERVAL '1 day') THEN
            v_end := v_end + INTERVAL '1 day';
        END IF;
    END IF;
    RETURN v_end;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1) Close one user's open sessions whose shift end has passed
--    Checkout time = shift_end_utc from attendance_window_for_user
-- ---------------------------------------------------------------------------
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
    v_win RECORD;
    v_end TIMESTAMPTZ;
    v_out TIMESTAMPTZ;
    v_probe TIMESTAMPTZ;
    v_tz TEXT;
    v_start_t TIME;
    v_end_t TIME;
    n INTEGER := 0;
    v_total INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR r IN
        SELECT *
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        v_tz := COALESCE(
            NULLIF(btrim((SELECT timezone FROM public.work_shifts WHERE id = r.shift_id)), ''),
            public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id)),
            public.app_timezone(),
            'UTC'
        );

        -- Probe midday on the attendance date so overnight / past shifts resolve correctly
        v_probe := (r.attendance_date::timestamp + TIME '12:00') AT TIME ZONE v_tz;
        SELECT * INTO v_win
        FROM public.attendance_window_for_user(p_user_id, v_probe)
        LIMIT 1;

        IF COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date
           OR v_win.shift_end_utc IS NULL THEN
            SELECT * INTO v_win
            FROM public.attendance_window_for_user(p_user_id, v_now)
            LIMIT 1;
        END IF;

        IF v_win.shift_end_utc IS NOT NULL
           AND COALESCE(v_win.attendance_date, r.attendance_date) = r.attendance_date THEN
            v_end := v_win.shift_end_utc;
        ELSE
            SELECT s.start_time, s.end_time
            INTO v_start_t, v_end_t
            FROM public.get_active_shift_for_user(p_user_id, r.attendance_date) s
            LIMIT 1;
            IF v_start_t IS NULL OR v_end_t IS NULL THEN
                CONTINUE;
            END IF;
            v_end := public.shift_end_timestamptz(
                r.attendance_date, v_start_t, v_end_t, r.clock_in_at
            );
        END IF;

        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        -- Documented rule: clock out at shift end (not "now")
        v_out := GREATEST(r.clock_in_at, v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                ELSE trim(both ' |' from COALESCE(notes, '') || ' | Closed (shift ended)')
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM public.attendance_visit_segments
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

    -- Orphan open visits (day record may already show clock_out)
    FOR r IN
        SELECT DISTINCT ON (ar.id) ar.*
        FROM public.attendance_records ar
        JOIN public.attendance_visit_segments vs
          ON vs.user_id = ar.user_id
         AND vs.attendance_date = ar.attendance_date
         AND vs.clock_out_at IS NULL
        WHERE ar.user_id = p_user_id
          AND ar.status IS DISTINCT FROM 'absent'
        ORDER BY ar.id
    LOOP
        v_tz := COALESCE(
            NULLIF(btrim((SELECT timezone FROM public.work_shifts WHERE id = r.shift_id)), ''),
            public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id)),
            public.app_timezone(),
            'UTC'
        );
        v_probe := (r.attendance_date::timestamp + TIME '12:00') AT TIME ZONE v_tz;
        SELECT * INTO v_win
        FROM public.attendance_window_for_user(p_user_id, v_probe)
        LIMIT 1;

        IF v_win.shift_end_utc IS NULL THEN
            CONTINUE;
        END IF;
        v_end := v_win.shift_end_utc;
        IF v_now < v_end THEN
            CONTINUE;
        END IF;

        v_out := GREATEST(COALESCE(r.clock_out_at, v_end), v_end);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = GREATEST(clock_in_at, v_out),
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

        IF r.clock_out_at IS NULL THEN
            v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);
            UPDATE public.attendance_records SET
                clock_out_at = v_out,
                work_minutes = v_total,
                notes = CASE
                    WHEN COALESCE(notes, '') ILIKE '%shift ended%' THEN notes
                    ELSE trim(both ' |' from COALESCE(notes, '') || ' | Auto clock-out (shift ended)')
                END
            WHERE id = r.id;
        END IF;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_all_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
    n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT DISTINCT x.user_id
        FROM (
            SELECT ar.user_id
            FROM public.attendance_records ar
            WHERE ar.clock_in_at IS NOT NULL
              AND ar.clock_out_at IS NULL
              AND ar.status IS DISTINCT FROM 'absent'
            UNION
            SELECT vs.user_id
            FROM public.attendance_visit_segments vs
            WHERE vs.clock_out_at IS NULL
        ) x
    LOOP
        n := n + public.close_open_attendance_if_shift_ended(r.user_id, NULL, NULL);
    END LOOP;
    RETURN n;
END;
$$;

-- Alias used by older cron job names
CREATE OR REPLACE FUNCTION public.attendance_close_ended_windows()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.close_all_ended_shift_attendance();
END;
$$;

DROP FUNCTION IF EXISTS public.close_my_ended_shift_attendance();
CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    RETURN public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_all_ended_shift_attendance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_close_ended_windows() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_my_ended_shift_attendance() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_all_ended_shift_attendance() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_ended_windows() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_ensure_open_visit(UUID, UUID, DATE, TIMESTAMPTZ, TEXT) TO service_role;

-- Prefer pg_cron when available (every minute)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname IN ('scorr-close-ended-shifts', 'scorr-attendance-cron');
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM cron.unschedule('scorr-close-ended-shifts');
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      BEGIN
        PERFORM cron.unschedule('scorr-attendance-cron');
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END;

    PERFORM cron.schedule(
      'scorr-close-ended-shifts',
      '* * * * *',
      $cron$SELECT public.close_all_ended_shift_attendance();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Harden process_auto_attendance_event: already_in early; never reopen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(
  p_token_hash text,
  p_event text,
  p_zone_id uuid DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL,
  p_occurred_at_utc_ms bigint DEFAULT NULL,
  p_device_now_utc_ms bigint DEFAULT NULL,
  p_device_timezone text DEFAULT NULL,
  p_is_mock boolean DEFAULT false,
  p_device_id text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_client_ip text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_occurred TIMESTAMPTZ;
  v_event TEXT := lower(trim(COALESCE(p_event, '')));
  v_win RECORD;
  v_site RECORD;
  v_wifi RECORD;
  v_matched_zone UUID;
  v_matched_label TEXT;
  v_wifi_network_id UUID;
  v_match_via TEXT := NULL;
  v_wifi_ok BOOLEAN := false;
  v_gps_ok BOOLEAN := false;
  v_dist DOUBLE PRECISION;
  v_radius INTEGER;
  v_source TEXT := 'auto_wifi';
  v_checkin_start TIMESTAMPTZ;
  v_checkin_end TIMESTAMPTZ;
  v_att_date DATE;
  v_rec public.attendance_records%ROWTYPE;
  v_id UUID;
  v_any_zone BOOLEAN := false;
  v_gps_usable BOOLEAN;
BEGIN
  IF p_token_hash IS NULL OR btrim(p_token_hash) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_token', 'action', 'missing_token', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_dev
  FROM public.attendance_devices d
  WHERE d.token_hash = p_token_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token', 'action', 'invalid_token', 'stop_tracking', true);
  END IF;

  IF v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'revoked_token', 'action', 'revoked_token', 'stop_tracking', true);
  END IF;

  IF v_dev.platform = 'ios' OR lower(COALESCE(p_platform, '')) = 'ios' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'platform_disabled',
      'action', 'platform_disabled',
      'stop_tracking', true,
      'message', 'Automatic check-in is not available on iOS yet.'
    );
  END IF;

  IF v_dev.platform NOT IN ('android', 'windows', 'linux') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'platform_disabled',
      'action', 'platform_disabled',
      'stop_tracking', true
    );
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_dev.user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_gone', 'action', 'user_gone', 'stop_tracking', true);
  END IF;

  IF COALESCE(v_user.work_mode, 'office') = 'remote' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_mode_remote', 'action', 'work_mode_remote', 'stop_tracking', true);
  END IF;

  IF p_occurred_at_utc_ms IS NOT NULL AND p_occurred_at_utc_ms > 0 THEN
    v_occurred := to_timestamp(p_occurred_at_utc_ms / 1000.0);
  ELSE
    v_occurred := v_now;
  END IF;
  IF v_occurred > v_now + INTERVAL '2 minutes' THEN
    v_occurred := v_now;
  END IF;
  IF v_occurred < v_now - INTERVAL '15 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_too_old', 'action', 'event_too_old');
  END IF;

  UPDATE public.attendance_devices SET
    last_seen_at = v_now,
    device_timezone = COALESCE(NULLIF(btrim(p_device_timezone), ''), device_timezone),
    app_version = COALESCE(NULLIF(btrim(p_app_version), ''), app_version),
    last_heartbeat_at = CASE
      WHEN v_event IN ('heartbeat', 'ping', 'enter', 'wifi_connected', 'power_on') THEN v_now
      ELSE last_heartbeat_at
    END
  WHERE id = v_dev.id;

  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'mock_location', 'action', 'mock_location', 'flagged', true);
  END IF;

  -- Opportunistic: close this user's ended shift before evaluating check-in
  PERFORM public.close_open_attendance_if_shift_ended(v_dev.user_id, p_latitude, p_longitude);

  IF v_event NOT IN (
    'enter', 'ping', 'wifi_connected', 'heartbeat', 'power_on'
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'event_not_used_for_checkin',
      'message', 'This event does not trigger auto check-in.'
    );
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_occurred) LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false) OR v_win.shift_start_utc IS NULL OR v_win.shift_end_utc IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_shift',
      'action', 'no_shift',
      'message', 'No shift assigned for this time.'
    );
  END IF;

  v_checkin_start := v_win.shift_start_utc - INTERVAL '60 minutes';
  v_checkin_end := v_win.shift_end_utc;
  v_att_date := v_win.attendance_date;

  IF v_occurred < v_checkin_start OR v_occurred > v_checkin_end THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'outside_window',
      'action', 'outside_window',
      'stop_tracking', v_occurred > v_checkin_end,
      'window_start_utc', v_checkin_start,
      'window_end_utc', v_checkin_end,
      'shift_start_utc', v_win.shift_start_utc,
      'shift_end_utc', v_win.shift_end_utc,
      'server_now_utc', v_now,
      'message', 'Auto check-in only runs from 1 hour before shift start until shift end.'
    );
  END IF;

  -- Early dedup (before Wi-Fi/GPS work): already in → ignore further auto check-ins
  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_dev.user_id AND attendance_date = v_att_date;

  IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_in',
      'reason', 'already_in',
      'ignored', true,
      'suppress_checkin', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'window_end_utc', v_checkin_end,
      'message', 'Already checked in for this shift day.'
    );
  END IF;

  -- Already completed this attendance day (checked out) → do not re-open
  IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_done',
      'reason', 'already_done',
      'ignored', true,
      'suppress_checkin', true,
      'stop_tracking', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'message', 'Attendance for this shift day is already complete.'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_dev.user_id
      AND vs.attendance_date = v_att_date
      AND vs.clock_out_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_in',
      'reason', 'already_in',
      'ignored', true,
      'suppress_checkin', true,
      'attendance_date', v_att_date,
      'window_end_utc', v_checkin_end,
      'message', 'Already checked in for this shift day.'
    );
  END IF;

  -- Ordered check-in decision (not random OR):
  --   1) Office Wi-Fi on any assigned location's saved networks → check in
  --   2) Else GPS inside that location's radius (location on) → check in
  --   3) Else no check-in
  v_gps_usable := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
    AND (p_accuracy_m IS NULL OR p_accuracy_m <= 100);

  -- Pass 1: Wi-Fi first across assigned locations
  FOR v_site IN
    SELECT * FROM public.get_work_sites_for_user(v_dev.user_id)
  LOOP
    IF v_site.office_location_id IS NULL THEN
      CONTINUE;
    END IF;
    v_any_zone := true;

    IF p_zone_id IS NOT NULL AND p_zone_id IS DISTINCT FROM v_site.office_location_id THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_wifi
    FROM public.attendance_match_office_wifi(
      v_site.office_location_id, p_client_ip, p_ssid, p_bssid
    );
    IF COALESCE(v_wifi.matched, false) THEN
      v_wifi_ok := true;
      v_gps_ok := false;
      v_matched_zone := v_site.office_location_id;
      v_matched_label := COALESCE(v_wifi.network_label, v_site.site_name);
      v_wifi_network_id := v_wifi.network_id;
      v_match_via := 'wifi';
      v_source := 'auto_wifi';
      EXIT;
    END IF;
  END LOOP;

  -- Pass 2: only if not on office Wi-Fi → office radius (GPS)
  IF v_matched_zone IS NULL AND v_gps_usable THEN
    FOR v_site IN
      SELECT * FROM public.get_work_sites_for_user(v_dev.user_id)
    LOOP
      IF v_site.office_location_id IS NULL THEN
        CONTINUE;
      END IF;
      v_any_zone := true;

      IF p_zone_id IS NOT NULL AND p_zone_id IS DISTINCT FROM v_site.office_location_id THEN
        CONTINUE;
      END IF;

      IF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN
        CONTINUE;
      END IF;

      v_radius := GREATEST(COALESCE(v_site.radius_meters, 1), 1);
      v_dist := public.haversine_meters(
        p_latitude, p_longitude, v_site.latitude, v_site.longitude
      );
      IF v_dist IS NOT NULL AND v_dist <= v_radius THEN
        v_wifi_ok := false;
        v_gps_ok := true;
        v_matched_zone := v_site.office_location_id;
        v_matched_label := v_site.site_name;
        v_wifi_network_id := NULL;
        v_match_via := 'gps';
        v_source := 'auto_gps';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF NOT v_any_zone THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_zone',
      'action', 'no_zone',
      'message', 'No office location assigned.'
    );
  END IF;

  IF v_matched_zone IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', CASE
        WHEN NOT v_gps_usable AND NULLIF(btrim(COALESCE(p_ssid, '')), '') IS NULL
          THEN 'need_fresh_location'
        WHEN NOT v_gps_usable THEN 'not_on_office_wifi'
        ELSE 'outside_radius'
      END,
      'action', CASE
        WHEN NOT v_gps_usable AND NULLIF(btrim(COALESCE(p_ssid, '')), '') IS NULL
          THEN 'need_fresh_location'
        WHEN NOT v_gps_usable THEN 'not_on_office_wifi'
        ELSE 'outside_radius'
      END,
      'decision_order', 'wifi_then_radius',
      'message', 'Not on office Wi-Fi and not inside the office radius.'
    );
  END IF;

  -- Insert only when no day row yet; never clear an existing clock_out_at
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at,
    wifi_network_id, wifi_network_label, shift_id
  )
  VALUES (
    v_dev.user_id, v_att_date, 'present', 'approved'::public.approval_status, v_dev.user_id,
    v_occurred, NULL, NULL, v_source, v_dev.user_id, v_now,
    v_wifi_network_id, CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END, v_win.shift_id
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE
  SET status = 'present',
      approval_status = 'approved'::public.approval_status,
      marked_by = v_dev.user_id,
      reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_dev.user_id),
      reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
      clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
      -- Keep existing clock_out_at (do not reopen)
      clock_out_at = public.attendance_records.clock_out_at,
      attendance_source = COALESCE(public.attendance_records.attendance_source, EXCLUDED.attendance_source),
      wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
      wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
      shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
  WHERE public.attendance_records.clock_in_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Conflict row already had clock_in (race) → treat as already_in / already_done
    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_dev.user_id AND attendance_date = v_att_date;
    IF v_rec.clock_out_at IS NULL AND v_rec.clock_in_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_in',
        'reason', 'already_in',
        'ignored', true,
        'suppress_checkin', true,
        'attendance_record_id', v_rec.id,
        'attendance_date', v_att_date,
        'message', 'Already checked in for this shift day.'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_done',
      'reason', 'already_done',
      'ignored', true,
      'suppress_checkin', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'message', 'Attendance for this shift day is already complete.'
    );
  END IF;

  PERFORM public.attendance_ensure_open_visit(
    v_dev.user_id, v_id, v_att_date, v_occurred,
    CASE
      WHEN v_match_via = 'gps' THEN 'Auto GPS check-in (after Wi-Fi miss)'
      ELSE 'Auto Wi-Fi check-in'
    END
  );

  BEGIN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      zone_id, latitude, longitude, accuracy_m, ssid, bssid, occurred_at,
      wifi_network_id, wifi_network_label, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, true, 'clock_in', p_client_ip,
      v_matched_zone, p_latitude, p_longitude, p_accuracy_m,
      NULLIF(btrim(COALESCE(p_ssid, '')), ''), NULLIF(lower(btrim(COALESCE(p_bssid, ''))), ''),
      v_occurred, v_wifi_network_id, CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END,
      jsonb_build_object(
        'platform', v_dev.platform,
        'rule', 'wifi_or_radius_auto_checkin',
        'match_via', v_match_via,
        'distance_m', v_dist
      )
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_in',
    'reason', 'wifi_or_radius_auto_checkin',
    'match_via', v_match_via,
    'attendance_source', v_source,
    'attendance_record_id', v_id,
    'attendance_date', v_att_date,
    'zone_id', v_matched_zone,
    'wifi_network_id', v_wifi_network_id,
    'wifi_network_label', CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END,
    'distance_m', v_dist,
    'suppress_checkin', true,
    'window_start_utc', v_checkin_start,
    'window_end_utc', v_checkin_end,
    'decision_order', 'wifi_then_radius',
    'message', CASE
      WHEN v_match_via = 'gps' THEN 'Checked in inside the office radius (not on office Wi-Fi).'
      ELSE 'Checked in on office Wi-Fi.'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  text, text, uuid, double precision, double precision, double precision,
  text, text, bigint, bigint, text, boolean, text, text, text, text
) TO authenticated, service_role;

-- Opportunistic self-close when devices/pollers fetch schedule
CREATE OR REPLACE FUNCTION public.attendance_schedule_by_token(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
BEGIN
  SELECT * INTO v_dev FROM public.attendance_devices WHERE token_hash = p_token_hash LIMIT 1;
  IF NOT FOUND OR v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_or_revoked_token', 'stop_tracking', true);
  END IF;

  IF v_dev.platform = 'ios' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'platform_disabled',
      'stop_tracking', true,
      'message', 'Automatic check-in is not available on iOS yet.'
    );
  END IF;

  UPDATE public.attendance_devices SET last_seen_at = timezone('utc', now()) WHERE id = v_dev.id;
  PERFORM public.close_open_attendance_if_shift_ended(v_dev.user_id, NULL, NULL);

  RETURN public.attendance_schedule_for_user(v_dev.user_id, timezone('utc', now()), 7)
    || jsonb_build_object('user_id', v_dev.user_id, 'device_row_id', v_dev.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_attendance_schedule()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.close_open_attendance_if_shift_ended(auth.uid(), NULL, NULL);
  RETURN public.attendance_schedule_for_user(auth.uid(), timezone('utc', now()), 7);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_schedule_by_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_schedule() TO authenticated;

NOTIFY pgrst, 'reload schema';
