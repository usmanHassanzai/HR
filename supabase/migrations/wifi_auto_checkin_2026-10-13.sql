-- wifi_auto_checkin_2026-10-13.sql
-- Clean office auto check-in (Android + Desktop only).
-- Rules:
--   1) Wi-Fi networks belong to an office location (SSID when configuring Wi-Fi; BSSID / public IP optional).
--   2) Auto check-in during [shift_start − 1h, shift_end] when EITHER:
--        a) connected to that location's office Wi-Fi, OR
--        b) GPS is inside that location's radius_meters (mobile location on).
--   3) Assigned locations only. One open attendance session per user/day (already_in).
--   4) iOS auto path stays off (registration rejected; events ignored).

-- ---------------------------------------------------------------------------
-- 1) Soften Wi-Fi network storage: SSID required; IP no longer mandatory
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.office_wifi_networks_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.label := btrim(COALESCE(NEW.label, ''));
  NEW.ssids := (
    SELECT COALESCE(array_agg(DISTINCT btrim(x) ORDER BY btrim(x)), '{}')
    FROM unnest(COALESCE(NEW.ssids, '{}')) AS x
    WHERE btrim(x) <> ''
  );
  NEW.wifi_bssids := (
    SELECT COALESCE(array_agg(DISTINCT lower(btrim(x)) ORDER BY lower(btrim(x))), '{}')
    FROM unnest(COALESCE(NEW.wifi_bssids, '{}')) AS x
    WHERE btrim(x) <> ''
  );
  BEGIN
    NEW.public_ip_cidrs := public.assert_public_ip_cidrs(COALESCE(NEW.public_ip_cidrs, '{}'));
  EXCEPTION WHEN undefined_function THEN
    NEW.public_ip_cidrs := COALESCE(NEW.public_ip_cidrs, '{}');
  END;
  IF cardinality(NEW.ssids) = 0 THEN
    RAISE EXCEPTION 'Each Wi-Fi network needs at least one SSID';
  END IF;
  IF NEW.label = '' THEN
    NEW.label := NEW.ssids[1];
  END IF;
  NEW.updated_at := timezone('utc', now());
  IF NEW.company_id IS NULL THEN
    SELECT company_id INTO NEW.company_id FROM public.office_locations WHERE id = NEW.office_location_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_office_wifi_networks(
  p_office_id UUID,
  p_networks JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  v_demo BOOLEAN;
  elem JSONB;
  v_id UUID;
  v_label TEXT;
  v_ssids TEXT[];
  v_bssids TEXT[];
  v_ips TEXT[];
  v_active BOOLEAN;
  v_sort INT := 0;
  v_keep UUID[] := '{}';
  v_warnings TEXT[];
  v_count INT := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Only admins can manage office Wi-Fi networks'; END IF;

  v_demo := public.is_demo_user(v_uid);
  IF v_demo THEN
    IF NOT EXISTS (SELECT 1 FROM public.office_locations WHERE id = p_office_id AND is_demo) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  ELSE
    v_company := public.current_company_id();
    IF NOT EXISTS (SELECT 1 FROM public.office_locations WHERE id = p_office_id AND company_id = v_company) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  END IF;

  IF p_networks IS NULL OR jsonb_typeof(p_networks) <> 'array' THEN
    RAISE EXCEPTION 'p_networks must be a JSON array';
  END IF;
  IF jsonb_array_length(p_networks) > 50 THEN
    RAISE EXCEPTION 'At most 50 Wi-Fi networks per office';
  END IF;

  v_warnings := public.office_wifi_duplicate_warnings(p_office_id, p_networks);

  FOR elem IN SELECT * FROM jsonb_array_elements(p_networks)
  LOOP
    v_label := NULLIF(btrim(COALESCE(elem->>'label', '')), '');
    v_ssids := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'ssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    IF elem ? 'ssid' AND NULLIF(btrim(elem->>'ssid'), '') IS NOT NULL THEN
      v_ssids := ARRAY[btrim(elem->>'ssid')] || v_ssids;
    END IF;
    SELECT COALESCE(array_agg(DISTINCT s), '{}') INTO v_ssids FROM unnest(v_ssids) s WHERE btrim(s) <> '';

    v_bssids := COALESCE(
      ARRAY(SELECT lower(btrim(x::text)) FROM jsonb_array_elements_text(COALESCE(elem->'wifi_bssids', elem->'bssids', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    v_ips := COALESCE(
      ARRAY(SELECT btrim(x::text) FROM jsonb_array_elements_text(COALESCE(elem->'public_ip_cidrs', '[]'::jsonb)) x WHERE btrim(x::text) <> ''),
      '{}'
    );
    v_active := COALESCE((elem->>'active')::boolean, true);

    IF v_label IS NULL AND cardinality(v_ssids) = 0 AND cardinality(v_bssids) = 0 AND cardinality(v_ips) = 0 THEN
      CONTINUE;
    END IF;

    IF cardinality(v_ssids) = 0 THEN
      RAISE EXCEPTION 'Each Wi-Fi network needs at least one SSID';
    END IF;
    IF v_label IS NULL THEN
      v_label := v_ssids[1];
    END IF;

    v_id := NULLIF(elem->>'id', '')::uuid;

    IF v_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.office_wifi_networks
      WHERE id = v_id AND office_location_id = p_office_id
    ) THEN
      UPDATE public.office_wifi_networks SET
        label = v_label,
        ssids = v_ssids,
        wifi_bssids = v_bssids,
        public_ip_cidrs = v_ips,
        active = v_active,
        sort_order = v_sort
      WHERE id = v_id;
    ELSE
      INSERT INTO public.office_wifi_networks (
        office_location_id, company_id, label, ssids, wifi_bssids, public_ip_cidrs, active, sort_order
      ) VALUES (
        p_office_id, v_company, v_label, v_ssids, v_bssids, v_ips, v_active, v_sort
      ) RETURNING id INTO v_id;
    END IF;

    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
    v_count := v_count + 1;
  END LOOP;

  DELETE FROM public.office_wifi_networks
  WHERE office_location_id = p_office_id
    AND (cardinality(v_keep) = 0 OR NOT (id = ANY (v_keep)));

  PERFORM public.sync_office_location_wifi_aggregates(p_office_id);

  RETURN jsonb_build_object(
    'ok', true,
    'count', v_count,
    'warnings', to_jsonb(COALESCE(v_warnings, '{}'))
  );
END;
$$;

-- Match: SSID is enough when BSSID/IP not configured; configured identifiers must also match.
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
        WHEN v_ssid IS NOT NULL AND cardinality(COALESCE(o.wifi_ssids, '{}')) > 0 AND v_ssid = ANY (o.wifi_ssids)
          AND (
            cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
            OR (v_bssid IS NOT NULL AND v_bssid = ANY (o.wifi_bssids))
          )
          AND (
            cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
            OR public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
          )
        THEN true
        WHEN cardinality(COALESCE(o.wifi_ssids, '{}')) = 0
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
          AND v_bssid IS NOT NULL AND v_bssid = ANY (o.wifi_bssids)
          AND (
            cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
            OR public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
          )
        THEN true
        ELSE false
      END,
      false
    INTO matched, ssid_only_suspected
    FROM public.office_locations o
    WHERE o.id = p_office_id;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR n IN
    SELECT *
    FROM public.office_wifi_networks
    WHERE office_location_id = p_office_id AND active
    ORDER BY sort_order, created_at
  LOOP
    v_ssid_ok := cardinality(n.ssids) = 0 OR (v_ssid IS NOT NULL AND v_ssid = ANY (n.ssids));
    v_bssid_ok := cardinality(n.wifi_bssids) = 0 OR (v_bssid IS NOT NULL AND v_bssid = ANY (n.wifi_bssids));
    IF cardinality(n.public_ip_cidrs) = 0 THEN
      v_ip_ok := true;
    ELSE
      v_ip_ok := public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs);
    END IF;

    -- Require SSID when the network lists SSIDs (product: SSID is the primary identifier).
    IF cardinality(n.ssids) > 0 AND NOT (v_ssid IS NOT NULL AND v_ssid = ANY (n.ssids)) THEN
      CONTINUE;
    END IF;

    IF v_ssid_ok AND v_bssid_ok AND v_ip_ok THEN
      matched := true;
      network_id := n.id;
      network_label := n.label;
      ssid_only_suspected := cardinality(n.public_ip_cidrs) = 0 AND cardinality(n.wifi_bssids) = 0;
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

CREATE OR REPLACE FUNCTION public.test_office_wifi_match(
  p_office_id UUID,
  p_client_ip TEXT DEFAULT NULL,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
  m RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) AND NOT public.is_demo_user(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT public.is_demo_user(v_uid) THEN
    v_company := public.current_company_id();
    IF NOT EXISTS (
      SELECT 1 FROM public.office_locations WHERE id = p_office_id AND company_id = v_company
    ) THEN
      RAISE EXCEPTION 'Office location not found';
    END IF;
  END IF;

  SELECT * INTO m FROM public.attendance_match_office_wifi(p_office_id, p_client_ip, p_ssid, p_bssid);

  RETURN jsonb_build_object(
    'ok', true,
    'matched', COALESCE(m.matched, false),
    'network_label', m.network_label,
    'network_id', m.network_id,
    'client_ip', p_client_ip,
    'ssid', p_ssid,
    'bssid', p_bssid,
    'ssid_only_suspected', COALESCE(m.ssid_only_suspected, false),
    'message', CASE
      WHEN COALESCE(m.matched, false) THEN format('Matched network: %s', m.network_label)
      ELSE 'No network matched'
    END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Device registration (Android + desktop only; iOS rejected)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id text,
  p_platform text,
  p_device_timezone text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_token_plaintext text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_token TEXT;
  v_hash TEXT;
  v_row public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_device_id IS NULL OR btrim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id required';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('android', 'ios', 'windows', 'linux', 'web') THEN
    RAISE EXCEPTION 'Invalid platform';
  END IF;

  -- Product: auto check-in platforms are Android + Desktop only.
  IF p_platform = 'ios' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'platform_disabled',
      'device_token', NULL,
      'message', 'Automatic check-in is not available on iOS yet. Use Android or the desktop app.'
    );
  END IF;
  IF p_platform = 'web' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'platform_disabled',
      'device_token', NULL,
      'message', 'Automatic check-in needs the Android app or desktop app (browser cannot stay enrolled in the background).'
    );
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_token := COALESCE(
    NULLIF(btrim(p_token_plaintext), ''),
    encode(extensions.gen_random_bytes(32), 'hex')
  );
  v_hash := public.attendance_hash_device_token(v_token);

  -- Upsert: unique (user_id, device_id) — update existing row instead of insert-after-revoke.
  UPDATE public.attendance_devices
  SET
    platform = p_platform,
    device_timezone = COALESCE(NULLIF(btrim(p_device_timezone), ''), device_timezone),
    app_version = COALESCE(NULLIF(btrim(p_app_version), ''), app_version),
    token_hash = v_hash,
    revoked_at = NULL,
    last_seen_at = timezone('utc', now()),
    company_id = v_me.company_id
  WHERE user_id = v_uid AND device_id = btrim(p_device_id)
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    INSERT INTO public.attendance_devices (
      user_id, company_id, device_id, platform, device_timezone, app_version, token_hash,
      created_at, last_seen_at
    ) VALUES (
      v_uid, v_me.company_id, btrim(p_device_id), p_platform,
      NULLIF(btrim(p_device_timezone), ''), NULLIF(btrim(p_app_version), ''),
      v_hash, timezone('utc', now()), timezone('utc', now())
    )
    RETURNING * INTO v_row;
  END IF;

  IF p_platform = 'android' THEN
    UPDATE public.users SET auto_phone_attendance = true WHERE id = v_uid;
  ELSIF p_platform IN ('windows', 'linux') THEN
    UPDATE public.users SET auto_laptop_attendance = true WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'device_row_id', v_row.id,
    'device_token', v_token,
    'platform', p_platform
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_attendance_device(p_device_row_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.attendance_devices
  SET revoked_at = timezone('utc', now())
  WHERE id = p_device_row_id AND user_id = v_uid AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_auto_attendance_setup_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_issues TEXT[] := '{}';
  v_sites INT := 0;
  v_wifi INT := 0;
  v_shift BOOLEAN := false;
  v_win RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'ready', false, 'issues', jsonb_build_array('Not authenticated'));
  END IF;

  SELECT count(*)::int INTO v_sites
  FROM public.get_work_sites_for_user(v_uid);

  IF v_sites = 0 THEN
    v_issues := array_append(v_issues, 'No office location assigned. Ask admin to assign you under Office & Attendance.');
  ELSE
    SELECT count(*)::int INTO v_wifi
    FROM public.office_wifi_networks n
    JOIN public.employee_work_sites ews ON ews.office_location_id = n.office_location_id
    WHERE ews.user_id = v_uid
      AND COALESCE(ews.tracking_enabled, true)
      AND n.active
      AND cardinality(COALESCE(n.ssids, '{}')) > 0;

    IF v_wifi = 0 THEN
      -- Also accept flat wifi_ssids on assigned locations
      SELECT count(*)::int INTO v_wifi
      FROM public.office_locations o
      JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
      WHERE ews.user_id = v_uid
        AND COALESCE(ews.tracking_enabled, true)
        AND COALESCE(o.active, true)
        AND cardinality(COALESCE(o.wifi_ssids, '{}')) > 0;
    END IF;

    -- Wi-Fi is optional when GPS radius can check in; warn only if neither path is usable.
    IF v_wifi = 0 THEN
      -- GPS path still works when assigned locations have coordinates + radius.
      NULL;
    END IF;
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, timezone('utc', now())) LIMIT 1;
  v_shift := COALESCE(v_win.has_shift, false);
  IF NOT v_shift THEN
    v_issues := array_append(v_issues, 'No shift assigned. Ask admin to assign a shift.');
  END IF;

  RETURN jsonb_build_object(
    'ok', cardinality(v_issues) = 0,
    'ready', cardinality(v_issues) = 0,
    'status', CASE WHEN cardinality(v_issues) = 0 THEN 'ready' ELSE 'needs_setup' END,
    'issues', to_jsonb(v_issues),
    'platforms', jsonb_build_array('android', 'windows', 'linux'),
    'message', CASE
      WHEN cardinality(v_issues) = 0 THEN
        'Ready. On Android or desktop, enroll once — then office Wi-Fi or entering the office radius during your check-in window signs you in automatically.'
      ELSE array_to_string(v_issues, ' ')
    END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Schedule for device clients (check-in window ends at shift end)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_schedule_for_user(
  p_user_id UUID,
  p_from TIMESTAMPTZ DEFAULT timezone('utc', now()),
  p_days INTEGER DEFAULT 7
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_server_now TIMESTAMPTZ := timezone('utc', now());
  v_days JSONB := '[]'::JSONB;
  v_i INTEGER;
  v_at TIMESTAMPTZ;
  v_win RECORD;
  v_zone JSONB;
  v_user public.users%ROWTYPE;
  v_checkin_start TIMESTAMPTZ;
  v_checkin_end TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(z), '[]'::JSONB) INTO v_zone
  FROM (
    SELECT jsonb_build_object(
      'zone_id', o.id,
      'name', o.name,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'radius_meters', o.radius_meters,
      'detection_mode', 'wifi_only',
      'wifi_ssids', o.wifi_ssids,
      'wifi_bssids', o.wifi_bssids
    ) AS z
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
  ) q;

  FOR v_i IN 0..GREATEST(COALESCE(p_days, 7) - 1, 0) LOOP
    v_at := p_from + (v_i || ' days')::INTERVAL;

    SELECT * INTO v_win
    FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '12 hours')
    LIMIT 1;

    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '20 hours')
      LIMIT 1;
    END IF;
    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '4 hours')
      LIMIT 1;
    END IF;

    IF COALESCE(v_win.has_shift, false) AND v_win.shift_start_utc IS NOT NULL AND v_win.shift_end_utc IS NOT NULL THEN
      v_checkin_start := v_win.shift_start_utc - INTERVAL '60 minutes';
      v_checkin_end := v_win.shift_end_utc;

      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_days) e
        WHERE (e->>'attendance_date') = v_win.attendance_date::TEXT
      ) THEN
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'attendance_date', v_win.attendance_date,
          'shift_id', v_win.shift_id,
          'shift_name', v_win.shift_name,
          'shift_tz', v_win.shift_tz,
          'start_time', v_win.start_time,
          'end_time', v_win.end_time,
          'crosses_midnight', v_win.crosses_midnight,
          'shift_start_utc', v_win.shift_start_utc,
          'shift_end_utc', v_win.shift_end_utc,
          'window_start_utc', v_checkin_start,
          'window_end_utc', v_checkin_end
        ));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now_utc', v_server_now,
    'company_tz', public.company_timezone(v_user.company_id),
    'windows', v_days,
    'zones', COALESCE(v_zone, '[]'::JSONB),
    'rule', 'wifi_or_radius_auto_checkin',
    'message', 'Auto check-in: office Wi-Fi first, else office radius; window is 1 hour before shift start until shift end.'
  );
END;
$$;

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
  RETURN public.attendance_schedule_for_user(auth.uid(), timezone('utc', now()), 7);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Auto check-in engine (Wi-Fi only; one session per user/day)
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
  v_match_via TEXT := NULL; -- wifi | gps | wifi_and_gps
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

  -- iOS explicitly off
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

  -- Resolve occurred_at (ignore far-future / use server if missing)
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

  -- Check-in only events (no auto check-out in this rule set)
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

  -- Ordered check-in: (1) office Wi-Fi → (2) else office radius → (3) else no
  -- Superseded/hardened further by auto_checkout_shift_end_2026-10-13.sql
  v_gps_usable := p_latitude IS NOT NULL AND p_longitude IS NOT NULL
    AND (p_accuracy_m IS NULL OR p_accuracy_m <= 100);

  FOR v_site IN
    SELECT * FROM public.get_work_sites_for_user(v_dev.user_id)
  LOOP
    IF v_site.office_location_id IS NULL THEN CONTINUE; END IF;
    v_any_zone := true;
    IF p_zone_id IS NOT NULL AND p_zone_id IS DISTINCT FROM v_site.office_location_id THEN
      CONTINUE;
    END IF;
    SELECT * INTO v_wifi
    FROM public.attendance_match_office_wifi(
      v_site.office_location_id, p_client_ip, p_ssid, p_bssid
    );
    IF COALESCE(v_wifi.matched, false) THEN
      v_wifi_ok := true; v_gps_ok := false;
      v_matched_zone := v_site.office_location_id;
      v_matched_label := COALESCE(v_wifi.network_label, v_site.site_name);
      v_wifi_network_id := v_wifi.network_id;
      v_match_via := 'wifi'; v_source := 'auto_wifi';
      EXIT;
    END IF;
  END LOOP;

  IF v_matched_zone IS NULL AND v_gps_usable THEN
    FOR v_site IN
      SELECT * FROM public.get_work_sites_for_user(v_dev.user_id)
    LOOP
      IF v_site.office_location_id IS NULL THEN CONTINUE; END IF;
      v_any_zone := true;
      IF p_zone_id IS NOT NULL AND p_zone_id IS DISTINCT FROM v_site.office_location_id THEN
        CONTINUE;
      END IF;
      IF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN CONTINUE; END IF;
      v_radius := GREATEST(COALESCE(v_site.radius_meters, 1), 1);
      v_dist := public.haversine_meters(
        p_latitude, p_longitude, v_site.latitude, v_site.longitude
      );
      IF v_dist IS NOT NULL AND v_dist <= v_radius THEN
        v_wifi_ok := false; v_gps_ok := true;
        v_matched_zone := v_site.office_location_id;
        v_matched_label := v_site.site_name;
        v_wifi_network_id := NULL;
        v_match_via := 'gps'; v_source := 'auto_gps';
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
      'message', 'Connect to the office Wi-Fi or enter the office radius with location on.'
    );
  END IF;

  -- Dedup: already checked in today → ignore second device / repeat events
  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_dev.user_id AND attendance_date = v_att_date;

  IF FOUND
     AND v_rec.clock_in_at IS NOT NULL
     AND v_rec.clock_out_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'already_in',
      'reason', 'already_in',
      'ignored', true,
      'attendance_record_id', v_rec.id,
      'attendance_date', v_att_date,
      'zone_id', v_matched_zone,
      'wifi_network_label', v_matched_label,
      'message', 'Already checked in for this shift day (another device or earlier event).'
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
      'attendance_date', v_att_date,
      'zone_id', v_matched_zone,
      'message', 'Already checked in for this shift day.'
    );
  END IF;

  -- Create / reopen day record + open visit
  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at,
    wifi_network_id, wifi_network_label
  )
  VALUES (
    v_dev.user_id, v_att_date, 'present', 'approved'::public.approval_status, v_dev.user_id,
    v_occurred, NULL, NULL, v_source, v_dev.user_id, v_now,
    v_wifi_network_id, CASE WHEN v_wifi_ok THEN v_matched_label ELSE NULL END
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE
  SET status = 'present',
      approval_status = 'approved'::public.approval_status,
      marked_by = v_dev.user_id,
      reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_dev.user_id),
      reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
      clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_occurred),
      clock_out_at = NULL,
      attendance_source = COALESCE(public.attendance_records.attendance_source, EXCLUDED.attendance_source),
      wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
      wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label)
  RETURNING id INTO v_id;

  PERFORM public.attendance_ensure_open_visit(
    v_dev.user_id, v_id, v_att_date, v_occurred,
    CASE
      WHEN v_match_via = 'gps' THEN 'Auto GPS check-in'
      WHEN v_match_via = 'wifi_and_gps' THEN 'Auto Wi-Fi + GPS check-in'
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
    'window_start_utc', v_checkin_start,
    'window_end_utc', v_checkin_end,
    'message', CASE
      WHEN v_match_via = 'gps' THEN 'Checked in inside the office radius.'
      WHEN v_match_via = 'wifi_and_gps' THEN 'Checked in on office Wi-Fi inside the radius.'
      ELSE 'Checked in on office Wi-Fi.'
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_attendance_device(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_attendance_device(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_auto_attendance_setup_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_schedule() TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_for_user(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_by_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  text, text, uuid, double precision, double precision, double precision,
  text, text, bigint, bigint, text, boolean, text, text, text, text
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.test_office_wifi_match(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_office_wifi_networks(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
