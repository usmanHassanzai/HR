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
