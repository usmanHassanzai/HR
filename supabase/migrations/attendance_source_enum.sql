-- attendance_source_enum.sql
-- R57 + N1: extend attendance_source values; non-destructive backfill (dry-run counts in apply notes)

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS presence_method TEXT
    CHECK (presence_method IS NULL OR presence_method IN ('gps', 'wifi', 'laptop'));

-- Ensure attendance_source column exists as TEXT (historical)
ALTER TABLE public.attendance_records
  ALTER COLUMN attendance_source TYPE TEXT USING attendance_source::TEXT;

-- Backfill geo → auto_gps (non-destructive)
UPDATE public.attendance_records
SET attendance_source = 'auto_gps'
WHERE attendance_source = 'geo';

COMMENT ON COLUMN public.attendance_records.attendance_source IS
  'auto_gps | auto_wifi | auto_laptop | manual | leave | day_status | admin_correction';

COMMENT ON COLUMN public.attendance_records.presence_method IS
  'Matched detection method for auto visits: gps | wifi | laptop';

NOTIFY pgrst, 'reload schema';
