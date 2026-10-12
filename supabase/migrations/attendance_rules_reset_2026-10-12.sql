-- attendance_rules_reset_2026-10-12.sql
-- Re-runnable: strip attendance / office / auto-attendance RULE logic.
-- Keep tables, RLS, data. UI RPCs become safe stubs (no attendance writes, no device register).
-- Office CRUD and auto_* settings toggles still persist values only.

-- ---------------------------------------------------------------------------
-- 1) Drop rule triggers + attendance cron
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_attendance_block_checkin_after_shift_end ON public.attendance_records;
DROP TRIGGER IF EXISTS trg_attendance_records_window_guard ON public.attendance_records;
DROP TRIGGER IF EXISTS trg_attendance_visits_window_guard ON public.attendance_visit_segments;
DROP TRIGGER IF EXISTS trg_office_locations_after_sync ON public.office_locations;
DROP TRIGGER IF EXISTS trg_office_locations_validate_network ON public.office_locations;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scorr-attendance-cron') THEN
    PERFORM cron.unschedule('scorr-attendance-cron');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron unschedule: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Stub UI / edge entry points (no writes to attendance or devices)
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(double precision, double precision, double precision) CASCADE;
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(double precision, double precision, double precision, text) CASCADE;
DROP FUNCTION IF EXISTS public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.process_auto_attendance_event(text, text, uuid, double precision, double precision, double precision, text, text, bigint, bigint, text, boolean, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.check_in_attendance(date) CASCADE;
DROP FUNCTION IF EXISTS public.check_out_attendance(date) CASCADE;
DROP FUNCTION IF EXISTS public.check_out_attendance(date, double precision, double precision, double precision, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.get_my_location_window() CASCADE;
DROP FUNCTION IF EXISTS public.get_my_attendance_schedule() CASCADE;
DROP FUNCTION IF EXISTS public.attendance_schedule_by_token(text) CASCADE;
DROP FUNCTION IF EXISTS public.get_auto_attendance_setup_status() CASCADE;
DROP FUNCTION IF EXISTS public.register_attendance_device(text, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.revoke_attendance_device(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.close_my_ended_shift_attendance() CASCADE;
DROP FUNCTION IF EXISTS public.test_office_wifi_match(uuid, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.send_auto_attendance_setup_reminder(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.sync_work_sites_to_office(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.update_company_auto_attendance(boolean, boolean, text) CASCADE;
DROP FUNCTION IF EXISTS public.update_user_auto_attendance(uuid, boolean, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_office_location(uuid, text, text, double precision, double precision, integer, boolean, text[], text[], text[], text) CASCADE;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'action', 'rules_not_configured',
    'reason', 'rules_not_configured',
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_geo_attendance_ping(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_intent text,
  p_is_mock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.process_geo_attendance_ping(p_latitude, p_longitude, p_accuracy);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_auto_attendance_event(
  p_token_hash text,
  p_event text,
  p_zone_id uuid DEFAULT NULL,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL,
  p_occurred_at_utc_ms bigint DEFAULT NULL,
  p_device_now_utc_ms bigint DEFAULT NULL,
  p_device_timezone text DEFAULT NULL,
  p_is_mock boolean DEFAULT false,
  p_device_id text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_client_ip text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'reason', 'rules_not_configured',
    'action', 'rules_not_configured',
    'stop_tracking', true,
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_attendance(p_date date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No write. Clients show paused banner.
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_out_attendance(p_date date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_out_attendance(
  p_date date,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision,
  p_is_mock boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_location_window()
RETURNS TABLE(
  source text,
  shift_name text,
  start_time time without time zone,
  end_time time without time zone,
  grace_minutes integer,
  days_of_week integer[],
  crosses_midnight boolean,
  in_window boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_attendance_schedule()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'status', 'rules_not_configured',
    'windows', '[]'::jsonb,
    'zones', '[]'::jsonb,
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_schedule_by_token(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'status', 'rules_not_configured',
    'windows', '[]'::jsonb,
    'zones', '[]'::jsonb,
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_auto_attendance_setup_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 'rules_not_configured', 'issues', jsonb_build_array('Not authenticated'));
  END IF;
  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'ready', false,
    'issues', jsonb_build_array(
      'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
    ),
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.register_attendance_device(
  p_device_id text,
  p_platform text,
  p_device_timezone text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_token_plaintext text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Do not insert devices or flip auto_* flags.
  RETURN jsonb_build_object(
    'ok', false,
    'status', 'rules_not_configured',
    'device_token', NULL,
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_attendance_device(p_device_row_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Paused: do not revoke during rebuild (keeps existing rows).
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_my_ended_shift_attendance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.test_office_wifi_match(
  p_office_id uuid,
  p_client_ip text DEFAULT NULL,
  p_ssid text DEFAULT NULL,
  p_bssid text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'ok', false,
    'matched', false,
    'status', 'rules_not_configured',
    'message', 'Attendance, office and automatic attendance rules are being rebuilt. Everything is paused.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_auto_attendance_setup_reminder(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_work_sites_to_office(p_office_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Pin/radius propagation disabled during rebuild.
  RETURN;
END;
$$;

-- Settings: store values only (no enablement side effects beyond columns)
CREATE OR REPLACE FUNCTION public.update_company_auto_attendance(
  p_auto_phone boolean,
  p_auto_laptop boolean,
  p_timezone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_company UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_admin(v_uid) THEN RAISE EXCEPTION 'Only admins can update company attendance settings'; END IF;
  v_company := public.current_company_id();
  IF v_company IS NULL THEN RAISE EXCEPTION 'Account not linked to a company'; END IF;
  UPDATE public.companies SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance),
    timezone = COALESCE(NULLIF(btrim(p_timezone), ''), timezone)
  WHERE id = v_company;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_user_auto_attendance(
  p_user_id uuid,
  p_auto_phone boolean,
  p_auto_laptop boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_user_id IS DISTINCT FROM v_uid AND NOT public.is_admin(v_uid) AND NOT public.is_hr(v_uid) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  UPDATE public.users SET
    auto_phone_attendance = COALESCE(p_auto_phone, auto_phone_attendance),
    auto_laptop_attendance = COALESCE(p_auto_laptop, auto_laptop_attendance)
  WHERE id = p_user_id;
END;
$$;

-- Office upsert: save only; no sync_work_sites_to_office side effect
CREATE OR REPLACE FUNCTION public.upsert_office_location(
  p_id uuid,
  p_name text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters integer DEFAULT 150,
  p_active boolean DEFAULT true,
  p_wifi_ssids text[] DEFAULT NULL,
  p_wifi_bssids text[] DEFAULT NULL,
  p_public_ip_cidrs text[] DEFAULT NULL,
  p_detection_mode text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
  v_demo BOOLEAN := public.is_demo_user(v_uid);
  v_company UUID;
  v_mode text;
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

  v_mode := COALESCE(NULLIF(btrim(p_detection_mode), ''), 'gps_or_wifi');

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
      GREATEST(COALESCE(p_radius_meters, 150), 1),
      p_active,
      v_demo,
      v_company,
      COALESCE(p_wifi_ssids, '{}'),
      COALESCE(p_wifi_bssids, '{}'),
      COALESCE(p_public_ip_cidrs, '{}'),
      v_mode::public.office_detection_mode
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.office_locations SET
      name = trim(p_name),
      address = NULLIF(trim(p_address), ''),
      latitude = p_latitude,
      longitude = p_longitude,
      radius_meters = GREATEST(COALESCE(p_radius_meters, 150), 1),
      active = p_active,
      wifi_ssids = COALESCE(p_wifi_ssids, wifi_ssids),
      wifi_bssids = COALESCE(p_wifi_bssids, wifi_bssids),
      public_ip_cidrs = COALESCE(p_public_ip_cidrs, public_ip_cidrs),
      detection_mode = v_mode::public.office_detection_mode,
      updated_at = timezone('utc'::text, now())
    WHERE id = p_id
      AND (
        (v_demo AND is_demo = true)
        OR (NOT v_demo AND company_id = v_company)
      )
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Office location not found'; END IF;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_geo_attendance_ping(double precision, double precision, double precision, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_auto_attendance_event(text, text, uuid, double precision, double precision, double precision, text, text, bigint, bigint, text, boolean, text, text, text, text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.check_in_attendance(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_out_attendance(date, double precision, double precision, double precision, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_location_window() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_schedule() TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_schedule_by_token(text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_auto_attendance_setup_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_attendance_device(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_attendance_device(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_my_ended_shift_attendance() TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_office_wifi_match(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_auto_attendance_setup_reminder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_company_auto_attendance(boolean, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_auto_attendance(uuid, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_office_location(uuid, text, text, double precision, double precision, integer, boolean, text[], text[], text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_work_sites_to_office(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3) Drop pure rule-engine functions (IF EXISTS; ignore missing)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'attendance_cron_tick',
        'attendance_close_ended_windows',
        'attendance_apply_rule_5b',
        'attendance_apply_rule_5c',
        'attendance_apply_laptop_rules',
        'attendance_window_for_user',
        'attendance_checkin_allowed',
        'attendance_bounds_for_clock',
        'attendance_try_auto_checkin',
        'attendance_ensure_open_visit',
        'attendance_close_visit_with_note',
        'attendance_backfill_closed_visit',
        'attendance_handle_connection_lost',
        'attendance_handle_device_sleep',
        'attendance_handle_device_wake',
        'attendance_handle_device_shutdown',
        'attendance_block_checkin_after_shift_end',
        'attendance_guard_clock_times',
        'attendance_present_requires_presence_evidence',
        'attendance_match_office_wifi',
        'attendance_on_assigned_office_wifi',
        'attendance_gps_inside_assigned_office',
        'attendance_office_presence_check',
        'attendance_effective_any_signal_at',
        'attendance_effective_office_signal_at',
        'attendance_raw_office_signal_at',
        'attendance_raw_any_signal_at',
        'attendance_ios_last_inside_gps_uncontradicted',
        'attendance_user_uses_ios_silence_rules',
        'attendance_user_uses_laptop_only_rules',
        'attendance_laptop_sleep_grace_active',
        'attendance_laptop_set_notify',
        'attendance_laptop_track_off_office',
        'attendance_ip_in_cidrs',
        'attendance_close_stale_presence',
        'attendance_user_on_office_network',
        'is_within_shift_window',
        'is_within_shift_exit_window',
        'is_within_office',
        'geo_confirm_left_site',
        'close_open_attendance_if_shift_ended',
        'reconcile_ended_shift_attendance',
        'office_locations_validate_network',
        'trg_office_locations_after_sync',
        'trg_office_locations_bump_and_sync'
      )
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
