-- Check-in: office Wi-Fi alone when GPS off/unusable (replaces Rule 1+7 for check-in only).
-- Check-out / windows / Rule 6 unchanged. Re-runnable; replaces live functions (no copies).

-- ---------------------------------------------------------------------------
-- Shared presence check
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_office_presence_check(
  uuid, double precision, double precision, double precision, boolean, text, text
);

CREATE OR REPLACE FUNCTION public.attendance_office_presence_check(
  p_user_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_is_mock boolean DEFAULT false,
  p_client_ip text DEFAULT NULL,
  p_mode text DEFAULT 'check_in'
)
RETURNS TABLE (
  ok boolean,
  reason text,
  on_wifi boolean,
  gps_usable boolean,
  inside_radius boolean,
  outside_radius boolean,
  match_kind text,
  distance_m double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ip text;
  v_on_wifi boolean := false;
  v_gps_usable boolean := false;
  v_inside boolean := false;
  v_outside boolean := false;
  v_dist double precision := NULL;
  v_mode text := lower(trim(COALESCE(p_mode, 'check_in')));
BEGIN
  IF p_user_id IS NULL THEN
    ok := false; reason := 'gps_unusable'; on_wifi := false; gps_usable := false;
    inside_radius := false; outside_radius := false; match_kind := NULL; distance_m := NULL;
    RETURN NEXT; RETURN;
  END IF;

  v_ip := NULLIF(btrim(COALESCE(p_client_ip, '')), '');
  IF v_ip IS NULL THEN
    v_ip := public.attendance_request_client_ip();
  END IF;

  IF COALESCE(p_is_mock, false) THEN
    ok := false; reason := 'gps_unusable'; on_wifi := false; gps_usable := false;
    inside_radius := false; outside_radius := false; match_kind := NULL; distance_m := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- Usable GPS: coords + accuracy <= 100 m (accuracy worse than 100 = unusable).
  v_gps_usable :=
    p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p_accuracy IS NOT NULL
    AND p_accuracy <= 100;

  v_on_wifi := public.attendance_on_assigned_office_wifi(p_user_id, v_ip);

  IF v_gps_usable THEN
    SELECT public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
    INTO v_dist
    FROM public.employee_work_sites ews
    JOIN public.office_locations o ON o.id = ews.office_location_id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
    ORDER BY public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude) ASC
    LIMIT 1;

    v_inside := public.attendance_gps_inside_assigned_office(
      p_user_id, p_lat, p_lng, p_accuracy
    );
    v_outside := NOT v_inside;
  END IF;

  on_wifi := v_on_wifi;
  gps_usable := v_gps_usable;
  inside_radius := v_inside;
  outside_radius := v_outside;
  distance_m := v_dist;
  match_kind := NULL;

  IF v_mode = 'check_out' THEN
    -- Unchanged: wifi+inside OR usable outside reading. Missing GPS never checks out.
    IF (v_on_wifi AND v_inside) OR v_outside THEN
      ok := true; reason := NULL;
      match_kind := CASE WHEN v_outside THEN 'outside_gps' WHEN v_inside THEN 'wifi_gps' ELSE NULL END;
    ELSIF NOT v_gps_usable THEN
      ok := false; reason := 'gps_unusable';
    ELSIF v_inside AND NOT v_on_wifi THEN
      ok := false; reason := 'not_on_office_wifi';
    ELSE
      ok := false; reason := 'outside_radius';
    END IF;
  ELSE
    -- check_in: office Wi-Fi required; GPS optional.
    IF NOT v_on_wifi THEN
      ok := false; reason := 'not_on_office_wifi'; match_kind := NULL;
    ELSIF v_gps_usable AND v_outside THEN
      ok := false; reason := 'outside_radius'; match_kind := NULL;
    ELSIF v_gps_usable AND v_inside THEN
      ok := true; reason := NULL; match_kind := 'wifi_gps';
    ELSE
      -- Location off / denied / missing / accuracy > 100 → Wi-Fi alone.
      ok := true; reason := NULL; match_kind := 'wifi_no_gps';
    END IF;
  END IF;

  RETURN NEXT;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.attendance_office_presence_check(
  uuid, double precision, double precision, double precision, boolean, text, text
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Present evidence: Wi-Fi match required; GPS only when usable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_present_requires_presence_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_mode text := public.attendance_write_mode();
  v_opening boolean := false;
  v_wifi_ok boolean := false;
BEGIN
  IF v_mode IN ('shift_end_close', 'admin_correction', 'leave', 'day_status') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'present'::public.attendance_status THEN
    RETURN NEW;
  END IF;
  IF NEW.clock_in_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_opening :=
    TG_OP = 'INSERT'
    OR OLD.clock_in_at IS DISTINCT FROM NEW.clock_in_at
    OR COALESCE(OLD.status::text, '') IS DISTINCT FROM 'present'
    OR (OLD.clock_out_at IS NOT NULL AND NEW.clock_out_at IS NULL);

  IF NOT v_opening THEN
    RETURN NEW;
  END IF;

  -- Recorded office Wi-Fi match required (network id and/or wifi/laptop method).
  -- Source labels alone are not evidence — bare Present inserts must not pass.
  v_wifi_ok :=
    NEW.wifi_network_id IS NOT NULL
    OR COALESCE(NEW.presence_method, '') IN ('wifi', 'laptop');

  IF NOT v_wifi_ok THEN
    RAISE EXCEPTION 'attendance_present_requires_wifi_and_gps: missing Wi-Fi match on Present record';
  END IF;

  -- Distance/coords required only when GPS was usable (GPS-primary sources).
  -- wifi_no_gps / laptop / wifi presence may omit GPS.
  IF COALESCE(NEW.attendance_source, '') IN ('auto_gps', 'geo')
     AND (NEW.clock_in_lat IS NULL OR NEW.clock_in_lng IS NULL) THEN
    RAISE EXCEPTION 'attendance_present_requires_wifi_and_gps: missing GPS on Present record';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON COLUMN public.attendance_records.attendance_source IS
  'auto_gps | auto_wifi | auto_laptop | auto_wifi_no_gps | manual | manual_wifi_no_gps | leave | day_status | admin_correction';


-- process_auto_attendance_event (patched)
CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(p_token_hash text, p_event text, p_zone_id uuid DEFAULT NULL::uuid, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_ssid text DEFAULT NULL::text, p_bssid text DEFAULT NULL::text, p_occurred_at_utc_ms bigint DEFAULT NULL::bigint, p_device_now_utc_ms bigint DEFAULT NULL::bigint, p_device_timezone text DEFAULT NULL::text, p_is_mock boolean DEFAULT false, p_device_id text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text, p_client_ip text DEFAULT NULL::text)
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
  v_presence_chk RECORD;
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
  v_gps_usable := v_gps_has_fix AND p_accuracy_m IS NOT NULL AND p_accuracy_m <= 100;

  IF v_gps_has_fix THEN
    v_dist := public.haversine_meters(p_latitude, p_longitude, v_zone.latitude, v_zone.longitude);
    v_eff_radius := COALESCE(v_zone.radius_meters, 150)::DOUBLE PRECISION;
    v_exit_radius := v_eff_radius;
    v_gps_ok := v_gps_usable AND v_dist <= v_eff_radius;
    v_gps_inside := v_gps_usable AND v_dist <= v_exit_radius;
    -- Check-out ignores a reading worse than 50 m. Distance uses the saved radius.
    v_gps_outside := v_gps_has_fix
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 50
      AND v_dist > v_exit_radius;
  END IF;

  -- An exit or logout event without a real location is not proof they left.

  SELECT * INTO v_wifi_match
  FROM public.attendance_match_office_wifi(v_zone.id, p_client_ip, p_ssid, p_bssid);
  v_wifi_ok := COALESCE(v_wifi_match.matched, false);
  v_wifi_ssid_only := COALESCE(v_wifi_match.ssid_only_suspected, false);
  v_wifi_network_id := v_wifi_match.network_id;
  v_wifi_network_label := v_wifi_match.network_label;

  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;

  IF true THEN
    IF v_dev.platform IN ('android', 'ios') THEN
      -- Count outside readings only from a real GPS fix. Logout and a Wi-Fi
      -- callback do not count as outside.
      IF v_gps_outside THEN
        v_outside_streak := LEAST(COALESCE(v_dev.gps_outside_streak, 0) + 1, 10);
      ELSIF v_gps_inside OR v_gps_ok THEN
        v_outside_streak := 0;
      ELSE
        v_outside_streak := COALESCE(v_dev.gps_outside_streak, 0);
      END IF;

      IF v_gps_outside
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        -- Outside the radius: check out even on office Wi-Fi.
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSIF v_gps_inside OR v_gps_ok THEN
        -- Inside the radius: stay checked in. Wi-Fi is not required to stay.
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
        v_outside_streak := 0;
      ELSIF v_wifi_ok
            AND v_event IN ('wifi_connected', 'enter', 'ping', 'heartbeat', 'power_on', 'network_change') THEN
        -- Office Wi-Fi alone is enough to check in when GPS is off/unusable.
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSE
        -- Missing GPS and not on office Wi-Fi: do not check out.
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
    ELSE
      -- Laptop / desktop. Logging out or losing a ping is not a check-out.
      -- Check out only when the location is outside the office and this
      -- machine is not on office Wi-Fi. Power-off is handled below.
      IF v_gps_outside
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSIF v_gps_ok OR v_gps_inside THEN
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSIF v_wifi_ok
            AND v_event IN ('wifi_connected', 'enter', 'ping', 'heartbeat', 'power_on', 'network_change') THEN
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSE
        -- No usable outside reading. Wi-Fi drop / sleep is not a check-out.
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
    END IF;
  END IF;

  -- Inside the office radius: stay checked in. An outside reading already set leave.
  -- Laptop power-off, logout, and a Wi-Fi drop are not a check-out.
  IF (v_gps_inside OR v_gps_ok) AND NOT COALESCE(v_gps_outside, false) THEN
    v_present := true;
    v_left := false;
    v_leave_mode := NULL;
  END IF;

  -- Check-in: office Wi-Fi without GPS is allowed (handled via presence_check).
  -- Check-out still requires usable outside GPS elsewhere in this function.

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

  IF v_wifi_ok AND v_dev.platform IN ('windows', 'linux') THEN v_method := 'laptop';
  ELSIF v_wifi_ok THEN v_method := 'wifi';
  ELSIF v_gps_ok THEN v_method := 'gps';
  ELSE v_method := NULL;
  END IF;

  v_source := CASE v_method
    WHEN 'gps' THEN 'auto_gps'
    WHEN 'wifi' THEN 'auto_wifi'
    WHEN 'laptop' THEN 'auto_laptop'
    ELSE 'auto_wifi'
  END;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_events_log e
    WHERE e.user_id = v_dev.user_id
      AND e.device_id IS NOT DISTINCT FROM v_dev.id
      AND e.zone_id IS NOT DISTINCT FROM v_zone.id
      AND e.event = v_event
      AND e.accepted = true
      AND e.created_at > v_now - INTERVAL '5 minutes'
  ) INTO v_dup;

  -- Heartbeats can repeat. A laptop Test now is a ping and must always
  -- run the real check, even if the phone logged in or this laptop pinged recently.
  -- Never return duplicate_ignored when the person is not checked in.
  IF v_dup AND v_event NOT IN ('heartbeat', 'ping', 'exit') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
    IF EXISTS (
      SELECT 1 FROM public.attendance_records ar
      WHERE ar.user_id = v_dev.user_id
        AND ar.attendance_date = v_att_date
        AND ar.clock_in_at IS NOT NULL
        AND ar.clock_out_at IS NULL
    ) THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_checked_in',
        'reason', 'duplicate_within_5m',
        'attendance_date', v_att_date
      );
    END IF;
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
  ELSIF v_left THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id,
      gps_outside_streak = 0
    WHERE user_id = v_dev.user_id
      AND revoked_at IS NULL;
  ELSE
    UPDATE public.attendance_devices SET
      gps_outside_streak = CASE
        WHEN v_dev.platform IN ('android', 'ios') THEN v_outside_streak
        ELSE gps_outside_streak
      END
    WHERE id = v_dev.id;
  END IF;

  IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present AND NOT COALESCE(v_left, false) THEN
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
    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSE
      SELECT * INTO v_presence_chk
      FROM public.attendance_office_presence_check(
        v_dev.user_id, p_latitude, p_longitude, p_accuracy_m,
        COALESCE(p_is_mock, false), p_client_ip, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_presence_chk.ok, false) THEN
        v_action := COALESCE(v_presence_chk.reason, 'outside_radius');
      ELSE
      IF COALESCE(v_presence_chk.match_kind, '') = 'wifi_no_gps'
         OR (COALESCE(v_presence_chk.on_wifi, false) AND NOT COALESCE(v_presence_chk.gps_usable, false)) THEN
        v_method := CASE WHEN v_dev.platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
        v_source := 'auto_wifi_no_gps';
      ELSIF COALESCE(v_presence_chk.match_kind, '') = 'wifi_gps'
         OR (COALESCE(v_presence_chk.on_wifi, false) AND COALESCE(v_presence_chk.gps_usable, false)
             AND COALESCE(v_presence_chk.inside_radius, false)) THEN
        v_method := CASE WHEN v_dev.platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
        v_source := CASE WHEN v_dev.platform IN ('windows', 'linux') THEN 'auto_laptop' ELSE 'auto_wifi' END;
      END IF;
      INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
        reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
      ) VALUES (
        v_dev.user_id, v_att_date, 'present', 'approved', v_dev.user_id,
        v_corr.occurred_at, p_latitude, p_longitude, v_source, v_win.shift_id,
        CASE
          WHEN v_source = 'auto_wifi_no_gps'
            OR COALESCE(v_presence_chk.match_kind, '') = 'wifi_no_gps' THEN
            'Checked in on office Wi-Fi, location unavailable'
              || CASE WHEN v_wifi_network_label IS NOT NULL THEN ' · ' || v_wifi_network_label ELSE '' END
          ELSE
            'Checked in at ' || COALESCE(v_zone.name, 'office')
              || ' · ' || COALESCE(v_wifi_network_label, 'office Wi-Fi')
              || CASE WHEN v_presence_chk.distance_m IS NOT NULL
                   THEN ' · ' || ROUND(v_presence_chk.distance_m)::int || 'm from the office'
                   WHEN v_dist IS NOT NULL THEN ' · ' || ROUND(v_dist)::int || 'm from the office'
                   ELSE '' END
        END,
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
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out
  -- R69 immediate when GPS leave confirmed + not on office Wi-Fi
  -- Laptop power_off immediate; grace otherwise → cron after 15 min
  -- R54: check out only when ALL enrolled devices confirm left
  --------------------------------------------------------------------------
  ELSIF v_left AND v_leave_mode = 'immediate' THEN
    -- Outside the radius checks the person out on this reading.
    -- Other enrolled devices do not delay check-out.
    IF v_rec.id IS NOT NULL
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
      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = v_dev.user_id
        AND revoked_at IS NULL;
    ELSE
      v_action := 'no_open_visit';
      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = v_dev.user_id
        AND revoked_at IS NULL;
    END IF;

  ELSIF v_left AND COALESCE(v_leave_mode, 'immediate') <> 'immediate' THEN
    -- Never defer checkout on a quiet phone. Without a usable outside
    -- reading, ask the client for a fresh GPS fix (Rule 5).
    v_action := 'need_fresh_location';
    v_leave_mode := NULL;
    v_left := false;
  ELSIF v_event IN ('ping', 'heartbeat', 'power_on') THEN
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_checked_in';
    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_wifi';
    ELSE
      -- Office Wi-Fi without GPS is handled above as present; remaining = outside/reject.
      v_action := 'outside_radius';
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
    'attendance_source', v_source,
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
$function$
;

-- process_geo_attendance_ping (patched)
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

  -- Assigned office: nearest when GPS present, else any active assigned office.
  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
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
  ELSE
    SELECT
      ews.office_location_id,
      o.name,
      o.latitude,
      o.longitude,
      COALESCE(o.radius_meters, 150),
      NULL::double precision,
      COALESCE(o.is_demo, false)
    INTO v_office_id, v_site_name, v_site_lat, v_site_lng, v_radius, v_distance, v_demo
    FROM public.employee_work_sites ews
    JOIN public.office_locations o ON o.id = ews.office_location_id
    WHERE ews.user_id = v_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
    ORDER BY o.name ASC
    LIMIT 1;
  END IF;

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

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    INSERT INTO public.employee_location_pings (
      user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
      v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );
  END IF;

  IF v_intent = 'clock_in' THEN
    IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_clocked_in';
    ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSE
      SELECT * INTO v_chk
      FROM public.attendance_office_presence_check(
        v_user_id, p_latitude, p_longitude, p_accuracy, COALESCE(p_is_mock, false), NULL, 'check_in'
      ) LIMIT 1;
      IF NOT COALESCE(v_chk.ok, false) THEN
        v_action := COALESCE(v_chk.reason, 'outside_radius');
      ELSE
        INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, marked_by,
          clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
          reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
        ) VALUES (
          v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
          v_now, p_latitude, p_longitude,
          CASE WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN 'manual_wifi_no_gps' ELSE 'manual' END,
          v_win.shift_id,
          CASE
            WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN
              'Checked in on office Wi-Fi, location unavailable'
            ELSE
              public.attendance_checkin_note(v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date)
          END,
          v_user_id, v_now, 'wifi',
          NULL, NULL
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE SET
          clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
          clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
          clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
          clock_out_at = NULL,
          status = 'present',
          approval_status = 'approved',
          attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.attendance_source ELSE public.attendance_records.attendance_source END,
          presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
          notes = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN EXCLUDED.notes ELSE public.attendance_records.notes END,
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now,
          CASE WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN 'Wi-Fi entry (no GPS)' ELSE 'GPS entry' END
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
        v_user_id, p_latitude, p_longitude, p_accuracy, COALESCE(p_is_mock, false), NULL, 'check_in'
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
          v_now, p_latitude, p_longitude,
          CASE WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN 'auto_wifi_no_gps' ELSE 'auto_wifi' END,
          v_win.shift_id,
          CASE
            WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN
              'Checked in on office Wi-Fi, location unavailable'
            ELSE
              public.attendance_checkin_note(
                v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date
              )
          END,
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
            THEN EXCLUDED.attendance_source ELSE public.attendance_records.attendance_source END,
          presence_method = 'wifi',
          notes = CASE
            WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
            THEN EXCLUDED.notes ELSE public.attendance_records.notes END,
          shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
        RETURNING * INTO v_rec;
        PERFORM public.attendance_ensure_open_visit(
          v_user_id, v_rec.id, v_attendance_date, v_now,
          CASE WHEN COALESCE(v_chk.match_kind, '') = 'wifi_no_gps' THEN 'Auto Wi-Fi entry (no GPS)' ELSE 'Auto GPS entry' END
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
    'record_id', v_rec.id,
    'attendance_source', CASE
      WHEN v_action = 'clock_in' AND v_chk.match_kind = 'wifi_no_gps' AND v_intent = 'clock_in' THEN 'manual_wifi_no_gps'
      WHEN v_action = 'clock_in' AND v_chk.match_kind = 'wifi_no_gps' THEN 'auto_wifi_no_gps'
      WHEN v_action = 'clock_in' AND v_intent = 'clock_in' THEN 'manual'
      WHEN v_action = 'clock_in' THEN 'auto_wifi'
      ELSE NULL
    END
  );
END;
$function$
;


NOTIFY pgrst, 'reload schema';
