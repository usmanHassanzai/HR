-- Auto attendance priority over manual (mobile + laptop enrolled).
-- Builds on FIX_office_radius_exact_checkout_2026-10-08 (exact radius).
--
-- Blockers fixed:
-- 1) Laptop heartbeat off office Wi-Fi kept presence_state='present' while
--    refreshing last_heartbeat_at → R54 blocked phone auto check-out forever.
-- 2) R54 / stale-close treated laptop last_heartbeat_at as "still present";
--    only last_presence_at (real office match) counts.
-- 3) Off-network laptop heartbeat/power_on/ping clears present and can
--    immediate-checkout when no other device is present.
-- Manual clock-in/out RPCs remain unchanged (override / edge cases).

-- R40 rewrite: leave when distance > configured radius (2 consecutive outsides).
-- No distance padding beyond the admin-configured radius.
CREATE OR REPLACE FUNCTION public.geo_confirm_left_site(
    p_distance DOUBLE PRECISION,
    p_effective_radius DOUBLE PRECISION,
    p_prev_inside BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_distance IS NULL OR p_effective_radius IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_distance <= p_effective_radius THEN
        RETURN FALSE;
    END IF;
    -- Outside exact radius: confirm on 2 consecutive outside readings (anti GPS flicker).
    RETURN p_prev_inside IS FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_now()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v TEXT := nullif(current_setting('attendance.test_now', true), '');
BEGIN
  IF v IS NOT NULL THEN
    RETURN v::TIMESTAMPTZ;
  END IF;
  RETURN timezone('utc', now());
END;
$$;

ALTER TABLE public.attendance_devices
  ADD COLUMN IF NOT EXISTS gps_outside_streak INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(
  p_token_hash text,
  p_event text,
  p_zone_id uuid DEFAULT NULL::uuid,
  p_latitude double precision DEFAULT NULL::double precision,
  p_longitude double precision DEFAULT NULL::double precision,
  p_accuracy_m double precision DEFAULT NULL::double precision,
  p_ssid text DEFAULT NULL::text,
  p_bssid text DEFAULT NULL::text,
  p_occurred_at_utc_ms bigint DEFAULT NULL::bigint,
  p_device_now_utc_ms bigint DEFAULT NULL::bigint,
  p_device_timezone text DEFAULT NULL::text,
  p_is_mock boolean DEFAULT false,
  p_device_id text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_app_version text DEFAULT NULL::text,
  p_client_ip text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
      -- Laptop / desktop: power_off immediate; Wi-Fi leave + GPS outside → immediate.
      -- Off-office heartbeat/power_on must clear sticky "present" (R54 auto priority).
      IF v_event IN ('heartbeat', 'power_on', 'ping')
         AND NOT v_wifi_ok AND NOT v_gps_ok AND NOT v_laptop_ok THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
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
$function$;

-- Stale close: grace leave + auto priority (presence via last_presence_at only).
-- Preserves FIX_visit_out_before_in guard: skip when open visit is newer than last presence.
CREATE OR REPLACE FUNCTION public.attendance_close_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := public.attendance_now();
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
  v_any_present BOOLEAN;
  v_out TIMESTAMPTZ;
  v_has_open BOOLEAN;
  v_local_time TEXT;
  v_tz TEXT;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_source IN ('auto_gps', 'auto_wifi', 'auto_laptop')
      AND EXISTS (
        SELECT 1
        FROM public.attendance_devices d
        WHERE d.user_id = ar.user_id
          AND d.revoked_at IS NULL
      )
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    -- Real office presence only (not laptop heartbeats off Wi-Fi).
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = r.user_id
        AND d.revoked_at IS NULL
        AND d.presence_state = 'present'
        AND d.last_presence_at IS NOT NULL
        AND d.last_presence_at > v_now - INTERVAL '15 minutes'
    ) INTO v_any_present;

    IF v_any_present THEN
      CONTINUE;
    END IF;

    SELECT MAX(d.last_presence_at) INTO v_last
    FROM public.attendance_devices d
    WHERE d.user_id = r.user_id AND d.revoked_at IS NULL;

    IF v_last IS NULL OR v_last > v_now - INTERVAL '15 minutes' THEN
      CONTINUE;
    END IF;

    v_last := LEAST(v_last, COALESCE(v_win.window_end_utc, v_last));

    -- Geo/manual re-enter after device left: open visit is newer than last presence.
    IF EXISTS (
      SELECT 1
      FROM public.attendance_visit_segments vs
      WHERE vs.user_id = r.user_id
        AND vs.attendance_date = r.attendance_date
        AND vs.clock_out_at IS NULL
        AND vs.clock_in_at > v_last
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.attendance_visit_segments SET
      clock_out_at = GREATEST(clock_in_at, v_last),
      work_minutes = GREATEST(
        0,
        (EXTRACT(EPOCH FROM (GREATEST(clock_in_at, v_last) - clock_in_at)) / 60)::INTEGER
      ),
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Auto close: 15m no presence%' THEN notes
        ELSE COALESCE(notes, '') || ' | Auto close: 15m no presence (leave unconfirmed)'
      END
    WHERE user_id = r.user_id
      AND attendance_date = r.attendance_date
      AND clock_out_at IS NULL
      AND clock_in_at <= v_last;

    SELECT EXISTS (
      SELECT 1
      FROM public.attendance_visit_segments vs
      WHERE vs.user_id = r.user_id
        AND vs.attendance_date = r.attendance_date
        AND vs.clock_out_at IS NULL
    ) INTO v_has_open;

    IF v_has_open THEN
      CONTINUE;
    END IF;

    SELECT MAX(vs.clock_out_at)
    INTO v_out
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = r.user_id
      AND vs.attendance_date = r.attendance_date
      AND vs.clock_out_at IS NOT NULL
      AND vs.clock_out_at >= vs.clock_in_at;

    v_out := COALESCE(v_out, GREATEST(r.clock_in_at, v_last));
    v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_out);

    UPDATE public.attendance_records SET
      clock_out_at = v_out,
      work_minutes = v_mins,
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%Auto close: 15m no presence%' THEN notes
        ELSE COALESCE(notes, '') || ' | Auto close: 15m no presence (leave unconfirmed)'
      END
    WHERE id = r.id;

    BEGIN
      SELECT COALESCE(
        (SELECT d.device_timezone FROM public.attendance_devices d
         WHERE d.user_id = r.user_id AND d.revoked_at IS NULL
         ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 1),
        c.timezone,
        'UTC'
      )
      INTO v_tz
      FROM public.users u
      JOIN public.companies c ON c.id = u.company_id
      WHERE u.id = r.user_id;

      v_local_time := trim(to_char(v_out AT TIME ZONE COALESCE(v_tz, 'UTC'), 'FMHH12:MI AM'));
    EXCEPTION WHEN OTHERS THEN
      v_local_time := NULL;
    END;

    BEGIN
      PERFORM public.create_system_notification(
        r.user_id,
        'Checked out',
        'Checked out at ' || COALESCE(v_local_time, '') || ' — you left the office.',
        'info'::public.notification_type,
        jsonb_build_object('kind', 'auto_checkout_grace', 'occurred_at', v_out)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_now() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  text, text, uuid, double precision, double precision, double precision,
  text, text, bigint, bigint, text, boolean, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;

NOTIFY pgrst, 'reload schema';
