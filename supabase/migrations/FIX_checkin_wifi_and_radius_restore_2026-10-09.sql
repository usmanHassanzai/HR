-- Restore: check-in requires office Wi-Fi AND GPS inside radius.
-- Re-apply after older migrations overwrote process_* / check_in_attendance.

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  RAISE EXCEPTION
    'Check-in requires office Wi-Fi and being inside the office radius. Use Clock in with location.';
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated, service_role;

DO $fix$
DECLARE
  def text;
BEGIN
  ------------------------------------------------------------------
  -- AUTO: wifi + GPS accuracy/radius before clock_in
  ------------------------------------------------------------------
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

  -- Laptop / missing-GPS branch: never check in without wifi+radius
  IF def LIKE '%ELSIF v_dev.platform IN (''windows'', ''linux'')%'
     AND def LIKE '%not_on_office_network%' THEN
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
  END IF;

  IF def NOT LIKE '%need_fresh_location%' OR def NOT LIKE '%outside_radius%' THEN
    RAISE EXCEPTION 'auto check-in AND gate did not apply';
  END IF;
  IF def LIKE '%not_on_office_network%' THEN
    RAISE EXCEPTION 'old wifi-only check-in action is still present in auto';
  END IF;
  EXECUTE def;

  ------------------------------------------------------------------
  -- GEO manual + auto: wifi AND radius
  ------------------------------------------------------------------
  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);

  def := replace(def,
$old$        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_network';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$old$,
$new$        ELSIF NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_wifi';
        ELSIF NOT public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN
            v_action := 'outside_radius';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$new$);

  def := replace(def,
    $old$'Office Wi-Fi clock-in',$old$,
    $new$public.attendance_checkin_note(v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date)$new$);

  def := replace(def,
$old$        ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
           AND NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
           AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
           AND public.attendance_checkin_allowed(v_user_id, v_now) THEN
            v_action := 'not_on_office_network';
        ELSIF false AND v_inside AND (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL) THEN
            IF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
                v_action := 'checkin_blocked_shift_ended';
            ELSE
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'auto_gps', v_win.shift_id,
                'Auto GPS check-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE
                  WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
                  THEN 'auto_gps' ELSE public.attendance_records.attendance_source END,
                presence_method = 'gps',
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto GPS entry'
            );
            v_action := 'clock_in';
            END IF;
$old$,
$new$        ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
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
        ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
           AND public.attendance_checkin_allowed(v_user_id, v_now)
           AND public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
           AND public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'auto_wifi', v_win.shift_id,
                public.attendance_checkin_note(
                  v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date
                ),
                v_user_id, v_now, 'wifi'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE
                  WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
                  THEN 'auto_wifi' ELSE public.attendance_records.attendance_source END,
                presence_method = 'wifi',
                notes = CASE
                  WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
                  THEN EXCLUDED.notes ELSE public.attendance_records.notes
                END,
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto entry'
            );
            UPDATE public.attendance_visit_segments SET
              clock_in_lat = COALESCE(clock_in_lat, p_latitude),
              clock_in_lng = COALESCE(clock_in_lng, p_longitude),
              site_name = COALESCE(site_name, v_site_name)
            WHERE user_id = v_user_id
              AND attendance_date = v_attendance_date
              AND clock_out_at IS NULL;
            v_action := 'clock_in';
$new$);

  IF def LIKE '%ELSIF false AND v_inside%' THEN
    RAISE EXCEPTION 'geo GPS-only check-in path is still present';
  END IF;
  IF def LIKE '%not_on_office_network%' THEN
    RAISE EXCEPTION 'old wifi-only geo action is still present';
  END IF;
  IF def NOT LIKE '%attendance_gps_inside_assigned_office%' THEN
    RAISE EXCEPTION 'geo radius gate missing';
  END IF;
  EXECUTE def;
END
$fix$;

NOTIFY pgrst, 'reload schema';
