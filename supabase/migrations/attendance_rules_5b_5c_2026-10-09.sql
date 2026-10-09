-- Rules 5b (no office Wi-Fi timeout) and 5c (device offline timeout).
-- Re-runnable. Does NOT change Rule 5, Rule 6, check-in, or manual Clock out.
-- Order in cron: Rule 6 → 5c → 5b. One visit closed at most once per run.

-- ---------------------------------------------------------------------------
-- Company timeouts (defaults: 5b = 10 min, 5c = 3 min)
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS attendance_no_office_wifi_minutes INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS attendance_offline_minutes INTEGER NOT NULL DEFAULT 3;

UPDATE public.companies
SET attendance_no_office_wifi_minutes = 10
WHERE attendance_no_office_wifi_minutes IS NULL OR attendance_no_office_wifi_minutes < 1;

UPDATE public.companies
SET attendance_offline_minutes = 3
WHERE attendance_offline_minutes IS NULL OR attendance_offline_minutes < 1;

ALTER TABLE public.companies
  ALTER COLUMN attendance_no_office_wifi_minutes SET DEFAULT 10,
  ALTER COLUMN attendance_offline_minutes SET DEFAULT 3;

COMMENT ON COLUMN public.companies.attendance_no_office_wifi_minutes IS
  'Rule 5b: check out when no office-network match for this many minutes (default 10).';
COMMENT ON COLUMN public.companies.attendance_offline_minutes IS
  'Rule 5c: check out when no event from any device for this many minutes (default 3).';

-- ---------------------------------------------------------------------------
-- Per-user signal stamps + pending notify for cron closes
-- ---------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_office_signal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_any_signal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inside_gps_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_attendance_notify TEXT,
  ADD COLUMN IF NOT EXISTS pending_attendance_notify_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Window guard: allow signal-timeout / connection_lost adjustments
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_guard_clock_times()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mode TEXT := public.attendance_write_mode();
  v_win RECORD;
  v_at TIMESTAMPTZ;
BEGIN
  IF v_mode IN (
    'admin_correction', 'leave', 'day_status', 'shift_end_close', 'signal_timeout_close'
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'attendance_records' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_in_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: clock_out_at % not inside W for user %', v_at, NEW.user_id;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'attendance_visit_segments' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.clock_in_at IS NOT DISTINCT FROM OLD.clock_in_at
       AND NEW.clock_out_at IS NOT DISTINCT FROM OLD.clock_out_at THEN
      RETURN NEW;
    END IF;

    IF NEW.clock_in_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at) THEN
      v_at := NEW.clock_in_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_in_at % not inside W', v_at;
      END IF;
    END IF;

    IF NEW.clock_out_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at) THEN
      v_at := NEW.clock_out_at;
      SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
      IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: visit clock_out_at % not inside W', v_at;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Touch per-user signal stamps
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
    END
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_touch_user_signals(uuid, timestamptz, boolean, boolean)
  TO authenticated, service_role;

-- Trigger: every accepted auto/device event updates signals
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
BEGIN
  IF NEW.accepted IS NOT TRUE OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- connection_lost is a disconnect marker — do not refresh "still online" stamps
  IF lower(COALESCE(NEW.event, '')) = 'connection_lost' THEN
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

DROP TRIGGER IF EXISTS trg_attendance_events_log_touch_signals ON public.attendance_events_log;
CREATE TRIGGER trg_attendance_events_log_touch_signals
  AFTER INSERT ON public.attendance_events_log
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_events_log_touch_signals();

-- ---------------------------------------------------------------------------
-- Close (or move earlier) an open visit with a note; mark devices left
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_close_visit_with_note(
  p_user_id uuid,
  p_out_at timestamptz,
  p_note text,
  p_allow_earlier_on_closed boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.attendance_records%ROWTYPE;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_out timestamptz;
  v_mins integer;
  v_total integer;
  v_n integer := 0;
  v_closed_notes text;
BEGIN
  IF p_user_id IS NULL OR p_out_at IS NULL OR COALESCE(p_note, '') = '' THEN
    RETURN 0;
  END IF;

  PERFORM set_config('scorr.attendance_write_mode', 'signal_timeout_close', true);

  -- Prefer currently open visit.
  SELECT * INTO v_visit
  FROM public.attendance_visit_segments
  WHERE user_id = p_user_id
    AND clock_in_at IS NOT NULL
    AND clock_out_at IS NULL
  ORDER BY clock_in_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_out := GREATEST(v_visit.clock_in_at, p_out_at);
    v_mins := GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_visit.clock_in_at)) / 60)::integer);
    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_out,
      work_minutes = v_mins,
      notes = CASE
        WHEN COALESCE(notes, '') ILIKE '%' || p_note || '%' THEN notes
        ELSE trim(both ' |' from COALESCE(notes, '') || ' | ' || p_note)
      END
    WHERE id = v_visit.id;

    SELECT * INTO r
    FROM public.attendance_records
    WHERE id = v_visit.attendance_record_id
    LIMIT 1;
    IF NOT FOUND THEN
      SELECT * INTO r
      FROM public.attendance_records
      WHERE user_id = p_user_id
        AND attendance_date = v_visit.attendance_date
      LIMIT 1;
    END IF;

    IF FOUND THEN
      v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);
      UPDATE public.attendance_records SET
        clock_out_at = v_out,
        work_minutes = v_total,
        notes = CASE
          WHEN COALESCE(notes, '') ILIKE '%' || p_note || '%' THEN notes
          ELSE trim(both ' |' from COALESCE(notes, '') || ' | ' || p_note)
        END
      WHERE id = r.id;
    END IF;

    UPDATE public.attendance_devices SET
      presence_state = 'left',
      gps_outside_streak = 0,
      last_presence_at = v_out
    WHERE user_id = p_user_id
      AND revoked_at IS NULL;

    RETURN 1;
  END IF;

  -- Already closed by 5b/5c: connection_lost may move out EARLIER only.
  IF p_allow_earlier_on_closed THEN
    SELECT * INTO v_visit
    FROM public.attendance_visit_segments
    WHERE user_id = p_user_id
      AND clock_out_at IS NOT NULL
      AND (
        COALESCE(notes, '') ILIKE '%No office Wi-Fi for 10 minutes%'
        OR COALESCE(notes, '') ILIKE '%Device offline (no Wi-Fi or mobile data)%'
      )
    ORDER BY clock_out_at DESC
    LIMIT 1;

    IF FOUND AND p_out_at < v_visit.clock_out_at AND p_out_at >= v_visit.clock_in_at THEN
      v_out := p_out_at;
      v_mins := GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_visit.clock_in_at)) / 60)::integer);
      v_closed_notes := CASE
        WHEN COALESCE(v_visit.notes, '') ILIKE '%' || p_note || '%' THEN v_visit.notes
        ELSE trim(both ' |' from COALESCE(v_visit.notes, '') || ' | ' || p_note)
      END;
      UPDATE public.attendance_visit_segments SET
        clock_out_at = v_out,
        work_minutes = v_mins,
        notes = v_closed_notes
      WHERE id = v_visit.id;

      SELECT * INTO r FROM public.attendance_records WHERE id = v_visit.attendance_record_id LIMIT 1;
      IF FOUND THEN
        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);
        UPDATE public.attendance_records SET
          clock_out_at = LEAST(clock_out_at, v_out),
          work_minutes = v_total,
          notes = CASE
            WHEN COALESCE(notes, '') ILIKE '%' || p_note || '%' THEN notes
            ELSE trim(both ' |' from COALESCE(notes, '') || ' | ' || p_note)
          END
        WHERE id = r.id
          AND clock_out_at IS NOT NULL
          AND clock_out_at > v_out;
      END IF;
      RETURN 1;
    END IF;
  END IF;

  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_close_visit_with_note(uuid, timestamptz, text, boolean)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Rule 5c then 5b appliers (open visits inside check-out window only)
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
  v_note text := 'No office Wi-Fi for 10 minutes';
  v_msg text;
  v_local text;
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           COALESCE(c.attendance_no_office_wifi_minutes, 10) AS no_wifi_mins,
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

    v_timeout := make_interval(mins => GREATEST(1, r.no_wifi_mins));
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
      v_msg := format('Checked out - no office Wi-Fi for 10 minutes at %s', v_local);
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
-- Minute cron: Rule 6 → 5c → 5b (+ retention)
-- ---------------------------------------------------------------------------
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
-- connection_lost handler (checkout only; never check-in)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_handle_connection_lost(
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
  v_n integer := 0;
  v_note text := 'Device offline (no Wi-Fi or mobile data)';
  v_msg text;
  v_pending text;
  v_action text := 'already_clocked_out';
  v_att_date date := (p_occurred_at AT TIME ZONE 'UTC')::date;
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

  v_n := public.attendance_close_visit_with_note(p_user_id, p_occurred_at, v_note, true);
  IF v_n > 0 THEN
    v_action := 'clock_out';
    v_msg := format(
      'You were checked out at %s because your device was offline.',
      to_char(timezone(COALESCE(public.company_timezone(p_company_id), 'UTC'), p_occurred_at), 'HH12:MI AM')
    );
    UPDATE public.users SET
      pending_attendance_notify = NULL,
      pending_attendance_notify_at = NULL
    WHERE id = p_user_id;
  ELSE
    SELECT pending_attendance_notify INTO v_pending FROM public.users WHERE id = p_user_id;
    v_msg := v_pending;
    IF v_pending IS NOT NULL THEN
      UPDATE public.users SET
        pending_attendance_notify = NULL,
        pending_attendance_notify_at = NULL
      WHERE id = p_user_id;
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
      'connection_lost', true,
      'closed', v_n > 0
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'reason', v_action,
    'occurred_at', p_occurred_at,
    'notify_message', v_msg,
    'local_time', to_char(
      timezone(COALESCE(public.company_timezone(p_company_id), 'UTC'), p_occurred_at),
      'HH12:MI AM'
    ),
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_handle_connection_lost(
  uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text
) TO service_role;

-- Wire connection_lost early (before window / event_too_old) + exempt too_old.
DO $patch2$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Insert connection_lost handler immediately after occurred_at correction is available.
  -- Anchor: first attendance_window_for_user call after v_corr.
  IF def NOT LIKE '%attendance_handle_connection_lost%' THEN
    IF def NOT LIKE '%SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_corr.occurred_at)%' THEN
      RAISE EXCEPTION 'window lookup anchor missing';
    END IF;
    def := replace(def,
$old$  SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_corr.occurred_at) LIMIT 1;
$old$,
$new$  IF lower(v_event) = 'connection_lost' THEN
    SELECT COALESCE(u.work_mode::text, 'office') INTO v_wm
    FROM public.users u WHERE u.id = v_dev.user_id;
    RETURN public.attendance_handle_connection_lost(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version, v_wm
    );
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_corr.occurred_at) LIMIT 1;
$new$);
    -- process_auto may not declare v_wm — use inline subquery instead if needed.
    IF def LIKE '%SELECT COALESCE(u.work_mode::text, ''office'') INTO v_wm%' THEN
      -- Replace with a form that needs no extra DECLARE
      def := replace(def,
$old$  IF lower(v_event) = 'connection_lost' THEN
    SELECT COALESCE(u.work_mode::text, 'office') INTO v_wm
    FROM public.users u WHERE u.id = v_dev.user_id;
    RETURN public.attendance_handle_connection_lost(
      v_dev.user_id, v_dev.company_id, v_dev.id, v_event, v_corr.occurred_at,
      v_corr.skew_ms, v_corr.clock_flagged, p_client_ip, p_platform, p_app_version, v_wm
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
$new$);
    END IF;
  END IF;

  -- Exempt connection_lost from event_too_old (defense in depth if early return missed).
  IF def LIKE '%IF v_corr.occurred_at < v_now - INTERVAL ''15 minutes'' THEN%'
     AND def NOT LIKE '%AND lower(v_event) IS DISTINCT FROM ''connection_lost''%' THEN
    def := replace(def,
$old$  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes' THEN
$old$,
$new$  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes'
     AND lower(v_event) IS DISTINCT FROM 'connection_lost' THEN
$new$);
  END IF;

  IF def NOT LIKE '%attendance_handle_connection_lost%' THEN
    RAISE EXCEPTION 'failed to wire connection_lost helper';
  END IF;
  EXECUTE def;

  -- Pending notify attach (idempotent)
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );
  IF def NOT LIKE '%pending_attendance_notify%' THEN
    def := replace(def,
$old$  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
$old$,
$new$  IF v_notify_msg IS NULL OR btrim(v_notify_msg) = '' THEN
    SELECT pending_attendance_notify INTO v_notify_msg
    FROM public.users WHERE id = v_dev.user_id;
    IF v_notify_msg IS NOT NULL THEN
      UPDATE public.users SET
        pending_attendance_notify = NULL,
        pending_attendance_notify_at = NULL
      WHERE id = v_dev.user_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
$new$);
    EXECUTE def;
  END IF;
END $patch2$;

-- Patch process_geo to touch signals after a successful presence evaluation
DO $geo$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef(
    'public.process_geo_attendance_ping(double precision,double precision,double precision,text,boolean)'::regprocedure
  );

  IF def LIKE '%attendance_touch_user_signals%' THEN
    RAISE NOTICE 'process_geo already touches signals';
    RETURN;
  END IF;

  IF def LIKE '%v_match_kind%' THEN
    def := replace(def,
$old$  ELSIF v_intent = 'clock_out' THEN
$old$,
$new$  PERFORM public.attendance_touch_user_signals(
    v_user_id,
    v_now,
    COALESCE(v_chk_ok, false) AND COALESCE(v_match_kind, '') IN ('wifi_gps', 'wifi_no_gps'),
    COALESCE(v_chk_ok, false) AND COALESCE(v_match_kind, '') = 'wifi_gps'
      AND p_latitude IS NOT NULL AND p_longitude IS NOT NULL
      AND (p_accuracy IS NULL OR (p_accuracy >= 0 AND p_accuracy <= 50))
      AND NOT COALESCE(p_is_mock, false)
  );

  ELSIF v_intent = 'clock_out' THEN
$new$);
  END IF;

  IF def LIKE '%attendance_touch_user_signals%' THEN
    EXECUTE def;
  ELSE
    RAISE NOTICE 'process_geo signal touch skipped — insert point not found (non-fatal)';
  END IF;
END $geo$;

-- Self-read RPC for status card
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
  SELECT last_office_signal_at, last_any_signal_at, last_inside_gps_at
  INTO r
  FROM public.users WHERE id = v_uid;
  RETURN jsonb_build_object(
    'ok', true,
    'last_office_signal_at', r.last_office_signal_at,
    'last_any_signal_at', r.last_any_signal_at,
    'last_inside_gps_at', r.last_inside_gps_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_attendance_signal_times() TO authenticated;

NOTIFY pgrst, 'reload schema';
