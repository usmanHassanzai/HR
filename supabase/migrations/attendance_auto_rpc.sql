-- attendance_auto_rpc.sql
-- R55 / J: device-token auto attendance event processing (security definer).
-- Edge function auto-attendance-event calls this after hashing the token.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.attendance_hash_device_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.attendance_ip_in_cidrs(p_ip TEXT, p_cidrs TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c TEXT;
  host TEXT;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' OR p_cidrs IS NULL THEN
    RETURN false;
  END IF;
  -- Exact match or prefix match for CIDR strings (simple, no inet family mix issues)
  FOREACH c IN ARRAY p_cidrs LOOP
    c := btrim(c);
    IF c = '' THEN CONTINUE; END IF;
    host := split_part(c, '/', 1);
    IF p_ip = host OR p_ip = c THEN
      RETURN true;
    END IF;
    -- CIDR: compare as inet when both parse
    BEGIN
      IF p_ip::inet <<= c::inet THEN
        RETURN true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_device_any_present(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND d.last_heartbeat_at IS NOT NULL
      AND d.last_heartbeat_at > timezone('utc', now()) - INTERVAL '15 minutes'
      AND COALESCE((d.last_seen_at IS NOT NULL), true)
  );
$$;

-- Track per-device presence state for multi-device checkout (R54)
ALTER TABLE public.attendance_devices
  ADD COLUMN IF NOT EXISTS presence_state TEXT
    CHECK (presence_state IS NULL OR presence_state IN ('present', 'left', 'unknown')),
  ADD COLUMN IF NOT EXISTS last_presence_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_zone_id UUID,
  ADD COLUMN IF NOT EXISTS last_matched_method TEXT;

CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(
  p_token_hash TEXT,
  p_event TEXT,
  p_zone_id UUID DEFAULT NULL,
  p_latitude DOUBLE PRECISION DEFAULT NULL,
  p_longitude DOUBLE PRECISION DEFAULT NULL,
  p_accuracy_m DOUBLE PRECISION DEFAULT NULL,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL,
  p_occurred_at_utc_ms BIGINT DEFAULT NULL,
  p_device_now_utc_ms BIGINT DEFAULT NULL,
  p_device_timezone TEXT DEFAULT NULL,
  p_is_mock BOOLEAN DEFAULT false,
  p_device_id TEXT DEFAULT NULL,
  p_platform TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_client_ip TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_corr RECORD;
  v_win RECORD;
  v_event TEXT := lower(trim(COALESCE(p_event, '')));
  v_zone public.office_locations%ROWTYPE;
  v_dist DOUBLE PRECISION;
  v_eff_radius DOUBLE PRECISION;
  v_gps_ok BOOLEAN := false;
  v_wifi_ok BOOLEAN := false;
  v_wifi_ssid_only BOOLEAN := false;
  v_laptop_ok BOOLEAN := false;
  v_present BOOLEAN := false;
  v_left BOOLEAN := false;
  v_method TEXT;
  v_source TEXT;
  v_action TEXT := 'none';
  v_reason TEXT;
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
  v_stop BOOLEAN := false;
  v_log_id UUID;
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

  -- Skew correction
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

  -- Feature gates
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

  -- Mock location
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

  -- Window (server time for "now" gating; event time for acceptance)
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

  -- Late queued events: corrected time inside W and not > 15 min older than server now
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

  -- Zone
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

  -- GPS presence
  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL
     AND v_zone.latitude IS NOT NULL AND v_zone.longitude IS NOT NULL THEN
    v_dist := public.haversine_meters(p_latitude, p_longitude, v_zone.latitude, v_zone.longitude);
    v_eff_radius := COALESCE(v_zone.radius_meters, 150)::DOUBLE PRECISION
      + LEAST(COALESCE(p_accuracy_m, 0), 100);
    v_gps_ok := v_dist <= v_eff_radius;
  END IF;

  -- Wi-Fi presence: public IP required; BSSID if configured; SSID alone never enough
  IF cardinality(COALESCE(v_zone.public_ip_cidrs, '{}')) > 0
     AND public.attendance_ip_in_cidrs(p_client_ip, v_zone.public_ip_cidrs) THEN
    IF cardinality(COALESCE(v_zone.wifi_bssids, '{}')) > 0 THEN
      v_wifi_ok := (
        p_bssid IS NOT NULL
        AND lower(btrim(p_bssid)) = ANY (v_zone.wifi_bssids)
      );
    ELSIF cardinality(COALESCE(v_zone.wifi_ssids, '{}')) > 0 THEN
      -- SSID configured without BSSID: still require IP (already true) + SSID match
      v_wifi_ok := (
        p_ssid IS NOT NULL
        AND btrim(p_ssid) = ANY (v_zone.wifi_ssids)
      );
    ELSE
      -- IP allowlist only
      v_wifi_ok := true;
    END IF;
  ELSIF p_ssid IS NOT NULL
        AND cardinality(COALESCE(v_zone.wifi_ssids, '{}')) > 0
        AND btrim(p_ssid) = ANY (v_zone.wifi_ssids)
        AND NOT public.attendance_ip_in_cidrs(p_client_ip, COALESCE(v_zone.public_ip_cidrs, '{}')) THEN
    v_wifi_ssid_only := true;
  END IF;

  -- Laptop present = power_on / heartbeat while on office network (wifi or IP)
  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;

  -- Detection mode
  IF v_zone.detection_mode = 'gps_only' THEN
    v_present := v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat');
    v_left := (NOT v_gps_ok) AND v_event IN ('exit', 'ping');
  ELSIF v_zone.detection_mode = 'wifi_only' THEN
    v_present := v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter');
    v_left := (NOT v_wifi_ok) AND v_event IN ('wifi_disconnected', 'power_off', 'exit');
  ELSE
    -- gps_or_wifi
    v_present := (
      (v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat'))
      OR (v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter'))
      OR (v_laptop_ok)
    );
    v_left := (
      v_event IN ('exit', 'wifi_disconnected', 'power_off')
      OR ((NOT v_gps_ok) AND (NOT v_wifi_ok) AND v_event = 'ping')
    );
  END IF;

  IF v_event = 'power_off' THEN
    v_left := true;
    v_present := false;
  END IF;

  IF v_wifi_ssid_only THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      ssid, bssid, skew_ms, clock_flagged, zone_id, occurred_at, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'fake_hotspot_suspected', p_client_ip,
      p_ssid, p_bssid, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, v_corr.occurred_at,
      jsonb_build_object('flag', 'ssid_matched_ip_or_bssid_failed')
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

  -- Duplicate ignore same user/zone within 5 min
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_events_log e
    WHERE e.user_id = v_dev.user_id
      AND e.zone_id IS NOT DISTINCT FROM v_zone.id
      AND e.event = v_event
      AND e.accepted = true
      AND e.created_at > v_now - INTERVAL '5 minutes'
  ) INTO v_dup;

  IF v_dup AND v_event NOT IN ('heartbeat') THEN
    RETURN jsonb_build_object('ok', true, 'action', 'duplicate_ignored', 'reason', 'duplicate_within_5m');
  END IF;

  -- Update this device presence
  IF v_present THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_zone_id = v_zone.id,
      last_matched_method = v_method,
      last_heartbeat_at = v_now
    WHERE id = v_dev.id;
  ELSIF v_left OR v_event IN ('exit', 'wifi_disconnected', 'power_off') THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id
    WHERE id = v_dev.id;
  ELSIF v_event = 'heartbeat' AND v_wifi_ok THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_heartbeat_at = v_now,
      last_matched_method = COALESCE(v_method, last_matched_method)
    WHERE id = v_dev.id;
    v_present := true;
  END IF;

  -- Load open record
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
    ELSE
      INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
        reviewed_by, reviewed_at, presence_method
      ) VALUES (
        v_dev.user_id, v_att_date, 'present', 'approved', v_dev.user_id,
        v_corr.occurred_at, p_latitude, p_longitude, v_source, v_win.shift_id,
        'Auto check-in (' || COALESCE(v_method, 'auto') || ') at ' || COALESCE(v_zone.name, 'office'),
        v_dev.user_id, v_now, v_method
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
        site_name = COALESCE(site_name, v_zone.name)
      WHERE user_id = v_dev.user_id
        AND attendance_date = v_att_date
        AND clock_out_at IS NULL;
      v_action := 'clock_in';
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out only if ALL enrolled devices report left (R54)
  -- Immediate for power_off; Wi-Fi/GPS leave uses 15-min rule via cron (R69)
  --------------------------------------------------------------------------
  ELSIF v_left AND v_event = 'power_off' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_dev.user_id
        AND d.revoked_at IS NULL
        AND d.id <> v_dev.id
        AND d.presence_state = 'present'
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
          work_minutes = v_seg_mins,
          notes = COALESCE(notes, '') || ' | Auto laptop power-off'
        WHERE id = v_visit.id;
      END IF;
      v_total := public.attendance_day_total_minutes(v_dev.user_id, v_att_date, v_corr.occurred_at);
      UPDATE public.attendance_records SET
        clock_out_at = v_corr.occurred_at,
        work_minutes = v_total,
        notes = COALESCE(notes, '') || ' | Auto laptop power-off'
      WHERE id = v_rec.id;
      v_action := 'clock_out';
    ELSE
      v_action := CASE WHEN v_other_present THEN 'device_left_others_present' ELSE 'no_open_visit' END;
    END IF;

  ELSIF v_left AND v_event IN ('exit', 'wifi_disconnected') THEN
    -- Mark left; actual checkout deferred to cron after 15 min no presence (R69)
    v_action := 'presence_left_pending';
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    matched_method, skew_ms, clock_flagged, zone_id, latitude, longitude, accuracy_m,
    ssid, bssid, occurred_at, payload
  ) VALUES (
    v_dev.company_id, v_dev.user_id, v_dev.id, v_event, true, v_action, p_client_ip,
    v_method, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, p_latitude, p_longitude, p_accuracy_m,
    p_ssid, p_bssid, v_corr.occurred_at,
    jsonb_build_object(
      'app_version', p_app_version,
      'platform', p_platform,
      'clock_flagged', v_corr.clock_flagged
    )
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
    'event_log_id', v_log_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_hash_device_token(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  TEXT, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT, TEXT, BIGINT, BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';
