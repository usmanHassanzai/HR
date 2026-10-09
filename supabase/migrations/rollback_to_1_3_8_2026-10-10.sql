-- rollback_to_1_3_8_2026-10-10.sql
-- Re-runnable. Restores attendance/shift/office RPC surface to baseline commit 52f8774 (practical 1.3.8).
-- Does NOT drop tables/columns that hold real data.
-- Removes ONLY proven EdgeIP @scorr.test leftovers.

-- =============================================================================
-- 0) Proven test-data cleanup (EdgeIP from scripts/test-edge-attendance-ip.mjs)
-- =============================================================================
DO $cleanup$
DECLARE
  v_company uuid;
  v_n int;
BEGIN
  SELECT id INTO v_company FROM public.companies WHERE slug = 'edge-ip-0f9f49a4' LIMIT 1;
  IF v_company IS NULL THEN
    RAISE NOTICE 'EdgeIP company not found — skip named EdgeIP cleanup';
  ELSE
    RAISE NOTICE 'Deleting EdgeIP test company %', v_company;
  END IF;

  -- Child rows for any @scorr.test users (proven script leftovers)
  DELETE FROM public.attendance_events_log e
  USING public.users u
  WHERE e.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.attendance_visit_segments v
  USING public.users u
  WHERE v.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.attendance_records ar
  USING public.users u
  WHERE ar.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.attendance_devices d
  USING public.users u
  WHERE d.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.attendance_devices d
  WHERE v_company IS NOT NULL AND d.company_id = v_company;

  DELETE FROM public.employee_shift_assignments a
  USING public.users u
  WHERE a.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.employee_work_sites s
  USING public.users u
  WHERE s.user_id = u.id AND u.email ILIKE '%@scorr.test';

  DELETE FROM public.work_shifts
  WHERE name = 'EdgeIP Shift'
     OR (v_company IS NOT NULL AND manager_id IN (SELECT id FROM public.users WHERE company_id = v_company OR email ILIKE '%@scorr.test'));

  IF v_company IS NOT NULL THEN
    DELETE FROM public.office_wifi_networks WHERE company_id = v_company;
    DELETE FROM public.office_locations WHERE company_id = v_company;
  END IF;

  -- Users before departments (avoid department_id NULL check on employees)
  DELETE FROM auth.users WHERE email ILIKE '%@scorr.test';
  DELETE FROM public.users WHERE email ILIKE '%@scorr.test'
     OR (v_company IS NOT NULL AND company_id = v_company);

  IF v_company IS NOT NULL THEN
    DELETE FROM public.departments WHERE company_id = v_company;
    DELETE FROM public.companies WHERE id = v_company;
  END IF;

  DELETE FROM public.companies
  WHERE contact_email ILIKE '%@scorr.test'
     OR slug ILIKE 'edge-ip-%';

  SELECT count(*)::int INTO v_n FROM public.users WHERE email ILIKE '%@scorr.test';
  RAISE NOTICE 'Remaining @scorr.test users: %', v_n;
END;
$cleanup$;

-- =============================================================================
-- 1) Drop post-1.3.8-only triggers (safe; functions recreated below)
-- =============================================================================
DROP TRIGGER IF EXISTS trg_attendance_events_log_touch_signals ON public.attendance_events_log;
DROP TRIGGER IF EXISTS trg_office_locations_bump_version ON public.office_locations;
DROP TRIGGER IF EXISTS trg_office_locations_after_sync ON public.office_locations;
DROP TRIGGER IF EXISTS trg_attendance_block_checkin_after_shift_end ON public.attendance_records;
DROP TRIGGER IF EXISTS trg_attendance_present_requires_presence_evidence ON public.attendance_records;

-- =============================================================================
-- 2) Drop post-1.3.8-only functions (and extra overloads)
-- =============================================================================
DROP FUNCTION IF EXISTS public.attendance_apply_rule_5b() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_apply_rule_5c() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_apply_laptop_rules() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_retention_cleanup() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_try_auto_checkin(uuid, timestamptz, double precision, double precision, double precision, boolean, text, text, text, uuid, text, double precision) CASCADE;
DROP FUNCTION IF EXISTS public.notify_month_end_kpi_weightage() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_app_backgrounded_grace_active(uuid, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_app_backgrounded(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_app_quit(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_connection_lost(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_device_sleep(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_device_shutdown(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_handle_device_wake(uuid, uuid, uuid, text, timestamptz, bigint, boolean, text, text, text, text, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_list_false_checkout_gaps(integer) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_list_stuck_no_open_visit(integer) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_office_presence_check(uuid, double precision, double precision, double precision, boolean, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_effective_any_signal_at(uuid, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_effective_office_signal_at(uuid, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_raw_any_signal_at(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_raw_office_signal_at(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_visit_effective_end(uuid, timestamptz, timestamptz, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_shift_day_summary(uuid, date, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_shift_total_minutes(uuid, date, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_day_total_minutes(uuid, date, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_history_work_minutes(uuid, date, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_close_visit_with_note(uuid, uuid, timestamptz, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_touch_user_signals(uuid, timestamptz, boolean, boolean, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_events_log_touch_signals() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_guard_clock_times() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_user_uses_ios_silence_rules(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_ios_last_inside_gps_uncontradicted(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_user_uses_laptop_only_rules(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_laptop_sleep_grace_active(uuid, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_laptop_set_notify(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.attendance_laptop_track_off_office(uuid, boolean, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.trg_office_locations_bump_and_sync() CASCADE;
DROP FUNCTION IF EXISTS public.trg_office_locations_after_sync() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_block_checkin_after_shift_end() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_present_requires_presence_evidence() CASCADE;
DROP FUNCTION IF EXISTS public.get_my_attendance_signal_times() CASCADE;
DROP FUNCTION IF EXISTS public.check_out_attendance(date, double precision, double precision, double precision, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(double precision, double precision, double precision, text) CASCADE;
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_work_shift(text, time, time, integer[], integer, uuid, boolean, boolean, text, jsonb) CASCADE;

-- Optional empty post-only table (no real data expected)
DROP TABLE IF EXISTS public.attendance_auto_close_suppressed;

-- Drop functions that may have incompatible OUT/return types vs 1.3.8
DO $drop_compat$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_attendance_history',
        'get_team_attendance_history',
        'get_my_attendance_visits',
        'process_auto_attendance_event',
        'process_geo_attendance_ping',
        'check_in_attendance',
        'check_out_attendance',
        'close_open_attendance_if_shift_ended',
        'attendance_cron_tick',
        'attendance_close_stale_presence',
        'attendance_close_ended_windows',
        'attendance_window_for_user',
        'geo_confirm_left_site',
        'upsert_work_shift',
        'can_assign_kpi_to',
        'register_attendance_device',
        'sync_work_sites_to_office',
        'resolve_shift_attendance_date',
        'delete_work_shift',
        'can_manage_org_shifts',
        'attendance_now',
        'attendance_match_office_wifi',
        'attendance_checkin_allowed',
        'attendance_resolve_history_clock_out',
        'attendance_history_still_open',
        'reconcile_ended_shift_attendance',
        'app_timezone',
        'shift_end_timestamptz',
        'attendance_bounds_for_clock',
        'shift_latest_end_timestamptz',
        'get_my_location_window',
        'get_employee_work_sites',
        'get_manager_work_sites',
        'get_work_site_for_user',
        'attendance_schedule_for_user',
        'correct_attendance_times',
        'attendance_request_client_ip'
      )
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END;
$drop_compat$;

-- =============================================================================
-- 3) Recreate 1.3.8-era function bodies from baseline migrations (52f8774)
-- =============================================================================

-- >>> BEGIN attendance_window_core.sql
-- attendance_window_core.sql
-- R6–R12 / R20–R23: shared attendance window W = [start-60m, end+60m] in shift TZ.

CREATE OR REPLACE FUNCTION public.attendance_local_date(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT (p_at AT TIME ZONE assert_valid_iana_timezone(p_tz))::DATE;
$$;

-- Build timestamptz for a local clock on a given local date in IANA zone
CREATE OR REPLACE FUNCTION public.attendance_tz_instant(
  p_local_date DATE,
  p_local_time TIME,
  p_tz TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT (p_local_date + p_local_time) AT TIME ZONE assert_valid_iana_timezone(p_tz);
$$;

CREATE OR REPLACE FUNCTION public.attendance_iso_dow(p_at TIMESTAMPTZ, p_tz TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT EXTRACT(ISODOW FROM (p_at AT TIME ZONE assert_valid_iana_timezone(p_tz)))::INTEGER;
$$;

/**
 * Shared window for a user at instant p_at (server timestamptz).
 * Returns NULL shift fields when no shift covers that local day (R12).
 */
CREATE OR REPLACE FUNCTION public.attendance_window_for_user(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS TABLE (
  has_shift BOOLEAN,
  in_window BOOLEAN,
  shift_id UUID,
  shift_name TEXT,
  shift_tz TEXT,
  start_time TIME,
  end_time TIME,
  days_of_week INTEGER[],
  crosses_midnight BOOLEAN,
  attendance_date DATE,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  shift_start_utc TIMESTAMPTZ,
  shift_end_utc TIMESTAMPTZ,
  company_id UUID,
  company_tz TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id UUID;
  v_company_tz TEXT;
  v_shift_id UUID;
  v_shift_name TEXT;
  v_shift_tz TEXT;
  v_start TIME;
  v_end TIME;
  v_days INTEGER[];
  v_grace INTEGER;
  v_overnight BOOLEAN;
  v_local_date DATE;
  v_prev_date DATE;
  v_dow INTEGER;
  v_prev_dow INTEGER;
  v_att_date DATE;
  v_shift_start TIMESTAMPTZ;
  v_shift_end TIMESTAMPTZ;
  v_win_start TIMESTAMPTZ;
  v_win_end TIMESTAMPTZ;
  v_found BOOLEAN := false;
BEGIN
  SELECT u.company_id, public.company_timezone(u.company_id)
  INTO v_company_id, v_company_tz
  FROM public.users u
  WHERE u.id = p_user_id;

  v_company_tz := COALESCE(v_company_tz, 'Asia/Karachi');

  -- Prefer assigned active shift
  SELECT s.shift_id, s.shift_name, s.start_time, s.end_time, s.grace_minutes, s.days_of_week, s.crosses_midnight
  INTO v_shift_id, v_shift_name, v_start, v_end, v_grace, v_days, v_overnight
  FROM public.get_active_shift_for_user(p_user_id, public.attendance_local_date(p_at, v_company_tz)) s
  LIMIT 1;

  IF FOUND AND v_shift_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(btrim(ws.timezone), ''), v_company_tz)
    INTO v_shift_tz
    FROM public.work_shifts ws
    WHERE ws.id = v_shift_id;
    v_found := true;
  ELSE
    -- No personal shift: do not invent company hours for auto attendance (R12)
    has_shift := false;
    in_window := false;
    shift_id := NULL;
    shift_name := NULL;
    shift_tz := v_company_tz;
    start_time := NULL;
    end_time := NULL;
    days_of_week := NULL;
    crosses_midnight := false;
    attendance_date := NULL;
    window_start_utc := NULL;
    window_end_utc := NULL;
    shift_start_utc := NULL;
    shift_end_utc := NULL;
    company_id := v_company_id;
    company_tz := v_company_tz;
    RETURN NEXT;
    RETURN;
  END IF;

  v_shift_tz := assert_valid_iana_timezone(COALESCE(v_shift_tz, v_company_tz));
  v_days := COALESCE(v_days, ARRAY[1,2,3,4,5]);
  v_overnight := COALESCE(v_overnight, (v_end <= v_start));

  v_local_date := public.attendance_local_date(p_at, v_shift_tz);
  v_prev_date := v_local_date - 1;
  v_dow := public.attendance_iso_dow(p_at, v_shift_tz);
  v_prev_dow := CASE WHEN v_dow = 1 THEN 7 ELSE v_dow - 1 END;

  IF NOT v_overnight THEN
    IF v_dow = ANY (v_days) THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, v_end, v_shift_tz);
    ELSE
      has_shift := false;
      in_window := false;
      shift_id := v_shift_id;
      shift_name := v_shift_name;
      shift_tz := v_shift_tz;
      start_time := v_start;
      end_time := v_end;
      days_of_week := v_days;
      crosses_midnight := false;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      company_id := v_company_id;
      company_tz := v_company_tz;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    -- Overnight: before end clock belongs to previous local day's shift
    IF v_dow = ANY (v_days) AND (p_at AT TIME ZONE v_shift_tz)::TIME >= v_start THEN
      v_att_date := v_local_date;
      v_shift_start := public.attendance_tz_instant(v_local_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date + 1, v_end, v_shift_tz);
    ELSIF v_prev_dow = ANY (v_days) AND (p_at AT TIME ZONE v_shift_tz)::TIME <= v_end THEN
      v_att_date := v_prev_date;
      v_shift_start := public.attendance_tz_instant(v_prev_date, v_start, v_shift_tz);
      v_shift_end := public.attendance_tz_instant(v_local_date, v_end, v_shift_tz);
    ELSE
      has_shift := false;
      in_window := false;
      shift_id := v_shift_id;
      shift_name := v_shift_name;
      shift_tz := v_shift_tz;
      start_time := v_start;
      end_time := v_end;
      days_of_week := v_days;
      crosses_midnight := true;
      attendance_date := NULL;
      window_start_utc := NULL;
      window_end_utc := NULL;
      shift_start_utc := NULL;
      shift_end_utc := NULL;
      company_id := v_company_id;
      company_tz := v_company_tz;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_win_start := v_shift_start - INTERVAL '60 minutes';
  v_win_end := v_shift_end + INTERVAL '60 minutes';

  has_shift := true;
  in_window := (p_at >= v_win_start AND p_at <= v_win_end);
  shift_id := v_shift_id;
  shift_name := v_shift_name;
  shift_tz := v_shift_tz;
  start_time := v_start;
  end_time := v_end;
  days_of_week := v_days;
  crosses_midnight := v_overnight;
  attendance_date := v_att_date;
  window_start_utc := v_win_start;
  window_end_utc := v_win_end;
  shift_start_utc := v_shift_start;
  shift_end_utc := v_shift_end;
  company_id := v_company_id;
  company_tz := v_company_tz;
  RETURN NEXT;
END;
$$;

-- Skew correction (R25)
CREATE OR REPLACE FUNCTION public.attendance_correct_occurred_at(
  p_occurred_at_utc_ms BIGINT,
  p_device_now_utc_ms BIGINT,
  p_server_now TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS TABLE (
  occurred_at TIMESTAMPTZ,
  skew_ms BIGINT,
  clock_flagged BOOLEAN
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_server_ms BIGINT := (EXTRACT(EPOCH FROM p_server_now) * 1000)::BIGINT;
  v_skew BIGINT;
  v_occurred BIGINT;
BEGIN
  IF p_occurred_at_utc_ms IS NULL THEN
    occurred_at := p_server_now;
    skew_ms := 0;
    clock_flagged := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_occurred := p_occurred_at_utc_ms;
  v_skew := 0;
  clock_flagged := false;

  IF p_device_now_utc_ms IS NOT NULL THEN
    v_skew := p_device_now_utc_ms - v_server_ms;
    IF ABS(v_skew) > 2 * 60 * 1000 THEN
      v_occurred := p_occurred_at_utc_ms - v_skew;
    END IF;
    IF ABS(v_skew) > 10 * 60 * 1000 THEN
      clock_flagged := true;
    END IF;
  END IF;

  occurred_at := to_timestamp(v_occurred / 1000.0);
  skew_ms := v_skew;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_local_date(TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_tz_instant(DATE, TIME, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_iso_dow(TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_window_for_user(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_correct_occurred_at(BIGINT, BIGINT, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_window_core.sql

-- >>> BEGIN attendance_enforcement_triggers.sql
-- attendance_enforcement_triggers.sql
-- R16–R17 / C: reject NEW clock time writes outside W unless correction/leave/day_status context.
-- Historical rows are never rewritten by this migration.

CREATE OR REPLACE FUNCTION public.attendance_guard_clock_times()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode TEXT := public.attendance_write_mode();
  v_win RECORD;
  v_at TIMESTAMPTZ;
BEGIN
  -- Allow audited correction, leave day-status, and day_status supervisor marks
  IF v_mode IN ('admin_correction', 'leave', 'day_status') THEN
    RETURN NEW;
  END IF;

  -- Only care when clock times are introduced or changed
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

DROP TRIGGER IF EXISTS trg_attendance_records_window_guard ON public.attendance_records;
CREATE TRIGGER trg_attendance_records_window_guard
  BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at
  ON public.attendance_records
  FOR EACH ROW
  EXECUTE PROCEDURE public.attendance_guard_clock_times();

DROP TRIGGER IF EXISTS trg_attendance_visits_window_guard ON public.attendance_visit_segments;
CREATE TRIGGER trg_attendance_visits_window_guard
  BEFORE INSERT OR UPDATE OF clock_in_at, clock_out_at
  ON public.attendance_visit_segments
  FOR EACH ROW
  EXECUTE PROCEDURE public.attendance_guard_clock_times();

-- Reject location pings outside W (N3)
CREATE OR REPLACE FUNCTION public.employee_location_pings_window_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
  v_at TIMESTAMPTZ := COALESCE(NEW.recorded_at, timezone('utc', now()));
BEGIN
  SELECT * INTO v_win FROM public.attendance_window_for_user(NEW.user_id, v_at) LIMIT 1;
  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    RAISE EXCEPTION 'location_ping_outside_window';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_location_pings_window ON public.employee_location_pings;
CREATE TRIGGER trg_employee_location_pings_window
  BEFORE INSERT ON public.employee_location_pings
  FOR EACH ROW
  EXECUTE PROCEDURE public.employee_location_pings_window_guard();

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_enforcement_triggers.sql

-- >>> BEGIN attendance_auto_rpc.sql
-- attendance_auto_rpc.sql
-- R55 / J: device-token auto attendance event processing (security definer).
-- Edge function auto-attendance-event calls this after hashing the token.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.attendance_hash_device_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.attendance_ip_in_cidrs(p_ip TEXT, p_cidrs TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c TEXT;
  host TEXT;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' OR p_cidrs IS NULL THEN
    RETURN false;
  END IF;
  -- Exact match or prefix match for CIDR strings (simple, no inet family mix issues)
  FOREACH c IN ARRAY p_cidrs LOOP
    c := btrim(c);
    IF c = '' THEN CONTINUE; END IF;
    host := split_part(c, '/', 1);
    IF p_ip = host OR p_ip = c THEN
      RETURN true;
    END IF;
    -- CIDR: compare as inet when both parse
    BEGIN
      IF p_ip::inet <<= c::inet THEN
        RETURN true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_device_any_present(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
      AND d.last_heartbeat_at IS NOT NULL
      AND d.last_heartbeat_at > timezone('utc', now()) - INTERVAL '15 minutes'
      AND COALESCE((d.last_seen_at IS NOT NULL), true)
  );
$$;

-- Track per-device presence state for multi-device checkout (R54)
ALTER TABLE public.attendance_devices
  ADD COLUMN IF NOT EXISTS presence_state TEXT
    CHECK (presence_state IS NULL OR presence_state IN ('present', 'left', 'unknown')),
  ADD COLUMN IF NOT EXISTS last_presence_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_zone_id UUID,
  ADD COLUMN IF NOT EXISTS last_matched_method TEXT;

CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(
  p_token_hash TEXT,
  p_event TEXT,
  p_zone_id UUID DEFAULT NULL,
  p_latitude DOUBLE PRECISION DEFAULT NULL,
  p_longitude DOUBLE PRECISION DEFAULT NULL,
  p_accuracy_m DOUBLE PRECISION DEFAULT NULL,
  p_ssid TEXT DEFAULT NULL,
  p_bssid TEXT DEFAULT NULL,
  p_occurred_at_utc_ms BIGINT DEFAULT NULL,
  p_device_now_utc_ms BIGINT DEFAULT NULL,
  p_device_timezone TEXT DEFAULT NULL,
  p_is_mock BOOLEAN DEFAULT false,
  p_device_id TEXT DEFAULT NULL,
  p_platform TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_client_ip TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_corr RECORD;
  v_win RECORD;
  v_event TEXT := lower(trim(COALESCE(p_event, '')));
  v_zone public.office_locations%ROWTYPE;
  v_dist DOUBLE PRECISION;
  v_eff_radius DOUBLE PRECISION;
  v_gps_ok BOOLEAN := false;
  v_wifi_ok BOOLEAN := false;
  v_wifi_ssid_only BOOLEAN := false;
  v_laptop_ok BOOLEAN := false;
  v_present BOOLEAN := false;
  v_left BOOLEAN := false;
  v_method TEXT;
  v_source TEXT;
  v_action TEXT := 'none';
  v_reason TEXT;
  v_rec public.attendance_records%ROWTYPE;
  v_visit public.attendance_visit_segments%ROWTYPE;
  v_has_visit BOOLEAN := false;
  v_att_date DATE;
  v_seg_mins INTEGER;
  v_total INTEGER;
  v_dup BOOLEAN := false;
  v_other_present BOOLEAN := false;
  v_work_mode TEXT;
  v_phone_on BOOLEAN;
  v_laptop_on BOOLEAN;
  v_stop BOOLEAN := false;
  v_log_id UUID;
BEGIN
  IF p_token_hash IS NULL OR btrim(p_token_hash) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_token', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_dev
  FROM public.attendance_devices d
  WHERE d.token_hash = p_token_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token', 'stop_tracking', true);
  END IF;

  IF v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'revoked_token', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_dev.user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_gone', 'stop_tracking', true);
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = v_dev.company_id;

  -- Skew correction
  SELECT * INTO v_corr
  FROM public.attendance_correct_occurred_at(p_occurred_at_utc_ms, p_device_now_utc_ms, v_now)
  LIMIT 1;

  UPDATE public.attendance_devices SET
    last_seen_at = v_now,
    last_clock_skew_ms = v_corr.skew_ms,
    device_timezone = COALESCE(NULLIF(btrim(p_device_timezone), ''), device_timezone),
    app_version = COALESCE(NULLIF(btrim(p_app_version), ''), app_version),
    last_heartbeat_at = CASE
      WHEN v_event IN ('heartbeat', 'ping', 'enter', 'wifi_connected', 'power_on') THEN v_now
      ELSE last_heartbeat_at
    END
  WHERE id = v_dev.id;

  IF v_event NOT IN (
    'enter', 'exit', 'ping', 'wifi_connected', 'wifi_disconnected',
    'heartbeat', 'power_on', 'power_off'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_event');
  END IF;

  -- Feature gates
  v_work_mode := COALESCE(v_user.work_mode, 'office');
  v_phone_on := COALESCE(v_company.auto_phone_attendance, false)
            AND COALESCE(v_user.auto_phone_attendance, false);
  v_laptop_on := COALESCE(v_company.auto_laptop_attendance, false)
             AND COALESCE(v_user.auto_laptop_attendance, false);

  IF v_dev.platform IN ('android', 'ios') AND NOT v_phone_on THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'feature_off', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_off', 'stop_tracking', true);
  END IF;

  IF v_dev.platform IN ('windows', 'linux') AND NOT v_laptop_on THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'feature_off', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'feature_off', 'stop_tracking', true);
  END IF;

  IF v_work_mode = 'remote' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_mode_remote', 'stop_tracking', true);
  END IF;

  -- Mock location
  IF COALESCE(p_is_mock, false) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, zone_id, latitude, longitude, accuracy_m, occurred_at, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'mock_location', p_client_ip,
      v_corr.skew_ms, true, p_zone_id, p_latitude, p_longitude, p_accuracy_m, v_corr.occurred_at,
      jsonb_build_object('flag', 'mock_location')
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'mock_location', 'flagged', true);
  END IF;

  -- Window (server time for "now" gating; event time for acceptance)
  SELECT * INTO v_win FROM public.attendance_window_for_user(v_dev.user_id, v_corr.occurred_at) LIMIT 1;

  IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'outside_window', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'outside_window',
      'stop_tracking', true,
      'window_start_utc', v_win.window_start_utc,
      'window_end_utc', v_win.window_end_utc,
      'server_now_utc', v_now
    );
  END IF;

  -- Late queued events: corrected time inside W and not > 15 min older than server now
  IF v_corr.occurred_at < v_now - INTERVAL '15 minutes' THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      skew_ms, clock_flagged, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'event_too_old', p_client_ip,
      v_corr.skew_ms, v_corr.clock_flagged, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'event_too_old');
  END IF;

  v_att_date := v_win.attendance_date;

  -- Zone
  IF p_zone_id IS NOT NULL THEN
    SELECT * INTO v_zone FROM public.office_locations
    WHERE id = p_zone_id
      AND (company_id IS NULL OR company_id = v_dev.company_id)
      AND COALESCE(active, true);
  END IF;

  IF v_zone.id IS NULL THEN
    SELECT o.* INTO v_zone
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = v_dev.user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
    ORDER BY ews.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_zone.id IS NULL THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip, occurred_at
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'no_zone', p_client_ip, v_corr.occurred_at
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'no_zone', 'stop_tracking', true);
  END IF;

  -- GPS presence
  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL
     AND v_zone.latitude IS NOT NULL AND v_zone.longitude IS NOT NULL THEN
    v_dist := public.haversine_meters(p_latitude, p_longitude, v_zone.latitude, v_zone.longitude);
    v_eff_radius := COALESCE(v_zone.radius_meters, 150)::DOUBLE PRECISION
      + LEAST(COALESCE(p_accuracy_m, 0), 100);
    v_gps_ok := v_dist <= v_eff_radius;
  END IF;

  -- Wi-Fi presence: public IP required; BSSID if configured; SSID alone never enough
  IF cardinality(COALESCE(v_zone.public_ip_cidrs, '{}')) > 0
     AND public.attendance_ip_in_cidrs(p_client_ip, v_zone.public_ip_cidrs) THEN
    IF cardinality(COALESCE(v_zone.wifi_bssids, '{}')) > 0 THEN
      v_wifi_ok := (
        p_bssid IS NOT NULL
        AND lower(btrim(p_bssid)) = ANY (v_zone.wifi_bssids)
      );
    ELSIF cardinality(COALESCE(v_zone.wifi_ssids, '{}')) > 0 THEN
      -- SSID configured without BSSID: still require IP (already true) + SSID match
      v_wifi_ok := (
        p_ssid IS NOT NULL
        AND btrim(p_ssid) = ANY (v_zone.wifi_ssids)
      );
    ELSE
      -- IP allowlist only
      v_wifi_ok := true;
    END IF;
  ELSIF p_ssid IS NOT NULL
        AND cardinality(COALESCE(v_zone.wifi_ssids, '{}')) > 0
        AND btrim(p_ssid) = ANY (v_zone.wifi_ssids)
        AND NOT public.attendance_ip_in_cidrs(p_client_ip, COALESCE(v_zone.public_ip_cidrs, '{}')) THEN
    v_wifi_ssid_only := true;
  END IF;

  -- Laptop present = power_on / heartbeat while on office network (wifi or IP)
  IF v_dev.platform IN ('windows', 'linux') THEN
    v_laptop_ok := v_wifi_ok AND v_event IN ('power_on', 'heartbeat', 'ping', 'wifi_connected');
  END IF;

  -- Detection mode
  IF v_zone.detection_mode = 'gps_only' THEN
    v_present := v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat');
    v_left := (NOT v_gps_ok) AND v_event IN ('exit', 'ping');
  ELSIF v_zone.detection_mode = 'wifi_only' THEN
    v_present := v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter');
    v_left := (NOT v_wifi_ok) AND v_event IN ('wifi_disconnected', 'power_off', 'exit');
  ELSE
    -- gps_or_wifi
    v_present := (
      (v_gps_ok AND v_event IN ('enter', 'ping', 'heartbeat'))
      OR (v_wifi_ok AND v_event IN ('wifi_connected', 'ping', 'heartbeat', 'power_on', 'enter'))
      OR (v_laptop_ok)
    );
    v_left := (
      v_event IN ('exit', 'wifi_disconnected', 'power_off')
      OR ((NOT v_gps_ok) AND (NOT v_wifi_ok) AND v_event = 'ping')
    );
  END IF;

  IF v_event = 'power_off' THEN
    v_left := true;
    v_present := false;
  END IF;

  IF v_wifi_ssid_only THEN
    INSERT INTO public.attendance_events_log (
      company_id, user_id, device_id, event, accepted, reason_code, client_ip,
      ssid, bssid, skew_ms, clock_flagged, zone_id, occurred_at, payload
    ) VALUES (
      v_dev.company_id, v_dev.user_id, v_dev.id, v_event, false, 'fake_hotspot_suspected', p_client_ip,
      p_ssid, p_bssid, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, v_corr.occurred_at,
      jsonb_build_object('flag', 'ssid_matched_ip_or_bssid_failed')
    );
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_network', 'flagged', true, 'flag', 'fake_hotspot_suspected');
  END IF;

  IF v_gps_ok THEN v_method := 'gps';
  ELSIF v_wifi_ok AND v_dev.platform IN ('windows', 'linux') THEN v_method := 'laptop';
  ELSIF v_wifi_ok THEN v_method := 'wifi';
  ELSE v_method := NULL;
  END IF;

  v_source := CASE v_method
    WHEN 'gps' THEN 'auto_gps'
    WHEN 'wifi' THEN 'auto_wifi'
    WHEN 'laptop' THEN 'auto_laptop'
    ELSE 'auto_gps'
  END;

  -- Duplicate ignore same user/zone within 5 min
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_events_log e
    WHERE e.user_id = v_dev.user_id
      AND e.zone_id IS NOT DISTINCT FROM v_zone.id
      AND e.event = v_event
      AND e.accepted = true
      AND e.created_at > v_now - INTERVAL '5 minutes'
  ) INTO v_dup;

  IF v_dup AND v_event NOT IN ('heartbeat') THEN
    RETURN jsonb_build_object('ok', true, 'action', 'duplicate_ignored', 'reason', 'duplicate_within_5m');
  END IF;

  -- Update this device presence
  IF v_present THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_zone_id = v_zone.id,
      last_matched_method = v_method,
      last_heartbeat_at = v_now
    WHERE id = v_dev.id;
  ELSIF v_left OR v_event IN ('exit', 'wifi_disconnected', 'power_off') THEN
    UPDATE public.attendance_devices SET
      presence_state = 'left',
      last_zone_id = v_zone.id
    WHERE id = v_dev.id;
  ELSIF v_event = 'heartbeat' AND v_wifi_ok THEN
    UPDATE public.attendance_devices SET
      presence_state = 'present',
      last_presence_at = v_corr.occurred_at,
      last_heartbeat_at = v_now,
      last_matched_method = COALESCE(v_method, last_matched_method)
    WHERE id = v_dev.id;
    v_present := true;
  END IF;

  -- Load open record
  SELECT * INTO v_rec
  FROM public.attendance_records
  WHERE user_id = v_dev.user_id
    AND attendance_date = v_att_date
  LIMIT 1;

  SELECT * INTO v_visit
  FROM public.attendance_visit_segments vs
  WHERE vs.user_id = v_dev.user_id
    AND vs.attendance_date = v_att_date
    AND vs.clock_out_at IS NULL
  ORDER BY vs.clock_in_at DESC
  LIMIT 1;
  v_has_visit := FOUND;

  --------------------------------------------------------------------------
  -- PRESENT → check-in / new visit
  --------------------------------------------------------------------------
  IF v_present THEN
    IF v_rec.id IS NOT NULL AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL AND v_has_visit THEN
      v_action := 'already_checked_in';
    ELSE
      INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
        reviewed_by, reviewed_at, presence_method
      ) VALUES (
        v_dev.user_id, v_att_date, 'present', 'approved', v_dev.user_id,
        v_corr.occurred_at, p_latitude, p_longitude, v_source, v_win.shift_id,
        'Auto check-in (' || COALESCE(v_method, 'auto') || ') at ' || COALESCE(v_zone.name, 'office'),
        v_dev.user_id, v_now, v_method
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
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id),
        notes = CASE
          WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
          THEN EXCLUDED.notes ELSE public.attendance_records.notes
        END
      RETURNING * INTO v_rec;

      PERFORM public.attendance_ensure_open_visit(
        v_dev.user_id, v_rec.id, v_att_date, v_corr.occurred_at,
        'Auto entry ' || COALESCE(v_method, '')
      );
      UPDATE public.attendance_visit_segments SET
        clock_in_lat = COALESCE(clock_in_lat, p_latitude),
        clock_in_lng = COALESCE(clock_in_lng, p_longitude),
        site_name = COALESCE(site_name, v_zone.name)
      WHERE user_id = v_dev.user_id
        AND attendance_date = v_att_date
        AND clock_out_at IS NULL;
      v_action := 'clock_in';
    END IF;

  --------------------------------------------------------------------------
  -- LEFT → check-out only if ALL enrolled devices report left (R54)
  -- Immediate for power_off; Wi-Fi/GPS leave uses 15-min rule via cron (R69)
  --------------------------------------------------------------------------
  ELSIF v_left AND v_event = 'power_off' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_dev.user_id
        AND d.revoked_at IS NULL
        AND d.id <> v_dev.id
        AND d.presence_state = 'present'
        AND d.last_presence_at > v_now - INTERVAL '15 minutes'
    ) INTO v_other_present;

    IF NOT v_other_present
       AND v_rec.id IS NOT NULL
       AND v_rec.clock_in_at IS NOT NULL
       AND v_rec.clock_out_at IS NULL THEN
      IF v_has_visit THEN
        v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_corr.occurred_at - v_visit.clock_in_at))::INTEGER / 60);
        UPDATE public.attendance_visit_segments SET
          clock_out_at = v_corr.occurred_at,
          work_minutes = v_seg_mins,
          notes = COALESCE(notes, '') || ' | Auto laptop power-off'
        WHERE id = v_visit.id;
      END IF;
      v_total := public.attendance_day_total_minutes(v_dev.user_id, v_att_date, v_corr.occurred_at);
      UPDATE public.attendance_records SET
        clock_out_at = v_corr.occurred_at,
        work_minutes = v_total,
        notes = COALESCE(notes, '') || ' | Auto laptop power-off'
      WHERE id = v_rec.id;
      v_action := 'clock_out';
    ELSE
      v_action := CASE WHEN v_other_present THEN 'device_left_others_present' ELSE 'no_open_visit' END;
    END IF;

  ELSIF v_left AND v_event IN ('exit', 'wifi_disconnected') THEN
    -- Mark left; actual checkout deferred to cron after 15 min no presence (R69)
    v_action := 'presence_left_pending';
  END IF;

  INSERT INTO public.attendance_events_log (
    company_id, user_id, device_id, event, accepted, reason_code, client_ip,
    matched_method, skew_ms, clock_flagged, zone_id, latitude, longitude, accuracy_m,
    ssid, bssid, occurred_at, payload
  ) VALUES (
    v_dev.company_id, v_dev.user_id, v_dev.id, v_event, true, v_action, p_client_ip,
    v_method, v_corr.skew_ms, v_corr.clock_flagged, v_zone.id, p_latitude, p_longitude, p_accuracy_m,
    p_ssid, p_bssid, v_corr.occurred_at,
    jsonb_build_object(
      'app_version', p_app_version,
      'platform', p_platform,
      'clock_flagged', v_corr.clock_flagged
    )
  ) RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'matched_method', v_method,
    'attendance_date', v_att_date,
    'occurred_at', v_corr.occurred_at,
    'skew_ms', v_corr.skew_ms,
    'clock_flagged', v_corr.clock_flagged,
    'window_start_utc', v_win.window_start_utc,
    'window_end_utc', v_win.window_end_utc,
    'server_now_utc', v_now,
    'stop_tracking', false,
    'event_log_id', v_log_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_hash_device_token(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(
  TEXT, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  TEXT, TEXT, BIGINT, BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_auto_rpc.sql

-- >>> BEGIN attendance_register_device_rpc.sql
-- attendance_register_device_rpc.sql
-- R29 / E: register device (JWT once) → store token hash; revoke helpers

CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id TEXT,
  p_platform TEXT,
  p_device_timezone TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_token_plaintext TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_token TEXT;
  v_hash TEXT;
  v_row public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_device_id IS NULL OR btrim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id required';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('android', 'ios', 'windows', 'linux', 'web') THEN
    RAISE EXCEPTION 'Invalid platform';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_token := COALESCE(
    NULLIF(btrim(p_token_plaintext), ''),
    encode(extensions.gen_random_bytes(32), 'hex')
  );
  v_hash := public.attendance_hash_device_token(v_token);

  -- Revoke prior row for same device_id
  UPDATE public.attendance_devices
  SET revoked_at = timezone('utc', now())
  WHERE user_id = v_uid AND device_id = btrim(p_device_id) AND revoked_at IS NULL;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, device_timezone, app_version, token_hash,
    created_at, last_seen_at
  ) VALUES (
    v_uid, v_me.company_id, btrim(p_device_id), p_platform,
    NULLIF(btrim(p_device_timezone), ''), NULLIF(btrim(p_app_version), ''),
    v_hash, timezone('utc', now()), timezone('utc', now())
  )
  RETURNING * INTO v_row;

  -- Enable per-user toggle for this platform family when registering
  IF p_platform IN ('android', 'ios') THEN
    UPDATE public.users SET auto_phone_attendance = true WHERE id = v_uid;
  ELSIF p_platform IN ('windows', 'linux') THEN
    UPDATE public.users SET auto_laptop_attendance = true WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'device_row_id', v_row.id,
    'device_token', v_token,
    'platform', p_platform
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_attendance_device(p_device_row_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_dev public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  SELECT * INTO v_dev FROM public.attendance_devices WHERE id = p_device_row_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Device not found'; END IF;

  IF v_dev.user_id <> v_uid AND NOT (v_me.role IN ('admin', 'hr') AND v_me.company_id = v_dev.company_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.attendance_devices SET revoked_at = timezone('utc', now()) WHERE id = p_device_row_id;

  RETURN jsonb_build_object('ok', true, 'revoked', p_device_row_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_my_auto_attendance(p_kind TEXT DEFAULT 'phone')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_kind = 'laptop' THEN
    UPDATE public.users SET auto_laptop_attendance = false WHERE id = v_uid;
    UPDATE public.attendance_devices SET revoked_at = timezone('utc', now())
    WHERE user_id = v_uid AND platform IN ('windows', 'linux') AND revoked_at IS NULL;
  ELSE
    UPDATE public.users SET auto_phone_attendance = false WHERE id = v_uid;
    UPDATE public.attendance_devices SET revoked_at = timezone('utc', now())
    WHERE user_id = v_uid AND platform IN ('android', 'ios') AND revoked_at IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_company_attendance_devices()
RETURNS SETOF public.attendance_devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
    SELECT d.* FROM public.attendance_devices d
    WHERE d.company_id = v_me.company_id
    ORDER BY d.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unenrolled_auto_attendance_users()
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role public.user_role,
  work_mode TEXT,
  phone_enabled BOOLEAN,
  laptop_enabled BOOLEAN,
  has_phone_device BOOLEAN,
  has_laptop_device BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.full_name,
    u.email,
    u.role,
    COALESCE(u.work_mode, 'office'),
    COALESCE(u.auto_phone_attendance, false),
    COALESCE(u.auto_laptop_attendance, false),
    EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
    ),
    EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
    )
  FROM public.users u
  WHERE u.company_id = v_me.company_id
    AND u.role IN ('employee', 'manager', 'hr')
    AND COALESCE(u.work_mode, 'office') IN ('office', 'hybrid')
    AND (
      (COALESCE(u.auto_phone_attendance, false) AND NOT EXISTS (
        SELECT 1 FROM public.attendance_devices d
        WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
      ))
      OR (COALESCE(u.auto_laptop_attendance, false) AND NOT EXISTS (
        SELECT 1 FROM public.attendance_devices d
        WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
      ))
      OR (
        NOT COALESCE(u.auto_phone_attendance, false)
        AND NOT COALESCE(u.auto_laptop_attendance, false)
      )
    )
  ORDER BY u.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_attendance_device(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_attendance_device(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.disable_my_auto_attendance(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_company_attendance_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_unenrolled_auto_attendance_users() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_register_device_rpc.sql

-- >>> BEGIN fix_pgcrypto_extensions_search_path_2026-10-07.sql
-- Hotfix: pgcrypto lives in schema `extensions` on Supabase.
-- SECURITY DEFINER functions with SET search_path = public cannot resolve
-- gen_random_bytes / digest / crypt / gen_salt unless extensions is on the path
-- or calls are schema-qualified.
--
-- Symptom: Android "Register this phone" → function gen_random_bytes(integer) does not exist

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Token hash helper (called from register_attendance_device + edge hashing paths)
CREATE OR REPLACE FUNCTION public.attendance_hash_device_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;

-- Device enrollment (app calls via supabase.rpc('register_attendance_device', ...))
CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id TEXT,
  p_platform TEXT,
  p_device_timezone TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_token_plaintext TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_token TEXT;
  v_hash TEXT;
  v_row public.attendance_devices%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_device_id IS NULL OR btrim(p_device_id) = '' THEN
    RAISE EXCEPTION 'device_id required';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('android', 'ios', 'windows', 'linux', 'web') THEN
    RAISE EXCEPTION 'Invalid platform';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  v_token := COALESCE(
    NULLIF(btrim(p_token_plaintext), ''),
    encode(extensions.gen_random_bytes(32), 'hex')
  );
  v_hash := public.attendance_hash_device_token(v_token);

  -- Revoke prior row for same device_id
  UPDATE public.attendance_devices
  SET revoked_at = timezone('utc', now())
  WHERE user_id = v_uid AND device_id = btrim(p_device_id) AND revoked_at IS NULL;

  INSERT INTO public.attendance_devices (
    user_id, company_id, device_id, platform, device_timezone, app_version, token_hash,
    created_at, last_seen_at
  ) VALUES (
    v_uid, v_me.company_id, btrim(p_device_id), p_platform,
    NULLIF(btrim(p_device_timezone), ''), NULLIF(btrim(p_app_version), ''),
    v_hash, timezone('utc', now()), timezone('utc', now())
  )
  RETURNING * INTO v_row;

  -- Enable per-user toggle for this platform family when registering
  IF p_platform IN ('android', 'ios') THEN
    UPDATE public.users SET auto_phone_attendance = true WHERE id = v_uid;
  ELSIF p_platform IN ('windows', 'linux') THEN
    UPDATE public.users SET auto_laptop_attendance = true WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'device_row_id', v_row.id,
    'device_token', v_token,
    'platform', p_platform
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_attendance_device(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_hash_device_token(TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- <<< END fix_pgcrypto_extensions_search_path_2026-10-07.sql

-- >>> BEGIN attendance_correction_rpc.sql
-- attendance_correction_rpc.sql
-- R15 / R11: Admin/HR clock-time correction (reason required) + supervisor day-status audit helper

CREATE OR REPLACE FUNCTION public.correct_attendance_times(
  p_attendance_record_id UUID,
  p_clock_in_at TIMESTAMPTZ DEFAULT NULL,
  p_clock_out_at TIMESTAMPTZ DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_clear_clock_out BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_me public.users%ROWTYPE;
  v_rec public.attendance_records%ROWTYPE;
  v_target public.users%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Attendance correction requires a written reason';
  END IF;

  SELECT * INTO v_me FROM public.users WHERE id = v_actor;
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Only Admin/HR can correct attendance times';
  END IF;

  SELECT * INTO v_rec FROM public.attendance_records WHERE id = p_attendance_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance record not found'; END IF;

  SELECT * INTO v_target FROM public.users WHERE id = v_rec.user_id;
  IF v_target.company_id IS DISTINCT FROM v_me.company_id THEN
    RAISE EXCEPTION 'Not authorized for this company';
  END IF;

  v_before := jsonb_build_object(
    'clock_in_at', v_rec.clock_in_at,
    'clock_out_at', v_rec.clock_out_at,
    'status', v_rec.status,
    'attendance_source', v_rec.attendance_source,
    'work_minutes', v_rec.work_minutes
  );

  PERFORM public.attendance_set_write_context('admin_correction');

  UPDATE public.attendance_records SET
    clock_in_at = COALESCE(p_clock_in_at, clock_in_at),
    clock_out_at = CASE
      WHEN p_clear_clock_out THEN NULL
      ELSE COALESCE(p_clock_out_at, clock_out_at)
    END,
    attendance_source = 'admin_correction',
    notes = COALESCE(notes, '') || ' | Correction: ' || btrim(p_reason),
    work_minutes = CASE
      WHEN COALESCE(p_clock_in_at, clock_in_at) IS NOT NULL
           AND CASE WHEN p_clear_clock_out THEN NULL ELSE COALESCE(p_clock_out_at, clock_out_at) END IS NOT NULL
      THEN GREATEST(
        0,
        (EXTRACT(EPOCH FROM (
          CASE WHEN p_clear_clock_out THEN NULL ELSE COALESCE(p_clock_out_at, clock_out_at) END
          - COALESCE(p_clock_in_at, clock_in_at)
        )) / 60)::INTEGER
      )
      ELSE work_minutes
    END
  WHERE id = v_rec.id
  RETURNING * INTO v_rec;

  -- Align open/closed visit segment loosely
  IF v_rec.clock_out_at IS NULL AND v_rec.clock_in_at IS NOT NULL THEN
    PERFORM public.attendance_ensure_open_visit(
      v_rec.user_id, v_rec.id, v_rec.attendance_date, v_rec.clock_in_at, 'Admin correction'
    );
  ELSIF v_rec.clock_out_at IS NOT NULL AND v_rec.clock_in_at IS NOT NULL THEN
    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_rec.clock_out_at,
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_rec.clock_out_at - clock_in_at)) / 60)::INTEGER)
    WHERE attendance_record_id = v_rec.id AND clock_out_at IS NULL;
  END IF;

  PERFORM public.attendance_set_write_context('normal');

  v_after := jsonb_build_object(
    'clock_in_at', v_rec.clock_in_at,
    'clock_out_at', v_rec.clock_out_at,
    'status', v_rec.status,
    'attendance_source', v_rec.attendance_source,
    'work_minutes', v_rec.work_minutes
  );

  INSERT INTO public.attendance_corrections_audit (
    company_id, attendance_record_id, target_user_id, actor_user_id,
    reason, before, after, kind
  ) VALUES (
    v_me.company_id, v_rec.id, v_rec.user_id, v_actor,
    btrim(p_reason), v_before, v_after, 'admin_correction'
  );

  RETURN jsonb_build_object('ok', true, 'record_id', v_rec.id, 'before', v_before, 'after', v_after);
END;
$$;

GRANT EXECUTE ON FUNCTION public.correct_attendance_times(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_correction_rpc.sql

-- >>> BEGIN attendance_schedule_rpc.sql
-- attendance_schedule_rpc.sql
-- R34 / R26: next 7 days of windows for a device token (+ JWT helper for dashboard)

CREATE OR REPLACE FUNCTION public.attendance_schedule_for_user(
  p_user_id UUID,
  p_from TIMESTAMPTZ DEFAULT timezone('utc', now()),
  p_days INTEGER DEFAULT 7
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_server_now TIMESTAMPTZ := timezone('utc', now());
  v_days JSONB := '[]'::JSONB;
  v_i INTEGER;
  v_at TIMESTAMPTZ;
  v_win RECORD;
  v_zone JSONB;
  v_user public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(z), '[]'::JSONB) INTO v_zone
  FROM (
    SELECT jsonb_build_object(
      'zone_id', o.id,
      'name', o.name,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'radius_meters', o.radius_meters,
      'detection_mode', o.detection_mode,
      'wifi_ssids', o.wifi_ssids,
      'wifi_bssids', o.wifi_bssids
      -- public IPs intentionally omitted from device schedule (server-only)
    ) AS z
    FROM public.office_locations o
    JOIN public.employee_work_sites ews ON ews.office_location_id = o.id
    WHERE ews.user_id = p_user_id
      AND COALESCE(ews.tracking_enabled, true)
      AND COALESCE(o.active, true)
  ) q;

  FOR v_i IN 0..GREATEST(COALESCE(p_days, 7) - 1, 0) LOOP
    -- Probe midday UTC+offset samples; prefer shift TZ by walking hours
    v_at := p_from + (v_i || ' days')::INTERVAL;
    -- Try several offsets within the day so overnight windows are found
    SELECT * INTO v_win
    FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '12 hours')
    LIMIT 1;

    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '20 hours')
      LIMIT 1;
    END IF;
    IF NOT COALESCE(v_win.has_shift, false) THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(p_user_id, v_at + INTERVAL '4 hours')
      LIMIT 1;
    END IF;

    IF COALESCE(v_win.has_shift, false) AND v_win.window_start_utc IS NOT NULL THEN
      -- Dedupe by attendance_date
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_days) e
        WHERE (e->>'attendance_date') = v_win.attendance_date::TEXT
      ) THEN
        v_days := v_days || jsonb_build_array(jsonb_build_object(
          'attendance_date', v_win.attendance_date,
          'shift_id', v_win.shift_id,
          'shift_name', v_win.shift_name,
          'shift_tz', v_win.shift_tz,
          'start_time', v_win.start_time,
          'end_time', v_win.end_time,
          'crosses_midnight', v_win.crosses_midnight,
          'shift_start_utc', v_win.shift_start_utc,
          'shift_end_utc', v_win.shift_end_utc,
          'window_start_utc', v_win.window_start_utc,
          'window_end_utc', v_win.window_end_utc
        ));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'server_now_utc', v_server_now,
    'company_tz', public.company_timezone(v_user.company_id),
    'windows', v_days,
    'zones', COALESCE(v_zone, '[]'::JSONB)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_schedule_by_token(
  p_token_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dev public.attendance_devices%ROWTYPE;
BEGIN
  SELECT * INTO v_dev FROM public.attendance_devices WHERE token_hash = p_token_hash LIMIT 1;
  IF NOT FOUND OR v_dev.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_or_revoked_token', 'stop_tracking', true);
  END IF;

  UPDATE public.attendance_devices SET last_seen_at = timezone('utc', now()) WHERE id = v_dev.id;

  RETURN public.attendance_schedule_for_user(v_dev.user_id, timezone('utc', now()), 7)
    || jsonb_build_object('user_id', v_dev.user_id, 'device_row_id', v_dev.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_attendance_schedule()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN public.attendance_schedule_for_user(auth.uid(), timezone('utc', now()), 7);
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_schedule_for_user(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_by_token(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_schedule() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_schedule_rpc.sql

-- >>> BEGIN attendance_cron.sql
-- attendance_cron.sql
-- R56 / R9 / R51 / R69: close ended windows, laptop heartbeat gaps, Wi-Fi/GPS 15m absence
-- N3: delete location pings older than 90 days

CREATE OR REPLACE FUNCTION public.attendance_close_ended_windows()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_close_at TIMESTAMPTZ;
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.status = 'present'
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;

    -- Also try close using the record's attendance_date mid-shift probe
    IF v_win.window_end_utc IS NULL OR COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date THEN
      SELECT * INTO v_win
      FROM public.attendance_window_for_user(
        r.user_id,
        (r.attendance_date + TIME '12:00') AT TIME ZONE COALESCE(
          (SELECT timezone FROM public.work_shifts WHERE id = r.shift_id),
          public.company_timezone((SELECT company_id FROM public.users WHERE id = r.user_id))
        )
      )
      LIMIT 1;
    END IF;

    IF v_win.window_end_utc IS NOT NULL AND v_now > v_win.window_end_utc THEN
      SELECT COALESCE(MAX(d.last_presence_at), MAX(vs.clock_in_at), r.clock_in_at)
      INTO v_last
      FROM public.attendance_visit_segments vs
      FULL OUTER JOIN public.attendance_devices d ON d.user_id = r.user_id AND d.revoked_at IS NULL
      WHERE vs.user_id = r.user_id AND vs.attendance_date = r.attendance_date AND vs.clock_out_at IS NULL;

      v_close_at := LEAST(COALESCE(v_last, v_win.window_end_utc), v_win.window_end_utc);

      UPDATE public.attendance_visit_segments SET
        clock_out_at = v_close_at,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_close_at - clock_in_at)) / 60)::INTEGER),
        notes = COALESCE(notes, '') || ' | Auto close at window end'
      WHERE user_id = r.user_id
        AND attendance_date = r.attendance_date
        AND clock_out_at IS NULL;

      v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_close_at);

      UPDATE public.attendance_records SET
        clock_out_at = v_close_at,
        work_minutes = v_mins,
        notes = COALESCE(notes, '') || ' | Auto close at window end'
      WHERE id = r.id;

      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_close_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_win RECORD;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_last TIMESTAMPTZ;
  v_n INTEGER := 0;
  v_mins INTEGER;
  v_any_present BOOLEAN;
BEGIN
  FOR r IN
    SELECT ar.*
    FROM public.attendance_records ar
    WHERE ar.clock_in_at IS NOT NULL
      AND ar.clock_out_at IS NULL
      AND ar.attendance_source IN ('auto_gps', 'auto_wifi', 'auto_laptop', 'geo')
  LOOP
    SELECT * INTO v_win FROM public.attendance_window_for_user(r.user_id, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.in_window, false) THEN
      CONTINUE; -- ended-window job handles W end
    END IF;

    -- Any enrolled device still present within 15 min?
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = r.user_id
        AND d.revoked_at IS NULL
        AND d.presence_state = 'present'
        AND (
          (d.platform IN ('windows', 'linux') AND d.last_heartbeat_at > v_now - INTERVAL '15 minutes')
          OR (d.platform IN ('android', 'ios') AND d.last_presence_at > v_now - INTERVAL '15 minutes')
        )
    ) INTO v_any_present;

    IF v_any_present THEN
      CONTINUE;
    END IF;

    SELECT GREATEST(
      COALESCE((
        SELECT MAX(d.last_presence_at) FROM public.attendance_devices d
        WHERE d.user_id = r.user_id AND d.revoked_at IS NULL
      ), r.clock_in_at),
      COALESCE((
        SELECT MAX(d.last_heartbeat_at) FROM public.attendance_devices d
        WHERE d.user_id = r.user_id AND d.revoked_at IS NULL AND d.platform IN ('windows', 'linux')
      ), r.clock_in_at)
    ) INTO v_last;

    IF v_last IS NULL OR v_last > v_now - INTERVAL '15 minutes' THEN
      CONTINUE;
    END IF;

    -- Cap inside window
    v_last := LEAST(v_last, COALESCE(v_win.window_end_utc, v_last));

    UPDATE public.attendance_visit_segments SET
      clock_out_at = v_last,
      work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_last - clock_in_at)) / 60)::INTEGER),
      notes = COALESCE(notes, '') || ' | Auto close: 15m no presence'
    WHERE user_id = r.user_id
      AND attendance_date = r.attendance_date
      AND clock_out_at IS NULL;

    v_mins := public.attendance_day_total_minutes(r.user_id, r.attendance_date, v_last);

    UPDATE public.attendance_records SET
      clock_out_at = v_last,
      work_minutes = v_mins,
      notes = COALESCE(notes, '') || ' | Auto close: 15m no presence'
    WHERE id = r.id;

    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_cron_tick()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ended INTEGER;
  v_stale INTEGER;
  v_pings INTEGER;
BEGIN
  v_ended := public.attendance_close_ended_windows();
  v_stale := public.attendance_close_stale_presence();

  DELETE FROM public.employee_location_pings
  WHERE recorded_at < timezone('utc', now()) - INTERVAL '90 days';
  GET DIAGNOSTICS v_pings = ROW_COUNT;

  RETURN jsonb_build_object(
    'closed_ended', v_ended,
    'closed_stale', v_stale,
    'pings_deleted', v_pings,
    'ran_at', timezone('utc', now())
  );
END;
$$;

-- Align/replace scorr-close-ended-shifts cron if pg_cron available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('scorr-close-ended-shifts', 'scorr-attendance-cron');

    PERFORM cron.schedule(
      'scorr-attendance-cron',
      '*/5 * * * *',
      $cron$SELECT public.attendance_cron_tick();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_close_ended_windows() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_close_stale_presence() TO service_role;
GRANT EXECUTE ON FUNCTION public.attendance_cron_tick() TO service_role;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_cron.sql

-- >>> BEGIN attendance_writers_window.sql
-- attendance_writers_window.sql
-- R2 / R11 / R18 / N2: route all attendance writers through attendance_window_for_user.
-- Old JWT geo path kept working but enforces W + server time immediately.

-- R40: GPS exit needs 2 consecutive outside OR 50m beyond radius
CREATE OR REPLACE FUNCTION public.geo_confirm_left_site(
    p_distance DOUBLE PRECISION,
    p_effective_radius DOUBLE PRECISION,
    p_prev_inside BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_distance IS NULL OR p_effective_radius IS NULL THEN
        RETURN FALSE;
    END IF;
    IF p_distance <= p_effective_radius THEN
        RETURN FALSE;
    END IF;
    -- 50 m buffer beyond effective radius
    IF p_distance >= (p_effective_radius + 50) THEN
        RETURN TRUE;
    END IF;
    -- 2 consecutive outside readings
    RETURN p_prev_inside IS FALSE;
END;
$$;

-- resolve_shift_attendance_date → shared window (no hardcoded Karachi for window math)
CREATE OR REPLACE FUNCTION public.resolve_shift_attendance_date(
  p_user_id UUID,
  p_at TIMESTAMPTZ DEFAULT timezone('utc', now())
) RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_win RECORD;
BEGIN
  SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, p_at) LIMIT 1;
  IF COALESCE(v_win.has_shift, false) AND v_win.attendance_date IS NOT NULL THEN
    RETURN v_win.attendance_date;
  END IF;
  -- Fallback: company TZ local date (display/legacy only)
  RETURN public.attendance_local_date(p_at, public.company_timezone(
    (SELECT company_id FROM public.users WHERE id = p_user_id)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_shift_date DATE;
    v_rec public.attendance_records%ROWTYPE;
    v_id UUID;
    v_kept INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: check-in only inside the attendance window';
    END IF;

    v_shift_date := COALESCE(p_date, v_win.attendance_date);
    IF v_shift_date IS DISTINCT FROM v_win.attendance_date THEN
        RAISE EXCEPTION 'attendance_outside_window: date does not match current shift window';
    END IF;

    PERFORM public.attendance_realign_shift_records(v_uid);

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

    IF FOUND AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
        PERFORM public.attendance_ensure_open_visit(v_uid, v_rec.id, v_shift_date, v_now, 'Check in');
        RETURN v_rec.id;
    END IF;

    IF FOUND AND v_rec.clock_out_at IS NOT NULL THEN
        PERFORM public.attendance_backfill_closed_visit(
            v_uid, v_rec.id, v_shift_date, v_rec.clock_in_at, v_rec.clock_out_at, v_rec.work_minutes
        );
        v_kept := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);
    ELSE
        v_kept := COALESCE(v_rec.work_minutes, 0);
    END IF;

    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, marked_by,
        clock_in_at, clock_out_at, work_minutes, attendance_source, reviewed_by, reviewed_at, shift_id
    )
    VALUES (
        v_uid, v_shift_date, 'present', 'approved'::public.approval_status, v_uid,
        v_now, NULL, NULLIF(v_kept, 0), 'manual', v_uid, v_now, v_win.shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        approval_status = 'approved'::public.approval_status,
        marked_by = v_uid,
        reviewed_by = COALESCE(public.attendance_records.reviewed_by, v_uid),
        reviewed_at = COALESCE(public.attendance_records.reviewed_at, v_now),
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        clock_out_at = NULL,
        clock_out_lat = NULL,
        clock_out_lng = NULL,
        work_minutes = COALESCE(
            NULLIF(EXCLUDED.work_minutes, 0),
            NULLIF(public.attendance_records.work_minutes, 0)
        ),
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual'),
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, v_shift_date, v_now, 'Check in');

    UPDATE public.attendance_records
    SET work_minutes = NULLIF(public.attendance_day_total_minutes(v_uid, v_shift_date, v_now), 0)
    WHERE id = v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date DATE DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_shift_date DATE;
    v_rec public.attendance_records%ROWTYPE;
    v_total INTEGER := 0;
    v_id UUID;
    v_n INTEGER;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: check-out only inside the attendance window';
    END IF;

    v_shift_date := COALESCE(p_date, v_win.attendance_date);

    SELECT * INTO v_rec
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = v_shift_date;

    IF NOT FOUND OR v_rec.clock_in_at IS NULL THEN
        RAISE EXCEPTION 'Check in first, then you can check out';
    END IF;
    IF v_rec.status = 'absent' THEN
        RAISE EXCEPTION 'Cannot check out on an absent day';
    END IF;
    IF v_rec.clock_out_at IS NOT NULL THEN
        RAISE EXCEPTION 'Already checked out';
    END IF;

    UPDATE public.attendance_visit_segments
    SET clock_out_at = v_now,
        work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_now - clock_in_at)) / 60)::INTEGER)
    WHERE user_id = v_uid
      AND attendance_date = v_shift_date
      AND clock_out_at IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date
    ) THEN
        SELECT COALESCE(MAX(visit_number), 0) + 1 INTO v_n
        FROM public.attendance_visit_segments
        WHERE user_id = v_uid AND attendance_date = v_shift_date;
        INSERT INTO public.attendance_visit_segments (
            user_id, attendance_record_id, attendance_date, visit_number,
            clock_in_at, clock_out_at, work_minutes, notes
        ) VALUES (
            v_uid, v_rec.id, v_shift_date, GREATEST(v_n, 1),
            v_rec.clock_in_at, v_now,
            GREATEST(0, (EXTRACT(EPOCH FROM (v_now - v_rec.clock_in_at)) / 60)::INTEGER),
            'Manual check-out'
        );
    END IF;

    v_total := public.attendance_day_total_minutes(v_uid, v_shift_date, v_now);

    UPDATE public.attendance_records
    SET clock_out_at = v_now,
        work_minutes = v_total
    WHERE id = v_rec.id
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Employee hybrid remote self-mark: ONLY inside W; present = real check-in time; no synthetic clocks
CREATE OR REPLACE FUNCTION public.mark_hybrid_remote_day(
    p_date DATE DEFAULT CURRENT_DATE,
    p_status public.attendance_status DEFAULT 'present'
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_me public.users%ROWTYPE;
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_existing public.attendance_records%ROWTYPE;
    v_notes TEXT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_status NOT IN ('present', 'absent') THEN RAISE EXCEPTION 'Status must be present or absent'; END IF;

    SELECT * INTO v_me FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF COALESCE(v_me.work_mode, 'office') <> 'hybrid' THEN
        RAISE EXCEPTION 'Only hybrid workers can mark a remote day';
    END IF;
    IF v_me.role NOT IN ('employee', 'manager', 'hr') THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_uid, v_now) LIMIT 1;
    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RAISE EXCEPTION 'attendance_outside_window: remote self-mark only inside the attendance window';
    END IF;
    IF p_date IS DISTINCT FROM v_win.attendance_date THEN
        RAISE EXCEPTION 'attendance_outside_window: date must be the current shift attendance date';
    END IF;

    SELECT * INTO v_existing
    FROM public.attendance_records
    WHERE user_id = v_uid AND attendance_date = p_date;

    IF FOUND AND v_existing.attendance_source IN ('geo', 'auto_gps', 'auto_wifi', 'auto_laptop')
       AND v_existing.clock_in_at IS NOT NULL AND v_existing.clock_out_at IS NULL THEN
        RAISE EXCEPTION 'Already checked in at the office for this date';
    END IF;

    IF p_status = 'absent' THEN
        v_notes := 'Hybrid — marked absent (remote day)';
        INSERT INTO public.attendance_records (
            user_id, attendance_date, status, approval_status, notes, marked_by,
            reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
            work_minutes, shift_id
        ) VALUES (
            v_uid, p_date, 'absent', 'approved', v_notes, v_uid, v_uid, v_now,
            NULL, NULL, 'manual', NULL, v_win.shift_id
        )
        ON CONFLICT (user_id, attendance_date) DO UPDATE
        SET status = 'absent',
            clock_in_at = NULL,
            clock_out_at = NULL,
            work_minutes = NULL,
            notes = EXCLUDED.notes,
            attendance_source = 'manual',
            marked_by = v_uid,
            reviewed_by = v_uid,
            reviewed_at = v_now
        RETURNING id INTO v_id;
        RETURN v_id;
    END IF;

    -- Present = check-in at real server time (counts as check-in)
    v_notes := 'Hybrid — worked remotely';
    INSERT INTO public.attendance_records (
        user_id, attendance_date, status, approval_status, notes, marked_by,
        reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source,
        work_minutes, shift_id
    ) VALUES (
        v_uid, p_date, 'present', 'approved', v_notes, v_uid, v_uid, v_now,
        v_now, NULL, 'manual', NULL, v_win.shift_id
    )
    ON CONFLICT (user_id, attendance_date) DO UPDATE
    SET status = 'present',
        clock_in_at = COALESCE(public.attendance_records.clock_in_at, v_now),
        clock_out_at = NULL,
        notes = EXCLUDED.notes,
        attendance_source = COALESCE(public.attendance_records.attendance_source, 'manual'),
        marked_by = v_uid,
        reviewed_by = v_uid,
        reviewed_at = v_now,
        shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
    RETURNING id INTO v_id;

    PERFORM public.attendance_ensure_open_visit(v_uid, v_id, p_date, v_now, 'Hybrid remote check-in');
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Supervisor day-status mark for remote/hybrid-home: any time, NO clock times, audited
CREATE OR REPLACE FUNCTION public.mark_attendance(
    p_user_id UUID,
    p_date DATE,
    p_status public.attendance_status,
    p_notes TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_me public.users%ROWTYPE;
    v_emp public.users%ROWTYPE;
    v_allowed BOOLEAN := false;
    v_notes TEXT;
    v_before JSONB;
    v_after JSONB;
    v_existing public.attendance_records%ROWTYPE;
    v_day_status BOOLEAN := false;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_demo_isolation') THEN
        PERFORM public.enforce_demo_isolation(p_user_id);
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Use check-in for your own attendance';
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT * INTO v_emp FROM public.users WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

    IF public.is_admin(auth.uid()) THEN
        v_allowed := true;
    ELSIF public.is_manager_of(auth.uid(), p_user_id) THEN
        v_allowed := true;
    ELSIF v_me.role IN ('hr', 'admin') AND v_me.company_id IS NOT DISTINCT FROM v_emp.company_id THEN
        v_allowed := true;
    ELSIF v_me.role = 'manager'::public.user_role
          AND v_emp.role = 'employee'::public.user_role
          AND v_me.department_id IS NOT NULL
          AND v_emp.department_id = v_me.department_id
          AND (v_me.company_id IS NULL OR v_emp.company_id IS NOT DISTINCT FROM v_me.company_id) THEN
        v_allowed := true;
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    v_day_status := COALESCE(v_emp.work_mode, 'office') IN ('remote', 'hybrid');

    v_notes := COALESCE(NULLIF(trim(p_notes), ''),
        CASE
          WHEN v_emp.work_mode = 'remote' THEN 'Remote work — marked by supervisor'
          WHEN v_emp.work_mode = 'hybrid' THEN 'Hybrid home — marked by supervisor'
          ELSE 'Marked by supervisor'
        END
    );

    SELECT * INTO v_existing FROM public.attendance_records
    WHERE user_id = p_user_id AND attendance_date = p_date;

    v_before := CASE WHEN FOUND THEN to_jsonb(v_existing) ELSE '{}'::JSONB END;

    IF v_day_status THEN
      PERFORM public.attendance_set_write_context('day_status');

      INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, notes, marked_by,
          reviewed_by, reviewed_at, clock_in_at, clock_out_at, attendance_source, work_minutes
      )
      VALUES (
          p_user_id, p_date, p_status, 'approved', v_notes, auth.uid(),
          auth.uid(), v_now, NULL, NULL, 'day_status', NULL
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status,
          approval_status = 'approved',
          notes = EXCLUDED.notes,
          marked_by = auth.uid(),
          reviewed_by = auth.uid(),
          reviewed_at = v_now,
          clock_in_at = NULL,
          clock_out_at = NULL,
          work_minutes = NULL,
          attendance_source = 'day_status'
      RETURNING id INTO v_id;

      PERFORM public.attendance_set_write_context('normal');

      SELECT to_jsonb(ar) INTO v_after FROM public.attendance_records ar WHERE ar.id = v_id;

      INSERT INTO public.attendance_corrections_audit (
        company_id, attendance_record_id, target_user_id, actor_user_id,
        reason, before, after, kind
      ) VALUES (
        v_me.company_id, v_id, p_user_id, auth.uid(),
        NULLIF(trim(p_notes), ''), v_before, v_after, 'day_status'
      );
    ELSE
      -- Office workers: supervisor mark still allowed but clock times only if inside W via correction path
      -- Keep status mark without inventing clock times outside W
      PERFORM public.attendance_set_write_context('day_status');
      INSERT INTO public.attendance_records (
          user_id, attendance_date, status, approval_status, notes, marked_by,
          reviewed_by, reviewed_at, attendance_source
      )
      VALUES (
          p_user_id, p_date, p_status, 'approved', v_notes, auth.uid(),
          auth.uid(), v_now, 'day_status'
      )
      ON CONFLICT (user_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status,
          approval_status = 'approved',
          notes = EXCLUDED.notes,
          marked_by = auth.uid(),
          reviewed_by = auth.uid(),
          reviewed_at = v_now,
          attendance_source = COALESCE(public.attendance_records.attendance_source, 'day_status')
      RETURNING id INTO v_id;
      PERFORM public.attendance_set_write_context('normal');

      SELECT to_jsonb(ar) INTO v_after FROM public.attendance_records ar WHERE ar.id = v_id;
      INSERT INTO public.attendance_corrections_audit (
        company_id, attendance_record_id, target_user_id, actor_user_id,
        reason, before, after, kind
      ) VALUES (
        v_me.company_id, v_id, p_user_id, auth.uid(),
        NULLIF(trim(p_notes), ''), v_before, v_after, 'day_status'
      );
    END IF;

    PERFORM public.create_system_notification(
        p_user_id,
        'Attendance Recorded',
        'Your attendance for ' || p_date::TEXT || ' was marked as ' || p_status::TEXT || '.',
        'info'::notification_type
    );
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Closers use shared window end (R9)
CREATE OR REPLACE FUNCTION public.close_open_attendance_if_shift_ended(
    p_user_id UUID,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r public.attendance_records%ROWTYPE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_win RECORD;
    v_out TIMESTAMPTZ;
    v_last TIMESTAMPTZ;
    n INTEGER := 0;
    v_total INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN 0;
    END IF;

    FOR r IN
        SELECT *
        FROM public.attendance_records ar
        WHERE ar.user_id = p_user_id
          AND ar.clock_in_at IS NOT NULL
          AND ar.clock_out_at IS NULL
          AND ar.status IS DISTINCT FROM 'absent'
    LOOP
        SELECT * INTO v_win FROM public.attendance_window_for_user(p_user_id, v_now) LIMIT 1;

        IF v_win.window_end_utc IS NULL OR COALESCE(v_win.attendance_date, r.attendance_date) IS DISTINCT FROM r.attendance_date THEN
          SELECT * INTO v_win
          FROM public.attendance_window_for_user(
            p_user_id,
            (r.attendance_date + TIME '12:00') AT TIME ZONE COALESCE(
              (SELECT timezone FROM public.work_shifts ws WHERE ws.id = r.shift_id),
              public.company_timezone((SELECT company_id FROM public.users WHERE id = p_user_id))
            )
          ) LIMIT 1;
        END IF;

        IF v_win.window_end_utc IS NULL OR v_now <= v_win.window_end_utc THEN
            CONTINUE;
        END IF;

        SELECT COALESCE(MAX(d.last_presence_at), MAX(vs.clock_in_at), r.clock_in_at)
        INTO v_last
        FROM public.attendance_visit_segments vs
        FULL OUTER JOIN public.attendance_devices d
          ON d.user_id = p_user_id AND d.revoked_at IS NULL
        WHERE vs.user_id = p_user_id
          AND vs.attendance_date = r.attendance_date
          AND vs.clock_out_at IS NULL;

        v_out := LEAST(COALESCE(v_last, v_win.window_end_utc), v_win.window_end_utc);
        v_out := GREATEST(r.clock_in_at, v_out);

        UPDATE public.attendance_visit_segments SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (v_out - clock_in_at)) / 60)::INTEGER),
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%window end%' THEN notes
                ELSE COALESCE(notes, '') || ' | Closed (window end)'
            END
        WHERE user_id = p_user_id
          AND attendance_date = r.attendance_date
          AND clock_out_at IS NULL;

        IF NOT EXISTS (
            SELECT 1 FROM public.attendance_visit_segments
            WHERE user_id = p_user_id AND attendance_date = r.attendance_date
        ) THEN
            INSERT INTO public.attendance_visit_segments (
                user_id, attendance_record_id, attendance_date, visit_number,
                clock_in_at, clock_out_at, work_minutes, notes
            ) VALUES (
                p_user_id, r.id, r.attendance_date, 1,
                r.clock_in_at, v_out,
                GREATEST(0, (EXTRACT(EPOCH FROM (v_out - r.clock_in_at)) / 60)::INTEGER),
                'Auto clock-out (window end)'
            );
        END IF;

        v_total := public.attendance_day_total_minutes(p_user_id, r.attendance_date, v_out);

        UPDATE public.attendance_records SET
            clock_out_at = v_out,
            clock_out_lat = COALESCE(p_lat, clock_out_lat),
            clock_out_lng = COALESCE(p_lng, clock_out_lng),
            work_minutes = v_total,
            notes = CASE
                WHEN COALESCE(notes, '') ILIKE '%window end%' THEN notes
                ELSE COALESCE(notes, '') || ' | Auto clock-out (window end)'
            END
        WHERE id = r.id;

        n := n + 1;
    END LOOP;

    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public.touch_my_presence();
    RETURN public.close_open_attendance_if_shift_ended(v_uid, NULL, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.close_all_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN public.attendance_close_ended_windows();
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_ended_shift_attendance()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v1 INTEGER;
  v2 INTEGER;
BEGIN
  v1 := public.attendance_close_ended_windows();
  v2 := public.attendance_close_stale_presence();
  RETURN v1 + v2;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_hybrid_remote_day(DATE, public.attendance_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_attendance(UUID, DATE, public.attendance_status, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_open_attendance_if_shift_ended(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_all_ended_shift_attendance() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_ended_shift_attendance() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_writers_window.sql

-- >>> BEGIN attendance_geo_window.sql
-- attendance_geo_window.sql
-- N2: JWT process_geo_attendance_ping keeps working until device enrollment,
-- but enforces W + server time immediately; returns stop_tracking outside W.

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION DEFAULT NULL,
    p_intent TEXT DEFAULT 'auto'
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_role public.user_role;
    v_inside BOOLEAN := false;
    v_rec public.attendance_records%ROWTYPE;
    v_has_rec BOOLEAN := false;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
    v_action TEXT := 'none';
    v_site_name TEXT;
    v_distance DOUBLE PRECISION;
    v_radius INTEGER;
    v_effective_radius DOUBLE PRECISION;
    v_work_site_id UUID;
    v_demo BOOLEAN;
    v_site_lat DOUBLE PRECISION;
    v_site_lng DOUBLE PRECISION;
    v_office_id UUID;
    v_office_dist DOUBLE PRECISION;
    v_win RECORD;
    v_visit public.attendance_visit_segments%ROWTYPE;
    v_has_visit BOOLEAN := false;
    v_seg_mins INTEGER;
    v_total_mins INTEGER;
    v_intent TEXT := lower(trim(COALESCE(p_intent, 'auto')));
    v_open_checkin BOOLEAN := false;
    v_prev_inside BOOLEAN;
    v_left_site BOOLEAN := false;
    v_attendance_date DATE;
    v_enrolled BOOLEAN := false;
BEGIN
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
    IF v_role NOT IN ('employee'::public.user_role, 'manager'::public.user_role, 'hr'::public.user_role) THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Geo attendance is for employees, managers, and HR only');
    END IF;

    -- After device enrollment, prefer device-token path (N2)
    SELECT EXISTS (
      SELECT 1 FROM public.attendance_devices d
      WHERE d.user_id = v_user_id AND d.revoked_at IS NULL AND d.platform IN ('android', 'ios')
    ) INTO v_enrolled;

    UPDATE public.users SET last_seen_at = v_now WHERE id = v_user_id;

    IF v_intent NOT IN ('clock_in', 'clock_out', 'auto') THEN
        RETURN jsonb_build_object('action', 'skipped', 'reason', 'Unknown attendance intent');
    END IF;

    v_demo := public.is_demo_user(v_user_id);

    SELECT * INTO v_win FROM public.attendance_window_for_user(v_user_id, v_now) LIMIT 1;

    IF NOT COALESCE(v_win.has_shift, false) OR NOT COALESCE(v_win.in_window, false) THEN
        RETURN jsonb_build_object(
            'action', 'outside_window',
            'reason', 'outside_window',
            'stop_tracking', true,
            'window_start_utc', v_win.window_start_utc,
            'window_end_utc', v_win.window_end_utc,
            'server_now_utc', v_now,
            'enrolled_device', v_enrolled
        );
    END IF;

    v_attendance_date := v_win.attendance_date;

    SELECT
        ws.site_id, ws.site_name, ws.latitude, ws.longitude, ws.radius_meters
    INTO v_work_site_id, v_site_name, v_site_lat, v_site_lng, v_radius
    FROM public.get_work_site_for_user(v_user_id) ws
    LIMIT 1;

    IF FOUND AND v_work_site_id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site_lat, v_site_lng);
    ELSE
        SELECT w.office_id, w.office_name, w.distance_meters
        INTO v_office_id, v_site_name, v_office_dist
        FROM public.is_within_office(p_latitude, p_longitude) w
        LIMIT 1;

        IF FOUND AND v_office_id IS NOT NULL THEN
            SELECT o.radius_meters INTO v_radius FROM public.office_locations o WHERE o.id = v_office_id;
            v_distance := v_office_dist;
            v_work_site_id := v_office_id;
        END IF;
    END IF;

    v_radius := GREATEST(COALESCE(v_radius, 150), 150);
    v_effective_radius := v_radius::DOUBLE PRECISION
      + LEAST(COALESCE(p_accuracy, 0)::DOUBLE PRECISION, 100::DOUBLE PRECISION);
    v_inside := (v_distance IS NOT NULL AND v_distance <= v_effective_radius);

    SELECT p.inside_site INTO v_prev_inside
    FROM public.employee_location_pings p
    WHERE p.user_id = v_user_id
    ORDER BY p.recorded_at DESC
    LIMIT 1;

    v_left_site := public.geo_confirm_left_site(v_distance, v_effective_radius, v_prev_inside);

    v_rec := public.get_open_attendance_record(v_user_id);
    v_open_checkin := v_rec.id IS NOT NULL;
    v_has_rec := v_open_checkin;

    IF NOT v_has_rec THEN
        SELECT * INTO v_rec
        FROM public.attendance_records ar
        WHERE ar.user_id = v_user_id AND ar.attendance_date = v_attendance_date
        LIMIT 1;
        v_has_rec := FOUND;
    ELSE
        v_attendance_date := v_rec.attendance_date;
    END IF;

    SELECT * INTO v_visit
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_user_id
      AND vs.attendance_date = v_attendance_date
      AND vs.clock_out_at IS NULL
    ORDER BY vs.clock_in_at DESC
    LIMIT 1;
    v_has_visit := FOUND;

    -- Only store pings inside W (N3) — trigger also enforces
    INSERT INTO public.employee_location_pings (
        user_id, latitude, longitude, accuracy, inside_site, work_site_id, distance_meters, is_demo
    ) VALUES (
        v_user_id, p_latitude, p_longitude, p_accuracy, v_inside, v_work_site_id, v_distance, v_demo
    );

    IF v_intent = 'clock_in' THEN
        IF v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'already_clocked_in';
        ELSIF NOT v_inside THEN
            v_action := 'outside_office';
        ELSE
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'manual', v_win.shift_id,
                'GPS clock-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE WHEN public.attendance_records.clock_in_at IS NULL THEN 'manual' ELSE public.attendance_records.attendance_source END,
                presence_method = COALESCE(EXCLUDED.presence_method, public.attendance_records.presence_method),
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'GPS entry'
            );
            v_action := 'clock_in';
        END IF;

    ELSIF v_intent = 'clock_out' THEN
        IF NOT v_has_rec OR v_rec.clock_in_at IS NULL THEN
            v_action := 'no_open_visit';
        ELSIF v_rec.clock_out_at IS NOT NULL THEN
            v_action := 'already_clocked_out';
        ELSE
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins
                WHERE id = v_visit.id;
            END IF;
            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins
            WHERE id = v_rec.id;
            v_action := 'clock_out';
        END IF;

    ELSIF v_intent = 'auto' THEN
        IF v_enrolled THEN
            RETURN jsonb_build_object(
              'action', 'use_device_token',
              'reason', 'enrolled_device_use_auto_path',
              'stop_tracking', false,
              'enrolled_device', true
            );
        END IF;

        IF v_inside AND (NOT v_has_rec OR v_rec.clock_out_at IS NOT NULL OR v_rec.clock_in_at IS NULL) THEN
            INSERT INTO public.attendance_records (
                user_id, attendance_date, status, approval_status, marked_by,
                clock_in_at, clock_in_lat, clock_in_lng, attendance_source, shift_id, notes,
                reviewed_by, reviewed_at, presence_method
            ) VALUES (
                v_user_id, v_attendance_date, 'present', 'approved', v_user_id,
                v_now, p_latitude, p_longitude, 'auto_gps', v_win.shift_id,
                'Auto GPS check-in at ' || COALESCE(v_site_name, 'work site'),
                v_user_id, v_now, 'gps'
            )
            ON CONFLICT (user_id, attendance_date) DO UPDATE SET
                clock_in_at = COALESCE(public.attendance_records.clock_in_at, EXCLUDED.clock_in_at),
                clock_out_at = NULL,
                status = 'present',
                approval_status = 'approved',
                attendance_source = CASE
                  WHEN public.attendance_records.clock_out_at IS NOT NULL OR public.attendance_records.clock_in_at IS NULL
                  THEN 'auto_gps' ELSE public.attendance_records.attendance_source END,
                presence_method = 'gps',
                shift_id = COALESCE(public.attendance_records.shift_id, EXCLUDED.shift_id)
            RETURNING * INTO v_rec;
            PERFORM public.attendance_ensure_open_visit(
                v_user_id, v_rec.id, v_attendance_date, v_now, 'Auto GPS entry'
            );
            v_action := 'clock_in';
        ELSIF v_left_site AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            IF v_has_visit THEN
                v_seg_mins := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_visit.clock_in_at))::INTEGER / 60);
                UPDATE public.attendance_visit_segments SET
                    clock_out_at = v_now,
                    clock_out_lat = p_latitude,
                    clock_out_lng = p_longitude,
                    work_minutes = v_seg_mins
                WHERE id = v_visit.id;
            END IF;
            v_total_mins := public.attendance_day_total_minutes(v_user_id, v_attendance_date, v_now);
            UPDATE public.attendance_records SET
                clock_out_at = v_now,
                clock_out_lat = p_latitude,
                clock_out_lng = p_longitude,
                work_minutes = v_total_mins,
                notes = COALESCE(notes, '') || ' | Auto GPS check-out'
            WHERE id = v_rec.id;
            v_action := 'clock_out';
        ELSIF v_inside AND v_has_rec AND v_rec.clock_in_at IS NOT NULL AND v_rec.clock_out_at IS NULL THEN
            v_action := 'still_inside';
        ELSE
            v_action := 'none';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'action', v_action,
        'inside', v_inside,
        'distance_m', v_distance,
        'attendance_date', v_attendance_date,
        'window_start_utc', v_win.window_start_utc,
        'window_end_utc', v_win.window_end_utc,
        'server_now_utc', v_now,
        'stop_tracking', false,
        'enrolled_device', v_enrolled,
        'shift_tz', v_win.shift_tz
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_geo_window.sql

-- >>> BEGIN attendance_leave_window.sql
-- attendance_leave_window.sql
-- R11: approved leave days allowed outside W; no clock times; write context = leave

CREATE OR REPLACE FUNCTION public.attendance_apply_leave_day(
  p_user_id UUID,
  p_date DATE,
  p_notes TEXT DEFAULT 'Approved leave'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_now TIMESTAMPTZ := timezone('utc', now());
  v_actor UUID := auth.uid();
BEGIN
  PERFORM public.attendance_set_write_context('leave');

  INSERT INTO public.attendance_records (
    user_id, attendance_date, status, approval_status, notes, marked_by,
    reviewed_by, reviewed_at, clock_in_at, clock_out_at, work_minutes, attendance_source
  ) VALUES (
    p_user_id, p_date, 'absent', 'approved', p_notes, v_actor,
    v_actor, v_now, NULL, NULL, NULL, 'leave'
  )
  ON CONFLICT (user_id, attendance_date) DO UPDATE
  SET status = 'absent',
      approval_status = 'approved',
      notes = EXCLUDED.notes,
      clock_in_at = NULL,
      clock_out_at = NULL,
      work_minutes = NULL,
      attendance_source = 'leave',
      reviewed_by = v_actor,
      reviewed_at = v_now
  RETURNING id INTO v_id;

  PERFORM public.attendance_set_write_context('normal');
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attendance_apply_leave_day(UUID, DATE, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_leave_request(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_notes TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    req public.leave_requests%ROWTYPE;
    req_role public.user_role;
    v_year INTEGER;
    v_label TEXT;
    v_day DATE;
BEGIN
    SELECT * INTO req FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
    IF to_regprocedure('public.enforce_demo_isolation(uuid)') IS NOT NULL THEN
        PERFORM public.enforce_demo_isolation(req.user_id);
    END IF;
    IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

    SELECT role INTO req_role FROM public.users WHERE id = req.user_id;

    IF req_role = 'manager' THEN
        IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'Manager leave must be approved by admin'; END IF;
    ELSE
        IF NOT public.is_admin(auth.uid()) AND NOT public.is_manager_of(auth.uid(), req.user_id) THEN
            RAISE EXCEPTION 'Unauthorized';
        END IF;
    END IF;

    v_label := CASE
        WHEN req.leave_type = 'other' THEN COALESCE(NULLIF(btrim(req.leave_custom_type), ''), 'other')
        ELSE req.leave_type::TEXT
    END;

    IF p_approve THEN
        v_year := EXTRACT(YEAR FROM req.start_date)::INTEGER;
        PERFORM public.ensure_leave_balance(req.user_id, v_year);
        IF req.leave_type = 'annual' THEN
            UPDATE public.leave_balances SET annual_used = annual_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        ELSIF req.leave_type = 'sick' THEN
            UPDATE public.leave_balances SET sick_used = sick_used + req.days_count
            WHERE user_id = req.user_id AND year = v_year;
        END IF;

        v_day := req.start_date;
        WHILE v_day <= req.end_date LOOP
          IF EXTRACT(ISODOW FROM v_day) < 6 THEN
            PERFORM public.attendance_apply_leave_day(
              req.user_id, v_day, 'Approved leave: ' || v_label
            );
          END IF;
          v_day := v_day + 1;
        END LOOP;
    END IF;

    UPDATE public.leave_requests SET
        status = CASE WHEN p_approve THEN 'approved'::public.approval_status ELSE 'rejected'::public.approval_status END,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = p_notes
    WHERE id = p_request_id;

    PERFORM public.create_system_notification(
        req.user_id,
        CASE WHEN p_approve THEN 'Leave Approved' ELSE 'Leave Rejected' END,
        'Your ' || v_label || ' leave (' || req.start_date::TEXT || ' to ' || req.end_date::TEXT || ') was ' ||
        CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END || '.',
        CASE WHEN p_approve THEN 'info'::notification_type ELSE 'alert'::notification_type END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.review_leave_request(UUID, BOOLEAN, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_leave_window.sql

-- >>> BEGIN attendance_rls_lockdown.sql
-- attendance_rls_lockdown.sql
-- R19 / R58 / R64: lock down attendance writes; company isolation on new tables

-- attendance_records: no direct client writes
DROP POLICY IF EXISTS attendance_records_insert ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_update ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_delete ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_write ON public.attendance_records;
DROP POLICY IF EXISTS "Users can insert own attendance" ON public.attendance_records;
DROP POLICY IF EXISTS "Users can update own attendance" ON public.attendance_records;

DO $$
BEGIN
  -- Keep SELECT policies; block ALL writes for authenticated via explicit deny if needed
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'attendance_records' AND policyname = 'attendance_records_no_client_write'
  ) THEN
    CREATE POLICY attendance_records_no_client_write ON public.attendance_records
      FOR INSERT TO authenticated
      WITH CHECK (false);
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP POLICY IF EXISTS attendance_records_no_client_update ON public.attendance_records;
CREATE POLICY attendance_records_no_client_update ON public.attendance_records
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS attendance_records_no_client_delete ON public.attendance_records;
CREATE POLICY attendance_records_no_client_delete ON public.attendance_records
  FOR DELETE TO authenticated
  USING (false);

-- visit segments
DROP POLICY IF EXISTS attendance_visits_no_client_insert ON public.attendance_visit_segments;
CREATE POLICY attendance_visits_no_client_insert ON public.attendance_visit_segments
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS attendance_visits_no_client_update ON public.attendance_visit_segments;
CREATE POLICY attendance_visits_no_client_update ON public.attendance_visit_segments
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS attendance_visits_no_client_delete ON public.attendance_visit_segments;
CREATE POLICY attendance_visits_no_client_delete ON public.attendance_visit_segments
  FOR DELETE TO authenticated USING (false);

-- location pings: no client insert (RPCs are security definer)
DROP POLICY IF EXISTS employee_location_pings_no_client_insert ON public.employee_location_pings;
CREATE POLICY employee_location_pings_no_client_insert ON public.employee_location_pings
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS employee_location_pings_no_client_update ON public.employee_location_pings;
CREATE POLICY employee_location_pings_no_client_update ON public.employee_location_pings
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- Company settings update still via existing admin RPCs / policies on companies
-- Ensure new columns are readable

NOTIFY pgrst, 'reload schema';

-- <<< END attendance_rls_lockdown.sql

-- >>> BEGIN office_network_upsert.sql
-- office_network_upsert.sql
-- R67 / R74: extend upsert_office_location with Wi-Fi allowlist + detection mode;
-- company/user auto-attendance settings RPCs.

DROP FUNCTION IF EXISTS public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION public.upsert_office_location(
    p_id UUID,
    p_name TEXT,
    p_address TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INTEGER DEFAULT 150,
    p_active BOOLEAN DEFAULT true,
    p_wifi_ssids TEXT[] DEFAULT NULL,
    p_wifi_bssids TEXT[] DEFAULT NULL,
    p_public_ip_cidrs TEXT[] DEFAULT NULL,
    p_detection_mode TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_demo BOOLEAN := public.is_demo_user(v_uid);
    v_company UUID;
    v_mode public.office_detection_mode;
BEGIN
    IF NOT public.is_admin(v_uid) THEN
        RAISE EXCEPTION 'Only admins can manage office locations';
    END IF;
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Office name is required';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        RAISE EXCEPTION 'Latitude and longitude are required';
    END IF;

    IF p_detection_mode IS NULL OR btrim(p_detection_mode) = '' THEN
        v_mode := COALESCE(
          (SELECT detection_mode FROM public.office_locations WHERE id = p_id),
          'gps_or_wifi'::public.office_detection_mode
        );
    ELSE
        v_mode := p_detection_mode::public.office_detection_mode;
    END IF;

    IF p_public_ip_cidrs IS NOT NULL THEN
      PERFORM public.assert_public_ip_cidrs(p_public_ip_cidrs);
    END IF;

    IF NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.office_locations (
            name, address, latitude, longitude, radius_meters, active, is_demo, company_id,
            wifi_ssids, wifi_bssids, public_ip_cidrs, detection_mode
        ) VALUES (
            trim(p_name),
            NULLIF(trim(p_address), ''),
            p_latitude,
            p_longitude,
            GREATEST(COALESCE(p_radius_meters, 150), 50),
            p_active,
            v_demo,
            v_company,
            COALESCE(p_wifi_ssids, '{}'),
            COALESCE(p_wifi_bssids, '{}'),
            COALESCE(p_public_ip_cidrs, '{}'),
            v_mode
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.office_locations SET
            name = trim(p_name),
            address = NULLIF(trim(p_address), ''),
            latitude = p_latitude,
            longitude = p_longitude,
            radius_meters = GREATEST(COALESCE(p_radius_meters, 150), 50),
            active = p_active,
            wifi_ssids = COALESCE(p_wifi_ssids, wifi_ssids),
            wifi_bssids = COALESCE(p_wifi_bssids, wifi_bssids),
            public_ip_cidrs = COALESCE(p_public_ip_cidrs, public_ip_cidrs),
            detection_mode = v_mode,
            updated_at = timezone('utc'::text, now())
        WHERE id = p_id
          AND (
              (v_demo AND is_demo = true)
              OR (NOT v_demo AND company_id = v_company)
          )
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
    END IF;

    PERFORM public.sync_work_sites_to_office(v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_company_auto_attendance(
  p_auto_phone BOOLEAN DEFAULT NULL,
  p_auto_laptop BOOLEAN DEFAULT NULL,
  p_timezone TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  IF NOT FOUND OR v_me.role NOT IN ('admin', 'hr') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_timezone IS NOT NULL THEN
    PERFORM public.assert_valid_iana_timezone(p_timezone);
  END IF;

  UPDATE public.companies SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance),
    timezone = COALESCE(p_timezone, timezone)
  WHERE id = v_me.company_id;

  RETURN (
    SELECT jsonb_build_object(
      'auto_phone_attendance', c.auto_phone_attendance,
      'auto_laptop_attendance', c.auto_laptop_attendance,
      'timezone', c.timezone
    )
    FROM public.companies c WHERE c.id = v_me.company_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_user_auto_attendance(
  p_user_id UUID,
  p_auto_phone BOOLEAN DEFAULT NULL,
  p_auto_laptop BOOLEAN DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.users%ROWTYPE;
  v_target public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
  SELECT * INTO v_target FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF v_me.id = p_user_id THEN
    NULL;
  ELSIF v_me.role IN ('admin', 'hr') AND v_me.company_id = v_target.company_id THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.users SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance)
  WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_work_shift_timezone(
  p_shift_id UUID,
  p_timezone TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM public.assert_valid_iana_timezone(p_timezone);
  UPDATE public.work_shifts SET timezone = p_timezone WHERE id = p_shift_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_office_location(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN, TEXT[], TEXT[], TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_company_auto_attendance(BOOLEAN, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_auto_attendance(UUID, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_work_shift_timezone(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- <<< END office_network_upsert.sql

-- >>> EXTRACTS from fix_get_attendance_history_ambiguous_id.sql
-- extract get_attendance_history
CREATE OR REPLACE FUNCTION public.get_attendance_history(
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
    p_month INTEGER DEFAULT NULL,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE(
    id UUID,
    attendance_date DATE,
    status public.attendance_status,
    approval_status public.approval_status,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    attendance_source TEXT,
    work_minutes INTEGER,
    shift_name TEXT,
    notes TEXT
) AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_target UUID;
    v_role public.user_role;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;

    v_target := COALESCE(p_user_id, v_uid);

    IF v_target <> v_uid THEN
        IF v_role = 'manager'::public.user_role THEN
            IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_target AND u.manager_id = v_uid) THEN
                RAISE EXCEPTION 'Not authorized';
            END IF;
        ELSIF v_role <> 'admin'::public.user_role THEN
            RAISE EXCEPTION 'Not authorized';
        END IF;
    END IF;

    IF p_month IS NULL THEN
        v_start := make_date(p_year, 1, 1);
        v_end := make_date(p_year, 12, 31);
    ELSE
        v_start := make_date(p_year, p_month, 1);
        v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    RETURN QUERY
    SELECT
        q.rid,
        q.rdate,
        q.rstatus,
        q.rapproval,
        q.rin,
        q.rout,
        q.rsource,
        q.rmins,
        q.rshift,
        q.rnotes
    FROM (
        SELECT
            ar.id AS rid,
            ar.attendance_date AS rdate,
            ar.status AS rstatus,
            ar.approval_status AS rapproval,
            COALESCE(ar.clock_in_at, vis.first_in) AS rin,
            COALESCE(ar.clock_out_at, vis.last_out) AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
                COALESCE(ar.clock_out_at, vis.last_out),
                ar.work_minutes,
                ar.attendance_source,
                asg.shift_mins
            ) AS rmins,
            COALESCE(ws.name, asg.shift_name) AS rshift,
            ar.notes AS rnotes
        FROM public.attendance_records ar
        LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
        LEFT JOIN LATERAL (
            SELECT
                ws2.name AS shift_name,
                GREATEST(
                    1,
                    (
                        (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                        - (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                        + CASE
                            WHEN COALESCE(ws2.crosses_midnight, false)
                              OR (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                                 <= (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                            THEN 24 * 60
                            ELSE 0
                          END
                    )
                ) AS shift_mins
            FROM public.employee_shift_assignments esa
            JOIN public.work_shifts ws2 ON ws2.id = esa.shift_id
            WHERE esa.user_id = ar.user_id
              AND esa.effective_from <= ar.attendance_date
              AND (esa.effective_to IS NULL OR esa.effective_to >= ar.attendance_date)
            ORDER BY esa.effective_from DESC
            LIMIT 1
        ) asg ON true
        LEFT JOIN LATERAL (
            SELECT
                MIN(vs.clock_in_at) AS first_in,
                MAX(vs.clock_out_at) AS last_out
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE ar.user_id = v_target
          AND ar.attendance_date BETWEEN v_start AND v_end
    ) q
    ORDER BY q.rdate DESC, q.rin DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- >>> EXTRACTS from hr_attendance_history_access.sql
-- extract get_team_attendance_history
CREATE OR REPLACE FUNCTION public.get_team_attendance_history(
    p_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    p_month integer DEFAULT NULL::integer,
    p_user_id uuid DEFAULT NULL::uuid,
    p_department_id uuid DEFAULT NULL::uuid,
    p_scope text DEFAULT 'self'::text
)
RETURNS TABLE(
    id uuid,
    user_id uuid,
    employee_name text,
    employee_role text,
    department_name text,
    attendance_date date,
    status attendance_status,
    approval_status approval_status,
    clock_in_at timestamp with time zone,
    clock_out_at timestamp with time zone,
    attendance_source text,
    work_minutes integer,
    shift_name text,
    notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_uid UUID := auth.uid();
    v_role public.user_role;
    v_company UUID;
    v_start DATE;
    v_end DATE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    SELECT u.role, u.company_id INTO v_role, v_company FROM public.users u WHERE u.id = v_uid;
    IF v_company IS NULL THEN RAISE EXCEPTION 'No company context'; END IF;

    IF p_month IS NULL THEN
        v_start := make_date(p_year, 1, 1);
        v_end := make_date(p_year, 12, 31);
    ELSE
        v_start := make_date(p_year, p_month, 1);
        v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    RETURN QUERY
    SELECT
        q.rid,
        q.ruser,
        q.rname,
        q.rrole,
        q.rdept,
        q.rdate,
        q.rstatus,
        q.rapproval,
        q.rin,
        q.rout,
        q.rsource,
        q.rmins,
        q.rshift,
        q.rnotes
    FROM (
        SELECT
            ar.id AS rid,
            ar.user_id AS ruser,
            u.full_name AS rname,
            u.role::TEXT AS rrole,
            d.name AS rdept,
            ar.attendance_date AS rdate,
            ar.status AS rstatus,
            ar.approval_status AS rapproval,
            COALESCE(ar.clock_in_at, vis.first_in) AS rin,
            CASE
                WHEN COALESCE(vis.any_open, false) THEN NULL
                WHEN ar.clock_out_at IS NULL
                     AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                     AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                ELSE COALESCE(ar.clock_out_at, vis.last_out)
            END AS rout,
            ar.attendance_source AS rsource,
            public.attendance_history_work_minutes(
                ar.user_id,
                ar.attendance_date,
                COALESCE(ar.clock_in_at, vis.first_in),
                CASE
                    WHEN COALESCE(vis.any_open, false) THEN NULL
                    WHEN ar.clock_out_at IS NULL
                         AND COALESCE(ar.clock_in_at, vis.first_in) IS NOT NULL
                         AND COALESCE(vis.visit_count, 0) = 0 THEN NULL
                    ELSE COALESCE(ar.clock_out_at, vis.last_out)
                END,
                ar.work_minutes,
                ar.attendance_source,
                asg.shift_mins
            ) AS rmins,
            COALESCE(ws.name, asg.shift_name) AS rshift,
            ar.notes AS rnotes
        FROM public.attendance_records ar
        JOIN public.users u ON u.id = ar.user_id
        LEFT JOIN public.departments d ON d.id = u.department_id
        LEFT JOIN public.work_shifts ws ON ws.id = ar.shift_id
        LEFT JOIN LATERAL (
            SELECT
                ws2.name AS shift_name,
                GREATEST(
                    1,
                    (
                        (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                        - (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                        + CASE
                            WHEN COALESCE(ws2.crosses_midnight, false)
                              OR (EXTRACT(HOUR FROM ws2.end_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.end_time)::INTEGER)
                                 <= (EXTRACT(HOUR FROM ws2.start_time)::INTEGER * 60 + EXTRACT(MINUTE FROM ws2.start_time)::INTEGER)
                            THEN 24 * 60
                            ELSE 0
                          END
                    )
                ) AS shift_mins
            FROM public.employee_shift_assignments esa
            JOIN public.work_shifts ws2 ON ws2.id = esa.shift_id
            WHERE esa.user_id = ar.user_id
              AND esa.effective_from <= ar.attendance_date
              AND (esa.effective_to IS NULL OR esa.effective_to >= ar.attendance_date)
            ORDER BY esa.effective_from DESC
            LIMIT 1
        ) asg ON true
        LEFT JOIN LATERAL (
            SELECT
                MIN(vs.clock_in_at) AS first_in,
                MAX(vs.clock_out_at) FILTER (WHERE vs.clock_out_at IS NOT NULL) AS last_out,
                BOOL_OR(vs.clock_out_at IS NULL) AS any_open,
                COUNT(*)::INTEGER AS visit_count
            FROM public.attendance_visit_segments vs
            WHERE vs.user_id = ar.user_id
              AND vs.attendance_date = ar.attendance_date
        ) vis ON true
        WHERE u.company_id = v_company
          AND ar.attendance_date BETWEEN v_start AND v_end
          AND (
              (p_scope = 'self' AND ar.user_id = COALESCE(p_user_id, v_uid))
              OR (
                  p_scope = 'team'
                  AND v_role = 'manager'::public.user_role
                  AND (ar.user_id = v_uid OR u.manager_id = v_uid)
              )
              OR (
                  p_scope = 'department'
                  AND p_department_id IS NOT NULL
                  AND u.department_id = p_department_id
                  AND (
                      public.is_admin(v_uid)
                      OR public.is_hr(v_uid)
                      OR (
                          v_role = 'manager'::public.user_role
                          AND u.department_id = public.user_department_id(v_uid)
                      )
                  )
              )
              OR (
                  p_scope = 'company'
                  AND (public.is_admin(v_uid) OR public.is_hr(v_uid))
                  AND (p_department_id IS NULL OR u.department_id = p_department_id)
              )
          )
          AND (
              ar.user_id = v_uid
              OR public.is_admin(v_uid)
              OR public.is_hr(v_uid)
              OR (v_role = 'manager'::public.user_role AND (u.manager_id = v_uid OR u.id = v_uid))
              OR (v_role = 'manager'::public.user_role AND p_scope = 'department' AND u.department_id = public.user_department_id(v_uid))
          )
    ) q
    ORDER BY q.rdate DESC, q.rname, q.rin DESC NULLS LAST;
END;
$function$;


-- >>> EXTRACTS from overnight_shift_attendance_date.sql
-- extract get_my_attendance_visits
CREATE OR REPLACE FUNCTION public.get_my_attendance_visits(p_date DATE DEFAULT NULL)
RETURNS TABLE (
    id UUID,
    visit_number INTEGER,
    clock_in_at TIMESTAMPTZ,
    clock_out_at TIMESTAMPTZ,
    work_minutes INTEGER,
    site_name TEXT,
    notes TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_shift_date DATE;
    v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    v_shift_date := COALESCE(p_date, public.resolve_shift_attendance_date(v_uid, v_now));

    RETURN QUERY
    SELECT
        vs.id,
        ROW_NUMBER() OVER (ORDER BY vs.clock_in_at ASC)::INTEGER AS visit_number,
        vs.clock_in_at,
        vs.clock_out_at,
        CASE
            WHEN vs.clock_out_at IS NOT NULL THEN COALESCE(
                vs.work_minutes,
                GREATEST(0, (EXTRACT(EPOCH FROM (vs.clock_out_at - vs.clock_in_at)) / 60)::INTEGER)
            )
            ELSE GREATEST(0, (EXTRACT(EPOCH FROM (v_now - vs.clock_in_at)) / 60)::INTEGER)
        END,
        vs.site_name,
        vs.notes
    FROM public.attendance_visit_segments vs
    WHERE vs.user_id = v_uid
      AND public.resolve_shift_attendance_date(v_uid, vs.clock_in_at) = v_shift_date
    ORDER BY vs.clock_in_at ASC;
END;
$$;

-- extract resolve_shift_attendance_date
CREATE OR REPLACE FUNCTION public.resolve_shift_attendance_date(
    p_user_id UUID,
    p_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tz TEXT := public.app_timezone();
    v_local_date DATE;
    v_local_time TIME;
    v_shift_start TIME;
    v_shift_end TIME;
    v_shift_days INTEGER[] := ARRAY[1, 2, 3, 4, 5, 6, 7];
    v_overnight BOOLEAN := false;
    v_edge INTEGER;
    v_early TIME;
    v_late TIME;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN (p_at AT TIME ZONE v_tz)::DATE;
    END IF;

    v_local_date := (p_at AT TIME ZONE v_tz)::DATE;
    v_local_time := (p_at AT TIME ZONE v_tz)::TIME;
    v_edge := public.shift_edge_minutes();

    SELECT s.start_time, s.end_time, s.days_of_week, s.crosses_midnight
    INTO v_shift_start, v_shift_end, v_shift_days, v_overnight
    FROM public.get_active_shift_for_user(p_user_id, v_local_date) s
    LIMIT 1;

    IF NOT FOUND OR v_shift_start IS NULL THEN
        SELECT
            COALESCE(c.location_window_start, '17:00'::TIME),
            COALESCE(c.location_window_end, '04:00'::TIME)
        INTO v_shift_start, v_shift_end
        FROM public.users u
        JOIN public.companies c ON c.id = u.company_id
        WHERE u.id = p_user_id;

        v_shift_start := COALESCE(v_shift_start, '17:00'::TIME);
        v_shift_end := COALESCE(v_shift_end, '04:00'::TIME);
        v_shift_days := ARRAY[1, 2, 3, 4, 5, 6, 7];
        v_overnight := v_shift_end <= v_shift_start;
    ELSE
        v_overnight := COALESCE(v_overnight, public.is_shift_overnight(v_shift_start, v_shift_end));
    END IF;

    IF NOT v_overnight THEN
        RETURN v_local_date;
    END IF;

    v_early := (v_shift_start - (v_edge || ' minutes')::INTERVAL)::TIME;
    v_late := (v_shift_end + (v_edge || ' minutes')::INTERVAL)::TIME;

    -- After midnight but still in yesterday's shift (through end + checkout hour)
    IF v_local_time <= v_late THEN
        RETURN v_local_date - 1;
    END IF;

    -- Evening portion of today's shift
    IF v_local_time >= v_early THEN
        RETURN v_local_date;
    END IF;

    RETURN v_local_date;
END;
$$;


-- >>> EXTRACTS from kpi_assign_dept_scope.sql
-- extract can_assign_kpi_to
CREATE OR REPLACE FUNCTION public.can_assign_kpi_to(p_target_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_me public.users%ROWTYPE;
    v_them public.users%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_target_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT * INTO v_me FROM public.users WHERE id = auth.uid();
    SELECT * INTO v_them FROM public.users WHERE id = p_target_id;
    IF v_me.id IS NULL OR v_them.id IS NULL THEN
        RETURN false;
    END IF;
    IF COALESCE(v_me.is_demo, false) IS DISTINCT FROM COALESCE(v_them.is_demo, false) THEN
        RETURN false;
    END IF;
    IF NOT COALESCE(v_me.is_demo, false)
       AND v_me.company_id IS DISTINCT FROM v_them.company_id THEN
        RETURN false;
    END IF;

    IF public.is_admin(auth.uid()) THEN
        RETURN v_them.role IN ('employee'::public.user_role, 'manager'::public.user_role);
    END IF;

    IF v_me.role = 'manager'::public.user_role THEN
        RETURN v_them.role = 'employee'::public.user_role
            AND v_me.department_id IS NOT NULL
            AND v_them.department_id IS NOT DISTINCT FROM v_me.department_id;
    END IF;

    RETURN false;
END;
$$;


-- >>> EXTRACTS from hr_shift_permissions.sql
-- extract upsert_work_shift
CREATE OR REPLACE FUNCTION public.upsert_work_shift(
    p_name TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_days_of_week INTEGER[] DEFAULT ARRAY[1,2,3,4,5],
    p_grace_minutes INTEGER DEFAULT 30,
    p_shift_id UUID DEFAULT NULL,
    p_crosses_midnight BOOLEAN DEFAULT NULL,
    p_apply_to_all BOOLEAN DEFAULT true
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role_txt TEXT;
    v_id UUID;
    v_demo BOOLEAN;
    v_overnight BOOLEAN;
    v_company UUID;
    v_org BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    SELECT role::text INTO v_role_txt FROM public.users WHERE id = v_uid;
    IF v_role_txt NOT IN ('manager', 'admin', 'hr') THEN
        RAISE EXCEPTION 'Only managers, HR, and admins can manage shifts';
    END IF;

    v_org := public.can_manage_org_shifts(v_uid);
    v_overnight := COALESCE(p_crosses_midnight, public.is_shift_overnight(p_start_time, p_end_time));

    IF NOT v_overnight AND p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'End time must be after start time (or enable overnight shift)';
    END IF;

    v_demo := public.is_demo_user(v_uid);
    PERFORM public.enforce_demo_isolation(v_uid);

    IF v_org AND NOT v_demo THEN
        v_company := public.current_company_id();
        IF v_company IS NULL THEN
            RAISE EXCEPTION 'Account not linked to a company';
        END IF;
    END IF;

    IF p_shift_id IS NULL THEN
        INSERT INTO public.work_shifts (
            manager_id, name, start_time, end_time, days_of_week, grace_minutes,
            crosses_midnight, apply_to_all, is_demo
        ) VALUES (
            v_uid, trim(p_name), p_start_time, p_end_time, p_days_of_week, p_grace_minutes,
            v_overnight, p_apply_to_all, v_demo
        )
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.work_shifts ws SET
            name = trim(p_name),
            start_time = p_start_time,
            end_time = p_end_time,
            days_of_week = p_days_of_week,
            grace_minutes = p_grace_minutes,
            crosses_midnight = v_overnight,
            apply_to_all = p_apply_to_all,
            updated_at = timezone('utc'::text, now())
        WHERE ws.id = p_shift_id
          AND (
              ws.manager_id = v_uid
              OR (
                  v_org
                  AND EXISTS (
                      SELECT 1 FROM public.users owner
                      WHERE owner.id = ws.manager_id
                        AND (
                            (v_demo AND owner.is_demo = true)
                            OR (NOT v_demo AND owner.company_id = v_company)
                        )
                  )
              )
          )
        RETURNING ws.id INTO v_id;
        IF v_id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
    END IF;

    IF p_apply_to_all AND v_role_txt = 'manager' THEN
        BEGIN
            PERFORM public.assign_shift_to_all_team(v_id, CURRENT_DATE);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- extract delete_work_shift
CREATE OR REPLACE FUNCTION public.delete_work_shift(p_shift_id UUID)
RETURNS VOID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_company UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

    IF public.can_manage_org_shifts(v_uid) THEN
        IF public.is_demo_user(v_uid) THEN
            DELETE FROM public.work_shifts ws
            WHERE ws.id = p_shift_id
              AND EXISTS (SELECT 1 FROM public.users o WHERE o.id = ws.manager_id AND o.is_demo = true);
        ELSE
            v_company := public.current_company_id();
            DELETE FROM public.work_shifts ws
            WHERE ws.id = p_shift_id
              AND EXISTS (
                  SELECT 1 FROM public.users o
                  WHERE o.id = ws.manager_id AND o.company_id = v_company
              );
        END IF;
    ELSE
        DELETE FROM public.work_shifts WHERE id = p_shift_id AND manager_id = v_uid;
    END IF;

    IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- extract can_manage_org_shifts
CREATE OR REPLACE FUNCTION public.can_manage_org_shifts(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin(p_uid) OR public.is_hr(p_uid);
$$;


-- >>> EXTRACTS from sync_office_live_pin_to_assignments.sql
-- extract sync_work_sites_to_office
CREATE OR REPLACE FUNCTION public.sync_work_sites_to_office(p_office_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_office public.office_locations%ROWTYPE;
    v_count INTEGER := 0;
    v_n INTEGER;
BEGIN
    SELECT * INTO v_office FROM public.office_locations WHERE id = p_office_id;
    IF NOT FOUND THEN RETURN 0; END IF;

    UPDATE public.manager_work_sites SET
        name = v_office.name,
        address = v_office.address,
        latitude = v_office.latitude,
        longitude = v_office.longitude,
        radius_meters = v_office.radius_meters,
        office_location_id = v_office.id,
        updated_at = timezone('utc'::text, now())
    WHERE office_location_id = p_office_id
       OR (office_location_id IS NULL AND lower(name) = lower(v_office.name));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + COALESCE(v_n, 0);

    UPDATE public.employee_work_sites SET
        name = v_office.name,
        address = v_office.address,
        latitude = v_office.latitude,
        longitude = v_office.longitude,
        radius_meters = v_office.radius_meters,
        office_location_id = v_office.id,
        updated_at = timezone('utc'::text, now())
    WHERE office_location_id = p_office_id
       OR (office_location_id IS NULL AND lower(name) = lower(v_office.name));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + COALESCE(v_n, 0);

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- =============================================================================
-- 4) Cron: only 1.3.8 attendance schedule (*/5). Remove post-1.3.8 attendance crons.
-- =============================================================================
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN (
      'scorr-attendance-cron',
      'scorr-close-ended-shifts',
      'scorr-attendance-retention',
      'scorr-kpi-weightage-month-end'
    );

    PERFORM cron.schedule(
      'scorr-attendance-cron',
      '*/5 * * * *',
      $job$SELECT public.attendance_cron_tick();$job$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END;
$cron$;

-- Keep scorr-kpi-performance-awards (pre-1.3.8) untouched.


DO $done$
BEGIN
  RAISE NOTICE 'rollback_to_1_3_8_2026-10-10 applied';
END;
$done$;
