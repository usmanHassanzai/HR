-- During the shift, employee, manager, and HR stay checked in when they are
-- inside the office radius or on any saved office Wi-Fi.
-- Check out only when a real GPS fix is outside that radius and they are not
-- on any saved office Wi-Fi. Silence, logout, a Wi-Fi drop, and laptop
-- power-off are not a check-out.

CREATE OR REPLACE FUNCTION public.attendance_close_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A quiet phone is not proof they left. Checkout is an outside-radius
  -- reading while they are not on office Wi-Fi, handled by the live ping.
  RETURN 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;

CREATE OR REPLACE FUNCTION public.attendance_user_on_office_network(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND d.last_presence_at IS NOT NULL
      AND d.last_presence_at > public.attendance_now() - INTERVAL '20 minutes'
      AND (
        d.last_matched_method IN ('wifi', 'laptop')
        OR EXISTS (
          SELECT 1
          FROM public.attendance_events_log e
          WHERE e.device_id = d.id
            AND e.accepted = true
            AND e.created_at > public.attendance_now() - INTERVAL '20 minutes'
            AND COALESCE(e.payload->>'wifi_ok', '') = 'true'
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.attendance_user_on_office_network(UUID) TO authenticated, service_role;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);

  def := replace(def,
$old$  IF v_zone.detection_mode = 'gps_only' THEN
    v_present := v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat');
    v_left := (NOT v_gps_ok) AND v_event IN ('exit', 'ping');
    IF v_left AND v_gps_outside THEN
      v_leave_mode := 'immediate';
    ELSIF v_left AND NOT v_gps_usable THEN
      v_leave_mode := 'grace';
    END IF;
  ELSIF v_zone.detection_mode = 'wifi_only' THEN
    v_present := v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter');
    v_left := (NOT v_wifi_ok) AND v_event IN ('wifi_disconnected', 'power_off', 'exit');
    IF v_left THEN
      v_leave_mode := CASE WHEN v_event = 'power_off' THEN 'immediate' ELSE 'grace' END;
    END IF;
  ELSE
    -- gps_or_wifi (default)
    v_present := (
      (v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat'))
      OR (v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter'))
      OR (v_laptop_ok)
    );
    v_left := false;

    IF v_dev.platform IN ('android', 'ios') THEN
$old$,
$new$  IF true THEN
    IF v_dev.platform IN ('android', 'ios') THEN
$new$);

  def := replace(def,
$old$    END IF;
  END IF;

  IF v_event = 'power_off' THEN
    v_left := true;
    v_present := false;
    v_leave_mode := 'immediate';
  END IF;
$old$,
$new$    END IF;
  END IF;

  -- Inside the office radius, or on any saved office Wi-Fi: stay checked in.
  -- Laptop power-off, logout, and a Wi-Fi drop are not a check-out.
  IF v_wifi_ok OR v_gps_inside OR v_gps_ok THEN
    v_present := true;
    v_left := false;
    v_leave_mode := NULL;
  END IF;
$new$);

  def := replace(def,
$old$  ELSIF v_left OR v_event IN ('exit', 'wifi_disconnected', 'power_off') THEN
$old$,
$new$  ELSIF v_left AND NOT v_wifi_ok AND NOT COALESCE(v_gps_inside, false) THEN
$new$);

  def := replace(def,
$old$  ELSIF v_left AND v_leave_mode = 'immediate' THEN
$old$,
$new$  ELSIF v_left AND v_leave_mode = 'immediate' AND NOT v_wifi_ok AND NOT COALESCE(v_gps_inside, false) THEN
$new$);

  IF strpos(def, 'Inside the office radius, or on any saved office Wi-Fi') = 0
     OR strpos(def, 'IF v_event = ''power_off'' THEN') > 0
     OR strpos(def, 'ELSIF v_left OR v_event IN (''exit'', ''wifi_disconnected'', ''power_off'')') > 0
     OR strpos(def, 'IF true THEN') = 0 THEN
    RAISE EXCEPTION 'checkout rule patch did not apply';
  END IF;

  EXECUTE def;
END $$;
