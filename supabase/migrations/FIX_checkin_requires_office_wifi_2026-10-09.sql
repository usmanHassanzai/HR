-- Check-in requires the device public IP to match an active office network.
-- GPS inside the radius does not check anyone in.
-- Work-from-home (work mode remote, or a remote/hybrid day marked by
-- Admin/HR) is not checked in by office Wi-Fi or radius, and may clock in
-- from any network.

CREATE OR REPLACE FUNCTION public.attendance_request_client_ip()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  hdr jsonb;
  cf text;
  xff text;
BEGIN
  BEGIN
    hdr := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF hdr IS NULL THEN
    RETURN NULL;
  END IF;

  cf := NULLIF(btrim(COALESCE(hdr->>'cf-connecting-ip', hdr->>'CF-Connecting-IP', '')), '');
  IF cf IS NOT NULL THEN
    RETURN cf;
  END IF;

  xff := NULLIF(btrim(COALESCE(hdr->>'x-forwarded-for', hdr->>'X-Forwarded-For', '')), '');
  IF xff IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(btrim(split_part(xff, ',', 1)), '');
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_on_assigned_office_wifi(
  p_user_id UUID,
  p_ip TEXT
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
    CROSS JOIN LATERAL public.attendance_match_office_wifi(o.id, p_ip, NULL, NULL) m
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
      AND COALESCE(m.matched, false)
      AND NOT COALESCE(m.ssid_only_suspected, false)
  );
$$;

CREATE OR REPLACE FUNCTION public.attendance_is_wfh_day(
  p_user_id UUID,
  p_date DATE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT u.work_mode::text FROM public.users u WHERE u.id = p_user_id), 'office') = 'remote'
    OR EXISTS (
      SELECT 1
      FROM public.attendance_records ar
      WHERE ar.user_id = p_user_id
        AND ar.attendance_date = p_date
        AND (
          ar.notes ILIKE '%remote work%'
          OR ar.notes ILIKE '%remote day%'
          OR ar.notes ILIKE '%worked remotely%'
          OR ar.notes ILIKE '%hybrid remote%'
        )
    );
$$;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);
  def := replace(def,
$old$    ELSIF NOT public.attendance_checkin_allowed(v_dev.user_id, v_corr.occurred_at) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSE
$old$,
$new$    ELSIF NOT public.attendance_checkin_allowed(v_dev.user_id, v_corr.occurred_at) THEN
      v_action := 'checkin_blocked_shift_ended';
    ELSIF public.attendance_is_wfh_day(v_dev.user_id, v_att_date) THEN
      v_action := 'wfh_skip';
    ELSIF NOT v_wifi_ok THEN
      v_action := 'not_on_office_network';
    ELSE
$new$);
  IF def NOT LIKE '%ELSIF NOT v_wifi_ok THEN%' THEN
    RAISE EXCEPTION 'auto check-in wifi gate did not apply';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);
  def := replace(def,
$old$        ELSIF NOT v_inside THEN
            v_action := 'outside_office';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$old$,
$new$        ELSIF NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
              AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip()) THEN
            v_action := 'not_on_office_network';
        ELSIF NOT public.attendance_checkin_allowed(v_user_id, v_now) THEN
$new$);
  def := replace(def,
    $old$'GPS clock-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'$old$,
    $new$'Office Wi-Fi clock-in',
                v_user_id, v_now, 'wifi'$new$);
  def := replace(def,
$old$        IF v_inside AND (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL) THEN
$old$,
$new$        IF (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL)
           AND NOT public.attendance_is_wfh_day(v_user_id, v_attendance_date)
           AND NOT public.attendance_on_assigned_office_wifi(v_user_id, public.attendance_request_client_ip())
           AND public.attendance_checkin_allowed(v_user_id, v_now) THEN
            v_action := 'not_on_office_network';
        ELSIF false AND v_inside AND (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL) THEN
$new$);
  IF def NOT LIKE '%attendance_on_assigned_office_wifi%' THEN
    RAISE EXCEPTION 'manual check-in wifi gate did not apply';
  END IF;
  IF def NOT LIKE '%ELSIF false AND v_inside%' THEN
    RAISE EXCEPTION 'gps-only auto check-in was not disabled';
  END IF;
  EXECUTE def;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_request_client_ip() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_on_assigned_office_wifi(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_is_wfh_day(UUID, DATE) TO authenticated, service_role;
