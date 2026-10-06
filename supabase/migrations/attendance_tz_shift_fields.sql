-- attendance_tz_shift_fields.sql
-- D/R20–R23: per-company and per-shift IANA time zones; overnight shifts allowed.
-- Does NOT change historical clock timestamps (already timestamptz).

-- Company default timezone (new companies default Asia/Karachi)
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Karachi';

COMMENT ON COLUMN public.companies.timezone IS
  'IANA timezone for company defaults and admin report display (e.g. Asia/Karachi).';

-- Per-shift IANA timezone (default filled from company on insert via trigger/app)
ALTER TABLE public.work_shifts
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Drop same-day-only check so overnight local times are valid when needed
ALTER TABLE public.work_shifts DROP CONSTRAINT IF EXISTS work_shifts_check;
ALTER TABLE public.work_shifts DROP CONSTRAINT IF EXISTS work_shifts_end_time_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_shifts_days_nonempty'
  ) THEN
    ALTER TABLE public.work_shifts
      ADD CONSTRAINT work_shifts_days_nonempty CHECK (cardinality(days_of_week) > 0);
  END IF;
END $$;

-- Backfill shift timezone from company of the shift manager (or Karachi)
UPDATE public.work_shifts ws
SET timezone = COALESCE(
  (
    SELECT c.timezone
    FROM public.users u
    JOIN public.companies c ON c.id = u.company_id
    WHERE u.id = ws.manager_id
    LIMIT 1
  ),
  'Asia/Karachi'
)
WHERE ws.timezone IS NULL OR btrim(ws.timezone) = '';

ALTER TABLE public.work_shifts
  ALTER COLUMN timezone SET DEFAULT 'Asia/Karachi';

ALTER TABLE public.work_shifts
  ALTER COLUMN timezone SET NOT NULL;

-- Validate IANA names Postgres knows
CREATE OR REPLACE FUNCTION public.assert_valid_iana_timezone(p_tz TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_tz IS NULL OR btrim(p_tz) = '' THEN
    RAISE EXCEPTION 'timezone is required';
  END IF;
  PERFORM now() AT TIME ZONE p_tz;
  RETURN p_tz;
EXCEPTION WHEN invalid_parameter_value OR undefined_object THEN
  RAISE EXCEPTION 'Invalid IANA timezone: %', p_tz;
END;
$$;

CREATE OR REPLACE FUNCTION public.company_timezone(p_company_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT assert_valid_iana_timezone(c.timezone) FROM public.companies c WHERE c.id = p_company_id),
    'Asia/Karachi'
  );
$$;

-- Keep app_timezone() as display/default ONLY (not for window math)
CREATE OR REPLACE FUNCTION public.app_timezone()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT 'Asia/Karachi'::TEXT;
$$;

-- Session GUC used by enforcement triggers to allow audited correction writes
CREATE OR REPLACE FUNCTION public.attendance_set_write_context(p_mode TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config(
    'scorr.attendance_write_mode',
    COALESCE(NULLIF(btrim(p_mode), ''), 'normal'),
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_write_mode()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('scorr.attendance_write_mode', true), ''), 'normal');
$$;

GRANT EXECUTE ON FUNCTION public.assert_valid_iana_timezone(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_timezone(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_timezone() TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_set_write_context(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_write_mode() TO authenticated;

NOTIFY pgrst, 'reload schema';
