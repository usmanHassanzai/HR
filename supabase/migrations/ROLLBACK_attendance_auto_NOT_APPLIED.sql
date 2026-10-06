-- ROLLBACK PLAN — NOT APPLIED
-- Reverse of the automatic-attendance migration set (apply only after explicit approval).
-- Order: reverse of forward apply. Review each block before running.
-- Generated: 2026-10-06
--
-- BACKUP STATUS (queried via Management API 2026-10-06):
--   region: ap-northeast-1
--   walg_enabled: true
--   pitr_enabled: FALSE
--   backups: [] (empty list from API)
--   NO confirmed PITR restore point timestamp was returned by the API.
--   Action required: verify in Supabase Dashboard → Database → Backups whether
--   daily WAL-G backups exist; do NOT rely on this file alone.

-- ============================================================================
-- 17) attendance_rls_lockdown.sql (reverse)
-- ============================================================================
DROP POLICY IF EXISTS attendance_records_no_client_write ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_no_client_update ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_no_client_delete ON public.attendance_records;
DROP POLICY IF EXISTS attendance_visits_no_client_insert ON public.attendance_visit_segments;
DROP POLICY IF EXISTS attendance_visits_no_client_update ON public.attendance_visit_segments;
DROP POLICY IF EXISTS attendance_visits_no_client_delete ON public.attendance_visit_segments;
DROP POLICY IF EXISTS employee_location_pings_no_client_insert ON public.employee_location_pings;
DROP POLICY IF EXISTS employee_location_pings_no_client_update ON public.employee_location_pings;
-- NOTE: prior SELECT/write policies are NOT automatically restored; redeploy last known
-- good migration that defined attendance RLS (e.g. attendance_leave.sql / hr_self_attendance).

-- ============================================================================
-- 16) attendance_leave_window.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.attendance_apply_leave_day(UUID, DATE, TEXT);
-- Restore previous review_leave_request from leave_type_other.sql / hr_self_attendance.sql
-- by re-applying that migration file (not inlined here).

-- ============================================================================
-- 15) attendance_geo_window.sql (reverse)
-- ============================================================================
-- Restore process_geo_attendance_ping from geo_auto_attendance_restore.sql (re-apply that file).

-- ============================================================================
-- 14) attendance_writers_window.sql (reverse)
-- ============================================================================
-- Restore check_in_attendance / check_out_attendance / mark_* / closers from
-- overnight_shift_attendance_date.sql, hr_self_attendance.sql, shift_one_hour_edges.sql
-- (re-apply last known good versions).

-- ============================================================================
-- 13) attendance_cron.sql (reverse)
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'scorr-attendance-cron';
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DROP FUNCTION IF EXISTS public.attendance_cron_tick();
DROP FUNCTION IF EXISTS public.attendance_close_stale_presence();
DROP FUNCTION IF EXISTS public.attendance_close_ended_windows();

-- ============================================================================
-- 12) attendance_schedule_rpc.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_my_attendance_schedule();
DROP FUNCTION IF EXISTS public.attendance_schedule_by_token(TEXT);
DROP FUNCTION IF EXISTS public.attendance_schedule_for_user(UUID, TIMESTAMPTZ, INTEGER);

-- ============================================================================
-- 11) attendance_correction_rpc.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.correct_attendance_times(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BOOLEAN);

-- ============================================================================
-- 10) attendance_register_device_rpc.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.list_unenrolled_auto_attendance_users();
DROP FUNCTION IF EXISTS public.list_company_attendance_devices();
DROP FUNCTION IF EXISTS public.disable_my_auto_attendance(TEXT);
DROP FUNCTION IF EXISTS public.revoke_attendance_device(UUID);
DROP FUNCTION IF EXISTS public.register_attendance_device(TEXT, TEXT, TEXT, TEXT, TEXT);

-- ============================================================================
-- 9) attendance_auto_rpc.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.process_auto_attendance_event(TEXT, TEXT, UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, BIGINT, BIGINT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.attendance_device_any_present(UUID);
DROP FUNCTION IF EXISTS public.attendance_ip_in_cidrs(TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.attendance_hash_device_token(TEXT);
ALTER TABLE public.attendance_devices
  DROP COLUMN IF EXISTS presence_state,
  DROP COLUMN IF EXISTS last_presence_at,
  DROP COLUMN IF EXISTS last_zone_id,
  DROP COLUMN IF EXISTS last_matched_method;

-- ============================================================================
-- 8) attendance_enforcement_triggers.sql (reverse)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_employee_location_pings_window ON public.employee_location_pings;
DROP FUNCTION IF EXISTS public.employee_location_pings_window_guard();
DROP TRIGGER IF EXISTS trg_attendance_visits_window_guard ON public.attendance_visit_segments;
DROP TRIGGER IF EXISTS trg_attendance_records_window_guard ON public.attendance_records;
DROP FUNCTION IF EXISTS public.attendance_guard_clock_times();

-- ============================================================================
-- 7) attendance_events_log.sql (reverse)
-- ============================================================================
DROP TABLE IF EXISTS public.attendance_corrections_audit CASCADE;
DROP TABLE IF EXISTS public.attendance_events_log CASCADE;

-- ============================================================================
-- 6) attendance_devices.sql (reverse)
-- ============================================================================
DROP TABLE IF EXISTS public.attendance_devices CASCADE;

-- ============================================================================
-- 5) attendance_source_enum.sql (reverse)
-- ============================================================================
-- Non-destructive reverse of geo→auto_gps backfill:
UPDATE public.attendance_records
SET attendance_source = 'geo'
WHERE attendance_source = 'auto_gps';
ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS presence_method;

-- ============================================================================
-- 4) office_network_allowlist.sql (reverse)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_office_locations_validate_network ON public.office_locations;
DROP FUNCTION IF EXISTS public.office_locations_validate_network();
DROP FUNCTION IF EXISTS public.assert_public_ip_cidrs(TEXT[]);
ALTER TABLE public.office_locations
  DROP COLUMN IF EXISTS wifi_ssids,
  DROP COLUMN IF EXISTS wifi_bssids,
  DROP COLUMN IF EXISTS public_ip_cidrs,
  DROP COLUMN IF EXISTS detection_mode;
DROP TYPE IF EXISTS public.office_detection_mode;

-- ============================================================================
-- 3) attendance_settings.sql (reverse)
-- ============================================================================
ALTER TABLE public.users
  DROP COLUMN IF EXISTS auto_phone_attendance,
  DROP COLUMN IF EXISTS auto_laptop_attendance;
ALTER TABLE public.companies
  DROP COLUMN IF EXISTS auto_phone_attendance,
  DROP COLUMN IF EXISTS auto_laptop_attendance;

-- ============================================================================
-- 2) attendance_window_core.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.attendance_correct_occurred_at(BIGINT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.attendance_window_for_user(UUID, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.attendance_iso_dow(TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS public.attendance_tz_instant(DATE, TIME, TEXT);
DROP FUNCTION IF EXISTS public.attendance_local_date(TIMESTAMPTZ, TEXT);

-- ============================================================================
-- 1) attendance_tz_shift_fields.sql (reverse)
-- ============================================================================
DROP FUNCTION IF EXISTS public.attendance_write_mode();
DROP FUNCTION IF EXISTS public.attendance_set_write_context(TEXT);
-- Restore app_timezone() body to prior definition if different (was Asia/Karachi — keep).
DROP FUNCTION IF EXISTS public.company_timezone(UUID);
DROP FUNCTION IF EXISTS public.assert_valid_iana_timezone(TEXT);
ALTER TABLE public.work_shifts DROP COLUMN IF EXISTS timezone;
ALTER TABLE public.companies DROP COLUMN IF EXISTS timezone;
-- Also reverse office_network_upsert extras if applied:
DROP FUNCTION IF EXISTS public.update_work_shift_timezone(UUID, TEXT);
DROP FUNCTION IF EXISTS public.update_user_auto_attendance(UUID, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.update_company_auto_attendance(BOOLEAN, BOOLEAN, TEXT);
-- Restore upsert_office_location 7-arg signature from sync_office_live_pin_to_assignments.sql

-- ============================================================================
-- DATA FIX NOTES (not automatic)
-- ============================================================================
-- 1) Revert Arrant "AC Shift" times only if you want pre-migration overnight storage:
--    UPDATE work_shifts SET start_time='18:00', end_time='03:00', timezone='Asia/Karachi',
--      crosses_midnight=true WHERE id='6eb1c0d5-5d03-475d-9f6d-21d886815a78';
-- 2) NeuralTech Night Shift + Morning Shift timezone were reverted on 2026-10-06 during incident response.
-- 3) Edge functions register-attendance-device / auto-attendance-event / attendance-schedule
--    must be deleted or disabled separately via Supabase dashboard/API (not SQL).
