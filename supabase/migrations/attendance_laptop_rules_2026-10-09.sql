-- Laptop-only attendance rules (L1–L7).
-- Re-runnable. Does NOT change phone / web / check-in / Rule 5 / Rule 6 / manual clocks.
-- LAST in apply-all-migrations.mjs (after iOS silence migration).

-- ---------------------------------------------------------------------------
-- Company setting
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS attendance_laptop_sleep_minutes INTEGER NOT NULL DEFAULT 30;

UPDATE public.companies
SET attendance_laptop_sleep_minutes = 30
WHERE attendance_laptop_sleep_minutes IS NULL OR attendance_laptop_sleep_minutes < 1;

ALTER TABLE public.companies
  ALTER COLUMN attendance_laptop_sleep_minutes SET DEFAULT 30;

COMMENT ON COLUMN public.companies.attendance_laptop_sleep_minutes IS
  'Laptop-only: minutes asleep before silent check-out at sleep time (default 30).';

-- ---------------------------------------------------------------------------
-- Per-user laptop sleep / off-office streak
-- ---------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS laptop_sleep_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS laptop_off_office_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS laptop_off_office_since TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Helper: laptop-only (no phone signal in this open visit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_user_uses_laptop_only_rules(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_has_laptop boolean := false;
  v_phone_in_visit boolean := false;
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
      AND lower(COALESCE(d.platform, '')) IN ('windows', 'linux')
  ) INTO v_has_laptop;

  IF NOT v_has_laptop THEN
    RETURN false;
  END IF;

  -- Active phone during this visit → keep normal multi-device behavior.
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND lower(COALESCE(d.platform, '')) IN ('android', 'ios', 'iphone', 'ipad')
      AND d.last_seen_at IS NOT NULL
      AND d.last_seen_at >= COALESCE(v_visit_in, timezone('utc', now()) - INTERVAL '12 hours')
  ) INTO v_phone_in_visit;

  RETURN NOT v_phone_in_visit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_user_uses_laptop_only_rules(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attendance_laptop_sleep_grace_active(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sleep timestamptz;
  v_mins integer;
  v_company uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.attendance_user_uses_laptop_only_rules(p_user_id) THEN
    RETURN false;
  END IF;
  SELECT laptop_sleep_at, company_id INTO v_sleep, v_company
  FROM public.users WHERE id = p_user_id;
  IF v_sleep IS NULL THEN
    RETURN false;
  END IF;
  SELECT COALESCE(c.attendance_laptop_sleep_minutes, 30) INTO v_mins
  FROM public.companies c WHERE c.id = v_company;
  RETURN timezone('utc', now()) < v_sleep + make_interval(mins => GREATEST(1, COALESCE(v_mins, 30)));
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_laptop_sleep_grace_active(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Notify helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_laptop_set_notify(
  p_user_id uuid,
  p_company_id uuid,
  p_out_at timestamptz,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_local text;
  v_msg text;
BEGIN
  v_local := to_char(
    timezone(COALESCE(public.company_timezone(p_company_id), 'UTC'), p_out_at),
    'HH12:MI AM'
  );
  v_msg := format('Checked out at %s — %s', v_local, p_reason);
  UPDATE public.users SET
    pending_attendance_notify = v_msg,
    pending_attendance_notify_at = timezone('utc', now()),
    laptop_sleep_at = NULL,
    laptop_off_office_count = 0,
    laptop_off_office_since = NULL
  WHERE id = p_user_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- L3 cron: asleep longer than timeout → out at sleep time
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_apply_laptop_rules()
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
  v_win RECORD;
  v_note text := 'Laptop asleep for more than 30 minutes';
  v_mins integer;
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           u.laptop_sleep_at, u.work_mode,
           COALESCE(c.attendance_laptop_sleep_minutes, 30) AS sleep_mins
    FROM public.attendance_visit_segments vs
    JOIN public.users u ON u.id = vs.user_id
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NULL
      AND u.laptop_sleep_at IS NOT NULL
  LOOP
    IF COALESCE(r.work_mode::text, 'office') = 'remote' THEN
      CONTINUE;
    END IF;
    IF public.attendance_is_wfh_day(r.user_id, r.attendance_date) THEN
      CONTINUE;
    END IF;
    IF NOT public.attendance_user_uses_laptop_only_rules(r.user_id) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    v_mins := GREATEST(1, r.sleep_mins);
    v_timeout := make_interval(mins => v_mins);
    IF r.laptop_sleep_at > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_note := format('Laptop asleep for more than %s minutes', v_mins);
    IF public.attendance_close_visit_with_note(r.user_id, r.laptop_sleep_at, v_note, false) > 0 THEN
      PERFORM public.attendance_laptop_set_notify(
        r.user_id, r.company_id, r.laptop_sleep_at,
        format('laptop asleep for more than %s minutes', v_mins)
      );
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_apply_laptop_rules() TO service_role;

-- ---------------------------------------------------------------------------
-- Event handlers: sleep / wake / shutdown
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_handle_device_sleep(
  p_user_id uuid,
  p_company_id uuid,
  p_device_row_id uuid,
  p_event text,
  p_occurred_at timestamptz,
  p_skew_ms bigint,
  p_clock_flagged boolean,
  p_client_ip text,
  p_platform text,
  p_app_version text,
  p_work_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_att_date date := (p_occurred_at AT TIME ZONE 'UTC')::date;
  v_action text := 'device_sleep';
  v_n integer := 0;
  v_mins integer;
  v_note text;
  v_msg text;
BEGIN
  IF COALESCE(p_work_mode, 'office') = 'remote'
     OR public.attendance_is_wfh_day(p_user_id, v_att_date) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'wfh_skip', p_client_ip,
      p_skew_ms, p_clock_flagged, p_occurred_at,
      jsonb_build_object('platform', p_platform, 'app_version', p_app_version)
    );
    RETURN jsonb_build_object('ok', true, 'action', 'wfh_skip', 'occurred_at', p_occurred_at);
  END IF;

  IF NOT public.attendance_user_uses_laptop_only_rules(p_user_id) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'multi_device_skip', p_client_ip,
      p_skew_ms, p_clock_flagged, p_occurred_at,
      jsonb_build_object('platform', p_platform, 'app_version', p_app_version)
    );
    RETURN jsonb_build_object(
      'ok', true, 'action', 'multi_device_skip', 'occurred_at', p_occurred_at,
      'stop_tracking', false
    );
  END IF;

  UPDATE public.users SET
    laptop_sleep_at = CASE
      WHEN laptop_sleep_at IS NULL OR p_occurred_at < laptop_sleep_at THEN p_occurred_at
      ELSE laptop_sleep_at
    END,
    laptop_off_office_count = 0,
    laptop_off_office_since = NULL
  WHERE id = p_user_id;

  SELECT COALESCE(c.attendance_laptop_sleep_minutes, 30) INTO v_mins
  FROM public.companies c WHERE c.id = p_company_id;

  -- Late sleep (already past timeout): close only, never check-in.
  IF timezone('utc', now()) >= p_occurred_at + make_interval(mins => GREATEST(1, COALESCE(v_mins, 30))) THEN
    v_note := format('Laptop asleep for more than %s minutes', GREATEST(1, COALESCE(v_mins, 30)));
    v_n := public.attendance_close_visit_with_note(p_user_id, p_occurred_at, v_note, true);
    IF v_n > 0 THEN
      v_action := 'clock_out';
      PERFORM public.attendance_laptop_set_notify(
        p_user_id, p_company_id, p_occurred_at,
        format('laptop asleep for more than %s minutes', GREATEST(1, COALESCE(v_mins, 30)))
      );
      SELECT pending_attendance_notify INTO v_msg FROM public.users WHERE id = p_user_id;
    END IF;
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    skew_ms, clock_flagged, occurred_at, payload
  ) VALUES (
    p_company_id, p_user_id, p_device_row_id, p_event, true, v_action, p_client_ip,
    p_skew_ms, p_clock_flagged, p_occurred_at,
    jsonb_build_object(
      'platform', p_platform,
      'app_version', p_app_version,
      'device_sleep', true,
      'closed', v_n > 0
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'reason', v_action,
    'occurred_at', p_occurred_at,
    'notify_message', v_msg,
    'laptop_sleep_at', p_occurred_at,
    'stop_tracking', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_handle_device_shutdown(
  p_user_id uuid,
  p_company_id uuid,
  p_device_row_id uuid,
  p_event text,
  p_occurred_at timestamptz,
  p_skew_ms bigint,
  p_clock_flagged boolean,
  p_client_ip text,
  p_platform text,
  p_app_version text,
  p_work_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_att_date date := (p_occurred_at AT TIME ZONE 'UTC')::date;
  v_action text := 'device_shutdown';
  v_n integer := 0;
  v_note text := 'Laptop shut down';
  v_msg text;
BEGIN
  IF COALESCE(p_work_mode, 'office') = 'remote'
     OR public.attendance_is_wfh_day(p_user_id, v_att_date) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'wfh_skip', p_client_ip,
      p_skew_ms, p_clock_flagged, p_occurred_at,
      jsonb_build_object('platform', p_platform, 'app_version', p_app_version)
    );
    RETURN jsonb_build_object('ok', true, 'action', 'wfh_skip', 'occurred_at', p_occurred_at);
  END IF;

  IF public.attendance_user_uses_laptop_only_rules(p_user_id) THEN
    v_n := public.attendance_close_visit_with_note(p_user_id, p_occurred_at, v_note, true);
    IF v_n > 0 THEN
      v_action := 'clock_out';
      PERFORM public.attendance_laptop_set_notify(
        p_user_id, p_company_id, p_occurred_at, 'laptop shut down'
      );
      SELECT pending_attendance_notify INTO v_msg FROM public.users WHERE id = p_user_id;
    END IF;
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    skew_ms, clock_flagged, occurred_at, payload
  ) VALUES (
    p_company_id, p_user_id, p_device_row_id, p_event, true, v_action, p_client_ip,
    p_skew_ms, p_clock_flagged, p_occurred_at,
    jsonb_build_object(
      'platform', p_platform,
      'app_version', p_app_version,
      'device_shutdown', true,
      'closed', v_n > 0
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'reason', v_action,
    'occurred_at', p_occurred_at,
    'notify_message', v_msg,
    'stop_tracking', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_handle_device_wake(
  p_user_id uuid,
  p_company_id uuid,
  p_device_row_id uuid,
  p_event text,
  p_occurred_at timestamptz,
  p_skew_ms bigint,
  p_clock_flagged boolean,
  p_client_ip text,
  p_platform text,
  p_app_version text,
  p_work_mode text,
  p_on_office_network boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_att_date date := (p_occurred_at AT TIME ZONE 'UTC')::date;
  v_action text := 'device_wake';
  v_n integer := 0;
  v_sleep timestamptz;
  v_mins integer;
  v_note text;
  v_msg text;
BEGIN
  IF COALESCE(p_work_mode, 'office') = 'remote'
     OR public.attendance_is_wfh_day(p_user_id, v_att_date) THEN
    UPDATE public.users SET laptop_sleep_at = NULL WHERE id = p_user_id;
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'wfh_skip', p_client_ip,
      p_skew_ms, p_clock_flagged, p_occurred_at,
      jsonb_build_object('platform', p_platform, 'app_version', p_app_version)
    );
    RETURN jsonb_build_object('ok', true, 'action', 'wfh_skip', 'occurred_at', p_occurred_at);
  END IF;

  SELECT laptop_sleep_at INTO v_sleep FROM public.users WHERE id = p_user_id;
  SELECT COALESCE(c.attendance_laptop_sleep_minutes, 30) INTO v_mins
  FROM public.companies c WHERE c.id = p_company_id;

  IF public.attendance_user_uses_laptop_only_rules(p_user_id)
     AND v_sleep IS NOT NULL THEN
    IF COALESCE(p_on_office_network, false)
       AND p_occurred_at <= v_sleep + make_interval(mins => GREATEST(1, COALESCE(v_mins, 30))) THEN
      -- L2: wake on office within window — keep visit, clear sleep.
      UPDATE public.users SET
        laptop_sleep_at = NULL,
        laptop_off_office_count = 0,
        laptop_off_office_since = NULL,
        last_any_signal_at = CASE
          WHEN last_any_signal_at IS NULL OR p_occurred_at > last_any_signal_at
          THEN p_occurred_at ELSE last_any_signal_at END,
        last_office_signal_at = CASE
          WHEN last_office_signal_at IS NULL OR p_occurred_at > last_office_signal_at
          THEN p_occurred_at ELSE last_office_signal_at END
      WHERE id = p_user_id;
      v_action := 'already_checked_in';
    ELSE
      -- L4: wake off office (or past grace without L3 yet) → out at sleep time.
      v_note := 'Laptop woke outside the office network';
      IF COALESCE(p_on_office_network, false) THEN
        -- Past 30 min but still on office: L3 should have closed; close at sleep if still open.
        v_note := format('Laptop asleep for more than %s minutes', GREATEST(1, COALESCE(v_mins, 30)));
      END IF;
      v_n := public.attendance_close_visit_with_note(p_user_id, v_sleep, v_note, true);
      IF v_n > 0 THEN
        v_action := 'clock_out';
        PERFORM public.attendance_laptop_set_notify(
          p_user_id, p_company_id, v_sleep,
          CASE WHEN COALESCE(p_on_office_network, false)
            THEN format('laptop asleep for more than %s minutes', GREATEST(1, COALESCE(v_mins, 30)))
            ELSE 'laptop woke outside the office network'
          END
        );
        SELECT pending_attendance_notify INTO v_msg FROM public.users WHERE id = p_user_id;
      ELSE
        UPDATE public.users SET laptop_sleep_at = NULL WHERE id = p_user_id;
      END IF;
    END IF;
  ELSE
    UPDATE public.users SET
      laptop_sleep_at = NULL,
      laptop_off_office_count = 0,
      laptop_off_office_since = NULL
    WHERE id = p_user_id;
    PERFORM public.attendance_touch_user_signals(
      p_user_id, p_occurred_at, COALESCE(p_on_office_network, false), false
    );
    v_action := 'device_wake';
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    skew_ms, clock_flagged, occurred_at, payload
  ) VALUES (
    p_company_id, p_user_id, p_device_row_id, p_event, true, v_action, p_client_ip,
    p_skew_ms, p_clock_flagged, p_occurred_at,
    jsonb_build_object(
      'platform', p_platform,
      'app_version', p_app_version,
      'device_wake', true,
      'wifi_ok', COALESCE(p_on_office_network, false),
      'closed', v_n > 0
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'reason', v_action,
    'occurred_at', p_occurred_at,
    'notify_message', v_msg,
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_handle_device_sleep(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_handle_device_shutdown(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_handle_device_wake(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text, boolean
) TO service_role;

-- ---------------------------------------------------------------------------
-- L5: consecutive non-office heartbeats while awake (laptop-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_laptop_track_off_office(
  p_user_id uuid,
  p_company_id uuid,
  p_occurred_at timestamptz,
  p_on_office_network boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
  v_since timestamptz;
  v_n integer := 0;
  v_note text := 'Laptop left the office network';
  v_msg text;
BEGIN
  IF NOT public.attendance_user_uses_laptop_only_rules(p_user_id) THEN
    RETURN NULL;
  END IF;
  -- Asleep: L1–L4 own this period.
  IF EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND laptop_sleep_at IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  IF COALESCE(p_on_office_network, false) THEN
    UPDATE public.users SET
      laptop_off_office_count = 0,
      laptop_off_office_since = NULL
    WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  SELECT laptop_off_office_count, laptop_off_office_since
  INTO v_count, v_since
  FROM public.users WHERE id = p_user_id;

  v_count := COALESCE(v_count, 0) + 1;
  IF v_since IS NULL THEN
    v_since := p_occurred_at;
  END IF;

  UPDATE public.users SET
    laptop_off_office_count = v_count,
    laptop_off_office_since = v_since
  WHERE id = p_user_id;

  IF v_count >= 2 THEN
    v_n := public.attendance_close_visit_with_note(p_user_id, v_since, v_note, false);
    IF v_n > 0 THEN
      PERFORM public.attendance_laptop_set_notify(
        p_user_id, p_company_id, v_since, 'laptop left the office network'
      );
      SELECT pending_attendance_notify INTO v_msg FROM public.users WHERE id = p_user_id;
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'clock_out',
        'reason', 'clock_out',
        'occurred_at', v_since,
        'notify_message', v_msg,
        'stop_tracking', false
      );
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_laptop_track_off_office(
  uuid, uuid, timestamptz, boolean
) TO service_role;

-- ---------------------------------------------------------------------------
-- Patch 5c / 5b: skip during laptop sleep grace (L1)
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
    IF public.attendance_user_uses_ios_silence_rules(r.user_id) THEN
      CONTINUE;
    END IF;
    -- L1: laptop asleep within grace → do not apply 5c
    IF public.attendance_laptop_sleep_grace_active(r.user_id) THEN
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
    -- L1: laptop asleep within grace → do not apply 5b
    IF public.attendance_laptop_sleep_grace_active(r.user_id) THEN
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

    IF v_ios AND public.attendance_ios_last_inside_gps_uncontradicted(r.user_id, v_visit_in) THEN
      CONTINUE;
    END IF;

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

-- ---------------------------------------------------------------------------
-- Cron: Rule 6 → laptop → 5c → 5b
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_cron_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ended integer;
  v_lap integer;
  v_5c integer;
  v_5b integer;
  v_retention jsonb;
BEGIN
  v_ended := public.attendance_close_ended_windows();
  v_lap := public.attendance_apply_laptop_rules();
  v_5c := public.attendance_apply_rule_5c();
  v_5b := public.attendance_apply_rule_5b();
  v_retention := public.attendance_retention_cleanup();

  RETURN jsonb_build_object(
    'closed_ended', v_ended,
    'closed_laptop', v_lap,
    'closed_offline_5c', v_5c,
    'closed_no_office_wifi_5b', v_5b,
    'retention', v_retention,
    'ran_at', timezone('utc', now())
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Wire device_sleep / wake / shutdown into process_auto (+ stale exempt)
-- ---------------------------------------------------------------------------
DO $wire$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  IF def NOT LIKE '%attendance_handle_device_sleep%' THEN
    IF def NOT LIKE '%IF lower(v_event) = ''connection_lost'' THEN%' THEN
      RAISE EXCEPTION 'connection_lost anchor missing for laptop event wire';
    END IF;
    def := replace(def,
$old$  IF lower(v_event) = 'connection_lost' THEN
    RETURN public.attendance_handle_connection_lost(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version,
      (SELECT COALESCE(u.work_mode::text, 'office') FROM public.users u WHERE u.id = v_dev.user_id)
    );
  END IF;
$old$,
$new$  IF lower(v_event) = 'connection_lost' THEN
    RETURN public.attendance_handle_connection_lost(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version,
      (SELECT COALESCE(u.work_mode::text, 'office') FROM public.users u WHERE u.id = v_dev.user_id)
    );
  END IF;

  IF lower(v_event) = 'device_sleep' THEN
    RETURN public.attendance_handle_device_sleep(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version,
      (SELECT COALESCE(u.work_mode::text, 'office') FROM public.users u WHERE u.id = v_dev.user_id)
    );
  END IF;

  IF lower(v_event) = 'device_shutdown' THEN
    RETURN public.attendance_handle_device_shutdown(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version,
      (SELECT COALESCE(u.work_mode::text, 'office') FROM public.users u WHERE u.id = v_dev.user_id)
    );
  END IF;

  IF lower(v_event) = 'device_wake' THEN
    RETURN public.attendance_handle_device_wake(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version,
      (SELECT COALESCE(u.work_mode::text, 'office') FROM public.users u WHERE u.id = v_dev.user_id),
      public.attendance_on_assigned_office_wifi(v_dev.user_id, COALESCE(p_client_ip, public.attendance_request_client_ip()))
    );
  END IF;
$new$);
    EXECUTE def;
  END IF;

  -- Exempt sleep/shutdown from event_too_old (wake stays normal freshness).
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );
  IF def LIKE '%AND lower(v_event) IS DISTINCT FROM ''connection_lost'' THEN%'
     AND def NOT LIKE '%device_sleep%' THEN
    def := replace(def,
$old$  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes'
     AND lower(v_event) IS DISTINCT FROM 'connection_lost' THEN
$old$,
$new$  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes'
     AND lower(v_event) IS DISTINCT FROM 'connection_lost'
     AND lower(v_event) IS DISTINCT FROM 'device_sleep'
     AND lower(v_event) IS DISTINCT FROM 'device_shutdown' THEN
$new$);
    EXECUTE def;
  END IF;

  -- L5: after wifi_ok for windows/linux awake signals
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );
  IF def NOT LIKE '%attendance_laptop_track_off_office%' THEN
    IF position($a$  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;
$a$ in def) > 0 THEN
      def := replace(def,
$old$  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;
$old$,
$new$  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected', 'network_change', 'device_wake');
  END IF;

  -- L5 laptop-only: two consecutive non-office awake signals → check out
  IF v_dev.platform IN ('windows', 'linux')
     AND lower(v_event) IN ('heartbeat', 'ping', 'power_on', 'network_change', 'wifi_connected') THEN
    IF (public.attendance_laptop_track_off_office(
          v_dev.user_id, v_dev.company_id, v_corr.occurred_at, v_wifi_ok
        )->>'action') = 'clock_out' THEN
      SELECT pending_attendance_notify INTO v_notify_msg FROM public.users WHERE id = v_dev.user_id;
      IF v_notify_msg IS NOT NULL THEN
        UPDATE public.users SET pending_attendance_notify = NULL, pending_attendance_notify_at = NULL
        WHERE id = v_dev.user_id;
      END IF;
      RETURN jsonb_build_object(
        'ok', true,
        'action', 'clock_out',
        'reason', 'clock_out',
        'occurred_at', v_corr.occurred_at,
        'notify_message', v_notify_msg,
        'stop_tracking', false
      );
    END IF;
  END IF;
$new$);
      EXECUTE def;
    ELSE
      RAISE NOTICE 'laptop L5 wire: wifi/laptop_ok anchor not found (non-fatal)';
    END IF;
  END IF;
END $wire$;

-- Self-read RPC: include laptop_sleep_at for status card
CREATE OR REPLACE FUNCTION public.get_my_attendance_signal_times()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  SELECT last_office_signal_at, last_any_signal_at, last_inside_gps_at, laptop_sleep_at
  INTO r
  FROM public.users WHERE id = v_uid;
  RETURN jsonb_build_object(
    'ok', true,
    'last_office_signal_at', r.last_office_signal_at,
    'last_any_signal_at', r.last_any_signal_at,
    'last_inside_gps_at', r.last_inside_gps_at,
    'laptop_sleep_at', r.laptop_sleep_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_signal_times() TO authenticated;

-- Do not treat sleep/shutdown as "still online" signal stamps
CREATE OR REPLACE FUNCTION public.attendance_events_log_touch_signals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_office boolean := false;
  v_inside boolean := false;
  v_at timestamptz;
  v_ev text;
BEGIN
  IF NEW.accepted IS NOT TRUE OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_ev := lower(COALESCE(NEW.event, ''));
  -- Disconnect / sleep markers — do not refresh "still online" stamps
  IF v_ev IN ('connection_lost', 'device_sleep', 'device_shutdown') THEN
    RETURN NEW;
  END IF;
  v_at := COALESCE(NEW.occurred_at, NEW.created_at, timezone('utc', now()));
  v_office :=
    COALESCE(NEW.matched_method, '') IN ('wifi', 'laptop')
    OR COALESCE((NEW.payload->>'wifi_ok')::boolean, false);
  v_inside :=
    NEW.latitude IS NOT NULL
    AND NEW.longitude IS NOT NULL
    AND NEW.accuracy_m IS NOT NULL
    AND NEW.accuracy_m >= 0
    AND NEW.accuracy_m <= 50
    AND COALESCE((NEW.payload->>'gps_outside')::boolean, true) = false
    AND COALESCE((NEW.payload->>'is_mock')::boolean, false) = false;
  PERFORM public.attendance_touch_user_signals(NEW.user_id, v_at, v_office, v_inside);
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
