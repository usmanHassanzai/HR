-- attendance_settings.sql
-- R59 / company + per-user auto attendance toggles (default OFF)

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS auto_phone_attendance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_laptop_attendance BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auto_phone_attendance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_laptop_attendance BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.companies.auto_phone_attendance IS
  'Company master switch for automatic phone GPS/Wi-Fi attendance. Default OFF.';
COMMENT ON COLUMN public.companies.auto_laptop_attendance IS
  'Company master switch for laptop on/off attendance. Default OFF.';

NOTIFY pgrst, 'reload schema';
