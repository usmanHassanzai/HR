-- Check out on one usable GPS reading outside the saved office radius.
-- A usable checkout reading has accuracy <= 50 m. There is no extra buffer.
-- Checkout runs from shift start until 1 hour after shift end.
-- Logout, missing GPS, and a Wi-Fi drop still do not check anyone out.

CREATE OR REPLACE FUNCTION public.geo_confirm_left_site(
  p_distance DOUBLE PRECISION,
  p_effective_radius DOUBLE PRECISION,
  p_prev_inside BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF p_distance IS NULL OR p_effective_radius IS NULL THEN
    RETURN FALSE;
  END IF;
  -- One reading outside the saved radius is enough. p_prev_inside is unused.
  RETURN p_distance > p_effective_radius;
END;
$fn$;

DO $out$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure);

  def := replace(def,
$old$    v_gps_ok := v_gps_usable AND v_dist <= v_eff_radius;
    v_gps_inside := v_gps_usable AND v_dist <= v_exit_radius;
    v_gps_outside := v_gps_usable AND v_dist > v_exit_radius;
$old$,
$new$    v_gps_ok := v_gps_usable AND v_dist <= v_eff_radius;
    v_gps_inside := v_gps_usable AND v_dist <= v_exit_radius;
    -- Check-out ignores a reading worse than 50 m. Distance uses the saved radius.
    v_gps_outside := v_gps_has_fix
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 50
      AND v_dist > v_exit_radius;
$new$);

  def := replace(def,
$old$      ELSIF v_gps_outside AND NOT v_wifi_ok AND v_outside_streak >= 2 THEN
        -- Not on office Wi-Fi and the location is outside the office radius.
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
$old$,
$new$      ELSIF v_gps_outside AND NOT v_wifi_ok
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        -- One usable outside reading. Not on office Wi-Fi.
        -- From shift start until 1 hour after shift end.
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
$new$);

  def := replace(def,
$old$      ELSIF v_gps_outside AND NOT v_wifi_ok AND NOT v_laptop_ok THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
$old$,
$new$      ELSIF v_gps_outside AND NOT v_wifi_ok AND NOT v_laptop_ok
            AND v_corr.occurred_at >= v_win.shift_start_utc
            AND v_corr.occurred_at <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc) THEN
        v_present := false;
        v_left := true;
        v_leave_mode := 'immediate';
$new$);

  def := replace(def,
$old$  IF v_dup AND v_event NOT IN ('heartbeat', 'ping') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
$old$,
$new$  IF v_dup AND v_event NOT IN ('heartbeat', 'ping', 'exit') AND v_leave_mode IS DISTINCT FROM 'immediate' THEN
$new$);

  IF def NOT LIKE '%p_accuracy_m <= 50%' THEN
    RAISE EXCEPTION 'checkout accuracy gate did not apply';
  END IF;
  IF def LIKE '%v_outside_streak >= 2%' THEN
    RAISE EXCEPTION 'phone still requires two outside readings';
  END IF;
  EXECUTE def;

  def := pg_get_functiondef('public.process_geo_attendance_ping(double precision,double precision,double precision,text)'::regprocedure);
  def := replace(def,
$old$    v_left_site := public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);
$old$,
$new$    v_left_site := p_accuracy IS NOT NULL
      AND p_accuracy <= 50
      AND v_now >= v_win.shift_start_utc
      AND v_now <= COALESCE(v_win.shift_end_utc + interval '1 hour', v_win.window_end_utc)
      AND public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);
$new$);
  IF def NOT LIKE '%p_accuracy <= 50%' THEN
    RAISE EXCEPTION 'geo checkout accuracy gate did not apply';
  END IF;
  EXECUTE def;
END $out$;
