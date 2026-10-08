-- Opening attendance history must not check anyone out.
-- A weak GPS reading is not an exit when the office network or a fresh check-in says they are here.
-- History shows "still present" while a phone or laptop is still marked present.

CREATE OR REPLACE FUNCTION public.reconcile_ended_shift_attendance()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v1 INTEGER;
BEGIN
  v1 := public.attendance_close_ended_windows();
  RETURN v1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.attendance_history_still_open(
    p_user_id uuid,
    p_clock_in timestamptz,
    p_any_open boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(p_any_open, false)
    OR EXISTS (
      SELECT 1
      FROM public.attendance_devices d
      WHERE d.user_id = p_user_id
        AND d.revoked_at IS NULL
        AND d.presence_state = 'present'
        AND d.last_presence_at IS NOT NULL
        AND d.last_presence_at > timezone('utc', now()) - INTERVAL '12 hours'
        AND (
          p_clock_in IS NULL
          OR (
            d.last_presence_at >= p_clock_in - INTERVAL '2 minutes'
            AND d.last_presence_at <= p_clock_in + INTERVAL '20 hours'
          )
        )
    );
$$;

GRANT EXECUTE ON FUNCTION public.attendance_history_still_open(uuid, timestamptz, boolean) TO authenticated, service_role;

DO $$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.attendance_close_stale_presence()'::regprocedure);
  def := replace(def,
$old$    IF v_any_present THEN
      CONTINUE;
    END IF;
$old$,
$new$    IF v_any_present THEN
      CONTINUE;
    END IF;

    -- A check-in from the last 15 minutes is not an exit.
    IF EXISTS (
      SELECT 1
      FROM public.attendance_visit_segments vs
      WHERE vs.user_id = r.user_id
        AND vs.attendance_date = r.attendance_date
        AND vs.clock_in_at > v_now - INTERVAL '15 minutes'
    ) THEN
      CONTINUE;
    END IF;

    -- Office Wi-Fi or a recent inside reading means they are still here.
    IF EXISTS (
      SELECT 1
      FROM public.attendance_events_log e
      WHERE e.user_id = r.user_id
        AND e.accepted IS TRUE
        AND e.occurred_at > v_now - INTERVAL '30 minutes'
        AND (
          e.matched_method IN ('wifi', 'laptop', 'gps')
          OR e.wifi_network_id IS NOT NULL
          OR (
            e.zone_id IS NOT NULL
            AND e.client_ip IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.attendance_match_office_wifi(e.zone_id, e.client_ip, NULL, NULL) m
              WHERE COALESCE(m.matched, false)
            )
          )
        )
    ) THEN
      CONTINUE;
    END IF;
$new$);
  IF strpos(def, 'A check-in from the last 15 minutes') = 0 THEN
    RAISE EXCEPTION 'stale close patch did not apply';
  END IF;
  EXECUTE def;
END $$;

DO $$
DECLARE
  def text;
  fname text;
BEGIN
  FOREACH fname IN ARRAY ARRAY[
    'public.get_attendance_history(integer,integer,uuid)',
    'public.get_team_attendance_history(integer,integer,uuid,uuid,text)'
  ]
  LOOP
    def := pg_get_functiondef(fname::regprocedure);
    def := replace(
      def,
      'COALESCE(vis.any_open, false)',
      'public.attendance_history_still_open(ar.user_id, COALESCE(ar.clock_in_at, vis.first_in), COALESCE(vis.any_open, false))'
    );
    IF strpos(def, 'attendance_history_still_open') = 0 THEN
      RAISE EXCEPTION 'history patch did not apply for %', fname;
    END IF;
    EXECUTE def;
  END LOOP;
END $$;
