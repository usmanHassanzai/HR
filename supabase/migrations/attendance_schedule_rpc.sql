-- attendance_schedule_rpc.sql
-- R34 / R26: next 7 days of windows for a device token (+ JWT helper for dashboard)

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
      'detection_mode', o.detection_mode,
      'wifi_ssids', o.wifi_ssids,
      'wifi_bssids', o.wifi_bssids
      -- public IPs intentionally omitted from device schedule (server-only)
    ) AS z
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
  ) q;

  FOR v_i IN 0..GREATEST(COALESCE(p_days, 7) - 1, 0) LOOP
    -- Probe midday UTC+offset samples; prefer shift TZ by walking hours
    v_at := p_from + (v_i || ' days')::INTERVAL;
    -- Try several offsets within the day so overnight windows are found
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

    IF COALESCE(v_win.has_shift, false) AND v_win.window_start_utc IS NOT NULL THEN
      -- Dedupe by attendance_date
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
          'window_start_utc', v_win.window_start_utc,
          'window_end_utc', v_win.window_end_utc
        ));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now_utc', v_server_now,
    'company_tz', public.company_timezone(v_user.company_id),
    'windows', v_days,
    'zones', COALESCE(v_zone, '[]'::JSONB)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_schedule_by_token(
  p_token_hash TEXT
) RETURNS JSONB
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

  UPDATE public.attendance_devices SET last_seen_at = timezone('utc', now()) WHERE id = v_dev.id;

  RETURN public.attendance_schedule_for_user(v_dev.user_id, timezone('utc', now()), 7)
    || jsonb_build_object('user_id', v_dev.user_id, 'device_row_id', v_dev.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_attendance_schedule()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.attendance_schedule_for_user(auth.uid(), timezone('utc', now()), 7);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_schedule_for_user(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_by_token(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_schedule() TO authenticated;

NOTIFY pgrst, 'reload schema';
