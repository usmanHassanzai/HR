-- Fix 0-minute visit loop (check-in then immediate silence/stale close).
-- Re-runnable. LAST in apply-all-migrations.mjs.
-- Does NOT change check-in rules, Rule 5 semantics (fresh outside GPS), Rule 6,
-- manual Clock in/out, windows, KPIs, leave, login/MFA, departments, office setup.
-- Does NOT hard-delete attendance_records or visit segments.

-- ---------------------------------------------------------------------------
-- Raw signal helpers (do NOT floor to visit_in — callers apply GREATEST)
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
    AND lower(COALESCE(e.event, '')) NOT IN ('connection_lost', 'device_sleep', 'device_shutdown');
  IF v_stamp IS NULL THEN
    RETURN v_evt;
  END IF;
  IF v_evt IS NULL THEN
    RETURN v_stamp;
  END IF;
  RETURN GREATEST(v_stamp, v_evt);
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_raw_office_signal_at(p_user_id uuid)
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
  SELECT last_office_signal_at INTO v_stamp FROM public.users WHERE id = p_user_id;
  SELECT MAX(COALESCE(e.occurred_at, e.created_at)) INTO v_evt
  FROM public.attendance_events_log e
  WHERE e.user_id = p_user_id
    AND e.accepted IS TRUE
    AND e.created_at > timezone('utc', now()) - INTERVAL '12 hours'
    AND lower(COALESCE(e.event, '')) NOT IN ('connection_lost', 'device_sleep', 'device_shutdown')
    AND (
      COALESCE(e.matched_method, '') IN ('wifi', 'laptop')
      OR COALESCE((e.payload->>'wifi_ok')::boolean, false)
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

-- Keep effective_* for callers; still floor to visit_in for "is silence broken?"
CREATE OR REPLACE FUNCTION public.attendance_effective_any_signal_at(
  p_user_id uuid,
  p_visit_in timestamptz DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_eff timestamptz;
BEGIN
  v_eff := public.attendance_raw_any_signal_at(p_user_id);
  IF p_visit_in IS NOT NULL AND (v_eff IS NULL OR p_visit_in > v_eff) THEN
    v_eff := p_visit_in;
  END IF;
  RETURN v_eff;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_effective_office_signal_at(
  p_user_id uuid,
  p_visit_in timestamptz DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_eff timestamptz;
BEGIN
  v_eff := public.attendance_raw_office_signal_at(p_user_id);
  IF p_visit_in IS NOT NULL AND (v_eff IS NULL OR p_visit_in > v_eff) THEN
    v_eff := p_visit_in;
  END IF;
  RETURN v_eff;
END;
$$;

-- Log suppressed auto-closes (0-min / stale Rule 5)
CREATE TABLE IF NOT EXISTS public.attendance_auto_close_suppressed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  visit_id uuid,
  rule text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
CREATE INDEX IF NOT EXISTS idx_attendance_auto_close_suppressed_user
  ON public.attendance_auto_close_suppressed (user_id, created_at DESC);

-- Close helper: silence rules must not produce under-2-minute visits
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
  v_is_rule5 boolean := false;
  v_is_silence boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_out_at IS NULL OR COALESCE(p_note, '') = '' THEN
    RETURN 0;
  END IF;

  PERFORM set_config('scorr.attendance_write_mode', 'signal_timeout_close', true);

  v_is_rule5 :=
    p_note ILIKE '%left the office radius%'
    OR p_note ILIKE '%outside office radius%'
    OR p_note ILIKE '%Auto leave%';
  v_is_silence :=
    p_note ILIKE '%Device offline%'
    OR p_note ILIKE '%No office Wi-Fi%'
    OR p_note ILIKE '%Laptop asleep%'
    OR p_note ILIKE '%connection_lost%';

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments
  WHERE user_id = p_user_id
    AND clock_in_at IS NOT NULL
    AND clock_out_at IS NULL
    AND COALESCE(merge_status, '') IS DISTINCT FROM 'superseded'
  ORDER BY clock_in_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_out := GREATEST(v_visit.clock_in_at, p_out_at);
    v_mins := GREATEST(0, (EXTRACT(EPOCH FROM (v_out - v_visit.clock_in_at)) / 60)::integer);

    -- Guard: automatic silence/laptop close < 2 minutes after open → do not close
    IF v_is_silence AND NOT v_is_rule5
       AND (
         v_out < v_visit.clock_in_at + INTERVAL '2 minutes'
         OR v_mins < 2
       ) THEN
      INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
      VALUES (
        p_user_id, v_visit.id, 'under_2min_silence',
        jsonb_build_object(
          'note', p_note,
          'visit_in', v_visit.clock_in_at,
          'requested_out', p_out_at,
          'clamped_out', v_out,
          'mins', v_mins
        )
      );
      RETURN 0;
    END IF;
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
      IF p_out_at < v_visit.clock_in_at + INTERVAL '2 minutes' THEN
        INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
        VALUES (
          p_user_id, v_visit.id, 'under_2min_earlier_close',
          jsonb_build_object('note', p_note, 'visit_in', v_visit.clock_in_at, 'requested_out', p_out_at)
        );
        RETURN 0;
      END IF;
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

-- ---------------------------------------------------------------------------
-- Rule 5c — silence from later of signal and visit check-in; out after timeout
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
BEGIN
  FOR r IN
    SELECT DISTINCT vs.user_id, vs.attendance_date, u.company_id,
           COALESCE(c.attendance_offline_minutes, 3) AS offline_mins,
           u.last_inside_gps_at, u.work_mode
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

    v_timeout := make_interval(mins => GREATEST(1, r.offline_mins));

    -- Never close before timeout since visit opened; absolute 2-minute guard
    IF v_visit_in > v_now - v_timeout OR v_visit_in > v_now - INTERVAL '2 minutes' THEN
      CONTINUE;
    END IF;

    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    -- Office-network signal from ANY device also resets 5c
    IF public.attendance_effective_office_signal_at(r.user_id, v_visit_in) > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_raw := public.attendance_raw_any_signal_at(r.user_id);
    v_anchor := GREATEST(COALESCE(v_raw, v_visit_in), v_visit_in);
    IF v_anchor > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    -- Out = last signal only if strictly after check-in; else when silence matured
    IF v_raw IS NOT NULL AND v_raw > v_visit_in THEN
      v_out := v_raw;
    ELSE
      v_out := v_visit_in + v_timeout;
    END IF;
    v_out := LEAST(v_now, GREATEST(v_out, v_visit_in + v_timeout));

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

-- ---------------------------------------------------------------------------
-- Rule 5b — same silence-anchor rules
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
           u.last_inside_gps_at, u.work_mode
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

-- Laptop sleep: visit-age + office-signal guards; out not before visit_in+timeout
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
  v_note text;
  v_mins integer;
  v_visit_in timestamptz;
  v_office timestamptz;
  v_out timestamptz;
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
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
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

    SELECT MAX(clock_in_at) INTO v_visit_in
    FROM public.attendance_visit_segments
    WHERE user_id = r.user_id AND clock_out_at IS NULL
      AND COALESCE(merge_status, '') IS DISTINCT FROM 'superseded';

    IF v_visit_in IS NULL THEN
      CONTINUE;
    END IF;

    v_office := public.attendance_effective_office_signal_at(r.user_id, v_visit_in);
    IF v_office IS NOT NULL AND v_office > v_now - INTERVAL '3 minutes' THEN
      CONTINUE;
    END IF;

    v_mins := GREATEST(1, r.sleep_mins);
    v_timeout := make_interval(mins => v_mins);

    IF v_visit_in > v_now - v_timeout OR v_visit_in > v_now - INTERVAL '2 minutes' THEN
      CONTINUE;
    END IF;

    IF GREATEST(r.laptop_sleep_at, v_visit_in) > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_note := format('Laptop asleep for more than %s minutes', v_mins);
    IF r.laptop_sleep_at >= v_visit_in THEN
      v_out := r.laptop_sleep_at;
    ELSE
      v_out := v_visit_in + v_timeout;
    END IF;
    v_out := LEAST(v_now, GREATEST(v_out, v_visit_in + v_timeout));

    IF public.attendance_close_visit_with_note(r.user_id, v_out, v_note, false) > 0 THEN
      PERFORM public.attendance_laptop_set_notify(
        r.user_id, r.company_id, v_out,
        format('laptop asleep for more than %s minutes', v_mins)
      );
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5c() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_apply_rule_5b() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_apply_laptop_rules() TO service_role;

-- Restore cron: Rule 6 → laptop → 5c → 5b
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

-- connection_lost must not zero-minute a fresh visit
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
  v_visit_in timestamptz;
  v_timeout interval;
  v_offline_mins integer;
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

  SELECT MAX(clock_in_at) INTO v_visit_in
  FROM public.attendance_visit_segments
  WHERE user_id = p_user_id AND clock_out_at IS NULL
    AND COALESCE(merge_status, '') IS DISTINCT FROM 'superseded';

  SELECT COALESCE(c.attendance_offline_minutes, 3)
    INTO v_offline_mins
  FROM public.users u
  LEFT JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = p_user_id;
  v_timeout := make_interval(mins => GREATEST(1, COALESCE(v_offline_mins, 3)));

  IF v_visit_in IS NOT NULL
     AND (
       p_occurred_at <= v_visit_in
       OR v_visit_in > timezone('utc', now()) - v_timeout
       OR v_visit_in > timezone('utc', now()) - INTERVAL '2 minutes'
     ) THEN
    INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
    SELECT p_user_id, vs.id, 'connection_lost_too_soon',
      jsonb_build_object(
        'occurred_at', p_occurred_at,
        'visit_in', v_visit_in,
        'event', p_event,
        'platform', p_platform
      )
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id AND vs.clock_out_at IS NULL
    ORDER BY vs.clock_in_at DESC LIMIT 1;

    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at, payload
    ) VALUES (
      p_company_id, p_user_id, p_device_row_id, p_event, true, 'ignored_before_timeout', p_client_ip,
      p_skew_ms, p_clock_flagged, p_occurred_at,
      jsonb_build_object(
        'platform', p_platform,
        'app_version', p_app_version,
        'connection_lost', true,
        'suppressed', true
      )
    );
    RETURN jsonb_build_object('ok', true, 'action', 'ignored_before_timeout', 'occurred_at', p_occurred_at);
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

-- ---------------------------------------------------------------------------
-- Shared check-in: always refresh ALL signal stamps in the same transaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_try_auto_checkin(
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_is_mock boolean DEFAULT false,
  p_client_ip text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_zone_name text DEFAULT NULL,
  p_wifi_network_id uuid DEFAULT NULL,
  p_wifi_network_label text DEFAULT NULL,
  p_distance_m double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_at timestamptz := COALESCE(p_occurred_at, v_now);
  v_att_date date;
  v_win RECORD;
  v_presence RECORD;
  v_rec public.attendance_records%ROWTYPE;
  v_has_visit boolean := false;
  v_method text;
  v_source text;
  v_note text;
  v_prior_closed boolean := false;
  v_local text;
  v_company uuid;
  v_platform text := lower(COALESCE(p_platform, ''));
  v_inside_gps boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'action', 'none', 'reason', 'missing_user');
  END IF;

  SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, v_at) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_blocked_shift_ended',
      'reason', 'outside_window',
      'stop_tracking', false
    );
  END IF;

  IF NOT public.attendance_checkin_allowed(p_user_id, v_at) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', 'checkin_blocked_shift_ended',
      'reason', 'checkin_blocked_shift_ended',
      'stop_tracking', false
    );
  END IF;

  v_att_date := COALESCE(
    v_win.attendance_date,
    public.resolve_shift_attendance_date(p_user_id, v_at)
  );

  IF public.attendance_is_wfh_day(p_user_id, v_att_date) THEN
    RETURN jsonb_build_object('ok', true, 'action', 'wfh_skip', 'reason', 'wfh_skip');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.clock_out_at IS NULL
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
  ) INTO v_has_visit;
  IF v_has_visit THEN
    -- Still refresh stamps on accepted present ping while already in
    PERFORM public.attendance_touch_user_signals(p_user_id, v_at, true, false);
    RETURN jsonb_build_object('ok', true, 'action', 'already_checked_in', 'reason', 'already_checked_in');
  END IF;

  SELECT * INTO v_presence
  FROM public.attendance_office_presence_check(
    p_user_id, p_latitude, p_longitude, p_accuracy_m,
    COALESCE(p_is_mock, false), p_client_ip, 'check_in'
  ) LIMIT 1;

  IF NOT COALESCE(v_presence.ok, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'action', COALESCE(v_presence.reason, 'outside_radius'),
      'reason', COALESCE(v_presence.reason, 'outside_radius'),
      'stop_tracking', false
    );
  END IF;

  v_inside_gps := COALESCE(v_presence.inside_radius, false)
    AND COALESCE(v_presence.gps_usable, false);

  IF COALESCE(v_presence.match_kind, '') = 'wifi_no_gps'
     OR (COALESCE(v_presence.on_wifi, false) AND NOT COALESCE(v_presence.gps_usable, false)) THEN
    v_method := CASE WHEN v_platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
    v_source := 'auto_wifi_no_gps';
  ELSE
    v_method := CASE WHEN v_platform IN ('windows', 'linux') THEN 'laptop' ELSE 'wifi' END;
    v_source := CASE WHEN v_platform IN ('windows', 'linux') THEN 'auto_laptop' ELSE 'auto_wifi' END;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.attendance_date = v_att_date
      AND vs.clock_out_at IS NOT NULL
  ) INTO v_prior_closed;

  IF v_source = 'auto_wifi_no_gps' THEN
    v_note := 'Checked in on office Wi-Fi, location unavailable'
      || CASE WHEN p_wifi_network_label IS NOT NULL THEN ' · ' || p_wifi_network_label ELSE '' END;
  ELSE
    v_note := 'Checked in at ' || COALESCE(p_zone_name, 'office')
      || ' · ' || COALESCE(p_wifi_network_label, 'office Wi-Fi')
      || CASE
           WHEN COALESCE(v_presence.distance_m, p_distance_m) IS NOT NULL
           THEN ' · ' || ROUND(COALESCE(v_presence.distance_m, p_distance_m))::int || 'm from the office'
           ELSE ''
         END;
  END IF;

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, marked_by,
    clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
    reviewed_by, reviewed_at, presence_method, wifi_network_id, wifi_network_label
  ) VALUES (
    p_user_id, v_att_date, 'present', 'approved', p_user_id,
    v_at, p_latitude, p_longitude, v_source, v_win.shift_id, v_note,
    p_user_id, v_now, v_method, p_wifi_network_id, p_wifi_network_label
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE SET
    clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
    clock_out_at = NULL,
    clock_out_lat = NULL,
    clock_out_lng = NULL,
    status = 'present',
    approval_status = 'approved',
    attendance_source = CASE
      WHEN public.attendance_records.clock_in_at IS NULL OR public.attendance_records.clock_out_at IS NOT NULL
      THEN EXCLUDED.attendance_source
      ELSE public.attendance_records.attendance_source
    END,
    presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
    wifi_network_id = COALESCE(EXCLUDED.wifi_network_id, public.attendance_records.wifi_network_id),
    wifi_network_label = COALESCE(EXCLUDED.wifi_network_label, public.attendance_records.wifi_network_label),
    shift_id = COALESCE(EXCLUDED.shift_id, public.attendance_records.shift_id),
    notes = CASE
      WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
      THEN EXCLUDED.notes ELSE public.attendance_records.notes
    END
  RETURNING * INTO v_rec;

  PERFORM public.attendance_ensure_open_visit(
    p_user_id, v_rec.id, v_att_date, v_at,
    'Auto entry ' || COALESCE(v_method, '')
  );

  UPDATE public.attendance_visit_segments SET
    clock_in_lat = COALESCE(clock_in_lat, p_latitude),
    clock_in_lng = COALESCE(clock_in_lng, p_longitude),
    site_name = COALESCE(site_name, p_zone_name),
    wifi_network_id = COALESCE(p_wifi_network_id, wifi_network_id),
    wifi_network_label = COALESCE(p_wifi_network_label, wifi_network_label)
  WHERE user_id = p_user_id
    AND attendance_date = v_att_date
    AND clock_out_at IS NULL;

  UPDATE public.attendance_devices SET
    presence_state = 'present',
    last_presence_at = v_at,
    gps_outside_streak = 0
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  -- Every accepted check-in updates office + any + inside GPS (when usable)
  PERFORM public.attendance_touch_user_signals(p_user_id, v_at, true, v_inside_gps);

  SELECT company_id INTO v_company FROM public.users WHERE id = p_user_id;
  v_local := to_char(
    timezone(COALESCE(public.company_timezone(v_company), 'UTC'), v_at),
    'HH12:MI AM'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'clock_in',
    'reason', 'clock_in',
    'attendance_date', v_att_date,
    'attendance_source', v_source,
    'presence_method', v_method,
    'local_time', v_local,
    'notify_message', CASE
      WHEN v_prior_closed THEN format('Checked in again at %s', v_local)
      ELSE format('Checked in at %s', v_local)
    END,
    'stop_tracking', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_try_auto_checkin(
  uuid, timestamptz, double precision, double precision, double precision,
  boolean, text, text, text, uuid, text, double precision
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- process_auto: ignore stale Rule 5 (occurred_at / location before visit in)
-- ---------------------------------------------------------------------------
DO $pa$
DECLARE
  def text;
  old_left text;
  new_left text;
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  -- Upgrade Rule 5 stale guard to use raw device timestamp (skew-safe).
  IF position('scorr_stale_rule5_guard_v2' in def) = 0 THEN
    IF position('scorr_stale_rule5_guard_v1' in def) > 0 THEN
      def := replace(
        def,
        $v1$-- scorr_stale_rule5_guard_v1
    -- Rule 5: occurred_at (event/location time) must be AFTER the open visit check-in.
    IF v_has_visit AND v_visit.clock_in_at IS NOT NULL
       AND v_corr.occurred_at <= v_visit.clock_in_at THEN
      INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
      VALUES (
        v_dev.user_id, v_visit.id, 'stale_rule5_reading',
        jsonb_build_object(
          'occurred_at', v_corr.occurred_at,
          'visit_in', v_visit.clock_in_at,
          'event', v_event,
          'accuracy_m', p_accuracy_m,
          'lat', p_latitude,
          'lng', p_longitude
        )
      );
      v_action := 'ignored_stale_outside';
    -- Outside the radius checks the person out on this reading.
    -- Other enrolled devices do not delay check-out.
    ELSIF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN$v1$,
        $v2$-- scorr_stale_rule5_guard_v2
    -- Raw device timestamp (before skew rewrite) must be AFTER the open visit check-in.
    IF v_has_visit AND v_visit.clock_in_at IS NOT NULL
       AND (
         v_corr.occurred_at <= v_visit.clock_in_at
         OR (
           p_occurred_at_utc_ms IS NOT NULL
           AND to_timestamp(p_occurred_at_utc_ms / 1000.0) <= v_visit.clock_in_at
         )
       ) THEN
      INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
      VALUES (
        v_dev.user_id, v_visit.id, 'stale_rule5_reading',
        jsonb_build_object(
          'occurred_at', v_corr.occurred_at,
          'raw_occurred_at', CASE
            WHEN p_occurred_at_utc_ms IS NULL THEN NULL
            ELSE to_timestamp(p_occurred_at_utc_ms / 1000.0)
          END,
          'visit_in', v_visit.clock_in_at,
          'event', v_event,
          'accuracy_m', p_accuracy_m,
          'lat', p_latitude,
          'lng', p_longitude
        )
      );
      v_action := 'ignored_stale_outside';
    -- Outside the radius checks the person out on this reading.
    -- Other enrolled devices do not delay check-out.
    ELSIF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN$v2$
      );
    ELSE
      old_left := $o$ELSIF v_left AND v_leave_mode = 'immediate' THEN
    -- Outside the radius checks the person out on this reading.
    -- Other enrolled devices do not delay check-out.
    IF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN$o$;
      new_left := $n$ELSIF v_left AND v_leave_mode = 'immediate' THEN
    -- scorr_stale_rule5_guard_v2
    IF v_has_visit AND v_visit.clock_in_at IS NOT NULL
       AND (
         v_corr.occurred_at <= v_visit.clock_in_at
         OR (
           p_occurred_at_utc_ms IS NOT NULL
           AND to_timestamp(p_occurred_at_utc_ms / 1000.0) <= v_visit.clock_in_at
         )
       ) THEN
      INSERT INTO public.attendance_auto_close_suppressed (user_id, visit_id, rule, detail)
      VALUES (
        v_dev.user_id, v_visit.id, 'stale_rule5_reading',
        jsonb_build_object(
          'occurred_at', v_corr.occurred_at,
          'raw_occurred_at', CASE
            WHEN p_occurred_at_utc_ms IS NULL THEN NULL
            ELSE to_timestamp(p_occurred_at_utc_ms / 1000.0)
          END,
          'visit_in', v_visit.clock_in_at,
          'event', v_event,
          'accuracy_m', p_accuracy_m,
          'lat', p_latitude,
          'lng', p_longitude
        )
      );
      v_action := 'ignored_stale_outside';
    ELSIF v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN$n$;
      IF position(old_left in def) = 0 THEN
        RAISE NOTICE 'stale Rule 5 guard v2: LEFT anchor not found (non-fatal)';
      ELSE
        def := replace(def, old_left, new_left);
      END IF;
    END IF;
  END IF;

  EXECUTE def;
END $pa$;

-- Manual check-in: refresh silence stamps
DO $manual$
DECLARE
  def text;
BEGIN
  def := pg_get_functiondef('public.check_in_attendance'::regproc);
  IF position('scorr_manual_checkin_touch_v1' in def) > 0 THEN
    RETURN;
  END IF;
  IF position('PERFORM public.attendance_ensure_open_visit(v_uid,' in def) = 0 THEN
    RAISE NOTICE 'manual check_in ensure anchor missing';
    RETURN;
  END IF;
  def := replace(
    def,
    'PERFORM public.attendance_ensure_open_visit(v_uid,',
    $t$-- scorr_manual_checkin_touch_v1
        PERFORM public.attendance_touch_user_signals(
          v_uid, COALESCE(v_now, timezone('utc', now())), true, false
        );
        PERFORM public.attendance_ensure_open_visit(v_uid,$t$
  );
  BEGIN
    EXECUTE def;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'manual check_in touch patch skipped: %', SQLERRM;
  END;
END $manual$;

NOTIFY pgrst, 'reload schema';
