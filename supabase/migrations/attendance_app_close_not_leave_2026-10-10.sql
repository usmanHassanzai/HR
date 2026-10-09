-- Closing the app must never count as leaving the office.
-- Web / iOS Home Screen: app_backgrounded → skip 5b/5c for company grace
--   (attendance_backgrounded_minutes, default 60), then close at last signal
--   with note "No signal after app was closed".
-- Native/desktop keep tracking; app_quit is logged only (no immediate leave).
-- Re-runnable. LAST in apply-all-migrations.mjs.
-- Does NOT change Rule 5 (fresh outside GPS), Rule 6, manual Clock in/out,
-- check-in rules, windows, KPIs, leave, login/MFA, departments, office, shifts.
-- Does NOT hard-delete attendance_records or visit segments.

-- ---------------------------------------------------------------------------
-- Company setting + device/user stamps
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS attendance_backgrounded_minutes INTEGER NOT NULL DEFAULT 60;

UPDATE public.companies
SET attendance_backgrounded_minutes = 60
WHERE attendance_backgrounded_minutes IS NULL OR attendance_backgrounded_minutes < 1;

ALTER TABLE public.companies
  ALTER COLUMN attendance_backgrounded_minutes SET DEFAULT 60;

COMMENT ON COLUMN public.companies.attendance_backgrounded_minutes IS
  'After app_backgrounded (web / Home Screen), skip 5b/5c for this many minutes; then close if still silent.';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_app_backgrounded_at TIMESTAMPTZ;

ALTER TABLE public.attendance_devices
  ADD COLUMN IF NOT EXISTS last_app_backgrounded_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.last_app_backgrounded_at IS
  'Latest app_backgrounded from a non-background client; cleared on any real device signal.';

-- ---------------------------------------------------------------------------
-- Real signals clear backgrounded grace
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_touch_user_signals(
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_office_network boolean DEFAULT false,
  p_inside_gps boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_user_id IS NULL OR p_occurred_at IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.users SET
    last_any_signal_at = CASE
      WHEN last_any_signal_at IS NULL OR p_occurred_at > last_any_signal_at
      THEN p_occurred_at ELSE last_any_signal_at
    END,
    last_office_signal_at = CASE
      WHEN p_office_network AND (last_office_signal_at IS NULL OR p_occurred_at > last_office_signal_at)
      THEN p_occurred_at ELSE last_office_signal_at
    END,
    last_inside_gps_at = CASE
      WHEN p_inside_gps AND (last_inside_gps_at IS NULL OR p_occurred_at > last_inside_gps_at)
      THEN p_occurred_at ELSE last_inside_gps_at
    END,
    -- A later real presence signal means the app is alive again.
    -- Use strict '>' so the app_backgrounded row itself (same timestamp) does not clear.
    last_app_backgrounded_at = CASE
      WHEN last_app_backgrounded_at IS NOT NULL
           AND p_occurred_at > last_app_backgrounded_at
      THEN NULL
      ELSE last_app_backgrounded_at
    END
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_touch_user_signals(uuid, timestamptz, boolean, boolean)
  TO authenticated, service_role;

-- Trigger must not treat app_backgrounded / app_quit as presence signals
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
  IF v_ev IN (
    'connection_lost', 'device_sleep', 'device_shutdown',
    'app_backgrounded', 'app_quit'
  ) THEN
    RETURN NEW;
  END IF;
  v_at := COALESCE(NEW.occurred_at, NEW.created_at, timezone('utc', now()));
  v_office :=
    COALESCE(NEW.matched_method, '') IN ('wifi', 'laptop')
    OR COALESCE((NEW.payload->>'wifi_ok')::boolean, false)
    OR COALESCE((NEW.payload->>'office_network')::boolean, false);
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

-- ---------------------------------------------------------------------------
-- Grace helper: still inside backgrounded window (no real signal since)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_app_backgrounded_grace_active(
  p_user_id uuid,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_bg timestamptz;
  v_mins integer;
  v_company uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT u.last_app_backgrounded_at, u.company_id
    INTO v_bg, v_company
  FROM public.users u WHERE u.id = p_user_id;
  IF v_bg IS NULL THEN
    RETURN false;
  END IF;
  SELECT COALESCE(c.attendance_backgrounded_minutes, 60)
    INTO v_mins
  FROM public.companies c WHERE c.id = v_company;
  RETURN p_now < v_bg + make_interval(mins => GREATEST(1, COALESCE(v_mins, 60)));
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_app_backgrounded_grace_active(uuid, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- app_backgrounded: mark grace; do NOT refresh last_any_signal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_handle_app_backgrounded(
  p_user_id uuid,
  p_company_id uuid,
  p_device_row_id uuid,
  p_event text,
  p_occurred_at timestamptz,
  p_skew_ms bigint,
  p_clock_flagged boolean,
  p_client_ip text,
  p_platform text,
  p_app_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_at timestamptz := COALESCE(p_occurred_at, timezone('utc', now()));
BEGIN
  UPDATE public.attendance_devices SET
    last_app_backgrounded_at = v_at,
    last_seen_at = GREATEST(COALESCE(last_seen_at, v_at), v_at)
  WHERE id = p_device_row_id;

  UPDATE public.users SET
    last_app_backgrounded_at = CASE
      WHEN last_app_backgrounded_at IS NULL OR v_at >= last_app_backgrounded_at
      THEN v_at ELSE last_app_backgrounded_at
    END
  WHERE id = p_user_id;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    skew_ms, clock_flagged, occurred_at, payload
  ) VALUES (
    p_company_id, p_user_id, p_device_row_id, p_event, true, 'app_backgrounded', p_client_ip,
    p_skew_ms, p_clock_flagged, v_at,
    jsonb_build_object(
      'platform', p_platform,
      'app_version', p_app_version,
      'app_backgrounded', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'app_backgrounded',
    'reason', 'app_backgrounded',
    'occurred_at', v_at,
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_handle_app_backgrounded(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text
) TO service_role;

-- ---------------------------------------------------------------------------
-- app_quit (desktop tray Quit): log only — not an office leave
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_handle_app_quit(
  p_user_id uuid,
  p_company_id uuid,
  p_device_row_id uuid,
  p_event text,
  p_occurred_at timestamptz,
  p_skew_ms bigint,
  p_clock_flagged boolean,
  p_client_ip text,
  p_platform text,
  p_app_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_at timestamptz := COALESCE(p_occurred_at, timezone('utc', now()));
BEGIN
  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    skew_ms, clock_flagged, occurred_at, payload
  ) VALUES (
    p_company_id, p_user_id, p_device_row_id, p_event, true, 'app_quit', p_client_ip,
    p_skew_ms, p_clock_flagged, v_at,
    jsonb_build_object(
      'platform', p_platform,
      'app_version', p_app_version,
      'app_quit', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'app_quit',
    'reason', 'app_quit',
    'occurred_at', v_at,
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_handle_app_quit(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text
) TO service_role;

-- ---------------------------------------------------------------------------
-- Exclude background/quit/laptop close from "any signal" used by silence rules
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_raw_any_signal_at(p_user_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stamp timestamptz;
  v_evt timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT last_any_signal_at INTO v_stamp FROM public.users WHERE id = p_user_id;
  SELECT MAX(COALESCE(e.occurred_at, e.created_at)) INTO v_evt
  FROM public.attendance_events_log e
  WHERE e.user_id = p_user_id
    AND e.accepted IS TRUE
    AND e.created_at > timezone('utc', now()) - INTERVAL '12 hours'
    AND lower(COALESCE(e.event, '')) NOT IN (
      'connection_lost', 'device_sleep', 'device_shutdown',
      'app_backgrounded', 'app_quit'
    );
  IF v_stamp IS NULL THEN
    RETURN v_evt;
  END IF;
  IF v_evt IS NULL THEN
    RETURN v_stamp;
  END IF;
  RETURN GREATEST(v_stamp, v_evt);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_raw_any_signal_at(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rule 5c — skip during app_backgrounded grace; after grace close with note
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
  v_raw timestamptz;
  v_anchor timestamptz;
  v_out timestamptz;
  v_inside timestamptz;
  v_win RECORD;
  v_note text := 'Device offline (no Wi-Fi or mobile data)';
  v_msg text;
  v_visit_in timestamptz;
  v_visit_id uuid;
  v_bg timestamptz;
  v_bg_mins integer;
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           COALESCE(c.attendance_offline_minutes, 3) AS offline_mins,
           COALESCE(c.attendance_backgrounded_minutes, 60) AS backgrounded_mins,
           u.last_inside_gps_at, u.work_mode, u.last_app_backgrounded_at
    FROM public.attendance_visit_segments vs
    JOIN public.users u ON u.id = vs.user_id
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NULL
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
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
    IF public.attendance_laptop_sleep_grace_active(r.user_id) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE;
    END IF;

    SELECT vs.clock_in_at, vs.id
      INTO v_visit_in, v_visit_id
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = r.user_id AND vs.clock_out_at IS NULL
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
    ORDER BY vs.clock_in_at DESC
    LIMIT 1;

    IF v_visit_in IS NULL THEN
      CONTINUE;
    END IF;

    v_bg := r.last_app_backgrounded_at;
    v_bg_mins := GREATEST(1, COALESCE(r.backgrounded_mins, 60));

    -- Web / Home Screen closed the app: hold 5c for grace, then special close
    IF v_bg IS NOT NULL THEN
      IF v_now < v_bg + make_interval(mins => v_bg_mins) THEN
        CONTINUE;
      END IF;
      -- Grace expired and stamp still set → no real signal since background
      IF v_visit_in > v_now - INTERVAL '2 minutes' THEN
        CONTINUE;
      END IF;
      v_raw := public.attendance_raw_any_signal_at(r.user_id);
      IF v_raw IS NOT NULL AND v_raw > v_visit_in THEN
        v_out := v_raw;
      ELSE
        v_out := v_visit_in;
      END IF;
      v_out := LEAST(v_now, GREATEST(v_out, v_visit_in));
      v_note := 'No signal after app was closed';
      IF public.attendance_close_visit_with_note(r.user_id, v_out, v_note, false) > 0 THEN
        v_msg := format(
          'You were checked out at %s because there was no signal after the app was closed.',
          to_char(timezone(COALESCE(public.company_timezone(r.company_id), 'UTC'), v_out), 'HH12:MI AM')
        );
        UPDATE public.users SET
          pending_attendance_notify = v_msg,
          pending_attendance_notify_at = v_now,
          last_app_backgrounded_at = NULL
        WHERE id = r.user_id;
        v_n := v_n + 1;
      END IF;
      CONTINUE;
    END IF;

    v_timeout := make_interval(mins => GREATEST(1, r.offline_mins));

    IF v_visit_in > v_now - v_timeout OR v_visit_in > v_now - INTERVAL '2 minutes' THEN
      CONTINUE;
    END IF;

    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF public.attendance_effective_office_signal_at(r.user_id, v_visit_in) > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_raw := public.attendance_raw_any_signal_at(r.user_id);
    v_anchor := GREATEST(COALESCE(v_raw, v_visit_in), v_visit_in);
    IF v_anchor > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF v_raw IS NOT NULL AND v_raw > v_visit_in THEN
      v_out := v_raw;
    ELSE
      v_out := v_visit_in + v_timeout;
    END IF;
    v_out := LEAST(v_now, GREATEST(v_out, v_visit_in + v_timeout));
    v_note := 'Device offline (no Wi-Fi or mobile data)';

    IF public.attendance_close_visit_with_note(r.user_id, v_out, v_note, false) > 0 THEN
      v_msg := format(
        'You were checked out at %s because your device was offline.',
        to_char(timezone(COALESCE(public.company_timezone(r.company_id), 'UTC'), v_out), 'HH12:MI AM')
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

GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5c() TO service_role;

-- ---------------------------------------------------------------------------
-- Rule 5b — same as prior fix, plus skip while app_backgrounded (5c owns close)
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
  v_raw timestamptz;
  v_anchor timestamptz;
  v_out timestamptz;
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
           u.last_inside_gps_at, u.work_mode, u.last_app_backgrounded_at
    FROM public.attendance_visit_segments vs
    JOIN public.users u ON u.id = vs.user_id
    LEFT JOIN public.companies c ON c.id = u.company_id
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NULL
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
  LOOP
    IF COALESCE(r.work_mode::text, 'office') = 'remote' THEN
      CONTINUE;
    END IF;
    IF public.attendance_is_wfh_day(r.user_id, r.attendance_date) THEN
      CONTINUE;
    END IF;
    -- Backgrounded clients: 5c + backgrounded timeout owns silence close
    IF r.last_app_backgrounded_at IS NOT NULL THEN
      CONTINUE;
    END IF;
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
    WHERE user_id = r.user_id AND clock_out_at IS NULL
      AND COALESCE(merge_status, '') IS DISTINCT FROM 'superseded';

    IF v_visit_in IS NULL THEN
      CONTINUE;
    END IF;

    IF v_visit_in > v_now - v_timeout OR v_visit_in > v_now - INTERVAL '2 minutes' THEN
      CONTINUE;
    END IF;

    IF v_ios AND public.attendance_ios_last_inside_gps_uncontradicted(r.user_id, v_visit_in) THEN
      CONTINUE;
    END IF;

    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_raw := public.attendance_raw_office_signal_at(r.user_id);
    v_anchor := GREATEST(COALESCE(v_raw, v_visit_in), v_visit_in);
    IF v_anchor > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF v_raw IS NOT NULL AND v_raw > v_visit_in THEN
      v_out := v_raw;
    ELSE
      v_out := v_visit_in + v_timeout;
    END IF;
    v_out := LEAST(v_now, GREATEST(v_out, v_visit_in + v_timeout));

    IF public.attendance_close_visit_with_note(r.user_id, v_out, v_note, false) > 0 THEN
      v_local := to_char(
        timezone(COALESCE(public.company_timezone(r.company_id), 'UTC'), v_out),
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

GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5b() TO service_role;

-- ---------------------------------------------------------------------------
-- Wire app_backgrounded / app_quit into process_auto (allowlist + handlers)
-- ---------------------------------------------------------------------------
DO $pa$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Expand allowlist
  IF position('''app_backgrounded''' in def) = 0 THEN
    IF position(
$old$IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;$old$
      in def
    ) = 0 THEN
      RAISE EXCEPTION 'process_auto allowlist block not found for app_backgrounded splice';
    END IF;
    def := replace(
      def,
$old$IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;$old$,
$new$IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off',
    'app_backgrounded', 'app_quit'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;

  -- scorr_app_close_handlers_v1
  IF lower(v_event) = 'app_backgrounded' THEN
    RETURN public.attendance_handle_app_backgrounded(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event,
      v_corr.occurred_at, v_corr.skew_ms, v_corr.clock_flagged,
      p_client_ip, p_platform, p_app_version
    );
  END IF;
  IF lower(v_event) = 'app_quit' THEN
    RETURN public.attendance_handle_app_quit(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event,
      v_corr.occurred_at, v_corr.skew_ms, v_corr.clock_flagged,
      p_client_ip, p_platform, p_app_version
    );
  END IF;$new$
    );
  ELSIF position('scorr_app_close_handlers_v1' in def) = 0 THEN
    -- Allowlist already has events but handlers missing — insert after allowlist END IF
    def := replace(
      def,
$old$IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off',
    'app_backgrounded', 'app_quit'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;$old$,
$new$IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off',
    'app_backgrounded', 'app_quit'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;

  -- scorr_app_close_handlers_v1
  IF lower(v_event) = 'app_backgrounded' THEN
    RETURN public.attendance_handle_app_backgrounded(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event,
      v_corr.occurred_at, v_corr.skew_ms, v_corr.clock_flagged,
      p_client_ip, p_platform, p_app_version
    );
  END IF;
  IF lower(v_event) = 'app_quit' THEN
    RETURN public.attendance_handle_app_quit(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event,
      v_corr.occurred_at, v_corr.skew_ms, v_corr.clock_flagged,
      p_client_ip, p_platform, p_app_version
    );
  END IF;$new$
    );
  END IF;

  EXECUTE def;
END;
$pa$;
