-- FIX_auto_attendance_schedule_detection_2026-10-14.sql
-- Schedule was hardcoding zones as wifi_only, so Android skipped geofences and
-- radius leave/enter. Use the office's real detection_mode (gps_or_wifi).

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
  v_session_open BOOLEAN := false;
  v_open_date DATE := NULL;
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
      'detection_mode', COALESCE(o.detection_mode::text, 'gps_or_wifi'),
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
          'window_end_utc', v_checkin_end,
          'session_open', EXISTS (
            SELECT 1 FROM public.attendance_records ar
            WHERE ar.user_id = p_user_id
              AND ar.attendance_date = v_win.attendance_date
              AND ar.clock_in_at IS NOT NULL
              AND ar.clock_out_at IS NULL
          ) OR EXISTS (
            SELECT 1 FROM public.attendance_visit_segments vs
            WHERE vs.user_id = p_user_id
              AND vs.attendance_date = v_win.attendance_date
              AND vs.clock_out_at IS NULL
          )
        ));
      END IF;
    END IF;
  END LOOP;

  SELECT * INTO v_win
  FROM public.attendance_window_for_user(p_user_id, v_server_now)
  LIMIT 1;
  IF COALESCE(v_win.has_shift, false) AND v_win.attendance_date IS NOT NULL THEN
    v_open_date := v_win.attendance_date;
    v_session_open := EXISTS (
      SELECT 1 FROM public.attendance_records ar
      WHERE ar.user_id = p_user_id
        AND ar.attendance_date = v_open_date
        AND ar.clock_in_at IS NOT NULL
        AND ar.clock_out_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM public.attendance_visit_segments vs
      WHERE vs.user_id = p_user_id
        AND vs.attendance_date = v_open_date
        AND vs.clock_out_at IS NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now_utc', v_server_now,
    'company_tz', public.company_timezone(v_user.company_id),
    'windows', v_days,
    'zones', COALESCE(v_zone, '[]'::JSONB),
    'session_open', v_session_open,
    'session_attendance_date', v_open_date,
    'rule', 'wifi_or_radius_auto_checkin',
    'message', 'Auto check-in: office Wi-Fi first, else office radius; re-entry after checkout allowed in window.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_schedule_for_user(uuid, timestamptz, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.attendance_schedule_for_user(uuid, timestamptz, integer) IS
  'Device/JWT schedule: windows + zones with real office detection_mode (Wi-Fi then radius).';

-- Offices that already have GPS should not stay stuck on wifi_only from older saves.
UPDATE public.office_locations
SET detection_mode = 'gps_or_wifi'
WHERE COALESCE(active, true)
  AND detection_mode = 'wifi_only'
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND NOT (latitude = 0 AND longitude = 0);
