-- iOS-only attendance silence + Rule 5 stale/imprecise guards.
-- Re-runnable. Does NOT change Android / desktop / web silence timeouts,
-- check-in rules, Rule 6, or manual Clock in/out.
-- LAST migration in apply-all-migrations.mjs.

-- ---------------------------------------------------------------------------
-- Company setting: iOS office-signal silence timeout (default 30 minutes)
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ios_office_signal_timeout INTEGER NOT NULL DEFAULT 30;

UPDATE public.companies
SET ios_office_signal_timeout = 30
WHERE ios_office_signal_timeout IS NULL OR ios_office_signal_timeout < 1;

ALTER TABLE public.companies
  ALTER COLUMN ios_office_signal_timeout SET DEFAULT 30;

COMMENT ON COLUMN public.companies.ios_office_signal_timeout IS
  'iOS-only Rule 5b: minutes without office network before silent check-out (default 30).';

-- ---------------------------------------------------------------------------
-- Helpers: iOS silence mode + later outside GPS after an inside reading
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_user_uses_ios_silence_rules(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_has_ios boolean := false;
  v_non_ios_in_visit boolean := false;
  v_visit_in timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT MAX(clock_in_at) INTO v_visit_in
  FROM public.attendance_visit_segments
  WHERE user_id = p_user_id
    AND clock_in_at IS NOT NULL
    AND clock_out_at IS NULL;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND lower(COALESCE(d.platform, '')) IN ('ios', 'iphone', 'ipad')
  ) INTO v_has_ios;

  IF NOT v_has_ios THEN
    RETURN false;
  END IF;

  -- Non-iOS device that sent a signal during this open visit (or recently if no visit)
  -- → keep normal 5b/5c (laptop/Android counts).
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND lower(COALESCE(d.platform, '')) NOT IN ('ios', 'iphone', 'ipad')
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at >= COALESCE(v_visit_in, timezone('utc', now()) - INTERVAL '12 hours')
  ) INTO v_non_ios_in_visit;

  RETURN NOT v_non_ios_in_visit;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_ios_last_inside_gps_uncontradicted(
  p_user_id uuid,
  p_since timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_inside timestamptz;
  v_later_outside boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT last_inside_gps_at INTO v_inside
  FROM public.users WHERE id = p_user_id;

  IF v_inside IS NULL THEN
    RETURN false;
  END IF;
  IF p_since IS NOT NULL AND v_inside < p_since THEN
    RETURN false;
  END IF;

  -- A later usable GPS reading marked outside contradicts the inside hold.
  SELECT EXISTS (
    SELECT 1
    FROM public.attendance_events_log e
    WHERE e.user_id = p_user_id
      AND e.accepted IS TRUE
      AND e.occurred_at > v_inside
      AND e.latitude IS NOT NULL
      AND e.longitude IS NOT NULL
      AND e.accuracy_m IS NOT NULL
      AND e.accuracy_m >= 0
      AND e.accuracy_m <= 50
      AND COALESCE((e.payload->>'gps_outside')::boolean, false) = true
      AND COALESCE((e.payload->>'is_mock')::boolean, false) = false
  ) INTO v_later_outside;

  RETURN NOT v_later_outside;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_user_uses_ios_silence_rules(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_ios_last_inside_gps_uncontradicted(uuid, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rule 5c: skip entirely for iOS silence-mode users
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_apply_rule_5c()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
  v_n integer := 0;
  v_now timestamptz := timezone('utc', now());
  v_timeout interval;
  v_last timestamptz;
  v_inside timestamptz;
  v_win RECORD;
  v_note text := 'Device offline (no Wi-Fi or mobile data)';
  v_msg text;
  v_visit_in timestamptz;
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           COALESCE(c.attendance_offline_minutes, 3) AS offline_mins,
           u.last_any_signal_at, u.last_inside_gps_at, u.work_mode
    FROM public.attendance_visit_segments vs
    JOIN public.users u ON u.id = vs.user_id
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NULL
  LOOP
    IF COALESCE(r.work_mode::text, 'office') = 'remote' THEN
      CONTINUE;
    END IF;
    IF public.attendance_is_wfh_day(r.user_id, r.attendance_date) THEN
      CONTINUE;
    END IF;

    -- iOS-only (no non-iOS signal in this visit): do not apply 5c.
    IF public.attendance_user_uses_ios_silence_rules(r.user_id) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    v_timeout := make_interval(mins => GREATEST(1, r.offline_mins));
    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_last := r.last_any_signal_at;
    IF v_last IS NULL THEN
      SELECT MAX(clock_in_at) INTO v_last
      FROM public.attendance_visit_segments
      WHERE user_id = r.user_id AND clock_out_at IS NULL;
    END IF;
    IF v_last IS NULL OR v_last > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF public.attendance_close_visit_with_note(r.user_id, v_last, v_note, false) > 0 THEN
      v_msg := format(
        'You were checked out at %s because your device was offline.',
        to_char(timezone(COALESCE(public.company_timezone(r.company_id), 'UTC'), v_last), 'HH12:MI AM')
      );
      UPDATE public.users SET
        pending_attendance_notify = v_msg,
        pending_attendance_notify_at = v_now
      WHERE id = r.user_id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rule 5b: iOS silence-mode uses ios_office_signal_timeout + inside-GPS hold
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_apply_rule_5b()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
  v_n integer := 0;
  v_now timestamptz := timezone('utc', now());
  v_timeout interval;
  v_last timestamptz;
  v_inside timestamptz;
  v_win RECORD;
  v_note text;
  v_msg text;
  v_local text;
  v_ios boolean;
  v_mins integer;
  v_visit_in timestamptz;
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           COALESCE(c.attendance_no_office_wifi_minutes, 10) AS no_wifi_mins,
           COALESCE(c.ios_office_signal_timeout, 30) AS ios_timeout_mins,
           u.last_office_signal_at, u.last_inside_gps_at, u.work_mode
    FROM public.attendance_visit_segments vs
    JOIN public.users u ON u.id = vs.user_id
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NULL
  LOOP
    IF COALESCE(r.work_mode::text, 'office') = 'remote' THEN
      CONTINUE;
    END IF;
    IF public.attendance_is_wfh_day(r.user_id, r.attendance_date) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    v_ios := public.attendance_user_uses_ios_silence_rules(r.user_id);
    IF v_ios THEN
      v_mins := GREATEST(1, r.ios_timeout_mins);
      v_note := format('No office Wi-Fi for %s minutes (iOS)', v_mins);
    ELSE
      v_mins := GREATEST(1, r.no_wifi_mins);
      v_note := 'No office Wi-Fi for 10 minutes';
    END IF;
    v_timeout := make_interval(mins => v_mins);

    SELECT MAX(clock_in_at) INTO v_visit_in
    FROM public.attendance_visit_segments
    WHERE user_id = r.user_id AND clock_out_at IS NULL;

    -- iOS: never silence-checkout while last usable GPS in this visit was inside
    -- and no later outside reading exists.
    IF v_ios AND public.attendance_ios_last_inside_gps_uncontradicted(r.user_id, v_visit_in) THEN
      CONTINUE;
    END IF;

    -- Non-iOS (and iOS without inside hold): recent inside GPS within timeout still protects.
    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_last := r.last_office_signal_at;
    IF v_last IS NULL THEN
      SELECT MAX(clock_in_at) INTO v_last
      FROM public.attendance_visit_segments
      WHERE user_id = r.user_id AND clock_out_at IS NULL;
    END IF;
    IF v_last IS NULL OR v_last > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF public.attendance_close_visit_with_note(r.user_id, v_last, v_note, false) > 0 THEN
      v_local := to_char(
        timezone(COALESCE(public.company_timezone(r.company_id), 'UTC'), v_last),
        'HH12:MI AM'
      );
      IF v_ios THEN
        v_msg := format('Checked out - no office Wi-Fi for %s minutes at %s', v_mins, v_local);
      ELSE
        v_msg := format('Checked out - no office Wi-Fi for 10 minutes at %s', v_local);
      END IF;
      UPDATE public.users SET
        pending_attendance_notify = v_msg,
        pending_attendance_notify_at = v_now
      WHERE id = r.user_id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5c() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5b() TO service_role;

-- Cron tick unchanged (still Rule 6 → 5c → 5b); re-assert for safety.
CREATE OR REPLACE FUNCTION public.attendance_cron_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ended integer;
  v_5c integer;
  v_5b integer;
  v_retention jsonb;
BEGIN
  v_ended := public.attendance_close_ended_windows();
  v_5c := public.attendance_apply_rule_5c();
  v_5b := public.attendance_apply_rule_5b();
  v_retention := public.attendance_retention_cleanup();

  RETURN jsonb_build_object(
    'closed_ended', v_ended,
    'closed_offline_5c', v_5c,
    'closed_no_office_wifi_5b', v_5b,
    'retention', v_retention,
    'ran_at', timezone('utc', now())
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Rule 5 (outside radius): iOS ignore stale / imprecise GPS for check-out only.
-- Patches process_auto_attendance_event in place (no signature change).
-- Location age / precise flags arrive via optional request headers encoded in
-- client_ip? No — clients omit coords (edge sanitizes). Server belt: for iOS,
-- treat outside only when accuracy <= 50 (already) and accuracy is not the
-- reduced-accuracy band (>= 65 often). Also ignore when payload marker set.
-- Extra: if platform ios and accuracy > 50 → already not outside.
-- Add explicit iOS reduced-accuracy floor: accuracy > 50 OR null → not outside.
-- Stale handled at edge/client by stripping coords.
-- ---------------------------------------------------------------------------
DO $ios_r5$
DECLARE
  def text;
  old_block text;
  new_block text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Idempotent marker
  IF def LIKE '%scorr_ios_rule5_stale_guard%' THEN
    RAISE NOTICE 'iOS Rule 5 guard already present';
    RETURN;
  END IF;

  old_block := $o$  v_gps_outside := v_gps_has_fix
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 50
      AND v_dist > v_exit_radius;
  END IF;$o$;

  new_block := $n$  v_gps_outside := v_gps_has_fix
      AND p_accuracy_m IS NOT NULL
      AND p_accuracy_m <= 50
      AND v_dist > v_exit_radius;
    -- scorr_ios_rule5_stale_guard: iOS only — never check out on reduced-accuracy
    -- or when the client marked the fix unusable for leave (coords already stripped
    -- by edge for stale >60s / precise-off; this catches accuracy > 50 leftovers).
    IF v_gps_outside
       AND lower(COALESCE(v_dev.platform, p_platform, '')) IN ('ios', 'iphone', 'ipad') THEN
      IF p_accuracy_m IS NULL OR p_accuracy_m > 50 THEN
        v_gps_outside := false;
      END IF;
    END IF;
  END IF;$n$;

  IF position(old_block in def) = 0 THEN
    RAISE NOTICE 'iOS Rule 5 guard: anchor not found (non-fatal)';
    RETURN;
  END IF;

  def := replace(def, old_block, new_block);
  EXECUTE def;
END $ios_r5$;

NOTIFY pgrst, 'reload schema';
