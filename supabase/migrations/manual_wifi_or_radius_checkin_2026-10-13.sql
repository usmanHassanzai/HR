-- manual_wifi_or_radius_checkin_2026-10-13.sql
-- Check-in decision order (auto + manual Clock in):
--   1) Configured OFFICE Wi-Fi for an ASSIGNED location → check in (no radius required)
--      Never accept arbitrary / public Wi-Fi.
--   2) Else GPS inside assigned location radius → check in
--   3) Else no check-in
-- Manual Clock out: any location during [shift_start, shift_end) (same as early leave).
-- Does NOT restore the full old Wi-Fi engine.

-- ---------------------------------------------------------------------------
-- 1) Harden office Wi-Fi matcher: configured identifiers only; never match-all
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_match_office_wifi(
  p_office_id UUID,
  p_client_ip TEXT,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL
) RETURNS TABLE (
  matched BOOLEAN,
  network_id UUID,
  network_label TEXT,
  ssid_only_suspected BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n RECORD;
  v_ssid TEXT := NULLIF(btrim(COALESCE(p_ssid, '')), '');
  v_bssid TEXT := NULLIF(lower(btrim(COALESCE(p_bssid, ''))), '');
  v_net_count INT := 0;
  v_ip_ok BOOLEAN;
  v_ssid_ok BOOLEAN;
  v_bssid_ok BOOLEAN;
  v_has_ssid BOOLEAN;
  v_has_bssid BOOLEAN;
  v_has_ip BOOLEAN;
BEGIN
  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;

  SELECT count(*)::int INTO v_net_count
  FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id AND active;

  -- Legacy flat columns when no network rows exist.
  IF v_net_count = 0 THEN
    SELECT
      CASE
        -- SSID required when SSIDs are configured (primary office Wi-Fi identity)
        WHEN v_ssid IS NOT NULL
          AND cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
          AND v_ssid = ANY (o.wifi_ssids)
          AND (
            cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
            OR (v_bssid IS NOT NULL AND v_bssid = ANY (o.wifi_bssids))
          )
          AND (
            cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
            OR public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
          )
        THEN true
        -- BSSID-only office network (no SSIDs listed)
        WHEN cardinality(COALESCE(o.wifi_ssids, '{}')) = 0
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
          AND v_bssid IS NOT NULL AND v_bssid = ANY (o.wifi_bssids)
          AND (
            cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
            OR public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
          )
        THEN true
        -- Public-IP-only office network (no SSID/BSSID lists)
        WHEN cardinality(COALESCE(o.wifi_ssids, '{}')) = 0
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
          AND cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
          AND public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
        THEN true
        ELSE false
      END,
      CASE
        WHEN cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
          AND cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
        THEN true
        ELSE false
      END
    INTO matched, ssid_only_suspected
    FROM public.office_locations o
    WHERE o.id = p_office_id;
    -- No configured identifiers → never match (blocks empty / public Wi-Fi)
    IF matched IS NULL THEN
      matched := false;
      ssid_only_suspected := false;
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR n IN
    SELECT *
    FROM public.office_wifi_networks
    WHERE office_location_id = p_office_id AND active
    ORDER BY sort_order, created_at
  LOOP
    v_has_ssid := cardinality(n.ssids) > 0;
    v_has_bssid := cardinality(n.wifi_bssids) > 0;
    v_has_ip := cardinality(n.public_ip_cidrs) > 0;

    -- Skip empty network rows (would otherwise match any client)
    IF NOT v_has_ssid AND NOT v_has_bssid AND NOT v_has_ip THEN
      CONTINUE;
    END IF;

    -- Require SSID when the network lists SSIDs
    IF v_has_ssid AND NOT (v_ssid IS NOT NULL AND v_ssid = ANY (n.ssids)) THEN
      CONTINUE;
    END IF;

    v_ssid_ok := (NOT v_has_ssid) OR (v_ssid IS NOT NULL AND v_ssid = ANY (n.ssids));
    v_bssid_ok := (NOT v_has_bssid) OR (v_bssid IS NOT NULL AND v_bssid = ANY (n.wifi_bssids));
    IF v_has_ip THEN
      v_ip_ok := public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs);
    ELSE
      v_ip_ok := true;
    END IF;

    IF v_ssid_ok AND v_bssid_ok AND v_ip_ok THEN
      matched := true;
      network_id := n.id;
      network_label := n.label;
      ssid_only_suspected := v_has_ssid AND NOT v_has_bssid AND NOT v_has_ip;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;

  matched := false;
  network_id := NULL;
  network_label := NULL;
  ssid_only_suspected := false;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Manual / dashboard: process_geo_attendance_ping — wifi then radius writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL,
  p_intent text DEFAULT 'auto',
  p_is_mock boolean DEFAULT false,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role public.user_role;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
  v_win RECORD;
  v_checkin_start TIMESTAMPTZ;
  v_checkin_end TIMESTAMPTZ;
  v_att_date DATE;
  v_rec public.attendance_records%ROWTYPE;
  v_site RECORD;
  v_wifi RECORD;
  v_client_ip TEXT := public.request_client_ip();
  v_wifi_ok BOOLEAN := false;
  v_gps_ok BOOLEAN := false;
  v_gps_usable BOOLEAN;
  v_matched_zone UUID;
  v_matched_label TEXT;
  v_wifi_network_id UUID;
  v_match_via TEXT;
  v_source TEXT;
  v_dist DOUBLE PRECISION;
  v_radius INTEGER;
  v_any_zone BOOLEAN := false;
  v_id UUID;
  v_was_closed BOOLEAN := false;
  v_out TIMESTAMPTZ;
  v_total INTEGER;
  v_tz TEXT;
  v_company_id UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF COALESCE(p_is_mock, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'gps_unusable',
      'reason', 'gps_unusable',
      'inside_office', false,
      'message', 'Mock location is not allowed.'
    );
  END IF;

  SELECT role, company_id INTO v_role, v_company_id FROM public.users WHERE id = v_user_id;
  IF v_role NOT IN (
    'employee'::public.user_role,
    'manager'::public.user_role,
    'hr'::public.user_role
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'skipped',
      'reason', 'role_skipped',
      'message', 'Geo attendance is for employees, managers, and HR only.'
    );
  END IF;

  IF v_intent NOT IN ('clock_in', 'clock_out', 'auto') THEN
    RETURN jsonb_build_object('ok', false, 'action', 'none', 'reason', 'unknown_intent');
  END IF;

  -- Presence-only for auto dashboard pings (background auto uses process_auto_attendance_event)
  IF v_intent = 'auto' THEN
    v_gps_usable := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
      AND (p_accuracy IS NULL OR p_accuracy <= 100);
    FOR v_site IN SELECT * FROM public.get_work_sites_for_user(v_user_id)
    LOOP
      IF v_site.office_location_id IS NULL THEN CONTINUE; END IF;
      v_any_zone := true;
      SELECT * INTO v_wifi
      FROM public.attendance_match_office_wifi(
        v_site.office_location_id, v_client_ip, p_ssid, p_bssid
      );
      IF COALESCE(v_wifi.matched, false) THEN
        RETURN jsonb_build_object(
          'ok', true,
          'action', 'inside_office',
          'reason', 'office_wifi',
          'inside_office', true,
          'match_via', 'wifi',
          'office_name', COALESCE(v_wifi.network_label, v_site.site_name),
          'decision_order', 'wifi_then_radius',
          'office_wifi_only', true,
          'writes_paused', false,
          'message', 'On configured office Wi-Fi for an assigned location.'
        );
      END IF;
    END LOOP;
    IF v_gps_usable THEN
      FOR v_site IN SELECT * FROM public.get_work_sites_for_user(v_user_id)
      LOOP
        IF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN CONTINUE; END IF;
        v_any_zone := true;
        v_radius := GREATEST(COALESCE(v_site.radius_meters, 1), 1);
        v_dist := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
        IF v_dist IS NOT NULL AND v_dist <= v_radius THEN
          RETURN jsonb_build_object(
            'ok', true,
            'action', 'inside_office',
            'reason', 'office_radius',
            'inside_office', true,
            'match_via', 'gps',
            'office_name', v_site.site_name,
            'distance_meters', ROUND(v_dist)::integer,
            'radius_meters', v_radius,
            'effective_radius_meters', v_radius,
            'decision_order', 'wifi_then_radius',
            'office_wifi_only', true,
            'writes_paused', false,
            'message', 'Inside assigned office radius (not on office Wi-Fi).'
          );
        END IF;
      END LOOP;
    END IF;
    SELECT
      s.site_name,
      GREATEST(COALESCE(s.radius_meters, 1), 1),
      public.haversine_meters(p_latitude, p_longitude, s.latitude, s.longitude)
    INTO v_matched_label, v_radius, v_dist
    FROM public.get_work_sites_for_user(v_user_id) s
    WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    ORDER BY public.haversine_meters(p_latitude, p_longitude, s.latitude, s.longitude) ASC
    LIMIT 1;
    IF FOUND THEN
      v_any_zone := true;
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'action', CASE WHEN NOT v_any_zone THEN 'outside_office' ELSE 'outside_radius' END,
      'reason', 'assignment_presence',
      'inside_office', false,
      'office_name', v_matched_label,
      'distance_meters', CASE WHEN v_dist IS NULL THEN NULL ELSE ROUND(v_dist)::integer END,
      'radius_meters', v_radius,
      'effective_radius_meters', v_radius,
      'decision_order', 'wifi_then_radius',
      'office_wifi_only', true,
      'writes_paused', false,
      'message', 'Not on configured office Wi-Fi and not inside assigned office radius.'
    );
  END IF;

  PERFORM public.close_open_attendance_if_shift_ended(v_user_id, p_latitude, p_longitude);

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_user_id, v_now) LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false)
     OR v_win.shift_start_utc IS NULL
     OR v_win.shift_end_utc IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'no_shift',
      'reason', 'no_shift',
      'message', 'No shift assigned for this time.'
    );
  END IF;

  v_att_date := v_win.attendance_date;
  v_checkin_start := v_win.shift_start_utc - INTERVAL '60 minutes';
  v_checkin_end := v_win.shift_end_utc;

  -- Manual clock out: any location in [shift_start, shift_end)
  IF v_intent = 'clock_out' THEN
    IF v_now < v_win.shift_start_utc THEN
      RETURN jsonb_build_object(
        'ok', false,
        'action', 'checkout_before_shift_start',
        'reason', 'checkout_before_shift_start',
        'message', 'Check-out is only allowed after shift start and before shift end.'
      );
    END IF;
    IF v_now >= v_win.shift_end_utc THEN
      RETURN jsonb_build_object(
        'ok', false,
        'action', 'checkout_after_shift_end',
        'reason', 'checkout_after_shift_end',
        'message', 'Shift has ended. Open sessions are closed at shift end automatically.'
      );
    END IF;

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_user_id AND attendance_date = v_att_date;

    IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'action', 'no_open_visit',
        'reason', 'not_checked_in',
        'message', 'Clock in first, then clock out.'
      );
    END IF;
    IF v_rec.clock_out_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_clocked_out',
        'reason', 'already_checked_out',
        'session_open', false,
        'attendance_record_id', v_rec.id,
        'message', 'Already checked out.'
      );
    END IF;

    v_out := GREATEST(v_rec.clock_in_at, v_now);
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
      )
    WHERE user_id = v_user_id
      AND attendance_date = v_att_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
      SELECT 1 FROM public.attendance_visit_segments
      WHERE user_id = v_user_id AND attendance_date = v_att_date
    ) THEN
      INSERT INTO public.attendance_visit_segments (
        user_id, attendance_record_id, attendance_date, visit_number,
        clock_in_at, clock_out_at, clock_out_lat, clock_out_lng, work_minutes, notes
      ) VALUES (
        v_user_id, v_rec.id, v_att_date, 1,
        v_rec.clock_in_at, v_out, p_latitude, p_longitude,
        GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_rec.clock_in_at)) / 60)::INTEGER),
        'Manual check-out (any location)'
      );
    END IF;

    v_total := public.attendance_day_total_minutes(v_user_id, v_att_date, v_out);

    UPDATE public.attendance_records SET
      clock_out_at = v_out,
      clock_out_lat = COALESCE(p_latitude, clock_out_lat),
      clock_out_lng = COALESCE(p_longitude, clock_out_lng),
      work_minutes = v_total
    WHERE id = v_rec.id;

    v_tz := COALESCE(
      NULLIF(btrim((SELECT timezone FROM public.work_shifts WHERE id = v_rec.shift_id)), ''),
      public.company_timezone(v_company_id),
      public.app_timezone(),
      'UTC'
    );

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'clock_out',
      'reason', 'manual_checkout_any_location',
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'clock_out_at', v_out,
      'local_time', to_char(timezone(v_tz, v_out), 'HH24:MI'),
      'session_open', false,
      'location_required', false,
      'message', 'Checked out. Returning on office Wi-Fi or inside the radius will check you in again.'
    );
  END IF;

  -- Manual clock in: [start−1h, end], office Wi-Fi first, else radius
  IF v_now < v_checkin_start OR v_now > v_checkin_end THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', CASE
        WHEN v_now > v_checkin_end THEN 'checkin_blocked_shift_ended'
        ELSE 'shift_not_started'
      END,
      'reason', 'outside_window',
      'window_start_utc', v_checkin_start,
      'window_end_utc', v_checkin_end,
      'message', 'Clock-in is allowed from 1 hour before shift start until shift end.'
    );
  END IF;

  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_user_id AND attendance_date = v_att_date;

  IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_clocked_in',
      'reason', 'already_in',
      'session_open', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'message', 'Already checked in.'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_user_id
      AND vs.attendance_date = v_att_date
      AND vs.clock_out_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_clocked_in',
      'reason', 'already_in',
      'session_open', true,
      'attendance_date', v_att_date,
      'message', 'Already checked in (open visit).'
    );
  END IF;

  v_was_closed := FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NOT NULL;

  v_gps_usable := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
    AND (p_accuracy IS NULL OR p_accuracy <= 100);

  -- Path 1: configured office Wi-Fi only (assigned locations)
  FOR v_site IN SELECT * FROM public.get_work_sites_for_user(v_user_id)
  LOOP
    IF v_site.office_location_id IS NULL THEN CONTINUE; END IF;
    v_any_zone := true;
    SELECT * INTO v_wifi
    FROM public.attendance_match_office_wifi(
      v_site.office_location_id, v_client_ip, p_ssid, p_bssid
    );
    IF COALESCE(v_wifi.matched, false) THEN
      v_wifi_ok := true;
      v_matched_zone := v_site.office_location_id;
      v_matched_label := COALESCE(v_wifi.network_label, v_site.site_name);
      v_wifi_network_id := v_wifi.network_id;
      v_match_via := 'wifi';
      v_source := 'manual';
      EXIT;
    END IF;
  END LOOP;

  -- Path 2: else office radius (GPS inside assigned location)
  IF v_matched_zone IS NULL AND v_gps_usable THEN
    FOR v_site IN SELECT * FROM public.get_work_sites_for_user(v_user_id)
    LOOP
      IF v_site.office_location_id IS NULL THEN CONTINUE; END IF;
      v_any_zone := true;
      IF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN CONTINUE; END IF;
      v_radius := GREATEST(COALESCE(v_site.radius_meters, 1), 1);
      v_dist := public.haversine_meters(
        p_latitude, p_longitude, v_site.latitude, v_site.longitude
      );
      IF v_dist IS NOT NULL AND v_dist <= v_radius THEN
        v_gps_ok := true;
        v_matched_zone := v_site.office_location_id;
        v_matched_label := v_site.site_name;
        v_match_via := 'gps';
        v_source := 'manual';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF NOT v_any_zone THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'outside_office',
      'reason', 'no_work_site',
      'inside_office', false,
      'message', 'No office location assigned. Ask admin: Office & Attendance → Assign people.'
    );
  END IF;

  IF v_matched_zone IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', CASE
        WHEN NOT v_gps_usable AND NULLIF(btrim(COALESCE(p_ssid, '')), '') IS NULL
          THEN 'need_fresh_location'
        WHEN NOT v_gps_usable THEN 'not_on_office_wifi'
        ELSE 'outside_radius'
      END,
      'reason', CASE
        WHEN NOT v_gps_usable AND NULLIF(btrim(COALESCE(p_ssid, '')), '') IS NULL
          THEN 'need_fresh_location'
        WHEN NOT v_gps_usable THEN 'not_on_office_wifi'
        ELSE 'outside_radius'
      END,
      'inside_office', false,
      'decision_order', 'wifi_then_radius',
      'office_wifi_only', true,
      'message', 'Not on configured office Wi-Fi and not inside the office radius.'
    );
  END IF;

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at,
    wifi_network_id, wifi_network_label, shift_id,
    clock_in_lat, clock_in_lng, presence_method
  )
  VALUES (
    v_user_id, v_att_date, 'present', 'approved'::public.approval_status, v_user_id,
    v_now, NULL, NULL, v_source, v_user_id, v_now,
    v_wifi_network_id, CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END, v_win.shift_id,
    CASE WHEN v_gps_ok THEN p_latitude ELSE NULL END,
    CASE WHEN v_gps_ok THEN p_longitude ELSE NULL END,
    CASE WHEN v_match_via = 'wifi' THEN 'wifi' ELSE 'gps' END
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE
  SET status = 'present',
      approval_status = 'approved'::public.approval_status,
      marked_by = v_user_id,
      reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_user_id),
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
      shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
      clock_in_lat = COALESCE(EXCLUDED.clock_in_lat, public.attendance_records.clock_in_lat),
      clock_in_lng = COALESCE(EXCLUDED.clock_in_lng, public.attendance_records.clock_in_lng),
      presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method)
  WHERE public.attendance_records.clock_in_at IS NULL
     OR public.attendance_records.clock_out_at IS NOT NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_user_id AND attendance_date = v_att_date;
    IF v_rec.clock_out_at IS NULL AND v_rec.clock_in_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'already_clocked_in',
        'reason', 'already_in',
        'session_open', true,
        'attendance_record_id', v_rec.id,
        'message', 'Already checked in.'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_conflict',
      'reason', 'checkin_conflict',
      'message', 'Could not open attendance session.'
    );
  END IF;

  PERFORM public.attendance_ensure_open_visit(
    v_user_id, v_id, v_att_date, v_now,
    CASE
      WHEN v_was_closed AND v_match_via = 'gps' THEN 'Manual re-entry GPS check-in'
      WHEN v_was_closed THEN 'Manual re-entry Wi-Fi check-in'
      WHEN v_match_via = 'gps' THEN 'Manual GPS check-in (after Wi-Fi miss)'
      ELSE 'Manual office Wi-Fi check-in'
    END
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_in',
    'reason', CASE
      WHEN v_was_closed THEN 'wifi_or_radius_reentry'
      ELSE 'wifi_or_radius_manual_checkin'
    END,
    'match_via', v_match_via,
    'attendance_source', v_source,
    'attendance_record_id', v_id,
    'attendance_date', v_att_date,
    'zone_id', v_matched_zone,
    'office_name', v_matched_label,
    'wifi_network_id', v_wifi_network_id,
    'wifi_network_label', CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END,
    'distance_meters', CASE WHEN v_dist IS NULL THEN NULL ELSE ROUND(v_dist)::integer END,
    'inside_office', true,
    'session_open', true,
    'reentry', v_was_closed,
    'decision_order', 'wifi_then_radius',
    'office_wifi_only', true,
    'window_start_utc', v_checkin_start,
    'window_end_utc', v_checkin_end,
    'message', CASE
      WHEN v_match_via = 'gps' THEN
        'Checked in inside the office radius (not on configured office Wi-Fi).'
      ELSE
        'Checked in on configured office Wi-Fi (radius not required).'
    END
  );
END;
$$;

-- Keep older overloads delegating to the full signature
CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(
    p_latitude, p_longitude, p_accuracy, 'auto', false, NULL, NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(
    p_latitude, p_longitude, p_accuracy, p_intent, false, NULL, NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text,
  p_is_mock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(
    p_latitude, p_longitude, p_accuracy, p_intent, p_is_mock, NULL, NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean, text, text) TO authenticated;

-- Legacy date-only RPC: point clients at Clock in with location (no silent bypass)
CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'Use Clock in with location. Check-in requires configured office Wi-Fi or being inside the assigned office radius.';
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(date) TO authenticated;

COMMENT ON FUNCTION public.attendance_match_office_wifi(uuid, text, text, text) IS
  'Matches ONLY configured office Wi-Fi / IP for a location. Never accepts arbitrary public Wi-Fi. Empty network configs never match.';

COMMENT ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean, text, text) IS
  'Manual Clock in: office Wi-Fi first (configured + assigned), else GPS radius. Manual Clock out: any location in shift window.';

NOTIFY pgrst, 'reload schema';
