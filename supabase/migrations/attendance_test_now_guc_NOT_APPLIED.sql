-- NOT APPLIED — await explicit "apply".
-- Lets SQL tests freeze "now" via: SELECT set_config('attendance.test_now', '2026-10-06 15:00:00+00', true);
-- Production behavior unchanged when the GUC is unset.

CREATE OR REPLACE FUNCTION public.attendance_now()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_override TEXT := nullif(current_setting('attendance.test_now', true), '');
BEGIN
  IF v_override IS NOT NULL THEN
    RETURN v_override::TIMESTAMPTZ;
  END IF;
  RETURN timezone('utc', now());
END;
$$;

-- Patch process_auto_attendance_event to use attendance_now() instead of now().
-- Re-apply attendance_auto_rpc.sql body with v_now := public.attendance_now();
-- (Full function body is in attendance_auto_rpc.sql — after apply, replace the line:
--    v_now TIMESTAMPTZ := timezone('utc', now());
--  with:
--    v_now TIMESTAMPTZ := public.attendance_now();
-- )
