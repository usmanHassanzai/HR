-- ROLLBACK wifi_match_any_saved_network_2026-10-21
-- Restores SSID normalize from fix_office_wifi_match_robust_2026-10-13,
-- BSSID + match from wifi_match_any_saved_ssid_bssid_2026-10-15,
-- and early checkout from FIX_auto_reentry_session_probe_2026-10-14
-- (no desktop stay-checked-in guard).
-- Does not drop tables or delete attendance rows.

CREATE OR REPLACE FUNCTION public.attendance_normalize_ssid(p_ssid TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(btrim(btrim(COALESCE(p_ssid, '')), '"'), '');
$$;

CREATE OR REPLACE FUNCTION public.attendance_ssid_in_list(p_ssid TEXT, p_list TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    public.attendance_normalize_ssid(p_ssid) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_list, '{}'::text[])) AS s(ssid)
      WHERE lower(public.attendance_normalize_ssid(s.ssid))
          = lower(public.attendance_normalize_ssid(p_ssid))
    );
$$;

CREATE OR REPLACE FUNCTION public.attendance_normalize_bssid(p_bssid TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    lower(replace(btrim(COALESCE(p_bssid, '')), '-', ':')),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.attendance_bssid_in_list(p_bssid TEXT, p_list TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    public.attendance_normalize_bssid(p_bssid) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_list, '{}'::text[])) AS b(bssid)
      WHERE public.attendance_normalize_bssid(b.bssid)
          = public.attendance_normalize_bssid(p_bssid)
    );
$$;

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
  v_ssid TEXT := public.attendance_normalize_ssid(p_ssid);
  v_bssid TEXT := public.attendance_normalize_bssid(p_bssid);
  v_net_count INT := 0;
  v_has_ssid BOOLEAN;
  v_has_bssid BOOLEAN;
  v_has_ip BOOLEAN;
  v_ssid_hit BOOLEAN;
  v_bssid_hit BOOLEAN;
  v_ip_hit BOOLEAN;
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
        WHEN public.attendance_ssid_in_list(v_ssid, o.wifi_ssids) THEN true
        WHEN public.attendance_bssid_in_list(v_bssid, o.wifi_bssids) THEN true
        WHEN cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
          AND public.attendance_ip_in_cidrs(p_client_ip, o.public_ip_cidrs)
        THEN true
        ELSE false
      END,
      CASE
        WHEN public.attendance_ssid_in_list(v_ssid, o.wifi_ssids)
          AND cardinality(COALESCE(o.wifi_bssids, '{}')) = 0
          AND cardinality(COALESCE(o.public_ip_cidrs, '{}')) = 0
        THEN true
        ELSE false
      END
    INTO matched, ssid_only_suspected
    FROM public.office_locations o
    WHERE o.id = p_office_id;
    IF matched IS NULL THEN
      matched := false;
      ssid_only_suspected := false;
    END IF;
    -- Never match when location has no Wi-Fi / IP identifiers configured
    IF matched AND NOT EXISTS (
      SELECT 1 FROM public.office_locations o
      WHERE o.id = p_office_id
        AND (
          cardinality(COALESCE(o.wifi_ssids, '{}')) > 0
          OR cardinality(COALESCE(o.wifi_bssids, '{}')) > 0
          OR cardinality(COALESCE(o.public_ip_cidrs, '{}')) > 0
        )
    ) THEN
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
    v_has_ssid := cardinality(COALESCE(n.ssids, '{}')) > 0;
    v_has_bssid := cardinality(COALESCE(n.wifi_bssids, '{}')) > 0;
    v_has_ip := cardinality(COALESCE(n.public_ip_cidrs, '{}')) > 0;

    IF NOT v_has_ssid AND NOT v_has_bssid AND NOT v_has_ip THEN
      CONTINUE;
    END IF;

    v_ssid_hit := v_has_ssid AND public.attendance_ssid_in_list(v_ssid, n.ssids);
    v_bssid_hit := v_has_bssid AND public.attendance_bssid_in_list(v_bssid, n.wifi_bssids);
    v_ip_hit := v_has_ip AND public.attendance_ip_in_cidrs(p_client_ip, n.public_ip_cidrs);

    -- ANY saved identifier on this network row is enough (multi-SSID offices / mesh APs).
    IF v_ssid_hit OR v_bssid_hit OR v_ip_hit THEN
      matched := true;
      network_id := n.id;
      network_label := COALESCE(
        NULLIF(btrim(n.label), ''),
        CASE WHEN v_ssid_hit THEN v_ssid ELSE n.ssids[1] END
      );
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

-- Keep office_locations.wifi_* as the union of all active network rows (schedule / clients).
DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'sync_office_location_wifi_aggregates'
  ) THEN
    FOR r IN SELECT id FROM public.office_locations LOOP
      PERFORM public.sync_office_location_wifi_aggregates(r.id);
    END LOOP;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_normalize_bssid(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_bssid_in_list(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_match_office_wifi(UUID, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.attendance_match_office_wifi(uuid, text, text, text) IS
  'Matches ANY saved office Wi-Fi for a location: case-insensitive SSID OR normalized BSSID OR public IP. Empty configs / unsaved public Wi-Fi never match.';

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

NOTIFY pgrst, 'reload schema';
