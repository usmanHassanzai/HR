-- FIX_auto_reentry_session_probe_2026-10-14.sql
-- Harden mid-shift re-entry after checkout:
-- 1) Early checkout / already-checked-out responses expose resume_checkin for clients.
-- 2) process_auto: when matching fails but session is closed, keep session_open=false
--    and resume_checkin=true so clients clear local suppress and keep probing.
-- 3) Log non-spam outcomes (already_in / outside / no match) lightly for diagnostics.

CREATE OR REPLACE FUNCTION public.attendance_device_early_checkout(
  p_user_id uuid,
  p_device_row_id uuid,
  p_company_id uuid,
  p_platform text,
  p_event text,
  p_occurred timestamptz,
  p_now timestamptz,
  p_zone_id uuid DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL,
  p_client_ip text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_rec public.attendance_records%ROWTYPE;
  v_att_date DATE;
  v_out TIMESTAMPTZ;
  v_total INTEGER;
  v_tz TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_gone', 'action', 'user_gone');
  END IF;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(p_user_id, p_occurred)
  LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false)
     OR v_win.shift_start_utc IS NULL
     OR v_win.shift_end_utc IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_shift',
      'action', 'no_shift',
      'message', 'No shift assigned for this time.'
    );
  END IF;

  v_att_date := v_win.attendance_date;

  IF p_occurred < v_win.shift_start_utc THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'checkout_before_shift_start',
      'action', 'checkout_before_shift_start',
      'shift_start_utc', v_win.shift_start_utc,
      'shift_end_utc', v_win.shift_end_utc,
      'server_now_utc', p_now,
      'message', 'Check-out is only allowed after shift start and before shift end.'
    );
  END IF;

  IF p_occurred >= v_win.shift_end_utc THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'checkout_after_shift_end',
      'action', 'checkout_after_shift_end',
      'stop_tracking', true,
      'shift_start_utc', v_win.shift_start_utc,
      'shift_end_utc', v_win.shift_end_utc,
      'server_now_utc', p_now,
      'message', 'Shift has ended. Open sessions are closed at shift end automatically.'
    );
  END IF;

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = p_user_id AND attendance_date = v_att_date;

  IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'not_checked_in',
      'ignored', true,
      'session_open', false,
      'suppress_checkin', false,
      'resume_checkin', true,
      'message', 'No open check-in to close.'
    );
  END IF;

  -- Already closed → allow client to try re-entry check-in (do not stop tracking)
  IF v_rec.clock_out_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'ignored',
      'reason', 'already_checked_out',
      'ignored', true,
      'session_open', false,
      'suppress_checkin', false,
      'resume_checkin', true,
      'stop_tracking', false,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'message', 'Already checked out; re-entry check-in is allowed if back on office Wi-Fi or radius.'
    );
  END IF;

  v_out := GREATEST(v_rec.clock_in_at, p_occurred);
  IF v_out >= v_win.shift_end_utc THEN
    v_out := v_win.shift_end_utc - INTERVAL '1 second';
    IF v_out < v_rec.clock_in_at THEN
      v_out := v_rec.clock_in_at;
    END IF;
  END IF;

  UPDATE public.attendance_visit_segments SET
    clock_out_at = GREATEST(clock_in_at, v_out),
    clock_out_lat = COALESCE(p_latitude, clock_out_lat),
    clock_out_lng = COALESCE(p_longitude, clock_out_lng),
    work_minutes = GREATEST(
      0,
      (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_out) - clock_in_at)) / 60)::INTEGER
    ),
    notes = CASE
      WHEN COALESCE(notes, '') ILIKE '%early check-out%' THEN notes
      ELSE trim(both ' |' from COALESCE(notes, '') || ' | Early check-out (any location)')
    END
  WHERE user_id = p_user_id
    AND attendance_date = v_att_date
    AND clock_out_at IS NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id AND attendance_date = v_att_date
  ) THEN
    INSERT INTO public.attendance_visit_segments (
      user_id, attendance_record_id, attendance_date, visit_number,
      clock_in_at, clock_out_at, clock_out_lat, clock_out_lng, work_minutes, notes
    ) VALUES (
      p_user_id, v_rec.id, v_att_date, 1,
      v_rec.clock_in_at, v_out, p_latitude, p_longitude,
      GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_rec.clock_in_at)) / 60)::INTEGER),
      'Early check-out (any location)'
    );
  END IF;

  v_total := public.attendance_day_total_minutes(p_user_id, v_att_date, v_out);

  UPDATE public.attendance_records SET
    clock_out_at = v_out,
    clock_out_lat = COALESCE(p_latitude, clock_out_lat),
    clock_out_lng = COALESCE(p_longitude, clock_out_lng),
    work_minutes = v_total,
    notes = CASE
      WHEN COALESCE(notes, '') ILIKE '%early check-out%' THEN notes
      ELSE trim(both ' |' from COALESCE(notes, '') || ' | Early check-out (any location)')
    END
  WHERE id = v_rec.id;

  BEGIN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      zone_id, latitude, longitude, accuracy_m, ssid, bssid, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'clock_out', p_client_ip,
      p_zone_id, p_latitude, p_longitude, p_accuracy_m,
      NULLIF(btrim(COALESCE(p_ssid, '')), ''),
      NULLIF(lower(btrim(COALESCE(p_bssid, ''))), ''),
      p_occurred,
      jsonb_build_object(
        'platform', p_platform,
        'rule', 'early_checkout_any_location',
        'window', 'shift_start_to_end',
        'location_required', false,
        'reentry_allowed', true
      )
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  v_tz := COALESCE(
    NULLIF(btrim((SELECT timezone FROM public.work_shifts WHERE id = v_rec.shift_id)), ''),
    public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id)),
    public.app_timezone(),
    'UTC'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_out',
    'reason', 'early_checkout_any_location',
    'attendance_record_id', v_rec.id,
    'attendance_date', v_att_date,
    'clock_out_at', v_out,
    'local_time', to_char(timezone(v_tz, v_out), 'HH24:MI'),
    'shift_start_utc', v_win.shift_start_utc,
    'shift_end_utc', v_win.shift_end_utc,
    'session_open', false,
    'suppress_checkin', false,
    'resume_checkin', true,
    'stop_tracking', false,
    'location_required', false,
    'message', 'Checked out during the shift. Returning to office Wi-Fi or radius will check you in again.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_device_early_checkout(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  uuid, double precision, double precision, double precision,
  text, text, text
) TO service_role;

-- ---------------------------------------------------------------------------
-- process_auto: same re-entry logic + resume_checkin on closed-session misses
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
  v_was_closed BOOLEAN := false;
  v_miss_reason TEXT;
  v_miss_action TEXT;
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

  PERFORM public.close_open_attendance_if_shift_ended(v_dev.user_id, p_latitude, p_longitude);

  IF v_event IN (
    'exit', 'wifi_disconnected', 'leave', 'checkout'
  ) THEN
    RETURN public.attendance_device_early_checkout(
      v_dev.user_id,
      v_dev.id,
      v_dev.company_id,
      v_dev.platform,
      v_event,
      v_occurred,
      v_now,
      p_zone_id,
      p_latitude,
      p_longitude,
      p_accuracy_m,
      p_ssid,
      p_bssid,
      p_client_ip
    );
  END IF;

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
      'session_open', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'window_end_utc', v_checkin_end,
      'message', 'Already checked in (open session).'
    );
  END IF;

  v_was_closed := FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NOT NULL;

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
      'session_open', true,
      'attendance_date', v_att_date,
      'window_end_utc', v_checkin_end,
      'message', 'Already checked in (open visit).'
    );
  END IF;

  v_gps_usable := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
    AND (p_accuracy_m IS NULL OR p_accuracy_m <= 100);

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
      'session_open', false,
      'resume_checkin', true,
      'message', 'No office location assigned.'
    );
  END IF;

  IF v_matched_zone IS NULL THEN
    v_miss_reason := CASE
      WHEN NOT v_gps_usable AND NULLIF(btrim(COALESCE(p_ssid, '')), '') IS NULL
        THEN 'need_fresh_location'
      WHEN NOT v_gps_usable THEN 'not_on_office_wifi'
      ELSE 'outside_radius'
    END;
    v_miss_action := v_miss_reason;

    BEGIN
      INSERT INTO public.attendance_events_log (
        company_id, user_id, device_id, event, accepted, reason_code, client_ip,
        zone_id, latitude, longitude, accuracy_m, ssid, bssid, occurred_at, payload
      ) VALUES (
        v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, v_miss_reason, p_client_ip,
        p_zone_id, p_latitude, p_longitude, p_accuracy_m,
        NULLIF(btrim(COALESCE(p_ssid, '')), ''),
        NULLIF(lower(btrim(COALESCE(p_bssid, ''))), ''),
        v_occurred,
        jsonb_build_object(
          'platform', v_dev.platform,
          'rule', 'wifi_or_radius_auto_checkin',
          'session_closed', v_was_closed,
          'decision_order', 'wifi_then_radius'
        )
      );
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_miss_reason,
      'action', v_miss_action,
      'decision_order', 'wifi_then_radius',
      'office_wifi_only', true,
      'session_open', false,
      'suppress_checkin', false,
      'resume_checkin', true,
      'message', 'Not on configured office Wi-Fi (assigned location) and not inside the office radius. Public/arbitrary Wi-Fi does not count.'
    );
  END IF;

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
      clock_out_at = NULL,
      clock_out_lat = NULL,
      clock_out_lng = NULL,
      work_minutes = NULL,
      attendance_source = CASE
        WHEN public.attendance_records.clock_out_at IS NOT NULL THEN EXCLUDED.attendance_source
        ELSE COALESCE(public.attendance_records.attendance_source, EXCLUDED.attendance_source)
      END,
      wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
      wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
      shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
  WHERE public.attendance_records.clock_in_at IS NULL
     OR public.attendance_records.clock_out_at IS NOT NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
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
        'session_open', true,
        'attendance_record_id', v_rec.id,
        'attendance_date', v_att_date,
        'message', 'Already checked in (open session).'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_conflict',
      'reason', 'checkin_conflict',
      'attendance_date', v_att_date,
      'message', 'Could not open attendance session.'
    );
  END IF;

  PERFORM public.attendance_ensure_open_visit(
    v_dev.user_id, v_id, v_att_date, v_occurred,
    CASE
      WHEN v_was_closed AND v_match_via = 'gps' THEN 'Auto re-entry GPS check-in (after Wi-Fi miss)'
      WHEN v_was_closed THEN 'Auto re-entry Wi-Fi check-in'
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
        'distance_m', v_dist,
        'reentry', v_was_closed
      )
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_in',
    'reason', CASE
      WHEN v_was_closed THEN 'wifi_or_radius_reentry'
      ELSE 'wifi_or_radius_auto_checkin'
    END,
    'match_via', v_match_via,
    'attendance_source', v_source,
    'attendance_record_id', v_id,
    'attendance_date', v_att_date,
    'zone_id', v_matched_zone,
    'wifi_network_id', v_wifi_network_id,
    'wifi_network_label', CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END,
    'distance_m', v_dist,
    'reentry', v_was_closed,
    'session_open', true,
    'suppress_checkin', true,
    'window_start_utc', v_checkin_start,
    'window_end_utc', v_checkin_end,
    'decision_order', 'wifi_then_radius',
    'office_wifi_only', true,
    'message', CASE
      WHEN v_was_closed AND v_match_via = 'gps' THEN 'Checked in again inside the office radius.'
      WHEN v_was_closed THEN 'Checked in again on configured office Wi-Fi.'
      WHEN v_match_via = 'gps' THEN 'Checked in inside the office radius (not on configured office Wi-Fi).'
      ELSE 'Checked in on configured office Wi-Fi (radius not required).'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  text, text, uuid, double precision, double precision, double precision,
  text, text, bigint, bigint, text, boolean, text, text, text, text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
