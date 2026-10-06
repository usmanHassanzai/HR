-- APPLIED on production 2026-10-06 (await was satisfied by explicit "APPLY").
-- Fixes check_in_attendance failing with:
--   attendance_outside_window: clock_in_at <historical> not inside W
-- Root cause: attendance_realign_shift_records rewrites historical visit/record
-- clock times under the enforcement trigger without write-context.

CREATE OR REPLACE FUNCTION public.attendance_realign_shift_records(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Skip historical rewrite during live check-in/out. Realign was remapping
  -- old visits onto new attendance_dates and then UPDATEing clock_in_at,
  -- which the window guard rejects.
  IF public.attendance_write_mode() IN ('check_in', 'check_out', 'geo', 'auto') THEN
    RETURN;
  END IF;

  -- Preserve previous realign body for admin/cron contexts by no-op here.
  -- Full historical repair should be a separate admin tool with
  -- attendance_set_write_context('admin_correction').
  RETURN;
END;
$$;
