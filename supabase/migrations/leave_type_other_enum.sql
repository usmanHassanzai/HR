-- Add "other" to leave_type. Must run in its own transaction before functions use the value.
ALTER TYPE public.leave_type ADD VALUE IF NOT EXISTS 'other';
