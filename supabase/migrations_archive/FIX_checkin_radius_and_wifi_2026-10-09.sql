-- Check-in requires BOTH an office public IP and a usable GPS reading
-- inside the saved office radius (accuracy <= 100 m, not mock).
-- Either one alone does not check anyone in.
-- Work-from-home stays exempt. Check-out rules are unchanged.

CREATE OR REPLACE FUNCTION public.attendance_gps_inside_assigned_office(
  p_user_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_accuracy DOUBLE PRECISION
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.employee_work_sites ews
    JOIN public.office_locations o ON o.id = ews.office_location_id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
      AND p_lat IS NOT NULL
      AND p_lng IS NOT NULL
      AND p_accuracy IS NOT NULL
      AND p_accuracy <= 100
      AND public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude)
          <= COALESCE(o.radius_meters, 150)
  );
$$;

CREATE OR REPLACE FUNCTION public.attendance_checkin_note(
  p_user_id UUID,
  p_ip TEXT,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_date DATE
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_label text;
  v_dist integer;
BEGIN
  IF public.attendance_is_wfh_day(p_user_id, p_date) THEN
    RETURN 'Work from home check-in';
  END IF;

  SELECT o.name,
         m.network_label,
         CASE
           WHEN p_lat IS NULL OR p_lng IS NULL THEN NULL
           ELSE ROUND(public.haversine_meters(p_lat, p_lng, o.latitude, o.longitude))::integer
         END
    INTO v_name, v_label, v_dist
  FROM public.employee_work_sites ews
  JOIN public.office_locations o ON o.id = ews.office_location_id
  LEFT JOIN LATERAL public.attendance_match_office_wifi(o.id, p_ip, NULL, NULL) m ON true
  WHERE ews.user_id = p_user_id
    AND COALESCE(ews.tracking_enabled, true)
    AND COALESCE(o.active, true)
  ORDER BY COALESCE(m.matched, false) DESC, COALESCE(m.ssid_only_suspected, false) ASC, o.name
  LIMIT 1;

  RETURN 'Checked in at ' || COALESCE(v_name, 'office')
    || ' · ' || COALESCE(NULLIF(v_label, ''), 'office Wi-Fi')
    || ' · ' || COALESCE(v_dist::text, '?') || 'm from the office';
END;
$$;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);

  def := replace(def,
$old$    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_network';
    ELSE
$old$,
$new$    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_wifi';
    ELSIF NOT (
      v_gps_inside
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 100
    ) THEN
      v_action := CASE
        WHEN v_dev.platform IN ('windows', 'linux')
             AND NOT (
               p_latitude IS NOT NULL
               AND p_longitude IS NOT NULL
               AND p_accuracy_m IS NOT NULL
               AND p_accuracy_m <= 100
             )
          THEN 'need_fresh_location'
        ELSE 'outside_radius'
      END;
    ELSE
$new$);

  def := replace(def,
$old$        'Auto check-in (' || COALESCE(v_method, 'auto') || ') at ' || COALESCE(v_zone.name, 'office')
          || CASE WHEN v_wifi_network_label IS NOT NULL THEN ' [' || v_wifi_network_label || ']' ELSE '' END,
$old$,
$new$        'Checked in at ' || COALESCE(v_zone.name, 'office')
          || ' · ' || COALESCE(v_wifi_network_label, 'office Wi-Fi')
          || ' · ' || COALESCE(ROUND(v_dist)::int, 0) || 'm from the office',
$new$);

  def := replace(def,
$old$  ELSIF v_dev.platform IN ('windows', 'linux')
     AND v_event IN ('ping', 'heartbeat', 'power_on') THEN
    -- Laptop is inside the shift clocks but not on office Wi-Fi.
    -- Keep an open phone check-in. Do not clock out.
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_checked_in';
    ELSE
      v_action := 'not_on_office_network';
    END IF;
$old$,
$new$  ELSIF v_event IN ('ping', 'heartbeat', 'power_on') THEN
    -- Keep an open visit. Do not clock out from this branch.
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      v_action := 'already_checked_in';
    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_wifi';
    ELSIF v_dev.platform IN ('windows', 'linux')
          AND NOT (
            p_latitude IS NOT NULL
            AND p_longitude IS NOT NULL
            AND p_accuracy_m IS NOT NULL
            AND p_accuracy_m <= 100
          ) THEN
      v_action := 'need_fresh_location';
    ELSE
      v_action := 'outside_radius';
    END IF;
$new$);

  IF def NOT LIKE '%need_fresh_location%' OR def NOT LIKE '%outside_radius%' THEN
    RAISE EXCEPTION 'auto check-in AND gate did not apply';
  END IF;
  IF def LIKE '%not_on_office_network%' THEN
    RAISE EXCEPTION 'old wifi-only check-in action is still present';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);

  def := replace(def,
$old$        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_network';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$old$,
$new$        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_wifi';
        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN
            v_action := 'outside_radius';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$new$);

  def := replace(def,
    $old$'Office Wi-Fi clock-in',$old$,
    $new$public.attendance_checkin_note(v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date)$new$);

  def := replace(def,
$old$        IF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
           AND NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
           AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
           AND public.attendance_checkin_allowed(v_user_id, v_now) THEN
            v_action := 'not_on_office_network';
$old$,
$new$        IF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
           AND NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
           AND public.attendance_checkin_allowed(v_user_id, v_now)
           AND NOT (
             public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
             AND public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy)
           ) THEN
            v_action := CASE
              WHEN NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
                THEN 'not_on_office_wifi'
              ELSE 'outside_radius'
            END;
$new$);

  IF def NOT LIKE '%attendance_gps_inside_assigned_office%' THEN
    RAISE EXCEPTION 'manual check-in AND gate did not apply';
  END IF;
  IF def NOT LIKE '%attendance_checkin_note%' THEN
    RAISE EXCEPTION 'check-in note was not updated';
  END IF;
  IF def LIKE '%not_on_office_network%' THEN
    RAISE EXCEPTION 'old manual wifi-only action is still present';
  END IF;
  EXECUTE def;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_gps_inside_assigned_office(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_checkin_note(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DATE) TO authenticated, service_role;
