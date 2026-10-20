-- Enable RLS on office Wi-Fi networks and internal attendance tables.
-- Does not drop, replace, or weaken any existing policy.
-- Internal / archive tables: RLS on, no policies.
--   anon and authenticated cannot read or write them.
--   service_role (BYPASSRLS) and SECURITY DEFINER functions owned by the
--   table owner keep working (retention cleanup, suppressed-close log).
-- office_wifi_networks:
--   company members may SELECT their own company's rows.
--   Admin and HR of that company may INSERT, UPDATE, DELETE.
--   Demo users follow the same demo-office pattern as office_locations.
-- Re-runnable: policies are created only when missing.

ALTER TABLE public.office_wifi_networks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
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
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    RAISE NOTICE 'RLS enabled with no policies: public.%', r.relname;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'office_wifi_networks'
      AND policyname = 'office_wifi_networks_select_company'
  ) THEN
    CREATE POLICY office_wifi_networks_select_company
      ON public.office_wifi_networks
      FOR SELECT
      TO authenticated
      USING (
        (
          NOT public.is_demo_user(auth.uid())
          AND company_id IS NOT NULL
          AND company_id = public.current_company_id()
        )
        OR (
          public.is_demo_user(auth.uid())
          AND EXISTS (
            SELECT 1
            FROM public.office_locations o
            WHERE o.id = office_wifi_networks.office_location_id
              AND o.is_demo = true
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'office_wifi_networks'
      AND policyname = 'office_wifi_networks_insert_admin_hr'
  ) THEN
    CREATE POLICY office_wifi_networks_insert_admin_hr
      ON public.office_wifi_networks
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (
          NOT public.is_demo_user(auth.uid())
          AND company_id IS NOT NULL
          AND company_id = public.current_company_id()
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
        )
        OR (
          public.is_demo_user(auth.uid())
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
          AND EXISTS (
            SELECT 1
            FROM public.office_locations o
            WHERE o.id = office_wifi_networks.office_location_id
              AND o.is_demo = true
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'office_wifi_networks'
      AND policyname = 'office_wifi_networks_update_admin_hr'
  ) THEN
    CREATE POLICY office_wifi_networks_update_admin_hr
      ON public.office_wifi_networks
      FOR UPDATE
      TO authenticated
      USING (
        (
          NOT public.is_demo_user(auth.uid())
          AND company_id IS NOT NULL
          AND company_id = public.current_company_id()
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
        )
        OR (
          public.is_demo_user(auth.uid())
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
          AND EXISTS (
            SELECT 1
            FROM public.office_locations o
            WHERE o.id = office_wifi_networks.office_location_id
              AND o.is_demo = true
          )
        )
      )
      WITH CHECK (
        (
          NOT public.is_demo_user(auth.uid())
          AND company_id IS NOT NULL
          AND company_id = public.current_company_id()
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
        )
        OR (
          public.is_demo_user(auth.uid())
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
          AND EXISTS (
            SELECT 1
            FROM public.office_locations o
            WHERE o.id = office_wifi_networks.office_location_id
              AND o.is_demo = true
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'office_wifi_networks'
      AND policyname = 'office_wifi_networks_delete_admin_hr'
  ) THEN
    CREATE POLICY office_wifi_networks_delete_admin_hr
      ON public.office_wifi_networks
      FOR DELETE
      TO authenticated
      USING (
        (
          NOT public.is_demo_user(auth.uid())
          AND company_id IS NOT NULL
          AND company_id = public.current_company_id()
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
        )
        OR (
          public.is_demo_user(auth.uid())
          AND (public.is_admin(auth.uid()) OR public.is_hr(auth.uid()))
          AND EXISTS (
            SELECT 1
            FROM public.office_locations o
            WHERE o.id = office_wifi_networks.office_location_id
              AND o.is_demo = true
          )
        )
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
