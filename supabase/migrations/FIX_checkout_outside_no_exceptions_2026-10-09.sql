-- Outside the saved office radius checks the person out.
-- Office Wi-Fi no longer blocks check-out.
-- Another enrolled device that is still present no longer delays check-out.
-- The pre-enrollment 20-minute office-Wi-Fi sticky rule is removed.
-- Re-entry still needs inside the radius AND office Wi-Fi (existing check-in AND rule).
-- Stay checked in while inside the radius. A Wi-Fi drop alone never checks out.

CREATE OR REPLACE FUNCTION public.attendance_user_on_office_network(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- No longer used to block check-out. Always false.
  SELECT false;
$$;

DO $out$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);

  def := replace(def,
$old$      IF v_gps_outside THEN
        v_outside_streak := LEAST(COALESCE(v_dev.gps_outside_streak, 0) + 1, 10);
      ELSIF v_gps_inside OR v_gps_ok OR v_wifi_ok THEN
        v_outside_streak := 0;
      ELSE
        v_outside_streak := COALESCE(v_dev.gps_outside_streak, 0);
      END IF;

      IF v_wifi_ok OR v_gps_inside OR v_gps_ok THEN
        -- Office Wi-Fi or inside the office radius: stay checked in.
        -- Logging out of Scorr must not check them out.
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
        IF v_wifi_ok OR v_gps_inside THEN
          v_outside_streak := 0;
        END IF;
      ELSIF v_gps_outside AND NOT v_wifi_ok
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        -- One usable outside reading. Not on office Wi-Fi.
        -- From shift start until 1 hour after shift end.
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSE
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
$old$,
$new$      IF v_gps_outside THEN
        v_outside_streak := LEAST(COALESCE(v_dev.gps_outside_streak, 0) + 1, 10);
      ELSIF v_gps_inside OR v_gps_ok THEN
        v_outside_streak := 0;
      ELSE
        v_outside_streak := COALESCE(v_dev.gps_outside_streak, 0);
      END IF;

      IF v_gps_outside
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        -- Outside the radius: check out even on office Wi-Fi.
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSIF v_gps_inside OR v_gps_ok THEN
        -- Inside the radius: stay checked in. Wi-Fi is not required to stay.
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
        v_outside_streak := 0;
      ELSE
        -- Missing GPS or a Wi-Fi drop: do not check out.
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
$new$);

  def := replace(def,
$old$      IF v_wifi_ok OR v_gps_ok OR v_laptop_ok THEN
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSIF v_gps_outside AND NOT v_wifi_ok AND NOT v_laptop_ok
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSE
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
$old$,
$new$      IF v_gps_outside
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
      ELSIF v_gps_ok OR v_gps_inside THEN
        v_present := true;
        v_left := false;
        v_leave_mode := NULL;
      ELSE
        -- No usable outside reading. Wi-Fi drop / sleep is not a check-out.
        v_present := false;
        v_left := false;
        v_leave_mode := NULL;
      END IF;
$new$);

  def := replace(def,
$old$  -- Inside the office radius, or on any saved office Wi-Fi: stay checked in.
  -- Laptop power-off, logout, and a Wi-Fi drop are not a check-out.
  IF v_wifi_ok OR v_gps_inside OR v_gps_ok THEN
    v_present := true;
    v_left := false;
    v_leave_mode := NULL;
  END IF;
$old$,
$new$  -- Inside the office radius: stay checked in. An outside reading already set leave.
  -- Laptop power-off, logout, and a Wi-Fi drop are not a check-out.
  IF (v_gps_inside OR v_gps_ok) AND NOT COALESCE(v_gps_outside, false) THEN
    v_present := true;
    v_left := false;
    v_leave_mode := NULL;
  END IF;
$new$);

  def := replace(def,
$old$  ELSIF v_left AND NOT v_wifi_ok AND NOT COALESCE(v_gps_inside, false) THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id,
      gps_outside_streak = CASE
        WHEN v_dev.platform IN ('android', 'ios') THEN v_outside_streak
        ELSE gps_outside_streak
      END
    WHERE id = v_dev.id;
$old$,
$new$  ELSIF v_left THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id,
      gps_outside_streak = 0
    WHERE user_id = v_dev.user_id
      AND revoked_at IS NULL;
$new$);

  def := replace(def,
$old$  IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present THEN
$old$,
$new$  IF v_event = 'heartbeat' AND v_wifi_ok AND NOT v_present AND NOT COALESCE(v_left, false) THEN
$new$);

  def := replace(def,
$old$  ELSIF v_left AND v_leave_mode = 'immediate' AND NOT v_wifi_ok AND NOT COALESCE(v_gps_inside, false) THEN
    -- Only real office presence (last_presence_at) blocks check-out — never laptop
    -- heartbeats off Wi-Fi, which used to refresh last_heartbeat_at and stuck R54.
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_dev.user_id
        AND d.revoked_at IS NULL
        AND d.id <> v_dev.id
        AND d.presence_state = 'present'
        AND d.last_presence_at IS NOT NULL
        AND d.last_presence_at > v_now - INTERVAL '15 minutes'
    ) INTO v_other_present;

    IF NOT v_other_present
       AND v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
$old$,
$new$  ELSIF v_left AND v_leave_mode = 'immediate' THEN
    -- Outside the radius checks the person out on this reading.
    -- Other enrolled devices do not delay check-out.
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
$new$);

  def := replace(def,
$old$    ELSE
      v_action := CASE WHEN v_other_present THEN 'device_left_others_present' ELSE 'no_open_visit' END;
    END IF;

  ELSIF v_left AND COALESCE(v_leave_mode, 'grace') = 'grace' THEN
$old$,
$new$      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = v_dev.user_id
        AND revoked_at IS NULL;
    ELSE
      v_action := 'no_open_visit';
      UPDATE public.attendance_devices SET
        presence_state = 'left',
        gps_outside_streak = 0
      WHERE user_id = v_dev.user_id
        AND revoked_at IS NULL;
    END IF;

  ELSIF v_left AND COALESCE(v_leave_mode, 'grace') = 'grace' THEN
$new$);

  IF def LIKE '%device_left_others_present%' THEN
    RAISE EXCEPTION 'other-device checkout wait is still present';
  END IF;
  IF def LIKE '%v_gps_outside AND NOT v_wifi_ok%' THEN
    RAISE EXCEPTION 'wifi still blocks outside checkout';
  END IF;
  IF def LIKE '%v_leave_mode = ''immediate'' AND NOT v_wifi_ok%' THEN
    RAISE EXCEPTION 'wifi still gates the checkout branch';
  END IF;
  IF def NOT LIKE '%Outside the radius: check out even on office Wi-Fi%' THEN
    RAISE EXCEPTION 'outside-radius checkout rule did not apply';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);
  def := replace(def,
$old$        ELSIF v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL
              AND NOT public.attendance_user_on_office_network(v_user_id) THEN
$old$,
$new$        ELSIF v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
$new$);
  IF def LIKE '%attendance_user_on_office_network%' THEN
    RAISE EXCEPTION 'geo still uses office-network checkout block';
  END IF;
  EXECUTE def;
END $out$;

GRANT EXECUTE ON FUNCTION public.attendance_user_on_office_network(UUID) TO authenticated, service_role;
