-- False automatic check-out fix (all platforms).
-- Re-runnable. LAST in apply-all-migrations.mjs.
-- Does NOT change Rule 5 (outside GPS), Rule 6, manual Clock in/out, or check-in rules.
-- Does NOT hard-delete attendance_records or visit segments.
-- Repair (merge gaps) is gated — run only after operator says "fix records".

-- ---------------------------------------------------------------------------
-- Audit table for future repair (extend existing attendance_corrections_audit)
-- ---------------------------------------------------------------------------
ALTER TABLE public.attendance_corrections_audit
  ADD COLUMN IF NOT EXISTS visit_id UUID,
  ADD COLUMN IF NOT EXISTS closing_rule TEXT,
  ADD COLUMN IF NOT EXISTS corrected_by TEXT;

COMMENT ON COLUMN public.attendance_corrections_audit.corrected_by IS
  'Repair actor, e.g. system_false_checkout_repair';

CREATE INDEX IF NOT EXISTS idx_attendance_corrections_audit_target
  ON public.attendance_corrections_audit (target_user_id, created_at DESC);

ALTER TABLE public.attendance_visit_segments
  ADD COLUMN IF NOT EXISTS superseded_by UUID,
  ADD COLUMN IF NOT EXISTS merge_status TEXT;

COMMENT ON COLUMN public.attendance_visit_segments.merge_status IS
  'merged/superseded marker for false-checkout repair; never hard-deleted.';
-- ---------------------------------------------------------------------------
-- Backfill silence stamps from accepted office-network events (last 14 days)
-- ---------------------------------------------------------------------------
UPDATE public.users u SET
  last_any_signal_at = GREATEST(
    COALESCE(u.last_any_signal_at, '-infinity'::timestamptz),
    s.any_at
  ),
  last_office_signal_at = CASE
    WHEN s.office_at IS NULL THEN u.last_office_signal_at
    ELSE GREATEST(
      COALESCE(u.last_office_signal_at, '-infinity'::timestamptz),
      s.office_at
    )
  END
FROM (
  SELECT
    e.user_id,
    MAX(COALESCE(e.occurred_at, e.created_at)) AS any_at,
    MAX(COALESCE(e.occurred_at, e.created_at)) FILTER (
      WHERE COALESCE(e.matched_method, '') IN ('wifi', 'laptop')
         OR COALESCE((e.payload->>'wifi_ok')::boolean, false)
    ) AS office_at
  FROM public.attendance_events_log e
  WHERE e.accepted IS TRUE
    AND e.created_at > timezone('utc', now()) - INTERVAL '14 days'
    AND lower(COALESCE(e.event, '')) NOT IN ('connection_lost', 'device_sleep', 'device_shutdown')
  GROUP BY e.user_id
) s
WHERE u.id = s.user_id
  AND (
    u.last_any_signal_at IS NULL
    OR u.last_any_signal_at < s.any_at
    OR (s.office_at IS NOT NULL AND (u.last_office_signal_at IS NULL OR u.last_office_signal_at < s.office_at))
  );

-- ---------------------------------------------------------------------------
-- Helper: latest accepted office-network signal from ANY device (events + stamp)
-- ---------------------------------------------------------------------------
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
  v_stamp timestamptz;
  v_evt timestamptz;
  v_eff timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT last_office_signal_at INTO v_stamp
  FROM public.users WHERE id = p_user_id;

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

  v_eff := v_stamp;
  IF v_evt IS NOT NULL AND (v_eff IS NULL OR v_evt > v_eff) THEN
    v_eff := v_evt;
  END IF;
  IF p_visit_in IS NOT NULL AND (v_eff IS NULL OR p_visit_in > v_eff) THEN
    v_eff := p_visit_in;
  END IF;
  RETURN v_eff;
END;
$$;

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
  v_stamp timestamptz;
  v_evt timestamptz;
  v_eff timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT last_any_signal_at INTO v_stamp
  FROM public.users WHERE id = p_user_id;

  SELECT MAX(COALESCE(e.occurred_at, e.created_at)) INTO v_evt
  FROM public.attendance_events_log e
  WHERE e.user_id = p_user_id
    AND e.accepted IS TRUE
    AND e.created_at > timezone('utc', now()) - INTERVAL '12 hours'
    AND lower(COALESCE(e.event, '')) NOT IN ('connection_lost', 'device_sleep', 'device_shutdown');

  v_eff := v_stamp;
  IF v_evt IS NOT NULL AND (v_eff IS NULL OR v_evt > v_eff) THEN
    v_eff := v_evt;
  END IF;
  IF p_visit_in IS NOT NULL AND (v_eff IS NULL OR p_visit_in > v_eff) THEN
    v_eff := p_visit_in;
  END IF;
  RETURN v_eff;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_effective_office_signal_at(uuid, timestamptz)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_effective_any_signal_at(uuid, timestamptz)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared shift duration SSOT (sum of ALL visits for the shift date)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_shift_total_minutes(
  p_user_id uuid,
  p_shift_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN vs.clock_out_at IS NOT NULL THEN COALESCE(
        vs.work_minutes,
        GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::integer)
      )
      ELSE GREATEST(0, (EXTRACT(EPOCH FROM (p_now - vs.clock_in_at)) / 60)::integer)
    END
  ), 0)::integer
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = p_user_id
    AND vs.attendance_date = p_shift_date
    AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded';
$$;

-- Keep legacy name as a thin alias to the shared function.
CREATE OR REPLACE FUNCTION public.attendance_day_total_minutes(
  p_user_id uuid,
  p_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT public.attendance_shift_total_minutes(p_user_id, p_date, p_now);
$$;

CREATE OR REPLACE FUNCTION public.attendance_shift_day_summary(
  p_user_id uuid,
  p_shift_date date,
  p_now timestamptz DEFAULT timezone('utc', now())
)
RETURNS TABLE (
  first_clock_in timestamptz,
  last_clock_out timestamptz,
  still_present boolean,
  total_minutes integer,
  visit_count integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    MIN(vs.clock_in_at) AS first_clock_in,
    CASE
      WHEN BOOL_OR(vs.clock_out_at IS NULL) THEN NULL
      ELSE MAX(vs.clock_out_at)
    END AS last_clock_out,
    BOOL_OR(vs.clock_out_at IS NULL) AS still_present,
    public.attendance_shift_total_minutes(p_user_id, p_shift_date, p_now) AS total_minutes,
    COUNT(*)::integer AS visit_count
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = p_user_id
    AND vs.attendance_date = p_shift_date
    AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded';
$$;

GRANT EXECUTE ON FUNCTION public.attendance_shift_total_minutes(uuid, date, timestamptz)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_shift_day_summary(uuid, date, timestamptz)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attendance_history_work_minutes(
  p_user_id uuid,
  p_date date,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_stored integer,
  p_source text,
  p_shift_mins integer
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_seg integer;
  v_has_visits boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = p_user_id
      AND vs.attendance_date = p_date
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
  ) INTO v_has_visits;

  v_seg := public.attendance_shift_total_minutes(p_user_id, p_date);
  IF v_has_visits THEN
    RETURN v_seg;
  END IF;
  IF p_stored IS NOT NULL AND p_stored > 0 THEN
    RETURN p_stored;
  END IF;
  IF p_clock_in IS NOT NULL AND p_clock_out IS NOT NULL THEN
    RETURN GREATEST(0, (EXTRACT(EPOCH FROM (p_clock_out - p_clock_in)) / 60)::integer);
  END IF;
  IF p_source IS DISTINCT FROM 'geo' AND p_shift_mins IS NOT NULL AND p_shift_mins > 0 THEN
    RETURN p_shift_mins;
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rule 5c: any-device signals reset silence; never close visit younger than timeout
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

    SELECT MAX(clock_in_at) INTO v_visit_in
    FROM public.attendance_visit_segments
    WHERE user_id = r.user_id AND clock_out_at IS NULL;

    v_timeout := make_interval(mins => GREATEST(1, r.offline_mins));

    -- Never close a visit younger than the offline timeout.
    IF v_visit_in IS NOT NULL AND v_visit_in > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    -- Office-network signal from ANY device also resets 5c.
    v_last := public.attendance_effective_office_signal_at(r.user_id, v_visit_in);
    IF v_last IS NOT NULL AND v_last > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_last := public.attendance_effective_any_signal_at(r.user_id, v_visit_in);
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
-- Rule 5b: any-device office signal resets; visit-age grace; iOS holds
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
    WHERE user_id = r.user_id AND clock_out_at IS NULL;

    IF v_visit_in IS NOT NULL AND v_visit_in > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    IF v_ios AND public.attendance_ios_last_inside_gps_uncontradicted(r.user_id, v_visit_in) THEN
      CONTINUE;
    END IF;

    v_inside := r.last_inside_gps_at;
    IF v_inside IS NOT NULL AND v_inside > v_now - v_timeout THEN
      CONTINUE;
    END IF;

    v_last := public.attendance_effective_office_signal_at(r.user_id, v_visit_in);
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

-- Laptop sleep close: skip if any device still sending office-network signals
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
    WHERE user_id = r.user_id AND clock_out_at IS NULL;

    -- Phone/laptop still on office Wi-Fi → never close by laptop sleep rule.
    v_office := public.attendance_effective_office_signal_at(r.user_id, NULL);
    IF v_office IS NOT NULL AND v_office > v_now - INTERVAL '3 minutes' THEN
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

-- Cron order unchanged: Rule 6 → laptop → 5c → 5b
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
-- Touch trigger: also treat heartbeat/ping with wifi_ok; always refresh any-signal
-- ---------------------------------------------------------------------------
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
  IF v_ev IN ('connection_lost', 'device_sleep', 'device_shutdown') THEN
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

DROP TRIGGER IF EXISTS trg_attendance_events_log_touch_signals ON public.attendance_events_log;
CREATE TRIGGER trg_attendance_events_log_touch_signals
  AFTER INSERT ON public.attendance_events_log
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_events_log_touch_signals();

-- ---------------------------------------------------------------------------
-- process_auto: touch silence stamps on office present + force re-entry
-- when no open visit (left/pending must not block).
-- ---------------------------------------------------------------------------
DO $patch_pa$
DECLARE
  def text;
  marker text := 'scorr_false_checkout_reentry_v1';
BEGIN
  def := pg_get_functiondef(
    'public.process_auto_attendance_event(text,text,uuid,double precision,double precision,double precision,text,text,bigint,bigint,text,boolean,text,text,text,text)'::regprocedure
  );

  IF def LIKE '%' || marker || '%' THEN
    RAISE NOTICE 'false-checkout process_auto patch already present';
    RETURN;
  END IF;

  -- After wifi/laptop method resolved and before presence branching, touch signals.
  IF position('v_method :=' in def) > 0 AND position(marker in def) = 0 THEN
    -- Insert touch + re-entry clear just before PRESENT → check-in block
    IF position('PRESENT → check-in / new visit' in def) > 0 THEN
      def := replace(
        def,
        'PRESENT → check-in / new visit',
        marker || E'\n'
        || E'  -- Any accepted office-network present signal resets 5b/5c silence timers.\n'
        || E'  IF v_present AND (COALESCE(v_method, '''') IN (''wifi'', ''laptop'') OR COALESCE(v_wifi_ok, false)) THEN\n'
        || E'    PERFORM public.attendance_touch_user_signals(\n'
        || E'      v_dev.user_id, v_corr.occurred_at, true,\n'
        || E'      COALESCE(v_gps_inside, false)\n'
        || E'    );\n'
        || E'  ELSIF v_present THEN\n'
        || E'    PERFORM public.attendance_touch_user_signals(\n'
        || E'      v_dev.user_id, v_corr.occurred_at, false,\n'
        || E'      COALESCE(v_gps_inside, false)\n'
        || E'    );\n'
        || E'  END IF;\n'
        || E'  -- Re-entry: no open visit + office present → never stay blocked by left state.\n'
        || E'  IF v_present AND NOT v_has_visit\n'
        || E'     AND (COALESCE(v_method, '''') IN (''wifi'', ''laptop'') OR COALESCE(v_wifi_ok, false)) THEN\n'
        || E'    UPDATE public.attendance_devices SET\n'
        || E'      presence_state = ''present'',\n'
        || E'      last_presence_at = v_corr.occurred_at\n'
        || E'    WHERE id = v_dev.id;\n'
        || E'    v_dev.presence_state := ''present'';\n'
        || E'  END IF;\n'
        || E'  -- PRESENT → check-in / new visit'
      );
      EXECUTE def;
      RAISE NOTICE 'false-checkout process_auto patch applied';
    ELSE
      RAISE NOTICE 'false-checkout process_auto: PRESENT anchor not found (non-fatal)';
    END IF;
  END IF;
END $patch_pa$;

-- ---------------------------------------------------------------------------
-- STEP 4 list-only: false-checkout gaps (no edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_list_false_checkout_gaps(
  p_days integer DEFAULT 7
)
RETURNS TABLE (
  gap_user_id uuid,
  gap_full_name text,
  gap_email text,
  gap_shift_date date,
  gap_closed_visit_id uuid,
  gap_closing_rule text,
  gap_start timestamptz,
  gap_end timestamptz,
  gap_minutes integer,
  gap_evidence text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := timezone('utc', now()) - make_interval(days => GREATEST(1, COALESCE(p_days, 7)));
BEGIN
  RETURN QUERY
  WITH visits AS (
    SELECT
      vs.id AS visit_id,
      vs.user_id AS uid,
      vs.attendance_date AS adate,
      vs.clock_in_at AS cin,
      vs.clock_out_at AS cout,
      vs.notes AS vnotes,
      CASE
        WHEN COALESCE(vs.notes, '') ILIKE '%Device offline (no Wi-Fi or mobile data)%' THEN '5c'
        WHEN COALESCE(vs.notes, '') ILIKE '%No office Wi-Fi for % minutes (iOS)%' THEN '5b_ios'
        WHEN COALESCE(vs.notes, '') ILIKE '%No office Wi-Fi for 10 minutes%' THEN '5b'
        WHEN COALESCE(vs.notes, '') ILIKE '%Laptop asleep%' THEN 'laptop_sleep'
        WHEN COALESCE(vs.notes, '') ILIKE '%Laptop left office network%' THEN 'laptop_off_office'
        WHEN COALESCE(vs.notes, '') ILIKE '%Laptop shut down%' THEN 'laptop_shutdown'
        WHEN COALESCE(vs.notes, '') ILIKE '%connection_lost%'
          OR COALESCE(vs.notes, '') ILIKE '%Connection lost%' THEN 'connection_lost'
        WHEN COALESCE(vs.notes, '') ILIKE '%15m no presence%' THEN 'legacy_15m'
        ELSE NULL
      END AS close_rule
    FROM public.attendance_visit_segments vs
    WHERE vs.clock_in_at IS NOT NULL
      AND vs.clock_out_at IS NOT NULL
      AND vs.clock_out_at >= v_since
      AND COALESCE(vs.merge_status, '') IS DISTINCT FROM 'superseded'
  ),
  ordered AS (
    SELECT
      v.*,
      LEAD(v.cin) OVER (
        PARTITION BY v.uid, v.adate ORDER BY v.cin, v.visit_id
      ) AS next_in
    FROM visits v
  ),
  gaps AS (
    SELECT
      o.uid,
      o.adate,
      o.visit_id,
      o.close_rule,
      o.cout AS gstart,
      o.next_in AS gend,
      GREATEST(0, (EXTRACT(EPOCH FROM (o.next_in - o.cout)) / 60)::integer) AS gmins,
      o.vnotes
    FROM ordered o
    WHERE o.close_rule IS NOT NULL
      AND o.close_rule IN ('5c', '5b', '5b_ios', 'laptop_sleep', 'laptop_off_office', 'laptop_shutdown', 'connection_lost', 'legacy_15m')
      AND o.next_in IS NOT NULL
      AND o.next_in > o.cout
      AND COALESCE(o.vnotes, '') NOT ILIKE '%left the office radius%'
      AND COALESCE(o.vnotes, '') NOT ILIKE '%Rule 6%'
      AND COALESCE(o.vnotes, '') NOT ILIKE '%shift end%'
      AND COALESCE(o.vnotes, '') NOT ILIKE '%Clocked out on office Wi-Fi%'
      AND COALESCE(o.vnotes, '') NOT ILIKE '%Manual%'
  ),
  filtered AS (
    SELECT g.*,
      EXISTS (
        SELECT 1 FROM public.attendance_events_log e
        WHERE e.user_id = g.uid
          AND e.accepted IS TRUE
          AND COALESCE(e.occurred_at, e.created_at) > g.gstart
          AND COALESCE(e.occurred_at, e.created_at) < g.gend
          AND e.latitude IS NOT NULL
          AND e.longitude IS NOT NULL
          AND e.accuracy_m IS NOT NULL
          AND e.accuracy_m >= 0
          AND e.accuracy_m <= 50
          AND COALESCE((e.payload->>'gps_outside')::boolean, false) = true
          AND COALESCE((e.payload->>'is_mock')::boolean, false) = false
      ) AS has_outside_gps,
      EXISTS (
        SELECT 1 FROM public.attendance_events_log e
        WHERE e.user_id = g.uid
          AND e.accepted IS TRUE
          AND COALESCE(e.occurred_at, e.created_at) > g.gstart
          AND COALESCE(e.occurred_at, e.created_at) <= g.gend
          AND (
            COALESCE(e.matched_method, '') IN ('wifi', 'laptop')
            OR COALESCE((e.payload->>'wifi_ok')::boolean, false)
          )
      ) AS has_office_evt,
      EXISTS (
        SELECT 1 FROM public.attendance_events_log e
        WHERE e.user_id = g.uid
          AND e.accepted IS TRUE
          AND COALESCE(e.occurred_at, e.created_at) >= g.gend
          AND COALESCE(e.occurred_at, e.created_at) < g.gend + INTERVAL '2 hours'
          AND (
            COALESCE(e.matched_method, '') IN ('wifi', 'laptop')
            OR COALESCE((e.payload->>'wifi_ok')::boolean, false)
          )
      ) AS reentered_office
    FROM gaps g
  )
  SELECT
    f.uid,
    u.full_name::text,
    u.email::text,
    f.adate,
    f.visit_id,
    f.close_rule::text,
    f.gstart,
    f.gend,
    f.gmins,
    format(
      'close=%s; office_evt_in_gap=%s; reentered=%s; gap_le_60=%s',
      f.close_rule,
      f.has_office_evt,
      f.reentered_office,
      (f.gmins <= 60)
    )::text
  FROM filtered f
  JOIN public.users u ON u.id = f.uid
  WHERE f.has_outside_gps IS NOT TRUE
    AND (f.has_office_evt OR f.reentered_office OR f.gmins <= 60)
  ORDER BY u.full_name, f.adate, f.gstart;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_list_false_checkout_gaps(integer)
  TO authenticated, service_role;

-- Users currently on office Wi-Fi (recent) with no open visit
CREATE OR REPLACE FUNCTION public.attendance_list_stuck_no_open_visit(
  p_within_minutes integer DEFAULT 30
)
RETURNS TABLE (
  stuck_user_id uuid,
  stuck_full_name text,
  stuck_email text,
  last_office_event_at timestamptz,
  last_close_note text,
  last_clock_out_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH recent AS (
    SELECT e.user_id AS uid, MAX(COALESCE(e.occurred_at, e.created_at)) AS last_evt
    FROM public.attendance_events_log e
    WHERE e.accepted IS TRUE
      AND e.created_at > timezone('utc', now()) - make_interval(mins => GREATEST(5, COALESCE(p_within_minutes, 30)))
      AND (
        COALESCE(e.matched_method, '') IN ('wifi', 'laptop')
        OR COALESCE((e.payload->>'wifi_ok')::boolean, false)
      )
    GROUP BY e.user_id
  )
  SELECT
    u.id,
    u.full_name::text,
    u.email::text,
    r.last_evt,
    (
      SELECT vs.notes FROM public.attendance_visit_segments vs
      WHERE vs.user_id = u.id AND vs.clock_out_at IS NOT NULL
      ORDER BY vs.clock_out_at DESC LIMIT 1
    )::text,
    (
      SELECT vs.clock_out_at FROM public.attendance_visit_segments vs
      WHERE vs.user_id = u.id AND vs.clock_out_at IS NOT NULL
      ORDER BY vs.clock_out_at DESC LIMIT 1
    )
  FROM recent r
  JOIN public.users u ON u.id = r.uid
  WHERE NOT EXISTS (
    SELECT 1 FROM public.attendance_visit_segments vs
    WHERE vs.user_id = u.id AND vs.clock_out_at IS NULL
  )
  ORDER BY r.last_evt DESC;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_list_stuck_no_open_visit(integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
