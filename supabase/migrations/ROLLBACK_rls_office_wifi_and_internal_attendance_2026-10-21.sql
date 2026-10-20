-- Rollback rls_office_wifi_and_internal_attendance_2026-10-21.sql
-- Drops only the four policies that migration created.
-- Disables RLS on these tables only when no other policy remains.
-- Does not drop tables or delete rows. Do not run on production until reviewed.

DO $$
DECLARE
  r record;
  v_other bigint;
BEGIN
  DROP POLICY IF EXISTS office_wifi_networks_select_company ON public.office_wifi_networks;
  DROP POLICY IF EXISTS office_wifi_networks_insert_admin_hr ON public.office_wifi_networks;
  DROP POLICY IF EXISTS office_wifi_networks_update_admin_hr ON public.office_wifi_networks;
  DROP POLICY IF EXISTS office_wifi_networks_delete_admin_hr ON public.office_wifi_networks;

  SELECT count(*) INTO v_other
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'office_wifi_networks';
  IF v_other > 0 THEN
    RAISE EXCEPTION
      'office_wifi_networks still has % policy(ies) this rollback did not create; RLS left enabled',
      v_other;
  END IF;
  ALTER TABLE public.office_wifi_networks DISABLE ROW LEVEL SECURITY;

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (
        c.relname LIKE 'attendance_auto_close_suppress%'
        OR c.relname = 'attendance_events_log_archive'
        OR c.relname LIKE 'employee_location_pings_archive%'
      )
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM pg_policies WHERE schemaname = %L AND tablename = %L',
      'public', r.relname
    ) INTO v_other;
    IF v_other > 0 THEN
      RAISE EXCEPTION
        'public.% has policies; RLS left enabled', r.relname;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
