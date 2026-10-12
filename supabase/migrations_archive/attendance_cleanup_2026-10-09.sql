-- Attendance retention + dead-helper cleanup (Rules 1-7 unchanged).
-- Re-runnable: archives then deletes telemetry older than 30 days;
-- drops only unused helpers listed below.

-- ---------------------------------------------------------------------------
-- Archive tables (schema mirrors live tables + archived_at)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_events_log_archive (
  LIKE public.attendance_events_log INCLUDING DEFAULTS
);
ALTER TABLE public.attendance_events_log_archive
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now());

CREATE TABLE IF NOT EXISTS public.employee_location_pings_archive (
  LIKE public.employee_location_pings INCLUDING DEFAULTS
);
ALTER TABLE public.employee_location_pings_archive
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now());

-- ---------------------------------------------------------------------------
-- Retention cleanup (re-runnable)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_retention_cleanup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := timezone('utc', now()) - INTERVAL '30 days';
  v_events_archived INTEGER := 0;
  v_events_deleted INTEGER := 0;
  v_pings_archived INTEGER := 0;
  v_pings_deleted INTEGER := 0;
  v_devices_deleted INTEGER := 0;
BEGIN
  -- Events log
  WITH moved AS (
    INSERT INTO public.attendance_events_log_archive
    SELECT e.*, timezone('utc', now())
    FROM public.attendance_events_log e
    WHERE e.created_at < v_cutoff
      AND NOT EXISTS (
        SELECT 1 FROM public.attendance_events_log_archive a WHERE a.id = e.id
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_events_archived FROM moved;

  DELETE FROM public.attendance_events_log
  WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_events_deleted = ROW_COUNT;

  -- Location pings
  WITH moved AS (
    INSERT INTO public.employee_location_pings_archive
    SELECT p.*, timezone('utc', now())
    FROM public.employee_location_pings p
    WHERE p.recorded_at < v_cutoff
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_location_pings_archive a WHERE a.id = p.id
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_pings_archived FROM moved;

  DELETE FROM public.employee_location_pings
  WHERE recorded_at < v_cutoff;
  GET DIAGNOSTICS v_pings_deleted = ROW_COUNT;

  -- Devices: revoked OR last activity unseen for 30+ days
  DELETE FROM public.attendance_devices d
  WHERE (
      d.revoked_at IS NOT NULL AND d.revoked_at < v_cutoff
    )
    OR (
      d.revoked_at IS NULL
      AND COALESCE(d.last_seen_at, d.last_heartbeat_at, d.created_at) < v_cutoff
    );
  GET DIAGNOSTICS v_devices_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'events_archived', v_events_archived,
    'events_deleted', v_events_deleted,
    'pings_archived', v_pings_archived,
    'pings_deleted', v_pings_deleted,
    'devices_deleted', v_devices_deleted,
    'cutoff', v_cutoff,
    'ran_at', timezone('utc', now())
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_retention_cleanup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_retention_cleanup() TO service_role;

-- ---------------------------------------------------------------------------
-- Minute cron: Rule 6 closer + retention (no stale-presence noop)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attendance_cron_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ended INTEGER;
  v_retention jsonb;
BEGIN
  v_ended := public.attendance_close_ended_windows();
  v_retention := public.attendance_retention_cleanup();

  RETURN jsonb_build_object(
    'closed_ended', v_ended,
    'retention', v_retention,
    'ran_at', timezone('utc', now())
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Daily retention cron (idempotent schedule)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scorr-attendance-retention') THEN
    PERFORM cron.unschedule('scorr-attendance-retention');
  END IF;
  PERFORM cron.schedule(
    'scorr-attendance-retention',
    '20 3 * * *',
    $cron$SELECT public.attendance_retention_cleanup()$cron$
  );
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'pg_cron not available — skip daily retention schedule';
  WHEN OTHERS THEN
    RAISE NOTICE 'cron schedule notice: %', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- Drop unused helpers only (keep get_today_geo_attendance / check_in_attendance)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.attendance_close_stale_presence();
DROP FUNCTION IF EXISTS public.attendance_realign_shift_records_admin(uuid);
DROP FUNCTION IF EXISTS public.attendance_realign_shift_records(uuid);
DROP FUNCTION IF EXISTS public.attendance_user_on_office_network(uuid);
DROP FUNCTION IF EXISTS public.attendance_device_any_present(uuid);
DROP FUNCTION IF EXISTS public.attendance_backfill_closed_visit(uuid, uuid, date, timestamptz, timestamptz, integer);
DROP FUNCTION IF EXISTS public.has_shift_ended(time, time, integer[], timestamptz);
DROP FUNCTION IF EXISTS public.close_all_ended_shift_attendance();

-- Run retention once now (archive then delete eligible rows)
SELECT public.attendance_retention_cleanup();
