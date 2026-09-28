-- Must run in its own migration/transaction before kpi_completion_review.sql uses the value.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'kpi_completion_status'
      AND e.enumlabel = 'pending_review'
  ) THEN
    ALTER TYPE public.kpi_completion_status ADD VALUE 'pending_review';
  END IF;
END
$$;
