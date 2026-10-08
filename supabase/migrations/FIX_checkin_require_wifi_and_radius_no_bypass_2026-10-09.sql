-- Permanent: check-in only when office public IP matches AND GPS is inside
-- the saved radius (accuracy <= 100 m). Close the check_in_attendance bypass
-- that let people mark present with no Wi-Fi and no location. Restore geo
-- auto check-in when BOTH conditions are true (it was left disabled).

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
  -- This RPC has no GPS reading. It must never create a visit.
  -- Office check-in only goes through process_geo_attendance_ping /
  -- process_auto_attendance_event, which require office Wi-Fi AND radius.
  RAISE EXCEPTION
    'Check-in requires office Wi-Fi and being inside the office radius. Use Clock in with location.';
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated, service_role;

DO $fix$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);

  -- Manual Clock in: never skip Wi-Fi / radius for WFH (remote marking is separate).
  def := replace(def,
$old$        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_wifi';
        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN
            v_action := 'outside_radius';
$old$,
$new$        ELSIF NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_wifi';
        ELSIF NOT public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN
            v_action := 'outside_radius';
$new$);

  -- Auto path: reject when missing Wi-Fi or radius (including former WFH skip hole).
  def := replace(def,
$old$        ELSIF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
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
                reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'auto_wifi', v_win.shift_id,
                public.attendance_checkin_note(
                  v_user_id, public.attendance_request_client_ip(), p_latitude, p_longitude, v_attendance_date
                ),
                v_user_id, v_now, 'wifi',
                NULL, NULL
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
  IF def NOT LIKE '%AND public.attendance_gps_inside_assigned_office(v_user_id, p_latitude, p_longitude, p_accuracy) THEN%' THEN
    RAISE EXCEPTION 'geo AND check-in success path missing';
  END IF;
  IF position(
    'ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)' || E'\n'
    || '              AND NOT public.attendance_on_assigned_office_wifi'
    IN def
  ) > 0 THEN
    RAISE EXCEPTION 'WFH still bypasses manual wifi gate';
  END IF;

  EXECUTE def;
END
$fix$;

-- Auto device path already has wifi + GPS gates. Keep WFH as skip (no office check-in).
-- Fail closed if the old wifi-only note format is still the only insert note.
DO $auto$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);
  IF def NOT LIKE '%not_on_office_wifi%' OR def NOT LIKE '%outside_radius%' THEN
    RAISE EXCEPTION 'auto check-in AND gate missing';
  END IF;
  IF def LIKE '%not_on_office_network%' THEN
    RAISE EXCEPTION 'old auto wifi-only action returned';
  END IF;
END
$auto$;

NOTIFY pgrst, 'reload schema';
