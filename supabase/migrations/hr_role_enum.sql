-- Must run and commit before hr_shift_permissions.sql (new enum values cannot be used in the same transaction).
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'hr';
